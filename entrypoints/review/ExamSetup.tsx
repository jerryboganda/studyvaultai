import { useId, useMemo, useState } from 'react';
import {
  EXAM_MAX_MINUTES,
  EXAM_MAX_QUESTIONS,
  examDuration,
  examScopeOptions,
  validateExamConfig,
  type ExamConfig,
  type ExamHistoryEntry,
  type ExamSession,
} from '@study/exam';
import type { ExamData } from '@storage/exam';
import { Button, EmptyState, InlineNotice, plural } from '@ui';
import { TID, formatWhen, percent } from '@ui/review';

const whole = (text: string): number => (/^\d+$/.test(text.trim()) ? Number(text) : Number.NaN);

/**
 * Exam setup: what to ask (a bank, folder or tag), how many questions, an optional time limit, and
 * the history of recent exams. Everything the form says is derived from the real cards.
 */
export function ExamSetup({
  data,
  loading,
  loadError,
  retry,
  current,
  history,
  historyError,
  busy,
  startError,
  timeZone,
  onStart,
  onContinue,
  onShowResults,
  onDiscard,
  onClearHistory,
}: {
  data: ExamData | null;
  loading: boolean;
  loadError: string | null;
  retry(): void;
  /** The exam kept on this device: in progress, or finished with its results still open. */
  current: ExamSession | null;
  history: readonly ExamHistoryEntry[];
  historyError: string | null;
  busy: boolean;
  startError: string | null;
  timeZone: string;
  onStart(config: ExamConfig): void;
  onContinue(): void;
  onShowResults(): void;
  onDiscard(): void;
  onClearHistory(): void;
}) {
  const uid = useId();
  const options = useMemo(() => (data ? examScopeOptions(data) : []), [data]);
  const [scopeValue, setScopeValue] = useState('all');
  const [questionsText, setQuestionsText] = useState<string | null>(null);
  const [timed, setTimed] = useState(false);
  const [minutesText, setMinutesText] = useState<string | null>(null);
  const [shuffle, setShuffle] = useState(true);

  if (loadError) {
    return (
      <InlineNotice
        tone="error"
        title="Your cards could not be loaded"
        action={<Button onClick={retry}>Retry</Button>}
      >
        {loadError}
      </InlineNotice>
    );
  }
  if (loading || !data) return <p className="sv-muted">Loading your cards…</p>;

  const option = options.find((o) => o.value === scopeValue) ?? options[0];
  const available = option?.available ?? 0;
  const inProgress = current !== null && current.phase !== 'finished';

  const questions = whole(questionsText ?? String(Math.min(20, Math.max(1, available))));
  const asked = Number.isFinite(questions) ? Math.min(questions, available) : available;
  const minutes = timed
    ? whole(minutesText ?? String(Math.min(EXAM_MAX_MINUTES, Math.max(1, asked))))
    : null;
  const check = validateExamConfig({ questions, minutes }, available);
  const reason = !check.ok
    ? (check.errors.questions ?? check.errors.minutes)
    : inProgress
      ? 'Finish or discard the exam in progress first.'
      : undefined;

  const start = () => {
    if (!option || !check.ok) return;
    onStart({
      scope: option.scope,
      scopeLabel: option.label,
      questions: check.count,
      minutes,
      shuffle,
    });
  };

  return (
    <div className="sv-stack" data-testid={TID.examSetup}>
      {current ? (
        <InlineNotice
          tone="info"
          title={inProgress ? 'An exam is in progress' : 'Your last exam’s results are still here'}
          action={
            <div className="sv-row">
              <Button
                variant="primary"
                data-testid={TID.examContinue}
                onClick={inProgress ? onContinue : onShowResults}
              >
                {inProgress ? 'Continue the exam' : 'Show the results'}
              </Button>
              <Button data-testid={TID.examDiscard} onClick={onDiscard}>
                {inProgress ? 'Discard the exam' : 'Close the results'}
              </Button>
            </div>
          }
        >
          {inProgress
            ? `${current.scopeLabel}: ${current.questions.length} questions. The timer does not pause while you are away.`
            : `${current.scopeLabel}. They are kept on this device for 24 hours.`}
        </InlineNotice>
      ) : null}

      <section className="sv-stack" aria-labelledby={`${uid}-h`}>
        <h2 id={`${uid}-h`}>Exam simulation</h2>
        <p className="sv-muted">
          A timed run with no feedback until the end. An exam never changes your review schedule
          unless you choose to count it as review on the results page.
        </p>

        {options[0]?.available === 0 ? (
          <EmptyState title="No cards to ask yet">
            Make flashcards first (Create cards). Suspended and deleted cards are not asked.
          </EmptyState>
        ) : (
          <form
            className="sv-stack"
            aria-label="Exam options"
            onSubmit={(e) => {
              e.preventDefault();
              if (!reason) start();
            }}
          >
            <div className="sv-field">
              <label className="sv-label" htmlFor={`${uid}-scope`}>
                What to ask
              </label>
              <select
                id={`${uid}-scope`}
                className="sv-control"
                data-testid={TID.examScope}
                value={option?.value ?? 'all'}
                onChange={(e) => {
                  setScopeValue(e.target.value);
                  setQuestionsText(null);
                }}
              >
                {options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label} ({plural(o.available, 'card')})
                  </option>
                ))}
              </select>
            </div>

            <div className="sv-field">
              <label className="sv-label" htmlFor={`${uid}-n`}>
                Number of questions
              </label>
              <input
                id={`${uid}-n`}
                className="sv-control"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                data-testid={TID.examQuestions}
                value={questionsText ?? String(Math.min(20, Math.max(1, available)))}
                aria-invalid={!check.ok && check.errors.questions !== undefined}
                aria-describedby={`${uid}-n-note`}
                onChange={(e) => setQuestionsText(e.target.value)}
              />
              <p
                id={`${uid}-n-note`}
                className={check.ok ? 'sv-small sv-muted' : 'sv-small rv-error'}
              >
                {!check.ok && check.errors.questions
                  ? check.errors.questions
                  : check.ok && check.capped
                    ? `Only ${plural(available, 'card')} can be asked in this scope, so the exam has ${check.count} questions.`
                    : `Up to ${EXAM_MAX_QUESTIONS}. ${plural(available, 'card')} available.`}
              </p>
            </div>

            <div className="sv-field">
              <label className="sv-check">
                <input
                  type="checkbox"
                  data-testid={TID.examTimed}
                  checked={timed}
                  onChange={(e) => setTimed(e.target.checked)}
                />
                <span>Set a time limit</span>
              </label>
              {timed ? (
                <>
                  <label className="sv-label" htmlFor={`${uid}-m`}>
                    Minutes to answer
                  </label>
                  <input
                    id={`${uid}-m`}
                    className="sv-control"
                    type="text"
                    inputMode="numeric"
                    autoComplete="off"
                    data-testid={TID.examMinutes}
                    value={minutesText ?? String(Math.min(EXAM_MAX_MINUTES, Math.max(1, asked)))}
                    aria-invalid={!check.ok && check.errors.minutes !== undefined}
                    aria-describedby={`${uid}-m-note`}
                    onChange={(e) => setMinutesText(e.target.value)}
                  />
                  <p
                    id={`${uid}-m-note`}
                    className={
                      !check.ok && check.errors.minutes ? 'sv-small rv-error' : 'sv-small sv-muted'
                    }
                  >
                    {!check.ok && check.errors.minutes
                      ? check.errors.minutes
                      : 'The clock cannot be paused. It covers answering; marking your own answers afterwards is not timed.'}
                  </p>
                </>
              ) : (
                <p className="sv-small sv-muted">
                  No time limit: the exam ends when you finish it.
                </p>
              )}
            </div>

            <label className="sv-check">
              <input
                type="checkbox"
                data-testid={TID.examShuffle}
                checked={shuffle}
                onChange={(e) => setShuffle(e.target.checked)}
              />
              <span>Shuffle the order of the questions</span>
            </label>

            {startError ? <InlineNotice tone="error">{startError}</InlineNotice> : null}
            <div className="sv-row">
              <Button
                variant="primary"
                data-testid={TID.examStart}
                busy={busy}
                disabledReason={reason}
                onClick={start}
              >
                Start exam
              </Button>
              {reason ? <span className="sv-small sv-muted">{reason}</span> : null}
            </div>
          </form>
        )}
      </section>

      <section className="sv-stack" aria-labelledby={`${uid}-hist`} data-testid={TID.examHistory}>
        <h2 id={`${uid}-hist`}>Recent exams</h2>
        {historyError ? <InlineNotice tone="error">{historyError}</InlineNotice> : null}
        {history.length === 0 ? (
          <p className="sv-muted">No exam has been finished yet.</p>
        ) : (
          <>
            <div className="rv-tablewrap">
              <table className="rv-table">
                <caption className="sv-sr">The last {history.length} exams you finished</caption>
                <thead>
                  <tr>
                    <th scope="col">Finished</th>
                    <th scope="col">Scope</th>
                    <th scope="col">Score</th>
                    <th scope="col">Time</th>
                    <th scope="col">Counted as review</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h) => {
                    const graded = h.total - h.void;
                    return (
                      <tr key={h.id}>
                        <th scope="row">{formatWhen(h.finishedAt, timeZone)}</th>
                        <td>{h.scopeLabel}</td>
                        <td>
                          {graded === 0 ? 'n/a' : percent(h.correct / graded)} ({h.correct} of{' '}
                          {graded})
                        </td>
                        <td>
                          {examDuration(h.usedMs)}
                          {h.minutes === null
                            ? ''
                            : h.timedOut
                              ? `, ran out (limit ${h.minutes} min)`
                              : ` of ${h.minutes} min`}
                        </td>
                        <td>{h.countedAsReview ? 'Yes' : 'No'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="sv-row">
              <Button data-testid={TID.examHistoryClear} onClick={onClearHistory}>
                Clear this list
              </Button>
            </div>
          </>
        )}
        <p className="sv-small sv-muted">
          This list and an exam in progress are stored on this device only. They are not part of
          backups and are not synced, and “Delete all data” removes them.
        </p>
      </section>
    </div>
  );
}
