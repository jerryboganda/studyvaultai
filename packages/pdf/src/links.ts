import type { PdfRect } from '@shared';
import { boundsOf, rotateRect } from './geometry';
import type { ResolvedDest } from './outline';

/**
 * Link annotations of a page (ADR-006, Amendment 3). Pure: pdf.js's raw annotations are turned into
 * `PageLink`s through an injected destination resolver, so this runs and is tested without a worker.
 *
 * What is read: annotations whose subtype is `Link`, and only the fields pdf.js has already reduced to
 * a destination (`dest`), an address (`url` / `unsafeUrl`) or a named action (`action`). Everything
 * is untrusted input: an address is only ever opened if `vetExternalUrl` says so, and the reader
 * asks the person first.
 */

/** Most links read from one page; the rest are counted, not shown. */
export const MAX_LINKS_PER_PAGE = 500;
/** Longest address that is shown and opened. */
export const MAX_LINK_URL_LENGTH = 2048;
/** A page with more links than this does not put each one in the tab order (see linkLayer.ts). */
export const DENSE_PAGE_LINKS = 40;
/** Positions the Back control remembers. */
export const MAX_BACK_ENTRIES = 50;

/** The slice of a pdf.js annotation that is read (all unknown: the data comes from the file). */
export interface RawAnnotation {
  subtype?: unknown;
  rect?: unknown;
  quadPoints?: unknown;
  url?: unknown;
  unsafeUrl?: unknown;
  dest?: unknown;
  action?: unknown;
  newWindow?: unknown;
  attachment?: unknown;
  setOCGState?: unknown;
  resetForm?: unknown;
}

export type LinkTarget =
  /** A place in this document. `left`/`top` are PDF user-space coordinates when the destination names them. */
  | { kind: 'page'; pageNumber: number; left: number | null; top: number | null }
  /** An address that passed `vetExternalUrl`: opened only after the person confirms. */
  | { kind: 'external'; url: string; host: string; origin: string }
  /** Something the reader will not do; `reason` is the sentence shown to the person. */
  | { kind: 'refused'; reason: string };

export interface PageLink {
  /** Rectangles in the raw page frame (0..1 of the page box, top-left origin); one per line of a wrapped link. */
  rects: PdfRect[];
  target: LinkTarget;
  /** Accessible name, e.g. "Link to page 12" or "External link to example.org". */
  label: string;
}

export interface PageLinks {
  links: PageLink[];
  /** Links beyond MAX_LINKS_PER_PAGE (not listed, not clickable). */
  omitted: number;
}

export const NO_LINKS: PageLinks = { links: [], omitted: 0 };

// ---------------------------------------------------------------------------------------------
// Address policy
// ---------------------------------------------------------------------------------------------

export type UrlVerdict =
  | { ok: true; url: string; host: string; origin: string }
  | { ok: false; reason: string; scheme: string | null };

const schemeRefusal = (scheme: string): string =>
  `This link points to a "${scheme}:" address. StudyVault opens only web addresses (http or https), and only after you confirm.`;

/**
 * Whether an address from a PDF may be offered for opening: an absolute http or https address without
 * a user name or password, at most MAX_LINK_URL_LENGTH characters. The scheme is read from the PARSED
 * address (never from the raw text), so `JaVaScRiPt:`, a leading space or a hidden newline cannot slip
 * through. `javascript:`, `data:`, `file:`, `blob:`, `chrome:`, `chrome-extension:`, `ftp:`, `mailto:`
 * and every other scheme are refused; so is anything that is not a full address.
 */
export function vetExternalUrl(raw: string): UrlVerdict {
  if (raw.length > MAX_LINK_URL_LENGTH) {
    return {
      ok: false,
      scheme: null,
      reason: `This link's address is longer than ${MAX_LINK_URL_LENGTH.toLocaleString('en-US')} characters, so it was not opened.`,
    };
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return {
      ok: false,
      scheme: null,
      reason: 'This link is not a full web address, so there is nothing to open.',
    };
  }
  const scheme = u.protocol.slice(0, -1);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, scheme, reason: schemeRefusal(scheme) };
  }
  if (u.username !== '' || u.password !== '') {
    return {
      ok: false,
      scheme,
      reason: "This link's address contains a user name or password, so it was not opened.",
    };
  }
  if (u.hostname === '') {
    return {
      ok: false,
      scheme,
      reason: "This link's address has no site name, so it was not opened.",
    };
  }
  // `host` is the ASCII form (an internationalised name shows as xn--...), which is what is contacted.
  return { ok: true, url: u.href, host: u.host, origin: u.origin };
}

// ---------------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------------

const unit = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * A rectangle in PDF user space (`[x1, y1, x2, y2]`, origin bottom-left) -> the raw page frame the
 * highlight overlay uses (0..1 of `view`, origin top-left, no /Rotate applied), cut to the page. Null
 * when it is not a finite rectangle or has no area on the page. Display then applies
 * `rotateRect(frame, viewportRotation)`, which is the same frame and rotation pdf.js's viewport uses.
 */
export function userRectToFrame(rect: ArrayLike<number>, view: readonly number[]): PdfRect | null {
  const vx0 = Math.min(view[0] ?? 0, view[2] ?? 612);
  const vx1 = Math.max(view[0] ?? 0, view[2] ?? 612);
  const vy0 = Math.min(view[1] ?? 0, view[3] ?? 792);
  const vy1 = Math.max(view[1] ?? 0, view[3] ?? 792);
  const w = vx1 - vx0;
  const h = vy1 - vy0;
  const [a, b, c, d] = [rect[0], rect[1], rect[2], rect[3]];
  if (!(w > 0) || !(h > 0)) return null;
  if (![a, b, c, d].every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  const x0 = unit((Math.min(a!, c!) - vx0) / w);
  const x1 = unit((Math.max(a!, c!) - vx0) / w);
  const y0 = unit((vy1 - Math.max(b!, d!)) / h);
  const y1 = unit((vy1 - Math.min(b!, d!)) / h);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/** The raw-frame point (0..1, top-left origin) a destination names; the page's top-left when it names none. */
export function destinationPoint(
  view: readonly number[],
  left: number | null,
  top: number | null,
): { x: number; y: number } {
  const vx0 = Math.min(view[0] ?? 0, view[2] ?? 612);
  const vx1 = Math.max(view[0] ?? 0, view[2] ?? 612);
  const vy0 = Math.min(view[1] ?? 0, view[3] ?? 792);
  const vy1 = Math.max(view[1] ?? 0, view[3] ?? 792);
  const x = left !== null && vx1 > vx0 ? unit((left - vx0) / (vx1 - vx0)) : 0;
  const y = top !== null && vy1 > vy0 ? unit((vy1 - top) / (vy1 - vy0)) : 0;
  return { x, y };
}

/** Rectangles of one link: one per quadrilateral when it has QuadPoints, else its bounding rectangle. */
function framesOf(a: RawAnnotation, view: readonly number[]): PdfRect[] {
  const q = a.quadPoints;
  if (q && typeof q === 'object' && 'length' in q) {
    const pts = q as ArrayLike<number>;
    const out: PdfRect[] = [];
    // pdf.js stores each quad as [minX, maxY, maxX, maxY, minX, minY, maxX, minY].
    for (let i = 0; i + 8 <= pts.length && out.length < 16; i += 8) {
      const r = userRectToFrame([pts[i]!, pts[i + 5]!, pts[i + 2]!, pts[i + 1]!], view);
      if (r) out.push(r);
    }
    if (out.length > 0) return out;
  }
  const rect = a.rect;
  if (rect && typeof rect === 'object' && 'length' in rect) {
    const r = userRectToFrame(rect as ArrayLike<number>, view);
    if (r) return [r];
  }
  return [];
}

/**
 * Reading order of items that have a box: top to bottom, and left to right within a line (boxes that
 * share half their height are one line). Geometric: it is not column-aware.
 */
export function orderByLines<T>(items: readonly T[], box: (item: T) => PdfRect): T[] {
  const boxed = items
    .map((item) => ({ item, b: box(item) }))
    .sort((p, q) => p.b.y + p.b.h / 2 - (q.b.y + q.b.h / 2));
  const lines: Array<typeof boxed> = [];
  for (const e of boxed) {
    const line = lines[lines.length - 1];
    const head = line?.[0];
    if (line && head) {
      const overlap = Math.min(head.b.y + head.b.h, e.b.y + e.b.h) - Math.max(head.b.y, e.b.y);
      if (overlap >= 0.5 * Math.min(head.b.h, e.b.h)) {
        line.push(e);
        continue;
      }
    }
    lines.push([e]);
  }
  return lines.flatMap((line) => line.sort((p, q) => p.b.x - q.b.x).map((e) => e.item));
}

/** Index of the last box (topmost) that holds the point `(fx, fy)` (fractions of the page), or -1. */
export function hitTest(boxes: ReadonlyArray<readonly PdfRect[]>, fx: number, fy: number): number {
  for (let i = boxes.length - 1; i >= 0; i--) {
    for (const r of boxes[i]!) {
      if (fx >= r.x && fx <= r.x + r.w && fy >= r.y && fy <= r.y + r.h) return i;
    }
  }
  return -1;
}

/** Links in the order a person reads them on the page as displayed at `rotation`. */
export function sortLinks(links: readonly PageLink[], rotation: number): PageLink[] {
  return orderByLines(links, (l) => rotateRect(boundsOf(l.rects), rotation));
}

// ---------------------------------------------------------------------------------------------
// Annotations -> links
// ---------------------------------------------------------------------------------------------

const REFUSED = {
  action:
    'This link runs a PDF action (open another file or run a script). StudyVault does not run PDF actions.',
  attachment: 'This link opens a file attached to the PDF. StudyVault does not open attachments.',
  form: 'This link is a form or layer action. StudyVault does not run those.',
  missing: 'This link points to a place that is not in this PDF.',
} as const;

const refuse = (reason: string): LinkTarget => ({ kind: 'refused', reason });

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F]/g;
const namedAction = (name: string): string => name.replace(CONTROL, ' ').slice(0, 30);

export interface LinkContext {
  /** The page's own box and /Rotate. */
  view: readonly number[];
  rotate: number;
  pageNumber: number;
  pageCount: number;
  /** Destination (name or explicit array) -> page; anything unresolvable has no page. */
  resolve(dest: unknown): Promise<ResolvedDest>;
}

async function classify(a: RawAnnotation, ctx: LinkContext): Promise<LinkTarget | null> {
  // pdf.js sets `newWindow` only for Launch, GoToR and a JavaScript action it could read an address
  // from; none of them is a plain link, so none is followed.
  if (typeof a.newWindow === 'boolean') return refuse(REFUSED.action);
  if (a.attachment !== undefined && a.attachment !== null) return refuse(REFUSED.attachment);
  if (a.setOCGState || a.resetForm) return refuse(REFUSED.form);

  const address =
    typeof a.url === 'string' ? a.url : typeof a.unsafeUrl === 'string' ? a.unsafeUrl : null;
  if (address !== null) {
    const v = vetExternalUrl(address);
    return v.ok
      ? { kind: 'external', url: v.url, host: v.host, origin: v.origin }
      : refuse(v.reason);
  }
  if (typeof a.action === 'string') {
    const here = ctx.pageNumber;
    const page =
      a.action === 'NextPage'
        ? Math.min(ctx.pageCount, here + 1)
        : a.action === 'PrevPage'
          ? Math.max(1, here - 1)
          : a.action === 'FirstPage'
            ? 1
            : a.action === 'LastPage'
              ? ctx.pageCount
              : null;
    if (page === null) {
      return refuse(
        `This link runs the PDF action "${namedAction(a.action)}", which StudyVault does not run.`,
      );
    }
    return { kind: 'page', pageNumber: page, left: null, top: null };
  }
  if (a.dest !== undefined && a.dest !== null) {
    let at: ResolvedDest = { pageNumber: null, top: null };
    try {
      at = await ctx.resolve(a.dest);
    } catch {
      /* a destination that cannot be read is a destination that is not there */
    }
    if (at.pageNumber === null) return refuse(REFUSED.missing);
    return { kind: 'page', pageNumber: at.pageNumber, left: at.left ?? null, top: at.top };
  }
  // No destination pdf.js understands (a script, a submit-form action, a decorative box): nothing to follow.
  return null;
}

const labelOf = (t: LinkTarget): string =>
  t.kind === 'page'
    ? `Link to page ${t.pageNumber}`
    : t.kind === 'external'
      ? `External link to ${t.host}`
      : 'Link that StudyVault will not open';

/** Link annotations of one page as `PageLink`s, in the reading order of the page as it is by default. */
export async function buildPageLinks(
  raw: readonly RawAnnotation[] | null | undefined,
  ctx: LinkContext,
): Promise<PageLinks> {
  const found: Array<{ rects: PdfRect[]; annotation: RawAnnotation }> = [];
  let omitted = 0;
  for (const a of Array.isArray(raw) ? (raw as RawAnnotation[]) : []) {
    if (a?.subtype !== 'Link') continue;
    const rects = framesOf(a, ctx.view);
    if (rects.length === 0) continue;
    if (found.length >= MAX_LINKS_PER_PAGE) omitted += 1;
    else found.push({ rects, annotation: a });
  }
  const links: PageLink[] = [];
  const targets = await Promise.all(
    found.map((f) => classify(f.annotation, ctx).catch(() => null)),
  );
  found.forEach((f, i) => {
    const target = targets[i];
    if (target) links.push({ rects: f.rects, target, label: labelOf(target) });
  });
  return { links: sortLinks(links, ctx.rotate), omitted };
}

// ---------------------------------------------------------------------------------------------
// Back stack
// ---------------------------------------------------------------------------------------------

/**
 * Where the reader was: a page and how far the top edge of the view was into it, as a fraction of the
 * page's height (negative: above the page's top edge, in the gap after the page before it).
 */
export interface ViewPosition {
  page: number;
  frac: number;
}

/** `from` goes on top; the oldest entries fall off; the place that is already on top is not stacked twice. */
export function pushBack(stack: readonly ViewPosition[], from: ViewPosition): ViewPosition[] {
  const top = stack[stack.length - 1];
  if (top && top.page === from.page && Math.abs(top.frac - from.frac) < 0.01) return stack.slice();
  return [...stack, from].slice(-MAX_BACK_ENTRIES);
}

export function popBack(stack: readonly ViewPosition[]): {
  to: ViewPosition | null;
  stack: ViewPosition[];
} {
  const to = stack[stack.length - 1] ?? null;
  return { to, stack: stack.slice(0, -1) };
}
