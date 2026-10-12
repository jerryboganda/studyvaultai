import { useId, useState, type Ref } from 'react';
import { MAX_QUERY_LENGTH, QUERY_SYNTAX, type DidYouMean, type QueryWarning } from '@search';
import { Button, Kbd } from '@ui';
import type { SearchHostState } from '@ui/vault/searchHost';
import { hasFacetToken, toggleFacetToken, type FacetKey } from './filters';
import type { SearchExtras } from './results';

/** Human sentence for what the index is doing; null when there is nothing to say. */
export function describeIndexState(state: SearchHostState): string | null {
  switch (state.phase) {
    case 'restoring':
      return 'Opening the search index…';
    case 'building': {
      const why =
        state.reason === 'purge'
          ? 'Items were permanently deleted'
          : state.reason === 'requested'
            ? 'Rebuilding as requested'
            : 'Building the search index';
      const progress =
        state.total !== null && state.total > 0
          ? `${state.done.toLocaleString()} of ${state.total.toLocaleString()}`
          : `${state.done.toLocaleString()} so far`;
      return `${why}: ${progress}. Browsing works meanwhile; search results appear when this finishes.`;
    }
    case 'error':
      return `Search is unavailable: ${state.message}`;
    default:
      return null;
  }
}

const FACETS: Array<{ key: FacetKey; label: string }> = [
  { key: 'bank', label: 'Banks' },
  { key: 'tag', label: 'Tags' },
  { key: 'kind', label: 'Kinds' },
  { key: 'host', label: 'Sites' },
  { key: 'status', label: 'Status' },
];

export function SearchBar({
  value,
  onChange,
  inputRef,
  hostState,
  searching,
  total,
  extras,
  onRebuild,
}: {
  value: string;
  onChange(next: string): void;
  inputRef: Ref<HTMLInputElement>;
  hostState: SearchHostState;
  /** The box holds a query and results are the search's. */
  searching: boolean;
  total: number | null;
  extras: SearchExtras | null;
  onRebuild(): void;
}) {
  const id = useId();
  const [helpOpen, setHelpOpen] = useState(false);
  const indexNote = describeIndexState(hostState);
  const warnings: QueryWarning[] = searching ? (extras?.warnings ?? []) : [];
  const didYouMean: DidYouMean | null = searching ? (extras?.didYouMean ?? null) : null;
  const facets = searching ? extras?.facets : null;

  return (
    <div className="dash-search" role="search">
      <div className="sv-row dash-search__row">
        <label className="sv-sr" htmlFor={`${id}-input`}>
          Search highlights and notes
        </label>
        <input
          ref={inputRef}
          id={`${id}-input`}
          type="search"
          className="sv-control dash-search__input"
          placeholder={'Search your vault: "cell membrane", tag:neuro, kind:formula'}
          value={value}
          maxLength={MAX_QUERY_LENGTH}
          autoComplete="off"
          spellCheck={false}
          aria-describedby={`${id}-status`}
          data-testid="search-input"
          onChange={(e) => onChange(e.target.value)}
        />
        <Button
          aria-expanded={helpOpen}
          aria-controls={`${id}-help`}
          onClick={() => setHelpOpen((v) => !v)}
          data-testid="search-help-toggle"
        >
          Syntax help
        </Button>
      </div>

      {helpOpen ? (
        <div id={`${id}-help`} className="dash-help" data-testid="search-help">
          <p className="sv-small sv-muted">
            Words are all required, and typos and word beginnings still match. Click “Use” to put an
            example into the search box.
          </p>
          <ul className="sv-stack sv-stack--tight">
            {QUERY_SYNTAX.map((row) => (
              <li key={row.example} className="sv-row">
                <code className="sv-kbd">{row.example}</code>
                <span className="sv-grow sv-small">{row.meaning}</span>
                <Button
                  variant="ghost"
                  onClick={() =>
                    onChange(value.trim() ? `${value.trim()} ${row.example}` : row.example)
                  }
                >
                  Use
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p id={`${id}-status`} className="sv-small sv-muted dash-search__status" role="status">
        {indexNote ??
          (searching && total !== null ? (
            <>
              {total.toLocaleString()} {total === 1 ? 'match' : 'matches'}
              {/* The timing is for the eye: read aloud on every query it is noise. */}
              {extras ? (
                <span aria-hidden="true"> in {Math.max(1, Math.round(extras.took))} ms</span>
              ) : null}
            </>
          ) : (
            'Press / to search. Ctrl+K opens the command palette.'
          ))}{' '}
        {hostState.phase === 'error' ? (
          <Button variant="ghost" onClick={onRebuild}>
            Rebuild the index
          </Button>
        ) : null}
        {hostState.phase === 'ready' && hostState.rejected > 0 ? (
          <span>
            {hostState.rejected.toLocaleString()} items could not be indexed and will not appear in
            search.
          </span>
        ) : null}
      </p>

      {hostState.phase === 'building' ? (
        <progress
          className="dash-progress"
          aria-label="Search index progress"
          max={hostState.total ?? undefined}
          value={hostState.total !== null ? hostState.done : undefined}
        />
      ) : null}

      {warnings.length > 0 ? (
        <ul className="sv-small dash-warnings" data-testid="search-warnings">
          {warnings.map((w, i) => (
            <li key={`${w.code}-${i}`}>{w.message}</li>
          ))}
        </ul>
      ) : null}

      {didYouMean ? (
        <p className="sv-small" data-testid="did-you-mean">
          Did you mean{' '}
          <Button variant="ghost" onClick={() => onChange(didYouMean.query)}>
            {didYouMean.query}
          </Button>
          ?
        </p>
      ) : null}

      {facets ? (
        <div className="dash-facets" aria-label="Narrow the results" role="group">
          {FACETS.map(({ key, label }) => {
            const values = facets[key].slice(0, 8);
            if (values.length === 0) return null;
            return (
              <div key={key} className="sv-row dash-facets__group">
                <span className="sv-label">{label}</span>
                {values.map((f) => {
                  const on = hasFacetToken(value, key, f.value);
                  return (
                    <button
                      key={f.value}
                      type="button"
                      className="dash-chip"
                      aria-pressed={on}
                      data-testid={`facet-${key}`}
                      onClick={() => onChange(toggleFacetToken(value, key, f.value))}
                    >
                      <span dir="auto">{f.value}</span>
                      <span className="sv-muted"> {f.count}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function ShortcutLegend() {
  return (
    <dl className="dash-legend sv-small">
      {[
        ['Ctrl+K', 'Command palette'],
        ['/', 'Focus search'],
        ['F6', 'Next pane (Shift+F6 previous)'],
        ['↑ ↓ Home End', 'Move in the list or tree'],
        ['Space', 'Select the current row'],
        ['Shift+↑ ↓', 'Extend the selection'],
        ['Ctrl+A', 'Select all loaded rows'],
        ['Delete', 'Move the selection to the trash'],
        ['F2', 'Rename the current bank or folder'],
        ['Alt+↑ ↓ → ←', 'Reorder, indent or outdent a folder'],
        ['Shift+F10', 'Context menu in the tree'],
      ].map(([keys, what]) => (
        <div key={keys} className="sv-row">
          <dt>
            <Kbd shortcut={keys!} />
          </dt>
          <dd>{what}</dd>
        </div>
      ))}
    </dl>
  );
}
