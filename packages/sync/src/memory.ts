import type { AppliedChange, Row } from './merge.ts';
import type { Applier, OpLog, PendingOp, SyncStateStore } from './ports.ts';
import { ApplyRejectedError } from './ports.ts';
import type {
  ConflictRecord,
  EntityMeta,
  QuarantinedOp,
  SyncOperation,
  SyncState,
} from './schema.ts';

/**
 * In-memory reference implementations of the ports. They define the contract the Dexie versions must
 * meet, back the simulator and the unit tests, and let a host test its wiring without IndexedDB.
 */

interface LogEntry {
  op: SyncOperation;
  attempts: number;
  sentAt: number | null;
}

export function createMemoryOpLog(): OpLog & { all(): readonly LogEntry[] } {
  let entries: LogEntry[] = [];
  const pendingEntries = () => entries.filter((e) => e.sentAt === null);
  return {
    all: () => entries,
    async append(op) {
      entries.push({ op: structuredClone(op), attempts: 0, sentAt: null });
    },
    async pending(limit): Promise<PendingOp[]> {
      return pendingEntries()
        .slice(0, limit)
        .map((e) => ({ op: structuredClone(e.op), attempts: e.attempts }));
    },
    async unattemptedFor(entityType, entityId) {
      const hit = pendingEntries()
        .filter(
          (e) => e.attempts === 0 && e.op.entityType === entityType && e.op.entityId === entityId,
        )
        .at(-1);
      return hit ? { op: structuredClone(hit.op), attempts: hit.attempts } : null;
    },
    async replace(removeIds, op) {
      const ids = new Set(removeIds);
      const at = entries.findIndex((e) => ids.has(e.op.id));
      const attempts = at >= 0 ? (entries[at]?.attempts ?? 0) : 0;
      const index = at < 0 ? entries.length : at;
      const kept = entries.filter((e) => !ids.has(e.op.id));
      if (op) {
        const position = at < 0 ? kept.length : Math.min(index, kept.length);
        // Re-encrypting keeps the attempt count (same logical op); a coalesced op is brand new.
        kept.splice(position, 0, {
          op: structuredClone(op),
          attempts: removeIds.length === 1 && removeIds[0] === op.id ? attempts : 0,
          sentAt: null,
        });
      }
      entries = kept;
    },
    async countPending() {
      return pendingEntries().length;
    },
    async markAttempted(ids) {
      const set = new Set(ids);
      for (const e of entries) if (set.has(e.op.id)) e.attempts++;
    },
    async markSent(ids, at) {
      const set = new Set(ids);
      for (const e of entries) if (set.has(e.op.id)) e.sentAt = at;
    },
    async pruneSent(olderThan) {
      const before = entries.length;
      entries = entries.filter((e) => e.sentAt === null || e.sentAt >= olderThan);
      return before - entries.length;
    },
    async clear() {
      entries = [];
    },
  };
}

export function createMemoryStateStore(): SyncStateStore {
  let state: SyncState | null = null;
  let metas = new Map<string, EntityMeta>();
  let conflicts = new Map<string, ConflictRecord>();
  let quarantined = new Map<string, QuarantinedOp>();
  const key = (t: string, id: string) => `${t}\u0000${id}`;
  return {
    async loadState() {
      return state ? structuredClone(state) : null;
    },
    async saveState(s) {
      state = structuredClone(s);
    },
    async getMeta(t, id) {
      const m = metas.get(key(t, id));
      return m ? structuredClone(m) : null;
    },
    async putMeta(m) {
      metas.set(key(m.entityType, m.entityId), structuredClone(m));
    },
    async deleteMeta(t, id) {
      metas.delete(key(t, id));
    },
    async listTombstones(olderThan, limit) {
      return [...metas.values()]
        .filter((m) => m.tombstoneAt !== null && m.tombstoneAt < olderThan)
        .slice(0, limit)
        .map((m) => structuredClone(m));
    },
    async putConflict(c) {
      conflicts.set(c.id, structuredClone(c));
    },
    async getConflict(id) {
      const c = conflicts.get(id);
      return c ? structuredClone(c) : null;
    },
    async listConflicts(options) {
      return [...conflicts.values()]
        .filter((c) => !options?.unresolvedOnly || c.resolution === null)
        .map((c) => structuredClone(c));
    },
    async listConflictsFor(t, id) {
      return [...conflicts.values()]
        .filter((c) => c.entityType === t && c.entityId === id)
        .map((c) => structuredClone(c));
    },
    async deleteConflicts(ids) {
      for (const id of ids) conflicts.delete(id);
    },
    async putQuarantined(q) {
      quarantined.delete(q.id);
      quarantined.set(q.id, structuredClone(q));
    },
    async listQuarantined() {
      return [...quarantined.values()].map((q) => structuredClone(q));
    },
    async deleteQuarantined(id) {
      quarantined.delete(id);
    },
    async clearAll() {
      state = null;
      metas = new Map();
      conflicts = new Map();
      quarantined = new Map();
    },
  };
}

export interface MemoryApplierOptions {
  /** Device-local defaults a create must supply (the host's schemaVersion, resolve status...). */
  defaults?: (entityType: string) => Row;
  /** Table-schema check: return an error message to refuse the merged row (quarantines the op). */
  validate?: (entityType: string, row: Row) => string | null;
}

/** Rows keyed by entityType then entityId. `apply` is the contract a Dexie Applier must keep. */
export function createMemoryApplier(options: MemoryApplierOptions = {}): Applier & {
  tables: Map<string, Map<string, Row>>;
  put(entityType: string, entityId: string, row: Row): void;
  get(entityType: string, entityId: string): Row | undefined;
} {
  const tables = new Map<string, Map<string, Row>>();
  const table = (t: string) => {
    let m = tables.get(t);
    if (!m) tables.set(t, (m = new Map()));
    return m;
  };
  return {
    tables,
    put(t, id, row) {
      table(t).set(id, structuredClone(row));
    },
    get(t, id) {
      const r = tables.get(t)?.get(id);
      return r ? structuredClone(r) : undefined;
    },
    async read(t, id) {
      const r = tables.get(t)?.get(id);
      return r ? structuredClone(r) : null;
    },
    async apply(change: AppliedChange) {
      const rows = table(change.entityType);
      if (change.deleted) {
        rows.delete(change.entityId);
        return;
      }
      const current = rows.get(change.entityId);
      const next: Row =
        change.create || !current
          ? { ...(options.defaults?.(change.entityType) ?? {}) }
          : structuredClone(current);
      Object.assign(next, structuredClone(change.fields));
      for (const [f, members] of Object.entries(change.sets)) next[f] = [...members];
      const problem = options.validate?.(change.entityType, next) ?? null;
      if (problem) throw new ApplyRejectedError('schema_invalid', problem);
      rows.set(change.entityId, next);
    },
  };
}
