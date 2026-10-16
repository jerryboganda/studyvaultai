import {
  BADGES,
  XP,
  backlog,
  countsByBank,
  countsByDeck,
  dueForecast,
  estimatedRetention,
  formatInterval,
  hashSeed,
  seededRandom,
  streak,
  studyLog,
  trueRetention,
  type BacklogStats,
  type BankCounts,
  type Card,
  type Celebration,
  type DeckCounts,
  type DeckSettings,
  type DueForecast,
  type Rating,
  type RetentionReport,
  type ReviewLog,
  type StreakReport,
  type StudyDay,
} from '@study';
import type { AnalyticsInput } from '@storage';
import { plural } from '../text';

/** Pure view-model helpers of the review surfaces: no React, no storage, no clock reads. */

// ---------------------------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------------------------

export type KeyAction =
  | { type: 'reveal' }
  | { type: 'rate'; rating: Rating }
  | { type: 'choose'; index: number }
  | { type: 'undo' }
  | { type: 'edit' }
  | { type: 'suspend' }
  | { type: 'bury' }
  | { type: 'source' }
  | { type: 'explain' };

export interface KeyContext {
  phase: 'question' | 'answer' | 'waiting' | 'done' | 'loading' | 'idle' | 'error';
  /** The card on screen is multiple choice and still unanswered. */
  choosing: boolean;
  /** The card editor is open: letters belong to the editor. */
  editing: boolean;
  canUndo: boolean;
  /** Number of options of the multiple-choice card on screen. */
  choiceCount: number;
}

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

/**
 * Keys of the session. Space/Enter show the answer; 1-4 grade it (and pick an option of a
 * multiple-choice card before that); Z undoes the last answer; E, S, B, J, X are edit, suspend,
 * bury, jump to source and explain. Nothing fires while a text field has focus or a modifier is held.
 */
export function keyAction(e: KeyLike, targetIsField: boolean, ctx: KeyContext): KeyAction | null {
  if (targetIsField || e.ctrlKey || e.metaKey || e.altKey || ctx.editing) return null;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (key === 'z') return ctx.canUndo && ctx.phase !== 'loading' ? { type: 'undo' } : null;
  if (ctx.phase !== 'question' && ctx.phase !== 'answer') return null;
  if (ctx.phase === 'question' && (key === ' ' || key === 'Enter')) return { type: 'reveal' };
  if (key >= '1' && key <= '9') {
    const n = Number(key);
    if (ctx.phase === 'question' && ctx.choosing) {
      return n <= ctx.choiceCount ? { type: 'choose', index: n - 1 } : null;
    }
    if (ctx.phase === 'answer' && n <= 4) return { type: 'rate', rating: n as Rating };
    return null;
  }
  switch (key) {
    case 'e':
      return { type: 'edit' };
    case 's':
      return { type: 'suspend' };
    case 'b':
      return { type: 'bury' };
    case 'j':
      return { type: 'source' };
    case 'x':
      return ctx.phase === 'answer' ? { type: 'explain' } : null;
    default:
      return null;
  }
}

/** True for elements that take typed text (and so own the letter keys). */
export function isFieldTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true
  );
}

// ---------------------------------------------------------------------------------------------
// Multiple choice display order
// ---------------------------------------------------------------------------------------------

// The seed hash lives in @study (the exam module needs it too); kept exported from here.
export { hashSeed };

/** Same card and same repetition always show the options in the same order (no reshuffle on render). */
export const choiceRandom = (card: Pick<Card, 'id' | 'fsrs'>): ReturnType<typeof seededRandom> =>
  seededRandom(hashSeed(`${card.id}:${card.fsrs.reps}:${card.fsrs.lapses}`));

// ---------------------------------------------------------------------------------------------
// Session summary (from the real review logs of one session)
// ---------------------------------------------------------------------------------------------

export interface SessionSummary {
  answered: number;
  byRating: Record<Rating, number>;
  /** Answers other than Again, or null before the first answer. */
  passRate: number | null;
  /** Time on cards, each answer capped at five minutes (a tab left open is not study time). */
  durationMs: number;
  newCards: number;
  /** Graduated cards that were forgotten (Again on a review card). */
  lapses: number;
  leeches: number;
}

const MAX_COUNTED_MS = 5 * 60_000;

export function summarizeSession(
  logs: readonly Pick<
    ReviewLog,
    'sessionId' | 'rating' | 'durationMs' | 'previousState' | 'leech' | 'userCorrection'
  >[],
  sessionId: string,
): SessionSummary {
  const byRating: Record<Rating, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  let durationMs = 0;
  let newCards = 0;
  let lapses = 0;
  let leeches = 0;
  let answered = 0;
  for (const l of logs) {
    if (l.sessionId !== sessionId || l.userCorrection) continue;
    answered += 1;
    byRating[l.rating] += 1;
    durationMs += Math.min(MAX_COUNTED_MS, l.durationMs);
    if (l.previousState.state === 'new') newCards += 1;
    if (l.rating === 1 && l.previousState.state === 'review') lapses += 1;
    if (l.leech) leeches += 1;
  }
  return {
    answered,
    byRating,
    passRate: answered === 0 ? null : (answered - byRating[1]) / answered,
    durationMs,
    newCards,
    lapses,
    leeches,
  };
}

/**
 * The done screen's "what is left" line. "Now" is counted like the page header's "25 due now" (the
 * queue: new cards and daily limits included), so the two always agree; `reviewsTomorrow` is the
 * forecast's reviews and learning steps due tomorrow (new cards are not scheduled ahead).
 */
export function leftAfterSession(
  dueNow: { total: number; new: number },
  reviewsTomorrow: number,
): string {
  const now =
    dueNow.total === 0
      ? 'Nothing is due right now'
      : `${plural(dueNow.total, 'card')} still due now${dueNow.new > 0 ? ` (${dueNow.new} new)` : ''}`;
  return `${now}, ${plural(reviewsTomorrow, 'review')} due tomorrow.`;
}

/** "3 min", "45 s", "1 h 05 min". */
export function formatDuration(ms: number): string {
  const s = Math.round(Math.max(0, ms) / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

// ---------------------------------------------------------------------------------------------
// Game layer (ADR-022): what the review page says about XP and celebrations
// ---------------------------------------------------------------------------------------------

/**
 * XP a finished session earned: one per counted answer (undone answers are not in the summary) and
 * the session bonus, which `already` means was recorded earlier for this same session.
 */
export function sessionXp(
  answered: number,
  bonus: 'awarded' | 'already' | 'no_answers' | null,
): number {
  const bonusXp = answered > 0 && (bonus === 'awarded' || bonus === 'already') ? XP.session : 0;
  return answered * XP.review + bonusXp;
}

/** Title (no exclamation mark: the done screen already has one) and one line for a celebration. */
export function celebrationText(c: Celebration): { title: string; line: string } {
  switch (c.kind) {
    case 'goal':
      return { title: 'Daily goal met', line: `${c.xp} of ${c.goal} XP today` };
    case 'level':
      return { title: `Level ${c.level}`, line: 'You reached a new level' };
    case 'badge':
      return {
        title: 'Badge earned',
        line: BADGES.find((b) => b.id === c.badgeId)?.name ?? c.badgeId,
      };
    case 'streak':
      return { title: `${c.days}-day streak`, line: `Daily goal met ${c.days} days running` };
  }
}

/** "in 7m", "in 3h", "in 4d": time until an instant, with the labels the answer buttons use. */
export const untilLabel = (iso: string, nowMs: number): string =>
  `in ${formatInterval(Math.max(0, Date.parse(iso) - nowMs))}`;

/** Wall-clock time of an instant in the study time zone: "Tue 14 Oct, 09:30". */
export function formatWhen(iso: string, timeZone: string, locale?: string): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/** A study-day key ("2026-03-02") as "Mon 2 Mar" (the key is already a local calendar date). */
export function formatDayKey(dayKey: string, locale?: string): string {
  const d = new Date(`${dayKey}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return dayKey;
  return new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(d);
}

// ---------------------------------------------------------------------------------------------
// Deck settings form
// ---------------------------------------------------------------------------------------------

export interface DeckSettingsDraft {
  targetRetentionPct: string;
  newPerDay: string;
  reviewsPerDay: string;
  learningSteps: string;
  relearnSteps: string;
  maxIntervalDays: string;
  enableFuzz: boolean;
  leechThreshold: string;
}
export type DeckSettingsErrors = Partial<Record<keyof DeckSettingsDraft, string>>;

export const toDraft = (s: DeckSettings): DeckSettingsDraft => ({
  targetRetentionPct: String(Math.round(s.targetRetention * 1000) / 10),
  newPerDay: String(s.newPerDay),
  reviewsPerDay: String(s.reviewsPerDay),
  learningSteps: s.learningSteps.join(' '),
  relearnSteps: s.relearnSteps.join(' '),
  maxIntervalDays: String(s.maxIntervalDays),
  enableFuzz: s.enableFuzz,
  leechThreshold: String(s.leechThreshold),
});

const STEP = /^[1-9]\d{0,4}[mhd]$/;

function intField(
  text: string,
  min: number,
  max: number,
  what: string,
): { ok: true; value: number } | { ok: false; error: string } {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return { ok: false, error: `${what} must be a whole number.` };
  const n = Number(t);
  if (n < min || n > max) return { ok: false, error: `${what} must be between ${min} and ${max}.` };
  return { ok: true, value: n };
}

function stepsField(
  text: string,
  what: string,
): { ok: true; value: string[] } | { ok: false; error: string } {
  const parts = text.split(/[\s,]+/).filter((p) => p !== '');
  if (parts.length > 8) return { ok: false, error: `${what}: use at most 8 steps.` };
  const bad = parts.find((p) => !STEP.test(p));
  if (bad) {
    return {
      ok: false,
      error: `"${bad}" is not a step. Write whole numbers with m, h or d: 1m 10m 1h 1d.`,
    };
  }
  return { ok: true, value: parts };
}

export function parseDraft(
  d: DeckSettingsDraft,
): { ok: true; value: DeckSettings } | { ok: false; errors: DeckSettingsErrors } {
  const errors: DeckSettingsErrors = {};
  const retention = Number(d.targetRetentionPct.trim());
  let targetRetention = 0.9;
  if (d.targetRetentionPct.trim() === '' || !Number.isFinite(retention)) {
    errors.targetRetentionPct = 'Enter a percentage between 70 and 99.';
  } else if (retention < 70 || retention > 99) {
    errors.targetRetentionPct = 'Target retention must be between 70% and 99%.';
  } else {
    targetRetention = Math.round(retention * 10) / 1000;
  }
  const newPerDay = intField(d.newPerDay, 0, 9999, 'New cards per day');
  const reviewsPerDay = intField(d.reviewsPerDay, 0, 9999, 'Reviews per day');
  const maxInterval = intField(d.maxIntervalDays, 1, 36_500, 'Maximum interval');
  const leech = intField(d.leechThreshold, 1, 99, 'Leech threshold');
  const learning = stepsField(d.learningSteps, 'Learning steps');
  const relearn = stepsField(d.relearnSteps, 'Relearning steps');
  if (!newPerDay.ok) errors.newPerDay = newPerDay.error;
  if (!reviewsPerDay.ok) errors.reviewsPerDay = reviewsPerDay.error;
  if (!maxInterval.ok) errors.maxIntervalDays = maxInterval.error;
  if (!leech.ok) errors.leechThreshold = leech.error;
  if (!learning.ok) errors.learningSteps = learning.error;
  if (!relearn.ok) errors.relearnSteps = relearn.error;
  if (
    Object.keys(errors).length > 0 ||
    !newPerDay.ok ||
    !reviewsPerDay.ok ||
    !maxInterval.ok ||
    !leech.ok ||
    !learning.ok ||
    !relearn.ok
  ) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      targetRetention,
      newPerDay: newPerDay.value,
      reviewsPerDay: reviewsPerDay.value,
      learningSteps: learning.value,
      relearnSteps: relearn.value,
      maxIntervalDays: maxInterval.value,
      enableFuzz: d.enableFuzz,
      leechThreshold: leech.value,
    },
  };
}

/** Field by field (key order of the stored object is not significant). */
export const sameDeckSettings = (a: DeckSettings, b: DeckSettings): boolean =>
  a.targetRetention === b.targetRetention &&
  a.newPerDay === b.newPerDay &&
  a.reviewsPerDay === b.reviewsPerDay &&
  a.maxIntervalDays === b.maxIntervalDays &&
  a.enableFuzz === b.enableFuzz &&
  a.leechThreshold === b.leechThreshold &&
  a.learningSteps.join(' ') === b.learningSteps.join(' ') &&
  a.relearnSteps.join(' ') === b.relearnSteps.join(' ');

// ---------------------------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------------------------

export interface AnalyticsReport {
  hasCards: boolean;
  /** Review logs that count (undone ones excluded). */
  totalReviews: number;
  firstReviewAt: string | null;
  forecast: DueForecast;
  backlog: BacklogStats;
  retention: RetentionReport;
  estimated: { value: number | null; cards: number };
  log: StudyDay[];
  loggedDays: number;
  streak: StreakReport;
  decks: DeckCounts[];
  banks: (BankCounts & { name: string })[];
  orphanCards: number;
  targetRetention: { min: number; max: number } | null;
}

/** Everything the analytics view shows, from the real rows. Pure: `now` is in the input. */
export function computeAnalytics(input: AnalyticsInput): AnalyticsReport {
  const now = Date.parse(input.now);
  const counted = input.logs.filter((l) => !l.userCorrection);
  const { decks, orphanCards } = countsByDeck(input.cards, input.decks, now, input.boundary);
  const bankName = new Map(input.banks.map((b) => [b.id, b.name]));
  const log = studyLog(input.logs, now, input.boundary, { days: 30 });
  const targets = input.decks.map((d) => d.settings.targetRetention);
  return {
    hasCards: input.cards.length > 0,
    totalReviews: counted.length,
    firstReviewAt: input.firstReviewAt,
    forecast: dueForecast(input.cards, now, input.boundary, 30),
    backlog: backlog(input.cards, now, input.boundary),
    retention: trueRetention(input.logs, { minSamples: 20 }),
    estimated: estimatedRetention(input.cards, now),
    log,
    loggedDays: log.filter((d) => d.reviews > 0).length,
    streak: streak(input.logs, now, input.boundary),
    decks,
    banks: countsByBank(decks).map((b) => ({
      ...b,
      name: b.bankId === null ? 'No bank' : (bankName.get(b.bankId) ?? 'Deleted bank'),
    })),
    orphanCards,
    targetRetention:
      targets.length === 0 ? null : { min: Math.min(...targets), max: Math.max(...targets) },
  };
}

export const percent = (n: number | null, digits = 0): string =>
  n === null ? 'n/a' : `${(n * 100).toFixed(digits)}%`;
