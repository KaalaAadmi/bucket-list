# bucket-list — Implementation Plan

`[x]` = built and tested (in-memory store, moto as R2). `[ ]` = to do. Steps S1–S7 together were phase 4 of the Shot Listed plan.

| Step | Scope | Status |
| --- | --- | --- |
| S1 | Repo, Hono app for Vercel, config | Done |
| S2 | API keys and auth | Done |
| S3 | Uploads, duplicates by content hash, resuming | Done |
| S4 | Assets, links, delete, merge | Done |
| S5 | Variants and dropping originals | Done |
| S6 | Usage and daily cleanup | Done |
| S7 | Tests, smoke script, deploy | Tests and smoke Done; **deploy to do** |
| S8 | Import from Shot Listed | Script Done; not needed today |
| S9 | Features for your personal storage app | Later |

---

## S1 — Skeleton (Done)

- [x] Repo `bucket-list`; TypeScript, ESM; Hono app exported from `src/index.ts` (Vercel picks it up with no config)
- [x] `src/env.ts` validated on first request; `STORE=memory` for local trials, refused in Vercel production
- [x] JSON errors with a code and message; generic 500s
- [x] `GET /v1/health`; local server `npm run dev` / `npm run start:memory` on :8787
- [x] `.env.example`, `vercel.json` (daily cron), `infra/r2-cors.json`

## S2 — Keys and auth (Done)

- [x] `rsk_<id>_<secret>` keys; SHA-256 of the secret stored; constant-time compare
- [x] Bearer middleware with scopes (`read`, `write`, `delete`, `admin`); everything filtered by the key's app
- [x] `POST`/`GET /v1/keys`, `DELETE /v1/keys/:id` with `ADMIN_TOKEN`
- [x] `npm run create-key`

## S3 — Uploads (Done)

- [x] Upload rules (`policy.ts`, ported, plus zip, PDF, JSON, text); per-request `kinds` and `maxBytes`
- [x] Single PUT and multipart, part URLs, complete with a `HEAD` size check, cancel (`r2.ts`, ported)
- [x] Duplicates (`dedupe.ts`, ported): external ID, then content hash per collection; adopting the external ID; races settled by the unique index
- [x] Resume: fresh link for a single upload; `ListParts` for multipart; new multipart on the same asset if R2 dropped it; idempotent complete; `GET /v1/uploads/:id`

## S4 — Assets and links (Done)

- [x] List with a cursor and optional links; links for up to 100 assets at once; view and download links
- [x] `PATCH` (409 on a hash or external ID clash), `DELETE` (failed object deletes recorded in `orphans`)
- [x] Merge in a MongoDB transaction; losing files deleted after

## S5 — Variants (Done)

- [x] Start, complete (size check) and delete variants; atomic per name
- [x] Drop the original once a proxy exists; links fall back to the proxy

## S6 — Usage and cleanup (Done)

- [x] `GET /v1/usage`: one aggregation, by collection and kind
- [x] `GET /v1/cron/cleanup` with `CRON_SECRET`: stale uploads (24 h without activity), then orphans

## S7 — Tests, smoke, deploy

- [x] Unit tests: policy, keys, duplicate rules, key format
- [x] Store contract suite: in memory always; MongoDB when `MONGODB_TEST_URI` is set
- [x] API tests in-process for auth, and with moto for every file flow
- [x] S3 round trips (ported from Shot Listed)
- [x] `npm run smoke`, passed against a local server (memory store, moto)
- [x] `openapi.yaml`, validated as OpenAPI 3.1
- [ ] **Run the store suite against MongoDB**: `MONGODB_TEST_URI=<throwaway Atlas database> npm test`
- [ ] Create the R2 bucket, its CORS rule (with Shot Listed's domain) and lifecycle rule; an R2 API token for this bucket only
- [ ] New Atlas project and free cluster; database user; network access `0.0.0.0/0`
- [ ] Vercel project from this repo; env vars from `.env.example`; deploy
- [ ] `curl <url>/v1/health`; `npm run create-key` for `shot-listed`; `npm run smoke -- <url>`

**Done when:** the store suite passes against MongoDB, and `npm run smoke` passes against the deployed URL with a real key.

Then Shot Listed: set `STORAGE_API_URL` and `STORAGE_API_KEY`, run `npm run check:storage`, deploy (Shot Listed plan, phase 5).

## S8 — Import from Shot Listed (only if needed)

- [x] `npm run import:shot-listed` (with `--dry-run`)
- [ ] Not needed: nothing was uploaded to production before the split. Run it only if that changes.

## S9 — Personal storage app features (later)

- [ ] Rename and move between collections from a UI (the API already allows it)
- [ ] Share links with an expiry, revocable
- [ ] Trash with restore and auto-purge after 30 days
- [ ] Per-app quotas and a usage alert
- [ ] Move to Vercel Pro (or Cloudflare) before selling anything built on it
