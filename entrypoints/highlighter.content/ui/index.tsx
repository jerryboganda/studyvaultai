import { createShadowRootUi } from 'wxt/utils/content-script-ui/shadow-root';
import { HOST_ATTRIBUTE } from '@highlights';
import type { CaptureUi, CreateCaptureUi } from '../contract';
import { mountCaptureUi } from './mount';
// Inlined into the bundle: no runtime fetch and no web_accessible_resources entry for pages to probe.
import overlayCss from './styles.css?inline';

export { placeToolbar } from './placement';
export type { PlaceInput, Placement, Rect } from './placement';

/** Custom element name of the overlay host (must contain a hyphen). */
export const HOST_TAG = 'studyvault-overlay';

/**
 * Mounts the overlay inside a Shadow DOM host appended to <html>, so page CSS cannot reach it and
 * an ancestor transform on <body> cannot break fixed positioning.
 *
 * The shadow root is closed in production so page scripts cannot walk into it. The e2e variant
 * (`pnpm build:e2e`, SV_E2E=1) opens it because Playwright cannot pierce closed roots.
 */
declare const __SV_E2E__: boolean | undefined;

export const createCaptureUi: CreateCaptureUi = async (ctx, host) => {
  const ui = await createShadowRootUi<CaptureUi>(ctx, {
    name: HOST_TAG,
    css: overlayCss,
    // Layout and stacking are set in styles.css (:host); WXT's inline positioning is not used.
    position: 'inline',
    anchor: () => document.documentElement,
    append: 'last',
    mode: typeof __SV_E2E__ !== 'undefined' && __SV_E2E__ ? 'open' : 'closed',
    // Page hotkeys (single-key shortcuts) must not fire while the user drives the overlay by keyboard.
    // This does not hide keystrokes from capture-phase page listeners: the overlay has no text fields.
    isolateEvents: true,
    onMount: (container, _shadow, shadowHost) => mountCaptureUi({ container, shadowHost, host }),
    onRemove: (mounted) => mounted?.destroy(),
  });
  // Marked before mounting so the text stream and mutation observer never see the host unmarked.
  // This is the only attribute the page-visible host ever carries; theme and density are applied
  // inside the shadow root (Overlay.tsx).
  ui.shadowHost.setAttribute(HOST_ATTRIBUTE, '');
  ui.mount();

  const mounted = ui.mounted;
  if (!mounted) throw new Error('StudyVault overlay failed to mount');
  return {
    showToolbar: (selection) => mounted.showToolbar(selection),
    hideToolbar: () => mounted.hideToolbar(),
    showHighlightPopover: (highlight, anchor) => mounted.showHighlightPopover(highlight, anchor),
    refreshHighlightPopover: (latest) => mounted.refreshHighlightPopover(latest),
    toast: (notice) => mounted.toast(notice),
    applySettings: (settings) => mounted.applySettings(settings),
    focusToolbar: () => mounted.focusToolbar(),
    announce: (text) => mounted.announce(text),
    destroy: () => ui.remove(),
  };
};
