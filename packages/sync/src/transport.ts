import './zodConfig.ts';
import type { z } from 'zod';
import type { Transport } from './ports.ts';
import { TransportError } from './ports.ts';
import type {
  KeyProfile as KeyProfileType,
  PullResponse as PullResponseType,
  PushRequest,
  PushResponse as PushResponseType,
  RotateRequest,
} from './schema.ts';
import { ErrorBody, KeyProfile, PROTOCOL_VERSION, PullResponse, PushResponse } from './schema.ts';

const MAX_RESPONSE_CHARS = 8 * 1024 * 1024;

export interface HttpTransportOptions {
  /** https://host[:port][/prefix]. Plain http is accepted for localhost only. */
  baseUrl: string;
  fetch: typeof fetch;
  /** Current access token, or null when signed out. `forceRefresh` is passed once after a 401. */
  getAccessToken(options?: { forceRefresh?: boolean }): Promise<string | null>;
  /** Reads Settings.features.sync. Nothing is sent while it is false. */
  isEnabled?: () => boolean | Promise<boolean>;
  timeoutMs?: number;
}

export function normaliseBaseUrl(raw: string): string {
  const url = new URL(raw);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error(
      'The sync server must be reached over https (http is accepted for localhost only).',
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('The sync server address must not contain credentials, a query or a fragment.');
  }
  return url.toString().replace(/\/+$/, '');
}

function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, 60 * 60 * 1000) : undefined;
}

export interface HttpSyncClient extends Transport {
  getKeyProfile(): Promise<KeyProfileType | null>;
  /** Create the first profile (version 1). Changing it is a rotation. */
  putKeyProfile(profile: KeyProfileType): Promise<void>;
  /** Atomically re-encrypt the whole log under a new key profile. */
  rotate(request: RotateRequest): Promise<void>;
  /** Permanently delete everything the server holds for this account. */
  deleteAllData(): Promise<void>;
}

/**
 * fetch-based client of the reference protocol. No cookies (credentials: 'omit'), no redirects (a
 * bearer token must never follow one), every response validated, every failure classified.
 */
export function createHttpTransport(o: HttpTransportOptions): HttpSyncClient {
  const base = normaliseBaseUrl(o.baseUrl);
  const timeoutMs = o.timeoutMs ?? 20_000;

  async function call(
    method: string,
    path: string,
    body?: unknown,
    allow404 = false,
  ): Promise<unknown> {
    if (o.isEnabled && !(await o.isEnabled())) {
      throw new TransportError('client', 'Sync is turned off.');
    }
    for (let attempt = 0; ; attempt++) {
      const token = await o.getAccessToken(attempt > 0 ? { forceRefresh: true } : undefined);
      if (!token) throw new TransportError('auth', 'Not signed in.');
      let res: Response;
      try {
        res = await o.fetch(`${base}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/json',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
        });
      } catch (e) {
        throw new TransportError('network', e instanceof Error ? e.message : 'Network error');
      }
      if (res.status === 401 && attempt === 0) continue; // once, with a refreshed token
      const text = await res.text().catch(() => '');
      if (text.length > MAX_RESPONSE_CHARS)
        throw new TransportError('protocol', 'Response too large.');
      let json: unknown = null;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          if (res.ok) throw new TransportError('protocol', 'Response is not JSON.');
        }
      }
      if (res.ok) return json;
      if (res.status === 404 && allow404) return null;
      const err = ErrorBody.safeParse(json);
      const message = err.success ? err.data.error.message : `HTTP ${res.status}`;
      const code = err.success ? err.data.error.code : '';
      const wait =
        retryAfterMs(res.headers.get('retry-after')) ??
        (err.success ? err.data.error.retryAfterMs : undefined);
      if (res.status === 401 || res.status === 403) {
        throw new TransportError('auth', message, undefined, res.status);
      }
      if (res.status === 410 || code === 'cursor_expired') {
        throw new TransportError('cursor_expired', message, undefined, res.status);
      }
      if (res.status === 429)
        throw new TransportError('rate_limited', message, wait ?? 30_000, res.status);
      if (res.status === 408 || res.status >= 500) {
        throw new TransportError('server', message, wait, res.status);
      }
      throw new TransportError('client', message, undefined, res.status);
    }
  }

  function parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const r = schema.safeParse(value);
    if (!r.success) {
      throw new TransportError('protocol', 'The server response does not match the protocol.');
    }
    return r.data;
  }

  return {
    async push(request: PushRequest): Promise<PushResponseType> {
      return parse(
        PushResponse,
        await call('POST', '/v1/ops', { ...request, v: PROTOCOL_VERSION }),
      );
    },
    async pull({ since, limit }): Promise<PullResponseType> {
      const q = new URLSearchParams({ limit: String(limit) });
      if (since !== null) q.set('since', since);
      return parse(PullResponse, await call('GET', `/v1/ops?${q.toString()}`));
    },
    async getKeyProfile() {
      const json = await call('GET', '/v1/e2ee/profile', undefined, true);
      return json === null ? null : parse(KeyProfile, json);
    },
    async putKeyProfile(profile) {
      await call('PUT', '/v1/e2ee/profile', profile);
    },
    async rotate(request) {
      await call('POST', '/v1/e2ee/rotate', request);
    },
    async deleteAllData() {
      await call('DELETE', '/v1/data', { confirm: 'delete-all-my-data' });
    },
  };
}
