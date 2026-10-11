import { describe, expect, it } from 'vitest';
import { paintOverlay, paintRects } from './overlay';
import { buildPageText, type PageText, type PageTextItem } from './pageText';
import { orderTextLayer } from './pageView';
import { boundaryToStream, partRects, rangeParts, streamToDom, type PageDom } from './selection';
import { mk } from './testing/items';

const LETTER = { viewBox: [0, 0, 612, 792], rotate: 0 } as const;

/** A text layer the way pdf.js builds it: one span per item, in CONTENT-STREAM order. */
function layerFor(items: PageTextItem[], rotation = 0) {
  document.body.innerHTML = '<div id="page"><div id="layer"></div></div>';
  const pageEl = document.getElementById('page')!;
  const layer = document.getElementById('layer')!;
  const pt: PageText = buildPageText(items, LETTER);
  const divs = items.map((it) => {
    const span = document.createElement('span');
    span.textContent = it.str;
    layer.append(span);
    return span;
  });
  const { itemOf, spanOf } = orderTextLayer(layer, divs, pt);
  const dom: PageDom = {
    pageNumber: 1,
    pageEl,
    textLayer: layer,
    itemOf,
    spanOf,
    text: pt,
    rotation,
  };
  return { dom, layer, divs, pt };
}

const textOf = (el: Element): string => el.textContent ?? '';

describe('orderTextLayer', () => {
  const left = [
    mk('left one here', 72, 700),
    mk('left two here', 72, 686),
    mk('left three here', 72, 672),
  ];
  const right = [
    mk('right one here', 330, 700),
    mk('right two here', 330, 686),
    mk('right three here', 330, 672),
  ];
  // Let the column detector see enough boxes.
  const more = [
    mk('left four here', 72, 658),
    mk('left five here', 72, 644),
    mk('right four here', 330, 658),
    mk('right five here', 330, 644),
  ];
  const interleaved = [
    left[0]!,
    right[0]!,
    left[1]!,
    right[1]!,
    left[2]!,
    right[2]!,
    more[0]!,
    more[2]!,
    more[1]!,
    more[3]!,
  ];

  it('makes DOM order equal stream order, so a browser selection is contiguous in the stream', () => {
    const { layer, pt } = layerFor(interleaved);
    const spans = [...layer.children].filter((c) => c.tagName === 'SPAN');
    expect(spans.map(textOf).join(' ')).toBe(pt.text);
    expect(layer.querySelectorAll('br').length).toBe(pt.lineEnds.size);
  });
});

describe('selection mapping', () => {
  const items = [
    mk('The renal cortex', 72, 700),
    mk('contains glomeruli.', 72, 686),
    mk('Next paragraph here.', 72, 660),
  ];

  it('maps a DOM range across two spans to one stream range', () => {
    const { dom, divs, pt } = layerFor(items);
    const range = document.createRange();
    range.setStart(divs[0]!.firstChild!, 4); // "renal ..."
    range.setEnd(divs[1]!.firstChild!, 8); // "... contains"
    const parts = rangeParts(range, [dom]);
    expect(parts).toHaveLength(1);
    expect(pt.text.slice(parts[0]!.start, parts[0]!.end)).toBe('renal cortex contains');
  });

  it('treats container boundaries (triple click, select all) correctly', () => {
    const { dom, layer, pt } = layerFor(items);
    const range = document.createRange();
    range.selectNodeContents(layer);
    const parts = rangeParts(range, [dom]);
    expect(pt.text.slice(parts[0]!.start, parts[0]!.end)).toBe(pt.text);
    expect(boundaryToStream(dom, layer, 0, 'start')).toBe(0);
  });

  it('a selection that spans two pages yields one part per page', () => {
    const a = layerFor(items);
    const aDom = a.dom;
    // Second page appended after the first, in the same document.
    const holder = document.createElement('div');
    holder.innerHTML = '<div id="page2"><div id="layer2"></div></div>';
    document.body.append(holder);
    const layer2 = holder.querySelector('#layer2') as HTMLElement;
    const items2 = [mk('Second page text', 72, 700)];
    const pt2 = buildPageText(items2, LETTER);
    const s2 = document.createElement('span');
    s2.textContent = 'Second page text';
    layer2.append(s2);
    const m = orderTextLayer(layer2, [s2], pt2);
    const bDom: PageDom = {
      pageNumber: 2,
      pageEl: holder.querySelector('#page2') as HTMLElement,
      textLayer: layer2,
      itemOf: m.itemOf,
      spanOf: m.spanOf,
      text: pt2,
      rotation: 0,
    };
    const range = document.createRange();
    range.setStart(a.divs[2]!.firstChild!, 5); // "paragraph here." on page 1
    range.setEnd(s2.firstChild!, 6); // "Second" on page 2
    const parts = rangeParts(range, [aDom, bDom]);
    expect(parts.map((p) => p.page.pageNumber)).toEqual([1, 2]);
    expect(a.pt.text.slice(parts[0]!.start, parts[0]!.end)).toBe('paragraph here.');
    expect(pt2.text.slice(parts[1]!.start, parts[1]!.end)).toBe('Second');
  });

  it('a range outside every text layer yields nothing', () => {
    const { dom } = layerFor(items);
    const outside = document.createElement('p');
    outside.textContent = 'chrome around the page';
    document.body.append(outside);
    const range = document.createRange();
    range.selectNodeContents(outside);
    expect(rangeParts(range, [dom])).toEqual([]);
  });

  it('stream offsets map back to DOM boundaries', () => {
    const { dom, divs, pt } = layerFor(items);
    const at = pt.text.indexOf('cortex');
    const b = streamToDom(dom, at, 'start')!;
    expect(b.node).toBe(divs[0]!.firstChild);
    expect(b.offset).toBe(10);
    const e = streamToDom(dom, at + 'cortex'.length, 'end')!;
    expect(e).toEqual({ node: divs[0]!.firstChild, offset: 16 });
  });

  it('turns client rects into raw-frame rects and undoes the display rotation', () => {
    const { dom, divs, pt } = layerFor(items);
    const at = pt.text.indexOf('renal');
    const part = { page: { ...dom, rotation: 90 }, start: at, end: at + 5 };
    const pageBox = { left: 100, top: 50, width: 400, height: 200 };
    void divs;
    // On screen (rotated 90deg clockwise) the rect sits at the right edge: x 0.9..1.0, y 0..0.5.
    const rects = partRects(part, {
      pageBox,
      rects: () => [{ left: 100 + 0.9 * 400, top: 50, width: 0.1 * 400, height: 0.5 * 200 }],
    });
    expect(rects).toHaveLength(1);
    // Unrotated: x = y' = 0, y = 1 - (x' + w') = 0, w = h' = 0.5, h = w' = 0.1.
    expect(rects[0]!.x).toBeCloseTo(0, 5);
    expect(rects[0]!.y).toBeCloseTo(0, 5);
    expect(rects[0]!.w).toBeCloseTo(0.5, 5);
    expect(rects[0]!.h).toBeCloseTo(0.1, 5);
  });

  it('falls back to geometry when the browser reports no layout', () => {
    const { dom, pt } = layerFor(items);
    const rects = partRects({ page: dom, start: 0, end: pt.text.length });
    expect(rects.length).toBeGreaterThan(0);
  });
});

describe('overlay', () => {
  it('paints one box per rect with the kind cue, rotated into the displayed frame', () => {
    const layer = document.createElement('div');
    const clicked: string[] = [];
    paintOverlay(
      layer,
      [
        {
          id: 'h1',
          rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.05 }],
          color: 'amber',
          kind: 'essential',
          selected: false,
          label: 'Highlight on page 1',
        },
        {
          id: 'h2',
          rects: [
            { x: 0, y: 0, w: 0.5, h: 0.1 },
            { x: 0, y: 0.1, w: 0.2, h: 0.1 },
          ],
          color: 'blue',
          kind: 'exception',
          selected: true,
          label: 'Highlight on page 1',
        },
      ],
      0,
      (id) => clicked.push(id),
    );
    const boxes = [...layer.querySelectorAll<HTMLElement>('.sv-pdf-hl')];
    expect(boxes).toHaveLength(3);
    expect(boxes[0]!.dataset.deco).toBe('solid');
    expect(boxes[1]!.dataset.deco).toBe('wavy');
    expect(boxes[1]!.dataset.selected).toBe('true');
    expect(boxes[0]!.style.left).toBe('10%');
    boxes[0]!.querySelector<HTMLElement>('.sv-pdf-hl__rule')!.click();
    expect(clicked).toEqual(['h1']);

    paintOverlay(
      layer,
      [
        {
          id: 'h3',
          rects: [{ x: 0, y: 0, w: 0.5, h: 0.25 }],
          color: 'red',
          kind: 'question',
          selected: false,
          label: 'x',
        },
      ],
      90,
    );
    const rotated = layer.querySelector<HTMLElement>('.sv-pdf-hl')!;
    // 90deg clockwise: x' = 1 - (y + h) = 0.75, y' = x = 0, w' = h = 0.25, h' = w = 0.5.
    expect([
      rotated.style.left,
      rotated.style.top,
      rotated.style.width,
      rotated.style.height,
    ]).toEqual(['75%', '0%', '25%', '50%']);
    expect(layer.querySelectorAll('.sv-pdf-hl')).toHaveLength(1);
  });

  it('paints plain rects and marks the current one', () => {
    const layer = document.createElement('div');
    paintRects(
      layer,
      [
        { x: 0, y: 0, w: 0.1, h: 0.1 },
        { x: 0.5, y: 0.5, w: 0.1, h: 0.1 },
      ],
      0,
      'sv-pdf-find',
      (i) => i === 1,
    );
    const els = [...layer.children] as HTMLElement[];
    expect(els.map((e) => e.dataset.current ?? '')).toEqual(['', 'true']);
  });
});
