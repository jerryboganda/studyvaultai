export interface FindMatch {
  /** 1-based page. */
  page: number;
  /** Offsets in that page's text stream. */
  start: number;
  end: number;
}

const MAX_QUERY = 200;
export const MAX_MATCHES = 2000;

/** Case-insensitive; any whitespace in the query matches any whitespace run (the stream is collapsed). */
export function queryRegExp(query: string): RegExp | null {
  const q = query.trim().slice(0, MAX_QUERY);
  if (q === '') return null;
  const body = q
    .split(/\s+/)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s+');
  return new RegExp(body, 'giu');
}

export interface FindOptions {
  query: string;
  pageCount: number;
  getText(page: number): Promise<string>;
  signal?: AbortSignal;
  onProgress?(pagesDone: number, pageCount: number): void;
  /** Called with each page's matches as soon as that page has been searched. */
  onMatches?(batch: FindMatch[]): void;
  maxMatches?: number;
}

export interface FindResult {
  matches: FindMatch[];
  /** More matches exist than were collected. */
  truncated: boolean;
  cancelled: boolean;
}

/** Search every page's text stream in order; cancellable and incremental. */
export async function findInDocument(opts: FindOptions): Promise<FindResult> {
  const re = queryRegExp(opts.query);
  const max = opts.maxMatches ?? MAX_MATCHES;
  const matches: FindMatch[] = [];
  if (!re) return { matches, truncated: false, cancelled: false };
  for (let page = 1; page <= opts.pageCount; page++) {
    if (opts.signal?.aborted) return { matches, truncated: false, cancelled: true };
    let text: string;
    try {
      text = await opts.getText(page);
    } catch {
      continue; // a page that cannot be read has no matches; the rest are still searched
    }
    const batch: FindMatch[] = [];
    for (const m of text.matchAll(re)) {
      if (m[0].length === 0) continue;
      if (matches.length + batch.length >= max) {
        matches.push(...batch);
        opts.onMatches?.(batch);
        return { matches, truncated: true, cancelled: false };
      }
      batch.push({ page, start: m.index, end: m.index + m[0].length });
    }
    matches.push(...batch);
    if (batch.length > 0) opts.onMatches?.(batch);
    opts.onProgress?.(page, opts.pageCount);
  }
  return { matches, truncated: false, cancelled: false };
}
