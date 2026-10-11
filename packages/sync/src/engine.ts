import { maxHlc, receive, tick, hlcWallMs } from './hlc.ts';
import type { JsonValue } from './json.ts';
import { deepEqual, isJsonValue } from './json.ts';
import type { AppliedChange, Row } from './merge.ts';
import {
  applyLocalToMeta,
  freshMeta,
  frozenViolation,
  mergeRemote,
  metaMaxClock,
} from './merge.ts';
import type { ResolvedPolicy, SyncPolicy } from './policy.ts';
import { resolvePolicy } from './policy.ts';
import type {
  Applier,
  Clock,
  OpAad,
  OpLog,
  PayloadCodec,
  PendingOp,
  SyncStateStore,
  Transport,
} from './ports.ts';
import { ApplyRejectedError, CodecLockedError, TransportError } from './ports.ts';
import type {
  ConflictRecord,
  EncryptedEnvelope,
  EntityMeta,
  QuarantinedOp,
  RejectReason,
  SyncState,
  SyncStatus,
} from './schema.ts';
import {
  FieldName,
  OpPayload,
  PROTOCOL_VERSION,
  RETRYABLE_REASONS,
  SyncOperation,
  SyncState as SyncStateSchema,
} from './schema.ts';

export interface SyncOptions {
  /** Operations per push request. */
  batchOps: number;
  /** Serialised bytes per push request (the server's body limit is larger). */
  batchBytes: number;
  pullLimit: number;
  /** Pull pages per run, so one run fits inside a service-worker lifetime. */
  maxPagesPerRun: number;
  /** Hard bound of the outbox after coalescing; beyond it recordLocalChange throws. */
  maxPendingOps: number;
  maxQuarantined: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** +/- fraction of random spread on each backoff. */
  backoffJitter: number;
  /** Remote clocks further ahead than this are clamped and their operations quarantined. */
  maxDriftMs: number;
  tombstoneRetentionMs: number;
  sentRetentionMs: number;
  resolvedConflictRetentionMs: number;
  /** Merge successive unsent edits of one entity into one operation (lossless). */
  coalesce: boolean;
}

const DAY = 24 * 60 * 60 * 1000;

export const DEFAULT_SYNC_OPTIONS: SyncOptions = {
  batchOps: 50,
  batchBytes: 1024 * 1024,
  pullLimit: 200,
  maxPagesPerRun: 50,
  maxPendingOps: 20_000,
  maxQuarantined: 1_000,
  backoffBaseMs: 2_000,
  backoffMaxMs: 15 * 60 * 1000,
  backoffJitter: 0.25,
  maxDriftMs: DAY,
  tombstoneRetentionMs: 90 * DAY,
  sentRetentionMs: 7 * DAY,
  resolvedConflictRetentionMs: 30 * DAY,
  coalesce: true,
};

export interface SyncDeps {
  /** Stable id of this installation (UUIDv7). */
  clientId: string;
  policy: SyncPolicy;
  /** Reads Settings.features.sync. When false the engine does nothing: no I/O, no scheduling. */
  isEnabled(): boolean | Promise<boolean>;
  log: OpLog;
  store: SyncStateStore;
  transport: Transport;
  applier: Applier;
  clock: Clock;
  newId(): string;
  /** E2EE. Absent = plaintext to the server (TLS only: NOT end-to-end encryption). */
  codec?: PayloadCodec;
  /** Account the tokens belong to (OIDC `sub`); null = signed out. Absent = no account binding. */
  accountId?(): string | null | Promise<string | null>;
  /** [0,1). Injected so backoff is deterministic in tests. */
  random?(): number;
  options?: Partial<SyncOptions>;
}

export type LocalChange =
  | {
      kind: 'upsert';
      entityType: string;
      entityId: string;
      /** The row before the write (null for a create) and after it. */
      before: Record<string, unknown> | null;
      after: Record<string, unknown>;
    }
  | {
      kind: 'delete';
      entityType: string;
      entityId: string;
      before: Record<string, unknown> | null;
    };

export interface SyncReport {
  status: SyncStatus;
  pulled: number;
  applied: number;
  conflicts: number;
  quarantined: number;
  pushed: number;
  pending: number;
  /** True when pages remain: call sync() again. */
  more: boolean;
  error: { code: string; message: string } | null;
  /** Earliest time a retry is useful (epoch ms), when backing off. */
  retryAt: number | null;
}

export class ImmutableFieldError extends Error {
  constructor(
    readonly entityType: string,
    readonly field: string,
  ) {
    super(`${entityType}.${field} is immutable provenance and cannot be changed`);
    this.name = 'ImmutableFieldError';
  }
}

export class NotSerialisableError extends Error {
  constructor(
    readonly entityType: string,
    readonly field: string,
  ) {
    super(`${entityType}.${field} is not plain JSON and cannot be synchronised`);
    this.name = 'NotSerialisableError';
  }
}

export class SyncQueueFullError extends Error {
  constructor(readonly limit: number) {
    super(`The sync queue is full (${limit} unsent changes). Connect and sync, or turn sync off.`);
    this.name = 'SyncQueueFullError';
  }
}

export function aadOf(op: {
  id: string;
  clientId: string;
  entityType: string;
  entityId: string;
  opType: string;
  revision: number;
  hlc: string;
}): OpAad {
  const { id, clientId, entityType, entityId, opType, revision, hlc } = op;
  return { id, clientId, entityType, entityId, opType, revision, hlc };
}

function digest(value: unknown): string {
  const text = JSON.stringify(value) ?? 'undefined';
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return `malformed-${(h >>> 0).toString(16)}-${text.length}`;
}

/** Syncable view of a row: JSON only, minus device-local fields. `strict` throws on non-JSON data. */
function syncRow(
  row: Record<string, unknown>,
  policy: ResolvedPolicy,
  entityType: string,
  strict: boolean,
): Row {
  const out: Row = {};
  for (const key of Object.keys(row)) {
    const v = row[key];
    if (v === undefined || policy.local.has(key)) continue;
    if (policy.fields && !policy.fields.has(key)) continue;
    if (!FieldName.safeParse(key).success) continue;
    if (!isJsonValue(v)) {
      if (strict) throw new NotSerialisableError(entityType, key);
      continue;
    }
    out[key] = v;
  }
  return out;
}

function stringArray(value: JsonValue | undefined, entityType: string, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((m) => typeof m !== 'string')) {
    throw new NotSerialisableError(entityType, field);
  }
  return [...new Set(value as string[])];
}

function emptyPayload(): OpPayload {
  return { v: 1, full: false, set: {}, prev: {}, base: {}, sets: {}, observed: null };
}

interface ChangeExtras {
  /** Extra clocks a field edit supersedes (conflict resolution). */
  supersedes?: Record<string, string[]>;
  /** Fields to include even if their value did not change (so a resolution reaches other devices). */
  force?: string[];
}

export class SyncEngine {
  private readonly opts: SyncOptions;
  private readonly policies = new Map<string, ResolvedPolicy>();
  private inFlight: Promise<SyncReport> | null = null;

  constructor(private readonly d: SyncDeps) {
    this.opts = { ...DEFAULT_SYNC_OPTIONS, ...d.options };
    for (const [type, p] of Object.entries(d.policy)) this.policies.set(type, resolvePolicy(p));
  }

  // ---------------------------------------------------------------------------------------------
  // Local changes -> operations
  // ---------------------------------------------------------------------------------------------

  /**
   * Record one local write. Call it in the same transaction as the write itself (OpLog, the state
   * store and the entity live in one IndexedDB database). Returns the operation, or null when sync
   * is off, the table is not synchronised, or nothing syncable changed.
   * Throws ImmutableFieldError if the write changes provenance, SyncQueueFullError when the outbox
   * is full (the host should still commit the write and call `markNeedsResync()`).
   */
  async recordLocalChange(
    change: LocalChange,
    extras: ChangeExtras = {},
  ): Promise<SyncOperation | null> {
    if (!(await this.enabled())) return null;
    const policy = this.policies.get(change.entityType);
    if (!policy) return null;

    const { clientId } = this.d;
    const state = await this.loadState();
    const now = this.d.clock.now();
    const meta =
      (await this.d.store.getMeta(change.entityType, change.entityId)) ??
      freshMeta(change.entityType, change.entityId);
    const before = change.before ? syncRow(change.before, policy, change.entityType, false) : null;

    let opType: 'upsert' | 'delete';
    let payload: OpPayload;
    if (change.kind === 'delete') {
      opType = 'delete';
      // The deleter's causal context: a receiver whose text edits are not in it keeps them in a record.
      payload = emptyPayload();
      for (const [f, c] of Object.entries(meta.fields)) payload.prev[f] = [c.c];
    } else {
      opType = 'upsert';
      const after = syncRow(change.after, policy, change.entityType, true);
      const built = this.buildUpsert(change.entityType, policy, meta, before, after, extras);
      if (!built) return null;
      payload = built;
    }

    const ticked = tick(state.hlc, now, clientId, [metaMaxClock(meta)]);
    const id = this.d.newId();
    const revision = meta.revision + 1;
    const op = SyncOperation.parse({
      id,
      clientId,
      entityType: change.entityType,
      entityId: change.entityId,
      opType,
      revision,
      hlc: ticked.hlc,
      baseRevision: meta.revision,
      payload,
      payloadEncrypted: false,
      tombstone: opType === 'delete',
      idempotencyKey: `${clientId}:${id}`,
      createdAt: new Date(now).toISOString(),
    });

    let nextMeta = applyLocalToMeta(meta, op, payload, now, policy);
    let toAppend: SyncOperation = op;
    let replaceId: string | null = null;

    const pending =
      this.opts.coalesce && opType === 'upsert'
        ? await this.d.log.unattemptedFor(change.entityType, change.entityId)
        : null;
    if (pending && !pending.op.payloadEncrypted && pending.op.opType === 'upsert') {
      const earlier = OpPayload.safeParse(pending.op.payload);
      if (earlier.success && !overlaps(earlier.data, payload)) {
        const merged = coalescePayload(earlier.data, payload);
        toAppend = SyncOperation.parse({
          ...op,
          baseRevision: pending.op.baseRevision,
          payload: merged,
        });
        nextMeta = alignCoalescedMeta(nextMeta, earlier.data, payload, op.hlc);
        replaceId = pending.op.id;
      }
    }
    if (replaceId === null && (await this.d.log.countPending()) >= this.opts.maxPendingOps) {
      throw new SyncQueueFullError(this.opts.maxPendingOps);
    }

    state.hlc = ticked.state;
    await this.d.store.putMeta(nextMeta);
    if (replaceId !== null) await this.d.log.replace([replaceId], toAppend);
    else await this.d.log.append(toAppend);
    state.pending = await this.d.log.countPending();
    await this.save(state);
    return toAppend;
  }

  private buildUpsert(
    entityType: string,
    policy: ResolvedPolicy,
    meta: EntityMeta,
    before: Row | null,
    after: Row,
    extras: ChangeExtras,
  ): OpPayload | null {
    const full = before === null || !meta.born;
    if (before) {
      for (const f of Object.keys(before)) {
        const frozen = policy.immutable.has(f) || policy.appendOnly;
        if (frozen && !deepEqual(before[f], after[f])) throw new ImmutableFieldError(entityType, f);
      }
    }

    const payload = emptyPayload();
    payload.full = full;
    payload.observed = meta.rm;
    const touched = (f: string) => {
      const cur = meta.fields[f];
      payload.prev[f] = [...new Set([...(cur ? [cur.c] : []), ...(extras.supersedes?.[f] ?? [])])];
    };

    for (const [f, v] of Object.entries(after)) {
      if (policy.sets.has(f)) continue;
      if (!full && before && deepEqual(before[f], v) && !extras.force?.includes(f)) continue;
      payload.set[f] = v;
      touched(f);
      if (policy.text.has(f) && before && before[f] !== undefined) payload.base[f] = before[f]!;
    }
    if (!full && before) {
      for (const f of Object.keys(before)) {
        if (policy.sets.has(f) || Object.hasOwn(after, f)) continue;
        payload.set[f] = null; // a field that no longer exists
        touched(f);
      }
    }

    for (const f of policy.sets) {
      const next = stringArray(after[f], entityType, f);
      const prior = full ? [] : stringArray(before?.[f], entityType, f);
      const add = next.filter((m) => !prior.includes(m));
      const remove = prior.filter((m) => !next.includes(m));
      if (add.length === 0 && remove.length === 0) continue;
      const seen: Record<string, string> = {};
      for (const m of add) {
        const rm = meta.sets[f]?.[m]?.rm;
        if (rm) seen[m] = rm;
      }
      payload.sets[f] = { add, remove, seen };
    }

    const empty = Object.keys(payload.set).length === 0 && Object.keys(payload.sets).length === 0;
    if (empty && !full) return null;
    // Provenance stays frozen even across a delete: re-creating an id with other provenance is refused.
    const violated = frozenViolation(meta, policy, payload.set, full);
    if (violated !== null) throw new ImmutableFieldError(entityType, violated);
    return payload;
  }

  /**
   * Initial upload (first time sync is switched on) and re-upload after `markNeedsResync`: entities
   * that this device has never sent get a full snapshot. Entities already known are skipped.
   */
  async backfill(
    changes: Iterable<LocalChange>,
    options: { force?: boolean } = {},
  ): Promise<{ queued: number; skipped: number }> {
    let queued = 0;
    let skipped = 0;
    for (const c of changes) {
      const meta = await this.d.store.getMeta(c.entityType, c.entityId);
      if (!options.force && meta?.born && c.kind === 'upsert') {
        skipped++;
        continue;
      }
      if (await this.recordLocalChange(c)) queued++;
      else skipped++;
    }
    return { queued, skipped };
  }

  // ---------------------------------------------------------------------------------------------
  // Sync run
  // ---------------------------------------------------------------------------------------------

  /** One resumable run: pull (apply remote), then push. Never throws; the report says what happened. */
  sync(options: { force?: boolean } = {}): Promise<SyncReport> {
    if (this.inFlight) return this.inFlight;
    const run = this.run(options).finally(() => {
      this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }

  private async run(options: { force?: boolean }): Promise<SyncReport> {
    const report: SyncReport = {
      status: 'idle',
      pulled: 0,
      applied: 0,
      conflicts: 0,
      quarantined: 0,
      pushed: 0,
      pending: 0,
      more: false,
      error: null,
      retryAt: null,
    };
    if (!(await this.enabled())) return { ...report, status: 'disabled' };

    const state = await this.loadState();
    const finish = async (status: SyncStatus, error?: { code: string; message: string }) => {
      state.status = status;
      state.lastError = error ? { ...error, at: this.d.clock.now() } : null;
      state.pending = await this.d.log.countPending();
      await this.save(state);
      report.status = status;
      report.pending = state.pending;
      report.error = error ?? null;
      report.retryAt = state.backoff.nextAttemptAt;
      return report;
    };

    try {
      if (this.d.accountId) {
        const account = await this.d.accountId();
        if (account === null) {
          return await finish('auth_required', {
            code: 'auth_required',
            message: 'Sign in to sync.',
          });
        }
        if (state.accountId === null) state.accountId = account;
        else if (state.accountId !== account) {
          return await finish('account_mismatch', {
            code: 'account_mismatch',
            message:
              'This device holds data from a different account. Nothing was uploaded or merged.',
          });
        }
      }
      const now = this.d.clock.now();
      if (
        !options.force &&
        state.backoff.nextAttemptAt !== null &&
        now < state.backoff.nextAttemptAt
      ) {
        report.status = 'backoff';
        report.retryAt = state.backoff.nextAttemptAt;
        report.pending = await this.d.log.countPending();
        report.error = state.lastError
          ? { code: state.lastError.code, message: state.lastError.message }
          : null;
        return report;
      }
      if (this.d.codec?.required && !this.d.codec.isUnlocked()) {
        // Nothing can be read or encrypted without the key; do not touch the network at all.
        return await finish('locked', {
          code: 'locked',
          message: 'Enter your sync passphrase to continue.',
        });
      }
      if (state.needsResync) {
        state.cursor = null;
        state.needsResync = false;
      }
      state.status = 'syncing';
      await this.save(state);

      let locked = false;
      locked = (await this.pull(state, report)) || locked;
      if (report.status !== 'disabled') locked = (await this.push(state, report)) || locked;
      if (!(await this.enabled())) return await finish('disabled');

      state.backoff = { attempt: 0, nextAttemptAt: null };
      state.lastSyncAt = this.d.clock.now();
      return await finish(locked ? 'locked' : 'idle');
    } catch (e) {
      return await this.fail(state, report, e, finish);
    }
  }

  private async fail(
    state: SyncState,
    report: SyncReport,
    e: unknown,
    finish: (s: SyncStatus, err?: { code: string; message: string }) => Promise<SyncReport>,
  ): Promise<SyncReport> {
    const message = e instanceof Error ? e.message : String(e);
    const backoff = (retryAfterMs?: number) => {
      const attempt = state.backoff.attempt + 1;
      const base = Math.min(this.opts.backoffMaxMs, this.opts.backoffBaseMs * 2 ** (attempt - 1));
      const spread = 1 + ((this.d.random?.() ?? 0.5) * 2 - 1) * this.opts.backoffJitter;
      const wait = Math.max(retryAfterMs ?? 0, Math.round(base * spread));
      state.backoff = { attempt, nextAttemptAt: this.d.clock.now() + wait };
    };
    if (e instanceof TransportError) {
      switch (e.kind) {
        case 'auth':
          return finish('auth_required', {
            code: 'auth_required',
            message: 'Sign in again to sync.',
          });
        case 'cursor_expired':
          return finish('resync_required', {
            code: 'cursor_expired',
            message:
              "The server no longer knows this device's position (reset or restored). Review before re-syncing.",
          });
        case 'network':
          backoff();
          return finish('offline', { code: 'network', message });
        case 'rate_limited':
          backoff(e.retryAfterMs);
          return finish('backoff', { code: 'rate_limited', message });
        default:
          backoff(e.retryAfterMs);
          return finish('error', { code: e.kind, message });
      }
    }
    if (e instanceof CodecLockedError) return finish('locked', { code: 'locked', message });
    backoff();
    report.more = true;
    return finish('error', { code: 'internal', message });
  }

  /** Returns true when encrypted operations had to be set aside because the key is locked. */
  private async pull(state: SyncState, report: SyncReport): Promise<boolean> {
    let locked = false;
    for (let page = 0; page < this.opts.maxPagesPerRun; page++) {
      if (!(await this.enabled())) {
        report.status = 'disabled';
        return locked;
      }
      const res = await this.d.transport.pull({ since: state.cursor, limit: this.opts.pullLimit });
      this.checkEpoch(state, res.epoch);
      // HLC order is a causal order: applying a page in it puts a create before its updates.
      const entries = [...res.ops].sort((a, b) => hlcKey(a.op).localeCompare(hlcKey(b.op)));
      for (const entry of entries) {
        report.pulled++;
        const outcome = await this.applyRemote(entry.op, state, report);
        if (outcome === 'locked') locked = true;
      }
      if (res.nextCursor === state.cursor && res.ops.length === 0 && res.hasMore) {
        throw new TransportError(
          'protocol',
          'The server returned an empty page that claims more data.',
        );
      }
      state.cursor = res.nextCursor;
      await this.save(state);
      if (!res.hasMore) return locked;
    }
    report.more = true;
    return locked;
  }

  private async applyRemote(
    raw: unknown,
    state: SyncState,
    report: SyncReport,
  ): Promise<'applied' | 'skipped' | 'quarantined' | 'locked'> {
    const parsed = SyncOperation.safeParse(raw);
    if (!parsed.success) {
      const id =
        typeof (raw as { id?: unknown } | null)?.id === 'string'
          ? (raw as { id: string }).id
          : digest(raw);
      await this.quarantine(
        report,
        { id, entityType: null, entityId: null, op: null },
        'invalid_op',
        'Malformed operation envelope.',
      );
      return 'quarantined';
    }
    const op = parsed.data;
    if (op.clientId === state.clientId) return 'skipped'; // our own, already applied when written
    const ref = { id: op.id, entityType: op.entityType, entityId: op.entityId, op };
    const now = this.d.clock.now();

    const wall = hlcWallMs(op.hlc);
    if (wall === null || wall > now + this.opts.maxDriftMs) {
      await this.quarantine(
        report,
        ref,
        'clock_skew',
        'The operation is stamped far in the future.',
      );
      return 'quarantined';
    }
    const policy = this.policies.get(op.entityType);
    if (!policy) {
      await this.quarantine(
        report,
        ref,
        'unknown_entity_type',
        `Unknown entity type ${op.entityType}.`,
      );
      return 'quarantined';
    }

    let body: unknown = op.payload;
    const codec = this.d.codec;
    if (op.payloadEncrypted) {
      if (!codec?.isUnlocked()) {
        await this.quarantine(
          report,
          ref,
          'locked',
          'Encrypted operation received while the key is locked.',
        );
        return 'locked';
      }
      try {
        body = await codec.decrypt(op.payload as EncryptedEnvelope, aadOf(op));
      } catch (e) {
        if (e instanceof CodecLockedError) {
          // Another key version (rotated elsewhere): retryable once this device unlocks the new one.
          await this.quarantine(report, ref, 'locked', e.message);
          return 'locked';
        }
        await this.quarantine(
          report,
          ref,
          'decrypt_failed',
          'Authentication of the encrypted payload failed.',
        );
        return 'quarantined';
      }
    } else if (codec?.required) {
      await this.quarantine(
        report,
        ref,
        'plaintext_in_e2ee',
        'Plaintext operation refused in end-to-end encrypted mode.',
      );
      return 'quarantined';
    }

    const payload = OpPayload.safeParse(body);
    if (!payload.success) {
      await this.quarantine(report, ref, 'invalid_op', 'Payload does not match the protocol.');
      return 'quarantined';
    }
    const p = payload.data;
    const fieldNames = [...Object.keys(p.set), ...Object.keys(p.sets)];
    if (op.opType === 'upsert' && p.set['id'] !== undefined && p.set['id'] !== op.entityId) {
      await this.quarantine(report, ref, 'invalid_op', 'Payload id differs from the entity id.');
      return 'quarantined';
    }
    if (policy.fields) {
      const unknown = fieldNames.find((f) => !policy.fields!.has(f) && !policy.local.has(f));
      if (unknown) {
        await this.quarantine(
          report,
          ref,
          'unknown_field',
          `Field ${unknown} is not known to this version.`,
        );
        return 'quarantined';
      }
    }

    state.hlc = receive(state.hlc, op.hlc, now, this.opts.maxDriftMs);
    const meta = await this.d.store.getMeta(op.entityType, op.entityId);
    const row = await this.d.applier.read(op.entityType, op.entityId);
    const outcome = mergeRemote({
      meta,
      op,
      payload: p,
      local: row ? syncRow(row, policy, op.entityType, false) : null,
      policy,
      now,
    });

    if (outcome.kind === 'rejected') {
      await this.quarantine(report, ref, outcome.reason, outcome.detail);
      return 'quarantined';
    }
    if (outcome.kind === 'parked') {
      await this.quarantine(
        report,
        ref,
        'awaiting_create',
        'Update for an entity that has not arrived yet.',
      );
      return 'quarantined';
    }

    if (outcome.change) {
      try {
        await this.d.applier.apply(outcome.change);
      } catch (e) {
        if (e instanceof ApplyRejectedError) {
          await this.quarantine(report, ref, e.reason, e.message);
          return 'quarantined';
        }
        throw e;
      }
    }
    // Metadata after the row: a crash in between re-applies the (idempotent) operation.
    await this.d.store.putMeta(outcome.meta);
    for (const c of outcome.conflicts) {
      if (!(await this.d.store.getConflict(c.id))) {
        await this.d.store.putConflict(c);
        report.conflicts++;
      }
    }
    await this.autoResolve(op.entityType, op.entityId, p, now);
    report.applied++;
    // A re-delivered operation that was set aside earlier (locked, awaiting create) is settled now.
    await this.d.store.deleteQuarantined(op.id);

    if (p.full || op.opType === 'delete')
      await this.retryParked(op.entityType, op.entityId, state, report);
    return 'applied';
  }

  /** A remote edit that lists both sides of an open conflict among what it replaced settles it. */
  private async autoResolve(
    entityType: string,
    entityId: string,
    p: OpPayload,
    now: number,
  ): Promise<void> {
    if (Object.keys(p.set).length === 0) return;
    for (const c of await this.d.store.listConflictsFor(entityType, entityId)) {
      if (c.resolution || c.field === null || !Object.hasOwn(p.set, c.field)) continue;
      const seen = p.prev[c.field] ?? [];
      const sides = [c.local.hlc, c.remote.hlc].filter((h): h is string => h !== null);
      if (sides.length > 0 && sides.every((h) => seen.includes(h))) {
        await this.d.store.putConflict({
          ...c,
          resolution: { choice: 'superseded', value: p.set[c.field] ?? null, resolvedAt: now },
        });
      }
    }
  }

  private async quarantine(
    report: SyncReport,
    ref: { id: string; entityType: string | null; entityId: string | null; op: unknown },
    reason: RejectReason,
    detail: string,
  ): Promise<void> {
    const item: QuarantinedOp = {
      id: ref.id,
      entityType: ref.entityType,
      entityId: ref.entityId,
      reason,
      detail,
      at: this.d.clock.now(),
      op: ref.op,
    };
    await this.d.store.putQuarantined(item);
    report.quarantined++;
    const all = await this.d.store.listQuarantined();
    const excess = all.length - this.opts.maxQuarantined;
    if (excess > 0) {
      // Evicting a retryable operation loses it locally; the server still has it, so re-pull later.
      let lostRetryable = false;
      for (const old of all.slice(0, excess)) {
        if (RETRYABLE_REASONS.has(old.reason)) lostRetryable = true;
        await this.d.store.deleteQuarantined(old.id);
      }
      if (lostRetryable) {
        const state = await this.loadState();
        state.needsResync = true;
        await this.save(state);
      }
    }
  }

  private async retryParked(
    entityType: string,
    entityId: string,
    state: SyncState,
    report: SyncReport,
  ): Promise<void> {
    const parked = (await this.d.store.listQuarantined())
      .filter(
        (q) =>
          q.reason === 'awaiting_create' && q.entityType === entityType && q.entityId === entityId,
      )
      .sort((a, b) => hlcKey(a.op).localeCompare(hlcKey(b.op)));
    for (const q of parked) {
      await this.d.store.deleteQuarantined(q.id);
      await this.applyRemote(q.op, state, report);
    }
  }

  /** The first contact pins the server's data generation; a different one stops everything. */
  private checkEpoch(state: SyncState, epoch: string): void {
    if (state.epoch === null) state.epoch = epoch;
    else if (state.epoch !== epoch) {
      throw new TransportError(
        'cursor_expired',
        'The server data was erased, restored or replaced since this device last synced.',
      );
    }
  }

  private async push(state: SyncState, report: SyncReport): Promise<boolean> {
    let batchSize = this.opts.batchOps;
    for (;;) {
      if (!(await this.enabled())) {
        report.status = 'disabled';
        return false;
      }
      const queue = await this.d.log.pending(batchSize);
      if (queue.length === 0) return false;
      const batch = limitBytes(queue, this.opts.batchBytes);

      const codec = this.d.codec;
      if (codec) {
        for (const p of batch) {
          if (p.op.payloadEncrypted) continue;
          if (!codec.isUnlocked()) return true;
          // Encrypt once and persist the ciphertext, so a retry resends identical bytes.
          const envelope = await codec.encrypt(p.op.payload, aadOf(p.op));
          p.op = SyncOperation.parse({ ...p.op, payload: envelope, payloadEncrypted: true });
          await this.d.log.replace([p.op.id], p.op);
        }
      }

      await this.d.log.markAttempted(batch.map((p) => p.op.id));
      let res;
      try {
        res = await this.d.transport.push({
          v: PROTOCOL_VERSION,
          clientId: state.clientId,
          ops: batch.map((p) => p.op),
        });
      } catch (e) {
        if (e instanceof TransportError && e.kind === 'client') {
          if (batch.length > 1) {
            batchSize = Math.max(1, Math.floor(batch.length / 2));
            continue;
          }
          const only = batch[0]!.op;
          await this.quarantine(
            report,
            opRef(only),
            'invalid_op',
            `Server refused the operation: ${e.message}`,
          );
          await this.d.log.replace([only.id], null);
          continue;
        }
        throw e;
      }

      this.checkEpoch(state, res.epoch);
      const byKey = new Map(res.results.map((r) => [r.idempotencyKey, r] as const));
      const sent: string[] = [];
      let progressed = false;
      for (const p of batch) {
        const r = byKey.get(p.op.idempotencyKey);
        if (!r) continue;
        if (r.status === 'accepted' || r.status === 'duplicate') {
          sent.push(p.op.id);
          if (r.status === 'accepted') report.pushed++;
        } else if (r.code === 'quota_exceeded' || r.code === 'hlc_in_future') {
          // Transient/environmental: keep the operation, surface the problem.
          throw new TransportError(
            'client',
            r.code === 'quota_exceeded'
              ? 'The server storage quota for this account is exhausted.'
              : 'This device clock is far ahead of the server; fix the date and time.',
          );
        } else {
          await this.quarantine(
            report,
            opRef(p.op),
            'invalid_op',
            `Server rejected the operation: ${r.code ?? 'unknown'}`,
          );
          await this.d.log.replace([p.op.id], null);
          progressed = true;
        }
      }
      if (sent.length > 0) {
        await this.d.log.markSent(sent, this.d.clock.now());
        progressed = true;
      }
      if (!progressed)
        throw new TransportError('protocol', 'The server acknowledged none of the operations.');
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Conflicts, quarantine, housekeeping
  // ---------------------------------------------------------------------------------------------

  async listConflicts(options?: { unresolvedOnly?: boolean }): Promise<ConflictRecord[]> {
    return this.d.store.listConflicts(options);
  }

  async listQuarantined(): Promise<QuarantinedOp[]> {
    return this.d.store.listQuarantined();
  }

  /**
   * Settle a conflict. The decision becomes an ordinary operation that supersedes both versions, so
   * every other device closes its record when it arrives. Restoring a remotely deleted entity writes
   * it back and re-adds it with the causal knowledge of the tombstone (it wins over it).
   */
  async resolveConflict(
    id: string,
    decision:
      | { choice: 'local' }
      | { choice: 'remote' }
      | { choice: 'custom'; value: JsonValue }
      | { choice: 'keep_deleted' }
      | { choice: 'restore' }
      | { choice: 'discard' },
  ): Promise<ConflictRecord> {
    const record = await this.d.store.getConflict(id);
    if (!record) throw new Error(`Unknown conflict ${id}`);
    if (record.resolution) return record;
    const now = this.d.clock.now();
    let value: JsonValue = null;

    if (record.kind === 'text_edit') {
      if (record.field === null) throw new Error('Corrupt conflict record');
      if (
        decision.choice === 'keep_deleted' ||
        decision.choice === 'restore' ||
        decision.choice === 'discard'
      ) {
        throw new Error(`${decision.choice} does not apply to a text conflict`);
      }
      value =
        decision.choice === 'local'
          ? record.local.value
          : decision.choice === 'remote'
            ? record.remote.value
            : decision.value;
      const row = await this.d.applier.read(record.entityType, record.entityId);
      if (row) {
        const field = record.field;
        await this.d.applier.apply({
          entityType: record.entityType,
          entityId: record.entityId,
          deleted: false,
          create: false,
          fields: { [field]: value },
          sets: {},
        });
        const clocks = [record.local.hlc, record.remote.hlc].filter((h): h is string => h !== null);
        await this.recordLocalChange(
          {
            kind: 'upsert',
            entityType: record.entityType,
            entityId: record.entityId,
            before: row,
            after: { ...row, [field]: value },
          },
          { supersedes: { [field]: clocks }, force: [field] },
        );
      }
    } else if (decision.choice === 'restore') {
      if (
        record.kind !== 'deleted_remotely' ||
        typeof record.local.value !== 'object' ||
        record.local.value === null ||
        Array.isArray(record.local.value)
      ) {
        throw new Error('This conflict cannot be restored: the full row was not retained');
      }
      const snapshot = record.local.value as Row;
      const change: AppliedChange = {
        entityType: record.entityType,
        entityId: record.entityId,
        deleted: false,
        create: true,
        fields: snapshot,
        sets: {},
      };
      await this.d.applier.apply(change);
      await this.recordLocalChange({
        kind: 'upsert',
        entityType: record.entityType,
        entityId: record.entityId,
        before: null,
        after: snapshot,
      });
      value = snapshot;
    } else if (decision.choice !== 'keep_deleted' && decision.choice !== 'discard') {
      throw new Error(`${decision.choice} does not apply to a deletion conflict`);
    }

    const resolved: ConflictRecord = {
      ...record,
      resolution: { choice: decision.choice, value, resolvedAt: now },
    };
    await this.d.store.putConflict(resolved);
    return resolved;
  }

  /** Re-run quarantined operations that can succeed now (after unlock, upgrade, or time passing). */
  async retryQuarantined(): Promise<SyncReport> {
    const report: SyncReport = {
      status: 'idle',
      pulled: 0,
      applied: 0,
      conflicts: 0,
      quarantined: 0,
      pushed: 0,
      pending: 0,
      more: false,
      error: null,
      retryAt: null,
    };
    if (!(await this.enabled())) return { ...report, status: 'disabled' };
    const state = await this.loadState();
    for (const q of await this.d.store.listQuarantined()) {
      if (!RETRYABLE_REASONS.has(q.reason)) continue;
      await this.d.store.deleteQuarantined(q.id);
      report.pulled++;
      await this.applyRemote(q.op, state, report);
    }
    await this.save(state);
    report.pending = await this.d.log.countPending();
    return report;
  }

  /** Drop expired tombstones, sent operations and old resolved conflicts. Safe to run any time. */
  async prune(): Promise<{
    tombstones: number;
    sentOps: number;
    conflicts: number;
    orphans: number;
  }> {
    if (!(await this.enabled())) return { tombstones: 0, sentOps: 0, conflicts: 0, orphans: 0 };
    const now = this.d.clock.now();
    const expired = await this.d.store.listTombstones(now - this.opts.tombstoneRetentionMs, 1000);
    for (const m of expired) await this.d.store.deleteMeta(m.entityType, m.entityId);
    const sentOps = await this.d.log.pruneSent(now - this.opts.sentRetentionMs);
    const stale = (await this.d.store.listConflicts())
      .filter(
        (c) =>
          c.resolution && c.resolution.resolvedAt < now - this.opts.resolvedConflictRetentionMs,
      )
      .map((c) => c.id);
    await this.d.store.deleteConflicts(stale);
    // Updates that never found their entity (it was deleted and its tombstone is long gone).
    const orphans = (await this.d.store.listQuarantined()).filter(
      (q) => q.reason === 'awaiting_create' && q.at < now - this.opts.tombstoneRetentionMs,
    );
    for (const q of orphans) await this.d.store.deleteQuarantined(q.id);
    return {
      tombstones: expired.length,
      sentOps,
      conflicts: stale.length,
      orphans: orphans.length,
    };
  }

  /** The next sync pulls everything again (idempotent) instead of continuing from the cursor. */
  async markNeedsResync(): Promise<void> {
    const state = await this.loadState();
    state.needsResync = true;
    if (state.status === 'resync_required') state.status = 'idle';
    await this.save(state);
  }

  /**
   * The user confirmed that the server's data was erased, restored or replaced: pin the new data
   * generation and pull from the start. Follow with `backfill(rows, { force: true })` to send what
   * only this device still holds. Re-sent snapshots carry fresh clocks, so a concurrent unsent edit on
   * another device can lose a scalar field to them (free text is kept as a conflict, as always).
   */
  async acknowledgeServerReset(): Promise<void> {
    const state = await this.loadState();
    state.epoch = null;
    state.cursor = null;
    state.needsResync = false;
    state.backoff = { attempt: 0, nextAttemptAt: null };
    if (state.status === 'resync_required') state.status = 'idle';
    await this.save(state);
  }

  /**
   * Attach this device's data to whichever account is signed in now: forgets cursor, metadata and
   * outbox (the data itself stays). Follow with `backfill` of all rows. The caller must have asked
   * the user: this is how one person's data could otherwise land in another person's account.
   */
  async rebindAccount(): Promise<void> {
    await this.d.log.clear();
    await this.d.store.clearAll();
  }

  async getState(): Promise<SyncState> {
    const state = await this.loadState();
    state.pending = await this.d.log.countPending();
    if (this.inFlight) state.status = 'syncing';
    if (!(await this.enabled())) state.status = 'disabled';
    return state;
  }

  // ---------------------------------------------------------------------------------------------

  private async save(state: SyncState): Promise<void> {
    // "syncing" belongs to a live run; persisting it would outlive a killed service worker.
    await this.d.store.saveState(state.status === 'syncing' ? { ...state, status: 'idle' } : state);
  }

  private async enabled(): Promise<boolean> {
    return Boolean(await this.d.isEnabled());
  }

  private async loadState(): Promise<SyncState> {
    const stored = await this.d.store.loadState();
    const parsed = SyncStateSchema.safeParse(stored);
    if (parsed.success) return { ...parsed.data, clientId: this.d.clientId };
    return {
      v: 1,
      clientId: this.d.clientId,
      accountId: null,
      cursor: null,
      epoch: null,
      pending: 0,
      lastSyncAt: null,
      status: 'idle',
      lastError: null,
      backoff: { attempt: 0, nextAttemptAt: null },
      hlc: { wall: 0, counter: 0 },
      // Missing or unreadable state: continue safely by re-pulling (applying is idempotent).
      needsResync: stored !== null,
    };
  }
}

function opRef(op: SyncOperation) {
  return { id: op.id, entityType: op.entityType, entityId: op.entityId, op };
}

function hlcKey(raw: unknown): string {
  const hlc = (raw as { hlc?: unknown } | null)?.hlc;
  return typeof hlc === 'string' ? hlc : '';
}

function limitBytes(queue: PendingOp[], maxBytes: number): PendingOp[] {
  const out: PendingOp[] = [];
  let bytes = 0;
  for (const p of queue) {
    bytes += JSON.stringify(p.op).length;
    if (out.length > 0 && bytes > maxBytes) break;
    out.push(p);
  }
  return out;
}

/** Two unsent edits can merge unless one touches a set member the other also touches. */
function overlaps(a: OpPayload, b: OpPayload): boolean {
  for (const [f, d] of Object.entries(b.sets)) {
    const e = a.sets[f];
    if (!e) continue;
    const mine = new Set([...d.add, ...d.remove]);
    if ([...e.add, ...e.remove].some((m) => mine.has(m))) return true;
  }
  return false;
}

function coalescePayload(earlier: OpPayload, later: OpPayload): OpPayload {
  const merged = emptyPayload();
  merged.full = earlier.full || later.full;
  merged.set = { ...earlier.set, ...later.set };
  for (const f of Object.keys(merged.set)) {
    // The replaced value is the one the earliest unsent edit replaced: nobody has seen the others.
    merged.prev[f] = earlier.prev[f] ?? later.prev[f] ?? [];
    const base = earlier.base[f] ?? later.base[f];
    if (base !== undefined) merged.base[f] = base;
  }
  merged.observed = maxHlc(earlier.observed, later.observed);
  for (const f of new Set([...Object.keys(earlier.sets), ...Object.keys(later.sets)])) {
    const a = earlier.sets[f];
    const b = later.sets[f];
    merged.sets[f] = {
      add: [...(a?.add ?? []), ...(b?.add ?? [])],
      remove: [...(a?.remove ?? []), ...(b?.remove ?? [])],
      seen: { ...(a?.seen ?? {}), ...(b?.seen ?? {}) },
    };
  }
  return merged;
}

/** After coalescing, every field/removal of the merged operation carries the merged operation's clock. */
function alignCoalescedMeta(
  meta: EntityMeta,
  earlier: OpPayload,
  later: OpPayload,
  hlc: string,
): EntityMeta {
  const next = structuredClone(meta);
  for (const f of Object.keys(earlier.set)) {
    const cur = next.fields[f];
    if (cur && !Object.hasOwn(later.set, f)) {
      next.fields[f] = { c: hlc, a: [cur.c, ...cur.a].slice(0, 16) };
    }
  }
  for (const [f, d] of Object.entries(earlier.sets)) {
    for (const m of d.remove) {
      const s = next.sets[f]?.[m];
      if (s && s.rm !== null && s.rm < hlc) s.rm = hlc;
    }
  }
  return next;
}
