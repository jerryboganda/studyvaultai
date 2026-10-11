import { setTrustedSettingsStore } from '@runtime';
import { parseSettings } from '@shared';
import { withDb, withWritableDb } from './db';

/**
 * Privileged configuration, kept where a content script cannot reach it.
 *
 * `chrome.storage.local` is readable and writable by content scripts, which run next to untrusted page
 * script. Whatever steers where tokens and the vault are sent, or what the worker lets through, must
 * not live there. The extension origin's IndexedDB can only be opened by extension pages and the
 * service worker, so these rows live in the `meta` table (never exported, never in a backup, removed
 * by "Delete all data" together with the database):
 *
 *  - `sync.config`      the sync server, the sign-in provider and the client id (+ the key profile
 *                       this device has seen). Written by the worker only.
 *  - `sync.encryption`  the person's decision about how uploads are protected, and the marker that
 *                       end-to-end encryption was enabled (downgrade protection).
 *  - `settings.trusted` the authoritative copy of the settings the worker enforces (deny list,
 *                       private-window capture, feature flags). Written only through `updateSettings`.
 *
 * Nothing here is a secret in itself, but each of them decides where secrets go.
 */

export type SyncPrivateKey = 'sync.config' | 'sync.encryption';

const TRUSTED_SETTINGS_KEY = 'settings.trusted';

export async function readSyncPrivate(key: SyncPrivateKey): Promise<unknown> {
  const row = await withDb((db) => db.meta.get(key));
  return row?.value ?? null;
}

/** `null` removes the row. */
export async function writeSyncPrivate(key: SyncPrivateKey, value: unknown): Promise<void> {
  await withWritableDb(async (db) => {
    if (value === null) await db.meta.delete(key);
    else await db.meta.put({ key, value, updatedAt: new Date().toISOString() });
  });
}

// Every extension context that can write settings imports this barrel, so every writer keeps the
// authoritative copy current. A context without IndexedDB (a content script, a database-less test
// sandbox) registers nothing and keeps the single-copy behaviour.
if (typeof indexedDB !== 'undefined') {
  setTrustedSettingsStore({
    async load() {
      const row = await withDb((db) => db.meta.get(TRUSTED_SETTINGS_KEY));
      return row ? parseSettings(row.value) : null;
    },
    async save(settings) {
      await withDb(async (db) => {
        await db.meta.put({
          key: TRUSTED_SETTINGS_KEY,
          value: settings,
          updatedAt: new Date().toISOString(),
        });
      });
    },
  });
}
