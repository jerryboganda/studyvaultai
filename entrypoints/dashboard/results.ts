import type { ColorId, HighlightKind, ResolveStatus } from '@shared';
import { DEFAULT_PALETTE } from '@shared';
import type { DashboardItem } from '@storage';
import type {
  Facets,
  DidYouMean,
  QueryWarning,
  SearchField,
  SearchHit,
  SearchOptions,
  SearchResult,
  Segment,
} from '@search';
import type { DashboardApi } from './api';
import { toCountQuery, toHighlightQuery, type Filters, type Scope, type SortKey } from './filters';

/** What the centre list shows, whichever engine produced it (pure except for the api calls). */

export const PAGE_SIZE = 100;
/** Most rows an id-set or select-all-filtered resolution will walk before it reports "capped". */
export const ID_RESOLVE_CAP = 20_000;
const BROWSE_PAGE_MAX = 500;
const SEARCH_PAGE_MAX = 500;
const QUOTE_PREVIEW_CHARS = 400;

export interface ResultRow {
  /** Unique within a result: the highlight id (or the note id of a note hit). */
  key: string;
  /** The highlight this row stands for; null for a note that is attached to nothing. */
  highlightId: string | null;
  docType: 'highlight' | 'note';
  /** Quote as segments (search: matched words flagged; browse: one plain segment). */
  segments: Segment[];
  /** A second matching field (your comment, a note, a tag...) shown under the quote. */
  matchNote: { field: SearchField; segments: Segment[] } | null;
  title: string;
  host: string;
  kind: HighlightKind | null;
  color: ColorId | null;
  priority: number | null;
  resolveStatus: ResolveStatus | null;
  tags: string[];
  banks: string[];
  hasNote: boolean;
  updatedAt: string;
  /** Browse only. */
  sourceType: 'web' | 'pdf' | null;
  pageNumber: number | null;
}

export type PageCursor = { kind: 'browse'; cursor: string } | { kind: 'search'; offset: number };

export interface SearchExtras {
  facets: Facets | null;
  didYouMean: DidYouMean | null;
  warnings: QueryWarning[];
  took: number;
}

export interface Page {
  rows: ResultRow[];
  /** Matches across all pages. */
  total: number;
  next: PageCursor | null;
  extras: SearchExtras | null;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

export function rowFromItem(item: DashboardItem): ResultRow {
  const { highlight, source } = item;
  return {
    key: highlight.id,
    highlightId: highlight.id,
    docType: 'highlight',
    segments: [{ text: clip(highlight.exactQuote, QUOTE_PREVIEW_CHARS), match: false }],
    matchNote: null,
    title: source.title,
    host: source.host,
    kind: highlight.kind,
    color: highlight.color,
    priority: highlight.priority,
    resolveStatus: highlight.resolveStatus,
    tags: item.tags.map((t) => t.name),
    banks: item.banks.map((b) => b.name),
    hasNote: item.noteCount > 0 || highlight.userComment.trim() !== '',
    updatedAt: item.updatedAt,
    sourceType: source.type ?? 'web',
    pageNumber: highlight.anchorSet.type === 'pdf' ? highlight.anchorSet.pageNumber : null,
  };
}

const KINDS = new Set<string>(Object.keys(DEFAULT_PALETTE));
const STATUSES = new Set<string>(['unchecked', 'resolved', 'changed', 'ambiguous', 'orphaned']);

export function rowFromHit(hit: SearchHit): ResultRow {
  const doc = hit.doc;
  const quote = hit.highlights.find((h) => h.field === 'quote');
  const other = hit.highlights.find((h) => h.field !== 'quote' && h.segments.some((s) => s.match));
  const kind = KINDS.has(doc.kind) ? (doc.kind as HighlightKind) : null;
  return {
    key: doc.id,
    highlightId: doc.highlightId ?? (doc.docType === 'highlight' ? doc.id : null),
    docType: doc.docType,
    segments: quote?.segments ?? [{ text: clip(doc.quote, QUOTE_PREVIEW_CHARS), match: false }],
    matchNote: other ? { field: other.field, segments: other.segments } : null,
    title: doc.title,
    host: doc.host ?? '',
    kind,
    color: kind ? DEFAULT_PALETTE[kind] : null,
    priority: kind ? doc.priority : null,
    resolveStatus: STATUSES.has(doc.resolveStatus) ? (doc.resolveStatus as ResolveStatus) : null,
    tags: [...doc.tags],
    banks: [...doc.banks],
    hasNote: doc.docType === 'note' || doc.comment.trim() !== '',
    updatedAt: doc.updatedAt,
    sourceType: null,
    pageNumber: null,
  };
}

/**
 * One row per highlight. The engine already folds a highlight's note hits into one (`collapseNotes`);
 * this guards the seams it cannot see: a cursor page that overlaps the previous one, or an index that
 * changed between two pages. The first row of a highlight wins.
 */
export function dedupeRows(rows: readonly ResultRow[], seen: Set<string>): ResultRow[] {
  const out: ResultRow[] = [];
  for (const row of rows) {
    const id = row.highlightId ?? row.key;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(row);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------------------------

export interface BrowseInput {
  scope: Scope;
  filters: Filters;
  sort: SortKey;
  cursor?: string | null;
  /** Ask for the match count too (first page only). */
  withTotal: boolean;
  limit?: number;
}

export async function fetchBrowsePage(api: DashboardApi, input: BrowseInput): Promise<Page> {
  const limit = Math.min(input.limit ?? PAGE_SIZE, BROWSE_PAGE_MAX);
  const [page, total] = await Promise.all([
    api.listHighlights(
      toHighlightQuery({
        scope: input.scope,
        filters: input.filters,
        sort: input.sort,
        cursor: input.cursor ?? null,
        limit,
      }),
    ),
    input.withTotal
      ? api.countHighlights(toCountQuery(input.scope, input.filters))
      : Promise.resolve(-1),
  ]);
  return {
    rows: page.items.map(rowFromItem),
    total,
    next: page.nextCursor ? { kind: 'browse', cursor: page.nextCursor } : null,
    extras: null,
  };
}

export interface SearchLike {
  search(query: string, options?: SearchOptions): SearchResult;
}

export interface SearchInput {
  query: string;
  sort: SearchOptions['sort'];
  offset: number;
  limit?: number;
  /** Highlight ids the hits must belong to (source / date filters). Null: no restriction. */
  idSet: ReadonlySet<string> | null;
}

function extrasOf(r: SearchResult): SearchExtras {
  return { facets: r.facets, didYouMean: r.didYouMean, warnings: r.warnings, took: r.took };
}

export function fetchSearchPage(index: SearchLike, input: SearchInput): Page {
  const limit = Math.min(input.limit ?? PAGE_SIZE, SEARCH_PAGE_MAX);
  if (input.idSet === null) {
    const result = index.search(input.query, {
      sort: input.sort,
      limit,
      offset: input.offset,
      collapseNotes: true,
      facets: input.offset === 0,
      suggest: input.offset === 0,
    });
    const end = input.offset + result.hits.length;
    return {
      rows: result.hits.map(rowFromHit),
      total: result.total,
      next: end < result.total && result.hits.length > 0 ? { kind: 'search', offset: end } : null,
      extras: input.offset === 0 ? extrasOf(result) : null,
    };
  }
  // A restriction the index cannot apply: take every hit (bounded), keep those in the id set.
  const rows: ResultRow[] = [];
  let extras: SearchExtras | null = null;
  for (let offset = 0; offset < ID_RESOLVE_CAP;) {
    const result = index.search(input.query, {
      sort: input.sort,
      limit: SEARCH_PAGE_MAX,
      offset,
      collapseNotes: true,
      facets: offset === 0,
      suggest: offset === 0,
    });
    if (offset === 0) extras = extrasOf(result);
    for (const hit of result.hits) {
      const id = hit.doc.highlightId ?? hit.doc.id;
      if (input.idSet.has(id)) rows.push(rowFromHit(hit));
    }
    offset += result.hits.length;
    if (result.hits.length === 0 || offset >= result.total) break;
  }
  return { rows, total: rows.length, next: null, extras };
}

// ---------------------------------------------------------------------------------------------
// Whole-result id resolution (select all filtered, id-set filters)
// ---------------------------------------------------------------------------------------------

export interface ResolvedIds {
  ids: string[];
  /** The walk stopped at ID_RESOLVE_CAP; the list is a prefix of the full result. */
  capped: boolean;
}

export async function collectBrowseIds(
  api: DashboardApi,
  scope: Scope,
  filters: Filters,
  sort: SortKey = 'captured-desc',
): Promise<ResolvedIds> {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = await api.listHighlights(
      toHighlightQuery({ scope, filters, sort, cursor, limit: BROWSE_PAGE_MAX }),
    );
    for (const item of page.items) ids.push(item.highlight.id);
    cursor = page.nextCursor;
    if (!cursor) return { ids, capped: false };
    if (ids.length >= ID_RESOLVE_CAP) return { ids, capped: true };
  }
}

export function collectSearchIds(
  index: SearchLike,
  query: string,
  idSet: ReadonlySet<string> | null,
): ResolvedIds {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (let offset = 0; ;) {
    const result = index.search(query, {
      limit: SEARCH_PAGE_MAX,
      offset,
      collapseNotes: true,
      facets: false,
      suggest: false,
    });
    for (const hit of result.hits) {
      const id = hit.doc.highlightId;
      if (id === null || seen.has(id)) continue;
      if (idSet !== null && !idSet.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    offset += result.hits.length;
    if (result.hits.length === 0 || offset >= result.total) return { ids, capped: false };
    if (offset >= ID_RESOLVE_CAP) return { ids, capped: true };
  }
}
