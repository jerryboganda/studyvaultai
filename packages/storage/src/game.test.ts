// @vitest-environment node
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GAME_RULES_VERSION, type Celebration } from '@study';
import type { PdfAnchorSet } from '@shared';
import { acceptAiItem } from './ai';
import { bulkDelete } from './bulk';
import { closeDb, getDb } from './db';
import {
  GAME_SEEN_KEY,
  claimCelebrations,
  getGameState,
  isGameModeOn,
  runGameBackfill,
  setDailyGoal,
  setGameMode,
} from './game';
import { observe } from './observe';
import { savePdfHighlight, upsertDocument } from './pdf';
import { restoreHighlight, saveCapture, softDeleteHighlight } from './repo';
import {
  completeStudySession,
  createCardsFromHighlight,
  createCardsFromHighlights,
  createCardsFromKnowledgePoint,
  createDeck,
  createKnowledgePoint,
  createManualCards,
  deleteCards,
  getCard,
  loadStudySession,
  reviewCard,
  startStudySession,
  undoLastReview,
} from './study';
import { createSyncRuntime } from './sync';
import { purge } from './trash';
import { cap } from './test-fixtures';
import {
  UTC,
  acceptTwoAiCards,
  expectLedgerComplete,
  importQuote,
  ledgerIds,
  readyState,
} from './test-game';
import { freshDatabase, save } from './test-vault';

const MIN = 60_000;
const T0 = Date.parse('2026-03-02T15:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

beforeEach(async () => {
  await freshDatabase();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  // A fresh vault: the backfill finds nothing and marks the game ready (start fact, baseline).
  expect(await runGameBackfill()).toEqual({ status: 'done', added: 0 });
});

afterEach(() => {
  vi.useRealTimers();
});

/** Freeze `Date` only (timers stay real, so IndexedDB keeps working). */
function clockAt(ms: number): (ms: number) => void {
  vi.useFakeTimers({ toFake: ['Date'] });
  const set = (t: number) => vi.setSystemTime(new Date(t));
  set(ms);
  return set;
}

const basic = (n: number) => ({
  template: 'basic' as const,
  question: `Question ${n}?`,
  answer: `Answer ${n}`,
});

async function deckWithCards(n: number, now = T0) {
  const deck = await createDeck({ name: 'Cardiology' });
  const cards = await createManualCards(
    Array.from({ length: n }, (_, i) => basic(i + 1)),
    { deckId: deck.id, now },
  );
  return { deck, cards };
}

const totalXp = async () => (await readyState()).totalXp;

describe('every create path writes exactly its ledger row', () => {
  it('a review writes rv_; duplicate, stale and unavailable answers write nothing', async () => {
    const { cards } = await deckWithCards(2);
    const [a, b] = cards as [(typeof cards)[0], (typeof cards)[0]];
    const first = await reviewCard(a.id, 3, { logId: 'log-review-0001', now: T0 + MIN });
    expect(first.status).toBe('reviewed');
    const after = await ledgerIds();
    expect(after.events).toEqual(['cd_' + a.id, 'cd_' + b.id, 'rv_log-review-0001'].sort());
    expect((await reviewCard(a.id, 4, { logId: 'log-review-0001' })).status).toBe('duplicate');
    expect((await reviewCard(b.id, 3, { expectedVersion: 'not-the-version' })).status).toBe(
      'stale',
    );
    await deleteCards([b.id]);
    expect((await reviewCard(b.id, 3)).status).toBe('unavailable');
    expect(await ledgerIds()).toEqual(after);
    expect(await totalXp()).toBe(2 * 3 + 1);
    await expectLedgerComplete();
  });

  it('undoing a review writes ru_, dated at the review, so the XP leaves the day it was earned', async () => {
    const { cards } = await deckWithCards(1);
    const out = await reviewCard(cards[0]!.id, 3, { now: T0 + MIN });
    expect(out.status).toBe('reviewed');
    const logId = out.status === 'reviewed' ? out.log.id : '';
    const day = await readyState(T0 + 2 * MIN);
    expect(day.today.xp).toBe(3 + 1);
    expect((await undoLastReview(cards[0]!.id, { now: T0 + 26 * 60 * MIN })).status).toBe('undone');
    const fact = await getDb().gameFacts.get(`ru_${logId}`);
    expect(fact).toMatchObject({ kind: 'review_undo', ref: logId, at: iso(T0 + MIN) });
    const later = await readyState(T0 + 27 * 60 * MIN);
    expect(later.totalXp).toBe(3);
    expect(later.days.find((d) => d.dayKey === '2026-03-02')!.xp).toBe(3);
    await expectLedgerComplete();
  });

  it('a web save earns once: created writes hs_, duplicate and restored write nothing, imports earn 0', async () => {
    const set = clockAt(T0);
    const created = await saveCapture(cap());
    expect(created.status).toBe('created');
    expect((await saveCapture(cap())).status).toBe('duplicate');
    set(T0 + 11 * MIN); // deleted after the undo window: the XP stays
    await softDeleteHighlight(created.highlight.id);
    expect((await saveCapture(cap())).status).toBe('restored');
    await importQuote('Digoxin inhibits the sodium-potassium ATPase.');
    expect(await ledgerIds()).toEqual({
      events: [`hs_${created.highlight.id}`],
      facts: [expect.stringMatching(/^gx_/)],
    });
    expect(await totalXp()).toBe(2);
    await expectLedgerComplete();
  });

  it('a PDF save behaves the same', async () => {
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
    const input = {
      documentId: DOC,
      anchorSet,
      exactQuote: 'Preload is end-diastolic stretch.',
      kind: 'essential' as const,
      color: 'amber' as const,
      bankId: null,
      userComment: '',
      priority: 3,
      captureMethod: 'toolbar' as const,
    };
    const first = await savePdfHighlight(input);
    expect(first.status).toBe('created');
    expect((await savePdfHighlight(input)).status).toBe('duplicate');
    expect((await ledgerIds()).events).toEqual([`hs_${first.highlight.id}`]);
    await expectLedgerComplete();
  });

  it('every card creator writes one event per card: a three-deletion cloze earns 9 XP', async () => {
    const h = await save('Warfarin inhibits vitamin K epoxide reductase in the liver.');
    const cloze = await createCardsFromHighlight(h.id, [
      { template: 'cloze', markup: '{{c1::Warfarin}} inhibits {{c2::vitamin K}} {{c3::epoxide}}.' },
    ]);
    expect(cloze).toHaveLength(3);
    expect(await totalXp()).toBe(2 + 9);
    const h2 = await save('Heparin potentiates antithrombin III.');
    await createCardsFromHighlights([{ highlightId: h2.id, template: basic(1) }]);
    const kp = await createKnowledgePoint({
      highlightId: h2.id,
      shortOneLiner: 'Heparin: antithrombin',
      examPearl: 'Heparin acts through antithrombin III.',
    });
    expect(await createCardsFromKnowledgePoint(kp.id, 'pearl')).toHaveLength(1);
    await createManualCards([basic(2)]);
    expect(await totalXp()).toBe(2 * 2 + 3 * (3 + 1 + 1 + 1));
    await expectLedgerComplete();
  });

  it('an AI accept writes its cards’ events; accepting the same item again writes none', async () => {
    const h = await save('Aspirin irreversibly inhibits cyclooxygenase.');
    const [first, second] = await acceptTwoAiCards(h);
    const ids = await ledgerIds();
    expect(ids.events).toEqual([`hs_${h.id}`, `cd_${first!.id}`, `cd_${second!.id}`].sort());
    const resultId = String((await getDb().aiResults.toArray())[0]!.id);
    const again = await acceptAiItem({
      resultId,
      itemPath: '/cards/0',
      edited: false,
      cards: [first!],
    });
    expect(again.alreadyAccepted).toBe(true);
    expect(await ledgerIds()).toEqual(ids);
    expect(await totalXp()).toBe(2 + 2 * 3);
    await expectLedgerComplete();
  });

  it('a failing ledger write aborts the review: no log is written and the card is unchanged', async () => {
    const { cards } = await deckWithCards(1);
    const before = await getCard(cards[0]!.id);
    const db = getDb();
    const spy = vi
      .spyOn(db.gameEvents, 'bulkAdd')
      .mockRejectedValueOnce(new Error('injected ledger failure'));
    await expect(reviewCard(cards[0]!.id, 3, { now: T0 + MIN })).rejects.toThrow(
      /injected ledger failure/,
    );
    spy.mockRestore();
    expect(await db.reviewLogs.count()).toBe(0);
    expect(await getCard(cards[0]!.id)).toEqual(before);
    await expectLedgerComplete();
  });
});

describe('save undo', () => {
  it('a save deleted 9:59 after it was made gives its XP back; at 10:01 it keeps it', async () => {
    const set = clockAt(T0);
    const quick = await save('A quick save that is undone from the toast.');
    const kept = await save('A save that is tidied up later.');
    set(T0 + 9 * MIN + 59_000);
    await softDeleteHighlight(quick.id);
    set(T0 + 10 * MIN + 1_000);
    await softDeleteHighlight(kept.id);
    expect((await ledgerIds()).facts).toEqual(
      [`hu_${quick.id}`, expect.stringMatching(/^gx_/)].sort(),
    );
    expect(await getDb().gameFacts.get(`hu_${quick.id}`)).toMatchObject({
      kind: 'save_undo',
      at: iso(T0),
    });
    expect(await totalXp()).toBe(2);
  });

  it('delete, restore, delete subtracts once', async () => {
    const set = clockAt(T0);
    const h = await save('Saved, deleted, restored and deleted again.');
    set(T0 + MIN);
    await softDeleteHighlight(h.id);
    await restoreHighlight(h.id);
    set(T0 + 2 * MIN);
    await softDeleteHighlight(h.id);
    expect((await ledgerIds()).facts.filter((id) => id.startsWith('hu_'))).toEqual([`hu_${h.id}`]);
    expect(await totalXp()).toBe(0);
  });

  it('a bulk delete follows the same rule', async () => {
    const set = clockAt(T0);
    const a = await save('First of a bulk deletion.');
    const b = await save('Second of a bulk deletion.');
    set(T0 + 20 * MIN);
    const c = await save('Third, saved later.');
    set(T0 + 25 * MIN);
    expect((await bulkDelete([a.id, b.id, c.id])).changed).toBe(3);
    expect((await ledgerIds()).facts.filter((id) => id.startsWith('hu_'))).toEqual([`hu_${c.id}`]);
    expect(await totalXp()).toBe(4);
  });
});

describe('completeStudySession', () => {
  it('awards +5 once per session, only for an answer that still stands, and clears only its own session', async () => {
    const { deck, cards } = await deckWithCards(3);
    const { session } = await startStudySession({
      deckIds: [deck.id],
      now: T0 + MIN,
      boundary: UTC,
    });
    // another session id: nothing to award, and the stored session stays
    expect(await completeStudySession('session-elsewhere-1')).toEqual({ status: 'no_answers' });
    expect((await loadStudySession())?.id).toBe(session.id);

    expect(
      (await reviewCard(cards[0]!.id, 3, { sessionId: session.id, now: T0 + 2 * MIN })).status,
    ).toBe('reviewed');
    expect(await completeStudySession(session.id, { now: T0 + 3 * MIN })).toEqual({
      status: 'awarded',
    });
    expect(await loadStudySession()).toBeNull();
    expect(await getDb().gameFacts.get(`sb_${session.id}`)).toMatchObject({
      kind: 'session',
      at: iso(T0 + 3 * MIN),
    });
    expect(await totalXp()).toBe(3 * 3 + 1 + 5);
    // an undo after the done screen, then done again: the bonus stays
    await undoLastReview(cards[0]!.id);
    expect(await completeStudySession(session.id)).toEqual({ status: 'already' });
    expect(await totalXp()).toBe(3 * 3 + 5);

    // an empty queue also reaches the done screen
    const empty = await startStudySession({ deckIds: [deck.id], now: T0 + 4 * MIN });
    expect(await completeStudySession(empty.session.id)).toEqual({ status: 'no_answers' });
    // every answer undone
    const third = await startStudySession({ deckIds: [deck.id], now: T0 + 5 * MIN });
    await reviewCard(cards[1]!.id, 2, { sessionId: third.session.id, now: T0 + 6 * MIN });
    await undoLastReview(cards[1]!.id);
    expect(await completeStudySession(third.session.id)).toEqual({ status: 'no_answers' });
    expect((await ledgerIds()).facts.filter((id) => id.startsWith('sb_'))).toEqual([
      `sb_${session.id}`,
    ]);
    await expect(completeStudySession('')).rejects.toMatchObject({ code: 'invalid_request' });
  });
});

describe('purge', () => {
  it('keeps total XP and copies the purged rows’ events into gameFacts, enough for a fresh device', async () => {
    const set = clockAt(T0);
    const h = await save('A highlight with a card and a review, later purged.');
    const [card] = await createCardsFromHighlight(h.id, [basic(1)]);
    const out = await reviewCard(card!.id, 3, { now: T0 + MIN });
    const logId = out.status === 'reviewed' ? out.log.id : '';
    set(T0 + 30 * MIN);
    await softDeleteHighlight(h.id);
    expect(await totalXp()).toBe(6);
    const db = getDb();
    const events = await db.gameEvents.toArray();
    await purge([h.id]);
    expect(await db.highlights.count()).toBe(0);
    expect(await db.cards.count()).toBe(0);
    expect(await db.reviewLogs.count()).toBe(0);
    expect(await totalXp()).toBe(6);
    for (const id of [`hs_${h.id}`, `cd_${card!.id}`, `rv_${logId}`]) {
      expect(await db.gameFacts.get(id)).toEqual(events.find((e) => e.id === id));
    }
    // A device that joins later has no gameEvents of its own for these rows: the copies carry the XP.
    await db.gameEvents.clear();
    expect(await totalXp()).toBe(6);
  });
});

describe('the sync applier', () => {
  it('derives events for a remote log, highlight and card, skips a remote import, writes nothing on delete', async () => {
    const rt = await createSyncRuntime({ isEnabled: () => true });
    const db = getDb();
    const { cards } = await deckWithCards(1);
    const out = await reviewCard(cards[0]!.id, 3, { now: T0 + MIN });
    const h = await save('A highlight to copy as a remote one.');
    const local = {
      highlight: (await db.highlights.get(h.id)) as Record<string, unknown>,
      card: (await db.cards.get(cards[0]!.id)) as Record<string, unknown>,
      log: out.status === 'reviewed' ? (out.log as Record<string, unknown>) : {},
    };
    const create = (entityType: string, row: Record<string, unknown>) =>
      rt.applier.apply({
        entityType,
        entityId: String(row.id),
        deleted: false,
        create: true,
        fields: Object.fromEntries(
          // the wire never carries device-local fields
          Object.entries(row).filter(
            ([k]) =>
              !['schemaVersion', 'resolveStatus', 'resolveConfidence', 'lastResolvedAt'].includes(
                k,
              ),
          ),
        ) as never,
        sets: {},
      });
    await create('highlights', { ...local.highlight, id: 'remote-hl-00001' });
    await create('highlights', {
      ...local.highlight,
      id: 'remote-imp-0001',
      captureMethod: 'import',
    });
    await create('cards', { ...local.card, id: 'remote-card-001' });
    await create('reviewLogs', { ...local.log, id: 'remote-log-0001', cardId: 'remote-card-001' });
    const ids = (await ledgerIds()).events;
    expect(ids).toEqual(
      expect.arrayContaining(['hs_remote-hl-00001', 'cd_remote-card-001', 'rv_remote-log-0001']),
    );
    expect(ids).not.toContain('hs_remote-imp-0001');
    const before = await ledgerIds();
    await rt.applier.apply({
      entityType: 'highlights',
      entityId: 'remote-hl-00001',
      deleted: true,
      create: false,
      fields: {},
      sets: {},
    });
    expect(await ledgerIds()).toEqual(before);
    await expectLedgerComplete();
  });

  it('a remote delete keeps the XP of a row this device has not derived yet (a purge elsewhere)', async () => {
    const rt = await createSyncRuntime({ isEnabled: () => true });
    const h = await save('Purged on another device before this one derived it.');
    const db = getDb();
    await db.gameEvents.delete(`hs_${h.id}`); // as if this device's backfill had not reached it
    await rt.applier.apply({
      entityType: 'highlights',
      entityId: h.id,
      deleted: true,
      create: false,
      fields: {},
      sets: {},
    });
    expect(await db.highlights.get(h.id)).toBeUndefined();
    expect(await db.gameEvents.get(`hs_${h.id}`)).toMatchObject({ kind: 'save', ref: h.id });
  });

  it('applies a remote game fact as a plain row: a goal set on another device applies here', async () => {
    const rt = await createSyncRuntime({ isEnabled: () => true });
    const goal = {
      id: 'gs_019a0000-0000-7000-8000-000000000001',
      kind: 'goal',
      at: iso(Date.now() - MIN),
      ref: null,
      value: 50,
    };
    await rt.applier.apply({
      entityType: 'gameFacts',
      entityId: goal.id,
      deleted: false,
      create: true,
      fields: goal,
      sets: {},
    });
    expect((await readyState()).goal).toEqual({ value: 50, chosen: true });
  });

  it('with capture on, only the few game facts reach the outbox; events never do', async () => {
    const rt = await createSyncRuntime({ isEnabled: () => true });
    rt.startCapture();
    const { cards } = await deckWithCards(1);
    await reviewCard(cards[0]!.id, 3, { now: T0 + MIN });
    await undoLastReview(cards[0]!.id);
    await setDailyGoal(10);
    const pending = (await rt.log.pending(10_000)).map(
      (p) => `${p.op.entityType}:${p.op.entityId}`,
    );
    expect(pending.filter((p) => p.startsWith('gameEvents'))).toEqual([]);
    expect(pending.filter((p) => p.startsWith('gameFacts:ru_'))).toHaveLength(1);
    expect(pending.filter((p) => p.startsWith('gameFacts:gs_'))).toHaveLength(1);
    rt.stopCapture();
  });
});

describe('goal and Game mode', () => {
  it('a chosen goal applies from today and is a row, so it is backed up and synced', async () => {
    expect((await readyState()).goal).toEqual({ value: 30, chosen: false });
    await setDailyGoal(10);
    expect((await readyState()).goal).toEqual({ value: 10, chosen: true });
    await expect(setDailyGoal(20 as never)).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('a choice made after the clock ran ahead still wins, for the goal and for Game mode', async () => {
    const ahead = T0 + 2 * 60 * MIN;
    await setDailyGoal(50, { now: ahead });
    await setDailyGoal(10, { now: T0 }); // the clock was put right
    expect((await readyState(T0)).goal.value).toBe(10);
    await setGameMode(false, { now: ahead });
    await setGameMode(true, { now: T0 });
    await setGameMode(true, { now: T0 + MIN }); // already on: no row
    expect(await isGameModeOn()).toBe(true);
    expect((await ledgerIds()).facts.filter((id) => id.startsWith('gm_'))).toHaveLength(2);
  });

  it('Game mode off hides celebrations; recording continues; a switch writes only on change', async () => {
    expect(await isGameModeOn()).toBe(true);
    await setGameMode(true); // already on: no row
    expect((await ledgerIds()).facts.filter((id) => id.startsWith('gm_'))).toEqual([]);
    await setGameMode(false);
    await setGameMode(false);
    expect((await ledgerIds()).facts.filter((id) => id.startsWith('gm_'))).toHaveLength(1);
    expect(await isGameModeOn()).toBe(false);
    await save('Saved while Game mode is off.');
    const off = await readyState();
    expect(off).toMatchObject({ mode: false, pending: [], totalXp: 2 });
    expect(off.today.saves).toBe(1);
    await setGameMode(true);
    // turned back on after the save: the first-save badge is earned, but not celebrated now
    const on = await readyState();
    expect(on.badges.find((b) => b.id === 'first_save')!.unlockedDayKey).not.toBeNull();
    expect(on.pending).toEqual([]);
    const state = await getGameState({ boundary: UTC });
    expect(state.ready && state.rulesVersion).toBe(GAME_RULES_VERSION);
  });
});

describe('claimCelebrations', () => {
  it('two pages racing claim each key exactly once', async () => {
    await save('The first save of this vault.');
    const { pending } = await readyState();
    expect(pending.map((c) => c.key)).toContain('badge:first_save');
    const [a, b] = await Promise.all([claimCelebrations(pending), claimCelebrations(pending)]);
    expect([...a, ...b].map((c) => c.key).sort()).toEqual(pending.map((c) => c.key).sort());
    expect((await readyState()).pending).toEqual([]);
    expect(await claimCelebrations(pending)).toEqual([]);
  });

  it('claims nothing before the backfill set the baseline, and prunes dated keys that cannot recur', async () => {
    const db = getDb();
    await db.meta.delete(GAME_SEEN_KEY);
    const old: Celebration = {
      key: 'goal:2026-01-01',
      at: '2026-01-01T12:00:00.000Z',
      kind: 'goal',
      dayKey: '2026-01-01',
      goal: 30,
      xp: 31,
    };
    expect(await claimCelebrations([old])).toEqual([]);
    expect(await db.meta.get(GAME_SEEN_KEY)).toBeUndefined();
    await db.meta.put({
      key: GAME_SEEN_KEY,
      value: { v: 1, baselineAt: '2026-01-01T00:00:00.000Z', keys: ['goal:2026-01-01', 'level:3'] },
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const today: Celebration = {
      key: 'level:4',
      at: '2026-03-10T12:00:00.000Z',
      kind: 'level',
      level: 4,
    };
    expect(await claimCelebrations([today], { now: '2026-03-10T12:00:00.000Z' })).toEqual([today]);
    const seen = (await db.meta.get(GAME_SEEN_KEY))!.value as { keys: string[] };
    expect(seen.keys.sort()).toEqual(['level:3', 'level:4']);
    await expect(claimCelebrations([{ ...today, key: '' }])).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });
});

describe('a fresh device', () => {
  it('reports progress, never partial numbers, until the backfill finished', async () => {
    await freshDatabase();
    closeDb();
    const state = await getGameState({ boundary: UTC });
    expect(state).toEqual({
      ready: false,
      mode: true,
      backfill: { status: 'pending', done: 0, total: 0, error: null },
    });
    await expect(
      getGameState({ boundary: { timeZone: 'Nowhere/City', rolloverHour: 4 } }),
    ).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });
});

describe('inside a live query (how the UI reads it)', () => {
  /** One subscription, as `useObserved` makes on every dataEpoch bump: its first value. */
  async function firstValue(): Promise<string> {
    const seen: string[] = [];
    const errors: unknown[] = [];
    const stop = observe(() => getGameState({ boundary: UTC })).subscribe(
      (s) => seen.push(s.ready ? `xp:${s.totalXp}` : `waiting:${s.backfill.status}`),
      (err) => errors.push(err),
    );
    try {
      await vi.waitFor(() => expect(seen.length + errors.length).toBeGreaterThan(0), {
        timeout: 5000,
      });
      expect(errors).toEqual([]); // no write and no "transaction committed too early"
      return seen[0]!;
    } finally {
      stop();
    }
  }

  it('reads without writing, waiting and ready, and follows the ledger on each resubscription', async () => {
    await freshDatabase();
    await save('Saved before the game was ready.');
    expect(await firstValue()).toBe('waiting:pending');
    expect((await runGameBackfill()).status).toBe('done');
    expect(await firstValue()).toBe('xp:2');
    await save('Saved while the view is open.');
    expect(await firstValue()).toBe('xp:4');
  });
});
