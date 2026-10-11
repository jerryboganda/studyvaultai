import type { TableRegistry } from '@shared';

/** A stored record. Values must be JSON data, plus Blob / ArrayBuffer / typed arrays (see binary.ts). */
export type Row = Record<string, unknown>;

/** Primary key value: one field, or an array for a compound key (same order as TableSpec.primaryKey). */
export type RowKey = string | number | readonly (string | number)[];

export interface ReadOptions {
  /** Exclusive lower bound in primary-key order. Absent on the first page. */
  afterKey?: RowKey;
  /** Maximum rows per page. */
  limit: number;
}

/**
 * A table read is either ONE PAGE (`Promise<rows>`: rows with key > afterKey in ascending key order,
 * at most `limit`; fewer than `limit` or none means "done") or a stream of pages (`AsyncIterable`,
 * which is read to the end and may ignore `afterKey`). Implementations must return rows in a stable
 * primary-key order; soft-deleted rows ARE included (tombstones are part of a backup).
 */
export type TableRead = Promise<readonly Row[]> | AsyncIterable<readonly Row[]>;

export interface RowReader {
  readTable(name: string, options: ReadOptions): TableRead;
}

/** Read side of the vault. A Dexie-backed implementation lives in @storage; this package never imports it. */
export interface BackupSource extends RowReader {
  readonly registry: TableRegistry;
  /** Live row counts per table name (including soft-deleted rows). Used for progress only. */
  counts(): Promise<Readonly<Record<string, number>>>;
}

export interface StagingInit {
  /** Tables that will receive rows. */
  tables: readonly string[];
  /** Rows that will be put per table (an upper bound, for pre-sizing). */
  expectedRows: Readonly<Record<string, number>>;
}

/**
 * What `StagingDb.commit` must make true, in ONE atomic step (all-or-nothing):
 *  - replace: for every table in `tables`, delete every live row, then copy in every staged row;
 *  - merge:   for every table, upsert the staged rows whose key is listed in `upsert[table]` and
 *             change nothing else. Rows are never deleted.
 */
export type CommitPlan =
  | { mode: 'replace'; tables: readonly string[] }
  | { mode: 'merge'; upsert: Readonly<Record<string, readonly RowKey[]>> };

/**
 * A scratch copy of the incoming data. The restore code writes into it, asks the target to validate
 * it, and only then commits it to the live tables. Anything but `commit` must leave live data alone.
 */
export interface StagingDb {
  /** Bulk-insert validated, migrated rows (Blob fields already rehydrated). */
  putRows(table: string, rows: readonly Row[]): Promise<void>;
  /** Optional target-side checks (e.g. unique indexes). Return human-readable problems; [] means OK. */
  validate?(): Promise<readonly string[]>;
  /** Apply the plan atomically. On throw, live data must be exactly as before the call. */
  commit(plan: CommitPlan): Promise<void>;
  /** Undo anything a failed commit may have left behind and drop staged rows. Must be idempotent. */
  rollback(): Promise<void>;
  /** Release the staging area. Called after success; idempotent. */
  discard(): Promise<void>;
}

/**
 * Per table: the fields a merge restore must never change on a row that already exists (capture
 * provenance). The member `'*'` means every field of the row (append-only tables). A restore that
 * would change one keeps the live row and reports a conflict.
 */
export type ImmutableFields = Readonly<Record<string, readonly string[]>>;

/** Text of a passage an AI result may cite (a highlight's quote, a note's body). */
export interface Passage {
  /** Table the passage lives in (decides whether a citation names a highlight or a note). */
  table: string;
  text: string;
}

/**
 * Port for a table whose rows make claims about the text of other rows (AI results cite highlights
 * and notes). The restore finds the passages a row cites in the archive and in the live vault and
 * hands them to `regrade`, so a forged archive cannot bring in a claim the local data does not back.
 */
export interface CitationGuard {
  /** The table of rows that cite passages. */
  readonly table: string;
  /** Tables holding citeable passages, and the field with the text in each. */
  readonly passages: Readonly<Record<string, string>>;
  /** Ids of the passages a row cites. Receives rows that are not validated yet: be defensive. */
  cited(row: Row): readonly string[];
  /**
   * The row to keep: the same object when its claims hold, otherwise a demoted copy (never one that
   * claims more). Pure and deterministic: it runs once per scan and again when rows are staged.
   */
  regrade(row: Row, passages: ReadonlyMap<string, Passage>): Row;
}

/** Write side of the vault. Extends the source so dry runs can compare against live data. */
export interface RestoreTarget extends BackupSource {
  createStaging(init: StagingInit): Promise<StagingDb>;
  /**
   * Which fields of existing rows a merge may not change. Required, so a target cannot forget to
   * say; evaluated when a restore starts (schemas other modules register show up).
   */
  immutableFields(): ImmutableFields;
  /** Re-checks rows that cite other rows' text (AI results). Absent: such rows are taken as they are. */
  readonly citationGuard?: CitationGuard;
  /**
   * Runs `run` while no other restore uses this vault, from the live-data comparison to the commit.
   * Rejects with `restore_in_progress` when another one does. Absent: no mutual exclusion.
   */
  exclusive?<T>(run: () => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------------------------

/**
 * One pure step from archive `appSchemaVersion === from` to `from + 1`. `tables` maps a table name
 * to a per-row transform: return the (new) row, or null to drop it (reported). A table not listed
 * passes through. Steps must not mutate their input and must be deterministic.
 */
export interface MigrationStep {
  readonly from: number;
  readonly tables?: Readonly<Record<string, (row: Row) => Row | null>>;
}

// ---------------------------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------------------------

export interface ExportProgress {
  phase: 'reading' | 'compressing' | 'encrypting' | 'done';
  table: string | null;
  tablesDone: number;
  tablesTotal: number;
  rowsDone: number;
  /** From `source.counts()`; an estimate if rows change during the export. */
  rowsTotal: number;
}

export interface RestoreProgress {
  phase: 'decrypting' | 'verifying' | 'staging' | 'committing' | 'done';
  table: string | null;
  tablesDone: number;
  tablesTotal: number;
  rowsDone: number;
  rowsTotal: number;
}
