# bucket-list — Database Schema

MongoDB Atlas, database `r2_storage` (set by `MONGODB_DB`), in **its own Atlas project** so it has its own free cluster. All collections are **Done** (code in `src/store/mongo.ts`; indexes are created on the first request). The same rules are implemented in memory (`src/store/memory.ts`) for tests.

Conventions:

- Asset IDs are UUID strings; API key IDs are 12 base32 characters (part of the key).
- Dates are BSON dates; the API shows them as ISO strings.
- Optional fields are left out, never stored as `null`, because the partial unique indexes must see them as missing.
- Every query filters by `app`.

| Collection | Holds |
| --- | --- |
| `assets` | One document per stored file, with its variants |
| `api_keys` | Keys, as hashes, with their app and scopes |
| `orphans` | R2 objects whose delete failed, retried daily |

---

## `assets`

| Field | Type | Notes |
| --- | --- | --- |
| `_id` | string | Asset ID |
| `app` | string | From the caller's key, e.g. `shot-listed` |
| `collection` | string | `library`, `finals`, … (`[a-z0-9-]`, up to 32) |
| `key` | string | R2 key of the original: `apps/<app>/<collection>/YYYY/MM/<id>.<ext>` |
| `filename` | string | Cleaned for download headers |
| `contentType` | string | Resolved from the extension when iOS sends none |
| `kind` | `"photo" \| "video" \| "file"` | |
| `size` | number | Bytes; checked against R2 on completion |
| `contentHash` | string? | SHA-256 hex, sent by the caller |
| `externalId` | string? | ID in the source, e.g. a Photos UUID |
| `takenAt` | Date? | |
| `status` | `"uploading" \| "uploaded"` | |
| `hasOriginal` | boolean | False once the original was dropped for the proxy |
| `multipart` | `{ uploadId, partSize, partCount }`? | While a multipart upload is open. Which parts arrived is asked from R2 (`ListParts`), never stored here |
| `metadata` | object | The caller's, up to 4 KB. Shot Listed stores `{ origin }` |
| `variants` | array | `{ name, key, contentType, size, status, createdAt, updatedAt }`; key `apps/<app>/variants/<id>/<name>.<ext>` |
| `createdAt` | Date | |
| `updatedAt` | Date | Moves on every resume and part request; the cleanup uses it |

Indexes:

| Name | Keys | Options | Why |
| --- | --- | --- | --- |
| `unique_hash` | `{ app, collection, contentHash }` | unique, partial: `contentHash` is a string | The duplicate rule. Per collection, so a library clip can also be a final cut |
| `unique_external_id` | `{ app, externalId }` | unique, partial: string | One asset per Photos item |
| `unique_key` | `{ key }` | unique | Two assets never share an object |
| `list` | `{ app, collection, status, createdAt: -1, _id: -1 }` | | Listing and the cursor |
| `list_kind` | `{ app, kind, status, createdAt: -1, _id: -1 }` | | Listing by kind across collections |
| `stale` | `{ status, updatedAt }` | | Daily cleanup |

How the rules use them:

- A duplicate-key error on insert means an identical request just won a race; the service re-reads and resumes the winner's upload.
- Adopting an external ID updates only where `externalId` is missing, so it never overwrites one.
- Variants are changed with single atomic updates (a pipeline `$set` replaces by name; `$pull` removes), so a thumbnail and a proxy finishing at once can't overwrite each other.
- Merge runs in a transaction: delete the other document first (freeing its hash and external ID), then update the kept one. Atlas clusters are replica sets, so transactions work on the free tier.
- Usage is one aggregation over the app's uploaded assets: original size when `hasOriginal`, plus the sizes of uploaded variants, grouped by collection and kind. No counters to drift.

## `api_keys`

| Field | Type | Notes |
| --- | --- | --- |
| `_id` | string | Key ID (the `<id>` in `rsk_<id>_<secret>`) |
| `app` | string | |
| `name` | string | Your label, e.g. `vercel`, `pipeline-host` |
| `keyHash` | string | Hex SHA-256 of the secret; the key itself is never stored |
| `scopes` | string[] | `read`, `write`, `delete`, `admin` |
| `createdAt`, `lastUsedAt?`, `revokedAt?` | Date | `lastUsedAt` written at most hourly |

Index: `by_app` on `{ app }`. Revoked keys are kept, so the list is a history.

## `orphans`

`{ _id: <R2 key>, createdAt }`. Added when a delete fails after a record is already gone (delete, merge, dropped original); the daily cleanup retries and removes the entry on success.

## Size and load

| Item | Estimate |
| --- | --- |
| One asset with two variants, plus indexes | About 1–1.5 KB |
| 10,000 assets | About 15 MB of the free cluster's 512 MB |
| One upload | About 3–5 operations (lookups, insert, touches, complete) |
| One Library page | One find (48 items) plus signed links, which need no database |
| Atlas's 100 operations a second | Far above anything a single person's uploads produce |

## Import from Shot Listed (only if needed)

`npm run import:shot-listed` reads Shot Listed's old `assets` collection (uploaded items only) and inserts matching documents with the same IDs and R2 keys, `app: "shot-listed"`, `collection` `library` or `finals` (from `purpose`), `metadata.origin`, and variants for any `proxies/<id>.mp4` or `thumbs/<id>.jpg` objects that exist. `--dry-run` lists what it would do. No files move. Items from before content hashes existed have no `contentHash`; Shot Listed's pipeline host fills it in when it indexes them.
