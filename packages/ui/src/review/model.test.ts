import { describe, expect, it } from 'vitest';
import { DEFAULT_DECK_SETTINGS } from '@study';
import { makeCard, makeDeck } from '@study/testUtils';
import type { AnalyticsInput } from '@storage';
import {
  celebrationText,
  choiceRandom,
  computeAnalytics,
  formatDuration,
  hashSeed,
  isFieldTarget,
  keyAction,
  leftAfterSession,
  parseDraft,
  sessionXp,
  summarizeSession,
  toDraft,
  type KeyContext,
} from './model';
import { parseReviewSearch, reviewSearch } from './links';
import { parseStudySettings } from './settings';
import { clozeWrap, initialEditorState, nextClozeIndex, toTemplateInput } from './templates';

const key = (
  k: string,
  mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {},
) => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...mods,
});
const ctx = (over: Partial<KeyContext> = {}): KeyContext => ({
  phase: 'question',
  choosing: false,
  editing: false,
  canUndo: false,
  choiceCount: 0,
  ...over,
});

describe('keyAction', () => {
  it('Space and Enter reveal on the question side only', () => {
    expect(keyAction(key(' '), false, ctx())).toEqual({ type: 'reveal' });
    expect(keyAction(key('Enter'), false, ctx())).toEqual({ type: 'reveal' });
    expect(keyAction(key(' '), false, ctx({ phase: 'answer' }))).toBeNull();
  });

  it('1-4 grade only after the answer is shown', () => {
    expect(keyAction(key('3'), false, ctx())).toBeNull();
    for (const n of [1, 2, 3, 4]) {
      expect(keyAction(key(String(n)), false, ctx({ phase: 'answer' }))).toEqual({
        type: 'rate',
        rating: n,
      });
    }
    expect(keyAction(key('5'), false, ctx({ phase: 'answer' }))).toBeNull();
  });

  it('digits pick an option of a multiple-choice card before the answer', () => {
    const mcq = ctx({ choosing: true, choiceCount: 3 });
    expect(keyAction(key('2'), false, mcq)).toEqual({ type: 'choose', index: 1 });
    expect(keyAction(key('4'), false, mcq)).toBeNull();
    // After choosing, 1-4 are grades again.
    expect(keyAction(key('1'), false, ctx({ phase: 'answer', choiceCount: 3 }))).toEqual({
      type: 'rate',
      rating: 1,
    });
  });

  it('Z undoes only when there is something to undo, in any phase', () => {
    expect(keyAction(key('z'), false, ctx({ canUndo: false }))).toBeNull();
    expect(keyAction(key('Z'), false, ctx({ canUndo: true, phase: 'waiting' }))).toEqual({
      type: 'undo',
    });
  });

  it('never fires while typing, with a modifier, or while the editor is open', () => {
    expect(keyAction(key('1'), true, ctx({ phase: 'answer' }))).toBeNull();
    expect(keyAction(key('1', { ctrlKey: true }), false, ctx({ phase: 'answer' }))).toBeNull();
    expect(keyAction(key('s', { metaKey: true }), false, ctx())).toBeNull();
    expect(keyAction(key(' '), false, ctx({ editing: true }))).toBeNull();
  });

  it('maps the card actions and keeps explain for the answer side', () => {
    expect(keyAction(key('e'), false, ctx())).toEqual({ type: 'edit' });
    expect(keyAction(key('s'), false, ctx())).toEqual({ type: 'suspend' });
    expect(keyAction(key('b'), false, ctx())).toEqual({ type: 'bury' });
    expect(keyAction(key('j'), false, ctx())).toEqual({ type: 'source' });
    expect(keyAction(key('x'), false, ctx())).toBeNull();
    expect(keyAction(key('x'), false, ctx({ phase: 'answer' }))).toEqual({ type: 'explain' });
  });
});

describe('isFieldTarget', () => {
  it('recognises inputs and textareas but not buttons', () => {
    expect(isFieldTarget(document.createElement('input'))).toBe(true);
    expect(isFieldTarget(document.createElement('textarea'))).toBe(true);
    expect(isFieldTarget(document.createElement('button'))).toBe(false);
    expect(isFieldTarget(null)).toBe(false);
  });
});

describe('multiple-choice display order', () => {
  it('is stable for one repetition and changes with the next', () => {
    const card = makeCard('card-order-01', { state: 'review', reps: 3 });
    const a = choiceRandom(card);
    const b = choiceRandom(card);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    const later = choiceRandom({ ...card, fsrs: { ...card.fsrs, reps: 4 } });
    expect(hashSeed('x')).toBe(hashSeed('x'));
    expect(later()).not.toBe(choiceRandom(card)());
  });
});

describe('deck settings draft', () => {
  it('round-trips the defaults', () => {
    const parsed = parseDraft(toDraft(DEFAULT_DECK_SETTINGS));
    expect(parsed).toEqual({ ok: true, value: DEFAULT_DECK_SETTINGS });
  });

  it('explains every bad field and accepts the edges', () => {
    const base = toDraft(DEFAULT_DECK_SETTINGS);
    const bad = parseDraft({
      ...base,
      targetRetentionPct: '50',
      newPerDay: '-1',
      reviewsPerDay: 'many',
      learningSteps: '1m 10s',
      relearnSteps: '1 2 3 4 5 6 7 8 9',
      maxIntervalDays: '0',
      leechThreshold: '100',
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(Object.keys(bad.errors).sort()).toEqual([
        'learningSteps',
        'leechThreshold',
        'maxIntervalDays',
        'newPerDay',
        'relearnSteps',
        'reviewsPerDay',
        'targetRetentionPct',
      ]);
      expect(bad.errors.learningSteps).toContain('10s');
    }
    const edge = parseDraft({
      ...base,
      targetRetentionPct: '99',
      newPerDay: '0',
      learningSteps: '',
      relearnSteps: '5m, 1h 1d',
      maxIntervalDays: '36500',
    });
    expect(edge).toMatchObject({
      ok: true,
      value: {
        targetRetention: 0.99,
        newPerDay: 0,
        learningSteps: [],
        relearnSteps: ['5m', '1h', '1d'],
      },
    });
  });
});

describe('summarizeSession', () => {
  const log = (rating: 1 | 2 | 3 | 4, over: Record<string, unknown> = {}) => ({
    sessionId: 'session-0001',
    rating,
    durationMs: 4000,
    previousState: makeCard('card-sum-0001', { state: 'review' }).fsrs,
    leech: false,
    ...over,
  });

  it('counts only this session and ignores undone answers', () => {
    const s = summarizeSession(
      [
        log(3),
        log(1),
        log(4, { previousState: makeCard('card-sum-0002').fsrs }),
        log(3, { sessionId: 'other-session' }),
        log(3, { userCorrection: { kind: 'undone', at: '2026-01-01T00:00:00.000Z' } }),
        log(1, { leech: true, durationMs: 3_600_000 }),
      ],
      'session-0001',
    );
    expect(s.answered).toBe(4);
    expect(s.byRating).toEqual({ 1: 2, 2: 0, 3: 1, 4: 1 });
    expect(s.newCards).toBe(1);
    expect(s.lapses).toBe(2);
    expect(s.leeches).toBe(1);
    // The hour-long answer is capped at five minutes: a tab left open is not study time.
    expect(s.durationMs).toBe(4000 * 3 + 300_000);
    expect(s.passRate).toBe(0.5);
  });

  it('has no pass rate before the first answer', () => {
    expect(summarizeSession([], 'session-0001').passRate).toBeNull();
    expect(formatDuration(45_000)).toBe('45 s');
    expect(formatDuration(5 * 60_000)).toBe('5 min');
    expect(formatDuration(3_900_000)).toBe('1 h 05 min');
  });
});

describe('leftAfterSession', () => {
  it('counts what is left like the header ("25 due now"), new cards included and named', () => {
    // The header's 25 = 18 reviews and learning steps + 7 new cards from the same queue.
    expect(leftAfterSession({ total: 25, new: 7 }, 4)).toBe(
      '25 cards still due now (7 new), 4 reviews due tomorrow.',
    );
    expect(leftAfterSession({ total: 1, new: 0 }, 1)).toBe(
      '1 card still due now, 1 review due tomorrow.',
    );
    expect(leftAfterSession({ total: 0, new: 0 }, 0)).toBe(
      'Nothing is due right now, 0 reviews due tomorrow.',
    );
  });
});

describe('computeAnalytics', () => {
  const NOW = '2026-03-10T12:00:00.000Z';
  const base = (over: Partial<AnalyticsInput> = {}): AnalyticsInput => ({
    now: NOW,
    boundary: { timeZone: 'UTC', rolloverHour: 0 },
    decks: [],
    cards: [],
    logs: [],
    firstReviewAt: null,
    banks: [],
    ...over,
  });

  it('empty data is empty: no invented numbers', () => {
    const r = computeAnalytics(base());
    expect(r.hasCards).toBe(false);
    expect(r.totalReviews).toBe(0);
    expect(r.retention.status).toBe('insufficient_data');
    expect(r.retention.trueRetention).toBeNull();
    expect(r.estimated.value).toBeNull();
    expect(r.streak.current).toBe(0);
    expect(r.forecast.days).toHaveLength(30);
    expect(r.forecast.days.every((d) => d.due === 0)).toBe(true);
    expect(r.log.every((d) => d.reviews === 0)).toBe(true);
    expect(r.targetRetention).toBeNull();
  });

  it('derives forecast, backlog, counts and retention from the rows', () => {
    const deck = makeDeck('deck-0001', { name: 'Cardiology', bankId: 'bank-0001' });
    const day = 86_400_000;
    const now = Date.parse(NOW);
    const review = (id: string, dueOffset: number) =>
      makeCard(id, {
        state: 'review',
        due: new Date(now + dueOffset).toISOString(),
        lastReview: new Date(now - 10 * day).toISOString(),
        stability: 20,
      });
    const cards = [
      review('card-a-000001', -3 * day), // overdue
      review('card-a-000002', 2 * day), // due in 2 days
      review('card-a-000003', 2 * day),
      makeCard('card-a-000004'), // new
    ];
    const prev = review('card-a-000002', 0).fsrs;
    const logs = Array.from({ length: 24 }, (_, i) => ({
      cardId: 'card-a-000002',
      reviewedAt: new Date(now - (i % 3) * day - 1000).toISOString(),
      rating: (i % 6 === 0 ? 1 : 3) as 1 | 3,
      durationMs: 5000,
      previousState: prev,
    }));
    const r = computeAnalytics(
      base({ decks: [deck], cards, logs, banks: [{ id: 'bank-0001', name: 'Cardiology' }] }),
    );
    expect(r.hasCards).toBe(true);
    expect(r.backlog.overdue).toBe(1);
    expect(r.forecast.overdue).toBe(1);
    expect(r.forecast.days[2]?.due).toBe(2);
    expect(r.forecast.newAvailable).toBe(1);
    expect(r.decks[0]).toMatchObject({
      name: 'Cardiology',
      total: 4,
      new: 1,
      review: 3,
      overdue: 1,
    });
    expect(r.banks[0]).toMatchObject({ name: 'Cardiology', decks: 1, total: 4 });
    expect(r.retention.status).toBe('ok');
    expect(r.retention.matureReviews).toBe(24);
    expect(r.retention.trueRetention).toBeCloseTo(20 / 24, 5);
    expect(r.streak.current).toBeGreaterThanOrEqual(3);
    expect(r.loggedDays).toBe(3);
    expect(r.targetRetention).toEqual({ min: 0.9, max: 0.9 });
  });
});

describe('card editor state', () => {
  it('seeds cloze from the quote and leaves the other fields empty', () => {
    const s = initialEditorState('Aspirin inhibits COX.');
    expect(s.cloze.markup).toBe('Aspirin inhibits COX.');
    expect(s.basic).toEqual({ question: '', answer: '', explanation: '' });
  });

  it('drops blank options and keeps the key on the same text', () => {
    const s = initialEditorState(null, 'mcq');
    s.mcq = {
      ...s.mcq,
      stem: 'Which?',
      choices: ['', 'B', '', 'D'],
      correctIndex: 3,
    };
    expect(toTemplateInput(s)).toMatchObject({
      template: 'mcq',
      choices: ['B', 'D'],
      correctIndex: 1,
    });
    s.mcq.correctIndex = 0; // the marked option is blank
    expect(toTemplateInput(s)).toMatchObject({ correctIndex: -1 });
  });

  it('wraps the selection, keeps edge spaces outside and refuses markup', () => {
    const text = 'Aspirin inhibits COX-1 irreversibly.';
    const out = clozeWrap(text, 8, 17, 1);
    expect(out).toMatchObject({
      ok: true,
      text: 'Aspirin {{c1::inhibits}} COX-1 irreversibly.',
    });
    expect(clozeWrap(text, 0, 7, 2, 'drug')).toMatchObject({
      ok: true,
      text: '{{c2::Aspirin::drug}} inhibits COX-1 irreversibly.',
    });
    expect(clozeWrap(text, 3, 3, 1)).toMatchObject({ ok: false });
    expect(clozeWrap('a {{c1::b}} c', 0, 13, 2)).toMatchObject({ ok: false });
    expect(clozeWrap(text, 0, 7, 100)).toMatchObject({ ok: false });
    expect(clozeWrap(text, 0, 7, 1, 'x::y')).toMatchObject({ ok: false });
    expect(nextClozeIndex('{{c1::a}} {{c3::b}}')).toBe(4);
    expect(nextClozeIndex('plain')).toBe(1);
  });
});

describe('links and settings parsing', () => {
  it('round-trips a review link and ignores junk from the address bar', () => {
    const q = reviewSearch({ view: 'create', highlightId: '01912345-6789-7abc-8def-0123456789ab' });
    expect(parseReviewSearch(q)).toEqual({
      view: 'create',
      highlightId: '01912345-6789-7abc-8def-0123456789ab',
    });
    expect(parseReviewSearch('?view=admin&highlight=<script>&deck=../x&start=1')).toEqual({
      start: true,
    });
  });

  it('carries an exam on a syllabus topic through the address, and trusts nothing in it', () => {
    const link = { view: 'exam', syllabusId: 'syllabus-0001', topicId: 'topic-000001' } as const;
    expect(reviewSearch(link)).toBe('view=exam&syllabus=syllabus-0001&topic=topic-000001');
    expect(parseReviewSearch(reviewSearch(link))).toEqual(link);
    // The whole syllabus has no topic; a topic without its syllabus means nothing.
    expect(reviewSearch({ view: 'exam', syllabusId: 'syllabus-0001' })).toBe(
      'view=exam&syllabus=syllabus-0001',
    );
    expect(reviewSearch({ view: 'exam', topicId: 'topic-000001' })).toBe('view=exam');
    expect(parseReviewSearch('?view=exam&topic=topic-000001')).toEqual({ view: 'exam' });
    // Anything that is not an id is dropped.
    expect(parseReviewSearch('?view=exam&syllabus=<img>&topic=../x')).toEqual({ view: 'exam' });
    expect(parseReviewSearch('?view=exam&syllabus=syllabus-0001&topic=a b')).toEqual({
      view: 'exam',
      syllabusId: 'syllabus-0001',
    });
  });

  it('falls back field by field to defaults', () => {
    const s = parseStudySettings({ timeZone: 'Not/AZone', rolloverHour: 6, order: 'due', junk: 1 });
    expect(s.rolloverHour).toBe(6);
    expect(s.order).toBe('due');
    expect(s.timeZone).not.toBe('Not/AZone');
    expect(s.interleave).toBe('deck');
    expect(parseStudySettings(null).learnAheadMinutes).toBe(20);
  });
});

describe('game view helpers', () => {
  it('counts one XP per answer and the session bonus once, also when it was recorded earlier', () => {
    expect(sessionXp(3, 'awarded')).toBe(8);
    expect(sessionXp(3, 'already')).toBe(8);
    expect(sessionXp(3, null)).toBe(3);
    // No answer, no bonus (and no XP at all).
    expect(sessionXp(0, 'no_answers')).toBe(0);
    expect(sessionXp(0, 'awarded')).toBe(0);
  });

  it('names each celebration with real numbers and no exclamation mark', () => {
    const at = '2026-03-10T12:00:00.000Z';
    const goal = celebrationText({
      key: 'g',
      at,
      kind: 'goal',
      dayKey: '2026-03-10',
      goal: 30,
      xp: 34,
    });
    expect(goal).toEqual({ title: 'Daily goal met', line: '34 of 30 XP today' });
    expect(celebrationText({ key: 'l', at, kind: 'level', level: 4 }).title).toBe('Level 4');
    expect(celebrationText({ key: 'b', at, kind: 'badge', badgeId: 'first_session' }).line).toBe(
      'Session done',
    );
    expect(celebrationText({ key: 's', at, kind: 'streak', days: 7 })).toEqual({
      title: '7-day streak',
      line: 'Daily goal met 7 days running',
    });
    for (const t of [goal.title, goal.line]) expect(t).not.toMatch(/!/);
  });
});
