import { createContext, useContext } from 'react';
import type { CaptureHost } from '../contract';
import { pushToast, type Store, type UiState } from './store';

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

const SIDE_PANEL_FAILED =
  'Could not open the side panel. Open it from the StudyVault toolbar button instead.';

/**
 * Opens the side panel, where all free text is typed: page scripts can observe keystrokes typed
 * inside the page document, so the overlay has no text fields. Call it straight from the click
 * handler, before any await: chrome.sidePanel.open needs the user gesture. A failure is reported
 * once, unless the host already did.
 */
export async function openSidePanel(ui: UiContext, highlightId: string | null): Promise<boolean> {
  const errorsBefore = ui.store.get().errorSeq;
  let opened: boolean;
  try {
    opened = await ui.host.openInSidePanel(highlightId);
  } catch {
    opened = false;
  }
  if (!opened && ui.store.get().errorSeq === errorsBefore) {
    pushToast(ui.store, { text: SIDE_PANEL_FAILED, tone: 'error' });
  }
  return opened;
}
