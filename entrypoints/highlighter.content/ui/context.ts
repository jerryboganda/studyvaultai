import { createContext, useContext } from 'react';
import type { CaptureHost } from '../contract';
import type { Store, UiState } from './store';

/** What the overlay components may do. Built once by mount.tsx. */
export interface UiContext {
  host: CaptureHost;
  store: Store<UiState>;
  /** The element inside the overlay that has focus right now, if any. */
  focusedInside(): HTMLElement | null;
  /** Remember the page element focus is about to leave (call before moving focus into the overlay). */
  rememberFocus(): void;
  /** Give focus back to the remembered page element, only if it is still inside the overlay. */
  restoreFocus(): void;
  /** Hide the toolbar (and its panel), returning focus first. */
  closeToolbar(): void;
  /** Escape / Cancel on the toolbar: also clears the page selection so it does not reappear. */
  dismissToolbar(): void;
  closePopover(restoreFocus: boolean): void;
}

export const UiCtx = createContext<UiContext | null>(null);

export function useUi(): UiContext {
  const ctx = useContext(UiCtx);
  if (!ctx) throw new Error('StudyVault overlay context is missing');
  return ctx;
}

export function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message.trim() ? err.message : fallback;
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
