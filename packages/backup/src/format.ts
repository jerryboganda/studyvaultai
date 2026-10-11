import { z } from 'zod';
import { strToU8, unzipSync, Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import { IsoDate } from '@shared';
import { BackupError } from './errors';
import { concatBytes } from './canonical';

export const BACKUP_FORMAT = 'studyvault-backup' as const;
/** Single-file JSON variant of the same format (small vaults). */
export const BACKUP_JSON_FORMAT = 'studyvault-backup-json' as const;
export const BACKUP_FORMAT_VERSION = 1 as const;
export const MANIFEST_FILE = 'manifest.json';
export const APP_NAME = 'StudyVault AI';

export const tableFile = (name: string): string => `tables/${name}.ndjson`;
export const blobFile = (sha256: string): string => `blobs/${sha256}.bin`;

const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

export const TableName = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);

export const ManifestTable = z.object({
  name: TableName,
  rowCount: z.number().int().min(0),
  /**
   * SHA-256 over the canonical row stream: for each row, in file order, its key-sorted JSON with
   * `derivedFields` removed, followed by "
". The file itself keeps members in stored order.
   */
  sha256: Sha256Hex,
  /** Zip entry holding the NDJSON rows. Absent in the single-file JSON variant. */
  file: z.string().max(200).optional(),
  /** Fields left out of `sha256` (recomputed by the app). */
  derivedFields: z.array(z.string().max(64)).max(64).optional(),
});
export type ManifestTable = z.infer<typeof ManifestTable>;

export const Manifest = z.object({
  format: z.literal(BACKUP_FORMAT).or(z.literal(BACKUP_JSON_FORMAT)),
  formatVersion: z.number().int().min(1),
  /** Dexie/registry schema version of the data when it was exported. */
  appSchemaVersion: z.number().int().min(1),
  createdAt: IsoDate,
  createdBy: z.object({ app: z.string().max(100), version: z.string().max(50) }),
  tables: z.array(ManifestTable).max(256),
  options: z.object({
    /** true when at least one localOnly table (e.g. cached PDF bytes) is included. */
    includesAttachments: z.boolean(),
    encrypted: z.boolean(),
  }),
  /** SHA-256 of canonicalJson(manifest without this field). */
  checksum: Sha256Hex,
});
export type Manifest = z.infer<typeof Manifest>;

export interface RestoreLimits {
  /** Largest accepted input file. */
  maxArchiveBytes: number;
  /** Zip entries (tables + blobs + manifest). */
  maxEntries: number;
  /** Declared uncompressed size of one table file. */
  maxTableBytes: number;
  /** Declared uncompressed size of one binary payload. */
  maxBlobBytes: number;
  /** Sum of declared uncompressed sizes of every entry (zip-bomb guard). */
  maxTotalBytes: number;
  /** One NDJSON line. */
  maxRowBytes: number;
  /** Rows over all tables. */
  maxRows: number;
}

const MiB = 1024 * 1024;
export const DEFAULT_RESTORE_LIMITS: RestoreLimits = {
  maxArchiveBytes: 1024 * MiB,
  maxEntries: 50_000,
  maxTableBytes: 512 * MiB,
  maxBlobBytes: 256 * MiB,
  maxTotalBytes: 2048 * MiB,
  maxRowBytes: 8 * MiB,
  maxRows: 5_000_000,
};

// ---------------------------------------------------------------------------------------------
// Zip writing (streaming fflate, synchronous deflate: Workers from blob: URLs are blocked by the
// extension CSP)
// ---------------------------------------------------------------------------------------------

export class ZipSink {
  private readonly chunks: Uint8Array[] = [];
  private failure: unknown = null;
  private readonly zip = new Zip((err, chunk) => {
    if (err) this.failure = err;
    else this.chunks.push(chunk);
  });

  constructor(private readonly mtime: Date) {}

  private check(): void {
    if (this.failure) {
      throw new BackupError('corrupt_archive', 'Writing the archive failed.', {}, this.failure);
    }
  }

  add(name: string, data: Uint8Array, level: 0 | 6): void {
    const file = level === 0 ? new ZipPassThrough(name) : new ZipDeflate(name, { level });
    file.mtime = this.mtime;
    this.zip.add(file);
    file.push(data, true);
    this.check();
  }

  /** Same as add() but in slices, calling `between` after each (abort checks / yielding). */
  async addSliced(
    name: string,
    data: Uint8Array,
    level: 0 | 6,
    between: () => Promise<void>,
    sliceBytes = 256 * 1024,
  ): Promise<void> {
    const file = level === 0 ? new ZipPassThrough(name) : new ZipDeflate(name, { level });
    file.mtime = this.mtime;
    this.zip.add(file);
    for (let at = 0; at < data.length; at += sliceBytes) {
      file.push(data.subarray(at, at + sliceBytes), false);
      this.check();
      await between();
    }
    file.push(new Uint8Array(0), true);
    this.check();
  }

  finish(): Uint8Array {
    this.zip.end();
    this.check();
    return concatBytes(this.chunks);
  }
}

export function textBytes(text: string): Uint8Array {
  return strToU8(text);
}

// ---------------------------------------------------------------------------------------------
// Zip reading (central directory based, one entry decompressed at a time)
// ---------------------------------------------------------------------------------------------

export interface ZipInfo {
  size: number;
  originalSize: number;
  compression: number;
}

const ZIP_LOCAL = [0x50, 0x4b, 0x03, 0x04];
const ZIP_EMPTY = [0x50, 0x4b, 0x05, 0x06];

export function looksLikeZip(bytes: Uint8Array): boolean {
  const starts = (sig: number[]) => sig.every((b, i) => bytes[i] === b);
  return bytes.length >= 4 && (starts(ZIP_LOCAL) || starts(ZIP_EMPTY));
}

export function looksLikeJson(bytes: Uint8Array): boolean {
  for (let i = 0; i < Math.min(bytes.length, 16); i++) {
    const b = bytes[i];
    if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d) continue;
    if (b === 0xef && bytes[i + 1] === 0xbb && bytes[i + 2] === 0xbf) {
      i += 2;
      continue;
    }
    return b === 0x7b;
  }
  return false;
}

export function listZip(bytes: Uint8Array, maxEntries: number): Map<string, ZipInfo> {
  const entries = new Map<string, ZipInfo>();
  let dup: string | null = null;
  let overflow = false;
  try {
    unzipSync(bytes, {
      filter: (f) => {
        if (entries.has(f.name)) dup = f.name;
        else
          entries.set(f.name, {
            size: f.size,
            originalSize: f.originalSize,
            compression: f.compression,
          });
        if (entries.size > maxEntries) overflow = true;
        return false;
      },
    });
  } catch (cause) {
    throw new BackupError(
      'corrupt_archive',
      'The file is not a readable ZIP archive (it may be truncated or damaged).',
      {},
      cause,
    );
  }
  if (overflow) {
    throw new BackupError('limit_exceeded', 'The archive has too many entries.', { maxEntries });
  }
  if (dup !== null) {
    throw new BackupError('corrupt_archive', 'The archive lists the same entry twice.', {
      entry: dup,
    });
  }
  return entries;
}

/** Decompress exactly one entry. The declared size is checked BEFORE any allocation. */
export function readZipEntry(
  bytes: Uint8Array,
  entries: Map<string, ZipInfo>,
  name: string,
  maxBytes: number,
): Uint8Array {
  const info = entries.get(name);
  if (!info) {
    throw new BackupError('corrupt_archive', `The archive is missing "${name}".`, { entry: name });
  }
  if (info.compression !== 0 && info.compression !== 8) {
    throw new BackupError('corrupt_archive', `"${name}" uses an unsupported compression method.`, {
      entry: name,
    });
  }
  // DEFLATE cannot expand more than ~1032:1; a header claiming more is a zip bomb or damage.
  if (info.compression === 8 && info.originalSize > info.size * 1100 + 1024) {
    throw new BackupError('corrupt_archive', `"${name}" declares an impossible size.`, {
      entry: name,
    });
  }
  if (info.originalSize > maxBytes) {
    throw new BackupError('limit_exceeded', `"${name}" is larger than the allowed size.`, {
      entry: name,
      declaredBytes: info.originalSize,
      maxBytes,
    });
  }
  try {
    const out = unzipSync(bytes, { filter: (f) => f.name === name })[name];
    if (!out || out.length !== info.originalSize) throw new Error('size mismatch');
    return out;
  } catch (cause) {
    throw new BackupError(
      'corrupt_archive',
      `"${name}" could not be decompressed.`,
      { entry: name },
      cause,
    );
  }
}
