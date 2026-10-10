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
});
