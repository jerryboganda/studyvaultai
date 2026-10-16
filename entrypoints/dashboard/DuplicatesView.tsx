import { useEffect, useRef, type ReactNode } from 'react';
import {
  BadgeCheck,
  Calendar,
  Copy,
  ExternalLink,
  FileText,
  Globe,
  Library,
  Trash,
} from 'lucide-react';
import { BuddyEmptyState, ChunkyButton, InlineNotice, errorMessage, plural, useToast } from '@ui';
import { useApi } from './api';
import { formatDate } from './format';
import { useBump, useVaultQuery } from './hooks';
import { webSourceHref } from './links';
import { Chip, IconAction, IconLink, Loading, ViewHead } from './moreKit';
import { useTreeData } from './treeData';

/**
 * Highlights that carry exactly the same quote, each group with its copies side by side. Nothing
 * here merges or deletes on its own: every copy is a real highlight with its own notes and place.
 * The person moves one copy to the trash, or keeps one and moves the others, always with Undo.
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

  /** Move copies to the trash; Undo restores every one of them. */
  const trash = async (ids: string[], message: string) => {
    const done: string[] = [];
    const undo = {
      label: 'Undo',
      onClick: () => {
        void Promise.all(done.map((id) => api.restoreHighlight(id))).then(
          () => {
            bump();
            clusters.refresh();
          },
          (err: unknown) =>
            toast.push({ tone: 'error', message: errorMessage(err, 'Could not restore.') }),
        );
      },
    };
    try {
      for (const id of ids) {
        await api.softDeleteHighlight(id);
        done.push(id);
      }
      // The card that held the focus is gone: the keyboard goes to Undo.
      toast.push({ message, action: undo, focusAction: true });
    } catch (err) {
      // Copies already moved before the failure can still be put back.
      toast.push({
        tone: 'error',
        message: errorMessage(err, 'Could not move it to the trash.'),
        ...(done.length > 0 ? { action: undo } : {}),
      });
    } finally {
      if (done.length > 0) {
        bump();
        clusters.refresh();
      }
    }
  };

  const list = clusters.data ?? [];
  const head: ReactNode = (
    <ViewHead
      icon={Copy}
      tone="warning"
      title="Duplicates"
      titleId="dups-title"
      info="These highlights have exactly the same text. Keeping several is fine: each may sit in another bank with its own notes. Nothing is removed unless you choose to."
      {...(list.length > 0 ? { count: plural(list.length, 'group') } : {})}
    />
  );

  // The title stays put while the search runs or fails, so the page does not jump.
  if (clusters.loading || clusters.error) {
    return (
      <section className="dash-panel mv-view" aria-labelledby="dups-title">
        {head}
        {clusters.loading ? (
          <Loading>Looking for duplicates…</Loading>
        ) : (
          <InlineNotice
            tone="error"
            title="Could not look for duplicates"
            action={
              <ChunkyButton size="sm" onClick={clusters.refresh}>
                Try again
              </ChunkyButton>
            }
          >
            {clusters.error}
          </InlineNotice>
        )}
      </section>
    );
  }

  return (
    <section
      className="dash-panel mv-view"
      aria-labelledby="dups-title"
      data-testid="duplicates-view"
    >
      {head}
      {list.length === 0 ? (
        <BuddyEmptyState pose="sleep" title="No duplicates found" text="Every quote is unique." />
      ) : (
        <ul className="mv-list" data-testid="duplicate-clusters">
          {list.map((cluster) => (
            <li
              key={cluster.quoteHash}
              ref={cluster.quoteHash === focusKey ? focusRef : undefined}
              className="mv-card dup-cluster"
              data-testid="duplicate-cluster"
              aria-current={cluster.quoteHash === focusKey ? 'true' : undefined}
            >
              <blockquote className="mv-quote" dir="auto">
                {cluster.quote}
              </blockquote>
              <p className="mv-row">
                <Chip icon={Copy} tone="warning">
                  {plural(cluster.members.length, 'copy', 'copies')}
                </Chip>
                <Chip icon={Globe}>{plural(cluster.sourceCount, 'source')}</Chip>
              </p>
              <ul className="dup-copies">
                {cluster.members.map((m, i) => {
                  const href =
                    m.sourceType === 'web'
                      ? webSourceHref(m.originalUrl, cluster.quote)
                      : undefined;
                  const title = m.sourceTitle || m.host || 'Untitled';
                  const others = cluster.members
                    .filter((o) => o.highlightId !== m.highlightId)
                    .map((o) => o.highlightId);
                  return (
                    <li key={m.highlightId} className="dup-copy" data-testid="duplicate-member">
                      <span className="dup-copy__badge" aria-hidden="true">
                        {i + 1}
                      </span>
                      <strong className="mv-wrap" dir="auto">
                        {title}
                      </strong>
                      <span className="mv-row">
                        {m.host && m.host !== title ? (
                          <Chip icon={Globe} prefix="Site">
                            {m.host}
                          </Chip>
                        ) : null}
                        {m.pageNumber ? (
                          <Chip icon={FileText} prefix="Page">
                            {`p. ${m.pageNumber}`}
                          </Chip>
                        ) : null}
                        <Chip icon={Calendar} prefix="Saved">
                          {formatDate(m.capturedAt)}
                        </Chip>
                        {m.bankIds.map((id) => (
                          <Chip key={id} icon={Library} tone="primary" prefix="Bank">
                            {bankName(id)}
                          </Chip>
                        ))}
                      </span>
                      <span className="dup-copy__actions">
                        <ChunkyButton
                          size="sm"
                          variant="primary"
                          icon={BadgeCheck}
                          data-testid="duplicate-keep"
                          aria-label={`Keep this one: ${title}`}
                          onClick={() =>
                            void trash(
                              others,
                              `Kept one copy. Moved ${plural(others.length, 'copy', 'copies')} to the trash.`,
                            )
                          }
                        >
                          Keep this one
                        </ChunkyButton>
                        <span className="dup-copy__icons">
                          <IconAction
                            icon={Library}
                            label="Show in library"
                            onClick={() => onShow(m.highlightId)}
                          />
                          {href ? (
                            <IconLink icon={ExternalLink} label="Open source" href={href} />
                          ) : null}
                          <IconAction
                            icon={Trash}
                            className="mv-ibtn--danger"
                            label="Move this copy to trash"
                            tipSide="left"
                            data-testid="duplicate-trash"
                            onClick={() =>
                              void trash([m.highlightId], 'Moved this copy to the trash.')
                            }
                          />
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}
      {list.length >= 200 ? <p className="mv-line">Showing the first 200 groups.</p> : null}
    </section>
  );
}
