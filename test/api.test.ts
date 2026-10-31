// The HTTP API end to end: real routes, in-memory store, moto as R2.
// Auth tests always run; anything that touches the bucket needs R2_TEST_ENDPOINT.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { headObject } from "../src/r2.js";
import { ADMIN_TOKEN, CRON_SECRET, put, S3_ENDPOINT, setup } from "./helpers.js";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const MiB = 1024 ** 2;

describe("auth", () => {
  test("health needs no key", async () => {
    const t = await setup();
    assert.equal((await t.call("GET", "/v1/health")).json.ok, true);
  });

  test("no key, a malformed key, a wrong secret, a revoked key → 401", async () => {
    const t = await setup();
    const good = await t.key();
    assert.equal((await t.call("GET", "/v1/usage")).status, 401);
    assert.equal((await t.call("GET", "/v1/usage", { token: "nope" })).status, 401);
    const wrong = good.slice(0, -4) + (good.endsWith("AAAA") ? "BBBB" : "AAAA");
    assert.equal((await t.call("GET", "/v1/usage", { token: wrong })).status, 401);
    const id = good.split("_")[1];
    assert.equal((await t.call("DELETE", `/v1/keys/${id}`, { token: ADMIN_TOKEN })).status, 204);
    assert.equal((await t.call("GET", "/v1/usage", { token: good })).status, 401);
  });

  test("missing scope → 403", async () => {
    const t = await setup();
    const readOnly = await t.key("shot-listed", ["read"]);
    const res = await t.call("POST", "/v1/uploads", { token: readOnly, body: { collection: "library", filename: "a.jpg", size: 1 } });
    assert.equal(res.status, 403);
  });

  test("keys are admin-only; the admin token can't touch assets", async () => {
    const t = await setup();
    const k = await t.key();
    assert.equal((await t.call("GET", "/v1/keys", { token: k })).status, 403, "a normal key lacks the admin scope");
    const created = await t.call("POST", "/v1/keys", { token: ADMIN_TOKEN, body: { app: "my-app", name: "laptop", scopes: ["read"] } });
    assert.equal(created.status, 201);
    assert.match(created.json.key, /^rsk_/);
    const listed = await t.call("GET", "/v1/keys?app=my-app", { token: ADMIN_TOKEN });
    assert.equal(listed.json.keys.length, 1);
    assert.equal(listed.json.keys[0].key, undefined, "secrets are never listed");
    assert.equal((await t.call("GET", "/v1/usage", { token: ADMIN_TOKEN })).status, 401);
  });

  test("cron needs its secret", async () => {
    const t = await setup();
    assert.equal((await t.call("GET", "/v1/cron/cleanup")).status, 401);
    assert.equal((await t.call("GET", "/v1/cron/cleanup", { token: CRON_SECRET })).status, 200);
  });

  test("bad input is a 400 with the field named", async () => {
    const t = await setup();
    const k = await t.key();
    const res = await t.call("POST", "/v1/uploads", { token: k, body: { collection: "Library!", filename: "a.jpg", size: 1 } });
    assert.equal(res.status, 400);
    assert.match(res.json.error.message, /collection/);
    const notJson = await t.app.request("/v1/uploads", { method: "POST", headers: { Authorization: `Bearer ${k}` }, body: "{" });
    assert.equal(notJson.status, 400);
  });
});

describe("files", { skip: !S3_ENDPOINT }, () => {
  let t: Awaited<ReturnType<typeof setup>>;
  let k: string;
  before(async () => {
    t = await setup({ s3: true });
    k = await t.key();
  });
  after(() => t.destroy());

  async function uploadSmall(body: Uint8Array, extra: Record<string, unknown> = {}, token = k) {
    const req = { collection: "library", filename: "a.jpg", contentType: "image/jpeg", size: body.length, contentHash: sha(body), ...extra };
    const start = await t.call("POST", "/v1/uploads", { token, body: req });
    if (start.json.mode === "single") {
      await put(start.json.url, body, start.json.headers);
      const done = await t.call("POST", `/v1/uploads/${start.json.assetId}/complete`, { token, body: {} });
      assert.equal(done.status, 200, JSON.stringify(done.json));
    }
    return start.json;
  }

  test("single upload, then the same bytes are a duplicate", async () => {
    const body = randomBytes(1000);
    const first = await uploadSmall(body);
    assert.equal(first.mode, "single");
    const again = await uploadSmall(body);
    assert.deepEqual(again, { mode: "duplicate", assetId: first.assetId, adopted: false });
    const got = await t.call("GET", `/v1/assets/${first.assetId}`, { token: k });
    assert.equal(got.json.asset.status, "uploaded");
    assert.match(got.json.asset.filename, /a\.jpg/);
  });

  test("the Mac's Photos ID is adopted onto the phone's upload", async () => {
    const body = randomBytes(900);
    const phone = await uploadSmall(body);
    const mac = await t.call("POST", "/v1/uploads", {
      token: k,
      body: { collection: "library", filename: "IMG_1.jpg", size: body.length, contentHash: sha(body), externalId: "photos-uuid-1" },
    });
    assert.deepEqual(mac.json, { mode: "duplicate", assetId: phone.assetId, adopted: true });
    assert.equal((await t.call("GET", `/v1/assets/${phone.assetId}`, { token: k })).json.asset.externalId, "photos-uuid-1");
  });

  test("the same bytes can be a library item and a final cut", async () => {
    const body = randomBytes(800);
    const lib = await uploadSmall(body, { contentType: "video/mp4", filename: "cut.mp4" });
    const fin = await uploadSmall(body, { contentType: "video/mp4", filename: "cut.mp4", collection: "finals" });
    assert.equal(fin.mode, "single");
    assert.notEqual(fin.assetId, lib.assetId);
  });

  test("a stopped single upload resumes on the same asset", async () => {
    const body = randomBytes(700);
    const req = { collection: "library", filename: "b.jpg", size: body.length, contentHash: sha(body) };
    const first = await t.call("POST", "/v1/uploads", { token: k, body: req });
    // never PUT: the phone lost signal
    const second = await t.call("POST", "/v1/uploads", { token: k, body: req });
    assert.equal(second.json.mode, "single");
    assert.equal(second.json.assetId, first.json.assetId);
    await put(second.json.url, body, second.json.headers);
    assert.equal((await t.call("POST", `/v1/uploads/${first.json.assetId}/complete`, { token: k, body: {} })).status, 200);
    // finishing twice is fine
    assert.equal((await t.call("POST", `/v1/uploads/${first.json.assetId}/complete`, { token: k, body: {} })).status, 200);
  });

  test("a stopped multipart upload resumes with only the missing parts", async () => {
    const size = 70 * MiB;
    const body = randomBytes(size);
    const req = { collection: "library", filename: "long.mov", size, contentHash: sha(body) };
    const start = (await t.call("POST", "/v1/uploads", { token: k, body: req })).json;
    assert.equal(start.mode, "multipart");
    const slice = (n: number) => body.subarray((n - 1) * start.partSize, Math.min(n * start.partSize, size));
    const sign = async (nums: number[]) =>
      (await t.call("POST", `/v1/uploads/${start.assetId}/parts`, { token: k, body: { partNumbers: nums } })).json.parts as {
        partNumber: number;
        url: string;
      }[];
    for (const p of await sign([1, 2])) await put(p.url, slice(p.partNumber));

    const resumed = (await t.call("POST", "/v1/uploads", { token: k, body: req })).json;
    assert.equal(resumed.mode, "resume");
    assert.equal(resumed.assetId, start.assetId);
    assert.deepEqual(resumed.uploadedParts.map((p: { partNumber: number }) => p.partNumber), [1, 2]);
    assert.equal(resumed.uploadedParts[0].size, start.partSize);

    // GET gives the same state, for a caller that kept the ID.
    assert.equal((await t.call("GET", `/v1/uploads/${start.assetId}`, { token: k })).json.mode, "resume");

    const parts = resumed.uploadedParts.map(({ partNumber, etag }: { partNumber: number; etag: string }) => ({ partNumber, etag }));
    const missing = Array.from({ length: start.partCount }, (_, i) => i + 1).filter((n) => n > 2);
    for (const p of await sign(missing)) parts.push({ partNumber: p.partNumber, etag: await put(p.url, slice(p.partNumber)) });
    const done = await t.call("POST", `/v1/uploads/${start.assetId}/complete`, { token: k, body: { parts } });
    assert.equal(done.status, 200, JSON.stringify(done.json));
    assert.equal((await headObject(t.bucket, (await t.store.getAsset("shot-listed", start.assetId))!.key))?.size, size);
  });

  test("if R2 dropped the multipart upload, it restarts on the same asset", async () => {
    const size = 65 * MiB;
    const req = { collection: "library", filename: "gone.mov", size, contentHash: sha(Buffer.from("gone")) };
    const start = (await t.call("POST", "/v1/uploads", { token: k, body: req })).json;
    const rec = (await t.store.getAsset("shot-listed", start.assetId))!;
    const { abortMultipart } = await import("../src/r2.js");
    await abortMultipart(t.bucket, rec.key, rec.multipart!.uploadId);
    const again = (await t.call("POST", "/v1/uploads", { token: k, body: req })).json;
    assert.equal(again.mode, "multipart");
    assert.equal(again.assetId, start.assetId);
    assert.notEqual((await t.store.getAsset("shot-listed", start.assetId))!.multipart!.uploadId, rec.multipart!.uploadId);
    await t.call("DELETE", `/v1/uploads/${start.assetId}`, { token: k });
  });

  test("caller limits and size checks", async () => {
    const tooBig = await t.call("POST", "/v1/uploads", {
      token: k,
      body: { collection: "finals", filename: "x.mp4", size: 600 * MiB, kinds: ["video"], maxBytes: 500 * MiB },
    });
    assert.equal(tooBig.status, 413);
    const wrongKind = await t.call("POST", "/v1/uploads", {
      token: k,
      body: { collection: "finals", filename: "x.jpg", size: 10, kinds: ["video"] },
    });
    assert.equal(wrongKind.status, 415);

    const body = randomBytes(300);
    const start = (await t.call("POST", "/v1/uploads", { token: k, body: { collection: "library", filename: "s.jpg", size: 999, contentHash: sha(body) } })).json;
    await put(start.url, body, start.headers);
    const mismatch = await t.call("POST", `/v1/uploads/${start.assetId}/complete`, { token: k, body: {} });
    assert.equal(mismatch.status, 422);
    assert.equal((await t.call("GET", `/v1/assets/${start.assetId}`, { token: k })).status, 404);
  });

  test("another app sees nothing", async () => {
    const mine = await uploadSmall(randomBytes(100));
    const theirs = await t.key("other-app");
    assert.equal((await t.call("GET", `/v1/assets/${mine.assetId}`, { token: theirs })).status, 404);
    assert.equal((await t.call("DELETE", `/v1/assets/${mine.assetId}`, { token: theirs })).status, 404);
    assert.equal((await t.call("GET", "/v1/assets", { token: theirs })).json.items.length, 0);
  });

  test("list pages, links, batch links, downloads", async () => {
    const t2 = await setup({ s3: true });
    const k2 = await t2.key();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const b = randomBytes(50 + i);
      const s = (await t2.call("POST", "/v1/uploads", { token: k2, body: { collection: "library", filename: `p${i}.jpg`, size: b.length, contentHash: sha(b) } })).json;
      await put(s.url, b, s.headers);
      await t2.call("POST", `/v1/uploads/${s.assetId}/complete`, { token: k2, body: {} });
      ids.push(s.assetId);
    }
    const p1 = (await t2.call("GET", "/v1/assets?collection=library&limit=3&urls=thumb", { token: k2 })).json;
    assert.equal(p1.items.length, 3);
    assert.ok(p1.items[0].url, "falls back to the original when there's no thumb");
    const p2 = (await t2.call("GET", `/v1/assets?collection=library&limit=3&before=${p1.next}`, { token: k2 })).json;
    assert.equal(p2.items.length, 2);
    assert.equal(p2.next, null);
    assert.equal(new Set([...p1.items, ...p2.items].map((a: { id: string }) => a.id)).size, 5);

    const batch = (await t2.call("POST", "/v1/assets/urls", { token: k2, body: { items: [{ id: ids[0] }, { id: "missing" }] } })).json;
    assert.ok(batch.urls[0].url);
    assert.equal(batch.urls[1].url, null);

    const dl = (await t2.call("POST", `/v1/assets/${ids[0]}/url`, { token: k2, body: { download: true } })).json;
    const res = await fetch(dl.url);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-disposition") ?? "", /attachment; filename="p0\.jpg"/);
    assert.equal((await t2.call("POST", `/v1/assets/${ids[0]}/url`, { token: k2, body: { variant: "proxy" } })).status, 404);
    t2.destroy();
  });

  test("patch: metadata, and hash clashes are a 409", async () => {
    const a = await uploadSmall(randomBytes(120));
    const b = await uploadSmall(randomBytes(121));
    const aHash = (await t.call("GET", `/v1/assets/${a.assetId}`, { token: k })).json.asset.contentHash;
    const ok = await t.call("PATCH", `/v1/assets/${b.assetId}`, { token: k, body: { metadata: { origin: "phone-upload" } } });
    assert.deepEqual(ok.json.asset.metadata, { origin: "phone-upload" });
    const clash = await t.call("PATCH", `/v1/assets/${b.assetId}`, { token: k, body: { contentHash: aHash } });
    assert.equal(clash.status, 409);
  });

  test("variants, dropping the original, usage, delete", async () => {
    const body = randomBytes(5000);
    const a = await uploadSmall(body, { contentType: "video/mp4", filename: "clip.mp4" });
    const before = (await t.call("GET", "/v1/usage", { token: k })).json.bytes;

    assert.equal((await t.call("DELETE", `/v1/assets/${a.assetId}/original`, { token: k })).status, 409, "needs a proxy first");
    const proxy = randomBytes(2000);
    const v = await t.call("POST", `/v1/assets/${a.assetId}/variants`, { token: k, body: { name: "proxy", contentType: "video/mp4", size: proxy.length } });
    assert.equal(v.status, 201);
    await put(v.json.url, proxy, v.json.headers);
    const done = await t.call("POST", `/v1/assets/${a.assetId}/variants/proxy/complete`, { token: k });
    assert.equal(done.json.asset.variants[0].status, "uploaded");
    assert.equal((await t.call("GET", "/v1/usage", { token: k })).json.bytes, before + 2000);

    const dropped = await t.call("DELETE", `/v1/assets/${a.assetId}/original`, { token: k });
    assert.equal(dropped.json.asset.hasOriginal, false);
    assert.equal((await t.call("GET", "/v1/usage", { token: k })).json.bytes, before + 2000 - 5000);
    // "original" now opens the proxy
    const link = (await t.call("POST", `/v1/assets/${a.assetId}/url`, { token: k, body: {} })).json.url;
    assert.equal((await (await fetch(link)).arrayBuffer()).byteLength, 2000);

    const rec = (await t.store.getAsset("shot-listed", a.assetId))!;
    assert.equal((await t.call("DELETE", `/v1/assets/${a.assetId}`, { token: k })).status, 204);
    assert.equal(await headObject(t.bucket, rec.variants[0].key), null);
    assert.equal((await t.call("GET", `/v1/assets/${a.assetId}`, { token: k })).status, 404);
  });

  test("merge keeps this ID and the chosen original", async () => {
    const older = await uploadSmall(randomBytes(400), { filename: "converted.jpg", collection: "merge" });
    const newerBody = randomBytes(900);
    const newer = await uploadSmall(newerBody, { filename: "original.heic", contentType: "image/heic", collection: "merge", externalId: "photos-77" });
    const olderKey = (await t.store.getAsset("shot-listed", older.assetId))!.key;

    const res = await t.call("POST", `/v1/assets/${older.assetId}/merge`, { token: k, body: { from: newer.assetId, keepOriginal: "from" } });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.asset.id, older.assetId);
    assert.equal(res.json.asset.size, 900);
    assert.equal(res.json.asset.externalId, "photos-77");
    assert.equal(res.json.asset.contentHash, sha(newerBody));
    assert.equal((await t.call("GET", `/v1/assets/${newer.assetId}`, { token: k })).status, 404);
    assert.equal(await headObject(t.bucket, olderKey), null, "the losing file is deleted");
    // The merged hash still dedupes.
    assert.equal((await uploadSmall(newerBody, { collection: "merge" })).mode, "duplicate");
    // A read-only or write-only key can't merge.
    const writeOnly = await t.key("shot-listed", ["write"]);
    assert.equal((await t.call("POST", `/v1/assets/${older.assetId}/merge`, { token: writeOnly, body: { from: "x", keepOriginal: "this" } })).status, 403);
  });

  test("cleanup removes uploads nobody came back to", async () => {
    const body = randomBytes(200);
    const s = (await t.call("POST", "/v1/uploads", { token: k, body: { collection: "library", filename: "lost.jpg", size: body.length, contentHash: sha(body) } })).json;
    await t.store.updateAsset("shot-listed", s.assetId, { updatedAt: new Date(Date.now() - 2 * 86_400_000) });
    const res = await t.call("GET", "/v1/cron/cleanup", { token: CRON_SECRET });
    assert.ok(res.json.staleUploadsRemoved >= 1);
    assert.equal((await t.call("GET", `/v1/assets/${s.assetId}`, { token: k })).status, 404);
  });
});
