import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { uuidv7 } from 'uuidv7';
import type { Card } from '@study';
import {
  chooseOption,
  createExam,
  endAnswering,
  finishExam,
  goToQuestion,
  gradeExam,
  historyEntry,
  markRecall,
  markRemaining,
  planExamReview,
  resumeExam,
  tickExam,
  typeAnswer,
  withReviewApplied,
  withReviewUndone,
  type ExamConfig,
  type ExamSession,
} from '@study/exam';
import { getCards } from '@storage';
import {
  applyExamReview,
  clearExamHistory,
  clearExamSession,
  loadExamData,
  loadExamHistory,
  loadExamSession,
  recordExamHistory,
  saveExamSession,
  undoExamReview,
} from '@storage/exam';
import {
  Button,
  ConfirmDialog,
  InlineNotice,
  errorMessage,
  plural,
  useAction,
  useAsync,
  useDataEpoch,
} from '@ui';
import { TID, toBoundary, type StudySettings } from '@ui/review';
import { ExamMarking, ExamRun } from './ExamRun';
import { ExamResults } from './ExamResults';
import { ExamSetup } from './ExamSetup';

/**
 * Exam simulation (ADR-020). One exam at a time, kept in the device-local `meta` table after every
 * change, so a reload, a crash or a second window can continue it; the rules are the pure functions
 * of `@study/exam`, this component only wires them to the page and the clock.
 */
export function ExamView({
  settings,
  onFocusMode,
}: {
  settings: StudySettings;
  onFocusMode(active: boolean): void;
}) {
  const stored = useAsync(() => loadExamSession(Date.now()), []);
  if (stored.error) {
    return (
      <InlineNotice
        tone="error"
        title="Your exam could not be loaded"
        action={<Button onClick={stored.refresh}>Retry</Button>}
      >
        {stored.error}
      </InlineNotice>
    );
  }
  if (!stored.data) return <p className="sv-muted">Loading…</p>;
  return (
    <ExamFlow
      settings={settings}
      onFocusMode={onFocusMode}
      initial={stored.data.session}
      expired={stored.data.expired}
    />
  );
}

function ExamFlow({
  settings,
  onFocusMode,
  initial,
  expired,
}: {
  settings: StudySettings;
  onFocusMode(active: boolean): void;
  initial: ExamSession | null;
  expired: boolean;
}) {
  const boundary = toBoundary(settings);
  const epoch = useDataEpoch();
  // A page that opens on an exam in progress continues it: the clock never stopped.
  const [boot] = useState(() => {
    if (initial?.phase !== 'answering') return { exam: initial, resumed: false, timedOut: false };
    const r = resumeExam(initial, Date.now());
    return { exam: r.exam, resumed: true, timedOut: r.timedOut };
  });
  const [exam, setExam] = useState<ExamSession | null>(boot.exam);
  const examRef = useRef<ExamSession | null>(boot.exam);
  const [screen, setScreen] = useState<'setup' | 'exam'>(boot.exam ? 'exam' : 'setup');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [notice, setNotice] = useState<string | null>(
    expired
      ? 'The exam you left unfinished expired after 24 hours and was removed.'
      : boot.timedOut
        ? 'The time limit ran out while this page was closed. Your answers were kept.'
        : null,
  );
  const [reviewNote, setReviewNote] = useState<string | null>(null);
  const [asking, setAsking] = useState<'discard' | 'clear' | null>(null);
  const [historyTick, setHistoryTick] = useState(0);

  const put = useCallback((next: ExamSession | null) => {
    examRef.current = next;
    setExam(next);
  }, []);
  /** Show the new exam state now and write it to the device; a failed write is reported, not hidden. */
  const commit = useCallback(
    (next: ExamSession) => {
      put(next);
      saveExamSession(next).then(
        () => setSaveError(null),
        (err: unknown) =>
          setSaveError(errorMessage(err, 'Your exam could not be saved on this device.')),
      );
    },
    [put],
  );
  const act = useCallback(
    (change: (e: ExamSession, now: number) => ExamSession) => {
      const current = examRef.current;
      if (!current) return;
      const next = change(current, Date.now());
      if (next !== current) commit(next);
    },
    [commit],
  );

  // What opening the page did to a running exam (time up, clock reset) is kept too.
  useEffect(() => {
    if (boot.resumed && boot.exam) void saveExamSession(boot.exam).catch(() => undefined);
  }, [boot]);

  // An exam on screen is the only thing on the page: no header, no tabs. Results show the tabs again.
  const focus = screen === 'exam' && exam !== null && exam.phase !== 'finished';
  useEffect(() => {
    onFocusMode(focus);
  }, [focus, onFocusMode]);
  useEffect(() => () => onFocusMode(false), [onFocusMode]);

  const cardsLoad = useAsync(
    () => getCards(examRef.current?.questions.map((q) => q.cardId) ?? []),
    [exam?.id ?? null, exam?.phase ?? null],
  );
  const cards = useMemo(
    () => new Map<string, Card>((cardsLoad.data ?? []).map((c) => [c.id, c] as const)),
    [cardsLoad.data],
  );

  const setup = useAsync(
    () => (screen === 'setup' ? loadExamData() : Promise.resolve(null)),
    [screen],
    [epoch],
  );
  const history = useAsync(() => loadExamHistory(), [], [historyTick]);

  const recordHistory = useCallback(async (e: ExamSession) => {
    const entry = historyEntry(e);
    if (!entry) return;
    try {
      await recordExamHistory(entry);
      setHistoryTick((n) => n + 1);
    } catch {
      // The list is a convenience; the results themselves are saved with the exam.
    }
  }, []);

  /** Marking is over: fix the outcomes against the cards as they are now and keep the summary. */
  const finalize = useCallback(
    async (current: ExamSession, live: readonly Card[]) => {
      const byId = new Map(live.map((c) => [c.id, c] as const));
      const done = finishExam(current, gradeExam(current, byId), Date.now());
      if (done === current) return;
      commit(done);
      await recordHistory(done);
    },
    [commit, recordHistory],
  );

  // Nothing to mark (no recall question, or every one was removed): go straight to the results.
  useEffect(() => {
    const live = cardsLoad.data;
    if (!exam || exam.phase !== 'marking' || !live) return undefined;
    const present = new Set(live.map((c) => c.id));
    if (exam.questions.some((q) => q.kind === 'recall' && present.has(q.cardId))) return undefined;
    const id = setTimeout(() => void finalize(exam, live), 0);
    return () => clearTimeout(id);
  }, [exam, cardsLoad.data, finalize]);

  const start = useAction(async (config: ExamConfig) => {
    // Fresh facts: cards may have changed since the form was drawn.
    const data = await loadExamData();
    const created = createExam({
      id: uuidv7(),
      now: Date.now(),
      random: Math.random,
      config,
      cards: data.cards,
      bankNames: data.bankNames,
    });
    await saveExamSession(created);
    put(created);
    setReviewNote(null);
    setNotice(null);
    setScreen('exam');
  });

  const showResults = useAction(async () => {
    const current = examRef.current;
    if (!current || current.phase !== 'marking') return;
    await finalize(current, await getCards(current.questions.map((q) => q.cardId)));
  });

  const count = useAction(async (on: boolean) => {
    const current = examRef.current;
    if (!current || current.phase !== 'finished') return;
    setReviewNote(null);
    if (on) {
      const plan = planExamReview(current);
      const out = await applyExamReview(plan.items, { sessionId: current.id, boundary });
      if (out.logs.length === 0) {
        setReviewNote('No card could be reviewed: they were deleted or suspended since the exam.');
        return;
      }
      const next = withReviewApplied(
        current,
        { logs: out.logs, skipped: plan.skipped + out.unavailable },
        Date.now(),
      );
      commit(next);
      setReviewNote(
        `Counted ${plural(out.logs.length, 'card')} as review.${
          out.unavailable > 0
            ? ` ${plural(out.unavailable, 'card')} could not be reviewed (deleted or suspended).`
            : ''
        }`,
      );
      await recordHistory(next);
    } else if (current.review) {
      const out = await undoExamReview(current.review.logs);
      const next = withReviewUndone(current, Date.now());
      commit(next);
      setReviewNote(
        `Undid ${plural(out.undone, 'review')}.${
          out.refused > 0
            ? ` ${plural(out.refused, 'card')} could not be undone because ${
                out.refused === 1 ? 'it was' : 'they were'
              } reviewed again since.`
            : ''
        }`,
      );
      await recordHistory(next);
    }
  });

  const closeExam = useAction(async () => {
    await clearExamSession();
    put(null);
    setReviewNote(null);
    setAsking(null);
    setScreen('setup');
  });

  const clearList = useAction(async () => {
    await clearExamHistory();
    setAsking(null);
    setHistoryTick((n) => n + 1);
  });

  const toSetup = () => setScreen('setup');
  const continueExam = () => {
    const current = examRef.current;
    if (!current) return;
    if (current.phase === 'answering') {
      // Time away is not charged to a question; time up, if it came, is applied.
      const r = resumeExam(current, Date.now());
      commit(r.exam);
      if (r.timedOut)
        setNotice('The time limit ran out while you were away. Your answers were kept.');
    }
    setScreen('exam');
  };

  let body: ReactNode;
  if (screen === 'setup' || !exam) {
    body = (
      <ExamSetup
        data={setup.data ?? null}
        loading={setup.loading}
        loadError={setup.error}
        retry={setup.refresh}
        current={exam}
        history={history.data ?? []}
        historyError={history.error}
        busy={start.busy}
        startError={start.error}
        timeZone={settings.timeZone}
        onStart={(config) => void start.run(config)}
        onContinue={continueExam}
        onShowResults={() => setScreen('exam')}
        onDiscard={() => (exam?.phase === 'finished' ? void closeExam.run() : setAsking('discard'))}
        onClearHistory={() => setAsking('clear')}
      />
    );
  } else if (!cardsLoad.data) {
    body = cardsLoad.error ? (
      <InlineNotice
        tone="error"
        title="The questions could not be loaded"
        action={<Button onClick={cardsLoad.refresh}>Retry</Button>}
      >
        {cardsLoad.error}
      </InlineNotice>
    ) : (
      <p className="sv-muted">Loading the questions…</p>
    );
  } else if (exam.phase === 'answering') {
    body = (
      <ExamRun
        exam={exam}
        cards={cards}
        announce={setAnnouncement}
        onChoose={(i, id) => act((e, now) => chooseOption(e, i, id, now))}
        onType={(i, text) => act((e, now) => typeAnswer(e, i, text, now))}
        onGo={(i) => act((e, now) => goToQuestion(e, i, now))}
        onFinish={() => act((e, now) => endAnswering(e, now))}
        onLeave={toSetup}
        onTimeUp={() => act((e, now) => tickExam(e, now))}
      />
    );
  } else if (exam.phase === 'marking') {
    body = (
      <>
        <ExamMarking
          exam={exam}
          cards={cards}
          onMark={(i, mark) => act((e) => markRecall(e, i, mark))}
          onMarkRest={() => act((e) => markRemaining(e, 'dont', (id) => cards.has(id)))}
          onShowResults={() => void showResults.run()}
        />
        {showResults.error ? <InlineNotice tone="error">{showResults.error}</InlineNotice> : null}
      </>
    );
  } else {
    body = (
      <ExamResults
        exam={exam}
        cards={cards}
        timeZone={settings.timeZone}
        countBusy={count.busy}
        countError={count.error}
        reviewNote={reviewNote}
        onCount={(on) => void count.run(on)}
        onClose={() => void closeExam.run()}
      />
    );
  }

  return (
    <div className="sv-stack">
      {/* One polite region for the whole exam: it outlives each screen, so "time is up" is heard. */}
      <p className="sv-sr" role="status" aria-live="polite" data-testid={TID.examAnnounce}>
        {announcement}
      </p>
      {notice ? (
        <InlineNotice
          tone="warning"
          live
          action={<Button onClick={() => setNotice(null)}>Dismiss</Button>}
        >
          {notice}
        </InlineNotice>
      ) : null}
      {saveError ? (
        <InlineNotice tone="warning" title="Not saved on this device">
          {saveError} Your answers are still on screen; if this page closes they may be lost.
        </InlineNotice>
      ) : null}
      {closeExam.error ? <InlineNotice tone="error">{closeExam.error}</InlineNotice> : null}
      {clearList.error ? <InlineNotice tone="error">{clearList.error}</InlineNotice> : null}
      {body}

      {asking === 'discard' ? (
        <ConfirmDialog
          title="Discard this exam?"
          confirmLabel="Discard exam"
          cancelLabel="Keep it"
          danger
          onConfirm={() => void closeExam.run()}
          onCancel={() => setAsking(null)}
        >
          <p>
            Its answers are deleted and no summary is kept. Your review schedule is not touched.
          </p>
        </ConfirmDialog>
      ) : null}
      {asking === 'clear' ? (
        <ConfirmDialog
          title="Clear the list of recent exams?"
          confirmLabel="Clear the list"
          danger
          onConfirm={() => void clearList.run()}
          onCancel={() => setAsking(null)}
        >
          <p>
            The summaries of finished exams are removed from this device. Cards are not touched.
          </p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
