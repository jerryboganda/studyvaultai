import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { getDueSummary, loadStudySession, type DueSummary } from '@storage';
import { useObserved, type Loadable } from '../hooks';
import { errorMessage } from '../text';
import {
  getStudySettings,
  toClock,
  updateStudySettings,
  watchStudySettings,
  type StudySettings,
} from './settings';
import { ReviewSessionController, type ControllerDeps, type SessionState } from './session';

/** The study settings, kept current across contexts (options page, review page, side panel). */
export function useStudySettings() {
  const [settings, setSettings] = useState<StudySettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    getStudySettings().then(
      // A change event that raced the first read is newer than the read.
      (s) => {
        if (live) setSettings((current) => current ?? s);
      },
      (err: unknown) => {
        if (live) setError(errorMessage(err, 'Could not read your study settings.'));
      },
    );
    return () => {
      live = false;
    };
  }, [attempt]);

  useEffect(() => watchStudySettings((s) => setSettings(s)), []);

  const retry = useCallback(() => {
    setError(null);
    setAttempt((n) => n + 1);
  }, []);

  const update = useCallback(async (mutate: (current: StudySettings) => StudySettings) => {
    const next = await updateStudySettings(mutate);
    setSettings(next);
    return next;
  }, []);

  return { settings, error, retry, update };
}

/**
 * A number that changes every `ms`: queries that depend on "now" (what is due today) re-run when
 * the study day may have rolled over, even if no row changed. A hidden page has no one to show a
 * count to (and these queries read every card that can be due), so it does not tick; it ticks once
 * when the page is shown again.
 */
export function useTick(ms = 60_000): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState !== 'hidden') setTick((n) => n + 1);
    }, ms);
    const onShown = () => {
      if (document.visibilityState === 'visible') setTick((n) => n + 1);
    };
    document.addEventListener('visibilitychange', onShown);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onShown);
    };
  }, [ms]);
  return tick;
}

/** Stable primitive key of the settings that change study queries. */
export const clockKey = (s: StudySettings | null): string =>
  s === null ? 'none' : JSON.stringify(toClock(s));

export interface DueCount {
  /** Cards the learner can study right now under today's caps (null until known). */
  count: number | null;
  summary: DueSummary | null;
  /** A saved session can be continued (cards still to show). */
  resumable: { remaining: number; answered: number } | null;
  loading: boolean;
  error: string | null;
  retryable: boolean;
  refresh(): void;
}

/**
 * Live "cards due today" for badges in the popup, side panel and options page. Re-queries when any
 * context changes the database, when the study settings change, and every minute (day rollover).
 * Reads the study settings itself, so callers pass nothing.
 */
export function useDueCount(): DueCount {
  const { settings, error: settingsError } = useStudySettings();
  const tick = useTick();
  const key = clockKey(settings);
  const summary = useObserved<DueSummary | null>(
    () => (settings ? getDueSummary(toClock(settings)) : Promise.resolve(null)),
    [key, tick],
  );
  const stored = useObserved(() => loadStudySession(), []);
  const resumable = useMemo(() => {
    const s = stored.data;
    if (!s) return null;
    const remaining = s.pending.length + s.learning.length;
    return remaining > 0 ? { remaining, answered: s.answered } : null;
  }, [stored.data]);
  const data = summary.data ?? null;
  return {
    count: data ? data.total.total : null,
    summary: data,
    resumable,
    loading: settings === null || summary.loading,
    error: settingsError ?? summary.error,
    retryable: summary.retryable,
    refresh: summary.refresh,
  };
}

/** The review session controller of this page, as React state. */
export function useReviewSession(deps: ControllerDeps = {}) {
  const [controller] = useState(() => new ReviewSessionController(deps));
  const state: SessionState = useSyncExternalStore(controller.subscribe, controller.getState);
  return { controller, state };
}

export type { Loadable };
