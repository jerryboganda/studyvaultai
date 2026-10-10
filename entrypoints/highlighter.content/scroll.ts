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
 * Scrolls so the middle of `range` sits in the middle of its scroll container (or the viewport).
 * `Element.scrollIntoView` is not used: it centres the whole element, which for a long paragraph
 * can leave the highlighted sentence off-screen. Reduced-motion users get an instant jump.
 */
export function scrollRangeToCenter(win: Window, range: Range): void {
  const rect = rectOf(range);
  const reduced = win.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  const behavior: ScrollBehavior = reduced ? 'auto' : 'smooth';
  const middle = rect.top + rect.height / 2;
  const scroller = scrollParent(win, elementOf(range.startContainer));
  if (scroller) {
    const box = scroller.getBoundingClientRect();
    scroller.scrollBy({ top: middle - (box.top + box.height / 2), behavior });
  } else {
    win.scrollBy({ top: middle - win.innerHeight / 2, behavior });
  }
}
