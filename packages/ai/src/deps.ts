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

export interface FallbackTarget {
  provider: AiProvider;
  /** This provider's own price list; null/absent = unknown (its cost is then not estimated). */
  pricing?: Pricing | null;
}

/** The providers of one request in the order they are tried; index 0 is the one consent names first. */
export interface ChainTarget {
  provider: AiProvider;
  pricing: Pricing | null;
}

export function chainOf(
  deps: Pick<PipelineDeps, 'provider' | 'pricing' | 'fallbacks'>,
): ChainTarget[] {
  return [
    { provider: deps.provider, pricing: deps.pricing ?? null },
    ...(deps.fallbacks ?? []).map((f) => ({ provider: f.provider, pricing: f.pricing ?? null })),
  ];
}

/**
 * An upper bound for a request whichever provider answers: the highest price of each kind, or null
 * (unknown) as soon as one provider has no price list.
 */
export function worstPricing(chain: readonly ChainTarget[]): Pricing | null {
  let worst: Pricing | null = null;
  for (const t of chain) {
    if (!t.pricing) return null;
    worst = worst
      ? {
          inputUsdPerMTok: Math.max(worst.inputUsdPerMTok, t.pricing.inputUsdPerMTok),
          outputUsdPerMTok: Math.max(worst.outputUsdPerMTok, t.pricing.outputUsdPerMTok),
        }
      : t.pricing;
  }
  return worst;
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
  /**
   * Providers tried, in order, after `provider` when it fails with `network`, `server_error` or
   * `timeout` (never for auth, quota, rate limit, refusal or a bad answer). They receive exactly the
   * previewed text, and the consent token covers the whole list (see `AiRequestPreview.recipients`).
   */
  fallbacks?: readonly FallbackTarget[];
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
  /** Reply text so far, for providers that stream (progress display only). */
  onDelta?: (textSoFar: string) => void;
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
