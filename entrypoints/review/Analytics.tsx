import { Suspense, lazy, useMemo } from 'react';
import { RATINGS, RATING_LABELS } from '@study';
import { getAnalyticsInput } from '@storage';
import { Button, EmptyState, InlineNotice, plural, useDataEpoch, useAsync } from '@ui';
import {
  TID,
  bankRowId,
  clockKey,
  computeAnalytics,
  formatDayKey,
  formatDuration,
  formatWhen,
  percent,
  toClock,
  useTick,
  type StudySettings,
} from '@ui/review';
import { BarChart, ShareBars } from './Charts';

const HISTORY_DAYS = 365;

// The syllabus coverage table is only needed on this tab, and only its own chunk carries it.
const SyllabusCoverage = lazy(() => import('./SyllabusCoverage'));

function Coverage({ settings }: { settings: StudySettings }) {
  return (
    <Suspense fallback={<p className="sv-muted">Loading syllabus coverage…</p>}>
      <SyllabusCoverage settings={settings} />
    </Suspense>
  );
}

/**
 * Review analytics from the real database rows. A number that cannot be derived is shown as
 * "not enough data" with the reason, never as an invented value.
 */
export function Analytics({ settings }: { settings: StudySettings }) {
  const epoch = useDataEpoch();
  const tick = useTick();
  const key = clockKey(settings);
  const input = useAsync(
    () => getAnalyticsInput({ ...toClock(settings), sinceDays: HISTORY_DAYS }),
    [key],
    [epoch, tick],
  );
  const report = useMemo(() => (input.data ? computeAnalytics(input.data) : null), [input.data]);

  if (input.error) {
    return (
      <InlineNotice
        tone="error"
        title="Analytics could not be loaded"
        action={input.retryable ? <Button onClick={input.refresh}>Retry</Button> : undefined}
      >
        {input.error}
      </InlineNotice>
    );
  }
  if (!report || !input.data) return <p className="sv-muted">Loading analytics…</p>;

  const tz = input.data.boundary.timeZone;
  if (!report.hasCards && report.totalReviews === 0) {
    return (
      <div data-testid={TID.analytics}>
        <EmptyState title="No data yet">
          <span data-testid={TID.analyticsEmpty}>
            Charts appear here once you have cards and have answered some. Nothing is estimated or
            filled in before then.
          </span>
        </EmptyState>
        <Coverage settings={settings} />
      </div>
    );
  }

  const { forecast, backlog, retention, log, streak, estimated } = report;
  const forecastBars = forecast.days.map((d) => ({
    label: d.dayOffset === 0 ? `Today, ${formatDayKey(d.dayKey)}` : formatDayKey(d.dayKey),
    tick: d.dayOffset === 0 ? 'Today' : String(d.dayOffset),
    value: d.review,
    extra: d.learning,
  }));
  const forecastTotal = forecast.days.reduce((n, d) => n + d.due, 0);
  const logBars = log.map((d, i) => ({
    label: i === log.length - 1 ? `Today, ${formatDayKey(d.dayKey)}` : formatDayKey(d.dayKey),
    tick: i === log.length - 1 ? 'Today' : String(i - log.length + 1),
    value: d.reviews,
  }));
  const logTotal = log.reduce((n, d) => n + d.reviews, 0);
  const logMs = log.reduce((n, d) => n + d.durationMs, 0);

  return (
    <div className="sv-stack rv-analytics" data-testid={TID.analytics}>
      <section className="rv-stats" aria-label="At a glance">
        <div className="rv-stat">
          <span className="rv-count">{forecast.overdue + (forecast.days[0]?.due ?? 0)}</span>
          <span className="sv-small">due today (including {forecast.overdue} overdue)</span>
        </div>
        <div className="rv-stat" data-testid={TID.streak}>
          <span className="rv-count">{streak.current}</span>
          <span className="sv-small">
            day streak
            {streak.studiedToday ? '' : streak.current > 0 ? ', study today to keep it' : ''}; best{' '}
            {streak.longest}
          </span>
        </div>
        <div className="rv-stat">
          <span className="rv-count">{report.totalReviews}</span>
          <span className="sv-small">
            reviews recorded
            {report.firstReviewAt ? `, since ${formatWhen(report.firstReviewAt, tz)}` : ''}
          </span>
        </div>
        <div className="rv-stat">
          <span className="rv-count">{forecast.newAvailable}</span>
          <span className="sv-small">new cards waiting</span>
        </div>
      </section>

      <section className="sv-stack" aria-labelledby="rv-forecast-h">
        <h2 id="rv-forecast-h">Due forecast, next 30 days</h2>
        {forecast.totalCards === 0 ? (
          <p className="sv-muted">No active cards, so there is nothing to forecast.</p>
        ) : (
          <>
            <BarChart
              testId={TID.forecast}
              tableTestId={TID.forecastTable}
              title="Cards coming due each day"
              summary={`${forecastTotal} cards come due in the next 30 days; ${forecast.overdue} are already overdue and ${forecast.beyond} are scheduled later.`}
              bars={forecastBars}
              valueLabel="Reviews"
              extraLabel="Learning steps"
              tickEvery={5}
            />
            <p className="sv-small sv-muted">
              {plural(forecast.overdue, 'card')} already overdue (they are part of today),{' '}
              {plural(forecast.beyond, 'card')} scheduled beyond 30 days.
            </p>
          </>
        )}
      </section>

      <section className="sv-stack" aria-labelledby="rv-backlog-h" data-testid={TID.backlogStats}>
        <h2 id="rv-backlog-h">Backlog</h2>
        {backlog.overdue === 0 ? (
          <p>No review cards are overdue.</p>
        ) : (
          <p>
            {plural(backlog.overdue, 'review card')} overdue: the oldest by{' '}
            {plural(backlog.oldestOverdueDays ?? 0, 'day')}, the median by{' '}
            {plural(backlog.medianOverdueDays ?? 0, 'day')}. Plan a recovery from the Study view.
          </p>
        )}
        <p className="sv-small sv-muted">
          {plural(backlog.dueToday, 'review')} due later today,{' '}
          {plural(backlog.learningDue, 'learning step')} due now.
        </p>
      </section>

      <section className="sv-stack" aria-labelledby="rv-ret-h" data-testid={TID.retention}>
        <h2 id="rv-ret-h">Retention</h2>
        {retention.status === 'ok' ? (
          <p>
            <span className="rv-count">{percent(retention.trueRetention, 1)}</span> of{' '}
            {retention.matureReviews} reviews of learned cards were remembered (answered Hard, Good
            or Easy).
            {report.targetRetention
              ? ` Your decks aim for ${
                  report.targetRetention.min === report.targetRetention.max
                    ? percent(report.targetRetention.min)
                    : `${percent(report.targetRetention.min)} to ${percent(report.targetRetention.max)}`
                }.`
              : ''}
          </p>
        ) : (
          <InlineNotice tone="info" title="Not enough data yet">
            <span data-testid={TID.retentionInsufficient}>
              True retention needs at least {retention.minSamples} reviews of learned cards; you
              have {retention.matureReviews}. It is not estimated before then.
            </span>
          </InlineNotice>
        )}
        {retention.matureReviews > 0 ? (
          <ShareBars
            title="How reviews of learned cards were answered"
            rows={RATINGS.map((r) => ({
              label: RATING_LABELS[r],
              count: retention.byRating[r].count,
              share: retention.byRating[r].share,
            }))}
          />
        ) : null}
        <p className="sv-small sv-muted">
          {estimated.value === null
            ? 'The memory model has no learned cards to estimate from yet.'
            : `Estimated recall right now across ${plural(estimated.cards, 'learned card')}: ${percent(
                estimated.value,
              )}. This is the model's estimate, not a measurement.`}
        </p>
      </section>

      <section className="sv-stack" aria-labelledby="rv-log-h" data-testid={TID.studyLog}>
        <h2 id="rv-log-h">Daily study log, last 30 days</h2>
        {logTotal === 0 ? (
          <p className="sv-muted">No reviews were recorded in the last 30 days.</p>
        ) : (
          <BarChart
            title="Reviews per day"
            summary={`${logTotal} reviews on ${report.loggedDays} of the last 30 study days, about ${formatDuration(
              logMs,
            )} in total.`}
            bars={logBars}
            valueLabel="Reviews"
            tickEvery={5}
            columns={{
              header: 'New cards, passed, time',
              cells: log.map(
                (d) =>
                  `${d.newCards} new, ${d.passed} passed${
                    d.accuracy === null ? '' : ` (${percent(d.accuracy)})`
                  }, ${formatDuration(d.durationMs)}`,
              ),
            }}
          />
        )}
      </section>

      <section className="sv-stack" aria-labelledby="rv-counts-h" data-testid={TID.counts}>
        <h2 id="rv-counts-h">Cards by bank and deck</h2>
        {report.decks.length === 0 ? (
          <p className="sv-muted">There are no decks yet.</p>
        ) : (
          <div className="rv-tablewrap">
            <table className="rv-table">
              <caption className="sv-sr">Card counts by bank and deck</caption>
              <thead>
                <tr>
                  <th scope="col">Bank / deck</th>
                  <th scope="col">Cards</th>
                  <th scope="col">New</th>
                  <th scope="col">Learning</th>
                  <th scope="col">Review</th>
                  <th scope="col">Suspended</th>
                  <th scope="col">Due</th>
                  <th scope="col">Overdue</th>
                </tr>
              </thead>
              <tbody>
                {report.banks.map((b) => (
                  <BankRows
                    key={b.bankId ?? 'none'}
                    bank={b}
                    decks={report.decks.filter((d) => d.bankId === b.bankId)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {report.orphanCards > 0 ? (
          <p className="sv-small sv-muted">
            {plural(report.orphanCards, 'card')} belong to a deck that no longer exists and are not
            counted above.
          </p>
        ) : null}
      </section>

      <Coverage settings={settings} />
    </div>
  );
}

function BankRows({
  bank,
  decks,
}: {
  bank: ReturnType<typeof computeAnalytics>['banks'][number];
  decks: ReturnType<typeof computeAnalytics>['decks'];
}) {
  return (
    <>
      <tr className="rv-table__bank" data-testid={bankRowId(bank.bankId)}>
        <th scope="row">{bank.name}</th>
        <td>{bank.total}</td>
        <td>{bank.new}</td>
        <td>{bank.learning + bank.relearning}</td>
        <td>{bank.review}</td>
        <td>{bank.suspended}</td>
        <td>{bank.due}</td>
        <td>{bank.overdue}</td>
      </tr>
      {decks.map((d) => (
        <tr key={d.deckId}>
          <th scope="row" className="rv-table__deck">
            {d.name}
          </th>
          <td>{d.total}</td>
          <td>{d.new}</td>
          <td>{d.learning + d.relearning}</td>
          <td>{d.review}</td>
          <td>{d.suspended}</td>
          <td>{d.due}</td>
          <td>{d.overdue}</td>
        </tr>
      ))}
    </>
  );
}
