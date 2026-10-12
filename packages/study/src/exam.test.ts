// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { Id } from '@shared/schema';
import type { ExamSyllabusInput } from './examSyllabus';
import { seededRandom } from './random';
import {
  EXAM_HISTORY_LIMIT,
  EXAM_MAX_MINUTES,
  EXAM_MAX_QUESTIONS,
  EXAM_TTL_MS,
  ExamHistoryEntry,
  ExamSession,
  chooseOption,
  correctAnswerText,
  createExam,
  crossedMilestones,
  endAnswering,
  examBreakdown,
  examChoiceRandom,
  examDuration,
  examMilestones,
  examRemainingMs,
  examScopeOptions,
  examTiming,
  examToMarkdown,
  finishExam,
  formatClock,
  givenAnswerText,
  goToQuestion,
  gradeExam,
  historyEntry,
  inExamScope,
  isCountedAsReview,
  markRecall,
  markRemaining,
  milestoneMessage,
  outcomeOf,
  parseExamHistory,
  parseExamSession,
  pendingMarks,
  planExamReview,
  pushHistory,
  resumeExam,
  scoreOutcomes,
  tickExam,
  typeAnswer,
  upgradeExamSession,
  validateExamConfig,
  withReviewApplied,
  withReviewUndone,
  type ExamCardFacts,
  type ExamCardView,
  type ExamConfig,
  type ExamOutcome,
  type ExamSession as ExamSessionValue,
} from './exam';

const MIN = 60_000;
const T0 = Date.parse('2026-03-10T12:00:00.000Z');
const ALL: ExamConfig['scope'] = { kind: 'all' };

const cardId = (n: number) => `card-${String(n).padStart(6, '0')}`;

function facts(
  n: number,
  over: (i: number) => Partial<ExamCardFacts> = () => ({}),
): ExamCardFacts[] {
  return Array.from({ length: n }, (_, k) => ({
    cardId: cardId(k + 1),
    cardType: 'basic' as const,
    bankId: 'bank-cardio',
    bankIds: ['bank-cardio'],
    folderIds: [],
    tags: [],
    ...over(k + 1),
  }));
}

const config = (over: Partial<ExamConfig> = {}): ExamConfig => ({
  scope: ALL,
  scopeLabel: 'All cards',
  questions: 10,
  minutes: 30,
  shuffle: true,
  ...over,
});

function make(
  cards: readonly ExamCardFacts[],
  over: Partial<ExamConfig> = {},
  rnd = 0.25,
  at = T0,
): ExamSessionValue {
  return createExam({
    id: 'exam-0001',
    now: at,
    random: () => rnd,
    config: config(over),
    cards,
    bankNames: { 'bank-cardio': 'Cardiology', 'bank-pharm': 'Pharmacology' },
  });
}

/** A view of a card as scoring sees it. */
const view = (over: Partial<ExamCardView> = {}): ExamCardView => ({
  cardType: 'basic',
  front: 'What is the SA node?',
  back: 'The pacemaker',
  sourceQuote: null,
  ...over,
});
const mcqView = (over: Partial<ExamCardView> = {}): ExamCardView =>
  view({
    cardType: 'mcq',
    front: 'Which node paces the heart?',
    back: 'SA node',
    choices: [
      { id: 'ch1', text: 'SA node' },
      { id: 'ch2', text: 'AV node' },
    ],
    answerChoiceId: 'ch1',
    ...over,
  });

describe('scope', () => {
  const pool: ExamCardFacts[] = [
    ...facts(1, () => ({
      bankIds: ['bank-cardio'],
      folderIds: ['f-physio', 'f-heart'],
      tags: ['Pearl'],
    })),
    ...facts(1, () => ({
      cardId: cardId(2),
      bankId: 'bank-pharm',
      bankIds: ['bank-pharm', 'bank-cardio'],
      folderIds: ['f-drugs'],
      tags: ['pearl', 'Drug'],
    })),
    ...facts(1, () => ({ cardId: cardId(3), bankId: null, bankIds: [], tags: [] })),
  ];

  it('all, bank, folder (with its ancestors) and tag (case-insensitive) select the right cards', () => {
    const ids = (scope: ExamConfig['scope']) =>
      pool.filter((c) => inExamScope(c, scope)).map((c) => c.cardId);
    expect(ids(ALL)).toEqual([cardId(1), cardId(2), cardId(3)]);
    expect(ids({ kind: 'bank', bankId: 'bank-cardio' })).toEqual([cardId(1), cardId(2)]);
    expect(ids({ kind: 'bank', bankId: 'bank-pharm' })).toEqual([cardId(2)]);
    expect(ids({ kind: 'folder', bankId: 'bank-cardio', folderId: 'f-physio' })).toEqual([
      cardId(1),
    ]);
    expect(ids({ kind: 'folder', bankId: 'bank-cardio', folderId: 'f-heart' })).toEqual([
      cardId(1),
    ]);
    expect(ids({ kind: 'tag', tag: 'PEARL' })).toEqual([cardId(1), cardId(2)]);
    expect(ids({ kind: 'tag', tag: 'nothing' })).toEqual([]);
  });

  it('scope options list only scopes with cards, with their real counts', () => {
    const options = examScopeOptions({
      cards: pool,
      banks: [
        { id: 'bank-cardio', name: 'Cardiology' },
        { id: 'bank-pharm', name: 'Pharmacology' },
        { id: 'bank-empty', name: 'Empty' },
      ],
      folders: [
        { id: 'f-physio', bankId: 'bank-cardio', path: ['Physiology'] },
        { id: 'f-heart', bankId: 'bank-cardio', path: ['Physiology', 'Heart'] },
        { id: 'f-none', bankId: 'bank-cardio', path: ['Unused'] },
      ],
    });
    expect(options.map((o) => [o.label, o.available])).toEqual([
      ['All cards', 3],
      ['Bank: Cardiology', 2],
      ['Bank: Pharmacology', 1],
      ['Folder: Cardiology / Physiology', 1],
      ['Folder: Cardiology / Physiology / Heart', 1],
      ['Tag: Drug', 1],
      ['Tag: Pearl', 2],
    ]);
    expect(new Set(options.map((o) => o.value)).size).toBe(options.length);
  });
});

describe('configuration', () => {
  it('caps the question count by the cards available and says so', () => {
    expect(validateExamConfig({ questions: 50, minutes: null }, 12)).toEqual({
      ok: true,
      count: 12,
      capped: true,
    });
    expect(validateExamConfig({ questions: 12, minutes: 30 }, 12)).toEqual({
      ok: true,
      count: 12,
      capped: false,
    });
  });

  it('rejects counts and limits that make no sense, with a message per field', () => {
    for (const questions of [0, -1, 1.5, Number.NaN, EXAM_MAX_QUESTIONS + 1]) {
      const r = validateExamConfig({ questions, minutes: null }, 500);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.errors.questions).toBeTruthy();
    }
    for (const minutes of [0, -5, 2.5, Number.NaN, EXAM_MAX_MINUTES + 1]) {
      const r = validateExamConfig({ questions: 5, minutes }, 50);
      expect(!r.ok && r.errors.minutes).toBeTruthy();
    }
    const none = validateExamConfig({ questions: 5, minutes: 5 }, 0);
    expect(!none.ok && none.errors.questions).toMatch(/no cards/);
  });
});

describe('createExam', () => {
  const pool = facts(30, (i) => ({
    cardType: i % 5 === 0 ? ('mcq' as const) : ('basic' as const),
    tags: i % 2 === 0 ? ['even'] : [],
  }));

  it('is deterministic: the same random gives the same exam', () => {
    const a = make(pool, {}, 0.37);
    const b = make(pool, {}, 0.37);
    expect(a).toEqual(b);
    expect(make(pool, {}, 0.38).questions.map((q) => q.cardId)).not.toEqual(
      a.questions.map((q) => q.cardId),
    );
  });

  it('draws the cards from the seed, not from the order the pool arrives in', () => {
    const reversed = [...pool].reverse();
    expect(make(reversed, {}, 0.5).questions.map((q) => q.cardId)).toEqual(
      make(pool, {}, 0.5).questions.map((q) => q.cardId),
    );
  });

  it('asks each card at most once and never more than were available', () => {
    const exam = make(pool, { questions: 200 });
    const ids = exam.questions.map((q) => q.cardId);
    expect(ids).toHaveLength(30);
    expect(new Set(ids).size).toBe(30);
    expect(make(pool, { questions: 7 }).questions).toHaveLength(7);
  });

  it('keeps creation order without shuffle, and a different order with it', () => {
    const plain = make(pool, { questions: 30, shuffle: false });
    const ids = plain.questions.map((q) => q.cardId);
    expect(ids).toEqual([...ids].sort());
    const shuffled = make(pool, { questions: 30, shuffle: true });
    expect(shuffled.questions.map((q) => q.cardId)).not.toEqual(ids);
    expect([...shuffled.questions.map((q) => q.cardId)].sort()).toEqual(ids);
  });

  it('chooses a subset from the whole pool, not the first cards', () => {
    const exam = make(pool, { questions: 5, shuffle: false }, 0.9);
    expect(exam.questions.map((q) => q.cardId)).not.toEqual(pool.slice(0, 5).map((c) => c.cardId));
  });

  it('applies the scope, maps card types to question kinds and records the deadline', () => {
    const exam = make(pool, { scope: { kind: 'tag', tag: 'EVEN' }, questions: 100, minutes: 12 });
    expect(exam.questions).toHaveLength(15);
    expect(exam.questions.every((q) => q.tags.includes('even'))).toBe(true);
    expect(exam.questions.find((q) => q.cardId === cardId(10))?.kind).toBe('mcq');
    expect(exam.questions.find((q) => q.cardId === cardId(2))?.kind).toBe('recall');
    expect(exam.deadlineAt).toBe(new Date(T0 + 12 * MIN).toISOString());
    expect(exam.expiresAt).toBe(new Date(T0 + EXAM_TTL_MS).toISOString());
    expect(exam.bankNames).toEqual({ 'bank-cardio': 'Cardiology' });
    expect(make(pool, { minutes: null }).deadlineAt).toBeNull();
  });

  it('refuses an invalid configuration or an empty scope', () => {
    expect(() => make(pool, { questions: 0 })).toThrow(RangeError);
    expect(() => make(pool, { minutes: 0 })).toThrow(RangeError);
    expect(() => make(pool, { scope: { kind: 'bank', bankId: 'bank-missing' } })).toThrow(
      /no cards/,
    );
    expect(() => make([], {})).toThrow(RangeError);
  });

  it('produces a value its own schema accepts, even after a JSON round trip', () => {
    const exam = make(pool);
    expect(ExamSession.safeParse(exam).success).toBe(true);
    expect(ExamSession.parse(JSON.parse(JSON.stringify(exam)))).toEqual(exam);
    for (const q of exam.questions) expect(Id.safeParse(q.cardId).success).toBe(true);
  });

  it('shuffles one multiple-choice list the same way every time, differently per card and seed', () => {
    const a = examChoiceRandom({ seed: 7 }, cardId(1));
    const b = examChoiceRandom({ seed: 7 }, cardId(1));
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    expect(examChoiceRandom({ seed: 7 }, cardId(2))()).not.toBe(
      examChoiceRandom({ seed: 7 }, cardId(1))(),
    );
    expect(examChoiceRandom({ seed: 8 }, cardId(1))()).not.toBe(
      examChoiceRandom({ seed: 7 }, cardId(1))(),
    );
  });
});

describe('the timer', () => {
  const exam = make(facts(5), { questions: 5, minutes: 30 });

  it('counts down to zero and never below; untimed exams have no remaining time', () => {
    expect(examRemainingMs(exam, T0)).toBe(30 * MIN);
    expect(examRemainingMs(exam, T0 + 10 * MIN)).toBe(20 * MIN);
    expect(examRemainingMs(exam, T0 + 31 * MIN)).toBe(0);
    expect(examRemainingMs(make(facts(5), { questions: 5, minutes: null }), T0)).toBeNull();
    expect(examRemainingMs({ ...exam, phase: 'marking' }, T0)).toBe(0);
  });

  it('announces at 50%, 10%, one minute and the end, in that order, once each', () => {
    expect(examMilestones(30 * MIN)).toEqual([
      { id: 'half', remainingMs: 15 * MIN },
      { id: 'tenth', remainingMs: 3 * MIN },
      { id: 'minute', remainingMs: MIN },
      { id: 'timeup', remainingMs: 0 },
    ]);
    const at = (minutes: number) => crossedMilestones(exam, T0 + minutes * MIN);
    expect(at(0)).toEqual([]);
    expect(at(14.9)).toEqual([]);
    expect(at(15)).toEqual(['half']);
    expect(at(27)).toEqual(['half', 'tenth']);
    expect(at(29)).toEqual(['half', 'tenth', 'minute']);
    expect(at(30)).toEqual(['half', 'tenth', 'minute', 'timeup']);
    expect(
      crossedMilestones(make(facts(5), { questions: 5, minutes: null }), T0 + 99 * MIN),
    ).toEqual([]);
  });

  it('drops a milestone that would repeat another or fall at the start', () => {
    // 10 min: a tenth IS one minute; 2 min: half IS one minute; 1 min: one minute is the start.
    expect(examMilestones(10 * MIN).map((m) => m.id)).toEqual(['half', 'minute', 'timeup']);
    expect(examMilestones(2 * MIN).map((m) => m.id)).toEqual(['half', 'tenth', 'timeup']);
    expect(examMilestones(MIN).map((m) => m.id)).toEqual(['half', 'tenth', 'timeup']);
    // 90 min is long enough for all three, 5 min too.
    expect(examMilestones(90 * MIN).map((m) => m.id)).toEqual([
      'half',
      'tenth',
      'minute',
      'timeup',
    ]);
    expect(examMilestones(5 * MIN).map((m) => m.remainingMs)).toEqual([150_000, 60_000, 30_000, 0]);
  });

  it('says what is left in words, and the visible clock rounds up', () => {
    expect(milestoneMessage('half', 30 * MIN)).toBe(
      'Half of the time has passed. About 15 minutes left.',
    );
    expect(milestoneMessage('tenth', 30 * MIN)).toBe(
      'Ten percent of the time is left: about 3 minutes.',
    );
    expect(milestoneMessage('minute', 30 * MIN)).toBe('One minute left.');
    expect(milestoneMessage('timeup', 30 * MIN)).toMatch(/^Time is up/);
    expect(milestoneMessage('tenth', 5 * MIN)).toMatch(/30 seconds/);
    expect(formatClock(30 * MIN)).toBe('30:00');
    expect(formatClock(61_000)).toBe('01:01');
    expect(formatClock(400)).toBe('00:01');
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(3_725_000)).toBe('1:02:05');
    expect(examDuration(45_000)).toBe('45 s');
    expect(examDuration(125_000)).toBe('2 min 05 s');
    expect(examDuration(3_720_000)).toBe('1 h 02 min');
  });
});

describe('answering', () => {
  const pool = facts(4, (i) => ({ cardType: i === 1 ? ('mcq' as const) : ('basic' as const) }));
  const base = make(pool, { questions: 4, shuffle: false, minutes: 10 });

  it('records a choice for a multiple-choice question and a typed answer for a recall one', () => {
    const mcq = base.questions.findIndex((q) => q.kind === 'mcq');
    const recall = base.questions.findIndex((q) => q.kind === 'recall');
    let e = chooseOption(base, mcq, 'ch2', T0 + 1000);
    expect(e.questions[mcq]?.choiceId).toBe('ch2');
    e = chooseOption(e, mcq, null, T0 + 2000);
    expect(e.questions[mcq]?.choiceId).toBeNull();
    e = typeAnswer(e, recall, 'the pacemaker', T0 + 3000);
    expect(e.questions[recall]?.text).toBe('the pacemaker');
    // The wrong kind of answer is ignored, not stored.
    expect(chooseOption(base, recall, 'ch1', T0 + 1000).questions[recall]?.choiceId).toBeNull();
    expect(typeAnswer(base, mcq, 'text', T0 + 1000).questions[mcq]?.text).toBe('');
    // Inputs are never mutated.
    expect(base.questions[mcq]?.choiceId).toBeNull();
  });

  it('charges time to the question on screen and moves between questions', () => {
    let e = goToQuestion(base, 0, T0 + 5_000);
    expect(e.questions[0]?.spentMs).toBe(5_000);
    e = goToQuestion(e, 2, T0 + 20_000);
    expect(e.current).toBe(2);
    expect(e.questions[0]?.spentMs).toBe(20_000);
    e = chooseOption(e, 1, 'ch1', T0 + 26_000);
    expect(e.questions[2]?.spentMs).toBe(6_000);
    expect(goToQuestion(e, 99, T0 + 27_000).current).toBe(2);
    expect(goToQuestion(e, -1, T0 + 27_000).current).toBe(2);
  });

  it('never charges negative time when the device clock goes back', () => {
    let e = goToQuestion(base, 1, T0 + 10_000);
    e = goToQuestion(e, 0, T0 + 4_000);
    expect(e.questions.map((q) => q.spentMs)).toEqual([10_000, 0, 0, 0]);
    expect(e.lastAt).toBe(new Date(T0 + 4_000).toISOString());
  });

  it('ends at the deadline whenever the end is noticed, and drops an answer that comes late', () => {
    const late = chooseOption(base, 0, 'ch1', T0 + 10 * MIN + 5_000);
    expect(late.phase).toBe('marking');
    expect(late.endReason).toBe('timeup');
    expect(late.endedAt).toBe(new Date(T0 + 10 * MIN).toISOString());
    expect(late.questions[0]?.choiceId).toBeNull();
    expect(late.questions[0]?.spentMs).toBe(10 * MIN);
    // One millisecond before the deadline still counts.
    const edge = chooseOption(
      make(pool, { minutes: 10, shuffle: false }),
      0,
      'ch1',
      T0 + 10 * MIN - 1,
    );
    expect(edge.phase).toBe('answering');
    expect(edge.questions[0]?.choiceId).toBe('ch1');
    expect(tickExam(base, T0 + 10 * MIN).phase).toBe('marking');
  });

  it('ticking is idempotent and an untimed exam never runs out', () => {
    const ended = tickExam(base, T0 + 11 * MIN);
    expect(tickExam(ended, T0 + 12 * MIN)).toBe(ended);
    const untimed = make(pool, { minutes: null });
    expect(tickExam(untimed, T0 + 1000 * MIN)).toBe(untimed);
  });

  it('finishing by hand records "submitted" at that moment', () => {
    const e = endAnswering(chooseOption(base, 1, 'ch1', T0 + 1_000), T0 + 9_000);
    expect(e.phase).toBe('marking');
    expect(e.endReason).toBe('submitted');
    expect(e.endedAt).toBe(new Date(T0 + 9_000).toISOString());
    // Pressing finish after the deadline is the deadline's doing.
    expect(endAnswering(base, T0 + 12 * MIN).endReason).toBe('timeup');
    // Nothing changes once answering is over.
    expect(chooseOption(e, 1, 'ch2', T0 + 10_000)).toBe(e);
    expect(goToQuestion(e, 0, T0 + 10_000)).toBe(e);
    expect(endAnswering(e, T0 + 10_000)).toBe(e);
  });
});

describe('resuming', () => {
  const base = make(facts(3), { questions: 3, minutes: 10, shuffle: false });

  it('a reload before the deadline continues without charging the time away to a question', () => {
    const answered = goToQuestion(base, 1, T0 + 2 * MIN);
    const back = resumeExam(answered, T0 + 6 * MIN);
    expect(back.timedOut).toBe(false);
    expect(back.exam.phase).toBe('answering');
    expect(back.exam.current).toBe(1);
    expect(back.exam.lastAt).toBe(new Date(T0 + 6 * MIN).toISOString());
    expect(back.exam.questions[1]?.spentMs).toBe(0);
    // The clock itself never paused.
    expect(examRemainingMs(back.exam, T0 + 6 * MIN)).toBe(4 * MIN);
  });

  it('a reload after the deadline lands in marking with the answers kept', () => {
    const answered = typeAnswer(base, 0, 'kept', T0 + MIN);
    const back = resumeExam(answered, T0 + 3 * 60 * MIN);
    expect(back.timedOut).toBe(true);
    expect(back.exam.phase).toBe('marking');
    expect(back.exam.questions[0]?.text).toBe('kept');
    expect(back.exam.endedAt).toBe(new Date(T0 + 10 * MIN).toISOString());
  });

  it('a marking or finished exam is returned as it is', () => {
    const marking = endAnswering(base, T0 + MIN);
    expect(resumeExam(marking, T0 + 5 * MIN)).toEqual({ exam: marking, timedOut: false });
  });

  it('survives a JSON round trip mid-exam and is dropped after 24 hours', () => {
    const mid = chooseOption(typeAnswer(base, 0, 'half done', T0 + 1000), 1, 'ch1', T0 + 2000);
    const stored = JSON.parse(JSON.stringify(mid)) as unknown;
    const loaded = parseExamSession(stored, T0 + 3 * MIN);
    expect(loaded).toEqual({ session: mid, expired: false });
    expect(parseExamSession(stored, T0 + EXAM_TTL_MS - 1).session).not.toBeNull();
    expect(parseExamSession(stored, T0 + EXAM_TTL_MS)).toEqual({ session: null, expired: true });
  });

  it('rejects garbage and inconsistent sessions instead of resuming them', () => {
    expect(parseExamSession(null, T0)).toEqual({ session: null, expired: false });
    expect(parseExamSession({ version: 2 }, T0).session).toBeNull();
    expect(parseExamSession({ ...base, current: 9 }, T0).session).toBeNull();
    const twice = { ...base, questions: [base.questions[0], base.questions[0]] };
    expect(parseExamSession(twice, T0).session).toBeNull();
    expect(parseExamSession({ ...base, phase: 'finished' }, T0).session).toBeNull();
    expect(parseExamSession({ ...base, minutes: null }, T0).session).toBeNull();
    expect(parseExamSession({ ...base, phase: 'marking' }, T0).session).toBeNull();
    expect(parseExamSession({ ...base, deadlineAt: 'soon' }, T0).session).toBeNull();
  });
});

describe('marking, scoring and the results', () => {
  const pool: ExamCardFacts[] = [
    ...facts(1, () => ({
      cardType: 'mcq' as const,
      bankId: 'bank-cardio',
      tags: ['Pearl'],
    })),
    ...facts(1, () => ({ cardId: cardId(2), bankId: 'bank-cardio', tags: ['Pearl', 'ECG'] })),
    ...facts(1, () => ({ cardId: cardId(3), bankId: 'bank-pharm', tags: ['ECG'] })),
    ...facts(1, () => ({ cardId: cardId(4), bankId: null, tags: [] })),
    ...facts(1, () => ({
      cardId: cardId(5),
      cardType: 'mcq' as const,
      bankId: 'bank-pharm',
      tags: [],
    })),
  ];
  const cards = new Map<string, ExamCardView>([
    [cardId(1), mcqView()],
    [cardId(2), view({ front: 'Recall 2' })],
    [
      cardId(3),
      view({ front: 'Recall 3', sourceQuote: 'Line one\n<script>alert(1)</script> | pipe' }),
    ],
    [cardId(4), view({ front: 'Recall 4' })],
    [cardId(5), mcqView({ front: 'Second mcq' })],
  ]);
  const exam = make(pool, { questions: 5, shuffle: false, minutes: 20 });
  const at = (n: number) => exam.questions.findIndex((q) => q.cardId === cardId(n));

  /** Everything answered: mcq 1 right, mcq 5 unanswered, recall 2 known, 3 not known, 4 left blank. */
  function finished(): ExamSessionValue {
    let e = chooseOption(exam, at(1), 'ch1', T0 + 30_000);
    e = typeAnswer(e, at(3), 'my attempt', T0 + 60_000);
    e = endAnswering(e, T0 + 5 * MIN);
    e = markRecall(e, at(2), 'know');
    e = markRecall(e, at(3), 'dont');
    e = markRecall(e, at(4), 'dont');
    return finishExam(e, gradeExam(e, cards), T0 + 6 * MIN);
  }

  it('scores multiple choice by the key and recall by the person, and counts unanswered against', () => {
    const f = finished();
    expect(f.phase).toBe('finished');
    expect(f.outcomes).toEqual(['correct', 'correct', 'wrong', 'wrong', 'unanswered']);
    expect(scoreOutcomes(f.outcomes ?? [])).toEqual({
      total: 5,
      correct: 2,
      wrong: 2,
      unanswered: 1,
      void: 0,
      graded: 5,
      fraction: 0.4,
    });
  });

  it('only a marking exam can be finished, with one outcome per question', () => {
    expect(finishExam(exam, [], T0)).toBe(exam);
    const marking = endAnswering(exam, T0 + MIN);
    expect(finishExam(marking, ['correct'], T0 + 2 * MIN)).toBe(marking);
    expect(markRecall(exam, at(2), 'know')).toBe(exam); // not while answering
    const done = finished();
    expect(finishExam(done, done.outcomes ?? [], T0)).toBe(done);
    expect(done.finishedAt).toBe(new Date(T0 + 6 * MIN).toISOString());
    expect(done.expiresAt).toBe(new Date(T0 + 6 * MIN + EXAM_TTL_MS).toISOString());
  });

  it('outcomeOf: a removed or changed card is void, never a wrong answer', () => {
    const q = (over: Partial<ExamSessionValue['questions'][number]> = {}) => ({
      ...(exam.questions[0] as ExamSessionValue['questions'][number]),
      kind: 'mcq' as const,
      ...over,
    });
    const table: [ExamOutcome, ReturnType<typeof q>, ExamCardView | null][] = [
      ['void', q({ choiceId: 'ch1' }), null],
      ['void', q({ choiceId: 'ch1' }), view()], // no longer multiple choice
      ['void', q({ choiceId: 'ch1' }), mcqView({ answerChoiceId: undefined })],
      ['unanswered', q({ choiceId: null }), mcqView()],
      ['unanswered', q({ choiceId: 'gone' }), mcqView()], // the option was removed since
      ['correct', q({ choiceId: 'ch1' }), mcqView()],
      ['wrong', q({ choiceId: 'ch2' }), mcqView()],
      ['correct', q({ kind: 'recall', mark: 'know' }), view()],
      ['wrong', q({ kind: 'recall', mark: 'dont' }), view()],
      ['unanswered', q({ kind: 'recall', mark: null }), view()],
      ['void', q({ kind: 'recall', mark: 'know' }), null],
    ];
    for (const [want, question, card] of table) expect(outcomeOf(question, card)).toBe(want);
  });

  it('a void question is left out of the score and the breakdown', () => {
    const f = finished();
    const without = new Map(cards);
    without.delete(cardId(2));
    const outcomes = gradeExam(f, without);
    expect(outcomes[at(2)]).toBe('void');
    const s = scoreOutcomes(outcomes);
    expect([s.total, s.graded, s.void, s.correct]).toEqual([5, 4, 1, 1]);
    expect(s.fraction).toBe(0.25);
    expect(scoreOutcomes(['void', 'void']).fraction).toBeNull();
  });

  it('pending marks ignore recall questions whose card is gone; the rest can be marked in bulk', () => {
    const marking = endAnswering(exam, T0 + MIN);
    expect(pendingMarks(marking, () => true)).toEqual([at(2), at(3), at(4)].sort((a, b) => a - b));
    expect(pendingMarks(marking, (id) => id !== cardId(3))).toEqual(
      [at(2), at(4)].sort((a, b) => a - b),
    );
    const some = markRecall(marking, at(2), 'know');
    const rest = markRemaining(some, 'dont', () => true);
    expect(rest.questions[at(2)]?.mark).toBe('know');
    expect(rest.questions[at(3)]?.mark).toBe('dont');
    expect(pendingMarks(rest, () => true)).toEqual([]);
    expect(markRemaining(exam, 'dont', () => true)).toBe(exam);
  });

  it('breaks the score down by bank and by tag, a question counting under each of its tags', () => {
    const f = finished();
    const parts = examBreakdown(f, f.outcomes ?? []);
    expect(parts.banks.map((b) => [b.label, b.total, b.correct, b.wrong, b.unanswered])).toEqual([
      ['Cardiology', 2, 2, 0, 0],
      ['No bank', 1, 0, 1, 0],
      ['Pharmacology', 2, 0, 1, 1],
    ]);
    expect(parts.tags.map((t) => [t.label, t.total, t.correct])).toEqual([
      ['ECG', 2, 1],
      ['Pearl', 2, 2],
    ]);
  });

  it('measures the time used, the limit and the average on the questions that were looked at', () => {
    const f = finished();
    const t = examTiming(f);
    expect(t.usedMs).toBe(5 * MIN);
    expect(t.limitMs).toBe(20 * MIN);
    expect(t.timedOut).toBe(false);
    expect(t.meanMs).toBe(5 * MIN); // all of it was spent on question 0
    const ran = tickExam(exam, T0 + 21 * MIN);
    expect(examTiming(ran)).toMatchObject({ usedMs: 20 * MIN, timedOut: true });
  });

  it('keeps the exam out of the review schedule until it is counted', () => {
    const f = finished();
    const plan = planExamReview(f);
    expect(plan.items.map((i) => [i.cardId, i.rating])).toEqual([
      [cardId(1), 3],
      [cardId(2), 3],
      [cardId(3), 1],
      [cardId(4), 1],
    ]);
    expect(plan.skipped).toBe(1); // the unanswered multiple choice
    expect(new Set(plan.items.map((i) => i.logId)).size).toBe(4);
    for (const item of plan.items) {
      expect(Id.safeParse(item.logId).success).toBe(true);
      expect(item.logId.startsWith(f.id)).toBe(true);
    }
    expect(plan.items[0]?.durationMs).toBe(5 * MIN); // capped at five minutes
    // Same exam, same keys: a second plan is identical, so applying twice cannot double-review.
    expect(planExamReview(f)).toEqual(plan);
    expect(planExamReview(exam).items).toEqual([]);
  });

  it('records that the exam was counted, and that it was undone', () => {
    const f = finished();
    expect(isCountedAsReview(f)).toBe(false);
    expect(withReviewApplied(exam, { logs: [], skipped: 0 }, T0)).toBe(exam);
    const logs = planExamReview(f).items.map(({ cardId: c, logId, rating }) => ({
      cardId: c,
      logId,
      rating,
    }));
    const counted = withReviewApplied(f, { logs, skipped: 1 }, T0 + 7 * MIN);
    expect(isCountedAsReview(counted)).toBe(true);
    expect(ExamSession.safeParse(counted).success).toBe(true);
    const undone = withReviewUndone(counted, T0 + 8 * MIN);
    expect(isCountedAsReview(undone)).toBe(false);
    expect(undone.review?.undoneAt).toBe(new Date(T0 + 8 * MIN).toISOString());
    expect(withReviewUndone(f, T0)).toBe(f);
  });

  it('exports Markdown with the score, the breakdown and the missed questions, with markup inert', () => {
    const md = examToMarkdown(finished(), cards);
    expect(md).toMatch(/^# Exam results: All cards$/m);
    expect(md).toContain('- Score: 40% (2 of 5 correct, 2 wrong, 1 unanswered)');
    expect(md).toContain('- Time: 5 min 00 s of 20 min');
    expect(md).toContain('| Cardiology | 2 | 2 | 100% |');
    expect(md).toContain('## Missed questions');
    expect(md).toContain('### 3. Recall 3');
    expect(md).toContain('- Your answer: my attempt');
    expect(md).toContain('- Correct answer: The pacemaker');
    expect(md).toContain('- Your answer: no answer');
    // A quote with markup, a pipe and a line break cannot add a heading, a tag or a table cell.
    expect(md).toContain('> Line one');
    expect(md).toContain('> \\<script\\>alert(1)\\</script\\> \\| pipe');
    expect(md).not.toContain('<script>');
    expect(md.endsWith('\n')).toBe(true);
  });

  it('answer texts: the key of a multiple-choice card, what was picked, what was typed', () => {
    expect(correctAnswerText(mcqView())).toBe('SA node');
    expect(correctAnswerText(view())).toBe('The pacemaker');
    const q = (over: Partial<ExamSessionValue['questions'][number]>) => ({
      ...(exam.questions[0] as ExamSessionValue['questions'][number]),
      ...over,
    });
    expect(givenAnswerText(q({ kind: 'mcq', choiceId: 'ch2' }), mcqView())).toBe('AV node');
    expect(givenAnswerText(q({ kind: 'mcq', choiceId: null }), mcqView())).toBeNull();
    expect(givenAnswerText(q({ kind: 'recall', text: '  typed  ' }), view())).toBe('typed');
    expect(givenAnswerText(q({ kind: 'recall', text: '   ' }), view())).toBeNull();
  });
});

describe('history', () => {
  const entry = (n: number, over: Record<string, unknown> = {}) => ({
    id: `exam-${String(n).padStart(4, '0')}`,
    startedAt: new Date(T0 + n * MIN).toISOString(),
    finishedAt: new Date(T0 + n * MIN + 5000).toISOString(),
    scopeLabel: 'All cards',
    total: 10,
    correct: 6,
    wrong: 3,
    unanswered: 1,
    void: 0,
    minutes: 15,
    usedMs: 600_000,
    timedOut: false,
    countedAsReview: false,
    ...over,
  });

  it('keeps the newest twenty, newest first, one per exam', () => {
    let list: ReturnType<typeof parseExamHistory> = [];
    for (let n = 1; n <= 25; n += 1) list = pushHistory(list, entry(n));
    expect(list).toHaveLength(EXAM_HISTORY_LIMIT);
    expect(list[0]?.id).toBe('exam-0025');
    expect(list[19]?.id).toBe('exam-0006');
    const again = pushHistory(list, entry(25, { countedAsReview: true, correct: 7 }));
    expect(again).toHaveLength(EXAM_HISTORY_LIMIT);
    expect(again[0]).toMatchObject({ id: 'exam-0025', countedAsReview: true, correct: 7 });
  });

  it('parsing drops what does not validate and never repairs it', () => {
    const stored = [entry(1), { ...entry(2), total: 0 }, 'junk', null, entry(3)];
    expect(parseExamHistory(stored).map((e) => e.id)).toEqual(['exam-0001', 'exam-0003']);
    expect(parseExamHistory({ not: 'a list' })).toEqual([]);
    expect(parseExamHistory(undefined)).toEqual([]);
  });

  it('summarises a finished exam, and only a finished one', () => {
    const e = make(facts(2), { questions: 2, minutes: null, shuffle: false });
    expect(historyEntry(e)).toBeNull();
    const done = finishExam(endAnswering(e, T0 + 2 * MIN), ['correct', 'void'], T0 + 3 * MIN);
    expect(historyEntry(done)).toEqual({
      id: 'exam-0001',
      startedAt: new Date(T0).toISOString(),
      finishedAt: new Date(T0 + 3 * MIN).toISOString(),
      scopeLabel: 'All cards',
      total: 2,
      correct: 1,
      wrong: 0,
      unanswered: 0,
      void: 1,
      minutes: null,
      usedMs: 2 * MIN,
      timedOut: false,
      countedAsReview: false,
    });
  });
});

describe('determinism', () => {
  it('the injected random is the only source of chance', () => {
    const pool = facts(40);
    const run = (seed: number) => make(pool, { questions: 12 }, seededRandom(seed)());
    expect(run(1)).toEqual(run(1));
    expect(run(1).seed).not.toBe(run(2).seed);
  });
});

describe('the persisted exam across versions', () => {
  const plain = () => make(facts(3), { questions: 3, minutes: null });

  it('carries a stored version 1 exam over: no syllabus, no topic on any question', () => {
    const now = plain();
    const old = JSON.parse(JSON.stringify(now)) as Record<string, unknown>;
    old.version = 1;
    delete old.syllabus;
    for (const q of old.questions as Record<string, unknown>[]) delete q.topicId;
    const loaded = parseExamSession(old, T0 + MIN);
    expect(loaded.unreadable).toBeUndefined();
    expect(loaded.session).toEqual(now);
    // Upgrading is idempotent and leaves anything else alone.
    expect(upgradeExamSession(upgradeExamSession(old))).toEqual(upgradeExamSession(old));
    expect(upgradeExamSession('garbage')).toBe('garbage');
    expect(upgradeExamSession({ version: 2, x: 1 })).toEqual({ version: 2, x: 1 });
  });

  it('says a row it cannot read was unreadable (another version, damage), and nothing for no row', () => {
    const now = plain();
    expect(parseExamSession({ ...now, version: 3 }, T0)).toEqual({
      session: null,
      expired: false,
      unreadable: true,
    });
    expect(parseExamSession({ nonsense: true }, T0).unreadable).toBe(true);
    expect(parseExamSession(undefined, T0)).toEqual({ session: null, expired: false });
    // An old row that is also past its 24 hours is simply expired.
    const old = { ...JSON.parse(JSON.stringify(now)), version: 1 } as Record<string, unknown>;
    expect(parseExamSession(old, T0 + EXAM_TTL_MS)).toEqual({ session: null, expired: true });
  });

  it('rejects a syllabus exam that does not keep its outline, and a question of an unknown topic', () => {
    const now = plain();
    const scope = { kind: 'syllabus', syllabusId: 'syllabus-0001', topicId: null, weighted: false };
    expect(parseExamSession({ ...now, scope }, T0).session).toBeNull();
    const withSyllabus = {
      ...now,
      syllabus: { topics: [{ id: 'topic-001', title: 'Heart' }], skipped: [], undrawn: 0 },
    };
    expect(parseExamSession(withSyllabus, T0).session).toBeNull(); // not a syllabus scope
    const asked = {
      ...withSyllabus,
      scope,
      questions: now.questions.map((q, i) => (i === 0 ? { ...q, topicId: 'topic-999' } : q)),
    };
    expect(parseExamSession(asked, T0).session).toBeNull();
    const fine = {
      ...withSyllabus,
      scope,
      questions: now.questions.map((q, i) => (i === 0 ? { ...q, topicId: 'topic-001' } : q)),
    };
    expect(parseExamSession(fine, T0).session).not.toBeNull();
  });
});

describe('an exam over a syllabus: results by topic', () => {
  const topics = [
    {
      id: 'topic-0A',
      title: 'Cardiology',
      depth: 1,
      parentId: null,
      bankIds: ['bank-cardio'],
      tagIds: [],
    },
    {
      id: 'topic-0B',
      title: 'Renal',
      depth: 1,
      parentId: null,
      bankIds: ['bank-renal'],
      tagIds: [],
    },
  ];
  const cards: ExamCardFacts[] = [
    ...facts(3, (i) => ({
      bankIds: ['bank-cardio'],
      bankId: 'bank-cardio',
      tags: i === 1 ? ['Pearl'] : [],
    })),
    ...[4, 5].map((n) => ({
      ...facts(1)[0]!,
      cardId: cardId(n),
      bankId: 'bank-renal',
      bankIds: ['bank-renal'],
    })),
  ];
  const syllabus: ExamSyllabusInput = {
    topics,
    refs: new Map(
      cards.map((c) => [c.cardId, { bankIds: c.bankIds, tagIds: [] as string[] }] as const),
    ),
  };
  const exam = () =>
    createExam({
      id: 'exam-0001',
      now: T0,
      random: () => 0.25,
      config: {
        scope: { kind: 'syllabus', syllabusId: 'syllabus-0001', topicId: null, weighted: false },
        scopeLabel: 'Syllabus: Boards',
        questions: 5,
        minutes: null,
        shuffle: false,
      },
      cards,
      bankNames: { 'bank-cardio': 'Cardiology', 'bank-renal': 'Renal' },
      syllabus,
    });

  it('breaks the score down per topic in outline order, each question under one topic', () => {
    const e = exam();
    const outcomes: ExamOutcome[] = ['correct', 'wrong', 'unanswered', 'correct', 'void'];
    const rows = examBreakdown(e, outcomes).topics;
    expect(rows.map((r) => [r.key, r.label, r.total, r.correct, r.wrong, r.unanswered])).toEqual([
      ['topic-0A', 'Cardiology', 3, 1, 1, 1],
      ['topic-0B', 'Renal', 1, 1, 0, 0],
    ]);
    // An exam of another scope has no topic rows.
    expect(
      examBreakdown(make(facts(3), { questions: 3 }), ['correct', 'wrong', 'void']).topics,
    ).toEqual([]);
  });

  it('puts the topics in the Markdown and names the syllabus by id in the history', () => {
    const e = exam();
    const done = finishExam(
      endAnswering(e, T0 + MIN),
      ['correct', 'wrong', 'unanswered', 'correct', 'wrong'],
      T0 + 2 * MIN,
    );
    const md = examToMarkdown(done, new Map());
    expect(md).toContain('## By topic');
    expect(md).toContain('| Cardiology | 3 | 1 | 33% |');
    expect(historyEntry(done)).toMatchObject({
      syllabusId: 'syllabus-0001',
      scopeLabel: 'Syllabus: Boards',
    });
    expect(ExamHistoryEntry.safeParse(historyEntry(done)).success).toBe(true);
    // Not part of other exams' summaries.
    expect(
      historyEntry(
        finishExam(
          endAnswering(make(facts(1), { questions: 1 }), T0 + MIN),
          ['correct'],
          T0 + 2 * MIN,
        ),
      ),
    ).not.toHaveProperty('syllabusId');
  });

  it('survives a JSON round trip', () => {
    const e = exam();
    expect(ExamSession.parse(JSON.parse(JSON.stringify(e)))).toEqual(e);
  });
});
