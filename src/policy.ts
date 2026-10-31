// Upload rules: what can be stored, how big, and how it is split into parts.
// Ported from shot-listed/web/src/lib/media/policy.ts, plus `file` for zips and documents.

export type Kind = "photo" | "video" | "file";

const TYPES: Record<string, { kind: Kind; ext: string }> = {
  "image/jpeg": { kind: "photo", ext: "jpg" },
  "image/png": { kind: "photo", ext: "png" },
  "image/heic": { kind: "photo", ext: "heic" },
  "image/heif": { kind: "photo", ext: "heif" },
  "image/webp": { kind: "photo", ext: "webp" },
  "image/gif": { kind: "photo", ext: "gif" },
  "video/mp4": { kind: "video", ext: "mp4" },
  "video/quicktime": { kind: "video", ext: "mov" },
  "video/x-m4v": { kind: "video", ext: "m4v" },
  "video/webm": { kind: "video", ext: "webm" },
  "application/zip": { kind: "file", ext: "zip" },
  "application/pdf": { kind: "file", ext: "pdf" },
  "application/json": { kind: "file", ext: "json" },
  "text/plain": { kind: "file", ext: "txt" },
};

const EXT_TO_TYPE: Record<string, string> = Object.fromEntries(
  Object.entries(TYPES).map(([type, { ext }]) => [ext, type]),
);
EXT_TO_TYPE.jpeg = "image/jpeg";

/** iOS sometimes sends no type, or `application/octet-stream`; fall back to the extension. */
export function resolveContentType(filename: string, declared: string | undefined): string | null {
  const type = (declared ?? "").toLowerCase().split(";")[0].trim();
  if (type && TYPES[type]) return type;
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  return EXT_TO_TYPE[ext] ?? null;
}

export function kindOf(contentType: string): Kind | null {
  return TYPES[contentType]?.kind ?? null;
}

export function extensionFor(contentType: string): string {
  return TYPES[contentType]?.ext ?? "bin";
}

/** R2's single-object ceiling is about 5 GiB. */
export const MAX_FILE_BYTES = 5 * 1024 ** 3;

/** Above this, upload in parts so a dropped phone connection only retries one part. */
export const MULTIPART_THRESHOLD_BYTES = 64 * 1024 ** 2;

/** S3/R2 parts must be at least 5 MiB (except the last) and there can be at most 10,000. */
const MIN_PART_BYTES = 8 * 1024 ** 2;
const MAX_PARTS = 10_000;

export function planParts(size: number): { partSize: number; partCount: number } {
  let partSize = MIN_PART_BYTES;
  while (Math.ceil(size / partSize) > MAX_PARTS) partSize *= 2;
  return { partSize, partCount: Math.max(1, Math.ceil(size / partSize)) };
}

export function expectedPartSize(size: number, partSize: number, partNumber: number): number {
  const start = (partNumber - 1) * partSize;
  return Math.max(0, Math.min(partSize, size - start));
}

/** SHA-256 of the exact bytes, 64 lowercase hex characters. */
export const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/;

/** Apps, collections and variant names: short, lowercase, URL- and key-safe. */
export const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Upload links: long enough for one large part on a slow phone connection. */
export const UPLOAD_URL_TTL_S = 15 * 60;
export const DEFAULT_VIEW_URL_TTL_S = 60 * 60;
export const MAX_VIEW_URL_TTL_S = 24 * 60 * 60;

/** Unfinished uploads untouched for this long are removed by the daily cleanup. */
export const STALE_UPLOAD_MS = 24 * 60 * 60 * 1000;

export const MAX_METADATA_BYTES = 4 * 1024;
export const MAX_PARTS_PER_REQUEST = 100;
export const MAX_LIST_LIMIT = 100;
