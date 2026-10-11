import { elementOf, rectOf } from './eligibility';

/** The nearest ancestor that scrolls vertically, or null when the page (viewport) scrolls. */
function scrollParent(win: Window, from: Element | null): Element | null {
  const root = win.document.documentElement;
  for (let el = from; el && el !== root && el !== win.document.body; el = el.parentElement) {
    const overflow = win.getComputedStyle(el).overflowY;
    if (/auto|scroll|overlay/.test(overflow) && el.scrollHeight > el.clientHeight) return el;
  }
  return null;
}

/**
 * Does the text have a box to scroll to? False for display:none (closed tab panel, collapsed
 * accordion: no client rects) and for content-visibility:hidden, which keeps boxes but shows
 * nothing (a closed <details>). Where there is no layout engine (jsdom) nothing can be said.
 */
function isRendered(range: Range): boolean {
  const owner = elementOf(range.startContainer);
  if (typeof owner?.checkVisibility === 'function' && !owner.checkVisibility()) return false;
  if (typeof range.getClientRects !== 'function') return true;
  return Array.from(range.getClientRects()).some((r) => r.width > 0 || r.height > 0);
}

/**
 * Scrolls so the middle of `range` sits in the middle of its scroll container (or the viewport).
 * `Element.scrollIntoView` is not used: it centres the whole element, which for a long paragraph
 * can leave the highlighted sentence off-screen. Reduced-motion users get an instant jump, and so
 * does `instant` (a caller that measures the range right after, e.g. to anchor a popover).
 * Returns false, having moved nothing, when the text is hidden: a zero rect would otherwise scroll
 * the page to its top.
 */
export function scrollRangeToCenter(
  win: Window,
  range: Range,
  opts: { instant?: boolean } = {},
): boolean {
  if (!isRendered(range)) return false;
  const rect = rectOf(range);
  const reduced = win.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  const behavior: ScrollBehavior = opts.instant ? 'instant' : reduced ? 'auto' : 'smooth';
  const middle = rect.top + rect.height / 2;
  const scroller = scrollParent(win, elementOf(range.startContainer));
  if (scroller) {
    const box = scroller.getBoundingClientRect();
    scroller.scrollBy({ top: middle - (box.top + box.height / 2), behavior });
  } else {
    win.scrollBy({ top: middle - win.innerHeight / 2, behavior });
  }
  return true;
}
