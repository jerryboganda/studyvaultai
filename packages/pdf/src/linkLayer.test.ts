import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLinkLayer } from './linkLayer';
import { DENSE_PAGE_LINKS, type PageLink } from './links';

// jsdom has no layout: the page element reports a fixed box, so a point on the screen maps to a
// fraction of the page the way it does in a browser.
const PAGE = { left: 100, top: 50, width: 400, height: 600 };

const link = (x: number, y: number, w = 0.2, h = 0.04, page = 5): PageLink => ({
  rects: [{ x, y, w, h }],
  target: { kind: 'page', pageNumber: page, left: null, top: null },
  label: `Link to page ${page}`,
});

/** Screen point at a fraction of the page. */
const at = (fx: number, fy: number) => ({
  clientX: PAGE.left + fx * PAGE.width,
  clientY: PAGE.top + fy * PAGE.height,
});

function setup(links: PageLink[], rotation = 0) {
  const host = document.createElement('div');
  document.body.append(host);
  host.getBoundingClientRect = () =>
    ({
      ...PAGE,
      x: PAGE.left,
      y: PAGE.top,
      right: PAGE.left + PAGE.width,
      bottom: PAGE.top + PAGE.height,
      toJSON: () => ({}),
    }) as DOMRect;
  const stop = new AbortController();
  const onActivate = vi.fn();
  const layer = createLinkLayer(host, stop.signal, onActivate);
  host.append(layer.el);
  layer.paint({ links, omitted: 0 }, rotation, 3);
  const anchors = (): HTMLElement[] => [...layer.el.querySelectorAll<HTMLElement>('a')];
  const press = (p: { clientX: number; clientY: number }, target: Element = host): void => {
    target.dispatchEvent(new MouseEvent('pointerdown', { ...p, bubbles: true }));
  };
  const click = (p: { clientX: number; clientY: number }, target: Element = host): boolean =>
    target.dispatchEvent(new MouseEvent('click', { ...p, bubbles: true, cancelable: true }));
  return { host, layer, stop, onActivate, anchors, press, click };
}

afterEach(() => {
  document.body.replaceChildren();
  document.getSelection()?.removeAllRanges();
});

describe('link layer: the anchors', () => {
  it('draws one named anchor per link, in reading order, placed in percent of the page', () => {
    const { layer, anchors } = setup([
      link(0.1, 0.5, 0.2, 0.04, 9),
      link(0.5, 0.1, 0.2, 0.04, 2),
      link(0.1, 0.1, 0.2, 0.04, 1),
    ]);
    expect(anchors().map((a) => a.getAttribute('aria-label'))).toEqual([
      'Link to page 1',
      'Link to page 2',
      'Link to page 9',
    ]);
    const first = anchors()[0]!;
    expect(first.getAttribute('role')).toBe('link');
    expect(Number.parseFloat(first.style.left)).toBeCloseTo(10.0, 3);
    expect(Number.parseFloat(first.style.top)).toBeCloseTo(10.0, 3);
    expect(Number.parseFloat(first.style.width)).toBeCloseTo(20.0, 3);
    expect(Number.parseFloat(first.style.height)).toBeCloseTo(4.0, 3);
    expect(layer.el.getAttribute('role')).toBe('group');
    expect(layer.el.getAttribute('aria-label')).toBe('Links on page 3: 3');
  });

  it('applies the rotation the page is shown at', () => {
    const { anchors } = setup([link(0.1, 0.2, 0.3, 0.05)], 90);
    const a = anchors()[0]!;
    // rotateRect 90: x = 1 - (y + h), y = x, w = h, h = w
    expect(Number.parseFloat(a.style.left)).toBeCloseTo(75.0, 3);
    expect(Number.parseFloat(a.style.top)).toBeCloseTo(10.0, 3);
    expect(Number.parseFloat(a.style.width)).toBeCloseTo(5.0, 3);
    expect(Number.parseFloat(a.style.height)).toBeCloseTo(30.0, 3);
  });

  it('a page with no links has no group', () => {
    const { layer, anchors } = setup([]);
    expect(anchors()).toHaveLength(0);
    expect(layer.el.getAttribute('role')).toBeNull();
  });

  it('puts every link of a sparse page in the tab order', () => {
    const { anchors } = setup([link(0.1, 0.1), link(0.1, 0.3), link(0.1, 0.5)]);
    expect(anchors().map((a) => a.tabIndex)).toEqual([0, 0, 0]);
  });

  it('gives a dense page one tab stop and arrow keys, not one stop per link', () => {
    const many = Array.from({ length: DENSE_PAGE_LINKS + 1 }, (_, i) => link(0.1, 0.01 + i * 0.02));
    const { layer, anchors } = setup(many);
    expect(anchors().filter((a) => a.tabIndex === 0)).toHaveLength(1);
    expect(anchors()[0]!.tabIndex).toBe(0);
    expect(layer.el.getAttribute('aria-label')).toContain('arrow keys');

    anchors()[0]!.focus();
    anchors()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(anchors()[1]);
    expect(
      anchors()
        .map((a) => a.tabIndex)
        .filter((t) => t === 0),
    ).toHaveLength(1);
    expect(anchors()[1]!.tabIndex).toBe(0);
    expect(anchors()[0]!.tabIndex).toBe(-1);

    anchors()[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(document.activeElement).toBe(anchors()[DENSE_PAGE_LINKS]);
  });

  it('Enter on a focused anchor follows its link; other keys do nothing', () => {
    const { anchors, onActivate } = setup([link(0.1, 0.1, 0.2, 0.04, 8)]);
    const a = anchors()[0]!;
    a.focus();
    a.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(onActivate).not.toHaveBeenCalled();
    a.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate.mock.calls[0]![0].target.pageNumber).toBe(8);
  });
});

describe('link layer: the pointer', () => {
  // That the anchors take no pointer events (so a drag that starts on a link still selects text) is a
  // CSS fact of the stylesheet: tests/e2e/pdf-links.spec.ts drags across a link in a real browser.
  it('a click without a drag on a link follows it', () => {
    const { press, click, onActivate } = setup([link(0.1, 0.1, 0.2, 0.04, 8)]);
    const p = at(0.2, 0.12);
    press(p);
    click(p);
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate.mock.calls[0]![0].target.pageNumber).toBe(8);
  });

  it('a click beside the link, or without a press, does nothing', () => {
    const { press, click, onActivate } = setup([link(0.1, 0.1, 0.2, 0.04)]);
    const outside = at(0.6, 0.12);
    press(outside);
    click(outside);
    click(at(0.2, 0.12)); // no pointerdown on the page first
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('a press that travelled is a drag, not a click', () => {
    const { press, click, onActivate } = setup([link(0.1, 0.1, 0.4, 0.04)]);
    press(at(0.1, 0.12));
    click(at(0.3, 0.12)); // ends on the link, 80 px away
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('never follows a link while text is selected, nor the click that ends a selection', () => {
    const { press, click, onActivate } = setup([link(0.1, 0.1, 0.4, 0.04)]);
    const words = document.createElement('p');
    words.textContent = 'selected words';
    document.body.append(words);

    // A selection made by the drag: it exists when the click arrives.
    press(at(0.2, 0.12));
    document.getSelection()!.selectAllChildren(words);
    click(at(0.2, 0.12));
    expect(onActivate).not.toHaveBeenCalled();

    // A selection that was there before the press: this click only clears it.
    press(at(0.2, 0.12));
    document.getSelection()!.removeAllRanges();
    click(at(0.2, 0.12));
    expect(onActivate).not.toHaveBeenCalled();

    // Nothing selected: the next click follows the link.
    press(at(0.2, 0.12));
    click(at(0.2, 0.12));
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('leaves a click on a highlight underline to the highlight', () => {
    const { host, press, click, onActivate } = setup([link(0.1, 0.1, 0.4, 0.04)]);
    const rule = document.createElement('div');
    rule.className = 'sv-pdf-hl__rule';
    host.append(rule);
    press(at(0.2, 0.12), rule);
    click(at(0.2, 0.12), rule);
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('an assistive technology that activates the anchor itself follows it', () => {
    const { anchors, click, onActivate } = setup([link(0.1, 0.1, 0.2, 0.04, 6)]);
    click({ clientX: 0, clientY: 0 }, anchors()[0]!);
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate.mock.calls[0]![0].target.pageNumber).toBe(6);
  });

  it('marks the page while the pointer is over a link, and not while a button is down', () => {
    const { host } = setup([link(0.1, 0.1, 0.2, 0.04)]);
    const move = (p: { clientX: number; clientY: number }, buttons = 0): void => {
      host.dispatchEvent(new MouseEvent('pointermove', { ...p, buttons, bubbles: true }));
    };
    move(at(0.2, 0.12));
    expect(host.classList.contains('sv-over-link')).toBe(true);
    move(at(0.8, 0.8));
    expect(host.classList.contains('sv-over-link')).toBe(false);
    move(at(0.2, 0.12), 1); // dragging a selection: the cursor stays the text cursor
    expect(host.classList.contains('sv-over-link')).toBe(false);
  });

  it('stops listening when the page is released', () => {
    const { stop, press, click, onActivate } = setup([link(0.1, 0.1, 0.4, 0.04)]);
    stop.abort();
    press(at(0.2, 0.12));
    click(at(0.2, 0.12));
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('a wrapped link follows from any of its lines', () => {
    const wrapped: PageLink = {
      rects: [
        { x: 0.1, y: 0.1, w: 0.5, h: 0.03 },
        { x: 0.1, y: 0.14, w: 0.2, h: 0.03 },
      ],
      target: {
        kind: 'external',
        url: 'https://example.org/',
        host: 'example.org',
        origin: 'https://example.org',
      },
      label: 'External link to example.org',
    };
    const { press, click, onActivate } = setup([wrapped]);
    for (const p of [at(0.5, 0.11), at(0.2, 0.15)]) {
      press(p);
      click(p);
    }
    expect(onActivate).toHaveBeenCalledTimes(2);
    press(at(0.5, 0.15)); // the gap beside the second line is not the link
    click(at(0.5, 0.15));
    expect(onActivate).toHaveBeenCalledTimes(2);
  });
});
