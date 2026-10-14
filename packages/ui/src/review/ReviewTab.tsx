import { browser } from 'wxt/browser';
import { ExternalLink, Layers, Play, Plus } from 'lucide-react';
import { NO_BANK, listBankInfos, type DueSummary } from '@storage';
import { Button } from '../Button';
import { ChunkyButton, InfoTip, VaultBuddy } from '../design';
import { InlineNotice } from '../Notice';
import { useAction, useObserved } from '../hooks';
import { plural } from '../text';
import './review.css';
import { useDueCount } from './hooks';
import { reviewPageUrl, type ReviewLink } from './links';
import { untilLabel } from './model';
import { TID, bankRowId } from './testids';
import { useNow } from './useNow';

const TOP_BANKS = 5;

/**
 * Compact review entry for the side panel (UX_DESIGN 7.2): the due count big, the new / learning /
 * review mix as chips, one yellow Start, and the banks with the most due. A session is not run in a
 * 320 px panel: distraction-free study needs room, so the buttons open the review page in a tab.
 * Styles: `.rt-*` in entrypoints/sidepanel/sidepanel.css (the panel is the only host).
 */
export function ReviewTab({
  open,
  nowMs,
}: {
  /** How to open the full page. Default: a new tab on `review.html`. Injected for tests. */
  open?: (link: ReviewLink) => Promise<void> | void;
  /** Epoch ms for the "next step in" label. Default: the device clock, read every minute. */
  nowMs?: number;
}) {
  const due = useDueCount();
  const clock = useNow();
  const now = nowMs ?? clock;
  const banks = useObserved(() => listBankInfos(), []);
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
  const bankById = new Map((banks.data ?? []).map((b) => [b.id, b]));
  const rows = Object.entries(summary.byBank)
    .filter(([, g]) => g.total > 0)
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, TOP_BANKS);

  const nothingAtAll = total.total === 0 && deferred === 0 && summary.nextLearningAt === null;
  // aria-busy buttons still click: one tab per press.
  const run = (link: ReviewLink) => {
    if (!go.busy) void go.run(link);
  };
  const start = () => run({ view: 'study', start: true });

  return (
    <div className="sv-stack" data-testid={TID.tab}>
      {go.error ? (
        <InlineNotice tone="error" title="Could not open the review page">
          {go.error}
        </InlineNotice>
      ) : null}

      {total.total > 0 || due.resumable ? (
        <section className="rt-hero" aria-label="Due today">
          <VaultBuddy pose="think" size={72} />
          <p className="rt-num">
            <span data-testid={TID.tabCount}>{total.total}</span>{' '}
            <span className="rt-num__unit">due</span>
          </p>
          <ul className="rt-mix" aria-label="Due mix">
            <li className="rt-chip rt-chip--new">{total.new} new</li>
            <li className="rt-chip rt-chip--learn">{total.learning} learning</li>
            <li className="rt-chip rt-chip--review">{total.review} review</li>
          </ul>
          {deferred > 0 ? (
            <p className="rt-deferred" data-testid={TID.deferredNote}>
              <span>+{plural(deferred, 'more card')} over today&rsquo;s limit</span>
              <InfoTip label="About cards over the limit" side="top">
                {`${summary.deferred.review} reviews and ${summary.deferred.new} new stay due for later days. None are skipped.`}
              </InfoTip>
            </p>
          ) : null}
          {due.resumable ? (
            <ChunkyButton
              variant="sun"
              size="lg"
              block
              icon={Play}
              data-testid={TID.tabContinue}
              aria-busy={go.busy || undefined}
              onClick={start}
            >
              Continue session ({due.resumable.remaining} left)
            </ChunkyButton>
          ) : (
            <ChunkyButton
              variant="sun"
              size="lg"
              block
              icon={Layers}
              data-testid={TID.tabStart}
              aria-busy={go.busy || undefined}
              onClick={start}
            >
              Start review
            </ChunkyButton>
          )}
        </section>
      ) : nothingAtAll ? (
        <section className="rt-hero rt-hero--quiet" aria-labelledby="rt-empty-title">
          <VaultBuddy pose="sleep" size={112} />
          <h3 id="rt-empty-title" className="rt-title">
            No cards yet
          </h3>
          <p className="rt-line" data-testid={TID.tabEmpty}>
            Turn a highlight into a flashcard.
          </p>
          <ChunkyButton
            variant="primary"
            icon={Plus}
            data-testid={TID.tabCreate}
            aria-busy={go.busy || undefined}
            onClick={() => run({ view: 'create' })}
          >
            Create cards
          </ChunkyButton>
        </section>
      ) : (
        <section className="rt-hero rt-hero--quiet" aria-labelledby="rt-done-title">
          <VaultBuddy pose="cheer" size={112} />
          <h3 id="rt-done-title" className="rt-title">
            All caught up
          </h3>
          <p className="rt-line" data-testid={TID.nextLearning}>
            {summary.nextLearningAt
              ? `Next step ${untilLabel(summary.nextLearningAt, now)}.`
              : 'Nothing is due right now.'}
          </p>
          {deferred > 0 ? (
            <p className="rt-deferred" data-testid={TID.deferredNote}>
              +{plural(deferred, 'more card')} over today&rsquo;s limit
            </p>
          ) : null}
        </section>
      )}

      {rows.length > 0 ? (
        <section className="sv-stack sv-stack--tight" aria-labelledby="rt-banks">
          <h3 id="rt-banks" className="rt-h">
            By bank
          </h3>
          <ul className="rt-banks" aria-label="Due by bank">
            {rows.map(([key, g]) => {
              const bank = key === NO_BANK ? undefined : bankById.get(key);
              const name = key === NO_BANK ? 'No bank' : (bank?.name ?? 'Bank');
              return (
                <li
                  key={key}
                  className="rt-row"
                  data-testid={bankRowId(key === NO_BANK ? null : key)}
                >
                  <span className={`rt-tile sp-sw--${bank?.color ?? 'none'}`} aria-hidden="true">
                    {bank?.icon ?? (Array.from(name.trim())[0] ?? '?').toUpperCase()}
                  </span>
                  <span className="rt-row__name sv-wrap" dir="auto">
                    {name}
                  </span>
                  <span className="rt-row__n">{g.total}</span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <div>
        <ChunkyButton
          variant="ghost"
          size="sm"
          iconEnd={ExternalLink}
          data-testid={TID.tabOpen}
          aria-busy={go.busy || undefined}
          onClick={() => run({ view: 'study' })}
        >
          Open review page
        </ChunkyButton>
      </div>
    </div>
  );
}
