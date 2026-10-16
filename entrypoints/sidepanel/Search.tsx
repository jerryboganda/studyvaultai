import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Code,
  House,
  Layers,
  ListFilter,
  LocateFixed,
  NotebookPen,
  Search,
  TriangleAlert,
  X,
} from 'lucide-react';
import { MAX_QUERY_LENGTH, QUERY_SYNTAX, type SearchResult, type Snippet } from '@search';
import { KIND_LABELS, type ColorId, type HighlightKind, type ResolveStatus } from '@shared';
import {
  Button,
  BuddyEmptyState,
  InlineNotice,
  KindChip,
  describeResolveState,
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
import { StatusBadge, type CardActions } from './HighlightCard';
import { IconAction } from './IconAction';
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

/** Words for index values (kind and status ids); the chip still toggles the raw value. */
function facetLabel(key: FacetKey, value: string): string {
  if (key === 'kind' && value in KIND_LABELS) return KIND_LABELS[value as HighlightKind].label;
  if (key === 'status') return describeResolveState(value as ResolveStatus).label;
  return value;
}

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
  /** The "focus-search" command asked for the cursor to be put in the query box. */
  focusRequested?: boolean;
  /** The box took focus: the request is done. */
  onFocused?(): void;
  /** Shown under the empty box (the newest saves). */
  recent?: ReactNode;
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
  focusRequested = false,
  onFocused,
  recent,
}: SearchTabProps) {
  const uid = useId();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!focusRequested) return;
    input.current?.focus();
    input.current?.select();
    onFocused?.();
  }, [focusRequested, onFocused]);
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
      return {
        result: host.search(query, { limit, collapseNotes: true, facets: true, suggest: true }),
      };
    } catch (err) {
      return { error: errorMessage(err, 'The search failed.') };
    }
    // `state.phase` and `revision` stand for "the index changed" (the host is one stable object).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, state.phase, revision, query, limit]);

  const result = outcome && 'result' in outcome ? outcome.result : null;
  const rows = useMemo(() => (result ? rowsFromHits(result.hits) : []), [result]);
  const canNarrow = Boolean(result?.facets && rows.length > 0);

  return (
    <div className="sv-stack" data-testid="search-tab">
      <h2 className="sv-sr">Search</h2>
      <div className="sp-search" role="search">
        <label className="sv-sr" htmlFor={`${uid}-q`}>
          Search highlights and notes
        </label>
        <Search className="sp-search__icon" aria-hidden="true" strokeWidth={2.4} />
        <input
          ref={input}
          id={`${uid}-q`}
          type="search"
          className="sp-search__input"
          data-testid="search-input"
          autoComplete="off"
          spellCheck={false}
          maxLength={MAX_QUERY_LENGTH}
          placeholder="Search your vault"
          dir="auto"
          value={text}
          aria-describedby={`${uid}-status`}
          onChange={(e) => onText(e.target.value)}
        />
        {text !== '' ? (
          <span className="sp-search__clear">
            <IconAction icon={X} label="Clear search" tipSide="left" onClick={() => onText('')} />
          </span>
        ) : null}
      </div>

      <div className="sp-chips">
        <button
          type="button"
          className="sp-pill"
          aria-expanded={help}
          aria-controls={`${uid}-help`}
          data-testid="search-help-toggle"
          onClick={() => setHelp((v) => !v)}
        >
          <Code aria-hidden="true" strokeWidth={2.4} />
          Search syntax
        </button>
        {canNarrow ? (
          <button
            type="button"
            className="sp-pill"
            aria-expanded={facets}
            aria-controls={`${uid}-facets`}
            data-testid="search-facets-toggle"
            onClick={() => setFacets((v) => !v)}
          >
            <ListFilter aria-hidden="true" strokeWidth={2.4} />
            Narrow results
          </button>
        ) : null}
        {scope ? (
          <span className="sp-pill sp-pill--on" data-testid="search-scope">
            <span dir="auto" className="sv-wrap">
              Only in {scopeLabel(scope)}
            </span>
            <button
              type="button"
              className="sp-scope__x"
              aria-label="Search everywhere"
              onClick={onClearScope}
            >
              <X aria-hidden="true" strokeWidth={2.6} />
            </button>
          </span>
        ) : null}
      </div>

      {help ? (
        <div id={`${uid}-help`} className="sp-help" data-testid="search-help">
          <p className="sv-small sv-muted">Every word must match; small typos still match.</p>
          <ul className="sp-help__list">
            {QUERY_SYNTAX.map((row) => (
              <li key={row.example} className="sp-help__row">
                <code className="sv-kbd sv-wrap">{row.example}</code>
                <span className="sv-small sv-muted">{row.meaning}</span>
                <Button
                  variant="ghost"
                  aria-label={`Use ${row.example}`}
                  onClick={() => onText(appendTokens(text, [row.example]))}
                >
                  Use
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {canNarrow && facets && result?.facets ? (
        <div
          id={`${uid}-facets`}
          role="group"
          aria-label="Narrow the results"
          className="sp-facets"
        >
          {FACETS.map(({ key, label }) => {
            const values = result.facets![key].slice(0, FACET_VALUES_SHOWN);
            if (values.length === 0) return null;
            return (
              <div key={key} className="sp-facets__row">
                <span className="sp-facets__label">{label}</span>
                {values.map((f) => (
                  <button
                    key={f.value}
                    type="button"
                    className="sp-chip"
                    aria-pressed={hasFacetToken(text, key, f.value)}
                    data-testid={`facet-${key}`}
                    onClick={() => onText(toggleFacetToken(text, key, f.value))}
                  >
                    <span dir="auto">{facetLabel(key, f.value)}</span>
                    <span className="sp-chip__n"> {f.count}</span>
                  </button>
                ))}
              </div>
            );
          })}
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

      <p id={`${uid}-status`} className="sp-hint" role="status" data-testid="search-status">
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
            <li key={`${w.code}-${i}`}>
              <TriangleAlert aria-hidden="true" strokeWidth={2.4} />
              {w.message}
            </li>
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

      {/* An empty box shows the newest saves (UX_DESIGN 7.2); the mascot only when there are none. */}
      {query === '' && index?.usable !== false
        ? (recent ?? (
            <BuddyEmptyState
              pose="think"
              title="Search your vault"
              text="Words, tags, banks or sites."
              mascotSize={88}
            />
          ))
        : null}

      {result && rows.length === 0 && result.total === 0 ? (
        <div className="sp-noresult">
          <BuddyEmptyState
            pose="sleep"
            title="No results"
            text={
              scope ? `Nothing in ${scopeLabel(scope)} matches.` : 'Try fewer or shorter words.'
            }
            mascotSize={88}
          />
          {scope ? (
            <Button onClick={onClearScope} data-testid="search-everywhere">
              Search everywhere
            </Button>
          ) : null}
        </div>
      ) : null}

      {rows.length > 0 ? (
        <ul className="sp-list" aria-label="Search results" data-testid="search-results">
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
}): ReactNode {
  if (s.query === '') return '';
  if (!s.usable) return 'Search will answer as soon as the index is ready.';
  if (!s.result) return s.outcome && 'error' in s.outcome ? '' : 'Searching…';
  const { total, took, hits } = s.result;
  if (total === 0) return 'No matches.';
  // The timing is for the eye only (aria-hidden): read aloud after every query it is noise.
  return (
    <>
      {total.toLocaleString()} {total === 1 ? 'match' : 'matches'}
      <span aria-hidden="true"> in {Math.max(1, Math.round(took))} ms</span>
      {hits.length < total ? `; showing the best ${s.shown}.` : '.'}
    </>
  );
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
  const meta = [row.title || row.host, row.banks.join(', ')].filter((x) => x !== '').join(' · ');

  return (
    <article
      className={`hl-card sp-sw--${row.kind ? paletteFor(row.kind) : 'none'}`}
      data-testid="search-result"
      data-highlight-id={id ?? undefined}
      aria-label={`${row.kind ? 'Highlight' : 'Note'}: ${truncate(quoteText, 60)}`}
    >
      <div className="hl-card__top">
        {row.kind ? (
          <KindChip kind={row.kind} color={paletteFor(row.kind)} />
        ) : (
          <span className="hl-chip">
            <NotebookPen aria-hidden="true" strokeWidth={2.4} />
            Note
          </span>
        )}
        {attention && row.resolveStatus ? <StatusBadge status={row.resolveStatus} /> : null}
        {row.docType === 'note' && row.kind ? (
          <span className="hl-chip">
            <NotebookPen aria-hidden="true" strokeWidth={2.4} />
            Matched a note
          </span>
        ) : null}
        {row.priority ? <span className="hl-chip">P{row.priority}</span> : null}
      </div>
      <p className="hl-card__quote sv-wrap" dir="auto">
        <Snip snippet={row.quote} />
      </p>
      {row.match ? (
        <p className="hl-card__meta sv-wrap" dir="auto">
          <span>In {FIELD_LABELS[row.match.field]}: </span>
          <Snip snippet={row.match.snippet} />
        </p>
      ) : null}
      {meta !== '' ? (
        <p className="hl-card__meta sv-wrap" dir="auto">
          {meta}
        </p>
      ) : null}
      {row.tags.length > 0 ? (
        <ul className="hl-chips" aria-label="Tags">
          {row.tags.map((t) => (
            <li key={t} className="hl-tag" dir="auto">
              <span aria-hidden="true">#</span>
              <span>{t}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="hl-card__actions">
        <IconAction
          icon={Layers}
          label="Make flashcard"
          busy={act.busy}
          data-testid="hit-flashcard"
          disabledReason={
            id === null
              ? orphanNote
              : reviewOn
                ? undefined
                : 'Review is turned off in Settings, so flashcards cannot be made.'
          }
          onClick={() => void act.run('flashcard')}
        />
        <IconAction
          icon={LocateFixed}
          label="Show on page"
          busy={act.busy}
          data-testid="hit-reveal"
          disabledReason={reveal.enabled ? undefined : reveal.reason}
          onClick={() => void act.run('reveal')}
        />
        <IconAction
          icon={House}
          label="Open in dashboard"
          busy={act.busy}
          data-testid="hit-dashboard"
          disabledReason={id === null ? orphanNote : undefined}
          onClick={() => void act.run('dashboard')}
        />
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
