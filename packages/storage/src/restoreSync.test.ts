// @vitest-environment node
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { exportBackup, restoreBackup } from '@backup';
import { SyncOperation, type Transport } from '@sync';
import { FakeServer } from '../../sync/src/testing/harness';
import { BACKUP_MIGRATIONS, createBackupTarget, createSnapshotSource } from './backupTarget';
import { getDb, resetDbForTests } from './db';
import { saveCapture } from './repo';
import { createSyncRuntime, type SyncRuntime } from './sync';
import { cap } from './test-fixtures';

/**
 * Restoring a backup while sync has been used on this device (ADR-010): the restore is not a series
 * of local edits. Real engine, real Dexie runtime, in-memory server from @sync/testing.
 */

const QUOTES = [
  'Aspirin irreversibly inhibits cyclooxygenase.',
  'Warfarin inhibits vitamin K epoxide reductase.',
  'Heparin potentiates antithrombin III.',
] as const;

let server: FakeServer;

const bridge = (): Transport => ({
  push: async (req) => server.push(req),
  pull: async ({ since, limit }) => server.pull(since, limit),
});

async function runtime(): Promise<SyncRuntime> {
  const rt = await createSyncRuntime({ isEnabled: () => true, transport: bridge() });
  rt.startCapture();
  return rt;
}

const serverOps = () => server.log.map((e) => SyncOperation.parse(e.op));
const live = async () =>
  (await getDb().highlights.toArray())
    .filter((h) => h.deletedAt === null)
    .map((h) => h.exactQuote)
    .sort();
const identity = async () => (await getDb().meta.get('sync.clientId'))?.value;

async function restoreReplace(bytes: Uint8Array) {
  return restoreBackup(bytes, {
    target: createBackupTarget(),
    mode: 'replace',
    migrations: BACKUP_MIGRATIONS,
  });
}

beforeEach(async () => {
  await resetDbForTests();
  fakeBrowser.reset();
  server = new FakeServer();
});

describe('restore when sync has been used on this device', () => {
  it('replace keeps the server as it is, starts a new identity and re-sends what it stored', async () => {
    const first = await runtime();
    await saveCapture(cap(QUOTES[0], 100));
    await saveCapture(cap(QUOTES[1], 400));
    const backup = await exportBackup(await createSnapshotSource(), { appVersion: 'test' });
    await saveCapture(cap(QUOTES[2], 800)); // made after the backup: the restore removes it here
    expect((await first.engine.sync({ force: true })).status).toBe('idle');
    expect(serverOps().some((op) => op.tombstone)).toBe(false);
    const before = serverOps().length;
    const oldId = first.clientId;

    await restoreReplace(backup.bytes);

    // the vault is the backup, and the identity and bookkeeping were reset with it
    expect(await live()).toEqual([QUOTES[0], QUOTES[1]]);
    const newId = await identity();
    expect(newId).toEqual(expect.any(String));
    expect(newId).not.toBe(oldId);
    expect(await getDb().syncOps.count()).toBe(0);
    expect(await getDb().syncEntityMeta.count()).toBe(0);
    expect(await first.isCurrent()).toBe(false); // a long-lived holder must replace its runtime
    expect(await first.isDirty()).toBe(true); // and rows are found by fingerprint, not by capture

    const second = await runtime();
    expect(second.clientId).toBe(newId);
    expect(await second.isCurrent()).toBe(true);
    await second.reconcile();
    expect((await second.engine.sync({ force: true })).status).toBe('idle');

    const after = serverOps().slice(before);
    // Nothing was deleted from the account because the backup lacked it ...
    expect(serverOps().some((op) => op.tombstone || op.opType === 'delete')).toBe(false);
    // ... everything sent after the restore carries the new identity ...
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((op) => op.clientId === newId)).toBe(true);
    // ... and the rows only the account still had come back on the pull.
    expect(await live()).toEqual([...QUOTES].sort());
  });

  it('a merge restore is ordinary edits: the identity stays', async () => {
    const rt = await runtime();
    await saveCapture(cap(QUOTES[0], 100));
    const backup = await exportBackup(await createSnapshotSource(), { appVersion: 'test' });
    await saveCapture(cap(QUOTES[1], 400));
    await rt.engine.sync({ force: true });

    await restoreBackup(backup.bytes, {
      target: createBackupTarget(),
      mode: 'merge',
      migrations: BACKUP_MIGRATIONS,
    });

    expect(await identity()).toBe(rt.clientId);
    expect(await rt.isCurrent()).toBe(true);
    expect(await live()).toEqual([QUOTES[0], QUOTES[1]]);
  });

  it('a device that never synchronised gets no sync identity from a restore', async () => {
    await saveCapture(cap(QUOTES[0], 100));
    const backup = await exportBackup(await createSnapshotSource(), { appVersion: 'test' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await restoreReplace(backup.bytes);

    expect(await identity()).toBeUndefined();
    expect(await live()).toEqual([QUOTES[0]]);
  });

  it('every context records under the identity that is stored now', async () => {
    const stale = await runtime();
    await saveCapture(cap(QUOTES[0], 100));
    const backup = await exportBackup(await createSnapshotSource(), { appVersion: 'test' });
    await restoreReplace(backup.bytes);
    const newId = (await identity()) as string;
    expect(stale.clientId).not.toBe(newId);

    // `stale` is still the installed capture runtime of this connection (a context that was open).
    await saveCapture(cap(QUOTES[1], 400));

    const queued = (await stale.log.pending(100)).map((p) => p.op.clientId);
    expect(queued.length).toBeGreaterThan(0);
    expect(new Set(queued)).toEqual(new Set([newId]));
  });
});
