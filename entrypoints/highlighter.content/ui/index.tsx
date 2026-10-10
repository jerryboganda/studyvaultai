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
 * The shadow root is closed in production so page scripts cannot read draft notes. The e2e build
 * (`wxt build --mode e2e`) opens it because Playwright cannot pierce closed roots.
 */
export const createCaptureUi: CreateCaptureUi = async (ctx, host) => {
  const ui = await createShadowRootUi<CaptureUi>(ctx, {
    name: HOST_TAG,
    css: overlayCss,
    // Layout and stacking are set in styles.css (:host); WXT's inline positioning is not used.
    position: 'inline',
    anchor: () => document.documentElement,
    append: 'last',
    mode: import.meta.env.MODE === 'e2e' ? 'open' : 'closed',
    // Page hotkeys (single-key shortcuts) must not fire while the user types a note.
    isolateEvents: true,
    onMount: (container, _shadow, shadowHost) => mountCaptureUi({ container, shadowHost, host }),
    onRemove: (mounted) => mounted?.destroy(),
  });
  // Marked before mounting so the text stream and mutation observer never see the host unmarked.
  ui.shadowHost.setAttribute(HOST_ATTRIBUTE, '');
  ui.mount();

  const mounted = ui.mounted;
  if (!mounted) throw new Error('StudyVault overlay failed to mount');
  return {
    showToolbar: (selection) => mounted.showToolbar(selection),
    hideToolbar: () => mounted.hideToolbar(),
    showHighlightPopover: (highlight, anchor) => mounted.showHighlightPopover(highlight, anchor),
    toast: (notice) => mounted.toast(notice),
    applySettings: (settings) => mounted.applySettings(settings),
    destroy: () => ui.remove(),
  };
};
