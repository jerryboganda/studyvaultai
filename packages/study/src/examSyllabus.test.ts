// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { CoverageTopic } from './analytics';
import { createExam, type ExamCardFacts, type ExamConfig } from './exam';
import {
  allocateByWeight,
  drawSyllabusExam,
  syllabusExamCounts,
  syllabusExamPool,
  syllabusScopeLabel,
  type ExamCardRefs,
  type ExamSyllabusInput,
} from './examSyllabus';
import { seededRandom } from './random';

const topic = (id: string, over: Partial<CoverageTopic> = {}): CoverageTopic => ({
  id,
  title: `Topic ${id}`,
  depth: 1,
  parentId: null,
  bankIds: [],
  tagIds: [],
  ...over,
});

/**
 *   A (weight 3)          own: nothing
 *     A1 (weight 2)       bank b1
 *     A2                  tag t1
 *   B                     bank b2
 *   C                     nothing
 * Shares of the whole: A1 0.4, A2 0.2, B 0.2, C 0.2.
 */
const OUTLINE: CoverageTopic[] = [
  topic('A', { weight: 3 }),
  topic('A1', { depth: 2, parentId: 'A', weight: 2, bankIds: ['b1'] }),
  topic('A2', { depth: 2, parentId: 'A', tagIds: ['t1'] }),
  topic('B', { bankIds: ['b2'] }),
  topic('C'),
];

const cardId = (n: number) => `card-${String(n).padStart(6, '0')}`;
const facts = (n: number): ExamCardFacts => ({
  cardId: cardId(n),
  cardType: 'basic',
  bankId: null,
  bankIds: [],
  folderIds: [],
  tags: [],
});

/** `spec`: card number -> the banks and tags it is in. */
function vault(spec: Record<number, ExamCardRefs>): {
  cards: ExamCardFacts[];
  syllabus: ExamSyllabusInput;
} {
  const nums = Object.keys(spec).map(Number);
  return {
    cards: nums.map(facts),
    syllabus: {
      topics: OUTLINE,
      refs: new Map(nums.map((n) => [cardId(n), spec[n] as ExamCardRefs] as const)),
    },
  };
}
const inBank = (...b: string[]): ExamCardRefs => ({ bankIds: b, tagIds: [] });
const inTag = (...t: string[]): ExamCardRefs => ({ bankIds: [], tagIds: t });

/** 10 cards in A1, 10 in A2, 10 in B, one nowhere and one outside the syllabus. */
function big() {
  const spec: Record<number, ExamCardRefs> = {};
  for (let n = 1; n <= 10; n += 1) spec[n] = inBank('b1');
  for (let n = 11; n <= 20; n += 1) spec[n] = inTag('t1');
  for (let n = 21; n <= 30; n += 1) spec[n] = inBank('b2');
  spec[31] = inBank('elsewhere');
  return vault(spec);
}

describe('allocateByWeight', () => {
  it('shares by largest remainder, ties to the earlier item, and always adds up', () => {
    const items = [1, 1, 1].map((weight) => ({ weight, cap: 99 }));
    expect(allocateByWeight(items, 10)).toEqual([4, 3, 3]);
    expect(allocateByWeight(items, 2)).toEqual([1, 1, 0]);
    expect(allocateByWeight(items, 0)).toEqual([0, 0, 0]);
    const weighted = [4, 2, 2].map((weight) => ({ weight, cap: 99 }));
    expect(allocateByWeight(weighted, 10)).toEqual([5, 3, 2]);
  });

  it('never gives an item more than it holds, and shares the rest in proportion', () => {
    const items = [
      { weight: 4, cap: 1 },
      { weight: 2, cap: 99 },
      { weight: 2, cap: 99 },
    ];
    // 4/8 of 10 would be 5, but only 1 exists: the other 9 go 1:1.
    expect(allocateByWeight(items, 10)).toEqual([1, 5, 4]);
    // Asked for more than exists: everything, no more.
    expect(allocateByWeight(items, 500)).toEqual([1, 99, 99]);
  });

  it('skips an item with no cards or no weight', () => {
    expect(
      allocateByWeight(
        [
          { weight: 1, cap: 0 },
          { weight: 0, cap: 5 },
          { weight: 1, cap: 5 },
        ],
        3,
      ),
    ).toEqual([0, 0, 3]);
  });

  it('holds its invariants on many shapes: total, caps, and within one of the exact share', () => {
    const rnd = seededRandom(1234);
    for (let run = 0; run < 300; run += 1) {
      const items = Array.from({ length: 1 + Math.floor(rnd() * 8) }, () => ({
        weight: 1 + Math.floor(rnd() * 9),
        cap: Math.floor(rnd() * 12),
      }));
      const total = Math.floor(rnd() * 60);
      const out = allocateByWeight(items, total);
      const cap = items.reduce((s, i) => s + i.cap, 0);
      expect(out.reduce((s, n) => s + n, 0)).toBe(Math.min(total, cap));
      out.forEach((n, i) => {
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThanOrEqual((items[i] as { cap: number }).cap);
      });
      if (items.every((i) => i.cap >= total)) {
        const sum = items.reduce((s, i) => s + i.weight, 0);
        out.forEach((n, i) => {
          const exact = (total * (items[i] as { weight: number }).weight) / sum;
          expect(Math.abs(n - exact)).toBeLessThan(1);
        });
      }
    }
  });
});

describe('which cards a topic holds', () => {
  it('counts each card once per topic, with its subtopics, exactly as coverage does', () => {
    const { cards, syllabus } = vault({
      1: inBank('b1'),
      2: { bankIds: ['b1'], tagIds: ['t1'] }, // reaches A1 and A2: still one card in A
      3: inTag('t1'),
      4: inBank('b2'),
      5: inBank('nothing'),
    });
    const c = syllabusExamCounts(syllabus, cards);
    expect(c.total).toBe(4);
    expect(Object.fromEntries(c.byTopic)).toEqual({ A: 3, A1: 2, A2: 2, B: 1, C: 0 });
  });

  it('never asks a card it was not given, and a card without a filing belongs nowhere', () => {
    const { syllabus } = vault({ 1: inBank('b1'), 2: inBank('b1') });
    const pool = syllabusExamPool({
      syllabus,
      topicId: null,
      weighted: false,
      cards: [facts(1), facts(3)], // 2 is suspended (not given); 3 has no filing
      seed: 1,
    });
    expect(pool.cards.map((c) => c.facts.cardId)).toEqual([cardId(1)]);
  });

  it('a topic is its whole subtree; the whole syllabus is every topic; a card is in a pool once', () => {
    const { cards, syllabus } = big();
    const pool = (topicId: string | null) =>
      syllabusExamPool({ syllabus, topicId, weighted: false, cards, seed: 1 });
    expect(pool('A').inScope).toBe(20);
    expect(pool('A1').inScope).toBe(10);
    expect(pool('B').inScope).toBe(10);
    expect(pool('C').inScope).toBe(0);
    expect(pool(null).inScope).toBe(30);
    // Input order and duplicates make no difference.
    const shuffled = [...cards.slice(5), ...cards.slice(0, 5), facts(1)];
    expect(
      syllabusExamPool({ syllabus, topicId: 'A', weighted: false, cards: shuffled, seed: 1 }).cards,
    ).toEqual(pool('A').cards);
  });

  it('refuses a topic that is not in the syllabus', () => {
    const { cards, syllabus } = big();
    expect(() =>
      syllabusExamPool({ syllabus, topicId: 'gone', weighted: false, cards, seed: 1 }),
    ).toThrow(RangeError);
  });

  it('counts a card under one topic when it belongs to several, balancing between them', () => {
    // 1..4 are in both A1 and A2; 5 is only in A1.
    const { cards, syllabus } = vault({
      1: { bankIds: ['b1'], tagIds: ['t1'] },
      2: { bankIds: ['b1'], tagIds: ['t1'] },
      3: { bankIds: ['b1'], tagIds: ['t1'] },
      4: { bankIds: ['b1'], tagIds: ['t1'] },
      5: inBank('b1'),
    });
    const pool = syllabusExamPool({ syllabus, topicId: 'A', weighted: true, cards, seed: 9 });
    const by = Object.fromEntries(pool.units.map((u) => [u.id, u.available]));
    expect(by.A1! + by.A2!).toBe(5);
    expect(by.A2).toBeGreaterThan(0); // not starved by A1 although every card of A2 is also A1's
    expect(Math.abs(by.A1! - by.A2!)).toBeLessThanOrEqual(1);
    expect(pool.units.map((u) => u.reaching)).toEqual([5, 4]);
  });
});

describe('a weighted exam', () => {
  const draw = (count: number, seed = 1, topicId: string | null = null) => {
    const { cards, syllabus } = big();
    const pool = syllabusExamPool({ syllabus, topicId, weighted: true, cards, seed });
    return { pool, draw: drawSyllabusExam(pool, count) };
  };
  const asked = (d: ReturnType<typeof draw>['draw']) =>
    Object.fromEntries(d.rows.map((r) => [r.topicId, r.asked]));

  it('shares the questions by weight, with the remainder to the largest, among topics with cards', () => {
    const { pool, draw: d } = draw(10);
    // A1 0.4, A2 0.2, B 0.2 of 0.8 -> 5, 2.5, 2.5 -> 5, 3, 2 (the tie goes to the earlier topic).
    expect(asked(d)).toEqual({ A1: 5, A2: 3, B: 2, C: 0 });
    expect(d.picked).toHaveLength(10);
    expect(new Set(d.picked.map((p) => p.facts.cardId)).size).toBe(10);
    expect(pool.units.map((u) => [u.id, Math.round(u.share * 100)])).toEqual([
      ['A1', 50],
      ['A2', 25],
      ['B', 25],
      ['C', 0], // no cards: no share
    ]);
  });

  it('reports a topic with no cards instead of silently dropping its weight', () => {
    const { draw: d } = draw(10);
    expect(d.rows.map((r) => r.topicId)).toEqual(['A1', 'A2', 'B', 'C']);
    expect(d.skipped).toEqual([{ topicId: 'C', title: 'Topic C', reason: 'nocards' }]);
    expect(d.picked.every((p) => p.topicId !== 'C')).toBe(true);
  });

  it('a question belongs to the topic it was drawn for, and the card is of that topic', () => {
    const { syllabus } = big();
    const { draw: d } = draw(12);
    const refs = syllabus.refs;
    for (const p of d.picked) {
      const r = refs.get(p.facts.cardId) as ExamCardRefs;
      const where = {
        A1: r.bankIds.includes('b1'),
        A2: r.tagIds.includes('t1'),
        B: r.bankIds.includes('b2'),
      };
      expect(where[p.topicId as keyof typeof where], p.topicId).toBe(true);
    }
  });

  it('is deterministic with the seed, changes with it, and ignores the order of the cards', () => {
    const ids = (d: ReturnType<typeof draw>['draw']) => d.picked.map((p) => p.facts.cardId);
    expect(ids(draw(9, 5).draw)).toEqual(ids(draw(9, 5).draw));
    expect(ids(draw(9, 6).draw)).not.toEqual(ids(draw(9, 5).draw));
    const { cards, syllabus } = big();
    const reversed = syllabusExamPool({
      syllabus,
      topicId: null,
      weighted: true,
      cards: [...cards].reverse(),
      seed: 5,
    });
    expect(ids(drawSyllabusExam(reversed, 9))).toEqual(ids(draw(9, 5).draw));
  });

  it('asks everything there is when more is wanted, and never more than the pool', () => {
    const { pool, draw: d } = draw(500);
    expect(pool.drawable).toBe(30);
    expect(d.picked).toHaveLength(30);
    expect(asked(d)).toEqual({ A1: 10, A2: 10, B: 10, C: 0 });
  });

  it('a topic with cards but too small a share is reported, not hidden', () => {
    const { cards, syllabus } = vault({
      1: inBank('b1'),
      2: inBank('b1'),
      3: inBank('b1'),
      4: inBank('b2'),
    });
    const pool = syllabusExamPool({ syllabus, topicId: null, weighted: true, cards, seed: 1 });
    const d = drawSyllabusExam(pool, 1);
    // One question: A1 (share 2/3 of the topics that have cards) takes it; B gets none.
    expect(d.picked.map((p) => p.topicId)).toEqual(['A1']);
    expect(d.skipped).toContainEqual({ topicId: 'B', title: 'Topic B', reason: 'noshare' });
  });

  it('a topic whose every card is also in another is reported as shared', () => {
    const { cards, syllabus } = vault({ 1: { bankIds: ['b1'], tagIds: ['t1'] } });
    const pool = syllabusExamPool({ syllabus, topicId: 'A', weighted: false, cards, seed: 1 });
    const d = drawSyllabusExam(pool, 1);
    expect(d.picked).toHaveLength(1);
    const loser = d.skipped.find((s) => s.reason === 'shared');
    expect(loser?.topicId === 'A1' || loser?.topicId === 'A2').toBe(true);
  });

  it('cards only a parent’s own mapping reaches are counted under that parent and not drawn weighted', () => {
    const outline = [
      topic('P', { bankIds: ['bp'] }),
      topic('P1', { depth: 2, parentId: 'P', bankIds: ['b1'] }),
    ];
    const syllabus: ExamSyllabusInput = {
      topics: outline,
      refs: new Map([
        [cardId(1), inBank('bp')],
        [cardId(2), inBank('b1')],
      ]),
    };
    const cards = [facts(1), facts(2)];
    const plain = syllabusExamPool({ syllabus, topicId: null, weighted: false, cards, seed: 1 });
    expect(plain.inScope).toBe(2);
    expect(plain.cards.map((c) => [c.facts.cardId, c.topicId])).toEqual([
      [cardId(1), 'P'],
      [cardId(2), 'P1'],
    ]);
    const weighted = syllabusExamPool({ syllabus, topicId: null, weighted: true, cards, seed: 1 });
    expect(weighted.drawable).toBe(1);
    expect(weighted.inScope - weighted.drawable).toBe(1);
    expect(drawSyllabusExam(weighted, 5).picked.map((p) => p.facts.cardId)).toEqual([cardId(2)]);
  });

  it('draws unweighted exams from the seed alone, like every other scope', () => {
    const { cards, syllabus } = big();
    const pool = syllabusExamPool({ syllabus, topicId: 'A', weighted: false, cards, seed: 77 });
    const d = drawSyllabusExam(pool, 6);
    expect(d.picked).toHaveLength(6);
    expect(d.picked.every((p) => ['A1', 'A2'].includes(p.topicId))).toBe(true);
    expect(drawSyllabusExam(pool, 6)).toEqual(d);
  });
});

describe('createExam over a syllabus', () => {
  const config = (over: Partial<ExamConfig> = {}): ExamConfig => ({
    scope: { kind: 'syllabus', syllabusId: 'syllabus-0001', topicId: null, weighted: true },
    scopeLabel: syllabusScopeLabel('Boards', null, true),
    questions: 9,
    minutes: null,
    shuffle: false,
    ...over,
  });
  const make = (over: Partial<ExamConfig> = {}, seed = 3) => {
    const { cards, syllabus } = big();
    return createExam({
      id: 'exam-0001',
      now: Date.parse('2026-03-10T12:00:00.000Z'),
      random: () => seed / 2 ** 32,
      config: config(over),
      cards,
      syllabus,
    });
  };

  it('keeps the topic of each question, the titles as they were and what was left out', () => {
    const e = make();
    expect(e.version).toBe(2);
    expect(e.questions).toHaveLength(9);
    expect(e.questions.every((q) => q.topicId !== null)).toBe(true);
    expect(e.syllabus?.topics.map((t) => t.id)).toEqual(['A1', 'A2', 'B']);
    expect(e.syllabus?.skipped).toEqual([{ id: 'C', title: 'Topic C', reason: 'nocards' }]);
    expect(e.syllabus?.undrawn).toBe(0);
    expect(e.seed).toBe(3);
  });

  it('is the exam the form planned: the same seed gives the same questions', () => {
    expect(make({ seed: 99 }).questions.map((q) => q.cardId)).toEqual(
      make({ seed: 99 }).questions.map((q) => q.cardId),
    );
    expect(make({ seed: 99 }).seed).toBe(99);
    expect(make({ seed: 100 }).questions.map((q) => q.cardId)).not.toEqual(
      make({ seed: 99 }).questions.map((q) => q.cardId),
    );
  });

  it('needs the outline, a real topic and a card to ask', () => {
    const { cards } = big();
    const base = {
      id: 'exam-0001',
      now: 0,
      random: () => 0.5,
      cards,
    };
    expect(() => createExam({ ...base, config: config() })).toThrow(/could not be read/);
    expect(() =>
      make({
        scope: { kind: 'syllabus', syllabusId: 'syllabus-0001', topicId: 'C', weighted: false },
      }),
    ).toThrow(/no cards/);
    expect(() =>
      make({
        scope: { kind: 'syllabus', syllabusId: 'syllabus-0001', topicId: 'gone', weighted: false },
      }),
    ).toThrow(/not in this syllabus/);
  });

  it('labels the scope and stays within the stored limit', () => {
    expect(syllabusScopeLabel('Boards', 'Renal', false)).toBe('Syllabus: Boards / Renal');
    expect(syllabusScopeLabel('Boards', null, true)).toBe('Syllabus: Boards (weighted by topic)');
    expect(syllabusScopeLabel('x'.repeat(120), 'y'.repeat(200), true).length).toBeLessThanOrEqual(
      300,
    );
  });
});
