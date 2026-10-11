import { afterEach, describe, expect, it, vi } from 'vitest';
import { scrollRangeToCenter } from './scroll';
import { rangeOver, setBody } from './testUtils';

type RangeWithRect = { getBoundingClientRect?: unknown };

function stubRangeRect(top: number, height: number): void {
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ top, height, left: 0, width: 50, right: 50, bottom: top + height }),
  });
}

afterEach(() => {
  delete (Range.prototype as { getClientRects?: unknown }).getClientRects;
  delete (Element.prototype as { checkVisibility?: unknown }).checkVisibility;
  delete (Range.prototype as RangeWithRect).getBoundingClientRect;
  delete (window as { matchMedia?: unknown }).matchMedia;
  setBody('');
});

describe('scrollRangeToCenter', () => {
  it('scrolls the nearest scrollable ancestor, not the page', () => {
    setBody(
      '<div id="pane" style="overflow-y:auto"><p>Some words that are highlighted here.</p></div>',
    );
    const pane = document.getElementById('pane')!;
    Object.defineProperty(pane, 'scrollHeight', { value: 2000, configurable: true });
    Object.defineProperty(pane, 'clientHeight', { value: 400, configurable: true });
    pane.getBoundingClientRect = () => ({ top: 100, height: 400 }) as DOMRect;
    const paneScroll = vi.fn();
    pane.scrollBy = paneScroll as never;
    const pageScroll = vi.fn();
    window.scrollBy = pageScroll as never;

    stubRangeRect(700, 20); // 710 is 410px below the pane's middle (300)
    scrollRangeToCenter(window, rangeOver('words that are'));
    expect(paneScroll).toHaveBeenCalledWith({ top: 410, behavior: 'smooth' });
    expect(pageScroll).not.toHaveBeenCalled();
  });

  it('scrolls the viewport when no ancestor scrolls', () => {
    setBody('<p>Some words that are highlighted here.</p>');
    const pageScroll = vi.fn();
    window.scrollBy = pageScroll as never;
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
    stubRangeRect(1000, 40);
    scrollRangeToCenter(window, rangeOver('words that are'));
    expect(pageScroll).toHaveBeenCalledWith({ top: 1000 + 20 - 400, behavior: 'smooth' });
  });

  it('does not animate for users who prefer reduced motion', () => {
    setBody('<p>Some words that are highlighted here.</p>');
    const pageScroll = vi.fn();
    window.scrollBy = pageScroll as never;
    window.matchMedia = ((q: string) => ({
      matches: q.includes('prefers-reduced-motion'),
    })) as never;
    stubRangeRect(10, 10);
    scrollRangeToCenter(window, rangeOver('words that are'));
    expect(pageScroll.mock.calls[0]![0]).toMatchObject({ behavior: 'auto' });
  });

  it('returns true once it has scrolled', () => {
    setBody('<p>Some words that are highlighted here.</p>');
    window.scrollBy = vi.fn() as never;
    stubRangeRect(10, 10);
    expect(scrollRangeToCenter(window, rangeOver('words that are'))).toBe(true);
  });

  it('can jump instantly (the caller measures the range straight afterwards)', () => {
    setBody('<p>Some words that are highlighted here.</p>');
    const pageScroll = vi.fn();
    window.scrollBy = pageScroll as never;
    stubRangeRect(10, 10);
    scrollRangeToCenter(window, rangeOver('words that are'), { instant: true });
    expect(pageScroll.mock.calls[0]![0]).toMatchObject({ behavior: 'instant' });
  });

  describe('text that is hidden', () => {
    function spies() {
      const pageScroll = vi.fn();
      window.scrollBy = pageScroll as never;
      const pane = document.getElementById('pane');
      const paneScroll = vi.fn();
      if (pane) {
        Object.defineProperty(pane, 'scrollHeight', { value: 2000, configurable: true });
        Object.defineProperty(pane, 'clientHeight', { value: 400, configurable: true });
        pane.scrollBy = paneScroll as never;
      }
      return { pageScroll, paneScroll };
    }

    it('display:none (no client rects): moves nothing, in the page or in a scroll pane', () => {
      setBody(
        '<div id="pane" style="overflow-y:auto"><div hidden><p>Some words in a closed panel.</p></div></div>',
      );
      const { pageScroll, paneScroll } = spies();
      stubRangeRect(0, 0);
      Object.defineProperty(Range.prototype, 'getClientRects', {
        configurable: true,
        value: () => [],
      });
      expect(scrollRangeToCenter(window, rangeOver('words in a closed'))).toBe(false);
      expect(pageScroll).not.toHaveBeenCalled();
      expect(paneScroll).not.toHaveBeenCalled();
    });

    it('rects that are all empty count as hidden', () => {
      setBody('<p>Some words that are highlighted here.</p>');
      const { pageScroll } = spies();
      stubRangeRect(0, 0);
      Object.defineProperty(Range.prototype, 'getClientRects', {
        configurable: true,
        value: () => [{ width: 0, height: 0 }],
      });
      expect(scrollRangeToCenter(window, rangeOver('words that are'))).toBe(false);
      expect(pageScroll).not.toHaveBeenCalled();
    });

    it('content-visibility:hidden (a closed <details>) keeps its boxes but is still hidden', () => {
      setBody('<details><summary>More</summary><p>Some words in a closed details.</p></details>');
      const { pageScroll } = spies();
      stubRangeRect(300, 20);
      Object.defineProperty(Range.prototype, 'getClientRects', {
        configurable: true,
        value: () => [{ width: 120, height: 18 }], // the engine still reports a box
      });
      Object.defineProperty(Element.prototype, 'checkVisibility', {
        configurable: true,
        value: () => false,
      });
      expect(scrollRangeToCenter(window, rangeOver('words in a closed'))).toBe(false);
      expect(pageScroll).not.toHaveBeenCalled();
    });

    it('text with a box is scrolled to', () => {
      setBody('<p>Some words that are highlighted here.</p>');
      const { pageScroll } = spies();
      stubRangeRect(300, 20);
      Object.defineProperty(Range.prototype, 'getClientRects', {
        configurable: true,
        value: () => [{ width: 120, height: 18 }],
      });
      Object.defineProperty(Element.prototype, 'checkVisibility', {
        configurable: true,
        value: () => true,
      });
      expect(scrollRangeToCenter(window, rangeOver('words that are'))).toBe(true);
      expect(pageScroll).toHaveBeenCalledTimes(1);
    });
  });
});
