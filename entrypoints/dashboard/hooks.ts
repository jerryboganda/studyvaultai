import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';
import { useAsync, useDataEpoch, useLatest, type Loadable } from '@ui';
import { errorMessage } from '@ui';

type Dep = string | number | boolean | null | undefined;

// ---------------------------------------------------------------------------------------------
// Data liveness
// ---------------------------------------------------------------------------------------------

interface Versioning {
  /** Changes whenever this page itself wrote something (the cross-context epoch is slower). */
  local: number;
  bump(): void;
}
const VersionContext = createContext<Versioning>({ local: 0, bump: () => undefined });
export const VersionProvider = VersionContext.Provider;
/** Call after a write so every query re-reads right away. */
export const useBump = () => useContext(VersionContext).bump;

/** An async read that re-runs when the data changed anywhere (other tabs, the page, this view). */
export function useVaultQuery<T>(fn: () => Promise<T>, deps: readonly Dep[]): Loadable<T> {
  const epoch = useDataEpoch();
  const { local } = useContext(VersionContext);
  return useAsync(fn, deps, [epoch, local]);
}

export function useDataVersion(): number {
  return useContext(VersionContext).local + useDataEpoch();
}

// ---------------------------------------------------------------------------------------------
// Small state helpers
// ---------------------------------------------------------------------------------------------

/** `value` after it has stopped changing for `ms`. */
export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** Per-viewer preference in localStorage; the page works when storage is blocked. */
export function useLocalPref<T extends string>(
  key: string,
  initial: T,
  valid: readonly T[],
): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = window.localStorage.getItem(key);
      return stored !== null && (valid as readonly string[]).includes(stored)
        ? (stored as T)
        : initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (next: T) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, next);
      } catch {
        /* a convenience, not a requirement */
      }
    },
    [key],
  );
  return [value, set];
}

export function useLocalSet(key: string): [Set<string>, Dispatch<SetStateAction<Set<string>>>] {
  const [value, setValue] = useState<Set<string>>(() => {
    try {
      const raw = window.localStorage.getItem(key);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : []);
    } catch {
      return new Set();
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify([...value]));
    } catch {
      /* ignore */
    }
  }, [key, value]);
  return [value, setValue];
}

// ---------------------------------------------------------------------------------------------
// Autosaved text
// ---------------------------------------------------------------------------------------------

export type SaveStatus =
  | { kind: 'idle' }
  | { kind: 'dirty' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; message: string };

/**
 * Text that saves itself: debounced while typing, immediately on blur (`flush`) and when the
 * editor goes away, so switching to another highlight never drops what was typed.
 */
export function useAutosave(value: string, save: (text: string) => Promise<void>, delayMs = 700) {
  const [draft, setDraft] = useState(value);
  const [persisted, setPersisted] = useState(value);
  const [seen, setSeen] = useState(value);
  const [status, setStatus] = useState<SaveStatus>({ kind: 'idle' });
  const saver = useLatest(save);
  const inflight = useRef<string | null>(null);
  const pending = useRef<string | null>(null);

  // The stored value moved underneath (another tab): follow it unless there are unsaved edits.
  if (value !== seen) {
    setSeen(value);
    if (draft === persisted) {
      setDraft(value);
      setPersisted(value);
    }
  }

  const send = useCallback(
    async (text: string) => {
      if (inflight.current === text) return;
      inflight.current = text;
      setStatus({ kind: 'saving' });
      try {
        await saver.current(text);
        setPersisted(text);
        setStatus({ kind: 'saved' });
      } catch (err) {
        setStatus({ kind: 'error', message: errorMessage(err, 'Could not save.') });
      } finally {
        inflight.current = null;
      }
    },
    [saver],
  );

  useEffect(() => {
    pending.current = draft === persisted ? null : draft;
  });

  useEffect(() => {
    if (draft === persisted) return undefined;
    const timer = setTimeout(() => void send(draft), delayMs);
    return () => clearTimeout(timer);
  }, [draft, persisted, delayMs, send]);

  useEffect(
    () => () => {
      const text = pending.current;
      if (text !== null) void saver.current(text).catch(() => undefined);
    },
    [saver],
  );

  const onChange = useCallback((text: string) => {
    setDraft(text);
    setStatus({ kind: 'dirty' });
  }, []);
  const flush = useCallback(() => {
    if (pending.current !== null) void send(pending.current);
  }, [send]);

  return { draft, onChange, flush, status, dirty: draft !== persisted };
}

// ---------------------------------------------------------------------------------------------
// Popover-style <details>
// ---------------------------------------------------------------------------------------------

/**
 * Makes the <details> popovers under `root` behave like popovers: Escape closes the open one and
 * returns focus to its summary, and pressing anywhere outside closes it.
 */
export function useDismissibleDetails(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = root.current;
    if (!el) return undefined;
    const onDown = (e: PointerEvent) => {
      for (const d of el.querySelectorAll<HTMLDetailsElement>('details[open]')) {
        if (!d.contains(e.target as Node)) d.open = false;
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const open = (e.target as HTMLElement).closest<HTMLDetailsElement>('details[open]');
      if (!open) return;
      open.open = false;
      open.querySelector('summary')?.focus();
      e.stopPropagation();
    };
    document.addEventListener('pointerdown', onDown);
    el.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      el.removeEventListener('keydown', onKey);
    };
  }, [root]);
}
