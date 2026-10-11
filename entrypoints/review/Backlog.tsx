import { useId, useState } from 'react';
import { studyDayKey, studyDayNumber } from '@study';
import { applyBacklog, planBacklog } from '@storage';
import {
  Button,
  ConfirmDialog,
  InlineNotice,
  errorMessage,
  plural,
  truncate,
  useAction,
  useAsync,
  useDataEpoch,
} from '@ui';
import { TID, clockKey, formatDayKey, toBoundary, toClock, type StudySettings } from '@ui/review';

const MAX_SAMPLE = 8;

/**
 * Overdue recovery: spread the cards that are late over the next few days within each deck's daily
 * budget. The plan is computed and shown first; nothing changes until the learner applies it, and
 * only due dates move (memory strength is kept).
 */
export function BacklogRecovery({
  settings,
  overdue,
}: {
  settings: StudySettings;
  overdue: number;
}) {
  const uid = useId();
  const epoch = useDataEpoch();
  const [days, setDays] = useState(7);
  const [perDay, setPerDay] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [result, setResult] = useState<{ moved: number; skipped: number } | null>(null);
  const key = clockKey(settings);
  const boundary = toBoundary(settings);

  const budget = perDay.trim() === '' ? undefined : Number(perDay);
  const budgetError =
    budget !== undefined && (!Number.isInteger(budget) || budget < 1 || budget > 9999)
      ? 'Enter a whole number between 1 and 9999, or leave it empty to use each deck’s own limit.'
      : null;

  const plan = useAsync(
    () =>
      budgetError
        ? Promise.resolve(null)
        : planBacklog({
            ...toClock(settings),
            days,
            ...(budget === undefined ? {} : { maxPerDay: budget }),
          }),
    [key, days, budgetError ? 'invalid' : (budget ?? 'deck')],
    [epoch],
  );

  const apply = useAction(async () => {
    if (!plan.data) return;
    const applied = await applyBacklog(plan.data.plan, toClock(settings));
    setResult(applied);
    setConfirm(false);
    plan.refresh();
  });

  const preview = plan.data;
  const byDay = new Map<number, number>();
  const dayLabel = new Map<number, string>();
  for (const m of preview?.moves ?? []) {
    byDay.set(m.dayOffset, (byDay.get(m.dayOffset) ?? 0) + 1);
    dayLabel.set(
      m.dayOffset,
      formatDayKey(studyDayKey(studyDayNumber(Date.parse(m.toDueAt), boundary))),
    );
  }
  const moves = preview?.moves.length ?? 0;

  return (
    <section className="sv-stack" aria-label="Backlog recovery" data-testid={TID.backlog}>
      <p>
        {plural(overdue, 'review card')} {overdue === 1 ? 'is' : 'are'} overdue. Recovery spreads
        them over the next days so you are not buried at once. Only due dates change; what you
        remember about each card is kept.
      </p>
      <div className="rv-grid">
        <div className="sv-field">
          <label className="sv-label" htmlFor={`${uid}-days`}>
            Spread over
          </label>
          <select
            id={`${uid}-days`}
            className="sv-control"
            data-testid={TID.backlogDays}
            value={days}
            onChange={(e) => {
              setDays(Number(e.target.value));
              setResult(null);
            }}
          >
            {[2, 3, 5, 7, 10, 14, 21, 30].map((d) => (
              <option key={d} value={d}>
                {d} days (today included)
              </option>
            ))}
          </select>
        </div>
        <div className="sv-field">
          <label className="sv-label" htmlFor={`${uid}-budget`}>
            Reviews per day, per deck
          </label>
          <input
            id={`${uid}-budget`}
            className="sv-control"
            inputMode="numeric"
            placeholder="Each deck’s own limit"
            value={perDay}
            aria-invalid={budgetError ? true : undefined}
            aria-describedby={budgetError ? `${uid}-budget-err` : undefined}
            onChange={(e) => {
              setPerDay(e.target.value);
              setResult(null);
            }}
          />
          {budgetError ? (
            <p id={`${uid}-budget-err`} className="sv-small rv-error">
              <span aria-hidden="true">✕ </span>
              {budgetError}
            </p>
          ) : null}
        </div>
      </div>

      {plan.error ? (
        <InlineNotice tone="error" title="The plan could not be computed">
          {plan.error}
        </InlineNotice>
      ) : null}
      {result ? (
        <div data-testid={TID.backlogResult}>
          <InlineNotice tone="success" live>
            Moved {plural(result.moved, 'card')}
            {result.skipped > 0
              ? `; ${plural(result.skipped, 'card')} changed since the plan was made and were left alone`
              : ''}
            .
          </InlineNotice>
        </div>
      ) : null}

      {preview ? (
        <div className="sv-stack sv-stack--tight" data-testid={TID.backlogPlan}>
          <h3>What will change</h3>
          <ul className="rv-list">
            <li>
              {plural(preview.plan.keptToday, 'overdue card')} stay due today (within today&rsquo;s
              budget).
            </li>
            <li>
              {plural(moves, 'card')} move to later days
              {moves > 0 ? ':' : '.'}
            </li>
          </ul>
          {moves > 0 ? (
            <div className="rv-tablewrap">
              <table className="rv-table">
                <caption className="sv-sr">Cards moved per day</caption>
                <thead>
                  <tr>
                    <th scope="col">New due day</th>
                    <th scope="col">Cards</th>
                  </tr>
                </thead>
                <tbody>
                  {[...byDay.entries()]
                    .sort((a, b) => a[0] - b[0])
                    .map(([offset, count]) => (
                      <tr key={offset}>
                        <th scope="row">{dayLabel.get(offset) ?? `Day +${offset}`}</th>
                        <td>{count}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {preview.unassigned.length > 0 ? (
            <InlineNotice tone="warning" title="Some cards do not fit">
              {plural(preview.unassigned.length, 'card')} would not fit into {days} days at this
              budget and stay overdue. Spread over more days or raise the budget to include them.
            </InlineNotice>
          ) : null}
          {moves > 0 ? (
            <details className="rv-details">
              <summary>Show the first {Math.min(MAX_SAMPLE, moves)} cards that move</summary>
              <ul className="rv-list">
                {preview.moves.slice(0, MAX_SAMPLE).map((m) => (
                  <li key={m.cardId} className="sv-wrap">
                    {truncate(m.front, 70)}: was due {formatDayKey(m.fromDueAt.slice(0, 10))}, now{' '}
                    {formatDayKey(studyDayKey(studyDayNumber(Date.parse(m.toDueAt), boundary)))}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          <div className="sv-row">
            <Button
              variant="primary"
              data-testid={TID.backlogApply}
              busy={apply.busy}
              disabledReason={moves === 0 ? 'The plan does not move any card.' : undefined}
              onClick={() => setConfirm(true)}
            >
              Apply plan
            </Button>
            {moves === 0 ? (
              <span className="sv-small sv-muted">Nothing needs to move at this budget.</span>
            ) : null}
          </div>
        </div>
      ) : plan.loading ? (
        <p className="sv-muted">Working out a plan…</p>
      ) : null}
      {apply.error ? (
        <InlineNotice tone="error" title="Could not apply the plan">
          {errorMessage(apply.error)}
        </InlineNotice>
      ) : null}

      {confirm && preview ? (
        <ConfirmDialog
          title={`Move ${plural(moves, 'card')}?`}
          confirmLabel="Move the cards"
          onConfirm={() => void apply.run()}
          onCancel={() => setConfirm(false)}
        >
          <p>
            {plural(moves, 'card')} will get a later due date as listed. Their memory strength is
            kept, but their old overdue dates are not restored if you change your mind.
          </p>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
