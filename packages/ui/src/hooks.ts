import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import type { Settings } from '@shared';
import { getSettings, updateSettings, watchDataEpoch, watchSettings } from '@runtime';
import { observe } from '@storage';
import { errorMessage } from './text';

/** Query dependencies must be primitives: they are compared through JSON, not identity. */
export type Dep = string | number | boolean | null | undefined;

/**
 * Always-fresh reference to the latest committed value, readable from effects and callbacks.
 * Updated in a layout effect so an event handler never sees a render older than what is on screen.
 */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

export function useSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getSettings().then(
      // A change event that raced the first read is newer than the read.
      (s) => {
        if (live) setSettings((current) => current ?? s);
      },
      (err: unknown) => {
        if (live) setError(errorMessage(err, 'Could not read your settings.'));
      },
    );
    const stop = watchSettings((s) => setSettings(s));
    return () => {
      live = false;
      stop();
    };
  }, []);

  /** Serialised read-modify-write through @runtime; the returned settings are shown immediately. */
  const update = useCallback(async (mutate: (current: Settings) => Settings) => {
    const next = await updateSettings(mutate);
    setSettings(next);
    return next;
  }, []);

  return { settings, error, update };
}

/** Mirror the theme setting onto <html data-theme>; "system" removes it so the media query decides. */
export function useApplyTheme(theme: Settings['theme'] | undefined) {
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
    else delete root.dataset.theme;
  }, [theme]);
}

// ---------------------------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------------------------

/** Counter that changes whenever any context mutated the database (cross-context liveness). */
export function useDataEpoch(): number {
  const [epoch, setEpoch] = useState(0);
  useEffect(() => watchDataEpoch(() => setEpoch((n) => n + 1)), []);
  return epoch;
}

export interface Loadable<T> {
  data: T | undefined;
  error: string | null;
  /** True until the first result for the current dependencies has arrived. */
  loading: boolean;
  /** Clears the result and runs again (Retry buttons). */
  reload(): void;
  /** Runs again but keeps the current data and error visible until the new result arrives. */
  refresh(): void;
}

type Result<T> = { key: string; data?: T; error?: string } | null;

function toLoadable<T>(
  result: Result<T>,
  key: string,
  actions: Pick<Loadable<T>, 'reload' | 'refresh'>,
): Loadable<T> {
  const current = result?.key === key ? result : null;
  return {
    data: current?.data,
    error: current?.error ?? null,
    loading: current === null,
    ...actions,
  };
}

/**
 * Run an async function whenever `deps` change; the data of other deps is never shown. Results of
 * superseded runs are ignored. A change in `refreshOn` runs it again but keeps the current data
 * visible until the new result arrives.
 */
export function useAsync<T>(
  fn: () => Promise<T>,
  deps: readonly Dep[],
  refreshOn: readonly Dep[] = [],
): Loadable<T> {
  const latest = useLatest(fn);
  const key = JSON.stringify(deps);
  const refreshKey = JSON.stringify(refreshOn);
  const [runs, setRuns] = useState(0);
  const [result, setResult] = useState<Result<T>>(null);

  useEffect(() => {
    let live = true;
    latest.current().then(
      (data) => {
        if (live) setResult({ key, data });
      },
      (err: unknown) => {
        if (live) setResult({ key, error: errorMessage(err) });
      },
    );
    return () => {
      live = false;
    };
  }, [key, refreshKey, runs, latest]);

  const reload = useCallback(() => {
    setResult(null);
    setRuns((n) => n + 1);
  }, []);
  const refresh = useCallback(() => setRuns((n) => n + 1), []);
  return toLoadable(result, key, { reload, refresh });
}

/**
 * Live database query: re-emits when Dexie reports a change (via @storage `observe`) and is
 * re-subscribed when another context bumps the data epoch. `query` must only call read functions.
 */
export function useObserved<T>(query: () => Promise<T>, deps: readonly Dep[]): Loadable<T> {
  const latest = useLatest(query);
  const epoch = useDataEpoch();
  const key = JSON.stringify(deps);
  const [runs, setRuns] = useState(0);
  const [result, setResult] = useState<Result<T>>(null);

  useEffect(() => {
    let live = true;
    const stop = observe(() => latest.current()).subscribe(
      (data) => {
        if (live) setResult({ key, data });
      },
      (err: unknown) => {
        if (live) setResult({ key, error: errorMessage(err) });
      },
    );
    return () => {
      live = false;
      stop();
    };
  }, [key, epoch, runs, latest]);

  const reload = useCallback(() => {
    setResult(null);
    setRuns((n) => n + 1);
  }, []);
  const refresh = useCallback(() => setRuns((n) => n + 1), []);
  return toLoadable(result, key, { reload, refresh });
}

// ---------------------------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------------------------

export interface ActiveTab {
  id: number;
  windowId: number;
  /** Undefined when Chrome does not share the address (no activeTab/host access, browser pages). */
  url: string | undefined;
  title: string | undefined;
  /** "loading" | "complete" | "unloaded"; changes are the cue to look at the page again. */
  status: string | undefined;
}

const sameTab = (a: ActiveTab | null, b: ActiveTab | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.id === b.id &&
    a.windowId === b.windowId &&
    a.url === b.url &&
    a.title === b.title &&
    a.status === b.status);

/** The active tab of this page's window, kept current through tabs.onActivated / onUpdated. */
export function useActiveTab() {
  const [state, setState] = useState<{
    loading: boolean;
    tab: ActiveTab | null;
    error: string | null;
  }>({ loading: true, tab: null, error: null });

  useEffect(() => {
    let live = true;
    const read = async () => {
      try {
        const [found] = await browser.tabs.query({ active: true, currentWindow: true });
        if (!live) return;
        const tab: ActiveTab | null =
          found?.id === undefined
            ? null
            : {
                id: found.id,
                windowId: found.windowId,
                url: found.url,
                title: found.title,
                status: found.status,
              };
        setState((prev) =>
          !prev.loading && prev.error === null && sameTab(prev.tab, tab)
            ? prev
            : { loading: false, tab, error: null },
        );
      } catch (err) {
        if (live) {
          setState({ loading: false, tab: null, error: errorMessage(err, 'Could not read tabs.') });
        }
      }
    };
    void read();
    const onActivated = () => void read();
    const onUpdated = (
      _tabId: number,
      change: { url?: string; title?: string; status?: string },
      tab: { active: boolean },
    ) => {
      if (tab.active && (change.url || change.title || change.status)) void read();
    };
    browser.tabs.onActivated.addListener(onActivated);
    browser.tabs.onUpdated.addListener(onUpdated);
    return () => {
      live = false;
      browser.tabs.onActivated.removeListener(onActivated);
      browser.tabs.onUpdated.removeListener(onUpdated);
    };
  }, []);

  return state;
}

// ---------------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------------

/**
 * Wrap a user-triggered async action with busy/error state and a retry. `fn` is invoked
 * synchronously from `run`, so a `permissions.request` or `sidePanel.open` made first thing in
 * it still counts as running inside the click's user gesture.
 */
export function useAction<A extends unknown[]>(fn: (...args: A) => Promise<void>) {
  const latest = useLatest(fn);
  const lastArgs = useRef<A | null>(null);
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({
    busy: false,
    error: null,
  });

  const run = useCallback(
    (...args: A) => {
      lastArgs.current = args;
      setState({ busy: true, error: null });
      return latest.current(...args).then(
        () => setState({ busy: false, error: null }),
        (err: unknown) => setState({ busy: false, error: errorMessage(err) }),
      );
    },
    [latest],
  );
  const retry = useCallback(() => {
    if (lastArgs.current) void run(...lastArgs.current);
  }, [run]);
  const clear = useCallback(() => setState({ busy: false, error: null }), []);

  return { run, retry, clear, busy: state.busy, error: state.error };
}
