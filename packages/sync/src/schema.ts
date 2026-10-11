import './zodConfig.ts';
import { z } from 'zod';
import { HLC_PATTERN } from './hlc.ts';
import type { JsonValue } from './json.ts';
import { isJsonValue } from './json.ts';

/**
 * Wire protocol and persisted state of optional synchronisation (DATA_MODEL "SyncOperation").
 * Dependencies: zod only. The reference server (server/) imports this module, so the protocol has one
 * definition. Nothing in this package runs unless Settings.features.sync is on.
 */

export const PROTOCOL_VERSION = 1 as const;

/** Wire limits. The reference server enforces the same numbers. */
export const LIMITS = {
  /** Operations per push request. */
  maxBatchOps: 100,
  /** Serialised size of one operation envelope. */
  maxOpBytes: 256 * 1024,
  /** Causal predecessors listed per field. */
  maxPrevPerField: 8,
  /** Members added/removed per set field per operation. */
  maxSetMembers: 2000,
  /** Fields per operation payload. */
  maxFields: 256,
  /** Clocks of superseded values remembered per field (stale duplicate detection). */
  maxAncestry: 16,
} as const;

// ---------------------------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------------------------

/** No C0 control characters or DEL (also keeps log lines and file names clean). */
const printable = (s: string) =>
  ![...s].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
const base64url = /^[A-Za-z0-9_-]+$/;

export const Hlc = z.string().regex(HLC_PATTERN, 'invalid hybrid logical clock');
export type Hlc = z.infer<typeof Hlc>;

/** Names that would collide with Object.prototype members when used as record keys. */
const plainKey = (s: string) => !(s in Object.prototype);

/** Stable per-installation identifier (UUIDv7). A restored backup must be given a new one. */
export const ClientId = z
  .string()
  .regex(/^[0-9A-Za-z_-]{8,64}$/, 'invalid client id')
  .refine(plainKey, 'invalid client id');
export const OpId = z.string().regex(/^[0-9A-Za-z_-]{8,64}$/, 'invalid operation id');
export const EntityType = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/, 'invalid entity type')
  .refine(plainKey, 'invalid entity type');
export const EntityId = z.string().min(1).max(256).refine(printable, 'invalid entity id');
export const FieldName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, 'invalid field name')
  .refine(plainKey, 'invalid field name');
export const Member = z
  .string()
  .min(1)
  .max(256)
  .refine(printable, 'invalid set member')
  .refine(plainKey, 'invalid set member');
export const JsonValueSchema = z.custom<JsonValue>((v) => isJsonValue(v), 'not plain JSON');
export const EpochMs = z.number().int().min(0);
export const IsoDate = z.iso.datetime();

/** Opaque server position. The reference server uses a decimal sequence number. */
export const SyncCursor = z.string().min(1).max(128);
export type SyncCursor = z.infer<typeof SyncCursor>;

// ---------------------------------------------------------------------------------------------
// Operation payloads
// ---------------------------------------------------------------------------------------------

/** AES-256-GCM ciphertext of one JSON-encoded OpPayload. `kid` names the key version used. */
export const EncryptedEnvelope = z.object({
  v: z.literal(1),
  alg: z.literal('A256GCM'),
  kid: z.string().regex(/^[0-9A-Za-z_-]{1,64}$/),
  /** 96-bit random IV, base64url (16 chars). */
  iv: z.string().length(16).regex(base64url),
  /** Ciphertext || 128-bit tag, base64url. */
  ct: z.string().min(22).max(LIMITS.maxOpBytes).regex(base64url),
});
export type EncryptedEnvelope = z.infer<typeof EncryptedEnvelope>;

/** Membership delta of one set-valued field. Remove wins over a concurrent add. */
export const SetDelta = z.object({
  add: z.array(Member).max(LIMITS.maxSetMembers),
  remove: z.array(Member).max(LIMITS.maxSetMembers),
  /**
   * For each added member: the removal clock the writer had already observed. An add that has seen
   * the latest removal re-adds legitimately; one that has not is concurrent and loses (remove wins).
   */
  seen: z
    .record(Member, Hlc)
    .refine((r) => Object.keys(r).length <= LIMITS.maxSetMembers, 'too many members'),
});
export type SetDelta = z.infer<typeof SetDelta>;

/**
 * Decrypted body of an operation. A patch: only fields the writer changed (all of them when `full`).
 * Causal metadata lives in here, not in the envelope, so an E2EE server learns none of it.
 */
export const OpPayload = z
  .object({
    v: z.literal(1),
    /** `set` holds every syncable field of the entity (create, first sync, resurrection). */
    full: z.boolean(),
    /** New values of scalar and text fields. */
    set: z.record(FieldName, JsonValueSchema),
    /**
     * For each field in `set` (and, for deletes, every field): the clocks of the values the writer
     * replaced. A receiver whose current clock is among them is looking at a fast-forward; otherwise
     * the edits are concurrent. A conflict resolution lists both sides it supersedes.
     */
    prev: z.record(FieldName, z.array(Hlc).max(LIMITS.maxPrevPerField)),
    /** Previous value of free-text fields: the common ancestor for a three-way merge in the UI. */
    base: z.record(FieldName, JsonValueSchema),
    /** Set-valued fields. */
    sets: z.record(FieldName, SetDelta),
    /** Entity tombstone clock the writer had observed when it wrote an upsert (remove-wins causality). */
    observed: Hlc.nullable(),
  })
  .refine((p) => Object.keys(p.set).length <= LIMITS.maxFields, 'too many fields')
  .refine((p) => Object.keys(p.sets).length <= LIMITS.maxFields, 'too many set fields');
export type OpPayload = z.infer<typeof OpPayload>;

export const OP_TYPES = ['upsert', 'delete'] as const;

const PlainPayload = z.record(z.string(), z.unknown());

export const SyncOperation = z
  .object({
    /** UUIDv7/ULID, unique per operation. */
    id: OpId,
    clientId: ClientId,
    entityType: EntityType,
    entityId: EntityId,
    opType: z.enum(OP_TYPES),
    /** Per-entity monotonic counter: max revision the writer had applied, plus one. */
    revision: z.number().int().min(1).max(2_147_483_647),
    /** Hybrid logical clock: the total order used for last-writer-wins. */
    hlc: Hlc,
    /** The entity revision the writer had applied when it made this change (0 = creation). */
    baseRevision: z.number().int().min(0).max(2_147_483_647),
    /** OpPayload, or the encrypted envelope of one when `payloadEncrypted`. */
    payload: z.union([EncryptedEnvelope, PlainPayload]),
    payloadEncrypted: z.boolean(),
    tombstone: z.boolean(),
    /** Deterministic per logical operation; the server de-duplicates replays on it. */
    idempotencyKey: z
      .string()
      .min(8)
      .max(200)
      .regex(/^[\x21-\x7e]+$/),
    createdAt: IsoDate,
  })
  .superRefine((op, ctx) => {
    if (op.tombstone !== (op.opType === 'delete')) {
      ctx.addIssue({ code: 'custom', message: 'tombstone must be set exactly for deletes' });
    }
    if (op.revision <= op.baseRevision) {
      ctx.addIssue({ code: 'custom', message: 'revision must exceed baseRevision' });
    }
    if (op.payloadEncrypted !== EncryptedEnvelope.safeParse(op.payload).success) {
      ctx.addIssue({ code: 'custom', message: 'payloadEncrypted does not match payload' });
    }
  });
export type SyncOperation = z.infer<typeof SyncOperation>;

// ---------------------------------------------------------------------------------------------
// HTTP wire format (POST /v1/ops, GET /v1/ops, key profile)
// ---------------------------------------------------------------------------------------------

export const PushRejectCode = z.enum([
  'invalid_op',
  'payload_too_large',
  'hlc_in_future',
  'idempotency_conflict',
  'client_mismatch',
  'quota_exceeded',
]);
export type PushRejectCode = z.infer<typeof PushRejectCode>;

/** Operations are validated one by one server-side, so a single bad one cannot wedge a batch. */
export const PushRequest = z.object({
  v: z.literal(PROTOCOL_VERSION),
  clientId: ClientId,
  ops: z.array(z.unknown()).min(1).max(LIMITS.maxBatchOps),
});
export type PushRequest = z.infer<typeof PushRequest>;

export const PushResult = z.object({
  id: z.string().max(64).nullable(),
  idempotencyKey: z.string().max(200).nullable(),
  status: z.enum(['accepted', 'duplicate', 'rejected']),
  cursor: SyncCursor.nullable(),
  code: PushRejectCode.nullable(),
  message: z.string().max(300).nullable(),
});
export type PushResult = z.infer<typeof PushResult>;

/**
 * Identity of one generation of an account's server data. It changes when the data is erased or the
 * server starts over, so a device can tell "my cursor is stale" from "the server is a different one".
 */
export const Epoch = z.string().min(8).max(64);

export const PushResponse = z.object({
  v: z.literal(PROTOCOL_VERSION),
  results: z.array(PushResult).max(LIMITS.maxBatchOps),
  epoch: Epoch,
  head: SyncCursor,
  serverTime: IsoDate,
});
export type PushResponse = z.infer<typeof PushResponse>;

export const PullResponse = z.object({
  v: z.literal(PROTOCOL_VERSION),
  /** Envelopes are validated individually by the client (one malformed op must not block a page). */
  ops: z.array(z.object({ cursor: SyncCursor, op: z.unknown() })).max(1000),
  nextCursor: SyncCursor,
  hasMore: z.boolean(),
  epoch: Epoch,
  head: SyncCursor,
  serverTime: IsoDate,
});
export type PullResponse = z.infer<typeof PullResponse>;

/** Structured error body of every non-2xx response. */
export const ErrorBody = z.object({
  error: z.object({
    code: z.string().max(64),
    message: z.string().max(500),
    retryAfterMs: z.number().int().min(0).optional(),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

/**
 * Public parameters of the E2EE key (stored server-side, safe to disclose: salt, cost, and a check
 * value that only proves a passphrase right or wrong). No key material, ever.
 */
export const KeyProfile = z.object({
  v: z.literal(1),
  kdf: z.literal('PBKDF2-SHA256'),
  iterations: z.number().int().min(600_000).max(10_000_000),
  /** 16..64 random bytes, base64url. */
  salt: z.string().min(22).max(86).regex(base64url),
  /** Key version id, carried by every envelope. */
  kid: z.string().regex(/^[0-9A-Za-z_-]{1,64}$/),
  /** 1 for the first key, +1 per rotation. The server accepts a replacement only at version + 1. */
  version: z.number().int().min(1).max(1_000_000),
  /** HMAC-SHA-256 of a constant under a key derived from the passphrase (32 bytes, base64url). */
  keyCheck: z.string().length(43).regex(base64url),
  createdAt: IsoDate,
});
export type KeyProfile = z.infer<typeof KeyProfile>;

/** Atomically re-encrypt the whole log under a new key (rotation). */
export const RotateRequest = z.object({
  profile: KeyProfile,
  replacements: z.array(z.object({ id: OpId, payload: EncryptedEnvelope })).max(100_000),
});
export type RotateRequest = z.infer<typeof RotateRequest>;

// ---------------------------------------------------------------------------------------------
// Persisted client state (plain data: everything resumes after a service-worker restart)
// ---------------------------------------------------------------------------------------------

export const SYNC_STATUSES = [
  'disabled',
  'idle',
  'syncing',
  'offline',
  'backoff',
  'auth_required',
  'locked',
  /** Signed in, but the person has not yet chosen how uploads are protected: nothing is sent. */
  'awaiting_encryption_choice',
  'resync_required',
  'account_mismatch',
  'error',
] as const;
export const SyncStatus = z.enum(SYNC_STATUSES);
export type SyncStatus = z.infer<typeof SyncStatus>;

export const SyncState = z.object({
  v: z.literal(1),
  clientId: ClientId,
  /** Account (OIDC `sub`) this device's data is attached to; a different one is never merged silently. */
  accountId: z.string().max(256).nullable(),
  cursor: SyncCursor.nullable(),
  /** Server data generation the cursor belongs to; a different one means "start over" (see Epoch). */
  epoch: Epoch.nullable().default(null),
  /** Unsent local operations (denormalised for the UI; the OpLog is authoritative). */
  pending: z.number().int().min(0),
  lastSyncAt: EpochMs.nullable(),
  status: SyncStatus,
  lastError: z
    .object({ code: z.string().max(64), message: z.string().max(500), at: EpochMs })
    .nullable(),
  backoff: z.object({ attempt: z.number().int().min(0), nextAttemptAt: EpochMs.nullable() }),
  hlc: z.object({ wall: EpochMs, counter: z.number().int().min(0) }),
  /** Set when remote operations had to be dropped or the queue overflowed: pull everything again. */
  needsResync: z.boolean(),
});
export type SyncState = z.infer<typeof SyncState>;

const FieldClock = z.object({
  /** Clock of the operation that wrote the current value. */
  c: Hlc,
  /** Clocks of values this one superseded (most recent first), to ignore stale re-deliveries. */
  a: z.array(Hlc).max(LIMITS.maxAncestry),
});

const MemberState = z.object({
  has: z.boolean(),
  /** Latest removal clock. */
  rm: Hlc.nullable(),
  /** Greatest removal clock any add had observed. Present iff has and (no rm or ao >= rm). */
  ao: Hlc.nullable(),
});

/** Merge metadata of one entity. Small, convergent (every component is a max/or join). */
export const EntityMeta = z.object({
  entityType: EntityType,
  entityId: EntityId,
  /** Per-entity revision: max applied. */
  revision: z.number().int().min(0),
  /** Highest revision applied per client (per-entity revision vector). */
  vector: z.record(ClientId, z.number().int().min(0)),
  fields: z.record(FieldName, FieldClock),
  sets: z.record(FieldName, z.record(Member, MemberState)),
  /** Any upsert seen. */
  born: z.boolean(),
  /** Entity tombstone clock (latest delete) and greatest tombstone clock any upsert had observed. */
  rm: Hlc.nullable(),
  ao: Hlc.nullable(),
  /** When the tombstone was created (epoch ms, for retention). */
  tombstoneAt: EpochMs.nullable(),
  /**
   * SHA-256 fingerprints of immutable fields at first sight (key "*" = a whole append-only row).
   * They outlive a delete, so "delete then re-create with other provenance" is refused too.
   */
  frozen: z.record(z.string().max(64), z.string().length(64)).default({}),
});
export type EntityMeta = z.infer<typeof EntityMeta>;

const ConflictSide = z.object({
  /** The value (text fields), the row (deletes) or null when that side has nothing. */
  value: JsonValueSchema,
  hlc: Hlc.nullable(),
});

export const CONFLICT_KINDS = ['text_edit', 'deleted_remotely', 'edit_lost_to_delete'] as const;
export const CONFLICT_CHOICES = [
  'local',
  'remote',
  'custom',
  'keep_deleted',
  'restore',
  'discard',
  'superseded',
] as const;

/**
 * Both versions of something that was changed on two devices without either seeing the other. The
 * field keeps the last-writer-wins value; the other side is retained here until the user decides.
 */
export const ConflictRecord = z.object({
  /** Deterministic from its content, so re-delivery never duplicates a record. */
  id: z.string().min(1).max(512),
  entityType: EntityType,
  entityId: EntityId,
  /** null for whole-entity conflicts (a delete against an edit). */
  field: FieldName.nullable(),
  kind: z.enum(CONFLICT_KINDS),
  local: ConflictSide,
  remote: ConflictSide,
  /** Common ancestor when the remote writer supplied it. */
  base: JsonValueSchema.nullable(),
  detectedAt: EpochMs,
  resolution: z
    .object({
      choice: z.enum(CONFLICT_CHOICES),
      value: JsonValueSchema,
      resolvedAt: EpochMs,
    })
    .nullable(),
});
export type ConflictRecord = z.infer<typeof ConflictRecord>;

export const REJECT_REASONS = [
  'invalid_op',
  'immutable_field',
  'unknown_entity_type',
  'unknown_field',
  'schema_invalid',
  'decrypt_failed',
  'locked',
  'plaintext_in_e2ee',
  'clock_skew',
  'awaiting_create',
] as const;
export const RejectReason = z.enum(REJECT_REASONS);
export type RejectReason = z.infer<typeof RejectReason>;

/** Reasons a later attempt can succeed (client upgraded, key entered, create arrived, time passed). */
export const RETRYABLE_REASONS: ReadonlySet<RejectReason> = new Set([
  'unknown_entity_type',
  'unknown_field',
  'schema_invalid',
  'locked',
  'clock_skew',
  'awaiting_create',
]);

/** A remote operation that was not applied, kept so nothing is silently dropped. */
export const QuarantinedOp = z.object({
  /** Operation id, or a digest when the envelope itself was malformed. */
  id: z.string().min(1).max(200),
  entityType: z.string().max(64).nullable(),
  entityId: z.string().max(256).nullable(),
  reason: RejectReason,
  detail: z.string().max(500),
  at: EpochMs,
  /** The envelope as received (null when it was too malformed to keep). */
  op: z.unknown(),
});
export type QuarantinedOp = z.infer<typeof QuarantinedOp>;
