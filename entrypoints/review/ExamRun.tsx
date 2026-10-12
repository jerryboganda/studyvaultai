import { useEffect, useId, useRef, useState } from 'react';
import { orderChoices, type Card } from '@study';
import {
  crossedMilestones,
  examChoiceRandom,
  examRemainingMs,
  formatClock,
  milestoneMessage,
  pendingMarks,
  type ExamSession,
} from '@study/exam';
import { Badge, Button, ConfirmDialog, InlineNotice, plural, useLatest } from '@ui';
import { CardFace, TID, examChoiceId, examMarkId } from '@ui/review';

const KIND_LABEL = { mcq: 'Multiple choice', recall: 'Recall' } as const;

/**
 * The visible timer and the milestone announcements, isolated so that a tick re-renders only this.
 * The number is a `timer` (no live region): a screen reader reads it when asked and is never
 * interrupted once a second. The person is told at 50 %, 10 %, one minute and the end, through the
 * page's single polite region (`announce`), which outlives this component.
 */
function ExamClock({
  startedAt,
  deadlineAt,
  phase,
  announce,
  onTimeUp,
}: Pick<ExamSession, 'startedAt' | 'deadlineAt' | 'phase'> & {
  announce(message: string): void;
  onTimeUp(): void;
}) {
  const [tick, setTick] = useState(() => Date.now());
  const latest = useLatest({ announce, onTimeUp });

  useEffect(() => {
    if (deadlineAt === null) return undefined;
    const timing = { startedAt, deadlineAt, phase };
    const total = Date.parse(deadlineAt) - Date.parse(startedAt);
    // What was already behind us when this opened is not announced again (a resumed exam).
    const told = new Set(crossedMilestones(timing, Date.now()));
    const id = setInterval(() => {
      const now = Date.now();
      setTick(now);
      for (const m of crossedMilestones(timing, now)) {
        if (told.has(m)) continue;
        told.add(m);
        latest.current.announce(milestoneMessage(m, total));
      }
      if (examRemainingMs(timing, now) === 0) latest.current.onTimeUp();
    }, 1000);
    return () => clearInterval(id);
  }, [startedAt, deadlineAt, phase, latest]);

  if (deadlineAt === null) return <p className="sv-small sv-muted">No time limit</p>;
  const left = examRemainingMs({ deadlineAt, phase }, tick) ?? 0;
  return (
    <p className="rv-exam__clock">
      <span className="sv-small">Time left </span>
      <span role="timer" aria-live="off" className="rv-exam__timer" data-testid={TID.examTimer}>
        {formatClock(left)}
      </span>
    </p>
  );
}

/** The question on screen while answering: no answer, key or score is shown anywhere. */
export function ExamRun({
  exam,
  cards,
  announce,
  onChoose,
  onType,
  onGo,
  onFinish,
  onLeave,
  onTimeUp,
}: {
  exam: ExamSession;
  cards: ReadonlyMap<string, Card>;
  announce(message: string): void;
  onChoose(index: number, choiceId: string): void;
  onType(index: number, text: string): void;
  onGo(index: number): void;
  onFinish(): void;
  onLeave(): void;
  onTimeUp(): void;
}) {
  const uid = useId();
  const [asking, setAsking] = useState<'finish' | 'leave' | null>(null);
  const article = useRef<HTMLElement>(null);
  const q = exam.questions[exam.current];
  const card = q ? (cards.get(q.cardId) ?? null) : null;
  const total = exam.questions.length;
  const answered = exam.questions.filter((x) =>
    x.kind === 'mcq' ? x.choiceId !== null : x.text.trim() !== '',
  ).length;
  const openChoices = exam.questions.filter((x) => x.kind === 'mcq' && x.choiceId === null).length;
  const openRecall = exam.questions.filter(
    (x) => x.kind === 'recall' && x.text.trim() === '',
  ).length;

  // A new question takes focus, so keyboard and screen-reader users are never left on a button
  // that has just changed meaning.
  const index = exam.current;
  useEffect(() => {
    article.current?.focus({ preventScroll: true });
  }, [index]);

  if (!q) return null;
  const last = index === total - 1;

  return (
    <main className="rv-session rv-exam" aria-label="Exam in progress" data-testid={TID.examRun}>
      <header className="rv-session__head">
        <div className="rv-session__progress">
          <progress
            data-testid={TID.examProgress}
            value={answered}
            max={Math.max(1, total)}
            aria-label="Questions answered"
          />
          <span className="sv-small">
            {answered} of {total} answered
          </span>
        </div>
        <ExamClock
          startedAt={exam.startedAt}
          deadlineAt={exam.deadlineAt}
          phase={exam.phase}
          announce={announce}
          onTimeUp={onTimeUp}
        />
        <Button
          variant="ghost"
          data-testid={TID.examLeave}
          onClick={() => setAsking('leave')}
          title="The timer keeps running. You can continue from the Exam tab."
        >
          Leave exam
        </Button>
      </header>

      <article
        ref={article}
        tabIndex={-1}
        className="rv-card"
        aria-labelledby={`${uid}-q`}
        data-testid={TID.examQuestion}
      >
        <div className="sv-row rv-card__meta">
          <h2 id={`${uid}-q`} className="rv-exam__heading">
            Question {exam.current + 1} of {total}
          </h2>
          <Badge>{KIND_LABEL[q.kind]}</Badge>
          {card?.needsHumanVerification ? <Badge tone="warning">Needs your check</Badge> : null}
        </div>

        {!card ? (
          <InlineNotice tone="warning">
            This card is no longer available (it was deleted or suspended). It is not scored.
          </InlineNotice>
        ) : q.kind === 'mcq' ? (
          <>
            <p className="rv-face">{card.front}</p>
            <fieldset className="rv-fieldset">
              <legend className="sv-label">Choose one answer</legend>
              <div className="rv-choices" data-testid={TID.examChoices}>
                {orderChoices(card.choices ?? [], examChoiceRandom(exam, card.id)).map((c, i) => (
                  <label key={c.id} className="rv-choice" data-testid={examChoiceId(i)}>
                    <input
                      type="radio"
                      name={`${uid}-choice`}
                      value={c.id}
                      checked={q.choiceId === c.id}
                      onChange={() => onChoose(exam.current, c.id)}
                    />
                    <span className="rv-choice__text">{c.text}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          </>
        ) : (
          <>
            <CardFace card={card} reveal={false} />
            <div className="sv-field">
              <label className="sv-label" htmlFor={`${uid}-text`}>
                Your answer (optional)
              </label>
              <textarea
                id={`${uid}-text`}
                className="sv-control"
                rows={4}
                autoComplete="off"
                data-testid={TID.examText}
                value={q.text}
                aria-describedby={`${uid}-text-note`}
                onChange={(e) => onType(exam.current, e.target.value)}
              />
              <p id={`${uid}-text-note`} className="sv-small sv-muted">
                Typing is optional and never graded by the machine. When you finish, the right
                answer is shown and you mark your own.
              </p>
            </div>
          </>
        )}
      </article>

      <div className="sv-row">
        <Button
          data-testid={TID.examPrev}
          disabledReason={exam.current === 0 ? 'This is the first question.' : undefined}
          onClick={() => onGo(exam.current - 1)}
        >
          Previous
        </Button>
        <Button
          data-testid={TID.examNext}
          disabledReason={last ? 'This is the last question.' : undefined}
          onClick={() => onGo(exam.current + 1)}
        >
          Next
        </Button>
        <Button variant="primary" data-testid={TID.examFinish} onClick={() => setAsking('finish')}>
          Finish exam
        </Button>
      </div>

      {asking === 'finish' ? (
        <ConfirmDialog
          title="Finish the exam?"
          confirmLabel="Finish exam"
          cancelLabel="Keep answering"
          onConfirm={() => {
            setAsking(null);
            onFinish();
          }}
          onCancel={() => setAsking(null)}
        >
          {openChoices > 0 ? (
            <p>
              {plural(openChoices, 'multiple-choice question')} {openChoices === 1 ? 'has' : 'have'}{' '}
              no answer and will count as unanswered.
            </p>
          ) : null}
          {openRecall > 0 ? (
            <p>
              {plural(openRecall, 'recall question')} {openRecall === 1 ? 'has' : 'have'} nothing
              typed. You can still mark {openRecall === 1 ? 'it' : 'them'} from memory in the next
              step.
            </p>
          ) : null}
          <p>You cannot change your answers afterwards.</p>
        </ConfirmDialog>
      ) : null}
      {asking === 'leave' ? (
        <ConfirmDialog
          title="Leave the exam?"
          confirmLabel="Leave exam"
          cancelLabel="Stay in the exam"
          onConfirm={() => {
            setAsking(null);
            onLeave();
          }}
          onCancel={() => setAsking(null)}
        >
          <p>
            Your answers are saved, but the timer does not stop while you are away. You can continue
            from the Exam tab until the time runs out
            {exam.deadlineAt === null ? ' or 24 hours have passed' : ''}.
          </p>
        </ConfirmDialog>
      ) : null}
    </main>
  );
}

/**
 * After answering: the recall questions are shown with their answer and the person marks their own.
 * Multiple choice is already scored and shows nothing here.
 */
export function ExamMarking({
  exam,
  cards,
  onMark,
  onMarkRest,
  onShowResults,
}: {
  exam: ExamSession;
  cards: ReadonlyMap<string, Card>;
  onMark(index: number, mark: 'know' | 'dont'): void;
  onMarkRest(): void;
  onShowResults(): void;
}) {
  const uid = useId();
  const exists = (id: string) => cards.has(id);
  const pending = pendingMarks(exam, exists).length;
  const items = exam.questions.flatMap((q, i) => {
    const card = cards.get(q.cardId);
    return q.kind === 'recall' && card ? [{ q, i, card }] : [];
  });

  return (
    <main
      className="rv-session rv-exam"
      aria-label="Mark your answers"
      data-testid={TID.examMarking}
    >
      <header className="sv-stack sv-stack--tight">
        <h2>Mark your answers</h2>
        <InlineNotice tone={exam.endReason === 'timeup' ? 'warning' : 'info'}>
          {exam.endReason === 'timeup'
            ? 'Time is up. Your answers are saved. '
            : 'You finished answering. '}
          Compare each recall answer with the right one and mark whether you knew it.
          Multiple-choice questions are already scored. This step is not timed.
        </InlineNotice>
        <p className="sv-small" data-testid={TID.examProgress}>
          {items.length - pending} of {items.length} marked
        </p>
      </header>

      <ol className="sv-stack">
        {items.map(({ q, i, card }) => (
          <li key={q.cardId}>
            <fieldset className="rv-card rv-fieldset" aria-describedby={`${uid}-${i}`}>
              <legend className="sv-label">Question {i + 1}</legend>
              <CardFace card={card} reveal />
              <p id={`${uid}-${i}`} className="sv-small">
                <span className="sv-label">Your answer: </span>
                <span className="rv-prewrap">
                  {q.text.trim() === '' ? 'No answer typed' : q.text}
                </span>
              </p>
              <div className="rv-choices">
                {(
                  [
                    ['know', 'I knew it'],
                    ['dont', 'I did not know it'],
                  ] as const
                ).map(([mark, label]) => (
                  <label key={mark} className="rv-choice" data-testid={examMarkId(i, mark)}>
                    <input
                      type="radio"
                      name={`${uid}-mark-${i}`}
                      checked={q.mark === mark}
                      onChange={() => onMark(i, mark)}
                    />
                    <span className="rv-choice__text">
                      {label} <span className="sv-sr">(question {i + 1})</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          </li>
        ))}
      </ol>

      <div className="sv-row">
        <Button
          data-testid={TID.examMarkRest}
          disabledReason={pending === 0 ? 'Every question is marked.' : undefined}
          onClick={onMarkRest}
        >
          Mark the rest as not known
        </Button>
        <Button
          variant="primary"
          data-testid={TID.examShowResults}
          disabledReason={
            pending > 0 ? `${plural(pending, 'question')} still need a mark.` : undefined
          }
          onClick={onShowResults}
        >
          Show results
        </Button>
      </div>
    </main>
  );
}
