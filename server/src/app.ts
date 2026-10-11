import { createHash } from 'node:crypto';
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { hlcWallMs } from '../../packages/sync/src/hlc.ts';
import {
  KeyProfile,
  LIMITS,
  PROTOCOL_VERSION,
  PushRequest,
  RotateRequest,
  SyncOperation,
} from '../../packages/sync/src/schema.ts';
import type { PushRejectCode, PushResult } from '../../packages/sync/src/schema.ts';
import type { TokenVerifier } from './auth.ts';
import type { ServerConfig } from './config.ts';
import { RateLimiter } from './limits.ts';
import type { OpStore } from './store.ts';
import { hashOperation } from './store.ts';

/**
 * Reference implementation of the sync protocol over node:http.
 *
 *   GET    /v1/health               liveness, no auth, reveals nothing about data
 *   POST   /v1/ops                  push a batch (idempotent per operation)
 *   GET    /v1/ops?since=&limit=    pull in server order
 *   GET    /v1/e2ee/profile         key profile (salt, KDF cost, check value; never key material)
 *   PUT    /v1/e2ee/profile         create the first profile
 *   POST   /v1/e2ee/rotate          swap profile and re-encrypted payloads atomically
 *   DELETE /v1/data                 erase everything held for the caller
 *
 * Authentication is a bearer token in the Authorization header, never a cookie. Browsers do not
 * attach such headers on their own, so a page on another site cannot make a request that carries a
 * user's credentials: cross-site request forgery does not apply to this API. CORS is therefore an
 * allow-list for legitimate callers, never `*`, and `Access-Control-Allow-Credentials` is not sent.
 */

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterMs: number | undefined;
  readonly headers: Record<string, string>;

  constructor(
    status: number,
    code: string,
    message: string,
    retryAfterMs?: number,
    headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
    this.headers = headers;
  }
}

export interface LogEvent {
  event: 'request' | 'auth_failure' | 'rate_limited' | 'origin_rejected' | 'error';
  route: string;
  status: number;
  ms?: number;
  /** Truncated digest of the user id, never the id or any token. */
  user?: string;
  detail?: string;
}

export interface AppDeps {
  config: ServerConfig;
  store: OpStore;
  verifier: TokenVerifier;
  now?: () => number;
  log?: (e: LogEvent) => void;
}

const BEARER = /^Bearer ([A-Za-z0-9\-._~+/]{1,8000}=*)$/;
const CONFIRM = z.object({ confirm: z.literal('delete-all-my-data') });

export function createSyncServer(deps: AppDeps): http.Server {
  const { config, store, verifier } = deps;
  const now = deps.now ?? Date.now;
  const log =
    deps.log ?? ((e) => console.log(JSON.stringify({ ts: new Date(now()).toISOString(), ...e })));
  const ipLimiter = new RateLimiter(config.ipRatePerMinute, 60_000);
  const userLimiter = new RateLimiter(config.userRatePerMinute, 60_000);
  const allowedOrigins = new Set(config.corsOrigins);

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const started = now();
    const url = new URL(req.url ?? '/', 'http://sync.invalid');
    const route = `${req.method ?? '?'} ${url.pathname}`;
    let userTag: string | undefined;
    let status = 500;

    const send = (code: number, body: unknown, extra: Record<string, string> = {}) => {
      status = code;
      const payload = body === undefined ? '' : JSON.stringify(body);
      res.writeHead(code, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
        ...corsHeaders,
        ...extra,
      });
      res.end(payload);
    };

    const origin = req.headers.origin;
    const corsHeaders: Record<string, string> = {};
    if (typeof origin === 'string' && allowedOrigins.has(origin)) {
      corsHeaders['access-control-allow-origin'] = origin;
      corsHeaders['vary'] = 'Origin';
      corsHeaders['access-control-expose-headers'] = 'retry-after';
    }

    try {
      if (url.pathname === '/v1/health' && req.method === 'GET') {
        send(200, {
          status: 'ok',
          protocol: PROTOCOL_VERSION,
          time: new Date(now()).toISOString(),
        });
        return;
      }
      if (typeof origin === 'string' && !allowedOrigins.has(origin)) {
        log({ event: 'origin_rejected', route, status: 403 });
        throw new HttpError(403, 'origin_not_allowed', 'This origin may not use the API.');
      }
      if (req.method === 'OPTIONS') {
        send(204, undefined, {
          'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'access-control-allow-headers': 'authorization, content-type',
          'access-control-max-age': '600',
        });
        return;
      }

      const ip = clientIp(req, config.trustProxy);
      const ipWait = ipLimiter.hit(ip, now());
      if (ipWait > 0) {
        log({ event: 'rate_limited', route, status: 429, detail: 'ip' });
        throw new HttpError(429, 'rate_limited', 'Too many requests.', ipWait);
      }

      const token = BEARER.exec(String(req.headers.authorization ?? ''))?.[1] ?? null;
      const principal = token ? await verifier(token) : null;
      if (!principal) {
        log({ event: 'auth_failure', route, status: 401 });
        res.setHeader('www-authenticate', 'Bearer');
        throw new HttpError(401, 'unauthorized', 'A valid bearer token is required.');
      }
      const userId = principal.userId;
      userTag = createHash('sha256').update(userId).digest('hex').slice(0, 12);
      const userWait = userLimiter.hit(userId, now());
      if (userWait > 0) {
        log({ event: 'rate_limited', route, status: 429, detail: 'user', user: userTag });
        throw new HttpError(429, 'rate_limited', 'Too many requests.', userWait);
      }

      if (url.pathname === '/v1/ops') {
        if (req.method === 'POST') return void send(200, await push(userId, await readJson(req)));
        if (req.method === 'GET') return void send(200, await pull(userId, url));
        throw methodNotAllowed('GET, POST');
      }
      if (url.pathname === '/v1/e2ee/profile') {
        if (req.method === 'GET') {
          const profile = await store.getProfile(userId);
          if (!profile) throw new HttpError(404, 'not_found', 'No key profile.');
          return void send(200, profile);
        }
        if (req.method === 'PUT') {
          const parsed = KeyProfile.safeParse(await readJson(req));
          if (!parsed.success) throw new HttpError(400, 'invalid_request', 'Invalid key profile.');
          const r = await store.createProfile(userId, parsed.data);
          if (r === 'exists')
            throw new HttpError(
              409,
              'profile_exists',
              'A key profile already exists; rotate instead.',
            );
          if (r === 'version_conflict')
            throw new HttpError(409, 'version_conflict', 'The first profile must be version 1.');
          return void send(201, parsed.data);
        }
        throw methodNotAllowed('GET, PUT');
      }
      if (url.pathname === '/v1/e2ee/rotate') {
        if (req.method !== 'POST') throw methodNotAllowed('POST');
        const parsed = RotateRequest.safeParse(await readJson(req));
        if (!parsed.success)
          throw new HttpError(400, 'invalid_request', 'Invalid rotation request.');
        const map = new Map(parsed.data.replacements.map((r) => [r.id, r.payload] as const));
        if (map.size !== parsed.data.replacements.length) {
          throw new HttpError(400, 'invalid_request', 'Duplicate operation ids in rotation.');
        }
        const r = await store.rotate(userId, parsed.data.profile, map);
        if (r === 'version_conflict')
          throw new HttpError(409, 'version_conflict', 'Profile version must be current + 1.');
        if (r === 'incomplete') {
          throw new HttpError(
            409,
            'incomplete_rotation',
            'The rotation must re-encrypt every stored operation.',
          );
        }
        return void send(200, { ok: true });
      }
      if (url.pathname === '/v1/data') {
        if (req.method !== 'DELETE') throw methodNotAllowed('DELETE');
        if (!CONFIRM.safeParse(await readJson(req)).success) {
          throw new HttpError(400, 'invalid_request', 'Confirmation missing.');
        }
        await store.deleteUser(userId);
        return void send(200, { ok: true });
      }
      throw new HttpError(404, 'not_found', 'No such route.');
    } catch (e) {
      const err = e instanceof HttpError ? e : new HttpError(500, 'internal', 'Internal error.');
      if (!(e instanceof HttpError))
        log({
          event: 'error',
          route,
          status: 500,
          detail: String((e as Error)?.message).slice(0, 200),
        });
      const extra: Record<string, string> = { ...err.headers };
      if (err.retryAfterMs !== undefined)
        extra['retry-after'] = String(Math.ceil(err.retryAfterMs / 1000));
      if (err.status === 413) extra['connection'] = 'close';
      send(
        err.status,
        {
          error: {
            code: err.code,
            message: err.message,
            ...(err.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}),
          },
        },
        extra,
      );
    } finally {
      if (route !== 'GET /v1/health')
        log({ event: 'request', route, status, ms: now() - started, user: userTag });
    }
  };

  function methodNotAllowed(allowed: string): HttpError {
    return new HttpError(405, 'method_not_allowed', 'Method not allowed.', undefined, {
      allow: allowed,
    });
  }

  async function push(userId: string, body: unknown) {
    const parsed = PushRequest.safeParse(body);
    if (!parsed.success) throw new HttpError(400, 'invalid_request', 'Invalid push request.');
    const { clientId, ops } = parsed.data;
    const results: PushResult[] = new Array<PushResult>(ops.length);
    const reject = (
      i: number,
      id: string | null,
      key: string | null,
      code: PushRejectCode,
      message: string,
    ) => {
      results[i] = { id, idempotencyKey: key, status: 'rejected', cursor: null, code, message };
    };
    const candidates: { index: number; op: SyncOperation; hash: string; bytes: number }[] = [];
    const horizon = now() + config.maxFutureSkewMs;

    ops.forEach((raw, i) => {
      const parsedOp = SyncOperation.safeParse(raw);
      if (!parsedOp.success)
        return reject(i, null, null, 'invalid_op', 'Operation does not match the protocol.');
      const op = parsedOp.data;
      const bytes = Buffer.byteLength(JSON.stringify(op));
      if (bytes > LIMITS.maxOpBytes)
        return reject(i, op.id, op.idempotencyKey, 'payload_too_large', 'Operation is too large.');
      if (op.clientId !== clientId)
        return reject(
          i,
          op.id,
          op.idempotencyKey,
          'client_mismatch',
          'Operation belongs to another client id.',
        );
      const wall = hlcWallMs(op.hlc);
      if (wall === null || wall > horizon)
        return reject(
          i,
          op.id,
          op.idempotencyKey,
          'hlc_in_future',
          'Operation clock is too far ahead of the server.',
        );
      candidates.push({ index: i, op, hash: hashOperation(op), bytes });
    });

    if (candidates.length > 0) {
      const stored = await store.append(
        userId,
        candidates.map(({ op, hash, bytes }) => ({ op, hash, bytes })),
        config.quotaBytesPerUser,
      );
      candidates.forEach((c, k) => {
        const r = stored[k]!;
        if (r.status === 'accepted' || r.status === 'duplicate') {
          results[c.index] = {
            id: c.op.id,
            idempotencyKey: c.op.idempotencyKey,
            status: r.status,
            cursor: String(r.cursor),
            code: null,
            message: null,
          };
        } else if (r.status === 'idempotency_conflict') {
          reject(
            c.index,
            c.op.id,
            c.op.idempotencyKey,
            'idempotency_conflict',
            'This idempotency key was used for different content.',
          );
        } else {
          reject(
            c.index,
            c.op.id,
            c.op.idempotencyKey,
            'quota_exceeded',
            'Storage quota exceeded.',
          );
        }
      });
    }
    return {
      v: PROTOCOL_VERSION,
      results,
      epoch: await store.epoch(userId),
      head: String(await store.head(userId)),
      serverTime: new Date(now()).toISOString(),
    };
  }

  async function pull(userId: string, url: URL) {
    const sinceRaw = url.searchParams.get('since');
    const limitRaw = url.searchParams.get('limit');
    if (sinceRaw !== null && !/^\d{1,15}$/.test(sinceRaw)) {
      throw new HttpError(
        400,
        'invalid_request',
        '`since` must be a cursor returned by the server.',
      );
    }
    if (limitRaw !== null && !/^\d{1,4}$/.test(limitRaw)) {
      throw new HttpError(400, 'invalid_request', '`limit` must be a small integer.');
    }
    const since = sinceRaw === null ? 0 : Number(sinceRaw);
    const limit = Math.min(
      Math.max(1, limitRaw === null ? config.defaultPullLimit : Number(limitRaw)),
      config.maxPullLimit,
    );
    const head = await store.head(userId);
    // A cursor from the future means the server lost or was reset to older data. Say so loudly.
    if (since > head)
      throw new HttpError(410, 'cursor_expired', 'The cursor is ahead of this server.');
    const { ops } = await store.list(userId, since, limit, config.maxPullBytes);
    const nextCursor = ops.at(-1)?.cursor ?? since;
    return {
      v: PROTOCOL_VERSION,
      ops: ops.map((s) => ({ cursor: String(s.cursor), op: s.op })),
      nextCursor: String(nextCursor),
      hasMore: nextCursor < head,
      epoch: await store.epoch(userId),
      head: String(head),
      serverTime: new Date(now()).toISOString(),
    };
  }

  async function readJson(req: IncomingMessage): Promise<unknown> {
    const type = String(req.headers['content-type'] ?? '');
    if (!/^application\/json(\s*;.*)?$/i.test(type)) {
      throw new HttpError(415, 'unsupported_media_type', 'Send application/json.');
    }
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > config.maxBodyBytes) {
      throw new HttpError(413, 'payload_too_large', 'Request body is too large.');
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      total += buf.length;
      if (total > config.maxBodyBytes) {
        throw new HttpError(413, 'payload_too_large', 'Request body is too large.');
      }
      chunks.push(buf);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch {
      throw new HttpError(400, 'invalid_json', 'Body is not valid JSON.');
    }
  }

  const server = http.createServer({ maxHeaderSize: 16 * 1024 }, (req, res) => {
    void handler(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = String(req.headers['x-forwarded-for'] ?? '');
    const last = forwarded.split(',').at(-1)?.trim();
    if (last) return last;
  }
  return req.socket.remoteAddress ?? 'unknown';
}
