import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { hashSecret, parseKey, safeEqual } from "../src/apikeys.js";
import { decideUpload } from "../src/dedupe.js";
import { originalKey, safeFilename, variantKey } from "../src/keys.js";
import { expectedPartSize, kindOf, NAME_PATTERN, planParts, resolveContentType } from "../src/policy.js";

describe("upload rules", () => {
  test("falls back to the file extension when iOS sends no type", () => {
    assert.equal(resolveContentType("IMG_0001.MOV", ""), "video/quicktime");
    assert.equal(resolveContentType("IMG_0002.HEIC", "application/octet-stream"), "image/heic");
    assert.equal(resolveContentType("pack.zip", undefined), "application/zip");
    assert.equal(resolveContentType("virus.exe", "application/x-msdownload"), null);
  });

  test("zips and documents are files", () => {
    assert.equal(kindOf("application/zip"), "file");
    assert.equal(kindOf("video/mp4"), "video");
  });

  test("plans parts within S3 limits", () => {
    assert.deepEqual(planParts(17 * 1024 ** 2), { partSize: 8 * 1024 ** 2, partCount: 3 });
    const huge = planParts(5 * 1024 ** 3);
    assert.ok(huge.partCount <= 10_000 && huge.partSize >= 5 * 1024 ** 2);
    const size = 17 * 1024 ** 2;
    const sum = [1, 2, 3].reduce((t, n) => t + expectedPartSize(size, 8 * 1024 ** 2, n), 0);
    assert.equal(sum, size);
  });

  test("keys carry the app and collection", () => {
    const at = new Date("2026-10-29T09:00:00Z");
    assert.equal(originalKey("shot-listed", "library", "abc", "video/quicktime", at), "apps/shot-listed/library/2026/10/abc.mov");
    assert.equal(variantKey("shot-listed", "abc", "thumb", "image/jpeg"), "apps/shot-listed/variants/abc/thumb.jpg");
    assert.equal(safeFilename('a"b\\c/d.jpg'), "a_b_c_d.jpg");
  });

  test("names are short and lowercase", () => {
    assert.ok(NAME_PATTERN.test("clip-packs"));
    assert.ok(!NAME_PATTERN.test("Clip Packs"));
    assert.ok(!NAME_PATTERN.test("a".repeat(33)));
  });
});

describe("duplicate rules", () => {
  const uploaded = { id: "a", status: "uploaded" as const, size: 10 };
  const uploading = { id: "b", status: "uploading" as const, size: 10 };

  test("new bytes start a new upload", () => assert.deepEqual(decideUpload({ size: 10 }), { action: "new" }));
  test("same bytes are a duplicate", () =>
    assert.deepEqual(decideUpload({ size: 10, byHash: uploaded }), { action: "duplicate", id: "a", adoptExternalId: false }));
  test("the Mac adopts an item the phone uploaded", () =>
    assert.deepEqual(decideUpload({ size: 10, externalId: "p", byHash: uploaded }), { action: "duplicate", id: "a", adoptExternalId: true }));
  test("unfinished uploads resume", () => assert.deepEqual(decideUpload({ size: 10, byHash: uploading }), { action: "resume", id: "b" }));
  test("external ID wins over the hash", () =>
    assert.deepEqual(decideUpload({ size: 10, externalId: "p", byExternalId: uploading, byHash: uploaded }), { action: "resume", id: "b" }));
  test("a hash with a different size is refused", () => assert.equal(decideUpload({ size: 11, byHash: uploaded }).action, "reject"));
});

describe("API keys", () => {
  test("parses only well-formed keys", () => {
    const secret = Buffer.alloc(32, 7).toString("base64url");
    assert.deepEqual(parseKey(`rsk_abcdefghijk2_${secret}`), { id: "abcdefghijk2", secret });
    assert.equal(parseKey("rsk_short_x"), null);
    assert.equal(parseKey(`Bearer rsk_abcdefghijk2_${secret}`), null);
  });

  test("stores a SHA-256 of the secret and compares in constant time", () => {
    assert.equal(hashSecret("x"), createHash("sha256").update("x").digest("hex"));
    assert.ok(safeEqual("abc", "abc"));
    assert.ok(!safeEqual("abc", "abd"));
    assert.ok(!safeEqual("abc", "abcd"));
  });
});
