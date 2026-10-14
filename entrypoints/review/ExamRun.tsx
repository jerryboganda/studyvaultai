import { useEffect, useId, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleHelp,
  Flag,
  Timer,
  X,
  type LucideIcon,
} from 'lucide-react';
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
import {
  BarMeter,
  ChunkyButton,
  ConfirmDialog,
  IconButton,
  InfoTip,
  InlineNotice,
  plural,
  useLatest,
} from '@ui';
import { CardFace, TID, examChoiceId, examMarkId } from '@ui/review';

const KIND_LABEL = { mcq: 'Multiple choice', recall: 'Recall' } as const;
const LETTERS = 'ABCDEFGHIJ';

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

  if (deadlineAt === null) return <p className="rv-clock rv-clock--none">No time limit</p>;
  const left = examRemainingMs({ deadlineAt, phase }, tick) ?? 0;
  const total = Date.parse(deadlineAt) - Date.parse(startedAt);
  // The last tenth (or minute) is marked by a word as well as a colour.
  const low = left <= Math.max(60_000, total / 10);
  return (
    <p className={`rv-clock${low ? ' rv-clock--low' : ''}`}>
      <Timer aria-hidden="true" strokeWidth={2.5} />
      <span className="sv-vh">Time left </span>
      <span role="timer" aria-live="off" className="rv-clock__time" data-testid={TID.examTimer}>
        {formatClock(left)}
      </span>
      {low ? <span className="rv-clock__low">left</span> : null}
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
  const isAnswered = (x: ExamSession['questions'][number]) =>
    x.kind === 'mcq' ? x.choiceId !== null : x.text.trim() !== '';
  const answered = exam.questions.filter(isAnswered).length;
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
    <main className="rv-session rv-examrun" aria-label="Exam in progress" data-testid={TID.examRun}>
      <header className="rv-top">
        <IconButton
          icon={X}
          label="Leave exam"
          tipSide="right"
          data-testid={TID.examLeave}
          onClick={() => setAsking('leave')}
        />
        <div className="rv-pill" data-testid={TID.examProgress}>
          <span className="rv-pill__count" aria-hidden="true">
            {answered}/{total}
          </span>
          <BarMeter
            value={answered}
            max={Math.max(1, total)}
            label="Questions answered"
            valueText={`${answered} of ${total} answered`}
          />
        </div>
        <div className="rv-top__stats">
          <ExamClock
            startedAt={exam.startedAt}
            deadlineAt={exam.deadlineAt}
            phase={exam.phase}
            announce={announce}
            onTimeUp={onTimeUp}
          />
        </div>
      </header>

      <nav className="rv-qnav" aria-label="Questions">
        <ol className="rv-qnav__list">
          {exam.questions.map((x, i) => {
            const done = isAnswered(x);
            return (
              <li key={x.cardId}>
                <button
                  type="button"
                  className={`rv-qnav__dot${done ? ' is-done' : ''}${i === index ? ' is-current' : ''}`}
                  aria-current={i === index ? 'step' : undefined}
                  aria-label={`Question ${i + 1}, ${done ? 'answered' : 'not answered'}`}
                  onClick={() => onGo(i)}
                >
                  {done ? (
                    <Check aria-hidden="true" strokeWidth={3} />
                  ) : (
                    <span aria-hidden="true">{i + 1}</span>
                  )}
                </button>
              </li>
            );
          })}
        </ol>
      </nav>

      <article
        ref={article}
        tabIndex={-1}
        className="rv-card rv-examq"
        aria-labelledby={`${uid}-q`}
        data-testid={TID.examQuestion}
      >
        <div className="rv-card__meta">
          <h2 id={`${uid}-q`} className="rv-examq__heading">
            Question {exam.current + 1} of {total}
          </h2>
          <span className="rv-chip">{KIND_LABEL[q.kind]}</span>
          {card?.needsHumanVerification ? (
            <span className="rv-chip rv-chip--warning">Needs your check</span>
          ) : null}
        </div>

        {!card ? (
          <InlineNotice tone="warning">
            This card is no longer available (it was deleted or suspended). It is not scored.
          </InlineNotice>
        ) : q.kind === 'mcq' ? (
          <>
            <p className="rv-face rv-examq__text">{card.front}</p>
            <fieldset className="rv-opts">
              <legend className="sv-vh">Choose one answer</legend>
              <div className="rv-opts__list" data-testid={TID.examChoices}>
                {orderChoices(card.choices ?? [], examChoiceRandom(exam, card.id)).map((c, i) => (
                  <label key={c.id} className="rv-opt" data-testid={examChoiceId(i)}>
                    <input
                      type="radio"
                      className="sv-vh"
                      name={`${uid}-choice`}
                      value={c.id}
                      checked={q.choiceId === c.id}
                      onChange={() => onChoose(exam.current, c.id)}
                    />
                    <span className="rv-opt__letter" aria-hidden="true">
                      {LETTERS[i] ?? i + 1}
                    </span>
                    <span className="rv-opt__text">{c.text}</span>
                    <span className="rv-opt__check" aria-hidden="true">
                      <Check strokeWidth={3.5} />
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          </>
        ) : (
          <>
            <div className="rv-examq__text">
              <CardFace card={card} reveal={false} />
            </div>
            <div className="sv-field">
              <span className="rv-labelrow">
                <label className="sv-label" htmlFor={`${uid}-text`}>
                  Your answer (optional)
                </label>
                <InfoTip label="About recall answers" align="start">
                  Typing is optional and never graded by the machine. When you finish, the right
                  answer is shown and you mark your own.
                </InfoTip>
              </span>
              <textarea
                id={`${uid}-text`}
                className="sv-control"
                rows={4}
                autoComplete="off"
                data-testid={TID.examText}
                value={q.text}
                onChange={(e) => onType(exam.current, e.target.value)}
              />
            </div>
          </>
        )}
      </article>

      <div className="rv-examnav">
        <ChunkyButton
          icon={ArrowLeft}
          data-testid={TID.examPrev}
          disabledReason={exam.current === 0 ? 'This is the first question.' : undefined}
          onClick={() => onGo(exam.current - 1)}
        >
          Previous
        </ChunkyButton>
        <span className="rv-examnav__spacer" />
        <ChunkyButton
          variant={last ? 'secondary' : 'primary'}
          iconEnd={ArrowRight}
          data-testid={TID.examNext}
          disabledReason={last ? 'This is the last question.' : undefined}
          onClick={() => onGo(exam.current + 1)}
        >
          Next
        </ChunkyButton>
        <ChunkyButton
          variant={last ? 'sun' : 'secondary'}
          icon={Flag}
          data-testid={TID.examFinish}
          onClick={() => setAsking('finish')}
        >
          Finish exam
        </ChunkyButton>
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

const MARKS: readonly { mark: 'know' | 'dont'; label: string; icon: LucideIcon }[] = [
  { mark: 'know', label: 'I knew it', icon: Check },
  { mark: 'dont', label: "Didn't know it", icon: CircleHelp },
];

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
  const title = useRef<HTMLHeadingElement>(null);
  // The Finish button that opened this step is gone: the step's title takes focus, never <body>.
  useEffect(() => title.current?.focus(), []);
  const exists = (id: string) => cards.has(id);
  const pending = pendingMarks(exam, exists).length;
  const items = exam.questions.flatMap((q, i) => {
    const card = cards.get(q.cardId);
    return q.kind === 'recall' && card ? [{ q, i, card }] : [];
  });
  const marked = items.length - pending;

  return (
    <main
      className="rv-session rv-marking"
      aria-label="Mark your answers"
      data-testid={TID.examMarking}
    >
      <header className="rv-tabhead">
        <span className="rv-tabhead__art sv-art--success" aria-hidden="true">
          <Check strokeWidth={2.6} />
        </span>
        <div className="rv-tabhead__text">
          <h2 ref={title} tabIndex={-1} className="rv-tabhead__title">
            Mark your answers
          </h2>
          <p className="rv-tabhead__line">
            {exam.endReason === 'timeup'
              ? 'Time is up. Your answers are saved. '
              : 'You finished answering. '}
            <InfoTip label="About marking" align="start">
              Compare each recall answer with the right one and mark whether you knew it.
              Multiple-choice questions are already scored. This step is not timed.
            </InfoTip>
          </p>
        </div>
        <div className="rv-marking__progress">
          <BarMeter
            value={marked}
            max={Math.max(1, items.length)}
            label="Answers marked"
            tone="success"
          />
          <p className="sv-small" data-testid={TID.examProgress}>
            {marked} of {items.length} marked
          </p>
        </div>
      </header>

      <ol className="rv-marklist">
        {items.map(({ q, i, card }) => (
          <li key={q.cardId}>
            <fieldset className="rv-card rv-markcard" aria-describedby={`${uid}-${i}`}>
              <legend className="rv-markcard__legend">Question {i + 1}</legend>
              <CardFace card={card} reveal />
              <p id={`${uid}-${i}`} className="rv-markcard__yours">
                <span className="sv-label">Your answer: </span>
                <span className="rv-prewrap">
                  {q.text.trim() === '' ? 'No answer typed' : q.text}
                </span>
              </p>
              <div className="rv-markcard__choices">
                {MARKS.map(({ mark, label, icon: Icon }) => (
                  <label
                    key={mark}
                    className={`rv-markopt rv-markopt--${mark}`}
                    data-testid={examMarkId(i, mark)}
                  >
                    <input
                      type="radio"
                      className="sv-vh"
                      name={`${uid}-mark-${i}`}
                      checked={q.mark === mark}
                      onChange={() => onMark(i, mark)}
                    />
                    <Icon aria-hidden="true" strokeWidth={2.6} />
                    <span>
                      {label} <span className="sv-sr">(question {i + 1})</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          </li>
        ))}
      </ol>

      <div className="rv-examnav">
        <ChunkyButton
          data-testid={TID.examMarkRest}
          disabledReason={pending === 0 ? 'Every question is marked.' : undefined}
          onClick={onMarkRest}
        >
          Mark rest unknown
        </ChunkyButton>
        <span className="rv-examnav__spacer" />
        <ChunkyButton
          variant="primary"
          size="lg"
          data-testid={TID.examShowResults}
          disabledReason={
            pending > 0 ? `${plural(pending, 'question')} still need a mark.` : undefined
          }
          onClick={onShowResults}
        >
          Show results
        </ChunkyButton>
      </div>
    </main>
  );
}
