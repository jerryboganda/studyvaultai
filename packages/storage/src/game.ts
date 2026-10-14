import Dexie, { type Table } from 'dexie';
import { uuidv7 } from 'uuidv7';
import { z } from 'zod';
import { Highlight, IsoDate } from '@shared';
import {
  DailyGoal,
  GAME_RULES_VERSION,
  GameEventRow,
  GameFactRow,
  UNDO_SAVE_WINDOW_MS,
  cardEvent,
  cardUndoFact,
  daysToTuples,
  deriveGame,
  goalFact,
  mergeDays,
  modeFact,
  pendingCelebrations,
  reviewEvent,
  reviewUndoFact,
  saveEvent,
  saveUndoFact,
  startFact,
  startFold,
  tuplesToDays,
  type Celebration,
  type DayMap,
  type DayTuple,
  type DerivedGame,
  type FoldResult,
  type GameEventKind,
  type GameRow,
  type GameSeen,
} from '@study/game';
import { Card, ReviewLog } from '@study/schema';
import {
  DAY_MS,
  DayBoundary,
  studyDayKey,
  studyDayNumber,
  studyDayStartMs,
  toIso,
  toMs,
  type DateInput,
} from '@study/time';
import { notNull, now as nowIso, parseInput, parseRow, signalChange } from './core';
import { toStorageError, withDb, withWritableDb, type MetaRow, type StudyVaultDb } from './db';

/**
 * Game layer storage (ADR-022): the two append-only ledger tables, the resumable backfill, the
 * read path with its per-day cache, and the few writes the UI makes (goal, Game mode, celebrations).
 * The rules themselves are pure (`@study` game.ts). Every XP-earning write adds its ledger row in
 * its own transaction through `addMissing` (hooks in study.ts, ai.ts, repo.ts, pdf.ts, bulk.ts,
 * sync.ts and trash.ts); nothing here is ever updated or deleted except by a replace restore.
 */

/** Device-local `meta` rows (never backed up, never synchronised). */
export const GAME_BACKFILL_KEY = 'game.backfill';
export const GAME_SEEN_KEY = 'game.seen';
export const GAME_CACHE_KEY = 'game.cache';
/** What a replace restore deletes, so the game is re-derived from the restored rows. */
export const GAME_META_KEYS = [GAME_BACKFILL_KEY, GAME_SEEN_KEY, GAME_CACHE_KEY] as const;
const LAST_RESTORE_KEY = 'lastRestore';

type GameTable = Table<GameRow, string>;

// ---------------------------------------------------------------------------------------------
// Write helpers used by the hooks (call inside a readwrite transaction that includes the table)
// ---------------------------------------------------------------------------------------------

/**
 * Add the rows whose id is not stored yet; returns how many were added. Ids are deterministic, so a
 * retry, the backfill, the sync applier and live writes racing each other add every row once.
 * Dexie promises only: the caller's transaction does not auto-commit.
 */
export async function addMissing(table: GameTable, rows: readonly GameRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const unique = [...new Map(rows.map((r) => [r.id, r])).values()];
  const have = await table.bulkGet(unique.map((r) => r.id));
  const missing = unique.filter((_, i) => have[i] === undefined);
  if (missing.length > 0) await table.bulkAdd(missing);
  return missing.length;
}

/** Source tables whose rows earn XP, in backfill order. */
const SOURCES = ['reviewLogs', 'highlights', 'cards'] as const;
export type SourceTable = (typeof SOURCES)[number];
/** The sync applier adds the ledger rows of these tables in its own transaction. */
export const GAME_SOURCE_TABLES: ReadonlySet<string> = new Set(SOURCES);

export interface DerivedLedger {
  /** `gameEvents` rows. */
  events: GameRow[];
  /** `gameFacts` rows: the `ru_` of a log that is already undone. */
  facts: GameRow[];
}

/**
 * The ledger rows of one validated source row: its event (none for an import or another table)
 * and, for a log that was undone, its `ru_`. The backfill and the sync applier both derive this
 * way, so a log that arrives already undone nets 0 wherever it is first seen.
 */
export function deriveLedger(table: string, row: unknown): DerivedLedger {
  if (table === 'reviewLogs') {
    const log = row as ReviewLog;
    return { events: [reviewEvent(log)], facts: log.userCorrection ? [reviewUndoFact(log)] : [] };
  }
  if (table === 'cards') return { events: [cardEvent(row as Card)], facts: [] };
  if (table === 'highlights') {
    const e = saveEvent(row as Highlight);
    return { events: e ? [e] : [], facts: [] };
  }
  return { events: [], facts: [] };
}

const SOURCE_SCHEMAS: Record<SourceTable, z.ZodType> = {
  reviewLogs: ReviewLog,
  highlights: Highlight,
  cards: Card,
};

const isSource = (table: string): table is SourceTable => GAME_SOURCE_TABLES.has(table);

/** Validated rows of a source table; parseRow skips (and logs) one that does not validate. */
const parsedSources = (table: SourceTable, rows: readonly unknown[]): unknown[] =>
  rows.flatMap((raw) => {
    const row = raw === undefined ? null : parseRow(SOURCE_SCHEMAS[table], raw, table);
    return row === null ? [] : [row];
  });

/**
 * Add the ledger rows that source rows imply, exactly as the backfill derives them; returns how many
 * were added. Inside a rw transaction over both ledger tables. A purge and a remote delete call it
 * before the rows go, so their XP never depends on whether the backfill had reached them yet (a
 * no-op when it had).
 */
export async function addLedgerOf(
  db: StudyVaultDb,
  table: string,
  rows: readonly unknown[],
): Promise<number> {
  if (!isSource(table)) return 0;
  const events: GameRow[] = [];
  const facts: GameRow[] = [];
  for (const row of parsedSources(table, rows)) {
    const derived = deriveLedger(table, row);
    events.push(...derived.events);
    facts.push(...derived.facts);
  }
  return (await addMissing(db.gameEvents, events)) + (await addMissing(db.gameFacts, facts));
}

/** The incoming source rows a merge restore adds (not in the vault yet). Read before its writes. */
export async function newSourceRows(
  db: StudyVaultDb,
  incoming: ReadonlyMap<string, readonly unknown[]>,
): Promise<Map<SourceTable, unknown[]>> {
  const out = new Map<SourceTable, unknown[]>();
  for (const table of SOURCES) {
    const rows = (incoming.get(table) ?? []) as ReadonlyArray<{ id?: unknown }>;
    if (rows.length === 0) continue;
    const have = await db.table(table).bulkGet(rows.map((r) => String(r.id)));
    out.set(
      table,
      rows.filter((_, i) => have[i] === undefined),
    );
  }
  return out;
}

/**
 * Inside a merge restore, after its writes: a merge earns no XP (UX_DESIGN.md, spec section 10), on
 * every path. The backfill, another device's sync applier and any later re-derivation would credit a
 * merged source row, so each one whose event the vault does not hold (in `gameEvents`, or as a purge
 * copy) gets its synced canceller, the same row an undo writes (`ru_`, `hu_`; `cu_` for a card). The
 * events the archive itself brought (a v5 archive) are kept: those are its own XP records.
 */
export async function voidMergedXp(
  db: StudyVaultDb,
  added: ReadonlyMap<SourceTable, readonly unknown[]>,
): Promise<number> {
  const pairs: Array<{ event: GameRow; cancel: GameRow }> = [];
  for (const [table, rows] of added) {
    for (const row of parsedSources(table, rows)) {
      for (const event of deriveLedger(table, row).events) {
        const cancel =
          table === 'reviewLogs'
            ? reviewUndoFact(row as ReviewLog)
            : table === 'highlights'
              ? saveUndoFact(row as Highlight)
              : cardUndoFact(row as Card);
        pairs.push({ event, cancel });
      }
    }
  }
  if (pairs.length === 0) return 0;
  const ids = pairs.map((p) => p.event.id);
  const [events, copies] = [await db.gameEvents.bulkGet(ids), await db.gameFacts.bulkGet(ids)];
  return addMissing(
    db.gameFacts,
    pairs.filter((_, i) => !events[i] && !copies[i]).map((p) => p.cancel),
  );
}

/**
 * A highlight soft-deleted within UNDO_SAVE_WINDOW_MS of its creation gives its save XP back. The
 * fact's id is fixed per highlight, so delete, restore, delete again subtracts once.
 */
export async function revokeQuickSave(
  db: StudyVaultDb,
  raw: unknown,
  deletedAtIso: string,
): Promise<void> {
  const h = parseRow(Highlight, raw, 'highlight');
  if (!h || h.captureMethod === 'import') return;
  const dt = Date.parse(deletedAtIso) - Date.parse(h.createdAt);
  if (dt >= 0 && dt <= UNDO_SAVE_WINDOW_MS) await addMissing(db.gameFacts, [saveUndoFact(h)]);
}

/**
 * Inside a purge: copy the events of the purged source rows into the synced `gameFacts`, same id
 * and content, so XP survives the purge here and reaches a device that joins later.
 */
export async function fossilize(
  db: StudyVaultDb,
  gone: ReadonlyArray<readonly [string, unknown]>,
): Promise<void> {
  const prefix: Record<string, string> = { reviewLogs: 'rv', highlights: 'hs', cards: 'cd' };
  const ids = gone.flatMap(([table, key]) =>
    prefix[table] !== undefined && typeof key === 'string' ? [`${prefix[table]}_${key}`] : [],
  );
  if (ids.length === 0) return;
  const rows = (await db.gameEvents.bulkGet(ids)).flatMap((r) => {
    const parsed = r === undefined ? null : GameEventRow.safeParse(r);
    return parsed?.success ? [parsed.data] : [];
  });
  await addMissing(db.gameFacts, rows);
}

// ---------------------------------------------------------------------------------------------
// Device-local records
// ---------------------------------------------------------------------------------------------

const nextSource = (t: SourceTable): SourceTable | null => SOURCES[SOURCES.indexOf(t) + 1] ?? null;

const BackfillMarker = z.object({
  v: z.literal(1),
  runId: z.string().min(1),
  rulesVersion: z.number().int(),
  status: z.enum(['running', 'done', 'failed']),
  /** Next source table to read (null: every table done). */
  table: z.enum(SOURCES).nullable(),
  /** Last primary key read in `table` (null: start of the table). */
  after: z.string().nullable(),
  added: z.number().int().min(0),
  done: z.number().int().min(0),
  total: z.number().int().min(0),
  startedAt: IsoDate,
  heartbeatAt: IsoDate,
  error: z.string().optional(),
});
type BackfillMarker = z.infer<typeof BackfillMarker>;

const SeenSchema = z.object({
  v: z.literal(1),
  baselineAt: IsoDate,
  keys: z.array(z.string()).max(10_000),
});

const DayTupleSchema = z.tuple([
  z.number().int(),
  z.number().int().min(0),
  z.number().int().min(0),
  z.number().int().min(0),
  z.number().int().min(0),
  z.number().int().min(0),
  z.number().int().min(0),
]);
const GameCacheUpdateSchema = z.object({
  key: z.string().min(1).max(300),
  timeZone: z.string().min(1).max(64),
  rolloverHour: z.number().int().min(0).max(23),
  cutDay: z.number().int(),
  count: z.number().int().min(0),
  days: z.array(DayTupleSchema).max(100_000),
});
const GameCacheSchema = GameCacheUpdateSchema.extend({ v: z.literal(1) });

/** Opaque to the UI: hand it to `saveGameCache` unchanged. */
export type GameCacheUpdate = {
  key: string;
  timeZone: string;
  rolloverHour: number;
  cutDay: number;
  count: number;
  days: DayTuple[];
};

const valueOf = <T>(schema: z.ZodType<T>, row: MetaRow | undefined): T | null => {
  const parsed = schema.safeParse(row?.value);
  return parsed.success ? parsed.data : null;
};
const metaRow = (key: string, value: unknown, ts: string): MetaRow => ({
  key,
  value,
  updatedAt: ts,
});

/** Changes whenever the rules, the study day or the vault (replace or merge restore) change. */
function cacheKey(b: DayBoundary, lastRestore: MetaRow | undefined): string {
  const at = (lastRestore?.value as { at?: unknown } | undefined)?.at;
  return `${GAME_RULES_VERSION}|${b.timeZone}|${b.rolloverHour}|${typeof at === 'string' ? at : '-'}`;
}

// ---------------------------------------------------------------------------------------------
// Backfill
// ---------------------------------------------------------------------------------------------

export interface GameBackfillResult {
  status: 'done' | 'busy' | 'restarted' | 'failed';
  /** Ledger rows this call added. */
  added: number;
  error?: string;
}

/** Tuning and test seams; the worker and the UI call `runGameBackfill()` without them. */
export interface GameBackfillOptions {
  /** Source rows per transaction. Default 1000. */
  pageSize?: number;
  /** Awaited between pages so user writes interleave. Default: one macrotask. */
  betweenPages?: () => Promise<void>;
}

/** Name of the Web Lock that keeps two contexts from doing the backfill work twice. */
export const GAME_BACKFILL_LOCK = 'studyvault-game-backfill';
let backfillRunningHere = false;

/** `withRestoreLock` (backupTarget.ts), except that a held lock answers null instead of throwing. */
async function withGameLock<T>(run: () => Promise<T>): Promise<T | null> {
  if (backfillRunningHere) return null;
  backfillRunningHere = true;
  try {
    const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
    if (!locks) return await run();
    return await locks.request(
      GAME_BACKFILL_LOCK,
      { mode: 'exclusive', ifAvailable: true },
      (lock) => (lock ? run() : null),
    );
  } finally {
    backfillRunningHere = false;
  }
}

/**
 * Derive the ledger from the existing history: one `rv_` per review log (plus `ru_` for an undone
 * one), one `hs_` per non-imported highlight, one `cd_` per card. Resumable: each page reads its
 * source rows and writes their events and the checkpoint in ONE transaction, which also checks that
 * this run still owns the marker (a replace restore deletes it, so the run stops with `restarted`
 * and the next trigger re-derives from the restored rows). Idempotent: ids are deterministic and
 * only missing rows are added. When the job is done it costs one `meta` read.
 */
export async function runGameBackfill(o: GameBackfillOptions = {}): Promise<GameBackfillResult> {
  return (await withGameLock(() => backfill(o))) ?? { status: 'busy', added: 0 };
}

async function backfill(o: GameBackfillOptions): Promise<GameBackfillResult> {
  const pageSize = Math.max(1, Math.floor(o.pageSize ?? 1000));
  const pause = o.betweenPages ?? (() => new Promise<void>((r) => setTimeout(r, 0)));
  const runId = uuidv7();
  let added = 0;
  try {
    const current = valueOf(BackfillMarker, await withDb((db) => db.meta.get(GAME_BACKFILL_KEY)));
    if (current?.status === 'done' && current.rulesVersion === GAME_RULES_VERSION) {
      return { status: 'done', added: 0 };
    }
    const started = await withWritableDb((db) =>
      db.transaction('rw', [db.meta, db.reviewLogs, db.highlights, db.cards], async () => {
        const stored = valueOf(BackfillMarker, await db.meta.get(GAME_BACKFILL_KEY));
        if (stored?.status === 'done' && stored.rulesVersion === GAME_RULES_VERSION) return null;
        const ts = nowIso();
        let next: BackfillMarker;
        if (stored && stored.rulesVersion === GAME_RULES_VERSION) {
          const { error: _previous, ...rest } = stored;
          next = { ...rest, runId, status: 'running', heartbeatAt: ts }; // resume at the checkpoint
        } else {
          const total =
            (await db.reviewLogs.count()) +
            (await db.highlights.count()) +
            (await db.cards.count());
          next = {
            v: 1,
            runId,
            rulesVersion: GAME_RULES_VERSION,
            status: 'running',
            table: 'reviewLogs',
            after: null,
            added: 0,
            done: 0,
            total,
            startedAt: ts,
            heartbeatAt: ts,
          };
        }
        await db.meta.put(metaRow(GAME_BACKFILL_KEY, next, ts));
        return next;
      }),
    );
    if (started === null) return { status: 'done', added: 0 };

    let next: SourceTable | null = started.table;
    while (next !== null) {
      const table: SourceTable = next;
      const page = await withWritableDb((db) =>
        db.transaction(
          'rw',
          [db.table(table), db.gameEvents, db.gameFacts, db.meta],
          async (): Promise<{ marker: BackfillMarker; pageAdded: number } | null> => {
            const stored = valueOf(BackfillMarker, await db.meta.get(GAME_BACKFILL_KEY));
            if (stored?.runId !== runId) return null; // replace restore, or another run took over
            const source = db.table(table);
            const rows = (await (
              stored.after === null
                ? source.orderBy(':id')
                : source.where(':id').above(stored.after)
            )
              .limit(pageSize)
              .toArray()) as Array<{ id?: unknown }>;
            const pageAdded = await addLedgerOf(db, table, rows);
            const full = rows.length >= pageSize;
            const ts = nowIso();
            const marker: BackfillMarker = {
              ...stored,
              added: stored.added + pageAdded,
              done: Math.min(stored.total, stored.done + rows.length),
              heartbeatAt: ts,
              table: full ? table : nextSource(table),
              after: full ? String(rows[rows.length - 1]?.id) : null,
            };
            await db.meta.put(metaRow(GAME_BACKFILL_KEY, marker, ts));
            return { marker, pageAdded };
          },
        ),
      );
      if (page === null) return { status: 'restarted', added };
      next = page.marker.table;
      added += page.pageAdded;
      await pause();
    }

    const finished = await withWritableDb((db) =>
      db.transaction('rw', [db.gameFacts, db.meta], async () => {
        const stored = valueOf(BackfillMarker, await db.meta.get(GAME_BACKFILL_KEY));
        if (stored?.runId !== runId) return false;
        const ts = nowIso();
        const starts = await db.gameFacts
          .where('[kind+at]')
          .between(['start', Dexie.minKey], ['start', Dexie.maxKey])
          .count();
        // The game's epoch on this vault. Written while sync capture is on, so it syncs.
        if (starts === 0) await db.gameFacts.add(startFact(uuidv7(), ts));
        if (!(await db.meta.get(GAME_SEEN_KEY))) {
          await db.meta.put(metaRow(GAME_SEEN_KEY, { v: 1, baselineAt: ts, keys: [] }, ts));
        }
        const done: BackfillMarker = {
          ...stored,
          status: 'done',
          table: null,
          after: null,
          done: stored.total,
          heartbeatAt: ts,
        };
        await db.meta.put(metaRow(GAME_BACKFILL_KEY, done, ts));
        return true;
      }),
    );
    if (!finished) return { status: 'restarted', added };
    await signalChange(); // once, not per page
    return { status: 'done', added };
  } catch (err) {
    const e = toStorageError(err);
    const error = e.code === 'quota_exceeded' ? 'quota_exceeded' : e.message;
    try {
      // Best effort, so the UI can say why game numbers are missing. This run holds the lock, so a
      // marker it does not own is a stale one (a stopped worker): only a finished one is kept.
      await withDb((db) =>
        db.transaction('rw', db.meta, async () => {
          const stored = valueOf(BackfillMarker, await db.meta.get(GAME_BACKFILL_KEY));
          const ts = nowIso();
          if (stored?.status === 'done') return;
          const failed: BackfillMarker = stored
            ? { ...stored, status: 'failed', heartbeatAt: ts, error }
            : {
                v: 1,
                runId,
                rulesVersion: GAME_RULES_VERSION,
                status: 'failed',
                table: 'reviewLogs',
                after: null,
                added: 0,
                done: 0,
                total: 0,
                startedAt: ts,
                heartbeatAt: ts,
                error,
              };
          await db.meta.put(metaRow(GAME_BACKFILL_KEY, failed, ts));
        }),
      );
    } catch {
      /* the database itself is failing: the result below still says why */
    }
    return { status: 'failed', added, error };
  }
}

// ---------------------------------------------------------------------------------------------
// Read path
// ---------------------------------------------------------------------------------------------

export interface BackfillView {
  status: 'pending' | 'running' | 'done' | 'failed';
  done: number;
  total: number;
  error: string | null;
}

export type GameState =
  /** Progress only, never a partial number. */
  | { ready: false; mode: boolean; backfill: BackfillView }
  | ({
      ready: true;
      rulesVersion: typeof GAME_RULES_VERSION;
      mode: boolean;
      backfill: BackfillView;
      /** Today's milestones this device may still celebrate; [] while Game mode is off. */
      pending: Celebration[];
      /** Hand to `saveGameCache` when not null. */
      cacheUpdate: GameCacheUpdate | null;
    } & Omit<DerivedGame, 'milestones'>);

const inRange = (table: GameTable, lo: string | null, hi: string | null) => {
  if (lo === null) return table.where('at').below(hi ?? '');
  if (hi === null) return table.where('at').aboveOrEqual(lo);
  return table.where('at').between(lo, hi, true, false);
};

// The readers below are plain functions returning Dexie promises, never async wrappers: inside a
// live query an async wrapper loses Dexie's transaction zone, and the caller's next request then
// fails as "committed too early" (the same rule as `rowsWhereIn` in core.ts).

/** Ledger rows below an instant, both tables: the cache's change detector (rows are only added). */
function countBelow(db: StudyVaultDb, iso: string): PromiseLike<number> {
  return Dexie.Promise.all([
    db.gameEvents.where('at').below(iso).count(),
    db.gameFacts.where('at').below(iso).count(),
  ]).then(([events, facts]) => events + facts);
}

/** Fold every ledger row with lo <= at < hi (null: unbounded); events are streamed. */
function foldBetween(
  db: StudyVaultDb,
  lo: string | null,
  hi: string | null,
  b: DayBoundary,
  T: number,
): PromiseLike<FoldResult> {
  return inRange(db.gameFacts, lo, hi)
    .toArray()
    .then((rows) => {
      const fold = startFold(
        rows.map((r) => parseRow(GameFactRow, r, 'game fact')).filter(notNull),
        b,
        T,
      );
      return inRange(db.gameEvents, lo, hi)
        .each((raw) => {
          const e = parseRow(GameEventRow, raw, 'game event');
          if (e) fold.add(e);
        })
        .then(() => fold.finish());
    });
}

/** Every valid fact of one kind, in ledger order. A handful of rows (goal, mode, start). */
function factsOf(db: StudyVaultDb, kind: GameEventKind): PromiseLike<GameRow[]> {
  return db.gameFacts
    .where('[kind+at]')
    .between([kind, Dexie.minKey], [kind, Dexie.maxKey])
    .toArray()
    .then((rows) =>
      rows
        .map((r) => parseRow(GameFactRow, r, 'game fact'))
        .filter(notNull)
        .filter((r) => r.kind === kind)
        .sort(
          (a, c) => Date.parse(a.at) - Date.parse(c.at) || (a.id < c.id ? -1 : a.id > c.id ? 1 : 0),
        ),
    );
}

const latestMode = (db: StudyVaultDb): PromiseLike<GameRow | undefined> =>
  factsOf(db, 'mode').then((rows) => rows.at(-1));

/**
 * The whole game state for the UI. Read-only (safe inside a live query): one read transaction over
 * the two ledger tables and `meta`. Closed days come from the per-day cache in `meta['game.cache']`
 * when its key and row count still match (both tables only ever gain rows, and a replace restore
 * changes the key), plus a fold of the days closed since; today is always folded fresh.
 */
export async function getGameState(o: {
  boundary: DayBoundary;
  now?: DateInput;
}): Promise<GameState> {
  const b = parseInput(DayBoundary, o.boundary, 'study day boundary');
  const nowMs = o.now === undefined ? Date.now() : toMs(o.now);
  return withDb((db) =>
    db.transaction('r', [db.gameEvents, db.gameFacts, db.meta], async (): Promise<GameState> => {
      const marker = valueOf(BackfillMarker, await db.meta.get(GAME_BACKFILL_KEY));
      const current = marker !== null && marker.rulesVersion === GAME_RULES_VERSION;
      const backfill: BackfillView =
        marker === null || (!current && marker.status === 'done')
          ? { status: 'pending', done: 0, total: 0, error: null }
          : {
              status: marker.status,
              done: marker.done,
              total: marker.total,
              error: marker.error ?? null,
            };
      const lastMode = await latestMode(db);
      const mode = lastMode ? lastMode.value === 1 : true;
      if (!(current && marker.status === 'done')) return { ready: false, mode, backfill };

      const T = studyDayNumber(nowMs, b);
      const cutIso = toIso(studyDayStartMs(T, b));
      const key = cacheKey(b, await db.meta.get(LAST_RESTORE_KEY));
      const cache = valueOf(GameCacheSchema, await db.meta.get(GAME_CACHE_KEY));
      let prefix: DayMap | null = null;
      let hit = false;
      if (cache && cache.key === key && cache.cutDay <= T) {
        const cacheCut = toIso(studyDayStartMs(cache.cutDay, b));
        if ((await countBelow(db, cacheCut)) === cache.count) {
          hit = true;
          const closed = tuplesToDays(cache.days);
          prefix =
            cache.cutDay === T
              ? closed
              : mergeDays(closed, (await foldBetween(db, cacheCut, cutIso, b, T)).days);
        }
      }
      prefix ??= (await foldBetween(db, null, cutIso, b, T)).days;
      const tail = await foldBetween(db, cutIso, null, b, T);
      const cacheUpdate: GameCacheUpdate | null =
        hit && cache?.cutDay === T
          ? null
          : {
              key,
              timeZone: b.timeZone,
              rolloverHour: b.rolloverHour,
              cutDay: T,
              count: await countBelow(db, cutIso),
              days: daysToTuples(prefix),
            };
      const { milestones, ...derived } = deriveGame({
        days: mergeDays(prefix, tail.days),
        ordered: tail.ordered,
        goals: await factsOf(db, 'goal'),
        starts: await factsOf(db, 'start'),
        b,
        T,
      });
      const seenRow = valueOf(SeenSchema, await db.meta.get(GAME_SEEN_KEY));
      const seen: GameSeen | null = seenRow
        ? { baselineAt: seenRow.baselineAt, keys: seenRow.keys }
        : null;
      const pending = pendingCelebrations(milestones, {
        mode,
        modeOnAt: lastMode?.value === 1 ? lastMode.at : null,
        seen,
      });
      return {
        ready: true,
        rulesVersion: GAME_RULES_VERSION,
        mode,
        backfill,
        ...derived,
        pending,
        cacheUpdate,
      };
    }),
  );
}

/**
 * Persist the closed-day rollup `getGameState` returned. A compare-and-set: refused (nothing
 * written) when a ledger row was added below the cut since, or a restore changed the key. Never
 * signals: nothing a viewer shows changed.
 */
export async function saveGameCache(update: GameCacheUpdate): Promise<void> {
  const u = parseInput(GameCacheUpdateSchema, update, 'game cache');
  const b = parseInput(
    DayBoundary,
    { timeZone: u.timeZone, rolloverHour: u.rolloverHour },
    'study day boundary',
  );
  await withWritableDb((db) =>
    db.transaction('rw', [db.gameEvents, db.gameFacts, db.meta], async () => {
      if (cacheKey(b, await db.meta.get(LAST_RESTORE_KEY)) !== u.key) return;
      if ((await countBelow(db, toIso(studyDayStartMs(u.cutDay, b)))) !== u.count) return;
      await db.meta.put(metaRow(GAME_CACHE_KEY, { v: 1, ...u }, nowIso()));
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// Goal, Game mode and celebrations
// ---------------------------------------------------------------------------------------------

const stamp = (now: DateInput | undefined) => (now === undefined ? nowIso() : toIso(toMs(now)));
/**
 * The latest goal or mode is the last fact by (at, id), so a new choice is dated after the latest
 * one of its kind: one stamped by a clock that ran ahead must not outrank every later choice.
 */
const after = (ts: string, last: GameRow | undefined): string =>
  last !== undefined && Date.parse(last.at) >= Date.parse(ts) ? toIso(Date.parse(last.at) + 1) : ts;

/** Choose the daily goal. Applies from the current study day; past days keep theirs. */
export async function setDailyGoal(goal: DailyGoal, o: { now?: DateInput } = {}): Promise<void> {
  const value = parseInput(DailyGoal, goal, 'daily goal');
  const ts = stamp(o.now);
  await withWritableDb((db) =>
    db.transaction('rw', db.gameFacts, async () => {
      const last = (await factsOf(db, 'goal')).at(-1);
      await db.gameFacts.add(goalFact(uuidv7(), value, after(ts, last)));
    }),
  );
  await signalChange();
}

/** Switch Game mode. Display only: recording continues. Writes only when the value changes. */
export async function setGameMode(on: boolean, o: { now?: DateInput } = {}): Promise<void> {
  const value = parseInput(z.boolean(), on, 'Game mode');
  const ts = stamp(o.now);
  const changed = await withWritableDb((db) =>
    db.transaction('rw', db.gameFacts, async () => {
      const last = await latestMode(db);
      if ((last ? last.value === 1 : true) === value) return false;
      await db.gameFacts.add(modeFact(uuidv7(), value, after(ts, last)));
      return true;
    }),
  );
  if (changed) await signalChange();
}

/** The latest Game mode fact; on by default. One index read (the worker asks on every save). */
export async function isGameModeOn(): Promise<boolean> {
  return withDb((db) =>
    db.transaction('r', db.gameFacts, async () => {
      const last = await latestMode(db);
      return last ? last.value === 1 : true;
    }),
  );
}

const CelebrationsInput = z
  .array(z.looseObject({ key: z.string().min(1).max(120), at: IsoDate }))
  .max(200);
/** `goal:<day>` and `streak:<n>:<day>`: these keys can only match a milestone of that day. */
const DATED_KEY = /^(?:goal|streak:\d+):(\d{4}-\d{2}-\d{2})$/;

/**
 * Claim celebrations for this device: returns the ones no page of this device claimed before, and
 * records them, in one readwrite transaction (two pages racing get each key exactly once). Nothing
 * is claimed before the backfill set the device baseline. Never signals.
 */
export async function claimCelebrations(
  pending: readonly Celebration[],
  o: { now?: DateInput } = {},
): Promise<Celebration[]> {
  parseInput(CelebrationsInput, pending, 'celebrations');
  if (pending.length === 0) return [];
  const nowMs = o.now === undefined ? Date.now() : toMs(o.now);
  // Dated keys older than this can never be pending again. Three days covers any zone and rollover
  // hour without knowing the study-day boundary.
  const cutoff = studyDayKey(Math.floor(nowMs / DAY_MS) - 3);
  return withWritableDb((db) =>
    db.transaction('rw', db.meta, async () => {
      const seen = valueOf(SeenSchema, await db.meta.get(GAME_SEEN_KEY));
      if (!seen) return [];
      const keys = new Set(seen.keys);
      const fresh: Celebration[] = [];
      for (const c of pending) {
        if (keys.has(c.key)) continue;
        keys.add(c.key);
        fresh.push(c);
      }
      if (fresh.length === 0) return [];
      const kept = [...keys].filter((k) => {
        const day = DATED_KEY.exec(k)?.[1];
        return day === undefined || day >= cutoff;
      });
      await db.meta.put(
        metaRow(GAME_SEEN_KEY, { v: 1, baselineAt: seen.baselineAt, keys: kept }, nowIso()),
      );
      return fresh;
    }),
  );
}
