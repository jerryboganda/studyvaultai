import { createRoot } from 'react-dom/client';
import type { CaptureHost, CaptureUi } from '../contract';
import { UiCtx, type UiContext } from './context';
import { Overlay } from './Overlay';
import { createStore, pushToast, type UiState } from './store';

export interface MountOptions {
  /** Element inside the shadow root that the React tree renders into. */
  container: HTMLElement;
  /**
   * The shadow host. It carries nothing but the marker attribute: theme and density are applied on
   * an element inside the shadow root, so a page script cannot read the user's settings from it.
   */
  shadowHost: HTMLElement;
  host: CaptureHost;
}

/** An announcement is cleared after this long so it does not linger for browse-mode readers. */
const ANNOUNCE_CLEAR_MS = 8000;

/**
 * Wires the store, React tree and document listeners. Knows nothing about WXT, so jsdom tests can
 * drive it directly; index.tsx adds the Shadow DOM host.
 */
export function mountCaptureUi({ container, shadowHost, host }: MountOptions): CaptureUi {
  const doc = container.ownerDocument;
  const store = createStore<UiState>({
    settings: host.settings(),
    toolbar: null,
    popover: null,
    toasts: [],
    announcement: null,
    errorSeq: 0,
  });
  let destroyed = false;
  let returnTarget: HTMLElement | null = null;
  let announceSeq = 0;
  let announceTimer: ReturnType<typeof setTimeout> | undefined;

  const focusedInside = (): HTMLElement | null => {
    const root = container.getRootNode() as Document | ShadowRoot;
    const el = root.activeElement;
    return el instanceof HTMLElement && container.contains(el) ? el : null;
  };

  const ctx: UiContext = {
    host,
    store,
    focusedInside,
    rememberFocus() {
      const el = doc.activeElement;
      // When focus is already inside the overlay the origin was remembered earlier.
      if (el instanceof HTMLElement && el !== shadowHost && el !== doc.body) returnTarget = el;
    },
    restoreFocus() {
      const target = returnTarget;
      returnTarget = null;
      // Never yank focus from a page element the user has since moved to.
      if (target?.isConnected && focusedInside()) target.focus({ preventScroll: true });
    },
    closeToolbar() {
      ctx.restoreFocus();
      store.set({ toolbar: null });
    },
    dismissToolbar() {
      host.dismissSelection();
      ctx.closeToolbar();
    },
    closePopover(restoreFocus) {
      if (restoreFocus) ctx.restoreFocus();
      else returnTarget = null;
      store.set({ popover: null });
    },
  };

  // Light dismiss: a press anywhere on the page closes the highlight popover.
  const onPointerDown = (e: Event): void => {
    if (!store.get().popover || e.composedPath().includes(shadowHost)) return;
    ctx.closePopover(false);
  };

  // No keydown listener on purpose: the shortcut that brings the user here is a (remappable)
  // browser command, and a page-level handler for a fixed key swallowed Chrome's own accelerators.
  doc.addEventListener('pointerdown', onPointerDown, true);

  const root = createRoot(container);
  root.render(
    <UiCtx.Provider value={ctx}>
      <Overlay />
    </UiCtx.Provider>,
  );

  return {
    showToolbar(selection) {
      if (destroyed) return;
      store.set({ toolbar: { selection }, popover: null });
    },
    hideToolbar() {
      if (destroyed || !store.get().toolbar) return;
      ctx.closeToolbar();
    },
    showHighlightPopover(highlight, anchor) {
      if (destroyed) return;
      store.set({ popover: { highlight, anchor } });
    },
    toast(notice) {
      if (destroyed) return;
      pushToast(store, notice);
    },
    applySettings(settings) {
      if (destroyed) return;
      store.set({ settings });
    },
    focusToolbar() {
      if (destroyed) return false;
      const { toolbar, toasts } = store.get();
      let target: HTMLElement | null = null;
      if (toolbar) {
        target = container.querySelector<HTMLElement>('[role="toolbar"] button[tabindex="0"]');
      } else {
        // The newest actionable toast: Undo must undo the save the user just made.
        const toast = [...toasts].reverse().find((t) => t.action);
        if (toast) {
          target = container.querySelector<HTMLElement>(
            `button[data-sv-toast-action="${toast.id}"]`,
          );
        }
      }
      if (!target) return false;
      ctx.rememberFocus();
      target.focus({ preventScroll: true });
      if (focusedInside() === target) return true;
      // A surface that is not laid out yet (hidden until measured) refuses focus.
      returnTarget = null;
      return false;
    },
    announce(text) {
      if (destroyed || !text.trim()) return;
      // A new id replaces the message node, which is what makes an identical text speak again.
      store.set({ announcement: { id: ++announceSeq, text } });
      clearTimeout(announceTimer);
      announceTimer = setTimeout(() => store.set({ announcement: null }), ANNOUNCE_CLEAR_MS);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearTimeout(announceTimer);
      doc.removeEventListener('pointerdown', onPointerDown, true);
      root.unmount();
      returnTarget = null;
    },
  };
}
