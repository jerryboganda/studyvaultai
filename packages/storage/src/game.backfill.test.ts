// @vitest-environment node
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportBackup, restoreBackup } from '@backup';
import type { TableRegistry } from '@shared';
import { DAY_MS } from '@study';
import {
  BACKUP_MIGRATIONS,
  backupTableRegistry,
  createBackupTarget,
  createSnapshotSource,
  deletePreMigrationSnapshot,
} from './backupTarget';
import { getDb } from './db';
import {
  GAME_BACKFILL_KEY,
  GAME_CACHE_KEY,
  GAME_META_KEYS,
  getGameState,
  runGameBackfill,
  saveGameCache,
  setDailyGoal,
  setGameMode,
  type GameState,
} from './game';
import { saveCapture, softDeleteHighlight } from './repo';
import {
  completeStudySession,
  createDeck,
  createManualCards,
  createCardsFromHighlight,
  reviewCard,
  startStudySession,
  undoLastReview,
} from './study';
import { createSyncRuntime } from './sync';
import { purge } from './trash';
import { cap } from './test-fixtures';
import { UTC, expectLedgerComplete, importQuote, ledgerIds, readyState } from './test-game';
import { freshDatabase, save } from './test-vault';

const MIN = 60_000;
const T0 = Date.parse('2026-03-02T15:00:00.000Z');
const NOW = T0 + 5 * DAY_MS;
const NEW_YORK = { timeZone: 'America/New_York', rolloverHour: 4 };
const options = { appVersion: 'test' };

beforeEach(async () => {
  await freshDatabase();
  await deletePreMigrationSnapshot();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
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

/**
 * A history spread over five study days: 4 saves (one trashed 20 minutes later, so it keeps its
 * XP), an import, 5 cards, 6 reviews (one undone) and one finished session. Leaves the clock at NOW.
 */
async function seedHistory() {
  const set = clockAt(T0);
  const saves = [];
  for (let i = 0; i < 4; i++) saves.push(await save(`History fact number ${i} for the backfill.`));
  await importQuote('An imported quote never earns XP.');
  const deck = await createDeck({ name: 'History' });
  const cards = await createManualCards([1, 2, 3, 4].map(basic), { deckId: deck.id, now: T0 });
  const [fromHighlight] = await createCardsFromHighlight(saves[3]!.id, [basic(5)], { now: T0 });
  cards.push(fromHighlight!);
  set(T0 + 20 * MIN);
  await softDeleteHighlight(saves[3]!.id);
  const { session } = await startStudySession({
    deckIds: [deck.id],
    now: T0 + DAY_MS,
    boundary: UTC,
  });
  for (let i = 0; i < 5; i++) {
    await reviewCard(cards[i]!.id, 3, { now: T0 + i * DAY_MS + 30 * MIN, sessionId: session.id });
  }
  await reviewCard(cards[0]!.id, 4, { now: T0 + 4 * DAY_MS + 40 * MIN });
  await undoLastReview(cards[0]!.id, { now: T0 + 4 * DAY_MS + 41 * MIN });
  await completeStudySession(session.id, { now: T0 + 4 * DAY_MS + 50 * MIN });
  set(NOW);
  return { saves, cards, deck, session };
}
/** 4 saves x2 + 5 cards x3 + 5 standing reviews + the +5 bonus. */
const HISTORY_XP = 4 * 2 + 5 * 3 + 5 + 5;

/** What a v4 vault looks like after the upgrade: the source rows, no ledger, no game records. */
async function asIfBeforeTheUpdate(): Promise<void> {
  const db = getDb();
  await db.gameEvents.clear();
  await db.gameFacts.clear();
  await db.meta.bulkDelete([...GAME_META_KEYS]);
}

/** The ledger the source rows imply (no gx_ start fact, no session bonuses, goals or modes). */
async function derivable(): Promise<{ events: string[]; facts: string[] }> {
  const db = getDb();
  const events: string[] = [];
  const facts: string[] = [];
  for (const l of (await db.reviewLogs.toArray()) as Record<string, unknown>[]) {
    events.push(`rv_${String(l.id)}`);
    if (l.userCorrection) facts.push(`ru_${String(l.id)}`);
  }
  for (const h of await db.highlights.toArray()) {
    if (h.captureMethod !== 'import') events.push(`hs_${h.id}`);
  }
  for (const c of await db.cards.toArray()) events.push(`cd_${String(c.id)}`);
  return { events: events.sort(), facts: facts.sort() };
}

const withoutStart = (ids: string[]) => ids.filter((id) => !id.startsWith('gx_'));

/** Everything a viewer sees, minus the opaque cache hand-off and the device-local backfill view. */
function view(s: GameState) {
  if (!s.ready) throw new Error('not ready');
  const { cacheUpdate: _c, backfill: _b, ...rest } = s;
  return rest;
}

const v4Registry = (): TableRegistry => ({
  schemaVersion: 4,
  tables: backupTableRegistry.tables.filter(
    (t) => t.name !== 'gameEvents' && t.name !== 'gameFacts',
  ),
});

describe('the backfill', () => {
  it('derives exactly the expected ledger, ru_ for undone logs included; a second run adds 0', async () => {
    await seedHistory();
    await asIfBeforeTheUpdate();
    expect(await getGameState({ boundary: UTC })).toMatchObject({
      ready: false,
      backfill: { status: 'pending' },
    });
    const run = await runGameBackfill({ pageSize: 2 });
    const expected = await derivable();
    expect(run).toEqual({ status: 'done', added: expected.events.length + expected.facts.length });
    const ids = await ledgerIds();
    expect(ids.events).toEqual(expected.events);
    expect(withoutStart(ids.facts)).toEqual(expected.facts);
    expect(ids.facts.filter((id) => id.startsWith('gx_'))).toHaveLength(1);
    expect(await runGameBackfill({ pageSize: 2 })).toEqual({ status: 'done', added: 0 });
    const state = await readyState(NOW);
    // The session bonus was earned before the update: nothing records it, so it is not invented.
    expect(state.totalXp).toBe(HISTORY_XP - 5);
    // 6 logs + 5 highlights (the import is read too) + 5 cards
    expect(state.backfill).toEqual({ status: 'done', done: 16, total: 16, error: null });
    await expectLedgerComplete();
  });

  it('resumes at its checkpoint after a failure (a killed worker) and ends with the same set', async () => {
    await seedHistory();
    await asIfBeforeTheUpdate();
    const db = getDb();
    const real = db.gameEvents.bulkAdd.bind(db.gameEvents);
    let calls = 0;
    const spy = vi.spyOn(db.gameEvents, 'bulkAdd').mockImplementation(((...args: unknown[]) => {
      calls++;
      if (calls === 3) return Promise.reject(new Error('the worker was stopped'));
      return (real as (...a: unknown[]) => unknown)(...args);
    }) as never);
    const first = await runGameBackfill({ pageSize: 2 });
    spy.mockRestore();
    expect(first).toMatchObject({ status: 'failed', error: 'the worker was stopped' });
    expect(first.added).toBeGreaterThan(0);
    const marker = (await db.meta.get(GAME_BACKFILL_KEY))!.value as Record<string, unknown>;
    expect(marker).toMatchObject({
      status: 'failed',
      table: 'reviewLogs',
      after: expect.any(String),
    });
    expect(await getGameState({ boundary: UTC })).toMatchObject({
      ready: false,
      backfill: { status: 'failed', error: 'the worker was stopped' },
    });
    const second = await runGameBackfill({ pageSize: 2 });
    const expected = await derivable();
    expect(second.status).toBe('done');
    expect(first.added + second.added).toBe(expected.events.length + expected.facts.length);
    const ids = await ledgerIds();
    expect(ids.events).toEqual(expected.events);
    expect(withoutStart(ids.facts)).toEqual(expected.facts);
  });

  it('two runs at once: one is busy, the ledger is the same', async () => {
    await seedHistory();
    await asIfBeforeTheUpdate();
    const runs = await Promise.all([
      runGameBackfill({ pageSize: 2 }),
      runGameBackfill({ pageSize: 2 }),
    ]);
    expect(runs.map((r) => r.status).sort()).toEqual(['busy', 'done']);
    const expected = await derivable();
    expect((await ledgerIds()).events).toEqual(expected.events);
  });

  it('live reviews and an undo during the backfill land exactly once', async () => {
    const { cards } = await seedHistory();
    await asIfBeforeTheUpdate();
    let pauses = 0;
    const run = await runGameBackfill({
      pageSize: 2,
      betweenPages: async () => {
        if (++pauses !== 2) return;
        await reviewCard(cards[3]!.id, 4, { now: NOW + MIN });
        await reviewCard(cards[4]!.id, 2, { now: NOW + 2 * MIN });
        await undoLastReview(cards[4]!.id, { now: NOW + 3 * MIN });
      },
    });
    expect(run.status).toBe('done');
    const expected = await derivable();
    const ids = await ledgerIds();
    expect(ids.events).toEqual(expected.events);
    expect(withoutStart(ids.facts)).toEqual(expected.facts);
    expect((await readyState(NOW + DAY_MS)).totalXp).toBe(HISTORY_XP - 5 + 1);
    await expectLedgerComplete();
  });

  it('a replace restore mid-run stops it (restarted); the next run re-derives from the restored rows', async () => {
    await seedHistory();
    const archive = await exportBackup(
      { ...(await createSnapshotSource()), registry: v4Registry() },
      options,
    );
    expect(archive.manifest.appSchemaVersion).toBe(4);
    await save('Only in the live vault, never in the archive.');
    await setDailyGoal(50);
    await asIfBeforeTheUpdate();
    let pauses = 0;
    const run = await runGameBackfill({
      pageSize: 2,
      betweenPages: async () => {
        if (++pauses !== 1) return;
        await restoreBackup(archive.bytes, {
          target: createBackupTarget(),
          mode: 'replace',
          migrations: BACKUP_MIGRATIONS,
        });
      },
    });
    expect(run.status).toBe('restarted');
    // the restore emptied the game tables (the archive has none) and reset the marker
    expect(await ledgerIds()).toEqual({ events: [], facts: [] });
    expect(await getGameState({ boundary: UTC })).toMatchObject({
      backfill: { status: 'pending' },
    });
    expect((await runGameBackfill()).status).toBe('done');
    const expected = await derivable();
    const ids = await ledgerIds();
    expect(ids.events).toEqual(expected.events); // no ghost events of the replaced rows
    expect(withoutStart(ids.facts)).toEqual(expected.facts);
    const state = await readyState(NOW);
    expect(state.totalXp).toBe(HISTORY_XP - 5);
    expect(state.goal).toEqual({ value: 30, chosen: false }); // the goal card comes back
  });

  it('a quota error reports failed, and the app keeps saving', async () => {
    await seedHistory();
    await asIfBeforeTheUpdate();
    const db = getDb();
    const quota = Object.assign(new Error('The quota has been exceeded.'), {
      name: 'QuotaExceededError',
    });
    const spy = vi.spyOn(db.gameEvents, 'bulkAdd').mockRejectedValueOnce(quota);
    expect(await runGameBackfill({ pageSize: 2 })).toMatchObject({
      status: 'failed',
      error: 'quota_exceeded',
    });
    spy.mockRestore();
    expect(await getGameState({ boundary: UTC })).toMatchObject({
      ready: false,
      backfill: { status: 'failed', error: 'quota_exceeded' },
    });
    expect((await saveCapture(cap('A save while the game is unavailable.', 4000))).status).toBe(
      'created',
    );
    expect((await runGameBackfill()).status).toBe('done');
    await expectLedgerComplete();
  });

  it('a purge before the backfill reached the purged rows keeps their XP; an undone log nets 0', async () => {
    const { saves, cards } = await seedHistory();
    // The purged highlight's card also has an undone review: its copy must not come back as +1.
    await reviewCard(cards[4]!.id, 4, { now: NOW - 30 * MIN });
    await undoLastReview(cards[4]!.id, { now: NOW - 29 * MIN });
    await asIfBeforeTheUpdate(); // just updated: pending (the same for running or failed)
    await purge([saves[3]!.id]);
    const db = getDb();
    expect(await db.reviewLogs.where('cardId').equals(cards[4]!.id).count()).toBe(0);
    expect((await runGameBackfill()).status).toBe('done');
    expect((await readyState(NOW)).totalXp).toBe(HISTORY_XP - 5);
    // The copies carry the purged XP to a device that joins later, the undo included.
    const facts = (await ledgerIds()).facts;
    expect(facts).toEqual(expect.arrayContaining([`hs_${saves[3]!.id}`, `cd_${cards[4]!.id}`]));
    expect(facts.filter((id) => id.startsWith('rv_'))).toHaveLength(2);
    expect(facts.filter((id) => id.startsWith('ru_'))).toHaveLength(2); // cards[0]'s and this one
    await expectLedgerComplete();
  });

  it('a rules version change re-runs it over the whole history', async () => {
    await seedHistory();
    await asIfBeforeTheUpdate();
    expect((await runGameBackfill()).status).toBe('done');
    const db = getDb();
    const marker = (await db.meta.get(GAME_BACKFILL_KEY))!;
    await db.meta.put({
      ...marker,
      value: { ...(marker.value as Record<string, unknown>), rulesVersion: 0 },
    });
    const [lost] = await db.gameEvents.limit(1).primaryKeys();
    await db.gameEvents.delete(lost!);
    expect(await getGameState({ boundary: UTC })).toMatchObject({
      ready: false,
      backfill: { status: 'pending' },
    });
    expect(await runGameBackfill()).toEqual({ status: 'done', added: 1 });
    expect((await db.meta.get(GAME_BACKFILL_KEY))!.value).toMatchObject({
      rulesVersion: 1,
      status: 'done',
    });
  });
});

describe('the per-day cache', () => {
  async function prime(now: number, b = UTC): Promise<void> {
    const s = await readyState(now, b);
    if (s.cacheUpdate) await saveGameCache(s.cacheUpdate);
  }
  async function expectWarmEqualsCold(now: number, b = UTC): Promise<void> {
    const warm = view(await readyState(now, b));
    await getDb().meta.delete(GAME_CACHE_KEY);
    expect(view(await readyState(now, b))).toEqual(warm);
  }

  it('a warm state equals a cold state after every kind of change', async () => {
    const { cards, saves } = await seedHistory();
    expect((await runGameBackfill()).status).toBe('done');
    await prime(NOW);
    expect((await readyState(NOW)).cacheUpdate).toBeNull(); // a hit
    const steps: Array<[string, () => Promise<unknown>]> = [
      ['a review in a closed day', () => reviewCard(cards[2]!.id, 3, { now: T0 + DAY_MS + MIN })],
      ['its undo', () => undoLastReview(cards[2]!.id, { now: NOW })],
      ['a save today', () => save('Saved on the day of the cache test.')],
      [
        'a quick delete',
        async () => softDeleteHighlight((await save('Saved and undone at once.')).id),
      ],
      ['cards in a closed day', () => createManualCards([basic(9)], { now: T0 + 2 * DAY_MS })],
      ['a purge', () => purge([saves[3]!.id])],
      ['a back-dated goal', () => setDailyGoal(10, { now: T0 + 2 * DAY_MS })],
      ['a goal today', () => setDailyGoal(50)],
      ['Game mode off', () => setGameMode(false)],
      [
        'a remote log from another device',
        async () => {
          const rt = await createSyncRuntime({ isEnabled: () => true });
          const log = (await getDb().reviewLogs.toArray())[0]!;
          await rt.applier.apply({
            entityType: 'reviewLogs',
            entityId: 'remote-log-cache-1',
            deleted: false,
            create: true,
            fields: {
              ...log,
              id: 'remote-log-cache-1',
              reviewedAt: new Date(T0 + 3 * DAY_MS).toISOString(),
            },
            sets: {},
          });
        },
      ],
    ];
    for (const [label, mutate] of steps) {
      await prime(NOW);
      await mutate();
      await expectWarmEqualsCold(NOW).catch((e: unknown) => {
        throw new Error(`after ${label}: ${String(e)}`);
      });
    }
    // a merge restore and a replace restore (both change the key)
    const archive = await exportBackup(await createSnapshotSource(), options);
    await prime(NOW);
    await restoreBackup(archive.bytes, {
      target: createBackupTarget(),
      mode: 'merge',
      migrations: BACKUP_MIGRATIONS,
    });
    await expectWarmEqualsCold(NOW);
    await prime(NOW);
    await restoreBackup(archive.bytes, {
      target: createBackupTarget(),
      mode: 'replace',
      migrations: BACKUP_MIGRATIONS,
    });
    expect((await runGameBackfill()).status).toBe('done');
    await expectWarmEqualsCold(NOW);
    // another study-day boundary, and the incremental rollover of one and of three days
    await prime(NOW);
    await expectWarmEqualsCold(NOW, NEW_YORK);
    await prime(NOW);
    await expectWarmEqualsCold(NOW + DAY_MS);
    await prime(NOW);
    await expectWarmEqualsCold(NOW + 3 * DAY_MS);
    await expectLedgerComplete();
  });

  it('saveGameCache refuses a rollup when a row was added below its cut, or the vault was replaced', async () => {
    const { cards } = await seedHistory();
    expect((await runGameBackfill()).status).toBe('done');
    const db = getDb();
    const stale = (await readyState(NOW)).cacheUpdate!;
    await reviewCard(cards[1]!.id, 3, { now: T0 + DAY_MS + 5 * MIN }); // below the cut
    await saveGameCache(stale);
    expect(await db.meta.get(GAME_CACHE_KEY)).toBeUndefined();
    const fresh = (await readyState(NOW)).cacheUpdate!;
    const archive = await exportBackup(await createSnapshotSource(), options);
    await restoreBackup(archive.bytes, {
      target: createBackupTarget(),
      mode: 'replace',
      migrations: BACKUP_MIGRATIONS,
    });
    await saveGameCache(fresh); // the restore changed the key
    expect(await db.meta.get(GAME_CACHE_KEY)).toBeUndefined();
    expect((await runGameBackfill()).status).toBe('done');
    await saveGameCache((await readyState(NOW)).cacheUpdate!);
    expect(await db.meta.get(GAME_CACHE_KEY)).toBeDefined();
    expect((await readyState(NOW)).cacheUpdate).toBeNull();
    await expect(saveGameCache({ ...fresh, days: [[1, -5, 0, 0, 0, 0, 0]] })).rejects.toMatchObject(
      {
        code: 'invalid_request',
      },
    );
  });
});

describe('backup and restore', () => {
  it('a v5 archive round-trips both tables exactly, and a replace gives the same game state', async () => {
    await seedHistory();
    expect((await runGameBackfill()).status).toBe('done');
    await setDailyGoal(10);
    await setGameMode(false);
    await setGameMode(true);
    const db = getDb();
    const before = {
      events: await db.gameEvents.toArray(),
      facts: await db.gameFacts.toArray(),
      state: view(await readyState(NOW)),
    };
    const archive = await exportBackup(await createSnapshotSource(), options);
    expect(archive.manifest.tables.map((t) => t.name)).toEqual(
      expect.arrayContaining(['gameEvents', 'gameFacts']),
    );
    await freshDatabase();
    await restoreBackup(archive.bytes, {
      target: createBackupTarget(),
      mode: 'replace',
      migrations: BACKUP_MIGRATIONS,
    });
    expect(await getDb().gameEvents.toArray()).toEqual(before.events);
    expect(await getDb().gameFacts.toArray()).toEqual(before.facts);
    expect(await runGameBackfill()).toEqual({ status: 'done', added: 0 });
    // The baseline is new (a replace resets it), so nothing old is pending; everything else matches.
    expect({ ...view(await readyState(NOW)), pending: [] }).toEqual({
      ...before.state,
      pending: [],
    });
  });

  it('a replace with a v4 archive empties the game tables; the backfill re-derives them; the goal card returns', async () => {
    await seedHistory();
    await setDailyGoal(100);
    const archive = await exportBackup(
      { ...(await createSnapshotSource()), registry: v4Registry() },
      options,
    );
    const { report } = await restoreBackup(archive.bytes, {
      target: createBackupTarget(),
      mode: 'replace',
      migrations: BACKUP_MIGRATIONS,
    });
    expect(report.migratedFromVersion).toBe(4);
    expect(report.replaceImpact.clearedWithoutArchiveData).toEqual(
      expect.arrayContaining(['gameEvents', 'gameFacts']),
    );
    expect(await ledgerIds()).toEqual({ events: [], facts: [] });
    expect((await runGameBackfill()).status).toBe('done');
    const expected = await derivable();
    const ids = await ledgerIds();
    expect(ids.events).toEqual(expected.events);
    expect(withoutStart(ids.facts)).toEqual(expected.facts);
    const state = await readyState(NOW);
    expect(state.totalXp).toBe(HISTORY_XP - 5); // the archive held no session bonus
    expect(state.goal).toEqual({ value: 30, chosen: false });
    expect(state.badges.find((b) => b.id === 'first_session')!.unlockedDayKey).toBeNull();
  });

  it('merging your own archive adds no game rows', async () => {
    await seedHistory();
    const before = await ledgerIds();
    const archive = await exportBackup(await createSnapshotSource(), options);
    const { report } = await restoreBackup(archive.bytes, {
      target: createBackupTarget(),
      mode: 'merge',
      migrations: BACKUP_MIGRATIONS,
    });
    expect(report.totals).toMatchObject({ add: 0, update: 0, conflict: 0 });
    expect(await ledgerIds()).toEqual(before);
  });

  it('a merge earns nothing on any path: before the backfill, on re-derivation, after a replace, on another device', async () => {
    // Another vault, exported without game tables (v4): a save, its card, a standing and an undone review.
    const set = clockAt(T0);
    const h = await save('Another vault’s highlight, merged into this one.');
    const [card] = await createCardsFromHighlight(h.id, [basic(1)], { now: T0 });
    await reviewCard(card!.id, 3, { now: T0 + MIN });
    await reviewCard(card!.id, 4, { now: T0 + 2 * MIN });
    await undoLastReview(card!.id, { now: T0 + 3 * MIN });
    const logIds = (await getDb().reviewLogs.toArray()).map((l) => String(l.id));
    const archive = await exportBackup(
      { ...(await createSnapshotSource()), registry: v4Registry() },
      options,
    );
    await freshDatabase();
    await deletePreMigrationSnapshot();
    set(NOW);
    await save('This vault’s own highlight.'); // 2 XP; the backfill has not run yet
    const merge = (bytes: Uint8Array) =>
      restoreBackup(bytes, {
        target: createBackupTarget(),
        mode: 'merge',
        migrations: BACKUP_MIGRATIONS,
      });
    await merge(archive.bytes);
    expect((await runGameBackfill()).status).toBe('done');
    expect((await readyState(NOW)).totalXp).toBe(2);

    // The cancellers are synced rows: reconcile sends them with the merged rows, so another device's
    // applier, which derives the merged rows' events, nets 0 too.
    const rt = await createSyncRuntime({ isEnabled: () => true });
    await rt.reconcile();
    const queued = (await rt.log.pending(10_000)).map((p) => `${p.op.entityType}:${p.op.entityId}`);
    expect(queued).toEqual(
      expect.arrayContaining([
        `gameFacts:hu_${h.id}`,
        `gameFacts:cu_${card!.id}`,
        ...logIds.map((id) => `gameFacts:ru_${id}`),
      ]),
    );

    // A rules change re-derives every row.
    const db = getDb();
    const marker = (await db.meta.get(GAME_BACKFILL_KEY))!;
    await db.meta.put({
      ...marker,
      value: { ...(marker.value as Record<string, unknown>), rulesVersion: 0 },
    });
    expect((await runGameBackfill()).status).toBe('done');
    expect((await readyState(NOW)).totalXp).toBe(2);

    // A replace with this vault's own (v5) export re-derives from the restored rows.
    const own = await exportBackup(await createSnapshotSource(), options);
    await restoreBackup(own.bytes, {
      target: createBackupTarget(),
      mode: 'replace',
      migrations: BACKUP_MIGRATIONS,
    });
    expect((await runGameBackfill()).status).toBe('done');
    expect((await readyState(NOW)).totalXp).toBe(2);
    // merging the same archive again adds nothing at all
    await merge(archive.bytes);
    expect((await readyState(NOW)).totalXp).toBe(2);
  });

  it('a log brought back by a merge earns nothing new', async () => {
    const { cards } = await seedHistory();
    expect((await runGameBackfill()).status).toBe('done');
    const out = await reviewCard(cards[1]!.id, 3, { now: NOW });
    const logId = out.status === 'reviewed' ? out.log.id : '';
    const archive = await exportBackup(
      { ...(await createSnapshotSource()), registry: v4Registry() },
      options,
    );
    const db = getDb();
    await db.reviewLogs.delete(logId); // a vault that does not have this log
    await db.gameEvents.delete(`rv_${logId}`);
    const xp = (await readyState(NOW)).totalXp;
    await restoreBackup(archive.bytes, {
      target: createBackupTarget(),
      mode: 'merge',
      migrations: BACKUP_MIGRATIONS,
    });
    expect(await db.reviewLogs.get(logId)).toBeDefined();
    expect(await db.gameEvents.get(`rv_${logId}`)).toBeUndefined();
    expect((await readyState(NOW)).totalXp).toBe(xp);
  });
});
