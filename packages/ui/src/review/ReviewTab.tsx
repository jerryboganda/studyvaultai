import { browser } from 'wxt/browser';
import { NO_BANK, listBanks, type DueSummary } from '@storage';
import { Button } from '../Button';
import { EmptyState, InlineNotice } from '../Notice';
import { useAction, useObserved } from '../hooks';
import { plural } from '../text';
import './review.css';
import { useDueCount } from './hooks';
import { reviewPageUrl, type ReviewLink } from './links';
import { untilLabel } from './model';
import { TID, bankRowId } from './testids';

const TOP_BANKS = 5;

/**
 * Compact review entry for the side panel: what is due today, start or continue, and a way into the
 * full review page. A session is not run in a 320 px panel: distraction-free study needs room, so
 * the buttons open the review page in a tab.
 */
export function ReviewTab({
  open,
  nowMs,
}: {
  /** How to open the full page. Default: a new tab on `review.html`. Injected for tests. */
  open?: (link: ReviewLink) => Promise<void> | void;
  /** Epoch ms for the "next step in" label. Default: the device clock. */
  nowMs?: number;
}) {
  const due = useDueCount();
  const banks = useObserved(() => listBanks(), []);
  const go = useAction(async (link: ReviewLink) => {
    if (open) {
      await open(link);
      return;
    }
    await browser.tabs.create({ url: reviewPageUrl(link) });
  });

  if (due.error) {
    return (
      <div className="sv-stack" data-testid={TID.tab}>
        <InlineNotice
          tone="error"
          title="Review could not be loaded"
          action={due.retryable ? <Button onClick={due.refresh}>Retry</Button> : undefined}
        >
          {due.error}
        </InlineNotice>
      </div>
    );
  }
  if (due.loading || !due.summary) {
    return (
      <p className="sv-muted" data-testid={TID.tab}>
        Loading review…
      </p>
    );
  }
  const summary: DueSummary = due.summary;
  const total = summary.total;
  const deferred = summary.deferred.review + summary.deferred.new;
  const bankName = new Map((banks.data ?? []).map((b) => [b.id, b.name]));
  const rows = Object.entries(summary.byBank)
    .filter(([, g]) => g.total > 0)
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, TOP_BANKS);

  const nothingAtAll = total.total === 0 && deferred === 0 && summary.nextLearningAt === null;

  return (
    <div className="sv-stack" data-testid={TID.tab}>
      {go.error ? (
        <InlineNotice tone="error" title="Could not open the review page">
          {go.error}
        </InlineNotice>
      ) : null}

      {total.total > 0 ? (
        <section className="sv-stack sv-stack--tight" aria-label="Due today">
          <p>
            <span className="rv-count" data-testid={TID.tabCount}>
              {total.total}
            </span>{' '}
            <span>{total.total === 1 ? 'card' : 'cards'} to study now</span>
          </p>
          <p className="sv-small sv-muted">
            {plural(total.new, 'new card')}, {plural(total.learning, 'learning step')},{' '}
            {plural(total.review, 'review')}
          </p>
        </section>
      ) : nothingAtAll ? (
        <EmptyState
          title="No cards to review yet"
          action={
            <Button
              data-testid={TID.tabCreate}
              onClick={() => void go.run({ view: 'create' })}
              busy={go.busy}
            >
              Create cards
            </Button>
          }
        >
          <span data-testid={TID.tabEmpty}>
            Turn a saved highlight into a flashcard to start spaced review.
          </span>
        </EmptyState>
      ) : (
        <InlineNotice tone="success" title="Nothing is due right now">
          {summary.nextLearningAt && nowMs !== undefined
            ? `The next learning step comes back ${untilLabel(summary.nextLearningAt, nowMs)}.`
            : summary.nextLearningAt
              ? 'A learning step comes back later today.'
              : 'You are caught up for today.'}
        </InlineNotice>
      )}

      {deferred > 0 ? (
        <p className="sv-small sv-muted" data-testid={TID.deferredNote}>
          {plural(deferred, 'more card')} due but beyond today&rsquo;s limits (
          {summary.deferred.review} reviews, {summary.deferred.new} new). They stay due and are not
          skipped.
        </p>
      ) : null}

      {due.resumable ? (
        <Button
          variant="primary"
          data-testid={TID.tabContinue}
          busy={go.busy}
          onClick={() => void go.run({ view: 'study', start: true })}
        >
          Continue session ({due.resumable.remaining} left)
        </Button>
      ) : total.total > 0 ? (
        <Button
          variant="primary"
          data-testid={TID.tabStart}
          busy={go.busy}
          onClick={() => void go.run({ view: 'study', start: true })}
        >
          Start reviewing
        </Button>
      ) : null}

      {rows.length > 0 ? (
        <ul className="sv-stack sv-stack--tight" aria-label="Due by bank">
          {rows.map(([key, g]) => (
            <li key={key} className="rv-row" data-testid={bankRowId(key === NO_BANK ? null : key)}>
              <span className="sv-grow sv-wrap">
                {key === NO_BANK ? 'No bank' : (bankName.get(key) ?? 'Bank')}
              </span>
              <span>{g.total}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="sv-row">
        <Button
          variant="ghost"
          data-testid={TID.tabOpen}
          busy={go.busy}
          onClick={() => void go.run({ view: 'study' })}
        >
          Open full review page
        </Button>
      </div>
    </div>
  );
}
