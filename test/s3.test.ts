// The R2 layer against any S3-compatible endpoint (ported from Shot Listed).
// Run: npm test                     (pure checks only)
//      R2_TEST_ENDPOINT=http://127.0.0.1:5055 npm test   (needs moto_server -p 5055)
// Set R2_TEST_STRICT=1 only against a real R2 test bucket: mocks don't verify signatures.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { CreateBucketCommand } from "@aws-sdk/client-s3";
import * as r2 from "../src/r2.js";
import { originalKey as appKey } from "../src/keys.js";
import { planParts, MULTIPART_THRESHOLD_BYTES } from "../src/policy.js";
const originalKey = (id: string, type: string) => appKey("test", "library", id, type);

const endpoint = process.env.R2_TEST_ENDPOINT;

describe("r2 against an S3 endpoint", { skip: !endpoint }, () => {
  const bucket = `reel-test-${Date.now()}`;
  const store = r2.createR2({
    accountId: "test",
    accessKeyId: "test",
    secretAccessKey: "test",
    bucket,
    endpoint,
  });

  before(async () => {
    await store.client.send(new CreateBucketCommand({ Bucket: bucket }));
  });
  after(() => store.client.destroy());

  test("single presigned PUT, then head, signed GET and delete", async () => {
    const key = originalKey("single", "image/jpeg");
    const body = new Uint8Array(1234).fill(7);
    const url = await r2.signSinglePut(store, key, "image/jpeg");
    const put = await fetch(url, { method: "PUT", body, headers: { "Content-Type": "image/jpeg" } });
    assert.equal(put.status, 200);

    assert.deepEqual((await r2.headObject(store, key))?.size, 1234);
    const got = await fetch(await r2.signGet(store, key, { downloadName: "photo.jpg" }));
    assert.equal(got.status, 200);
    assert.equal((await got.arrayBuffer()).byteLength, 1234);

    await r2.deleteObject(store, key);
    assert.equal(await r2.headObject(store, key), null);
  });

  test("multipart upload with presigned part URLs", async () => {
    const size = MULTIPART_THRESHOLD_BYTES / 4 + 1024 ** 2; // 17 MiB: three parts of 8, 8, 1
    const { partSize, partCount } = planParts(size);
    const data = new Uint8Array(size);
    for (let i = 0; i < size; i += 4096) data[i] = i % 251;

    const key = originalKey("multi", "video/mp4");
    const uploadId = await r2.startMultipart(store, key, "video/mp4");
    const urls = await r2.signParts(
      store,
      key,
      uploadId,
      Array.from({ length: partCount }, (_, i) => i + 1),
    );
    const parts = await Promise.all(
      urls.map(async ({ partNumber, url }) => {
        const chunk = data.slice((partNumber - 1) * partSize, Math.min(partNumber * partSize, size));
        const res = await fetch(url, { method: "PUT", body: chunk });
        assert.equal(res.status, 200, `part ${partNumber}`);
        return { partNumber, etag: res.headers.get("etag")! };
      }),
    );
    // Complete in shuffled order to prove the wrapper sorts them.
    await r2.completeMultipart(store, key, uploadId, parts.reverse());

    assert.equal((await r2.headObject(store, key))?.size, size);
    const back = new Uint8Array(await (await fetch(await r2.signGet(store, key))).arrayBuffer());
    assert.equal(back.byteLength, size);
    assert.equal(back[4096 * 1000], data[4096 * 1000]);
  });

  test("lists the parts already sent, so a stopped upload can resume", async () => {
    const size = 2 * 8 * 1024 ** 2 + 1000; // three parts: 8 MiB, 8 MiB, 1000 bytes
    const { partSize } = planParts(size);
    const data = new Uint8Array(size).fill(3);
    const key = originalKey("resume", "video/mp4");
    const uploadId = await r2.startMultipart(store, key, "video/mp4");

    // Send parts 1 and 3, then "lose signal".
    const urls = await r2.signParts(store, key, uploadId, [1, 3]);
    for (const { partNumber, url } of urls) {
      const chunk = data.slice((partNumber - 1) * partSize, Math.min(partNumber * partSize, size));
      assert.equal((await fetch(url, { method: "PUT", body: chunk })).status, 200);
    }

    const listed = await r2.listParts(store, key, uploadId);
    assert.deepEqual(listed?.map((p) => [p.partNumber, p.size]), [[1, partSize], [3, 1000]]);
    assert.ok(listed?.every((p) => p.etag));

    // Resume: send only part 2, complete with all three.
    const [{ url }] = await r2.signParts(store, key, uploadId, [2]);
    const res = await fetch(url, { method: "PUT", body: data.slice(partSize, 2 * partSize) });
    await r2.completeMultipart(store, key, uploadId, [
      ...listed!.map(({ partNumber, etag }) => ({ partNumber, etag })),
      { partNumber: 2, etag: res.headers.get("etag")! },
    ]);
    assert.equal((await r2.headObject(store, key))?.size, size);
  });

  test("an upload R2 no longer knows lists as null", async () => {
    const key = originalKey("forgotten", "video/mp4");
    const uploadId = await r2.startMultipart(store, key, "video/mp4");
    await r2.abortMultipart(store, key, uploadId);
    assert.equal(await r2.listParts(store, key, uploadId), null);
  });

  test("aborting a multipart upload leaves nothing behind", async () => {
    const key = originalKey("aborted", "video/mp4");
    const uploadId = await r2.startMultipart(store, key, "video/mp4");
    await r2.abortMultipart(store, key, uploadId);
    assert.equal(await r2.headObject(store, key), null);
  });

  test("a PUT with the wrong Content-Type is rejected", { skip: !process.env.R2_TEST_STRICT }, async () => {
    const key = originalKey("wrongtype", "image/png");
    const url = await r2.signSinglePut(store, key, "image/png");
    const res = await fetch(url, { method: "PUT", body: new Uint8Array(10), headers: { "Content-Type": "image/jpeg" } });
    assert.equal(res.status, 403);
  });
});
