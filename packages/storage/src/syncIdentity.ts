import { uuidv7 } from 'uuidv7';
import { getDb, type StudyVaultDb } from './db';

/**
 * This installation's sync identity, kept apart from ./sync on purpose: restoring a backup has to
 * reset it, and ./sync registers the connection gate (and loads the whole engine) when imported.
 * Everything here is device-local state in the `meta` table and the four bookkeeping stores.
 */

/** Keys of the device-local rows kept in `meta`. */
export const META_STATE = 'sync.state';
export const META_CLIENT = 'sync.clientId';
/** Rows may differ from their fingerprints: the next run reconciles before it pulls. */
export const META_DIRTY = 'sync.dirty';

const putMeta = (db: StudyVaultDb, key: string, value: unknown) =>
  db.meta.put({ key, value, updatedAt: new Date().toISOString() });

/** This installation's id (UUIDv7), created once. Never part of a backup. */
export async function ensureClientId(db: StudyVaultDb = getDb()): Promise<string> {
  return db.transaction('rw', db.meta, async () => {
    const row = await db.meta.get(META_CLIENT);
    if (typeof row?.value === 'string' && row.value.length >= 8) return row.value;
    const id = uuidv7();
    await putMeta(db, META_CLIENT, id);
    return id;
  });
}

/**
 * Call after data was replaced behind sync's back (a profile import, a database copy): new client
 * id, so operations from the old identity are not mistaken for this device's own, and a clean
 * start for the bookkeeping. The next enable reconciles the rows with the server.
 */
export async function resetSyncIdentity(db: StudyVaultDb = getDb()): Promise<string> {
  const id = uuidv7();
  await db.transaction(
    'rw',
    [db.meta, db.syncOps, db.syncEntityMeta, db.syncConflicts, db.syncQuarantine],
    async () => {
      await db.syncOps.clear();
      await db.syncEntityMeta.clear();
      await db.syncConflicts.clear();
      await db.syncQuarantine.clear();
      await db.meta.delete(META_STATE);
      await putMeta(db, META_CLIENT, id);
    },
  );
  return id;
}

/**
 * A restore replaced this database's rows wholesale. When the database has a sync identity (sync was
 * switched on here at some point), start a new one: the replaced rows are not a series of local
 * edits, so the old bookkeeping must not turn the rows the backup lacks into tombstones, and the old
 * history must not be mistaken for this device's own. The next run re-sends what is stored and
 * pulls the account's history again. Null when this database never synchronised.
 *
 * Call inside the restore transaction, whose scope must include `meta` and the four bookkeeping
 * tables (syncOps, syncEntityMeta, syncConflicts, syncQuarantine): the reset then commits or rolls
 * back with the restore.
 */
export async function resetSyncIdentityIfUsed(db: StudyVaultDb): Promise<string | null> {
  if ((await db.meta.get(META_CLIENT)) === undefined) return null;
  return resetSyncIdentity(db);
}
