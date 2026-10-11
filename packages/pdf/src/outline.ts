/**
 * Document outline (bookmarks). Pure: pdf.js's raw outline is turned into a flat, depth-annotated
 * list through an injected destination resolver, so this runs and is tested without a worker.
 * The reader uses it for navigation and as the `headingContext` of highlights (nearest heading above
 * the selection).
 */

export interface OutlineEntry {
  /** Cleaned, bounded title (display text; rendered as a text node only). */
  title: string;
  /** 1-based page the entry points to; null when its destination could not be resolved. */
  pageNumber: number | null;
  /** Destination y in PDF user space (origin bottom-left) when the destination names one. */
  top: number | null;
  /** 0 for top-level entries. */
  depth: number;
}

/** The slice of pdf.js's `getOutline()` result that is read. */
export interface RawOutlineItem {
  title?: unknown;
  dest?: unknown;
  items?: unknown;
}

export interface ResolvedDest {
  pageNumber: number | null;
  top: number | null;
}

export const MAX_OUTLINE_ENTRIES = 2000;
export const MAX_OUTLINE_DEPTH = 8;
export const MAX_OUTLINE_TITLE = 300;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F]/g;
const cleanTitle = (t: unknown): string =>
  (typeof t === 'string' ? t : '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();

/** Pre-order flattening with bounded size and depth; entries without a title are skipped. */
export async function buildOutline(
  raw: readonly RawOutlineItem[] | null | undefined,
  resolve: (dest: unknown) => Promise<ResolvedDest>,
): Promise<OutlineEntry[]> {
  const out: OutlineEntry[] = [];
  const walk = async (items: readonly RawOutlineItem[], depth: number): Promise<void> => {
    for (const item of items) {
      if (out.length >= MAX_OUTLINE_ENTRIES) return;
      const title = cleanTitle(item?.title).slice(0, MAX_OUTLINE_TITLE);
      if (title !== '') {
        let dest: ResolvedDest = { pageNumber: null, top: null };
        try {
          dest = await resolve(item.dest);
        } catch {
          /* a broken destination keeps the title, without a page */
        }
        out.push({ title, pageNumber: dest.pageNumber, top: dest.top, depth });
      }
      const kids = Array.isArray(item?.items) ? (item.items as RawOutlineItem[]) : [];
      if (kids.length > 0 && depth + 1 < MAX_OUTLINE_DEPTH) await walk(kids, depth + 1);
    }
  };
  if (Array.isArray(raw)) await walk(raw, 0);
  return out;
}

/** y of a destination as a fraction of the page from its top edge, given the page's `view` box. */
function normalisedTop(e: OutlineEntry, view: readonly number[] | null): number {
  if (e.top === null || !view) return 0;
  const [, y0 = 0, , y1 = 792] = view;
  const h = y1 - y0;
  return h > 0 ? Math.min(1, Math.max(0, (y1 - e.top) / h)) : 0;
}

/**
 * The heading a passage sits under: the nearest outline entry at or above it in reading order.
 * `y` is the passage's top as a fraction of the page height from the top (null: unknown, then the last
 * heading that starts on the page counts). Entries without a page are ignored. Null when there is none.
 */
export function headingFor(
  entries: readonly OutlineEntry[],
  pageNumber: number,
  y: number | null,
  view: readonly number[] | null,
): string | null {
  const reachable = entries.filter((e) => e.pageNumber !== null && e.pageNumber <= pageNumber);
  if (reachable.length === 0) return null;
  const onPage = reachable.filter((e) => e.pageNumber === pageNumber);
  if (onPage.length > 0) {
    const above = y === null ? onPage : onPage.filter((e) => normalisedTop(e, view) <= y + 0.005);
    if (above.length > 0) {
      let best = above[0]!;
      for (const e of above) {
        if (normalisedTop(e, view) >= normalisedTop(best, view)) best = e;
      }
      return best.title;
    }
  }
  const earlier = reachable.filter((e) => e.pageNumber! < pageNumber);
  if (earlier.length === 0) return null;
  const lastPage = Math.max(...earlier.map((e) => e.pageNumber!));
  const there = earlier.filter((e) => e.pageNumber === lastPage);
  return there[there.length - 1]!.title;
}
