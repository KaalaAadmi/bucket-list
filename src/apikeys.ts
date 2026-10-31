// API keys: `rsk_<id>_<secret>`. Only a hash of the secret is stored; the key is shown once.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ApiKeyRecord, Scope, Store } from "./store/types.js";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const KEY_PATTERN = /^rsk_([a-z2-7]{12})_([A-Za-z0-9_-]{43})$/;

export const ALL_SCOPES: Scope[] = ["read", "write", "delete", "admin"];

function randomId(): string {
  return [...randomBytes(12)].map((b) => BASE32[b % 32]).join("");
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function parseKey(token: string): { id: string; secret: string } | null {
  const m = KEY_PATTERN.exec(token);
  return m ? { id: m[1], secret: m[2] } : null;
}

export async function createKey(
  store: Store,
  input: { app: string; name: string; scopes: Scope[] },
): Promise<{ record: ApiKeyRecord; key: string }> {
  const id = randomId();
  const secret = randomBytes(32).toString("base64url");
  const record: ApiKeyRecord = {
    id,
    app: input.app,
    name: input.name,
    keyHash: hashSecret(secret),
    scopes: [...new Set(input.scopes)],
    createdAt: new Date(),
  };
  await store.insertKey(record);
  return { record, key: `rsk_${id}_${secret}` };
}

/** Looks up and checks a key. Null for anything wrong, so callers can't tell which part failed. */
export async function verifyKey(store: Store, token: string): Promise<ApiKeyRecord | null> {
  const parsed = parseKey(token);
  if (!parsed) return null;
  const record = await store.getKey(parsed.id);
  if (!record || record.revokedAt) return null;
  return safeEqual(record.keyHash, hashSecret(parsed.secret)) ? record : null;
}

export function keyView(k: ApiKeyRecord) {
  return {
    id: k.id,
    app: k.app,
    name: k.name,
    scopes: k.scopes,
    createdAt: k.createdAt.toISOString(),
    lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
    revokedAt: k.revokedAt?.toISOString() ?? null,
  };
}
