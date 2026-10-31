// The registry the service keeps about each file. MongoDB in production; an in-memory
// copy for tests and local trials. Both enforce the same unique rules (see DuplicateKeyError).
import type { Kind } from "../policy.js";

export type Scope = "read" | "write" | "delete" | "admin";

export type Variant = {
  name: string;
  key: string;
  contentType: string;
  size: number;
  status: "uploading" | "uploaded";
  createdAt: Date;
  updatedAt: Date;
};

export type AssetRecord = {
  id: string;
  app: string;
  collection: string;
  /** R2 object key of the original. */
  key: string;
  filename: string;
  contentType: string;
  kind: Kind;
  size: number;
  /** SHA-256 hex of the bytes, as claimed by the caller. Unique per app and collection. */
  contentHash?: string;
  /** ID in the source system, such as a Photos library UUID. Unique per app. */
  externalId?: string;
  takenAt?: Date;
  status: "uploading" | "uploaded";
  /** False once the original was dropped in favour of the `proxy` variant. */
  hasOriginal: boolean;
  /** Present while a multipart upload is open. */
  multipart?: { uploadId: string; partSize: number; partCount: number };
  metadata: Record<string, unknown>;
  variants: Variant[];
  createdAt: Date;
  /** Moves on every resume and part request; the daily cleanup uses it. */
  updatedAt: Date;
};

export type ApiKeyRecord = {
  id: string;
  app: string;
  name: string;
  /** Hex SHA-256 of the secret part. The key itself is never stored. */
  keyHash: string;
  scopes: Scope[];
  createdAt: Date;
  lastUsedAt?: Date;
  revokedAt?: Date;
};

export type ListQuery = {
  collection?: string;
  kind?: Kind;
  status: "uploading" | "uploaded";
  /** Return items strictly older than this (newest first). */
  before?: { createdAt: Date; id: string };
  limit: number;
};

export type UsageRow = { collection: string; kind: Kind; bytes: number; objects: number };

export type AssetPatch = Partial<Omit<AssetRecord, "id" | "app" | "variants">>;
export type AssetUnset = Array<"multipart" | "externalId" | "contentHash" | "takenAt">;

export interface Store {
  /** Throws DuplicateKeyError on a clash of (app, collection, contentHash), (app, externalId) or key. */
  insertAsset(asset: AssetRecord): Promise<void>;
  getAsset(app: string, id: string): Promise<AssetRecord | null>;
  /** Several at once, in no particular order; missing IDs are left out. */
  getAssets(app: string, ids: string[]): Promise<AssetRecord[]>;
  findByExternalId(app: string, externalId: string): Promise<AssetRecord | null>;
  findByHash(app: string, collection: string, contentHash: string): Promise<AssetRecord | null>;
  /** Only updates when `where.status` matches, if given. Throws DuplicateKeyError like insert. */
  updateAsset(
    app: string,
    id: string,
    set: AssetPatch,
    unset?: AssetUnset,
    where?: { status?: AssetRecord["status"]; externalIdMissing?: boolean },
  ): Promise<AssetRecord | null>;
  deleteAsset(app: string, id: string): Promise<boolean>;
  listAssets(app: string, query: ListQuery): Promise<AssetRecord[]>;
  /** Across all apps: uploads not touched since `before`. */
  staleUploads(before: Date, limit: number): Promise<AssetRecord[]>;
  /** Uploaded originals still stored, plus uploaded variants, grouped by collection and kind. */
  usage(app: string): Promise<UsageRow[]>;
  /** Replace or add a variant by name, atomically. */
  putVariant(app: string, id: string, variant: Variant): Promise<AssetRecord | null>;
  removeVariant(app: string, id: string, name: string): Promise<AssetRecord | null>;
  /** Atomically delete `otherId`, then apply `set` to `keptId`. */
  merge(app: string, keptId: string, otherId: string, set: AssetPatch): Promise<AssetRecord | null>;

  insertKey(key: ApiKeyRecord): Promise<void>;
  getKey(id: string): Promise<ApiKeyRecord | null>;
  listKeys(app?: string): Promise<ApiKeyRecord[]>;
  revokeKey(id: string, at: Date): Promise<boolean>;
  touchKey(id: string, at: Date): Promise<void>;

  /** R2 objects that should be gone but whose delete failed; retried by the cleanup. */
  addOrphans(keys: string[]): Promise<void>;
  listOrphans(limit: number): Promise<string[]>;
  removeOrphan(key: string): Promise<void>;
}
