import type { PdfRect } from '@shared';
import { cyrb53Hex } from '@highlights/hash';
import { clampRect, mergeLineRects, normalizeRotation, rotateRect } from './geometry';

/**
 * Page text stream `sv-pdf-text-v1` (ADR-006). The anchor space of a PDF highlight is a derived string
 * of ONE page, never `Selection.toString()` and never raw pdf.js item order:
 *
 *  1. Items are placed in reading order from their geometry: columns are found from empty vertical
 *     gutters, full-width lines (titles, captions) separate bands of columns, lines are clustered by
 *     vertical overlap and read left-to-right (right-to-left when the line's items say `rtl`).
 *  2. Items on a line are joined with one space when the horizontal gap is a word gap; lines are
 *     joined with one space.
 *  3. A hyphen (-, U+00AD, U+2010) that ends a line, follows a letter and is followed by a lowercase
 *     letter on the next line is removed and the two halves are joined without a space.
 *  4. Whitespace is collapsed exactly like ADR-004: runs of [\t\n\v\f\r<space><NBSP>] become one space,
 *     leading whitespace is dropped, no other Unicode normalisation or case folding is applied.
 *
 * The same function runs when a highlight is captured and when it is restored, so consistency is by
 * construction. Every character of the stream maps back to (item, raw offset) through `segments`.
 */

export interface PageTextItem {
  str: string;
  /** PDF user-space matrix [a, b, c, d, e, f] (pdf.js `TextItem.transform`). */
  transform: readonly number[];
  /** Advance width in user-space units. */
  width: number;
  height: number;
  /** 'ltr' | 'rtl' | 'ttb'. */
  dir?: string;
}

export interface PageGeometry {
  /** pdf.js `page.view`: [xMin, yMin, xMax, yMax] in user space. */
  viewBox: readonly number[];
  /** The page's own /Rotate (degrees); the reading order is computed as the page is shown by default. */
  rotate: number;
}

/** A run of stream characters that map 1:1 onto raw characters of one item (or a collapsed run). */
export interface TextSegment {
  /** Index into the original `items` array; -1 for a separator space that belongs to no item. */
  item: number;
  rawStart: number;
  rawEnd: number;
  start: number;
  end: number;
}

/** Item geometry in the raw page frame (normalised, origin top-left, rotation 0). */
export interface ItemGeometry {
  box: PdfRect;
  /** Baseline origin (descent included), advance vector, up vector (ascent included); normalised. */
  quad: readonly [number, number, number, number, number, number];
  /** Length of the item's raw string. */
  length: number;
}

export interface PageText {
  readonly text: string;
  /** cyrb53 hex of `text`: equals `PdfAnchorSet.contentSignature` while the page text is unchanged. */
  readonly signature: string;
  readonly segments: readonly TextSegment[];
  /** Per original item index; null for items without geometry or text. */
  readonly items: ReadonlyArray<ItemGeometry | null>;
  /** Item indices in stream (reading) order, whitespace-only items included. */
  readonly order: readonly number[];
  /** Indices into `order` after which a visual line ends. */
  readonly lineEnds: ReadonlySet<number>;
  readonly itemSegments: ReadonlyMap<number, readonly TextSegment[]>;
}

const WS = /[\t\n\v\f\r \u00A0]+/g;
const TRAILING_WS = /[\t\n\v\f\r \u00A0]+$/;
const HYPHENS = new Set(['-', '\u00AD', '\u2010']);
const LETTER = /\p{L}/u;
const LOWER = /\p{Ll}/u;

const DESCENT = 0.22;
const WORD_GAP = 0.12; // em
const LINE_TOLERANCE = 0.6; // of the smaller font height
const GUTTER_MIN = 0.6; // median font heights, after boxes are shrunk by 0.25 on each side
const GUTTER_SHRINK = 0.25;
const MIN_BOXES_FOR_COLUMNS = 8;
const MAX_GUTTERS = 3;

interface Box {
  i: number;
  str: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  cx: number;
  cy: number;
  /** Font height in user-space units. */
  h: number;
  blank: boolean;
  rtl: boolean;
}

function itemGeometry(
  it: PageTextItem,
  vx0: number,
  vy1: number,
  vbW: number,
  vbH: number,
): ItemGeometry | null {
  const t = it.transform;
  if (t.length < 6 || t.some((n) => typeof n !== 'number' || !Number.isFinite(n))) return null;
  const [a, b, c, d, e, f] = t as [number, number, number, number, number, number];
  const adv = Math.hypot(a, b);
  const width = Number.isFinite(it.width) && it.width > 0 ? it.width : 0;
  // Advance vector in user space (item.width is already scaled), up vector is (c, d).
  const wx = adv > 0 ? (a / adv) * width : 0;
  const wy = adv > 0 ? (b / adv) * width : 0;
  const ox = e - DESCENT * c;
  const oy = f - DESCENT * d;
  const hx = (1 + DESCENT) * c;
  const hy = (1 + DESCENT) * d;
  // user space (y up) -> raw frame (y down), normalised.
  const nx = (x: number): number => (x - vx0) / vbW;
  const ny = (y: number): number => (vy1 - y) / vbH;
  const quad = [nx(ox), ny(oy), wx / vbW, -wy / vbH, hx / vbW, -hy / vbH] as const;
  const xs = [quad[0], quad[0] + quad[2], quad[0] + quad[4], quad[0] + quad[2] + quad[4]];
  const ys = [quad[1], quad[1] + quad[3], quad[1] + quad[5], quad[1] + quad[3] + quad[5]];
  const box = clampRect({
    x: Math.min(...xs),
    y: Math.min(...ys),
    w: Math.max(...xs) - Math.min(...xs),
    h: Math.max(...ys) - Math.min(...ys),
  });
  return { box, quad, length: it.str.length };
}

const median = (xs: number[]): number => {
  const s = xs.slice().sort((p, q) => p - q);
  return s.length === 0 ? 0 : s[s.length >> 1]!;
};

/** Cluster boxes into visual lines (by vertical overlap) and order each line along the reading axis. */
function toLines(boxes: Box[]): Box[][] {
  const sorted = boxes.slice().sort((p, q) => p.cy - q.cy || p.x0 - q.x0);
  const lines: { ref: number; hMin: number; boxes: Box[] }[] = [];
  for (const b of sorted) {
    const cur = lines[lines.length - 1];
    if (cur && Math.abs(b.cy - cur.ref) <= LINE_TOLERANCE * Math.min(b.h, cur.hMin)) {
      cur.boxes.push(b);
      cur.hMin = Math.min(cur.hMin, b.h);
    } else {
      lines.push({ ref: b.cy, hMin: b.h, boxes: [b] });
    }
  }
  return lines.map((l) => {
    const solid = l.boxes.filter((b) => !b.blank);
    const rtl = solid.length > 0 && solid.filter((b) => b.rtl).length * 2 > solid.length;
    return l.boxes.sort((p, q) => (rtl ? q.x1 - p.x1 : p.x0 - q.x0));
  });
}

/** x positions of empty vertical bands that separate columns (display space), left to right. */
function findGutters(solid: Box[], rows: number): number[] {
  const n = solid.length;
  if (n < MIN_BOXES_FOR_COLUMNS) return [];
  const medH = median(solid.map((b) => b.h));
  if (medH <= 0) return [];
  const shrink = GUTTER_SHRINK * medH;
  const events: Array<[number, number]> = [];
  for (const b of solid) {
    const wide = b.x1 - b.x0 > 2 * shrink;
    const s = wide ? b.x0 + shrink : b.cx;
    const e = wide ? b.x1 - shrink : b.cx;
    events.push([s, 1], [e, -1]);
  }
  events.sort((p, q) => p[0] - q[0] || q[1] - p[1]);
  // Coverage may be this high inside a gutter: full-width lines (title, caption, page number) cross it.
  // Measured against ROWS, not items: a line made of many small items still covers a point once.
  const limit = Math.max(1, Math.floor(0.2 * rows));
  const minSide = Math.ceil(0.15 * n);
  const found: Array<[number, number]> = [];
  let cover = 0;
  let from: number | null = null;
  for (const [x, delta] of events) {
    cover += delta;
    if (cover <= limit && from === null) from = x;
    else if (cover > limit && from !== null) {
      found.push([from, x]);
      from = null;
    }
  }
  const out: Array<{ mid: number; width: number }> = [];
  for (const [g0, g1] of found) {
    if (g1 - g0 < GUTTER_MIN * medH) continue;
    let left = 0;
    let right = 0;
    for (const b of solid) {
      if (b.x1 <= g0 + shrink) left++;
      else if (b.x0 >= g1 - shrink) right++;
    }
    if (left >= minSide && right >= minSide) out.push({ mid: (g0 + g1) / 2, width: g1 - g0 });
  }
  // Aligned word gaps of a table also qualify; when there are many, the widest are the real columns.
  return out
    .sort((p, q) => q.width - p.width)
    .slice(0, MAX_GUTTERS)
    .map((g) => g.mid)
    .sort((p, q) => p - q);
}

/** Boxes in reading order, grouped into lines. */
function readingOrder(boxes: Box[]): Box[][] {
  const solid = boxes.filter((b) => !b.blank);
  const gutters = findGutters(solid, toLines(solid).length);
  if (gutters.length === 0) return toLines(boxes);

  const colOf = (b: Box): number => gutters.filter((g) => g <= b.cx).length;
  const spans = (b: Box): boolean => !b.blank && gutters.some((g) => b.x0 < g && b.x1 > g);
  const spanning = boxes.filter(spans);
  const bands = toLines(spanning); // full-width lines, top to bottom
  const bandY = bands.map((l) => l.reduce((s, b) => s + b.cy, 0) / l.length);

  const groups = new Map<string, { major: number; col: number; boxes: Box[] }>();
  const add = (major: number, col: number, b: Box): void => {
    const key = `${major}:${col}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { major, col, boxes: [] }));
    g.boxes.push(b);
  };
  bands.forEach((l, k) => l.forEach((b) => add(2 * k + 1, 0, b)));
  const isSpanning = new Set(spanning);
  for (const b of boxes) {
    if (isSpanning.has(b)) continue;
    add(2 * bandY.filter((y) => y < b.cy).length, colOf(b), b);
  }
  return [...groups.values()]
    .sort((p, q) => p.major - q.major || p.col - q.col)
    .flatMap((g) => toLines(g.boxes));
}

export function buildPageText(items: readonly PageTextItem[], geometry: PageGeometry): PageText {
  const [vx0 = 0, vy0 = 0, vx1 = 612, vy1 = 792] = geometry.viewBox;
  const vbW = Math.max(vx1 - vx0, 1e-6);
  const vbH = Math.max(vy1 - vy0, 1e-6);
  const rot = normalizeRotation(geometry.rotate);
  const dW = rot % 180 === 0 ? vbW : vbH;
  const dH = rot % 180 === 0 ? vbH : vbW;

  const geos: (ItemGeometry | null)[] = [];
  const boxes: Box[] = [];
  items.forEach((it, i) => {
    const g =
      typeof it.str === 'string' && it.str !== '' ? itemGeometry(it, vx0, vy1, vbW, vbH) : null;
    geos.push(g);
    if (!g) return;
    const d = rotateRect(g.box, rot);
    const x0 = d.x * dW;
    const y0 = d.y * dH;
    const x1 = (d.x + d.w) * dW;
    const y1 = (d.y + d.h) * dH;
    const t = it.transform;
    const size = Math.hypot(t[2] ?? 0, t[3] ?? 0) || it.height || (y1 - y0) / (1 + DESCENT);
    boxes.push({
      i,
      str: it.str,
      x0,
      y0,
      x1,
      y1,
      cx: (x0 + x1) / 2,
      cy: (y0 + y1) / 2,
      h: Math.max(size, 1e-3),
      blank: it.str.replace(WS, '') === '',
      rtl: it.dir === 'rtl',
    });
  });

  const lines = readingOrder(boxes);

  let text = '';
  const segments: TextSegment[] = [];
  const order: number[] = [];
  const lineEnds = new Set<number>();
  let lastSpace = true; // leading whitespace is dropped
  let joinNext = false;

  const seg = (
    item: number,
    rawStart: number,
    rawEnd: number,
    start: number,
    end: number,
  ): void => {
    const last = segments[segments.length - 1];
    const oneToOne = last !== undefined && last.rawEnd - last.rawStart === last.end - last.start;
    if (
      last &&
      oneToOne &&
      last.item === item &&
      item >= 0 &&
      last.rawEnd === rawStart &&
      last.end === start
    ) {
      last.rawEnd = rawEnd;
      last.end = end;
    } else segments.push({ item, rawStart, rawEnd, start, end });
  };
  const space = (item: number, rawStart: number, rawEnd: number): void => {
    if (lastSpace) return;
    text += ' ';
    segments.push({ item, rawStart, rawEnd, start: text.length - 1, end: text.length });
    lastSpace = true;
  };
  const word = (item: number, str: string, from: number, to: number): void => {
    seg(item, from, to, text.length, text.length + (to - from));
    text += str.slice(from, to);
    lastSpace = false;
  };

  const firstChar = (line: Box[] | undefined): string => {
    for (const b of line ?? []) {
      const m = /[^\t\n\v\f\r \u00A0]/.exec(b.str);
      if (m) return m[0];
    }
    return '';
  };

  lines.forEach((line, li) => {
    joinNext = false;
    let prev: Box | null = null;
    const rtl = line.length > 1 && line[0]!.x0 > line[line.length - 1]!.x0;
    line.forEach((b, bi) => {
      if (prev) {
        const gap = rtl ? prev.x0 - b.x1 : b.x0 - prev.x1;
        if (gap > WORD_GAP * Math.min(prev.h, b.h)) space(-1, 0, 0);
      }
      let limit = b.str.length;
      if (bi === line.length - 1) {
        const trimmed = b.str.replace(TRAILING_WS, '');
        const last = trimmed[trimmed.length - 1];
        const before = trimmed[trimmed.length - 2];
        const next = firstChar(lines[li + 1]);
        if (
          last &&
          HYPHENS.has(last) &&
          before &&
          LETTER.test(before) &&
          next &&
          LOWER.test(next)
        ) {
          limit = trimmed.length - 1;
          joinNext = true;
        }
      }
      order.push(b.i);
      let pos = 0;
      for (const m of b.str.slice(0, limit).matchAll(WS)) {
        if (m.index > pos) word(b.i, b.str, pos, m.index);
        space(b.i, m.index, m.index + m[0].length);
        pos = m.index + m[0].length;
      }
      if (pos < limit) word(b.i, b.str, pos, limit);
      prev = b;
    });
    lineEnds.add(order.length - 1);
    if (!joinNext) space(-1, 0, 0);
  });

  if (text.endsWith(' ')) {
    text = text.slice(0, -1);
    const last = segments[segments.length - 1];
    if (last && last.end === text.length + 1) segments.pop();
  }

  const byItem = new Map<number, TextSegment[]>();
  for (const s of segments) {
    if (s.item < 0) continue;
    const list = byItem.get(s.item);
    if (list) list.push(s);
    else byItem.set(s.item, [s]);
  }
  return {
    text,
    signature: cyrb53Hex(text),
    segments,
    items: geos,
    order,
    lineEnds,
    itemSegments: byItem,
  };
}

/**
 * Stream offset of the boundary before raw character `raw` of `item`. `bias` says which way a boundary
 * that falls into collapsed whitespace or a dropped hyphen is moved: 'start' forward, 'end' backward,
 * so a selection never grows past what the user covered. Null when the item has no text in the stream.
 */
export function streamOffsetOf(
  pt: PageText,
  item: number,
  raw: number,
  bias: 'start' | 'end',
): number | null {
  const segs = pt.itemSegments.get(item);
  if (!segs || segs.length === 0) return null;
  if (bias === 'start') {
    for (const s of segs) {
      if (raw < s.rawEnd) {
        if (raw <= s.rawStart) return s.start;
        return s.rawEnd - s.rawStart === s.end - s.start ? s.start + (raw - s.rawStart) : s.end;
      }
    }
    return segs[segs.length - 1]!.end;
  }
  for (let k = segs.length - 1; k >= 0; k--) {
    const s = segs[k]!;
    if (raw > s.rawStart) {
      if (raw >= s.rawEnd) return s.end;
      return s.rawEnd - s.rawStart === s.end - s.start ? s.start + (raw - s.rawStart) : s.start;
    }
  }
  return segs[0]!.start;
}

/**
 * Rectangles (raw frame) covering stream range [start, end), one per visual line. Partial items are
 * interpolated along the baseline by character count, so this is exact to within a character or two;
 * the reader prefers the browser's own client rects at capture time and uses this when it has none.
 */
export function rectsForRange(pt: PageText, start: number, end: number): PdfRect[] {
  const out: PdfRect[] = [];
  for (const s of pt.segments) {
    if (s.item < 0 || s.end <= start || s.start >= end) continue;
    const g = pt.items[s.item];
    if (!g || g.length === 0) continue;
    const a = Math.max(start, s.start);
    const b = Math.min(end, s.end);
    const oneToOne = s.rawEnd - s.rawStart === s.end - s.start;
    const rs = oneToOne ? s.rawStart + (a - s.start) : s.rawStart;
    const re = oneToOne ? s.rawStart + (b - s.start) : s.rawEnd;
    const f0 = rs / g.length;
    const f1 = re / g.length;
    const [ox, oy, wx, wy, hx, hy] = g.quad;
    const xs: number[] = [];
    const ys: number[] = [];
    for (const f of [f0, f1]) {
      for (const t of [0, 1]) {
        xs.push(ox + f * wx + t * hx);
        ys.push(oy + f * wy + t * hy);
      }
    }
    out.push(
      clampRect({
        x: Math.min(...xs),
        y: Math.min(...ys),
        w: Math.max(...xs) - Math.min(...xs),
        h: Math.max(...ys) - Math.min(...ys),
      }),
    );
  }
  return mergeLineRects(out);
}
