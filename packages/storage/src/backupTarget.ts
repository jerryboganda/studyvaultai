import Dexie, { type IndexableType, type Table } from 'dexie';
import { uuidv7 } from 'uuidv7';
import { z } from 'zod';
import {
  CustomFields,
  DEFAULT_PALETTE,
  HIGHLIGHT_KINDS,
  MAX_QUOTE_CHARS,
  MAX_TITLE_CHARS,
  MAX_URL_CHARS,
  PLACEHOLDER_SOURCE_PREFIX,
  SCHEMA_VERSION,
  StudyVaultError,
  Tag,
  redactUrl,
  sourceKeys,
  tagNameKey,
  type Highlight,
  type Source,
  type TableRegistry,
  type TableSpec,
  type Tag as TagRow,
} from '@shared';
import {
  exportBackup,
  type BackupSource,
  type CommitPlan,
  type ExportDataset,
  type ImportRowSet,
  type MigrationStep,
  type ReadOptions,
  type RestoreTarget,
  type Row,
  type RowKey,
  type StagingDb,
  type StagingInit,
  type TableRead,
} from '@backup';
import { isPrimary, matchSources, now, parseRow, resolveTargetBank, signalChange } from './core';
import {
  DB_VERSION,
  onBeforeMigrate,
  suppressSyncCapture,
  withDb,
  withWritableDb,
  type MetaRow,
  type MigrationContext,
  type StudyVaultDb,
} from './db';
import { normalizeQuote, quoteHash } from './normalize';
import { getTableRegistry } from './registry';
import { resetSyncIdentityIfUsed } from './sync';

/**
 * Storage side of backup/restore (@backup is pure and talks to data only through ports).
 *
 *  - BackupSource over the table registry: pages by primary key (compound keys included) and counts.
 *  - RestoreTarget whose staging area is a throwaway IndexedDB database. Nothing is written to the
 *    live tables until `commit`, which applies the whole plan in ONE transaction: a failure (or a
 *    crash) leaves the live rows exactly as they were.
 *  - The automatic pre-migration snapshot, kept in its own small database (a v1 database has no
 *    `meta` table to hold it, and the live database is about to change shape).
 *  - `importExternalHighlights`: the write side of the Markdown/CSV importer.
 */

/** Throwaway database that holds an incoming restore until it is committed. */
export const RESTORE_STAGING_DB = 'studyvault-restore-staging';
/** Holds the single automatic snapshot taken right before a schema upgrade. */
export const PRE_MIGRATION_DB = 'studyvault-premigration';
/** Largest pre-migration archive that is kept; a bigger vault records "too large" instead. */
export const MAX_PRE_MIGRATION_BYTES = 64 * 1024 * 1024;
/** Placeholder address of highlights imported without a source URL (RFC 2606 `.invalid`). */
export const IMPORTED_SOURCE_URL_PREFIX = `${PLACEHOLDER_SOURCE_PREFIX}imported/`;

/**
 * Never exported and never restored, whatever the archive says: `meta` holds secrets (the AI key)
 * and device state, `syncOps` is this device's outgoing queue. A forged archive cannot reach them.
 */
export const BACKUP_EXCLUDED_TABLES: readonly string[] = ['meta', 'syncOps'];

/** Live view of the registry minus the excluded tables (schemas other modules register show up). */
export const backupTableRegistry: TableRegistry = {
  get schemaVersion() {
    return DB_VERSION;
  },
  get tables() {
    return getTableRegistry().tables.filter((t) => !BACKUP_EXCLUDED_TABLES.includes(t.name));
  },
};

/**
 * Row upgrades for archives written at an older registry version, oldest first. Mirrors the Dexie
 * upgrade in db.ts (`upgradeV1ToV2`): a v1 row simply lacks the two fields v2 made explicit.
 * Whoever raises DB_VERSION adds the next step here (a test fails until they do).
 */
export const BACKUP_MIGRATIONS: readonly MigrationStep[] = [
  {
    from: 1,
    tables: {
      sources: (row) => (row.type === undefined ? { ...row, type: 'web' } : row),
      highlightBanks: (row) => (row.folderId === undefined ? { ...row, folderId: null } : row),
    },
  },
  // v3 added only device-local sync bookkeeping tables (never exported): rows are unchanged.
  { from: 2 },
];

/** Tables whose ids share one namespace (same list as the integrity check). */
const ENTITY_TABLES = ['banks', 'sources', 'highlights', 'folders', 'tags', 'notes', 'documents'];

const tableOf = (db: StudyVaultDb, name: string) => db.table(name) as Table<Row, IndexableType>;

// ---------------------------------------------------------------------------------------------
// BackupSource
// ---------------------------------------------------------------------------------------------

function keyOf(spec: Pick<TableSpec, 'primaryKey'>, row: Row): RowKey {
  const pk = spec.primaryKey;
  return typeof pk === 'string'
    ? (row[pk] as string | number)
    : (pk as readonly string[]).map((f) => row[f] as string | number);
}

/** IndexedDB key order for the key shapes the registry uses (number < string, arrays element-wise). */
function compareKeys(a: RowKey, b: RowKey): number {
  const x = (Array.isArray(a) ? a : [a]) as (string | number)[];
  const y = (Array.isArray(b) ? b : [b]) as (string | number)[];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const p = x[i] as string | number;
    const q = y[i] as string | number;
    if (p === q) continue;
    if (typeof p !== typeof q) return typeof p === 'number' ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return x.length - y.length;
}

/** Rows of every registry table, page by page from the live database (one read each). */
function liveSource(): BackupSource {
  return {
    registry: backupTableRegistry,
    readTable(name: string, { afterKey, limit }: ReadOptions): TableRead {
      return withDb(async (db) => {
        const table = tableOf(db, name);
        const rows =
          afterKey === undefined
            ? table.toCollection()
            : table.where(':id').above(afterKey as IndexableType);
        return rows.limit(limit).toArray();
      });
    },
    counts() {
      return withDb((db) =>
        db.transaction('r', db.tables, async () => {
          const out: Record<string, number> = {};
          for (const spec of backupTableRegistry.tables)
            out[spec.name] = await tableOf(db, spec.name).count();
          return out;
        }),
      );
    },
  };
}

/** Pages served from arrays already in memory; tables not in `data` come from `fallback`. */
function memorySource(
  registry: TableRegistry,
  data: ReadonlyMap<string, readonly Row[]>,
  fallback?: BackupSource,
): BackupSource {
  return {
    registry,
    readTable(name, { afterKey, limit }) {
      const rows = data.get(name);
      if (!rows) {
        if (fallback)
          return fallback.readTable(name, {
            limit,
            ...(afterKey === undefined ? {} : { afterKey }),
          });
        return Promise.reject(new Error(`No rows are available for table "${name}".`));
      }
      const spec = registry.tables.find((t) => t.name === name);
      let lo = 0;
      if (afterKey !== undefined && spec) {
        let hi = rows.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (compareKeys(keyOf(spec, rows[mid] as Row), afterKey) <= 0) lo = mid + 1;
          else hi = mid;
        }
      }
      return Promise.resolve(rows.slice(lo, lo + limit));
    },
    async counts() {
      const out: Record<string, number> = fallback ? { ...(await fallback.counts()) } : {};
      for (const [name, rows] of data) out[name] = rows.length;
      return out;
    },
  };
}

/**
 * A source for one export: every ordinary table is read in ONE read transaction (so the archive is
 * a consistent point in time even while pages keep capturing), cached PDF bytes are paged from the
 * live database. Holds the ordinary rows in memory for the duration of the export.
 */
export async function createSnapshotSource(): Promise<BackupSource> {
  const live = liveSource();
  const specs = backupTableRegistry.tables.filter((t) => !t.localOnly);
  const data = new Map<string, Row[]>();
  await withDb((db) =>
    db.transaction(
      'r',
      specs.map((s) => tableOf(db, s.name)),
      async () => {
        for (const spec of specs) data.set(spec.name, await tableOf(db, spec.name).toArray());
      },
    ),
  );
  return memorySource(backupTableRegistry, data, live);
}

// ---------------------------------------------------------------------------------------------
// RestoreTarget
// ---------------------------------------------------------------------------------------------

const pkSpec = (spec: TableSpec): string =>
  typeof spec.primaryKey === 'string' ? spec.primaryKey : `[${spec.primaryKey.join('+')}]`;

class DexieStaging implements StagingDb {
  private readonly counts = new Map<string, number>();
  private released = false;

  constructor(
    private stage: Dexie | null,
    private readonly tables: ReadonlySet<string>,
  ) {}

  private store(name: string): Table<Row, IndexableType> {
    if (!this.stage || !this.tables.has(name)) {
      throw new Error(`Table "${name}" was not announced to the staging area.`);
    }
    return this.stage.table(name) as Table<Row, IndexableType>;
  }

  async putRows(table: string, rows: readonly Row[]): Promise<void> {
    if (this.released) throw new Error('The staging area was already released.');
    await this.store(table).bulkPut(rows as Row[]);
    this.counts.set(table, (this.counts.get(table) ?? 0) + rows.length);
  }

  /** Target-side checks the archive's own verification cannot make. */
  async validate(): Promise<readonly string[]> {
    const problems: string[] = [];
    const owner = new Map<string, string>();
    for (const [name, expected] of this.counts) {
      const stored = await this.store(name).count();
      if (stored !== expected) {
        problems.push(`${name}: ${expected} rows were staged but ${stored} are stored.`);
      }
      if (!ENTITY_TABLES.includes(name)) continue;
      for (const key of await this.store(name).toCollection().primaryKeys()) {
        const id = String(key);
        const other = owner.get(id);
        if (other !== undefined && other !== name) {
          problems.push(`One id is used by both a ${other} row and a ${name} row.`);
        } else owner.set(id, name);
      }
    }
    return problems.slice(0, 20);
  }

  async commit(plan: CommitPlan): Promise<void> {
    if (this.released) throw new Error('The staging area was already released.');
    const known = new Set(backupTableRegistry.tables.map((t) => t.name));
    const names = plan.mode === 'replace' ? [...plan.tables] : Object.keys(plan.upsert);
    for (const n of names) {
      if (!known.has(n)) throw new Error(`The restore plan names an unknown table "${n}".`);
    }

    // An IndexedDB transaction cannot wait on another database, so what is staged is read first.
    // (Blob values are handles to files on disk, not copies in memory.)
    const incoming = new Map<string, Row[]>();
    let total = 0;
    for (const n of names) {
      const staged = this.tables.has(n);
      let rows: Row[] = [];
      if (plan.mode === 'replace') {
        rows = staged ? await this.store(n).toArray() : [];
      } else {
        const keys = (plan.upsert[n] ?? []) as IndexableType[];
        if (keys.length > 0) {
          const got = staged ? await this.store(n).bulkGet(keys) : [];
          if (!staged || got.some((r) => r === undefined)) {
            throw new Error(`The restore plan lists a row of "${n}" that was not staged.`);
          }
          rows = got as Row[];
        }
      }
      incoming.set(n, rows);
      total += rows.length;
    }
    if (plan.mode === 'merge' && total === 0) return; // nothing to write

    const ts = new Date().toISOString();
    const markers: MetaRow[] = [
      // the search index must be rebuilt: replaced and older rows do not move its updatedAt cursor
      { key: 'searchIndexStale', value: ts, updatedAt: ts },
      { key: 'lastRestore', value: { at: ts, mode: plan.mode, rows: total }, updatedAt: ts },
      // Restored rows are not echoed to the sync outbox one by one (suppressed below); the sync
      // runtime reconciles rows against its fingerprints when it finds this marker (see sync.ts).
      { key: 'sync.dirty', value: ts, updatedAt: ts },
    ];
    // A replace is not a series of local edits: sync's bookkeeping is reset in the same transaction.
    const apply = (db: StudyVaultDb) =>
      db.transaction(
        'rw',
        [
          ...names.map((n) => tableOf(db, n)),
          db.meta,
          ...(plan.mode === 'replace'
            ? [db.syncOps, db.syncEntityMeta, db.syncConflicts, db.syncQuarantine]
            : []),
        ] as Table[],
        async (tx) => {
          suppressSyncCapture(tx);
          await assertNoIdCollisions(
            db,
            incoming,
            new Set(plan.mode === 'replace' ? plan.tables : []),
          );
          for (const n of names) {
            const table = tableOf(db, n);
            const rows = incoming.get(n) ?? [];
            if (plan.mode === 'replace') {
              await table.clear();
              if (rows.length > 0) await table.bulkAdd(rows);
            } else if (rows.length > 0) await table.bulkPut(rows);
          }
          await db.meta.bulkPut(markers);
          if (plan.mode === 'replace') await resetSyncIdentityIfUsed(db);
        },
      );
    // Replace is also the way out of "data from a newer build": withWritableDb would refuse it.
    await (plan.mode === 'replace' ? withDb(apply) : withWritableDb(apply));
    await signalChange();
  }

  rollback(): Promise<void> {
    return this.release();
  }

  discard(): Promise<void> {
    return this.release();
  }

  private async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    this.stage?.close();
    this.stage = null;
    await Dexie.delete(RESTORE_STAGING_DB).catch(() => undefined);
  }
}

/** A staged id must not already name a row of a different entity table (and survive the plan). */
async function assertNoIdCollisions(
  db: StudyVaultDb,
  incoming: ReadonlyMap<string, readonly Row[]>,
  cleared: ReadonlySet<string>,
): Promise<void> {
  const staged: [string, string][] = [];
  for (const t of ENTITY_TABLES) {
    for (const row of incoming.get(t) ?? []) {
      if (typeof row.id === 'string') staged.push([row.id, t]);
    }
  }
  for (const other of ENTITY_TABLES) {
    if (cleared.has(other)) continue;
    const ids = staged.filter(([, t]) => t !== other).map(([id]) => id);
    if (ids.length === 0) continue;
    const hits = await tableOf(db, other).bulkGet(ids);
    if (hits.some((r) => r !== undefined)) {
      throw new Error(`An id in the backup is already used by a row of "${other}".`);
    }
  }
}

/** Remove a staging database left behind by a crashed restore (it can hold a copy of the data). */
export async function clearRestoreStaging(): Promise<void> {
  await Dexie.delete(RESTORE_STAGING_DB);
}

/** The vault as a restore target: pass it to `prepareRestore`/`restoreBackup` as `target`. */
export function createBackupTarget(): RestoreTarget {
  const live = liveSource();
  return {
    ...live,
    async createStaging(init: StagingInit): Promise<StagingDb> {
      await Dexie.delete(RESTORE_STAGING_DB); // leftovers of an earlier crash
      const specs = new Map(backupTableRegistry.tables.map((t) => [t.name, t] as const));
      const names = [...new Set(init.tables)];
      for (const n of names) {
        if (!specs.has(n)) throw new Error(`Cannot stage unknown table "${n}".`);
      }
      if (names.length === 0) return new DexieStaging(null, new Set());
      const stage = new Dexie(RESTORE_STAGING_DB);
      stage
        .version(1)
        .stores(Object.fromEntries(names.map((n) => [n, pkSpec(specs.get(n) as TableSpec)])));
      await stage.open();
      return new DexieStaging(stage, new Set(names));
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Pre-migration snapshot
// ---------------------------------------------------------------------------------------------

export interface PreMigrationInfo {
  createdAt: string;
  /** Dexie version the data had, and the one it was upgraded to. */
  fromVersion: number;
  toVersion: number;
  /** 'kept' has an archive; the others say why there is none. */
  status: 'kept' | 'too_large' | 'failed';
  reason: string | null;
  rows: number;
  tables: Record<string, number>;
  byteLength: number;
  sha256: string | null;
  filename: string;
}

interface PreMigrationRecord extends PreMigrationInfo {
  id: 'latest';
  bytes: Uint8Array | null;
}

async function withPreDb<T>(fn: (t: Table<PreMigrationRecord, string>) => Promise<T>): Promise<T> {
  const db = new Dexie(PRE_MIGRATION_DB);
  db.version(1).stores({ snapshots: 'id' });
  try {
    await db.open();
    return await fn(db.table<PreMigrationRecord, string>('snapshots'));
  } finally {
    db.close();
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

let installed: (() => void) | null = null;

/**
 * Take an automatic backup of the whole database right before a schema upgrade, and keep the
 * latest one (replacing the previous). Best effort: a failure is recorded and the upgrade goes on,
 * because the upgrade itself is transactional. Call once, before the first database use, in the
 * context that opens the database after an extension update (the service worker). Returns the
 * unregister function. Not installed by importing this module.
 */
export function installPreMigrationSnapshot(
  options: { maxBytes?: number; appVersion?: string } = {},
): () => void {
  if (installed) return installed;
  const maxBytes = options.maxBytes ?? MAX_PRE_MIGRATION_BYTES;
  const hook = async (ctx: MigrationContext) => {
    if (typeof indexedDB === 'undefined') return;
    const createdAt = new Date().toISOString();
    const stamp = createdAt
      .replace(/[-:]/g, '')
      .replace(/\.\d+Z$/, '')
      .replace('T', '-');
    const base = {
      id: 'latest' as const,
      createdAt,
      fromVersion: ctx.fromVersion,
      toVersion: ctx.toVersion,
      filename: `studyvault-before-update-${stamp}.zip`,
    };
    let record: PreMigrationRecord;
    try {
      const raw = await ctx.snapshot();
      // ordinary tables that existed at the old version, with their current schemas
      const specs = backupTableRegistry.tables.filter((t) => !t.localOnly && t.name in raw);
      const data = new Map(specs.map((s) => [s.name, raw[s.name] as Row[]] as const));
      const out = await exportBackup(
        memorySource({ schemaVersion: ctx.fromVersion, tables: specs }, data),
        {
          now: () => new Date(createdAt),
          ...(options.appVersion ? { appVersion: options.appVersion } : {}),
        },
      );
      const tables = Object.fromEntries(out.manifest.tables.map((t) => [t.name, t.rowCount]));
      const common = { ...base, rows: out.stats.rows, tables, byteLength: out.bytes.length };
      record =
        out.bytes.length > maxBytes
          ? {
              ...common,
              status: 'too_large',
              reason: `The copy would be ${out.bytes.length} bytes; the limit is ${maxBytes}. Export a backup yourself.`,
              sha256: null,
              bytes: null,
            }
          : {
              ...common,
              status: 'kept',
              reason: null,
              sha256: await sha256Hex(out.bytes),
              bytes: out.bytes,
            };
    } catch (err) {
      record = {
        ...base,
        status: 'failed',
        reason: err instanceof Error ? err.message : String(err),
        rows: 0,
        tables: {},
        byteLength: 0,
        sha256: null,
        bytes: null,
      };
    }
    await withPreDb((t) => t.put(record));
  };
  const off = onBeforeMigrate(hook);
  installed = () => {
    off();
    installed = null;
  };
  return installed;
}

const infoOf = ({ bytes: _bytes, id: _id, ...info }: PreMigrationRecord): PreMigrationInfo => info;

const hasPreMigrationDb = async (): Promise<boolean> =>
  typeof indexedDB !== 'undefined' && (await Dexie.exists(PRE_MIGRATION_DB));

/** What the automatic pre-update copy is (without its bytes); null when none was ever taken. */
export async function getPreMigrationInfo(): Promise<PreMigrationInfo | null> {
  if (!(await hasPreMigrationDb())) return null;
  const record = await withPreDb((t) => t.get('latest'));
  return record ? infoOf(record) : null;
}

/** The kept archive, to download or to feed the import wizard. Null when none is kept. */
export async function readPreMigrationSnapshot(): Promise<{
  info: PreMigrationInfo;
  bytes: Uint8Array;
} | null> {
  if (!(await hasPreMigrationDb())) return null;
  const record = await withPreDb((t) => t.get('latest'));
  return record?.bytes ? { info: infoOf(record), bytes: record.bytes } : null;
}

/** Delete the pre-update copy (the user's choice, and part of "delete all my data"). */
export async function deletePreMigrationSnapshot(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  await Dexie.delete(PRE_MIGRATION_DB);
}

// ---------------------------------------------------------------------------------------------
// Datasets for the human-readable exporters
// ---------------------------------------------------------------------------------------------

const DATASET_TABLES = [
  'banks',
  'sources',
  'highlights',
  'highlightBanks',
  'folders',
  'tags',
  'highlightTags',
  'notes',
  'decks',
  'cards',
] as const;

/**
 * Plain rows for Markdown/CSV/Anki exports, read in one transaction. With `bankIds` only those
 * banks, the highlights filed in them and what belongs to those highlights are included.
 */
export async function loadExportDataset(
  options: { bankIds?: readonly string[] } = {},
): Promise<ExportDataset> {
  const all = await withDb((db) =>
    db.transaction(
      'r',
      DATASET_TABLES.map((n) => tableOf(db, n)),
      async () => {
        const out = {} as Record<(typeof DATASET_TABLES)[number], Row[]>;
        for (const n of DATASET_TABLES) out[n] = await tableOf(db, n).toArray();
        return out;
      },
    ),
  );
  if (!options.bankIds) return all;
  const banks = new Set(options.bankIds);
  const memberships = all.highlightBanks.filter((m) => banks.has(m.bankId as string));
  const highlightIds = new Set(memberships.map((m) => m.highlightId as string));
  const highlights = all.highlights.filter((h) => highlightIds.has(h.id as string));
  const sourceIds = new Set(highlights.map((h) => h.sourceId as string));
  const links = all.highlightTags.filter((l) => highlightIds.has(l.highlightId as string));
  const tagIds = new Set(links.map((l) => l.tagId as string));
  const decks = all.decks.filter((d) => typeof d.bankId === 'string' && banks.has(d.bankId));
  const deckIds = new Set(decks.map((d) => d.id as string));
  return {
    banks: all.banks.filter((b) => banks.has(b.id as string)),
    sources: all.sources.filter((s) => sourceIds.has(s.id as string)),
    highlights,
    highlightBanks: memberships,
    folders: all.folders.filter((f) => banks.has(f.bankId as string)),
    tags: all.tags.filter((t) => tagIds.has(t.id as string)),
    highlightTags: links,
    notes: all.notes.filter(
      (n) => typeof n.highlightId === 'string' && highlightIds.has(n.highlightId),
    ),
    decks,
    cards: all.cards.filter(
      (c) =>
        (typeof c.deckId === 'string' && deckIds.has(c.deckId)) ||
        (typeof c.highlightId === 'string' && highlightIds.has(c.highlightId)),
    ),
  };
}

// ---------------------------------------------------------------------------------------------
// External (Markdown / CSV) highlights
// ---------------------------------------------------------------------------------------------

/** quoteHash of every live highlight: input of the importer's duplicate detection. */
export async function listLiveQuoteHashes(): Promise<Set<string>> {
  return withDb(async (db) => {
    const hashes = new Set<string>();
    await db.highlights.each((h) => {
      if (h.deletedAt === null && typeof h.quoteHash === 'string') hashes.add(h.quoteHash);
    });
    return hashes;
  });
}

const ImportedRow = z.object({
  quote: z.string().trim().min(1).max(MAX_QUOTE_CHARS),
  comment: z.string().max(20_000),
  tags: z.array(z.string()).max(32),
  bank: z.string().nullable(),
  folder: z.string().nullable(),
  kind: z.enum(HIGHLIGHT_KINDS).nullable(),
  sourceTitle: z.string().nullable(),
  sourceUrl: z.string().max(MAX_URL_CHARS).nullable(),
  capturedAt: z.iso.datetime().nullable(),
  format: z.enum(['markdown', 'csv']),
});

export interface ImportExternalResult {
  created: number;
  /** Skipped because a live highlight with the same normalised quote already exists. */
  duplicates: number;
  sourcesCreated: number;
  tagsCreated: number;
  /** The bank they went to (the Inbox when the requested bank is gone). */
  bankId: string;
  highlightIds: string[];
}

const trimTo = (s: string, max: number) => (s.length > max ? s.slice(0, max) : s);

/**
 * Write reviewed rows from `importMarkdownHighlights` / `importCsvHighlights` into one bank, in one
 * transaction. Every row is re-validated (the UI is a boundary) and its hash recomputed. Rows get
 * `customFields: { importedFrom, needsReview: true }`; their Source is a 'web' source when the row
 * names an http(s) URL (a claim, not a capture) and an `IMPORTED_SOURCE_URL_PREFIX` placeholder
 * otherwise. Quotes already in the vault are skipped, so importing a file twice adds nothing.
 */
export async function importExternalHighlights(
  rowSet: Pick<ImportRowSet, 'highlights'>,
  options: { bankId: string | null },
): Promise<ImportExternalResult> {
  const prepared: { row: z.infer<typeof ImportedRow>; normalized: string; hash: string }[] = [];
  for (const raw of rowSet.highlights) {
    const parsed = ImportedRow.safeParse(raw);
    if (!parsed.success) {
      throw new StudyVaultError(
        'invalid_request',
        `Invalid imported highlight: ${parsed.error.message}`,
      );
    }
    const normalized = normalizeQuote(parsed.data.quote);
    if (normalized === '') continue;
    // hash before the transaction: awaiting crypto.subtle inside it would let IndexedDB commit
    prepared.push({ row: parsed.data, normalized, hash: await quoteHash(normalized) });
  }
  const ts = now();
  const batch = uuidv7();

  const { result, changed } = await withWritableDb((db) =>
    db.transaction(
      'rw',
      [db.banks, db.sources, db.highlights, db.highlightBanks, db.tags, db.highlightTags],
      async () => {
        const bank = await resolveTargetBank(db, options.bankId, ts);
        const tags = (await db.tags.toArray()).flatMap((r) => {
          const t = parseRow(Tag, r, 'tag');
          return t ? [t] : [];
        });
        const liveByKey = new Map<string, TagRow>();
        for (const t of tags) {
          if (t.deletedAt === null) {
            liveByKey.set(t.nameKey, t);
            for (const alias of t.aliases) liveByKey.set(tagNameKey(alias), t);
          }
        }
        const placeholders = new Map<string, Source>();
        const webSources = new Map<string, Source>();
        const seen = new Set<string>();
        const out: ImportExternalResult = {
          created: 0,
          duplicates: 0,
          sourcesCreated: 0,
          tagsCreated: 0,
          bankId: bank.id,
          highlightIds: [],
        };

        const sourceFor = async (row: z.infer<typeof ImportedRow>): Promise<Source> => {
          const keys = row.sourceUrl ? sourceKeys(row.sourceUrl, null) : null;
          const originalUrl = row.sourceUrl ? redactUrl(row.sourceUrl) : null;
          if (
            keys &&
            originalUrl &&
            keys.urlKey.length <= MAX_URL_CHARS &&
            keys.visitedKey.length <= MAX_URL_CHARS &&
            originalUrl.length <= MAX_URL_CHARS
          ) {
            const cached = webSources.get(keys.urlKey);
            if (cached) return cached;
            let source = (await matchSources(db, keys)).find((s) => isPrimary(s, keys));
            if (!source) {
              const host = new URL(row.sourceUrl as string).hostname;
              source = {
                id: uuidv7(),
                schemaVersion: SCHEMA_VERSION,
                createdAt: ts,
                updatedAt: ts,
                deletedAt: null,
                type: 'web',
                urlKey: keys.urlKey,
                visitedKey: keys.visitedKey,
                originalUrl,
                canonicalUrl: null,
                host,
                title: trimTo(row.sourceTitle ?? host, MAX_TITLE_CHARS),
              };
              await db.sources.put(source);
              out.sourcesCreated++;
            }
            webSources.set(keys.urlKey, source);
            return source;
          }
          const label = row.sourceTitle ?? '';
          const cached = placeholders.get(label);
          if (cached) return cached;
          const n = placeholders.size + 1;
          const source: Source = {
            id: uuidv7(),
            schemaVersion: SCHEMA_VERSION,
            createdAt: ts,
            updatedAt: ts,
            deletedAt: null,
            type: 'web',
            urlKey: `imported:${batch}:${n}`,
            visitedKey: `imported:${batch}:${n}`,
            originalUrl: `${IMPORTED_SOURCE_URL_PREFIX}${batch}/${n}`,
            canonicalUrl: null,
            host: 'imported',
            title: trimTo(
              label || `Imported from ${row.format === 'csv' ? 'a CSV file' : 'a Markdown file'}`,
              MAX_TITLE_CHARS,
            ),
          };
          await db.sources.put(source);
          placeholders.set(label, source);
          out.sourcesCreated++;
          return source;
        };

        const tagFor = async (name: string): Promise<TagRow | null> => {
          const text = name.replace(/\s+/g, ' ').trim();
          const parsed = Tag.shape.name.safeParse(text);
          if (!parsed.success) return null;
          const key = tagNameKey(parsed.data);
          const known = liveByKey.get(key);
          if (known) return known;
          const trashed = tags.find((t) => t.deletedAt !== null && t.nameKey === key);
          const tag: TagRow = trashed
            ? { ...trashed, name: parsed.data, deletedAt: null, updatedAt: ts }
            : {
                id: uuidv7(),
                schemaVersion: SCHEMA_VERSION,
                createdAt: ts,
                updatedAt: ts,
                deletedAt: null,
                name: parsed.data,
                nameKey: key,
                color: null,
                aliases: [],
              };
          await db.tags.put(tag);
          liveByKey.set(key, tag);
          out.tagsCreated++;
          return tag;
        };

        for (const { row, normalized, hash } of prepared) {
          const existing = await db.highlights
            .where('quoteHash')
            .equals(hash)
            .filter((h) => h.deletedAt === null)
            .first();
          if (existing || seen.has(hash)) {
            out.duplicates++;
            continue;
          }
          seen.add(hash);
          const source = await sourceFor(row);
          const kind = row.kind ?? 'essential';
          const marker: Record<string, string | boolean> = {
            importedFrom: row.format,
            needsReview: true,
          };
          if (row.bank) marker.importedBank = trimTo(row.bank, 500);
          if (row.folder) marker.importedFolder = trimTo(row.folder, 500);
          const highlight: Highlight = {
            id: uuidv7(),
            schemaVersion: SCHEMA_VERSION,
            createdAt: ts,
            updatedAt: ts,
            deletedAt: null,
            sourceId: source.id,
            exactQuote: row.quote,
            normalizedQuote: normalized.slice(0, MAX_QUOTE_CHARS),
            quoteHash: hash,
            // No page was seen: the position is a placeholder, the quote selector does the work.
            anchorSet: {
              type: 'html',
              textAlgorithm: 'sv-text-v1',
              textQuote: { exact: row.quote, prefix: '', suffix: '' },
              textPosition: { start: 0, end: row.quote.length },
              structuralPath: null,
              contentSignature: 'imported',
              documentTextLength: row.quote.length,
            },
            kind,
            color: DEFAULT_PALETTE[kind],
            priority: 3,
            userComment: row.comment,
            headingContext: null,
            captureMethod: 'import',
            capturedAt: row.capturedAt ?? ts,
            resolveStatus: 'unchecked',
            resolveConfidence: null,
            lastResolvedAt: null,
            customFields: CustomFields.parse(marker),
          };
          await db.highlights.put(highlight);
          await db.highlightBanks.put({
            highlightId: highlight.id,
            bankId: bank.id,
            folderId: null,
            addedAt: ts,
          });
          const linked = new Set<string>();
          for (const name of row.tags) {
            const tag = await tagFor(name);
            if (!tag || linked.has(tag.id)) continue;
            linked.add(tag.id);
            await db.highlightTags.put({ highlightId: highlight.id, tagId: tag.id, addedAt: ts });
          }
          out.created++;
          out.highlightIds.push(highlight.id);
        }
        return { result: out, changed: out.created > 0 };
      },
    ),
  );
  if (changed) await signalChange();
  return result;
}

export interface NeedsReviewItem {
  id: string;
  quote: string;
  comment: string;
  importedFrom: string;
  capturedAt: string;
}

/** Live highlights that were imported from a file and not yet marked reviewed (newest first). */
export async function listImportedNeedingReview(
  limit = 200,
): Promise<{ total: number; items: NeedsReviewItem[] }> {
  return withDb(async (db) => {
    const rows = await db.highlights
      .filter((h) => h.deletedAt === null && h.customFields?.needsReview === true)
      .toArray();
    rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return {
      total: rows.length,
      items: rows.slice(0, limit).map((h) => ({
        id: h.id,
        quote: h.exactQuote,
        comment: h.userComment,
        importedFrom: String(h.customFields?.importedFrom ?? 'file'),
        capturedAt: h.capturedAt,
      })),
    };
  });
}
