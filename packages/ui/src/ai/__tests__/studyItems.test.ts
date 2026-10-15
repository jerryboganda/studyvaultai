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
    const all = await retrieveStudyItems('ACE inhibitors metformin diabetes heart failure', 10, load);
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
