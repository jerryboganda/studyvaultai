import {
  default_w,
  forgetting_curve,
  FSRSVersion,
  fsrs,
  generatorParameters,
  State,
  StrategyMode,
} from 'ts-fsrs';
import type { Card as FsrsCard, Grade, StepUnit } from 'ts-fsrs';
import { SCHEMA_VERSION } from '@shared/constants';
import type { Card, CardState, DeckSettings, FsrsState, Rating, ReviewLog } from './schema';
import {
  DAY_MS,
  HOUR_MS,
  UTC_BOUNDARY,
  formatInterval,
  studyDayStartMs,
  studyDayNumber,
  toIso,
  toMs,
  tzOffsetMs,
} from './time';
import type { DateInput, DayBoundary } from './time';

/**
 * Deterministic wrapper over ts-fsrs (FSRS-6, optimiser-free default weights).
 *
 * Determinism: every function takes `now` explicitly, fuzz is seeded from the card id and rep count
 * (or an injected seed) instead of the clock, and nothing is read from the environment.
 *
 * Elapsed days: ts-fsrs counts UTC calendar days. To make "elapsed" mean study days in the user's
 * frame, review times are shifted into the user's time zone (minus the rollover hour) before they
 * reach ts-fsrs and the resulting due dates are translated back to real instants. A due date is
 * always `now + interval` in real milliseconds, exactly as ts-fsrs computes it.
 */

export const ALGORITHM_VERSION = `sv1|ts-fsrs ${FSRSVersion}`;

const STATE_TO_FSRS: Record<CardState, State> = {
  new: State.New,
  learning: State.Learning,
  review: State.Review,
  relearning: State.Relearning,
};
const STATE_FROM_FSRS: Record<State, CardState> = {
  [State.New]: 'new',
  [State.Learning]: 'learning',
  [State.Review]: 'review',
  [State.Relearning]: 'relearning',
};

export class SchedulerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchedulerError';
  }
}

/** Fresh scheduling state: a new card is available from `now`. */
export function newFsrsState(now: DateInput): FsrsState {
  return {
    state: 'new',
    due: toIso(toMs(now)),
    stability: 0,
    difficulty: 0,
    elapsedDays: 0,
    scheduledDays: 0,
    learningSteps: 0,
    reps: 0,
    lapses: 0,
    lastReview: null,
  };
}

export interface ScheduleOptions {
  /** User's day boundary. Default: UTC calendar days (ts-fsrs native). */
  boundary?: DayBoundary;
  /** Explicit fuzz seed. Default `${card.id}:${reps}`. Ignored unless settings.enableFuzz. */
  seed?: string;
}

function params(settings: DeckSettings) {
  return generatorParameters({
    request_retention: settings.targetRetention,
    maximum_interval: settings.maxIntervalDays,
    enable_fuzz: settings.enableFuzz,
    enable_short_term: true,
    learning_steps: settings.learningSteps as StepUnit[],
    relearning_steps: settings.relearnSteps as StepUnit[],
  });
}

interface Outcome {
  rating: Rating;
  fsrs: FsrsState;
  elapsedDays: number;
  scheduledDays: number;
}

/** Runs ts-fsrs once and returns the four possible outcomes. Pure. */
function schedule(
  card: Pick<Card, 'id' | 'fsrs'>,
  nowMs: number,
  settings: DeckSettings,
  opts: ScheduleOptions,
): Record<Rating, Outcome> {
  const boundary = opts.boundary ?? UTC_BOUNDARY;
  const shift = (ms: number): number =>
    ms + tzOffsetMs(ms, boundary.timeZone) - boundary.rolloverHour * HOUR_MS;
  const prev = card.fsrs;
  const seed = opts.seed ?? `${card.id}:${prev.reps}`;
  const f = fsrs(params(settings)).useStrategy(StrategyMode.SEED, () => seed);

  const input: FsrsCard = {
    due: new Date(prev.due),
    stability: prev.stability,
    difficulty: prev.difficulty,
    elapsed_days: prev.elapsedDays,
    scheduled_days: prev.scheduledDays,
    learning_steps: prev.learningSteps,
    reps: prev.reps,
    lapses: prev.lapses,
    state: STATE_TO_FSRS[prev.state],
    ...(prev.lastReview ? { last_review: new Date(shift(Date.parse(prev.lastReview))) } : {}),
  };
  const shiftedNow = shift(nowMs);
  const record = f.repeat(input, new Date(shiftedNow));

  const out = {} as Record<Rating, Outcome>;
  for (const rating of [1, 2, 3, 4] as const) {
    const { card: next, log } = record[rating as Grade];
    let dueMs = nowMs + (next.due.getTime() - shiftedNow);
    let scheduledDays = Math.max(0, next.scheduled_days);
    // ts-fsrs forces Hard < Good < Easy and can overshoot the maximum by a day or two; the setting is a cap.
    if (next.state === State.Review && scheduledDays > settings.maxIntervalDays) {
      scheduledDays = settings.maxIntervalDays;
      dueMs = nowMs + scheduledDays * DAY_MS;
    }
    if (
      !Number.isFinite(next.stability) ||
      !Number.isFinite(next.difficulty) ||
      !Number.isFinite(dueMs)
    ) {
      throw new SchedulerError(`Scheduler produced a non-finite value for card ${card.id}`);
    }
    out[rating] = {
      rating,
      elapsedDays: Math.max(0, log.elapsed_days),
      scheduledDays,
      fsrs: {
        state: STATE_FROM_FSRS[next.state],
        due: toIso(dueMs),
        stability: next.stability,
        difficulty: next.difficulty,
        elapsedDays: Math.max(0, next.elapsed_days),
        scheduledDays,
        learningSteps: next.learning_steps,
        reps: next.reps,
        lapses: next.lapses,
        lastReview: toIso(nowMs),
      },
    };
  }
  return out;
}

/** The effective review time: never before the previous review (clock moved back / sync skew). */
function effectiveNow(card: Pick<Card, 'fsrs'>, now: DateInput): { ms: number; adjusted: boolean } {
  const requested = toMs(now);
  const last = card.fsrs.lastReview ? Date.parse(card.fsrs.lastReview) : -Infinity;
  return requested >= last ? { ms: requested, adjusted: false } : { ms: last, adjusted: true };
}

// ---------------------------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------------------------

export interface PreviewOutcome {
  rating: Rating;
  dueAt: string;
  /** Real milliseconds from now until due. */
  intervalMs: number;
  scheduledDays: number;
  /** "10m", "3d", "2.5mo". */
  label: string;
  state: CardState;
}

/** What each answer button would do: next due date and interval label for Again/Hard/Good/Easy. */
export function preview(
  card: Pick<Card, 'id' | 'fsrs'>,
  now: DateInput,
  settings: DeckSettings,
  opts: ScheduleOptions = {},
): Record<Rating, PreviewOutcome> {
  const { ms } = effectiveNow(card, now);
  const outcomes = schedule(card, ms, settings, opts);
  const map = {} as Record<Rating, PreviewOutcome>;
  for (const rating of [1, 2, 3, 4] as const) {
    const o = outcomes[rating];
    const intervalMs = Date.parse(o.fsrs.due) - ms;
    map[rating] = {
      rating,
      dueAt: o.fsrs.due,
      intervalMs,
      scheduledDays: o.scheduledDays,
      label: formatInterval(intervalMs),
      state: o.fsrs.state,
    };
  }
  return map;
}

// ---------------------------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------------------------

export interface ReviewOptions extends ScheduleOptions {
  /** Id for the ReviewLog row (the caller owns id generation). */
  logId: string;
  sessionId: string;
  /** Time the answer took, in ms. Clamped to 0..24h. */
  durationMs: number;
  /** Suspend a card that becomes a leech (default true). The `leech` tag is always added. */
  suspendLeeches?: boolean;
}

export interface ReviewResult {
  card: Card;
  log: ReviewLog;
  /** This answer pushed the card over the leech threshold. */
  leech: boolean;
  /** `now` was earlier than the previous review (clock change), so the previous review time was used. */
  clockAdjusted: boolean;
}

/** Anki's rule: first at `threshold` lapses, then every `ceil(threshold / 2)` lapses. */
export function isLeechTrigger(
  lapsesBefore: number,
  lapsesAfter: number,
  threshold: number,
): boolean {
  if (lapsesAfter <= lapsesBefore || lapsesAfter < threshold) return false;
  return (lapsesAfter - threshold) % Math.max(1, Math.ceil(threshold / 2)) === 0;
}

export function review(
  card: Card,
  rating: Rating,
  now: DateInput,
  settings: DeckSettings,
  opts: ReviewOptions,
): ReviewResult {
  const { ms, adjusted } = effectiveNow(card, now);
  const outcome = schedule(card, ms, settings, opts)[rating];
  const nowIso = toIso(ms);
  const leech = isLeechTrigger(card.fsrs.lapses, outcome.fsrs.lapses, settings.leechThreshold);
  const next: Card = {
    ...card,
    fsrs: outcome.fsrs,
    dueAt: outcome.fsrs.due,
    buriedUntil: null,
    updatedAt: nowIso,
    ...(leech
      ? {
          suspended: card.suspended || opts.suspendLeeches !== false,
          tags: card.tags.includes('leech') ? card.tags : [...card.tags, 'leech'],
        }
      : {}),
  };
  const log: ReviewLog = {
    id: opts.logId,
    schemaVersion: SCHEMA_VERSION,
    cardId: card.id,
    reviewedAt: nowIso,
    rating,
    durationMs: Math.min(86_400_000, Math.max(0, Math.round(opts.durationMs))),
    sessionId: opts.sessionId,
    previousState: card.fsrs,
    nextState: outcome.fsrs,
    algorithmVersion: ALGORITHM_VERSION,
    scheduledDays: outcome.scheduledDays,
    elapsedDays: outcome.elapsedDays,
    leech,
  };
  return { card: next, log, leech, clockAdjusted: adjusted };
}

// ---------------------------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------------------------

export type UndoResult =
  | { ok: true; card: Card; log: ReviewLog }
  | { ok: false; reason: 'card_mismatch' | 'already_undone' | 'not_last_review' };

const sameState = (a: FsrsState, b: FsrsState): boolean =>
  a.state === b.state &&
  a.stability === b.stability &&
  a.difficulty === b.difficulty &&
  a.elapsedDays === b.elapsedDays &&
  a.scheduledDays === b.scheduledDays &&
  a.learningSteps === b.learningSteps &&
  a.reps === b.reps &&
  a.lapses === b.lapses &&
  a.lastReview === b.lastReview &&
  Date.parse(a.due) === Date.parse(b.due);

/**
 * Undo the LAST review of a card: restores the scheduling state recorded in the log. Refused when
 * the card has moved on (another review, reschedule or reset happened since), so an old log can
 * never overwrite newer state. The returned log is the same row amended with `userCorrection`;
 * analytics ignore corrected logs. The caller persists both inside one transaction.
 */
export function undoReview(card: Card, log: ReviewLog, now: DateInput): UndoResult {
  if (log.cardId !== card.id) return { ok: false, reason: 'card_mismatch' };
  if (log.userCorrection) return { ok: false, reason: 'already_undone' };
  if (!sameState(card.fsrs, log.nextState)) return { ok: false, reason: 'not_last_review' };
  const at = toIso(toMs(now));
  // ponytail: a repeat leech trigger undone also drops the pre-existing 'leech' tag; the next lapse re-adds it.
  const restored: Card = {
    ...card,
    fsrs: log.previousState,
    dueAt: log.previousState.due,
    updatedAt: at,
    ...(log.leech ? { suspended: false, tags: card.tags.filter((t) => t !== 'leech') } : {}),
  };
  return { ok: true, card: restored, log: { ...log, userCorrection: { kind: 'undone', at } } };
}

// ---------------------------------------------------------------------------------------------
// Manual operations (not reviews: they write no ReviewLog and do not touch memory state)
// ---------------------------------------------------------------------------------------------

/** Move the due date. Stability and difficulty are kept; a due date in the past means "due now". */
export function reschedule(card: Card, dueAt: DateInput, now: DateInput): Card {
  const nowMs = toMs(now);
  const dueMs = Math.max(toMs(dueAt), nowMs);
  const due = toIso(dueMs);
  const anchor = card.fsrs.lastReview ? Date.parse(card.fsrs.lastReview) : nowMs;
  return {
    ...card,
    dueAt: due,
    updatedAt: toIso(nowMs),
    fsrs: {
      ...card.fsrs,
      due,
      scheduledDays:
        card.fsrs.state === 'review'
          ? Math.max(0, Math.round((dueMs - anchor) / DAY_MS))
          : card.fsrs.scheduledDays,
    },
  };
}

/** Forget a card: back to a new card, available now. Review counts are kept unless asked. */
export function resetCard(card: Card, now: DateInput, opts: { resetCounts?: boolean } = {}): Card {
  const fresh = newFsrsState(now);
  const fsrsState: FsrsState = opts.resetCounts
    ? fresh
    : { ...fresh, reps: card.fsrs.reps, lapses: card.fsrs.lapses };
  return {
    ...card,
    fsrs: fsrsState,
    dueAt: fsrsState.due,
    buriedUntil: null,
    updatedAt: fresh.due,
  };
}

export function setSuspended(card: Card, suspended: boolean, now: DateInput): Card {
  return { ...card, suspended, updatedAt: toIso(toMs(now)) };
}

/** Hide until the next study day starts (in the user's frame). */
export function buryCard(card: Card, now: DateInput, boundary: DayBoundary): Card {
  const nowMs = toMs(now);
  const until = studyDayStartMs(studyDayNumber(nowMs, boundary) + 1, boundary);
  return { ...card, buriedUntil: toIso(until), updatedAt: toIso(nowMs) };
}

export function unburyCard(card: Card, now: DateInput): Card {
  return { ...card, buriedUntil: null, updatedAt: toIso(toMs(now)) };
}

// ---------------------------------------------------------------------------------------------
// Memory model readouts
// ---------------------------------------------------------------------------------------------

/**
 * Probability of recall now (FSRS forgetting curve, default weights, fractional days since the last
 * review). null for cards that have never been studied. An estimate, not a measurement.
 */
export function retrievability(card: Pick<Card, 'fsrs'>, now: DateInput): number | null {
  const { fsrs: s } = card;
  if (s.state === 'new' || !s.lastReview || s.stability <= 0) return null;
  const days = Math.max(0, (toMs(now) - Date.parse(s.lastReview)) / DAY_MS);
  return forgetting_curve(default_w, days, s.stability);
}
