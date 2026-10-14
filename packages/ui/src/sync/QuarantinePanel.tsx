import { useId, useState } from 'react';
import { Ban } from 'lucide-react';
import { RETRYABLE_REASONS, type QuarantinedOp } from '@sync';
import { Badge } from '../Badge';
import { Button } from '../Button';
import { EmptyState } from '../design/EmptyState';
import { InfoTip } from '../design/InfoTip';
import { InlineNotice } from '../Notice';
import { useAction, useAsync } from '../hooks';
import { useSyncApi } from './api';
import { REASON_TEXT, entityLabel } from './labels';

const LOCAL_PREFIX = 'local:';

function Item({
  item,
  onDismiss,
  busy,
}: {
  item: QuarantinedOp;
  onDismiss(): void;
  busy: boolean;
}) {
  const local = item.id.startsWith(LOCAL_PREFIX);
  return (
    <li className="sv-sync-item sd-stack" data-testid={`quarantine-item-${item.id}`}>
      <div className="sd-row">
        <strong>{entityLabel(item.entityType)}</strong>
        <Badge tone={local ? 'info' : 'warning'}>
          {local ? 'Kept on this device only' : 'From the server'}
        </Badge>
        {RETRYABLE_REASONS.has(item.reason) ? <Badge tone="info">May work later</Badge> : null}
      </div>
      <p className="sv-sync-item__text">{REASON_TEXT[item.reason]}</p>
      {item.detail ? <p className="sd-line">{item.detail}</p> : null}
      <p className="sd-line">
        {new Date(item.at).toLocaleString()}
        {item.entityId ? ` · ${item.entityId}` : ''}
      </p>
      <div className="sd-row">
        <Button busy={busy} data-testid="quarantine-dismiss" onClick={onDismiss}>
          {local ? 'Dismiss this note' : 'Ignore it on this device'}
        </Button>
      </div>
    </li>
  );
}

/**
 * Changes that were not exchanged, with the reason: remote operations this version refused, and
 * local rows that could not be sent. Nothing is applied half-understood and nothing is dropped
 * without being listed here.
 */
export function QuarantinePanel({ refreshKey = 0 }: { refreshKey?: number | string }) {
  const api = useSyncApi();
  const headingId = useId();
  const [said, setSaid] = useState('');
  const list = useAsync(() => api.listQuarantine(), [], [refreshKey]);
  const items = list.data ?? [];
  const canRetry = items.some(
    (i) => RETRYABLE_REASONS.has(i.reason) && !i.id.startsWith(LOCAL_PREFIX),
  );

  const retry = useAction(async () => {
    const { retried, remaining } = await api.retryQuarantine();
    setSaid(
      retried > 0
        ? `${retried} change${retried === 1 ? ' was' : 's were'} applied. ${remaining} remain.`
        : 'Nothing could be applied yet.',
    );
    list.refresh();
  });
  const dismiss = useAction(async (id: string) => {
    await api.discardQuarantined(id);
    setSaid('Dismissed.');
    list.refresh();
  });

  return (
    <section className="sd-card" aria-labelledby={headingId} data-testid="quarantine-panel">
      <div className="sd-row">
        <span className="sd-tile sd-tile--sm sv-art--neutral" aria-hidden="true">
          <Ban strokeWidth={2.4} />
        </span>
        <h3 id={headingId} className="sd-card__title sd-grow">
          Not exchanged{items.length > 0 ? ` (${items.length})` : ''}
        </h3>
        <InfoTip label="About changes not exchanged" align="end">
          Changes that were refused or could not be sent, and why. Your own data is never changed by
          a refused change.
        </InfoTip>
      </div>
      <p role="status" className="sv-sr">
        {said}
      </p>
      {list.error ? (
        <InlineNotice
          tone="error"
          title="Could not read the list"
          action={<Button onClick={list.reload}>Retry</Button>}
        >
          {list.error}
        </InlineNotice>
      ) : list.loading ? (
        <p className="sd-line">Loading&hellip;</p>
      ) : items.length === 0 ? (
        <EmptyState
          pose="sleep"
          mascotSize={56}
          heading="h4"
          title="Nothing was refused"
          text="Every change was exchanged or applied."
          className="sv-sync-empty"
        />
      ) : (
        <>
          <div className="sd-row">
            <Button
              busy={retry.busy}
              data-testid="quarantine-retry"
              disabledReason={canRetry ? undefined : 'None of these can succeed by trying again.'}
              onClick={() => void retry.run()}
            >
              Try the ones that may work now
            </Button>
          </div>
          {retry.error ? (
            <InlineNotice tone="error" title="Could not retry">
              {retry.error}
            </InlineNotice>
          ) : null}
          {dismiss.error ? (
            <InlineNotice tone="error" title="Could not dismiss">
              {dismiss.error}
            </InlineNotice>
          ) : null}
          <ul className="sd-stack sv-sync-list">
            {items.map((item) => (
              <Item
                key={item.id}
                item={item}
                busy={dismiss.busy}
                onDismiss={() => void dismiss.run(item.id)}
              />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
