import { useId, useState } from 'react';
import type { Card } from '@study';
import {
  correctAnswerText,
  examBreakdown,
  examDuration,
  examTiming,
  examToMarkdown,
  givenAnswerText,
  isCountedAsReview,
  planExamReview,
  scoreOutcomes,
  type BreakdownRow,
  type ExamOutcome,
  type ExamQuestion,
  type ExamSession,
} from '@study/exam';
import { getCardSourceContext, type CardSourceContext } from '@storage';
import { Badge, Button, InlineNotice, plural, truncate, useAction, useAsync } from '@ui';
import { TID, examJumpId, examMissedId, formatWhen, percent } from '@ui/review';
import { openSource, type JumpResult } from './jump';

const OUTCOME = {
  correct: { glyph: '✓', text: 'Correct' },
  wrong: { glyph: '✕', text: 'Wrong' },
  unanswered: { glyph: '–', text: 'Unanswered' },
  void: { glyph: '–', text: 'Not scored' },
} as const satisfies Record<ExamOutcome, { glyph: string; text: string }>;

/** Blob URL + <a download>: the way an extension page writes a file without the downloads permission. */
function downloadText(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function Breakdown({
  title,
  first,
  rows,
  testId,
}: {
  title: string;
  first: string;
  rows: BreakdownRow[];
  testId: string;
}) {
  if (rows.length === 0) return null;
  return (
    <section className="sv-stack sv-stack--tight" data-testid={testId}>
      <h3>{title}</h3>
      <div className="rv-tablewrap">
        <table className="rv-table">
          <caption className="sv-sr">{title}</caption>
          <thead>
            <tr>
              <th scope="col">{first}</th>
              <th scope="col">Questions</th>
              <th scope="col">Correct</th>
              <th scope="col">Wrong</th>
              <th scope="col">Unanswered</th>
              <th scope="col">Score</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <th scope="row">{r.label}</th>
                <td>{r.total}</td>
                <td>{r.correct}</td>
                <td>{r.wrong}</td>
                <td>{r.unanswered}</td>
                <td>{percent(r.correct / r.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function MissedItem({
  q,
  index,
  outcome,
  card,
  context,
}: {
  q: ExamQuestion;
  index: number;
  outcome: ExamOutcome;
  card: Card | null;
  context: CardSourceContext | null | undefined;
}) {
  const [jump, setJump] = useState<JumpResult | null>(null);
  const [jumpNote, setJumpNote] = useState<string | null>(null);
  const open = useAction(async () => {
    setJump(null);
    try {
      const ctx = await getCardSourceContext(q.cardId);
      setJump(await openSource(ctx, undefined, { onProgress: setJumpNote }));
    } finally {
      setJumpNote(null);
    }
  });
  const quote = context?.quote ?? card?.sourceQuote ?? null;
  const o = OUTCOME[outcome];
  return (
    <li className="rv-card sv-stack sv-stack--tight" data-testid={examMissedId(index)}>
      <div className="sv-row rv-card__meta">
        <h4 className="rv-exam__heading">Question {index + 1}</h4>
        <Badge tone={outcome === 'wrong' ? 'danger' : 'neutral'} glyph={o.glyph}>
          {o.text}
        </Badge>
      </div>
      {card ? (
        <>
          <p className="rv-face rv-face--small">{card.front}</p>
          <p className="sv-small">
            <span className="sv-label">Your answer: </span>
            <span className="rv-prewrap">{givenAnswerText(q, card) ?? 'No answer'}</span>
          </p>
          <p className="sv-small">
            <span className="sv-label">Correct answer: </span>
            <span className="rv-prewrap">{correctAnswerText(card)}</span>
          </p>
        </>
      ) : (
        <p className="sv-muted">This card no longer exists.</p>
      )}
      {quote ? (
        <blockquote className="sv-quote">
          {quote}
          {context?.source ? (
            <footer className="sv-small sv-muted">
              {context.source.title} ({context.source.host})
              {context.quoteIsSnapshot ? ', saved quote' : ''}
            </footer>
          ) : null}
        </blockquote>
      ) : null}
      <div className="sv-row">
        <Button
          data-testid={examJumpId(index)}
          busy={open.busy}
          disabledReason={
            card?.highlightId ? undefined : 'This card has no source: it was typed in by hand.'
          }
          onClick={() => void open.run()}
        >
          Jump to source
        </Button>
      </div>
      {open.error ? <InlineNotice tone="error">{open.error}</InlineNotice> : null}
      {jumpNote ? (
        <InlineNotice tone="info" live>
          {jumpNote}
        </InlineNotice>
      ) : null}
      {jump ? (
        <InlineNotice
          tone={jump.ok && jump.scrolled ? 'success' : jump.ok ? 'info' : 'warning'}
          live
        >
          {jump.message}
        </InlineNotice>
      ) : null}
    </li>
  );
}

/**
 * The results of a finished exam, from the outcomes fixed when marking ended. Nothing here changes
 * the review schedule unless the person counts the exam as review (and that can be undone).
 */
export function ExamResults({
  exam,
  cards,
  timeZone,
  countBusy,
  countError,
  reviewNote,
  onCount,
  onClose,
}: {
  exam: ExamSession;
  cards: ReadonlyMap<string, Card>;
  timeZone: string;
  countBusy: boolean;
  countError: string | null;
  reviewNote: string | null;
  onCount(on: boolean): void;
  onClose(): void;
}) {
  const uid = useId();
  const [wanted, setWanted] = useState<boolean | null>(null);
  const outcomes = exam.outcomes ?? [];
  const score = scoreOutcomes(outcomes);
  const timing = examTiming(exam);
  const parts = examBreakdown(exam, outcomes);
  const plan = planExamReview(exam);
  const counted = isCountedAsReview(exam);
  const undone = exam.review !== null && exam.review.undoneAt !== null;
  const missed = exam.questions.flatMap((q, i) => {
    const o = outcomes[i];
    return o === 'wrong' || o === 'unanswered' ? [{ q, i, o }] : [];
  });
  const contexts = useAsync(async () => {
    const out: Record<string, CardSourceContext | null> = {};
    await Promise.all(
      missed.map(async ({ q }) => {
        try {
          out[q.cardId] = await getCardSourceContext(q.cardId);
        } catch {
          out[q.cardId] = null; // the card is gone: the item says so
        }
      }),
    );
    return out;
  }, [exam.id]);

  const countReason = undone
    ? 'This exam was counted once and then undone. An exam can only be counted once.'
    : plan.items.length === 0
      ? 'No answered question to count.'
      : null;

  return (
    <section className="sv-stack" aria-labelledby={`${uid}-h`} data-testid={TID.examResults}>
      <h2 id={`${uid}-h`}>Exam results</h2>
      <p className="sv-muted">
        {exam.scopeLabel}, finished {formatWhen(exam.finishedAt ?? exam.lastAt, timeZone)}.
      </p>

      <div className="rv-stats" data-testid={TID.examScore}>
        <div className="rv-stat">
          <span className="rv-count">
            {score.fraction === null ? 'n/a' : percent(score.fraction)}
          </span>
          <span className="sv-small">
            {score.correct} of {score.graded} correct
          </span>
        </div>
        <div className="rv-stat">
          <span className="rv-count">{score.wrong}</span>
          <span className="sv-small">wrong</span>
        </div>
        <div className="rv-stat">
          <span className="rv-count">{score.unanswered}</span>
          <span className="sv-small">unanswered</span>
        </div>
        <div className="rv-stat">
          <span className="rv-count">{examDuration(timing.usedMs)}</span>
          <span className="sv-small">
            {timing.limitMs === null
              ? 'no time limit'
              : timing.timedOut
                ? `time ran out (limit ${exam.minutes} min)`
                : `of ${exam.minutes} min`}
          </span>
        </div>
      </div>
      {score.void > 0 ? (
        <p className="sv-small sv-muted">
          {plural(score.void, 'question')} could not be scored because the card was removed or
          changed type; {score.void === 1 ? 'it is' : 'they are'} left out of the score.
        </p>
      ) : null}

      <Breakdown title="By bank" first="Bank" rows={parts.banks} testId={TID.examBanks} />
      <Breakdown title="By tag" first="Tag" rows={parts.tags} testId={TID.examTags} />
      {parts.tags.length > 0 ? (
        <p className="sv-small sv-muted">A question with several tags counts under each of them.</p>
      ) : null}

      <details className="rv-details" data-testid={TID.examTimes}>
        <summary>
          Time per question
          {timing.meanMs === null ? '' : ` (average ${examDuration(timing.meanMs)})`}
        </summary>
        <div className="rv-details__body rv-tablewrap">
          <table className="rv-table">
            <caption className="sv-sr">Time spent on each question</caption>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Question</th>
                <th scope="col">Result</th>
                <th scope="col">Time</th>
              </tr>
            </thead>
            <tbody>
              {exam.questions.map((q, i) => {
                const o = OUTCOME[outcomes[i] ?? 'void'];
                return (
                  <tr key={q.cardId}>
                    <th scope="row">{i + 1}</th>
                    <td className="sv-wrap">
                      {truncate(cards.get(q.cardId)?.front ?? '(card removed)', 70)}
                    </td>
                    <td>
                      <span aria-hidden="true">{o.glyph}</span> {o.text}
                    </td>
                    <td>{examDuration(q.spentMs)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </details>

      <section className="sv-stack" aria-labelledby={`${uid}-missed`} data-testid={TID.examMissed}>
        <h3 id={`${uid}-missed`}>Missed questions</h3>
        {missed.length === 0 ? (
          <p>Nothing was missed.</p>
        ) : (
          <>
            {contexts.error ? (
              <InlineNotice tone="warning">
                The sources could not be loaded ({contexts.error}); your saved quotes are shown
                where they exist.
              </InlineNotice>
            ) : null}
            <ol className="sv-stack">
              {missed.map(({ q, i, o }) => (
                <MissedItem
                  key={q.cardId}
                  q={q}
                  index={i}
                  outcome={o}
                  card={cards.get(q.cardId) ?? null}
                  context={contexts.data?.[q.cardId]}
                />
              ))}
            </ol>
          </>
        )}
      </section>

      <section className="sv-stack sv-stack--tight" aria-labelledby={`${uid}-review`}>
        <h3 id={`${uid}-review`}>After the exam</h3>
        <label className="sv-check">
          <input
            type="checkbox"
            data-testid={TID.examCount}
            // While the work runs the box shows what was asked for, not the old state.
            checked={countBusy && wanted !== null ? wanted : counted}
            disabled={countBusy || countReason !== null}
            aria-busy={countBusy || undefined}
            aria-describedby={`${uid}-count-note`}
            onChange={(e) => {
              setWanted(e.target.checked);
              onCount(e.target.checked);
            }}
          />
          <span>Count this exam as review</span>
        </label>
        <p id={`${uid}-count-note`} className="sv-small sv-muted">
          {countReason ??
            `Gives ${plural(plan.items.length, 'answered card')} one rating each (correct is Good, wrong is Again) and updates their schedule. ${
              plan.skipped > 0 ? `${plural(plan.skipped, 'question')} left alone. ` : ''
            }Untick it to undo.`}
        </p>
        <p className="sv-small" role="status" data-testid={TID.examCountStatus}>
          {reviewNote ??
            (counted && exam.review
              ? `Counted: ${plural(exam.review.logs.length, 'card')} rated.`
              : '')}
        </p>
        {countError ? <InlineNotice tone="error">{countError}</InlineNotice> : null}

        <div className="sv-row">
          <Button
            data-testid={TID.examExport}
            onClick={() =>
              downloadText(
                `studyvault-exam-${(exam.finishedAt ?? exam.lastAt).slice(0, 10)}.md`,
                examToMarkdown(exam, cards),
              )
            }
          >
            Export results as Markdown
          </Button>
          <Button variant="primary" data-testid={TID.examClose} onClick={onClose}>
            Close results
          </Button>
        </div>
      </section>
    </section>
  );
}
