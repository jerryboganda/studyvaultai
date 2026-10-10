import { useSyncExternalStore } from 'react';
import type { HighlightView, Settings } from '@shared';
import type { SelectionInfo } from '../contract';

export type ToastTone = 'info' | 'success' | 'error';

export interface Toast {
  id: number;
  text: string;
  tone: ToastTone;
  action?: { label: string; run: () => void };
}

export interface UiState {
  settings: Settings;
  toolbar: { selection: SelectionInfo } | null;
  popover: { highlight: HighlightView; anchor: DOMRect } | null;
  toasts: Toast[];
  /** Counts error toasts so a caller can tell whether the host already reported a failure. */
  errorSeq: number;
}

export interface Store<S> {
  get(): S;
  set(patch: Partial<S> | ((state: S) => Partial<S>)): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<S>(initial: S): Store<S> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(patch) {
      state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
      for (const l of [...listeners]) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

export function useStore<S, T>(store: Store<S>, select: (state: S) => T): T {
  return useSyncExternalStore(store.subscribe, () => select(store.get()));
}

const MAX_TOASTS = 3;
let toastSeq = 0;

export function pushToast(
  store: Store<UiState>,
  notice: { text: string; tone?: ToastTone; action?: Toast['action'] },
): number {
  const toast: Toast = { ...notice, id: ++toastSeq, tone: notice.tone ?? 'info' };
  store.set((s) => ({
    // A repeat of what is already on screen replaces it instead of stacking.
    toasts: [...s.toasts.filter((t) => t.text !== toast.text), toast].slice(-MAX_TOASTS),
    errorSeq: toast.tone === 'error' ? s.errorSeq + 1 : s.errorSeq,
  }));
  return toast.id;
}

export function dismissToast(store: Store<UiState>, id: number): void {
  store.set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}
