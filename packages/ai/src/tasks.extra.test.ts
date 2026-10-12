// @vitest-environment node
// The task kinds added with the router: mnemonic, short_viva, study_outline, and the earlier turns
// of a bank chat (explain with `history`). Same contract as every other kind: strict output,
// verbatim-grounded evidence, unverified until accepted.
import { describe, expect, it } from 'vitest';
import { MNEMONIC_NOTICE } from './constants';
import { acceptResult, runTask } from './pipeline';
import { buildPreview } from './prepare';
import { createMockProvider } from './providers';
import { AiResult } from './schema';
import type { AiSelection, AiTaskKind } from './schema';
import { H1, H2, N1, approve, goodReply, makeDeps, sel } from './testkit';

async function run(kind: AiTaskKind, steps: unknown[], selection: AiSelection = sel([H1, H2])) {
  const provider = createMockProvider(steps.map((json) => ({ json })));
  const deps = makeDeps(provider);
  const opts = await approve(kind, selection, deps);
  return { out: await runTask(kind, selection, deps, opts), provider, deps };
}

// A model reply the tests then break on purpose: loosely typed on purpose.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;
const reply = (kind: AiTaskKind, selection: AiSelection = sel([H1, H2])) =>
  goodReply(kind, selection) as Loose;

describe('mnemonic', () => {
  it("is an aid, not a fact: the flag and the notice are the pipeline's, and the quote anchors it", async () => {
    const { out } = await run('mnemonic', [reply('mnemonic')]);
    if (out.result.kind !== 'mnemonic') throw new Error('kind');
    expect(out.result.output.aidNotFact).toBe(true);
    expect(out.result.notices).toContain(MNEMONIC_NOTICE);
    expect(out.result.verificationState).toBe('unverified');
    expect(out.result.citations).toEqual([{ highlightId: H1.id, quote: H1.text.slice(0, 40) }]);
  });

  it('a model that sets the flag itself is out of format (nothing but the pipeline writes it)', async () => {
    const forged = { ...reply('mnemonic'), aidNotFact: true };
    const provider = createMockProvider([{ json: forged }, { json: forged }]);
    const deps = makeDeps(provider);
    await expect(
      runTask('mnemonic', sel([H1, H2]), deps, await approve('mnemonic', sel([H1, H2]), deps)),
    ).rejects.toMatchObject({ code: 'invalid_output' });
  });

  it('an aid whose quote is not in the source is flagged and cannot be accepted', async () => {
    const bad = reply('mnemonic');
    bad.aids[0].evidence[0].text = 'Sulfonylureas are the first-line therapy';
    const { out } = await run('mnemonic', [bad]);
    expect(out.result.verificationState).toBe('unsupported');
    expect(out.result.grounding.claims[0]?.reason).toBe('quote_not_found');
    expect(() => acceptResult(out.result, 1)).toThrow(/cannot be accepted/);
  });

  it('keeps 1 to 5 aids', async () => {
    const six = reply('mnemonic');
    six.aids = Array.from({ length: 6 }, () => ({ ...six.aids[0] }));
    const provider = createMockProvider([{ json: six }, { json: six }]);
    const deps = makeDeps(provider);
    await expect(
      runTask('mnemonic', sel([H1, H2]), deps, await approve('mnemonic', sel([H1, H2]), deps)),
    ).rejects.toMatchObject({ code: 'invalid_output' });
  });
});

describe('short_viva', () => {
  it('questions carry model answers that cite the source', async () => {
    const { out } = await run('short_viva', [reply('short_viva')]);
    if (out.result.kind !== 'short_viva') throw new Error('kind');
    expect(out.result.output.questions).toHaveLength(2);
    expect(out.result.grounding).toMatchObject({ checked: 2, supported: 2, unsupported: 0 });
    expect(out.result.citations.map((c) => c.highlightId)).toEqual([H1.id, H2.id]);
  });

  it('fewer than three is allowed when the sources cannot support more; more than five is not', async () => {
    const one = reply('short_viva');
    one.questions = [one.questions[0]];
    expect((await run('short_viva', [one])).out.result.kind).toBe('short_viva');

    const six = reply('short_viva');
    six.questions = Array.from({ length: 6 }, () => ({ ...six.questions[0] }));
    const provider = createMockProvider([{ json: six }, { json: six }]);
    const deps = makeDeps(provider);
    await expect(
      runTask('short_viva', sel([H1, H2]), deps, await approve('short_viva', sel([H1, H2]), deps)),
    ).rejects.toMatchObject({ code: 'invalid_output' });
  });

  it('a model answer that quotes something the source does not say is flagged, per question', async () => {
    const mixed = reply('short_viva');
    mixed.questions[1].evidence[0].text = 'Insulin is never needed in type 1 diabetes';
    const { out } = await run('short_viva', [mixed]);
    expect(out.result.verificationState).toBe('unsupported');
    expect(out.result.grounding.claims.map((c) => [c.path, c.supported])).toEqual([
      ['/questions/0/evidence/0/text', true],
      ['/questions/1/evidence/0/text', false],
    ]);
  });
});

describe('study_outline', () => {
  it('is a hierarchy by level, every item cited', async () => {
    const { out } = await run('study_outline', [reply('study_outline')]);
    if (out.result.kind !== 'study_outline') throw new Error('kind');
    expect(out.result.output.items.map((i) => i.level)).toEqual([1, 2, 1]);
    expect(out.result.grounding.unsupported).toBe(0);
    expect(AiResult.safeParse(out.result).success).toBe(true);
  });

  it.each([
    ['starts below the top level', [{ level: 2 }, { level: 2 }]],
    ['jumps two levels at once', [{ level: 1 }, { level: 3 }]],
    ['leaves the three levels', [{ level: 1 }, { level: 4 }]],
  ])(
    'an outline that %s is sent back once, and the corrected one is stored',
    async (_n, levels) => {
      const base = reply('study_outline');
      const broken = {
        ...base,
        items: levels.map((l) => ({ ...base.items[0], ...l })),
      };
      const { out, provider } = await run('study_outline', [broken, base]);
      expect(provider.calls).toHaveLength(2);
      const repair = provider.calls[1]!.messages.at(-1)!.content;
      expect(repair).toContain('rejected by the format validator');
      if (out.result.kind !== 'study_outline') throw new Error('kind');
      expect(out.result.output.items.map((i) => i.level)).toEqual([1, 2, 1]);
    },
  );
});

describe('earlier turns of a chat', () => {
  const question = 'And what about type 1 diabetes?';
  const withHistory = (): AiSelection =>
    sel([H1, N1], {
      question,
      history: [
        { role: 'user', text: 'What is first-line for type 2 diabetes?' },
        { role: 'assistant', text: 'Metformin, according to your passage.' },
      ],
    });

  it('are shown in the preview as data blocks of their own and change what consent covers', async () => {
    const provider = createMockProvider([]);
    const deps = makeDeps(provider);
    const preview = await buildPreview('explain', withHistory(), deps);
    expect(preview.outboundText).toContain('kind="history"');
    expect(preview.outboundText).toContain(
      'The user asked: What is first-line for type 2 diabetes?',
    );
    expect(preview.outboundText).toContain(
      'The assistant answered: Metformin, according to your passage.',
    );
    expect(preview.outboundText).toContain('earlier turns of this conversation');
    expect(preview.chunks.map((c) => [c.id, c.kind])).toEqual([
      [H1.id, 'highlight'],
      [N1.id, 'note'],
      ['history_1', 'history'],
      ['history_2', 'history'],
      ['question', 'question'],
    ]);
    // The same question without them is another request, with another hash.
    const bare = await buildPreview('explain', sel([H1, N1], { question }), deps);
    expect(bare.previewHash).not.toBe(preview.previewHash);
    expect(bare.outboundText).not.toContain('history');
  });

  it('are never evidence: citing one is flagged as a passage that was not sent', async () => {
    const s = withHistory();
    const bad = {
      answer: 'It is metformin.',
      answerState: 'answered',
      uncertainty: '',
      evidence: [{ quoteId: 'history_2', text: 'Metformin, according to your passage.' }],
    };
    const { out } = await run('explain', [bad], s);
    expect(out.result.grounding.claims[0]).toMatchObject({
      supported: false,
      reason: 'unknown_id',
    });
    if (out.result.kind !== 'explain') throw new Error('kind');
    // Nothing grounded: the answer is not presented as one.
    expect(out.result.output.answerState).toBe('insufficient_sources');
    expect(out.result.verificationState).toBe('unsupported');
    expect(out.result.inputSourceIds).toEqual([H1.id, N1.id]);
  });

  it('are redacted like any passage, and only explain takes them', async () => {
    const s = sel([H1], {
      question,
      history: [{ role: 'user', text: 'Mail jane.doe@example.org the dose of metformin.' }],
    });
    const deps = makeDeps(createMockProvider([]));
    const preview = await buildPreview('explain', s, deps);
    expect(preview.outboundText).not.toContain('jane.doe@example.org');
    expect(preview.outboundText).toContain('[EMAIL]');
    expect(preview.redactions.map((r) => r.chunkId)).toContain('history_1');

    await expect(
      buildPreview('summary', sel([H1], { history: s.history! }), deps),
    ).rejects.toMatchObject({ code: 'invalid_selection' });
    await expect(
      buildPreview('explain', sel([{ ...H1, id: 'history_1' }], { question }), deps),
    ).rejects.toMatchObject({ code: 'invalid_selection' });
  });
});
