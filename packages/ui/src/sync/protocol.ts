import { z } from 'zod';
import { JsonValueSchema, SYNC_STATUSES } from '@sync';

/**
 * Messages between the sync settings UI and the service worker. Defined here (the UI package) and
 * imported by `entrypoints/background/sync.ts` through the deep path `@ui/sync/protocol`, so the
 * worker bundle does not pull in React. Same wire format as `BackgroundRpc` (see @runtime): the
 * worker serves it with `serveRpc`, extension pages call it with `callSync`.
 *
 * Nothing here carries synchronised content. The one secret that crosses it is the E2EE passphrase
 * typed by the user, which stays inside the extension and is never stored or logged.
 */

const def = <P extends z.ZodType, R extends z.ZodType>(payload: P, response: R) => ({
  payload,
  response,
});
const Empty = z.object({});

/** What the user types in: where the data goes and how to sign in. No secrets. */
export const SyncConfigInput = z.object({
  /** https://host[/prefix]; http only for localhost. */
  serverUrl: z.string().trim().min(1).max(300),
  /** OIDC issuer URL. */
  issuer: z.string().trim().min(1).max(300),
  /** Public client id registered with the provider (PKCE, no secret). */
  clientId: z.string().trim().min(1).max(200),
});
export type SyncConfigInput = z.infer<typeof SyncConfigInput>;

export const SyncStatusView = z.object({
  /** Settings.features.sync. Everything below is only meaningful when it is true. */
  enabled: z.boolean(),
  config: SyncConfigInput.nullable(),
  /** The redirect URI to register with the identity provider. */
  redirectUrl: z.string(),
  permissions: z.object({
    identity: z.boolean(),
    alarms: z.boolean(),
    /** Origin patterns of the configured servers that Chrome has not been asked / allowed yet. */
    missingOrigins: z.array(z.string()),
  }),
  signedIn: z.boolean(),
  account: z.string().nullable(),
  status: z.enum(SYNC_STATUSES),
  lastSyncAt: z.number().nullable(),
  pending: z.number().int().min(0),
  lastError: z.object({ code: z.string(), message: z.string() }).nullable(),
  retryAt: z.number().nullable(),
  running: z.boolean(),
  e2ee: z.object({
    mode: z.enum(['none', 'locked', 'unlocked']),
    version: z.number().int().nullable(),
    /** Seconds until the key is dropped (it is kept in memory-only session storage), when unlocked. */
    lockInSeconds: z.number().int().nullable(),
    /**
     * Why uploads are refused: this device enabled end-to-end encryption, and the server now shows
     * no encryption key, an older one or another one (downgrade protection). Absent/null = none.
     */
    warning: z.string().nullable().optional(),
    /** Stored items the last set-up or passphrase change could not vouch for (see "Refused changes"). */
    setAside: z.number().int().min(0).optional(),
  }),
  /**
   * How uploads are protected. 'undecided' = the person has not chosen: nothing is uploaded yet.
   * Absent (an older worker) is read as already decided.
   */
  encryptionChoice: z.enum(['undecided', 'plaintext', 'e2ee']).optional(),
  attention: z.object({
    conflicts: z.number().int().min(0),
    quarantined: z.number().int().min(0),
  }),
  /** Data types that are not exchanged yet, with the reason in plain words. */
  notSynced: z.array(z.string()),
  /** A problem that stops sync from starting (policy drift, no configuration ...). */
  problem: z.string().nullable(),
  /** Whether a periodic background schedule exists or sync only runs while the worker is awake. */
  scheduling: z.enum(['alarms', 'while-awake']),
});
export type SyncStatusView = z.infer<typeof SyncStatusView>;

export const ConflictDecision = z.discriminatedUnion('choice', [
  z.object({ choice: z.literal('local') }),
  z.object({ choice: z.literal('remote') }),
  z.object({ choice: z.literal('custom'), value: JsonValueSchema }),
  z.object({ choice: z.literal('keep_deleted') }),
  z.object({ choice: z.literal('restore') }),
  z.object({ choice: z.literal('discard') }),
]);
export type ConflictDecision = z.infer<typeof ConflictDecision>;

const Passphrase = z.string().min(1).max(1024);

export const SyncRpc = {
  'sync.status': def(Empty, SyncStatusView),
  'sync.configure': def(SyncConfigInput, SyncStatusView),
  /** Flips Settings.features.sync on and starts recording. The UI asks for permissions first. */
  'sync.enable': def(Empty, SyncStatusView),
  'sync.disable': def(Empty, SyncStatusView),
  /** `needsOrigins` non-empty: ask Chrome for these origins (from a click) and call again. */
  'sync.signIn': def(
    Empty,
    z.object({ status: SyncStatusView, needsOrigins: z.array(z.string()) }),
  ),
  'sync.signOut': def(
    z.object({ wipeLocalData: z.boolean(), revokeAtProvider: z.boolean() }),
    SyncStatusView,
  ),
  'sync.now': def(Empty, SyncStatusView),
  /**
   * The explicit choice to upload WITHOUT end-to-end encryption (the operator of the server can read
   * everything). Until this or a passphrase is chosen, nothing is uploaded.
   */
  'sync.uploadPlain': def(Empty, SyncStatusView),
  'sync.e2ee.setup': def(z.object({ passphrase: Passphrase }), SyncStatusView),
  'sync.e2ee.unlock': def(
    z.object({ passphrase: Passphrase }),
    z.object({ ok: z.boolean(), reason: z.enum(['wrong_passphrase', 'no_key']).nullable() }),
  ),
  'sync.e2ee.lock': def(Empty, SyncStatusView),
  'sync.e2ee.rotate': def(
    z.object({ current: Passphrase, next: Passphrase }),
    z.object({
      ok: z.boolean(),
      reason: z.enum(['wrong_passphrase', 'no_key']).nullable(),
      /** Stored items that could not be vouched for and were not carried over. */
      setAside: z.number().int().min(0).optional(),
    }),
  ),
  'sync.conflict.resolve': def(
    z.object({ id: z.string().min(1).max(512), decision: ConflictDecision }),
    z.object({ resolved: z.boolean() }),
  ),
  'sync.quarantine.retry': def(
    Empty,
    z.object({ retried: z.number().int().min(0), remaining: z.number().int().min(0) }),
  ),
  'sync.quarantine.discard': def(z.object({ id: z.string().min(1).max(200) }), Empty),
  'sync.serverData.delete': def(
    z.object({ confirm: z.literal('delete-all-my-data') }),
    SyncStatusView,
  ),
  /** The server lost or replaced this account's data: send this device's rows again. */
  'sync.reupload': def(Empty, SyncStatusView),
  /** The signed-in account differs from the one this device's data belongs to: attach it. */
  'sync.rebind': def(Empty, SyncStatusView),
} as const;
export type SyncRpc = typeof SyncRpc;
