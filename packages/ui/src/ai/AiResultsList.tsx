import './ai.css';
import { listAiResults } from '@storage';
import { useObserved } from '../hooks';
import { EmptyState, InlineNotice } from '../Notice';
import { Button } from '../Button';
import { AiResultCard } from './AiResultCard';

export interface AiResultsListProps {
  /** Only results that used one of these highlights. Omit for all results. */
  highlightIds?: readonly string[];
  limit?: number;
}

/** Stored AI drafts, newest first, live: they update when anything is accepted, discarded or run. */
export function AiResultsList({ highlightIds, limit = 20 }: AiResultsListProps) {
  const key = highlightIds ? highlightIds.join(',') : '*';
  const results = useObserved(
    () => listAiResults({ ...(highlightIds ? { highlightIds } : {}), limit }),
    [key, limit],
  );
  if (results.error) {
    return (
      <InlineNotice
        tone="error"
        title="Could not read AI drafts"
        action={results.retryable ? <Button onClick={results.refresh}>Retry</Button> : undefined}
      >
        {results.error}
      </InlineNotice>
    );
  }
  if (results.loading) return <p className="sv-muted">Loading AI drafts…</p>;
  const rows = results.data ?? [];
  if (rows.length === 0) {
    return (
      <EmptyState title="No AI drafts yet">
        Drafts you ask for appear here, labelled unverified, until you accept or discard them.
      </EmptyState>
    );
  }
  return (
    <ul className="ai-list" data-testid="ai-results">
      {rows.map((r) => (
        <li key={r.id}>
          <AiResultCard result={r} />
        </li>
      ))}
    </ul>
  );
}
