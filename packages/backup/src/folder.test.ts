// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { strToU8 } from 'fflate';
import { BackupError } from './errors';
import { exportBackup, type ExportOptions } from './export';
import {
  FOLDER_ORIGIN,
  ensureFolderPermission,
  folderError,
  hasFolderMarker,
  isFolderBackupName,
  writeFolderBackup,
} from './folder';
import { MemoryDirectory } from './memoryDirectory';
import { restoreBackup, inspectBackup } from './restore';
import { MemoryVault, fastKdf, pack, seedVault, subtle } from './testkit';

const at = (second: number) => new Date(Date.UTC(2026, 9, 11, 8, 30, second));

/** A backup of a small vault, written "at" the given second of 2026-10-11 08:30 UTC. */
const backup = (second: number, extra: Partial<ExportOptions> = {}) =>
  exportBackup(seedVault(3), {
    subtle,
    appVersion: '0.2.0',
    now: () => at(second),
    origin: FOLDER_ORIGIN,
    ...extra,
  });

const failure = async (run: () => Promise<unknown>): Promise<BackupError> => {
  try {
    await run();
  } catch (err) {
    expect(err).toBeInstanceOf(BackupError);
    return err as BackupError;
  }
  throw new Error('expected a BackupError');
};

describe('the marker that says a file is this feature’s own', () => {
  it('is in the manifest of a plain backup, inside the checksum, and the file still restores', async () => {
    const out = await backup(0);
    expect(out.manifest.origin).toBe('backup-folder');
    expect(await hasFolderMarker(new Blob([out.bytes as Uint8Array<ArrayBuffer>]))).toBe(true);
    const info = await inspectBackup(out.bytes, { subtle });
    expect(info.manifest?.origin).toBe('backup-folder');
    const target = new MemoryVault();
    const { result } = await restoreBackup(out.bytes, { target, mode: 'replace', subtle });
    expect(result).not.toBeNull();
  });

  it('is readable in the header of an encrypted backup without the passphrase', async () => {
    const out = await backup(0, { passphrase: 'correct horse battery', ...fastKdf });
    expect(out.encrypted).toBe(true);
    expect(await hasFolderMarker(new Blob([out.bytes as Uint8Array<ArrayBuffer>]))).toBe(true);
    // ... and the file still opens with the passphrase
    const info = await inspectBackup(out.bytes, { subtle, passphrase: 'correct horse battery' });
    expect(info.manifest?.origin).toBe('backup-folder');
  });

  it('is absent from a manual export, an encrypted manual export and any other file', async () => {
    const manual = await backup(0, { origin: undefined });
    expect(manual.manifest.origin).toBeUndefined();
    expect(await hasFolderMarker(new Blob([manual.bytes as Uint8Array<ArrayBuffer>]))).toBe(false);
    const manualEncrypted = await exportBackup(seedVault(2), {
      subtle,
      passphrase: 'correct horse battery',
      ...fastKdf,
    });
    expect(
      await hasFolderMarker(new Blob([manualEncrypted.bytes as Uint8Array<ArrayBuffer>])),
    ).toBe(false);
    const other = pack({
      'readme.txt': strToU8('hello'),
      'manifest.json': strToU8('{"origin":"backup-folder"}'),
    });
    for (const bytes of [other, strToU8('plain text'), new Uint8Array(0), new Uint8Array(100)]) {
      expect(await hasFolderMarker(new Blob([bytes as Uint8Array<ArrayBuffer>]))).toBe(false);
    }
  });

  it('is not claimed by a truncated or damaged file', async () => {
    const out = await backup(0);
    const half = out.bytes.slice(0, Math.floor(out.bytes.length / 2));
    expect(await hasFolderMarker(new Blob([half as Uint8Array<ArrayBuffer>]))).toBe(false);
    const hit = out.bytes.slice();
    hit.fill(0xff, hit.length - 30); // the end-of-directory record
    expect(await hasFolderMarker(new Blob([hit as Uint8Array<ArrayBuffer>]))).toBe(false);
  });

  it('names: only the feature’s own shape, never the manual export or a directory-like name', () => {
    for (const ok of [
      'studyvault-20261011-083000.zip',
      'studyvault-20261011-083000.svbackup',
      'studyvault-20261011-083000-2.zip',
    ]) {
      expect(isFolderBackupName(ok), ok).toBe(true);
    }
    for (const no of [
      'studyvault-backup-20261011-083000.zip',
      'studyvault-before-restore-20261011-083000.zip',
      'studyvault-20261011-083000.zip.bak',
      'studyvault-20261011.zip',
      '../studyvault-20261011-083000.zip',
      'notes.txt',
    ]) {
      expect(isFolderBackupName(no), no).toBe(false);
    }
  });
});

describe('writeFolderBackup', () => {
  it('writes the file under the dated name, verifies it and reports what it did', async () => {
    const dir = new MemoryDirectory();
    const out = await backup(5);
    const written = await writeFolderBackup(dir, out, { keepLast: 5 });
    expect(written).toMatchObject({
      fileName: 'studyvault-20261011-083005.zip',
      bytes: out.bytes.length,
      pruned: [],
      pruneFailed: [],
      inFolder: 1,
    });
    expect(dir.names()).toEqual(['studyvault-20261011-083005.zip']);
    expect(dir.files.get('studyvault-20261011-083005.zip')).toEqual(out.bytes);
    // the file in the folder is a backup the restore reads
    const info = await inspectBackup(dir.files.get(written.fileName) as Uint8Array, { subtle });
    expect(info.manifest?.checksum).toBe(out.manifest.checksum);
  });

  it('an encrypted backup is a .svbackup with the same marker', async () => {
    const dir = new MemoryDirectory();
    const out = await backup(7, { passphrase: 'correct horse battery', ...fastKdf });
    const written = await writeFolderBackup(dir, out, { keepLast: 5 });
    expect(written.fileName).toBe('studyvault-20261011-083007.svbackup');
    expect(await hasFolderMarker(await (await dir.getFileHandle(written.fileName)).getFile())).toBe(
      true,
    );
  });

  it('keeps the newest N of its own files and deletes nothing else', async () => {
    const dir = new MemoryDirectory();
    const mine: string[] = [];
    for (let s = 1; s <= 4; s++) {
      const name = `studyvault-20261011-08300${s}.zip`;
      dir.put(name, (await backup(s)).bytes);
      mine.push(name);
    }
    const encrypted = await backup(9, { passphrase: 'correct horse battery', ...fastKdf });
    dir.put('studyvault-20261011-083009.svbackup', encrypted.bytes);
    // everything that must survive: other files, look-alikes without the marker, a folder
    const manual = await exportBackup(seedVault(2), { subtle });
    dir.put('notes.txt', 'my notes');
    dir.put('studyvault-backup-20200101-000000.zip', manual.bytes);
    dir.put('studyvault-20200101-000000.zip', manual.bytes); // right name, no marker
    dir.put('studyvault-20200102-000000.svbackup', strToU8('not even a container'));
    dir.put(
      'studyvault-20200103-000000.zip',
      pack({ 'manifest.json': strToU8('{"origin":"backup-folder"}') }),
    );
    dir.directories.add('studyvault-20190101-000000.zip');
    const foreign = [
      ...dir.names().filter((n) => !mine.includes(n) && !n.endsWith('083009.svbackup')),
    ];

    const written = await writeFolderBackup(dir, await backup(10), { keepLast: 3 });

    expect(written.fileName).toBe('studyvault-20261011-083010.zip');
    // the 3 newest of the feature's own: 10 (new), 9 (encrypted), 4
    expect(written.pruned.sort()).toEqual([
      'studyvault-20261011-083001.zip',
      'studyvault-20261011-083002.zip',
      'studyvault-20261011-083003.zip',
    ]);
    expect(written.inFolder).toBe(3);
    expect(dir.names()).toEqual(
      [
        ...foreign,
        'studyvault-20261011-083004.zip',
        'studyvault-20261011-083009.svbackup',
        'studyvault-20261011-083010.zip',
      ].sort(),
    );
    expect(dir.directories.has('studyvault-20190101-000000.zip')).toBe(true);
  });

  it('keepLast 1 keeps just the new backup; a file with the same second gets a suffix and replaces nothing', async () => {
    const dir = new MemoryDirectory();
    const first = await backup(3);
    await writeFolderBackup(dir, first, { keepLast: 5 });
    const second = await backup(3, { appVersion: '0.2.1' });
    const written = await writeFolderBackup(dir, second, { keepLast: 5 });
    expect(written.fileName).toBe('studyvault-20261011-083003-2.zip');
    expect(dir.files.get('studyvault-20261011-083003.zip')).toEqual(first.bytes);
    const third = await writeFolderBackup(dir, await backup(4), { keepLast: 1 });
    expect(third.pruned.sort()).toEqual([
      'studyvault-20261011-083003-2.zip',
      'studyvault-20261011-083003.zip',
    ]);
    expect(dir.names()).toEqual(['studyvault-20261011-083004.zip']);
  });

  it('refuses a backup that is not marked for the folder, and a bad keepLast, before writing', async () => {
    const dir = new MemoryDirectory();
    const unmarked = await exportBackup(seedVault(1), { subtle, now: () => at(1) });
    expect((await failure(() => writeFolderBackup(dir, unmarked, { keepLast: 3 }))).code).toBe(
      'invalid_options',
    );
    expect(
      (await failure(async () => writeFolderBackup(dir, await backup(1), { keepLast: 0 }))).code,
    ).toBe('invalid_options');
    expect(dir.names()).toEqual([]);
  });

  it('a full drive leaves no empty file, keeps every older backup and prunes nothing', async () => {
    const dir = new MemoryDirectory();
    for (let s = 1; s <= 3; s++) await writeFolderBackup(dir, await backup(s), { keepLast: 10 });
    const before = dir.names();
    dir.freeBytes = 10;
    const err = await failure(async () => writeFolderBackup(dir, await backup(4), { keepLast: 1 }));
    expect(err.code).toBe('disk_full');
    expect(dir.names()).toEqual(before);
  });

  it('a file that does not read back the same is removed, reported, and prunes nothing', async () => {
    const dir = new MemoryDirectory();
    await writeFolderBackup(dir, await backup(1), { keepLast: 1 });
    const before = dir.names();

    for (const [what, corrupt] of [
      ['short', (b: Uint8Array) => b.slice(0, b.length - 10)],
      [
        'altered',
        (b: Uint8Array) => {
          const c = b.slice();
          c[Math.floor(c.length / 2)] = (c[Math.floor(c.length / 2)] ?? 0) ^ 0xff;
          return c;
        },
      ],
    ] as const) {
      dir.corrupt = corrupt;
      const err = await failure(async () =>
        writeFolderBackup(dir, await backup(2), { keepLast: 1 }),
      );
      expect(err.code, what).toBe('folder_verify_failed');
      expect(dir.names(), `${what}: only the file that was already there`).toEqual(before);
    }
  });

  it('a folder that is gone, or no longer allowed, is told apart from a full drive', async () => {
    const gone = new MemoryDirectory();
    gone.gone = true;
    expect(
      (await failure(async () => writeFolderBackup(gone, await backup(1), { keepLast: 2 }))).code,
    ).toBe('folder_missing');
    const denied = new MemoryDirectory();
    denied.permission = 'denied';
    expect(
      (await failure(async () => writeFolderBackup(denied, await backup(1), { keepLast: 2 }))).code,
    ).toBe('folder_permission');
  });

  it('a file that cannot be removed is reported and the new backup is still safe', async () => {
    const dir = new MemoryDirectory();
    await writeFolderBackup(dir, await backup(1), { keepLast: 5 });
    dir.locked.add('studyvault-20261011-083001.zip');
    const written = await writeFolderBackup(dir, await backup(2), { keepLast: 1 });
    expect(written.pruned).toEqual([]);
    expect(written.pruneFailed).toEqual(['studyvault-20261011-083001.zip']);
    expect(dir.names()).toEqual([
      'studyvault-20261011-083001.zip',
      'studyvault-20261011-083002.zip',
    ]);
  });
});

describe('ensureFolderPermission', () => {
  it('passes when granted and does not prompt', async () => {
    const dir = new MemoryDirectory();
    await ensureFolderPermission(dir);
    expect(dir.requests).toBe(0);
  });

  it('asks again when the grant is gone, and passes when the person allows it', async () => {
    const dir = new MemoryDirectory();
    dir.permission = 'prompt';
    await ensureFolderPermission(dir);
    expect(dir.requests).toBe(1);
    expect(dir.permission).toBe('granted');
  });

  it('says folder_permission when the person refuses, and can be tried again', async () => {
    const dir = new MemoryDirectory();
    dir.permission = 'prompt';
    dir.afterRequest = 'denied';
    expect((await failure(() => ensureFolderPermission(dir))).code).toBe('folder_permission');
    dir.afterRequest = 'granted';
    await ensureFolderPermission(dir);
    expect(dir.requests).toBe(2);
  });

  it('a request without a user gesture (SecurityError) is the same answer', async () => {
    const dir = new MemoryDirectory();
    dir.permission = 'prompt';
    dir.requestPermission = () =>
      Promise.reject(new DOMException('needs a gesture', 'SecurityError'));
    expect((await failure(() => ensureFolderPermission(dir))).code).toBe('folder_permission');
  });
});

describe('folderError', () => {
  it('maps the DOMExceptions Chrome throws', () => {
    const code = (name: string, message = 'x') => folderError(new DOMException(message, name)).code;
    expect(code('NotAllowedError')).toBe('folder_permission');
    expect(code('NotFoundError')).toBe('folder_missing');
    expect(code('QuotaExceededError')).toBe('disk_full');
    expect(code('UnknownError', 'No space left on device')).toBe('disk_full');
    expect(code('NoModificationAllowedError')).toBe('folder_write_failed');
    expect(folderError(new Error('boom')).code).toBe('folder_write_failed');
  });
});
