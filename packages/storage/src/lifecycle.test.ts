// @vitest-environment node
import 'fake-indexeddb/auto';
import Dexie, { type DBCore } from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  PRE_MIGRATION_DB,
  RESTORE_STAGING_DB,
  deletePreMigrationSnapshot,
  getPreMigrationInfo,
  installPreMigrationSnapshot,
} from './backupTarget';
import { DB_NAME, DB_VERSION, SCHEMA_V1, SCHEMA_V2, closeDb, getDb, resetDbForTests } from './db';
import { observe } from './observe';
import { listBanks, listRecentHighlights, saveCapture, wipeAllData } from './repo';
import { createSyncRuntime } from './sync';
import { cap } from './test-fixtures';
import { loadFixture, seedV1 } from './test-vault';

/**
 * Database lifecycle across contexts: who takes the pre-update copy, what a bounded copy costs and
 * what "Delete all data" does while another window still holds the database.
 */

beforeEach(async () => {
  await resetDbForTests();
  await deletePreMigrationSnapshot();
  fakeBrowser.reset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

const databaseNames = async () => (await indexedDB.databases()).map((d) => d.name);

describe('pre-update copy: whichever context upgrades the database', () => {
  let off: (() => void) | null = null;
  afterEach(() => {
    off?.();
    off = null;
  });

  it('a schema upgrade done by the sync runtime (raw open) still keeps the copy', async () => {
    off = installPreMigrationSnapshot({ appVersion: 'test' });
    await seedV1(loadFixture('schema-v1.json'));
    closeDb();

    const runtime = await createSyncRuntime({ isEnabled: () => true });

    expect(runtime.db.verno).toBe(DB_VERSION);
    expect(await getPreMigrationInfo()).toMatchObject({ status: 'kept', fromVersion: 1 });
  });

  it('is installed by the storage layer itself, with the manifest version read lazily', async () => {
    await seedV1(loadFixture('schema-v1.json'));
    // A page that never calls installPreMigrationSnapshot: only the module graph is new.
    vi.resetModules();
    const fresh = await import('./db');
    const target = await import('./backupTarget');
    const { browser } = await import('wxt/browser');
    Object.assign(browser.runtime, { getManifest: () => ({ version: '7.7.7' }) });
    try {
      await fresh.withDb(async () => {});
      expect(fresh.getDb().verno).toBe(DB_VERSION);
      expect(await target.getPreMigrationInfo()).toMatchObject({ status: 'kept', fromVersion: 1 });
      const kept = await target.readPreMigrationSnapshot();
      const { inspectBackup } = await import('@backup');
      expect((await inspectBackup(kept!.bytes)).manifest?.createdBy.version).toBe('7.7.7');
    } finally {
      fresh.closeDb();
    }
  });

  it('a live query that triggers the upgrade still gets its copy and keeps updating', async () => {
    off = installPreMigrationSnapshot({ appVersion: 'test' });
    await seedV1(loadFixture('schema-v1.json'));
    closeDb();
    const seen: number[] = [];
    const stop = observe(() => listRecentHighlights(50)).subscribe((items) =>
      seen.push(items.length),
    );
    try {
      await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0), { timeout: 5000 });
      // Dexie refuses writes inside a live query's zone: the copy must be made outside of it.
      expect(await getPreMigrationInfo()).toMatchObject({ status: 'kept', fromVersion: 1 });

      await saveCapture(cap('Added once the upgrade was done', 900));
      await vi.waitFor(() => expect(seen.at(-1)).toBe(seen[0]! + 1), { timeout: 5000 });
    } finally {
      stop();
    }
  });

  it('the same holds for the note that no copy was made, which is a write too', async () => {
    off = installPreMigrationSnapshot({ appVersion: 'test', maxBytes: 1_000 });
    await seedV1(loadFixture('schema-v1.json'));
    closeDb();
    const seen: number[] = [];
    const stop = observe(() => listRecentHighlights(50)).subscribe((items) =>
      seen.push(items.length),
    );
    try {
      await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0), { timeout: 5000 });
      expect(await getPreMigrationInfo()).toMatchObject({ status: 'too_large', fromVersion: 1 });
    } finally {
      stop();
    }
  });
});

describe('pre-update copy: memory is bounded before anything is read', () => {
  let off: (() => void) | null = null;
  afterEach(() => {
    off?.();
    off = null;
  });

  /** Counts rows every Dexie connection reads, per table (the probe included). */
  function watchReads() {
    const rows: Record<string, number> = {};
    const addon = (db: Dexie) => {
      db.use({
        stack: 'dbcore',
        name: 'count-reads',
        create(down: DBCore): DBCore {
          return {
            ...down,
            table(name) {
              const table = down.table(name);
              return {
                ...table,
                async query(req) {
                  const res = await table.query(req);
                  rows[name] = (rows[name] ?? 0) + res.result.length;
                  return res;
                },
                async getMany(req) {
                  const res = await table.getMany(req);
                  rows[name] = (rows[name] ?? 0) + res.length;
                  return res;
                },
                async openCursor(req) {
                  rows[name] = (rows[name] ?? 0) + 1;
                  return table.openCursor(req);
                },
              };
            },
          };
        },
      });
    };
    Dexie.addons.push(addon);
    return {
      rows,
      stop: () => {
        Dexie.addons.splice(Dexie.addons.indexOf(addon), 1);
      },
    };
  }

  /** A v2 database: what the previous build left, cached PDF bytes included. */
  async function seedV2WithPdfBytes() {
    await seedV1(loadFixture('schema-v1.json'));
    const old = new Dexie(DB_NAME);
    old.version(1).stores(SCHEMA_V1);
    old.version(2).stores(SCHEMA_V2);
    try {
      await old.open();
      await old.table('attachments').bulkPut(
        Array.from({ length: 5 }, (_, i) => ({
          id: `att-${i}`,
          documentId: `doc-${i}`,
          sha256: 'a'.repeat(64),
          createdAt: '2026-01-01T00:00:00.000Z',
          bytes: new Uint8Array(200_000),
        })),
      );
    } finally {
      old.close();
    }
  }

  it('never reads the cached PDF bytes it would only throw away', async () => {
    off = installPreMigrationSnapshot({ appVersion: 'test' });
    await seedV2WithPdfBytes();
    const reads = watchReads();
    try {
      await listBanks(); // upgrades v2 -> current
    } finally {
      reads.stop();
    }
    expect(await getPreMigrationInfo()).toMatchObject({ status: 'kept', fromVersion: 2 });
    expect(reads.rows.attachments ?? 0).toBe(0);
  });

  it('skips a vault that is too big by its row count and sample, and says why', async () => {
    off = installPreMigrationSnapshot({ appVersion: 'test', maxBytes: 1_000 });
    await seedV1(loadFixture('schema-v1.json'));
    const reads = watchReads();
    try {
      await listBanks();
    } finally {
      reads.stop();
    }
    const info = await getPreMigrationInfo();
    expect(info).toMatchObject({ status: 'too_large', fromVersion: 1, byteLength: 0 });
    expect(info?.reason).toMatch(/uncompressed/);
    expect(info?.rows).toBeGreaterThan(0);
    // Only the sample of each table was read: no table was loaded in full.
    expect(Object.values(reads.rows).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(
      Object.keys(info?.tables ?? {}).length * 25 + 5,
    );
    // The upgrade itself went ahead.
    expect(getDb().verno).toBe(DB_VERSION);
  });
});

describe('Delete all data while another window holds the database', () => {
  const held: IDBDatabase[] = [];
  // A test that fails must not leave a connection that blocks every later test's reset.
  afterEach(() => {
    for (const conn of held.splice(0)) conn.close();
  });

  /** A window that never answers `versionchange` (frozen, or running old code). */
  function holdOpen(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        request.result.onversionchange = () => {};
        held.push(request.result);
        resolve(request.result);
      };
    });
  }

  /** Something in every store a wipe must reach. */
  async function seedEverywhere() {
    await listBanks(); // creates the database
    await saveCapture(cap('A quote that must be gone afterwards', 10));
    const copy = new Dexie(PRE_MIGRATION_DB);
    copy.version(1).stores({ snapshots: 'id' });
    await copy.table('snapshots').put({ id: 'latest', status: 'failed' });
    copy.close();
    const staging = new Dexie(RESTORE_STAGING_DB);
    staging.version(1).stores({ leftovers: 'id' });
    await staging.table('leftovers').put({ id: 'x', quote: 'private text' });
    staging.close();
    await fakeBrowser.storage.local.set({ settings: { theme: 'dark' } });
  }

  it('reports "blocked" at once, keeps waiting and finishes the whole wipe when the window closes', async () => {
    await seedEverywhere();
    const frozen = await holdOpen();
    const states: string[] = [];
    let outcome = 'pending';
    const wipe = wipeAllData({ onState: (s) => states.push(s) });
    wipe.then(
      () => (outcome = 'done'),
      () => (outcome = 'failed'),
    );

    await vi.waitFor(() => expect(states).toEqual(['deleting', 'blocked']));
    // The other stores are the last step: nothing else was touched yet.
    expect(await databaseNames()).toEqual(
      expect.arrayContaining([PRE_MIGRATION_DB, RESTORE_STAGING_DB]),
    );
    expect((await fakeBrowser.storage.local.get('settings')).settings).toBeDefined();
    expect(outcome).toBe('pending');

    // A read in this context fails at once and says why; it does not queue behind the delete.
    await expect(listBanks()).rejects.toMatchObject({
      name: 'WipePendingError',
      code: 'storage_unavailable',
      message: expect.stringMatching(/close the other StudyVault windows/i),
    });

    frozen.close();
    await wipe;
    expect(states).toEqual(['deleting', 'blocked', 'cleaning']);
    const names = await databaseNames();
    expect(names).not.toContain(PRE_MIGRATION_DB);
    expect(names).not.toContain(RESTORE_STAGING_DB);
    expect((await fakeBrowser.storage.local.get('settings')).settings).toBeUndefined();
    // Reads work again, on an empty vault.
    expect((await listBanks()).map((b) => b.isInbox)).toEqual([true]);
    expect(await getDb().highlights.count()).toBe(0);
  });

  it('is not reported as failed after ten seconds: a queued delete cannot be taken back', async () => {
    await seedEverywhere();
    const frozen = await holdOpen();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const states: string[] = [];
      let outcome = 'pending';
      const wipe = wipeAllData({ onState: (s) => states.push(s) });
      wipe.then(
        () => (outcome = 'done'),
        () => (outcome = 'failed'),
      );
      await vi.waitFor(() => expect(states).toContain('blocked'));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(outcome).toBe('pending');

      frozen.close();
      await wipe;
      expect(outcome).toBe('done');
    } finally {
      vi.useRealTimers();
    }
  });

  it('"stop waiting" returns at once, says the delete still happens, and leaves no hung reads', async () => {
    await seedEverywhere();
    const frozen = await holdOpen();
    const stop = new AbortController();
    const states: string[] = [];
    const waiting = wipeAllData({ onState: (s) => states.push(s), signal: stop.signal });
    const outcome = waiting.then(
      () => null,
      (err: unknown) => err,
    );
    await vi.waitFor(() => expect(states).toContain('blocked'));
    stop.abort();
    expect(await outcome).toMatchObject({
      name: 'WipePendingError',
      message: expect.stringMatching(/cannot be cancelled/i),
    });

    // Still queued in IndexedDB, so this context keeps refusing instead of hanging ...
    await expect(listBanks()).rejects.toMatchObject({ name: 'WipePendingError' });
    // ... and asking again joins the same wipe instead of queueing a second one.
    const again: string[] = [];
    const second = wipeAllData({ onState: (s) => again.push(s) });
    expect(again).toEqual(['blocked']);

    frozen.close();
    await second;
    expect(await databaseNames()).not.toContain(PRE_MIGRATION_DB);
    expect((await listBanks()).length).toBe(1);
  });

  it('a wipe nobody waits for any more still clears the other stores when the delete completes', async () => {
    await seedEverywhere();
    const frozen = await holdOpen();
    const stop = new AbortController();
    const states: string[] = [];
    const waiting = wipeAllData({ onState: (s) => states.push(s), signal: stop.signal });
    waiting.catch(() => undefined);
    await vi.waitFor(() => expect(states).toContain('blocked'));
    stop.abort();

    frozen.close();
    await vi.waitFor(async () => {
      expect(await databaseNames()).not.toContain(PRE_MIGRATION_DB);
      expect((await fakeBrowser.storage.local.get('settings')).settings).toBeUndefined();
    });
  });
});
