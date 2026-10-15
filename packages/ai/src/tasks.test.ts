// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { CLINICAL_NOTICE, FACT_CHECK_SCOPE_NOTICE, TEMPLATE_VERSION } from './constants';
import { acceptResult, runTask } from './pipeline';
import { createMockProvider } from './providers';
import { AI_TASK_KINDS } from './constants';
import { AiResult } from './schema';
import type { AiTaskKind } from './schema';
import { G1, H1, H2, H3, approve, goodReply, makeDeps, sel, selectionFor } from './testkit';

async function run(kind: AiTaskKind, reply: unknown, selection = selectionFor(kind)) {
  const provider = createMockProvider([{ text: JSON.stringify(reply) }]);
  const deps = makeDeps(provider);
  const opts = await approve(kind, selection, deps);
  const out = await runTask(kind, selection, deps, opts);
  return { out, provider, deps };
}

describe('every task kind, end to end with the mock provider', () => {
  it.each(AI_TASK_KINDS)('%s produces a validated, grounded, unverified result', async (kind) => {
    const { out, provider } = await run(kind, goodReply(kind, selectionFor(kind)));
    const r = out.result;
    expect(AiResult.safeParse(r).success).toBe(true);
    expect(r.kind).toBe(kind);
    expect(r.verificationState).toBe('unverified');
    expect(r.acceptedByUserAt).toBeNull();
    expect(r.templateVersion).toBe(TEMPLATE_VERSION);
    expect(r.inputFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(r.grounding.unsupported).toBe(0);
    expect(r.consentRef).toMatch(/^id-/);
    expect(provider.calls).toHaveLength(1);
    expect(out.attempts).toBe(1);
    expect(r.citations.length).toBeGreaterThan(0);
    for (const c of r.citations) expect(c.highlightId ?? c.noteId).toBeTruthy();
  });

  it('exam pearl: cites the source chunk and keeps the model text out of the quote slot', async () => {
    const { out } = await run('exam_pearl', goodReply('exam_pearl', selectionFor('exam_pearl')));
    if (out.result.kind !== 'exam_pearl') throw new Error('kind');
    expect(out.result.output.sourceQuoteId).toBe(H1.id);
    expect(out.result.citations).toEqual([{ highlightId: H1.id, quote: H1.text.slice(0, 45) }]);
  });

  it('mcq: key, explanation and evidence kept; clinical text forces human verification', async () => {
    const { out } = await run('mcq', goodReply('mcq', selectionFor('mcq')));
    if (out.result.kind !== 'mcq') throw new Error('kind');
    expect(out.result.output.keyChoiceId).toBe('A');
    expect(out.result.output.evidence[0]?.quoteId).toBe(H1.id);
    // Model said false, but the content is clinical (diabetes, treatment): forced to true.
    expect(out.result.output.requiresHumanVerification).toBe(true);
    expect(out.result.notices).toContain(CLINICAL_NOTICE);
  });

  it('mcq on non-clinical text keeps the model flag and adds no clinical notice', async () => {
    const s = sel([G1], { options: { choiceCount: 3 } });
    const reply = {
      stem: 'Which sea does the Nile reach?',
      choices: [
        { id: 'A', text: 'Mediterranean Sea' },
        { id: 'B', text: 'Red Sea' },
        { id: 'C', text: 'Black Sea' },
      ],
      keyChoiceId: 'A',
      explanation: 'The Nile empties into the Mediterranean Sea.',
      evidence: [{ quoteId: G1.id, text: 'empties into the Mediterranean Sea' }],
      requiresHumanVerification: false,
    };
    const { out } = await run('mcq', reply, s);
    if (out.result.kind !== 'mcq') throw new Error('kind');
    expect(out.result.output.requiresHumanVerification).toBe(false);
    expect(out.result.notices).not.toContain(CLINICAL_NOTICE);
  });

  it('mcq with an ungrounded evidence quote is flagged unsupported and needs human verification', async () => {
    const s = selectionFor('mcq');
    const reply = goodReply('mcq', s) as { evidence: { text: string }[] };
    reply.evidence[0]!.text = 'Metformin is contraindicated in every patient';
    const { out } = await run('mcq', reply, s);
    expect(out.result.verificationState).toBe('unsupported');
    expect(out.result.grounding.unsupported).toBe(1);
    expect(out.result.grounding.claims[0]?.reason).toBe('quote_not_found');
    expect(out.result.citations).toHaveLength(0);
    if (out.result.kind !== 'mcq') throw new Error('kind');
    expect(out.result.output.requiresHumanVerification).toBe(true);
    expect(() => acceptResult(out.result, 1)).toThrow(/cannot be accepted/);
  });

  it('flashcards: basic and cloze are both kept; count limit is enforced via the repair path', async () => {
    const s = sel([H1, H2], { options: { count: 1 } });
    const two = goodReply('flashcards', s); // 2 cards but count=1
    const provider = createMockProvider([
      { json: two },
      { json: { cards: [(two as { cards: unknown[] }).cards[0]] } },
    ]);
    const deps = makeDeps(provider);
    const opts = await approve('flashcards', s, deps);
    const out = await runTask('flashcards', s, deps, opts);
    expect(provider.calls).toHaveLength(2);
    if (out.result.kind !== 'flashcards') throw new Error('kind');
    expect(out.result.output.cards).toHaveLength(1);
  });

  it('explain: answer with valid evidence stays answered', async () => {
    const { out } = await run('explain', goodReply('explain', selectionFor('explain')));
    if (out.result.kind !== 'explain') throw new Error('kind');
    expect(out.result.output.answerState).toBe('answered');
    expect(out.result.output.evidence).toHaveLength(1);
  });

  it('explain: an answer whose only citation is invented is downgraded to insufficient_sources', async () => {
    const s = selectionFor('explain');
    const reply = goodReply('explain', s) as { evidence: { text: string }[] };
    reply.evidence[0]!.text = 'Sulfonylureas are the first-line therapy';
    const { out } = await run('explain', reply, s);
    if (out.result.kind !== 'explain') throw new Error('kind');
    expect(out.result.output.answerState).toBe('insufficient_sources');
    expect(out.result.output.uncertainty).not.toBe('');
    expect(out.result.verificationState).toBe('unsupported');
  });

  it('explain: partially grounded evidence downgrades answered to partially_answered', async () => {
    const s = selectionFor('explain');
    const base = goodReply('explain', s) as { evidence: { quoteId: string; text: string }[] };
    base.evidence.push({ quoteId: 'note-0001', text: 'this sentence is not in the note at all' });
    const { out } = await run('explain', base, s);
    if (out.result.kind !== 'explain') throw new Error('kind');
    expect(out.result.output.answerState).toBe('partially_answered');
  });

  it('explain: "not in sources" is a valid, honest answer with no evidence', async () => {
    const s = selectionFor('explain');
    const reply = {
      answer: 'The selected passages do not say.',
      answerState: 'insufficient_sources',
      uncertainty: 'No passage mentions this.',
      evidence: [],
    };
    const { out } = await run('explain', reply, s);
    expect(out.result.verificationState).toBe('unverified');
    expect(out.result.grounding.checked).toBe(0);
  });

  it('explain requires a question', async () => {
    const provider = createMockProvider([]);
    const deps = makeDeps(provider);
    await expect(approve('explain', sel([H1]), deps)).rejects.toMatchObject({
      code: 'invalid_selection',
    });
  });

  it('compare_topics: not-stated cells are normalised and need no evidence', async () => {
    const { out } = await run(
      'compare_topics',
      goodReply('compare_topics', selectionFor('compare_topics')),
    );
    if (out.result.kind !== 'compare_topics') throw new Error('kind');
    const cell = out.result.output.rows[1]?.cells[0];
    expect(cell?.stated).toBe(false);
    expect(cell?.text).toBe('Not stated in the selected sources');
    expect(cell?.evidence).toEqual([]);
  });

  it('compare_topics: requested topics are enforced (repair on mismatch)', async () => {
    const s = sel([H1, H2], { topics: ['Type 1', 'Type 2'] });
    const wrong = goodReply('compare_topics', s) as { topics: string[] };
    wrong.topics = ['Type 1', 'Type 3'];
    const provider = createMockProvider([
      { json: wrong },
      { json: goodReply('compare_topics', s) },
    ]);
    const deps = makeDeps(provider);
    const out = await runTask('compare_topics', s, deps, await approve('compare_topics', s, deps));
    expect(provider.calls).toHaveLength(2);
    expect(out.result.kind).toBe('compare_topics');
  });

  it('contradictions: candidates are deterministic and the model only judges them', async () => {
    const s = selectionFor('contradictions');
    const { out, provider } = await run('contradictions', goodReply('contradictions', s), s);
    if (out.result.kind !== 'contradictions') throw new Error('kind');
    expect(out.result.output.candidateCount).toBe(1);
    expect(out.result.output.contradictions).toHaveLength(1);
    const prompt = provider.calls[0]!.messages[1]!.content;
    expect(prompt).toContain(`p1: ${H1.id} <-> ${H3.id}`);
  });

  it('contradictions: a pair the app did not offer is flagged not_a_candidate', async () => {
    const s = sel([H1, H3, G1]);
    const reply = {
      contradictions: [
        {
          a: { quoteId: H1.id, text: H1.text.slice(0, 40) },
          b: { quoteId: G1.id, text: G1.text.slice(0, 40) },
          explanation: 'invented conflict between unrelated passages',
        },
      ],
    };
    const { out } = await run('contradictions', reply, s);
    expect(out.result.verificationState).toBe('unsupported');
    expect(out.result.grounding.claims.map((c) => c.reason)).toEqual([
      'not_a_candidate',
      'not_a_candidate',
    ]);
  });

  it('contradictions: with no candidate pairs nothing is sent and the answer is computed locally', async () => {
    const s = sel([H1, G1]);
    const provider = createMockProvider([]);
    const deps = makeDeps(provider);
    const opts = await approve('contradictions', s, deps);
    const out = await runTask('contradictions', s, deps, opts);
    expect(provider.calls).toHaveLength(0);
    if (out.result.kind !== 'contradictions') throw new Error('kind');
    expect(out.result.output).toEqual({ contradictions: [], candidateCount: 0 });
    expect(out.attempts).toBe(0);
  });

  it('fact_check: labels are only the three allowed ones and the scope notice is attached', async () => {
    const { out } = await run('fact_check', goodReply('fact_check', selectionFor('fact_check')));
    if (out.result.kind !== 'fact_check') throw new Error('kind');
    expect(out.result.output.externallyVerified).toBe(false);
    expect(out.result.output.checks[0]?.label).toBe('source_supported');
    expect(out.result.output.checks[0]?.claim).toContain('Metformin');
    expect(out.result.notices).toContain(FACT_CHECK_SCOPE_NOTICE);
  });

  it('fact_check: "externally_verified" is never accepted from a model', async () => {
    const s = selectionFor('fact_check');
    const reply = goodReply('fact_check', s) as { checks: { label: string }[] };
    reply.checks[0]!.label = 'externally_verified';
    const provider = createMockProvider([{ json: reply }, { json: reply }]);
    const deps = makeDeps(provider);
    await expect(
      runTask('fact_check', s, deps, await approve('fact_check', s, deps)),
    ).rejects.toMatchObject({ code: 'invalid_output' });
  });

  it('fact_check: a supported label without grounded evidence is downgraded to not_checked', async () => {
    const s = selectionFor('fact_check');
    const reply = goodReply('fact_check', s) as { checks: { evidence: { text: string }[] }[] };
    reply.checks[0]!.evidence[0]!.text = 'Metformin is banned worldwide';
    const { out } = await run('fact_check', reply, s);
    if (out.result.kind !== 'fact_check') throw new Error('kind');
    expect(out.result.output.checks[0]?.label).toBe('not_checked');
    expect(out.result.verificationState).toBe('unsupported');
  });

  it('fact_check: a grounded conflict marks the result conflicting', async () => {
    const s = sel([H1, H3], { claims: ['Metformin is contraindicated in type 2 diabetes.'] });
    const reply = {
      checks: [
        {
          claimId: 'claim_1',
          label: 'conflicting',
          explanation: 'The passage says first-line, not contraindicated.',
          evidence: [{ quoteId: H1.id, text: H1.text.slice(0, 50) }],
        },
      ],
    };
    const { out } = await run('fact_check', reply, s);
    expect(out.result.verificationState).toBe('conflicting');
  });

  it('fact_check: a statement the model skipped becomes not_checked', async () => {
    const s = sel([H1, H2], {
      claims: ['Metformin is first-line.', 'Insulin is needed in type 1.'],
    });
    const reply = goodReply('fact_check', sel([H1, H2], { claims: ['x'] }));
    const { out } = await run('fact_check', reply, s);
    if (out.result.kind !== 'fact_check') throw new Error('kind');
    expect(out.result.output.checks.map((c) => c.label)).toEqual([
      'source_supported',
      'not_checked',
    ]);
  });
});

describe('verification states and acceptance', () => {
  it('stays unverified until the user accepts; only then source_supported', async () => {
    const { out } = await run('summary', goodReply('summary', selectionFor('summary')));
    expect(out.result.verificationState).toBe('unverified');
    const accepted = acceptResult(out.result, Date.parse('2026-10-12T00:00:00Z'));
    expect(accepted.verificationState).toBe('source_supported');
    expect(accepted.acceptedByUserAt).toBe('2026-10-12T00:00:00.000Z');
    // The stored result itself was not mutated.
    expect(out.result.acceptedByUserAt).toBeNull();
  });

  it('a result with zero checked citations is accepted but never becomes source_supported', async () => {
    const reply = {
      answer: 'Not covered.',
      answerState: 'insufficient_sources',
      uncertainty: '',
      evidence: [],
    };
    const { out } = await run('explain', reply);
    const accepted = acceptResult(out.result, Date.now());
    expect(accepted.verificationState).toBe('unverified');
    expect(accepted.acceptedByUserAt).not.toBeNull();
  });

  it('a conflicting result stays conflicting after acceptance', async () => {
    const s = sel([H1, H3], { claims: ['Metformin is contraindicated in type 2 diabetes.'] });
    const reply = {
      checks: [
        {
          claimId: 'claim_1',
          label: 'conflicting',
          explanation: 'No.',
          evidence: [{ quoteId: H1.id, text: H1.text.slice(0, 50) }],
        },
      ],
    };
    const { out } = await run('fact_check', reply, s);
    expect(acceptResult(out.result, Date.now()).verificationState).toBe('conflicting');
  });
});

describe('chat', () => {
  const ask = (extra: Record<string, unknown> = {}) => ({
    chunks: [],
    question: 'Explain how a beta blocker works in simple words.',
    ...extra,
  });

  it('answers with no passage at all, from general knowledge, citing nothing', async () => {
    const selection = AiSelectionParse(ask());
    const reply = { answer: 'Beta blockers slow the heart.', basis: 'general', evidence: [] };
    const { out, provider } = await run('chat', reply, selection);
    if (out.result.kind !== 'chat') throw new Error('kind');
    expect(out.result.output.basis).toBe('general');
    expect(out.result.inputSourceIds).toEqual([]);
    expect(out.result.verificationState).toBe('unverified');
    // The general assistant rule replaces "use only the data blocks".
    expect(provider.calls[0]!.messages[0]!.content).toContain('general knowledge');
    expect(provider.calls[0]!.messages[0]!.content).not.toContain('Use only the data blocks');
  });

  it('other kinds still need a passage', async () => {
    const deps = makeDeps(createMockProvider([]));
    await expect(approve('summary', AiSelectionParse({ chunks: [] }), deps)).rejects.toMatchObject({
      code: 'invalid_selection',
    });
  });

  it('sends the memory summary and earlier turns as non-citeable blocks', async () => {
    const selection = AiSelectionParse(
      ask({
        memory: 'We discussed heart failure drugs.',
        history: [
          { role: 'user', text: 'What is ACE inhibitor?' },
          { role: 'assistant', text: 'A drug class.' },
        ],
      }),
    );
    const reply = { answer: 'Okay.', basis: 'general', evidence: [] };
    const { provider } = await run('chat', reply, selection);
    const user = provider.calls[0]!.messages.find((m) => m.role === 'user')!.content;
    expect(user).toContain('kind="memory"');
    expect(user).toContain('kind="history"');
    expect(user).toContain('We discussed heart failure drugs.');
  });

  it('memory is refused for other kinds', async () => {
    const deps = makeDeps(createMockProvider([]));
    const selection = { ...selectionFor('summary'), memory: 'x' };
    await expect(approve('summary', selection, deps)).rejects.toMatchObject({
      code: 'invalid_selection',
    });
  });

  it('downgrades "notes" to "general" when no citation can be found', async () => {
    const selection = selectionFor('chat');
    const reply = {
      answer: 'It is in your notes.',
      basis: 'notes',
      evidence: [{ quoteId: H1.id, text: 'this exact sentence is not in the passage' }],
    };
    const { out } = await run('chat', reply, selection);
    if (out.result.kind !== 'chat') throw new Error('kind');
    expect(out.result.output.basis).toBe('general');
    expect(out.result.verificationState).toBe('unsupported');
  });

  it('rejects general answers that cite', async () => {
    const reply = {
      answer: 'x',
      basis: 'general',
      evidence: [{ quoteId: H1.id, text: H1.text.slice(0, 40) }],
    };
    const provider = createMockProvider([
      { text: JSON.stringify(reply) },
      { text: JSON.stringify(reply) },
    ]);
    const deps = makeDeps(provider);
    const selection = selectionFor('chat');
    const opts = await approve('chat', selection, deps);
    await expect(runTask('chat', selection, deps, opts)).rejects.toBeTruthy();
  });
});

function AiSelectionParse(v: unknown) {
  return v as ReturnType<typeof selectionFor>;
}
