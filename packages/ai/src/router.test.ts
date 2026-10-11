// @vitest-environment node
// The provider router: ordered providers, fallback only for "this endpoint is not answering", every
// attempt in the ledger, and consent that names every provider that may receive the text.
import { describe, expect, it } from 'vitest';
import { emptyBudget } from './budget';
import type { BudgetLimits } from './budget';
import { AiError } from './errors';
import type { AiErrorCode } from './errors';
import { failsOver, runTask } from './pipeline';
import { buildPreview, createConsentToken } from './prepare';
import { classifyHttp, createMockProvider } from './providers';
import type { MockProvider, MockStep } from './providers';
import { T0, approve, goodReply, makeDeps, sel, selectionFor } from './testkit';

const KIND = 'summary' as const;
const S = selectionFor(KIND);
const good: MockStep = { json: goodReply(KIND, S) };
const fail = (code: AiErrorCode, status?: number): MockStep => ({
  error: new AiError(code, status === undefined ? {} : { status }),
});

const prov = (name: string, steps: readonly MockStep[]) =>
  createMockProvider(steps, { id: `openai-compatible:${name}.test`, model: `${name}-model` });
const times = (step: MockStep, n: number): MockStep[] => Array.from({ length: n }, () => step);

const LIMITS: BudgetLimits = { maxRequestsPerDay: 30, maxCostUsdPerDay: null };

/** Preview -> consent -> run with the whole chain, the way the UI does it. */
async function run(
  primary: MockProvider,
  fallbacks: {
    provider: MockProvider;
    pricing?: { inputUsdPerMTok: number; outputUsdPerMTok: number };
  }[],
  over: {
    budget?: BudgetLimits;
    pricing?: { inputUsdPerMTok: number; outputUsdPerMTok: number };
  } = {},
) {
  const deps = makeDeps(primary, {
    fallbacks,
    ...(over.pricing ? { pricing: over.pricing } : {}),
  });
  const opts = await approve(KIND, S, deps, {
    budget: { state: emptyBudget(T0), limits: over.budget ?? LIMITS },
  });
  return { deps, out: await runTask(KIND, S, deps, opts) };
}

describe('which failures hand the request to the next provider', () => {
  // The decision table, from the HTTP status the provider sent to the decision.
  const table: [string, number, unknown, boolean][] = [
    ['500 server error', 500, null, true],
    ['502 bad gateway', 502, null, true],
    ['503 unavailable', 503, null, true],
    ['529 overloaded', 529, { error: { type: 'overloaded_error' } }, true],
    ['408 request timeout', 408, null, true],
    ['401 bad key', 401, null, false],
    ['403 forbidden', 403, null, false],
    ['402 payment required', 402, null, false],
    ['429 with the account out of quota', 429, { error: { code: 'insufficient_quota' } }, false],
    ['429 rate limit', 429, { error: { code: 'rate_limit_exceeded' } }, false],
    ['400 bad request', 400, null, false],
    ['404 unknown model', 404, null, false],
  ];
  it.each(table)('%s', (_name, status, body, expected) => {
    expect(failsOver(classifyHttp(status, body))).toBe(expected);
  });

  it('and for the errors that are not HTTP: only an unreachable endpoint or a timeout', () => {
    const yes: AiErrorCode[] = ['network', 'server_error', 'timeout'];
    const no: AiErrorCode[] = [
      'auth',
      'quota_exhausted',
      'rate_limited',
      'bad_request',
      'refused',
      'output_truncated',
      'invalid_output',
      'missing_key',
      'invalid_endpoint',
      'budget_exceeded',
      'aborted',
      'consent_mismatch',
      'internal',
    ];
    for (const c of yes) expect(failsOver(c), c).toBe(true);
    for (const c of no) expect(failsOver(c), c).toBe(false);
  });
});

describe('fallback in the pipeline', () => {
  it.each([
    ['network', fail('network')],
    ['5xx', fail('server_error', 503)],
    ['timeout', fail('timeout')],
  ])(
    'a %s failure moves to the next provider, which answers the previewed text',
    async (_n, step) => {
      const primary = prov('a', times(step, 2));
      const backup = prov('b', [good]);
      const { out, deps } = await run(primary, [{ provider: backup }]);
      // The first provider got its two attempts, the second one answered.
      expect(primary.calls).toHaveLength(2);
      expect(backup.calls).toHaveLength(1);
      expect(out.attempts).toBe(3);
      expect(out.result.provider).toBe('openai-compatible:b.test');
      expect(out.result.model).toBe('b-model');
      expect(out.result.verificationState).toBe('unverified');
      // Both saw byte-identical messages: exactly what was previewed.
      const preview = await buildPreview(KIND, S, deps);
      expect(backup.calls[0]!.messages).toEqual(preview.messages);
      expect(primary.calls[0]!.messages).toEqual(preview.messages);
      expect(deps.logs.map((l) => l.event)).toContain('fallback');
    },
  );

  it.each([
    ['401', fail('auth', 401)],
    ['403', fail('auth', 403)],
    ['429 out of quota', fail('quota_exhausted', 429)],
    ['a refusal', fail('refused')],
    ['a request the provider rejects', fail('bad_request', 400)],
    ['an answer cut off by the output limit', fail('output_truncated')],
  ])('%s never reaches the next provider', async (_n, step) => {
    const primary = prov('a', [step]);
    const backup = prov('b', [good]);
    const deps = makeDeps(primary, { fallbacks: [{ provider: backup }] });
    const err = await runTask(KIND, S, deps, await approve(KIND, S, deps)).catch((e) => e);
    expect(err).toBeInstanceOf(AiError);
    expect(backup.calls, 'the fallback was not asked').toHaveLength(0);
    expect(primary.calls).toHaveLength(1);
  });

  it('a plain rate limit is retried on the same provider and still does not cross to another origin', async () => {
    const primary = prov('a', times(fail('rate_limited', 429), 4));
    const backup = prov('b', [good]);
    const deps = makeDeps(primary, { fallbacks: [{ provider: backup }] });
    const err = await runTask(KIND, S, deps, await approve(KIND, S, deps)).catch((e) => e);
    expect(err.code).toBe('rate_limited');
    expect(primary.calls).toHaveLength(2);
    expect(backup.calls).toHaveLength(0);
  });

  it('a malformed answer is repaired by the provider that gave it, not handed on', async () => {
    const primary = prov('a', [{ text: 'not json' }, good]);
    const backup = prov('b', [good]);
    const { out } = await run(primary, [{ provider: backup }]);
    expect(primary.calls).toHaveLength(2);
    expect(backup.calls).toHaveLength(0);
    expect(out.result.provider).toBe('openai-compatible:a.test');
  });

  it('the repair goes to the provider that answered, even when that was a fallback', async () => {
    const primary = prov('a', times(fail('network'), 2));
    const backup = prov('b', [{ text: 'not json' }, good]);
    const { out } = await run(primary, [{ provider: backup }]);
    expect(primary.calls).toHaveLength(2);
    expect(backup.calls).toHaveLength(2);
    expect(backup.calls[1]!.messages.length).toBeGreaterThan(backup.calls[0]!.messages.length);
    expect(out.result.provider).toBe('openai-compatible:b.test');
    expect(out.attempts).toBe(4);
  });

  it('walks a chain in order and says how many providers were tried when all of them fail', async () => {
    const a = prov('a', times(fail('network'), 2));
    const b = prov('b', times(fail('server_error', 503), 2));
    const c = prov('c', times(fail('timeout'), 3));
    const deps = makeDeps(a, { fallbacks: [{ provider: b }, { provider: c }] });
    const err = await runTask(KIND, S, deps, {
      ...(await approve(KIND, S, deps)),
      budget: { state: emptyBudget(T0), limits: LIMITS },
    }).catch((e) => e);
    expect(err.code).toBe('timeout');
    expect(err.detail).toContain('tried 3 providers');
    // 2 + 2 + 3 attempts, all counted, failures included.
    expect([a.calls.length, b.calls.length, c.calls.length]).toEqual([2, 2, 3]);
    expect(err.budgetAfter.requests).toBe(7);
  });

  it('a single provider keeps its three attempts and its error is untouched', async () => {
    const only = prov('a', times(fail('server_error', 503), 3));
    const deps = makeDeps(only);
    const err = await runTask(KIND, S, deps, await approve(KIND, S, deps)).catch((e) => e);
    expect(only.calls).toHaveLength(3);
    expect(err.code).toBe('server_error');
    expect(err.detail).toBeUndefined();
  });

  it('the answer is cached, so asking again sends nothing to anyone', async () => {
    const primary = prov('a', times(fail('network'), 2));
    const backup = prov('b', [good]);
    const { deps, out } = await run(primary, [{ provider: backup }]);
    const again = await runTask(KIND, S, deps, await approve(KIND, S, deps));
    expect(again.cacheHit).toBe(true);
    expect(again.attempts).toBe(0);
    expect(again.result.id).toBe(out.result.id);
    expect(primary.calls).toHaveLength(2);
    expect(backup.calls).toHaveLength(1);
  });
});

describe('every attempt is in the ledger', () => {
  it('counts the failed attempts of each provider and the answer', async () => {
    const primary = prov('a', times(fail('server_error', 500), 2));
    const backup = prov('b', [{ ...good, usage: { inputTokens: 100, outputTokens: 40 } }]);
    const { out } = await run(primary, [{ provider: backup }]);
    expect(out.attempts).toBe(3);
    expect(out.budget).toMatchObject({ requests: 3, inputTokens: 100, outputTokens: 40 });
  });

  it('prices each attempt by the price list of the provider that made it', async () => {
    const primary = prov('a', times(fail('network'), 2));
    const backup = prov('b', [{ ...good, usage: { inputTokens: 1_000, outputTokens: 500 } }]);
    const cheap = { inputUsdPerMTok: 1, outputUsdPerMTok: 2 };
    const dear = { inputUsdPerMTok: 10, outputUsdPerMTok: 20 };
    const { out } = await run(primary, [{ provider: backup, pricing: dear }], { pricing: cheap });
    const expected = (1_000 * 10 + 500 * 20) / 1e6;
    expect(out.result.usage.estimatedCostUsd).toBeCloseTo(expected, 12);
    expect(out.budget!.costUsd).toBeCloseTo(expected, 12);
  });

  it('the estimate of a chain is its upper bound, and unknown when one provider has no prices', async () => {
    const deps = makeDeps(prov('a', []), {
      pricing: { inputUsdPerMTok: 1, outputUsdPerMTok: 2 },
      fallbacks: [
        { provider: prov('b', []), pricing: { inputUsdPerMTok: 10, outputUsdPerMTok: 1 } },
      ],
    });
    const p = await buildPreview(KIND, S, deps);
    const { inputTokens, maxOutputTokens } = p.estimate;
    expect(p.estimate.estimatedCostUsd).toBeCloseTo(
      (inputTokens * 10 + maxOutputTokens * 2) / 1e6,
      12,
    );

    const unknown = makeDeps(prov('a', []), {
      pricing: { inputUsdPerMTok: 1, outputUsdPerMTok: 2 },
      fallbacks: [{ provider: prov('b', []) }],
    });
    expect((await buildPreview(KIND, S, unknown)).estimate.estimatedCostUsd).toBeNull();
  });

  it('another provider is another request: it only goes out while the budget has room', async () => {
    const primary = prov('a', times(fail('network'), 2));
    const backup = prov('b', [good]);
    const deps = makeDeps(primary, { fallbacks: [{ provider: backup }] });
    const err = await runTask(KIND, S, deps, {
      ...(await approve(KIND, S, deps)),
      budget: { state: emptyBudget(T0), limits: { maxRequestsPerDay: 2, maxCostUsdPerDay: null } },
    }).catch((e) => e);
    expect(err.code).toBe('budget_exceeded');
    expect(err.detail).toBe('requests');
    expect(backup.calls).toHaveLength(0);
    expect(err.budgetAfter.requests).toBe(2);
  });
});

describe('consent covers every provider that may receive the text', () => {
  it('the preview lists the recipients in the order they are tried', async () => {
    const deps = makeDeps(prov('a', []), {
      fallbacks: [{ provider: prov('b', []) }, { provider: prov('c', []) }],
    });
    const p = await buildPreview(KIND, S, deps);
    expect(p.recipients).toEqual([
      { provider: 'openai-compatible:a.test', model: 'a-model' },
      { provider: 'openai-compatible:b.test', model: 'b-model' },
      { provider: 'openai-compatible:c.test', model: 'c-model' },
    ]);
    const single = await buildPreview(KIND, S, makeDeps(prov('a', [])));
    expect(single.recipients).toEqual([{ provider: 'openai-compatible:a.test', model: 'a-model' }]);
  });

  it('a confirmation for one provider is refused once a fallback is added, and the other way round', async () => {
    const a = prov('a', [good]);
    const b = prov('b', [good]);
    const alone = makeDeps(a);
    const aloneOpts = await approve(KIND, S, alone);
    const withBackup = makeDeps(a, { fallbacks: [{ provider: b }] });
    await expect(runTask(KIND, S, withBackup, aloneOpts)).rejects.toMatchObject({
      code: 'consent_mismatch',
    });
    const chainOpts = await approve(KIND, S, withBackup);
    await expect(runTask(KIND, S, alone, chainOpts)).rejects.toMatchObject({
      code: 'consent_mismatch',
    });
    expect(a.calls).toHaveLength(0);
    expect(b.calls).toHaveLength(0);
  });

  it('a different fallback, or the same ones in another order, is not what was confirmed', async () => {
    const a = prov('a', [good]);
    const b = prov('b', [good]);
    const c = prov('c', [good]);
    const confirmed = makeDeps(a, { fallbacks: [{ provider: b }, { provider: c }] });
    const opts = await approve(KIND, S, confirmed);
    for (const fallbacks of [
      [{ provider: c }, { provider: b }],
      [{ provider: b }],
      [{ provider: prov('evil', [good]) }, { provider: c }],
    ]) {
      const changed = makeDeps(a, { fallbacks });
      await expect(runTask(KIND, S, changed, opts)).rejects.toMatchObject({
        code: 'consent_mismatch',
      });
    }
    expect(b.calls.length + c.calls.length + a.calls.length).toBe(0);
    // The chain that was confirmed runs.
    const out = await runTask(KIND, S, confirmed, opts);
    expect(out.result.provider).toBe('openai-compatible:a.test');
  });

  it('the exact origin is part of what was confirmed: the same host on another scheme or port is not', async () => {
    const withOrigin = (origin: string) => ({ ...prov('a', [good]), origin });
    const confirmed = makeDeps(withOrigin('http://localhost:11434'));
    const preview = await buildPreview(KIND, S, confirmed);
    expect(preview.recipients).toEqual([
      { provider: 'openai-compatible:a.test', model: 'a-model', origin: 'http://localhost:11434' },
    ]);
    const opts = await approve(KIND, S, confirmed);
    for (const origin of ['https://localhost:11434', 'http://localhost:8080']) {
      const moved = makeDeps(withOrigin(origin));
      await expect(runTask(KIND, S, moved, opts)).rejects.toMatchObject({
        code: 'consent_mismatch',
      });
    }
    // A fallback's origin counts too.
    const chain = makeDeps(prov('p', [good]), {
      fallbacks: [{ provider: withOrigin('https://b.example.test') }],
    });
    const chainOpts = await approve(KIND, S, chain);
    const other = makeDeps(prov('p', [good]), {
      fallbacks: [{ provider: withOrigin('https://evil.example.test') }],
    });
    await expect(runTask(KIND, S, other, chainOpts)).rejects.toMatchObject({
      code: 'consent_mismatch',
    });
  });

  it('a consent token made for a chain names the first provider and is still bound to the text', async () => {
    const a = prov('a', [good]);
    const deps = makeDeps(a, { fallbacks: [{ provider: prov('b', []) }] });
    const preview = await buildPreview(KIND, S, deps);
    const token = createConsentToken(preview, deps);
    expect(token).toMatchObject({ provider: 'openai-compatible:a.test', model: 'a-model' });
    // Different text, same chain: refused.
    await expect(
      runTask(KIND, sel([S.chunks[0]!]), deps, { consent: token }),
    ).rejects.toMatchObject({ code: 'consent_mismatch' });
    expect(a.calls).toHaveLength(0);
  });

  it('with the feature off nothing is called, whatever the chain', async () => {
    const a = prov('a', [good]);
    const b = prov('b', [good]);
    const deps = makeDeps(a, { enabled: false, fallbacks: [{ provider: b }] });
    await expect(runTask(KIND, S, deps, { consent: undefined })).rejects.toMatchObject({
      code: 'disabled',
    });
    expect(a.calls.length + b.calls.length).toBe(0);
  });
});
