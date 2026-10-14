import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getGameState,
  runGameBackfill,
  saveGameCache,
  type GameBackfillResult,
  type GameState,
} from '@storage';
import { studyDayNumber, studyDayStartMs } from '@study';
import { useLatest, useObserved, type Loadable } from '../hooks';
import { useStudySettings } from '../review/hooks';

/** While the ledger is not ready, how often the progress is re-read (and a stopped run resumed). */
export const BACKFILL_POLL_MS = 1_000;
/** setTimeout's ceiling; a study day is far shorter, this only guards odd clocks. */
const MAX_TIMER_MS = 2 ** 31 - 1;

export interface GameView extends Loadable<GameState> {
  /** Run the backfill again after it failed (the reason is in `data.backfill.error`). */
  retryBackfill(): Promise<void>;
}

/**
 * The live game state (ADR-022) for any extension page. Re-read when any context writes, when the
 * study-day setting changes, and at the study-day rollover; a re-read keeps the old state visible.
 * While the ledger is not ready it starts (or resumes) the backfill and re-reads the progress every
 * second, so the progress shown is real; a failed backfill waits for `retryBackfill`. The closed-day
 * cache `getGameState` hands back is persisted here, outside the live query. Game mode off is
 * display only: callers hide XP, the ring, streak, level and badges while `data.mode` is false.
 * `now` is a test seam.
 */
export function useGame(o: { now?: () => number } = {}): GameView {
  const now = useLatest(o.now ?? Date.now);
  const { settings, error: settingsError } = useStudySettings();
  const timeZone = settings?.timeZone ?? null;
  const rolloverHour = settings?.rolloverHour ?? null;

  const observed = useObserved<GameState | null>(
    () =>
      timeZone === null || rolloverHour === null
        ? Promise.resolve(null)
        : getGameState({ boundary: { timeZone, rolloverHour }, now: now.current() }),
    [timeZone, rolloverHour],
  );
  const { refresh } = observed;
  const state = observed.data ?? undefined;

  // 1. Persist the closed-day rollup (a compare-and-set that never signals).
  const cacheUpdate = state?.ready ? state.cacheUpdate : null;
  useEffect(() => {
    if (!cacheUpdate) return;
    saveGameCache(cacheUpdate).catch((err: unknown) =>
      console.warn('[StudyVault] could not keep the game cache', err),
    );
  }, [cacheUpdate]);

  // 2. Not ready: run the backfill and show its progress. Its Web Lock makes a second context
  // answer `busy` at once, and the next call resumes a run whose worker was stopped.
  const inFlight = useRef<Promise<GameBackfillResult> | null>(null);
  const [lastRun, setLastRun] = useState<GameBackfillResult | null>(null);
  const run = useCallback((): Promise<GameBackfillResult> => {
    inFlight.current ??= runGameBackfill()
      .catch((err: unknown): GameBackfillResult => ({
        status: 'failed',
        added: 0,
        error: err instanceof Error ? err.message : String(err),
      }))
      .then((result) => {
        inFlight.current = null;
        setLastRun(result);
        refresh();
        return result;
      });
    return inFlight.current;
  }, [refresh]);
  const waiting =
    state !== undefined &&
    !state.ready &&
    state.backfill.status !== 'failed' &&
    lastRun?.status !== 'failed';
  useEffect(() => {
    if (!waiting) return;
    void run();
    const id = setInterval(() => {
      void run();
      refresh();
    }, BACKFILL_POLL_MS);
    return () => clearInterval(id);
  }, [waiting, run, refresh]);

  // 3. Re-read at the next study-day rollover even when nothing is written.
  const [rollovers, setRollovers] = useState(0);
  const ready = state?.ready === true;
  useEffect(() => {
    if (!ready || timeZone === null || rolloverHour === null) return;
    const b = { timeZone, rolloverHour };
    const at = now.current();
    const next = studyDayStartMs(studyDayNumber(at, b) + 1, b);
    const id = setTimeout(
      () => {
        refresh();
        setRollovers((n) => n + 1);
      },
      Math.min(MAX_TIMER_MS, Math.max(0, next - at)),
    );
    return () => clearTimeout(id);
  }, [ready, timeZone, rolloverHour, rollovers, refresh, now]);

  const retryBackfill = useCallback(async () => {
    setLastRun(null);
    await run();
  }, [run]);

  return {
    ...observed,
    data: state,
    error: settingsError ?? observed.error,
    loading: settings === null || observed.loading || observed.data === null,
    retryBackfill,
  };
}
