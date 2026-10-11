import { useEffect, useRef } from 'react';
import { Button, EmptyState, InlineNotice, errorMessage, plural, useToast } from '@ui';
import { useApi } from './api';
import { formatDate } from './format';
import { useBump, useVaultQuery } from './hooks';
import { webSourceHref } from './links';
import { useTreeData } from './treeData';

/**
 * Highlights that carry exactly the same quote. Nothing here merges or deletes on its own: every
 * copy is a real highlight with its own notes and place, and the user decides per copy.
 */
export function DuplicatesView({
  focusHighlightId,
  onShow,
}: {
  focusHighlightId: string | null;
  onShow(highlightId: string): void;
}) {
  const api = useApi();
  const bump = useBump();
  const toast = useToast();
  const data = useTreeData();
  const clusters = useVaultQuery(() => api.findDuplicateClusters({ limit: 200 }), []);
  const focusRef = useRef<HTMLLIElement | null>(null);
  const focusKey = clusters.data?.find((c) =>
    c.members.some((m) => m.highlightId === focusHighlightId),
  )?.quoteHash;

  useEffect(() => {
    focusRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [focusKey, clusters.data]);

  const bankName = (id: string) => data.banks.find((b) => b.id === id)?.name ?? 'Unknown bank';

  const trash = async (highlightId: string) => {
    try {
      await api.softDeleteHighlight(highlightId);
      bump();
      clusters.refresh();
      toast.push({
        message: 'Moved this copy to the trash.',
        action: {
          label: 'Undo',
          onClick: () => {
            void api.restoreHighlight(highlightId).then(
              () => {
                bump();
                clusters.refresh();
              },
              (err: unknown) =>
                toast.push({ tone: 'error', message: errorMessage(err, 'Could not restore.') }),
            );
          },
        },
      });
    } catch (err) {
      toast.push({ tone: 'error', message: errorMessage(err, 'Could not move it to the trash.') });
    }
  };

  if (clusters.loading)
    return (
      <p className="sv-muted dash-loading" role="status">
        Looking for duplicates…
      </p>
    );
  if (clusters.error) {
    return (
      <InlineNotice
        tone="error"
        title="Could not look for duplicates"
        action={<Button onClick={clusters.refresh}>Try again</Button>}
      >
        {clusters.error}
      </InlineNotice>
    );
  }
  const list = clusters.data ?? [];

  return (
    <section className="dash-panel" aria-labelledby="dups-title" data-testid="duplicates-view">
      <h2 id="dups-title">Duplicate quotes</h2>
      <p className="sv-small sv-muted">
        These highlights have exactly the same text. Keeping several is fine (each may sit in a
        different bank with its own notes). Nothing is merged or removed unless you choose to.
      </p>
      {list.length === 0 ? (
        <EmptyState title="No duplicates found">
          Every saved quote is unique across your vault.
        </EmptyState>
      ) : (
        <ul className="sv-stack" data-testid="duplicate-clusters">
          {list.map((cluster) => (
            <li
              key={cluster.quoteHash}
              ref={cluster.quoteHash === focusKey ? focusRef : undefined}
              className="dash-cluster"
              data-testid="duplicate-cluster"
              aria-current={cluster.quoteHash === focusKey ? 'true' : undefined}
            >
              <blockquote className="sv-quote" dir="auto">
                {cluster.quote}
              </blockquote>
              <p className="sv-small sv-muted">
                Saved {plural(cluster.members.length, 'time')} from{' '}
                {plural(cluster.sourceCount, 'source')}
              </p>
              <ul className="sv-stack sv-stack--tight">
                {cluster.members.map((m) => {
                  const href =
                    m.sourceType === 'web'
                      ? webSourceHref(m.originalUrl, cluster.quote)
                      : undefined;
                  return (
                    <li
                      key={m.highlightId}
                      className="sv-row dash-member"
                      data-testid="duplicate-member"
                    >
                      <span className="sv-grow sv-wrap" dir="auto">
                        <strong>{m.sourceTitle || m.host || 'Untitled'}</strong>
                        <span className="sv-small sv-muted">
                          {m.pageNumber ? ` · page ${m.pageNumber}` : ''} ·{' '}
                          {formatDate(m.capturedAt)}
                          {m.bankIds.length > 0 ? ` · ${m.bankIds.map(bankName).join(', ')}` : ''}
                        </span>
                      </span>
                      <Button onClick={() => onShow(m.highlightId)}>Show in library</Button>
                      {href ? (
                        <a className="sv-btn" href={href} target="_blank" rel="noopener noreferrer">
                          Open source
                        </a>
                      ) : null}
                      <Button
                        variant="danger"
                        onClick={() => void trash(m.highlightId)}
                        data-testid="duplicate-trash"
                      >
                        Move this copy to trash
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}
      {list.length >= 200 ? (
        <p className="sv-small sv-muted">Showing the first 200 groups.</p>
      ) : null}
    </section>
  );
}
