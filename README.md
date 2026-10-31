# bucket-list

A small media storage service any of your apps can use. Files go straight from the
caller to **Cloudflare R2** through short-lived signed links; the service keeps the
details of each file in **MongoDB Atlas**, checks for duplicates, resumes stopped
uploads, signs links, holds derived files (thumbnails, proxies) and reports usage.
It runs as a **Hono** app on **Vercel** (Node).

Shot Listed is its first user. It knows nothing about reels: each app gets its own API
key and its own space, so it can later be the backend of your own cloud storage app.

```
src/index.ts        Vercel entry (exports the Hono app)
src/app.ts          Routes, auth, validation
src/assets.ts       Uploads, duplicates, resuming, links, variants, merge, usage, cleanup
src/dedupe.ts       The duplicate rules (pure)
src/apikeys.ts      API keys: rsk_<id>_<secret>, only a hash stored
src/policy.ts       Allowed types, sizes, part plans
src/keys.ts         R2 key layout
src/r2.ts           R2 through its S3 API (AWS SDK)
src/store/          MongoDB store, plus an in-memory one for tests and local trials
scripts/            create-key, smoke, import-shot-listed
test/               Unit, store contract, API end to end
infra/r2-cors.json  CORS rule for the bucket
openapi.yaml        The API contract
docs/               PRD, TRD, APP_FLOW, DATABASE_SCHEMA, IMPLEMENTATION_PLAN, SPLIT_GUIDE
```

## Setup (about 20 minutes)

### 1. Cloudflare R2

1. **R2 → Create bucket** (e.g. `shot-listed`). Leave public access off.
2. Bucket → **Settings → CORS policy**: paste `infra/r2-cors.json` with your apps'
   domains (Shot Listed's Vercel domain, and `http://localhost:3000` for local work).
   Keep the `ETag` line: without it, large uploads can't finish.
3. Bucket → **Settings → Object lifecycle rules**: abort incomplete multipart uploads
   after 1 day. (The service also cleans up uploads abandoned for 24 hours.)
4. **R2 → Manage API tokens → Create API token**: Object Read & Write, this bucket only.
   Copy the Access Key ID, Secret Access Key and your Account ID.

### 2. MongoDB Atlas

Create a **new Atlas project** for storage and an M0 (free) cluster in it. One free
cluster is allowed per project, so this one gets its own 512 MB instead of sharing
Shot Listed's. Add a database user, allow access from anywhere (`0.0.0.0/0`, since
Vercel has no fixed IPs), and copy the connection string. Collections and indexes are
created on first request.

The free cluster pauses after 30 days with no connections; resume it from the Atlas
dashboard if it does.

### 3. Vercel

1. Push this repo to GitHub and import it as a **new Vercel project** (no root directory
   needed). Vercel detects the Hono app in `src/index.ts`.
2. Add every variable from `.env.example`. Generate `ADMIN_TOKEN` and `CRON_SECRET` with
   `openssl rand -hex 32`.
3. Deploy. `vercel.json` schedules the daily cleanup at 03:00 UTC (Vercel Hobby allows
   one run a day, which is all it needs).
4. Check it: `curl https://<project>.vercel.app/v1/health`.

### 4. Keys for your apps

```bash
npm install
ADMIN_TOKEN=... npm run create-key -- --url https://<project>.vercel.app \
  --app shot-listed --name vercel --scopes read,write,delete
```

The key is printed once. Put it in Shot Listed's `STORAGE_API_KEY`. Make a second one
(`--name pipeline-host`) for the pipeline host when you build it. To rotate a key,
create a new one, switch the app over, then revoke the old one with
`DELETE /v1/keys/<id>` (admin token).

### 5. Prove it works

```bash
STORAGE_API_KEY=rsk_... npm run smoke -- https://<project>.vercel.app
```

It uploads a 1 KB file, re-sends it (expects a duplicate), stops a 70 MB upload after 3
parts and resumes it, reads it back, adds a thumbnail, checks usage, and deletes it all.

## Local development

```bash
npm install
cp .env.example .env         # fill it in
npm run dev                  # http://localhost:8787, using your Atlas database

# Or with no database at all (everything is forgotten on restart):
STORE=memory R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... \
  R2_BUCKET=... ADMIN_TOKEN=$(openssl rand -hex 32) npm run start:memory
```

## Tests

```bash
npm run typecheck
npm test                                          # unit, store rules (in memory), auth

pip install "moto[server]" && moto_server -p 5055 &
R2_TEST_ENDPOINT=http://127.0.0.1:5055 npm test   # + every upload, resume, link, variant and merge flow

MONGODB_TEST_URI="mongodb+srv://..." npm test     # + the same store rules against real MongoDB
```

`MONGODB_TEST_URI` should point at a cluster you don't mind tests writing to; each run
uses a throwaway database (`r2_storage_test_…`) and drops it afterwards.

## API at a glance

All routes are under `/v1` and take `Authorization: Bearer <key>`. Full contract:
`openapi.yaml`; behaviour: `docs/TRD.md`.

| Route | Scope | What |
| --- | --- | --- |
| `GET /v1/health` | none | Is it up |
| `POST /v1/uploads` | write | Start an upload, resume one, or report a duplicate |
| `GET /v1/uploads/:id` | write | Resume state |
| `POST /v1/uploads/:id/parts` | write | Signed part URLs (up to 100) |
| `POST /v1/uploads/:id/complete` | write | Finish; checks the size with R2 |
| `DELETE /v1/uploads/:id` | delete | Cancel |
| `GET /v1/assets` | read | List, newest first, optional signed links |
| `POST /v1/assets/urls` | read | Signed links for up to 100 assets |
| `GET /v1/assets/:id` | read | One asset |
| `POST /v1/assets/:id/url` | read | Signed view or download link |
| `PATCH /v1/assets/:id` | write | Metadata, taken-at, collection, filename, hash, external ID |
| `DELETE /v1/assets/:id` | delete | Delete the original, variants and record |
| `POST /v1/assets/:id/merge` | write + delete | Fold a duplicate in, keeping the better original |
| `POST /v1/assets/:id/variants` | write | Signed PUT for a derived file |
| `POST /v1/assets/:id/variants/:name/complete` | write | Finish a variant |
| `DELETE /v1/assets/:id/variants/:name` | delete | Remove a variant |
| `DELETE /v1/assets/:id/original` | delete | Drop the original, keep the proxy |
| `GET /v1/usage` | read | Bytes and counts for your app |
| `POST` / `GET /v1/keys`, `DELETE /v1/keys/:id` | admin | Manage keys |
| `GET /v1/cron/cleanup` | cron secret | Daily cleanup |

## Limits worth knowing

- Files up to 5 GiB; up to 64 MiB in one PUT, larger ones in 8 MiB parts.
- Upload links last 15 minutes, view links 1 hour by default (24 hours at most).
- Vercel Hobby is for personal, non-commercial use. If you sell an app built on this,
  move to Vercel Pro (or another host; the API stays the same).
