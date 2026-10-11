import Dexie, {
  type DBCore,
  type DBCoreMutateRequest,
  type DBCoreMutateResponse,
  type DBCoreTable,
  type DBCoreTransaction,
  type Table,
  type Transaction,
} from 'dexie';
import {
  HighlightBank as HighlightBankSchema,
  SCHEMA_VERSION,
  Source as SourceSchema,
  StudyVaultError,
  type Attachment,
  type BankRecord,
  type Folder,
  type Highlight,
  type HighlightBank,
  type HighlightTag,
  type Note,
  type OcrPage,
  type PdfDocument,
  type Source,
  type Tag,
} from '@shared';
import { isNewerRow, normaliseRow } from './rows';

export const DB_NAME = 'studyvault';

/**
 * Dexie store definitions of schema version 1. Exported so migration tests (and the v2 upgrade)
 * build on the exact same strings instead of copying them.
 * Note: `isInbox` is a boolean and `deletedAt` is nullable; IndexedDB does not index such values,
 * so those two indexes are never used for lookups (live rows are filtered in code).
 */
export const SCHEMA_V1 = {
  banks: 'id, position, isInbox',
  sources: 'id, urlKey, visitedKey, updatedAt',
  highlights: 'id, sourceId, quoteHash, [sourceId+quoteHash], capturedAt, deletedAt, updatedAt',
  highlightBanks: '[highlightId+bankId], highlightId, bankId',
} as const;

/**
 * Dexie store definitions of schema version 2 (Phase 2, docs/plans/EXECUTION_BRIEF.md "Database
 * plan"). Restates every table because Dexie needs the whole definition of a table whose indexes
 * change. Booleans and null are not valid IndexedDB keys: `isInbox`, `pinned`, `suspended` and a
 * null `deletedAt`/`folderId` are simply absent from their indexes, which is what makes
 * `where('deletedAt').above('')` an index scan over exactly the trash. `schemaVersion` is indexed on
 * the three big tables so "does any row come from a newer build" is an index probe, not a scan.
 */
export const SCHEMA_V2 = {
  banks: 'id, position, isInbox',
  sources: 'id, urlKey, visitedKey, updatedAt, documentId, schemaVersion',
  highlights:
    'id, sourceId, quoteHash, [sourceId+quoteHash], capturedAt, deletedAt, updatedAt, kind, priority, resolveStatus, [priority+capturedAt], schemaVersion',
  highlightBanks: '[highlightId+bankId], highlightId, bankId, folderId, [bankId+folderId]',
  folders: 'id, bankId, parentFolderId, [bankId+parentFolderId], position, updatedAt, deletedAt',
  tags: 'id, nameKey, updatedAt, deletedAt',
  highlightTags: '[highlightId+tagId], highlightId, tagId',
  notes: 'id, highlightId, sourceId, pinned, updatedAt, deletedAt, schemaVersion',
  knowledgePoints: 'id, highlightId, updatedAt, deletedAt',
  decks: 'id, bankId, updatedAt, deletedAt',
  cards:
    'id, deckId, knowledgePointId, highlightId, dueAt, state, suspended, [deckId+dueAt], updatedAt, deletedAt',
  reviewLogs: 'id, cardId, reviewedAt, [cardId+reviewedAt], sessionId',
  aiResults: 'id, inputFingerprint, highlightId, kind, createdAt, acceptedAt',
  documents: 'id, title, pageCount, textStatus, createdAt, updatedAt, deletedAt',
  attachments: 'id, documentId, sha256, createdAt',
  ocrPages: '[documentId+pageNumber], documentId',
  syncOps: 'id, entityType, entityId, [entityType+entityId], clientId, createdAt, sentAt',
  meta: 'key',
} as const;

/**
 * Dexie store definitions of schema version 3 (optional sync, Phase 6). Additive: no vault table
 * changes. `syncOps` gains the two fields the outbox needs (`seq`: insertion order that survives a
 * coalescing replace; `pending`: 1 until the server acknowledged it, so "oldest unsent" is an index
 * range and not a scan of every sent row) and three device-local bookkeeping tables are added.
 * None of them is ever backed up, restored or synchronised.
 */
export const SCHEMA_V3 = {
  ...SCHEMA_V2,
  syncOps:
    'id, entityType, entityId, [entityType+entityId], clientId, createdAt, sentAt, seq, [pending+seq]',
  /** Merge metadata of one entity (EntityMeta). `tombstoneAt` drives retention pruning. */
  syncEntityMeta: '[entityType+entityId], entityType, tombstoneAt',
  /** Both versions of a concurrent edit or a delete-versus-edit, until the user decides. */
  syncConflicts: 'id, [entityType+entityId], kind, detectedAt',
  /** Remote operations (or local rows) that were not applied, with the reason. */
  syncQuarantine: 'id, entityType, reason, at',
} as const;

/** The Dexie (IndexedDB) version this build declares. Not the per-record `schemaVersion`. */
export const DB_VERSION = 3;

/** Row of a table whose entity schema belongs to another module (study, ai, sync). */
export type ForeignRow = { id: string } & Record<string, unknown>;

export interface MetaRow {
  key: string;
  value: unknown;
  updatedAt: string;
}

export const META_SCHEMA_KEY = 'schema';

export interface UpgradeStats {
  highlightBanksFixed: number;
  sourcesFixed: number;
  /** Rows left exactly as stored because they would not validate even after the fix. */
  skipped: number;
}

/**
 * v1 -> v2. Runs inside Dexie's versionchange transaction, so a throw rolls the whole upgrade back
 * and the database stays at v1. It only ever fills a field the v1 build left implicit; a row that
 * does not validate afterwards is skipped untouched (never replaced), matching the read path.
 */
export async function upgradeV1ToV2(tx: Transaction): Promise<UpgradeStats> {
  const stats: UpgradeStats = { highlightBanksFixed: 0, sourcesFixed: 0, skipped: 0 };
  const ts = new Date().toISOString();

  const memberships = tx.table('highlightBanks');
  const fixedMemberships: unknown[] = [];
  for (const raw of (await memberships.toArray()) as Array<Record<string, unknown>>) {
    if (raw.folderId !== undefined) continue;
    const next = { ...raw, folderId: null };
    if (HighlightBankSchema.safeParse(next).success) fixedMemberships.push(next);
    else stats.skipped++;
  }
  if (fixedMemberships.length > 0) await memberships.bulkPut(fixedMemberships);
  stats.highlightBanksFixed = fixedMemberships.length;

  const sources = tx.table('sources');
  const fixedSources: unknown[] = [];
  for (const raw of (await sources.toArray()) as Array<Record<string, unknown>>) {
    if (raw.type !== undefined) continue;
    const next = { ...raw, type: 'web' };
    if (SourceSchema.safeParse(normaliseRow(next)).success) fixedSources.push(next);
    else stats.skipped++;
  }
  if (fixedSources.length > 0) await sources.bulkPut(fixedSources);
  stats.sourcesFixed = fixedSources.length;

  const meta: MetaRow = {
    key: META_SCHEMA_KEY,
    value: {
      dbVersion: 2,
      recordSchemaVersion: SCHEMA_VERSION,
      migratedFrom: 1,
      migratedAt: ts,
      ...stats,
    },
    updatedAt: ts,
  };
  await tx.table('meta').put(meta);
  return stats;
}

export interface UpgradeV3Stats {
  /** `syncOps` rows from a pre-release build that were given `seq` / `pending` / `attempts`. */
  opsFixed: number;
}

/**
 * v2 -> v3. The new tables start empty; the only thing to carry over is `syncOps`, which no released
 * build wrote to (the table was reserved in v2), so this is defensive: a row that already has the
 * outbox fields is left exactly as it is. The schema marker keeps what earlier steps recorded (a
 * v1 upgrade's `migratedFrom: 1` stays) and only advances `dbVersion`.
 */
export async function upgradeV2ToV3(tx: Transaction): Promise<UpgradeV3Stats> {
  const stats: UpgradeV3Stats = { opsFixed: 0 };
  const ts = new Date().toISOString();

  const ops = tx.table('syncOps');
  const rows = (await ops.toArray()) as Array<Record<string, unknown>>;
  const missing = rows
    .filter((r) => typeof r.seq !== 'number')
    .sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')));
  let next = rows.reduce((n, r) => Math.max(n, typeof r.seq === 'number' ? r.seq : 0), 0);
  const fixed = missing.map((r) => ({
    ...r,
    seq: ++next,
    attempts: typeof r.attempts === 'number' ? r.attempts : 0,
    pending: typeof r.sentAt === 'number' ? 0 : 1,
  }));
  if (fixed.length > 0) await ops.bulkPut(fixed);
  stats.opsFixed = fixed.length;

  const metaTable = tx.table('meta');
  const previous = (await metaTable.get(META_SCHEMA_KEY)) as MetaRow | undefined;
  const prior =
    previous && typeof previous.value === 'object' && previous.value !== null
      ? (previous.value as Record<string, unknown>)
      : {};
  const marker: MetaRow = {
    key: META_SCHEMA_KEY,
    value: {
      recordSchemaVersion: SCHEMA_VERSION,
      migratedFrom: 2,
      migratedAt: ts,
      ...prior,
      dbVersion: 3,
      v3MigratedAt: ts,
      v3OpsFixed: stats.opsFixed,
    },
    updatedAt: ts,
  };
  await metaTable.put(marker);
  return stats;
}

// ---------------------------------------------------------------------------------------------
// Write interception (optional sync)
// ---------------------------------------------------------------------------------------------

/** One row-level effect of a successful write, as the sync layer needs it. */
export interface ObservedWrite {
  /** The row before the write (null: created) ... */
  before: Record<string, unknown> | null;
  /** ... and after it (null: physically deleted). */
  after: Record<string, unknown> | null;
}

/**
 * What the optional sync layer plugs into a connection (see sync.ts). The connection has none until
 * the user turns sync on: with `syncInterceptor === null` the middleware below is a pass-through.
 */
export interface WriteInterceptor {
  /** Tables whose writes are reported. */
  readonly tables: ReadonlySet<string>;
  /**
   * Object stores added to every readwrite transaction that includes an observed table, so the
   * bookkeeping commits or fails together with the write itself.
   */
  readonly scope: readonly string[];
  /**
   * Called inside the writing transaction, after the write succeeded. `trans` is the raw
   * IDBTransaction (the DBCore base transaction): use `trans.objectStore(name)` for every access.
   * Dexie's own table API must not be used here: Dexie keeps its transaction zone, and the write
   * lock of `modify`/`update`/`delete`, only across awaits it can see, so a native `await` chain
   * would wait for a lock its own caller holds. If this rejects the transaction is aborted: the
   * write and its bookkeeping are both gone.
   */
  record(
    table: string,
    writes: readonly ObservedWrite[],
    trans: DBCoreTransaction,
  ): PromiseLike<void>;
  /** A write happened in a transaction that was opened before the interceptor was installed. */
  missed?(table: string): void;
}

/** Transactions whose writes must not be reported (sync's own applier, restore). */
const suppressed = new WeakSet<object>();
/** Transactions whose scope was extended by the middleware. */
const scoped = new WeakSet<object>();

/**
 * Exclude the writes of this transaction from sync capture. Call as the first statement of the
 * transaction callback. Used by the sync applier (a remote change must not be echoed back as a local
 * edit) and available to whoever replaces data wholesale.
 */
export function suppressSyncCapture(tx: Transaction): void {
  suppressed.add(tx.idbtrans as unknown as object);
}

type Existing = Array<Record<string, unknown> | undefined>;

function observedMutate(
  table: DBCoreTable,
  req: DBCoreMutateRequest,
  it: WriteInterceptor,
): PromiseLike<DBCoreMutateResponse> {
  const extract = table.schema.primaryKey.extractKey;
  if (!extract) return table.mutate(req); // outbound keys: no StudyVault table has them
  const P = Dexie.Promise;

  let keys: unknown[] = [];
  let existing: PromiseLike<Existing>;
  switch (req.type) {
    case 'add':
      keys = req.keys ?? req.values.map(extract);
      existing = P.resolve([] as Existing);
      break;
    case 'put':
      keys = req.keys ?? req.values.map(extract);
      existing = table.getMany({ trans: req.trans, keys });
      break;
    case 'delete':
      keys = req.keys;
      existing = table.getMany({ trans: req.trans, keys });
      break;
    case 'deleteRange':
      existing = table
        .query({
          trans: req.trans,
          values: true,
          query: { index: table.schema.primaryKey, range: req.range },
        })
        .then((r) => r.result as Existing);
      break;
  }

  return existing.then((before) =>
    table.mutate(req).then((res) => {
      const failed = (i: number) => res.failures !== undefined && Object.hasOwn(res.failures, i);
      const writes: ObservedWrite[] = [];
      if (req.type === 'add' || req.type === 'put') {
        req.values.forEach((value, i) => {
          if (!failed(i)) writes.push({ before: before[i] ?? null, after: value });
        });
      } else if (req.type === 'delete') {
        keys.forEach((_key, i) => {
          const old = before[i];
          if (old && !failed(i)) writes.push({ before: old, after: null });
        });
      } else {
        for (const old of before) if (old) writes.push({ before: old, after: null });
      }
      if (writes.length === 0) return res;
      return P.resolve(it.record(table.name, writes, req.trans)).then(
        () => res,
        (err: unknown) => {
          // The row is already written inside this transaction: take both back.
          try {
            (req.trans as DBCoreTransaction).abort();
          } catch {
            /* already aborted */
          }
          throw err;
        },
      );
    }),
  );
}

/**
 * DBCore middleware (outermost, so it sees what the repositories asked for). It is a pass-through
 * unless `getInterceptor()` returns something, in which case:
 *  - readwrite transactions that include an observed table also open the interceptor's bookkeeping
 *    stores, so no repository needs to know sync exists;
 *  - every successful add/put/delete/deleteRange (bulk operations, Collection.modify and soft deletes
 *    included: they are all `mutate` requests) is reported with the row before and after.
 */
function syncCaptureMiddleware(getInterceptor: () => WriteInterceptor | null) {
  return {
    stack: 'dbcore' as const,
    name: 'studyvault-sync-capture',
    level: 10,
    create(down: DBCore): DBCore {
      return {
        ...down,
        transaction(stores, mode, options) {
          const it = getInterceptor();
          if (!it || mode !== 'readwrite' || !stores.some((s) => it.tables.has(s))) {
            return down.transaction(stores, mode, options);
          }
          const trans = down.transaction([...new Set([...stores, ...it.scope])], mode, options);
          scoped.add(trans);
          return trans;
        },
        table(name) {
          const table = down.table(name);
          return {
            ...table,
            mutate(req) {
              const it = getInterceptor();
              if (!it || !it.tables.has(name) || suppressed.has(req.trans)) {
                return table.mutate(req);
              }
              if (!scoped.has(req.trans)) {
                it.missed?.(name);
                return table.mutate(req);
              }
              // Dexie hands out its own thenable here, which every consumer treats as a Promise.
              return observedMutate(table, req, it) as Promise<DBCoreMutateResponse>;
            },
          };
        },
      };
    },
  };
}

export class StudyVaultDb extends Dexie {
  /** Installed by sync.ts while Settings.features.sync is on; null otherwise. */
  syncInterceptor: WriteInterceptor | null = null;

  declare banks: Table<BankRecord, string>;
  declare sources: Table<Source, string>;
  declare highlights: Table<Highlight, string>;
  declare highlightBanks: Table<HighlightBank, [string, string]>;
  declare folders: Table<Folder, string>;
  declare tags: Table<Tag, string>;
  declare highlightTags: Table<HighlightTag, [string, string]>;
  declare notes: Table<Note, string>;
  declare knowledgePoints: Table<ForeignRow, string>;
  declare decks: Table<ForeignRow, string>;
  declare cards: Table<ForeignRow, string>;
  declare reviewLogs: Table<ForeignRow, string>;
  declare aiResults: Table<ForeignRow, string>;
  declare documents: Table<PdfDocument, string>;
  declare attachments: Table<Attachment, string>;
  declare ocrPages: Table<OcrPage, [string, number]>;
  /** Outbox rows are typed in sync.ts (`SyncOpRow`); other modules only ever see a keyed row. */
  declare syncOps: Table<ForeignRow, string>;
  declare syncEntityMeta: Table<Record<string, unknown>, [string, string]>;
  declare syncConflicts: Table<{ id: string } & Record<string, unknown>, string>;
  declare syncQuarantine: Table<{ id: string } & Record<string, unknown>, string>;
  declare meta: Table<MetaRow, string>;

  constructor(name: string = DB_NAME) {
    super(name);
    this.version(1).stores(SCHEMA_V1);
    this.version(2)
      .stores(SCHEMA_V2)
      .upgrade(async (tx) => {
        await upgradeV1ToV2(tx);
      });
    this.version(3)
      .stores(SCHEMA_V3)
      .upgrade(async (tx) => {
        await upgradeV2ToV3(tx);
      });
    this.use(syncCaptureMiddleware(() => this.syncInterceptor));
  }
}

// ---------------------------------------------------------------------------------------------
// Pre-migration hook
// ---------------------------------------------------------------------------------------------

/** Rows of each table that `estimateBytes` reads to learn how big a row typically is. */
const SAMPLE_ROWS = 25;

export interface MigrationContext {
  databaseName: string;
  fromVersion: number;
  toVersion: number;
  /** Row count of every table the old version had (index counts: no row is read). */
  counts(): Promise<Record<string, number>>;
  /**
   * Rough size in bytes of the rows of `tables` as JSON: each table's count times the average row of
   * a small sample. Reads at most a few rows per table, so ask it before reading everything.
   */
  estimateBytes(tables: readonly string[]): Promise<number>;
  /**
   * The rows of `tables` (default: every table) as the old build wrote them, read from a connection
   * that is still at the old version. Call it (and finish any export) before the hook returns. It
   * holds every row it returns in memory: name only the tables that are needed.
   */
  snapshot(tables?: readonly string[]): Promise<Record<string, unknown[]>>;
}
export type MigrationHook = (ctx: MigrationContext) => void | Promise<void>;

const migrationHooks = new Map<MigrationHook, { required: boolean }>();

/**
 * Register a callback that runs once, right before an existing database is upgraded, so the backup
 * module can write a pre-migration export. The upgrade itself is transactional; this is the second
 * safety net. A hook that throws is logged and the upgrade proceeds, unless it was registered with
 * `required: true`, in which case the database is not opened (storage_unavailable) and nothing is
 * changed. Returns the unregister function.
 */
export function onBeforeMigrate(
  hook: MigrationHook,
  options: { required?: boolean } = {},
): () => void {
  migrationHooks.set(hook, { required: options.required === true });
  return () => {
    migrationHooks.delete(hook);
  };
}

/**
 * What this engine can say about `name` without opening it. `exists` is false only when it can say
 * the database does not exist: a probe open of a missing database creates it and deletes it again,
 * which would delete the real one if another context created it in between. `version` is the
 * IndexedDB version (Dexie's `verno` times ten), or null when the engine does not report one.
 */
async function lookUp(name: string): Promise<{ exists: boolean; version: number | null }> {
  try {
    if (typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') {
      return { exists: true, version: null };
    }
    const found = (await indexedDB.databases()).find((d) => d.name === name);
    return { exists: found !== undefined, version: found?.version ?? null };
  } catch {
    return { exists: true, version: null };
  }
}

/** Read the existing database at whatever version it has, without declaring a schema. */
async function runMigrationHooks(name: string): Promise<void> {
  if (migrationHooks.size === 0) return;
  const known = await lookUp(name);
  if (!known.exists) return;
  // Already at (or past) this build's version: nothing to protect, so no probe connection. Every
  // context start used to open the database twice (probe, then the real open) just to learn this.
  if (known.version !== null && known.version / 10 >= DB_VERSION) return;
  const probe = new Dexie(name);
  try {
    try {
      await probe.open();
    } catch (err) {
      // First run: nothing to protect.
      if ((err as { name?: string } | null)?.name === 'NoSuchDatabaseError') return;
      throw err;
    }
    const fromVersion = probe.verno;
    if (fromVersion >= DB_VERSION) return;
    const ctx: MigrationContext = {
      databaseName: name,
      fromVersion,
      toVersion: DB_VERSION,
      counts: async () => {
        const out: Record<string, number> = {};
        for (const table of probe.tables) out[table.name] = await table.count();
        return out;
      },
      estimateBytes: async (tables) => {
        let total = 0;
        for (const name of tables) {
          const table = probe.table(name);
          const count = await table.count();
          if (count === 0) continue;
          const sample = await table.limit(SAMPLE_ROWS).toArray();
          total += (JSON.stringify(sample).length / Math.max(1, sample.length)) * count;
        }
        return Math.ceil(total);
      },
      snapshot: async (tables) => {
        const out: Record<string, unknown[]> = {};
        for (const name of tables ?? probe.tables.map((t) => t.name)) {
          out[name] = await probe.table(name).toArray();
        }
        return out;
      },
    };
    for (const [hook, { required }] of [...migrationHooks]) {
      try {
        await hook(ctx);
      } catch (err) {
        if (required) {
          throw new StudyVaultError(
            'storage_unavailable',
            `The backup that must precede the upgrade failed, so nothing was changed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        console.warn('[StudyVault] pre-migration hook failed; continuing with the upgrade', err);
      }
    }
  } finally {
    probe.close();
  }
}

const opening = new WeakMap<Dexie, Promise<void>>();

/** True inside a liveQuery's Dexie zone, where Dexie refuses every write. */
const inLiveQuery = (): boolean =>
  Boolean((Dexie.Promise as unknown as { PSD?: { subscr?: unknown } }).PSD?.subscr);

/**
 * Open the database. Without pre-migration hooks (unit tests) this is exactly `db.open()`. With
 * hooks, which every context that loads the storage layer has, the open is shared between racing
 * callers and the hooks run at most once per open. Dexie's zone follows the awaits, so a liveQuery
 * that triggers the open keeps tracking the tables it reads afterwards (observe.test.ts).
 */
function openDatabase(db: StudyVaultDb): PromiseLike<unknown> {
  if (migrationHooks.size === 0) return db.open();
  let pending = opening.get(db);
  if (!pending) {
    // A hook writes its copy to another database, which Dexie refuses inside a liveQuery's zone. The
    // zone follows awaits and timers, so only a callback the event loop starts is outside of it.
    const hooks = inLiveQuery()
      ? new Promise<void>((resolve, reject) => {
          setTimeout(() => runMigrationHooks(db.name).then(resolve, reject), 0);
        })
      : runMigrationHooks(db.name);
    pending = (async () => {
      await hooks;
      await db.open();
    })().finally(() => opening.delete(db));
    opening.set(db, pending);
  }
  return pending;
}

/**
 * Open `db` the way `withDb` does, hooks included, for code that keeps a connection of its own (the
 * sync runtime): a raw `db.open()` there would upgrade the schema without the pre-update copy.
 */
export async function ensureOpen(db: StudyVaultDb): Promise<void> {
  assertNoPendingDelete();
  if (!db.isOpen()) await openDatabase(db);
}

// Dexie errors that mean "the database cannot be used right now" rather than "a bug".
const UNAVAILABLE = new Set([
  'OpenFailedError',
  'DatabaseClosedError',
  'MissingAPIError',
  'VersionError',
  'UpgradeError',
  'BlockedError',
  'SecurityError',
  'UnknownError',
  'InvalidStateError',
]);

/** Map anything thrown by IndexedDB/Dexie to a StudyVaultError with a precise code. */
export function toStorageError(err: unknown): StudyVaultError {
  if (err instanceof StudyVaultError) return err;
  const message = err instanceof Error ? err.message : String(err);
  // Dexie wraps the original failure in `.inner`, so look through the chain.
  let cursor: unknown = err;
  for (let depth = 0; depth < 4 && cursor; depth++) {
    const name = (cursor as { name?: unknown }).name;
    if (name === 'QuotaExceededError') return new StudyVaultError('quota_exceeded', message);
    if (typeof name === 'string' && UNAVAILABLE.has(name)) {
      return new StudyVaultError('storage_unavailable', message);
    }
    cursor = (cursor as { inner?: unknown }).inner;
  }
  return new StudyVaultError('internal', message);
}

let instance: StudyVaultDb | null = null;

/** Lazy singleton. Not yet opened: use `withDb` so open failures are mapped. */
export function getDb(): StudyVaultDb {
  return (instance ??= new StudyVaultDb());
}

/**
 * Runs once per connection, after it is open and before the first callback. sync.ts registers it so
 * that every extension context (service worker, side panel, options, PDF reader) learns, before it
 * writes anything, whether Settings.features.sync is on and must record its changes.
 */
export type ConnectionGate = (db: StudyVaultDb) => PromiseLike<void> | void;
let connectionGate: ConnectionGate | null = null;

export function setConnectionGate(gate: ConnectionGate | null): void {
  connectionGate = gate;
}

/** Open the shared database if needed, run `fn`, and surface every failure as a StudyVaultError. */
export async function withDb<T>(fn: (db: StudyVaultDb) => Promise<T>): Promise<T> {
  try {
    assertNoPendingDelete();
    const db = getDb();
    if (!db.isOpen()) await openDatabase(db);
    if (connectionGate) await connectionGate(db);
    return await fn(db);
  } catch (err) {
    throw toStorageError(err);
  }
}

/** Set once this connection has seen that no row was written by a newer build. */
let verifiedCurrent = false;

export const NEWER_DATA_MESSAGE =
  'This data was saved by a newer version of StudyVault. Update the extension before changing it; nothing was written.';

/**
 * Writes are refused while any row carries a schemaVersion this build does not know: this build
 * cannot know what such a row requires of its neighbours, and an older build rewriting them is how
 * data gets lost. Reads are unaffected. The scan runs once per connection (this build only ever
 * writes SCHEMA_VERSION, so a clean result stays clean); a positive result is re-checked each time
 * so that wiping the data, or replacing it, lifts the refusal.
 */
export async function assertNoNewerRows(db: StudyVaultDb): Promise<void> {
  if (verifiedCurrent) return;
  const refuse = () => new StudyVaultError('storage_unavailable', NEWER_DATA_MESSAGE);
  // Big tables: probe the schemaVersion index (numbers above ours; strings and junk sort after
  // Infinity and are not "newer"), and scan only when the probe says there may be one.
  for (const table of [db.sources, db.highlights, db.notes] as const) {
    const probe = table
      .where('schemaVersion')
      .between(SCHEMA_VERSION, Number.POSITIVE_INFINITY, false, true);
    if ((await probe.count()) > 0 && (await table.filter(isNewerRow).first()) !== undefined) {
      throw refuse();
    }
  }
  for (const table of [db.banks, db.folders, db.tags, db.documents] as const) {
    if ((await table.filter(isNewerRow).first()) !== undefined) throw refuse();
  }
  verifiedCurrent = true;
}

/** `withDb` for functions that write: refuses with storage_unavailable on data from a newer build. */
export function withWritableDb<T>(fn: (db: StudyVaultDb) => Promise<T>): Promise<T> {
  return withDb(async (db) => {
    await assertNoNewerRows(db);
    return fn(db);
  });
}

/** Close the connection and forget the singleton; the next call reopens (simulates a restart). */
export function closeDb(): void {
  instance?.close();
  instance = null;
  verifiedCurrent = false;
}

/**
 * "All StudyVault data is being deleted, and the delete is not finished": thrown by every database
 * call of this context until it is, and to a caller that stopped waiting for it. Code `storage_unavailable`.
 */
export class WipePendingError extends StudyVaultError {
  constructor(message: string) {
    super('storage_unavailable', message);
    this.name = 'WipePendingError';
  }
}

interface PendingDelete {
  /** Another window did not release the database when asked to: the request waits for it. */
  blocked: boolean;
  done: Promise<void>;
}
let pendingDelete: PendingDelete | null = null;

function assertNoPendingDelete(): void {
  if (!pendingDelete) return;
  throw new WipePendingError(
    pendingDelete.blocked
      ? 'All StudyVault data is being deleted, but another StudyVault window is still holding it. Close the other StudyVault windows: deleting finishes by itself, and reading and saving work again afterwards.'
      : 'All StudyVault data is being deleted. Try again in a moment.',
  );
}

/**
 * Close this context's connection and delete the whole database, however long that takes. An
 * IndexedDB delete cannot be taken back once requested: if another window keeps its connection open
 * (frozen, or a build that ignores `versionchange`) the request stays queued, and every open behind
 * it would queue too. So this never gives up on it. `onBlocked` fires when the engine reports that
 * another window holds the database; until the request completes, every database call in this
 * context fails at once with `WipePendingError` instead of hanging behind it. A second call while
 * one is pending joins it. Other windows' Dexie connections close themselves on `versionchange` and
 * reopen lazily (empty) on next use.
 */
export function deleteDatabase(onBlocked?: () => void): Promise<void> {
  if (pendingDelete) {
    if (pendingDelete.blocked) onBlocked?.();
    return pendingDelete.done;
  }
  closeDb();
  const state: PendingDelete = { blocked: false, done: Promise.resolve() };
  const request = new Dexie(DB_NAME, { addons: [] });
  request.on('blocked', () => {
    state.blocked = true;
    onBlocked?.();
  });
  state.done = Promise.resolve(request.delete())
    .catch((err: unknown) => {
      throw toStorageError(err);
    })
    .finally(() => {
      if (pendingDelete === state) pendingDelete = null;
    });
  pendingDelete = state;
  return state.done;
}

/** Test helper: close the connection and delete the whole database. */
export const resetDbForTests = (): Promise<void> => deleteDatabase();
