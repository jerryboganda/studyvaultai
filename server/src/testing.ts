import type { AddressInfo } from 'node:net';
import { createSyncServer } from './app.ts';
import type { LogEvent } from './app.ts';
import { staticTokenVerifier } from './auth.ts';
import type { TokenVerifier } from './auth.ts';
import { DEFAULT_CONFIG } from './config.ts';
import type { ServerConfig } from './config.ts';
import { MemoryStore } from './store.ts';
import type { OpStore } from './store.ts';

export const TOKEN_A = 'token-for-user-a-0123456789';
export const TOKEN_B = 'token-for-user-b-0123456789';

export interface Running {
  base: string;
  store: OpStore;
  events: LogEvent[];
  clock: { t: number };
  close(): Promise<void>;
}

export async function start(
  over: Partial<ServerConfig> = {},
  options: { store?: OpStore; verifier?: TokenVerifier; clock?: { t: number } } = {},
): Promise<Running> {
  const store = options.store ?? new MemoryStore();
  const events: LogEvent[] = [];
  const clock = options.clock ?? { t: Date.UTC(2026, 9, 11, 12, 0, 0) };
  const verifier =
    options.verifier ??
    staticTokenVerifier(
      new Map([
        [TOKEN_A, 'user-a'],
        [TOKEN_B, 'user-b'],
      ]),
    );
  const server = createSyncServer({
    config: { ...DEFAULT_CONFIG, ...over },
    store,
    verifier,
    now: () => clock.t,
    log: (e) => events.push(e),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    store,
    events,
    clock,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

export interface OpInit {
  id: string;
  clientId?: string;
  entityId?: string;
  wall?: number;
  key?: string;
  opType?: 'upsert' | 'delete';
  set?: Record<string, unknown>;
  revision?: number;
}

/** A syntactically valid plaintext operation. */
export function makeOp(init: OpInit, nowMs: number): Record<string, unknown> {
  const clientId = init.clientId ?? 'client-A';
  const wall = (init.wall ?? nowMs).toString(36).padStart(9, '0');
  const opType = init.opType ?? 'upsert';
  return {
    id: init.id,
    clientId,
    entityType: 'notes',
    entityId: init.entityId ?? `note-${init.id}`,
    opType,
    revision: init.revision ?? 1,
    hlc: `${wall}.0000.${clientId}`,
    baseRevision: (init.revision ?? 1) - 1,
    payload: {
      v: 1,
      full: opType === 'upsert',
      set: init.set ?? { title: `title ${init.id}` },
      prev: {},
      base: {},
      sets: {},
      observed: null,
    },
    payloadEncrypted: false,
    tombstone: opType === 'delete',
    idempotencyKey: init.key ?? `${clientId}:${init.id}`,
    createdAt: new Date(nowMs).toISOString(),
  };
}

export async function api(
  base: string,
  method: string,
  path: string,
  options: {
    token?: string | null;
    body?: unknown;
    raw?: string;
    headers?: Record<string, string>;
  } = {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper: assertions index freely
): Promise<{ status: number; json: any; headers: Headers }> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token !== null) headers['authorization'] = `Bearer ${options.token ?? TOKEN_A}`;
  let body: string | undefined;
  if (options.raw !== undefined) {
    body = options.raw;
    headers['content-type'] ??= 'application/json';
  } else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers['content-type'] ??= 'application/json';
  }
  const res = await fetch(`${base}${path}`, { method, headers, body });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json, headers: res.headers };
}
