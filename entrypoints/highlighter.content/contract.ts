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
}

export interface CaptureUi {
  /** Place the floating toolbar near the selection. Must not move focus or collapse the selection. */
  showToolbar(selection: SelectionInfo): void;
  hideToolbar(): void;
  /** Popover for an existing highlight (opened by clicking it on the page). */
  showHighlightPopover(highlight: HighlightView, anchor: DOMRect): void;
  /** Transient, accessible notice. `action` renders an Undo-style button. */
  toast(notice: {
    text: string;
    tone?: 'info' | 'success' | 'error';
    action?: { label: string; run: () => void };
  }): void;
  /** Re-apply theme / palette when settings change. */
  applySettings(settings: Settings): void;
  /** Remove listeners and DOM. Called on context invalidation. */
  destroy(): void;
}

/** Implemented in ui/index.tsx. */
export type CreateCaptureUi = (ctx: ContentScriptContext, host: CaptureHost) => Promise<CaptureUi>;
