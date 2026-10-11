// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '@shared/constants';
import {
  Card,
  DEFAULT_DECK_SETTINGS,
  Deck,
  DeckSettings,
  FsrsState,
  KnowledgePoint,
  ReviewLog,
  STUDY_TABLE_SPECS,
} from './schema';
import { newFsrsState } from './scheduler';
import { T0, makeCard, makeDeck } from './testUtils';

const kp = {
  id: 'kp-00000001',
  schemaVersion: SCHEMA_VERSION,
  createdAt: T0,
  updatedAt: T0,
  deletedAt: null,
  highlightId: 'hl-00000001',
  primaryQuoteId: 'hl-00000001',
  shortOneLiner: 'Insulin lowers blood glucose',
  examPearl: null,
  misconception: null,
  verificationStatus: 'not_checked',
  claims: [],
  createdBy: 'user',
  acceptedAt: T0,
};

describe('DeckSettings', () => {
  it('accepts the defaults and rejects out-of-range values', () => {
    expect(DeckSettings.safeParse(DEFAULT_DECK_SETTINGS).success).toBe(true);
    const bad = (patch: Record<string, unknown>) =>
      DeckSettings.safeParse({ ...DEFAULT_DECK_SETTINGS, ...patch }).success;
    expect(bad({ targetRetention: 0.69 })).toBe(false);
    expect(bad({ targetRetention: 0.7 })).toBe(true);
    expect(bad({ targetRetention: 0.99 })).toBe(true);
    expect(bad({ targetRetention: 1 })).toBe(false);
    expect(bad({ newPerDay: -1 })).toBe(false);
    expect(bad({ newPerDay: 1.5 })).toBe(false);
    expect(bad({ learningSteps: ['1m', '10m', '1d'] })).toBe(true);
    expect(bad({ learningSteps: ['1.5m'] })).toBe(false);
    expect(bad({ learningSteps: ['10s'] })).toBe(false);
    expect(bad({ learningSteps: [] })).toBe(true);
    expect(bad({ maxIntervalDays: 0 })).toBe(false);
    expect(bad({ leechThreshold: 0 })).toBe(false);
    expect(bad({ enableFuzz: 'yes' })).toBe(false);
  });

  it('defaults are the ones the product documents', () => {
    expect(DEFAULT_DECK_SETTINGS).toEqual({
      newPerDay: 20,
      reviewsPerDay: 200,
      targetRetention: 0.9,
      learningSteps: ['1m', '10m'],
      relearnSteps: ['10m'],
      maxIntervalDays: 36500,
      enableFuzz: true,
      leechThreshold: 8,
    });
  });
});

describe('Deck', () => {
  it('validates and trims the name', () => {
    const parsed = Deck.parse({ ...makeDeck(), name: '  Cardiology  ' });
    expect(parsed.name).toBe('Cardiology');
    expect(Deck.safeParse({ ...makeDeck(), name: '   ' }).success).toBe(false);
    expect(Deck.safeParse({ ...makeDeck(), bankId: null }).success).toBe(true);
  });
});

describe('KnowledgePoint', () => {
  it('parses a user point and an unaccepted AI suggestion', () => {
    expect(KnowledgePoint.safeParse(kp).success).toBe(true);
    expect(
      KnowledgePoint.safeParse({ ...kp, createdBy: 'ai', acceptedAt: null, id: 'kp-00000002' })
        .success,
    ).toBe(true);
  });

  it('refuses "source_supported" without a claim linked to evidence', () => {
    const supported = { ...kp, verificationStatus: 'source_supported' };
    expect(KnowledgePoint.safeParse(supported).success).toBe(false);
    expect(
      KnowledgePoint.safeParse({
        ...supported,
        claims: [
          { text: 'Insulin lowers glucose', evidenceHighlightIds: [], reliability: 'unrated' },
        ],
      }).success,
    ).toBe(false);
    expect(
      KnowledgePoint.safeParse({
        ...supported,
        claims: [
          {
            text: 'Insulin lowers glucose',
            evidenceHighlightIds: ['hl-00000009'],
            reliability: 'high',
          },
        ],
      }).success,
    ).toBe(true);
    expect(KnowledgePoint.safeParse({ ...kp, verificationStatus: 'proven' }).success).toBe(false);
  });
});

describe('FsrsState and Card', () => {
  it('JSON round trip is lossless, including awkward floating point values', () => {
    const state = {
      ...newFsrsState(T0),
      state: 'review' as const,
      stability: 162.999815 + 0.1 + 0.2, // not exactly representable in decimal
      difficulty: 2.090586 * 1.0000001,
      reps: 5,
      scheduledDays: 163,
      lastReview: '2026-03-05T09:10:00.000Z',
      due: '2026-08-15T09:10:00.000Z',
    };
    const restored = FsrsState.parse(JSON.parse(JSON.stringify(state)));
    expect(restored).toEqual(state);
    expect(Object.is(restored.stability, state.stability)).toBe(true);
  });

  it('rejects a studied card without memory state and non-UTC timestamps', () => {
    expect(
      FsrsState.safeParse({ ...newFsrsState(T0), state: 'review', stability: 0, difficulty: 0 })
        .success,
    ).toBe(false);
    const card = makeCard('card-0000001');
    expect(Card.safeParse(card).success).toBe(true);
    expect(Card.safeParse({ ...card, createdAt: '2026-01-05T11:00:00+02:00' }).success).toBe(false);
    expect(Card.safeParse({ ...card, createdAt: '2026-01-05' }).success).toBe(false);
  });

  it('keeps dueAt and fsrs.due in agreement', () => {
    const card = makeCard('card-0000001');
    expect(Card.safeParse({ ...card, dueAt: '2026-02-01T00:00:00.000Z' }).success).toBe(false);
    // The same instant written differently is still the same due date.
    expect(Card.safeParse({ ...card, dueAt: '2026-01-05T09:00:00Z' }).success).toBe(true);
  });

  it('fills defaults for fields added after the first stored rows', () => {
    const { buriedUntil, sourceQuote, needsHumanVerification, ...legacy } =
      makeCard('card-0000001');
    void buriedUntil;
    void sourceQuote;
    void needsHumanVerification;
    const parsed = Card.parse(legacy);
    expect(parsed).toMatchObject({
      buriedUntil: null,
      sourceQuote: null,
      needsHumanVerification: false,
    });
  });
});

describe('ReviewLog', () => {
  const base = {
    id: 'log-0000001',
    schemaVersion: SCHEMA_VERSION,
    cardId: 'card-0000001',
    reviewedAt: T0,
    rating: 3,
    durationMs: 1200,
    sessionId: 'session-0001',
    previousState: newFsrsState(T0),
    nextState: { ...newFsrsState(T0), state: 'learning', stability: 2.3, difficulty: 2.1, reps: 1 },
    algorithmVersion: 'sv1|ts-fsrs v5.4.2 using FSRS-6.0',
    scheduledDays: 0,
    elapsedDays: 0,
  };

  it('parses with leech defaulting to false and only ratings 1-4', () => {
    expect(ReviewLog.parse(base).leech).toBe(false);
    expect(ReviewLog.safeParse({ ...base, rating: 0 }).success).toBe(false);
    expect(ReviewLog.safeParse({ ...base, rating: 5 }).success).toBe(false);
    expect(ReviewLog.safeParse({ ...base, durationMs: -1 }).success).toBe(false);
  });

  it('allows the single amendment kind, "undone"', () => {
    expect(
      ReviewLog.safeParse({ ...base, userCorrection: { kind: 'undone', at: T0 } }).success,
    ).toBe(true);
    expect(
      ReviewLog.safeParse({ ...base, userCorrection: { kind: 'edited', at: T0 } }).success,
    ).toBe(false);
  });
});

describe('table registry contract', () => {
  it('describes decks, knowledgePoints, cards and reviewLogs, and their schemas accept real rows', () => {
    expect(STUDY_TABLE_SPECS.map((t) => t.name)).toEqual([
      'decks',
      'knowledgePoints',
      'cards',
      'reviewLogs',
    ]);
    const rows: Record<string, unknown> = {
      decks: makeDeck(),
      knowledgePoints: kp,
      cards: makeCard('card-0000001'),
      reviewLogs: {
        id: 'log-0000001',
        schemaVersion: SCHEMA_VERSION,
        cardId: 'card-0000001',
        reviewedAt: T0,
        rating: 3,
        durationMs: 0,
        sessionId: 'session-0001',
        previousState: newFsrsState(T0),
        nextState: newFsrsState(T0),
        algorithmVersion: 'sv1',
        scheduledDays: 0,
        elapsedDays: 0,
      },
    };
    for (const spec of STUDY_TABLE_SPECS) {
      expect(spec.schema.safeParse(rows[spec.name]).success).toBe(true);
      expect(spec.primaryKey).toBe('id');
    }
    const cards = STUDY_TABLE_SPECS.find((t) => t.name === 'cards');
    expect(cards?.references?.map((r) => r.table)).toEqual([
      'decks',
      'knowledgePoints',
      'highlights',
    ]);
    expect(STUDY_TABLE_SPECS.find((t) => t.name === 'reviewLogs')?.softDelete).toBe(false);
  });
});
