import type { ColorId, HighlightKind, PdfRect } from '@shared';
import { COLOR_SWATCH } from '@shared/constants';
import { KIND_DECORATION } from '@highlights/painter';
import { rotateRect } from './geometry';

/**
 * Highlight overlay of one page: absolutely positioned rectangles, percent-based so they follow zoom
 * with no recomputation, rotated into the displayed frame. The fill is `pointer-events: none` so text
 * selection is never blocked; the underline strip is the hit area. The cue per kind is the same
 * (decoration style, thickness) pair the web painter uses (KIND_DECORATION), so colour is never the
 * only signal. Styling lives in reader.css under `.sv-pdf-hl*`.
 */

export interface OverlayItem {
  id: string;
  rects: readonly PdfRect[];
  color: ColorId;
  kind: HighlightKind;
  selected: boolean;
  /** Accessible name of the hit area, e.g. "Highlight on page 3: essential fact". */
  label: string;
}

const pct = (n: number): string => `${(n * 100).toFixed(3)}%`;

function place(el: HTMLElement, r: PdfRect, rotation: number): void {
  const d = rotateRect(r, rotation);
  el.style.left = pct(d.x);
  el.style.top = pct(d.y);
  el.style.width = pct(d.w);
  el.style.height = pct(d.h);
}

export function paintOverlay(
  layer: HTMLElement,
  items: readonly OverlayItem[],
  rotation: number,
  onSelect?: (id: string) => void,
): void {
  const doc = layer.ownerDocument;
  const frag = doc.createDocumentFragment();
  for (const item of items) {
    const deco = KIND_DECORATION[item.kind];
    for (const r of item.rects) {
      const box = doc.createElement('div');
      box.className = 'sv-pdf-hl';
      box.dataset.hlId = item.id;
      box.dataset.kind = item.kind;
      box.dataset.deco = deco.style;
      if (item.selected) box.dataset.selected = 'true';
      box.style.setProperty('--sv-hl-fill', COLOR_SWATCH[item.color].bg);
      box.style.setProperty('--sv-hl-solid', COLOR_SWATCH[item.color].solid);
      box.style.setProperty('--sv-hl-w', `${deco.thickness}px`);
      place(box, r, rotation);
      const rule = doc.createElement('div');
      rule.className = 'sv-pdf-hl__rule';
      rule.setAttribute('role', 'button');
      rule.setAttribute('aria-label', item.label);
      rule.title = item.label;
      rule.tabIndex = -1; // keyboard users reach every highlight through the list
      if (onSelect) {
        const id = item.id;
        rule.addEventListener('click', () => onSelect(id));
      }
      box.append(rule);
      frag.append(box);
    }
  }
  layer.replaceChildren(frag);
}

/** Plain rectangles (search matches, the pending selection) in their own layer. */
export function paintRects(
  layer: HTMLElement,
  rects: readonly PdfRect[],
  rotation: number,
  className: string,
  current?: (index: number) => boolean,
): void {
  const doc = layer.ownerDocument;
  const frag = doc.createDocumentFragment();
  rects.forEach((r, i) => {
    const el = doc.createElement('div');
    el.className = className;
    if (current?.(i)) el.dataset.current = 'true';
    place(el, r, rotation);
    frag.append(el);
  });
  layer.replaceChildren(frag);
}
