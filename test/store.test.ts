// The same rules for every store. Always runs against the in-memory store; set
// MONGODB_TEST_URI (a throwaway Atlas database) to run it against MongoDB too:
//   MONGODB_TEST_URI="mongodb+srv://..." npm test
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DuplicateKeyError } from "../src/errors.js";
import { memoryStore } from "../src/store/memory.js";
import type { AssetRecord, Store } from "../src/store/types.js";

const mongoUri = process.env.MONGODB_TEST_URI;
const cleanups: Array<() => Promise<void>> = [];
after(async () => {
  for (const c of cleanups) await c();
  // The Mongo client is cached and shared, so close it once, after every database is dropped.
  if (mongoUri) await (await (await import("../src/store/mongo.js")).connect(mongoUri)).close();
});

function asset(over: Partial<AssetRecord> = {}): AssetRecord {
  const id = over.id ?? randomUUID();
  const now = new Date();
  return {
    id,
    app: "shot-listed",
    collection: "library",
    key: `apps/shot-listed/library/${id}.jpg`,
    filename: "a.jpg",
    contentType: "image/jpeg",
    kind: "photo",
    size: 100,
    status: "uploaded",
    hasOriginal: true,
    metadata: {},
    variants: [],
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

const hash = (c: string) => c.repeat(64);

const stores: Array<[string, () => Promise<Store>]> = [["memory", async () => memoryStore()]];
if (mongoUri) {
  stores.push([
    "mongo",
    async () => {
      const { mongoStore, connect } = await import("../src/store/mongo.js");
      const dbName = `r2_storage_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      const s = await mongoStore(mongoUri, dbName);
      cleanups.push(async () => {
        await (await connect(mongoUri)).db(dbName).dropDatabase();
      });
      return s;
    },
  ]);
}

for (const [label, make] of stores) {
  describe(`${label} store`, () => {
    test("one content hash per app and collection", async () => {
      const s = await make();
      await s.insertAsset(asset({ contentHash: hash("a") }));
      await assert.rejects(s.insertAsset(asset({ contentHash: hash("a") })), (e: unknown) => e instanceof DuplicateKeyError && e.field === "contentHash");
      // Same bytes in another collection, or another app, are fine.
      await s.insertAsset(asset({ contentHash: hash("a"), collection: "finals" }));
      await s.insertAsset(asset({ contentHash: hash("a"), app: "other-app" }));
      // No hash at all never clashes.
      await s.insertAsset(asset());
      await s.insertAsset(asset());
      assert.equal((await s.findByHash("shot-listed", "finals", hash("a")))?.collection, "finals");
    });

    test("one external ID per app", async () => {
      const s = await make();
      await s.insertAsset(asset({ externalId: "photos-1" }));
      await assert.rejects(s.insertAsset(asset({ externalId: "photos-1" })), (e: unknown) => e instanceof DuplicateKeyError && e.field === "externalId");
      await s.insertAsset(asset({ externalId: "photos-1", app: "other-app" }));
    });

    test("updates respect conditions and unique rules", async () => {
      const s = await make();
      const a = asset({ status: "uploading" });
      await s.insertAsset(a);
      await s.insertAsset(asset({ externalId: "taken" }));
      assert.equal(await s.updateAsset("shot-listed", a.id, { size: 5 }, [], { status: "uploaded" }), null);
      assert.equal((await s.updateAsset("shot-listed", a.id, { size: 5 }, [], { status: "uploading" }))?.size, 5);
      await assert.rejects(s.updateAsset("shot-listed", a.id, { externalId: "taken" }), DuplicateKeyError);
      const adopted = await s.updateAsset("shot-listed", a.id, { externalId: "mine" }, [], { externalIdMissing: true });
      assert.equal(adopted?.externalId, "mine");
      assert.equal(await s.updateAsset("shot-listed", a.id, { externalId: "again" }, [], { externalIdMissing: true }), null);
      const unset = await s.updateAsset("shot-listed", a.id, {}, ["externalId"]);
      assert.equal(unset?.externalId, undefined);
      // A field passed as undefined is left alone, not wiped.
      const kept = await s.updateAsset("shot-listed", a.id, { collection: undefined, metadata: undefined, size: 6 });
      assert.equal(kept?.collection, "library");
      assert.deepEqual(kept?.metadata, {});
      // Another app can't touch it.
      assert.equal(await s.updateAsset("other-app", a.id, { size: 1 }), null);
      assert.equal(await s.getAsset("other-app", a.id), null);
    });

    test("lists newest first with a stable cursor", async () => {
      const s = await make();
      const t = Date.now();
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const a = asset({ createdAt: new Date(t - (i < 2 ? 0 : i) * 1000) }); // two share a timestamp
        ids.push(a.id);
        await s.insertAsset(a);
      }
      await s.insertAsset(asset({ collection: "finals" }));
      const first = await s.listAssets("shot-listed", { collection: "library", status: "uploaded", limit: 3 });
      const last = first[first.length - 1];
      const rest = await s.listAssets("shot-listed", {
        collection: "library",
        status: "uploaded",
        limit: 10,
        before: { createdAt: last.createdAt, id: last.id },
      });
      const seen = [...first, ...rest].map((a) => a.id);
      assert.equal(new Set(seen).size, 5);
      assert.deepEqual(seen.sort(), [...ids].sort());
    });

    test("usage counts originals still stored and uploaded variants", async () => {
      const s = await make();
      const now = new Date();
      await s.insertAsset(asset({ size: 1000, kind: "video", contentType: "video/mp4" }));
      const b = asset({ size: 500, hasOriginal: false });
      await s.insertAsset(b);
      await s.putVariant("shot-listed", b.id, { name: "proxy", key: "p", contentType: "video/mp4", size: 200, status: "uploaded", createdAt: now, updatedAt: now });
      await s.putVariant("shot-listed", b.id, { name: "thumb", key: "t", contentType: "image/jpeg", size: 50, status: "uploading", createdAt: now, updatedAt: now });
      await s.insertAsset(asset({ size: 999, status: "uploading" }));
      const rows = await s.usage("shot-listed");
      const total = rows.reduce((t, r) => t + r.bytes, 0);
      assert.equal(total, 1000 + 200);
      assert.equal(rows.reduce((t, r) => t + r.objects, 0), 2);
    });

    test("variants replace by name", async () => {
      const s = await make();
      const a = asset();
      await s.insertAsset(a);
      const now = new Date();
      const v = { name: "thumb", key: "k1", contentType: "image/jpeg", size: 1, status: "uploading" as const, createdAt: now, updatedAt: now };
      await s.putVariant("shot-listed", a.id, v);
      const after2 = await s.putVariant("shot-listed", a.id, { ...v, key: "k2", status: "uploaded" });
      assert.equal(after2?.variants.length, 1);
      assert.equal(after2?.variants[0].key, "k2");
      assert.equal((await s.removeVariant("shot-listed", a.id, "thumb"))?.variants.length, 0);
    });

    test("merge deletes the other and frees its unique fields", async () => {
      const s = await make();
      const kept = asset();
      const other = asset({ externalId: "photos-9", contentHash: hash("b") });
      await s.insertAsset(kept);
      await s.insertAsset(other);
      const merged = await s.merge("shot-listed", kept.id, other.id, {
        externalId: "photos-9",
        contentHash: hash("b"),
        key: other.key,
      });
      assert.equal(merged?.externalId, "photos-9");
      assert.equal(await s.getAsset("shot-listed", other.id), null);
      assert.equal((await s.findByExternalId("shot-listed", "photos-9"))?.id, kept.id);
    });

    test("finds stale uploads by last activity", async () => {
      const s = await make();
      const old = new Date(Date.now() - 2 * 86_400_000);
      await s.insertAsset(asset({ status: "uploading", updatedAt: old }));
      await s.insertAsset(asset({ status: "uploading" }));
      await s.insertAsset(asset({ status: "uploaded", updatedAt: old }));
      const stale = await s.staleUploads(new Date(Date.now() - 86_400_000), 10);
      assert.equal(stale.length, 1);
    });

    test("keys and orphans", async () => {
      const s = await make();
      await s.insertKey({ id: "k", app: "a", name: "n", keyHash: "h", scopes: ["read"], createdAt: new Date() });
      assert.equal((await s.listKeys("a")).length, 1);
      assert.ok(await s.revokeKey("k", new Date()));
      assert.ok((await s.getKey("k"))?.revokedAt);
      assert.equal(await s.revokeKey("nope", new Date()), false);
      await s.addOrphans(["x", "y", "x"]);
      assert.deepEqual((await s.listOrphans(10)).sort(), ["x", "y"]);
      await s.removeOrphan("x");
      assert.deepEqual(await s.listOrphans(10), ["y"]);
    });
  });
}
