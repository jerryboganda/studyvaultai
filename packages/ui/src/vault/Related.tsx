import { useId, useMemo, useState } from 'react';
import type { RelatedHit, RelatedOptions, RelatedResult } from '@search';
import { Button } from '../Button';
import { useAction } from '../hooks';
import { InlineNotice } from '../Notice';
import { errorMessage, plural, truncate } from '../text';
import type { SearchHostState } from './searchHost';

/** Most related highlights listed (the engine can say how many more there are). */
export const RELATED_SHOWN = 10;
const QUOTE_CHARS = 200;

/**
 * What a surface gives the section. The section never opens an index itself: `request` is how it
 * asks the surface to start one, and `state`/`revision` say what that index is doing.
 */
export interface RelatedPort {
  state: SearchHostState;
  /** Changes whenever the indexed content changed, so a list computed earlier is stale. */
  revision: number;
  /** The section was opened: start the index if this surface keeps it stopped until needed. */
  request?(): void;
  /** Related highlights of one highlight; throws while the index is not ready. */
  find(id: string, options: RelatedOptions): RelatedResult;
}

const isUsable = (s: SearchHostState): boolean => s.phase === 'ready' || s.phase === 'updating';

/** One honest sentence about an index that cannot answer yet, or null when it can. */
function waiting(state: SearchHostState): string | null {
  switch (state.phase) {
    case 'idle':
    case 'restoring':
      return 'Opening the search index…';
    case 'building': {
      const counted =
        state.total !== null && state.total > 0
          ? `${state.done.toLocaleString()} of ${state.total.toLocaleString()}`
          : `${state.done.toLocaleString()} so far`;
      return `Building the search index: ${counted}. Related highlights appear when it finishes.`;
    }
    case 'error':
      return `Related highlights are unavailable: ${state.message}`;
    default:
      return null;
  }
}

function RelatedItem({
  hit,
  openLabel,
  onOpen,
  onLink,
}: {
  hit: RelatedHit;
  openLabel: string;
  onOpen(highlightId: string): void | Promise<void>;
  onLink?(highlightId: string): Promise<void>;
}) {
  const [linked, setLinked] = useState(false);
  const open = useAction(async () => {
    await onOpen(hit.highlightId);
  });
  const link = useAction(async () => {
    await onLink?.(hit.highlightId);
    setLinked(true);
  });
  const quote = hit.doc.quote;
  const where = [hit.doc.title, hit.doc.host].filter((x): x is string => !!x);
  return (
    <li className="sv-related__item" data-testid="related-item" data-highlight-id={hit.highlightId}>
      <p className="sv-wrap" dir="auto">
        {truncate(quote, QUOTE_CHARS)}
      </p>
      {where.length > 0 ? (
        <p className="sv-small sv-muted sv-wrap" dir="auto">
          {where.join(' · ')}
        </p>
      ) : null}
      <p className="sv-small sv-wrap" dir="auto" data-testid="related-why">
        {hit.explanation}
      </p>
      <div className="sv-row">
        <Button
          busy={open.busy}
          aria-label={`${openLabel}: ${truncate(quote, 60)}`}
          data-testid="related-open"
          onClick={() => void open.run()}
        >
          {openLabel}
        </Button>
        {onLink ? (
          linked ? (
            <span className="sv-small" role="status" data-testid="related-linked">
              Linked as Related
            </span>
          ) : (
            <Button
              busy={link.busy}
              aria-label={`Link as Related: ${truncate(quote, 60)}`}
              data-testid="related-link"
              onClick={() => void link.run()}
            >
              Link as Related
            </Button>
          )
        ) : null}
      </div>
      {open.error || link.error ? (
        <InlineNotice
          tone="error"
          title="That did not work"
          action={
            open.error && open.retryable ? <Button onClick={open.retry}>Retry</Button> : undefined
          }
        >
          {open.error ?? link.error}
        </InlineNotice>
      ) : null}
    </li>
  );
}

/**
 * Highlights that share words with one highlight, from the user's own vault and the local lexical
 * index (no network, no model). Collapsed until asked; nothing is computed, and no index is started
 * through `port.request`, before it is first opened.
 */
export function RelatedSection({
  id,
  port,
  onOpen,
  onLink,
  openLabel = 'Open',
}: {
  /** The highlight to relate. */
  id: string;
  port: RelatedPort;
  /** Show one of the related highlights; a rejected promise is reported next to the item. */
  onOpen(highlightId: string): void | Promise<void>;
  /** Make a "related" link to one of them (one click); a rejected promise is reported. */
  onLink?(highlightId: string): Promise<void>;
  openLabel?: string;
}) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [otherSources, setOtherSources] = useState(false);
  const { state, revision, find } = port;
  const usable = isUsable(state);

  const outcome = useMemo((): { result: RelatedResult } | { error: string } | null => {
    if (!open || !usable) return null;
    try {
      return { result: find(id, { limit: RELATED_SHOWN, excludeSameSource: otherSources }) };
    } catch (err) {
      return { error: errorMessage(err, 'Could not find related highlights.') };
    }
    // `revision` is not read here: it stands for "the indexed content changed".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, usable, revision, find, id, otherSources]);

  const result = outcome && 'result' in outcome ? outcome.result : null;
  const wait = waiting(state);

  return (
    <div className="sv-stack sv-stack--tight" data-testid="related">
      <div>
        <Button
          aria-expanded={open}
          aria-controls={`${uid}-panel`}
          data-testid="related-toggle"
          onClick={() => {
            if (!open) port.request?.();
            setOpen((v) => !v);
          }}
        >
          {open ? 'Hide related highlights' : 'Show related highlights'}
        </Button>
      </div>
      <div id={`${uid}-panel`} hidden={!open} className="sv-stack sv-stack--tight">
        {open ? (
          <>
            <p className="sv-small sv-muted">
              Found by comparing words with the rest of your vault, on this device. Nothing is sent
              anywhere.
            </p>
            {wait ? (
              <InlineNotice tone={state.phase === 'error' ? 'error' : 'info'} live>
                {wait}
              </InlineNotice>
            ) : null}
            {state.phase === 'updating' ? (
              <p className="sv-small sv-muted">
                Catching up with your latest changes; the list may not include them yet.
              </p>
            ) : null}
            {usable ? (
              <label className="sv-check">
                <input
                  type="checkbox"
                  checked={otherSources}
                  data-testid="related-other-sources"
                  onChange={(e) => setOtherSources(e.target.checked)}
                />
                <span>Hide highlights from the same source</span>
              </label>
            ) : null}
            {outcome && 'error' in outcome ? (
              <InlineNotice tone="error" title="Could not find related highlights">
                {outcome.error}
              </InlineNotice>
            ) : null}
            {result ? (
              <>
                <p className="sv-small" role="status" data-testid="related-summary">
                  {!result.found
                    ? 'This highlight is not in the search index yet; it appears once the index has caught up.'
                    : result.hits.length === 0
                      ? 'No other highlight shares enough words with this one yet. Very common words are ignored and words must match exactly.'
                      : result.total > result.hits.length
                        ? `${plural(result.total, 'related highlight')}; showing the ${result.hits.length} most related.`
                        : `${plural(result.total, 'related highlight')}.`}
                </p>
                {result.hits.length > 0 ? (
                  <ul className="sv-related__list" aria-label="Related highlights">
                    {result.hits.map((hit) => (
                      <RelatedItem
                        key={hit.highlightId}
                        hit={hit}
                        openLabel={openLabel}
                        onOpen={onOpen}
                        onLink={onLink}
                      />
                    ))}
                  </ul>
                ) : null}
              </>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
