// @vitest-environment node
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { strFromU8, unzipSync } from 'fflate';
import { exportBackup, restoreBackup } from '@backup';
import {
  BACKUP_MIGRATIONS,
  createBackupTarget,
  createSnapshotSource,
  deletePreMigrationSnapshot,
} from './backupTarget';
import {
  DEFAULT_KEEP_LAST,
  DEFAULT_REMIND_AFTER_DAYS,
  backupDue,
  clearBackupFolder,
  getBackupFolder,
  getBackupFolderState,
  recordFolderBackup,
  setBackupFolder,
  updateBackupFolderPrefs,
  type BackupFolderState,
} from './backupFolder';
import { getDb, resetDbForTests } from './db';
import { wipeAllData } from './repo';

vi.setConfig({ testTimeout: 60_000 });

beforeEach(async () => {
  await resetDbForTests();
  await deletePreMigrationSnapshot();
  fakeBrowser.reset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

// A directory handle is a structured-cloneable reference; the fake database stores plain data.
const handle = (name = 'Study backups') => ({ kind: 'directory', name });
const last = (day: number) => ({
  at: new Date(Date.UTC(2026, 9, day, 8, 0, 0)).toISOString(),
  fileName: 'studyvault-20261011-080000.zip',
  bytes: 1234,
  sha256: 'a'.repeat(64),
  encrypted: false,
  pruned: 0,
});

describe('the chosen backup folder', () => {
  it('is nothing until a folder is chosen', async () => {
    expect(await getBackupFolderState()).toBeNull();
    expect(await getBackupFolder()).toBeNull();
  });

  it('keeps the handle and the state, with the defaults', async () => {
    const now = new Date('2026-10-11T08:00:00.000Z');
    const state = await setBackupFolder(handle(), 'Study backups', now);
    expect(state).toEqual({
      folderName: 'Study backups',
      chosenAt: now.toISOString(),
      keepLast: DEFAULT_KEEP_LAST,
      remindAfterDays: DEFAULT_REMIND_AFTER_DAYS,
      last: null,
    });
    expect(await getBackupFolderState()).toEqual(state);
    expect(await getBackupFolder()).toEqual({ handle: handle(), state });
  });

  it('keeps the person’s two choices, and refuses out-of-range ones without changing anything', async () => {
    await setBackupFolder(handle(), 'A');
    const state = await updateBackupFolderPrefs({ keepLast: 12, remindAfterDays: 0 });
    expect(state).toMatchObject({ keepLast: 12, remindAfterDays: 0 });
    for (const bad of [
      { keepLast: 0, remindAfterDays: 7 },
      { keepLast: 101, remindAfterDays: 7 },
      { keepLast: 2.5, remindAfterDays: 7 },
      { keepLast: 5, remindAfterDays: -1 },
      { keepLast: 5, remindAfterDays: 366 },
    ]) {
      await expect(updateBackupFolderPrefs(bad)).rejects.toThrow();
    }
    expect(await getBackupFolderState()).toEqual(state);
  });

  it('records the last backup; choosing another folder keeps the choices and drops the record', async () => {
    await setBackupFolder(handle('A'), 'A');
    await updateBackupFolderPrefs({ keepLast: 3, remindAfterDays: 14 });
    const recorded = await recordFolderBackup(last(11));
    expect(recorded.last).toEqual(last(11));
    expect((await getBackupFolderState())?.last).toEqual(last(11));

    const other = await setBackupFolder(handle('B'), 'B');
    expect(other).toMatchObject({ folderName: 'B', keepLast: 3, remindAfterDays: 14, last: null });
    expect((await getBackupFolder())?.handle).toEqual(handle('B'));
  });

  it('refuses to record a backup when no folder is chosen', async () => {
    await expect(recordFolderBackup(last(11))).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      updateBackupFolderPrefs({ keepLast: 2, remindAfterDays: 1 }),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('reads a damaged state row as "no folder" instead of trusting it', async () => {
    await setBackupFolder(handle(), 'A');
    await getDb().meta.put({
      key: 'backupFolder.state',
      value: { folderName: '', keepLast: 'many' },
      updatedAt: new Date().toISOString(),
    });
    expect(await getBackupFolderState()).toBeNull();
    expect(await getBackupFolder()).toBeNull();
  });

  it('"stop using this folder" removes both rows', async () => {
    await setBackupFolder(handle(), 'A');
    await clearBackupFolder();
    expect(await getBackupFolder()).toBeNull();
    expect(await getDb().meta.get('backupFolder.handle')).toBeUndefined();
    expect(await getDb().meta.get('backupFolder.state')).toBeUndefined();
  });
});

describe('where the folder is kept', () => {
  it('is in no backup file, and a restore (replace) neither reads nor changes it', async () => {
    await setBackupFolder(handle(), 'Study backups');
    await recordFolderBackup(last(11));
    const before = await getBackupFolder();

    const out = await exportBackup(await createSnapshotSource(), { appVersion: 'test' });
    expect(out.manifest.tables.map((t) => t.name)).not.toContain('meta');
    const members = unzipSync(out.bytes);
    const everything = Object.values(members)
      .map((m) => strFromU8(m))
      .join('\n');
    expect(everything).not.toContain('backupFolder');
    expect(everything).not.toContain('Study backups');

    const { result } = await restoreBackup(out.bytes, {
      target: createBackupTarget(),
      mode: 'replace',
      migrations: BACKUP_MIGRATIONS,
    });
    expect(result).not.toBeNull();
    expect(await getBackupFolder()).toEqual(before);
  });

  it('"Delete all data" removes the handle and the last-backup state with the database', async () => {
    await setBackupFolder(handle(), 'Study backups');
    await recordFolderBackup(last(11));
    expect(await getBackupFolder()).not.toBeNull();

    await wipeAllData();

    expect(await getBackupFolderState()).toBeNull();
    expect(await getBackupFolder()).toBeNull();
    const keys = (await getDb().meta.toArray()).map((r) => r.key);
    expect(keys.filter((k) => k.startsWith('backupFolder'))).toEqual([]);
  });
});

describe('backupDue', () => {
  const base: BackupFolderState = {
    folderName: 'A',
    chosenAt: '2026-10-01T00:00:00.000Z',
    keepLast: 5,
    remindAfterDays: 7,
    last: null,
  };
  const day = (n: number) => new Date(Date.UTC(2026, 9, n, 12, 0, 0));

  it('counts from the last backup, else from the day the folder was chosen', () => {
    expect(backupDue(base, day(5))).toEqual({ days: 4, due: false, never: true });
    expect(backupDue(base, day(8))).toMatchObject({ days: 7, due: true, never: true });
    const used = { ...base, last: last(10) };
    expect(backupDue(used, day(12))).toEqual({ days: 2, due: false, never: false });
    expect(backupDue(used, day(20))).toMatchObject({ days: 10, due: true, never: false });
  });

  it('is never due when the reminder is off, and never negative when the clock went back', () => {
    expect(backupDue({ ...base, remindAfterDays: 0 }, day(30))).toMatchObject({
      due: false,
      days: 29,
    });
    expect(backupDue({ ...base, last: last(20) }, day(10))).toMatchObject({ days: 0, due: false });
  });
});
