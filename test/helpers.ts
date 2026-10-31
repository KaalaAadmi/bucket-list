// Shared setup: the real app with an in-memory store, and moto standing in for R2.
//   moto_server -p 5055 &   then   R2_TEST_ENDPOINT=http://127.0.0.1:5055 npm test
import { CreateBucketCommand } from "@aws-sdk/client-s3";
import { createKey } from "../src/apikeys.js";
import { createApp } from "../src/app.js";
import { createR2, type R2 } from "../src/r2.js";
import { memoryStore } from "../src/store/memory.js";
import type { Scope, Store } from "../src/store/types.js";

export const S3_ENDPOINT = process.env.R2_TEST_ENDPOINT;
export const ADMIN_TOKEN = "a".repeat(64);
export const CRON_SECRET = "c".repeat(32);

let bucketSeq = 0;

export async function setup(opts: { s3?: boolean } = {}) {
  const store: Store = memoryStore();
  const bucketName = `bucket-list-test-${Date.now()}-${bucketSeq++}`;
  const bucket: R2 = createR2({
    accountId: "test",
    accessKeyId: "test",
    secretAccessKey: "test",
    bucket: bucketName,
    endpoint: S3_ENDPOINT ?? "http://127.0.0.1:1",
  });
  if (opts.s3) await bucket.client.send(new CreateBucketCommand({ Bucket: bucketName }));
  const app = createApp(async () => ({ store, r2: bucket, adminToken: ADMIN_TOKEN, cronSecret: CRON_SECRET, freeTierBytes: 10 * 1024 ** 3 }));

  async function key(appName = "shot-listed", scopes: Scope[] = ["read", "write", "delete"]) {
    return (await createKey(store, { app: appName, name: "test", scopes })).key;
  }

  async function call<T = any>(method: string, path: string, opts: { body?: unknown; token?: string } = {}) {
    const res = await app.request(path, {
      method,
      headers: {
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, json: (text ? JSON.parse(text) : null) as T };
  }

  return { app, store, bucket, key, call, destroy: () => bucket.client.destroy() };
}

export async function put(url: string, body: Uint8Array, headers: Record<string, string> = {}) {
  const res = await fetch(url, { method: "PUT", body: body as unknown as BodyInit, headers });
  if (!res.ok) throw new Error(`PUT failed: ${res.status}`);
  return res.headers.get("etag") ?? "";
}
