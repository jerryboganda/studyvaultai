// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { emptyBudget } from './budget';
import { CLINICAL_NOTICE, CONSENT_TTL_MS } from './constants';
import { runTask } from './pipeline';
import { buildPreview, createConsentToken } from './prepare';
import { createMockProvider } from './providers';
import { G1, H1, H2, N1, T0, approve, goodReply, makeDeps, sel, selectionFor } from './testkit';

const okProvider = (kind: Parameters<typeof goodReply>[0], s = selectionFor(kind), n = 1) =>
  createMockProvider(Array.from({ length: n }, () => ({ json: goodReply(kind, s) })));

describe('preview is exactly what is sent', () => {
  it('the provider receives byte-identical messages to the preview', async () => {
    const s = selectionFor('summary');
    const provider = okProvider('summary', s);
    const deps = makeDeps(provider);
    const preview = await buildPreview('summary', s, deps);
    const token = createConsentToken(preview, deps);
    await runTask('summary', s, deps, { consent: token });
    expect(provider.calls[0]!.messages).toEqual(preview.messages);
    expect(preview.outboundText).toContain(H1.text);
    expect(preview.willSend).toBe(true);
    expect(preview.estimate.inputTokens).toBeGreaterThan(0);
    expect(preview.estimate.estimatedCostUsd).toBeNull();
  });

  it('PII is redacted in the outbound text and the redaction report says what and where', async () => {
    const pii = {
      id: 'hl-pii-001',
      kind: 'highlight' as const,
      text: 'Contact Dr. Ali at ali.hassan@clinic.example or +20 100 123 4567 re card 4539 5787 6362 1486 and SSN 123-45-6789 metformin first-line.',
    };
    const s = sel([pii]);
    const provider = okProvider('exam_pearl', s);
    const deps = makeDeps(provider);
    const opts = await approve('exam_pearl', s, deps);
    const preview = await buildPreview('exam_pearl', s, deps);
    for (const raw of [
      'ali.hassan@clinic.example',
      '+20 100 123 4567',
      '4539 5787 6362 1486',
      '123-45-6789',
    ]) {
      expect(preview.outboundText).not.toContain(raw);
    }
    expect(preview.outboundText).toContain('[EMAIL]');
    expect(preview.redactionSummary).toMatchObject({ email: 1, phone: 1, card: 1, national_id: 1 });
    expect(preview.redactions.map((r) => r.original)).toContain('ali.hassan@clinic.example');
    await runTask('exam_pearl', s, deps, opts);
    const sent = JSON.stringify(provider.calls[0]!.messages);
    expect(sent).not.toContain('ali.hassan');
    expect(sent).not.toContain('4539');
  });

  it('user redaction edits change what is sent, and consent is bound to them', async () => {
    const c = {
      id: 'hl-edit-001',
      kind: 'highlight' as const,
      text: 'Email jane@example.com about metformin dosing in type 2 diabetes.',
    };
    const s = sel([c]);
    const provider = okProvider('summary', s, 3);
    const deps = makeDeps(provider);
    const region = (await buildPreview('summary', s, deps)).redactions[0]!;
    const kept = { keep: [region.id] };
    const optsKept = await approve('summary', s, deps, { edits: kept });
    await runTask('summary', s, deps, optsKept);
    expect(JSON.stringify(provider.calls[0]!.messages)).toContain('jane@example.com');
    // The token approved the kept version; running with the default (redacted) edits must be refused.
    await expect(runTask('summary', s, deps, { consent: optsKept.consent })).rejects.toMatchObject({
      code: 'consent_mismatch',
    });
    // Hand-marking extra text redacts it.
    const start = c.text.indexOf('metformin');
    const edits = { add: [{ chunkId: c.id, start, end: start + 'metformin'.length }] };
    const preview = await buildPreview('summary', s, deps, edits);
    expect(preview.chunks[0]!.sentText).toContain('[REDACTED] dosing');
  });

  it('long passages are cut visibly and never through a sensitive region', async () => {
    const email = 'long.address@example.com';
    const text = `${'word '.repeat(1578)}${email} tail`; // the address straddles the 7900 cut
    const s = sel([{ id: 'hl-long-001', kind: 'highlight', text }]);
    const deps = makeDeps(okProvider('summary', s), { limits: { maxChunkChars: 7_900 } });
    const preview = await buildPreview('summary', s, deps);
    const chunk = preview.chunks[0]!;
    expect(chunk.truncated).toBe(true);
    expect(chunk.sentText).not.toContain('long.addr');
    expect(chunk.sentText).not.toContain('@example');
    expect(preview.warnings.join(' ')).toMatch(/only the start is sent/);
  });

  it('includes a price estimate when pricing is supplied', async () => {
    const s = selectionFor('summary');
    const deps = makeDeps(okProvider('summary', s), {
      pricing: { inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
    });
    const p = await buildPreview('summary', s, deps);
    const { inputTokens, maxOutputTokens } = p.estimate;
    expect(p.estimate.estimatedCostUsd).toBeCloseTo(
      (inputTokens * 3 + maxOutputTokens * 15) / 1e6,
      10,
    );
  });
});

describe('consent gate', () => {
  it('refuses to run without a consent token and never calls the provider', async () => {
    const s = selectionFor('summary');
    const provider = okProvider('summary', s);
    const deps = makeDeps(provider);
    await expect(runTask('summary', s, deps, { consent: undefined })).rejects.toMatchObject({
      code: 'consent_required',
    });
    await expect(
      runTask('summary', s, deps, { consent: { nope: true } as never }),
    ).rejects.toMatchObject({ code: 'consent_required' });
    expect(provider.calls).toHaveLength(0);
  });

  it('refuses a token for a different selection, kind, model or provider', async () => {
    const s = selectionFor('summary');
    const provider = okProvider('summary', s, 4);
    const deps = makeDeps(provider);
    const opts = await approve('summary', s, deps);

    await expect(runTask('summary', sel([H1]), deps, opts)).rejects.toMatchObject({
      code: 'consent_mismatch',
    });
    await expect(runTask('exam_pearl', s, deps, opts)).rejects.toMatchObject({
      code: 'consent_mismatch',
    });
    const otherModel = makeDeps(createMockProvider([], { model: 'other-model' }));
    await expect(runTask('summary', s, otherModel, opts)).rejects.toMatchObject({
      code: 'consent_mismatch',
    });
    const forged = { ...opts.consent!, previewHash: 'a'.repeat(64) };
    await expect(runTask('summary', s, deps, { consent: forged })).rejects.toMatchObject({
      code: 'consent_mismatch',
    });
    expect(provider.calls).toHaveLength(0);
  });

  it('a token expires', async () => {
    const s = selectionFor('summary');
    const provider = okProvider('summary', s);
    const deps = makeDeps(provider);
    const opts = await approve('summary', s, deps);
    deps.clock.t = T0 + CONSENT_TTL_MS + 1;
    await expect(runTask('summary', s, deps, opts)).rejects.toMatchObject({
      code: 'consent_expired',
    });
    expect(provider.calls).toHaveLength(0);
  });

  it('AI disabled: typed error before any work', async () => {
    const s = selectionFor('summary');
    const provider = okProvider('summary', s);
    const deps = makeDeps(provider, { enabled: false });
    await expect(runTask('summary', s, deps, { consent: undefined })).rejects.toMatchObject({
      code: 'disabled',
    });
    expect(provider.calls).toHaveLength(0);
  });

  it('validates the selection at the boundary', async () => {
    const deps = makeDeps(createMockProvider([]));
    for (const bad of [
      { chunks: [] },
      { chunks: [{ id: 'x y', kind: 'highlight', text: 'a' }] },
      {
        chunks: [
          { id: 'dup-0001', kind: 'highlight', text: 'a' },
          { id: 'dup-0001', kind: 'note', text: 'b' },
        ],
      },
      { chunks: [{ id: 'ok-00001', kind: 'highlight', text: '\u200B\u200B' }] },
      { chunks: [{ id: 'ok-00001', kind: 'highlight', text: 'a' }], extra: 1 },
      { chunks: [{ id: 'question', kind: 'highlight', text: 'shadows the question block' }] },
      { chunks: [{ id: 'claim_1', kind: 'note', text: 'shadows a statement block' }] },
    ]) {
      await expect(buildPreview('summary', bad as never, deps)).rejects.toMatchObject({
        code: 'invalid_selection',
      });
    }
    await expect(buildPreview('hack' as never, sel([H1]), deps)).rejects.toMatchObject({
      code: 'invalid_selection',
    });
    await expect(buildPreview('compare_topics', sel([H1]), deps)).rejects.toMatchObject({
      code: 'invalid_selection',
    });
  });
});

describe('caching and fingerprints', () => {
  it('an identical request is served from the cache without a provider call', async () => {
    const s = selectionFor('summary');
    const provider = okProvider('summary', s, 2);
    const deps = makeDeps(provider);
    const first = await runTask('summary', s, deps, await approve('summary', s, deps));
    const second = await runTask('summary', s, deps, await approve('summary', s, deps));
    expect(provider.calls).toHaveLength(1);
    expect(second.cacheHit).toBe(true);
    expect(second.attempts).toBe(0);
    expect(second.result.id).toBe(first.result.id);
    expect(deps.cache.size).toBe(1);
  });

  it('whitespace-only differences share a fingerprint; model and kind do not', async () => {
    const a = sel([{ ...H1, text: H1.text }]);
    const b = sel([{ ...H1, text: H1.text.replace(/ /g, '  ') }]);
    const prov = createMockProvider(() => ({ json: goodReply('summary', a) }));
    const deps = makeDeps(prov);
    const r1 = await runTask('summary', a, deps, await approve('summary', a, deps));
    const r2 = await runTask('summary', b, deps, await approve('summary', b, deps));
    expect(r2.cacheHit).toBe(true);
    expect(r2.result.inputFingerprint).toBe(r1.result.inputFingerprint);

    const otherModel = makeDeps(
      createMockProvider(() => ({ json: goodReply('summary', a) }), { model: 'm2' }),
      {
        cache: deps.cache,
      },
    );
    const r3 = await runTask('summary', a, otherModel, await approve('summary', a, otherModel));
    expect(r3.cacheHit).toBe(false);
    expect(r3.result.inputFingerprint).not.toBe(r1.result.inputFingerprint);

    const pearl = createMockProvider(() => ({ json: goodReply('exam_pearl', a) }));
    const dPearl = makeDeps(pearl, { cache: deps.cache });
    const r4 = await runTask('exam_pearl', a, dPearl, await approve('exam_pearl', a, dPearl));
    expect(r4.result.inputFingerprint).not.toBe(r1.result.inputFingerprint);
  });

  it('a corrupt cache entry is ignored, not trusted', async () => {
    const s = selectionFor('summary');
    const provider = okProvider('summary', s);
    const deps = makeDeps(provider, {
      cache: { get: () => Promise.resolve({ junk: true } as never), put: () => Promise.resolve() },
    });
    const out = await runTask('summary', s, deps, await approve('summary', s, deps));
    expect(out.cacheHit).toBe(false);
    expect(provider.calls).toHaveLength(1);
  });
});

describe('budget (pure state in / state out)', () => {
  const limits = { maxRequestsPerDay: 1, maxCostUsdPerDay: null };

  it('counts requests, then refuses; a new UTC day resets', async () => {
    const s1 = sel([H1]);
    const s2 = sel([H2]);
    const provider = createMockProvider(() => ({ json: goodReply('summary', s1) }));
    const deps = makeDeps(provider);
    let state = emptyBudget(T0);
    const a = await runTask('summary', s1, deps, {
      ...(await approve('summary', s1, deps)),
      budget: { state, limits },
    });
    expect(a.budget).toMatchObject({ requests: 1 });
    state = a.budget!;
    await expect(
      runTask('summary', s2, deps, {
        ...(await approve('summary', s2, deps)),
        budget: { state, limits },
      }),
    ).rejects.toMatchObject({ code: 'budget_exceeded', detail: 'requests' });
    // Cache hits are free.
    const hit = await runTask('summary', s1, deps, {
      ...(await approve('summary', s1, deps)),
      budget: { state, limits },
    });
    expect(hit.cacheHit).toBe(true);
    expect(hit.budget).toEqual(state);
    // Next UTC day.
    deps.clock.t = T0 + 24 * 3_600_000;
    const d2 = await runTask('summary', s2, deps, {
      ...(await approve('summary', s2, deps)),
      budget: { state, limits },
    });
    expect(d2.budget).toMatchObject({ requests: 1, day: '2026-10-12' });
  });

  it('cost caps use the pricing table and refuse when cost cannot be known', async () => {
    const s = selectionFor('summary');
    const noPrice = makeDeps(okProvider('summary', s));
    const capped = { maxRequestsPerDay: 10, maxCostUsdPerDay: 1 };
    await expect(
      runTask('summary', s, noPrice, {
        ...(await approve('summary', s, noPrice)),
        budget: { state: emptyBudget(T0), limits: capped },
      }),
    ).rejects.toMatchObject({ code: 'budget_exceeded', detail: 'cost_unknown' });

    const pricing = { inputUsdPerMTok: 1_000_000, outputUsdPerMTok: 1_000_000 }; // $1 per token: any call is over
    const priced = makeDeps(okProvider('summary', s), { pricing });
    await expect(
      runTask('summary', s, priced, {
        ...(await approve('summary', s, priced)),
        budget: { state: emptyBudget(T0), limits: capped },
      }),
    ).rejects.toMatchObject({ code: 'budget_exceeded', detail: 'cost' });

    const cheap = makeDeps(okProvider('summary', s), {
      pricing: { inputUsdPerMTok: 1, outputUsdPerMTok: 2 },
    });
    const out = await runTask('summary', s, cheap, {
      ...(await approve('summary', s, cheap)),
      budget: { state: emptyBudget(T0), limits: capped },
    });
    expect(out.result.usage.estimatedCostUsd).toBeGreaterThan(0);
    expect(out.budget!.costUsd).toBeCloseTo(out.result.usage.estimatedCostUsd!, 12);
    expect(out.budget!.inputTokens).toBe(out.result.usage.inputTokens);
  });

  it('a failed run still reports the spend it caused', async () => {
    const s = selectionFor('summary');
    const provider = createMockProvider([{ text: 'nope' }, { text: 'still nope' }]);
    const deps = makeDeps(provider);
    const err = await runTask('summary', s, deps, {
      ...(await approve('summary', s, deps)),
      budget: { state: emptyBudget(T0), limits: { maxRequestsPerDay: 10, maxCostUsdPerDay: null } },
    }).catch((e) => e);
    expect(err.code).toBe('invalid_output');
    expect(err.budgetAfter.requests).toBe(2);
  });

  it('per-task caps: oversize input is refused, output cap reaches the provider', async () => {
    const huge = sel(
      Array.from({ length: 6 }, (_, i) => ({
        id: `hl-big-00${i}`,
        kind: 'highlight' as const,
        text: `${i} ${'lorem ipsum dolor '.repeat(500)}`,
      })),
    );
    const deps = makeDeps(okProvider('summary', huge), { limits: { maxInputTokens: 2_000 } });
    await expect(buildPreview('summary', huge, deps)).rejects.toMatchObject({
      code: 'input_too_large',
    });

    const s = selectionFor('exam_pearl');
    const provider = okProvider('exam_pearl', s);
    const d2 = makeDeps(provider, { limits: { maxOutputTokens: 123 } });
    await runTask('exam_pearl', s, d2, await approve('exam_pearl', s, d2));
    expect(provider.calls[0]!.maxOutputTokens).toBe(123);
  });
});

describe('notices and provenance', () => {
  it('clinical content gets the fixed notice; the caller can override either way', async () => {
    const s = sel([H1, H2]);
    const deps = makeDeps(okProvider('summary', s, 3));
    const auto = await runTask('summary', s, deps, await approve('summary', s, deps));
    expect(auto.result.notices).toContain(CLINICAL_NOTICE);

    const geo = sel([G1]);
    const d2 = makeDeps(okProvider('summary', geo));
    const nonClin = await runTask('summary', geo, d2, await approve('summary', geo, d2));
    expect(nonClin.result.notices).not.toContain(CLINICAL_NOTICE);

    const forced = sel([G1], { clinical: true });
    const d3 = makeDeps(okProvider('summary', forced));
    const f = await runTask('summary', forced, d3, await approve('summary', forced, d3));
    expect(f.result.notices).toContain(CLINICAL_NOTICE);

    const off = sel([H1, H2], { clinical: false });
    const d4 = makeDeps(okProvider('summary', off));
    const o = await runTask('summary', off, d4, await approve('summary', off, d4));
    expect(o.result.notices).not.toContain(CLINICAL_NOTICE);
  });

  it('records provenance and never touches the selection', async () => {
    const s = sel([H1, N1]);
    const snapshot = JSON.stringify(s);
    const provider = okProvider('summary', s);
    const deps = makeDeps(provider);
    const preview = await buildPreview('summary', s, deps);
    const token = createConsentToken(preview, deps);
    const { result } = await runTask('summary', s, deps, { consent: token });
    expect(JSON.stringify(s)).toBe(snapshot);
    expect(result.inputSourceIds).toEqual([H1.id, N1.id]);
    expect(result.provider).toBe('mock');
    expect(result.model).toBe('mock-model');
    expect(result.consentRef).toBe(token.id);
    expect(result.createdAt).toBe(new Date(T0).toISOString());
    // Quotes are cited by id; the immutable text is never copied back as an "edited" quote.
    for (const c of result.citations) {
      const src = [H1, N1].find((x) => x.id === (c.highlightId ?? c.noteId))!;
      expect(src.text).toContain(c.quote);
    }
    expect(result.citations.some((c) => c.noteId === N1.id || c.highlightId === H1.id)).toBe(true);
  });
});
