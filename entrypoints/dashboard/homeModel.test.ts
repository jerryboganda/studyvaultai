import { describe, expect, it } from 'vitest';
import type { AnalyticsInput } from '@storage';
import { bankStudyFrom, dayKeyDate, earnedBadges, greeting, nextBadge } from './homeModel';

const deck = (id: string, bankId: string | null, deletedAt: string | null = null) =>
  ({ id, bankId, deletedAt }) as AnalyticsInput['decks'][number];
const card = (id: string, deckId: string, deletedAt: string | null = null) =>
  ({ id, deckId, deletedAt, suspended: false }) as AnalyticsInput['cards'][number];
const log = (cardId: string, rating: 1 | 2 | 3 | 4, state = 'review', undone = false) =>
  ({
    cardId,
    rating,
    reviewedAt: '2026-10-01T10:00:00.000Z',
    durationMs: 1000,
    previousState: { state },
    ...(undone ? { userCorrection: { at: '2026-10-01T10:01:00.000Z' } } : {}),
  }) as unknown as AnalyticsInput['logs'][number];

describe('bankStudyFrom', () => {
  it('counts the cards of each bank and leaves out deleted cards and decks', () => {
    const study = bankStudyFrom({
      decks: [deck('d1', 'b1'), deck('d2', 'b2'), deck('d3', 'b3', '2026-01-01'), deck('d4', null)],
      cards: [card('c1', 'd1'), card('c2', 'd1'), card('c3', 'd1', 'x'), card('c4', 'd3')],
      logs: [],
    });
    expect(study).toEqual({ b1: { cards: 2, retention: null } });
  });

  it('measures retention of mature reviews only from five of them, never inventing a zero', () => {
    const cards = [card('c1', 'd1')];
    const decks = [deck('d1', 'b1')];
    const four = [log('c1', 3), log('c1', 3), log('c1', 1), log('c1', 4)];
    expect(bankStudyFrom({ decks, cards, logs: four }).b1!.retention).toBeNull();
    // Learning reviews and undone reviews do not count.
    const logs = [...four, log('c1', 3, 'learning'), log('c1', 3, 'review', true), log('c1', 2)];
    expect(bankStudyFrom({ decks, cards, logs }).b1!.retention).toBeCloseTo(4 / 5);
  });
});

describe('Home helpers', () => {
  it('greets by the time of day', () => {
    expect(greeting(6)).toBe('Good morning');
    expect(greeting(12)).toBe('Good afternoon');
    expect(greeting(18)).toBe('Good evening');
  });

  it('picks the locked badge closest to done and lists earned ones newest first', () => {
    const badges = [
      { id: 'first_save', unlockedDayKey: '2026-10-01', value: 1, target: 1 },
      { id: 'first_card', unlockedDayKey: '2026-10-03', value: 1, target: 1 },
      { id: 'cards_100', unlockedDayKey: null, value: 60, target: 100 },
      { id: 'bank_builder', unlockedDayKey: null, value: 90, target: 100 },
    ] as const;
    expect(nextBadge([...badges])?.id).toBe('bank_builder');
    expect(earnedBadges([...badges]).map((b) => b.id)).toEqual(['first_card', 'first_save']);
    expect(nextBadge(badges.slice(0, 2))).toBeNull();
  });

  it('reads a study day key as a local date', () => {
    const d = dayKeyDate('2026-03-09');
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2026, 2, 9]);
  });
});
