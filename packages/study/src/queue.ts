import { ReviewSession as ReviewSessionSchema } from './schema';
import type { Card, Deck, Rating, ReviewLog, ReviewSession } from './schema';
import { reschedule, retrievability } from './scheduler';
import type { Random } from './random';
import { MINUTE_MS, studyDayKey, studyDayNumber, studyDayStartMs, toIso, toMs } from './time';
import type { DateInput, DayBoundary } from './time';

/**
 * Review queue: what is due, in what order, under which daily caps, in the user's study day.
 *
 * Everything is a pure function of its arguments (cards, decks, `now`, boundary, injected random).
 * A review session is a plain value (`ReviewSession`): persist it anywhere, validate it on load,
 * and `resumeSession` reconciles it with the current card rows, so a restart can neither show a card
 * twice nor lose one.
 */

export const DEFAULT_LEARN_AHEAD_MS = 20 * MINUTE_MS;

export type DeckInfo = Pick<Deck, 'id' | 'bankId' | 'settings'> & { deletedAt?: string | null };
export type QueueCard = Pick<
  Card,
  'id' | 'deckId' | 'deletedAt' | 'suspended' | 'buriedUntil' | 'createdAt' | 'updatedAt' | 'fsrs'
>;

export type QueueKind = 'learning' | 'review' | 'new';

export interface QueueEntry {
  cardId: string;
  deckId: string;
  kind: QueueKind;
  dueAt: string;
  /** Whole study days past due (0 = due today). */
  overdueDays: number;
  /** Estimated recall probability now; null for new cards. */
  retrievability: number | null;
}

/** What the user already did today in one deck (see `countToday`). */
export interface DoneCounts {
  newDone: number;
  reviewsDone: number;
}

export interface QueueOptions {
  now: DateInput;
  boundary: DayBoundary;
  decks: readonly DeckInfo[];
  /** Per deck id: work already done in today's study day. Missing = nothing done. */
  done?: Readonly<Record<string, DoneCounts>>;
  /** Restrict to these decks (e.g. one bank's decks). null/undefined = every deck. */
  deckIds?: readonly string[] | null;
  /** Review order: lowest recall probability first (default), or oldest due first. */
  order?: 'retrievability' | 'due';
  /** New card order: oldest first (default) or shuffled (needs `random`). */
  newOrder?: 'created' | 'random';
  random?: Random;
  /** Spread decks proportionally ('deck', default), banks, or not at all. */
  interleave?: 'deck' | 'bank' | 'none';
  /** Learning cards due within this window are shown now instead of waiting. */
  learnAheadMs?: number;
}

export interface QueueResult {
  now: string;
  dayNumber: number;
  dayKey: string;
  /** When today's study day ends (the next rollover). */
  dayEndsAt: string;
  entries: QueueEntry[];
  /** `entries` ids in order: due learning steps, reviews, new cards, then steps due within the learn-ahead window. Each id once. */
  ids: string[];
  counts: { learning: number; review: number; new: number; total: number };
  /** Cards that are due but did not fit today's caps. They stay due: nothing is skipped or rescheduled. */
  deferred: {
    review: number;
    new: number;
    byDeck: Record<string, { review: number; new: number }>;
  };
  /** When the next learning step comes due (if none is due now). */
  nextLearningAt: string | null;
  excluded: {
    deleted: number;
    suspended: number;
    buried: number;
    duplicate: number;
    unknownDeck: number;
    outOfScope: number;
    /** New cards postponed to a later date. */
    postponed: number;
  };
}

interface Candidate {
  id: string;
  deckId: string;
  bankKey: string;
  kind: QueueKind;
  dueMs: number;
  /** Review: recall probability (low first). New: creation time or random rank (low first). */
  rank: number;
  retrievability: number | null;
}

const byId = (a: Candidate, b: Candidate): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function interleaveBuckets(buckets: Map<string, Candidate[]>): Candidate[] {
  const keys = [...buckets.keys()].sort();
  const items: { pos: number; b: number; i: number; c: Candidate }[] = [];
  keys.forEach((key, b) => {
    const list = buckets.get(key) as Candidate[];
    list.forEach((c, i) => items.push({ pos: (i + 0.5) / list.length, b, i, c }));
  });
  items.sort((x, y) => x.pos - y.pos || x.b - y.b || x.i - y.i);
  return items.map((x) => x.c);
}

export function buildQueue(cards: readonly QueueCard[], opts: QueueOptions): QueueResult {
  const nowMs = toMs(opts.now);
  const { boundary } = opts;
  const dayNumber = studyDayNumber(nowMs, boundary);
  const dayEndMs = studyDayStartMs(dayNumber + 1, boundary);
  const learnAheadEnd = nowMs + (opts.learnAheadMs ?? DEFAULT_LEARN_AHEAD_MS);
  const order = opts.order ?? 'retrievability';
  const mode = opts.interleave ?? 'deck';
  const scope = opts.deckIds ? new Set(opts.deckIds) : null;
  if (opts.newOrder === 'random' && !opts.random) {
    throw new TypeError('newOrder "random" needs an injected random function');
  }

  const decks = new Map<string, DeckInfo>();
  for (const d of opts.decks) if (!d.deletedAt) decks.set(d.id, d);

  const excluded = {
    deleted: 0,
    suspended: 0,
    buried: 0,
    duplicate: 0,
    unknownDeck: 0,
    outOfScope: 0,
    postponed: 0,
  };

  // Phantom-duplicate guard: one row per id, the most recently updated wins.
  const unique = new Map<string, QueueCard>();
  for (const c of cards) {
    const seen = unique.get(c.id);
    if (!seen) {
      unique.set(c.id, c);
    } else {
      excluded.duplicate += 1;
      if (Date.parse(c.updatedAt) > Date.parse(seen.updatedAt)) unique.set(c.id, c);
    }
  }

  const learning: Candidate[] = [];
  const learningAhead: Candidate[] = [];
  const reviews = new Map<string, Candidate[]>();
  const fresh = new Map<string, Candidate[]>();
  let nextLearningMs = Infinity;
  const push = (map: Map<string, Candidate[]>, key: string, c: Candidate): void => {
    const list = map.get(key);
    if (list) list.push(c);
    else map.set(key, [c]);
  };

  for (const c of unique.values()) {
    if (c.deletedAt) {
      excluded.deleted += 1;
      continue;
    }
    const deck = decks.get(c.deckId);
    if (!deck) {
      excluded.unknownDeck += 1;
      continue;
    }
    if (scope && !scope.has(c.deckId)) {
      excluded.outOfScope += 1;
      continue;
    }
    if (c.suspended) {
      excluded.suspended += 1;
      continue;
    }
    if (c.buriedUntil && Date.parse(c.buriedUntil) > nowMs) {
      excluded.buried += 1;
      continue;
    }
    const s = c.fsrs;
    const dueMs = Date.parse(s.due);
    const bankKey = mode === 'bank' ? (deck.bankId ?? `deck:${c.deckId}`) : c.deckId;
    if (s.state === 'new') {
      if (dueMs > nowMs) {
        excluded.postponed += 1;
        continue;
      }
      const rank =
        opts.newOrder === 'random' && opts.random ? opts.random() : Date.parse(c.createdAt);
      push(fresh, c.deckId, {
        id: c.id,
        deckId: c.deckId,
        bankKey,
        kind: 'new',
        dueMs,
        rank,
        retrievability: null,
      });
      continue;
    }
    const r = retrievability(c, nowMs) ?? 0;
    const cand: Candidate = {
      id: c.id,
      deckId: c.deckId,
      bankKey,
      kind: s.state === 'review' ? 'review' : 'learning',
      dueMs,
      rank: r,
      retrievability: r,
    };
    if (cand.kind === 'learning') {
      if (dueMs <= nowMs) learning.push(cand);
      else if (dueMs <= learnAheadEnd) learningAhead.push(cand);
      else nextLearningMs = Math.min(nextLearningMs, dueMs);
    } else if (dueMs < dayEndMs) {
      push(reviews, c.deckId, cand);
    }
  }

  // Per-deck caps. What does not fit is counted as deferred, never dropped from the data.
  const deferred: QueueResult['deferred'] = { review: 0, new: 0, byDeck: {} };
  const noteDeferred = (deckId: string, kind: 'review' | 'new', n: number): void => {
    if (n <= 0) return;
    deferred[kind] += n;
    const row = (deferred.byDeck[deckId] ??= { review: 0, new: 0 });
    row[kind] += n;
  };
  const cmpReview = (a: Candidate, b: Candidate): number =>
    order === 'due'
      ? a.dueMs - b.dueMs || byId(a, b)
      : a.rank - b.rank || a.dueMs - b.dueMs || byId(a, b);
  const cmpNew = (a: Candidate, b: Candidate): number => a.rank - b.rank || byId(a, b);

  const take = (
    pool: Map<string, Candidate[]>,
    kind: 'review' | 'new',
    cmp: (a: Candidate, b: Candidate) => number,
  ): Map<string, Candidate[]> => {
    const buckets = new Map<string, Candidate[]>();
    for (const [deckId, list] of pool) {
      const settings = (decks.get(deckId) as DeckInfo).settings;
      const done = opts.done?.[deckId];
      const cap =
        kind === 'review'
          ? settings.reviewsPerDay - (done?.reviewsDone ?? 0)
          : settings.newPerDay - (done?.newDone ?? 0);
      list.sort(cmp);
      const kept = list.slice(0, Math.max(0, cap));
      noteDeferred(deckId, kind, list.length - kept.length);
      for (const c of kept) push(buckets, mode === 'none' ? '' : c.bankKey, c);
    }
    for (const list of buckets.values()) list.sort(cmp);
    return buckets;
  };

  learning.sort((a, b) => a.dueMs - b.dueMs || byId(a, b));
  learningAhead.sort((a, b) => a.dueMs - b.dueMs || byId(a, b));
  const reviewList = interleaveBuckets(take(reviews, 'review', cmpReview));
  const newList = interleaveBuckets(take(fresh, 'new', cmpNew));

  const toEntry = (c: Candidate): QueueEntry => ({
    cardId: c.id,
    deckId: c.deckId,
    kind: c.kind,
    dueAt: toIso(c.dueMs),
    overdueDays: c.kind === 'new' ? 0 : Math.max(0, dayNumber - studyDayNumber(c.dueMs, boundary)),
    retrievability: c.retrievability,
  });
  // Steps that are due now come first; steps inside the learn-ahead window are offered last.
  const entries = [...learning, ...reviewList, ...newList, ...learningAhead].map(toEntry);

  return {
    now: toIso(nowMs),
    dayNumber,
    dayKey: studyDayKey(dayNumber),
    dayEndsAt: toIso(dayEndMs),
    entries,
    ids: entries.map((e) => e.cardId),
    counts: {
      learning: learning.length + learningAhead.length,
      review: reviewList.length,
      new: newList.length,
      total: entries.length,
    },
    deferred,
    nextLearningAt: Number.isFinite(nextLearningMs) ? toIso(nextLearningMs) : null,
    excluded,
  };
}

/**
 * Work already done in today's study day, per deck. New = first review of a card; reviews = reviews
 * of graduated cards (learning steps are not capped). Undone reviews do not count.
 */
export function countToday(
  logs: readonly Pick<ReviewLog, 'cardId' | 'reviewedAt' | 'previousState' | 'userCorrection'>[],
  deckOf: (cardId: string) => string | undefined,
  now: DateInput,
  boundary: DayBoundary,
): Record<string, DoneCounts> {
  const dayNumber = studyDayNumber(toMs(now), boundary);
  const start = studyDayStartMs(dayNumber, boundary);
  const end = studyDayStartMs(dayNumber + 1, boundary);
  const out: Record<string, DoneCounts> = {};
  for (const log of logs) {
    if (log.userCorrection) continue;
    const at = Date.parse(log.reviewedAt);
    if (at < start || at >= end) continue;
    const deckId = deckOf(log.cardId);
    if (!deckId) continue;
    const row = (out[deckId] ??= { newDone: 0, reviewsDone: 0 });
    if (log.previousState.state === 'new') row.newDone += 1;
    else if (log.previousState.state === 'review') row.reviewsDone += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------------------------

export function startSession(
  queue: QueueResult,
  args: { id: string; boundary: DayBoundary; deckIds?: readonly string[] | null },
): ReviewSession {
  return {
    version: 1,
    id: args.id,
    startedAt: queue.now,
    dayNumber: queue.dayNumber,
    boundary: args.boundary,
    deckIds: args.deckIds ? [...args.deckIds] : null,
    pending: queue.entries.filter((e) => e.kind !== 'learning').map((e) => e.cardId),
    learning: queue.entries
      .filter((e) => e.kind === 'learning')
      .map((e) => ({ cardId: e.cardId, dueAt: e.dueAt })),
    answered: 0,
    lastAnswer: null,
  };
}

export type NextCard =
  | { kind: 'card'; cardId: string; from: 'learning' | 'pending' }
  | { kind: 'wait'; until: string }
  | { kind: 'done' };

/**
 * The card to show next: a learning step that is due, then the queue, then a step inside the
 * learn-ahead window (shown early only because nothing else is left); otherwise when to come back.
 */
export function nextInSession(
  session: ReviewSession,
  now: DateInput,
  learnAheadMs: number = DEFAULT_LEARN_AHEAD_MS,
): NextCard {
  const nowMs = toMs(now);
  let soonest: { cardId: string; dueMs: number } | null = null;
  for (const l of session.learning) {
    const dueMs = Date.parse(l.dueAt);
    if (!soonest || dueMs < soonest.dueMs) soonest = { cardId: l.cardId, dueMs };
  }
  if (soonest && soonest.dueMs <= nowMs) {
    return { kind: 'card', cardId: soonest.cardId, from: 'learning' };
  }
  const head = session.pending[0];
  if (head !== undefined) return { kind: 'card', cardId: head, from: 'pending' };
  if (soonest && soonest.dueMs <= nowMs + learnAheadMs) {
    return { kind: 'card', cardId: soonest.cardId, from: 'learning' };
  }
  if (soonest) return { kind: 'wait', until: toIso(soonest.dueMs) };
  return { kind: 'done' };
}

/**
 * Record an answer. `answered` is the card AFTER review: a card that is still in a learning step
 * today re-enters the session at its due time, anything else leaves it. A card is never in the
 * session twice.
 */
export function answerInSession(
  session: ReviewSession,
  answered: Pick<Card, 'id' | 'suspended' | 'deletedAt' | 'fsrs'>,
  result: { logId: string; rating: Rating },
): ReviewSession {
  const dayEnd = studyDayStartMs(session.dayNumber + 1, session.boundary);
  const stepping =
    (answered.fsrs.state === 'learning' || answered.fsrs.state === 'relearning') &&
    !answered.suspended &&
    !answered.deletedAt &&
    Date.parse(answered.fsrs.due) < dayEnd;
  return {
    ...session,
    pending: session.pending.filter((id) => id !== answered.id),
    learning: [
      ...session.learning.filter((l) => l.cardId !== answered.id),
      ...(stepping ? [{ cardId: answered.id, dueAt: answered.fsrs.due }] : []),
    ],
    answered: session.answered + 1,
    lastAnswer: { cardId: answered.id, logId: result.logId, rating: result.rating },
  };
}

/** After `undoReview`: the restored card goes back to the front of the session. */
export function undoInSession(session: ReviewSession, restored: Pick<Card, 'id'>): ReviewSession {
  if (session.lastAnswer?.cardId !== restored.id) return session;
  return {
    ...session,
    pending: [restored.id, ...session.pending.filter((id) => id !== restored.id)],
    learning: session.learning.filter((l) => l.cardId !== restored.id),
    answered: Math.max(0, session.answered - 1),
    lastAnswer: null,
  };
}

export type DropReason =
  'missing' | 'deleted' | 'suspended' | 'buried' | 'not_due' | 'duplicate' | 'stale_day';

export interface ResumeResult {
  session: ReviewSession;
  dropped: { cardId: string; reason: DropReason }[];
  /** The session was built for an earlier study day: rebuild the queue instead of resuming. */
  stale: boolean;
  /** The device clock is earlier than the session start (clock change). The session is kept. */
  clockWentBack: boolean;
}

/** True when `value` is a structurally valid, non-duplicating session (use before resuming). */
export function parseSession(value: unknown): ReviewSession | null {
  const parsed = ReviewSessionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Reconcile a persisted session with the current card rows: the answer may have been written to the
 * database before the session was saved, a card may have been edited, suspended or deleted. Cards
 * that were answered meanwhile are dropped (no phantom repeat); cards now in a learning step move to
 * the learning list. Nothing new is added; order of survivors is kept.
 */
export function resumeSession(
  session: ReviewSession,
  cards: readonly QueueCard[],
  now: DateInput,
): ResumeResult {
  const nowMs = toMs(now);
  const dayNumber = studyDayNumber(nowMs, session.boundary);
  const clockWentBack = nowMs < Date.parse(session.startedAt);
  const ids = [...session.pending, ...session.learning.map((l) => l.cardId)];
  if (dayNumber !== session.dayNumber) {
    return {
      session: { ...session, pending: [], learning: [] },
      dropped: ids.map((cardId) => ({ cardId, reason: 'stale_day' as const })),
      stale: true,
      clockWentBack,
    };
  }
  const dayEnd = studyDayStartMs(dayNumber + 1, session.boundary);
  const byCard = new Map<string, QueueCard>();
  for (const c of cards) {
    const prev = byCard.get(c.id);
    if (!prev || Date.parse(c.updatedAt) > Date.parse(prev.updatedAt)) byCard.set(c.id, c);
  }
  const dropped: ResumeResult['dropped'] = [];
  const pending: string[] = [];
  const learning: { cardId: string; dueAt: string }[] = [];
  const seen = new Set<string>();
  for (const cardId of ids) {
    if (seen.has(cardId)) {
      dropped.push({ cardId, reason: 'duplicate' });
      continue;
    }
    seen.add(cardId);
    const c = byCard.get(cardId);
    const reason: DropReason | null = !c
      ? 'missing'
      : c.deletedAt
        ? 'deleted'
        : c.suspended
          ? 'suspended'
          : c.buriedUntil && Date.parse(c.buriedUntil) > nowMs
            ? 'buried'
            : null;
    if (reason || !c) {
      dropped.push({ cardId, reason: reason ?? 'missing' });
      continue;
    }
    const dueMs = Date.parse(c.fsrs.due);
    if (c.fsrs.state === 'learning' || c.fsrs.state === 'relearning') {
      if (dueMs < dayEnd) learning.push({ cardId, dueAt: c.fsrs.due });
      else dropped.push({ cardId, reason: 'not_due' });
    } else if (c.fsrs.state === 'review') {
      if (dueMs < dayEnd) pending.push(cardId);
      else dropped.push({ cardId, reason: 'not_due' });
    } else if (dueMs <= nowMs) {
      pending.push(cardId);
    } else {
      dropped.push({ cardId, reason: 'not_due' });
    }
  }
  return { session: { ...session, pending, learning }, dropped, stale: false, clockWentBack };
}

// ---------------------------------------------------------------------------------------------
// Backlog recovery
// ---------------------------------------------------------------------------------------------

export interface BacklogOptions {
  now: DateInput;
  boundary: DayBoundary;
  decks: readonly DeckInfo[];
  /** Window length in study days, today included (1-366). */
  days: number;
  /** Per-deck daily review budget. Default: each deck's reviewsPerDay. */
  maxPerDay?: number;
  done?: Readonly<Record<string, DoneCounts>>;
}

export interface BacklogMove {
  cardId: string;
  deckId: string;
  fromDueAt: string;
  toDueAt: string;
  /** Study days from today (>= 1). */
  dayOffset: number;
}

export interface BacklogPlan {
  /** Review cards overdue by at least one whole study day. */
  overdueTotal: number;
  /** Overdue cards that fit into today's budget and are left where they are. */
  keptToday: number;
  moves: BacklogMove[];
  /** Overdue cards that do not fit the window. They stay overdue and are listed, not hidden. */
  unassigned: { cardId: string; deckId: string }[];
}

/**
 * Plan how to spread overdue reviews over `days` study days within each deck's daily budget. Most
 * forgotten cards come first (today). Only due dates move, never memory state; the plan is a
 * proposal until `applyBacklogPlan`. Cards that do not fit are returned in `unassigned`.
 */
export function planBacklogRecovery(
  cards: readonly Pick<Card, 'id' | 'deckId' | 'deletedAt' | 'suspended' | 'fsrs'>[],
  opts: BacklogOptions,
): BacklogPlan {
  const nowMs = toMs(opts.now);
  const days = Math.min(366, Math.max(1, Math.floor(opts.days)));
  const today = studyDayNumber(nowMs, opts.boundary);
  const starts: number[] = [];
  for (let k = 0; k <= days; k += 1) starts.push(studyDayStartMs(today + k, opts.boundary));
  const decks = new Map(opts.decks.filter((d) => !d.deletedAt).map((d) => [d.id, d]));

  interface Item {
    id: string;
    deckId: string;
    dueMs: number;
    r: number;
  }
  const overdueByDeck = new Map<string, Item[]>();
  const existing = new Map<string, number[]>();
  let overdueTotal = 0;
  for (const c of cards) {
    if (c.deletedAt || c.suspended || c.fsrs.state !== 'review' || !decks.has(c.deckId)) continue;
    const dueMs = Date.parse(c.fsrs.due);
    if (dueMs < (starts[0] as number)) {
      const r = retrievability(c, nowMs) ?? 0;
      const list = overdueByDeck.get(c.deckId) ?? [];
      list.push({ id: c.id, deckId: c.deckId, dueMs, r });
      overdueByDeck.set(c.deckId, list);
      overdueTotal += 1;
    } else if (dueMs < (starts[days] as number)) {
      let k = 0;
      while (k + 1 < days && dueMs >= (starts[k + 1] as number)) k += 1;
      const row = existing.get(c.deckId) ?? new Array<number>(days).fill(0);
      row[k] = (row[k] ?? 0) + 1;
      existing.set(c.deckId, row);
    }
  }

  const moves: BacklogMove[] = [];
  const unassigned: BacklogPlan['unassigned'] = [];
  let keptToday = 0;
  for (const [deckId, list] of [...overdueByDeck].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    list.sort((a, b) => a.r - b.r || a.dueMs - b.dueMs || (a.id < b.id ? -1 : 1));
    const settings = (decks.get(deckId) as DeckInfo).settings;
    const cap = opts.maxPerDay ?? settings.reviewsPerDay;
    const row = existing.get(deckId) ?? new Array<number>(days).fill(0);
    let cursor = 0;
    for (let k = 0; k < days && cursor < list.length; k += 1) {
      const used = (row[k] ?? 0) + (k === 0 ? (opts.done?.[deckId]?.reviewsDone ?? 0) : 0);
      const room = Math.max(0, cap - used);
      for (let n = 0; n < room && cursor < list.length; n += 1, cursor += 1) {
        const item = list[cursor] as Item;
        if (k === 0) {
          keptToday += 1;
        } else {
          moves.push({
            cardId: item.id,
            deckId,
            fromDueAt: toIso(item.dueMs),
            toDueAt: toIso(starts[k] as number),
            dayOffset: k,
          });
        }
      }
    }
    for (; cursor < list.length; cursor += 1) {
      const item = list[cursor] as Item;
      unassigned.push({ cardId: item.id, deckId });
    }
  }
  return { overdueTotal, keptToday, moves, unassigned };
}

/** The cards a plan changes, with their due dates moved. The caller persists them. */
export function applyBacklogPlan(
  cards: readonly Card[],
  plan: BacklogPlan,
  now: DateInput,
): Card[] {
  const targets = new Map(plan.moves.map((m) => [m.cardId, m.toDueAt]));
  const out: Card[] = [];
  for (const c of cards) {
    const to = targets.get(c.id);
    if (to) out.push(reschedule(c, to, now));
  }
  return out;
}
