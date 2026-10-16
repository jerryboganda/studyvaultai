// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { retrieveStudyItems, type StudyItem } from '../chat';

const items: StudyItem[] = [
  {
    id: 'card-1',
    kind: 'card',
    highlightId: 'h-in',
    text: 'Flashcard question: What do ACE inhibitors do?\nAnswer: They block angiotensin converting enzyme.',
  },
  {
    id: 'card-2',
    kind: 'card',
    highlightId: 'h-out',
    text: 'Flashcard question: Which drug is first-line for type 2 diabetes?\nAnswer: Metformin.',
  },
  {
    id: 'kp-1',
    kind: 'knowledge_point',
    highlightId: null,
    text: 'Knowledge point: Heart failure reduces cardiac output.\nExam pearl: Diuretics relieve congestion.',
  },
];
const load = () => Promise.resolve(items);

describe('retrieveStudyItems', () => {
  it('finds a flashcard by a stem of its words', async () => {
    const found = await retrieveStudyItems('How does an ACE inhibitor work?', 4, load);
    expect(found.map((f) => f.id)).toContain('card-1');
    expect(found[0]).toMatchObject({ kind: 'card', label: 'flashcard' });
  });

  it('expands a known abbreviation to the words the cards use', async () => {
    const found = await retrieveStudyItems('What is HF?', 4, load);
    expect(found.map((f) => f.id)).toEqual(['kp-1']);
    expect(found[0]?.label).toBe('knowledge point');
  });

  it('returns nothing when no card shares a word', async () => {
    expect(await retrieveStudyItems('zebrafish genomics pipeline', 4, load)).toEqual([]);
    expect(await retrieveStudyItems('and the of', 4, load)).toEqual([]);
  });

  it('needs more than one shared word for a long question', async () => {
    const found = await retrieveStudyItems(
      'Explain pharmacology of glucose lowering agents and diabetes screening intervals',
      4,
      load,
    );
    // "diabetes" alone is one shared word out of many: not enough.
    expect(found).toEqual([]);
  });
});

describe('partialAnswer', () => {
  it('reads the answer field while the JSON is still being written', async () => {
    const { partialAnswer } = await import('../chat');
    expect(partialAnswer('{"answ')).toBe('');
    expect(partialAnswer('{"answer": "Beta block')).toBe('Beta block');
    expect(partialAnswer('{"answer":"Line one\\nLine \\"two\\" \\u00e9", "basis":"gen')).toBe(
      'Line one\nLine "two" \u00e9',
    );
    expect(partialAnswer('{"answer": "cut off\\')).toBe('cut off');
  });
});

describe('scope', () => {
  it('offers only items made from highlights in the scope, never a free-standing card', async () => {
    const all = await retrieveStudyItems(
      'ACE inhibitors metformin diabetes heart failure',
      10,
      load,
    );
    expect(all.map((f) => f.id).sort()).toEqual(['card-1', 'card-2', 'kp-1']);
    const scoped = await retrieveStudyItems(
      'ACE inhibitors metformin diabetes heart failure',
      10,
      load,
      new Set(['h-in']),
    );
    expect(scoped.map((f) => f.id)).toEqual(['card-1']);
  });
});

describe('fitSelection', () => {
  const passage = (id: string, chars: number) => ({
    id,
    kind: 'highlight' as const,
    text: 'x'.repeat(chars),
  });
  const turn = (role: 'user' | 'assistant', chars: number) => ({ role, text: 'y'.repeat(chars) });

  it('keeps everything that fits and says nothing was left out', async () => {
    const { fitSelection } = await import('../chat');
    const r = fitSelection({ chunks: [passage('a', 500)], question: 'q' }, 128_000);
    expect(r.droppedPassages).toBe(0);
    expect(r.droppedTurns).toBe(0);
    expect(r.selection.chunks).toHaveLength(1);
    expect(r.budgetTokens).toBe(10_000);
  });

  it('drops the lowest-ranked passages first, then the oldest turns, never the question or memory', async () => {
    const { fitSelection, estimateRequestTokens } = await import('../chat');
    const sel = {
      chunks: [passage('best', 6000), passage('mid', 6000), passage('worst', 6000)],
      question: 'what?',
      memory: 'summary',
      history: [
        turn('user', 3000),
        turn('assistant', 3000),
        turn('user', 3000),
        turn('assistant', 3000),
      ],
    };
    const r = fitSelection(sel, 128_000);
    expect(estimateRequestTokens(r.selection)).toBeLessThanOrEqual(r.budgetTokens);
    expect(r.selection.chunks.map((c) => c.id)[0]).toBe('best');
    expect(r.droppedPassages).toBeGreaterThan(0);
    expect(r.selection.question).toBe('what?');
    expect(r.selection.memory).toBe('summary');
    // Passages go before any turn does.
    if (r.droppedTurns > 0) expect(r.selection.chunks).toHaveLength(0);
  });

  it('uses a smaller budget for a small model', async () => {
    const { fitSelection } = await import('../chat');
    const { contextWindowTokens } = await import('../vendors');
    expect(contextWindowTokens('ubag', 'deepseek_web')).toBe(16_000);
    expect(contextWindowTokens('openai', 'gpt-5')).toBe(128_000);
    expect(contextWindowTokens('custom', 'mystery')).toBe(8_000);
    const r = fitSelection({ chunks: [passage('a', 14000)], question: 'q' }, 8_000);
    expect(r.budgetTokens).toBe(4_800);
    expect(r.selection.chunks).toHaveLength(0);
  });
});
