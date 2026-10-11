import { useEffect, useId, useState } from 'react';
import {
  createSavedSearch,
  deserializeSavedSearches,
  serializeSavedSearches,
  type SavedSearch,
} from '@search';
import { Button, InlineNotice, errorMessage } from '@ui';
import type { MetaPort } from './api';
import type { SortKey } from './filters';
import { SEARCH_SORTS, searchSort } from './filters';

export const SAVED_SEARCHES_KEY = 'savedSearches';

export interface SavedState {
  items: SavedSearch[];
  rejected: number;
  error: string | null;
}

export async function loadSaved(meta: MetaPort): Promise<SavedState> {
  const raw = await meta.get(SAVED_SEARCHES_KEY);
  if (raw === undefined) return { items: [], rejected: 0, error: null };
  const loaded = deserializeSavedSearches(raw);
  return { items: loaded.items, rejected: loaded.rejected, error: loaded.error ?? null };
}

/** A new list with `name` -> `query` added, or the reason it cannot be saved. */
export function addSaved(
  items: readonly SavedSearch[],
  input: { name: string; query: string; sort: SortKey },
  now = new Date(),
): { ok: true; items: SavedSearch[] } | { ok: false; error: string } {
  const made = createSavedSearch({
    name: input.name,
    query: input.query,
    ...(SEARCH_SORTS.includes(input.sort) ? { sort: searchSort(input.sort) } : {}),
    now,
  });
  if (!made.ok) return made;
  const key = made.search.name.toLocaleLowerCase();
  if (items.some((s) => s.name.toLocaleLowerCase() === key)) {
    return { ok: false, error: `A saved search named “${made.search.name}” already exists.` };
  }
  return { ok: true, items: [...items, made.search] };
}

export interface SavedController {
  state: SavedState | null;
  problem: string | null;
  save(name: string, query: string, sort: SortKey): Promise<boolean>;
  remove(id: string): Promise<void>;
}

/** Saved searches persisted in `meta` ('savedSearches'), loaded once and written on every change. */
export function useSavedSearches(meta: MetaPort): SavedController {
  const [state, setState] = useState<SavedState | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    loadSaved(meta).then(
      (loaded) => {
        if (live) setState(loaded);
      },
      (err: unknown) => {
        if (live) {
          setState({
            items: [],
            rejected: 0,
            error: errorMessage(err, 'Could not read saved searches.'),
          });
        }
      },
    );
    return () => {
      live = false;
    };
  }, [meta]);

  const persist = async (items: SavedSearch[]) => {
    try {
      await meta.put(SAVED_SEARCHES_KEY, serializeSavedSearches(items));
      setState((s) => ({ items, rejected: s?.rejected ?? 0, error: null }));
      setProblem(null);
      return true;
    } catch (err) {
      setProblem(errorMessage(err, 'Could not save the list.'));
      return false;
    }
  };

  return {
    state,
    problem,
    async save(name, query, sort) {
      const result = addSaved(state?.items ?? [], { name, query, sort });
      if (!result.ok) {
        setProblem(result.error);
        return false;
      }
      return persist(result.items);
    },
    async remove(id) {
      await persist((state?.items ?? []).filter((x) => x.id !== id));
    },
  };
}

export function SavedSearches({
  controller,
  currentText,
  currentSort,
  onRun,
}: {
  controller: SavedController;
  currentText: string;
  currentSort: SortKey;
  onRun(search: SavedSearch): void;
}) {
  const id = useId();
  const { state, problem } = controller;
  const [name, setName] = useState('');
  const canSave = currentText.trim() !== '';

  return (
    <section className="dash-saved" aria-labelledby={`${id}-h`} data-testid="saved-searches">
      <h2 id={`${id}-h`}>Saved searches</h2>
      {state === null ? (
        <p className="sv-small sv-muted">Loading…</p>
      ) : state.items.length === 0 ? (
        <p className="sv-small sv-muted">
          None yet. Type a search, give it a name below and keep it here.
        </p>
      ) : (
        <ul className="sv-stack sv-stack--tight">
          {state.items.map((s) => (
            <li key={s.id} className="sv-row">
              <button
                type="button"
                className="dash-link sv-grow"
                title={s.query}
                onClick={() => onRun(s)}
                data-testid="saved-search-run"
              >
                <span dir="auto">{s.name}</span>
              </button>
              <button
                type="button"
                className="dash-chip__x"
                aria-label={`Delete saved search ${s.name}`}
                onClick={() => void controller.remove(s.id)}
                data-testid="saved-search-delete"
              >
                <span aria-hidden="true">✕</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {state && (state.rejected > 0 || state.error) ? (
        <InlineNotice tone="warning">
          {state.error
            ? `Saved searches could not be read: ${state.error}`
            : `${state.rejected} saved search${state.rejected === 1 ? '' : 'es'} could not be read and were skipped.`}
        </InlineNotice>
      ) : null}
      <form
        className="sv-stack sv-stack--tight"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSave && name.trim() !== '') {
            void controller.save(name, currentText, currentSort).then((ok) => {
              if (ok) setName('');
            });
          }
        }}
      >
        <label className="sv-label" htmlFor={`${id}-name`}>
          Name for the current search
        </label>
        <input
          id={`${id}-name`}
          className="sv-control"
          value={name}
          maxLength={120}
          dir="auto"
          onChange={(e) => setName(e.target.value)}
          data-testid="saved-search-name"
        />
        <Button
          type="submit"
          disabledReason={
            !canSave
              ? 'Type a search first.'
              : name.trim() === ''
                ? 'Give the search a name.'
                : undefined
          }
          data-testid="saved-search-save"
        >
          Save this search
        </Button>
        {problem ? (
          <p className="sv-small" role="alert">
            {problem}
          </p>
        ) : null}
      </form>
    </section>
  );
}
