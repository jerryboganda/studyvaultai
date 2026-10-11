import { maxHlc } from './hlc.ts';
import type { JsonValue } from './json.ts';
import { deepEqual, stableStringify } from './json.ts';
import type { ResolvedPolicy } from './policy.ts';
import type {
  ConflictRecord,
  EntityMeta,
  OpPayload,
  RejectReason,
  SetDelta,
  SyncOperation,
} from './schema.ts';
import { LIMITS } from './schema.ts';
import { sha256Hex } from './sha256.ts';

/**
 * The merge function: pure, deterministic and order-independent.
 *
 * What converges (same operations in any order, with duplicates => same result):
 *  - every field's value and clock: last writer wins by hybrid logical clock;
 *  - every set member: present iff added and, if ever removed, re-added by someone who had seen the
 *    latest removal (a concurrent add loses: remove wins);
 *  - entity liveness: a delete wins over every upsert that had not observed it; an upsert that had
 *    observed it (a re-creation) wins back.
 * Conflict records are a side effect on top of that. They never change which value wins; they make
 * sure the losing side of a concurrent edit or a delete is still in the user's hands.
 */

export type Row = Record<string, JsonValue>;

/** What the host must write to its own storage after a successful merge. */
export interface AppliedChange {
  entityType: string;
  entityId: string;
  /** Remove the row (remove-wins tombstone). */
  deleted: boolean;
  /** The row does not exist locally: build it from `fields` (a full snapshot) and write it. */
  create: boolean;
  /** Fields to write: the winning values only (everything, for a create). */
  fields: Row;
  /** For each touched set-valued field, the complete resulting member list (replace). */
  sets: Record<string, string[]>;
}

export type MergeOutcome =
  | { kind: 'rejected'; reason: RejectReason; detail: string }
  /** A partial update for a row we do not have yet: wait for its creation. */
  | { kind: 'parked' }
  | { kind: 'merged'; meta: EntityMeta; change: AppliedChange | null; conflicts: ConflictRecord[] };

export interface MergeInput {
  meta: EntityMeta | null;
  op: SyncOperation;
  payload: OpPayload;
  /** Current local row restricted to syncable fields, or null when the row does not exist. */
  local: Row | null;
  policy: ResolvedPolicy;
  /** Epoch ms of the local clock. */
  now: number;
}

export function freshMeta(entityType: string, entityId: string): EntityMeta {
  return {
    entityType,
    entityId,
    revision: 0,
    vector: {},
    fields: {},
    sets: {},
    born: false,
    rm: null,
    ao: null,
    tombstoneAt: null,
    frozen: {},
  };
}

export function cloneMeta(meta: EntityMeta): EntityMeta {
  const copy = structuredClone(meta);
  copy.frozen ??= {}; // metadata persisted by an earlier build
  return copy;
}

const fingerprint = (value: JsonValue): string => sha256Hex(stableStringify(value));
const WHOLE_ROW = '*';

/**
 * The first immutable field of `set` whose value differs from what this entity was first seen with
 * (or "*" for an append-only row that is not an identical full snapshot), else null. Unlike the check
 * against the live row, this still holds after the row was deleted.
 */
export function frozenViolation(
  meta: EntityMeta,
  policy: ResolvedPolicy,
  set: Row,
  full: boolean,
): string | null {
  const frozen = meta.frozen ?? {};
  if (policy.appendOnly) {
    const seen = frozen[WHOLE_ROW];
    if (seen === undefined) return null;
    return full && fingerprint(set) === seen ? null : WHOLE_ROW;
  }
  for (const f of policy.immutable) {
    const seen = frozen[f];
    if (seen !== undefined && Object.hasOwn(set, f) && seen !== fingerprint(set[f]!)) return f;
  }
  return null;
}

function recordFrozen(meta: EntityMeta, policy: ResolvedPolicy, set: Row, full: boolean): void {
  meta.frozen ??= {};
  if (policy.appendOnly) {
    if (full && meta.frozen[WHOLE_ROW] === undefined) meta.frozen[WHOLE_ROW] = fingerprint(set);
    return;
  }
  for (const f of policy.immutable) {
    if (Object.hasOwn(set, f) && meta.frozen[f] === undefined)
      meta.frozen[f] = fingerprint(set[f]!);
  }
}

/** Live unless a tombstone exists that no upsert has observed (remove wins over concurrent edits). */
export function isAlive(meta: EntityMeta): boolean {
  return meta.born && (meta.rm === null || (meta.ao !== null && meta.ao >= meta.rm));
}

/** Greatest clock this device knows for the entity: every new local operation must exceed it. */
export function metaMaxClock(meta: EntityMeta): string | null {
  let max: string | null = maxHlc(meta.rm, meta.ao);
  for (const f of Object.values(meta.fields)) max = maxHlc(max, f.c);
  for (const set of Object.values(meta.sets)) {
    for (const m of Object.values(set)) max = maxHlc(maxHlc(max, m.rm), m.ao);
  }
  return max;
}

type MemberStates = Record<string, { has: boolean; rm: string | null; ao: string | null }>;

export function presentMembers(set: MemberStates): string[] {
  return Object.entries(set)
    .filter(([, s]) => s.has && (s.rm === null || (s.ao !== null && s.ao >= s.rm)))
    .map(([m]) => m)
    .sort();
}

function applySetDelta(
  meta: EntityMeta,
  field: string,
  delta: SetDelta,
  hlc: string,
  local: Row | null,
): void {
  const state = (meta.sets[field] ??= {});
  const existing = local?.[field];
  if (Array.isArray(existing)) {
    // Membership that predates sync (or was never recorded) counts as present, never as absent.
    for (const m of existing) {
      if (typeof m === 'string' && !Object.hasOwn(state, m)) {
        state[m] = { has: true, rm: null, ao: null };
      }
    }
  }
  for (const m of delta.add) {
    const s = Object.hasOwn(state, m) ? state[m]! : { has: false, rm: null, ao: null };
    s.has = true;
    s.ao = maxHlc(s.ao, delta.seen[m] ?? null);
    state[m] = s;
  }
  for (const m of delta.remove) {
    const s = Object.hasOwn(state, m) ? state[m]! : { has: false, rm: null, ao: null };
    s.rm = maxHlc(s.rm, hlc);
    state[m] = s;
  }
}

function ancestry(...lists: readonly (readonly string[])[]): string[] {
  const out: string[] = [];
  for (const l of lists) for (const c of l) if (c && !out.includes(c)) out.push(c);
  return out.slice(0, LIMITS.maxAncestry);
}

function bookkeeping(meta: EntityMeta, op: SyncOperation, payload: OpPayload, nowMs: number): void {
  meta.revision = Math.max(meta.revision, op.revision);
  meta.vector[op.clientId] = Math.max(meta.vector[op.clientId] ?? 0, op.revision);
  if (op.opType === 'delete') {
    meta.rm = maxHlc(meta.rm, op.hlc);
    const created = Date.parse(op.createdAt);
    meta.tombstoneAt = Math.min(Number.isFinite(created) ? created : nowMs, nowMs);
  } else {
    meta.born = true;
    meta.ao = maxHlc(meta.ao, payload.observed);
  }
}

/**
 * Metadata effect of an operation this device just created. The host has already written the row, so
 * there is nothing to apply and nothing to conflict with: only clocks and set states move.
 */
export function applyLocalToMeta(
  meta: EntityMeta,
  op: SyncOperation,
  payload: OpPayload,
  nowMs: number,
  policy: ResolvedPolicy,
): EntityMeta {
  const next = cloneMeta(meta);
  bookkeeping(next, op, payload, nowMs);
  if (op.opType === 'upsert') recordFrozen(next, policy, payload.set, payload.full);
  if (payload.full) {
    // A snapshot starts a new incarnation; receivers without the row reset the same way.
    next.fields = {};
    next.sets = {};
  }
  for (const f of Object.keys(payload.set)) {
    const cur = next.fields[f];
    next.fields[f] = {
      c: op.hlc,
      a: ancestry(payload.prev[f] ?? [], cur ? [cur.c, ...cur.a] : []),
    };
  }
  for (const [f, delta] of Object.entries(payload.sets))
    applySetDelta(next, f, delta, op.hlc, null);
  return next;
}

function textConflict(
  op: SyncOperation,
  field: string,
  localValue: JsonValue,
  localClock: string,
  remoteValue: JsonValue,
  base: JsonValue | undefined,
  now: number,
): ConflictRecord {
  return {
    id: `${op.entityType}:${op.entityId}:${field}:${localClock || '-'}:${op.hlc}`,
    entityType: op.entityType,
    entityId: op.entityId,
    field,
    kind: 'text_edit',
    local: { value: localValue, hlc: localClock || null },
    remote: { value: remoteValue, hlc: op.hlc },
    base: base ?? null,
    detectedAt: now,
    resolution: null,
  };
}

function pickText(set: Row, policy: ResolvedPolicy): Row {
  const out: Row = {};
  for (const [f, v] of Object.entries(set)) if (policy.text.has(f)) out[f] = v;
  return out;
}

export function mergeRemote(input: MergeInput): MergeOutcome {
  const { op, payload, policy, now } = input;
  const local = input.local;
  const before = input.meta ?? freshMeta(op.entityType, op.entityId);
  const isDelete = op.opType === 'delete';

  // Device-local fields are never accepted from a remote.
  const set: Row = {};
  for (const [f, v] of Object.entries(payload.set)) if (!policy.local.has(f)) set[f] = v;

  // Provenance can never be overwritten: refuse the whole operation and let the caller report it.
  if (!isDelete && local) {
    for (const [f, v] of Object.entries(set)) {
      const frozen = policy.immutable.has(f) || policy.appendOnly;
      if (frozen && Object.hasOwn(local, f) && !deepEqual(local[f], v)) {
        return {
          kind: 'rejected',
          reason: 'immutable_field',
          detail: `${op.entityType}.${f} is immutable`,
        };
      }
    }
  }

  if (!isDelete) {
    const violated = frozenViolation(before, policy, set, payload.full);
    if (violated !== null) {
      return {
        kind: 'rejected',
        reason: 'immutable_field',
        detail: `${op.entityType}.${violated} is immutable`,
      };
    }
  }

  const meta = cloneMeta(before);
  bookkeeping(meta, op, payload, now);
  const alive = isAlive(meta);

  // An upsert that had not observed the latest tombstone is concurrent with the delete: remove wins.
  const voided =
    !isDelete && meta.rm !== null && (payload.observed === null || payload.observed < meta.rm);

  if (isDelete || voided) {
    const conflicts: ConflictRecord[] = [];
    if (isDelete && !alive) {
      // Text the deleter had not seen is retained for the user.
      const unseen = Object.entries(before.fields).some(
        ([f, c]) => policy.text.has(f) && !(payload.prev[f] ?? []).includes(c.c),
      );
      if (local && unseen) {
        conflicts.push({
          id: `${op.entityType}:${op.entityId}:*:deleted_remotely:${op.hlc}`,
          entityType: op.entityType,
          entityId: op.entityId,
          field: null,
          kind: 'deleted_remotely',
          local: { value: local, hlc: null },
          remote: { value: null, hlc: op.hlc },
          base: null,
          detectedAt: now,
          resolution: null,
        });
      }
    } else if (voided) {
      const lost = pickText(set, policy);
      if (Object.keys(lost).length > 0) {
        conflicts.push({
          id: `${op.entityType}:${op.entityId}:*:edit_lost_to_delete:${op.hlc}`,
          entityType: op.entityType,
          entityId: op.entityId,
          field: null,
          kind: 'edit_lost_to_delete',
          local: { value: null, hlc: meta.rm },
          remote: { value: lost, hlc: op.hlc },
          base: null,
          detectedAt: now,
          resolution: null,
        });
      }
    }
    const remove = local !== null && !alive;
    const change: AppliedChange | null = remove
      ? {
          entityType: op.entityType,
          entityId: op.entityId,
          deleted: true,
          create: false,
          fields: {},
          sets: {},
        }
      : null;
    return { kind: 'merged', meta, change, conflicts };
  }

  if (local === null && !payload.full) return { kind: 'parked' };

  const conflicts: ConflictRecord[] = [];
  const create = local === null;
  if (create) {
    // No row to protect: this snapshot starts a new incarnation of the entity.
    meta.fields = {};
    meta.sets = {};
  }
  const change: AppliedChange = {
    entityType: op.entityType,
    entityId: op.entityId,
    deleted: false,
    create,
    fields: {},
    sets: {},
  };
  recordFrozen(meta, policy, set, payload.full);

  for (const [f, value] of Object.entries(set)) {
    const prev = payload.prev[f] ?? [];
    const cur = meta.fields[f];
    if (create) {
      change.fields[f] = value;
      meta.fields[f] = { c: op.hlc, a: ancestry(prev) };
      continue;
    }
    // Already incorporated (re-delivery) or superseded by something newer we have recorded.
    if (cur && (cur.c === op.hlc || cur.a.includes(op.hlc))) continue;

    const curClock = cur?.c ?? '';
    const localValue = local[f];
    const isText = policy.text.has(f);
    const differs = localValue !== undefined && !deepEqual(localValue, value);

    if (op.hlc > curClock) {
      const followsLocal = curClock === '' ? localValue === undefined : prev.includes(curClock);
      if (isText && differs && !followsLocal) {
        conflicts.push(
          textConflict(op, f, localValue as JsonValue, curClock, value, payload.base[f], now),
        );
      }
      if (localValue === undefined || differs) change.fields[f] = value;
      meta.fields[f] = { c: op.hlc, a: ancestry(prev, cur ? [cur.c, ...cur.a] : []) };
    } else if (cur) {
      // The local value is newer and stays; the remote one is kept if it was a concurrent edit.
      if (isText && differs) {
        conflicts.push(
          textConflict(op, f, localValue as JsonValue, curClock, value, payload.base[f], now),
        );
      }
      meta.fields[f] = { c: cur.c, a: ancestry(cur.a, [op.hlc]) };
    }
  }

  for (const [f, delta] of Object.entries(payload.sets)) {
    if (policy.local.has(f)) continue;
    applySetDelta(meta, f, delta, op.hlc, create ? null : local);
    change.sets[f] = presentMembers(meta.sets[f]!);
  }

  const empty =
    !create && Object.keys(change.fields).length === 0 && Object.keys(change.sets).length === 0;
  return { kind: 'merged', meta, change: empty ? null : change, conflicts };
}
