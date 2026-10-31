# Storage split: Shot Listed and bucket-list

Shot Listed is now two GitHub repos:

| Repo | What it is | Runs on |
| --- | --- | --- |
| `shot-listed` | The app: Library, Captions, Settings, and later inspirations, plans, Film it and the Board. Talks to storage only through a small connector. | Vercel (web), Oracle VM (pipeline host, later), its own MongoDB Atlas project |
| `bucket-list` | A general media storage service: uploads straight from the browser to R2, duplicate checks, resuming, an asset registry, signed links, derived files and usage. Knows nothing about reels. | Its own Vercel project (Hono on Node), its own MongoDB Atlas project, Cloudflare R2 |

`bucket-list` is a working name; rename it freely. Each app gets its own API key and space, so it can later be the backend of your own cloud storage app.

**Status:** the split is done in code, typechecked and tested in both repos. Neither is deployed yet. §3 is how to make sure both work once they are.

---

## 1. What moved where

Paths are relative to the `shot-listed` repo as it was before the split.

### Moved to `bucket-list`

| Was in `shot-listed` | Now in `bucket-list` | Changes |
| --- | --- | --- |
| `web/src/lib/media/r2.ts` | `src/r2.ts` | Same AWS SDK wrapper (signed PUT, multipart, part URLs, `ListParts`, `HEAD`, signed GET, delete); link lifetime is now a parameter. |
| `web/src/lib/media/keys.ts` | `src/keys.ts` | Keys gain an app and collection: `apps/<app>/<collection>/YYYY/MM/<id>.<ext>`; variants at `apps/<app>/variants/<id>/<name>.<ext>`. |
| `web/src/lib/media/policy.ts` (types, sizes, parts) | `src/policy.ts` | Same rules, plus GIF, WebM, zip, PDF, JSON and text. |
| `web/src/lib/media/dedupe.ts` | `src/dedupe.ts` | Unchanged; the hash match is now per collection. |
| Upload and asset functions in `web/src/lib/library.ts` (`createUpload`, `uploadState`, `signUploadParts`, `completeUpload`, `abortUpload`, the internal `startNewUpload`, `resumeUpload`, `discardUpload`, `clearStaleUploads`, plus `deleteAsset`, `downloadUrl`, `usage`) | `src/assets.ts` | Same behaviour on its own MongoDB database (`r2_storage`) behind a `Store` interface. New: variants, dropping originals, merge, batch links, orphan retries. Stale cleanup is a daily Vercel Cron job instead of running on each upload. |
| The `assets` collection in Shot Listed's database | `assets` in `r2_storage` | Same fields plus `app`, `collection` (was `purpose`), `metadata.origin` (was `origin`), `hasOriginal`, `variants`. |
| Route logic of `web/src/app/api/media/**` | `src/app.ts` | Hono routes under `/v1` with API keys and scopes. |
| `web/tests/r2.test.mts` | `test/s3.test.ts` | Same S3 round trips against moto. |
| The duplicate-rule tests in `web/tests/dedupe.test.mts` | `test/policy.test.ts` | Same cases. |
| `infra/r2-cors.json` | `infra/r2-cors.json` | Unchanged. |

### Changed in `shot-listed`

| File | Change |
| --- | --- |
| `web/src/lib/library.ts` | Uploads and the Library call the connector. Still checks the caller (Mac uploads need a Photos ID), maps `purpose` to a collection (`library`, `finals`), sets the final-cut limits (video, under 500 MB) and stores `origin` as metadata. Settings and the Mac heartbeat are unchanged. |
| `web/src/app/api/media/**` | Same URLs and request shapes; now thin proxies to storage. The browser, iOS Shortcut and Mac agent don't change. |
| `web/src/lib/finals.ts` | Reads, downloads and deletes the final cut through the connector. |
| `web/src/lib/http.ts` | Storage errors become responses: its 4xx messages pass through; 5xx become a 502 "storage had a problem". |
| `web/src/lib/db.ts`, `types.ts` | No more `assets` collection or `AssetDoc`. |
| `web/src/lib/env.ts`, `.env.example` | `R2_*` removed; `STORAGE_API_URL` and `STORAGE_API_KEY` added. |
| `web/src/lib/media/policy.ts` | Trimmed to what the browser needs: the file picker's accept list, the hash format, part sizes for resuming. |
| `web/tests/dedupe.test.mts` | Renamed `uploads.test.mts`; keeps the hashing and resume-planning tests. |
| `README.md`, `docs/*` | Updated. `docs/mac-agent.md` didn't need to change: the agent only talks to Shot Listed. |

### New in `shot-listed`

| File | Purpose |
| --- | --- |
| `web/src/lib/storage/client.ts` | Typed HTTP client for the storage API: key in the `Authorization` header, 15-second timeout, two retries on 429, 5xx and network errors, `StorageError` with the service's status and message. No Next.js imports, so scripts and tests can use it. |
| `web/src/lib/storage/connector.ts` | Server-only: the client configured from `STORAGE_API_URL` and `STORAGE_API_KEY`, and the purpose-to-collection map. |
| `web/src/lib/storage/types.ts` | Request and response types, following `bucket-list/openapi.yaml`. |
| `web/scripts/check-storage.mts` | `npm run check:storage`: health, a 1 KB upload, the same again (expects duplicate), read back, delete, usage. |
| `web/tests/storage-client.test.mts` | The client with `fetch` stubbed: headers and body, 4xx without retry, retries, 204s, query strings. |

### Deleted from `shot-listed`

`web/src/lib/media/r2.ts`, `keys.ts`, `dedupe.ts`, `web/tests/r2.test.mts`, `infra/r2-cors.json`, and the `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` dependencies. `hash-wasm` stays: the browser still hashes files.

### What did not move

- Hashing (`web/src/lib/media/hash.ts`) and resume planning (`resume.ts`) stay in Shot Listed: they run in the browser.
- `library_items` (tags, search data, same-shot matching) is Shot Listed's, and arrives with indexing in phase 6. Until then the Library lists straight from storage.

---

## 2. Order to bring them up

1. **R2:** bucket, CORS rule (`infra/r2-cors.json` in bucket-list, with Shot Listed's domains), lifecycle rule (abort incomplete multipart uploads after 1 day), API token for this bucket only.
2. **Atlas, twice:** one project and free cluster for `bucket-list`, another for `shot-listed`. Each gets its own 512 MB.
3. **Deploy `bucket-list`** to its own Vercel project with its env vars. `curl <url>/v1/health`.
4. **Create Shot Listed's key:** `ADMIN_TOKEN=… npm run create-key -- --url <storage url> --app shot-listed --name vercel --scopes read,write,delete`.
5. **Deploy `shot-listed`** with `STORAGE_API_URL` and `STORAGE_API_KEY`, plus its existing variables.
6. Nothing was uploaded to production before the split, so there is nothing to import. If that changes, bucket-list has `npm run import:shot-listed`.

---

## 3. How to make sure both work

### `bucket-list` on its own

1. `npm run typecheck && npm test`: unit tests, the store rules in memory, and auth.
2. With moto (`pip install "moto[server]"`, then `moto_server -p 5055 &`): `R2_TEST_ENDPOINT=http://127.0.0.1:5055 npm test` adds every upload, resume, link, variant, merge and cleanup flow.
3. Against MongoDB: `MONGODB_TEST_URI="mongodb+srv://…" npm test` runs the same store rules on a throwaway database. **Not yet run**; do this once, before deploying.
4. Deployed: `STORAGE_API_KEY=rsk_… npm run smoke -- https://<storage>.vercel.app`. Expect ten ticks: health, 1 KB upload, duplicate, 70 MB upload stopped after 3 parts, resumed with those 3, finished, bytes match, thumbnail, usage, deleted.
5. In Cloudflare, check the bucket's CORS rule lists your Shot Listed domain and exposes `ETag`.

### `shot-listed` with the connector

1. `cd web && npm run typecheck && npm run lint && npm test && npm run build`.
2. `npm run check:storage` with `STORAGE_API_URL` and `STORAGE_API_KEY` in `.env.local`. Expect: up, uploaded, duplicate, read back, deleted, usage.
3. On your phone, after deploying:
   - Library: add one photo and one video over 64 MB. Both appear with previews; the usage bar moves.
   - Pick the same photo again: **Already in library**.
   - Start another large video, turn on Airplane mode part-way, turn it off and tap **Retry** (or pick it again): the bar picks up where it stopped, and the grid shows one copy.
   - Captions: upload a final cut. The three steps run, the video plays, **Delete video** frees it.
   - Delete a library item; `GET /v1/assets/<id>` on storage then returns 404.

Both checks were run against a local storage server (in-memory store, moto as R2): the storage smoke test and Shot Listed's `check:storage` both passed.

### When something fails

| Symptom | Likely cause |
| --- | --- |
| Large uploads stop at 100% | Bucket CORS rule doesn't expose `ETag` |
| 403 on the browser's PUT | Content-Type differs from the signed one, or the link expired (15 minutes); Retry gets a fresh one |
| Shot Listed says the storage service had a problem (502) | Storage returned a 5xx: check its Vercel logs. Often the Atlas cluster is paused after 30 idle days, so resume it in the Atlas dashboard |
| 401 from storage | Wrong `STORAGE_API_KEY`, or the key was revoked |
| 403 from storage | The key lacks a scope; create one with `read,write,delete` |
| `check:storage` can't connect | `STORAGE_API_URL` is wrong, or the storage project isn't deployed |
| The same photo stored twice | The two files differ (iOS sent a converted copy). Expected until phase 6, which merges such pairs; identical files are always caught |
| Resume starts from 0% | More than a day passed and R2's lifecycle rule dropped the parts; it restarts on the same item, still one copy |
| **Checking** is slow on big videos | Hashing reads the whole file once before uploading; expected for multi-GB files |
