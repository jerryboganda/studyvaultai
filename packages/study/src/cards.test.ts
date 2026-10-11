// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  buildBasic,
  buildCloze,
  buildCompare,
  buildDefinition,
  buildMcq,
  cardSourceLink,
  clozeSegments,
  createCard,
  draftFromKnowledgePoint,
  gradeMcq,
  mcqIssues,
  mcqSuggestedRating,
  orderChoices,
} from './cards';
import type { Built, CardDraft } from './cards';
import { seededRandom } from './random';
import { Card as CardSchema } from './schema';
import { T0 } from './testUtils';

const source = {
  highlightId: 'hl-00000001',
  quote: 'The mitochondria is the powerhouse of the cell.',
};

function ok<T>(built: Built<T>): T {
  if (!built.ok) throw new Error(`expected ok, got: ${built.issues.join('; ')}`);
  return built.value;
}
const issues = <T>(built: Built<T>): string[] => (built.ok ? [] : built.issues);

describe('source link', () => {
  it('every template carries highlightId and the literal quote', () => {
    const drafts: CardDraft[] = [
      ok(buildBasic({ question: 'What?', answer: 'This.', source })),
      ok(buildDefinition({ term: 'Mitochondria', definition: 'Organelle.', source })),
      ok(
        buildCompare({
          left: 'Mitosis',
          right: 'Meiosis',
          rows: [{ aspect: 'Daughter cells', left: '2', right: '4' }],
          source,
        }),
      ),
      ...ok(buildCloze({ markup: 'The {{c1::mitochondria}} is the powerhouse.', source })),
      ok(
        buildMcq({
          stem: 'Powerhouse?',
          choices: ['Nucleus', 'Mitochondria', 'Ribosome'],
          correctIndex: 1,
          random: seededRandom(1),
          source,
        }),
      ),
    ];
    expect(drafts).toHaveLength(5);
    for (const d of drafts) {
      expect(d.highlightId).toBe('hl-00000001');
      expect(d.sourceQuote).toBe(source.quote);
    }
    const card = createCard(
      drafts[0] as CardDraft,
      { id: 'card-0000001', deckId: 'deck-0001' },
      T0,
    );
    expect(cardSourceLink(card)).toEqual({
      highlightId: 'hl-00000001',
      quote: source.quote,
      knowledgePointId: null,
    });
  });

  it('refuses a highlight link without its quote, accepts a free-standing card', () => {
    const bad = buildBasic({
      question: 'Q',
      answer: 'A',
      source: { highlightId: 'hl-00000001', quote: ' ' },
    });
    expect(issues(bad).join(' ')).toMatch(/must keep the highlight quote/);
    const free = ok(
      buildBasic({ question: 'Q', answer: 'A', source: { highlightId: null, quote: null } }),
    );
    expect(
      cardSourceLink(createCard(free, { id: 'card-0000002', deckId: 'deck-0001' }, T0)),
    ).toBeNull();
  });
});

describe('basic, definition, compare', () => {
  it('basic: trims, keeps explanation and normalised tags', () => {
    const d = ok(
      buildBasic({
        question: '  Which organelle makes ATP?  ',
        answer: 'Mitochondria',
        explanation: 'Oxidative phosphorylation.',
        tags: ['Cell biology', 'cell biology', ' ', 'exam'],
        source,
      }),
    );
    expect(d).toMatchObject({
      cardType: 'basic',
      front: 'Which organelle makes ATP?',
      explanation: 'Oxidative phosphorylation.',
      tags: ['Cell biology', 'exam'],
      createdBy: 'user',
      needsHumanVerification: false,
    });
  });

  it('rejects blank sides with readable issues', () => {
    expect(
      issues(buildBasic({ question: ' ', answer: '', source: { highlightId: null, quote: null } })),
    ).toEqual(['The front of the card is empty.', 'The back of the card is empty.']);
  });

  it('definition builds a "Define:" prompt', () => {
    const d = ok(
      buildDefinition({ term: ' Apoptosis ', definition: 'Programmed cell death.', source }),
    );
    expect(d).toMatchObject({ cardType: 'definition', front: 'Define: Apoptosis' });
    expect(issues(buildDefinition({ term: ' ', definition: 'x', source }))).toContain(
      'The term is empty.',
    );
  });

  it('compare lays the aspects out as plain text and validates the inputs', () => {
    const d = ok(
      buildCompare({
        left: 'Crohn disease',
        right: 'Ulcerative colitis',
        rows: [
          { aspect: 'Depth', left: 'Transmural', right: 'Mucosal' },
          { aspect: 'Rectum', left: 'Often spared', right: 'Always involved' },
        ],
        source,
      }),
    );
    expect(d.front).toBe('Differentiate: Crohn disease vs Ulcerative colitis');
    expect(d.back).toBe(
      [
        'Depth\n  Crohn disease: Transmural\n  Ulcerative colitis: Mucosal',
        'Rectum\n  Crohn disease: Often spared\n  Ulcerative colitis: Always involved',
      ].join('\n\n'),
    );
    expect(issues(buildCompare({ left: 'A', right: ' a ', rows: [], source }))).toEqual(
      expect.arrayContaining(['The two items must differ.', 'Add between 1 and 20 aspects.']),
    );
  });
});

describe('cloze cards', () => {
  const markup = 'The {{c1::heart::organ}} pumps {{c2::blood}} through {{c1::vessels}}.';

  it('creates one card per deletion index with the others as context', () => {
    const drafts = ok(buildCloze({ markup, source }));
    expect(drafts).toHaveLength(2);
    expect(drafts.map((d) => d.cloze?.activeIndex)).toEqual([1, 2]);
    expect(drafts[0]?.front).toBe('The [organ] pumps blood through [...].');
    expect(drafts[0]?.back).toBe('The heart pumps blood through vessels.');
    expect(drafts[1]?.front).toBe('The heart pumps [...] through vessels.');
    expect(drafts[0]?.cloze?.text).toBe(markup);
    expect(drafts[0]?.cloze?.deletions).toHaveLength(3);
  });

  it('perDeletion: false hides everything on one card', () => {
    const drafts = ok(buildCloze({ markup, source, perDeletion: false }));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.cloze?.activeIndex).toBeNull();
    expect(drafts[0]?.front).toBe('The [organ] pumps [...] through [...].');
  });

  it('rejects text without a valid deletion', () => {
    expect(issues(buildCloze({ markup: 'No gaps here', source }))[0]).toMatch(
      /at least one deletion/,
    );
    expect(issues(buildCloze({ markup: '{{c1::unclosed', source }))).toHaveLength(1);
  });

  it('exposes segments for rendering and survives Card validation', () => {
    const [first] = ok(buildCloze({ markup, source }));
    const card = createCard(first as CardDraft, { id: 'card-0000003', deckId: 'deck-0001' }, T0);
    const q = clozeSegments(card, false);
    expect(q.some((s) => s.kind === 'blank')).toBe(true);
    expect(clozeSegments(card, true).some((s) => s.kind === 'answer')).toBe(true);
    expect(CardSchema.safeParse(card).success).toBe(true);
  });

  it('a cloze whose data disagrees with its markup fails card validation', () => {
    const [first] = ok(buildCloze({ markup, source }));
    const card = createCard(first as CardDraft, { id: 'card-0000003', deckId: 'deck-0001' }, T0);
    const broken = { ...card, cloze: { ...card.cloze!, text: 'no markup left' } };
    expect(CardSchema.safeParse(broken).success).toBe(false);
    expect(CardSchema.safeParse({ ...card, cloze: null }).success).toBe(false);
  });
});

describe('multiple choice', () => {
  const base = {
    stem: 'Which organelle produces most ATP?',
    choices: ['Nucleus', 'Mitochondria', 'Golgi apparatus', 'Ribosome'],
    correctIndex: 1,
    source,
  };

  it('keeps the key on the right text after shuffling, for any seed', () => {
    const orders = new Set<string>();
    for (let seed = 1; seed <= 40; seed += 1) {
      const d = ok(buildMcq({ ...base, random: seededRandom(seed) }));
      const key = d.choices?.find((c) => c.id === d.answerChoiceId);
      expect(key?.text).toBe('Mitochondria');
      expect(d.back).toBe('Mitochondria');
      expect(d.choices?.map((c) => c.text).sort()).toEqual([...base.choices].sort());
      orders.add(d.choices?.map((c) => c.text).join('|') as string);
    }
    expect(orders.size).toBeGreaterThan(5);
  });

  it('is reproducible with the same seed and honours shuffle: false', () => {
    const a = ok(buildMcq({ ...base, random: seededRandom(5) }));
    const b = ok(buildMcq({ ...base, random: seededRandom(5) }));
    expect(a.choices).toEqual(b.choices);
    const fixed = ok(buildMcq({ ...base, random: seededRandom(5), shuffle: false }));
    expect(fixed.choices?.map((c) => c.text)).toEqual(base.choices);
    expect(fixed.answerChoiceId).toBe('ch2');
  });

  it('keeps positional choices ("All of the above") last', () => {
    const d = ok(
      buildMcq({
        stem: 'Which are risk factors?',
        choices: ['Smoking', 'Obesity', 'Age', 'All of the above'],
        correctIndex: 3,
        random: seededRandom(11),
        source,
      }),
    );
    expect(d.choices?.at(-1)?.text).toBe('All of the above');
    expect(d.choices?.find((c) => c.id === d.answerChoiceId)?.text).toBe('All of the above');
    expect(
      orderChoices(
        [{ text: 'None of the above' }, { text: 'x' }, { text: 'y' }],
        seededRandom(2),
      ).at(-1)?.text,
    ).toBe('None of the above');
  });

  it('validates the key and the choice list', () => {
    expect(
      issues(buildMcq({ ...base, correctIndex: 9, random: seededRandom(1) })).join(' '),
    ).toMatch(/Mark which choice is correct/);
    expect(
      issues(
        buildMcq({ ...base, choices: ['Only one'], correctIndex: 0, random: seededRandom(1) }),
      ).join(' '),
    ).toMatch(/at least 2 choices/);
    expect(
      issues(
        buildMcq({
          ...base,
          choices: ['Same', ' same ', 'Other'],
          correctIndex: 0,
          random: seededRandom(1),
        }),
      ).join(' '),
    ).toMatch(/different from each other/);
    expect(
      issues(
        buildMcq({ ...base, choices: ['A', ' ', 'C'], correctIndex: 0, random: seededRandom(1) }),
      ).join(' '),
    ).toMatch(/Every choice needs text/);
    expect(
      mcqIssues(
        [
          { id: 'ch1', text: 'A' },
          { id: 'ch2', text: 'B' },
        ],
        'ch9',
      ),
    ).toContain('The answer key does not point at one of the choices.');
  });

  it('flags AI-made cards for human verification and keeps the AI link', () => {
    const d = ok(
      buildMcq({ ...base, random: seededRandom(3), createdBy: 'ai', aiResultId: 'ai-result-0001' }),
    );
    expect(d).toMatchObject({
      createdBy: 'ai',
      aiResultId: 'ai-result-0001',
      needsHumanVerification: true,
    });
    const human = ok(buildMcq({ ...base, random: seededRandom(3), requireVerification: true }));
    expect(human.needsHumanVerification).toBe(true);
    expect(ok(buildMcq({ ...base, random: seededRandom(3) })).needsHumanVerification).toBe(false);
  });

  it('an incorrect key reference is rejected by the stored-card schema too', () => {
    const d = ok(buildMcq({ ...base, random: seededRandom(3) }));
    const card = createCard(d, { id: 'card-0000004', deckId: 'deck-0001' }, T0);
    expect(CardSchema.safeParse({ ...card, answerChoiceId: 'ch99' }).success).toBe(false);
    expect(CardSchema.safeParse({ ...card, choices: undefined }).success).toBe(false);
    expect(CardSchema.safeParse({ ...card, cardType: 'basic' }).success).toBe(false);
  });

  it('grades a chosen option and suggests a rating', () => {
    const d = ok(buildMcq({ ...base, random: seededRandom(3) }));
    const card = createCard(d, { id: 'card-0000004', deckId: 'deck-0001' }, T0);
    const right = gradeMcq(card, card.answerChoiceId as string);
    expect(right).toEqual({ correct: true, answerChoiceId: card.answerChoiceId });
    const wrongId = card.choices?.find((c) => c.id !== card.answerChoiceId)?.id as string;
    expect(gradeMcq(card, wrongId)?.correct).toBe(false);
    expect(gradeMcq(card, 'nope')).toBeNull();
    expect(mcqSuggestedRating(true)).toBe(3);
    expect(mcqSuggestedRating(false)).toBe(1);
  });
});

describe('knowledge point templates and card creation', () => {
  const kp = {
    id: 'kp-00000001',
    highlightId: 'hl-00000001',
    shortOneLiner: 'Mitochondria make most cellular ATP',
    examPearl: 'Maternal inheritance of mtDNA',
    misconception: 'Mitochondria only produce ATP',
    createdBy: 'user' as const,
  };

  it('builds recall cards from the point and links the source', () => {
    const pearl = ok(draftFromKnowledgePoint(kp, source.quote, 'pearl'));
    expect(pearl).toMatchObject({
      front: 'What is the exam pearl for: Mitochondria make most cellular ATP',
      back: 'Maternal inheritance of mtDNA',
      knowledgePointId: 'kp-00000001',
      highlightId: 'hl-00000001',
      sourceQuote: source.quote,
    });
    const mis = ok(draftFromKnowledgePoint(kp, source.quote, 'misconception'));
    expect(mis.back).toBe('Mitochondria make most cellular ATP');
    expect(mis.front).toContain('Common misconception: Mitochondria only produce ATP');
  });

  it('reports a missing field and carries AI provenance', () => {
    expect(
      issues(draftFromKnowledgePoint({ ...kp, examPearl: null }, source.quote, 'pearl'))[0],
    ).toMatch(/no exam pearl/);
    const ai = ok(draftFromKnowledgePoint({ ...kp, createdBy: 'ai' }, source.quote, 'pearl'));
    expect(ai.createdBy).toBe('ai');
    expect(ai.needsHumanVerification).toBe(true);
  });

  it('createCard starts a new card due now and validates ids', () => {
    const d = ok(buildBasic({ question: 'Q', answer: 'A', source }));
    const card = createCard(d, { id: 'card-0000005', deckId: 'deck-0001' }, T0);
    expect(card).toMatchObject({
      suspended: false,
      buriedUntil: null,
      dueAt: T0,
      createdAt: T0,
      deletedAt: null,
      fsrs: { state: 'new', reps: 0, lapses: 0, due: T0, lastReview: null },
    });
    expect(() => createCard(d, { id: 'x', deckId: 'deck-0001' }, T0)).toThrow();
  });
});
