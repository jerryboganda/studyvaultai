import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createSearchIndex } from '@search';
import { toIndexDocument } from '@ui/vault/searchHost';
import type { DashboardApi } from './api';
import { ALL_SCOPE, EMPTY_FILTERS } from './filters';
import type { SearchLike } from './results';
import { FakeVault, manyHighlights } from './testing';
import { useResults } from './useResults';

/**
 * The search index is built in the background after the dashboard opens. While the user is only
 * browsing it is irrelevant to the list, so its becoming ready must not blank the list, drop the
 * pages that were loaded, or read the vault again (a real browser run showed the summary line and
 * the rows disappearing for a moment right after opening).
 */
describe('useResults: the index becoming ready', () => {
  function setup(rows: number) {
    const vault = new FakeVault(manyHighlights(rows));
    const index = createSearchIndex();
    index.applyChanges(vault.searchDocs().map(toIndexDocument));
    return { vault, api: vault.api(), index: index as SearchLike };
  }

  it('keeps the browse list as it is', async () => {
    const { vault, api, index } = setup(3);
    const seen: Array<{ loading: boolean; rows: number; total: number | null }> = [];
    const { result, rerender } = renderHook(
      (props: { index: SearchLike | null }) => {
        const view = useResults({
          api,
          mode: 'browse',
          scope: ALL_SCOPE,
          filters: EMPTY_FILTERS,
          sort: 'captured-desc',
          query: '',
          index: props.index,
          refreshOn: [0],
        });
        seen.push({ loading: view.loading, rows: view.rows.length, total: view.total });
        return view;
      },
      { initialProps: { index: null as SearchLike | null } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.rows).toHaveLength(3);
    const reads = vault.called('listHighlights').length;

    seen.length = 0;
    rerender({ index });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => !s.loading && s.rows === 3 && s.total === 3)).toBe(true);
    expect(vault.called('listHighlights')).toHaveLength(reads);
  });

  it('still waits for the index in search mode and then answers', async () => {
    const { api, index } = setup(3);
    const { result, rerender } = renderHook(
      (props: { index: SearchLike | null }) =>
        useResults({
          api,
          mode: 'search',
          scope: ALL_SCOPE,
          filters: EMPTY_FILTERS,
          sort: 'relevance',
          query: 'mitochondria',
          index: props.index,
          refreshOn: [0],
        }),
      { initialProps: { index: null as SearchLike | null } },
    );
    expect(result.current.waitingForIndex).toBe(true);
    expect(result.current.rows).toEqual([]);

    rerender({ index });
    await waitFor(() => expect(result.current.rows).toHaveLength(3));
    expect(result.current.waitingForIndex).toBe(false);
    expect(result.current.total).toBe(3);
  });
});

/**
 * A note document repeats its highlight's quote, so a highlight with notes matches through several
 * documents. The count, the loaded rows and "load more" must all speak of highlights ("4 results,
 * 3 loaded" was the symptom: the engine counted documents, the list de-duplicated them).
 */
describe('useResults: highlights with notes', () => {
  const idOf = (i: number) => `hl-${String(i).padStart(6, '0')}`;

  async function setup(highlights: number, withNotes: number) {
    const vault = new FakeVault(manyHighlights(highlights));
    const api = vault.api();
    for (let i = 0; i < withNotes; i++) {
      await api.createNote({ highlightId: idOf(i), body: 'First note about mitochondria' });
      await api.createNote({ highlightId: idOf(i), body: 'Second note about mitochondria' });
    }
    const index = createSearchIndex();
    index.applyChanges(vault.searchDocs().map(toIndexDocument));
    return { vault, api, index: index as SearchLike };
  }

  const search = (api: DashboardApi, index: SearchLike, query = 'mitochondria') =>
    renderHook(() =>
      useResults({
        api,
        mode: 'search',
        scope: ALL_SCOPE,
        filters: EMPTY_FILTERS,
        sort: 'relevance',
        query,
        index,
        refreshOn: [0],
      }),
    );

  it('reports as many results as it lists, notes or not', async () => {
    const { api, index } = await setup(3, 1);
    const { result } = search(api, index);
    await waitFor(() => expect(result.current.rows).toHaveLength(3));
    expect(result.current.total).toBe(3);
    expect(result.current.hasMore).toBe(false);
    expect(new Set(result.current.rows.map((r) => r.highlightId)).size).toBe(3);
  });

  it('loads the next page without repeating or skipping a highlight', async () => {
    // 130 highlights, 40 of them with two notes: 210 documents, 130 results
    const { api, index } = await setup(130, 40);
    const { result } = search(api, index);
    await waitFor(() => expect(result.current.rows).toHaveLength(100));
    expect(result.current.total).toBe(130);
    expect(result.current.hasMore).toBe(true);

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.rows).toHaveLength(130));
    expect(result.current.total).toBe(130);
    expect(result.current.hasMore).toBe(false);
    expect(new Set(result.current.rows.map((r) => r.highlightId)).size).toBe(130);
  });

  it('finds a highlight through a note alone and counts it once', async () => {
    const { api, index } = await setup(5, 2);
    const { result } = search(api, index, 'second');
    await waitFor(() => expect(result.current.rows).toHaveLength(2));
    expect(result.current.total).toBe(2);
    expect(result.current.rows.every((r) => r.docType === 'note')).toBe(true);
    expect(result.current.rows.every((r) => r.matchNote?.field === 'comment')).toBe(true);
  });
});
