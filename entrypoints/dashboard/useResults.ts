import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage, useLatest } from '@ui';
import type { DashboardApi } from './api';
import {
  collectBrowseIds,
  dedupeRows,
  fetchBrowsePage,
  fetchSearchPage,
  PAGE_SIZE,
  type Page,
  type PageCursor,
  type ResultRow,
  type SearchExtras,
  type SearchLike,
} from './results';
import { needsIdSet, searchSort, type Filters, type Scope, type SortKey } from './filters';

export interface ResultsArgs {
  api: DashboardApi;
  /** Search mode when the text box holds a query; browse otherwise. */
  mode: 'browse' | 'search';
  scope: Scope;
  filters: Filters;
  sort: SortKey;
  /** Grammar query (user text + scope + filters); only read in search mode. */
  query: string;
  /** The index to search; null while it is restoring or rebuilding. */
  index: SearchLike | null;
  /** Re-read (keeping what is loaded) whenever one of these changes. */
  refreshOn: readonly (string | number)[];
}

export interface ResultsView {
  rows: ResultRow[];
  /** Matches across all pages; null until known. */
  total: number | null;
  /** First page of the current query is still coming. */
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  loadMore(): void;
  extras: SearchExtras | null;
  /** Search mode but the index is not usable yet. */
  waitingForIndex: boolean;
}

interface State {
  key: string;
  rows: ResultRow[];
  total: number | null;
  next: PageCursor | null;
  extras: SearchExtras | null;
  error: string | null;
  loadingMore: boolean;
}

const MAX_KEEP = 2_000;

export function useResults(args: ResultsArgs): ResultsView {
  const { mode, scope, filters, sort, query, index, refreshOn } = args;
  const searching = mode === 'search';
  /** Search mode, but the index is still restoring or rebuilding: nothing to ask yet. */
  const waiting = searching && index === null;
  // The index only matters to a search. While browsing, its becoming ready must not change the key
  // (that blanked the list and re-read the first page right after the dashboard opened).
  const key = JSON.stringify([
    mode,
    scope,
    filters,
    sort,
    searching ? query : '',
    searching && !waiting,
  ]);
  const refreshKey = JSON.stringify(refreshOn);

  const [state, setState] = useState<State | null>(null);
  const latest = useLatest({ args, state, key });
  const loadedKey = useRef('');
  const loadedCount = useRef(0);

  useEffect(() => {
    if (waiting) return undefined;
    let live = true;
    const a = latest.current.args;
    // The same query refreshed: reload as many rows as are on screen so the list does not jump.
    const keep =
      loadedKey.current === key
        ? Math.min(MAX_KEEP, Math.max(PAGE_SIZE, loadedCount.current))
        : PAGE_SIZE;

    const run = async (): Promise<State> => {
      let idSet: Set<string> | null = null;
      if (a.mode === 'search' && needsIdSet(a.filters)) {
        const resolved = await collectBrowseIds(a.api, a.scope, a.filters);
        idSet = new Set(resolved.ids);
      }
      const seen = new Set<string>();
      const rows: ResultRow[] = [];
      let total: number | null = null;
      let extras: SearchExtras | null = null;
      let next: PageCursor | null = null;
      for (let guard = 0; guard < 50; guard++) {
        let page: Page;
        if (a.mode === 'search') {
          page = fetchSearchPage(a.index!, {
            query: a.query,
            sort: searchSort(a.sort),
            offset: next?.kind === 'search' ? next.offset : 0,
            idSet,
            limit: Math.min(500, keep),
          });
        } else {
          page = await fetchBrowsePage(a.api, {
            scope: a.scope,
            filters: a.filters,
            sort: a.sort,
            cursor: next?.kind === 'browse' ? next.cursor : null,
            withTotal: next === null,
            limit: Math.min(500, keep),
          });
        }
        rows.push(...dedupeRows(page.rows, seen));
        if (next === null) {
          total = page.total >= 0 ? page.total : null;
          extras = page.extras;
        }
        next = page.next;
        if (next === null || rows.length >= keep) break;
      }
      return { key, rows, total, next, extras, error: null, loadingMore: false };
    };

    run().then(
      (result) => {
        if (!live) return;
        loadedKey.current = key;
        loadedCount.current = result.rows.length;
        setState(result);
      },
      (err: unknown) => {
        if (!live) return;
        setState({
          key,
          rows: [],
          total: null,
          next: null,
          extras: null,
          error: errorMessage(err, 'Could not load your highlights.'),
          loadingMore: false,
        });
      },
    );
    return () => {
      live = false;
    };
  }, [key, refreshKey, waiting, latest]);

  const loadMore = useCallback(() => {
    const { args: a, state: s, key: currentKey } = latest.current;
    if (!s || s.key !== currentKey || !s.next || s.loadingMore || s.error) return;
    const cursor = s.next;
    setState({ ...s, loadingMore: true });
    const fetchNext = async (): Promise<Page> => {
      if (cursor.kind === 'search') {
        if (!a.index) throw new Error('The search index is not ready.');
        return fetchSearchPage(a.index, {
          query: a.query,
          sort: searchSort(a.sort),
          offset: cursor.offset,
          idSet: null,
        });
      }
      return fetchBrowsePage(a.api, {
        scope: a.scope,
        filters: a.filters,
        sort: a.sort,
        cursor: cursor.cursor,
        withTotal: false,
      });
    };
    fetchNext().then(
      (page) =>
        setState((cur) => {
          if (!cur || cur.key !== currentKey) return cur;
          const seen = new Set(cur.rows.map((r) => r.highlightId ?? r.key));
          const rows = [...cur.rows, ...dedupeRows(page.rows, seen)];
          loadedCount.current = rows.length;
          return { ...cur, rows, next: page.next, loadingMore: false };
        }),
      (err: unknown) =>
        setState((cur) =>
          cur && cur.key === currentKey
            ? { ...cur, loadingMore: false, error: errorMessage(err, 'Could not load more.') }
            : cur,
        ),
    );
  }, [latest]);

  const current = state?.key === key ? state : null;
  return {
    rows: current?.rows ?? [],
    total: current?.total ?? null,
    loading: current === null && !waiting,
    loadingMore: current?.loadingMore ?? false,
    error: current?.error ?? null,
    hasMore: current?.next != null,
    loadMore,
    extras: current?.extras ?? null,
    waitingForIndex: waiting,
  };
}
