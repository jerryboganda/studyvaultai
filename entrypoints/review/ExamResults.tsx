import { useId, useState, type ReactNode } from 'react';
import {
  CircleCheck,
  CircleMinus,
  CircleX,
  Clock,
  Download,
  LocateFixed,
  type LucideIcon,
} from 'lucide-react';
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
import { SKIP_REASON_TEXT } from '@study/examSyllabus';
import {
  getCardSourceContext,
  getSyllabus,
  listBanks,
  listTags,
  type CardSourceContext,
} from '@storage';
import {
  Badge,
  Button,
  ChunkyButton,
  InfoTip,
  InlineNotice,
  ProgressRing,
  VaultBuddy,
  plural,
  truncate,
  useAction,
  useAsync,
} from '@ui';
import { TID, examJumpId, examMissedId, examStudyTopicId, formatWhen, percent } from '@ui/review';
import { openDashboard, type DashboardTarget } from '@ui/vault/dashboardLink';
import { subtreeMappings, topicLibraryTarget } from '@ui/vault/topicLink';
import { openSource, type JumpResult } from './jump';

/** Missed questions shown before "Show all": a long exam must not turn the results into a wall. */
const MISSED_PREVIEW = 5;

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
  action,
}: {
  title: string;
  first: string;
  rows: BreakdownRow[];
  testId: string;
  /** An extra column: a button per row. */
  action?: { header: string; cell(row: BreakdownRow): ReactNode };
}) {
  if (rows.length === 0) return null;
  return (
    <section className="rv-breakdown" data-testid={testId}>
      <h3 className="rv-subhead">{title}</h3>
      {/* Scrolls sideways on a narrow screen: focusable so the keyboard can scroll it. */}
      <div className="rv-tablewrap" role="region" aria-label={title} tabIndex={0}>
        <table className="rv-table rv-table--cards">
          <caption className="sv-sr">{title}</caption>
          <thead>
            <tr>
              <th scope="col">{first}</th>
              <th scope="col">Questions</th>
              <th scope="col">Correct</th>
              <th scope="col">Wrong</th>
              <th scope="col">Unanswered</th>
              <th scope="col">Score</th>
              {action ? <th scope="col">{action.header}</th> : null}
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
                <td>
                  <span className="rv-scorecell">
                    <span className="rv-bars__track" aria-hidden="true">
                      <span
                        className="rv-bars__fill rv-bars__fill--success"
                        style={{ width: `${Math.round((r.correct / r.total) * 100)}%` }}
                      />
                    </span>
                    <span>{percent(r.correct / r.total)}</span>
                  </span>
                </td>
                {action ? <td>{action.cell(r)}</td> : null}
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
    <li className="rv-missed" data-testid={examMissedId(index)}>
      <div className="rv-missed__head">
        <h4 className="rv-missed__title">Question {index + 1}</h4>
        <Badge tone={outcome === 'wrong' ? 'danger' : 'neutral'} glyph={o.glyph}>
          {o.text}
        </Badge>
      </div>
      {card ? (
        <>
          <p className="rv-missed__q">{card.front}</p>
          <p className="rv-missed__a rv-missed__a--yours">
            <span className="sv-label">Your answer: </span>
            <span className="rv-prewrap">{givenAnswerText(q, card) ?? 'No answer'}</span>
          </p>
          <p className="rv-missed__a rv-missed__a--key">
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
          variant="ghost"
          data-testid={examJumpId(index)}
          busy={open.busy}
          disabledReason={
            card?.highlightId ? undefined : 'This card has no source: it was typed in by hand.'
          }
          onClick={() => void open.run()}
        >
          <LocateFixed aria-hidden="true" className="rv-icon" strokeWidth={2.5} />
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
  const [allMissed, setAllMissed] = useState(false);
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

  // "Study this topic" opens the same dashboard list the coverage table's "Show" opens, so the
  // topic is read as it is now (it may have been edited since the exam).
  const syllabusId = exam.scope.kind === 'syllabus' ? exam.scope.syllabusId : null;
  const hasTopics = parts.topics.length > 0;
  const links = useAsync(async () => {
    if (syllabusId === null || !hasTopics) return null;
    const [syllabus, banks, tags] = await Promise.all([
      getSyllabus(syllabusId),
      listBanks(),
      listTags(),
    ]);
    return {
      mappings: syllabus ? subtreeMappings(syllabus.nodes) : null,
      banks: new Map(banks.map((b) => [b.id, b.name] as const)),
      tags: new Map(tags.map((t) => [t.tag.id, t.tag.name] as const)),
    };
  }, [exam.id, syllabusId, hasTopics]);
  const openTopic = useAction(async (target: DashboardTarget) => {
    await openDashboard(target);
  });
  const studyCell = (r: BreakdownRow): ReactNode => {
    const found = links.data?.mappings?.get(r.key);
    const target =
      found && links.data ? topicLibraryTarget(found, links.data.banks, links.data.tags) : null;
    const why = links.error
      ? `The syllabus could not be read: ${links.error}`
      : !links.data
        ? 'Reading your syllabus…'
        : links.data.mappings === null
          ? 'This syllabus has been deleted since the exam.'
          : !target
            ? 'This topic is no longer in the syllabus.'
            : target.kind === 'none'
              ? target.reason
              : undefined;
    return (
      <Button
        data-testid={examStudyTopicId(r.key)}
        aria-label={`Study this topic: ${r.label}`}
        disabledReason={why}
        onClick={() => {
          if (!target || target.kind === 'none') return;
          void openTopic.run(target.kind === 'bank' ? { bank: target.bankId } : { q: target.q });
        }}
      >
        Study this topic
      </Button>
    );
  };

  const countReason = undone
    ? 'This exam was counted once and then undone. An exam can only be counted once.'
    : plan.items.length === 0
      ? 'No answered question to count.'
      : null;

  const primaryRows = parts.topics.length > 0 ? 'topics' : 'banks';
  const timeText =
    timing.limitMs === null
      ? 'taken'
      : timing.timedOut
        ? `time ran out (limit ${exam.minutes} min)`
        : `of ${exam.minutes} min`;
  const chips: { icon: LucideIcon; tone: string; value: ReactNode; label: string }[] = [
    { icon: CircleX, tone: 'danger', value: score.wrong, label: 'wrong' },
    { icon: CircleMinus, tone: 'neutral', value: score.unanswered, label: 'unanswered' },
    { icon: Clock, tone: 'primary', value: examDuration(timing.usedMs), label: timeText },
  ];
  const topicsTable = (
    <Breakdown
      title="By topic"
      first="Topic"
      rows={parts.topics}
      testId={TID.examTopics}
      action={{ header: 'Study', cell: studyCell }}
    />
  );
  const banksTable = (
    <Breakdown title="By bank" first="Bank" rows={parts.banks} testId={TID.examBanks} />
  );

  return (
    <section className="rv-results" aria-labelledby={`${uid}-h`} data-testid={TID.examResults}>
      <header className="rv-results__hero">
        <VaultBuddy
          pose={score.fraction !== null && score.fraction >= 0.6 ? 'cheer' : 'think'}
          size={112}
          className="rv-results__buddy"
        />
        <div className="rv-results__head">
          <h2 id={`${uid}-h`} className="rv-tabhead__title">
            Exam results
          </h2>
          <p className="rv-tabhead__line">
            {exam.scopeLabel}, finished {formatWhen(exam.finishedAt ?? exam.lastAt, timeZone)}.
          </p>
        </div>
        <div className="rv-score" data-testid={TID.examScore}>
          {score.fraction === null ? (
            <span className="rv-score__na">n/a</span>
          ) : (
            <ProgressRing
              value={score.correct}
              max={score.graded}
              label="Score"
              unit="correct"
              tone="success"
              size={120}
              stroke={14}
            >
              <span className="rv-ring__num">{percent(score.fraction)}</span>
            </ProgressRing>
          )}
          <div className="rv-score__facts">
            <strong className="rv-score__main">
              {score.correct} of {score.graded} correct
            </strong>
            <ul className="rv-score__chips">
              {chips.map(({ icon: Icon, tone, value, label }) => (
                <li key={label} className={`rv-scorechip rv-scorechip--${tone}`}>
                  <Icon aria-hidden="true" strokeWidth={2.6} />
                  <strong>{value}</strong> <span>{label}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </header>
      {score.void > 0 ? (
        <p className="rv-wizline">
          {plural(score.void, 'question')} could not be scored because the card was removed or
          changed type; {score.void === 1 ? 'it is' : 'they are'} left out of the score.
        </p>
      ) : null}

      {primaryRows === 'topics' ? topicsTable : banksTable}
      {openTopic.error ? (
        <InlineNotice tone="error" title="Could not open the dashboard">
          {openTopic.error}
        </InlineNotice>
      ) : null}
      {exam.syllabus ? (
        <div className="sv-stack sv-stack--tight">
          {hasTopics ? (
            <p className="sv-small sv-muted">
              A card that belongs to several topics counts under one of them, so each question is
              listed once.
            </p>
          ) : null}
          {exam.syllabus.skipped.length > 0 || exam.syllabus.undrawn > 0 ? (
            <p className="sv-small" data-testid={TID.examLeftOut}>
              Left out of this exam:{' '}
              {[
                ...exam.syllabus.skipped.map((s) => `${s.title} (${SKIP_REASON_TEXT[s.reason]})`),
                ...(exam.syllabus.undrawn > 0
                  ? [
                      `${plural(exam.syllabus.undrawn, 'card')} that only belong to a topic with subtopics`,
                    ]
                  : []),
              ].join('; ')}
              .
            </p>
          ) : null}
        </div>
      ) : null}

      <section
        className="rv-breakdown"
        aria-labelledby={`${uid}-missed`}
        data-testid={TID.examMissed}
      >
        <h3 id={`${uid}-missed`} className="rv-subhead">
          Missed questions
        </h3>
        {missed.length === 0 ? (
          <p className="rv-wizline">
            <CircleCheck aria-hidden="true" strokeWidth={2.6} />
            Nothing was missed.
          </p>
        ) : (
          <>
            {contexts.error ? (
              <InlineNotice tone="warning">
                The sources could not be loaded ({contexts.error}); your saved quotes are shown
                where they exist.
              </InlineNotice>
            ) : null}
            <ol className="rv-missedlist">
              {(allMissed ? missed : missed.slice(0, MISSED_PREVIEW)).map(({ q, i, o }) => (
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
            {!allMissed && missed.length > MISSED_PREVIEW ? (
              <div className="sv-row">
                <ChunkyButton onClick={() => setAllMissed(true)}>
                  Show all {missed.length}
                </ChunkyButton>
              </div>
            ) : null}
          </>
        )}
      </section>

      <details className="rv-details rv-more">
        <summary>More details</summary>
        <div className="rv-details__body sv-stack">
          {primaryRows === 'topics' ? banksTable : null}
          <Breakdown title="By tag" first="Tag" rows={parts.tags} testId={TID.examTags} />
          {parts.tags.length > 0 ? (
            <p className="sv-small sv-muted">
              A question with several tags counts under each of them.
            </p>
          ) : null}
          <section className="rv-breakdown" data-testid={TID.examTimes}>
            <h3 className="rv-subhead">
              Time per question
              {timing.meanMs === null ? '' : ` (average ${examDuration(timing.meanMs)})`}
            </h3>
            <div className="rv-tablewrap" role="region" aria-label="Time per question" tabIndex={0}>
              <table className="rv-table rv-table--cards">
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
          </section>
        </div>
      </details>

      <section className="rv-after" aria-labelledby={`${uid}-review`}>
        <h3 id={`${uid}-review`} className="rv-subhead">
          After the exam
        </h3>
        <span className="rv-switchrow">
          <label className="sv-check">
            <input
              type="checkbox"
              role="switch"
              className="sv-switch"
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
            <span>Count as review</span>
          </label>
          <InfoTip label="About counting as review" align="start">
            Gives {plural(plan.items.length, 'answered card')} one rating each (correct is Good,
            wrong is Again) and updates their schedule. Untick it to undo.
          </InfoTip>
        </span>
        <p id={`${uid}-count-note`} className="sv-small sv-muted">
          {countReason ??
            (plan.skipped > 0
              ? `${plural(plan.skipped, 'question')} left alone. Untick it to undo.`
              : 'Untick it to undo.')}
        </p>
        <p className="sv-small" role="status" data-testid={TID.examCountStatus}>
          {reviewNote ??
            (counted && exam.review
              ? `Counted: ${plural(exam.review.logs.length, 'card')} rated.`
              : '')}
        </p>
        {countError ? <InlineNotice tone="error">{countError}</InlineNotice> : null}

        <div className="rv-examnav">
          <ChunkyButton
            icon={Download}
            data-testid={TID.examExport}
            onClick={() =>
              downloadText(
                `studyvault-exam-${(exam.finishedAt ?? exam.lastAt).slice(0, 10)}.md`,
                examToMarkdown(exam, cards),
              )
            }
          >
            Export results
          </ChunkyButton>
          <span className="rv-examnav__spacer" />
          <ChunkyButton variant="primary" data-testid={TID.examClose} onClick={onClose}>
            Close results
          </ChunkyButton>
        </div>
      </section>
    </section>
  );
}
