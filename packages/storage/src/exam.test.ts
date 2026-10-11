// @vitest-environment node
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chooseOption,
  createExam,
  endAnswering,
  examScopeOptions,
  finishExam,
  gradeExam,
  historyEntry,
  markRecall,
  planExamReview,
  type ExamConfig,
  type ExamSession,
} from '@study/exam';
import { BACKUP_EXCLUDED_TABLES } from './backupTarget';
import { closeDb, getDb } from './db';
import {
  applyExamReview,
  clearExamHistory,
  clearExamSession,
  loadExamData,
  loadExamHistory,
  loadExamSession,
  recordExamHistory,
  saveExamSession,
  undoExamReview,
} from './exam';
import { createFolder } from './hierarchy';
import { moveHighlight } from './membership';
import { createBank, softDeleteHighlight } from './repo';
import {
  createCardsFromHighlight,
  createManualCards,
  getCard,
  getCards,
  listReviewLogs,
  setCardsSuspended,
  type TemplateInput,
} from './study';
import { attachTags, createTag } from './tags';
import { freshDatabase, save } from './test-vault';

const MIN = 60_000;
const T0 = Date.parse('2026-03-10T12:00:00.000Z');
const UTC = { timeZone: 'UTC', rolloverHour: 0 };

const basic = (n: number, tags: string[] = []): TemplateInput => ({
  template: 'basic',
  question: `Question ${n}?`,
  answer: `Answer ${n}`,
  tags,
});

beforeEach(async () => {
  await freshDatabase();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

/** Cardiology (Physiology > Heart), Pharmacology (tagged), and one typed card with no bank. */
async function seed() {
  const cardio = await createBank('Cardiology');
  const pharm = await createBank('Pharmacology');
  const physio = await createFolder({ bankId: cardio.id, name: 'Physiology' });
  const heart = await createFolder({
    bankId: cardio.id,
    name: 'Heart',
    parentFolderId: physio.id,
  });
  const h1 = await save('Stroke volume is the blood ejected per beat.', { bankId: cardio.id });
  await moveHighlight({
    highlightId: h1.id,
    fromBankId: cardio.id,
    toBankId: cardio.id,
    folderId: heart.id,
  });
  const h2 = await save('Warfarin inhibits vitamin K epoxide reductase.', { bankId: pharm.id });
  const { tag } = await createTag('High Yield');
  await attachTags({ highlightIds: [h2.id], tagIds: [tag.id] });
  const [c1] = await createCardsFromHighlight(h1.id, [basic(1)], { now: T0 });
  const [c2] = await createCardsFromHighlight(h2.id, [basic(2, ['own-tag'])], { now: T0 });
  const [c3] = await createManualCards([basic(3)], { now: T0 });
  return { cardio, pharm, physio, heart, h1, h2, tag, c1: c1!, c2: c2!, c3: c3! };
}

describe('exam data', () => {
  it('resolves bank, folder (with its ancestors) and tag facts from the vault', async () => {
    const s = await seed();
    const data = await loadExamData();
    const by = new Map(data.cards.map((c) => [c.cardId, c]));

    expect(by.get(s.c1.id)).toMatchObject({
      cardType: 'basic',
      bankId: s.cardio.id,
      bankIds: [s.cardio.id],
      tags: [],
    });
    expect([...(by.get(s.c1.id)?.folderIds ?? [])].sort()).toEqual(
      [s.heart.id, s.physio.id].sort(),
    );
    expect(by.get(s.c2.id)).toMatchObject({ bankId: s.pharm.id, folderIds: [] });
    // The card's own tag and the highlight's tag, in one list.
    expect([...(by.get(s.c2.id)?.tags ?? [])].sort()).toEqual(['High Yield', 'own-tag']);
    expect(by.get(s.c3.id)).toMatchObject({ bankId: null, bankIds: [], folderIds: [], tags: [] });

    const options = examScopeOptions(data);
    const label = (l: string) => options.find((o) => o.label === l);
    expect(label('All cards')?.available).toBe(3);
    expect(label('Bank: Cardiology')?.available).toBe(1);
    expect(label('Folder: Cardiology / Physiology')?.available).toBe(1);
    expect(label('Folder: Cardiology / Physiology / Heart')?.available).toBe(1);
    expect(label('Tag: High Yield')?.available).toBe(1);
    expect(label('Tag: own-tag')?.available).toBe(1);
    expect(data.bankNames[s.cardio.id]).toBe('Cardiology');
  });

  it('leaves out suspended and deleted cards, and a trashed highlight files nothing', async () => {
    const s = await seed();
    await setCardsSuspended([s.c3.id], true);
    await softDeleteHighlight(s.h1.id);
    const data = await loadExamData();
    expect(data.cards.map((c) => c.cardId).sort()).toEqual([s.c1.id, s.c2.id].sort());
    const c1 = data.cards.find((c) => c.cardId === s.c1.id);
    // Still its deck's bank; the trashed highlight's folder no longer counts.
    expect(c1).toMatchObject({ bankId: s.cardio.id, folderIds: [] });
  });

  it('reads and writes nothing it should not: an empty vault is an empty universe', async () => {
    const data = await loadExamData();
    expect(data.cards).toEqual([]);
    expect(examScopeOptions(data).map((o) => o.value)).toEqual(['all']);
  });
});

describe('the running exam and the history', () => {
  async function exam(): Promise<ExamSession> {
    await seed();
    const { cards, bankNames } = await loadExamData();
    const config: ExamConfig = {
      scope: { kind: 'all' },
      scopeLabel: 'All cards',
      questions: 3,
      minutes: 30,
      shuffle: false,
    };
    return createExam({ id: 'exam-0001', now: T0, random: () => 0.5, config, cards, bankNames });
  }

  it('is kept in the device-local meta table, survives a restart, and is never backed up', async () => {
    const e = await exam();
    expect(await loadExamSession(T0)).toEqual({ session: null, expired: false });
    await saveExamSession(e);
    closeDb(); // a reload
    expect(await loadExamSession(T0 + 5 * MIN)).toEqual({ session: e, expired: false });
    const row = await getDb().meta.get('examSession');
    expect(row?.value).toEqual(e);
    expect(BACKUP_EXCLUDED_TABLES).toContain('meta');
    await clearExamSession();
    expect((await loadExamSession(T0)).session).toBeNull();
  });

  it('drops an exam after 24 hours, and says so once', async () => {
    const e = await exam();
    await saveExamSession(e);
    expect((await loadExamSession(T0 + 24 * 60 * MIN - 1)).session).not.toBeNull();
    expect(await loadExamSession(T0 + 24 * 60 * MIN)).toEqual({ session: null, expired: true });
    expect(await loadExamSession(T0 + 24 * 60 * MIN)).toEqual({ session: null, expired: false });
    expect(await getDb().meta.get('examSession')).toBeUndefined();
  });

  it('refuses to store an invalid exam and removes an unreadable one', async () => {
    const e = await exam();
    await expect(saveExamSession({ ...e, current: 99 })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(await getDb().meta.get('examSession')).toBeUndefined();
    await getDb().meta.put({
      key: 'examSession',
      value: { version: 7 },
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(await loadExamSession(T0)).toEqual({ session: null, expired: false });
    expect(await getDb().meta.get('examSession')).toBeUndefined();
  });

  it('keeps the last 20 summaries, one per exam, and clears them on request', async () => {
    const e = await exam();
    const done = finishExam(endAnswering(e, T0 + MIN), ['correct', 'wrong', 'void'], T0 + 2 * MIN);
    const entry = historyEntry(done)!;
    for (let n = 0; n < 24; n += 1) {
      await recordExamHistory({
        ...entry,
        id: `exam-${String(n + 10).padStart(4, '0')}`,
        finishedAt: new Date(T0 + n * MIN).toISOString(),
      });
    }
    const list = await loadExamHistory();
    expect(list).toHaveLength(20);
    expect(list[0]?.id).toBe('exam-0033');
    // Counting it later replaces the summary of the same exam instead of adding one.
    await recordExamHistory({ ...list[0]!, countedAsReview: true });
    const after = await loadExamHistory();
    expect(after).toHaveLength(20);
    expect(after[0]).toMatchObject({ id: 'exam-0033', countedAsReview: true });
    // A summary holds counts and labels, never a question.
    expect(JSON.stringify(after)).not.toMatch(/Question \d/);
    await clearExamHistory();
    expect(await loadExamHistory()).toEqual([]);
    await expect(recordExamHistory({ ...entry, total: 0 })).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });
});

describe('count this exam as review', () => {
  async function finishedExam() {
    const s = await seed();
    const { cards, bankNames } = await loadExamData();
    let e = createExam({
      id: 'exam-0002',
      now: T0,
      random: () => 0.1,
      config: {
        scope: { kind: 'all' },
        scopeLabel: 'All cards',
        questions: 3,
        minutes: null,
        shuffle: false,
      },
      cards,
      bankNames,
    });
    e = endAnswering(e, T0 + MIN);
    for (const [i, q] of e.questions.entries()) {
      if (q.cardId === s.c1.id) e = markRecall(e, i, 'know');
      if (q.cardId === s.c2.id) e = markRecall(e, i, 'dont');
      // c3 stays unmarked: unanswered, so no rating.
    }
    const live = new Map((await getCards(e.questions.map((q) => q.cardId))).map((c) => [c.id, c]));
    return { s, e: finishExam(e, gradeExam(e, live), T0 + 2 * MIN) };
  }

  it('an exam changes no card and writes no review by itself', async () => {
    const { s, e } = await finishedExam();
    expect(e.outcomes).toContain('correct');
    expect(await listReviewLogs()).toEqual([]);
    for (const c of [s.c1, s.c2, s.c3]) expect((await getCard(c.id))!.fsrs).toEqual(c.fsrs);
    // Even after being saved and loaded as results.
    await saveExamSession(e);
    expect((await loadExamSession(T0 + 3 * MIN)).session?.phase).toBe('finished');
    expect(await listReviewLogs()).toEqual([]);
  });

  it('rates each answered card once, is idempotent per exam, and can be undone', async () => {
    const { s, e } = await finishedExam();
    const plan = planExamReview(e);
    expect(plan.items.map((i) => [i.cardId, i.rating]).sort()).toEqual(
      [
        [s.c1.id, 3],
        [s.c2.id, 1],
      ].sort(),
    );

    const out = await applyExamReview(plan.items, {
      sessionId: e.id,
      now: T0 + 3 * MIN,
      boundary: UTC,
    });
    expect(out.unavailable).toBe(0);
    expect(out.logs).toHaveLength(2);
    const logs = await listReviewLogs();
    expect(logs.map((l) => [l.id, l.rating, l.sessionId]).sort()).toEqual(
      plan.items.map((i) => [i.logId, i.rating, e.id]).sort(),
    );
    const reviewed = (await getCard(s.c1.id))!;
    expect(reviewed.fsrs.reps).toBe(1);
    expect((await getCard(s.c3.id))!.fsrs).toEqual(s.c3.fsrs); // the unanswered one

    // A second go (a retry after a crash, a double click) writes nothing more.
    const again = await applyExamReview(plan.items, {
      sessionId: e.id,
      now: T0 + 4 * MIN,
      boundary: UTC,
    });
    expect(again.logs).toHaveLength(2);
    expect(await listReviewLogs()).toHaveLength(2);
    expect((await getCard(s.c1.id))!.fsrs).toEqual(reviewed.fsrs);

    const undone = await undoExamReview(out.logs, { now: T0 + 5 * MIN });
    expect(undone).toEqual({ undone: 2, refused: 0 });
    expect((await getCard(s.c1.id))!.fsrs).toEqual(s.c1.fsrs);
    expect((await getCard(s.c2.id))!.fsrs).toEqual(s.c2.fsrs);
    expect(await listReviewLogs()).toEqual([]); // undone logs are corrections, hidden by default
    expect(await undoExamReview(out.logs)).toEqual({ undone: 0, refused: 2 });
  });

  it('a card that was suspended or reviewed again since is reported, never overwritten', async () => {
    const { s, e } = await finishedExam();
    await setCardsSuspended([s.c2.id], true);
    const plan = planExamReview(e);
    const out = await applyExamReview(plan.items, {
      sessionId: e.id,
      now: T0 + 3 * MIN,
      boundary: UTC,
    });
    expect(out.unavailable).toBe(1);
    expect(out.logs.map((l) => l.cardId)).toEqual([s.c1.id]);

    // The card is reviewed again, outside the exam: the exam's undo must not touch it.
    const { reviewCard } = await import('./study');
    await reviewCard(s.c1.id, 4, { now: T0 + 10 * MIN, boundary: UTC });
    const state = (await getCard(s.c1.id))!.fsrs;
    expect(await undoExamReview(out.logs)).toEqual({ undone: 0, refused: 1 });
    expect((await getCard(s.c1.id))!.fsrs).toEqual(state);
  });

  it('a multiple-choice question is scored against the key of the card as it is now', async () => {
    const [mcq] = await createManualCards(
      [
        {
          template: 'mcq',
          stem: 'Which node paces?',
          choices: ['SA', 'AV', 'Purkinje'],
          correctIndex: 0,
        },
      ],
      { now: T0 },
    );
    const { cards } = await loadExamData();
    let e = createExam({
      id: 'exam-0003',
      now: T0,
      random: () => 0.1,
      config: {
        scope: { kind: 'all' },
        scopeLabel: 'All cards',
        questions: 1,
        minutes: null,
        shuffle: false,
      },
      cards,
    });
    expect(e.questions[0]?.kind).toBe('mcq');
    e = chooseOption(e, 0, mcq!.answerChoiceId!, T0 + 1000);
    e = endAnswering(e, T0 + 2000);
    const live = new Map((await getCards([mcq!.id])).map((c) => [c.id, c]));
    expect(gradeExam(e, live)).toEqual(['correct']);
    // The card is removed before the results are fixed: void, not wrong.
    expect(gradeExam(e, new Map())).toEqual(['void']);
  });
});
