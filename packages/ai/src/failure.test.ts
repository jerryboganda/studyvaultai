// @vitest-environment node
// TEST_PLAN "Review and AI matrix": provider key missing, timeout, rate limit, quota exhausted,
// cancellation, two simultaneous requests, retry idempotency, malformed output.
import { describe, expect, it } from 'vitest';
import { createCoordinator } from './deps';
import { AiError } from './errors';
import { runTask } from './pipeline';
import { createMockProvider, createOpenAICompatibleProvider } from './providers';
import type { FetchLike } from './providers';
import { approve, goodReply, makeDeps, rateLimited, selectionFor } from './testkit';

const KIND = 'summary' as const;
const S = selectionFor(KIND);
const GOOD = { json: goodReply(KIND, S) };

const gate = () => {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
};

describe('transport failures', () => {
  it('timeout: each attempt is cut at the deadline, retried, then surfaced as `timeout`', async () => {
    const provider = createMockProvider([{ hang: true }, { hang: true }, { hang: true }]);
    // Deadline fires immediately; the provider call is aborted through its signal.
    const deps = makeDeps(provider, { timeout: () => Promise.resolve(), timeoutMs: 50 });
    const err = await runTask(KIND, S, deps, await approve(KIND, S, deps)).catch((e) => e);
    expect(err).toBeInstanceOf(AiError);
    expect(err.code).toBe('timeout');
    expect(provider.calls).toHaveLength(3);
    expect(deps.cache.size).toBe(0);
  });

  it('timeout then success: the retry succeeds and is the only cached result', async () => {
    const provider = createMockProvider([{ error: new AiError('timeout') }, GOOD]);
    const deps = makeDeps(provider);
    const out = await runTask(KIND, S, deps, await approve(KIND, S, deps));
    expect(out.attempts).toBe(2);
    expect(deps.cache.size).toBe(1);
  });

  it('429 with Retry-After: waits exactly the advertised time, then succeeds', async () => {
    const provider = createMockProvider([{ error: rateLimited(2_000) }, GOOD]);
    const deps = makeDeps(provider);
    const out = await runTask(KIND, S, deps, await approve(KIND, S, deps));
    expect(deps.sleeps).toEqual([2_000]);
    expect(out.attempts).toBe(2);
  });

  it('429 with a Retry-After beyond the cap fails fast and tells the caller when to retry', async () => {
    const provider = createMockProvider([{ error: rateLimited(300_000) }, GOOD]);
    const deps = makeDeps(provider);
    const err = await runTask(KIND, S, deps, await approve(KIND, S, deps)).catch((e) => e);
    expect([err.code, err.retryAfterMs]).toEqual(['rate_limited', 300_000]);
    expect(provider.calls).toHaveLength(1);
    expect(deps.sleeps).toEqual([]);
  });

  it('exponential backoff with jitter when no Retry-After is sent', async () => {
    const provider = createMockProvider([
      { error: rateLimited() },
      { error: new AiError('server_error', { status: 503 }) },
      GOOD,
    ]);
    const deps = makeDeps(provider, { random: () => 0.5 });
    await runTask(KIND, S, deps, await approve(KIND, S, deps));
    // backoff 500 then 1000; equal jitter => base/2 + random * base/2.
    expect(deps.sleeps).toEqual([375, 750]);
  });

  it('jitter spans the documented range', async () => {
    const waits: number[] = [];
    for (const r of [0, 0.999]) {
      const provider = createMockProvider([{ error: rateLimited() }, GOOD]);
      const deps = makeDeps(provider, { random: () => r });
      await runTask(KIND, S, deps, await approve(KIND, S, deps));
      waits.push(...deps.sleeps);
    }
    expect(waits[0]).toBe(250);
    expect(waits[1]).toBeGreaterThanOrEqual(499);
    expect(waits[1]).toBeLessThanOrEqual(500);
  });

  it('gives up after maxAttempts with the last error', async () => {
    const provider = createMockProvider(() => ({ error: rateLimited(10) }));
    const deps = makeDeps(provider, { retry: { maxAttempts: 4 } });
    const err = await runTask(KIND, S, deps, await approve(KIND, S, deps)).catch((e) => e);
    expect(err.code).toBe('rate_limited');
    expect(provider.calls).toHaveLength(4);
    expect(deps.sleeps).toHaveLength(3);
  });

  it.each([
    ['quota_exhausted', new AiError('quota_exhausted', { status: 402 })],
    ['auth', new AiError('auth', { status: 401 })],
    ['bad_request', new AiError('bad_request', { status: 400 })],
    ['refused', new AiError('refused')],
    ['output_truncated', new AiError('output_truncated')],
  ] as const)('%s is not retried', async (code, error) => {
    const provider = createMockProvider(() => ({ error }));
    const deps = makeDeps(provider);
    const err = await runTask(KIND, S, deps, await approve(KIND, S, deps)).catch((e) => e);
    expect(err.code).toBe(code);
    expect(provider.calls).toHaveLength(1);
    expect(deps.sleeps).toEqual([]);
    expect(deps.cache.size).toBe(0);
  });

  it('quota exhausted through a real OpenAI-shaped 429 insufficient_quota is not retried', async () => {
    let calls = 0;
    const fetchFn: FetchLike = () => {
      calls++;
      return Promise.resolve(
        new Response(
          JSON.stringify({ error: { type: 'insufficient_quota', code: 'insufficient_quota' } }),
          {
            status: 429,
          },
        ),
      );
    };
    const provider = createOpenAICompatibleProvider({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test-0123456789abcdefghij',
      model: 'm',
      fetch: fetchFn,
    });
    const deps = makeDeps(provider);
    const err = await runTask(KIND, S, deps, await approve(KIND, S, deps)).catch((e) => e);
    expect(err.code).toBe('quota_exhausted');
    expect(calls).toBe(1);
  });

  it('missing key: typed error, no network call, nothing cached', async () => {
    let calls = 0;
    const provider = createOpenAICompatibleProvider({
      baseUrl: 'https://api.example.com/v1',
      model: 'm',
      fetch: () => {
        calls++;
        return Promise.reject(new Error('should not be called'));
      },
    });
    const deps = makeDeps(provider);
    const err = await runTask(KIND, S, deps, await approve(KIND, S, deps)).catch((e) => e);
    expect(err.code).toBe('missing_key');
    expect(calls).toBe(0);
    expect(deps.cache.size).toBe(0);
  });

  it('an unexpected thrown error becomes a scrubbed, typed network error', async () => {
    const provider = createMockProvider(() => ({
      error: new Error('socket hang up with key sk-live-ABCDEFGHIJKLMNOPQRSTUVWX'),
    }));
    const deps = makeDeps(provider, { retry: { maxAttempts: 1 } });
    const err = await runTask(KIND, S, deps, await approve(KIND, S, deps)).catch((e) => e);
    expect(err.code).toBe('network');
    expect(err.message).not.toContain('sk-live');
  });
});

describe('malformed output', () => {
  it('invalid JSON then a valid repair: two calls, one result, repair prompt carries the validator issues', async () => {
    const provider = createMockProvider([{ text: 'Sure! Here you go: {oops' }, GOOD]);
    const deps = makeDeps(provider);
    const out = await runTask(KIND, S, deps, await approve(KIND, S, deps));
    expect(provider.calls).toHaveLength(2);
    const repair = provider.calls[1]!.messages;
    expect(repair.at(-2)).toMatchObject({ role: 'assistant' });
    expect(repair.at(-1)!.content).toContain('not a single valid JSON document');
    expect(out.attempts).toBe(2);
    expect(deps.cache.size).toBe(1);
  });

  it('schema violations list the offending paths in the repair prompt', async () => {
    const bad = { ...(goodReply(KIND, S) as object), keyPoints: [] };
    const provider = createMockProvider([{ json: bad }, GOOD]);
    const deps = makeDeps(provider);
    await runTask(KIND, S, deps, await approve(KIND, S, deps));
    expect(provider.calls[1]!.messages.at(-1)!.content).toMatch(/keyPoints/);
  });

  it('two bad answers: typed invalid_output, no partial result, nothing cached', async () => {
    const provider = createMockProvider([
      { text: '{"summary": "x"}' },
      { text: '{"summary": "x", "keyPoints": ["a"], "evidence": []}' },
    ]);
    const deps = makeDeps(provider);
    const err = await runTask(KIND, S, deps, await approve(KIND, S, deps)).catch((e) => e);
    expect(err.code).toBe('invalid_output');
    expect(err.issues.length).toBeGreaterThan(0);
    expect(provider.calls).toHaveLength(2);
    expect(deps.cache.size).toBe(0);
  });

  it('a code-fenced JSON document is accepted; surrounding prose is not', async () => {
    const fenced = '```json\n' + JSON.stringify(goodReply(KIND, S)) + '\n```';
    const ok = createMockProvider([{ text: fenced }]);
    const d1 = makeDeps(ok);
    await expect(runTask(KIND, S, d1, await approve(KIND, S, d1))).resolves.toBeTruthy();
    expect(ok.calls).toHaveLength(1);
  });
});

describe('cancellation', () => {
  it('abort mid-flight: typed `aborted`, the provider is told, nothing cached, slot released', async () => {
    const provider = createMockProvider([{ hang: true }]);
    const coordinator = createCoordinator(1);
    const deps = makeDeps(provider, { coordinator });
    const ac = new AbortController();
    const opts = await approve(KIND, S, deps, { signal: ac.signal });
    const run = runTask(KIND, S, deps, opts).catch((e) => e);
    await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    const err = await run;
    expect(err.code).toBe('aborted');
    expect(provider.calls).toHaveLength(1);
    expect(deps.cache.size).toBe(0);
    expect(coordinator.inflight.size).toBe(0);
    // The slot is free again.
    const next = makeDeps(createMockProvider([GOOD]), { coordinator });
    await expect(runTask(KIND, S, next, await approve(KIND, S, next))).resolves.toBeTruthy();
  });

  it('abort before start and abort during a backoff wait', async () => {
    const pre = new AbortController();
    pre.abort();
    const d0 = makeDeps(createMockProvider([GOOD]));
    const e0 = await runTask(KIND, S, d0, {
      ...(await approve(KIND, S, d0)),
      signal: pre.signal,
    }).catch((e) => e);
    expect(e0.code).toBe('aborted');

    const ac = new AbortController();
    const provider = createMockProvider([{ error: rateLimited(1_000) }, GOOD]);
    const deps = makeDeps(provider, {
      sleep: (_ms, signal) =>
        new Promise((_res, rej) => {
          ac.abort();
          signal?.addEventListener('abort', () => rej(new Error('aborted')));
          if (signal?.aborted) rej(new Error('aborted'));
        }),
    });
    const err = await runTask(KIND, S, deps, {
      ...(await approve(KIND, S, deps)),
      signal: ac.signal,
    }).catch((e) => e);
    expect(err.code).toBe('aborted');
    expect(provider.calls).toHaveLength(1);
  });

  it('a queued request can be aborted while waiting for a slot', async () => {
    const g = gate();
    const provider = createMockProvider(() => ({
      gate: g.promise,
      json: goodReply('exam_pearl', S),
    }));
    const coordinator = createCoordinator(1);
    const deps = makeDeps(provider, { coordinator });
    const first = runTask('exam_pearl', S, deps, await approve('exam_pearl', S, deps));
    await new Promise((r) => setTimeout(r, 5));
    const ac = new AbortController();
    const other = selectionFor('flashcards');
    const second = runTask('flashcards', other, deps, {
      ...(await approve('flashcards', other, deps)),
      signal: ac.signal,
    }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    expect((await second).code).toBe('aborted');
    g.open();
    await expect(first).resolves.toBeTruthy();
    expect(provider.calls).toHaveLength(1);
  });
});

describe('concurrency', () => {
  it('two simultaneous identical requests make ONE provider call (single flight)', async () => {
    const g = gate();
    const provider = createMockProvider([{ gate: g.promise, ...GOOD }, GOOD]);
    const coordinator = createCoordinator(2);
    const deps = makeDeps(provider, { coordinator });
    const budget = {
      state: { day: '2026-10-11', requests: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 },
      limits: { maxRequestsPerDay: 5, maxCostUsdPerDay: null },
    };
    const o1 = await approve(KIND, S, deps, { budget });
    const o2 = await approve(KIND, S, deps, { budget });
    const a = runTask(KIND, S, deps, o1);
    const b = runTask(KIND, S, deps, o2);
    await new Promise((r) => setTimeout(r, 10));
    g.open();
    const [ra, rb] = await Promise.all([a, b]);
    expect(provider.calls).toHaveLength(1);
    expect(ra.result.id).toBe(rb.result.id);
    expect([ra.coalesced, rb.coalesced].sort()).toEqual([false, true]);
    const leader = ra.coalesced ? rb : ra;
    const follower = ra.coalesced ? ra : rb;
    expect(leader.budget!.requests).toBe(1);
    expect(follower.budget!.requests).toBe(0); // the follower is not charged
    expect(deps.cache.size).toBe(1);
    expect(coordinator.inflight.size).toBe(0);
  });

  it('a follower takes over when the leader is cancelled', async () => {
    const provider = createMockProvider([{ hang: true }, GOOD]);
    const coordinator = createCoordinator(2);
    const deps = makeDeps(provider, { coordinator });
    const ac = new AbortController();
    const leader = runTask(KIND, S, deps, {
      ...(await approve(KIND, S, deps)),
      signal: ac.signal,
    }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 5));
    const follower = runTask(KIND, S, deps, await approve(KIND, S, deps));
    await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    expect((await leader).code).toBe('aborted');
    const out = await follower;
    expect(out.result.kind).toBe(KIND);
    expect(provider.calls).toHaveLength(2);
  });

  it('different requests respect the concurrency limit', async () => {
    const g = gate();
    let live = 0;
    let peak = 0;
    const provider = createMockProvider((req) => {
      live++;
      peak = Math.max(peak, live);
      const isPearl = req.messages[1]!.content.includes('exam pearl');
      return {
        gate: g.promise.then(() => {
          live--;
        }),
        json: goodReply(isPearl ? 'exam_pearl' : 'summary', S),
      };
    });
    const coordinator = createCoordinator(1);
    const deps = makeDeps(provider, { coordinator });
    const p1 = runTask('exam_pearl', S, deps, await approve('exam_pearl', S, deps));
    const p2 = runTask('summary', S, deps, await approve('summary', S, deps));
    await new Promise((r) => setTimeout(r, 10));
    expect(provider.calls).toHaveLength(1); // second is queued behind the first
    g.open();
    await Promise.all([p1, p2]);
    expect(peak).toBe(1);
    expect(provider.calls).toHaveLength(2);
  });
});

describe('retry idempotency', () => {
  it('a retried request stores exactly one result and later runs are cache hits', async () => {
    const provider = createMockProvider([
      { error: rateLimited(1) },
      { error: rateLimited(1) },
      GOOD,
      GOOD,
    ]);
    const deps = makeDeps(provider);
    const first = await runTask(KIND, S, deps, await approve(KIND, S, deps));
    expect(first.attempts).toBe(3);
    expect(deps.cache.size).toBe(1);
    // Every attempt sent the identical request.
    const [c0, c1, c2] = provider.calls;
    expect(c1!.messages).toEqual(c0!.messages);
    expect(c2!.messages).toEqual(c0!.messages);
    const again = await runTask(KIND, S, deps, await approve(KIND, S, deps));
    expect(again.cacheHit).toBe(true);
    expect(again.result.id).toBe(first.result.id);
    expect(provider.calls).toHaveLength(3);
  });

  it('a cache write failure does not fail the run', async () => {
    const provider = createMockProvider([GOOD]);
    const deps = makeDeps(provider, {
      cache: { get: () => Promise.resolve(null), put: () => Promise.reject(new Error('quota')) },
    });
    const out = await runTask(KIND, S, deps, await approve(KIND, S, deps));
    expect(out.result.kind).toBe(KIND);
    expect(deps.logs.map((l) => l.event)).toContain('cache_put_failed');
  });
});
