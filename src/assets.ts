// What the API does with files: uploads (with duplicate checks and resuming), the asset
// registry, signed links, variants, merging and usage. Routes only validate and call these.
import { randomUUID } from "node:crypto";
import { badRequest, conflict, DuplicateKeyError, HttpError, notFound } from "./errors.js";
import { decideUpload } from "./dedupe.js";
import { originalKey, safeFilename, variantKey } from "./keys.js";
import {
  CONTENT_HASH_PATTERN,
  kindOf,
  MAX_FILE_BYTES,
  MAX_METADATA_BYTES,
  MAX_PARTS_PER_REQUEST,
  MULTIPART_THRESHOLD_BYTES,
  NAME_PATTERN,
  planParts,
  resolveContentType,
  STALE_UPLOAD_MS,
  type Kind,
} from "./policy.js";
import * as r2 from "./r2.js";
import type { AssetRecord, Store, Variant } from "./store/types.js";

/** Everything a request needs: the store, the bucket, and which app is asking. */
export type Ctx = { store: Store; r2: r2.R2; app: string; freeTierBytes: number };

// ---------- Views ----------

export type AssetView = ReturnType<typeof view>;

export function view(a: AssetRecord) {
  return {
    id: a.id,
    collection: a.collection,
    filename: a.filename,
    contentType: a.contentType,
    kind: a.kind,
    size: a.size,
    contentHash: a.contentHash ?? null,
    externalId: a.externalId ?? null,
    takenAt: a.takenAt?.toISOString() ?? null,
    status: a.status,
    hasOriginal: a.hasOriginal,
    metadata: a.metadata,
    variants: a.variants.map((v) => ({ name: v.name, contentType: v.contentType, size: v.size, status: v.status })),
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

async function mustGet(ctx: Ctx, id: string): Promise<AssetRecord> {
  const a = await ctx.store.getAsset(ctx.app, id);
  if (!a) throw notFound(); // another app's asset looks exactly like a missing one
  return a;
}

function checkMetadata(metadata: Record<string, unknown> | undefined) {
  if (metadata && Buffer.byteLength(JSON.stringify(metadata)) > MAX_METADATA_BYTES) {
    throw badRequest("metadata must be at most 4 KB of JSON");
  }
}

// ---------- Uploads ----------

export type CreateUploadInput = {
  collection: string;
  filename: string;
  contentType?: string;
  size: number;
  contentHash?: string;
  externalId?: string;
  takenAt?: string;
  metadata?: Record<string, unknown>;
  /** Limits the caller wants enforced, e.g. final cuts: video only, under 500 MB. */
  maxBytes?: number;
  kinds?: Kind[];
};

export type UploadedPart = { partNumber: number; etag: string; size: number };

export type UploadResult =
  | { mode: "duplicate"; assetId: string; adopted: boolean }
  | { mode: "single"; assetId: string; url: string; headers: Record<string, string> }
  | { mode: "multipart"; assetId: string; partSize: number; partCount: number }
  | { mode: "resume"; assetId: string; partSize: number; partCount: number; uploadedParts: UploadedPart[] };

/**
 * Start an upload, carry on with an unfinished one, or report that the file is stored.
 * Rules (src/dedupe.ts): external ID first, then content hash within the collection.
 */
export async function createUpload(ctx: Ctx, input: CreateUploadInput): Promise<UploadResult> {
  if (!NAME_PATTERN.test(input.collection)) throw badRequest("collection must match [a-z0-9-], up to 32 characters");
  const contentType = resolveContentType(input.filename, input.contentType);
  if (!contentType) throw new HttpError(415, "unsupported_type", `Unsupported file type: ${input.filename}`);
  const kind = kindOf(contentType)!;
  if (input.kinds && !input.kinds.includes(kind)) {
    throw new HttpError(415, "unsupported_type", `Only ${input.kinds.join(" or ")} files are allowed here`);
  }
  if (input.size <= 0) throw badRequest("Empty file");
  const limit = Math.min(MAX_FILE_BYTES, input.maxBytes ?? MAX_FILE_BYTES);
  if (input.size > limit) {
    throw new HttpError(413, "too_large", `File is larger than ${Math.floor(limit / 1024 ** 2)} MB`);
  }
  if (input.contentHash && !CONTENT_HASH_PATTERN.test(input.contentHash)) {
    throw badRequest("contentHash must be a SHA-256 hex digest");
  }
  checkMetadata(input.metadata);

  for (let attempt = 0; attempt < 2; attempt++) {
    const [byExternalId, byHash] = await Promise.all([
      input.externalId ? ctx.store.findByExternalId(ctx.app, input.externalId) : null,
      input.contentHash ? ctx.store.findByHash(ctx.app, input.collection, input.contentHash) : null,
    ]);
    const decision = decideUpload({
      size: input.size,
      externalId: input.externalId,
      byExternalId: byExternalId && existing(byExternalId),
      byHash: byHash && existing(byHash),
    });

    switch (decision.action) {
      case "reject":
        throw badRequest(decision.message);
      case "duplicate":
        if (decision.adoptExternalId) {
          // The phone uploaded these bytes first; remember the Mac's Photos ID so re-runs match.
          await ctx.store
            .updateAsset(ctx.app, decision.id, { externalId: input.externalId, updatedAt: new Date() }, [], {
              externalIdMissing: true,
            })
            .catch(ignoreDuplicate);
        }
        return { mode: "duplicate", assetId: decision.id, adopted: decision.adoptExternalId };
      case "resume":
        return resume(ctx, byExternalId?.id === decision.id ? byExternalId! : byHash!);
      case "new": {
        const created = await startNew(ctx, input, contentType, kind);
        if (created) return created;
        // Lost a race with an identical request: loop once and resume the winner's upload.
      }
    }
  }
  throw conflict("This file is being uploaded from somewhere else; try again in a moment");
}

function existing(a: AssetRecord) {
  return { id: a.id, status: a.status, size: a.size, externalId: a.externalId };
}

function ignoreDuplicate(err: unknown) {
  if (!(err instanceof DuplicateKeyError)) throw err;
}

async function startNew(
  ctx: Ctx,
  input: CreateUploadInput,
  contentType: string,
  kind: Kind,
): Promise<UploadResult | null> {
  const now = new Date();
  const id = randomUUID();
  const key = originalKey(ctx.app, input.collection, id, contentType, now);
  const record: AssetRecord = {
    id,
    app: ctx.app,
    collection: input.collection,
    key,
    filename: safeFilename(input.filename),
    contentType,
    kind,
    size: input.size,
    contentHash: input.contentHash,
    externalId: input.externalId,
    takenAt: input.takenAt ? new Date(input.takenAt) : undefined,
    status: "uploading",
    hasOriginal: true,
    metadata: input.metadata ?? {},
    variants: [],
    createdAt: now,
    updatedAt: now,
  };

  if (input.size > MULTIPART_THRESHOLD_BYTES) {
    const { partSize, partCount } = planParts(input.size);
    const uploadId = await r2.startMultipart(ctx.r2, key, contentType);
    if (!(await insertUnlessDuplicate(ctx, { ...record, multipart: { uploadId, partSize, partCount } }))) {
      await r2.abortMultipart(ctx.r2, key, uploadId).catch(() => undefined);
      return null;
    }
    return { mode: "multipart", assetId: id, partSize, partCount };
  }

  if (!(await insertUnlessDuplicate(ctx, record))) return null;
  const url = await r2.signSinglePut(ctx.r2, key, contentType);
  return { mode: "single", assetId: id, url, headers: { "Content-Type": contentType } };
}

async function insertUnlessDuplicate(ctx: Ctx, record: AssetRecord): Promise<boolean> {
  try {
    await ctx.store.insertAsset(record);
    return true;
  } catch (err) {
    if (err instanceof DuplicateKeyError) return false;
    throw err;
  }
}

/** Same asset, same key: nothing is stored twice and parts R2 already has aren't sent again. */
async function resume(ctx: Ctx, asset: AssetRecord): Promise<UploadResult> {
  const touch = { updatedAt: new Date() }; // keeps the daily cleanup off a live upload

  if (!asset.multipart) {
    // A cut-off single PUT leaves nothing in R2: a fresh link to the same key is enough.
    await ctx.store.updateAsset(ctx.app, asset.id, touch);
    const url = await r2.signSinglePut(ctx.r2, asset.key, asset.contentType);
    return { mode: "single", assetId: asset.id, url, headers: { "Content-Type": asset.contentType } };
  }

  const { uploadId, partSize, partCount } = asset.multipart;
  const uploadedParts = await r2.listParts(ctx.r2, asset.key, uploadId);
  if (uploadedParts) {
    await ctx.store.updateAsset(ctx.app, asset.id, touch);
    return { mode: "resume", assetId: asset.id, partSize, partCount, uploadedParts };
  }

  // R2 forgot the upload (lifecycle rule, or aborted): start a new one on the same asset.
  const newUploadId = await r2.startMultipart(ctx.r2, asset.key, asset.contentType);
  await ctx.store.updateAsset(ctx.app, asset.id, { ...touch, multipart: { uploadId: newUploadId, partSize, partCount } });
  return { mode: "multipart", assetId: asset.id, partSize, partCount };
}

/** For a caller that kept the asset ID: where did this upload get to? */
export async function uploadState(ctx: Ctx, id: string): Promise<UploadResult> {
  const asset = await mustGet(ctx, id);
  if (asset.status === "uploaded") return { mode: "duplicate", assetId: asset.id, adopted: false };
  return resume(ctx, asset);
}

async function uploading(ctx: Ctx, id: string): Promise<AssetRecord> {
  const asset = await mustGet(ctx, id);
  if (asset.status !== "uploading") throw conflict("Upload already finished");
  return asset;
}

export async function signUploadParts(ctx: Ctx, id: string, partNumbers: number[]) {
  const asset = await uploading(ctx, id);
  if (!asset.multipart) throw badRequest("This upload is a single PUT, not multipart");
  if (partNumbers.length === 0 || partNumbers.length > MAX_PARTS_PER_REQUEST) {
    throw badRequest(`Ask for 1 to ${MAX_PARTS_PER_REQUEST} parts at a time`);
  }
  const { partCount, uploadId } = asset.multipart;
  if (partNumbers.some((n) => !Number.isInteger(n) || n < 1 || n > partCount)) {
    throw badRequest(`Part numbers must be between 1 and ${partCount}`);
  }
  await ctx.store.updateAsset(ctx.app, id, { updatedAt: new Date() });
  return r2.signParts(ctx.r2, asset.key, uploadId, partNumbers);
}

export async function completeUpload(
  ctx: Ctx,
  id: string,
  parts: { partNumber: number; etag: string }[] | undefined,
): Promise<AssetView> {
  const asset = await mustGet(ctx, id);
  // Two attempts at the same file can both finish; the second just gets the result.
  if (asset.status === "uploaded") return view(asset);

  if (asset.multipart) {
    const { partCount, uploadId } = asset.multipart;
    const unique = new Set(parts?.map((p) => p.partNumber));
    if (!parts || unique.size !== partCount) throw badRequest(`Expected ${partCount} parts, got ${unique.size}`);
    await r2.completeMultipart(ctx.r2, asset.key, uploadId, parts).catch(async (err) => {
      // Another attempt at the same file may have finished it a moment ago.
      const already = await r2.headObject(ctx.r2, asset.key);
      if (!already || already.size !== asset.size) throw err;
    });
  }

  // Trust R2, not the caller: the object must exist at the size we were promised.
  const stored = await r2.headObject(ctx.r2, asset.key);
  if (!stored) throw conflict("R2 has no file yet; finish the upload first");
  if (stored.size !== asset.size) {
    await discard(ctx, asset);
    throw new HttpError(422, "size_mismatch", `Size mismatch (expected ${asset.size}, R2 has ${stored.size}); upload discarded`);
  }

  const done = await ctx.store.updateAsset(ctx.app, id, { status: "uploaded", updatedAt: new Date() }, ["multipart"]);
  return view(done ?? (await mustGet(ctx, id)));
}

export async function abortUpload(ctx: Ctx, id: string): Promise<void> {
  await discard(ctx, await uploading(ctx, id));
}

async function discard(ctx: Ctx, asset: AssetRecord): Promise<void> {
  if (asset.multipart) {
    await r2.abortMultipart(ctx.r2, asset.key, asset.multipart.uploadId).catch(() => undefined);
  }
  await removeObjects(ctx.store, ctx.r2, [asset.key]);
  await ctx.store.deleteAsset(asset.app, asset.id);
}

/** Deletes objects; anything that fails is recorded and retried by the daily cleanup. */
async function removeObjects(store: Store, bucket: r2.R2, keys: string[]): Promise<void> {
  const failed: string[] = [];
  await Promise.all(
    keys.map((k) =>
      r2.deleteObject(bucket, k).catch(() => {
        failed.push(k);
      }),
    ),
  );
  if (failed.length) await store.addOrphans(failed);
}

// ---------- Assets ----------

const encodeCursor = (a: AssetRecord) => Buffer.from(`${a.createdAt.toISOString()}|${a.id}`).toString("base64url");

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const [at, id] = Buffer.from(cursor, "base64url").toString().split("|");
  const createdAt = new Date(at);
  if (!id || Number.isNaN(createdAt.getTime())) throw badRequest("Invalid cursor");
  return { createdAt, id };
}

/** Which object a link should open: the variant if it exists, else the original, else the proxy. */
function objectFor(a: AssetRecord, variant?: string): Variant | { key: string } | null {
  const named = variant && variant !== "original" ? a.variants.find((v) => v.name === variant && v.status === "uploaded") : undefined;
  if (named) return named;
  if (a.hasOriginal) return { key: a.key };
  return a.variants.find((v) => v.name === "proxy" && v.status === "uploaded") ?? null;
}

export async function listAssets(
  ctx: Ctx,
  q: { collection?: string; kind?: Kind; status?: "uploading" | "uploaded"; before?: string; limit: number; urls?: string },
) {
  const rows = await ctx.store.listAssets(ctx.app, {
    collection: q.collection,
    kind: q.kind,
    status: q.status ?? "uploaded",
    before: q.before ? decodeCursor(q.before) : undefined,
    limit: q.limit + 1,
  });
  const page = rows.slice(0, q.limit);
  const items = await Promise.all(
    page.map(async (a) => {
      if (!q.urls || a.status !== "uploaded") return view(a);
      const obj = objectFor(a, q.urls);
      return { ...view(a), url: obj ? await r2.signGet(ctx.r2, obj.key) : null };
    }),
  );
  return { items, next: rows.length > q.limit ? encodeCursor(page[page.length - 1]) : null };
}

export async function getAsset(ctx: Ctx, id: string): Promise<AssetView> {
  return view(await mustGet(ctx, id));
}

export async function signUrl(
  ctx: Ctx,
  id: string,
  opts: { variant?: string; download?: boolean; expiresIn?: number },
): Promise<{ url: string; expiresAt: string }> {
  const asset = await mustGet(ctx, id);
  if (asset.status !== "uploaded") throw conflict("The upload hasn't finished");
  // An explicitly named variant must exist; "original" (or nothing) falls back to the proxy
  // when the original was dropped.
  const named = opts.variant && opts.variant !== "original";
  const obj = named ? asset.variants.find((v) => v.name === opts.variant && v.status === "uploaded") : objectFor(asset);
  if (!obj) throw notFound(named ? "No such variant" : "Nothing to link to: the original was dropped and there is no proxy");
  const expiresIn = opts.expiresIn ?? 3600;
  const url = await r2.signGet(ctx.r2, obj.key, {
    expiresIn,
    downloadName: opts.download ? asset.filename : undefined,
  });
  return { url, expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() };
}

/** Links for up to 100 assets in one call, e.g. a page of thumbnails. Missing IDs get null. */
export async function signUrls(ctx: Ctx, items: { id: string; variant?: string }[], expiresIn = 3600) {
  const found = new Map((await ctx.store.getAssets(ctx.app, items.map((i) => i.id))).map((a) => [a.id, a]));
  const urls = await Promise.all(
    items.map(async ({ id, variant }) => {
      const a = found.get(id);
      const obj = a && a.status === "uploaded" ? objectFor(a, variant) : null;
      return { id, url: obj ? await r2.signGet(ctx.r2, obj.key, { expiresIn }) : null };
    }),
  );
  return { urls, expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() };
}

export async function patchAsset(
  ctx: Ctx,
  id: string,
  patch: {
    metadata?: Record<string, unknown>;
    takenAt?: string | null;
    collection?: string;
    filename?: string;
    contentHash?: string;
    externalId?: string;
  },
): Promise<AssetView> {
  await mustGet(ctx, id);
  checkMetadata(patch.metadata);
  if (patch.collection !== undefined && !NAME_PATTERN.test(patch.collection)) throw badRequest("Invalid collection");
  if (patch.contentHash !== undefined && !CONTENT_HASH_PATTERN.test(patch.contentHash)) {
    throw badRequest("contentHash must be a SHA-256 hex digest");
  }
  try {
    const updated = await ctx.store.updateAsset(
      ctx.app,
      id,
      {
        metadata: patch.metadata,
        takenAt: patch.takenAt ? new Date(patch.takenAt) : undefined,
        collection: patch.collection,
        filename: patch.filename !== undefined ? safeFilename(patch.filename) : undefined,
        contentHash: patch.contentHash,
        externalId: patch.externalId,
        updatedAt: new Date(),
      },
      patch.takenAt === null ? ["takenAt"] : [],
    );
    return view(updated!);
  } catch (err) {
    if (err instanceof DuplicateKeyError) throw conflict(`Another asset already has that ${err.field}`);
    throw err;
  }
}

export async function deleteAsset(ctx: Ctx, id: string): Promise<void> {
  const asset = await mustGet(ctx, id);
  if (asset.multipart) await r2.abortMultipart(ctx.r2, asset.key, asset.multipart.uploadId).catch(() => undefined);
  await ctx.store.deleteAsset(ctx.app, id);
  // Deleting a missing key is a no-op in R2, so no need to check what exists.
  await removeObjects(ctx.store, ctx.r2, [asset.key, ...asset.variants.map((v) => v.key)]);
}

/**
 * Fold `from` into `id`: `id` survives (so whatever points at it keeps working). With
 * `keepOriginal: "from"`, the other asset's original becomes this one's; nothing is copied.
 */
export async function mergeAssets(
  ctx: Ctx,
  id: string,
  input: { from: string; keepOriginal: "this" | "from" },
): Promise<AssetView> {
  if (input.from === id) throw badRequest("Can't merge an asset into itself");
  const [kept, other] = await Promise.all([mustGet(ctx, id), mustGet(ctx, input.from)]);
  if (kept.status !== "uploaded" || other.status !== "uploaded") throw conflict("Both uploads must be finished");
  if (kept.collection !== other.collection) throw badRequest("Both assets must be in the same collection");
  if (kept.kind !== other.kind) throw badRequest("Both assets must be the same kind");

  const takeOther = input.keepOriginal === "from";
  const set = {
    ...(takeOther
      ? {
          key: other.key,
          filename: other.filename,
          contentType: other.contentType,
          size: other.size,
          contentHash: other.contentHash,
          hasOriginal: other.hasOriginal,
        }
      : {}),
    externalId: kept.externalId ?? other.externalId,
    takenAt: kept.takenAt ?? other.takenAt,
    updatedAt: new Date(),
  };
  const merged = await ctx.store.merge(ctx.app, id, other.id, set);
  if (!merged) throw notFound();

  const losing = takeOther ? [kept.key] : [other.key];
  await removeObjects(ctx.store, ctx.r2, [...losing, ...other.variants.map((v) => v.key)]);
  return view(merged);
}

// ---------- Variants ----------

export async function createVariant(
  ctx: Ctx,
  id: string,
  input: { name: string; contentType: string; size: number },
): Promise<{ url: string; headers: Record<string, string>; expiresAt: string }> {
  if (!NAME_PATTERN.test(input.name) || input.name === "original") throw badRequest("Invalid variant name");
  const asset = await mustGet(ctx, id);
  if (asset.status !== "uploaded") throw conflict("Finish the upload before adding variants");
  const contentType = resolveContentType("", input.contentType); // the declared type must be an allowed one
  if (!contentType) throw new HttpError(415, "unsupported_type", `Unsupported variant type: ${input.contentType}`);
  if (input.size <= 0 || input.size > MAX_FILE_BYTES) throw new HttpError(413, "too_large", "Variant size out of range");

  const now = new Date();
  const key = variantKey(ctx.app, id, input.name, contentType);
  await ctx.store.putVariant(ctx.app, id, {
    name: input.name,
    key,
    contentType,
    size: input.size,
    status: "uploading",
    createdAt: now,
    updatedAt: now,
  });
  // Variants come from servers, so one PUT (up to 5 GiB) is enough; no multipart.
  const url = await r2.signSinglePut(ctx.r2, key, contentType);
  return { url, headers: { "Content-Type": contentType }, expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString() };
}

export async function completeVariant(ctx: Ctx, id: string, name: string): Promise<AssetView> {
  const asset = await mustGet(ctx, id);
  const variant = asset.variants.find((v) => v.name === name);
  if (!variant) throw notFound("No such variant");
  if (variant.status === "uploaded") return view(asset);
  const stored = await r2.headObject(ctx.r2, variant.key);
  if (!stored) throw conflict("R2 has no file yet; PUT it first");
  if (stored.size !== variant.size) {
    await ctx.store.removeVariant(ctx.app, id, name);
    await removeObjects(ctx.store, ctx.r2, [variant.key]);
    throw new HttpError(422, "size_mismatch", `Size mismatch (expected ${variant.size}, R2 has ${stored.size})`);
  }
  const updated = await ctx.store.putVariant(ctx.app, id, { ...variant, status: "uploaded", updatedAt: new Date() });
  return view(updated!);
}

export async function deleteVariant(ctx: Ctx, id: string, name: string): Promise<AssetView> {
  const asset = await mustGet(ctx, id);
  const variant = asset.variants.find((v) => v.name === name);
  if (!variant) throw notFound("No such variant");
  if (name === "proxy" && !asset.hasOriginal) throw conflict("The original was dropped; the proxy is all that's left");
  const updated = await ctx.store.removeVariant(ctx.app, id, name);
  await removeObjects(ctx.store, ctx.r2, [variant.key]);
  return view(updated!);
}

/** Save space: keep the proxy, drop the original. */
export async function dropOriginal(ctx: Ctx, id: string): Promise<AssetView> {
  const asset = await mustGet(ctx, id);
  if (!asset.hasOriginal) return view(asset);
  if (!asset.variants.some((v) => v.name === "proxy" && v.status === "uploaded")) {
    throw conflict("Upload a proxy variant before dropping the original");
  }
  const updated = await ctx.store.updateAsset(ctx.app, id, { hasOriginal: false, updatedAt: new Date() });
  await removeObjects(ctx.store, ctx.r2, [asset.key]);
  return view(updated!);
}

// ---------- Usage and housekeeping ----------

export async function usage(ctx: Ctx) {
  const rows = await ctx.store.usage(ctx.app);
  const byCollection = new Map<string, { collection: string; bytes: number; objects: number }>();
  const count = { photo: 0, video: 0, file: 0 };
  let bytes = 0;
  for (const r of rows) {
    bytes += r.bytes;
    count[r.kind] += r.objects;
    const c = byCollection.get(r.collection) ?? { collection: r.collection, bytes: 0, objects: 0 };
    c.bytes += r.bytes;
    c.objects += r.objects;
    byCollection.set(r.collection, c);
  }
  return {
    bytes,
    objects: count.photo + count.video + count.file,
    photos: count.photo,
    videos: count.video,
    files: count.file,
    byCollection: [...byCollection.values()].sort((a, b) => b.bytes - a.bytes),
    freeTierBytes: ctx.freeTierBytes,
  };
}

/** Daily: remove uploads nobody came back to, and retry deletes that failed. */
export async function cleanup(store: Store, bucket: r2.R2, now = new Date()) {
  const stale = await store.staleUploads(new Date(now.getTime() - STALE_UPLOAD_MS), 200);
  for (const asset of stale) {
    if (asset.multipart) await r2.abortMultipart(bucket, asset.key, asset.multipart.uploadId).catch(() => undefined);
    await removeObjects(store, bucket, [asset.key]);
    await store.deleteAsset(asset.app, asset.id);
  }
  const orphans = await store.listOrphans(500);
  let retried = 0;
  for (const key of orphans) {
    try {
      await r2.deleteObject(bucket, key);
      await store.removeOrphan(key);
      retried++;
    } catch {
      // still failing; try again tomorrow
    }
  }
  return { staleUploadsRemoved: stale.length, orphansRemoved: retried };
}
