// @vitest-environment node
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { closeDb, getDb, onBeforeMigrate, resetDbForTests } from './db';
import { listBanks } from './repo';
import { loadFixture, seedV1 } from './test-vault';

/**
 * Every extension context that loads the storage layer registers a pre-migration hook, so every
 * first read used to open the database twice: a schema-less probe to learn its version, then the
 * real open. `indexedDB.databases()` already reports the version, so a current database is opened
 * once.
 */
beforeEach(async () => {
  await resetDbForTests();
  fakeBrowser.reset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('opening the database with a pre-migration hook registered', () => {
  it('opens a database that is already current exactly once, and never calls the hook', async () => {
    await listBanks(); // creates the database at the current version
    closeDb();

    const hook = vi.fn();
    const off = onBeforeMigrate(hook);
    const open = vi.spyOn(indexedDB, 'open');
    try {
      await listBanks();
      expect(open).toHaveBeenCalledTimes(1);
      expect(hook).not.toHaveBeenCalled();
      expect(getDb().isOpen()).toBe(true);
    } finally {
      off();
    }
  });

  it('still probes an older database, so the hook sees the data before the upgrade', async () => {
    const v1 = loadFixture('schema-v1.json');
    await seedV1(v1);

    const seen: number[] = [];
    const off = onBeforeMigrate(async (ctx) => {
      seen.push(ctx.fromVersion);
      expect((await ctx.snapshot()).highlights).toHaveLength(v1.highlights.length);
    });
    const open = vi.spyOn(indexedDB, 'open');
    try {
      await listBanks();
      expect(seen).toEqual([1]);
      // The probe, then the real open (which upgrades): more than the single open above.
      expect(open.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      off();
    }
  });
});
