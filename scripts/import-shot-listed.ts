// One-off: copy shot-listed's old `assets` records (from before the split) into this service.
// Same IDs, same R2 keys; no files move. Only needed if shot-listed stored files in production
// before it switched to the connector.
//
//   SHOT_LISTED_MONGODB_URI=... SHOT_LISTED_MONGODB_DB=shot_listed npm run import:shot-listed -- --dry-run
//   (then without --dry-run). Uses this repo's .env for MONGODB_URI and the R2 settings.
import { parseArgs } from "node:util";
import { MongoClient } from "mongodb";
import { kindOf } from "../src/policy.js";
import { createR2, headObject } from "../src/r2.js";
import { mongoStore } from "../src/store/mongo.js";
import type { AssetRecord, Variant } from "../src/store/types.js";

try {
  process.loadEnvFile?.(".env");
} catch {
  // variables may already be set
}

const { values } = parseArgs({ options: { "dry-run": { type: "boolean", default: false }, app: { type: "string", default: "shot-listed" } } });

type OldAsset = {
  _id: string;
  origin: string;
  purpose?: "library" | "final-cut";
  key: string;
  filename: string;
  contentType: string;
  kind: "photo" | "video";
  size: number;
  contentHash?: string;
  externalId?: string;
  takenAt?: Date;
  status: "uploading" | "uploaded";
  createdAt: Date;
  updatedAt: Date;
};

const sourceUri = process.env.SHOT_LISTED_MONGODB_URI;
if (!sourceUri || !process.env.MONGODB_URI) {
  console.error("Set SHOT_LISTED_MONGODB_URI (source) and MONGODB_URI (this service) first.");
  process.exit(1);
}

const source = await new MongoClient(sourceUri).connect();
const old = source.db(process.env.SHOT_LISTED_MONGODB_DB ?? "shot_listed").collection<OldAsset>("assets");
const store = await mongoStore(process.env.MONGODB_URI, process.env.MONGODB_DB ?? "r2_storage");
const bucket = createR2({
  accountId: process.env.R2_ACCOUNT_ID!,
  accessKeyId: process.env.R2_ACCESS_KEY_ID!,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  bucket: process.env.R2_BUCKET!,
  endpoint: process.env.R2_ENDPOINT,
});

let imported = 0;
let skipped = 0;
for await (const a of old.find({ status: "uploaded" })) {
  if (await store.getAsset(values.app!, a._id)) {
    skipped++;
    continue;
  }
  const variants: Variant[] = [];
  for (const [name, key, contentType] of [
    ["proxy", `proxies/${a._id}.mp4`, "video/mp4"],
    ["thumb", `thumbs/${a._id}.jpg`, "image/jpeg"],
  ] as const) {
    const found = await headObject(bucket, key);
    if (found) variants.push({ name, key, contentType, size: found.size, status: "uploaded", createdAt: a.createdAt, updatedAt: a.updatedAt });
  }
  const record: AssetRecord = {
    id: a._id,
    app: values.app!,
    collection: a.purpose === "final-cut" ? "finals" : "library",
    key: a.key,
    filename: a.filename,
    contentType: a.contentType,
    kind: kindOf(a.contentType) ?? a.kind,
    size: a.size,
    contentHash: a.contentHash,
    externalId: a.externalId,
    takenAt: a.takenAt,
    status: "uploaded",
    hasOriginal: true,
    metadata: { origin: a.origin },
    variants,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
  if (!values["dry-run"]) await store.insertAsset(record);
  imported++;
  console.log(`${values["dry-run"] ? "would import" : "imported"} ${a._id} (${record.collection}, ${a.filename})`);
}

console.log(`\n${values["dry-run"] ? "Dry run: " : ""}${imported} to import, ${skipped} already here.`);
await source.close();
process.exit(0);
