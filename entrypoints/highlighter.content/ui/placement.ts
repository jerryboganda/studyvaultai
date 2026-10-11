export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PlaceInput {
  /** Bounding rect of the anchor (selection or highlight), viewport-relative. */
  selection: Rect;
  /** Measured size of the floating element. */
  toolbar: { w: number; h: number };
  viewport: { w: number; h: number };
  /** Space between the anchor and the floating element. */
  gap?: number;
  /** Minimum distance from the viewport edges. */
  margin?: number;
}

export interface Placement {
  /** Viewport-relative top-left of the floating element, whole pixels. */
  x: number;
  y: number;
  /**
   * above/below: clear of the anchor. edge: neither side had room, so the element sits on the
   * viewport edge nearest the visible part of the anchor and may cover it.
   */
  placement: 'above' | 'below' | 'edge';
  /**
   * The largest the element may be and still sit inside the margins. The caller applies these as
   * max-width / max-height, so a surface taller than the viewport scrolls inside itself instead of
   * running off the screen (WCAG 1.4.10 reflow).
   */
  maxWidth: number;
  maxHeight: number;
}

/**
 * Prefers above the anchor, flips below when there is no room, and only covers the anchor when
 * neither side fits inside the viewport. Horizontally it is centred on the anchor and clamped.
 * The element is assumed to be limited to maxWidth x maxHeight, so an oversized one is placed as
 * the largest size that fits (and then sits exactly on the margins).
 */
export function placeToolbar({
  selection,
  toolbar,
  viewport,
  gap = 8,
  margin = 8,
}: PlaceInput): Placement {
  const maxWidth = Math.max(0, viewport.w - 2 * margin);
  const maxHeight = Math.max(0, viewport.h - 2 * margin);
  const w = Math.min(toolbar.w, maxWidth);
  const h = Math.min(toolbar.h, maxHeight);
  const maxX = viewport.w - w - margin;
  const x = Math.round(
    Math.max(margin, Math.min(selection.left + selection.width / 2 - w / 2, maxX)),
  );

  const minY = margin;
  const maxY = viewport.h - h - margin;
  const above = selection.top - gap - h;
  const below = selection.top + selection.height + gap;
  if (above >= minY && above <= maxY) {
    return { x, y: Math.round(above), placement: 'above', maxWidth, maxHeight };
  }
  if (below >= minY && below <= maxY) {
    return { x, y: Math.round(below), placement: 'below', maxWidth, maxHeight };
  }

  const visibleTop = Math.max(selection.top, 0);
  const visibleBottom = Math.min(selection.top + selection.height, viewport.h);
  const nearTop = (visibleTop + visibleBottom) / 2 <= viewport.h / 2;
  return { x, y: nearTop ? minY : Math.max(minY, maxY), placement: 'edge', maxWidth, maxHeight };
}
