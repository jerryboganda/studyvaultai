// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { candidatePairs } from './candidates';
import { checkBudget, dayKey, emptyBudget, recordSpend, rollover } from './budget';
import { citationsFrom, groundClaims, pairKey } from './grounding';
import type { ChunkText } from './grounding';
import { systemClock, toHex } from './system';

const chunks = new Map<string, ChunkText>([
  [
    'a-0000001',
    {
      id: 'a-0000001',
      kind: 'highlight',
      sent: 'The renal   cortex receives\n20% of cardiac output at rest.',
    },
  ],
  ['n-0000001', { id: 'n-0000001', kind: 'note', sent: 'Beta-blockers reduce heart rate.' }],
  ['s-0000001', { id: 's-0000001', kind: 'highlight', sent: 'Aspirin' }],
]);
const ground = (quoteId: string, quote: string) =>
  groundClaims([{ path: '/q', quoteId, quote }], chunks).claims[0]!;

describe('verbatim grounding (deterministic, no LLM judge)', () => {
  it('accepts contiguous spans, ignoring whitespace differences', () => {
    expect(ground('a-0000001', 'renal cortex receives 20% of cardiac')).toMatchObject({
      supported: true,
      reason: 'ok',
    });
    expect(
      ground('a-0000001', 'The renal cortex receives 20% of cardiac output at rest.').supported,
    ).toBe(true);
  });

  it('rejects paraphrase, case changes, ellipses and merged spans', () => {
    expect(ground('a-0000001', 'renal cortex gets a fifth of cardiac output').reason).toBe(
      'quote_not_found',
    );
    expect(ground('a-0000001', 'RENAL CORTEX RECEIVES').reason).toBe('quote_not_found');
    expect(ground('a-0000001', 'renal cortex ... at rest').reason).toBe('quote_not_found');
    expect(ground('a-0000001', 'cardiac output at rest. Beta-blockers reduce').reason).toBe(
      'quote_not_found',
    );
  });

  it('ids must exist and the quote must be in the cited chunk, not another one', () => {
    expect(ground('zzz-0000', 'renal cortex receives').reason).toBe('unknown_id');
    expect(ground('n-0000001', 'renal cortex receives').reason).toBe('quote_not_found');
    expect(ground('n-0000001', 'Beta-blockers reduce heart rate.').supported).toBe(true);
  });

  it('very short quotes only count when they are the whole chunk', () => {
    expect(ground('a-0000001', 'renal').reason).toBe('quote_too_short');
    expect(ground('s-0000001', 'Aspirin').supported).toBe(true);
    expect(ground('a-0000001', '   ').reason).toBe('quote_too_short');
  });

  it('only supported claims become citations; notes cite noteId, highlights highlightId', () => {
    const claims = [
      { path: '/a', quoteId: 'a-0000001', quote: 'renal cortex receives 20%' },
      { path: '/b', quoteId: 'n-0000001', quote: 'Beta-blockers reduce heart rate.' },
      { path: '/c', quoteId: 'n-0000001', quote: 'invented sentence about statins' },
      { path: '/d', quoteId: 'a-0000001', quote: 'renal  cortex receives 20%' }, // duplicate once normalised
    ];
    const report = groundClaims(claims, chunks);
    expect([report.checked, report.supported, report.unsupported]).toEqual([4, 3, 1]);
    expect(citationsFrom(claims, report, chunks)).toEqual([
      { highlightId: 'a-0000001', quote: 'renal cortex receives 20%' },
      { noteId: 'n-0000001', quote: 'Beta-blockers reduce heart rate.' },
    ]);
  });

  it('contradiction claims must belong to an offered candidate pair', () => {
    const keys = new Set([pairKey('a-0000001', 'n-0000001')]);
    const ok = groundClaims(
      [
        {
          path: '/x',
          quoteId: 'a-0000001',
          quote: 'renal cortex receives',
          candidate: ['n-0000001', 'a-0000001'],
        },
      ],
      chunks,
      keys,
    );
    expect(ok.claims[0]!.supported).toBe(true);
    const bad = groundClaims(
      [
        {
          path: '/x',
          quoteId: 'a-0000001',
          quote: 'renal cortex receives',
          candidate: ['a-0000001', 's-0000001'],
        },
      ],
      chunks,
      keys,
    );
    expect(bad.claims[0]!.reason).toBe('not_a_candidate');
  });
});

describe('candidate pair generation', () => {
  const docs = [
    { id: 'd3', text: 'Metformin lowers hepatic glucose production in type 2 diabetes.' },
    { id: 'd1', text: 'Metformin raises hepatic glucose production in type 2 diabetes.' },
    { id: 'd2', text: 'The Nile flows north through Egypt.' },
    { id: 'd4', text: 'Insulin lowers blood glucose in type 1 diabetes.' },
  ];

  it('is deterministic and independent of input order', () => {
    const a = candidatePairs(docs);
    const b = candidatePairs([...docs].reverse());
    expect(a).toEqual(b);
    expect(a[0]).toEqual(['d1', 'd3']);
    expect(a.flat()).not.toContain('d2');
  });

  it('caps the number of pairs, strongest first, and never pairs a chunk with itself', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      id: `c${String(i).padStart(2, '0')}`,
      text: `Metformin glucose diabetes hepatic production variant${i}`,
    }));
    const pairs = candidatePairs(many, { maxPairs: 5 });
    expect(pairs).toHaveLength(5);
    expect(pairs.every(([x, y]) => x !== y)).toBe(true);
    expect(candidatePairs([docs[0]!])).toEqual([]);
  });
});

describe('budget state', () => {
  it('is pure: inputs are never mutated and a new UTC day starts fresh', () => {
    const t = Date.parse('2026-10-11T23:59:00Z');
    const s0 = emptyBudget(t);
    const frozen = JSON.stringify(s0);
    const s1 = recordSpend(s0, t, { requests: 2, costUsd: 0.5, inputTokens: 10, outputTokens: 4 });
    expect(JSON.stringify(s0)).toBe(frozen);
    expect(s1).toMatchObject({ requests: 2, costUsd: 0.5 });
    expect(rollover(s1, t + 120_000)).toEqual(emptyBudget(t + 120_000));
    expect(dayKey(t + 120_000)).toBe('2026-10-12');
    const limits = { maxRequestsPerDay: 2, maxCostUsdPerDay: null };
    const need = { requests: 1, estimatedCostUsd: null };
    expect(checkBudget(s1, limits, t, need)).toEqual({ ok: false, reason: 'requests' });
    expect(checkBudget(s1, limits, t + 120_000, need)).toEqual({ ok: true });
  });
});

describe('system wiring', () => {
  it('importing the package performs no network call', async () => {
    const real = globalThis.fetch;
    let called = 0;
    globalThis.fetch = (() => {
      called++;
      return Promise.reject(new Error('network on import'));
    }) as typeof fetch;
    try {
      await import('./index');
    } finally {
      globalThis.fetch = real;
    }
    expect(called).toBe(0);
  });

  it('systemClock hashes with SHA-256, sleeps and aborts', async () => {
    const c = systemClock();
    expect(await c.sha256('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(c.randomId()).toMatch(/^[0-9a-f-]{36}$/);
    const ac = new AbortController();
    const slept = c.sleep(10_000, ac.signal);
    ac.abort();
    await expect(slept).rejects.toThrow();
    await expect(c.sleep(1)).resolves.toBeUndefined();
    expect(toHex(new Uint8Array([0, 255]).buffer)).toBe('00ff');
  });
});
