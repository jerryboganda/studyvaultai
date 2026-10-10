import { createRoot } from 'react-dom/client';
import type { Settings } from '@shared';
import type { CaptureHost, CaptureUi } from '../contract';
import { UiCtx, type UiContext } from './context';
import { Overlay } from './Overlay';
import { createStore, pushToast, type UiState } from './store';

export interface MountOptions {
  /** Element inside the shadow root that the React tree renders into. */
  container: HTMLElement;
  /** The element carrying data-theme / data-density (the shadow host). */
  shadowHost: HTMLElement;
  host: CaptureHost;
}

/** Alt+Shift+T: move keyboard focus into the overlay. */
function isFocusShortcut(e: KeyboardEvent): boolean {
  return e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyT';
}

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
    errorSeq: 0,
  });
  let destroyed = false;
  let returnTarget: HTMLElement | null = null;

  const applyAppearance = (settings: Settings): void => {
    shadowHost.setAttribute('data-theme', settings.theme);
    shadowHost.setAttribute('data-density', settings.density);
  };
  applyAppearance(store.get().settings);

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

  const onKeyDown = (e: KeyboardEvent): void => {
    if (!isFocusShortcut(e)) return;
    const state = store.get();
    let target: HTMLElement | null = null;
    if (state.toolbar) {
      target = container.querySelector<HTMLElement>('[role="toolbar"] button[tabindex="0"]');
    } else if (state.toasts.some((t) => t.action)) {
      target = container.querySelector<HTMLElement>('button[data-sv-toast-action]');
    }
    if (!target) return;
    e.preventDefault();
    ctx.rememberFocus();
    target.focus({ preventScroll: true });
  };

  // Light dismiss: a press anywhere on the page closes the highlight popover.
  const onPointerDown = (e: Event): void => {
    if (!store.get().popover || e.composedPath().includes(shadowHost)) return;
    ctx.closePopover(false);
  };

  doc.addEventListener('keydown', onKeyDown, true);
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
      applyAppearance(settings);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      doc.removeEventListener('keydown', onKeyDown, true);
      doc.removeEventListener('pointerdown', onPointerDown, true);
      root.unmount();
      returnTarget = null;
    },
  };
}
