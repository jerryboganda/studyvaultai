import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createSearchIndex } from '@search';
import { toIndexDocument } from '@ui/vault/searchHost';
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
