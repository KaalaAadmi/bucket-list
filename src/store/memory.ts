// In-memory store for tests and `npm run start:memory`. Same unique rules as MongoDB.
import { DuplicateKeyError } from "../errors.js";
import type { ApiKeyRecord, AssetPatch, AssetRecord, AssetUnset, ListQuery, Store, UsageRow, Variant } from "./types.js";

const clone = <T>(v: T): T => structuredClone(v);

export function memoryStore(): Store {
  const assets = new Map<string, AssetRecord>();
  const keys = new Map<string, ApiKeyRecord>();
  const orphans = new Set<string>();

  function clash(candidate: AssetRecord, ignoreId?: string): DuplicateKeyError | null {
    for (const a of assets.values()) {
      if (a.id === ignoreId) continue;
      if (a.id === candidate.id) return new DuplicateKeyError("id");
      if (a.key === candidate.key) return new DuplicateKeyError("key");
      if (a.app !== candidate.app) continue;
      if (candidate.contentHash && a.collection === candidate.collection && a.contentHash === candidate.contentHash) {
        return new DuplicateKeyError("contentHash");
      }
      if (candidate.externalId && a.externalId === candidate.externalId) return new DuplicateKeyError("externalId");
    }
    return null;
  }

  function apply(a: AssetRecord, set: AssetPatch, unset: AssetUnset = []): AssetRecord {
    // Like Mongo's $set after stripping undefined: a missing value leaves the field alone.
    const defined = Object.fromEntries(Object.entries(set).filter(([, v]) => v !== undefined));
    const next = { ...a, ...clone(defined) } as AssetRecord;
    for (const k of unset) delete next[k];
    return next;
  }

  const store: Store = {
    async insertAsset(asset) {
      const err = clash(asset);
      if (err) throw err;
      assets.set(asset.id, clone(asset));
    },
    async getAsset(app, id) {
      const a = assets.get(id);
      return a && a.app === app ? clone(a) : null;
    },
    async getAssets(app, ids) {
      return ids.map((id) => assets.get(id)).filter((a): a is AssetRecord => !!a && a.app === app).map(clone);
    },
    async findByExternalId(app, externalId) {
      for (const a of assets.values()) if (a.app === app && a.externalId === externalId) return clone(a);
      return null;
    },
    async findByHash(app, collection, contentHash) {
      for (const a of assets.values()) {
        if (a.app === app && a.collection === collection && a.contentHash === contentHash) return clone(a);
      }
      return null;
    },
    async updateAsset(app, id, set, unset, where) {
      const a = assets.get(id);
      if (!a || a.app !== app) return null;
      if (where?.status && a.status !== where.status) return null;
      if (where?.externalIdMissing && a.externalId) return null;
      const next = apply(a, set, unset);
      const err = clash(next, id);
      if (err) throw err;
      assets.set(id, next);
      return clone(next);
    },
    async deleteAsset(app, id) {
      const a = assets.get(id);
      if (!a || a.app !== app) return false;
      return assets.delete(id);
    },
    async listAssets(app, q: ListQuery) {
      return [...assets.values()]
        .filter((a) => a.app === app && a.status === q.status)
        .filter((a) => !q.collection || a.collection === q.collection)
        .filter((a) => !q.kind || a.kind === q.kind)
        .filter(
          (a) =>
            !q.before ||
            a.createdAt < q.before.createdAt ||
            (a.createdAt.getTime() === q.before.createdAt.getTime() && a.id < q.before.id),
        )
        .sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime() || (y.id < x.id ? -1 : 1))
        .slice(0, q.limit)
        .map(clone);
    },
    async staleUploads(before, limit) {
      return [...assets.values()]
        .filter((a) => a.status === "uploading" && a.updatedAt < before)
        .slice(0, limit)
        .map(clone);
    },
    async usage(app) {
      const rows = new Map<string, UsageRow>();
      for (const a of assets.values()) {
        if (a.app !== app || a.status !== "uploaded") continue;
        const k = `${a.collection}|${a.kind}`;
        const row = rows.get(k) ?? { collection: a.collection, kind: a.kind, bytes: 0, objects: 0 };
        row.objects += 1;
        if (a.hasOriginal) row.bytes += a.size;
        for (const v of a.variants) if (v.status === "uploaded") row.bytes += v.size;
        rows.set(k, row);
      }
      return [...rows.values()];
    },
    async putVariant(app, id, variant: Variant) {
      const a = assets.get(id);
      if (!a || a.app !== app) return null;
      a.variants = [...a.variants.filter((v) => v.name !== variant.name), clone(variant)];
      return clone(a);
    },
    async removeVariant(app, id, name) {
      const a = assets.get(id);
      if (!a || a.app !== app) return null;
      a.variants = a.variants.filter((v) => v.name !== name);
      return clone(a);
    },
    async merge(app, keptId, otherId, set) {
      const kept = assets.get(keptId);
      const other = assets.get(otherId);
      if (!kept || !other || kept.app !== app || other.app !== app) return null;
      const next = apply(kept, set);
      assets.delete(otherId);
      const err = clash(next, keptId);
      if (err) {
        assets.set(otherId, other); // roll back, as a transaction would
        throw err;
      }
      assets.set(keptId, next);
      return clone(next);
    },

    async insertKey(key) {
      if (keys.has(key.id)) throw new DuplicateKeyError("id");
      keys.set(key.id, clone(key));
    },
    async getKey(id) {
      const k = keys.get(id);
      return k ? clone(k) : null;
    },
    async listKeys(app) {
      return [...keys.values()].filter((k) => !app || k.app === app).map(clone);
    },
    async revokeKey(id, at) {
      const k = keys.get(id);
      if (!k) return false;
      k.revokedAt ??= at;
      return true;
    },
    async touchKey(id, at) {
      const k = keys.get(id);
      if (k) k.lastUsedAt = at;
    },

    async addOrphans(list) {
      for (const k of list) orphans.add(k);
    },
    async listOrphans(limit) {
      return [...orphans].slice(0, limit);
    },
    async removeOrphan(key) {
      orphans.delete(key);
    },
  };
  return store;
}
