import {
  getLastPurgeAt,
  getStorageUsage,
  listSearchDocuments,
  listSearchDocumentsChangedSince,
  withDb,
  withWritableDb,
} from '@storage';
import type { MetaPort } from '../vault/meta';
import type { SearchHostPorts } from '../vault/searchHost';

/** The `meta` table as the search host's cache store (same rows the dashboard's host uses). */
export const vaultMeta: MetaPort = {
  async get(key) {
    return withDb(async (db) => (await db.meta.get(key))?.value);
  },
  async put(key, value) {
    await withWritableDb(async (db) => {
      await db.meta.put({ key, value, updatedAt: new Date().toISOString() });
    });
  },
  async putMany(entries) {
    await withWritableDb((db) =>
      db.transaction('rw', db.meta, async () => {
        const updatedAt = new Date().toISOString();
        for (const e of entries) await db.meta.put({ key: e.key, value: e.value, updatedAt });
      }),
    );
  },
};

/** What `SearchHost` needs, wired to the real vault. */
export function vaultSearchPorts(): SearchHostPorts {
  return {
    listAll: (o) => listSearchDocuments(o),
    listChangedSince: (o) => listSearchDocumentsChangedSince(o),
    getLastPurgeAt: () => getLastPurgeAt(),
    countDocuments: async () => {
      const usage = await getStorageUsage();
      return (usage.rows.highlights ?? 0) + (usage.rows.notes ?? 0);
    },
    meta: vaultMeta,
  };
}
