import type { PdfRect } from '@shared';
import { boundsOf, rotateRect } from './geometry';
import { DENSE_PAGE_LINKS, hitTest, orderByLines, type PageLink, type PageLinks } from './links';

/**
 * The links of one page, drawn over it (ADR-006, Amendment 3): one transparent, absolutely positioned
 * anchor per link, placed in percent of the page so it follows zoom with no recomputation.
 *
 * Pointer: the anchors have `pointer-events: none`. A real hit target above the text layer would end
 * every drag-selection that starts on a link (and make the page's links drag as links), so the click
 * is caught on the page element instead and matched to the link's rectangles by arithmetic. A click
 * counts only when the pointer did not travel, no text was selected when it went down and none is
 * selected now: never during or after a selection.
 *
 * Keyboard: each anchor is focusable and Enter follows it. A page with at most DENSE_PAGE_LINKS links
 * puts each in the tab order, in reading order; a denser page offers ONE tab stop (the first link) and
 * arrow keys between the rest (roving tabindex), with the Links list of the navigation pane as the
 * primary way through it. Anchors exist only while their page is drawn, so the lazy window bounds
 * how many there are.
 */

const pct = (n: number): string => `${(n * 100).toFixed(3)}%`;
/** A press that moves farther than this (CSS px) before release is a drag, not a click. */
const CLICK_SLOP_PX = 4;

export interface LinkLayer {
  el: HTMLElement;
  /** Draw the page's links; `rotation` is the absolute viewport rotation the page is shown at. */
  paint(links: PageLinks, rotation: number, pageNumber: number): void;
}

function place(el: HTMLElement, r: PdfRect): void {
  el.style.left = pct(r.x);
  el.style.top = pct(r.y);
  el.style.width = pct(r.w);
  el.style.height = pct(r.h);
}

/**
 * `host` is the page element; listeners are removed when `signal` aborts. `onActivate` is called with
 * the link; whether it goes anywhere is the caller's decision (an address is confirmed first).
 */
export function createLinkLayer(
  host: HTMLElement,
  signal: AbortSignal,
  onActivate: (link: PageLink) => void,
): LinkLayer {
  const doc = host.ownerDocument;
  const el = doc.createElement('div');
  el.className = 'sv-pdf-layer sv-pdf-layer--links';

  let links: PageLink[] = [];
  let boxes: PdfRect[][] = [];
  let dense = false;
  let down: { x: number; y: number; selected: boolean } | null = null;

  const hasSelection = (): boolean => {
    const s = doc.getSelection();
    return s !== null && !s.isCollapsed;
  };
  const linkAt = (x: number, y: number): PageLink | null => {
    const r = host.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    return links[hitTest(boxes, (x - r.left) / r.width, (y - r.top) / r.height)] ?? null;
  };
  const linkOf = (target: EventTarget | null): PageLink | null => {
    const a = target instanceof Element ? target.closest<HTMLElement>('[data-sv-link]') : null;
    return a ? (links[Number(a.dataset.svLink)] ?? null) : null;
  };

  host.addEventListener(
    'pointerdown',
    (e) => {
      down = { x: e.clientX, y: e.clientY, selected: hasSelection() };
    },
    { signal },
  );
  host.addEventListener(
    'click',
    (e) => {
      if (e.defaultPrevented) return;
      const target = e.target instanceof Element ? e.target : null;
      // The highlight underline has its own click: it never also follows a link.
      if (target?.closest('.sv-pdf-hl__rule')) return;
      // An assistive technology's "activate" is a click on the anchor itself, with no pointer press.
      const direct = linkOf(target);
      if (direct) {
        e.preventDefault();
        onActivate(direct);
        return;
      }
      const start = down;
      down = null;
      if (!start || start.selected || hasSelection()) return;
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > CLICK_SLOP_PX) return;
      const link = linkAt(e.clientX, e.clientY);
      if (link) {
        e.preventDefault();
        onActivate(link);
      }
    },
    { signal },
  );
  // A pointer cursor over a link, set on the page (the anchors take no pointer events).
  host.addEventListener(
    'pointermove',
    (e) => {
      if (e.buttons !== 0) return;
      host.classList.toggle(
        'sv-over-link',
        links.length > 0 && linkAt(e.clientX, e.clientY) !== null,
      );
    },
    { signal },
  );
  host.addEventListener('pointerleave', () => host.classList.remove('sv-over-link'), { signal });

  el.addEventListener(
    'keydown',
    (e) => {
      const link = linkOf(e.target);
      if (!link) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        onActivate(link);
        return;
      }
      const step =
        e.key === 'ArrowDown' || e.key === 'ArrowRight'
          ? 1
          : e.key === 'ArrowUp' || e.key === 'ArrowLeft'
            ? -1
            : e.key === 'Home'
              ? -Infinity
              : e.key === 'End'
                ? Infinity
                : 0;
      if (!dense || step === 0) return;
      const anchors = [...el.querySelectorAll<HTMLElement>('[data-sv-link]')];
      const at = anchors.indexOf(e.target as HTMLElement);
      const next = anchors[Math.min(anchors.length - 1, Math.max(0, at + step))];
      if (!next || next === e.target) return;
      e.preventDefault();
      for (const a of anchors) a.tabIndex = a === next ? 0 : -1;
      next.focus();
    },
    { signal },
  );

  const paint = (page: PageLinks, rotation: number, pageNumber: number): void => {
    const shown = (l: PageLink): PdfRect => rotateRect(boundsOf(l.rects), rotation);
    links = orderByLines(page.links, shown);
    boxes = links.map((l) => l.rects.map((r) => rotateRect(r, rotation)));
    dense = links.length > DENSE_PAGE_LINKS;
    const frag = doc.createDocumentFragment();
    links.forEach((link, i) => {
      const a = doc.createElement('a');
      a.className = 'sv-pdf-link';
      a.dataset.svLink = String(i);
      a.dataset.kind = link.target.kind;
      a.setAttribute('role', 'link');
      a.setAttribute('aria-label', link.label);
      a.tabIndex = dense && i > 0 ? -1 : 0;
      place(a, shown(link));
      frag.append(a);
    });
    el.replaceChildren(frag);
    if (links.length === 0) {
      el.removeAttribute('role');
      el.removeAttribute('aria-label');
      return;
    }
    el.setAttribute('role', 'group');
    el.setAttribute(
      'aria-label',
      dense
        ? `Links on page ${pageNumber}: ${links.length}. Use the arrow keys to move between them, or the Links tab of the navigation pane.`
        : `Links on page ${pageNumber}: ${links.length}`,
    );
  };

  return { el, paint };
}
