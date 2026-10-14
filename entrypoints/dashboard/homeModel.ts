import type { AnalyticsInput, AnalyticsLog } from '@storage';
import { BADGES, MIN_TOPIC_RETENTION_REVIEWS, trueRetention, type BadgeId } from '@study';

/** Pure helpers of the dashboard Home (no I/O, no React). */

export interface BankStudy {
  /** Cards (not deleted) in the bank's decks. */
  cards: number;
  /** Measured retention of mature reviews (0..1); null below MIN_TOPIC_RETENTION_REVIEWS reviews. */
  retention: number | null;
}

/** Cards and retention per bank id (ADR-020's measure: mature reviews, a value only from 5). */
export function bankStudyFrom(
  input: Pick<AnalyticsInput, 'decks' | 'cards' | 'logs'>,
): Record<string, BankStudy> {
  const bankOfDeck = new Map(
    input.decks.filter((d) => !d.deletedAt && d.bankId).map((d) => [d.id, d.bankId!]),
  );
  const bankOfCard = new Map<string, string>();
  const cards = new Map<string, number>();
  for (const c of input.cards) {
    const bank = bankOfDeck.get(c.deckId);
    if (!bank || c.deletedAt) continue;
    bankOfCard.set(c.id, bank);
    cards.set(bank, (cards.get(bank) ?? 0) + 1);
  }
  const logs = new Map<string, AnalyticsLog[]>();
  for (const l of input.logs) {
    const bank = bankOfCard.get(l.cardId);
    if (!bank) continue;
    const list = logs.get(bank);
    if (list) list.push(l);
    else logs.set(bank, [l]);
  }
  return Object.fromEntries(
    [...cards].map(([bank, n]) => [
      bank,
      {
        cards: n,
        retention: trueRetention(logs.get(bank) ?? [], { minSamples: MIN_TOPIC_RETENTION_REVIEWS })
          .trueRetention,
      },
    ]),
  );
}

/** "Good morning" before noon, "Good afternoon" before 18:00, else "Good evening". */
export function greeting(hour: number): string {
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}

/** What a locked badge asks for, in at most a few words. */
export const BADGE_HINT: Record<BadgeId, string> = {
  first_save: 'Save a highlight',
  first_card: 'Make a card',
  first_session: 'Finish a session',
  cards_100: 'Make 100 cards',
  bank_builder: 'Save 100 highlights',
  reviews_1000: 'Do 1,000 reviews',
  streak_7: 'Keep a 7-day streak',
  streak_30: 'Keep a 30-day streak',
  goal_getter: 'Meet your goal 10 times',
  night_owl: 'Review after 11 pm 25 times',
  level_10: 'Reach level 10',
};

export const badgeName = (id: BadgeId): string => BADGES.find((b) => b.id === id)?.name ?? id;

export interface BadgeView {
  id: BadgeId;
  unlockedDayKey: string | null;
  value: number;
  target: number;
}

/** The locked badge closest to done (by share of its target); null when every badge is earned. */
export function nextBadge(badges: readonly BadgeView[]): BadgeView | null {
  let best: BadgeView | null = null;
  for (const b of badges) {
    if (b.unlockedDayKey !== null) continue;
    if (!best || b.value / b.target > best.value / best.target) best = b;
  }
  return best;
}

/** Earned badges, most recent first. */
export const earnedBadges = (badges: readonly BadgeView[]): BadgeView[] =>
  badges
    .filter((b) => b.unlockedDayKey !== null)
    .sort((a, b) => (a.unlockedDayKey! < b.unlockedDayKey! ? 1 : -1));

/** A study day key ("2026-10-14") as a local calendar date, for the heatmap's labels. */
export function dayKeyDate(dayKey: string): Date {
  const [y, m, d] = dayKey.split('-').map(Number);
  return new Date(y!, (m ?? 1) - 1, d ?? 1);
}
