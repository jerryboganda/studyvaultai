import type { TableSpec } from '@shared';
import { collectMarkers, containsMarker, rehydrateBinaries, type BinaryMarker } from './binary';
import { canonicalJson, concatBytes, keyString, omitFields, rowKey, yieldIfDue } from './canonical';
import {
  decryptContainer,
  isEncryptedContainer,
  resolveCrypto,
  sha256Hex,
  type Subtle,
} from './crypto';
import { exportBackup, type ExportOptions, type ExportResult } from './export';
import { BackupError, isBackupError, throwIfAborted } from './errors';
import {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  BACKUP_JSON_FORMAT,
  DEFAULT_RESTORE_LIMITS,
  MANIFEST_FILE,
  Manifest,
  blobFile,
  listZip,
  looksLikeJson,
  looksLikeZip,
  readZipEntry,
  tableFile,
  textBytes,
  type ManifestTable,
  type RestoreLimits,
  type ZipInfo,
} from './format';
import { decide, metaOf, type MergeDecision, type RowMeta } from './merge';
import { buildMigrationChain, migrateRow } from './migrate';
import { readAll } from './source';
import type {
  CitationGuard,
  CommitPlan,
  ImmutableFields,
  MigrationStep,
  Passage,
  RestoreProgress,
  RestoreTarget,
  Row,
  RowKey,
  StagingDb,
} from './types';

// ---------------------------------------------------------------------------------------------
// Options and report
// ---------------------------------------------------------------------------------------------

// Which fields a merge may not change comes from the target (`RestoreTarget.immutableFields`): the
// storage layer derives it from the sync policy, so there is one list of provenance fields.

export interface RestoreOptions {
  target: RestoreTarget;
  /** 'merge' (default) never deletes local rows; 'replace' makes the vault equal to the archive. */
  mode?: 'merge' | 'replace';
  passphrase?: string;
  /** Pure per-version row upgrades, oldest first. Required when the archive is older. */
  migrations?: readonly MigrationStep[];
  /** What to do with rows that fail their schema. Default 'abort' (typed error `row_invalid`). */
  invalidRows?: 'abort' | 'skip';
  /** What to do with broken references. Default 'abort' (typed error `integrity_violation`). */
  orphans?: 'abort' | 'skip';
  limits?: Partial<RestoreLimits>;
  /** Rows per staging write. Default 500. */
  batchSize?: number;
  subtle?: Subtle;
  randomBytes?: (n: number) => Uint8Array;
  signal?: AbortSignal;
  onProgress?: (p: RestoreProgress) => void;
  /**
   * When set, a backup of the live data is produced right before the commit and handed to `sink`.
   * If the sink throws, the restore is abandoned and nothing is changed.
   */
  preRestoreBackup?: {
    sink: (backup: ExportResult) => Promise<void>;
    options?: Pick<
      ExportOptions,
      'passphrase' | 'kdfIterations' | 'appVersion' | 'includeLocalOnlyTables'
    >;
  };
}

export interface InvalidRowInfo {
  table: string;
  /** 1-based line in the table file (index + 1 in single-file JSON). */
  line: number;
  reason:
    | 'not_an_object'
    | 'forbidden_key'
    | 'migration_failed'
    | 'schema'
    | 'duplicate_key'
    | 'missing_key'
    | 'binary_unavailable';
  message: string;
}

export interface OrphanInfo {
  table: string;
  key: string;
  field: string;
  refTable: string;
  /** null when the field was empty but is not nullable. */
  refKey: string | null;
  cascaded: boolean;
}

interface RowCompare {
  table: string;
  key: string;
  liveUpdatedAt: string | null;
  archiveUpdatedAt: string | null;
  liveDeleted: boolean;
  archiveDeleted: boolean;
}

export interface ConflictInfo extends RowCompare {
  reason: Extract<MergeDecision, { kind: 'conflict' }>['reason'];
}

export interface OverwriteInfo extends RowCompare {
  /** Which side is newer; in merge mode only 'archive_*' rows are actually overwritten. */
  direction: 'archive_newer' | 'archive_tombstone_tie' | 'live_newer' | 'conflict';
}

export interface TableReport {
  archiveRows: number;
  valid: number;
  invalid: number;
  droppedByMigration: number;
  /** Valid rows left out because a row they reference was invalid or missing (orphans: 'skip'). */
  excluded: number;
  add: number;
  update: number;
  skipIdentical: number;
  skipLiveNewer: number;
  conflict: number;
  /** Live rows the archive does not contain: kept by merge, removed by replace. */
  liveOnly: number;
  liveRows: number;
}

export interface Capped<T> {
  total: number;
  items: T[];
}

export interface RestoreReport {
  mode: 'merge' | 'replace';
  archive: {
    formatVersion: number;
    appSchemaVersion: number;
    createdAt: string;
    createdBy: { app: string; version: string };
    encrypted: boolean;
    includesAttachments: boolean;
    tables: { name: string; rowCount: number }[];
  };
  currentSchemaVersion: number;
  migratedFromVersion: number | null;
  tables: Record<string, TableReport>;
  totals: TableReport;
  /** Archive tables the app does not know; ignored. */
  skippedTables: string[];
  invalidRows: Capped<InvalidRowInfo>;
  orphans: Capped<OrphanInfo>;
  conflicts: Capped<ConflictInfo>;
  /** Rows whose live copy the commit would change or replace, with newer-vs-older direction. */
  overwritten: Capped<OverwriteInfo>;
  replaceImpact: {
    /** Registry tables replace mode will empty first (including ones the archive has no data for). */
    tablesCleared: string[];
    /** Of those, tables the archive does not contain at all. */
    clearedWithoutArchiveData: string[];
    /** Live rows that are NEWER than the archive's copy and would be overwritten by older data. */
    overwrittenNewerLiveRows: number;
    removedLiveOnlyRows: number;
  };
  warnings: string[];
}

export interface RestoreResult {
  mode: 'merge' | 'replace';
  /** Rows written to the live tables per table (merge: add + update; replace: all staged rows). */
  written: Record<string, number>;
  report: RestoreReport;
}

export interface PreparedRestore {
  readonly report: RestoreReport;
  /** Stage and apply atomically. One shot. Nothing live changes unless this resolves. */
  commit(): Promise<RestoreResult>;
  /** Release the decrypted archive. Safe to call any time; commit() afterwards is refused. */
  discard(): void;
}

const REPORT_CAP = 100;

// ---------------------------------------------------------------------------------------------
// Opening an archive
// ---------------------------------------------------------------------------------------------

interface RawRow {
  value: unknown;
  line: number;
}

interface ArchiveReader {
  manifest: Manifest;
  rows(entry: ManifestTable): Generator<RawRow>;
  blob(marker: BinaryMarker, verify: boolean): Promise<Uint8Array>;
}

function parseJsonStrict(
  bytes: Uint8Array,
  what: string,
  code: 'manifest_invalid' | 'corrupt_archive',
): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new BackupError(code, `${what} is not valid JSON.`, {}, cause);
  }
}

async function validateManifest(
  raw: unknown,
  expectedFormat: string,
  subtle: Subtle,
): Promise<Manifest> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new BackupError('not_a_backup', 'This file is not a StudyVault backup.');
  }
  const obj = raw as Record<string, unknown>;
  // Rows of a single-file JSON are checked one by one (and can be skipped); the head must be clean.
  const { data: _rows, ...head } = obj;
  if (hasForbiddenKey(head)) {
    throw new BackupError(
      'manifest_invalid',
      'The backup manifest contains a field name that is not allowed.',
    );
  }
  if (obj.format !== expectedFormat) {
    throw new BackupError('not_a_backup', 'This file is not a StudyVault backup.', {
      format: typeof obj.format === 'string' ? obj.format.slice(0, 64) : null,
    });
  }
  if (typeof obj.formatVersion === 'number' && obj.formatVersion > BACKUP_FORMAT_VERSION) {
    throw new BackupError(
      'future_format_version',
      `This backup uses format version ${obj.formatVersion}; this version of StudyVault reads up to ${BACKUP_FORMAT_VERSION}.`,
      { formatVersion: obj.formatVersion, supported: BACKUP_FORMAT_VERSION },
    );
  }
  const parsed = Manifest.safeParse(raw);
  if (!parsed.success) {
    throw new BackupError('manifest_invalid', 'The backup manifest is malformed.', {
      issues: parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.map(String).join('.')}: ${i.message}`),
    });
  }
  const { checksum, data: _data, ...rest } = obj;
  const expected = await sha256Hex(subtle, textBytes(canonicalJson(rest)));
  if (expected !== checksum) {
    throw new BackupError(
      'manifest_checksum_mismatch',
      'The backup manifest has been modified or damaged.',
    );
  }
  const names = new Set<string>();
  for (const t of parsed.data.tables) {
    if (names.has(t.name)) {
      throw new BackupError('manifest_invalid', `The manifest lists table "${t.name}" twice.`);
    }
    names.add(t.name);
  }
  return parsed.data;
}

function* ndjsonRows(bytes: Uint8Array, table: string, maxRowBytes: number): Generator<RawRow> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pos = 0;
  let line = 0;
  while (pos < bytes.length) {
    let end = bytes.indexOf(0x0a, pos);
    const isLast = end === -1;
    if (isLast) end = bytes.length;
    line++;
    if (end - pos > maxRowBytes) {
      throw new BackupError('limit_exceeded', `${table}: a row is larger than the allowed size.`, {
        table,
        line,
      });
    }
    if (end > pos) {
      let text: string;
      try {
        text = decoder.decode(bytes.subarray(pos, end));
      } catch (cause) {
        throw new BackupError(
          'table_corrupt',
          `${table}: line ${line} is not valid UTF-8.`,
          { table, line },
          cause,
        );
      }
      if (text.trim() !== '') {
        let value: unknown;
        try {
          value = JSON.parse(text);
        } catch (cause) {
          throw new BackupError(
            isLast ? 'table_truncated' : 'table_corrupt',
            isLast
              ? `${table}: the table file ends in the middle of a row (truncated).`
              : `${table}: line ${line} is not valid JSON.`,
            { table, line },
            cause,
          );
        }
        yield { value, line };
      }
    }
    pos = end + 1;
  }
}

/** The archive bytes, nulled by discard()/commit so they can be garbage collected. */
interface Holder {
  bytes: Uint8Array | null;
}

async function openArchive(
  holder: Holder,
  limits: RestoreLimits,
  subtle: Subtle,
): Promise<ArchiveReader> {
  const bytes = holder.bytes as Uint8Array;
  const live = (): Uint8Array => {
    if (!holder.bytes) {
      throw new BackupError('invalid_options', 'This restore was already committed or discarded.');
    }
    return holder.bytes;
  };
  if (looksLikeZip(bytes)) {
    // Entry count and declared sizes are capped inside listZip, before anything is decompressed.
    const entries: Map<string, ZipInfo> = listZip(bytes, limits);
    if (!entries.has(MANIFEST_FILE)) {
      throw new BackupError(
        'not_a_backup',
        'This ZIP file is not a StudyVault backup (no manifest).',
      );
    }
    const raw = parseJsonStrict(
      readZipEntry(bytes, entries, MANIFEST_FILE, 4 * 1024 * 1024),
      'manifest.json',
      'manifest_invalid',
    );
    const manifest = await validateManifest(raw, BACKUP_FORMAT, subtle);
    for (const t of manifest.tables) {
      if (t.file !== tableFile(t.name)) {
        throw new BackupError(
          'manifest_invalid',
          `Table "${t.name}" has an unexpected file entry.`,
        );
      }
      if (!entries.has(t.file)) {
        throw new BackupError(
          'corrupt_archive',
          `The archive is missing the file for table "${t.name}".`,
          {
            table: t.name,
          },
        );
      }
    }
    return {
      manifest,
      *rows(entry) {
        const data = readZipEntry(live(), entries, tableFile(entry.name), limits.maxTableBytes);
        yield* ndjsonRows(data, entry.name, limits.maxRowBytes);
      },
      async blob(marker, verify) {
        const name = blobFile(marker.sha256);
        const data = readZipEntry(live(), entries, name, limits.maxBlobBytes);
        if (data.length !== marker.size) {
          throw new BackupError('blob_corrupt', 'An attached file has the wrong size.', {
            entry: name,
          });
        }
        if (verify && (await sha256Hex(subtle, data)) !== marker.sha256) {
          throw new BackupError('blob_corrupt', 'An attached file fails its checksum.', {
            entry: name,
          });
        }
        return data;
      },
    };
  }
  if (looksLikeJson(bytes)) {
    // Single-file JSON is for small vaults: it is parsed in one piece, so it gets the table limit.
    if (bytes.length > limits.maxTableBytes) {
      throw new BackupError('limit_exceeded', 'The JSON backup is larger than the allowed size.', {
        bytes: bytes.length,
        maxBytes: limits.maxTableBytes,
      });
    }
    const raw = parseJsonStrict(bytes, 'The backup file', 'corrupt_archive') as Record<
      string,
      unknown
    >;
    const manifest = await validateManifest(raw, BACKUP_JSON_FORMAT, subtle);
    const data = raw.data;
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      throw new BackupError('manifest_invalid', 'The backup has no data section.');
    }
    return {
      manifest,
      *rows(entry) {
        const rows = (data as Record<string, unknown>)[entry.name];
        if (!Array.isArray(rows)) {
          throw new BackupError('corrupt_archive', `The backup has no rows for "${entry.name}".`, {
            table: entry.name,
          });
        }
        for (let i = 0; i < rows.length; i++) yield { value: rows[i], line: i + 1 };
      },
      blob() {
        return Promise.reject(
          new BackupError('blob_corrupt', 'Single-file JSON backups carry no attachments.'),
        );
      },
    };
  }
  throw new BackupError('not_a_backup', 'This file is not a StudyVault backup.');
}

/** What a file holds, without a registry. Encrypted files report `manifest: null` until unlocked. */
export async function inspectBackup(
  input: Uint8Array,
  options: {
    passphrase?: string;
    subtle?: Subtle;
    randomBytes?: (n: number) => Uint8Array;
    limits?: Partial<RestoreLimits>;
  } = {},
): Promise<{ encrypted: boolean; manifest: Manifest | null }> {
  const deps = resolveCrypto(options);
  const limits = { ...DEFAULT_RESTORE_LIMITS, ...options.limits };
  if (input.length > limits.maxArchiveBytes) {
    throw new BackupError('limit_exceeded', 'The file is larger than the allowed size.');
  }
  let bytes = input;
  const encrypted = isEncryptedContainer(input);
  if (encrypted) {
    if (options.passphrase === undefined) return { encrypted, manifest: null };
    bytes = await decryptContainer(deps, input, options.passphrase);
  }
  return { encrypted, manifest: (await openArchive({ bytes }, limits, deps.subtle)).manifest };
}

// ---------------------------------------------------------------------------------------------
// Scan (pass 1): verify, migrate, validate, collect metadata. Nothing is written anywhere.
// ---------------------------------------------------------------------------------------------

interface Ref {
  row: string;
  field: string;
  table: string;
  /** keyString of the referenced key, or null when the field is empty/unusable. */
  target: string | null;
  nullable: boolean;
}

interface TableScan {
  spec: TableSpec;
  entry: ManifestTable;
  archiveRows: number;
  meta: Map<string, RowMeta>;
  /**
   * Line of the one row that passed every check, per key. Staging takes exactly that line: a
   * forged archive may repeat a key, with an invalid row before the valid one.
   */
  lines: Map<string, number>;
  refs: Ref[];
  invalidCount: number;
  droppedByMigration: number;
}

class CappedList<T> {
  items: T[] = [];
  total = 0;
  add(item: T): void {
    this.total++;
    if (this.items.length < REPORT_CAP) this.items.push(item);
  }
  view(): Capped<T> {
    return { total: this.total, items: this.items };
  }
}

/**
 * Member names a parsed JSON graph must not have, whatever escapes the text used to spell them
 * (JSON.parse creates `__proto__` as an ordinary own property, which a later assignment or merge
 * turns into a prototype change). Run on the PARSED value, for every row of every file.
 *  - `__proto__` anywhere;
 *  - `constructor` or `prototype` holding an object: the `constructor.prototype` path that
 *    deep-merge gadgets walk. A plain string/number under those names is ordinary data (a custom
 *    field called "constructor") and is accepted, so a user's own backup always restores.
 * Nesting deeper than the 64 levels the exporter can write is refused (fail closed).
 */
function hasForbiddenKey(v: unknown, depth = 0): boolean {
  if (typeof v !== 'object' || v === null) return false;
  if (depth > 64) return true;
  if (Array.isArray(v)) return v.some((x) => hasForbiddenKey(x, depth + 1));
  for (const k of Object.keys(v)) {
    const x = (v as Row)[k];
    if (k === '__proto__') return true;
    if ((k === 'constructor' || k === 'prototype') && typeof x === 'object' && x !== null) {
      return true;
    }
    if (hasForbiddenKey(x, depth + 1)) return true;
  }
  return false;
}

function issueText(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  return issues
    .slice(0, 3)
    .map((i) => `${i.path.map(String).join('.') || '(row)'}: ${i.message}`)
    .join('; ')
    .slice(0, 300);
}

/** The target's citation guard with what it needs: ids cited by archive rows, and their text. */
interface GuardState {
  guard: CitationGuard;
  cited: Set<string>;
  passages: Map<string, Passage>;
}

interface Context {
  options: RestoreOptions;
  target: RestoreTarget;
  limits: RestoreLimits;
  subtle: Subtle;
  reader: ArchiveReader;
  chain: MigrationStep[];
  specs: Map<string, TableSpec>;
  immutable: ImmutableFields;
  /** Null when the target has no guard or the archive has nothing to guard. */
  guard: GuardState | null;
  batchSize: number;
  signal: AbortSignal | undefined;
  progress: (p: Partial<RestoreProgress> & Pick<RestoreProgress, 'phase'>) => void;
}

interface ScanState {
  scans: Map<string, TableScan>;
  invalid: CappedList<InvalidRowInfo>;
  verifiedBlobs: Set<string>;
  rowsSeen: number;
  /** Rows the citation guard demoted. */
  regraded: number;
}

const own = (o: Readonly<Record<string, string>>, k: string): string | undefined =>
  Object.hasOwn(o, k) ? o[k] : undefined;

/** A row as the vault will hold it: after the guard has re-checked what it cites. */
function guarded(ctx: Context, table: string, row: Row): Row {
  const g = ctx.guard;
  return g && g.guard.table === table ? g.guard.regrade(row, g.passages) : row;
}

async function scanTable(
  ctx: Context,
  state: ScanState,
  spec: TableSpec,
  entry: ManifestTable,
): Promise<TableScan> {
  const enc = new TextEncoder();
  const derived = spec.derivedFields;
  // The checksum is the exporter's statement about its own file, so it is checked with the fields
  // the MANIFEST says were left out of it, not with this build's list: a later build may derive a
  // different set of fields, and that must not turn an untouched older backup into "damaged".
  const leftOutOfChecksum = entry.derivedFields;
  const immutable = ctx.immutable[spec.name];
  const hashChunks: Uint8Array[] = [];
  let hashPart: string[] = [];
  let hashChars = 0;
  const scan: TableScan = {
    spec,
    entry,
    archiveRows: 0,
    meta: new Map(),
    lines: new Map(),
    refs: [],
    invalidCount: 0,
    droppedByMigration: 0,
  };
  const invalid = (line: number, reason: InvalidRowInfo['reason'], message: string) => {
    scan.invalidCount++;
    state.invalid.add({ table: spec.name, line, reason, message });
  };

  for (const raw of ctx.reader.rows(entry)) {
    scan.archiveRows++;
    if (++state.rowsSeen > ctx.limits.maxRows) {
      throw new BackupError('limit_exceeded', 'The archive has too many rows.', {
        maxRows: ctx.limits.maxRows,
      });
    }
    if (scan.archiveRows % 250 === 0) {
      throwIfAborted(ctx.signal);
      await yieldIfDue();
      ctx.progress({ phase: 'verifying', table: spec.name, rowsDone: state.rowsSeen });
    }
    const value = raw.value;
    const isObject = typeof value === 'object' && value !== null && !Array.isArray(value);
    // Checksum input: exactly what export hashed (markers in place, derived fields removed). Every
    // line counts, well-formed or not, so the checksum is a statement about the file.
    let text: string;
    try {
      text = canonicalJson(isObject ? omitFields(value as Row, leftOutOfChecksum) : value);
    } catch (cause) {
      // Never produced by the exporter (too deep, or a type JSON cannot hold): not verifiable.
      throw new BackupError(
        'table_corrupt',
        `${spec.name}: line ${raw.line} has a structure that cannot be verified (${(cause as Error).message}).`,
        { table: spec.name, line: raw.line },
        cause,
      );
    }
    hashPart.push(text, '\n');
    hashChars += text.length + 1;
    if (hashChars >= 256 * 1024) {
      hashChunks.push(enc.encode(hashPart.join('')));
      hashPart = [];
      hashChars = 0;
    }
    if (!isObject) {
      invalid(raw.line, 'not_an_object', 'The row is not a JSON object.');
      continue;
    }
    if (hasForbiddenKey(value)) {
      invalid(raw.line, 'forbidden_key', 'The row contains a member name that is not allowed.');
      continue;
    }

    let row: Row | null;
    try {
      row = migrateRow(spec.name, value as Row, ctx.chain);
    } catch (cause) {
      invalid(
        raw.line,
        'migration_failed',
        `Migration failed: ${(cause as Error).message}`.slice(0, 300),
      );
      continue;
    }
    if (row === null) {
      scan.droppedByMigration++;
      continue;
    }

    // Attachments: the bytes must exist and match their digest before the row counts as valid.
    let forSchema: Row = row;
    if (containsMarker(row)) {
      let missing: string | null = null;
      for (const m of collectMarkers(row)) {
        if (state.verifiedBlobs.has(m.sha256)) continue;
        try {
          await ctx.reader.blob(m, true);
          state.verifiedBlobs.add(m.sha256);
        } catch (cause) {
          if (isBackupError(cause) && cause.code === 'blob_corrupt') throw cause;
          missing = isBackupError(cause) ? cause.message : 'attachment unavailable';
          break;
        }
      }
      if (missing !== null) {
        invalid(raw.line, 'binary_unavailable', missing);
        continue;
      }
      forSchema = (await rehydrateBinaries(row, () => Promise.resolve(new Uint8Array(0)))) as Row;
    }

    // A schema's own refinements may throw on hostile input; that is an invalid row, not a crash.
    let schemaProblem: string | null = null;
    try {
      const parsed = spec.schema.safeParse(forSchema);
      if (!parsed.success) schemaProblem = issueText(parsed.error.issues);
    } catch (cause) {
      schemaProblem = `validation threw: ${(cause as Error).message}`.slice(0, 300);
    }
    if (schemaProblem !== null) {
      invalid(raw.line, 'schema', schemaProblem);
      continue;
    }
    let key: string;
    try {
      key = keyString(rowKey(spec, row));
    } catch {
      invalid(raw.line, 'missing_key', 'The row has no usable primary key.');
      continue;
    }
    if (scan.meta.has(key)) {
      invalid(raw.line, 'duplicate_key', 'Another row in this table has the same key.');
      continue;
    }
    // Passages that AI results cite (only the ones some archive row names are kept in memory).
    const passageField = ctx.guard ? own(ctx.guard.guard.passages, spec.name) : undefined;
    if (ctx.guard && passageField !== undefined) {
      const id = row.id;
      const text = row[passageField];
      if (
        typeof id === 'string' &&
        typeof text === 'string' &&
        ctx.guard.cited.has(id) &&
        !ctx.guard.passages.has(id)
      ) {
        ctx.guard.passages.set(id, { table: spec.name, text });
      }
    }
    let kept: Row;
    try {
      kept = guarded(ctx, spec.name, row);
    } catch (cause) {
      invalid(raw.line, 'schema', `re-check failed: ${(cause as Error).message}`.slice(0, 300));
      continue;
    }
    if (kept !== row) state.regraded++;
    row = kept;
    scan.meta.set(key, metaOf(row, derived, immutable));
    scan.lines.set(key, raw.line);
    for (const ref of spec.references ?? []) {
      const v = row[ref.field];
      if (v === null || v === undefined) {
        if (!ref.nullable) {
          scan.refs.push({
            row: key,
            field: ref.field,
            table: ref.table,
            target: null,
            nullable: false,
          });
        }
      } else if (typeof v === 'string' || typeof v === 'number') {
        scan.refs.push({
          row: key,
          field: ref.field,
          table: ref.table,
          target: keyString(v),
          nullable: ref.nullable === true,
        });
      } else {
        scan.refs.push({
          row: key,
          field: ref.field,
          table: ref.table,
          target: null,
          nullable: false,
        });
      }
    }
  }
  if (hashPart.length > 0) hashChunks.push(enc.encode(hashPart.join('')));

  if (scan.archiveRows < entry.rowCount) {
    throw new BackupError(
      'table_truncated',
      `${spec.name}: the table has ${scan.archiveRows} rows but the manifest lists ${entry.rowCount}.`,
      { table: spec.name, found: scan.archiveRows, expected: entry.rowCount },
    );
  }
  if (scan.archiveRows > entry.rowCount) {
    throw new BackupError(
      'row_count_mismatch',
      `${spec.name}: the table has ${scan.archiveRows} rows but the manifest lists ${entry.rowCount}.`,
      { table: spec.name, found: scan.archiveRows, expected: entry.rowCount },
    );
  }
  const actual = await sha256Hex(ctx.subtle, concatBytes(hashChunks));
  if (actual !== entry.sha256) {
    throw new BackupError(
      'table_checksum_mismatch',
      `${spec.name}: the table's checksum does not match the manifest (the backup was modified or damaged).`,
      { table: spec.name },
    );
  }
  return scan;
}

const MAX_CITED_IDS = 200_000;

/**
 * Pass 0 for a table whose rows cite other rows' text: the ids those rows cite, and (merge) the
 * text the live vault already holds for them. Passages that only the archive has are collected by
 * the scan of their own tables, which runs before the guarded table.
 */
async function openGuard(
  ctx: Context,
  guard: CitationGuard,
  entry: ManifestTable,
  mode: 'merge' | 'replace',
): Promise<GuardState> {
  const cited = new Set<string>();
  for (const raw of ctx.reader.rows(entry)) {
    const v = raw.value;
    if (typeof v !== 'object' || v === null || Array.isArray(v) || hasForbiddenKey(v)) continue;
    try {
      for (const id of guard.cited(v as Row)) {
        if (typeof id === 'string' && cited.size < MAX_CITED_IDS) cited.add(id);
      }
    } catch {
      // not a row the guard understands: the scan reports it
    }
  }
  const state: GuardState = { guard, cited, passages: new Map() };
  if (mode === 'merge' && cited.size > 0) {
    for (const [table, field] of Object.entries(guard.passages)) {
      const spec = ctx.specs.get(table);
      if (!spec) continue;
      for await (const page of readAll(ctx.target, spec, ctx.batchSize)) {
        for (const row of page) {
          const id = row.id;
          const text = row[field];
          if (typeof id === 'string' && typeof text === 'string' && cited.has(id)) {
            if (!state.passages.has(id)) state.passages.set(id, { table, text });
          }
        }
        throwIfAborted(ctx.signal);
        await yieldIfDue();
      }
    }
  }
  return state;
}

// ---------------------------------------------------------------------------------------------
// Evaluate: compare with live data, apply the orphan policy, decide what gets written.
// ---------------------------------------------------------------------------------------------

interface Evaluation {
  report: RestoreReport;
  /** Per table: keyStrings of rows to stage and write. */
  stage: Map<string, Set<string>>;
  commitPlan: CommitPlan;
  tablesRestored: string[];
}

async function scanLive(
  ctx: Context,
  spec: TableSpec,
  keysOnly: boolean,
): Promise<Map<string, RowMeta | null>> {
  const out = new Map<string, RowMeta | null>();
  const immutable = ctx.immutable[spec.name];
  let n = 0;
  for await (const page of readAll(ctx.target, spec, ctx.batchSize)) {
    for (const row of page) {
      const key = keyString(rowKey(spec, row));
      out.set(key, keysOnly ? null : metaOf(row, spec.derivedFields, immutable));
    }
    n += page.length;
    throwIfAborted(ctx.signal);
    ctx.progress({ phase: 'verifying', table: spec.name, rowsDone: n });
    await yieldIfDue();
  }
  return out;
}

async function evaluate(
  ctx: Context,
  state: ScanState,
  mode: 'merge' | 'replace',
  manifest: Manifest,
  skippedTables: string[],
  migratedFrom: number | null,
): Promise<Evaluation> {
  const { options } = ctx;
  const registry = ctx.target.registry;
  const policy = options.orphans ?? 'abort';

  // Live metadata of every archive table (dry-run numbers and merge decisions).
  const live = new Map<string, Map<string, RowMeta | null>>();
  for (const scan of state.scans.values()) {
    live.set(scan.spec.name, await scanLive(ctx, scan.spec, false));
  }
  // Live keys of every table something points at (merge only: replace discards live rows).
  const liveKeys = new Map<string, ReadonlySet<string>>();
  if (mode === 'merge') {
    for (const scan of state.scans.values()) {
      for (const ref of scan.spec.references ?? []) {
        if (liveKeys.has(ref.table)) continue;
        const known = live.get(ref.table);
        const spec = ctx.specs.get(ref.table);
        const map = known ?? (spec ? await scanLive(ctx, spec, true) : new Map());
        liveKeys.set(ref.table, new Set(map.keys()));
      }
    }
  }

  // Orphans, with a cascade when the policy is to skip them.
  const excluded = new Map<string, Set<string>>();
  const isExcluded = (table: string, key: string) => excluded.get(table)?.has(key) === true;
  const exclude = (table: string, key: string) => {
    let set = excluded.get(table);
    if (!set) excluded.set(table, (set = new Set()));
    set.add(key);
  };
  const exists = (table: string, key: string): boolean => {
    if (state.scans.get(table)?.meta.has(key) && !isExcluded(table, key)) return true;
    return liveKeys.get(table)?.has(key) === true;
  };
  const orphans = new CappedList<OrphanInfo>();
  for (let changed = true; changed;) {
    changed = false;
    for (const scan of state.scans.values()) {
      for (const ref of scan.refs) {
        if (isExcluded(scan.spec.name, ref.row)) continue;
        if (ref.target !== null && exists(ref.table, ref.target)) continue;
        orphans.add({
          table: scan.spec.name,
          key: ref.row,
          field: ref.field,
          refTable: ref.table,
          refKey: ref.target,
          cascaded:
            ref.target !== null &&
            state.scans.get(ref.table)?.meta.has(ref.target) === true &&
            isExcluded(ref.table, ref.target),
        });
        if (policy === 'skip') {
          exclude(scan.spec.name, ref.row);
          changed = true;
        }
      }
    }
    if (policy !== 'skip') break;
  }
  if (orphans.total > 0 && policy === 'abort') {
    throw new BackupError(
      'integrity_violation',
      `${orphans.total} row(s) reference data that does not exist.`,
      { orphans: orphans.view() },
    );
  }

  // Classification of every archive row against its live twin.
  const conflicts = new CappedList<ConflictInfo>();
  const overwritten = new CappedList<OverwriteInfo>();
  const tables: Record<string, TableReport> = {};
  const stage = new Map<string, Set<string>>();
  const upsert: Record<string, RowKey[]> = {};
  const totals = emptyTable();
  let overwrittenNewerLive = 0;
  let removedLiveOnly = 0;
  const isoOf = (t: number | null | undefined) =>
    t === null || t === undefined ? null : new Date(t).toISOString();

  for (const scan of state.scans.values()) {
    const name = scan.spec.name;
    const liveMap = live.get(name) ?? new Map<string, RowMeta | null>();
    const rep = emptyTable();
    rep.archiveRows = scan.archiveRows;
    rep.valid = scan.meta.size;
    rep.invalid = scan.invalidCount;
    rep.droppedByMigration = scan.droppedByMigration;
    rep.liveRows = liveMap.size;
    const toStage = new Set<string>();
    const archiveKeys = new Set<string>();
    for (const [key, meta] of scan.meta) {
      if (isExcluded(name, key)) {
        rep.excluded++;
        continue;
      }
      archiveKeys.add(key);
      const liveMeta = liveMap.get(key) ?? undefined;
      const d = decide(meta, liveMeta);
      const compare = {
        table: name,
        key,
        liveUpdatedAt: isoOf(liveMeta?.t),
        archiveUpdatedAt: isoOf(meta.t),
        liveDeleted: liveMeta ? liveMeta.d !== null : false,
        archiveDeleted: meta.d !== null,
      };
      switch (d.kind) {
        case 'add':
          rep.add++;
          toStage.add(key);
          break;
        case 'update':
          rep.update++;
          toStage.add(key);
          overwritten.add({ ...compare, direction: d.reason });
          break;
        case 'identical':
          rep.skipIdentical++;
          break;
        case 'live_newer':
          rep.skipLiveNewer++;
          if (mode === 'replace') {
            overwrittenNewerLive++;
            overwritten.add({ ...compare, direction: 'live_newer' });
          }
          break;
        case 'conflict':
          rep.conflict++;
          conflicts.add({ ...compare, reason: d.reason });
          if (mode === 'replace') {
            overwrittenNewerLive++;
            overwritten.add({ ...compare, direction: 'conflict' });
          }
          break;
      }
    }
    for (const key of liveMap.keys()) if (!archiveKeys.has(key)) rep.liveOnly++;
    if (mode === 'replace') {
      // The game ledger is the app's own accounting, not items the person would recognise.
      if (!scan.spec.bookkeeping) removedLiveOnly += rep.liveOnly;
      stage.set(name, archiveKeys);
    } else {
      stage.set(name, toStage);
      upsert[name] = [...toStage].map((k) => JSON.parse(k) as RowKey);
    }
    tables[name] = rep;
    for (const k of Object.keys(totals) as (keyof TableReport)[]) totals[k] += rep[k];
  }

  const inArchive = new Set(state.scans.keys());
  // Replace empties every exportable table, also those an older archive has no data for: leaving
  // them would keep rows that point into data the restore just replaced.
  const tablesCleared = registry.tables
    .filter((t) => !t.localOnly || inArchive.has(t.name))
    .map((t) => t.name);

  const report: RestoreReport = {
    mode,
    archive: {
      formatVersion: manifest.formatVersion,
      appSchemaVersion: manifest.appSchemaVersion,
      createdAt: manifest.createdAt,
      createdBy: manifest.createdBy,
      encrypted: manifest.options.encrypted,
      includesAttachments: manifest.options.includesAttachments,
      tables: manifest.tables.map((t) => ({ name: t.name, rowCount: t.rowCount })),
    },
    currentSchemaVersion: registry.schemaVersion,
    migratedFromVersion: migratedFrom,
    tables,
    totals,
    skippedTables,
    invalidRows: state.invalid.view(),
    orphans: orphans.view(),
    conflicts: conflicts.view(),
    overwritten: overwritten.view(),
    replaceImpact: {
      tablesCleared: mode === 'replace' ? tablesCleared : [],
      clearedWithoutArchiveData:
        mode === 'replace' ? tablesCleared.filter((n) => !inArchive.has(n)) : [],
      overwrittenNewerLiveRows: overwrittenNewerLive,
      removedLiveOnlyRows: removedLiveOnly,
    },
    warnings: [
      ...(skippedTables.length
        ? [
            `Ignored ${skippedTables.length} table(s) this version does not know: ${skippedTables.join(', ')}.`,
          ]
        : []),
      ...(state.regraded > 0
        ? [
            `${state.regraded} AI result(s) are not backed by the passages in your vault; they are restored as unverified drafts and the citations that could not be found were removed.`,
          ]
        : []),
    ],
  };
  const commitPlan: CommitPlan =
    mode === 'replace' ? { mode: 'replace', tables: tablesCleared } : { mode: 'merge', upsert };
  return { report, stage, commitPlan, tablesRestored: [...inArchive] };
}

function emptyTable(): TableReport {
  return {
    archiveRows: 0,
    valid: 0,
    invalid: 0,
    droppedByMigration: 0,
    excluded: 0,
    add: 0,
    update: 0,
    skipIdentical: 0,
    skipLiveNewer: 0,
    conflict: 0,
    liveOnly: 0,
    liveRows: 0,
  };
}

// ---------------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------------------------

/**
 * Parse -> verify -> migrate -> validate -> integrity-check -> dry run. NOTHING is written to the
 * target by this function (no staging area is even created). Throws a typed BackupError for every
 * corruption or incompatibility; the returned `report` is the dry-run.
 */
export async function prepareRestore(
  input: Uint8Array,
  options: RestoreOptions,
): Promise<PreparedRestore> {
  const mode = options.mode ?? 'merge';
  const limits: RestoreLimits = { ...DEFAULT_RESTORE_LIMITS, ...options.limits };
  const batchSize = options.batchSize ?? 500;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
    throw new BackupError('invalid_options', 'batchSize must be an integer from 1 to 10000.');
  }
  const deps = resolveCrypto(options);
  const { signal } = options;
  throwIfAborted(signal);
  if (input.length > limits.maxArchiveBytes) {
    throw new BackupError('limit_exceeded', 'The file is larger than the allowed size.', {
      bytes: input.length,
      maxArchiveBytes: limits.maxArchiveBytes,
    });
  }
  const registry = options.target.registry;
  const specs = new Map(registry.tables.map((t) => [t.name, t]));

  const emit = (p: Partial<RestoreProgress> & Pick<RestoreProgress, 'phase'>) =>
    options.onProgress?.({
      table: null,
      tablesDone: 0,
      tablesTotal: 0,
      rowsDone: 0,
      rowsTotal: 0,
      ...p,
    });

  let bytes = input;
  if (isEncryptedContainer(input)) {
    if (options.passphrase === undefined) {
      throw new BackupError(
        'passphrase_required',
        'This backup is encrypted; enter its passphrase.',
      );
    }
    emit({ phase: 'decrypting' });
    bytes = await decryptContainer(deps, input, options.passphrase);
  }
  throwIfAborted(signal);

  const holder: Holder = { bytes };
  const reader = await openArchive(holder, limits, deps.subtle);
  const { manifest } = reader;
  if (manifest.appSchemaVersion > registry.schemaVersion) {
    throw new BackupError(
      'future_schema_version',
      `This backup was made by a newer version of StudyVault (data version ${manifest.appSchemaVersion}; this one understands up to ${registry.schemaVersion}). Update the extension first.`,
      { archiveVersion: manifest.appSchemaVersion, currentVersion: registry.schemaVersion },
    );
  }
  const chain = buildMigrationChain(
    manifest.appSchemaVersion,
    registry.schemaVersion,
    options.migrations ?? [],
  );

  const skippedTables = manifest.tables.filter((t) => !specs.has(t.name)).map((t) => t.name);
  const known = manifest.tables.filter((t) => specs.has(t.name));
  const rowsTotal = known.reduce((n, t) => n + t.rowCount, 0);

  const ctx: Context = {
    options,
    target: options.target,
    limits,
    subtle: deps.subtle,
    reader,
    chain,
    specs,
    immutable: options.target.immutableFields(),
    guard: null,
    batchSize,
    signal,
    progress: (p) => emit({ tablesTotal: known.length, rowsTotal, ...p }),
  };
  const state: ScanState = {
    scans: new Map(),
    invalid: new CappedList<InvalidRowInfo>(),
    verifiedBlobs: new Set(),
    rowsSeen: 0,
    regraded: 0,
  };

  // Rows that cite other rows' text (AI results) are scanned last, once the passages they may cite
  // have been seen; the guard re-checks them against those passages and the live vault.
  const guard = options.target.citationGuard;
  const guardedEntry = guard
    ? known.find((t) => t.name === guard.table && t.rowCount > 0)
    : undefined;
  if (guard && guardedEntry) {
    ctx.guard = await openGuard(ctx, guard, guardedEntry, mode);
  }
  const order = ctx.guard
    ? [...known.filter((t) => t !== guardedEntry), ...known.filter((t) => t === guardedEntry)]
    : known;

  for (const entry of order) {
    throwIfAborted(signal);
    const spec = specs.get(entry.name) as TableSpec;
    state.scans.set(entry.name, await scanTable(ctx, state, spec, entry));
    ctx.progress({
      phase: 'verifying',
      table: entry.name,
      tablesDone: state.scans.size,
      rowsDone: state.rowsSeen,
    });
  }
  if (state.invalid.total > 0 && (options.invalidRows ?? 'abort') === 'abort') {
    throw new BackupError(
      'row_invalid',
      `${state.invalid.total} row(s) in the backup do not match the data model.`,
      { invalidRows: state.invalid.view() },
    );
  }

  const migratedFrom = chain.length > 0 ? manifest.appSchemaVersion : null;
  const evaluation = await evaluate(ctx, state, mode, manifest, skippedTables, migratedFrom);

  let used = false;
  return {
    report: evaluation.report,
    discard() {
      used = true;
      holder.bytes = null;
    },
    async commit() {
      if (used || holder.bytes === null) {
        throw new BackupError(
          'invalid_options',
          'This restore was already committed or discarded.',
        );
      }
      used = true;
      try {
        // One restore at a time, from the live-data comparison (it is redone inside) to the commit.
        const run = () => commitRestore(ctx, state, manifest, skippedTables, migratedFrom, mode);
        return await (ctx.target.exclusive ? ctx.target.exclusive(run) : run());
      } finally {
        holder.bytes = null;
      }
    },
  };
}

async function commitRestore(
  ctx: Context,
  state: ScanState,
  manifest: Manifest,
  skippedTables: string[],
  migratedFrom: number | null,
  mode: 'merge' | 'replace',
): Promise<RestoreResult> {
  const { options, target, signal } = ctx;
  throwIfAborted(signal);

  // Live data may have changed since the dry run: decide again from the current state.
  const evaluation = await evaluate(ctx, state, mode, manifest, skippedTables, migratedFrom);
  throwIfAborted(signal);

  if (options.preRestoreBackup) {
    try {
      const backup = await exportBackup(target, {
        ...options.preRestoreBackup.options,
        subtle: ctx.subtle,
        ...(options.randomBytes ? { randomBytes: options.randomBytes } : {}),
        ...(signal ? { signal } : {}),
      });
      await options.preRestoreBackup.sink(backup);
    } catch (cause) {
      if (isBackupError(cause) && cause.code === 'aborted') throw cause;
      throw new BackupError(
        'safety_backup_failed',
        'Could not save a safety backup of the current data, so nothing was restored.',
        {},
        cause,
      );
    }
  }
  throwIfAborted(signal);

  const expectedRows: Record<string, number> = {};
  for (const [t, set] of evaluation.stage) expectedRows[t] = set.size;
  let staging: StagingDb;
  try {
    staging = await target.createStaging({ tables: evaluation.tablesRestored, expectedRows });
  } catch (cause) {
    throw isBackupError(cause)
      ? cause
      : new BackupError('staging_failed', 'Could not create the staging area.', {}, cause);
  }

  const written: Record<string, number> = {};
  try {
    const stagedTotal = [...evaluation.stage.values()].reduce((n, s) => n + s.size, 0);
    let staged = 0;
    for (const [name, scan] of state.scans) {
      const wanted = evaluation.stage.get(name) as Set<string>;
      written[name] = wanted.size;
      if (wanted.size === 0) continue;
      let batch: Row[] = [];
      let batchBytes = 0;
      const flush = async () => {
        if (batch.length === 0) return;
        const rows = batch;
        batch = [];
        batchBytes = 0;
        await staging.putRows(name, rows);
        staged += rows.length;
        ctx.progress({ phase: 'staging', table: name, rowsDone: staged, rowsTotal: stagedTotal });
        throwIfAborted(signal);
        await yieldIfDue();
      };
      for (const raw of ctx.reader.rows(scan.entry)) {
        if (typeof raw.value !== 'object' || raw.value === null || Array.isArray(raw.value))
          continue;
        let row: Row | null;
        let key: string;
        try {
          row = migrateRow(name, raw.value as Row, ctx.chain);
          if (row === null) continue;
          key = keyString(rowKey(scan.spec, row));
          // Only the line the scan accepted: an earlier line with the same key failed a check.
          if (scan.lines.get(key) !== raw.line) continue;
          row = guarded(ctx, name, row);
        } catch {
          continue; // already reported as invalid in the scan
        }
        if (!wanted.delete(key)) continue;
        let hydrated = row;
        if (containsMarker(row)) {
          hydrated = (await rehydrateBinaries(row, async (m) => {
            const data = await ctx.reader.blob(m, false);
            batchBytes += data.length;
            return data;
          })) as Row;
        }
        batch.push(hydrated);
        if (batch.length >= ctx.batchSize || batchBytes >= 32 * 1024 * 1024) await flush();
      }
      await flush();
      if (wanted.size > 0) {
        throw new BackupError(
          'corrupt_archive',
          `${name}: rows changed between verification and staging.`,
          {
            table: name,
          },
        );
      }
    }
    const problems = (await staging.validate?.()) ?? [];
    if (problems.length > 0) {
      throw new BackupError('staging_failed', 'The staged data failed the storage checks.', {
        problems: problems.slice(0, 20),
      });
    }
    throwIfAborted(signal);
    ctx.progress({ phase: 'committing' });
    try {
      await staging.commit(evaluation.commitPlan);
    } catch (cause) {
      throw new BackupError(
        'commit_failed',
        'The restore could not be applied; your data was left as it was.',
        {},
        cause,
      );
    }
  } catch (cause) {
    await staging.rollback().catch(() => undefined);
    await staging.discard().catch(() => undefined);
    throw isBackupError(cause)
      ? cause
      : new BackupError(
          'staging_failed',
          'Writing to the staging area failed; nothing was changed.',
          {},
          cause,
        );
  }
  await staging.discard().catch(() => undefined);
  ctx.progress({ phase: 'done' });
  return { mode, written, report: evaluation.report };
}

/** prepareRestore + commit in one call. `dryRun: true` stops after the report. */
export async function restoreBackup(
  input: Uint8Array,
  options: RestoreOptions & { dryRun?: boolean },
): Promise<{ report: RestoreReport; result: RestoreResult | null }> {
  const prepared = await prepareRestore(input, options);
  if (options.dryRun) {
    prepared.discard();
    return { report: prepared.report, result: null };
  }
  const result = await prepared.commit();
  return { report: result.report, result };
}
