// MongoDB Atlas store. Its own database (default `r2_storage`), ideally in its own Atlas
// project so it has its own free cluster and never shares Shot Listed's 512 MB.
import { MongoClient, MongoServerError, type Collection, type Db, type Filter } from "mongodb";
import { DuplicateKeyError } from "../errors.js";
import type { ApiKeyRecord, AssetPatch, AssetRecord, Store, UsageRow } from "./types.js";

type AssetDoc = Omit<AssetRecord, "id"> & { _id: string };
type KeyDoc = Omit<ApiKeyRecord, "id"> & { _id: string };
type OrphanDoc = { _id: string; createdAt: Date };

const toAsset = ({ _id, ...rest }: AssetDoc): AssetRecord => ({ id: _id, ...rest });
const toKey = ({ _id, ...rest }: KeyDoc): ApiKeyRecord => ({ id: _id, ...rest });

function asDuplicate(err: unknown): never {
  if (err instanceof MongoServerError && err.code === 11000) {
    const fields = Object.keys((err.keyPattern as Record<string, unknown>) ?? {});
    if (fields.includes("contentHash")) throw new DuplicateKeyError("contentHash");
    if (fields.includes("externalId")) throw new DuplicateKeyError("externalId");
    if (fields.includes("key")) throw new DuplicateKeyError("key");
    throw new DuplicateKeyError("id");
  }
  throw err;
}

// One client per warm function instance; Vercel reuses it across requests.
const cache = globalThis as unknown as { _r2StorageMongo?: Map<string, Promise<MongoClient>> };

export async function connect(uri: string): Promise<MongoClient> {
  cache._r2StorageMongo ??= new Map();
  let client = cache._r2StorageMongo.get(uri);
  if (!client) {
    // Small pool: the free cluster allows 500 connections and serverless instances multiply.
    client = new MongoClient(uri, { maxPoolSize: 5, serverSelectionTimeoutMS: 8000 }).connect();
    client.catch(() => cache._r2StorageMongo?.delete(uri));
    cache._r2StorageMongo.set(uri, client);
  }
  return client;
}

export async function ensureIndexes(db: Db): Promise<void> {
  const assets = db.collection<AssetDoc>("assets");
  await Promise.all([
    assets.createIndex(
      { app: 1, collection: 1, contentHash: 1 },
      { unique: true, name: "unique_hash", partialFilterExpression: { contentHash: { $type: "string" } } },
    ),
    assets.createIndex(
      { app: 1, externalId: 1 },
      { unique: true, name: "unique_external_id", partialFilterExpression: { externalId: { $type: "string" } } },
    ),
    assets.createIndex({ key: 1 }, { unique: true, name: "unique_key" }),
    assets.createIndex({ app: 1, collection: 1, status: 1, createdAt: -1, _id: -1 }, { name: "list" }),
    assets.createIndex({ app: 1, kind: 1, status: 1, createdAt: -1, _id: -1 }, { name: "list_kind" }),
    assets.createIndex({ status: 1, updatedAt: 1 }, { name: "stale" }),
    db.collection<KeyDoc>("api_keys").createIndex({ app: 1 }, { name: "by_app" }),
  ]);
}

export async function mongoStore(uri: string, dbName: string): Promise<Store> {
  const client = await connect(uri);
  const db = client.db(dbName);
  const indexes = cache as unknown as { _r2StorageIndexes?: Map<string, Promise<void>> };
  indexes._r2StorageIndexes ??= new Map();
  if (!indexes._r2StorageIndexes.has(dbName)) {
    const p = ensureIndexes(db);
    p.catch(() => indexes._r2StorageIndexes?.delete(dbName));
    indexes._r2StorageIndexes.set(dbName, p);
  }
  await indexes._r2StorageIndexes.get(dbName);
  return storeFor(client, db);
}

function storeFor(client: MongoClient, db: Db): Store {
  const assets: Collection<AssetDoc> = db.collection<AssetDoc>("assets");
  const keys: Collection<KeyDoc> = db.collection<KeyDoc>("api_keys");
  const orphans: Collection<OrphanDoc> = db.collection<OrphanDoc>("orphans");

  return {
    async insertAsset(asset) {
      const { id, ...rest } = asset;
      await assets.insertOne({ _id: id, ...stripUndefined(rest) }).catch(asDuplicate);
    },
    async getAsset(app, id) {
      const d = await assets.findOne({ _id: id, app });
      return d && toAsset(d);
    },
    async getAssets(app, ids) {
      return (await assets.find({ _id: { $in: ids }, app }).toArray()).map(toAsset);
    },
    async findByExternalId(app, externalId) {
      const d = await assets.findOne({ app, externalId });
      return d && toAsset(d);
    },
    async findByHash(app, collection, contentHash) {
      const d = await assets.findOne({ app, collection, contentHash });
      return d && toAsset(d);
    },
    async updateAsset(app, id, set, unset = [], where = {}) {
      const filter: Filter<AssetDoc> = { _id: id, app };
      if (where.status) filter.status = where.status;
      if (where.externalIdMissing) filter.externalId = { $exists: false };
      const update: Record<string, unknown> = { $set: stripUndefined(set) };
      if (unset.length) update.$unset = Object.fromEntries(unset.map((k) => [k, ""]));
      const d = await assets
        .findOneAndUpdate(filter, update, { returnDocument: "after" })
        .catch(asDuplicate);
      return d && toAsset(d);
    },
    async deleteAsset(app, id) {
      return (await assets.deleteOne({ _id: id, app })).deletedCount === 1;
    },
    async listAssets(app, q) {
      const filter: Filter<AssetDoc> = { app, status: q.status };
      if (q.collection) filter.collection = q.collection;
      if (q.kind) filter.kind = q.kind;
      if (q.before) {
        filter.$or = [
          { createdAt: { $lt: q.before.createdAt } },
          { createdAt: q.before.createdAt, _id: { $lt: q.before.id } },
        ];
      }
      const docs = await assets.find(filter).sort({ createdAt: -1, _id: -1 }).limit(q.limit).toArray();
      return docs.map(toAsset);
    },
    async staleUploads(before, limit) {
      const docs = await assets.find({ status: "uploading", updatedAt: { $lt: before } }).limit(limit).toArray();
      return docs.map(toAsset);
    },
    async usage(app) {
      return assets
        .aggregate<UsageRow>([
          { $match: { app, status: "uploaded" } },
          {
            $project: {
              collection: 1,
              kind: 1,
              bytes: {
                $add: [
                  { $cond: ["$hasOriginal", "$size", 0] },
                  {
                    $sum: {
                      $map: {
                        input: { $filter: { input: "$variants", cond: { $eq: ["$$this.status", "uploaded"] } } },
                        in: "$$this.size",
                      },
                    },
                  },
                ],
              },
            },
          },
          {
            $group: {
              _id: { collection: "$collection", kind: "$kind" },
              bytes: { $sum: "$bytes" },
              objects: { $sum: 1 },
            },
          },
          { $project: { _id: 0, collection: "$_id.collection", kind: "$_id.kind", bytes: 1, objects: 1 } },
        ])
        .toArray();
    },
    async putVariant(app, id, variant) {
      // One pipeline update, so two variants finishing at once can't overwrite each other.
      const d = await assets.findOneAndUpdate(
        { _id: id, app },
        [
          {
            $set: {
              variants: {
                $concatArrays: [
                  { $filter: { input: "$variants", cond: { $ne: ["$$this.name", variant.name] } } },
                  [{ $literal: variant }],
                ],
              },
            },
          },
        ],
        { returnDocument: "after" },
      );
      return d && toAsset(d);
    },
    async removeVariant(app, id, name) {
      const d = await assets.findOneAndUpdate(
        { _id: id, app },
        { $pull: { variants: { name } } },
        { returnDocument: "after" },
      );
      return d && toAsset(d);
    },
    async merge(app, keptId, otherId, set: AssetPatch) {
      // Delete first so the other asset's contentHash and externalId are free for the kept one.
      const session = client.startSession();
      try {
        let result: AssetDoc | null = null;
        await session.withTransaction(async () => {
          const gone = await assets.deleteOne({ _id: otherId, app }, { session });
          if (gone.deletedCount !== 1) {
            result = null;
            return;
          }
          result = await assets
            .findOneAndUpdate({ _id: keptId, app }, { $set: stripUndefined(set) }, { session, returnDocument: "after" })
            .catch(asDuplicate);
          if (!result) throw new Error("Kept asset disappeared during merge");
        });
        return result ? toAsset(result) : null;
      } finally {
        await session.endSession();
      }
    },

    async insertKey(key) {
      const { id, ...rest } = key;
      await keys.insertOne({ _id: id, ...stripUndefined(rest) }).catch(asDuplicate);
    },
    async getKey(id) {
      const d = await keys.findOne({ _id: id });
      return d && toKey(d);
    },
    async listKeys(app) {
      return (await keys.find(app ? { app } : {}).sort({ createdAt: -1 }).toArray()).map(toKey);
    },
    async revokeKey(id, at) {
      const found = await keys.findOne({ _id: id });
      if (!found) return false;
      await keys.updateOne({ _id: id, revokedAt: { $exists: false } }, { $set: { revokedAt: at } });
      return true;
    },
    async touchKey(id, at) {
      await keys.updateOne({ _id: id }, { $set: { lastUsedAt: at } });
    },

    async addOrphans(list) {
      if (!list.length) return;
      const now = new Date();
      await orphans.bulkWrite(
        list.map((k) => ({ updateOne: { filter: { _id: k }, update: { $setOnInsert: { createdAt: now } }, upsert: true } })),
      );
    },
    async listOrphans(limit) {
      return (await orphans.find().limit(limit).toArray()).map((o) => o._id);
    },
    async removeOrphan(key) {
      await orphans.deleteOne({ _id: key });
    },
  };
}

/** Mongo stores `undefined` as null; partial unique indexes must see the field as missing. */
function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
