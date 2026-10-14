import { Suspense, lazy, useMemo } from 'react';
import {
  CalendarCheck,
  CalendarClock,
  CalendarDays,
  ChartColumn,
  Check,
  Feather,
  Hourglass,
  Inbox,
  Layers,
  ListChecks,
  Plus,
  RotateCcw,
  Target,
  TriangleAlert,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { RATINGS, RATING_LABELS, type Rating } from '@study';
import { getAnalyticsInput } from '@storage';
import {
  BarMeter,
  Button,
  Heatmap,
  InlineNotice,
  ProgressRing,
  plural,
  useDataEpoch,
  useAsync,
  type ArtTone,
} from '@ui';
import { useGame } from '@ui/game';
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
  type ExamTarget,
  type StudySettings,
} from '@ui/review';
import { BarChart, ShareBars, TableToggle, type ShareTone } from './Charts';
import { Empty, LinkButton, Loading, Panel, Pill } from './ManageKit';

const HISTORY_DAYS = 365;

// The syllabus coverage table is only needed on this tab, and only its own chunk carries it.
const SyllabusCoverage = lazy(() => import('./SyllabusCoverage'));

/** One icon and tone per rating, as on the rating buttons (UX_DESIGN 4). */
const RATING_LOOK: Record<Rating, { icon: LucideIcon; tone: ShareTone }> = {
  1: { icon: RotateCcw, tone: 'danger' },
  2: { icon: Hourglass, tone: 'warning' },
  3: { icon: Check, tone: 'success' },
  4: { icon: Feather, tone: 'violet' },
};

function Coverage({
  settings,
  onExamOnTopic,
}: {
  settings: StudySettings;
  onExamOnTopic?: ((target: ExamTarget) => void) | undefined;
}) {
  return (
    <Suspense fallback={<Loading>Loading coverage…</Loading>}>
      <SyllabusCoverage settings={settings} onExamOnTopic={onExamOnTopic} />
    </Suspense>
  );
}

function Tile({
  icon: Icon,
  tone,
  value,
  label,
  testId,
}: {
  icon: LucideIcon;
  tone: ArtTone;
  value: number;
  label: string;
  testId?: string;
}) {
  return (
    <div className="rv-stat rvm-tile" data-testid={testId}>
      <span className={`rvm-art rvm-art--lg sv-art--${tone}`} aria-hidden="true">
        <Icon strokeWidth={2.4} />
      </span>
      <span className="rv-count">{value}</span>
      <span className="sv-small">{label}</span>
    </div>
  );
}

/**
 * Review analytics from the real database rows. A number that cannot be derived is shown as
 * "not enough data" with the reason, never as an invented value.
 */
export function Analytics({
  settings,
  onExamOnTopic,
}: {
  settings: StudySettings;
  /** Opens the exam setup on a syllabus topic; without it the table has no such button. */
  onExamOnTopic?: ((target: ExamTarget) => void) | undefined;
}) {
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
        title="Stats could not load"
        action={input.retryable ? <Button onClick={input.refresh}>Retry</Button> : undefined}
      >
        {input.error}
      </InlineNotice>
    );
  }
  if (!report || !input.data) return <Loading>Loading stats…</Loading>;

  const tz = input.data.boundary.timeZone;
  if (!report.hasCards && report.totalReviews === 0) {
    return (
      <div className="rvm" data-testid={TID.analytics}>
        <Empty
          title="No stats yet"
          line={
            <span data-testid={TID.analyticsEmpty}>
              Charts appear once you make and answer cards.
            </span>
          }
        >
          <LinkButton href="?view=create" icon={Plus}>
            Create cards
          </LinkButton>
        </Empty>
        <Coverage settings={settings} onExamOnTopic={onExamOnTopic} />
      </div>
    );
  }

  const { forecast, backlog, retention, log, streak, estimated } = report;
  const forecastBars = forecast.days.map((d) => ({
    label: d.dayOffset === 0 ? `Today, ${formatDayKey(d.dayKey)}` : formatDayKey(d.dayKey),
    tick: d.dayOffset === 0 ? 'Today' : `in ${d.dayOffset}d`,
    value: d.review,
    extra: d.learning,
  }));
  const forecastTotal = forecast.days.reduce((n, d) => n + d.due, 0);
  const logBars = log.map((d, i) => ({
    label: i === log.length - 1 ? `Today, ${formatDayKey(d.dayKey)}` : formatDayKey(d.dayKey),
    tick: i === log.length - 1 ? 'Today' : `${log.length - 1 - i}d ago`,
    value: d.reviews,
  }));
  const logTotal = log.reduce((n, d) => n + d.reviews, 0);
  const logMs = log.reduce((n, d) => n + d.durationMs, 0);
  const target = report.targetRetention
    ? report.targetRetention.min === report.targetRetention.max
      ? percent(report.targetRetention.min)
      : `${percent(report.targetRetention.min)}-${percent(report.targetRetention.max)}`
    : null;

  return (
    <div className="rvm rv-analytics" data-testid={TID.analytics}>
      <section className="rvm-tiles" aria-label="At a glance">
        <Tile
          icon={CalendarClock}
          tone="primary"
          value={forecast.overdue + (forecast.days[0]?.due ?? 0)}
          label={forecast.overdue > 0 ? `Due today · ${forecast.overdue} overdue` : 'Due today'}
        />
        <Tile
          icon={CalendarCheck}
          tone="sun"
          value={streak.current}
          label={`Study days · best ${streak.longest}`}
          testId={TID.streak}
        />
        <Tile icon={ListChecks} tone="success" value={report.totalReviews} label="Reviews done" />
        <Tile icon={Inbox} tone="violet" value={forecast.newAvailable} label="New waiting" />
      </section>

      <div className="rvm-grid2">
        <Panel
          icon={Target}
          tone="success"
          title="Retention"
          testId={TID.retention}
          tip={`Reviews of learned cards answered Hard, Good or Easy. Shown from ${retention.minSamples} such reviews; nothing is estimated before then.`}
        >
          {retention.status === 'ok' && retention.trueRetention !== null ? (
            <div className="rvm-ringrow">
              <ProgressRing
                value={Math.round(retention.trueRetention * 1000) / 10}
                max={100}
                label="Retention"
                unit="%"
                tone="success"
                size={112}
                stroke={12}
              >
                <span className="rv-count">{percent(retention.trueRetention, 1)}</span>
              </ProgressRing>
              <div className="rvm-ringrow__text">
                <p className="rvm-line">
                  of {retention.matureReviews} reviews of learned cards were remembered
                </p>
                {target ? (
                  <span>
                    <Pill icon={Target} tone="primary">
                      Target {target}
                    </Pill>
                  </span>
                ) : null}
              </div>
            </div>
          ) : (
            <InlineNotice tone="info" title="Not enough data">
              <span data-testid={TID.retentionInsufficient}>
                Needs {retention.minSamples} reviews of learned cards; you have{' '}
                {retention.matureReviews}.
              </span>
            </InlineNotice>
          )}
          {retention.matureReviews > 0 ? (
            <ShareBars
              title="Answers on learned cards"
              rows={RATINGS.map((r) => ({
                label: RATING_LABELS[r],
                count: retention.byRating[r].count,
                share: retention.byRating[r].share,
                ...RATING_LOOK[r],
              }))}
            />
          ) : null}
          <p className="rvm-line">
            {estimated.value === null
              ? 'No model estimate yet.'
              : `Model estimate now: ${percent(estimated.value)} (${plural(estimated.cards, 'card')})`}
          </p>
        </Panel>

        <Panel
          icon={TriangleAlert}
          tone={backlog.overdue === 0 ? 'success' : 'warning'}
          title="Backlog"
          testId={TID.backlogStats}
          tip="Review cards whose due day has passed. The Study view can spread them over the next days."
        >
          {backlog.overdue === 0 ? (
            <p className="rvm-ringrow">
              <span className="rvm-big">0</span>
              <span className="rvm-line">overdue reviews</span>
            </p>
          ) : (
            <>
              <p className="rvm-ringrow">
                <span className="rvm-big">{backlog.overdue}</span>
                <span className="rvm-line">overdue reviews</span>
              </p>
              <div className="rvm-badges">
                <Pill icon={Hourglass} tone="warning">
                  Oldest {plural(backlog.oldestOverdueDays ?? 0, 'day')}
                </Pill>
                <Pill tone="warning">Median {plural(backlog.medianOverdueDays ?? 0, 'day')}</Pill>
              </div>
              <div>
                {/* The planner lives in the Study view. */}
                <LinkButton href="?view=study" variant="secondary" icon={CalendarCheck}>
                  Plan recovery
                </LinkButton>
              </div>
            </>
          )}
          <div className="rvm-badges">
            <Pill icon={CalendarClock}>{backlog.dueToday} later today</Pill>
            <Pill icon={Layers}>{plural(backlog.learningDue, 'learning step')} now</Pill>
          </div>
        </Panel>
      </div>

      <Panel
        icon={CalendarClock}
        title="Due forecast"
        tip="Cards coming due on each of the next 30 study days. Overdue cards count as today."
      >
        {forecast.totalCards === 0 ? (
          <p className="rvm-line">No active cards to forecast.</p>
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
            <div className="rvm-badges">
              <Pill icon={TriangleAlert} tone={forecast.overdue > 0 ? 'warning' : undefined}>
                {forecast.overdue} overdue
              </Pill>
              <Pill icon={CalendarDays}>{forecast.beyond} after 30 days</Pill>
            </div>
          </>
        )}
      </Panel>

      <Panel
        icon={ChartColumn}
        tone="violet"
        title="Daily reviews"
        testId={TID.studyLog}
        tip="Answers per study day over the last 30 days, with new cards, passed answers and time in the table."
      >
        {logTotal === 0 ? (
          <p className="rvm-line">No reviews in the last 30 days.</p>
        ) : (
          <BarChart
            title="Reviews per day"
            summary={`${logTotal} reviews on ${report.loggedDays} of the last 30 study days, about ${formatDuration(
              logMs,
            )} in total.`}
            bars={logBars}
            valueLabel="Reviews"
            tickEvery={5}
            tickFromEnd
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
        {report.firstReviewAt ? (
          <p className="rvm-line">First review {formatWhen(report.firstReviewAt, tz)}</p>
        ) : null}
      </Panel>

      <StudyCalendar />

      <Panel
        icon={Layers}
        title="Cards by deck"
        testId={TID.counts}
        tip="Active cards per bank and deck. Due counts review cards due today and learning steps due now."
      >
        {report.decks.length === 0 ? (
          <p className="rvm-line">No decks yet.</p>
        ) : (
          <>
            <ul className="rvm-mix">
              {report.banks.map((b) => {
                const decks = report.decks.filter((d) => d.bankId === b.bankId);
                return (
                  <li key={b.bankId ?? 'none'}>
                    <MixRow name={b.name} row={b} bank />
                    {/* A bank whose only deck has its name is that deck: one row says it all. */}
                    {decks.length > 1 || decks[0]?.name !== b.name ? (
                      <ul className="rvm-mix__decks">
                        {decks.map((d) => (
                          <li key={d.deckId}>
                            <MixRow name={d.name} row={d} />
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            <div className="rvm-chart__foot" aria-hidden="true">
              {MIX.map((m) => (
                <span key={m.key} className="rvm-legend">
                  <span className={`rvm-swatch rvm-mix__seg--${m.key}`} /> {m.label}
                </span>
              ))}
            </div>
            <TableToggle>
              <div
                className="rv-tablewrap"
                tabIndex={0}
                role="region"
                aria-label="Card counts by bank and deck"
              >
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
            </TableToggle>
          </>
        )}
        {report.orphanCards > 0 ? (
          <p className="rvm-line">
            {plural(report.orphanCards, 'card')} in a deleted deck, not counted above.
          </p>
        ) : null}
      </Panel>

      <Coverage settings={settings} onExamOnTopic={onExamOnTopic} />
    </div>
  );
}

/** "2026-10-14" as a local date (the heatmap's last column is that study day). */
function dayKeyDate(key: string): Date | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : undefined;
}

/**
 * The last 84 study days from the game ledger (ADR-022). Only with Game mode on, since the cells
 * are XP; while the ledger is still being built it says so instead of drawing empty days.
 */
function StudyCalendar() {
  const game = useGame();
  const state = game.data;
  if (!state || !state.mode) return null;
  if (!state.ready) {
    const { done, total, status } = state.backfill;
    return (
      <Panel icon={CalendarDays} tone="sun" title="Study calendar">
        {status === 'failed' ? (
          <div className="rvm-row">
            <p className="rvm-line">The calendar could not be built.</p>
            <Button onClick={() => void game.retryBackfill()}>Try again</Button>
          </div>
        ) : (
          <>
            <p className="rvm-line">Counting your study days…</p>
            {total > 0 ? (
              <BarMeter
                value={done}
                max={total}
                label="Study calendar"
                valueText={`${done} of ${total}`}
                tone="sun"
                size="sm"
              />
            ) : null}
          </>
        )}
      </Panel>
    );
  }
  const days = state.days;
  const last = days[days.length - 1];
  const end = last ? dayKeyDate(last.dayKey) : undefined;
  return (
    <Panel
      icon={CalendarDays}
      tone="sun"
      title="Study calendar"
      tip="XP per study day for the last 12 weeks. Darker means more XP; a snowflake marks a freeze."
    >
      <Heatmap
        days={days.map((d) => d.xp)}
        goal={state.goal.value}
        title="Study calendar"
        frozen={days.flatMap((d, i) => (d.frozen ? [i] : []))}
        {...(end ? { end } : {})}
      />
    </Panel>
  );
}

type Counts = ReturnType<typeof computeAnalytics>['decks'][number];
const MIX = [
  { key: 'new', label: 'New' },
  { key: 'learning', label: 'Learning' },
  { key: 'review', label: 'Review' },
  { key: 'suspended', label: 'Suspended' },
] as const;

/** One bank or deck: its card mix as a stacked bar (named in full for screen readers) and due. */
function MixRow({
  name,
  row,
  bank = false,
}: {
  name: string;
  row: Pick<Counts, 'total' | 'new' | 'learning' | 'relearning' | 'review' | 'suspended' | 'due'>;
  bank?: boolean;
}) {
  const parts = [row.new, row.learning + row.relearning, row.review, row.suspended];
  const said = MIX.map((m, i) => `${parts[i]} ${m.label.toLowerCase()}`).join(', ');
  return (
    <div className={`rvm-mix__row${bank ? ' is-bank' : ''}`}>
      <span className="rvm-mix__name" dir="auto">
        {name}
      </span>
      <span
        className="rvm-mix__bar"
        role="img"
        aria-label={`${name}: ${plural(row.total, 'card')}, ${said}`}
      >
        {parts.map((n, i) =>
          n > 0 ? (
            <span
              key={MIX[i]!.key}
              className={`rvm-mix__seg rvm-mix__seg--${MIX[i]!.key}`}
              style={{ flexGrow: n }}
            />
          ) : null,
        )}
      </span>
      <span className="rvm-mix__nums">
        <span className="rvm-mix__total" aria-hidden="true">
          {row.total}
        </span>
        <Pill icon={CalendarClock} tone={row.due > 0 ? 'primary' : undefined}>
          {row.due} due
        </Pill>
      </span>
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
