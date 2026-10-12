import '@shared/zodConfig';
import { z } from 'zod';
import { Id, IsoDate, MAX_SYLLABUS_NODES, MAX_SYLLABUS_TITLE_CHARS } from '@shared/schema';
import { tagNameKey } from '@shared/vault';
import { drawSyllabusExam, syllabusExamPool } from './examSyllabus';
import type { ExamSyllabusInput } from './examSyllabus';
import { hashSeed, seededRandom, shuffled } from './random';
import type { Random } from './random';
import { ChoiceId, LIMITS, Rating } from './schema';
import type { CardType } from './schema';
import { DAY_MS, HOUR_MS, MINUTE_MS, toIso, toMs } from './time';
import type { DateInput } from './time';

/**
 * Exam simulation (ADR-020): a timed run over a bank, folder, tag or syllabus topic with no feedback
 * until the end.
 *
 * Everything here is a pure function of its arguments: the clock arrives as `now`, chance as a
 * `Random`, cards as plain facts or views. An exam is a plain value (`ExamSession`) that the caller
 * persists and `parseExamSession` validates on load, so a reload, a suspended worker or a second
 * window can resume it. Nothing in this module touches review scheduling: counting an exam as review
 * is a separate, explicit step (`planExamReview`) that the caller applies through the review API.
 *
 * Flow: answering (timed; multiple choice is picked, recall cards are answered by typing or thinking)
 * -> marking (untimed; recall cards are revealed and self-marked Know / Don't know) -> finished.
 * The time limit covers answering only, so marking is never hurried and no answer is shown early.
 */

export const EXAM_TTL_MS = 24 * HOUR_MS;
export const EXAM_MAX_QUESTIONS = 200;
export const EXAM_MAX_MINUTES = 480;
export const EXAM_HISTORY_LIMIT = 20;

// ---------------------------------------------------------------------------------------------
// Scope and pool
// ---------------------------------------------------------------------------------------------

export const ExamScope = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }),
  z.object({ kind: z.literal('bank'), bankId: Id }),
  z.object({ kind: z.literal('folder'), bankId: Id, folderId: Id }),
  z.object({ kind: z.literal('tag'), tag: z.string().trim().min(1).max(LIMITS.tag) }),
  z.object({
    kind: z.literal('syllabus'),
    syllabusId: Id,
    /** null: the whole syllabus. Otherwise the topic and everything below it. */
    topicId: Id.nullable(),
    /** Questions are shared between the lowest-level topics in proportion to their weights. */
    weighted: z.boolean(),
  }),
]);
export type ExamScope = z.infer<typeof ExamScope>;

/** What the scope filter needs to know about one card; the storage layer resolves it. */
export interface ExamCardFacts {
  cardId: string;
  cardType: CardType;
  /** Bank the question is reported under: its deck's bank, else the first bank its highlight is in. */
  bankId: string | null;
  /** Every bank the card belongs to (its deck's and the ones its highlight is filed in). */
  bankIds: readonly string[];
  /** Every folder its highlight is filed in, plus all their ancestors (a folder holds its subtree). */
  folderIds: readonly string[];
  /** The card's own tags and its highlight's tags. */
  tags: readonly string[];
}

export function inExamScope(facts: ExamCardFacts, scope: ExamScope): boolean {
  switch (scope.kind) {
    case 'all':
      return true;
    case 'bank':
      return facts.bankIds.includes(scope.bankId);
    case 'folder':
      return facts.folderIds.includes(scope.folderId);
    case 'tag': {
      const key = tagNameKey(scope.tag);
      return facts.tags.some((t) => tagNameKey(t) === key);
    }
    case 'syllabus':
      // Needs the outline and what each card is filed under, not just the card: `createExam`
      // resolves it with `syllabusExamPool`.
      return false;
  }
}

export interface ExamUniverse {
  cards: readonly ExamCardFacts[];
  banks: readonly { id: string; name: string }[];
  /** `path` is the folder names from the top-level folder down to this one. */
  folders: readonly { id: string; bankId: string; path: readonly string[] }[];
}

export interface ExamScopeOption {
  /** Stable form value. */
  value: string;
  scope: ExamScope;
  /** "All cards", "Bank: Cardiology", "Folder: Cardiology / Physiology", "Tag: pharm". */
  label: string;
  /** Cards an exam over this scope can ask. */
  available: number;
}

/** The scopes that have at least one card, with their counts. */
export function examScopeOptions(u: ExamUniverse): ExamScopeOption[] {
  const out: ExamScopeOption[] = [
    { value: 'all', scope: { kind: 'all' }, label: 'All cards', available: u.cards.length },
  ];
  const count = (scope: ExamScope) => u.cards.filter((c) => inExamScope(c, scope)).length;
  const bankName = new Map(u.banks.map((b) => [b.id, b.name]));
  for (const b of [...u.banks].sort((x, y) => x.name.localeCompare(y.name))) {
    const scope: ExamScope = { kind: 'bank', bankId: b.id };
    out.push({
      value: `bank:${b.id}`,
      scope,
      label: `Bank: ${b.name}`,
      available: count(scope),
    });
  }
  for (const f of [...u.folders].sort((x, y) => x.path.join('/').localeCompare(y.path.join('/')))) {
    const scope: ExamScope = { kind: 'folder', bankId: f.bankId, folderId: f.id };
    const bank = bankName.get(f.bankId) ?? 'Deleted bank';
    out.push({
      value: `folder:${f.id}`,
      scope,
      label: `Folder: ${[bank, ...f.path].join(' / ')}`,
      available: count(scope),
    });
  }
  const labels = new Map<string, string>();
  for (const c of u.cards) {
    for (const t of c.tags) {
      const key = tagNameKey(t);
      if (!labels.has(key)) labels.set(key, t);
    }
  }
  for (const [key, tag] of [...labels].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const scope: ExamScope = { kind: 'tag', tag };
    out.push({ value: `tag:${key}`, scope, label: `Tag: ${tag}`, available: count(scope) });
  }
  return out.filter((o) => o.available > 0 || o.value === 'all');
}

// ---------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------

export interface ExamConfig {
  scope: ExamScope;
  /** Shown on the results and kept in the history (e.g. "Bank: Cardiology"). */
  scopeLabel: string;
  /** Number of questions asked for; capped by the cards available. */
  questions: number;
  /** Time limit in whole minutes (1-480), or null for none. */
  minutes: number | null;
  shuffle: boolean;
  /**
   * Seed of the draw. Omitted: drawn from the `Random` given to `createExam`. The setup form keeps
   * one so that the plan it shows for a syllabus exam is the one that is drawn.
   */
  seed?: number;
}

export type ExamConfigCheck =
  | { ok: true; count: number; capped: boolean }
  | { ok: false; errors: { questions?: string; minutes?: string } };

/** The form's rules, in one place: what the setup screen shows and what `createExam` enforces. */
export function validateExamConfig(
  input: { questions: number; minutes: number | null },
  available: number,
): ExamConfigCheck {
  const errors: { questions?: string; minutes?: string } = {};
  if (available < 1) errors.questions = 'There are no cards to ask in this scope.';
  else if (
    !Number.isInteger(input.questions) ||
    input.questions < 1 ||
    input.questions > EXAM_MAX_QUESTIONS
  ) {
    errors.questions = `Ask for a whole number of questions from 1 to ${EXAM_MAX_QUESTIONS}.`;
  }
  if (
    input.minutes !== null &&
    (!Number.isInteger(input.minutes) || input.minutes < 1 || input.minutes > EXAM_MAX_MINUTES)
  ) {
    errors.minutes = `Use a whole number of minutes from 1 to ${EXAM_MAX_MINUTES}, or no limit.`;
  }
  if (errors.questions !== undefined || errors.minutes !== undefined) return { ok: false, errors };
  const count = Math.min(input.questions, available);
  return { ok: true, count, capped: count < input.questions };
}

// ---------------------------------------------------------------------------------------------
// The persisted exam
// ---------------------------------------------------------------------------------------------

export const EXAM_OUTCOMES = ['correct', 'wrong', 'unanswered', 'void'] as const;
export const ExamOutcome = z.enum(EXAM_OUTCOMES);
export type ExamOutcome = z.infer<typeof ExamOutcome>;

const ExamQuestion = z.object({
  cardId: Id,
  /** mcq: scored by the key. recall: answered by typing or thinking, marked by the person. */
  kind: z.enum(['mcq', 'recall']),
  bankId: Id.nullable(),
  /** Syllabus exams: the topic the question counts under (null for every other exam). */
  topicId: Id.nullable(),
  tags: z.array(z.string().max(LIMITS.tag)).max(LIMITS.tags),
  /** Multiple choice: the option picked. */
  choiceId: ChoiceId.nullable(),
  /** Recall: what the person typed (optional, never graded by the machine). */
  text: z.string().max(LIMITS.longNote),
  /** Recall: the person's own mark, given after answering has ended. */
  mark: z.enum(['know', 'dont']).nullable(),
  spentMs: z.number().int().min(0).max(DAY_MS),
});
export type ExamQuestion = z.infer<typeof ExamQuestion>;

const ReviewApplied = z.object({
  at: IsoDate,
  logs: z.array(z.object({ cardId: Id, logId: Id, rating: Rating })).max(EXAM_MAX_QUESTIONS),
  /** Questions that got no rating (unanswered, or the card was gone). */
  skipped: z.number().int().min(0),
  undoneAt: IsoDate.nullable(),
});
export type ExamReviewApplied = z.infer<typeof ReviewApplied>;

/** What a syllabus exam keeps of its outline: titles as they were, and what was left out. */
const ExamSyllabusFacts = z.object({
  /** The topics that have a question, in outline order, with the title they had. */
  topics: z
    .array(z.object({ id: Id, title: z.string().max(MAX_SYLLABUS_TITLE_CHARS) }))
    .max(MAX_SYLLABUS_NODES),
  /** Lowest-level topics that got no question, and why. */
  skipped: z
    .array(
      z.object({
        id: Id,
        title: z.string().max(MAX_SYLLABUS_TITLE_CHARS),
        reason: z.enum(['nocards', 'shared', 'noshare']),
      }),
    )
    .max(MAX_SYLLABUS_NODES),
  /** Cards of the scope no lowest-level topic holds, so a weighted draw could not use them. */
  undrawn: z.number().int().min(0),
});
export type ExamSyllabusFacts = z.infer<typeof ExamSyllabusFacts>;

/** The persisted exam's version. 1 had no syllabus scope: `upgradeExamSession` carries it over. */
export const EXAM_SESSION_VERSION = 2;

export const ExamSession = z
  .object({
    version: z.literal(EXAM_SESSION_VERSION),
    id: Id,
    phase: z.enum(['answering', 'marking', 'finished']),
    scope: ExamScope,
    scopeLabel: z.string().min(1).max(300),
    /** Names of the banks the questions are reported under, as they were when the exam began. */
    bankNames: z.record(Id, z.string().max(200)),
    /** Set for (and only for) an exam over a syllabus. */
    syllabus: ExamSyllabusFacts.nullable(),
    minutes: z.number().int().min(1).max(EXAM_MAX_MINUTES).nullable(),
    shuffle: z.boolean(),
    /** Derives which cards, in which order, and the order of each multiple-choice list. */
    seed: z.number().int().min(0).max(0xffffffff),
    startedAt: IsoDate,
    deadlineAt: IsoDate.nullable(),
    /** The last instant time was charged to a question. */
    lastAt: IsoDate,
    /** When answering ended: the finish button, or the deadline when time ran out. */
    endedAt: IsoDate.nullable(),
    endReason: z.enum(['submitted', 'timeup']).nullable(),
    finishedAt: IsoDate.nullable(),
    /** Unfinished exams and unread results are dropped after this (24 h). */
    expiresAt: IsoDate,
    current: z.number().int().min(0),
    questions: z.array(ExamQuestion).min(1).max(EXAM_MAX_QUESTIONS),
    /** Set when the exam is finished: one per question, fixed from then on. */
    outcomes: z.array(ExamOutcome).nullable(),
    review: ReviewApplied.nullable(),
  })
  .superRefine((e, ctx) => {
    const bad = (message: string) => ctx.addIssue({ code: 'custom', path: [], message });
    if (e.current >= e.questions.length) bad('current is past the last question');
    if (new Set(e.questions.map((q) => q.cardId)).size !== e.questions.length) {
      bad('a card is asked twice');
    }
    if (e.outcomes !== null && e.outcomes.length !== e.questions.length) bad('outcomes misaligned');
    if (e.phase === 'finished' && (e.outcomes === null || e.finishedAt === null)) {
      bad('a finished exam needs its outcomes');
    }
    if (e.phase !== 'finished' && (e.outcomes !== null || e.review !== null)) {
      bad('an unfinished exam has no outcomes');
    }
    if (e.phase === 'answering' && e.endedAt !== null) bad('answering has not ended');
    if (e.phase !== 'answering' && (e.endedAt === null || e.endReason === null)) {
      bad('answering ended without a time');
    }
    if ((e.minutes === null) !== (e.deadlineAt === null)) bad('limit and deadline disagree');
    if ((e.scope.kind === 'syllabus') !== (e.syllabus !== null)) {
      bad('a syllabus exam keeps its outline, and only a syllabus exam does');
    }
    const known = new Set(e.syllabus?.topics.map((t) => t.id));
    if (e.questions.some((q) => q.topicId !== null && !known.has(q.topicId))) {
      bad('a question counts under a topic the exam does not know');
    }
  });
export type ExamSession = z.infer<typeof ExamSession>;

/**
 * A stored exam of an older version, brought to the current shape (or the value unchanged when it
 * is not one). Version 1 had no syllabus scope, so it gains exactly the empty parts.
 */
export function upgradeExamSession(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || !Array.isArray(v.questions)) return value;
  return {
    ...v,
    version: EXAM_SESSION_VERSION,
    syllabus: null,
    questions: v.questions.map((q: unknown) =>
      typeof q === 'object' && q !== null ? { ...q, topicId: null } : q,
    ),
  };
}

/**
 * Valid, unexpired exam from storage. `expired` tells the caller to say why it is gone; `unreadable`
 * says a row was there that is not a valid exam (damaged, or written by a version this one does not
 * know), so the caller can tell the person it was dropped instead of crashing or going silent.
 */
export function parseExamSession(
  value: unknown,
  now: DateInput,
): { session: ExamSession | null; expired: boolean; unreadable?: true } {
  const parsed = ExamSession.safeParse(upgradeExamSession(value));
  if (!parsed.success) {
    return value === null || value === undefined
      ? { session: null, expired: false }
      : { session: null, expired: false, unreadable: true };
  }
  if (Date.parse(parsed.data.expiresAt) <= toMs(now)) return { session: null, expired: true };
  return { session: parsed.data, expired: false };
}

const byCardId = (a: ExamCardFacts, b: ExamCardFacts): number =>
  a.cardId < b.cardId ? -1 : a.cardId > b.cardId ? 1 : 0;

/**
 * Build an exam: the cards of the scope, `count` of them chosen and ordered from a seed drawn from
 * `random` (the seed is stored, so the same exam can always be reproduced). Throws RangeError when
 * the configuration is not valid (check it with `validateExamConfig` first to show messages).
 */
export function createExam(input: {
  id: string;
  now: DateInput;
  random: Random;
  config: ExamConfig;
  /** The whole universe of cards; the scope is applied here. */
  cards: readonly ExamCardFacts[];
  bankNames?: Readonly<Record<string, string>>;
  /** Required for (and only used by) a syllabus scope: the outline and what each card is filed under. */
  syllabus?: ExamSyllabusInput;
}): ExamSession {
  const { config } = input;
  const scope = config.scope;
  const seed =
    config.seed === undefined
      ? Math.min(0xffffffff, Math.floor(input.random() * 0x100000000))
      : config.seed >>> 0;
  let pool: ExamCardFacts[] = [];
  let syllabusPool: ReturnType<typeof syllabusExamPool> | null = null;
  if (scope.kind === 'syllabus') {
    if (input.syllabus === undefined) throw new RangeError('The syllabus could not be read.');
    syllabusPool = syllabusExamPool({
      syllabus: input.syllabus,
      topicId: scope.topicId,
      weighted: scope.weighted,
      cards: input.cards,
      seed,
    });
  } else {
    pool = input.cards.filter((c) => inExamScope(c, scope)).sort(byCardId);
  }
  const check = validateExamConfig(config, syllabusPool ? syllabusPool.drawable : pool.length);
  if (!check.ok) throw new RangeError(Object.values(check.errors).join(' '));
  const startedMs = toMs(input.now);
  let picked: ExamCardFacts[];
  const topicOf = new Map<string, string>();
  let syllabus: ExamSyllabusFacts | null = null;
  if (syllabusPool) {
    const draw = drawSyllabusExam(syllabusPool, check.count);
    picked = draw.picked.map((p) => p.facts);
    for (const p of draw.picked) topicOf.set(p.facts.cardId, p.topicId);
    const used = new Set(draw.picked.map((p) => p.topicId));
    // The topics a question counts under, in outline order (units first appear in outline order).
    const order = [...syllabusPool.titles.keys()];
    syllabus = {
      topics: order
        .filter((id) => used.has(id))
        .map((id) => ({ id, title: syllabusPool.titles.get(id) ?? id })),
      skipped: draw.skipped.map((s) => ({ id: s.topicId, title: s.title, reason: s.reason })),
      undrawn: syllabusPool.inScope - syllabusPool.drawable,
    };
  } else {
    picked = shuffled(pool, seededRandom(seed)).slice(0, check.count);
  }
  const ordered = config.shuffle ? picked : [...picked].sort(byCardId);
  const names: Record<string, string> = {};
  for (const f of ordered) {
    const name = f.bankId === null ? undefined : input.bankNames?.[f.bankId];
    if (f.bankId !== null && name !== undefined) names[f.bankId] = name;
  }
  return {
    version: EXAM_SESSION_VERSION,
    id: input.id,
    phase: 'answering',
    scope: config.scope,
    scopeLabel: config.scopeLabel,
    bankNames: names,
    syllabus,
    minutes: config.minutes,
    shuffle: config.shuffle,
    seed,
    startedAt: toIso(startedMs),
    deadlineAt: config.minutes === null ? null : toIso(startedMs + config.minutes * MINUTE_MS),
    lastAt: toIso(startedMs),
    endedAt: null,
    endReason: null,
    finishedAt: null,
    expiresAt: toIso(startedMs + EXAM_TTL_MS),
    current: 0,
    questions: ordered.map((f) => ({
      cardId: f.cardId,
      kind: f.cardType === 'mcq' ? ('mcq' as const) : ('recall' as const),
      bankId: f.bankId,
      topicId: topicOf.get(f.cardId) ?? null,
      tags: f.tags.slice(0, LIMITS.tags).map((t) => t.slice(0, LIMITS.tag)),
      choiceId: null,
      text: '',
      mark: null,
      spentMs: 0,
    })),
    outcomes: null,
    review: null,
  };
}

/** Display order of a multiple-choice list: stable for one exam and card, so a render never reshuffles. */
export function examChoiceRandom(exam: Pick<ExamSession, 'seed'>, cardId: string): Random {
  return seededRandom((hashSeed(cardId) ^ exam.seed) >>> 0);
}

// ---------------------------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------------------------

const deadlineMs = (e: Pick<ExamSession, 'deadlineAt'>): number | null =>
  e.deadlineAt === null ? null : Date.parse(e.deadlineAt);

/** Milliseconds left to answer (never negative), or null when the exam has no time limit. */
export function examRemainingMs(
  exam: Pick<ExamSession, 'deadlineAt' | 'phase'>,
  now: DateInput,
): number | null {
  const d = deadlineMs(exam);
  if (d === null) return null;
  return exam.phase === 'answering' ? Math.max(0, d - toMs(now)) : 0;
}

export type ExamMilestone = 'half' | 'tenth' | 'minute' | 'timeup';

/**
 * The moments (as time left) at which the person is told how much time remains: half the time,
 * a tenth of it, one minute, and the end. A moment that would repeat another (within a second) or
 * fall at the very start is left out, so every announcement says something new.
 */
export function examMilestones(totalMs: number): { id: ExamMilestone; remainingMs: number }[] {
  const all: { id: ExamMilestone; remainingMs: number }[] = [
    { id: 'half', remainingMs: Math.round(totalMs / 2) },
    { id: 'minute', remainingMs: MINUTE_MS },
    { id: 'tenth', remainingMs: Math.round(totalMs / 10) },
  ];
  const kept: { id: ExamMilestone; remainingMs: number }[] = [];
  for (const m of all) {
    if (m.remainingMs >= totalMs || m.remainingMs < 1000) continue;
    if (kept.some((k) => Math.abs(k.remainingMs - m.remainingMs) < 1000)) continue;
    kept.push(m);
  }
  kept.sort((a, b) => b.remainingMs - a.remainingMs);
  return [...kept, { id: 'timeup', remainingMs: 0 }];
}

/** Milestones already reached at `now`, in the order they happen. Empty for an untimed exam. */
export function crossedMilestones(
  exam: Pick<ExamSession, 'deadlineAt' | 'startedAt' | 'phase'>,
  now: DateInput,
): ExamMilestone[] {
  const d = deadlineMs(exam);
  if (d === null) return [];
  const total = d - Date.parse(exam.startedAt);
  const left = exam.phase === 'answering' ? Math.max(0, d - toMs(now)) : 0;
  return examMilestones(total)
    .filter((m) => left <= m.remainingMs)
    .map((m) => m.id);
}

const spoken = (ms: number): string => {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s} seconds`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m} minutes` : `${Math.round(m / 6) / 10} hours`;
};

/** The sentence announced for a milestone (screen readers get these, never a per-second tick). */
export function milestoneMessage(id: ExamMilestone, totalMs: number): string {
  switch (id) {
    case 'half':
      return `Half of the time has passed. About ${spoken(totalMs / 2)} left.`;
    case 'tenth':
      return `Ten percent of the time is left: about ${spoken(totalMs / 10)}.`;
    case 'minute':
      return 'One minute left.';
    case 'timeup':
      return 'Time is up. Your answers are saved.';
  }
}

/** "12:05", or "1:02:09" from one hour. Rounds up, so 00:00 only shows once time is really up. */
export function formatClock(ms: number): string {
  const s = Math.ceil(Math.max(0, ms) / 1000);
  const two = (n: number) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  return `${h > 0 ? `${h}:` : ''}${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}`;
}

/** "45 s", "2 min 05 s", "1 h 02 min". */
export function examDuration(ms: number): string {
  const s = Math.round(Math.max(0, ms) / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

// ---------------------------------------------------------------------------------------------
// Transitions (each returns a new exam; one that does not apply returns the exam unchanged)
// ---------------------------------------------------------------------------------------------

/** Charge the time since the last event to the question on screen. Time never runs backwards. */
function charge(exam: ExamSession, atMs: number): ExamSession {
  if (exam.phase !== 'answering') return exam;
  const delta = Math.max(0, atMs - Date.parse(exam.lastAt));
  const questions =
    delta === 0
      ? exam.questions
      : exam.questions.map((q, i) =>
          i === exam.current
            ? { ...q, spentMs: Math.min(DAY_MS, q.spentMs + Math.round(delta)) }
            : q,
        );
  return { ...exam, questions, lastAt: toIso(atMs) };
}

function end(exam: ExamSession, atMs: number, reason: 'submitted' | 'timeup'): ExamSession {
  const e = charge(exam, atMs);
  return { ...e, phase: 'marking', endedAt: toIso(atMs), endReason: reason };
}

/**
 * Time ran out? The exam moves to marking, and its end is the deadline whenever this is noticed.
 * Call before showing or changing anything.
 */
export function tickExam(exam: ExamSession, now: DateInput): ExamSession {
  if (exam.phase !== 'answering') return exam;
  const d = deadlineMs(exam);
  if (d === null || toMs(now) < d) return exam;
  return end(exam, d, 'timeup');
}

function whileAnswering(
  exam: ExamSession,
  now: DateInput,
  change: (e: ExamSession) => ExamSession,
): ExamSession {
  const ticked = tickExam(exam, now);
  if (ticked.phase !== 'answering') return ticked;
  return change(charge(ticked, toMs(now)));
}

const withQuestion = (
  e: ExamSession,
  index: number,
  change: (q: ExamQuestion) => ExamQuestion,
): ExamSession =>
  e.questions[index] === undefined
    ? e
    : { ...e, questions: e.questions.map((q, i) => (i === index ? change(q) : q)) };

/** Pick (or clear, with null) the option of a multiple-choice question. */
export function chooseOption(
  exam: ExamSession,
  index: number,
  choiceId: string | null,
  now: DateInput,
): ExamSession {
  return whileAnswering(exam, now, (e) =>
    withQuestion(e, index, (q) => (q.kind === 'mcq' ? { ...q, choiceId } : q)),
  );
}

/** What the person typed for a recall question (kept, never graded by the machine). */
export function typeAnswer(
  exam: ExamSession,
  index: number,
  text: string,
  now: DateInput,
): ExamSession {
  return whileAnswering(exam, now, (e) =>
    withQuestion(e, index, (q) =>
      q.kind === 'recall' ? { ...q, text: text.slice(0, LIMITS.longNote) } : q,
    ),
  );
}

export function goToQuestion(exam: ExamSession, index: number, now: DateInput): ExamSession {
  return whileAnswering(exam, now, (e) =>
    Number.isInteger(index) && index >= 0 && index < e.questions.length
      ? { ...e, current: index }
      : e,
  );
}

/** The person pressed finish (or time ran out first: then the deadline wins). */
export function endAnswering(exam: ExamSession, now: DateInput): ExamSession {
  const ticked = tickExam(exam, now);
  return ticked.phase === 'answering' ? end(ticked, toMs(now), 'submitted') : ticked;
}

/** Back from a closed page: time-up is applied, and the time spent away is not charged to a question. */
export function resumeExam(
  exam: ExamSession,
  now: DateInput,
): { exam: ExamSession; timedOut: boolean } {
  const ticked = tickExam(exam, now);
  if (ticked.phase !== 'answering') {
    return { exam: ticked, timedOut: ticked !== exam };
  }
  return { exam: { ...ticked, lastAt: toIso(toMs(now)) }, timedOut: false };
}

/** Self-mark a recall question once answering has ended. */
export function markRecall(exam: ExamSession, index: number, mark: 'know' | 'dont'): ExamSession {
  if (exam.phase !== 'marking') return exam;
  return withQuestion(exam, index, (q) => (q.kind === 'recall' ? { ...q, mark } : q));
}

/** Indexes of recall questions still unmarked whose card is still there (a removed card cannot be marked). */
export function pendingMarks(exam: ExamSession, exists: (cardId: string) => boolean): number[] {
  return exam.questions.flatMap((q, i) =>
    q.kind === 'recall' && q.mark === null && exists(q.cardId) ? [i] : [],
  );
}

/** "Mark the rest as not known": the one bulk mark, always an explicit choice. */
export function markRemaining(
  exam: ExamSession,
  mark: 'know' | 'dont',
  exists: (cardId: string) => boolean,
): ExamSession {
  if (exam.phase !== 'marking') return exam;
  const open = new Set(pendingMarks(exam, exists));
  return { ...exam, questions: exam.questions.map((q, i) => (open.has(i) ? { ...q, mark } : q)) };
}

// ---------------------------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------------------------

/** What scoring needs to know about the card as it is now. A `Card` satisfies it. */
export interface ExamCardView {
  cardType: CardType;
  front: string;
  back: string;
  choices?: readonly { id: string; text: string }[] | undefined;
  answerChoiceId?: string | undefined;
  sourceQuote?: string | null | undefined;
}

/**
 * correct / wrong / unanswered, or void when the card is gone or can no longer be scored (a void
 * question is left out of the score, so removing a card never punishes the person).
 */
export function outcomeOf(q: ExamQuestion, card: ExamCardView | null): ExamOutcome {
  if (!card) return 'void';
  if (q.kind === 'mcq') {
    if (card.cardType !== 'mcq' || !card.answerChoiceId) return 'void';
    if (q.choiceId === null || !card.choices?.some((c) => c.id === q.choiceId)) return 'unanswered';
    return q.choiceId === card.answerChoiceId ? 'correct' : 'wrong';
  }
  return q.mark === 'know' ? 'correct' : q.mark === 'dont' ? 'wrong' : 'unanswered';
}

export function gradeExam(
  exam: ExamSession,
  cards: ReadonlyMap<string, ExamCardView>,
): ExamOutcome[] {
  return exam.questions.map((q) => outcomeOf(q, cards.get(q.cardId) ?? null));
}

/** Marking is over: the outcomes are fixed and the results can be shown (and kept for 24 h). */
export function finishExam(
  exam: ExamSession,
  outcomes: readonly ExamOutcome[],
  now: DateInput,
): ExamSession {
  if (exam.phase !== 'marking' || outcomes.length !== exam.questions.length) return exam;
  const at = toMs(now);
  return {
    ...exam,
    phase: 'finished',
    outcomes: [...outcomes],
    finishedAt: toIso(at),
    expiresAt: toIso(at + EXAM_TTL_MS),
  };
}

export interface ExamScore {
  total: number;
  correct: number;
  wrong: number;
  unanswered: number;
  void: number;
  /** Questions that count: everything except void ones. */
  graded: number;
  /** correct / graded, 0..1; null when nothing was graded. Unanswered questions count against it. */
  fraction: number | null;
}

export function scoreOutcomes(outcomes: readonly ExamOutcome[]): ExamScore {
  const n = { correct: 0, wrong: 0, unanswered: 0, void: 0 };
  for (const o of outcomes) n[o] += 1;
  const graded = outcomes.length - n.void;
  return {
    total: outcomes.length,
    ...n,
    graded,
    fraction: graded === 0 ? null : n.correct / graded,
  };
}

export interface BreakdownRow {
  key: string;
  label: string;
  total: number;
  correct: number;
  wrong: number;
  unanswered: number;
}

/**
 * Per bank, per tag and (syllabus exams) per topic. A question with several tags counts under each
 * of them; a question counts under exactly one topic. Void is left out. Topics come in outline order.
 */
export function examBreakdown(
  exam: ExamSession,
  outcomes: readonly ExamOutcome[],
): { banks: BreakdownRow[]; tags: BreakdownRow[]; topics: BreakdownRow[] } {
  const banks = new Map<string, BreakdownRow>();
  const tags = new Map<string, BreakdownRow>();
  const topics = new Map<string, BreakdownRow>();
  const topicTitle = new Map((exam.syllabus?.topics ?? []).map((t) => [t.id, t.title] as const));
  const add = (map: Map<string, BreakdownRow>, key: string, label: string, o: ExamOutcome) => {
    if (o === 'void') return;
    const row = map.get(key) ?? { key, label, total: 0, correct: 0, wrong: 0, unanswered: 0 };
    row.total += 1;
    row[o] += 1;
    map.set(key, row);
  };
  exam.questions.forEach((q, i) => {
    const o = outcomes[i] ?? 'void';
    const bank = q.bankId === null ? undefined : exam.bankNames[q.bankId];
    add(banks, q.bankId ?? 'none', bank ?? 'No bank', o);
    for (const t of q.tags) add(tags, tagNameKey(t), t, o);
    if (q.topicId !== null) add(topics, q.topicId, topicTitle.get(q.topicId) ?? 'Removed topic', o);
  });
  const byLabel = (a: BreakdownRow, b: BreakdownRow) => a.label.localeCompare(b.label);
  const outline = [...topicTitle.keys()];
  return {
    banks: [...banks.values()].sort(byLabel),
    tags: [...tags.values()].sort(byLabel),
    topics: [...topics.values()].sort((a, b) => outline.indexOf(a.key) - outline.indexOf(b.key)),
  };
}

export interface ExamTiming {
  /** From the start to the end of answering. */
  usedMs: number;
  /** The limit in ms, or null. */
  limitMs: number | null;
  timedOut: boolean;
  /** Mean time on a question that was looked at, or null when none was. */
  meanMs: number | null;
}

export function examTiming(exam: ExamSession): ExamTiming {
  const end = exam.endedAt === null ? Date.parse(exam.lastAt) : Date.parse(exam.endedAt);
  const seen = exam.questions.filter((q) => q.spentMs > 0);
  return {
    usedMs: Math.max(0, end - Date.parse(exam.startedAt)),
    limitMs: exam.minutes === null ? null : exam.minutes * MINUTE_MS,
    timedOut: exam.endReason === 'timeup',
    meanMs: seen.length === 0 ? null : seen.reduce((n, q) => n + q.spentMs, 0) / seen.length,
  };
}

// ---------------------------------------------------------------------------------------------
// Count as review
// ---------------------------------------------------------------------------------------------

export interface ExamReviewItem {
  cardId: string;
  /** Idempotency key of the review log: the same exam can never write a card's answer twice. */
  logId: string;
  rating: Rating;
  durationMs: number;
}

const MAX_REVIEW_MS = 5 * MINUTE_MS;

/**
 * One rating per answered card: correct is Good, wrong is Again. Unanswered and void questions are
 * left alone (running out of time is not forgetting). The caller applies the items with the review
 * API, which is idempotent per `logId`.
 */
export function planExamReview(exam: ExamSession): { items: ExamReviewItem[]; skipped: number } {
  const items: ExamReviewItem[] = [];
  exam.questions.forEach((q, i) => {
    const o = exam.outcomes?.[i];
    if (o !== 'correct' && o !== 'wrong') return;
    items.push({
      cardId: q.cardId,
      logId: `${exam.id}-${i + 1}`,
      rating: o === 'correct' ? 3 : 1,
      durationMs: Math.min(MAX_REVIEW_MS, q.spentMs),
    });
  });
  return { items, skipped: exam.questions.length - items.length };
}

export function withReviewApplied(
  exam: ExamSession,
  applied: { logs: ExamReviewApplied['logs']; skipped: number },
  now: DateInput,
): ExamSession {
  return exam.phase === 'finished'
    ? { ...exam, review: { at: toIso(toMs(now)), ...applied, undoneAt: null } }
    : exam;
}

export function withReviewUndone(exam: ExamSession, now: DateInput): ExamSession {
  return exam.review ? { ...exam, review: { ...exam.review, undoneAt: toIso(toMs(now)) } } : exam;
}

/** The exam is counted as review right now (applied and not undone). */
export const isCountedAsReview = (exam: Pick<ExamSession, 'review'>): boolean =>
  exam.review !== null && exam.review.undoneAt === null;

// ---------------------------------------------------------------------------------------------
// History (last 20, device-local summaries; no question text)
// ---------------------------------------------------------------------------------------------

export const ExamHistoryEntry = z.object({
  id: Id,
  startedAt: IsoDate,
  finishedAt: IsoDate,
  scopeLabel: z.string().min(1).max(300),
  /** Present for an exam over a syllabus (an id, never a title or card text). */
  syllabusId: Id.optional(),
  total: z.number().int().min(1).max(EXAM_MAX_QUESTIONS),
  correct: z.number().int().min(0),
  wrong: z.number().int().min(0),
  unanswered: z.number().int().min(0),
  void: z.number().int().min(0),
  minutes: z.number().int().min(1).max(EXAM_MAX_MINUTES).nullable(),
  usedMs: z.number().int().min(0),
  timedOut: z.boolean(),
  countedAsReview: z.boolean(),
});
export type ExamHistoryEntry = z.infer<typeof ExamHistoryEntry>;

/** The summary of a finished exam; null before it is finished. */
export function historyEntry(exam: ExamSession): ExamHistoryEntry | null {
  if (exam.phase !== 'finished' || exam.outcomes === null || exam.finishedAt === null) return null;
  const score = scoreOutcomes(exam.outcomes);
  const timing = examTiming(exam);
  return {
    id: exam.id,
    startedAt: exam.startedAt,
    finishedAt: exam.finishedAt,
    scopeLabel: exam.scopeLabel,
    ...(exam.scope.kind === 'syllabus' ? { syllabusId: exam.scope.syllabusId } : {}),
    total: score.total,
    correct: score.correct,
    wrong: score.wrong,
    unanswered: score.unanswered,
    void: score.void,
    minutes: exam.minutes,
    usedMs: Math.round(timing.usedMs),
    timedOut: timing.timedOut,
    countedAsReview: isCountedAsReview(exam),
  };
}

/** Add or replace an entry (by exam id); newest first; at most `EXAM_HISTORY_LIMIT`. */
export function pushHistory(
  list: readonly ExamHistoryEntry[],
  entry: ExamHistoryEntry,
): ExamHistoryEntry[] {
  return [entry, ...list.filter((e) => e.id !== entry.id)]
    .sort((a, b) => (a.finishedAt < b.finishedAt ? 1 : a.finishedAt > b.finishedAt ? -1 : 0))
    .slice(0, EXAM_HISTORY_LIMIT);
}

/** Entries that validate, in the stored order; anything else is dropped, never repaired. */
export function parseExamHistory(value: unknown): ExamHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((v) => {
      const r = ExamHistoryEntry.safeParse(v);
      return r.success ? [r.data] : [];
    })
    .slice(0, EXAM_HISTORY_LIMIT);
}

// ---------------------------------------------------------------------------------------------
// What the person answered, and Markdown export
// ---------------------------------------------------------------------------------------------

/** The correct answer as text: the key of a multiple-choice card, the back of any other. */
export function correctAnswerText(card: ExamCardView): string {
  if (card.cardType === 'mcq') {
    return card.choices?.find((c) => c.id === card.answerChoiceId)?.text ?? card.back;
  }
  return card.back;
}

/** What the person gave, as text, or null when they gave nothing. */
export function givenAnswerText(q: ExamQuestion, card: ExamCardView | null): string | null {
  if (q.kind === 'mcq') {
    return q.choiceId === null
      ? null
      : (card?.choices?.find((c) => c.id === q.choiceId)?.text ?? null);
  }
  return q.text.trim() === '' ? null : q.text.trim();
}

const escMd = (s: string): string =>
  s
    .replace(/\s*\r?\n\s*/g, ' ')
    .replace(/([\\`*_{}[\]<>#|~])/g, '\\$1')
    .trim();

const cell = escMd;
const pct = (n: number | null): string => (n === null ? 'n/a' : `${Math.round(n * 100)}%`);
const OUTCOME_LABEL: Record<ExamOutcome, string> = {
  correct: 'correct',
  wrong: 'wrong',
  unanswered: 'unanswered',
  void: 'not scored (card removed)',
};

/**
 * The results as Markdown. Card text is escaped, so a quote containing markup stays inert text in
 * whatever reads the file. Needs a finished exam.
 */
export function examToMarkdown(
  exam: ExamSession,
  cards: ReadonlyMap<string, ExamCardView>,
): string {
  const outcomes = exam.outcomes ?? gradeExam(exam, cards);
  const score = scoreOutcomes(outcomes);
  const timing = examTiming(exam);
  const parts = examBreakdown(exam, outcomes);
  const lines: string[] = [
    `# Exam results: ${escMd(exam.scopeLabel)}`,
    '',
    `- Finished: ${exam.finishedAt ?? exam.lastAt}`,
    `- Score: ${pct(score.fraction)} (${score.correct} of ${score.graded} correct, ${score.wrong} wrong, ${score.unanswered} unanswered${score.void > 0 ? `, ${score.void} not scored` : ''})`,
    `- Time: ${examDuration(timing.usedMs)}${
      timing.limitMs === null
        ? ' (no time limit)'
        : ` of ${exam.minutes} min${timing.timedOut ? ', time ran out' : ''}`
    }`,
    `- Counted as review: ${isCountedAsReview(exam) ? 'yes' : 'no'}`,
    '',
  ];
  const table = (title: string, first: string, rows: BreakdownRow[]) => {
    if (rows.length === 0) return;
    lines.push(
      `## ${title}`,
      '',
      `| ${first} | Questions | Correct | Score |`,
      '| --- | --- | --- | --- |',
    );
    for (const r of rows) {
      lines.push(`| ${cell(r.label)} | ${r.total} | ${r.correct} | ${pct(r.correct / r.total)} |`);
    }
    lines.push('');
  };
  table('By topic', 'Topic', parts.topics);
  table('By bank', 'Bank', parts.banks);
  table('By tag', 'Tag', parts.tags);

  lines.push('## Time per question', '', '| # | Result | Time |', '| --- | --- | --- |');
  exam.questions.forEach((q, i) => {
    lines.push(
      `| ${i + 1} | ${OUTCOME_LABEL[outcomes[i] ?? 'void']} | ${examDuration(q.spentMs)} |`,
    );
  });
  lines.push('');

  const missed = exam.questions.flatMap((q, i) => {
    const o = outcomes[i] ?? 'void';
    return o === 'wrong' || o === 'unanswered' ? [{ q, i, o }] : [];
  });
  lines.push('## Missed questions', '');
  if (missed.length === 0) lines.push('None.', '');
  for (const { q, i, o } of missed) {
    const card = cards.get(q.cardId) ?? null;
    lines.push(`### ${i + 1}. ${card ? escMd(card.front).slice(0, 300) : '(card removed)'}`, '');
    lines.push(`- Result: ${OUTCOME_LABEL[o]}`);
    lines.push(`- Your answer: ${escMd(givenAnswerText(q, card) ?? 'no answer')}`);
    if (card) lines.push(`- Correct answer: ${escMd(correctAnswerText(card))}`);
    lines.push(`- Time: ${examDuration(q.spentMs)}`, '');
    const quote = card?.sourceQuote?.trim();
    if (quote) {
      for (const l of quote.split(/\r?\n/)) lines.push(`> ${escMd(l)}`);
      lines.push('');
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
