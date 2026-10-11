import Dexie, { type Table, type Transaction } from 'dexie';
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

/** The Dexie (IndexedDB) version this build declares. Not the per-record `schemaVersion`. */
export const DB_VERSION = 2;

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

export class StudyVaultDb extends Dexie {
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
  declare syncOps: Table<ForeignRow, string>;
  declare meta: Table<MetaRow, string>;

  constructor(name: string = DB_NAME) {
    super(name);
    this.version(1).stores(SCHEMA_V1);
    this.version(2)
      .stores(SCHEMA_V2)
      .upgrade(async (tx) => {
        await upgradeV1ToV2(tx);
      });
  }
}

// ---------------------------------------------------------------------------------------------
// Pre-migration hook
// ---------------------------------------------------------------------------------------------

export interface MigrationContext {
  databaseName: string;
  fromVersion: number;
  toVersion: number;
  /**
   * Every row of every table as the old build wrote it, read from a connection that is still at the
   * old version. Call it (and finish any export) before the hook returns.
   */
  snapshot(): Promise<Record<string, unknown[]>>;
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

/** Read the existing database at whatever version it has, without declaring a schema. */
async function runMigrationHooks(name: string): Promise<void> {
  if (migrationHooks.size === 0) return;
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
      snapshot: async () => {
        const out: Record<string, unknown[]> = {};
        for (const table of probe.tables) out[table.name] = await table.toArray();
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

/**
 * Open the database. Without pre-migration hooks this is exactly `db.open()`: a Dexie promise, so a
 * liveQuery that triggers the open keeps tracking the tables it reads afterwards. With hooks the
 * open is shared between racing callers and the hooks run at most once per open.
 */
function openDatabase(db: StudyVaultDb): PromiseLike<unknown> {
  if (migrationHooks.size === 0) return db.open();
  let pending = opening.get(db);
  if (!pending) {
    pending = (async () => {
      await runMigrationHooks(db.name);
      await db.open();
    })().finally(() => opening.delete(db));
    opening.set(db, pending);
  }
  return pending;
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

/** Open the shared database if needed, run `fn`, and surface every failure as a StudyVaultError. */
export async function withDb<T>(fn: (db: StudyVaultDb) => Promise<T>): Promise<T> {
  try {
    const db = getDb();
    if (!db.isOpen()) await openDatabase(db);
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
async function assertNoNewerRows(db: StudyVaultDb): Promise<void> {
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

const DELETE_TIMEOUT_MS = 10_000;

/**
 * Close this context's connection and delete the whole database. Other contexts' Dexie
 * connections close themselves on the versionchange event and reopen lazily (empty) on next use.
 */
export async function deleteDatabase(): Promise<void> {
  closeDb();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const blocked = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new StudyVaultError(
            'storage_unavailable',
            'Another StudyVault window is still using the database. Close other StudyVault tabs and try again.',
          ),
        ),
      DELETE_TIMEOUT_MS,
    );
  });
  try {
    await Promise.race([Dexie.delete(DB_NAME), blocked]);
  } catch (err) {
    throw toStorageError(err);
  } finally {
    clearTimeout(timer);
  }
}

/** Test helper: close the connection and delete the whole database. */
export const resetDbForTests = deleteDatabase;
