import type { AppliedChange } from './merge.ts';
import type {
  ConflictRecord,
  EncryptedEnvelope,
  EntityMeta,
  PullResponse,
  PushRequest,
  PushResponse,
  QuarantinedOp,
  SyncOperation,
  SyncState,
} from './schema.ts';

/**
 * Everything the engine needs from the outside, as small interfaces. The engine itself holds no
 * state between calls: every method re-reads what it needs, so a suspended and restarted MV3
 * service worker (or a second extension context) behaves the same as a long-lived one.
 */

export interface Clock {
  /** Epoch milliseconds. */
  now(): number;
}

export interface PendingOp {
  op: SyncOperation;
  /** How many times a push containing it was started. Only never-attempted ops may be coalesced. */
  attempts: number;
}

/**
 * Local outbox. `append` and `replace` must take part in the transaction that wrote the entity (in
 * Dexie: call them inside the same `db.transaction`), so a local write and its operation commit or
 * fail together. Order is insertion order.
 */
export interface OpLog {
  append(op: SyncOperation): Promise<void>;
  /** Oldest first. */
  pending(limit: number): Promise<PendingOp[]>;
  /** The unsent, never-attempted operation of an entity, if any. */
  unattemptedFor(entityType: string, entityId: string): Promise<PendingOp | null>;
  /** Remove `removeIds` and (optionally) put `op` in their place, preserving queue position. */
  replace(removeIds: readonly string[], op: SyncOperation | null): Promise<void>;
  countPending(): Promise<number>;
  markAttempted(ids: readonly string[]): Promise<void>;
  markSent(ids: readonly string[], at: number): Promise<void>;
  /** Forget sent operations older than `olderThan` (epoch ms). Returns how many. */
  pruneSent(olderThan: number): Promise<number>;
  /** Drop everything (sign-out with "forget sync", or re-attaching the data to another account). */
  clear(): Promise<void>;
}

/** Sync bookkeeping that is not user data: cursor, clock, per-entity merge metadata, conflicts. */
export interface SyncStateStore {
  loadState(): Promise<SyncState | null>;
  saveState(state: SyncState): Promise<void>;
  getMeta(entityType: string, entityId: string): Promise<EntityMeta | null>;
  putMeta(meta: EntityMeta): Promise<void>;
  deleteMeta(entityType: string, entityId: string): Promise<void>;
  /** Entities whose tombstone is older than `olderThan` epoch ms. */
  listTombstones(olderThan: number, limit: number): Promise<EntityMeta[]>;
  putConflict(conflict: ConflictRecord): Promise<void>;
  getConflict(id: string): Promise<ConflictRecord | null>;
  listConflicts(options?: { unresolvedOnly?: boolean }): Promise<ConflictRecord[]>;
  listConflictsFor(entityType: string, entityId: string): Promise<ConflictRecord[]>;
  deleteConflicts(ids: readonly string[]): Promise<void>;
  putQuarantined(item: QuarantinedOp): Promise<void>;
  /** Oldest first. */
  listQuarantined(): Promise<QuarantinedOp[]>;
  deleteQuarantined(id: string): Promise<void>;
  /** Forget all sync bookkeeping (state, entity metadata, conflicts, quarantine). */
  clearAll(): Promise<void>;
}

export type TransportErrorKind =
  /** No connectivity, DNS, TLS, timeout. Retry later. */
  | 'network'
  /** 401/403: sign in again. */
  | 'auth'
  | 'rate_limited'
  | 'server'
  /** The cursor no longer exists on the server (reset or compacted). */
  | 'cursor_expired'
  /** The server refused this request permanently (400-class). */
  | 'client'
  /** The response was not what the protocol says. */
  | 'protocol';

export class TransportError extends Error {
  constructor(
    readonly kind: TransportErrorKind,
    message: string,
    readonly retryAfterMs?: number,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

/** The network edge. The reference HTTP implementation is `createHttpTransport`. */
export interface Transport {
  push(request: PushRequest): Promise<PushResponse>;
  pull(request: { since: string | null; limit: number }): Promise<PullResponse>;
}

/** Thrown by `Applier.apply` to quarantine an operation without aborting the run. */
export class ApplyRejectedError extends Error {
  constructor(
    readonly reason: 'schema_invalid' | 'unknown_field' | 'unknown_entity_type',
    message: string,
  ) {
    super(message);
    this.name = 'ApplyRejectedError';
  }
}

/** The host's storage, as the engine needs it. Implement on top of the Dexie repositories. */
export interface Applier {
  /** The current row (any shape; device-local fields are filtered out by the engine) or null. */
  read(entityType: string, entityId: string): Promise<Record<string, unknown> | null>;
  /**
   * Make `change` true in storage, atomically. A `create` must supply device-local defaults itself
   * (schemaVersion, resolve status...) and validate the row with the table's own schema: throw
   * `ApplyRejectedError` when it fails. Any other exception aborts the sync run with the cursor
   * unmoved, so the page is retried (applying is idempotent).
   */
  apply(change: AppliedChange): Promise<void>;
}

/** Authenticated data bound to an operation: swapping envelopes between entities/revisions fails. */
export interface OpAad {
  id: string;
  clientId: string;
  entityType: string;
  entityId: string;
  opType: string;
  revision: number;
  hlc: string;
}

export class CodecLockedError extends Error {
  constructor() {
    super('The encryption key is locked');
    this.name = 'CodecLockedError';
  }
}

/** End-to-end encryption of payloads (implemented in crypto.ts). Absent = plaintext mode. */
export interface PayloadCodec {
  /** True in E2EE mode: plaintext operations from the server are refused outright. */
  readonly required: boolean;
  isUnlocked(): boolean;
  encrypt(payload: unknown, aad: OpAad): Promise<EncryptedEnvelope>;
  decrypt(envelope: EncryptedEnvelope, aad: OpAad): Promise<unknown>;
}
