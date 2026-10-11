import { act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STYLES_CSS, declsFor, parseCss, readCss } from './testCss';
import { cleanupUi, makeHighlight, mountUi, rect } from './testHarness';

/**
 * jsdom has no layout. These tests give the overlay a viewport and natural sizes, and check what
 * it does about them: where it places itself, and what limits it sets so that nothing it shows
 * can be taller or wider than the screen (WCAG 1.4.10 reflow).
 */

interface Layout {
  view: { w: number; h: number };
  /** Natural height of the toolbar unit without / with a composer panel. */
  unit: { bar: number; withPanel: number; w: number };
  popover: { w: number; h: number };
}

function stubLayout({ view, unit, popover }: Layout): void {
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (this: Element) {
    return this === document.documentElement ? view.w : 0;
  });
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (this: Element) {
    return this === document.documentElement ? view.h : 0;
  });
  const sized = (el: HTMLElement): { w: number; h: number } => {
    if (el.classList.contains('sv-unit')) {
      return { w: unit.w, h: el.querySelector('.sv-panel') ? unit.withPanel : unit.bar };
    }
    if (el.classList.contains('sv-popover')) return popover;
    return { w: 0, h: 0 };
  };
  // A real browser reports the size after max-width/max-height, which the placement then trusts.
  const limited = (el: HTMLElement, axis: 'w' | 'h'): number => {
    const natural = sized(el)[axis];
    const cap = parseFloat(axis === 'w' ? el.style.maxWidth : el.style.maxHeight);
    return Number.isFinite(cap) ? Math.min(natural, cap) : natural;
  };
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return limited(this, 'w');
  });
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return limited(this, 'h');
  });
}

const unitOf = (container: HTMLElement): HTMLElement =>
  container.querySelector('.sv-unit') as HTMLElement;

afterEach(cleanupUi);

describe('floating surfaces are capped to the layout viewport', () => {
  it('sets px limits from the viewport minus the 8px margins, not from 100vw/100vh', () => {
    // 1366x657 at 200% zoom with a classic scrollbar: 683px wide viewport, 15px of it scrollbar.
    stubLayout({
      view: { w: 668, h: 328 },
      unit: { bar: 42, withPanel: 300, w: 420 },
      popover: { w: 300, h: 200 },
    });
    const { ui, container } = mountUi();
    act(() => ui.showToolbar({ text: 'abc', rect: rect(100, 200, 50, 20) }));
    const unit = unitOf(container);
    expect(unit.style.maxWidth).toBe('652px');
    expect(unit.style.maxHeight).toBe('312px');
  });

  it('places the bar above the selection, centred on it, when it fits there', () => {
    stubLayout({
      view: { w: 640, h: 360 },
      unit: { bar: 42, withPanel: 388, w: 424 },
      popover: { w: 300, h: 200 },
    });
    const { ui, container } = mountUi();
    act(() => ui.showToolbar({ text: 'abc', rect: rect(200, 150, 160, 20) }));
    const unit = unitOf(container);
    expect(unit.dataset.placement).toBe('above');
    // centre 280 - 212 = 68; 150 - 12 - 42 = 96
    expect(unit.style.transform).toBe('translate(68px, 96px)');
  });

  it('re-places the unit when a panel makes it too tall for where it was', async () => {
    stubLayout({
      view: { w: 640, h: 360 },
      unit: { bar: 42, withPanel: 388, w: 424 },
      popover: { w: 300, h: 200 },
    });
    const { ui, container, q } = mountUi();
    act(() => ui.showToolbar({ text: 'abc', rect: rect(200, 150, 160, 20) }));
    expect(unitOf(container).dataset.placement).toBe('above');

    await userEvent.setup().click(q.getByRole('button', { name: 'More options' }));
    const unit = unitOf(container);
    // 388px does not fit in 360px: it is limited to 344px and sits on the top margin.
    expect(unit.style.maxHeight).toBe('344px');
    expect(unit.dataset.placement).toBe('edge');
    expect(unit.style.transform).toBe('translate(68px, 8px)');
    expect(within(unit).getByRole('dialog', { name: 'Save with details' })).toBeTruthy();
  });

  it('flips the bar below the selection when there is no room above it', () => {
    stubLayout({
      view: { w: 640, h: 360 },
      unit: { bar: 42, withPanel: 260, w: 424 },
      popover: { w: 300, h: 200 },
    });
    const { ui, container } = mountUi();
    act(() => ui.showToolbar({ text: 'abc', rect: rect(200, 10, 160, 20) }));
    const unit = unitOf(container);
    expect(unit.dataset.placement).toBe('below');
    // 10 + 20 + 12
    expect(unit.style.transform).toBe('translate(68px, 42px)');
  });

  it('limits the highlight popover the same way and keeps it inside the margins', () => {
    stubLayout({
      view: { w: 640, h: 360 },
      unit: { bar: 42, withPanel: 260, w: 424 },
      popover: { w: 300, h: 400 },
    });
    const { ui, q } = mountUi();
    act(() => ui.showHighlightPopover(makeHighlight(), rect(100, 150, 160, 20)));
    const dialog = q.getByRole('dialog', { name: 'Highlight details' });
    expect(dialog.style.maxHeight).toBe('344px');
    expect(dialog.style.maxWidth).toBe('624px');
    expect(dialog.dataset.placement).toBe('edge');
    expect(dialog.style.transform).toBe('translate(30px, 8px)');
  });

  it('a 320x256 viewport (400% zoom) is limited to 304x240', () => {
    stubLayout({
      view: { w: 320, h: 256 },
      unit: { bar: 80, withPanel: 388, w: 424 },
      popover: { w: 300, h: 400 },
    });
    const { ui, container, q } = mountUi();
    act(() => ui.showToolbar({ text: 'abc', rect: rect(40, 100, 100, 20) }));
    expect(unitOf(container).style.maxWidth).toBe('304px');
    expect(unitOf(container).style.maxHeight).toBe('240px');
    act(() => ui.showHighlightPopover(makeHighlight(), rect(40, 100, 100, 20)));
    const dialog = q.getByRole('dialog', { name: 'Highlight details' });
    expect(dialog.style.maxWidth).toBe('304px');
    expect(dialog.style.maxHeight).toBe('240px');
    expect(dialog.style.transform).toBe('translate(8px, 8px)');
  });
});

describe('the More options markup matches the two-column layout', () => {
  const styles = parseCss(readCss(STYLES_CSS));
  const wide = '(max-height: 520px) and (min-width: 480px)';
  const areaClasses = new Set(
    styles
      .filter((r) => r.media === wide && r.decls.has('grid-area'))
      .flatMap((r) => r.selectors)
      .map((s) => /> \.([\w-]+)$/.exec(s)?.[1])
      .filter((c): c is string => c !== undefined),
  );

  it('has an area for every direct child of the More options panel', async () => {
    const { ui, q } = mountUi();
    act(() => ui.showToolbar({ text: 'abc', rect: rect(100, 200, 50, 20) }));
    await userEvent.setup().click(q.getByRole('button', { name: 'More options' }));
    const panel = q.getByRole('dialog', { name: 'Save with details' });
    await within(panel).findByRole('combobox', { name: 'Bank' });
    expect(areaClasses.size).toBeGreaterThanOrEqual(4);
    const orphans = Array.from(panel.children)
      .filter((child) => !Array.from(child.classList).some((c) => areaClasses.has(c)))
      .map((child) => child.outerHTML.slice(0, 80));
    expect(orphans, 'children without a grid-area would be auto-placed').toEqual([]);
  });

  it('declares the area for each class the panel uses', () => {
    for (const cls of ['sv-quote', 'sv-area-bank', 'sv-area-kind', 'sv-actions']) {
      expect(areaClasses.has(cls), cls).toBe(true);
    }
    expect(declsFor(styles, '.sv-panel', wide).get('grid-template-areas')).toBe(
      "'quote quote' 'bank kind' 'actions actions'",
    );
  });
});
