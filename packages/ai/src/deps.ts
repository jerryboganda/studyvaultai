import { AiError } from './errors';
import type { AiProvider } from './providers';
import type { AiResult } from './schema';
import type { DEFAULT_LIMITS } from './constants';

export interface Pricing {
  /** USD per one million input tokens. */
  inputUsdPerMTok: number;
  /** USD per one million output tokens. */
  outputUsdPerMTok: number;
}

export interface LogEvent {
  event: string;
  /** Always scrubbed; never contains source text, keys or provider bodies. */
  detail?: string;
}

/** Durable cache port: the host maps it to the Dexie `aiResults` table (index: inputFingerprint). */
export interface AiCache {
  get(fingerprint: string): Promise<AiResult | null | undefined>;
  put(result: AiResult): Promise<void>;
}

export function createMemoryCache(): AiCache & { readonly size: number; keys(): string[] } {
  const map = new Map<string, AiResult>();
  return {
    get: (fp) => Promise.resolve(map.get(fp) ?? null),
    put: (r) => {
      map.set(r.inputFingerprint, r);
      return Promise.resolve();
    },
    get size() {
      return map.size;
    },
    keys: () => [...map.keys()],
  };
}

export interface RetryPolicy {
  /** Provider attempts per call, including the first (default 3). */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** A Retry-After longer than this fails fast with `rate_limited` (default 20 s). */
  maxRetryWaitMs?: number;
}

/**
 * Everything impure is injected. Build one with `systemDeps()` in the extension, or by hand in tests.
 * `provider` is created per call by the caller with the user's key; this package never stores it.
 */
export interface PipelineDeps {
  /** Mirrors `Settings.features.ai`. Off => every call throws `disabled` before any work. */
  enabled: boolean;
  provider: AiProvider;
  now(): number;
  /** [0, 1) */
  random(): number;
  randomId(): string;
  sha256(text: string): Promise<string>;
  /** Backoff wait; must reject (any error) when `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** Deadline timer: resolves after `ms`; must settle or stay pending (never resolve) once aborted. */
  timeout(ms: number, signal: AbortSignal): Promise<void>;
  cache?: AiCache;
  coordinator?: AiCoordinator;
  limits?: Partial<{ -readonly [K in keyof typeof DEFAULT_LIMITS]: number }>;
  pricing?: Pricing | null;
  retry?: RetryPolicy;
  timeoutMs?: number;
  log?: (e: LogEvent) => void;
  /** Extra exact strings to scrub from anything emitted (the pipeline itself never sees the key). */
  secrets?: readonly string[];
}

export interface AiCoordinator {
  /** In-flight runs by input fingerprint (single flight). */
  readonly inflight: Map<string, Promise<unknown>>;
  acquire(signal?: AbortSignal): Promise<() => void>;
}

/** One per service-worker lifetime. Not durable on purpose: the cache is the durable layer. */
export function createCoordinator(maxConcurrent = 2): AiCoordinator {
  let active = 0;
  const waiters: { go(): void }[] = [];
  const release = () => {
    active--;
    waiters.shift()?.go();
  };
  return {
    inflight: new Map(),
    acquire(signal) {
      if (signal?.aborted) return Promise.reject(new AiError('aborted'));
      if (active < maxConcurrent) {
        active++;
        return Promise.resolve(once(release));
      }
      return new Promise((resolve, reject) => {
        const onAbort = () => {
          const i = waiters.indexOf(waiter);
          if (i >= 0) waiters.splice(i, 1);
          reject(new AiError('aborted'));
        };
        const waiter = {
          go: () => {
            signal?.removeEventListener('abort', onAbort);
            active++;
            resolve(once(release));
          },
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        waiters.push(waiter);
      });
    },
  };
}

function once(fn: () => void): () => void {
  let done = false;
  return () => {
    if (!done) {
      done = true;
      fn();
    }
  };
}
