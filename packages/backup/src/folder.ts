import { inflateSync, strFromU8 } from 'fflate';
import { containerOrigin, isEncryptedContainer } from './crypto';
import { BackupError } from './errors';
import type { ExportResult } from './export';
import { BACKUP_FORMAT, MANIFEST_FILE, looksLikeZip } from './format';

/**
 * Backups written into a folder the person chose (File System Access). Pure: the folder is a port
 * (`FolderDirectory`, the subset of FileSystemDirectoryHandle used here), so this is tested with an
 * in-memory directory and driven by a real handle in the extension.
 *
 * What it promises, in order:
 *  1. A file is written under a name that is free (an existing file is never replaced).
 *  2. The file is read back and compared byte for byte (size, ZIP/container signature, manifest and
 *     every table are all inside that comparison). A file that fails is removed again.
 *  3. Only then are older backups pruned, and only files that are provably this feature's own: the
 *     name has the shape `studyvault-YYYYMMDD-HHMMSS[-n].(zip|svbackup)` AND the file carries the
 *     `origin: 'backup-folder'` marker (manifest, or the plain-text header of an encrypted file).
 *     Anything else in the folder is never opened for writing and never deleted.
 */

export const FOLDER_ORIGIN = 'backup-folder' as const;

export type FolderPermissionState = 'granted' | 'denied' | 'prompt';

export interface FolderWritable {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}

export interface FolderFileHandle {
  getFile(): Promise<Blob>;
  createWritable(): Promise<FolderWritable>;
}

export interface FolderEntry {
  readonly kind: 'file' | 'directory';
  readonly name: string;
}

export interface FolderDirectory {
  readonly name: string;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FolderFileHandle>;
  removeEntry(name: string): Promise<void>;
  values(): AsyncIterable<FolderEntry>;
  /** Chrome's permission API; absent means "just try, and map the error". */
  queryPermission?(descriptor: { mode: 'readwrite' }): Promise<FolderPermissionState>;
  requestPermission?(descriptor: { mode: 'readwrite' }): Promise<FolderPermissionState>;
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

const nameOf = (err: unknown): string =>
  typeof err === 'object' && err !== null && 'name' in err ? String((err as Error).name) : '';

/** A DOMException (or anything else) from the file system as the typed error the screens explain. */
export function folderError(err: unknown): BackupError {
  if (err instanceof BackupError) return err;
  const name = nameOf(err);
  const raw = (err as { message?: unknown } | null)?.message;
  const message = typeof raw === 'string' ? raw : String(err);
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new BackupError(
      'folder_permission',
      'StudyVault does not have permission to write to the backup folder.',
      {},
      err,
    );
  }
  if (name === 'NotFoundError' || name === 'TypeMismatchError') {
    return new BackupError(
      'folder_missing',
      'The backup folder cannot be found. It may have been moved, renamed or deleted, or its drive disconnected.',
      {},
      err,
    );
  }
  if (name === 'QuotaExceededError' || /no space|disk (is )?full|ENOSPC/i.test(message)) {
    return new BackupError(
      'disk_full',
      'There is not enough free space for the backup on the drive that holds the folder.',
      {},
      err,
    );
  }
  return new BackupError(
    'folder_write_failed',
    `The backup could not be written to the folder${message ? ` (${message})` : ''}.`,
    {},
    err,
  );
}

/**
 * Make sure the folder may be written. Call it from the click that starts a backup: `request`
 * needs a user gesture, which is why a worker can never do this on its own. Throws
 * `folder_permission` when the person says no (or the gesture is gone), so the screen can ask again
 * from the next click.
 */
export async function ensureFolderPermission(dir: FolderDirectory): Promise<void> {
  const descriptor = { mode: 'readwrite' } as const;
  let state: FolderPermissionState;
  try {
    if (!dir.queryPermission) return;
    state = await dir.queryPermission(descriptor);
    if (state !== 'granted' && dir.requestPermission)
      state = await dir.requestPermission(descriptor);
  } catch (err) {
    throw folderError(err);
  }
  if (state !== 'granted') {
    throw new BackupError(
      'folder_permission',
      'StudyVault does not have permission to write to the backup folder.',
      { state },
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Names and the ownership marker
// ---------------------------------------------------------------------------------------------

const NAME = /^studyvault-\d{8}-\d{6}(?:-\d+)?\.(?:zip|svbackup)$/;

/** The shape of every file name this feature writes (manual exports use `studyvault-backup-...`). */
export const isFolderBackupName = (name: string): boolean => NAME.test(name);

const stemOf = (name: string): string => name.replace(/\.[a-z]+$/, '');

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const MAX_DIRECTORY_BYTES = 8 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
/** Magic + length + header JSON of an encrypted container (the JSON is at most 1 KiB). */
const CONTAINER_PREFIX = 8 + 4 + 1024;

const read = async (file: Blob, start: number, end: number): Promise<Uint8Array> =>
  new Uint8Array(await file.slice(start, end).arrayBuffer());

/**
 * Does the ZIP's manifest say `origin: 'backup-folder'`? Three small ranged reads (end record,
 * central directory, the manifest entry): a big backup is never loaded to answer this.
 */
async function zipHasMarker(file: Blob): Promise<boolean> {
  const tail = await read(file, Math.max(0, file.size - (22 + 0xffff)), file.size);
  const t = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let eocd = tail.length - 22;
  while (eocd >= 0 && t.getUint32(eocd, true) !== SIG_EOCD) eocd--;
  if (eocd < 0) return false;
  const count = t.getUint16(eocd + 10, true);
  const size = t.getUint32(eocd + 12, true);
  const offset = t.getUint32(eocd + 16, true);
  if (size > MAX_DIRECTORY_BYTES || offset + size > file.size) return false;

  const dir = await read(file, offset, offset + size);
  const d = new DataView(dir.buffer, dir.byteOffset, dir.byteLength);
  for (let at = 0, i = 0; i < count && at + 46 <= dir.length; i++) {
    if (d.getUint32(at, true) !== SIG_CENTRAL) return false;
    const nameLength = d.getUint16(at + 28, true);
    const next = at + 46 + nameLength + d.getUint16(at + 30, true) + d.getUint16(at + 32, true);
    if (strFromU8(dir.subarray(at + 46, at + 46 + nameLength)) !== MANIFEST_FILE) {
      at = next;
      continue;
    }
    const method = d.getUint16(at + 10, true);
    const packed = d.getUint32(at + 20, true);
    const unpacked = d.getUint32(at + 24, true);
    const local = d.getUint32(at + 42, true);
    if (packed > MAX_MANIFEST_BYTES || unpacked > MAX_MANIFEST_BYTES) return false;
    if (method !== 0 && method !== 8) return false;
    const header = await read(file, local, local + 30);
    const h = new DataView(header.buffer, header.byteOffset, header.byteLength);
    if (header.length < 30 || h.getUint32(0, true) !== SIG_LOCAL) return false;
    const start = local + 30 + h.getUint16(26, true) + h.getUint16(28, true);
    const raw = await read(file, start, start + packed);
    const text = method === 0 ? raw : inflateSync(raw, { out: new Uint8Array(unpacked) });
    const manifest = JSON.parse(strFromU8(text)) as { format?: unknown; origin?: unknown };
    return manifest.format === BACKUP_FORMAT && manifest.origin === FOLDER_ORIGIN;
  }
  return false;
}

/** Is this file one this feature wrote? Never throws: a file that cannot be read is "not ours". */
export async function hasFolderMarker(file: Blob): Promise<boolean> {
  try {
    const head = await read(file, 0, CONTAINER_PREFIX);
    if (isEncryptedContainer(head)) return containerOrigin(head) === FOLDER_ORIGIN;
    return looksLikeZip(head) ? await zipHasMarker(file) : false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Writing, verifying, pruning
// ---------------------------------------------------------------------------------------------

/** First name (`-2`, `-3` ... after the extension's stem) that no entry of the folder has. */
async function freeName(dir: FolderDirectory, wanted: string): Promise<string> {
  for (let n = 1; n < 100; n++) {
    const name = n === 1 ? wanted : wanted.replace(/(\.[a-z]+)$/, `-${n}$1`);
    try {
      await dir.getFileHandle(name);
    } catch (err) {
      if (nameOf(err) === 'NotFoundError') return name;
      if (nameOf(err) !== 'TypeMismatchError') throw folderError(err);
    }
  }
  throw new BackupError(
    'folder_write_failed',
    'The folder already holds a hundred backups from the same second.',
  );
}

const CHUNK = 4 * 1024 * 1024;

/** The file in the folder is exactly `expected`; throws `folder_verify_failed` otherwise. */
async function verify(handle: FolderFileHandle, expected: Uint8Array): Promise<void> {
  const failed = (what: string, details: Record<string, unknown> = {}) =>
    new BackupError(
      'folder_verify_failed',
      `The file was written but does not match what was saved (${what}).`,
      details,
    );
  let file: Blob;
  try {
    file = await handle.getFile();
  } catch (err) {
    throw failed(err instanceof Error ? err.message : 'it cannot be read back');
  }
  if (file.size !== expected.length) {
    throw failed(`${file.size} bytes on disk, ${expected.length} expected`, {
      onDisk: file.size,
      expected: expected.length,
    });
  }
  try {
    for (let at = 0; at < expected.length; at += CHUNK) {
      const part = await read(file, at, Math.min(at + CHUNK, expected.length));
      for (let i = 0; i < part.length; i++) {
        if (part[i] !== expected[at + i]) throw failed(`first difference at byte ${at + i}`);
      }
    }
  } catch (err) {
    throw err instanceof BackupError ? err : failed(err instanceof Error ? err.message : 'read');
  }
}

/** Names of this feature's files in the folder, newest first. */
async function ownFiles(dir: FolderDirectory): Promise<string[]> {
  const named: string[] = [];
  for await (const entry of dir.values()) {
    if (entry.kind === 'file' && NAME.test(entry.name)) named.push(entry.name);
  }
  const own: string[] = [];
  for (const name of named) {
    try {
      if (await hasFolderMarker(await (await dir.getFileHandle(name)).getFile())) own.push(name);
    } catch {
      // unreadable: not provably ours, so it is left alone
    }
  }
  // fixed-width UTC stamps: name order is time order (a "-2" suffix sorts after its base)
  return own.sort((a, b) => (stemOf(a) < stemOf(b) ? 1 : stemOf(a) > stemOf(b) ? -1 : 0));
}

export interface FolderWriteResult {
  fileName: string;
  bytes: number;
  /** Older backups of this feature removed to keep the newest `keepLast`. */
  pruned: string[];
  /** Ones that should have been removed and could not be (the new backup is safe regardless). */
  pruneFailed: string[];
  /** How many backups made by this feature the folder holds now. */
  inFolder: number;
}

/**
 * Write one backup (from `exportBackup(..., { origin: 'backup-folder' })`) into the folder, check
 * it, and prune. Throws a typed `BackupError`; whatever it throws, files that were already in the
 * folder are untouched (a failed write or check removes only the file it just created).
 */
export async function writeFolderBackup(
  dir: FolderDirectory,
  result: Pick<ExportResult, 'bytes' | 'suggestedFilename' | 'manifest'>,
  options: { keepLast: number },
): Promise<FolderWriteResult> {
  if (!Number.isInteger(options.keepLast) || options.keepLast < 1) {
    throw new BackupError('invalid_options', 'keepLast must be a whole number of at least 1.');
  }
  const wanted = result.suggestedFilename.replace(/^studyvault-backup-/, 'studyvault-');
  if (result.manifest.origin !== FOLDER_ORIGIN || !NAME.test(wanted)) {
    throw new BackupError(
      'invalid_options',
      'Only a backup made for the folder (marked as such) can be written there.',
    );
  }

  const fileName = await freeName(dir, wanted);
  let handle: FolderFileHandle;
  try {
    handle = await dir.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(result.bytes);
      await writable.close();
    } catch (err) {
      await writable.abort?.().catch(() => undefined);
      throw err;
    }
  } catch (err) {
    // `fileName` was free a moment ago: whatever is there now is the empty file this call made
    await dir.removeEntry(fileName).catch(() => undefined);
    throw folderError(err);
  }

  try {
    await verify(handle, result.bytes);
  } catch (err) {
    await dir.removeEntry(fileName).catch(() => undefined);
    throw err;
  }

  const out: FolderWriteResult = {
    fileName,
    bytes: result.bytes.length,
    pruned: [],
    pruneFailed: [],
    inFolder: 1,
  };
  try {
    const own = await ownFiles(dir);
    const keep = new Set([
      fileName,
      ...own.filter((n) => n !== fileName).slice(0, options.keepLast - 1),
    ]);
    for (const name of own) {
      if (keep.has(name)) continue;
      try {
        await dir.removeEntry(name);
        out.pruned.push(name);
      } catch {
        out.pruneFailed.push(name);
      }
    }
    out.inFolder = own.length - out.pruned.length;
  } catch {
    // listing failed: the backup is written and verified, pruning is skipped
  }
  return out;
}
