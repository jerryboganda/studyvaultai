import type { TableSpec } from '@shared';
import { extractBinaries, containsBinary } from './binary';
import { canonicalJson, concatBytes, omitFields, rowKey, yieldIfDue } from './canonical';
import {
  encryptContainer,
  DEFAULT_KDF_ITERATIONS,
  resolveCrypto,
  sha256Hex,
  type CryptoDeps,
  type Subtle,
} from './crypto';
import { BackupError, throwIfAborted } from './errors';
import {
  APP_NAME,
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  BACKUP_JSON_FORMAT,
  MANIFEST_FILE,
  ZipSink,
  blobFile,
  tableFile,
  textBytes,
  type Manifest,
  type ManifestTable,
} from './format';
import { readAll } from './source';
import type { BackupSource, ExportProgress, Row } from './types';

export interface ExportOptions {
  /** Written to the manifest (`createdBy.version`). */
  appVersion?: string;
  /**
   * Opt-in list of `localOnly` tables to include (e.g. ["attachments"] for cached PDF bytes).
   * Without it every localOnly table is left out: they never leave the device by default.
   */
  includeLocalOnlyTables?: readonly string[];
  /** Encrypts the whole archive (AES-256-GCM, PBKDF2-SHA-256 key). Lose it and the backup is gone. */
  passphrase?: string;
  /** PBKDF2 iterations; default 600 000. Lower values are for tests only. */
  kdfIterations?: number;
  /** Rows requested per readTable page. Default 500. */
  batchSize?: number;
  now?: () => Date;
  /** Inject `crypto.subtle`; defaults to globalThis.crypto.subtle. */
  subtle?: Subtle;
  /** Inject for deterministic output in tests. Defaults to crypto.getRandomValues. */
  randomBytes?: (n: number) => Uint8Array;
  signal?: AbortSignal;
  onProgress?: (p: ExportProgress) => void;
}

export interface ExportResult {
  /** A ZIP, or the passphrase container wrapping one. */
  bytes: Uint8Array;
  manifest: Manifest;
  encrypted: boolean;
  /** Safe file name for a download, e.g. studyvault-backup-20261011-083000.zip */
  suggestedFilename: string;
  stats: { rows: number; tables: number; blobs: number; blobBytes: number };
}

const FLUSH_CHARS = 256 * 1024;

export function selectTables(
  source: Pick<BackupSource, 'registry'>,
  includeLocalOnly: readonly string[] | undefined,
): TableSpec[] {
  const tables = source.registry.tables;
  const names = new Set<string>();
  for (const t of tables) {
    if (names.has(t.name)) {
      throw new BackupError('invalid_options', `Registry lists table "${t.name}" twice.`);
    }
    names.add(t.name);
  }
  for (const n of includeLocalOnly ?? []) {
    if (!names.has(n)) throw new BackupError('invalid_options', `Unknown table "${n}".`);
  }
  const opted = new Set(includeLocalOnly ?? []);
  return tables.filter((t) => !t.localOnly || opted.has(t.name));
}

interface EncodedTable {
  rowCount: number;
  sha256: string;
  /** NDJSON file bytes (zip variant). */
  file: Uint8Array;
  /** Canonical row strings (single-file JSON variant only). */
  lines: string[] | null;
}

interface EncodeCtx {
  source: BackupSource;
  subtle: Subtle;
  batchSize: number;
  signal: AbortSignal | undefined;
  /** Receives each distinct binary payload. null forbids binaries (single-file JSON). */
  onBytes: ((sha256: string, bytes: Uint8Array) => Promise<void>) | null;
  collectLines: boolean;
  onRows: (n: number) => void;
}

async function encodeTable(spec: TableSpec, ctx: EncodeCtx): Promise<EncodedTable> {
  const enc = new TextEncoder();
  const derived = spec.derivedFields && spec.derivedFields.length > 0 ? spec.derivedFields : null;
  const fileChunks: Uint8Array[] = [];
  const hashChunks: Uint8Array[] = [];
  const lines: string[] | null = ctx.collectLines ? [] : null;
  let filePart: string[] = [];
  let hashPart: string[] = [];
  let partChars = 0;
  let rowCount = 0;

  const flush = () => {
    if (filePart.length === 0) return;
    fileChunks.push(enc.encode(filePart.join('')));
    hashChunks.push(enc.encode(hashPart.join('')));
    filePart = [];
    hashPart = [];
    partChars = 0;
  };

  for await (const page of readAll(ctx.source, spec, ctx.batchSize)) {
    throwIfAborted(ctx.signal);
    for (const row of page) {
      rowKey(spec, row); // refuses rows without a usable primary key
      let prepared: unknown = row;
      if (containsBinary(row)) {
        if (!ctx.onBytes) {
          throw new BackupError(
            'invalid_options',
            `Table "${spec.name}" holds binary data; use the ZIP format, not single-file JSON.`,
          );
        }
        prepared = await extractBinaries(row, ctx.subtle, ctx.onBytes);
      }
      // The file keeps the row exactly as stored (member order included); only the checksum
      // stream is canonical, so provenance JSON round trips byte for byte.
      let text: string;
      let hashText: string;
      try {
        text = JSON.stringify(prepared);
        hashText = canonicalJson(omitFields(prepared as Row, derived ?? undefined));
      } catch (cause) {
        throw new BackupError(
          'source_error',
          `${spec.name}: a row cannot be serialised (${(cause as Error).message}).`,
          { table: spec.name },
          cause,
        );
      }
      filePart.push(text, '\n');
      hashPart.push(hashText, '\n');
      partChars += text.length + hashText.length + 2;
      lines?.push(text);
      rowCount++;
      if (partChars >= FLUSH_CHARS) flush();
    }
    ctx.onRows(page.length);
    await yieldIfDue();
  }
  flush();

  const file = concatBytes(fileChunks);
  const sha256 = await sha256Hex(ctx.subtle, concatBytes(hashChunks));
  return { rowCount, sha256, file, lines };
}

function manifestTable(spec: TableSpec, e: EncodedTable, withFile: boolean): ManifestTable {
  const t: ManifestTable = { name: spec.name, rowCount: e.rowCount, sha256: e.sha256 };
  if (withFile) t.file = tableFile(spec.name);
  if (spec.derivedFields && spec.derivedFields.length > 0)
    t.derivedFields = [...spec.derivedFields];
  return t;
}

async function sealManifest(subtle: Subtle, base: Omit<Manifest, 'checksum'>): Promise<Manifest> {
  return { ...base, checksum: await sha256Hex(subtle, textBytes(canonicalJson(base))) };
}

function stamp(d: Date): string {
  return d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, '')
    .replace('T', '-');
}

function checkOptions(o: ExportOptions): number {
  const batch = o.batchSize ?? 500;
  if (!Number.isInteger(batch) || batch < 1 || batch > 10_000) {
    throw new BackupError('invalid_options', 'batchSize must be an integer from 1 to 10000.');
  }
  if (o.passphrase !== undefined && o.passphrase.length === 0) {
    throw new BackupError('invalid_options', 'The passphrase must not be empty.');
  }
  return batch;
}

/**
 * Export the whole vault as a "studyvault-backup" v1 ZIP (manifest.json + one NDJSON file per table
 * + blobs/). Memory: one table's bytes at a time plus the compressed archive. The result is a
 * Uint8Array because the passphrase container (AES-GCM) is one-shot.
 *
 * Rows are read in primary-key pages through `source.readTable`; the manifest counts what was
 * actually written, so the archive is self-consistent even if the vault changes while it runs.
 */
export async function exportBackup(
  source: BackupSource,
  options: ExportOptions = {},
): Promise<ExportResult> {
  const batchSize = checkOptions(options);
  const deps: CryptoDeps = resolveCrypto(options);
  const { signal } = options;
  throwIfAborted(signal);
  const tables = selectTables(source, options.includeLocalOnlyTables);
  const createdAt = (options.now ?? (() => new Date()))();

  let counts: Readonly<Record<string, number>> = {};
  try {
    counts = await source.counts();
  } catch {
    // progress totals only
  }
  const rowsTotal = tables.reduce((n, t) => n + (counts[t.name] ?? 0), 0);
  let rowsDone = 0;
  const progress = (phase: ExportProgress['phase'], table: string | null, tablesDone: number) =>
    options.onProgress?.({
      phase,
      table,
      tablesDone,
      tablesTotal: tables.length,
      rowsDone,
      rowsTotal: Math.max(rowsTotal, rowsDone),
    });

  const sink = new ZipSink(createdAt);
  const between = async () => {
    throwIfAborted(signal);
    await yieldIfDue();
  };
  const seenBlobs = new Set<string>();
  const stats = { rows: 0, tables: tables.length, blobs: 0, blobBytes: 0 };
  const onBytes = async (sha256: string, bytes: Uint8Array) => {
    if (seenBlobs.has(sha256)) return;
    seenBlobs.add(sha256);
    stats.blobs++;
    stats.blobBytes += bytes.length;
    sink.add(blobFile(sha256), bytes, 0);
    await between();
  };

  const entries: ManifestTable[] = [];
  let tablesDone = 0;
  for (const spec of tables) {
    progress('reading', spec.name, tablesDone);
    const encoded = await encodeTable(spec, {
      source,
      subtle: deps.subtle,
      batchSize,
      signal,
      onBytes,
      collectLines: false,
      onRows: (n) => {
        rowsDone += n;
        progress('reading', spec.name, tablesDone);
      },
    });
    progress('compressing', spec.name, tablesDone);
    await sink.addSliced(tableFile(spec.name), encoded.file, 6, between);
    entries.push(manifestTable(spec, encoded, true));
    stats.rows += encoded.rowCount;
    tablesDone++;
  }

  const base: Omit<Manifest, 'checksum'> = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    appSchemaVersion: source.registry.schemaVersion,
    createdAt: createdAt.toISOString(),
    createdBy: { app: APP_NAME, version: options.appVersion ?? 'unknown' },
    tables: entries,
    options: {
      includesAttachments: tables.some((t) => t.localOnly === true),
      encrypted: options.passphrase !== undefined,
    },
  };
  const manifest = await sealManifest(deps.subtle, base);
  sink.add(MANIFEST_FILE, textBytes(JSON.stringify(manifest, null, 2)), 6);
  throwIfAborted(signal);

  let bytes = sink.finish();
  const encrypted = options.passphrase !== undefined;
  if (encrypted) {
    progress('encrypting', null, tablesDone);
    bytes = await encryptContainer(
      deps,
      bytes,
      options.passphrase as string,
      options.kdfIterations ?? DEFAULT_KDF_ITERATIONS,
    );
  }
  progress('done', null, tablesDone);
  return {
    bytes,
    manifest,
    encrypted,
    suggestedFilename: `studyvault-backup-${stamp(createdAt)}.${encrypted ? 'svbackup' : 'zip'}`,
    stats,
  };
}

export interface ExportJsonOptions extends ExportOptions {
  /** Refuse above this many rows; use the ZIP export for big vaults. Default 25 000. */
  maxRows?: number;
}

/**
 * Single-file JSON export for small vaults: the manifest fields plus `data: { table: rows[] }`.
 * Same checksums and the same restore pipeline as the ZIP. Binary (localOnly) tables cannot be
 * represented and are refused.
 */
export async function exportJson(
  source: BackupSource,
  options: ExportJsonOptions = {},
): Promise<ExportResult> {
  const batchSize = checkOptions(options);
  const deps = resolveCrypto(options);
  const { signal } = options;
  const maxRows = options.maxRows ?? 25_000;
  throwIfAborted(signal);
  const tables = selectTables(source, options.includeLocalOnlyTables);
  const createdAt = (options.now ?? (() => new Date()))();

  let rowsDone = 0;
  const entries: ManifestTable[] = [];
  const data: string[] = [];
  let tablesDone = 0;
  for (const spec of tables) {
    const encoded = await encodeTable(spec, {
      source,
      subtle: deps.subtle,
      batchSize,
      signal,
      onBytes: null,
      collectLines: true,
      onRows: (n) => {
        rowsDone += n;
        if (rowsDone > maxRows) {
          throw new BackupError(
            'limit_exceeded',
            `Too many rows for the single-file JSON export (limit ${maxRows}). Use the ZIP backup.`,
            { maxRows },
          );
        }
        options.onProgress?.({
          phase: 'reading',
          table: spec.name,
          tablesDone,
          tablesTotal: tables.length,
          rowsDone,
          rowsTotal: rowsDone,
        });
      },
    });
    entries.push(manifestTable(spec, encoded, false));
    data.push(`${JSON.stringify(spec.name)}:[${(encoded.lines ?? []).join(',')}]`);
    tablesDone++;
  }
  const base: Omit<Manifest, 'checksum'> = {
    format: BACKUP_JSON_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    appSchemaVersion: source.registry.schemaVersion,
    createdAt: createdAt.toISOString(),
    createdBy: { app: APP_NAME, version: options.appVersion ?? 'unknown' },
    tables: entries,
    options: {
      includesAttachments: tables.some((t) => t.localOnly === true),
      encrypted: options.passphrase !== undefined,
    },
  };
  const manifest = await sealManifest(deps.subtle, base);
  const head = canonicalJson(manifest);
  // manifest JSON with the data member appended, built from parts (no giant intermediate object)
  const text = `${head.slice(0, -1)},"data":{${data.join(',')}}}`;
  let bytes: Uint8Array = textBytes(text);
  const encrypted = options.passphrase !== undefined;
  if (encrypted) {
    bytes = await encryptContainer(
      deps,
      bytes,
      options.passphrase as string,
      options.kdfIterations ?? DEFAULT_KDF_ITERATIONS,
    );
  }
  return {
    bytes,
    manifest,
    encrypted,
    suggestedFilename: `studyvault-backup-${stamp(createdAt)}.${encrypted ? 'svbackup' : 'json'}`,
    stats: { rows: rowsDone, tables: tables.length, blobs: 0, blobBytes: 0 },
  };
}
