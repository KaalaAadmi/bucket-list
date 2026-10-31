// The HTTP API (v1). Routes validate input, check the caller's key and scopes, then call
// src/assets.ts. Built as a factory so tests can pass an in-memory store and a local S3.
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { z, ZodError } from "zod";
import { ALL_SCOPES, createKey, keyView, safeEqual, verifyKey } from "./apikeys.js";
import * as assets from "./assets.js";
import { badRequest, HttpError, notFound } from "./errors.js";
import { CONTENT_HASH_PATTERN, MAX_LIST_LIMIT, MAX_VIEW_URL_TTL_S, NAME_PATTERN } from "./policy.js";
import type { R2 } from "./r2.js";
import type { ApiKeyRecord, Scope, Store } from "./store/types.js";

export const VERSION = "0.1.0";

export type Deps = {
  store: Store;
  r2: R2;
  adminToken: string;
  cronSecret?: string;
  freeTierBytes: number;
};

type Env = { Variables: { deps: Deps; key: ApiKeyRecord } };

const name = z.string().regex(NAME_PATTERN, "must be lowercase letters, digits and dashes, up to 32 characters");
const kind = z.enum(["photo", "video", "file"]);
const metadata = z.record(z.string(), z.unknown());

const schemas = {
  createUpload: z.object({
    collection: name,
    filename: z.string().min(1).max(255),
    contentType: z.string().max(100).optional(),
    size: z.number().int().positive(),
    contentHash: z.string().regex(CONTENT_HASH_PATTERN, "must be a SHA-256 hex digest").optional(),
    externalId: z.string().min(1).max(200).optional(),
    takenAt: z.string().datetime({ offset: true }).optional(),
    metadata: metadata.optional(),
    maxBytes: z.number().int().positive().optional(),
    kinds: z.array(kind).min(1).optional(),
  }),
  parts: z.object({ partNumbers: z.array(z.number().int().positive()).min(1).max(100) }),
  complete: z.object({
    parts: z.array(z.object({ partNumber: z.number().int().positive(), etag: z.string().min(1) })).max(10_000).optional(),
  }),
  url: z.object({
    variant: z.string().max(32).optional(),
    download: z.boolean().optional(),
    expiresIn: z.number().int().min(60).max(MAX_VIEW_URL_TTL_S).optional(),
  }),
  urls: z.object({
    items: z.array(z.object({ id: z.string().min(1), variant: z.string().max(32).optional() })).min(1).max(100),
    expiresIn: z.number().int().min(60).max(MAX_VIEW_URL_TTL_S).optional(),
  }),
  patch: z.object({
    metadata: metadata.optional(),
    takenAt: z.string().datetime({ offset: true }).nullable().optional(),
    collection: name.optional(),
    filename: z.string().min(1).max(255).optional(),
    contentHash: z.string().regex(CONTENT_HASH_PATTERN).optional(),
    externalId: z.string().min(1).max(200).optional(),
  }),
  merge: z.object({ from: z.string().min(1), keepOriginal: z.enum(["this", "from"]) }),
  variant: z.object({ name, contentType: z.string().min(1).max(100), size: z.number().int().positive() }),
  key: z.object({ app: name, name: z.string().min(1).max(64), scopes: z.array(z.enum(ALL_SCOPES as [Scope, ...Scope[]])).min(1) }),
};

async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  const raw = await c.req.text();
  let json: unknown = {};
  if (raw.trim()) {
    try {
      json = JSON.parse(raw);
    } catch {
      throw badRequest("Body must be JSON");
    }
  }
  return schema.parse(json);
}

function bearer(c: Context): string | null {
  const h = c.req.header("authorization") ?? "";
  return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : null;
}

const TOUCH_EVERY_MS = 60 * 60 * 1000;

export function createApp(getDeps: () => Promise<Deps>) {
  const app = new Hono<Env>();

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: { code: err.code, message: err.message } }, err.status);
    if (err instanceof ZodError) {
      const issue = err.issues[0];
      const where = issue?.path.join(".");
      return c.json({ error: { code: "bad_request", message: where ? `${where}: ${issue.message}` : (issue?.message ?? "Invalid request") } }, 400);
    }
    console.error(err);
    return c.json({ error: { code: "internal", message: "Something went wrong" } }, 500);
  });
  app.notFound((c) => c.json({ error: { code: "not_found", message: "No such route" } }, 404));

  app.use("/v1/*", async (c, next) => {
    c.set("deps", await getDeps());
    await next();
  });

  /** API key with every listed scope. Asset IDs from other apps then look missing. */
  const requireKey = (...scopes: Scope[]): MiddlewareHandler<Env> => async (c, next) => {
    const token = bearer(c);
    const deps = c.get("deps");
    const key = token ? await verifyKey(deps.store, token) : null;
    if (!key) throw new HttpError(401, "unauthorized", "Missing, invalid or revoked API key");
    const missing = scopes.filter((s) => !key.scopes.includes(s));
    if (missing.length) throw new HttpError(403, "forbidden", `This key lacks the ${missing.join(", ")} scope`);
    if (!key.lastUsedAt || Date.now() - key.lastUsedAt.getTime() > TOUCH_EVERY_MS) {
      await deps.store.touchKey(key.id, new Date()).catch(() => undefined);
    }
    c.set("key", key);
    await next();
  };

  /** ADMIN_TOKEN, or a key with the admin scope. */
  const requireAdmin: MiddlewareHandler<Env> = async (c, next) => {
    const token = bearer(c);
    const deps = c.get("deps");
    if (token && safeEqual(token, deps.adminToken)) return next();
    const key = token ? await verifyKey(deps.store, token) : null;
    if (!key) throw new HttpError(401, "unauthorized", "Missing or invalid admin token");
    if (!key.scopes.includes("admin")) throw new HttpError(403, "forbidden", "This key lacks the admin scope");
    return next();
  };

  const ctx = (c: Context<Env>): assets.Ctx => {
    const deps = c.get("deps");
    return { store: deps.store, r2: deps.r2, app: c.get("key").app, freeTierBytes: deps.freeTierBytes };
  };

  app.get("/v1/health", (c) => c.json({ ok: true, version: VERSION }));

  // ----- Uploads
  app.post("/v1/uploads", requireKey("write"), async (c) => {
    const result = await assets.createUpload(ctx(c), await body(c, schemas.createUpload));
    return c.json(result, result.mode === "duplicate" ? 200 : 201);
  });
  app.get("/v1/uploads/:id", requireKey("write"), async (c) => c.json(await assets.uploadState(ctx(c), c.req.param("id"))));
  app.post("/v1/uploads/:id/parts", requireKey("write"), async (c) => {
    const { partNumbers } = await body(c, schemas.parts);
    return c.json({ parts: await assets.signUploadParts(ctx(c), c.req.param("id"), partNumbers) });
  });
  app.post("/v1/uploads/:id/complete", requireKey("write"), async (c) => {
    const { parts } = await body(c, schemas.complete);
    return c.json({ asset: await assets.completeUpload(ctx(c), c.req.param("id"), parts) });
  });
  app.delete("/v1/uploads/:id", requireKey("delete"), async (c) => {
    await assets.abortUpload(ctx(c), c.req.param("id"));
    return c.body(null, 204);
  });

  // ----- Assets
  app.get("/v1/assets", requireKey("read"), async (c) => {
    const q = c.req.query();
    const limit = Math.min(Math.max(Number(q.limit ?? 48) || 48, 1), MAX_LIST_LIMIT);
    const status = q.status === "uploading" ? "uploading" : "uploaded";
    return c.json(
      await assets.listAssets(ctx(c), {
        collection: q.collection ? name.parse(q.collection) : undefined,
        kind: q.kind ? kind.parse(q.kind) : undefined,
        status,
        before: q.before || undefined,
        limit,
        urls: q.urls || undefined,
      }),
    );
  });
  app.post("/v1/assets/urls", requireKey("read"), async (c) => {
    const { items, expiresIn } = await body(c, schemas.urls);
    return c.json(await assets.signUrls(ctx(c), items, expiresIn));
  });
  app.get("/v1/assets/:id", requireKey("read"), async (c) => c.json({ asset: await assets.getAsset(ctx(c), c.req.param("id")) }));
  app.post("/v1/assets/:id/url", requireKey("read"), async (c) =>
    c.json(await assets.signUrl(ctx(c), c.req.param("id"), await body(c, schemas.url))),
  );
  app.patch("/v1/assets/:id", requireKey("write"), async (c) =>
    c.json({ asset: await assets.patchAsset(ctx(c), c.req.param("id"), await body(c, schemas.patch)) }),
  );
  app.delete("/v1/assets/:id", requireKey("delete"), async (c) => {
    await assets.deleteAsset(ctx(c), c.req.param("id"));
    return c.body(null, 204);
  });
  app.post("/v1/assets/:id/merge", requireKey("write", "delete"), async (c) =>
    c.json({ asset: await assets.mergeAssets(ctx(c), c.req.param("id"), await body(c, schemas.merge)) }),
  );

  // ----- Variants and originals
  app.post("/v1/assets/:id/variants", requireKey("write"), async (c) =>
    c.json(await assets.createVariant(ctx(c), c.req.param("id"), await body(c, schemas.variant)), 201),
  );
  app.post("/v1/assets/:id/variants/:name/complete", requireKey("write"), async (c) =>
    c.json({ asset: await assets.completeVariant(ctx(c), c.req.param("id"), c.req.param("name")) }),
  );
  app.delete("/v1/assets/:id/variants/:name", requireKey("delete"), async (c) =>
    c.json({ asset: await assets.deleteVariant(ctx(c), c.req.param("id"), c.req.param("name")) }),
  );
  app.delete("/v1/assets/:id/original", requireKey("delete"), async (c) =>
    c.json({ asset: await assets.dropOriginal(ctx(c), c.req.param("id")) }),
  );

  // ----- Usage
  app.get("/v1/usage", requireKey("read"), async (c) => c.json(await assets.usage(ctx(c))));

  // ----- Keys (admin)
  app.post("/v1/keys", requireAdmin, async (c) => {
    const input = await body(c, schemas.key);
    const { record, key } = await createKey(c.get("deps").store, input);
    return c.json({ ...keyView(record), key }, 201);
  });
  app.get("/v1/keys", requireAdmin, async (c) => {
    const appName = c.req.query("app");
    return c.json({ keys: (await c.get("deps").store.listKeys(appName || undefined)).map(keyView) });
  });
  app.delete("/v1/keys/:id", requireAdmin, async (c) => {
    if (!(await c.get("deps").store.revokeKey(c.req.param("id"), new Date()))) throw notFound("No such key");
    return c.body(null, 204);
  });

  // ----- Daily cleanup (Vercel Cron sends `Authorization: Bearer $CRON_SECRET`)
  app.get("/v1/cron/cleanup", async (c) => {
    const deps = c.get("deps");
    const token = bearer(c);
    const ok = token && ((deps.cronSecret && safeEqual(token, deps.cronSecret)) || safeEqual(token, deps.adminToken));
    if (!ok) throw new HttpError(401, "unauthorized", "Cron secret required");
    return c.json(await assets.cleanup(deps.store, deps.r2));
  });

  return app;
}
