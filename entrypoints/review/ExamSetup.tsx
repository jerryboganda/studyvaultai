import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { coverageTopics } from '@study/analytics';
import {
  EXAM_MAX_MINUTES,
  EXAM_MAX_QUESTIONS,
  examDuration,
  examScopeOptions,
  validateExamConfig,
  type ExamConfig,
  type ExamHistoryEntry,
  type ExamScope,
  type ExamSession,
} from '@study/exam';
import {
  SKIP_REASON_TEXT,
  drawSyllabusExam,
  syllabusExamCounts,
  syllabusExamPool,
  syllabusScopeLabel,
} from '@study/examSyllabus';
import { loadExamTopicRefs, type ExamData } from '@storage/exam';
import { Button, EmptyState, InlineNotice, plural, useAction, useAsync, useDataEpoch } from '@ui';
import { TID, formatWhen, percent, type ExamTarget } from '@ui/review';
import { openDashboard, type DashboardTarget } from '@ui/vault/dashboardLink';

const whole = (text: string): number => (/^\d+$/.test(text.trim()) ? Number(text) : Number.NaN);

/**
 * Exam setup: what to ask (a bank, folder or tag, or a syllabus topic), how many questions, an
 * optional time limit, and the history of recent exams. Everything the form says is derived from
 * the real cards.
 */
export function ExamSetup({
  data,
  loading,
  loadError,
  retry,
  current,
  target,
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
  /** A syllabus (and topic) to start from: the form opens on it. */
  target: ExamTarget | null;
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
  const epoch = useDataEpoch();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const options = useMemo(() => (data ? examScopeOptions(data) : []), [data]);
  const syllabi = data?.syllabi ?? [];
  const [scopeValue, setScopeValue] = useState('all');
  const [source, setSource] = useState<'library' | 'syllabus'>(target ? 'syllabus' : 'library');
  const [syllabusId, setSyllabusId] = useState<string | null>(target?.syllabusId ?? null);
  const [topicId, setTopicId] = useState<string | null>(target?.topicId ?? null);
  const [weighted, setWeighted] = useState(false);
  const [questionsText, setQuestionsText] = useState<string | null>(null);
  const [timed, setTimed] = useState(false);
  const [minutesText, setMinutesText] = useState<string | null>(null);
  const [shuffle, setShuffle] = useState(true);
  // One seed per form: the plan shown for a syllabus exam is the one that gets drawn.
  const [seed] = useState(() => Math.floor(Math.random() * 0x100000000));
  const openEditor = useAction(async (to: DashboardTarget) => {
    await openDashboard(to);
  });

  // The syllabus scope is only read when it is in use (it reads the filing of every card).
  const bySyllabus = source === 'syllabus' && syllabi.length > 0;
  const refs = useAsync(
    () => (bySyllabus ? loadExamTopicRefs() : Promise.resolve(null)),
    [bySyllabus],
    [epoch],
  );
  const syllabus = bySyllabus
    ? (syllabi.find((s) => s.id === syllabusId) ?? syllabi[0])
    : undefined;
  const topics = useMemo(() => (syllabus ? coverageTopics(syllabus.nodes) : []), [syllabus]);
  const topic = topicId === null ? null : (topics.find((t) => t.id === topicId) ?? null);
  const refsData = refs.data ?? null;
  const input = useMemo(
    () => (refsData === null ? null : { topics, refs: refsData }),
    [topics, refsData],
  );
  const counts = useMemo(
    () => (input && data && bySyllabus ? syllabusExamCounts(input, data.cards) : null),
    [input, data, bySyllabus],
  );
  const pool = useMemo(
    () =>
      input && data && bySyllabus
        ? syllabusExamPool({
            syllabus: input,
            topicId: topic?.id ?? null,
            weighted,
            cards: data.cards,
            seed,
          })
        : null,
    [input, data, bySyllabus, topic?.id, weighted, seed],
  );

  const option = options.find((o) => o.value === scopeValue) ?? options[0];
  const available = bySyllabus ? (pool?.drawable ?? 0) : (option?.available ?? 0);
  const inProgress = current !== null && current.phase !== 'finished';

  const questions = whole(questionsText ?? String(Math.min(20, Math.max(1, available))));
  const asked = Number.isFinite(questions) ? Math.min(questions, available) : available;
  const minutes = timed
    ? whole(minutesText ?? String(Math.min(EXAM_MAX_MINUTES, Math.max(1, asked))))
    : null;
  const check = validateExamConfig({ questions, minutes }, available);
  const wanted = check.ok ? check.count : null;
  const draw = useMemo(
    () => (pool && wanted !== null ? drawSyllabusExam(pool, wanted) : null),
    [pool, wanted],
  );

  const readingSyllabus = bySyllabus && !refs.error && refsData === null;
  const reason = readingSyllabus
    ? 'Reading your syllabus and cards…'
    : bySyllabus && refs.error
      ? 'Your syllabus could not be read.'
      : !check.ok
        ? (check.errors.questions ?? check.errors.minutes)
        : inProgress
          ? 'Finish or discard the exam in progress first.'
          : undefined;

  // A page opened on a syllabus puts the person at the form's heading.
  const ready = data !== null && !loading && loadError === null;
  useEffect(() => {
    if (target && ready) headingRef.current?.focus();
  }, [target, ready]);

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

  const picked: { scope: ExamScope; label: string } | null = bySyllabus
    ? syllabus
      ? {
          scope: {
            kind: 'syllabus',
            syllabusId: syllabus.id,
            topicId: topic?.id ?? null,
            weighted,
          },
          label: syllabusScopeLabel(syllabus.name, topic?.title ?? null, weighted),
        }
      : null
    : option
      ? { scope: option.scope, label: option.label }
      : null;

  const start = () => {
    if (!picked || !check.ok || reason !== undefined) return;
    onStart({
      scope: picked.scope,
      scopeLabel: picked.label,
      questions: check.count,
      minutes,
      shuffle,
      ...(bySyllabus ? { seed } : {}),
    });
  };
  const reset = () => setQuestionsText(null);

  const goneNote =
    target !== null && source === 'syllabus'
      ? syllabi.length === 0
        ? 'The syllabus this exam was to be made from has been deleted.'
        : !syllabi.some((s) => s.id === target.syllabusId)
          ? 'The syllabus you chose has been deleted. Pick another one below.'
          : target.topicId !== null && syllabusId === target.syllabusId && topic === null
            ? 'The topic you chose is no longer in this syllabus. The whole syllabus is shown.'
            : null
      : null;

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
        <h2 id={`${uid}-h`} ref={headingRef} tabIndex={-1}>
          Exam simulation
        </h2>
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
            {goneNote ? <InlineNotice tone="warning">{goneNote}</InlineNotice> : null}

            {syllabi.length > 0 ? (
              <fieldset className="rv-fieldset" data-testid={TID.examSource}>
                <legend className="sv-label">What to ask from</legend>
                <div className="sv-stack sv-stack--tight">
                  <label className="sv-check">
                    <input
                      type="radio"
                      name={`${uid}-source`}
                      data-testid={TID.examSourceLibrary}
                      checked={!bySyllabus}
                      onChange={() => {
                        setSource('library');
                        reset();
                      }}
                    />
                    <span>My banks, folders and tags</span>
                  </label>
                  <label className="sv-check">
                    <input
                      type="radio"
                      name={`${uid}-source`}
                      data-testid={TID.examSourceSyllabus}
                      checked={bySyllabus}
                      onChange={() => {
                        setSource('syllabus');
                        reset();
                      }}
                    />
                    <span>A syllabus (a topic of my outline)</span>
                  </label>
                </div>
              </fieldset>
            ) : null}

            {!bySyllabus ? (
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
                    reset();
                  }}
                >
                  {options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label} ({plural(o.available, 'card')})
                    </option>
                  ))}
                </select>
                {syllabi.length === 0 ? (
                  <p className="sv-small sv-muted" data-testid={TID.examSyllabusNone}>
                    To be asked by topic of an exam or course, make a syllabus first: an outline
                    whose topics point at your banks and tags.{' '}
                    <Button
                      onClick={() => void openEditor.run({ view: 'syllabus' })}
                      data-testid={TID.examSyllabusEdit}
                    >
                      Create a syllabus
                    </Button>
                  </p>
                ) : null}
              </div>
            ) : syllabus ? (
              <div className="sv-stack">
                <div className="sv-field">
                  <label className="sv-label" htmlFor={`${uid}-syl`}>
                    Syllabus
                  </label>
                  <select
                    id={`${uid}-syl`}
                    className="sv-control"
                    data-testid={TID.examSyllabus}
                    value={syllabus.id}
                    onChange={(e) => {
                      setSyllabusId(e.target.value);
                      setTopicId(null);
                      reset();
                    }}
                  >
                    {syllabi.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>

                {topics.length === 0 ? (
                  <EmptyState
                    title="This syllabus has no topics yet"
                    action={
                      <Button
                        onClick={() =>
                          void openEditor.run({ view: 'syllabus', syllabus: syllabus.id })
                        }
                        data-testid={TID.examSyllabusEdit}
                      >
                        Edit this syllabus
                      </Button>
                    }
                  >
                    Add topics in the syllabus editor and point them at banks and tags; an exam can
                    then be drawn from them.
                  </EmptyState>
                ) : (
                  <>
                    <div className="sv-field">
                      <label className="sv-label" htmlFor={`${uid}-topic`}>
                        Topic (with everything below it)
                      </label>
                      <select
                        id={`${uid}-topic`}
                        className="sv-control"
                        data-testid={TID.examTopic}
                        value={topic?.id ?? ''}
                        onChange={(e) => {
                          setTopicId(e.target.value === '' ? null : e.target.value);
                          reset();
                        }}
                      >
                        <option value="">
                          {`The whole syllabus${counts ? ` (${plural(counts.total, 'card')})` : ''}`}
                        </option>
                        {topics.map((t) => (
                          <option key={t.id} value={t.id}>
                            {`${' '.repeat(t.depth - 1)}${t.title}${
                              counts ? ` (${plural(counts.byTopic.get(t.id) ?? 0, 'card')})` : ''
                            }`}
                          </option>
                        ))}
                      </select>
                    </div>

                    <label className="sv-check">
                      <input
                        type="checkbox"
                        data-testid={TID.examWeighted}
                        checked={weighted}
                        aria-describedby={`${uid}-weighted-note`}
                        onChange={(e) => {
                          setWeighted(e.target.checked);
                          reset();
                        }}
                      />
                      <span>Weighted by topic weight</span>
                    </label>
                    <p id={`${uid}-weighted-note`} className="sv-small sv-muted">
                      Questions are shared between the lowest-level topics in proportion to their
                      weights (no weight counts as 1, and a topic’s part also follows its parents’
                      weights). A topic with no cards is left out and listed below.
                    </p>

                    {pool && pool.inScope === 0 ? (
                      <EmptyState
                        title="No card belongs to this topic yet"
                        action={
                          <Button
                            onClick={() =>
                              void openEditor.run({ view: 'syllabus', syllabus: syllabus.id })
                            }
                            data-testid={TID.examSyllabusEdit}
                          >
                            Edit this syllabus
                          </Button>
                        }
                      >
                        A card belongs to a topic when its bank or tag is one the topic (or a
                        subtopic) points at. Map a bank or tag to it in the editor, and make cards
                        from the highlights there. Suspended and deleted cards are not asked.
                      </EmptyState>
                    ) : pool ? (
                      <p className="sv-small" data-testid={TID.examSyllabusNote}>
                        {plural(pool.inScope, 'card')} belong to{' '}
                        {topic ? `“${topic.title}” and its subtopics` : 'this syllabus'}
                        {weighted && pool.inScope > pool.drawable
                          ? `; ${plural(
                              pool.inScope - pool.drawable,
                              'card',
                            )} only belong to a topic that has subtopics and are not drawn in a weighted exam`
                          : ''}
                        .
                      </p>
                    ) : null}

                    {draw && pool && pool.inScope > 0 ? (
                      <details className="rv-details" data-testid={TID.examPlan}>
                        <summary>
                          {weighted
                            ? `How the ${plural(draw.picked.length, 'question')} are shared between topics`
                            : `Lowest-level topics of this scope (${draw.rows.length})`}
                        </summary>
                        <div className="rv-details__body sv-stack sv-stack--tight">
                          <div className="rv-tablewrap">
                            <table className="rv-table">
                              <caption className="sv-sr">
                                {weighted
                                  ? 'Questions per lowest-level topic, by weight'
                                  : 'Cards per lowest-level topic'}
                              </caption>
                              <thead>
                                <tr>
                                  <th scope="col">Topic</th>
                                  {weighted ? <th scope="col">Share</th> : null}
                                  <th scope="col">Cards</th>
                                  {weighted ? <th scope="col">Questions</th> : null}
                                </tr>
                              </thead>
                              <tbody>
                                {draw.rows.map((r) => (
                                  <tr key={r.topicId}>
                                    <th scope="row">{r.title}</th>
                                    {weighted ? <td>{percent(r.share, 1)}</td> : null}
                                    <td>{r.available}</td>
                                    {weighted ? <td>{r.asked}</td> : null}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          {draw.skipped.length > 0 ? (
                            <p className="sv-small" data-testid={TID.examLeftOut}>
                              Left out:{' '}
                              {draw.skipped
                                .map((s) => `${s.title} (${SKIP_REASON_TEXT[s.reason]})`)
                                .join('; ')}
                              .
                            </p>
                          ) : null}
                          <p className="sv-small sv-muted">
                            A card that belongs to several topics is counted under one of them, so
                            the questions add up.
                          </p>
                        </div>
                      </details>
                    ) : null}
                  </>
                )}
                {refs.error ? (
                  <InlineNotice
                    tone="error"
                    title="Your syllabus cards could not be read"
                    action={
                      refs.retryable ? <Button onClick={refs.refresh}>Retry</Button> : undefined
                    }
                  >
                    {refs.error}
                  </InlineNotice>
                ) : null}
                {openEditor.error ? (
                  <InlineNotice tone="error" title="Could not open the dashboard">
                    {openEditor.error}
                  </InlineNotice>
                ) : null}
              </div>
            ) : null}

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
                aria-invalid={!readingSyllabus && !check.ok && check.errors.questions !== undefined}
                aria-describedby={`${uid}-n-note`}
                onChange={(e) => setQuestionsText(e.target.value)}
              />
              <p
                id={`${uid}-n-note`}
                className={check.ok || readingSyllabus ? 'sv-small sv-muted' : 'sv-small rv-error'}
              >
                {readingSyllabus
                  ? 'Reading your syllabus and cards…'
                  : !check.ok && check.errors.questions
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
