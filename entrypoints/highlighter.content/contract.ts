import type {
  BankLite,
  CaptureResult,
  ColorId,
  HighlightKind,
  HighlightPatch,
  HighlightView,
  Settings,
} from '@shared';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';

/**
 * Seam between the page logic (controller.ts: selection, anchoring, rehydration, messaging) and the
 * Shadow DOM interface (ui/: toolbar, note composer, popover, toast). The UI never touches the page
 * DOM, the selection, or the extension messaging; the controller never renders UI.
 */

export interface SelectionInfo {
  /** Selected text, trimmed (preview only). */
  text: string;
  /** Viewport-relative bounding rect of the selection. */
  rect: DOMRect;
}

export interface SaveRequest {
  kind: HighlightKind;
  color: ColorId;
  /** null = last-used bank, else the Inbox. */
  bankId: string | null;
  comment: string;
  priority: number;
}

/** Everything the UI may ask the page logic to do. Implemented by controller.ts. */
export interface CaptureHost {
  /** Latest settings snapshot (palette, default kind, theme, last bank). */
  settings(): Settings;
  /** Saves the selection captured when the toolbar was shown (range cloned before focus moved). */
  save(req: SaveRequest): Promise<CaptureResult>;
  listBanks(): Promise<{ banks: BankLite[]; lastBankId: string | null }>;
  createBank(name: string): Promise<BankLite>;
  /** Undo of a save = soft delete (recoverable). */
  undo(highlightId: string): Promise<void>;
  update(id: string, patch: HighlightPatch): Promise<HighlightView>;
  remove(id: string): Promise<void>;
  restore(id: string): Promise<HighlightView>;
  /** The selection was consumed or dismissed; controller may clear its stored range. */
  dismissSelection(): void;
  /**
   * Open the side panel (extension origin) for this tab, optionally focusing a highlight's note.
   * The overlay never contains free-text inputs: page scripts can observe keystrokes typed inside
   * the page document. Must be called synchronously from a user gesture handler.
   */
  openInSidePanel(highlightId: string | null): Promise<boolean>;
}

export interface CaptureUi {
  /** Place the floating toolbar near the selection. Must not move focus or collapse the selection. */
  showToolbar(selection: SelectionInfo): void;
  hideToolbar(): void;
  /** Popover for an existing highlight (opened by clicking it on the page). */
  showHighlightPopover(highlight: HighlightView, anchor: DOMRect): void;
  /**
   * The stored highlights were just reloaded (an edit made in the side panel or another tab has
   * arrived). If a popover is open, it shows `latest(id)` for its highlight instead of what it was
   * opened with; an undefined answer leaves it as it is. Never opens, moves or focuses anything.
   */
  refreshHighlightPopover(latest: (id: string) => HighlightView | undefined): void;
  /** Transient, accessible notice. `action` renders an Undo-style button. */
  toast(notice: {
    text: string;
    tone?: 'info' | 'success' | 'error';
    action?: { label: string; run: () => void };
  }): void;
  /** Re-apply theme / palette when settings change. */
  applySettings(settings: Settings): void;
  /**
   * Move keyboard focus into the visible toolbar or, when there is none, the newest actionable
   * toast (Undo). Returns false when nothing could take focus; the caller then leaves the key to
   * the page. Reached through the remappable `focus-toolbar` command: the overlay itself listens
   * for no keys, so it cannot shadow a browser accelerator.
   */
  focusToolbar(): boolean;
  /**
   * Polite screen-reader announcement with no visible toast (e.g. "Highlight 2 of 5: ...").
   * Repeating the same text is announced again. Empty text is ignored.
   */
  announce(text: string): void;
  /** Remove listeners and DOM. Called on context invalidation. */
  destroy(): void;
}

/** Implemented in ui/index.tsx. */
export type CreateCaptureUi = (ctx: ContentScriptContext, host: CaptureHost) => Promise<CaptureUi>;
