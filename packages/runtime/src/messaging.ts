import type { z } from 'zod';
import { browser, type Browser } from 'wxt/browser';
import {
  BackgroundRpc,
  Envelope,
  StudyVaultError,
  TabRpc,
  WireMessage,
  type ErrorCode,
} from '@shared';

type RpcMap = Record<string, { payload: z.ZodType; response: z.ZodType }>;
type Sender = Browser.runtime.MessageSender;

/**
 * Nothing in this transport may wait forever: an extension page that never gets an answer spins
 * for ever, and chrome.runtime.sendMessage has no timeout of its own.
 * A handler that has not answered by HANDLER_TIMEOUT_MS gets an error reply from the worker; a
 * caller gives up after CALL_TIMEOUT_MS, which is longer so the worker's own verdict wins.
 */
export const HANDLER_TIMEOUT_MS = 15_000;
export const CALL_TIMEOUT_MS = 20_000;

export interface CallOptions {
  /** Give up waiting after this long (default CALL_TIMEOUT_MS). */
  timeoutMs?: number;
}

/**
 * Run `work`, rejecting with `onTimeout()` when it has not settled within `ms`. A synchronous
 * throw from `work` is a rejection too. The slow work itself is not cancelled.
 */
async function settleWithin<T>(
  work: () => Promise<T> | T,
  ms: number,
  onTimeout: () => Error,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  try {
    return await Promise.race([new Promise<T>((resolve) => resolve(work())), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function call<M extends RpcMap, K extends keyof M & string>(
  map: M,
  type: K,
  payload: z.input<M[K]['payload']>,
  send: (message: unknown) => Promise<unknown>,
  timeoutMs: number,
): Promise<z.output<M[K]['response']>> {
  const def = map[type]!;
  const parsedPayload = def.payload.safeParse(payload);
  if (!parsedPayload.success) {
    throw new StudyVaultError(
      'invalid_request',
      `Invalid ${type} payload: ${parsedPayload.error.message}`,
    );
  }
  let raw: unknown;
  try {
    raw = await settleWithin(
      () => send({ v: 1, type, payload: parsedPayload.data }),
      timeoutMs,
      () =>
        new StudyVaultError(
          'no_receiver',
          `No answer to ${type} within ${Math.round(timeoutMs / 1000)} seconds.`,
        ),
    );
  } catch (err) {
    // No receiver (restricted page, content script not injected), the worker failed to start, or
    // nobody answered in time.
    throw new StudyVaultError('no_receiver', err instanceof Error ? err.message : String(err));
  }
  const envelope = Envelope.safeParse(raw);
  if (!envelope.success) throw new StudyVaultError('internal', `Malformed response to ${type}`);
  if (!envelope.data.ok)
    throw new StudyVaultError(envelope.data.error.code, envelope.data.error.message);
  const parsed = def.response.safeParse(envelope.data.data);
  if (!parsed.success)
    throw new StudyVaultError('internal', `Invalid ${type} response: ${parsed.error.message}`);
  return parsed.data as z.output<M[K]['response']>;
}

/** Content script / extension page -> service worker. */
export function callBackground<K extends keyof BackgroundRpc & string>(
  type: K,
  payload: z.input<BackgroundRpc[K]['payload']>,
  options: CallOptions = {},
): Promise<z.output<BackgroundRpc[K]['response']>> {
  return call(
    BackgroundRpc,
    type,
    payload,
    (m) => browser.runtime.sendMessage(m),
    options.timeoutMs ?? CALL_TIMEOUT_MS,
  );
}

/** Service worker / extension page -> content script in `tabId`. */
export function callTab<K extends keyof TabRpc & string>(
  tabId: number,
  type: K,
  payload: z.input<TabRpc[K]['payload']>,
  options: CallOptions = {},
): Promise<z.output<TabRpc[K]['response']>> {
  return call(
    TabRpc,
    type,
    payload,
    (m) => browser.tabs.sendMessage(tabId, m),
    options.timeoutMs ?? CALL_TIMEOUT_MS,
  );
}

export type Handlers<M extends RpcMap> = {
  [K in keyof M & string]?: (
    payload: z.output<M[K]['payload']>,
    sender: Sender,
  ) => Promise<z.input<M[K]['response']>>;
};

function toError(err: unknown): { code: ErrorCode; message: string } {
  if (err instanceof StudyVaultError) return { code: err.code, message: err.message };
  return { code: 'internal', message: err instanceof Error ? err.message : String(err) };
}

/**
 * Register handlers for one RPC map. Messages of other maps (or foreign messages) are ignored so
 * several receivers can coexist. Senders from other extensions are rejected. Every accepted
 * request is answered: a handler that throws (even synchronously) or does not settle within
 * `timeoutMs` produces an error reply instead of leaving the caller waiting.
 * Returns an unsubscribe function.
 */
export function serveRpc<M extends RpcMap>(
  map: M,
  handlers: Handlers<M>,
  { timeoutMs = HANDLER_TIMEOUT_MS }: { timeoutMs?: number } = {},
): () => void {
  const listener = (message: unknown, sender: Sender, sendResponse: (r: unknown) => void) => {
    const wire = WireMessage.safeParse(message);
    if (!wire.success || !Object.hasOwn(map, wire.data.type)) return undefined;
    if (sender.id !== browser.runtime.id) {
      sendResponse({ ok: false, error: { code: 'forbidden', message: 'Unknown sender' } });
      return undefined;
    }
    const type = wire.data.type as keyof M & string;
    const handler = handlers[type];
    if (!handler) {
      sendResponse({ ok: false, error: { code: 'not_found', message: `No handler for ${type}` } });
      return undefined;
    }
    const payload = map[type]!.payload.safeParse(wire.data.payload);
    if (!payload.success) {
      sendResponse({
        ok: false,
        error: { code: 'invalid_request', message: payload.error.message },
      });
      return undefined;
    }
    settleWithin(
      () => handler(payload.data as never, sender),
      timeoutMs,
      () =>
        new StudyVaultError(
          'internal',
          `The background worker did not finish ${type} within ${Math.round(timeoutMs / 1000)} seconds. Try again; if it keeps happening, reload the extension.`,
        ),
    ).then(
      (data) => sendResponse({ ok: true, data }),
      (err: unknown) => sendResponse({ ok: false, error: toError(err) }),
    );
    return true; // keep the channel open for the async response
  };
  browser.runtime.onMessage.addListener(listener);
  return () => browser.runtime.onMessage.removeListener(listener);
}
