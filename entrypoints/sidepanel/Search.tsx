import { useEffect, useId, useMemo, useState } from 'react';
import { MAX_QUERY_LENGTH, QUERY_SYNTAX, type SearchResult, type Snippet } from '@search';
import type { ColorId, HighlightKind } from '@shared';
import {
  Badge,
  Button,
  EmptyState,
  InlineNotice,
  KindChip,
  ResolveBadge,
  errorMessage,
  truncate,
  useAction,
  useToast,
} from '@ui';
import {
  appendTokens,
  hasFacetToken,
  removeTokens,
  scopeTokens,
  toggleFacetToken,
  type FacetKey,
  type SearchHostHandle,
} from '@ui/panel';
import type { CardActions } from './HighlightCard';
import { REVEAL_NOT_FOUND, scopeLabel, type BankScope } from './model';
import {
  FIELD_LABELS,
  SEARCH_PAGE,
  describeIndex,
  hitReveal,
  rowsFromHits,
  type SearchRow,
} from './searchModel';

const FACETS: Array<{ key: Exclude<FacetKey, 'folder'>; label: string }> = [
  { key: 'bank', label: 'Banks' },
  { key: 'tag', label: 'Tags' },
  { key: 'kind', label: 'Kinds' },
  { key: 'host', label: 'Sites' },
  { key: 'status', label: 'Status' },
];
const FACET_VALUES_SHOWN = 6;

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

export interface SearchTabProps {
  search: SearchHostHandle;
  text: string;
  onText(next: string): void;
  scope: BankScope | null;
  onClearScope(): void;
  /** StudyVault is running in the active tab. */
  live: boolean;
  /** Highlights that belong to the page in the active tab. */
  pageIds: ReadonlySet<string>;
  paletteFor(kind: HighlightKind): ColorId;
  actions: CardActions;
  reviewOn: boolean;
}

export function SearchTab({
  search,
  text,
  onText,
  scope,
  onClearScope,
  live,
  pageIds,
  paletteFor,
  actions,
  reviewOn,
}: SearchTabProps) {
  const uid = useId();
  const [help, setHelp] = useState(false);
  const [facets, setFacets] = useState(false);
  const typed = useDebounced(text, 180);
  const scopeTokenList = scopeTokens(scope);
  const query = appendTokens(typed, scopeTokenList);
  // "Show more" is per query: a new query starts again at one page.
  const [paging, setPaging] = useState({ query, limit: SEARCH_PAGE });
  const limit = paging.query === query ? paging.limit : SEARCH_PAGE;

  const { host, state, revision } = search;
  const index = describeIndex(state);
  const outcome = useMemo((): { result: SearchResult } | { error: string } | null => {
    if (query === '' || !host.index) return null;
    try {
      return { result: host.search(query, { limit, facets: true, suggest: true }) };
    } catch (err) {
      return { error: errorMessage(err, 'The search failed.') };
    }
    // `state.phase` and `revision` stand for "the index changed" (the host is one stable object).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, state.phase, revision, query, limit]);

  const result = outcome && 'result' in outcome ? outcome.result : null;
  const rows = useMemo(() => (result ? rowsFromHits(result.hits) : []), [result]);

  return (
    <div className="sv-stack" data-testid="search-tab">
      <h2 className="sv-sr">Search</h2>
      <div className="sv-stack sv-stack--tight" role="search">
        <label className="sv-label" htmlFor={`${uid}-q`}>
          Search highlights and notes
        </label>
        <input
          id={`${uid}-q`}
          type="search"
          className="sv-control"
          data-testid="search-input"
          autoComplete="off"
          spellCheck={false}
          maxLength={MAX_QUERY_LENGTH}
          placeholder={'"cell membrane", tag:neuro, kind:formula'}
          dir="auto"
          value={text}
          aria-describedby={`${uid}-status`}
          onChange={(e) => onText(e.target.value)}
        />
        <div className="sv-row">
          <Button
            aria-expanded={help}
            aria-controls={`${uid}-help`}
            data-testid="search-help-toggle"
            onClick={() => setHelp((v) => !v)}
          >
            Search syntax
          </Button>
          {text !== '' ? (
            <Button variant="ghost" onClick={() => onText('')}>
              Clear search
            </Button>
          ) : null}
        </div>
      </div>

      {help ? (
        <div
          id={`${uid}-help`}
          className="sp-help sv-stack sv-stack--tight"
          data-testid="search-help"
        >
          <p className="sv-small sv-muted">
            Every word must match; typos and word beginnings still match. Use adds an example to the
            search box.
          </p>
          <ul className="sv-stack sv-stack--tight">
            {QUERY_SYNTAX.map((row) => (
              <li key={row.example} className="sv-stack sv-stack--tight">
                <div className="sv-row">
                  <code className="sv-kbd sv-wrap">{row.example}</code>
                  <Button
                    variant="ghost"
                    aria-label={`Use ${row.example}`}
                    onClick={() => onText(appendTokens(text, [row.example]))}
                  >
                    Use
                  </Button>
                </div>
                <span className="sv-small sv-muted">{row.meaning}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {scope ? (
        <div className="sv-row" data-testid="search-scope">
          <Badge glyph="⌖">
            <span dir="auto">Only in {scopeLabel(scope)}</span>
          </Badge>
          <Button variant="ghost" onClick={onClearScope}>
            Search everywhere
          </Button>
        </div>
      ) : null}

      {index ? (
        <div className="sv-stack sv-stack--tight" data-testid="search-index-state">
          <InlineNotice
            tone={index.tone}
            live={index.tone !== 'error'}
            action={
              index.failed ? (
                <span className="sv-row">
                  <Button onClick={search.retry}>Retry</Button>
                  <Button onClick={search.rebuild}>Rebuild the index</Button>
                </span>
              ) : undefined
            }
          >
            {index.text}
          </InlineNotice>
          {index.progress ? (
            <progress
              className="sp-progress"
              aria-label="Search index progress"
              max={index.progress.total ?? undefined}
              value={index.progress.total !== null ? index.progress.done : undefined}
            />
          ) : null}
        </div>
      ) : null}

      <p
        id={`${uid}-status`}
        className="sv-small sv-muted"
        role="status"
        data-testid="search-status"
      >
        {statusLine({ query, result, outcome, usable: index?.usable ?? true, shown: rows.length })}
      </p>

      {outcome && 'error' in outcome ? (
        <InlineNotice tone="error" title="The search failed">
          {outcome.error}
        </InlineNotice>
      ) : null}

      {result && result.warnings.length > 0 ? (
        <ul className="sv-small sp-warnings" data-testid="search-warnings">
          {result.warnings.map((w, i) => (
            <li key={`${w.code}-${i}`}>{w.message}</li>
          ))}
        </ul>
      ) : null}

      {result?.didYouMean ? (
        <p className="sv-small" data-testid="did-you-mean">
          Did you mean{' '}
          <Button
            variant="ghost"
            onClick={() => onText(removeTokens(result.didYouMean!.query, scopeTokenList))}
          >
            {removeTokens(result.didYouMean.query, scopeTokenList)}
          </Button>
          ?
        </p>
      ) : null}

      {result?.facets && rows.length > 0 ? (
        <div className="sv-stack sv-stack--tight">
          <div>
            <Button
              aria-expanded={facets}
              aria-controls={`${uid}-facets`}
              data-testid="search-facets-toggle"
              onClick={() => setFacets((v) => !v)}
            >
              Narrow results
            </Button>
          </div>
          {facets ? (
            <div
              id={`${uid}-facets`}
              role="group"
              aria-label="Narrow the results"
              className="sv-stack sv-stack--tight"
            >
              {FACETS.map(({ key, label }) => {
                const values = result.facets![key].slice(0, FACET_VALUES_SHOWN);
                if (values.length === 0) return null;
                return (
                  <div key={key} className="sv-row">
                    <span className="sv-label">{label}</span>
                    {values.map((f) => (
                      <button
                        key={f.value}
                        type="button"
                        className="sp-chip"
                        aria-pressed={hasFacetToken(text, key, f.value)}
                        data-testid={`facet-${key}`}
                        onClick={() => onText(toggleFacetToken(text, key, f.value))}
                      >
                        <span dir="auto">{f.value}</span>
                        <span className="sv-muted"> {f.count}</span>
                      </button>
                    ))}
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}

      {query === '' && index?.usable !== false ? (
        <EmptyState title="Search your vault">
          <p>
            Find highlights and notes by word, tag, bank, kind or site. It works offline and never
            sends anything anywhere.
          </p>
        </EmptyState>
      ) : null}

      {result && rows.length === 0 && result.total === 0 ? (
        <EmptyState title="No results">
          <p>
            {scope
              ? `Nothing in ${scopeLabel(scope)} matches. `
              : 'Nothing you have saved matches. '}
            Try fewer or shorter words; word beginnings and small typos already match.
          </p>
          {scope ? (
            <Button onClick={onClearScope} data-testid="search-everywhere">
              Search everywhere
            </Button>
          ) : null}
        </EmptyState>
      ) : null}

      {rows.length > 0 ? (
        <ul className="sp-results" aria-label="Search results" data-testid="search-results">
          {rows.map((row) => (
            <li key={row.key}>
              <SearchCard
                row={row}
                paletteFor={paletteFor}
                live={live}
                onActivePage={row.highlightId !== null && pageIds.has(row.highlightId)}
                actions={actions}
                reviewOn={reviewOn}
              />
            </li>
          ))}
        </ul>
      ) : null}

      {result && result.hits.length < result.total ? (
        <div>
          <Button
            data-testid="search-more"
            onClick={() => setPaging({ query, limit: limit + SEARCH_PAGE })}
          >
            Show more results
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function statusLine(s: {
  query: string;
  result: SearchResult | null;
  outcome: { result: SearchResult } | { error: string } | null;
  usable: boolean;
  shown: number;
}): string {
  if (s.query === '') return 'Type to search. Press Search syntax for what you can ask for.';
  if (!s.usable) return 'Search will answer as soon as the index is ready.';
  if (!s.result) return s.outcome && 'error' in s.outcome ? '' : 'Searching…';
  const { total, took, hits } = s.result;
  if (total === 0) return 'No matches.';
  const matches = `${total.toLocaleString()} ${total === 1 ? 'match' : 'matches'} in ${Math.max(1, Math.round(took))} ms`;
  return hits.length < total ? `${matches}; showing the best ${s.shown}.` : `${matches}.`;
}

// ---------------------------------------------------------------------------------------------

function Snip({ snippet }: { snippet: Snippet }) {
  return (
    <>
      {snippet.truncatedStart ? '…' : ''}
      {snippet.segments.map((s, i) =>
        s.match ? (
          <mark key={i} className="sp-mark">
            {s.text}
          </mark>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
      {snippet.truncatedEnd ? '…' : ''}
    </>
  );
}

type Op = 'reveal' | 'dashboard' | 'flashcard';

function SearchCard({
  row,
  paletteFor,
  live,
  onActivePage,
  actions,
  reviewOn,
}: {
  row: SearchRow;
  paletteFor(kind: HighlightKind): ColorId;
  live: boolean;
  onActivePage: boolean;
  actions: CardActions;
  reviewOn: boolean;
}) {
  const { announce } = useToast();
  const [revealNote, setRevealNote] = useState<{ ok: boolean; text: string } | null>(null);
  const id = row.highlightId;
  const orphanNote = 'This note is not attached to a highlight.';

  const act = useAction(async (op: Op) => {
    setRevealNote(null);
    if (id === null) return;
    if (op === 'reveal') {
      const { found } = await actions.reveal(id);
      const text = found ? 'Showing this highlight on the page.' : REVEAL_NOT_FOUND;
      setRevealNote({ ok: found, text });
      announce(text);
    } else if (op === 'dashboard') {
      await actions.openDashboard(id);
    } else {
      await actions.makeFlashcard(id);
    }
  });

  const reveal =
    id === null
      ? { enabled: false as const, reason: orphanNote }
      : hitReveal({ live, onActivePage, resolveStatus: row.resolveStatus });
  const quoteText = row.quote.segments.map((s) => s.text).join('');
  const attention = row.resolveStatus === 'ambiguous' || row.resolveStatus === 'orphaned';

  return (
    <article
      className="sp-card"
      data-testid="search-result"
      data-highlight-id={id ?? undefined}
      aria-label={`${row.kind ? 'Highlight' : 'Note'}: ${truncate(quoteText, 60)}`}
    >
      <div className="sv-row">
        {row.kind ? (
          <KindChip kind={row.kind} color={paletteFor(row.kind)} />
        ) : (
          <Badge glyph="✎">Note</Badge>
        )}
        {attention && row.resolveStatus ? <ResolveBadge status={row.resolveStatus} /> : null}
        {row.docType === 'note' && row.kind ? <Badge glyph="✎">Matched a note</Badge> : null}
        {row.priority ? <span className="sv-small sv-muted">P{row.priority}</span> : null}
      </div>
      <p className="sp-quote sv-wrap" dir="auto">
        <Snip snippet={row.quote} />
      </p>
      {row.match ? (
        <p className="sv-small sv-wrap" dir="auto">
          <span className="sv-muted">In {FIELD_LABELS[row.match.field]}: </span>
          <Snip snippet={row.match.snippet} />
        </p>
      ) : null}
      <p className="sv-small sv-muted sv-wrap" dir="auto">
        {[row.title || row.host, row.banks.join(', ')].filter((x) => x !== '').join(' · ')}
      </p>
      {row.tags.length > 0 ? (
        <div className="sv-row">
          {row.tags.map((t) => (
            <Badge key={t}>
              <span dir="auto">{t}</span>
            </Badge>
          ))}
        </div>
      ) : null}
      <div className="sv-row">
        <Button
          busy={act.busy}
          data-testid="hit-reveal"
          {...(reveal.enabled ? {} : { disabledReason: reveal.reason })}
          onClick={() => void act.run('reveal')}
        >
          Show on page
        </Button>
        <Button
          busy={act.busy}
          data-testid="hit-dashboard"
          {...(id === null ? { disabledReason: orphanNote } : {})}
          onClick={() => void act.run('dashboard')}
        >
          Open in dashboard
        </Button>
        <Button
          busy={act.busy}
          data-testid="hit-flashcard"
          {...(id === null
            ? { disabledReason: orphanNote }
            : reviewOn
              ? {}
              : {
                  disabledReason: 'Review is turned off in Settings, so flashcards cannot be made.',
                })}
          onClick={() => void act.run('flashcard')}
        >
          Make flashcard
        </Button>
      </div>
      {revealNote ? (
        <InlineNotice tone={revealNote.ok ? 'success' : 'warning'}>{revealNote.text}</InlineNotice>
      ) : null}
      {act.error ? (
        <InlineNotice
          tone="error"
          title="That did not work"
          action={act.retryable ? <Button onClick={act.retry}>Retry</Button> : undefined}
        >
          {act.error}
        </InlineNotice>
      ) : null}
    </article>
  );
}
