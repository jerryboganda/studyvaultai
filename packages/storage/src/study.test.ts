// @vitest-environment node
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PdfAnchorSet } from '@shared';
import { makeCard } from '@study/testUtils';
import { closeDb, getDb } from './db';
import { savePdfHighlight, upsertDocument } from './pdf';
import { checkIntegrity, unregisteredTables } from './registry';
import { createBank, softDeleteHighlight } from './repo';
import {
  acceptKnowledgePoint,
  applyBacklog,
  buildTemplateDrafts,
  buryCards,
  cardVersion,
  clearStudySession,
  createCardsFromHighlight,
  createCardsFromHighlights,
  createCardsFromKnowledgePoint,
  createDeck,
  createKnowledgePoint,
  createManualCards,
  deleteCards,
  deleteDeck,
  deleteKnowledgePoint,
  ensureDeckForBank,
  getAnalyticsInput,
  getCard,
  getCardSourceContext,
  getDueSummary,
  getStudyOverview,
  listCards,
  listDecks,
  listDueCards,
  listKnowledgePoints,
  listReviewLogs,
  loadStudySession,
  markCardVerified,
  moveCards,
  planBacklog,
  renameDeck,
  rescheduleCard,
  resetCardProgress,
  restoreCards,
  restoreDeck,
  resumeStudySession,
  reviewCard,
  setCardsSuspended,
  startStudySession,
  undoLastReview,
  updateCard,
  updateDeckSettings,
  updateKnowledgePoint,
  type TemplateInput,
} from './study';
import { freshDatabase, save, trackEpochs } from './test-vault';

const MIN = 60_000;
const DAY = 86_400_000;
const T0 = Date.parse('2026-03-02T15:00:00.000Z');
const UTC = { timeZone: 'UTC', rolloverHour: 0 };
const NEW_YORK = { timeZone: 'America/New_York', rolloverHour: 4 };

const basic = (n: number): TemplateInput => ({
  template: 'basic',
  question: `Question ${n}?`,
  answer: `Answer ${n}`,
});

beforeEach(async () => {
  await freshDatabase();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

/** A bank with one deck and `n` fresh manual cards, all created at T0. */
async function seedDeck(n: number, settings: Parameters<typeof updateDeckSettings>[1] = {}) {
  const deck = await createDeck({ name: 'Cardiology', settings });
  const cards = await createManualCards(
    Array.from({ length: n }, (_, i) => basic(i + 1)),
    { deckId: deck.id, now: T0 },
  );
  return { deck, cards };
}

describe('decks', () => {
  it('creates one default deck per bank, even when two windows ask at once', async () => {
    const bank = await createBank('Pharmacology');
    const [a, b, c] = await Promise.all([
      ensureDeckForBank(bank.id),
      ensureDeckForBank(bank.id),
      ensureDeckForBank(null),
    ]);
    expect(a.id).toBe(b.id);
    expect(a.bankId).toBe(bank.id);
    expect(a.name).toBe('Pharmacology');
    expect(c.bankId).toBeNull();
    expect(await listDecks()).toHaveLength(2);
  });

  it('validates settings and keeps cards untouched when the rules change', async () => {
    const { deck, cards } = await seedDeck(1);
    await expect(updateDeckSettings(deck.id, { targetRetention: 0.5 })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    const next = await updateDeckSettings(deck.id, { targetRetention: 0.85, newPerDay: 5 });
    expect(next.settings).toMatchObject({ targetRetention: 0.85, newPerDay: 5 });
    expect(await getCard(cards[0]!.id)).toEqual(cards[0]);
    expect((await renameDeck(deck.id, '  Heart  ')).name).toBe('Heart');
  });

  it('delete moves or removes the cards and restore brings them back', async () => {
    const a = await seedDeck(2);
    const b = await createDeck({ name: 'Other' });
    expect(await deleteDeck(a.deck.id, { moveCardsTo: b.id })).toEqual({ moved: 2, deleted: 0 });
    expect((await listCards({ deckId: b.id })).total).toBe(2);

    expect(await deleteDeck(b.id)).toEqual({ moved: 0, deleted: 2 });
    expect((await listCards()).total).toBe(0);
    await restoreDeck(b.id);
    expect((await listCards({ deckId: b.id })).total).toBe(2);
    await expect(deleteDeck(b.id, { moveCardsTo: b.id })).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });
});

describe('creating cards', () => {
  it('takes provenance from the highlight, not from the caller', async () => {
    const bank = await createBank('Cardiology');
    const h = await save('Aspirin irreversibly inhibits COX-1.', { bankId: bank.id });
    const [card] = await createCardsFromHighlight(h.id, [basic(1)], { now: T0 });
    expect(card).toMatchObject({
      highlightId: h.id,
      sourceQuote: 'Aspirin irreversibly inhibits COX-1.',
      cardType: 'basic',
      createdBy: 'user',
      needsHumanVerification: false,
      suspended: false,
    });
    expect(card!.fsrs).toMatchObject({ state: 'new', reps: 0, lapses: 0 });
    expect(card!.dueAt).toBe(card!.fsrs.due);
    const decks = await listDecks();
    expect(decks).toHaveLength(1);
    expect(decks[0]).toMatchObject({ bankId: bank.id, name: 'Cardiology' });
    expect(card!.deckId).toBe(decks[0]!.id);
  });

  it('makes one cloze card per deletion number and one for the whole text on request', async () => {
    const h = await save('Warfarin inhibits vitamin K epoxide reductase.');
    const markup = '{{c1::Warfarin}} inhibits {{c2::vitamin K epoxide reductase::enzyme}}.';
    const per = await createCardsFromHighlight(h.id, [{ template: 'cloze', markup }]);
    expect(per.map((c) => c.cloze?.activeIndex)).toEqual([1, 2]);
    expect(per[0]!.front).toBe('[...] inhibits vitamin K epoxide reductase.');
    expect(per[1]!.front).toBe('Warfarin inhibits [enzyme].');
    const whole = await createCardsFromHighlight(h.id, [
      { template: 'cloze', markup, perDeletion: false },
    ]);
    expect(whole).toHaveLength(1);
    expect(whole[0]!.cloze?.activeIndex).toBeNull();
  });

  it('is all or nothing, including the deck it would have created', async () => {
    const good = await save('A fact that can become a card.');
    const other = await save('Another fact.');
    await expect(
      createCardsFromHighlights([
        { highlightId: good.id, template: basic(1) },
        { highlightId: other.id, template: { template: 'basic', question: ' ', answer: 'x' } },
      ]),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(await getDb().cards.count()).toBe(0);
    expect(await listDecks()).toHaveLength(0);

    const cards = await createCardsFromHighlights([
      { highlightId: good.id, template: basic(1) },
      { highlightId: other.id, template: basic(2) },
    ]);
    expect(cards.map((c) => c.highlightId).sort()).toEqual([good.id, other.id].sort());
  });

  it('refuses a highlight that is gone and a deck that does not exist', async () => {
    const h = await save('Soon to be deleted.');
    await expect(
      createCardsFromHighlight('00000000-0000-7000-8000-000000000000', [basic(1)]),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      createManualCards([basic(1)], { deckId: '00000000-0000-7000-8000-000000000000' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await softDeleteHighlight(h.id);
    await expect(createCardsFromHighlight(h.id, [basic(1)])).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('builds multiple-choice and compare cards with their key and explanation', () => {
    const mcq = buildTemplateDrafts(
      {
        template: 'mcq',
        stem: 'Which enzyme does aspirin inhibit?',
        choices: ['COX', 'ACE', 'HMG-CoA reductase'],
        correctIndex: 0,
        explanation: 'Irreversible acetylation of COX.',
      },
      { highlightId: null, quote: null },
    );
    expect(mcq.ok).toBe(true);
    if (mcq.ok) {
      const card = mcq.value[0]!;
      expect(card.choices?.map((c) => c.text)).toEqual(['COX', 'ACE', 'HMG-CoA reductase']);
      expect(card.answerChoiceId).toBe('ch1');
      expect(card.explanation).toBe('Irreversible acetylation of COX.');
    }
    const bad = buildTemplateDrafts(
      { template: 'mcq', stem: 'Q', choices: ['same', 'same'], correctIndex: 0 },
      { highlightId: null, quote: null },
    );
    expect(bad.ok).toBe(false);
  });
});

describe('knowledge points', () => {
  it('start unchecked, need real evidence for source_supported, and only the person changes the label', async () => {
    const h = await save('Metformin reduces hepatic gluconeogenesis.');
    const kp = await createKnowledgePoint({
      highlightId: h.id,
      shortOneLiner: 'Metformin lowers hepatic glucose output',
      examPearl: 'First-line for type 2 diabetes unless contraindicated.',
    });
    expect(kp).toMatchObject({
      verificationStatus: 'not_checked',
      createdBy: 'user',
      primaryQuoteId: h.id,
    });
    expect(kp.acceptedAt).not.toBeNull();

    await expect(
      updateKnowledgePoint(kp.id, { verificationStatus: 'source_supported' }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      updateKnowledgePoint(kp.id, {
        claims: [
          {
            text: 'Reduces gluconeogenesis',
            evidenceHighlightIds: ['00000000-0000-7000-8000-000000000000'],
            reliability: 'unrated',
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });

    const ok = await updateKnowledgePoint(kp.id, {
      claims: [
        { text: 'Reduces gluconeogenesis', evidenceHighlightIds: [h.id], reliability: 'moderate' },
      ],
      verificationStatus: 'source_supported',
    });
    expect(ok.verificationStatus).toBe('source_supported');
    expect(await listKnowledgePoints({ highlightId: h.id })).toHaveLength(1);
  });

  it('an AI-created point arrives unaccepted and unchecked, and its cards are flagged', async () => {
    const h = await save('Statins inhibit HMG-CoA reductase.');
    const kp = await createKnowledgePoint({
      highlightId: h.id,
      shortOneLiner: 'Statins block cholesterol synthesis',
      misconception: 'Statins lower LDL by blocking absorption',
      createdBy: 'ai',
    });
    expect(kp).toMatchObject({
      createdBy: 'ai',
      acceptedAt: null,
      verificationStatus: 'not_checked',
    });
    const [card] = await createCardsFromKnowledgePoint(kp.id, 'misconception', { now: T0 });
    expect(card).toMatchObject({
      createdBy: 'ai',
      needsHumanVerification: true,
      knowledgePointId: kp.id,
      highlightId: h.id,
    });
    expect((await acceptKnowledgePoint(kp.id)).acceptedAt).not.toBeNull();
    expect((await getCard(card!.id))!.needsHumanVerification).toBe(true);
    expect((await markCardVerified(card!.id)).needsHumanVerification).toBe(false);
  });

  it('a missing exam pearl is reported instead of an empty card', async () => {
    const h = await save('Digoxin inhibits Na+/K+ ATPase.');
    const kp = await createKnowledgePoint({ highlightId: h.id, shortOneLiner: 'Digoxin: pump' });
    await expect(createCardsFromKnowledgePoint(kp.id, 'pearl')).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await deleteKnowledgePoint(kp.id);
    expect(await listKnowledgePoints({ highlightId: h.id })).toHaveLength(0);
  });
});

describe('answering', () => {
  it('writes the card and its log in one transaction, and rolls both back on failure', async () => {
    const { cards } = await seedDeck(1);
    const id = cards[0]!.id;
    vi.spyOn(getDb().reviewLogs, 'add').mockRejectedValueOnce(new Error('disk full'));
    await expect(
      reviewCard(id, 3, { now: T0, boundary: UTC, sessionId: 'session-0001' }),
    ).rejects.toBeInstanceOf(Error);
    expect(await getCard(id)).toEqual(cards[0]);
    expect(await getDb().reviewLogs.count()).toBe(0);

    const out = await reviewCard(id, 3, { now: T0, boundary: UTC, sessionId: 'session-0001' });
    expect(out.status).toBe('reviewed');
    if (out.status !== 'reviewed') return;
    expect(out.card.fsrs.reps).toBe(1);
    expect(out.card.dueAt).toBe(out.card.fsrs.due);
    expect(out.log).toMatchObject({
      cardId: id,
      rating: 3,
      sessionId: 'session-0001',
      previousState: cards[0]!.fsrs,
      nextState: out.card.fsrs,
    });
    expect(await getCard(id)).toEqual(out.card);
    expect(await listReviewLogs()).toEqual([out.log]);
  });

  it('a double submit writes one log: same key is a duplicate, same version is stale', async () => {
    const { cards } = await seedDeck(1);
    const id = cards[0]!.id;
    const version = cardVersion(cards[0]!);
    const [a, b] = await Promise.all([
      reviewCard(id, 3, { now: T0, boundary: UTC, logId: 'log-same-key-1' }),
      reviewCard(id, 3, { now: T0, boundary: UTC, logId: 'log-same-key-1' }),
    ]);
    expect([a.status, b.status].sort()).toEqual(['duplicate', 'reviewed']);
    expect(await getDb().reviewLogs.count()).toBe(1);
    expect((await getCard(id))!.fsrs.reps).toBe(1);

    // A second window that still shows the card as it was: different key, old version.
    const late = await reviewCard(id, 1, {
      now: T0 + MIN,
      boundary: UTC,
      logId: 'log-other-key-2',
      expectedVersion: version,
    });
    expect(late.status).toBe('stale');
    expect(await getDb().reviewLogs.count()).toBe(1);
  });

  it('two windows answering the same card at once: exactly one wins', async () => {
    const { cards } = await seedDeck(1);
    const id = cards[0]!.id;
    const version = cardVersion(cards[0]!);
    const results = await Promise.all([
      reviewCard(id, 4, { now: T0, boundary: UTC, expectedVersion: version }),
      reviewCard(id, 1, { now: T0, boundary: UTC, expectedVersion: version }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['reviewed', 'stale']);
    expect(await getDb().reviewLogs.count()).toBe(1);
  });

  it('refuses suspended and deleted cards and signals viewers only for real changes', async () => {
    const { cards } = await seedDeck(2);
    const epochs = trackEpochs();
    await setCardsSuspended([cards[0]!.id], true, T0);
    expect(await reviewCard(cards[0]!.id, 3, { now: T0, boundary: UTC })).toEqual({
      status: 'unavailable',
      reason: 'suspended',
    });
    await deleteCards([cards[1]!.id], T0);
    expect(await reviewCard(cards[1]!.id, 3, { now: T0, boundary: UTC })).toEqual({
      status: 'unavailable',
      reason: 'deleted',
    });
    expect((await reviewCard('00000000-0000-7000-8000-000000000000', 3, { now: T0 })).status).toBe(
      'unavailable',
    );
    const before = epochs.length;
    await restoreCards([cards[1]!.id]);
    expect(epochs.length).toBe(before + 1);
    await reviewCard(cards[1]!.id, 3, { now: T0, boundary: UTC });
    expect(epochs.length).toBe(before + 2);
    await reviewCard(cards[1]!.id, 3, {
      now: T0,
      boundary: UTC,
      expectedVersion: 'not-the-version',
    });
    expect(epochs.length).toBe(before + 2);
  });

  it('suspends a card that becomes a leech and the learner sees why', async () => {
    const deck = await createDeck({ name: 'Leeches', settings: { leechThreshold: 2 } });
    const row = makeCard('card-leech-01', {
      deckId: deck.id,
      state: 'review',
      due: new Date(T0).toISOString(),
      lastReview: new Date(T0 - 5 * DAY).toISOString(),
      lapses: 1,
    });
    await getDb().cards.put(row);
    const out = await reviewCard(row.id, 1, { now: T0, boundary: UTC });
    expect(out.status).toBe('reviewed');
    if (out.status !== 'reviewed') return;
    expect(out.leech).toBe(true);
    expect(out.card.suspended).toBe(true);
    expect(out.card.tags).toContain('leech');
    expect((await listCards({ filter: 'leech' })).total).toBe(1);
    // Unsuspending clears the flag: it is the learner saying the card was fixed.
    const [fixed] = await setCardsSuspended([row.id], false, T0 + MIN);
    expect(fixed!.suspended).toBe(false);
    expect(fixed!.tags).not.toContain('leech');
  });
});

describe('undo', () => {
  it('restores the exact state and corrects the log, twice in a row', async () => {
    const { cards } = await seedDeck(1);
    const id = cards[0]!.id;
    const first = await reviewCard(id, 3, { now: T0, boundary: UTC });
    const second = await reviewCard(id, 3, { now: T0 + 11 * MIN, boundary: UTC });
    if (first.status !== 'reviewed' || second.status !== 'reviewed') throw new Error('setup');

    const undone = await undoLastReview(id, { now: T0 + 12 * MIN, expectLogId: second.log.id });
    expect(undone.status).toBe('undone');
    if (undone.status !== 'undone') return;
    expect(undone.card.fsrs).toEqual(first.card.fsrs);
    expect(undone.log.userCorrection).toEqual({
      kind: 'undone',
      at: new Date(T0 + 12 * MIN).toISOString(),
    });
    // The log row is kept (append-only), only marked.
    expect(await getDb().reviewLogs.count()).toBe(2);
    expect(await listReviewLogs()).toHaveLength(1);
    expect(await listReviewLogs({ includeCorrected: true })).toHaveLength(2);

    const again = await undoLastReview(id, { now: T0 + 13 * MIN });
    expect(again.status).toBe('undone');
    expect((await getCard(id))!.fsrs).toEqual(cards[0]!.fsrs);
    expect(await undoLastReview(id)).toEqual({ status: 'refused', reason: 'no_review' });
  });

  it('undoes the answer the card is in, even when two logs share a review time (clock set back)', async () => {
    const { cards } = await seedDeck(1);
    const id = cards[0]!.id;
    // The newer answer's id sorts BEFORE the older one: an ordering by (reviewedAt, id) alone would
    // call the older answer "the last".
    const first = await reviewCard(id, 3, { now: T0, boundary: UTC, logId: 'log-zzzz-first' });
    const second = await reviewCard(id, 3, {
      now: T0 - 5 * MIN, // the clock went back: the review time is held at the previous one
      boundary: UTC,
      logId: 'log-aaaa-second',
    });
    if (first.status !== 'reviewed' || second.status !== 'reviewed') throw new Error('setup');
    expect(second.clockAdjusted).toBe(true);
    expect(second.log.reviewedAt).toBe(first.log.reviewedAt);

    const undone = await undoLastReview(id, { now: T0 + MIN, expectLogId: second.log.id });
    expect(undone.status).toBe('undone');
    if (undone.status !== 'undone') return;
    expect(undone.log.id).toBe('log-aaaa-second');
    expect(undone.card.fsrs).toEqual(first.card.fsrs);
  });

  it('refuses when the card has moved on or the learner meant another answer', async () => {
    const { cards } = await seedDeck(1);
    const id = cards[0]!.id;
    const first = await reviewCard(id, 3, { now: T0, boundary: UTC });
    if (first.status !== 'reviewed') throw new Error('setup');
    expect(await undoLastReview(id, { expectLogId: 'log-someone-else' })).toEqual({
      status: 'refused',
      reason: 'not_last_review',
    });
    await rescheduleCard(id, T0 + 3 * DAY, T0 + MIN);
    expect(await undoLastReview(id)).toEqual({ status: 'refused', reason: 'not_last_review' });
    expect((await getCard(id))!.fsrs.due).toBe(new Date(T0 + 3 * DAY).toISOString());
  });
});

describe('the queue', () => {
  it('honours the daily new-card cap, counting what was already done today', async () => {
    const { deck, cards } = await seedDeck(5, { newPerDay: 2 });
    const before = await listDueCards({ now: T0, boundary: UTC });
    expect(before.queue.counts).toMatchObject({ new: 2, review: 0, learning: 0, total: 2 });
    expect(before.queue.deferred.new).toBe(3);
    expect(before.cards).toHaveLength(2);

    await reviewCard(before.cards[0]!.id, 3, { now: T0, boundary: UTC });
    const after = await listDueCards({ now: T0 + MIN, boundary: UTC });
    // One new card was introduced: one more new card fits, and the answered card's learning
    // step (10 minutes away, inside the 20-minute learn-ahead window) is offered last.
    expect(after.queue.counts).toMatchObject({ new: 1, learning: 1, review: 0 });
    expect(after.queue.deferred.new).toBe(3);
    const last = after.queue.entries.at(-1)!;
    expect([last.cardId, last.kind]).toEqual([before.cards[0]!.id, 'learning']);
    expect(deck.id).toBe(before.decks[0]!.id);
    expect(cards).toHaveLength(5);
  });

  it('leaves suspended, buried and deleted cards out and brings buried cards back tomorrow', async () => {
    const { cards } = await seedDeck(4);
    await setCardsSuspended([cards[0]!.id], true, T0);
    await buryCards([cards[1]!.id], { now: T0, boundary: UTC });
    await deleteCards([cards[2]!.id], T0);
    const today = await listDueCards({ now: T0 + MIN, boundary: UTC });
    expect(today.cards.map((c) => c.id)).toEqual([cards[3]!.id]);
    const tomorrow = await listDueCards({ now: T0 + DAY, boundary: UTC });
    expect(tomorrow.cards.map((c) => c.id).sort()).toEqual([cards[1]!.id, cards[3]!.id].sort());
  });

  it('puts the study-day end where the local clock says, across DST (25h and 23h days)', async () => {
    const deck = await createDeck({ name: 'Zones' });
    const review = (id: string, due: string) =>
      makeCard(id, {
        deckId: deck.id,
        state: 'review',
        due,
        lastReview: '2026-10-20T12:00:00.000Z',
        stability: 8,
      });
    // Fall back (2026-11-01 in New York): the study day that began 04:00 EDT lasts 25 hours.
    await getDb().cards.bulkPut([
      review('card-fall-in-1', '2026-11-02T08:30:00.000Z'), // 03:30 EST: still "today"
      review('card-fall-out1', '2026-11-02T09:30:00.000Z'), // 04:30 EST: tomorrow
    ]);
    const fall = await listDueCards({ now: '2026-11-01T12:00:00.000Z', boundary: NEW_YORK });
    expect(fall.queue.dayEndsAt).toBe('2026-11-02T09:00:00.000Z');
    expect(fall.cards.map((c) => c.id)).toEqual(['card-fall-in-1']);

    // Spring forward (2026-03-08): the day that began 04:00 EST lasts 23 hours.
    await getDb().cards.bulkPut([
      review('card-spr-in-01', '2026-03-08T07:30:00.000Z'), // 03:30 EDT: today
      review('card-spr-out-1', '2026-03-08T08:30:00.000Z'), // 04:30 EDT: tomorrow
    ]);
    const spring = await listDueCards({ now: '2026-03-07T12:00:00.000Z', boundary: NEW_YORK });
    expect(spring.queue.dayEndsAt).toBe('2026-03-08T08:00:00.000Z');
    expect(spring.cards.map((c) => c.id)).toEqual(['card-spr-in-01']);
  });

  it('resets daily caps at the learner’s rollover hour, not at UTC midnight', async () => {
    await seedDeck(2, { newPerDay: 1 });
    const beforeRollover = '2026-03-03T08:30:00.000Z'; // 03:30 EST, still the previous study day
    const cards = await listDueCards({ now: beforeRollover, boundary: NEW_YORK });
    expect(cards.queue.counts.new).toBe(1);
    await reviewCard(cards.cards[0]!.id, 3, {
      now: beforeRollover,
      boundary: NEW_YORK,
    });
    const stillSameDay = await getDueSummary({
      now: '2026-03-03T08:45:00.000Z',
      boundary: NEW_YORK,
    });
    expect(stillSameDay.total.new).toBe(0);
    expect(stillSameDay.deferred.new).toBe(1);
    const nextDay = await getDueSummary({ now: '2026-03-03T09:05:00.000Z', boundary: NEW_YORK });
    expect(nextDay.total.new).toBe(1);
    expect(nextDay.dayKey).not.toBe(stillSameDay.dayKey);
  });

  it('survives a restart: cards, logs, due lists and the persisted session are the same', async () => {
    const { cards } = await seedDeck(3);
    const started = await startStudySession({ now: T0, boundary: UTC });
    const out = await reviewCard(cards[0]!.id, 3, {
      now: T0 + MIN,
      boundary: UTC,
      sessionId: started.session.id,
    });
    if (out.status !== 'reviewed') throw new Error('setup');
    const listBefore = await listDueCards({ now: T0 + 2 * MIN, boundary: UTC });

    closeDb(); // what a browser restart does to the connection

    expect(await getCard(cards[0]!.id)).toEqual(out.card);
    expect(await listReviewLogs()).toEqual([out.log]);
    const listAfter = await listDueCards({ now: T0 + 2 * MIN, boundary: UTC });
    expect(listAfter.queue.ids).toEqual(listBefore.queue.ids);
    expect(await loadStudySession()).toEqual(started.session);
  });
});

describe('the persisted session', () => {
  it('reconciles with answers written after the last save and never repeats a card', async () => {
    const { cards } = await seedDeck(3);
    const started = await startStudySession({ now: T0, boundary: UTC });
    expect(started.session.pending).toHaveLength(3);
    // The answer reached the database but the tab died before the session was saved.
    await reviewCard(started.session.pending[0]!, 3, {
      now: T0 + MIN,
      boundary: UTC,
      sessionId: started.session.id,
    });
    closeDb();

    const resumed = await resumeStudySession({ now: T0 + 2 * MIN, boundary: UTC });
    expect(resumed).not.toBeNull();
    expect(resumed!.stale).toBe(false);
    expect(resumed!.session.pending).toEqual(started.session.pending.slice(1));
    // The answered card is in a learning step today, so it returns later in the same session.
    expect(resumed!.session.learning.map((l) => l.cardId)).toEqual([started.session.pending[0]]);
    const all = [...resumed!.session.pending, ...resumed!.session.learning.map((l) => l.cardId)];
    expect(new Set(all).size).toBe(all.length);
    expect(all.sort()).toEqual(cards.map((c) => c.id).sort());
  });

  it('a session from an earlier study day is cleared and never resumed', async () => {
    await seedDeck(2);
    await startStudySession({ now: T0, boundary: UTC });
    const next = await resumeStudySession({ now: T0 + DAY, boundary: UTC });
    expect(next).toMatchObject({ stale: true });
    expect(await loadStudySession()).toBeNull();
    expect(await resumeStudySession({ now: T0 + DAY })).toBeNull();
    await clearStudySession();
  });

  it('drops cards suspended or deleted while the session was closed', async () => {
    const { cards } = await seedDeck(3);
    await startStudySession({ now: T0, boundary: UTC });
    await setCardsSuspended([cards[0]!.id], true, T0);
    await deleteCards([cards[1]!.id], T0);
    const resumed = await resumeStudySession({ now: T0 + MIN, boundary: UTC });
    expect(resumed!.session.pending).toEqual([cards[2]!.id]);
    expect(resumed!.dropped.map((d) => d.reason).sort()).toEqual(['deleted', 'suspended']);
  });
});

describe('counts and analytics input', () => {
  it('groups what is due by deck and bank, with caps reported as deferred', async () => {
    const bank = await createBank('Cardiology');
    const deckA = await ensureDeckForBank(bank.id);
    const deckB = await createDeck({ name: 'Loose', settings: { newPerDay: 1 } });
    await createManualCards([basic(1), basic(2), basic(3)], { deckId: deckA.id, now: T0 });
    await createManualCards([basic(4), basic(5)], { deckId: deckB.id, now: T0 });
    await getDb().cards.put(
      makeCard('card-late-0001', {
        deckId: deckA.id,
        state: 'review',
        due: new Date(T0 - 3 * DAY).toISOString(),
        lastReview: new Date(T0 - 13 * DAY).toISOString(),
        stability: 10,
      }),
    );

    const summary = await getDueSummary({ now: T0, boundary: UTC });
    expect(summary.byDeck[deckA.id]).toEqual({ learning: 0, review: 1, new: 3, total: 4 });
    expect(summary.byDeck[deckB.id]).toEqual({ learning: 0, review: 0, new: 1, total: 1 });
    expect(summary.byBank[bank.id]?.total).toBe(4);
    expect(summary.byBank['none']?.total).toBe(1);
    expect(summary.total.total).toBe(5);
    expect(summary.deferred).toEqual({ review: 0, new: 1 });

    const overview = await getStudyOverview({ now: T0, boundary: UTC });
    expect(overview.totalCards).toBe(6);
    expect(overview.backlog.overdue).toBe(1);
    const a = overview.decks.find((d) => d.deck.id === deckA.id)!;
    expect(a.counts).toMatchObject({ total: 4, new: 3, review: 1, overdue: 1 });
    expect(a.due.total).toBe(4);
    expect(overview.banks.find((b) => b.bankId === bank.id)?.name).toBe('Cardiology');
    expect(overview.banks.find((b) => b.bankId === null)?.name).toBe('No bank');
  });

  it('hands analytics the real logs and flags undone ones, nothing invented', async () => {
    const { cards } = await seedDeck(1);
    expect((await getAnalyticsInput({ now: T0, boundary: UTC })).firstReviewAt).toBeNull();
    const r = await reviewCard(cards[0]!.id, 3, { now: T0, boundary: UTC });
    if (r.status !== 'reviewed') throw new Error('setup');
    await undoLastReview(cards[0]!.id, { now: T0 + MIN });
    const input = await getAnalyticsInput({ now: T0 + 2 * MIN, boundary: UTC });
    expect(input.logs).toHaveLength(1);
    expect(input.logs[0]!.userCorrection?.kind).toBe('undone');
    expect(input.cards).toHaveLength(1);
    expect(input.firstReviewAt).toBe(r.log.reviewedAt);
  });
});

describe('backlog recovery', () => {
  async function overdueDeck(n: number, reviewsPerDay: number) {
    const deck = await createDeck({ name: 'Backlog', settings: { reviewsPerDay } });
    const rows = Array.from({ length: n }, (_, i) =>
      makeCard(`card-back-${String(i).padStart(4, '0')}`, {
        deckId: deck.id,
        state: 'review',
        due: new Date(T0 - (10 + i) * DAY).toISOString(),
        lastReview: new Date(T0 - (20 + i) * DAY).toISOString(),
        stability: 12,
      }),
    );
    await getDb().cards.bulkPut(rows);
    return { deck, rows };
  }

  it('previews the moves first, applies them in one step, and skips cards that changed', async () => {
    const { rows } = await overdueDeck(5, 2);
    const preview = await planBacklog({ now: T0, boundary: UTC, days: 3 });
    expect(preview.plan).toMatchObject({ overdueTotal: 5, keptToday: 2 });
    expect(preview.moves.map((m) => m.dayOffset).sort()).toEqual([1, 1, 2]);
    expect(preview.unassigned).toHaveLength(0);
    expect(preview.moves.every((m) => m.front.startsWith('Question '))).toBe(true);
    // Nothing was written by planning.
    expect(await getDb().cards.get(rows[0]!.id)).toEqual(rows[0]);

    // One of the planned cards is answered before the plan is applied.
    const planned = preview.moves[0]!.cardId;
    await rescheduleCard(planned, T0 + 30 * DAY, T0);
    const applied = await applyBacklog(preview.plan, { now: T0, boundary: UTC });
    expect(applied).toEqual({ moved: 2, skipped: 1 });
    const again = await applyBacklog(preview.plan, { now: T0, boundary: UTC });
    expect(again).toEqual({ moved: 0, skipped: 3 });
    // Memory state is untouched; only the due dates moved.
    const moved = await getCard(preview.moves[1]!.cardId);
    expect(moved!.fsrs.stability).toBe(12);
    expect(moved!.fsrs.state).toBe('review');
    expect(moved!.dueAt).not.toBe(preview.moves[1]!.fromDueAt);
  });

  it('lists what does not fit instead of hiding it', async () => {
    await overdueDeck(6, 1);
    const preview = await planBacklog({ now: T0, boundary: UTC, days: 2 });
    expect(preview.plan.keptToday).toBe(1);
    expect(preview.moves).toHaveLength(1);
    expect(preview.unassigned).toHaveLength(4);
  });
});

describe('source context', () => {
  it('opens the web page, keeps the quote after the highlight is deleted, shows notes', async () => {
    const h = await save('Heparin potentiates antithrombin III.', {
      userComment: 'Think: indirect thrombin inhibitor',
    });
    const [card] = await createCardsFromHighlight(h.id, [basic(1)], { now: T0 });
    const live = await getCardSourceContext(card!.id);
    expect(live).toMatchObject({
      highlightId: h.id,
      quote: 'Heparin potentiates antithrombin III.',
      quoteIsSnapshot: false,
      userComment: 'Think: indirect thrombin inhibitor',
    });
    expect(live.jump?.kind).toBe('web');
    expect(live.jump && live.jump.kind === 'web' && live.jump.url).toContain('example.com');

    await softDeleteHighlight(h.id);
    const gone = await getCardSourceContext(card!.id);
    expect(gone).toMatchObject({
      quote: 'Heparin potentiates antithrombin III.',
      quoteIsSnapshot: true,
      jump: null,
      userComment: '',
    });
  });

  it('points a PDF highlight at the reader, page and highlight', async () => {
    const DOC = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
    await upsertDocument({
      id: DOC,
      title: 'Cardiac physiology',
      pageCount: 12,
      byteLength: 2048,
      originalUrl: null,
      textStatus: 'text',
    });
    const anchorSet: PdfAnchorSet = {
      type: 'pdf',
      textAlgorithm: 'sv-pdf-text-v1',
      documentFingerprint: DOC,
      pageNumber: 7,
      rotation: 0,
      rects: [{ x: 0.1, y: 0.2, w: 0.5, h: 0.03 }],
      textQuote: { exact: 'Preload is end-diastolic stretch.', prefix: '', suffix: '' },
      textPosition: { start: 10, end: 43 },
      contentSignature: 'sig-1',
      documentTextLength: 3000,
    };
    const saved = await savePdfHighlight({
      documentId: DOC,
      anchorSet,
      exactQuote: 'Preload is end-diastolic stretch.',
      kind: 'essential',
      color: 'amber',
      bankId: null,
      userComment: '',
      priority: 3,
      captureMethod: 'toolbar',
    });
    const [card] = await createCardsFromHighlight(saved.highlight.id, [basic(1)], { now: T0 });
    const context = await getCardSourceContext(card!.id);
    expect(context.jump).toEqual({
      kind: 'pdf',
      documentId: DOC,
      pageNumber: 7,
      highlightId: saved.highlight.id,
    });
    expect(context.source).toMatchObject({ type: 'pdf', pageNumber: 7 });
  });

  it('a free-standing card has no source and says so', async () => {
    const { cards } = await seedDeck(1);
    expect(await getCardSourceContext(cards[0]!.id)).toMatchObject({
      highlightId: null,
      quote: null,
      jump: null,
      source: null,
    });
  });
});

describe('editing and managing cards', () => {
  it('rebuilds a cloze card from new markup and never touches provenance or schedule', async () => {
    const h = await save('Insulin is secreted by beta cells.');
    const [card] = await createCardsFromHighlight(
      h.id,
      [{ template: 'cloze', markup: '{{c1::Insulin}} is secreted by beta cells.' }],
      { now: T0 },
    );
    const edited = await updateCard(card!.id, {
      clozeMarkup: '{{c1::Insulin}} is secreted by {{c1::beta}} cells of the pancreas.',
      tags: ['endocrine', 'Endocrine', ' '],
      explanation: 'Islets of Langerhans.',
    });
    expect(edited.front).toBe('[...] is secreted by [...] cells of the pancreas.');
    expect(edited.back).toBe('Insulin is secreted by beta cells of the pancreas.');
    expect(edited.tags).toEqual(['endocrine']);
    expect(edited.highlightId).toBe(h.id);
    expect(edited.sourceQuote).toBe('Insulin is secreted by beta cells.');
    expect(edited.fsrs).toEqual(card!.fsrs);
    await expect(updateCard(card!.id, { clozeMarkup: 'no deletions here' })).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });

  it('changes a multiple-choice key only to a real choice', async () => {
    const [card] = await createManualCards(
      [
        {
          template: 'mcq',
          stem: 'Pick one',
          choices: ['A one', 'B two', 'C three'],
          correctIndex: 0,
        },
      ],
      { now: T0 },
    );
    expect(card!.answerChoiceId).toBe('ch1');
    const next = await updateCard(card!.id, { answerChoiceId: 'ch3' });
    expect(next.back).toBe('C three');
    await expect(updateCard(card!.id, { answerChoiceId: 'ch9' })).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });

  it('a deck deleted while cards are being moved never ends up holding live cards', async () => {
    const { cards } = await seedDeck(1);
    const target = await createDeck({ name: 'Target' });
    // The check of the deck and the move must be one transaction: started together, either the move
    // commits first (and the delete takes the card with its deck) or it finds the deck gone.
    const [moved] = await Promise.allSettled([
      moveCards([cards[0]!.id], target.id),
      deleteDeck(target.id),
    ]);
    if (moved.status === 'rejected') {
      expect(moved.reason).toMatchObject({ code: 'not_found' });
    }
    const db = getDb();
    const decks = new Map((await db.decks.toArray()).map((d) => [d.id, d] as const));
    for (const card of await db.cards.toArray()) {
      if (card.deletedAt !== null) continue;
      expect(decks.get(card.deckId as string)?.deletedAt, `deck of ${card.id}`).toBeNull();
    }
  });

  it('suspends, reschedules, resets and moves, each with one change signal', async () => {
    const { cards, deck } = await seedDeck(1);
    const other = await createDeck({ name: 'Elsewhere' });
    const id = cards[0]!.id;
    const epochs = trackEpochs();
    await setCardsSuspended([id], true, T0);
    await setCardsSuspended([id], false, T0);
    const due = await rescheduleCard(id, T0 + 5 * DAY, T0);
    expect(due.dueAt).toBe(new Date(T0 + 5 * DAY).toISOString());
    const reset = await resetCardProgress(id, { now: T0 + DAY });
    expect(reset.fsrs.state).toBe('new');
    const moved = await moveCards([id], other.id);
    expect(moved[0]!.deckId).toBe(other.id);
    expect(epochs).toHaveLength(5);
    await expect(moveCards([id], '00000000-0000-7000-8000-000000000000')).rejects.toMatchObject({
      code: 'not_found',
    });
    expect((await listCards({ deckId: deck.id })).total).toBe(0);
    expect((await listCards({ search: 'QUESTION 1' })).total).toBe(1);
  });
});

describe('registry and integrity', () => {
  it('registers the real schemas and a database full of study rows has no integrity issues', async () => {
    expect(unregisteredTables()).not.toContain('cards');
    expect(unregisteredTables()).not.toContain('decks');
    expect(unregisteredTables()).not.toContain('knowledgePoints');
    expect(unregisteredTables()).not.toContain('reviewLogs');

    const bank = await createBank('Integrity');
    const h = await save('Integrity quote for the study tables.', { bankId: bank.id });
    const kp = await createKnowledgePoint({ highlightId: h.id, shortOneLiner: 'Integrity' });
    const [card] = await createCardsFromHighlight(h.id, [basic(1)], {
      knowledgePointId: kp.id,
      now: T0,
    });
    await reviewCard(card!.id, 3, { now: T0, boundary: UTC });
    await startStudySession({ now: T0, boundary: UTC });

    const report = await checkIntegrity();
    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.tables.cards).toMatchObject({ rows: 1, invalid: 0 });
    expect(report.tables.reviewLogs).toMatchObject({ rows: 1, invalid: 0 });
  });
});
