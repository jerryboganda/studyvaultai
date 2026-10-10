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

async function call<M extends RpcMap, K extends keyof M & string>(
  map: M,
  type: K,
  payload: z.input<M[K]['payload']>,
  send: (message: unknown) => Promise<unknown>,
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
    raw = await send({ v: 1, type, payload: parsedPayload.data });
  } catch (err) {
    // No receiver (restricted page, content script not injected) or the worker failed to start.
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
): Promise<z.output<BackgroundRpc[K]['response']>> {
  return call(BackgroundRpc, type, payload, (m) => browser.runtime.sendMessage(m));
}

/** Service worker / extension page -> content script in `tabId`. */
export function callTab<K extends keyof TabRpc & string>(
  tabId: number,
  type: K,
  payload: z.input<TabRpc[K]['payload']>,
): Promise<z.output<TabRpc[K]['response']>> {
  return call(TabRpc, type, payload, (m) => browser.tabs.sendMessage(tabId, m));
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
 * several receivers can coexist. Senders from other extensions are rejected.
 * Returns an unsubscribe function.
 */
export function serveRpc<M extends RpcMap>(map: M, handlers: Handlers<M>): () => void {
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
    handler(payload.data as never, sender).then(
      (data) => sendResponse({ ok: true, data }),
      (err: unknown) => sendResponse({ ok: false, error: toError(err) }),
    );
    return true; // keep the channel open for the async response
  };
  browser.runtime.onMessage.addListener(listener);
  return () => browser.runtime.onMessage.removeListener(listener);
}
