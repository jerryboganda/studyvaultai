import { createContext, useContext } from 'react';
import type { z } from 'zod';
import { browser } from 'wxt/browser';
import { Envelope, StudyVaultError } from '@shared';
import { listSyncConflicts, listSyncQuarantine } from '@storage';
import type { ConflictRecord, QuarantinedOp } from '@sync';
import { SyncRpc, SyncStatusView, type ConflictDecision, type SyncConfigInput } from './protocol';

/**
 * Everything the sync settings UI needs from the outside. The default implementation talks to the
 * service worker (`SyncRpc`), reads the bookkeeping tables through @storage and asks Chrome for
 * permissions; tests pass a fake through `SyncApiProvider`.
 */
export interface SyncApi {
  status(): Promise<SyncStatusView>;
  /** Called whenever the worker publishes a new status. Returns the unsubscribe function. */
  onStatusChanged(listener: (view: SyncStatusView) => void): () => void;
  configure(input: SyncConfigInput): Promise<SyncStatusView>;
  enable(): Promise<SyncStatusView>;
  disable(): Promise<SyncStatusView>;
  signIn(): Promise<{ status: SyncStatusView; needsOrigins: string[] }>;
  signOut(o: { wipeLocalData: boolean; revokeAtProvider: boolean }): Promise<SyncStatusView>;
  syncNow(): Promise<SyncStatusView>;
  /** Upload without end-to-end encryption: the explicit choice that opens the first upload. */
  uploadPlain(): Promise<SyncStatusView>;
  e2eeSetup(passphrase: string): Promise<SyncStatusView>;
  e2eeUnlock(
    passphrase: string,
  ): Promise<{ ok: boolean; reason: 'wrong_passphrase' | 'no_key' | null }>;
  e2eeLock(): Promise<SyncStatusView>;
  e2eeRotate(
    current: string,
    next: string,
  ): Promise<{ ok: boolean; reason: 'wrong_passphrase' | 'no_key' | null; setAside?: number }>;
  resolveConflict(id: string, decision: ConflictDecision): Promise<void>;
  retryQuarantine(): Promise<{ retried: number; remaining: number }>;
  discardQuarantined(id: string): Promise<void>;
  deleteServerData(): Promise<SyncStatusView>;
  reupload(): Promise<SyncStatusView>;
  rebind(): Promise<SyncStatusView>;
  listConflicts(): Promise<ConflictRecord[]>;
  listQuarantine(): Promise<QuarantinedOp[]>;
  /**
   * Chrome's permission prompt. Needs a user gesture: call it from a click handler before any
   * `await`. Resolves false when the user declined.
   */
  requestPermissions(request: {
    origins?: string[];
    permissions?: Array<'identity' | 'alarms'>;
  }): Promise<boolean>;
}

const CALL_TIMEOUT_MS = 130_000;

/** One typed request to the worker, validated both ways. */
async function call<K extends keyof SyncRpc & string>(
  type: K,
  payload: z.input<SyncRpc[K]['payload']>,
): Promise<z.output<SyncRpc[K]['response']>> {
  const def = SyncRpc[type];
  const request = def.payload.safeParse(payload);
  if (!request.success) {
    throw new StudyVaultError(
      'invalid_request',
      `Invalid ${type} request: ${request.error.message}`,
    );
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let raw: unknown;
  try {
    raw = await Promise.race([
      browser.runtime.sendMessage({ v: 1, type, payload: request.data }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('StudyVault did not answer in time. Try again.')),
          CALL_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (err) {
    throw new StudyVaultError(
      'no_receiver',
      err instanceof Error ? err.message : 'StudyVault could not be reached.',
    );
  } finally {
    clearTimeout(timer);
  }
  const envelope = Envelope.safeParse(raw);
  if (!envelope.success) throw new StudyVaultError('internal', `Malformed response to ${type}`);
  if (!envelope.data.ok) {
    throw new StudyVaultError(envelope.data.error.code, envelope.data.error.message);
  }
  const response = def.response.safeParse(envelope.data.data);
  if (!response.success) {
    throw new StudyVaultError('internal', `Invalid ${type} response: ${response.error.message}`);
  }
  return response.data as z.output<SyncRpc[K]['response']>;
}

const STATUS_KEY = 'syncStatus';

export function createSyncApi(): SyncApi {
  const empty = {} as Record<string, never>;
  return {
    status: () => call('sync.status', empty),
    onStatusChanged(listener) {
      const handler = (changes: Record<string, { newValue?: unknown }>, area: string) => {
        if (area !== 'session' || !(STATUS_KEY in changes)) return;
        const parsed = SyncStatusView.safeParse(changes[STATUS_KEY]?.newValue);
        if (parsed.success) listener(parsed.data);
      };
      browser.storage.onChanged.addListener(handler);
      return () => browser.storage.onChanged.removeListener(handler);
    },
    configure: (input) => call('sync.configure', input),
    enable: () => call('sync.enable', empty),
    disable: () => call('sync.disable', empty),
    signIn: () => call('sync.signIn', empty),
    signOut: (o) => call('sync.signOut', o),
    syncNow: () => call('sync.now', empty),
    uploadPlain: () => call('sync.uploadPlain', empty),
    e2eeSetup: (passphrase) => call('sync.e2ee.setup', { passphrase }),
    e2eeUnlock: (passphrase) => call('sync.e2ee.unlock', { passphrase }),
    e2eeLock: () => call('sync.e2ee.lock', empty),
    e2eeRotate: (current, next) => call('sync.e2ee.rotate', { current, next }),
    async resolveConflict(id, decision) {
      await call('sync.conflict.resolve', { id, decision });
    },
    retryQuarantine: () => call('sync.quarantine.retry', empty),
    async discardQuarantined(id) {
      await call('sync.quarantine.discard', { id });
    },
    deleteServerData: () => call('sync.serverData.delete', { confirm: 'delete-all-my-data' }),
    reupload: () => call('sync.reupload', empty),
    rebind: () => call('sync.rebind', empty),
    listConflicts: () => listSyncConflicts({ unresolvedOnly: true }),
    listQuarantine: () => listSyncQuarantine(),
    requestPermissions: (request) => browser.permissions.request(request),
  };
}

let shared: SyncApi | null = null;
const Context = createContext<SyncApi | null>(null);
export const SyncApiProvider = Context.Provider;

export function useSyncApi(): SyncApi {
  return useContext(Context) ?? (shared ??= createSyncApi());
}
