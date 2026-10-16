// @vitest-environment node
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { preview, type Card } from '@study';
import {
  closeDb,
  createDeck,
  createManualCards,
  getCard,
  getDb,
  listReviewLogs,
  loadStudySession,
  reviewCard,
  type TemplateInput,
} from '@storage';
import { freshDatabase } from '@storage/test-vault';
import { ReviewSessionController, defaultPort, type ControllerDeps } from './session';

const MIN = 60_000;
const T0 = Date.parse('2026-03-02T15:00:00.000Z');
const UTC = { timeZone: 'UTC', rolloverHour: 0 };

const basic = (n: number): TemplateInput => ({
  template: 'basic',
  question: `Question ${n}?`,
  answer: `Answer ${n}`,
});

let clock = T0;
const make = (over: ControllerDeps = {}) =>
  new ReviewSessionController({ now: () => clock, boundary: UTC, learnAheadMs: 0, ...over });

async function seed(n: number, settings: Parameters<typeof createDeck>[0]['settings'] = {}) {
  const deck = await createDeck({ name: 'Cardiology', settings });
  const cards = await createManualCards(
    Array.from({ length: n }, (_, i) => basic(i + 1)),
    { deckId: deck.id, now: T0 },
  );
  return { deck, cards };
}

vi.setConfig({ testTimeout: 30_000 });

beforeEach(async () => {
  clock = T0;
  await freshDatabase();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('the session flow', () => {
  it('shows a card, reveals it, grades it with the real preview, and moves on', async () => {
    const { deck } = await seed(2);
    const c = make();
    await c.start(null);
    const first = c.getState().current!;
    expect(c.getState().phase).toBe('question');
    expect(c.getState().remaining).toBe(2);

    // The button labels are preview() of this very card, not a table.
    const expected = preview(first.card, T0, deck.settings, { boundary: UTC });
    for (const r of [1, 2, 3, 4] as const) {
      expect(first.previews[r].label).toBe(expected[r].label);
      expect(first.previews[r].dueAt).toBe(expected[r].dueAt);
    }

    c.reveal();
    expect(c.getState().phase).toBe('answer');
    await c.rate(3);

    const state = c.getState();
    expect(state.answered).toBe(1);
    expect(state.phase).toBe('question');
    expect(state.current!.card.id).not.toBe(first.card.id);
    const stored = (await getCard(first.card.id))!;
    expect(stored.fsrs.reps).toBe(1);
    expect(stored.fsrs.state).toBe('learning');
    expect(stored.dueAt).toBe(first.previews[3].dueAt);
    const logs = await listReviewLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      cardId: first.card.id,
      rating: 3,
      sessionId: state.session!.id,
    });
  });

  it('ignores a rating before the answer is shown', async () => {
    await seed(1);
    const c = make();
    await c.start(null);
    await c.rate(3);
    expect(await listReviewLogs()).toHaveLength(0);
    expect(c.getState().phase).toBe('question');
  });

  it('a double press answers once', async () => {
    await seed(2);
    const c = make();
    await c.start(null);
    c.reveal();
    await Promise.all([c.rate(3), c.rate(3)]);
    expect(await listReviewLogs()).toHaveLength(1);
    expect(c.getState().answered).toBe(1);
  });

  it('a learning step waits for its time, then comes back by itself', async () => {
    const { cards } = await seed(1);
    const c = make({ learnAheadMs: 0 });
    await c.start(null);
    c.reveal();
    await c.rate(3);
    expect(c.getState().phase).toBe('waiting');
    const due = c.getState().waitUntil!;
    expect(Date.parse(due)).toBe(T0 + 10 * MIN);

    clock = T0 + 5 * MIN;
    await c.tick();
    expect(c.getState().phase).toBe('waiting');
    clock = T0 + 10 * MIN;
    await c.tick();
    expect(c.getState().phase).toBe('question');
    expect(c.getState().current!.card.id).toBe(cards[0]!.id);
    expect(c.getState().current!.from).toBe('learning');
  });

  it('learn-ahead shows a step that is close instead of waiting', async () => {
    await seed(1);
    const c = make({ learnAheadMs: 20 * MIN });
    await c.start(null);
    c.reveal();
    await c.rate(3);
    expect(c.getState().phase).toBe('question');
    expect(c.getState().current!.from).toBe('learning');
  });

  it('can show a waiting card now on request', async () => {
    await seed(1);
    const c = make({ learnAheadMs: 0 });
    await c.start(null);
    c.reveal();
    await c.rate(3);
    expect(c.getState().phase).toBe('waiting');
    await c.tick({ early: true });
    expect(c.getState().phase).toBe('question');
  });

  it('finishes with a summary built from the real logs, then clears the stored session', async () => {
    await seed(2);
    const c = make();
    await c.start(null);
    c.reveal();
    await c.rate(4);
    c.reveal();
    await c.rate(4);
    const s = c.getState();
    expect(s.phase).toBe('done');
    expect(s.summary).toMatchObject({ answered: 2, newCards: 2, passRate: 1 });
    expect(s.summary!.byRating[4]).toBe(2);
    expect(await loadStudySession()).toBeNull();
  });

  it('leaving while an answer is still being saved keeps the person out of the session', async () => {
    await seed(3);
    const c = make();
    await c.start(null);
    c.reveal();
    const saving = c.rate(4);
    c.leave();
    await saving;
    const s = c.getState();
    expect(s.phase).toBe('idle');
    expect(s.current).toBeNull();
    expect(s.answered).toBe(1); // the answer itself was kept
    expect((await loadStudySession())!.answered).toBe(1);
    // Continuing brings the next card back.
    await c.resume();
    expect(c.getState().phase).toBe('question');
  });

  it('honours the daily cap: only the allowed new cards are in the session', async () => {
    await seed(5, { newPerDay: 2 });
    const c = make();
    await c.start(null);
    expect(c.getState().remaining).toBe(2);
    c.reveal();
    await c.rate(4);
    c.reveal();
    await c.rate(4);
    expect(c.getState().phase).toBe('done');
    // A second session the same day has nothing new left to show.
    const again = make();
    await again.start(null);
    expect(again.getState().phase).toBe('done');
    expect(again.getState().summary!.answered).toBe(0);
  });
});

describe('the session bonus (ADR-022)', () => {
  it('is recorded once when the session is done, in the same step that clears it', async () => {
    await seed(2);
    const c = make();
    await c.start(null);
    const id = c.getState().session!.id;
    expect(c.getState().bonus).toBeNull();
    c.reveal();
    await c.rate(4);
    expect(c.getState().bonus).toBeNull(); // nothing mid-session
    c.reveal();
    await c.rate(4);
    expect(c.getState()).toMatchObject({ phase: 'done', bonus: 'awarded' });
    expect(await getDb().gameFacts.get(`sb_${id}`)).toMatchObject({ kind: 'session', ref: id });
    expect(await loadStudySession()).toBeNull();
  });

  it('stays after an undo on the done screen: finishing again reports it as already earned', async () => {
    await seed(1);
    const c = make();
    await c.start(null);
    const id = c.getState().session!.id;
    c.reveal();
    await c.rate(4);
    expect(c.getState().bonus).toBe('awarded');

    await c.undo();
    expect(c.getState()).toMatchObject({ phase: 'question', bonus: null });
    c.reveal();
    await c.rate(4);
    expect(c.getState()).toMatchObject({ phase: 'done', bonus: 'already' });
    expect(await getDb().gameFacts.where('id').equals(`sb_${id}`).count()).toBe(1);
  });

  it('is not given for a session with nothing answered', async () => {
    await seed(1, { newPerDay: 0 });
    const c = make();
    await c.start(null);
    expect(c.getState()).toMatchObject({ phase: 'done', bonus: 'no_answers' });
    expect(await getDb().gameFacts.count()).toBe(0);
  });
});

describe('undo', () => {
  it('puts the card back as it was and shows it again', async () => {
    const { cards } = await seed(2);
    const c = make();
    await c.start(null);
    const first = c.getState().current!.card;
    c.reveal();
    await c.rate(3);
    expect(c.getState().lastAnswer?.cardId).toBe(first.id);
    // Written now: the page may show its XP.
    expect(c.getState().lastAnswer?.fresh).toBe(true);

    await c.undo();
    const s = c.getState();
    expect(s.current!.card.id).toBe(first.id);
    expect(s.current!.card.fsrs).toEqual(cards.find((x) => x.id === first.id)!.fsrs);
    expect(s.phase).toBe('question');
    expect(s.answered).toBe(0);
    expect(s.lastAnswer).toBeNull();
    expect(await listReviewLogs()).toHaveLength(0);
    expect(await listReviewLogs({ includeCorrected: true })).toHaveLength(1);

    // And it can be answered again: a fresh log, the undone one stays corrected.
    c.reveal();
    await c.rate(1);
    expect(await listReviewLogs()).toHaveLength(1);
  });

  it('is refused (with a reason) when the card moved on elsewhere', async () => {
    await seed(1);
    const c = make({ learnAheadMs: 20 * MIN });
    await c.start(null);
    const id = c.getState().current!.card.id;
    c.reveal();
    await c.rate(3);
    // Another window answers the same card again before the learner presses Z.
    await reviewCard(id, 3, { now: T0 + 11 * MIN, boundary: UTC });
    await c.undo();
    expect(c.getState().notice).toMatch(/cannot be undone any more/);
    expect(c.getState().lastAnswer).toBeNull();
  });
});

describe('resume', () => {
  it('after a reload continues where the learner was and never repeats an answered card', async () => {
    const { cards } = await seed(3);
    const first = make();
    await first.start(null);
    const answered = first.getState().current!.card.id;
    first.reveal();
    await first.rate(3);
    const sessionId = first.getState().session!.id;

    closeDb(); // the tab was closed and the browser restarted
    clock = T0 + 2 * MIN;
    const second = make({ learnAheadMs: 0 });
    const resumed = await second.resume();
    expect(resumed).not.toBeNull();
    const s = second.getState();
    expect(s.session!.id).toBe(sessionId);
    expect(s.answered).toBe(1);
    expect(s.phase).toBe('question');
    expect(s.current!.card.id).not.toBe(answered);
    expect(s.remaining).toBe(3); // two new + the learning step that is still ahead
    const all = [...s.session!.pending, ...s.session!.learning.map((l) => l.cardId)];
    expect(new Set(all).size).toBe(3);
    expect(all.sort()).toEqual(cards.map((x) => x.id).sort());
  });

  it('closes a session from an earlier study day and says so', async () => {
    await seed(2);
    const first = make();
    await first.start(null);
    clock = T0 + 24 * 60 * MIN;
    const next = make();
    const resumed = await next.resume();
    expect(resumed?.stale).toBe(true);
    expect(next.getState().phase).toBe('idle');
    expect(next.getState().notice).toMatch(/earlier study day/);
    expect(await loadStudySession()).toBeNull();
  });

  it('reports a card changed while the session was closed', async () => {
    const { cards } = await seed(3);
    const first = make();
    await first.start(null);
    const { setCardsSuspended } = await import('@storage');
    await setCardsSuspended([cards[0]!.id, cards[1]!.id], true, T0);
    const second = make();
    await second.resume();
    expect(second.getState().remaining).toBe(1);
    expect(second.getState().notice).toMatch(/2 cards were left out/);
  });
});

describe('concurrent windows', () => {
  it('a card answered in another window is not answered twice', async () => {
    await seed(2);
    const c = make();
    await c.start(null);
    const shown = c.getState().current!.card;
    // Another window answers it between "shown" and "graded".
    await reviewCard(shown.id, 3, { now: T0 + MIN, boundary: UTC });
    c.reveal();
    await c.rate(1);
    expect(c.getState().notice).toMatch(/changed in another window/);
    expect(await listReviewLogs()).toHaveLength(1);
    expect(c.getState().current?.card.id).not.toBe(shown.id);
  });

  it('a card suspended elsewhere is skipped with a message, not graded', async () => {
    const { cards } = await seed(2);
    const c = make();
    await c.start(null);
    const shown = c.getState().current!.card;
    const { setCardsSuspended } = await import('@storage');
    await setCardsSuspended([shown.id], true, T0);
    c.reveal();
    await c.rate(3);
    expect(await listReviewLogs()).toHaveLength(0);
    expect(c.getState().notice).toMatch(/skipped/);
    expect(c.getState().current?.card.id).toBe(cards.find((x) => x.id !== shown.id)!.id);
  });
});

describe('card actions in the session', () => {
  it('suspend and bury take the card out of the session and the queue', async () => {
    const { cards } = await seed(3);
    const c = make();
    await c.start(null);
    const a = c.getState().current!.card.id;
    await c.suspend();
    expect((await getCard(a))!.suspended).toBe(true);
    const b = c.getState().current!.card.id;
    expect(b).not.toBe(a);
    await c.bury();
    expect((await getCard(b))!.buriedUntil).not.toBeNull();
    expect(c.getState().remaining).toBe(1);
    expect(cards).toHaveLength(3);
    expect(c.getState().current!.card.id).not.toBe(b);
  });

  it('edits the card in place without touching its schedule', async () => {
    await seed(1);
    const c = make();
    await c.start(null);
    const before = c.getState().current!;
    const ok = await c.edit({ front: 'A better question?', tags: ['cardio'] });
    expect(ok).toBe(true);
    const after = c.getState().current!;
    expect(after.card.front).toBe('A better question?');
    expect(after.card.fsrs).toEqual(before.card.fsrs);
    expect(after.version).toBe(before.version);
    expect((await getCard(before.card.id))!.tags).toEqual(['cardio']);

    const bad = await c.edit({ front: '   ' });
    expect(bad).toBe(false);
    expect(c.getState().error).toBeTruthy();
  });

  it('multiple choice: picking an option reveals the key and suggests a grade', async () => {
    const deck = await createDeck({ name: 'MCQ' });
    await createManualCards(
      [
        {
          template: 'mcq',
          stem: 'Which enzyme does aspirin inhibit?',
          choices: ['COX', 'ACE', 'HMG-CoA reductase'],
          correctIndex: 0,
          explanation: 'Irreversible acetylation of COX.',
        },
      ],
      { deckId: deck.id, now: T0 },
    );
    const c = make();
    await c.start(null);
    const cur = c.getState().current!;
    expect(cur.choices).toHaveLength(3);
    const wrong = cur.choices.find((x) => x.id !== cur.card.answerChoiceId)!;
    c.choose(wrong.id);
    const s = c.getState();
    expect(s.phase).toBe('answer');
    expect(s.current!.grade).toEqual({ correct: false, answerChoiceId: cur.card.answerChoiceId });
    // The learner may still grade as they like; nothing was submitted by choosing.
    expect(await listReviewLogs()).toHaveLength(0);
  });

  it('cloze: blanks are uncovered one by one; the answer side starts when all are', async () => {
    const deck = await createDeck({ name: 'Cloze' });
    await createManualCards(
      [{ template: 'cloze', markup: '{{c1::Aspirin}} inhibits {{c2::COX}}', perDeletion: false }],
      { deckId: deck.id, now: T0 },
    );
    const c = make();
    await c.start(null);
    expect(c.getState().phase).toBe('question');
    c.revealBlank(1);
    expect(c.getState().phase).toBe('question');
    expect(c.getState().current!.revealedBlanks).toEqual([1]);
    c.revealBlank(2);
    expect(c.getState().phase).toBe('answer');
  });
});

describe('failures', () => {
  it('keeps the answer when the session cannot be saved, and says so', async () => {
    await seed(2);
    const save = vi.fn().mockRejectedValue(new Error('quota'));
    const c = make({ port: { ...defaultPort, saveStudySession: save } });
    await c.start(null);
    c.reveal();
    await c.rate(3);
    expect(await listReviewLogs()).toHaveLength(1);
    expect(c.getState().answered).toBe(1);
    expect(c.getState().notice).toMatch(/place in the session could not be saved/);
    expect(c.getState().error).toBeNull();
  });

  it('shows the error and stays on the card when the answer cannot be written', async () => {
    await seed(1);
    const reviewCardFail = vi.fn().mockRejectedValue(new Error('disk full'));
    const c = make({ port: { ...defaultPort, reviewCard: reviewCardFail } });
    await c.start(null);
    c.reveal();
    await c.rate(3);
    expect(c.getState().error).toBe('disk full');
    expect(c.getState().phase).toBe('answer');
    expect(c.getState().busy).toBe(false);
    // The same key is reused on retry, so a half-failed write can never double up.
    const logId = c.getState().current!.logId;
    await c.rate(3);
    expect(reviewCardFail.mock.calls[1]![2]).toMatchObject({ logId });
  });

  it('a card that cannot be shown is dropped, not looped on', async () => {
    const { cards } = await seed(2);
    const getCardFail = vi
      .fn<typeof defaultPort.getCard>()
      .mockImplementation(async (id) => (id === cards[0]!.id ? null : getCard(id)));
    const c = make({ port: { ...defaultPort, getCard: getCardFail } });
    await c.start(null);
    const shown: Card = c.getState().current!.card;
    expect(shown.id).toBe(cards[1]!.id);
    expect(c.getState().remaining).toBe(1);
  });
});
