import type { HighlightKind, ResolveStatus } from '@shared';
import type { HighlightQuery, HighlightSortField } from '@storage';
import type { SortMode } from '@search';

/** Filter state of the dashboard and how it maps onto the two query engines (pure, unit-tested). */

export type DateField = 'capturedAt' | 'updatedAt';

export interface Filters {
  tagIds: string[];
  tagMode: 'any' | 'all';
  kinds: HighlightKind[];
  priorities: number[];
  statuses: ResolveStatus[];
  /** One source (page or PDF) the highlights must come from. */
  source: { id: string; label: string } | null;
  /** true: has a note, false: has none, null: either. */
  hasNote: boolean | null;
  dateField: DateField;
  /** Local calendar days, "YYYY-MM-DD" or "". Both ends are inclusive. */
  dateFrom: string;
  dateTo: string;
}

export const EMPTY_FILTERS: Filters = {
  tagIds: [],
  tagMode: 'any',
  kinds: [],
  priorities: [],
  statuses: [],
  source: null,
  hasNote: null,
  dateField: 'capturedAt',
  dateFrom: '',
  dateTo: '',
};

/** Where in the tree the list is looking. A folder lists its whole subtree. */
export interface Scope {
  bankId: string | null;
  folderId: string | null;
}
export const ALL_SCOPE: Scope = { bankId: null, folderId: null };

export type SortKey =
  | 'relevance'
  | 'captured-desc'
  | 'captured-asc'
  | 'updated-desc'
  | 'priority-desc'
  | 'priority-asc';

export const BROWSE_SORTS: readonly SortKey[] = [
  'captured-desc',
  'captured-asc',
  'updated-desc',
  'priority-desc',
  'priority-asc',
];
export const SEARCH_SORTS: readonly SortKey[] = ['relevance', 'updated-desc', 'priority-desc'];

export const SORT_LABELS: Record<SortKey, string> = {
  relevance: 'Best match',
  'captured-desc': 'Newest captured',
  'captured-asc': 'Oldest captured',
  'updated-desc': 'Recently updated',
  'priority-desc': 'Priority, high to low',
  'priority-asc': 'Priority, low to high',
};

/** A sort the current mode cannot do falls back to the mode's default instead of failing. */
export function normalizeSort(sort: SortKey, searching: boolean): SortKey {
  if (searching) return SEARCH_SORTS.includes(sort) ? sort : 'relevance';
  return BROWSE_SORTS.includes(sort) ? sort : 'captured-desc';
}

export function browseSort(sort: SortKey): { by: HighlightSortField; dir: 'asc' | 'desc' } {
  switch (sort) {
    case 'captured-asc':
      return { by: 'capturedAt', dir: 'asc' };
    case 'updated-desc':
      return { by: 'updatedAt', dir: 'desc' };
    case 'priority-desc':
      return { by: 'priority', dir: 'desc' };
    case 'priority-asc':
      return { by: 'priority', dir: 'asc' };
    default:
      return { by: 'capturedAt', dir: 'desc' };
  }
}

export function searchSort(sort: SortKey): SortMode {
  if (sort === 'updated-desc') return 'updated';
  if (sort === 'priority-desc') return 'priority';
  return 'relevance';
}

export function filterCount(f: Filters): number {
  return (
    (f.tagIds.length > 0 ? 1 : 0) +
    (f.kinds.length > 0 ? 1 : 0) +
    (f.priorities.length > 0 ? 1 : 0) +
    (f.statuses.length > 0 ? 1 : 0) +
    (f.source ? 1 : 0) +
    (f.hasNote !== null ? 1 : 0) +
    (f.dateFrom !== '' || f.dateTo !== '' ? 1 : 0)
  );
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "YYYY-MM-DD" as a local date, or null when it is not a real calendar day. */
function parseDay(value: string): { y: number; m: number; d: number } | null {
  const match = DAY.exec(value);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const probe = new Date(y, m - 1, d);
  return probe.getFullYear() === y && probe.getMonth() === m - 1 && probe.getDate() === d
    ? { y, m, d }
    : null;
}

/**
 * The instants a pair of local days stands for: from = the first millisecond of `dateFrom`, to = the
 * last millisecond of `dateTo`, in the user's time zone. Reversed days are swapped; an unparseable
 * day is ignored.
 */
export function localDayRange(
  dateFrom: string,
  dateTo: string,
): { from?: string; to?: string } | null {
  let from = parseDay(dateFrom);
  let to = parseDay(dateTo);
  if (from && to && new Date(from.y, from.m - 1, from.d) > new Date(to.y, to.m - 1, to.d)) {
    [from, to] = [to, from];
  }
  const range: { from?: string; to?: string } = {};
  if (from) range.from = new Date(from.y, from.m - 1, from.d, 0, 0, 0, 0).toISOString();
  if (to) range.to = new Date(to.y, to.m - 1, to.d, 23, 59, 59, 999).toISOString();
  return range.from || range.to ? range : null;
}

export interface BrowseQueryInput {
  scope: Scope;
  filters: Filters;
  sort: SortKey;
  cursor?: string | null;
  limit?: number;
}

/** Scope + filters + sort as the vault's `listHighlights` / `countHighlights` query. */
export function toHighlightQuery(input: BrowseQueryInput): HighlightQuery {
  const { scope, filters: f } = input;
  const query: HighlightQuery = {};
  if (scope.folderId) query.folderId = scope.folderId;
  else if (scope.bankId) query.bankId = scope.bankId;
  if (f.tagIds.length > 0) {
    query.tagIds = [...f.tagIds];
    query.tagMode = f.tagMode;
  }
  if (f.kinds.length > 0) query.kinds = [...f.kinds];
  if (f.priorities.length > 0) query.priorities = [...f.priorities];
  if (f.statuses.length > 0) query.resolveStatuses = [...f.statuses];
  if (f.source) query.sourceId = f.source.id;
  if (f.hasNote !== null) query.hasNote = f.hasNote;
  const range = localDayRange(f.dateFrom, f.dateTo);
  if (range) query.dateRange = { field: f.dateField, ...range };
  query.sort = browseSort(input.sort);
  if (input.cursor) query.cursor = input.cursor;
  if (input.limit !== undefined) query.limit = input.limit;
  return query;
}

/** The query without paging and sorting, as `countHighlights` takes it. */
export function toCountQuery(
  scope: Scope,
  filters: Filters,
): Omit<HighlightQuery, 'cursor' | 'limit' | 'sort'> {
  const {
    sort: _sort,
    cursor: _cursor,
    limit: _limit,
    ...rest
  } = toHighlightQuery({
    scope,
    filters,
    sort: 'captured-desc',
  });
  return rest;
}

// ---------------------------------------------------------------------------------------------
// Search grammar
// ---------------------------------------------------------------------------------------------

/** Filters the search grammar cannot express; they are applied through an id set instead. */
export function needsIdSet(f: Filters): boolean {
  return f.source !== null || localDayRange(f.dateFrom, f.dateTo) !== null;
}

const quoted = (value: string): string => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export type FacetKey = 'bank' | 'tag' | 'kind' | 'host' | 'status';

/** `bank:"Cardiology"` */
export function facetToken(key: FacetKey, value: string): string {
  return `${key}:${quoted(value)}`;
}

export function hasFacetToken(query: string, key: FacetKey, value: string): boolean {
  return query.includes(facetToken(key, value));
}

/** A top-level OR binds loosest: anything appended to it must see the whole query grouped. */
const hasOr = (query: string): boolean => /(^|\s)OR(\s|$)/.test(query);

function stripOuterParens(query: string): string {
  const q = query.trim();
  if (!q.startsWith('(') || !q.endsWith(')')) return q;
  let depth = 0;
  for (let i = 0; i < q.length; i++) {
    if (q[i] === '(') depth++;
    else if (q[i] === ')') depth--;
    if (depth === 0 && i < q.length - 1) return q; // the first paren closes early: not one group
  }
  return q.slice(1, -1).trim();
}

/** The whole query is one parenthesised group, so appending to it needs no extra grouping. */
const isGroup = (q: string): boolean => stripOuterParens(q) !== q.trim();

/** Add the token when it is absent, remove it (with its separating space) when present. */
export function toggleFacetToken(query: string, key: FacetKey, value: string): string {
  const token = facetToken(key, value);
  if (query.includes(token)) {
    const rest = query
      .replace(token, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    return stripOuterParens(rest);
  }
  const base = query.trim();
  if (base === '') return token;
  return `${hasOr(base) && !isGroup(base) ? `(${base})` : base} ${token}`;
}

export interface SearchNames {
  bank: string | null;
  folder: string | null;
  /** Tag names in the same order as `filters.tagIds`. */
  tags: string[];
}

const anyOf = (tokens: string[]): string =>
  tokens.length === 1 ? tokens[0]! : `(${tokens.join(' OR ')})`;

/**
 * The text query with scope and structured filters appended in the documented grammar. Source and
 * date range are not in the grammar (`needsIdSet`); everything else is.
 */
export function toSearchQuery(
  text: string,
  scope: Scope,
  filters: Filters,
  names: SearchNames,
): string {
  const parts: string[] = [];
  const typed = text.trim();
  if (typed !== '') parts.push(typed);
  if (scope.bankId && names.bank) parts.push(`bank:${quoted(names.bank)}`);
  if (scope.folderId && names.folder) parts.push(`folder:${quoted(names.folder)}`);
  const tags = filters.tagIds.length > 0 ? names.tags.filter((n) => n !== '') : [];
  if (tags.length > 0) {
    const tokens = tags.map((n) => `tag:${quoted(n)}`);
    if (filters.tagMode === 'all') parts.push(...tokens);
    else parts.push(anyOf(tokens));
  }
  if (filters.kinds.length > 0) parts.push(anyOf(filters.kinds.map((k) => `kind:${k}`)));
  if (filters.priorities.length > 0) {
    parts.push(anyOf(filters.priorities.map((p) => `priority:=${p}`)));
  }
  if (filters.statuses.length > 0) parts.push(anyOf(filters.statuses.map((s) => `status:${s}`)));
  if (filters.hasNote === true) parts.push('has:note');
  if (filters.hasNote === false) parts.push('-has:note');
  // The user's own OR must not swallow the appended filters (OR binds loosest).
  if (typed !== '' && parts.length > 1 && hasOr(typed) && !isGroup(typed)) {
    parts[0] = `(${typed})`;
  }
  return parts.join(' ');
}
