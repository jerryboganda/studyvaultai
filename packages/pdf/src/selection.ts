import type { PdfRect } from '@shared';
import { clampRect, mergeLineRects, unrotateRect } from './geometry';
import { rectsForRange, streamOffsetOf, type PageText } from './pageText';

/**
 * Selection <-> page text stream mapping. The reader re-orders the text-layer spans of each page into
 * stream order (pageView.ts), so the DOM range the browser selects is contiguous in the stream too.
 */

export interface PageDom {
  pageNumber: number;
  /** Element whose border box is the page; client rects are normalised against it. */
  pageEl: HTMLElement;
  textLayer: HTMLElement;
  /** Text-layer span -> original item index. */
  itemOf: ReadonlyMap<Node, number>;
  /** Item index -> text-layer span. */
  spanOf: ReadonlyMap<number, HTMLElement>;
  text: PageText;
  /** Viewport rotation the page is displayed at (page /Rotate + the reader's rotation). */
  rotation: number;
}

export interface PagePart {
  page: PageDom;
  /** Stream range, whitespace-trimmed, non-empty. */
  start: number;
  end: number;
}

/** DOM boundary point -> stream offset, or null when it is not inside a mapped span. */
export function boundaryToStream(
  page: PageDom,
  node: Node,
  offset: number,
  bias: 'start' | 'end',
): number | null {
  const pt = page.text;
  if (node.nodeType === 3 /* Text */) {
    const item = node.parentNode ? page.itemOf.get(node.parentNode) : undefined;
    return item === undefined ? null : streamOffsetOf(pt, item, offset, bias);
  }
  const own = page.itemOf.get(node);
  if (own !== undefined) {
    const len = pt.items[own]?.length ?? 0;
    return streamOffsetOf(pt, own, offset <= 0 ? 0 : len, bias);
  }
  const kids = node.childNodes;
  if (bias === 'start') {
    for (let k = offset; k < kids.length; k++) {
      const item = page.itemOf.get(kids[k]!);
      const at = item === undefined ? null : streamOffsetOf(pt, item, 0, 'start');
      if (at !== null) return at;
    }
    return pt.text.length;
  }
  for (let k = Math.min(offset, kids.length) - 1; k >= 0; k--) {
    const item = page.itemOf.get(kids[k]!);
    const at =
      item === undefined ? null : streamOffsetOf(pt, item, pt.items[item]?.length ?? 0, 'end');
    if (at !== null) return at;
  }
  return 0;
}

/** One part per page that the range touches. A range over several pages yields several parts. */
export function rangeParts(range: Range, pages: readonly PageDom[]): PagePart[] {
  const parts: PagePart[] = [];
  for (const page of pages) {
    if (!range.intersectsNode(page.textLayer)) continue;
    const text = page.text.text;
    const startIn = page.textLayer.contains(range.startContainer);
    const endIn = page.textLayer.contains(range.endContainer);
    let s = startIn ? boundaryToStream(page, range.startContainer, range.startOffset, 'start') : 0;
    let e = endIn
      ? boundaryToStream(page, range.endContainer, range.endOffset, 'end')
      : text.length;
    if (s === null || e === null) continue;
    while (s < e && text[s] === ' ') s++;
    while (e > s && text[e - 1] === ' ') e--;
    if (e > s) parts.push({ page, start: s, end: e });
  }
  return parts;
}

/** Stream offset -> DOM boundary (text node + raw offset). Null when no mapped text is there. */
export function streamToDom(
  page: PageDom,
  offset: number,
  bias: 'start' | 'end',
): { node: Text; offset: number } | null {
  const segs = page.text.segments;
  const pick = (s: (typeof segs)[number], raw: number) => {
    const span = page.spanOf.get(s.item);
    const node = span?.firstChild;
    return node && node.nodeType === 3 ? { node: node as Text, offset: raw } : null;
  };
  if (bias === 'start') {
    for (const s of segs) {
      if (s.item < 0 || s.end <= offset) continue;
      const oneToOne = s.rawEnd - s.rawStart === s.end - s.start;
      return pick(s, oneToOne ? s.rawStart + Math.max(0, offset - s.start) : s.rawStart);
    }
    return null;
  }
  for (let k = segs.length - 1; k >= 0; k--) {
    const s = segs[k]!;
    if (s.item < 0 || s.start >= offset) continue;
    const oneToOne = s.rawEnd - s.rawStart === s.end - s.start;
    return pick(s, oneToOne ? s.rawStart + Math.min(offset - s.start, s.end - s.start) : s.rawEnd);
  }
  return null;
}

export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface RectEnv {
  /** Client rects of a DOM range (default: Range.getClientRects). Injectable for tests. */
  rects?: (range: Range) => ArrayLike<RectLike>;
  /** Border box of the page element (default: getBoundingClientRect). */
  pageBox?: RectLike;
}

/**
 * Highlight rectangles of a part, in the raw page frame. The browser's own client rects of the
 * selected text are used (exact to the glyph); when the layout is unavailable the rects are derived
 * from item geometry instead.
 */
export function partRects(part: PagePart, env: RectEnv = {}): PdfRect[] {
  const { page, start, end } = part;
  const a = streamToDom(page, start, 'start');
  const b = streamToDom(page, end, 'end');
  const box = env.pageBox ?? page.pageEl.getBoundingClientRect();
  if (a && b && box.width > 0 && box.height > 0) {
    const range = page.pageEl.ownerDocument.createRange();
    try {
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
    } catch {
      return rectsForRange(page.text, start, end);
    }
    const list = env.rects ? env.rects(range) : range.getClientRects();
    const out: PdfRect[] = [];
    for (let i = 0; i < list.length; i++) {
      const r = list[i]!;
      if (r.width < 1 || r.height < 1) continue;
      out.push(
        clampRect(
          unrotateRect(
            {
              x: (r.left - box.left) / box.width,
              y: (r.top - box.top) / box.height,
              w: r.width / box.width,
              h: r.height / box.height,
            },
            page.rotation,
          ),
        ),
      );
    }
    const merged = mergeLineRects(out.filter((r) => r.w > 0 && r.h > 0));
    if (merged.length > 0) return merged;
  }
  return rectsForRange(page.text, start, end);
}
