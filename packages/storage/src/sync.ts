import Dexie, { type IndexableType, type Table } from 'dexie';
import { uuidv7 } from 'uuidv7';
import { z } from 'zod';
import { getSettings, watchSettings } from '@runtime';
import { SCHEMA_VERSION, StudyVaultError, type TableRegistry, type TableSpec } from '@shared';
import {
  ApplyRejectedError,
  ConflictRecord,
  FieldName,
  ImmutableFieldError,
  NotSerialisableError,
  QuarantinedOp,
  STUDYVAULT_SYNC_POLICY,
  SyncEngine,
  SyncQueueFullError,
  TransportError,
  backfillChanges,
  checkPolicy,
  decodeEntityId,
  encodeEntityId,
  isAlive,
  isJsonValue,
  policyFromRegistry,
  presentMembers,
  resolvePolicy,
  stableStringify,
  syncableTables,
  type AppliedChange,
  type Applier,
  type Clock,
  type EntityMeta,
  type LocalChange,
  type OpLog,
  type PayloadCodec,
  type PendingOp,
  type ResolvedPolicy,
  type SyncOperation,
  type SyncOptions,
  type SyncPolicy,
  type SyncState,
  type SyncStateStore,
  type Transport,
} from '@sync';
import { sha256Hex } from '@sync/sha256';
import {
  NEWER_DATA_MESSAGE,
  assertNoNewerRows,
  getDb,
  setConnectionGate,
  suppressSyncCapture,
  withDb,
  type MetaRow,
  type ObservedWrite,
  type StudyVaultDb,
  type WriteInterceptor,
} from './db';
import { tableRegistry, unregisteredTables } from './registry';
import { isNewerRow, normaliseRow } from './rows';

/**
 * Storage side of optional synchronisation. `@sync` is pure: it asks for an outbox, a state store and
 * an applier. This module is those three on Dexie, plus the two pieces that make the engine usable
 * without touching any repository:
 *
 *  - CAPTURE. A DBCore middleware (db.ts) reports every successful write to a synchronised table,
 *    inside the writing transaction, with the row before and after. Bulk operations, `modify` and
 *    soft deletes are all `mutate` requests, so one place sees them all. It exists only while
 *    Settings.features.sync is on in that context; the sync applier's own writes are excluded.
 *  - RECONCILE. Per-field fingerprints are kept next to each entity's merge metadata. Whatever
 *    changed while capture was not running (first enable, sync switched off for a while, a restore)
 *    is found by comparing rows with those fingerprints and recorded as ordinary operations, before
 *    anything is pulled, so a remote change can never silently replace an unsent local edit.
 *
 * Nothing here runs while the flag is off: the connection gate reads the flag once per connection,
 * and the interceptor is installed only when it is on.
 */

// ---------------------------------------------------------------------------------------------
// Keys of the device-local rows kept in `meta`
// ---------------------------------------------------------------------------------------------

const META_STATE = 'sync.state';
const META_CLIENT = 'sync.clientId';
const META_DIRTY = 'sync.dirty';

const nowIso = () => new Date().toISOString();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTable = Table<any, any, any>;

async function putMetaRow(db: StudyVaultDb, key: string, value: unknown): Promise<void> {
  await db.meta.put({ key, value, updatedAt: nowIso() } satisfies MetaRow);
}

// ---------------------------------------------------------------------------------------------
// Raw IndexedDB access for the bookkeeping stores
//
// Capture runs inside someone else's Dexie transaction. Dexie keeps its transaction zone (and the
// write lock of modify/update/delete) only across awaits it can see, so a native await chain using
// Dexie's table API from there can wait for a lock its own caller holds. The bookkeeping stores are
// therefore read and written with plain IDBObjectStore calls on the transaction itself, which has
// no such state. Entity rows are only ever READ through the same transaction.
// ---------------------------------------------------------------------------------------------

function wrap<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

/** Run `fn` on `tx` when bound to a transaction, else in a new one over `stores`. */
async function inTx<T>(
  db: StudyVaultDb,
  tx: IDBTransaction | undefined,
  stores: readonly string[],
  mode: IDBTransactionMode,
  fn: (tx: IDBTransaction) => Promise<T>,
): Promise<T> {
  if (tx) return fn(tx);
  if (!db.isOpen()) await db.open();
  const own = db.backendDB().transaction([...new Set(stores)], mode);
  const finished = new Promise<void>((resolve, reject) => {
    own.oncomplete = () => resolve();
    own.onabort = () => reject(own.error ?? new Error('The transaction was aborted'));
    own.onerror = () => reject(own.error ?? new Error('The transaction failed'));
  });
  finished.catch(() => undefined);
  try {
    const out = await fn(own);
    await finished;
    return out;
  } catch (e) {
    try {
      own.abort();
    } catch {
      /* already finished */
    }
    throw e;
  }
}

const BOOKKEEPING_STORES = ['syncOps', 'syncEntityMeta', 'syncQuarantine', 'meta'] as const;

// ---------------------------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------------------------

export class SyncPolicyDriftError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`The sync policy no longer matches the table schemas: ${issues.join('; ')}`);
    this.name = 'SyncPolicyDriftError';
  }
}

export interface ActiveSyncPolicy {
  /** Policy specialised to the registry (derived fields local, schema as the field allow-list). */
  policy: SyncPolicy;
  /** Tables that take part, with their registry specs. */
  tables: readonly TableSpec[];
  /** Policy tables left out because their owner has not registered a schema yet. */
  notSynced: readonly string[];
}

/**
 * The policy that is actually used. A table whose schema is still the placeholder (its module has
 * not registered one) is left out: its fields cannot be validated, so exchanging it would be a
 * guess. A policy that names a field the schema does not have fails loudly (`SyncPolicyDriftError`)
 * instead of merging a renamed text field last-writer-wins.
 */
export function activeSyncPolicy(
  registry: TableRegistry = tableRegistry,
  base: SyncPolicy = STUDYVAULT_SYNC_POLICY,
  unregistered: readonly string[] = unregisteredTables(),
): ActiveSyncPolicy {
  const skip = new Set(unregistered);
  const registered = Object.fromEntries(
    Object.entries(base).filter(([table]) => !skip.has(table)),
  ) as SyncPolicy;
  const issues = checkPolicy(registry, registered);
  if (issues.length > 0) throw new SyncPolicyDriftError(issues);
  const policy = policyFromRegistry(registry, registered);
  return {
    policy,
    tables: syncableTables(registry, policy),
    notSynced: Object.keys(base).filter((t) => skip.has(t)),
  };
}

// ---------------------------------------------------------------------------------------------
// Fingerprints
// ---------------------------------------------------------------------------------------------

/**
 * What the engine would put on the wire for `row` (see engine `syncRow`), hashed per field. Set
 * fields are left out: their membership state lives in the merge metadata itself.
 */
export function fieldHashes(
  row: Record<string, unknown>,
  policy: ResolvedPolicy,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(row)) {
    const v = row[key];
    if (v === undefined || policy.local.has(key) || policy.sets.has(key)) continue;
    if (policy.fields && !policy.fields.has(key)) continue;
    if (!FieldName.safeParse(key).success || !isJsonValue(v)) continue;
    out[key] = sha256Hex(stableStringify(v)).slice(0, 16);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------------------------

/** One outbox row. `op` is the whole SyncOperation; the rest is index/bookkeeping. */
export interface SyncOpRow {
  id: string;
  seq: number;
  entityType: string;
  entityId: string;
  clientId: string;
  createdAt: string;
  sentAt: number | null;
  attempts: number;
  pending: 0 | 1;
  op: SyncOperation;
}

type MetaRecord = EntityMeta & { hf?: Record<string, string> };

// ---------------------------------------------------------------------------------------------
// OpLog
// ---------------------------------------------------------------------------------------------

export function createDexieOpLog(db: StudyVaultDb, tx?: IDBTransaction): OpLog {
  const S = 'syncOps';
  const toRow = (op: SyncOperation, seq: number, attempts: number): SyncOpRow => ({
    id: op.id,
    seq,
    entityType: op.entityType,
    entityId: op.entityId,
    clientId: op.clientId,
    createdAt: op.createdAt,
    sentAt: null,
    attempts,
    pending: 1,
    op,
  });
  const lastSeq = async (store: IDBObjectStore) => {
    const cursor = await wrap(store.index('seq').openCursor(null, 'prev'));
    return cursor ? (cursor.key as number) : 0;
  };
  const pendingRange = IDBKeyRange.bound([1, -Infinity], [1, Infinity]);
  return {
    append: (op) =>
      inTx(db, tx, [S], 'readwrite', async (t) => {
        const store = t.objectStore(S);
        await wrap(store.put(toRow(op, (await lastSeq(store)) + 1, 0)));
      }),
    pending: (limit) =>
      inTx(db, tx, [S], 'readonly', async (t) => {
        const rows = await wrap<SyncOpRow[]>(
          t.objectStore(S).index('[pending+seq]').getAll(pendingRange, limit),
        );
        return rows.map((r): PendingOp => ({ op: r.op, attempts: r.attempts }));
      }),
    unattemptedFor: (entityType, entityId) =>
      inTx(db, tx, [S], 'readonly', async (t) => {
        const rows = await wrap<SyncOpRow[]>(
          t.objectStore(S).index('[entityType+entityId]').getAll([entityType, entityId]),
        );
        const last = rows
          .filter((r) => r.pending === 1 && r.attempts === 0)
          .sort((a, b) => a.seq - b.seq)
          .at(-1);
        return last ? { op: last.op, attempts: last.attempts } : null;
      }),
    replace: (removeIds, op) =>
      inTx(db, tx, [S], 'readwrite', async (t) => {
        const store = t.objectStore(S);
        const found: SyncOpRow[] = [];
        for (const id of removeIds) {
          const row = await wrap<SyncOpRow | undefined>(store.get(id));
          if (row) found.push(row);
        }
        for (const id of removeIds) await wrap(store.delete(id));
        if (!op) return;
        const seq =
          found.length > 0 ? Math.min(...found.map((r) => r.seq)) : (await lastSeq(store)) + 1;
        // Re-encrypting the same operation keeps its attempt count; a coalesced one is new.
        const same = removeIds.length === 1 && removeIds[0] === op.id;
        await wrap(store.put(toRow(op, seq, same ? (found[0]?.attempts ?? 0) : 0)));
      }),
    countPending: () =>
      inTx(db, tx, [S], 'readonly', (t) =>
        wrap(t.objectStore(S).index('[pending+seq]').count(pendingRange)),
      ),
    markAttempted: (ids) =>
      inTx(db, tx, [S], 'readwrite', async (t) => {
        const store = t.objectStore(S);
        for (const id of ids) {
          const row = await wrap<SyncOpRow | undefined>(store.get(id));
          if (row) await wrap(store.put({ ...row, attempts: row.attempts + 1 }));
        }
      }),
    markSent: (ids, at) =>
      inTx(db, tx, [S], 'readwrite', async (t) => {
        const store = t.objectStore(S);
        for (const id of ids) {
          const row = await wrap<SyncOpRow | undefined>(store.get(id));
          if (row) await wrap(store.put({ ...row, sentAt: at, pending: 0 }));
        }
      }),
    pruneSent: (olderThan) =>
      inTx(db, tx, [S], 'readwrite', async (t) => {
        const store = t.objectStore(S);
        const keys = await wrap<IDBValidKey[]>(
          store.index('sentAt').getAllKeys(IDBKeyRange.upperBound(olderThan, true)),
        );
        for (const key of keys) await wrap(store.delete(key));
        return keys.length;
      }),
    clear: () =>
      inTx(db, tx, [S], 'readwrite', async (t) => {
        await wrap(t.objectStore(S).clear());
      }),
  };
}

// ---------------------------------------------------------------------------------------------
// SyncStateStore
// ---------------------------------------------------------------------------------------------

function entityKey(spec: TableSpec, entityId: string): IDBValidKey {
  const parts = decodeEntityId(spec.primaryKey, entityId);
  if (!parts) throw new ApplyRejectedError('schema_invalid', `Malformed entity id ${entityId}`);
  const shape = (spec.schema as { shape?: Record<string, { _zod?: { def?: { type?: string } } }> })
    .shape;
  const values = (typeof spec.primaryKey === 'string' ? [spec.primaryKey] : spec.primaryKey).map(
    (field) => {
      const raw = parts[field]!;
      return shape?.[field]?._zod?.def?.type === 'number' && raw.trim() !== '' && !isNaN(+raw)
        ? Number(raw)
        : raw;
    },
  );
  return (typeof spec.primaryKey === 'string' ? values[0] : values) as IDBValidKey;
}

function stripHashes(row: MetaRecord | undefined): EntityMeta | null {
  if (!row) return null;
  const { hf: _hf, ...meta } = row;
  return meta as EntityMeta;
}

function parseAll<X>(
  schema: { safeParse(v: unknown): { success: boolean; data?: unknown } },
  rows: readonly unknown[],
): X[] {
  return rows.flatMap((r) => {
    const parsed = schema.safeParse(r);
    return parsed.success ? [parsed.data as X] : [];
  });
}

export function createDexieStateStore(
  db: StudyVaultDb,
  active: ActiveSyncPolicy,
  tx?: IDBTransaction,
): SyncStateStore {
  const specs = new Map(active.tables.map((s) => [s.name, s] as const));
  const resolved = new Map(Object.entries(active.policy).map(([n, p]) => [n, resolvePolicy(p)]));
  const M = 'syncEntityMeta';
  const C = 'syncConflicts';
  const Q = 'syncQuarantine';
  const T = 'meta';

  const writeState = async (t: IDBTransaction, value: unknown) => {
    await wrap(
      t.objectStore(T).put({ key: META_STATE, value, updatedAt: nowIso() } satisfies MetaRow),
    );
  };

  return {
    loadState: () =>
      inTx(db, tx, [T], 'readonly', async (t) => {
        const row = await wrap<MetaRow | undefined>(t.objectStore(T).get(META_STATE));
        return (row?.value ?? null) as SyncState | null;
      }),
    saveState: (state) =>
      inTx(db, tx, [T], 'readwrite', async (t) => {
        await writeState(t, state);
      }),
    getMeta: (entityType, entityId) =>
      inTx(db, tx, [M], 'readonly', async (t) =>
        stripHashes(
          await wrap<MetaRecord | undefined>(t.objectStore(M).get([entityType, entityId])),
        ),
      ),
    putMeta: (next) => {
      const spec = specs.get(next.entityType);
      return inTx(db, tx, [M, T, ...(spec ? [spec.name] : [])], 'readwrite', async (t) => {
        const existing = await wrap<MetaRecord | undefined>(
          t.objectStore(M).get([next.entityType, next.entityId]),
        );
        if (existing && existing.revision > next.revision) {
          // A local edit committed between the engine reading this entity and writing it back:
          // keep the newer metadata and pull again, so the remote operation is merged onto it.
          const row = await wrap<MetaRow | undefined>(t.objectStore(T).get(META_STATE));
          if (row && typeof row.value === 'object' && row.value !== null) {
            await writeState(t, { ...(row.value as object), needsResync: true });
          }
          return;
        }
        let hf: Record<string, string> = {};
        const policy = resolved.get(next.entityType);
        if (spec && policy) {
          const row = await wrap<Record<string, unknown> | undefined>(
            t.objectStore(spec.name).get(entityKey(spec, next.entityId)),
          );
          if (row) hf = fieldHashes(row, policy);
        }
        await wrap(t.objectStore(M).put({ ...next, hf }));
      });
    },
    deleteMeta: (entityType, entityId) =>
      inTx(db, tx, [M], 'readwrite', async (t) => {
        await wrap(t.objectStore(M).delete([entityType, entityId]));
      }),
    listTombstones: (olderThan, limit) =>
      inTx(db, tx, [M], 'readonly', async (t) => {
        const rows = await wrap<MetaRecord[]>(
          t
            .objectStore(M)
            .index('tombstoneAt')
            .getAll(IDBKeyRange.upperBound(olderThan, true), limit),
        );
        return rows.map((r) => stripHashes(r)!);
      }),
    putConflict: (conflict) =>
      inTx(db, tx, [C], 'readwrite', async (t) => {
        await wrap(t.objectStore(C).put(conflict));
      }),
    getConflict: (id) =>
      inTx(db, tx, [C], 'readonly', async (t) => {
        const parsed = ConflictRecord.safeParse(await wrap(t.objectStore(C).get(id)));
        return parsed.success ? parsed.data : null;
      }),
    listConflicts: (options) =>
      inTx(db, tx, [C], 'readonly', async (t) => {
        const rows = await wrap<unknown[]>(t.objectStore(C).index('detectedAt').getAll());
        const all = parseAll<ConflictRecord>(ConflictRecord, rows);
        return options?.unresolvedOnly ? all.filter((c) => c.resolution === null) : all;
      }),
    listConflictsFor: (entityType, entityId) =>
      inTx(db, tx, [C], 'readonly', async (t) =>
        parseAll<ConflictRecord>(
          ConflictRecord,
          await wrap<unknown[]>(
            t.objectStore(C).index('[entityType+entityId]').getAll([entityType, entityId]),
          ),
        ),
      ),
    deleteConflicts: (ids) =>
      inTx(db, tx, [C], 'readwrite', async (t) => {
        for (const id of ids) await wrap(t.objectStore(C).delete(id));
      }),
    putQuarantined: (item) =>
      inTx(db, tx, [Q], 'readwrite', async (t) => {
        await wrap(t.objectStore(Q).put(item));
      }),
    listQuarantined: () =>
      inTx(db, tx, [Q], 'readonly', async (t) =>
        parseAll<QuarantinedOp>(
          QuarantinedOp,
          await wrap<unknown[]>(t.objectStore(Q).index('at').getAll()),
        ),
      ),
    deleteQuarantined: (id) =>
      inTx(db, tx, [Q], 'readwrite', async (t) => {
        await wrap(t.objectStore(Q).delete(id));
      }),
    clearAll: () =>
      inTx(db, tx, [M, C, Q, T], 'readwrite', async (t) => {
        await wrap(t.objectStore(M).clear());
        await wrap(t.objectStore(C).clear());
        await wrap(t.objectStore(Q).clear());
        await wrap(t.objectStore(T).delete(META_STATE));
      }),
  };
}

async function readConflicts(
  table: AnyTable,
  options?: { unresolvedOnly?: boolean },
): Promise<ConflictRecord[]> {
  const rows = (await table.orderBy('detectedAt').toArray()) as unknown[];
  const all = parseAll<ConflictRecord>(ConflictRecord, rows); // an unreadable record is skipped
  return options?.unresolvedOnly ? all.filter((c) => c.resolution === null) : all;
}

async function readQuarantine(table: AnyTable): Promise<QuarantinedOp[]> {
  return parseAll<QuarantinedOp>(QuarantinedOp, (await table.orderBy('at').toArray()) as unknown[]);
}

/** Conflicts, oldest first (reads only, so it is safe inside a live query). */
export function listSyncConflicts(
  options: { unresolvedOnly?: boolean } = {},
): Promise<ConflictRecord[]> {
  return withDb((db) => readConflicts(db.syncConflicts, options));
}

/** Remote operations and local rows that were not exchanged, oldest first. */
export function listSyncQuarantine(): Promise<QuarantinedOp[]> {
  return withDb((db) => readQuarantine(db.syncQuarantine));
}

export function countSyncAttention(): Promise<{ conflicts: number; quarantined: number }> {
  return withDb(async (db) => ({
    conflicts: (await readConflicts(db.syncConflicts, { unresolvedOnly: true })).length,
    quarantined: await db.syncQuarantine.count(),
  }));
}

// ---------------------------------------------------------------------------------------------
// Applier
// ---------------------------------------------------------------------------------------------

/** Device-local fields a created row needs (the engine never sends them; see policy `local`). */
export function localDefaults(entityType: string): Record<string, unknown> {
  const base: Record<string, unknown> = { schemaVersion: SCHEMA_VERSION };
  if (entityType === 'highlights') {
    base.resolveStatus = 'unchecked';
    base.resolveConfidence = null;
    base.lastResolvedAt = null;
  }
  return base;
}

export function createDexieApplier(db: StudyVaultDb, active: ActiveSyncPolicy): Applier {
  const specs = new Map(active.tables.map((s) => [s.name, s] as const));
  const specOf = (entityType: string): TableSpec => {
    const spec = specs.get(entityType);
    if (!spec) throw new ApplyRejectedError('unknown_entity_type', `Unknown ${entityType}`);
    return spec;
  };
  return {
    async read(entityType, entityId) {
      const spec = specOf(entityType);
      const row = await db.table(spec.name).get(entityKey(spec, entityId) as IndexableType);
      return (row ?? null) as Record<string, unknown> | null;
    },
    async apply(change: AppliedChange) {
      const spec = specOf(change.entityType);
      const key = entityKey(spec, change.entityId);
      await assertNoNewerRows(db);
      const table = db.table(spec.name);
      await db.transaction('rw', table, async (tx) => {
        // A remote change is not a local edit: do not echo it back as one.
        suppressSyncCapture(tx);
        if (change.deleted) {
          await table.delete(key as IndexableType);
          return;
        }
        const existing = (await table.get(key as IndexableType)) as
          Record<string, unknown> | undefined;
        if (existing && isNewerRow(existing)) {
          throw new StudyVaultError('storage_unavailable', NEWER_DATA_MESSAGE);
        }
        // Defaults only for fields this table has (membership rows carry no schemaVersion).
        const shape = (spec.schema as { shape?: Record<string, unknown> }).shape;
        const defaults = Object.fromEntries(
          Object.entries(localDefaults(change.entityType)).filter(
            ([field]) => shape === undefined || field in shape,
          ),
        );
        const next: Record<string, unknown> =
          existing && !change.create ? { ...existing } : { ...defaults, ...(existing ?? {}) };
        Object.assign(next, change.fields);
        for (const [field, members] of Object.entries(change.sets)) next[field] = [...members];

        // The wire has no "absent": a JSON null may stand for a field that no longer exists. Keep
        // it where the schema accepts null, drop exactly the optional fields that reject it.
        let verdict = spec.schema.safeParse(normaliseRow(next));
        for (let round = 0; round < 2 && !verdict.success; round++) {
          const rejected = verdict.error.issues
            .map((i) => i.path[0])
            .filter(
              (f): f is string =>
                typeof f === 'string' && next[f] === null && change.fields[f] === null,
            );
          if (rejected.length === 0) break;
          for (const field of rejected) delete next[field];
          verdict = spec.schema.safeParse(normaliseRow(next));
        }
        if (!verdict.success) {
          throw new ApplyRejectedError(
            'schema_invalid',
            verdict.error.issues
              .slice(0, 3)
              .map((i) => `${i.path.join('.')}: ${i.message}`)
              .join('; '),
          );
        }
        await table.put(next);
      });
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------------------------

/** This installation's id (UUIDv7), created once. Never part of a backup. */
export async function ensureClientId(db: StudyVaultDb = getDb()): Promise<string> {
  return db.transaction('rw', db.meta, async () => {
    const row = await db.meta.get(META_CLIENT);
    if (typeof row?.value === 'string' && row.value.length >= 8) return row.value;
    const id = uuidv7();
    await putMetaRow(db, META_CLIENT, id);
    return id;
  });
}

/**
 * Call after data was replaced behind sync's back (a profile import, a database copy): new client
 * id, so operations from the old identity are not mistaken for this device's own, and a clean
 * start for the bookkeeping. The next enable reconciles the rows with the server.
 */
export async function resetSyncIdentity(db: StudyVaultDb = getDb()): Promise<string> {
  const id = uuidv7();
  await db.transaction(
    'rw',
    [db.meta, db.syncOps, db.syncEntityMeta, db.syncConflicts, db.syncQuarantine] as AnyTable[],
    async () => {
      await db.syncOps.clear();
      await db.syncEntityMeta.clear();
      await db.syncConflicts.clear();
      await db.syncQuarantine.clear();
      await db.meta.delete(META_STATE);
      await putMetaRow(db, META_CLIENT, id);
    },
  );
  return id;
}

/**
 * A restore replaced this database's rows wholesale. When the database has a sync identity (sync was
 * switched on here at some point), start a new one: the replaced rows are not a series of local
 * edits, so the old bookkeeping must not turn the rows the backup lacks into tombstones, and the old
 * history must not be mistaken for this device's own. The next run re-sends what is stored and
 * pulls the account's history again. Null when this database never synchronised.
 *
 * Call inside the restore transaction, whose scope must include `meta` and the four bookkeeping
 * tables (syncOps, syncEntityMeta, syncConflicts, syncQuarantine): the reset then commits or rolls
 * back with the restore.
 */
export async function resetSyncIdentityIfUsed(db: StudyVaultDb): Promise<string | null> {
  if ((await db.meta.get(META_CLIENT)) === undefined) return null;
  return resetSyncIdentity(db);
}

/** The client id stored right now: another context may have replaced it behind this one's back. */
async function storedClientId(tx: IDBTransaction): Promise<string | undefined> {
  const row = (await wrap(tx.objectStore('meta').get(META_CLIENT))) as MetaRow | undefined;
  return typeof row?.value === 'string' && row.value.length >= 8 ? row.value : undefined;
}

// ---------------------------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------------------------

const noTransport: Transport = {
  async push() {
    throw new TransportError('client', 'This engine only records changes.');
  },
  async pull() {
    throw new TransportError('client', 'This engine only records changes.');
  },
};

/** An engine with its ports bound to one transaction (or free), and what needs the same binding. */
interface Bound {
  engine: SyncEngine;
  log: OpLog;
  store: SyncStateStore;
  /** Why a local row was kept out of the exchange, shown in the quarantine list. */
  noteLocalOnly(
    entityType: string,
    entityId: string,
    reason: 'immutable_field' | 'invalid_op',
    detail: string,
  ): Promise<void>;
  /** Remember that rows may differ from their fingerprints: the next run reconciles first. */
  markDirty(): Promise<void>;
}

/**
 * Record one change with the engine, turning "this row cannot be exchanged" into a visible note
 * instead of failing the user's write: sync is optional and must never make the vault unusable.
 * Returns false when the outbox is full (the caller may stop).
 */
async function recordSafely(bound: Bound, change: LocalChange): Promise<boolean> {
  try {
    await bound.engine.recordLocalChange(change);
    return true;
  } catch (e) {
    if (e instanceof ImmutableFieldError) {
      await bound.noteLocalOnly(
        change.entityType,
        change.entityId,
        'immutable_field',
        `${e.field} is source provenance and was changed on this device. The change stays here and is not sent.`,
      );
      return true;
    }
    if (e instanceof NotSerialisableError) {
      await bound.noteLocalOnly(
        change.entityType,
        change.entityId,
        'invalid_op',
        `${e.field} cannot be prepared for sync.`,
      );
      return true;
    }
    if (e instanceof SyncQueueFullError) {
      // The write itself stands. This change is not in the outbox, so remember to find it by
      // fingerprint once the queue has drained (a re-pull alone would not send it).
      await bound.markDirty();
      await bound.engine.markNeedsResync();
      return false;
    }
    if (e instanceof z.ZodError) {
      // A value the wire format cannot carry (a set member over its limit, too many fields ...).
      await bound.noteLocalOnly(
        change.entityType,
        change.entityId,
        'invalid_op',
        `This item does not fit the sync format: ${e.issues[0]?.message ?? 'invalid value'}.`,
      );
      return true;
    }
    throw e;
  }
}

export interface SyncRuntimeOptions {
  db?: StudyVaultDb;
  /** Reads Settings.features.sync (cached by the caller). */
  isEnabled(): boolean | Promise<boolean>;
  transport?: Transport;
  codec?: PayloadCodec;
  /** OIDC subject of the signed-in account, null when signed out. */
  accountId?(): string | null | Promise<string | null>;
  clock?: Clock;
  newId?(): string;
  random?(): number;
  options?: Partial<SyncOptions>;
  registry?: TableRegistry;
  policy?: SyncPolicy;
  unregistered?: readonly string[];
}

export interface ReconcileResult {
  /** Entities that had never been sent: recorded as creates. */
  created: number;
  /** Known entities whose fields changed while capture was not running. */
  changed: number;
  /** Known entities whose row is gone. */
  deleted: number;
  /** The outbox filled up: sync, then call again. */
  incomplete: boolean;
}

export interface SyncRuntime {
  readonly engine: SyncEngine;
  readonly db: StudyVaultDb;
  readonly clientId: string;
  readonly active: ActiveSyncPolicy;
  readonly log: OpLog;
  readonly store: SyncStateStore;
  readonly applier: Applier;
  /** Install the write interceptor on this connection (idempotent). */
  startCapture(): void;
  stopCapture(): void;
  /** Record what changed while capture was not running. */
  reconcile(): Promise<ReconcileResult>;
  /** True when a write was missed since the last reconcile. */
  isDirty(): Promise<boolean>;
  /**
   * False once the stored client id is no longer this runtime's (a restore started a new identity):
   * a long-lived holder must create a new runtime instead of sending under the old one.
   */
  isCurrent(): Promise<boolean>;
  /**
   * The server lost this device's data (or the user chose to start over): send every row again.
   * Re-sent snapshots carry fresh clocks, see engine `acknowledgeServerReset`.
   */
  resendAll(): Promise<{ queued: number }>;
  /** Attach this device's data to another account: forgets sync bookkeeping, then reconciles. */
  rebind(): Promise<ReconcileResult>;
}

export async function createSyncRuntime(o: SyncRuntimeOptions): Promise<SyncRuntime> {
  const db = o.db ?? getDb();
  if (!db.isOpen()) await db.open();
  const active = activeSyncPolicy(o.registry, o.policy, o.unregistered);
  const clientId = await ensureClientId(db);
  const resolved = new Map(Object.entries(active.policy).map(([n, p]) => [n, resolvePolicy(p)]));
  const registry: TableRegistry = {
    schemaVersion: (o.registry ?? tableRegistry).schemaVersion,
    tables: active.tables,
  };
  const applier = createDexieApplier(db, active);

  const bind = (tx?: IDBTransaction, id: string = clientId): Bound => {
    const log = createDexieOpLog(db, tx);
    const store = createDexieStateStore(db, active, tx);
    const engine = new SyncEngine({
      clientId: id,
      policy: active.policy,
      isEnabled: o.isEnabled,
      log,
      store,
      transport: o.transport ?? noTransport,
      applier,
      clock: o.clock ?? { now: () => Date.now() },
      newId: o.newId ?? uuidv7,
      ...(o.codec ? { codec: o.codec } : {}),
      ...(o.accountId ? { accountId: o.accountId } : {}),
      ...(o.random ? { random: o.random } : {}),
      ...(o.options ? { options: o.options } : {}),
    });
    return {
      engine,
      log,
      store,
      markDirty: () =>
        inTx(db, tx, ['meta'], 'readwrite', async (t) => {
          await wrap(
            t.objectStore('meta').put({ key: META_DIRTY, value: nowIso(), updatedAt: nowIso() }),
          );
        }),
      noteLocalOnly: (entityType, entityId, reason, detail) =>
        inTx(db, tx, ['syncQuarantine'], 'readwrite', async (t) => {
          await wrap(
            t.objectStore('syncQuarantine').put({
              id: `local:${entityType}:${entityId}`,
              entityType,
              entityId,
              reason,
              detail: detail.slice(0, 480),
              at: Date.now(),
              op: null,
            }),
          );
        }),
    };
  };
  const main = bind();
  const specs = new Map(active.tables.map((s) => [s.name, s] as const));

  const interceptor: WriteInterceptor = {
    tables: new Set(specs.keys()),
    scope: BOOKKEEPING_STORES,
    async record(table, writes: readonly ObservedWrite[], trans) {
      const spec = specs.get(table);
      if (!spec) return;
      const raw = trans as unknown as IDBTransaction;
      // Whatever identity is stored now, so a restore's new one reaches every context at its next write.
      const bound = bind(raw, (await storedClientId(raw)) ?? clientId);
      for (const write of writes) {
        const row = write.after ?? write.before;
        if (!row) continue;
        let entityId: string;
        try {
          entityId = encodeEntityId(spec.primaryKey, row);
        } catch {
          continue; // a row without its key cannot have been written
        }
        await recordSafely(
          bound,
          write.after
            ? {
                kind: 'upsert',
                entityType: table,
                entityId,
                before: write.before,
                after: write.after,
              }
            : { kind: 'delete', entityType: table, entityId, before: write.before },
        );
      }
    },
    missed() {
      // A transaction opened before sync was switched on wrote a synchronised table. Remember it:
      // the next run reconciles rows against their fingerprints before pulling anything.
      Dexie.ignoreTransaction(() => putMetaRow(db, META_DIRTY, nowIso())).catch(() => undefined);
    },
  };

  /** One entity per transaction: serialised against captures from other contexts. */
  const recordIn = async (spec: TableSpec, change: LocalChange): Promise<boolean> =>
    inTx(db, undefined, [...BOOKKEEPING_STORES, spec.name], 'readwrite', (t) =>
      recordSafely(bind(t), change),
    );

  const reconcile = async (): Promise<ReconcileResult> => {
    const result: ReconcileResult = { created: 0, changed: 0, deleted: 0, incomplete: false };
    await db.meta.delete(META_DIRTY);
    const finish = async (r: ReconcileResult) => {
      if (r.incomplete) await putMetaRow(db, META_DIRTY, nowIso());
      return r;
    };
    for (const spec of active.tables) {
      const policy = resolved.get(spec.name)!;
      const known = new Map(
        (
          (await db.syncEntityMeta.where('entityType').equals(spec.name).toArray()) as MetaRecord[]
        ).map((m) => [m.entityId, m] as const),
      );
      const seen = new Set<string>();
      const rows = (await db.table(spec.name).toArray()) as Array<Record<string, unknown>>;

      for (const row of rows) {
        let entityId: string;
        try {
          entityId = encodeEntityId(spec.primaryKey, row);
        } catch {
          continue;
        }
        seen.add(entityId);
        const meta = known.get(entityId);
        let change: LocalChange | null = null;
        let bucket: 'created' | 'changed' = 'changed';
        if (!meta || !meta.born || !meta.hf || !isAlive(meta)) {
          change = { kind: 'upsert', entityType: spec.name, entityId, before: null, after: row };
          bucket = !meta || !meta.born ? 'created' : 'changed';
        } else {
          const now = fieldHashes(row, policy);
          const was = meta.hf;
          const changedFields = [...new Set([...Object.keys(now), ...Object.keys(was)])].filter(
            (f) => now[f] !== was[f],
          );
          // The previous state as far as it is known: changed fields are left out (so the diff
          // contains them), removed ones are null, and set fields use the merge metadata's members.
          const before: Record<string, unknown> = { ...row };
          for (const f of changedFields) {
            if (f in now) delete before[f];
            else before[f] = null;
          }
          let setsChanged = false;
          for (const f of policy.sets) {
            const members = presentMembers(meta.sets[f] ?? {});
            before[f] = members;
            const next = Array.isArray(row[f]) ? (row[f] as unknown[]) : [];
            if (
              next.length !== members.length ||
              next.some((m) => typeof m !== 'string' || !members.includes(m))
            ) {
              setsChanged = true;
            }
          }
          if (changedFields.length > 0 || setsChanged) {
            change = { kind: 'upsert', entityType: spec.name, entityId, before, after: row };
          }
        }
        if (!change) continue;
        if (!(await recordIn(spec, change))) {
          result.incomplete = true;
          return finish(result);
        }
        result[bucket]++;
      }

      for (const [entityId, meta] of known) {
        if (seen.has(entityId) || !meta.born || !isAlive(meta)) continue;
        const gone: LocalChange = { kind: 'delete', entityType: spec.name, entityId, before: null };
        if (!(await recordIn(spec, gone))) {
          result.incomplete = true;
          return finish(result);
        }
        result.deleted++;
      }
    }
    return result;
  };

  return {
    engine: main.engine,
    db,
    clientId,
    active,
    log: main.log,
    store: main.store,
    applier,
    startCapture() {
      db.syncInterceptor = interceptor;
    },
    stopCapture() {
      db.syncInterceptor = null;
    },
    reconcile,
    async isDirty() {
      return (await db.meta.get(META_DIRTY)) !== undefined;
    },
    async isCurrent() {
      return (await db.meta.get(META_CLIENT))?.value === clientId;
    },
    async resendAll() {
      await main.engine.acknowledgeServerReset();
      let queued = 0;
      for (const spec of active.tables) {
        const rows = (await db.table(spec.name).toArray()) as Array<Record<string, unknown>>;
        for (const change of backfillChanges(registry, active.policy, spec.name, rows)) {
          if (!(await recordIn(spec, change))) return { queued };
          queued++;
        }
      }
      return { queued };
    },
    async rebind() {
      await main.engine.rebindAccount();
      return reconcile();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Per-connection activation (every extension context that can write)
// ---------------------------------------------------------------------------------------------

const captureRuntimes = new WeakMap<StudyVaultDb, Promise<SyncRuntime>>();

/**
 * Install capture on `db` (idempotent). Rejects, and installs nothing, when the policy has drifted
 * from the schemas: sync is then refused loudly rather than half-working.
 */
export function startSyncCapture(db: StudyVaultDb = getDb()): Promise<SyncRuntime> {
  let pending = captureRuntimes.get(db);
  if (!pending) {
    pending = createSyncRuntime({ db, isEnabled: () => db.syncInterceptor !== null }).then((rt) => {
      rt.startCapture();
      return rt;
    });
    captureRuntimes.set(db, pending);
    pending.catch(() => captureRuntimes.delete(db));
  }
  return pending;
}

export function stopSyncCapture(db: StudyVaultDb = getDb()): void {
  db.syncInterceptor = null;
  captureRuntimes.delete(db);
}

const gates = new WeakMap<StudyVaultDb, Promise<void>>();

async function initConnection(db: StudyVaultDb): Promise<void> {
  const sync = async (enabled: boolean) => {
    if (getDb() !== db) return; // a newer connection replaced this one
    if (enabled) await startSyncCapture(db);
    else stopSyncCapture(db);
  };
  try {
    // Only ever starts here: a context that has nothing to do (the flag is off) stays untouched.
    if ((await getSettings()).features.sync) await sync(true);
  } catch (err) {
    console.error('[StudyVault] sync capture could not start', err);
  }
  watchSettings((s) => {
    sync(s.features.sync).catch((err: unknown) =>
      console.error('[StudyVault] sync capture could not change state', err),
    );
  });
}

/**
 * Registered as the connection gate: before a context's first database call, find out once whether
 * sync is on. With the flag off this reads one settings key and installs nothing.
 */
setConnectionGate((db) => {
  let gate = gates.get(db);
  if (!gate) {
    gate = initConnection(db);
    gates.set(db, gate);
  }
  return gate;
});

/** Exposed so other restore-like flows can exclude their writes from capture. */
export { suppressSyncCapture } from './db';
