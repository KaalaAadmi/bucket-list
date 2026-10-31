// End-to-end check against a running service (local or deployed), using a real API key.
//   STORAGE_API_KEY=rsk_... npm run smoke -- http://localhost:8787
// Uploads into the `smoke-test` collection and deletes everything it made.
import { createHash, randomBytes } from "node:crypto";

const base = process.argv[2] ?? process.env.STORAGE_API_URL ?? "http://localhost:8787";
const key = process.env.STORAGE_API_KEY;
if (!key) {
  console.error("Set STORAGE_API_KEY to a key with read, write and delete scopes.");
  process.exit(1);
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
let step = 0;
const ok = (msg: string) => console.log(`✓ ${++step}. ${msg}`);

async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(new URL(path, base), {
    method,
    headers: { Authorization: `Bearer ${key}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = (text ? JSON.parse(text) : null) as T;
  if (res.status >= 400 && res.status !== 404) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  return { status: res.status, json };
}

async function put(url: string, data: Uint8Array, headers: Record<string, string> = {}): Promise<string> {
  const res = await fetch(url, { method: "PUT", body: data as unknown as BodyInit, headers });
  if (!res.ok) throw new Error(`PUT to R2 failed: ${res.status} ${await res.text()}`);
  return res.headers.get("etag") ?? "";
}

type Start = {
  mode: string;
  assetId: string;
  url?: string;
  headers?: Record<string, string>;
  partSize?: number;
  partCount?: number;
  uploadedParts?: { partNumber: number; etag: string; size: number }[];
};

async function main() {
  const health = await fetch(new URL("/v1/health", base));
  if (!health.ok) throw new Error(`Health check failed: ${health.status}`);
  ok(`health: ${JSON.stringify(await health.json())}`);

  // Small file: one PUT.
  const small = randomBytes(1024);
  const smallReq = { collection: "smoke-test", filename: "smoke.jpg", contentType: "image/jpeg", size: small.length, contentHash: sha(small) };
  const s1 = (await api<Start>("POST", "/v1/uploads", smallReq)).json;
  if (s1.mode !== "single") throw new Error(`expected single, got ${s1.mode}`);
  await put(s1.url!, small, s1.headers);
  await api("POST", `/v1/uploads/${s1.assetId}/complete`, {});
  ok("1 KB upload");

  const again = (await api<Start>("POST", "/v1/uploads", smallReq)).json;
  if (again.mode !== "duplicate" || again.assetId !== s1.assetId) throw new Error(`expected duplicate, got ${again.mode}`);
  ok("same 1 KB again → duplicate");

  // Big file: stop after 3 parts, then resume.
  const big = randomBytes(70 * 1024 ** 2);
  const bigReq = { collection: "smoke-test", filename: "smoke.mp4", contentType: "video/mp4", size: big.length, contentHash: sha(big) };
  const m1 = (await api<Start>("POST", "/v1/uploads", bigReq)).json;
  if (m1.mode !== "multipart") throw new Error(`expected multipart, got ${m1.mode}`);
  const partSize = m1.partSize!;
  const slice = (n: number) => big.subarray((n - 1) * partSize, Math.min(n * partSize, big.length));
  const sign = async (nums: number[]) =>
    (await api<{ parts: { partNumber: number; url: string }[] }>("POST", `/v1/uploads/${m1.assetId}/parts`, { partNumbers: nums })).json.parts;
  for (const p of await sign([1, 2, 3])) await put(p.url, slice(p.partNumber));
  ok(`70 MB upload: sent 3 of ${m1.partCount} parts, then "lost signal"`);

  const r = (await api<Start>("POST", "/v1/uploads", bigReq)).json;
  if (r.mode !== "resume" || r.assetId !== m1.assetId || r.uploadedParts?.length !== 3) {
    throw new Error(`expected resume with 3 parts, got ${r.mode} with ${r.uploadedParts?.length ?? 0}`);
  }
  ok("created again → resume with those 3 parts, same asset");

  const missing = Array.from({ length: m1.partCount! }, (_, i) => i + 1).filter((n) => n > 3);
  const etags = r.uploadedParts!.map(({ partNumber, etag }) => ({ partNumber, etag }));
  for (const p of await sign(missing)) etags.push({ partNumber: p.partNumber, etag: await put(p.url, slice(p.partNumber)) });
  await api("POST", `/v1/uploads/${m1.assetId}/complete`, { parts: etags });
  ok(`sent the other ${missing.length} parts and completed`);

  const { url } = (await api<{ url: string }>("POST", `/v1/assets/${m1.assetId}/url`, {})).json;
  const back = new Uint8Array(await (await fetch(url)).arrayBuffer());
  if (sha(back) !== bigReq.contentHash) throw new Error("downloaded bytes differ");
  ok("signed link returns the same bytes");

  // Variant.
  const thumb = randomBytes(512);
  const v = (await api<{ url: string; headers: Record<string, string> }>("POST", `/v1/assets/${m1.assetId}/variants`, {
    name: "thumb",
    contentType: "image/jpeg",
    size: thumb.length,
  })).json;
  await put(v.url, thumb, v.headers);
  await api("POST", `/v1/assets/${m1.assetId}/variants/thumb/complete`);
  ok("thumbnail variant");

  const usage = (await api<{ byCollection: { collection: string; bytes: number }[] }>("GET", "/v1/usage")).json;
  const smoke = usage.byCollection.find((c) => c.collection === "smoke-test");
  if (!smoke || smoke.bytes < big.length) throw new Error("usage doesn't include the smoke files");
  ok(`usage counts them (${(smoke.bytes / 1024 ** 2).toFixed(1)} MB in smoke-test)`);

  for (const id of [s1.assetId, m1.assetId]) await api("DELETE", `/v1/assets/${id}`);
  const gone = await api("GET", `/v1/assets/${m1.assetId}`);
  if (gone.status !== 404) throw new Error(`expected 404 after delete, got ${gone.status}`);
  const fileGone = await fetch(url);
  if (fileGone.ok) throw new Error("the file is still readable after delete");
  ok("deleted; asset and file are gone");

  console.log("\nAll smoke checks passed.");
}

main().catch((err) => {
  console.error(`\n✗ ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
