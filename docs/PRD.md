# bucket-list — Product Requirements

**Owner:** Arnav · **Last updated:** 31 October 2026 · `bucket-list` is a working name.

Status legend used in every bucket-list doc:

- **Done**: built and covered by automated tests (in-memory store, with moto standing in for R2). Not yet deployed or run against your own Atlas and R2.
- **Partly done**: some of it exists; the gap is named.
- **Planned**: not started.

---

## 1. Problem

Shot Listed's media code (signed uploads, multipart, duplicate checks, resuming, signed links, usage) was about a third of the app and had nothing to do with reels. Keeping it inside Shot Listed made the app bigger than it needed to be, and the same code would have had to be copied into any other project that stores photos and videos, including the iCloud-style storage app you want to build later.

## 2. Goal

A small, separate service that any of your apps can use to store files in Cloudflare R2 through one HTTP API. Each app gets its own API key and its own space; the service never knows what the files are for.

## 3. Users (callers)

| Caller | How it uses storage |
| --- | --- |
| Shot Listed web (Vercel) | Starts uploads for the browser, lists and signs links, deletes. Through `web/src/lib/storage/connector.ts`. |
| Shot Listed pipeline host (Oracle VM, later the Mac mini) | Downloads originals, uploads thumbnails and proxies, stores downloaded inspiration reels and clip packs, merges duplicates. With its own key. |
| Browser, iOS Shortcut, Mac agent | Never hold a storage key. They PUT bytes to the signed R2 links Shot Listed hands them. |
| Future: your personal storage app | Same API, its own key and app name. |
| You, as admin | Create and revoke keys with `ADMIN_TOKEN` (`npm run create-key`). |

## 4. Non-goals

- **No user interface.** Admin is a script and a few `curl` calls.
- **No end-user accounts.** Apps authenticate; who the person is inside an app is that app's business.
- **No processing.** No transcoding, thumbnails or AI. Callers make derived files and upload them as variants.
- **No look-alike detection.** The service spots identical bytes only. Recognising the same shot saved as two different files needs photo metadata and image comparison, so the app does it and then calls merge.
- **No public files.** The bucket stays private; every read is a signed link.
- **No cost.** Vercel Hobby, a free Atlas cluster and R2's free tier.

## 5. Features

### 5.1 Direct uploads — Done

- Start an upload with filename, content type, size and collection. The service resolves the type (iOS sometimes sends none), checks it against the rules, and returns either one signed PUT (files up to 64 MB) or a multipart plan (8 MiB parts, doubling to stay under 10,000 parts).
- Signed part URLs in batches of up to 100.
- Complete: stitch the parts, then confirm with R2 that the full file arrived before marking it uploaded.
- Cancel: removes the partial upload and the record.
- Links expire after 15 minutes and only accept the exact Content-Type that was signed.
- Files up to 5 GiB. Callers can tighten this per request (Shot Listed: final cuts are video only, under 500 MB).

### 5.2 No duplicate copies — Done

- **Content hash.** Callers send the SHA-256 of the file. The same bytes in the same app and collection come back as **duplicate** before anything is sent, whichever device sends them.
- **External ID.** Callers can send an ID from the source (such as a Photos library UUID), unique per app. When the Mac sends a photo whose bytes the phone already uploaded, the existing asset is given the Photos ID instead of being stored again.
- **Separate collections.** The same video can be a library clip and a final cut without one blocking the other.
- **Merge.** When an app decides two different files are the same shot (a JPEG and a HEIC of one photo), it asks the service to fold one asset into the other, keeping whichever original it chooses. Deciding that is the app's job (§4).

### 5.3 Resuming instead of restarting — Done

- Re-sending a file whose upload was cut off continues the same upload: the service reports which parts R2 already has, and only the rest are sent. Same asset ID, same object, no second copy and nothing re-sent.
- A small upload (one request) that was cut off simply gets a fresh link to the same object; R2 never keeps half a file.
- Two attempts at the same file at once are harmless: they carry identical bytes, and finishing twice returns the same asset.
- If R2 has already dropped the parts (more than a day later), a new upload starts on the same asset.
- Unfinished uploads nobody comes back to are removed after 24 hours.

### 5.4 Asset registry — Done

- Every file is an asset with: ID, app, collection, filename, content type, kind (photo, video, file), size, content hash, external ID, taken-at date, status, free-form metadata (up to 4 KB) and its variants.
- List by collection and kind, newest first, with a cursor; optionally with a signed link per item.
- Read one; update its metadata, taken-at date, collection, filename, hash or external ID.

### 5.5 Signed links — Done

- View links (default 1 hour, up to 24 hours) and download links that save under the original filename.
- For the original or any variant; links for up to 100 assets in one call (a page of thumbnails).

### 5.6 Delete — Done

Deletes the original, every variant and the record in one call. An open multipart upload is cancelled first. A delete R2 refuses is recorded and retried daily.

### 5.7 Variants — Done

Derived files attached to an asset by name (`proxy`, `thumb`, or anything the caller chooses). Start returns a signed PUT; complete checks the size with R2. Variants are deleted with their asset. An app can drop the original once a proxy exists, to save space; links to the original then open the proxy.

### 5.8 Usage — Done

Bytes and file counts per app and per collection (originals still stored plus finished variants), compared with the 10 GB R2 free tier.

### 5.9 API keys — Done

- One or more keys per app, each with scopes: `read`, `write`, `delete`, `admin`.
- Keys are shown once; only a hash is stored. Revoke by ID.
- `ADMIN_TOKEN` creates the first keys, so no key is needed to bootstrap.

### 5.10 Housekeeping — Done

A daily Vercel Cron job removes uploads untouched for 24 hours and retries failed deletes. An R2 lifecycle rule also aborts incomplete multipart uploads after 1 day.

### 5.11 Import from Shot Listed — Done (script), only if needed

`npm run import:shot-listed` copies Shot Listed's old Mongo `assets` records (from before the split) with the same IDs and R2 keys. No files move. Not needed if nothing was uploaded to production before the split, which is the case today.

### 5.12 Later, for your personal storage app — Planned

Folders as collections, share links with an expiry, trash with restore, per-app quotas and a usage alert. None is needed by Shot Listed.

## 6. Success measures

- Shot Listed's browser, Shortcut and Mac agent work unchanged after the split (same routes).
- No R2 credentials outside this service.
- The same file sent twice, from any device, is stored once; an upload cut off at 90% sends only the last 10% when tried again.
- `npm run smoke` passes against the deployed service.
- Runs on free tiers at Shot Listed's volume (a few hundred uploads a month).

## 7. Constraints

| Constraint | Effect |
| --- | --- |
| Vercel Hobby: personal, non-commercial use; functions up to 300 s | Fine for you. If you sell an app built on this, move this project to Vercel Pro or another host; the API stays the same. Bytes never pass through the function, so requests take milliseconds. |
| Vercel Hobby cron: once a day | Cleanup runs daily, which is all it needs. |
| Atlas free cluster: 512 MB, 100 operations a second, 500 connections, 10 GB transfer each way per week; paused after 30 days without connections | About 1 KB per asset, so 512 MB holds hundreds of thousands. Its own Atlas project, so it never shares Shot Listed's 512 MB. If it pauses, resume it from the dashboard. |
| R2 free tier: 10 GB, 1 million writes and 10 million reads a month | Shot Listed stores 1080p proxies and can drop originals. |
| Signed links need S3 credentials | The service holds an R2 API token as a Vercel secret and signs with the S3 API. |

## 8. Related documents

- `TRD.md`: architecture, API contract, auth, limits, testing
- `APP_FLOW.md`: how each caller uses the service, step by step
- `DATABASE_SCHEMA.md`: MongoDB collections
- `IMPLEMENTATION_PLAN.md`: steps S1–S9
- `SPLIT_GUIDE.md`: what moved from Shot Listed and how to check both repos work
- `../openapi.yaml`: the API contract
