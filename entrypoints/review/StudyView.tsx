import { useEffect, useRef } from 'react';
import { RATINGS, RATING_LABELS, type Deck } from '@study';
import {
  clearStudySession,
  getAnalyticsInput,
  getStudyOverview,
  loadStudySession,
  type DeckOverview,
  type StudyOverview,
} from '@storage';
import {
  Badge,
  Button,
  EmptyState,
  InlineNotice,
  plural,
  useAction,
  useAsync,
  useDataEpoch,
  useObserved,
} from '@ui';
import {
  TID,
  clockKey,
  computeAnalytics,
  deckRowId,
  deckStartId,
  formatDuration,
  formatWhen,
  percent,
  toBoundary,
  toClock,
  toQueuePrefs,
  useReviewSession,
  useTick,
  type ReviewView,
  type SessionState,
  type StudySettings,
  type ReviewSessionController,
} from '@ui/review';
import { BacklogRecovery } from './Backlog';
import { Session } from './Session';

export function StudyView({
  settings,
  start,
  deckId,
  onFocusMode,
  onNavigate,
}: {
  settings: StudySettings;
  /** The page was opened to start (or continue) a session right away. */
  start: boolean;
  deckId: string | null;
  onFocusMode(active: boolean): void;
  onNavigate(view: ReviewView): void;
}) {
  const key = clockKey(settings);
  const tick = useTick();
  const epoch = useDataEpoch();
  const { controller, state } = useReviewSession({
    prefs: toQueuePrefs(settings),
    learnAheadMs: settings.learnAheadMinutes * 60_000,
    boundary: toBoundary(settings),
  });
  const overview = useObserved(() => getStudyOverview(toClock(settings)), [key, tick]);
  const stored = useObserved(() => loadStudySession(), []);
  const wantsStart = useRef(start);

  // New settings apply to the next card and the next session.
  useEffect(() => {
    controller.configure({
      prefs: toQueuePrefs(settings),
      learnAheadMs: settings.learnAheadMinutes * 60_000,
      boundary: toBoundary(settings),
    });
  }, [controller, settings]);

  const inSession =
    state.phase === 'question' || state.phase === 'answer' || state.phase === 'waiting';
  useEffect(() => {
    onFocusMode(inSession);
  }, [inSession, onFocusMode]);

  // Opened with ?start=1 (side panel button): continue a saved session, else start one. Once.
  useEffect(() => {
    if (!wantsStart.current || stored.loading) return;
    wantsStart.current = false;
    const url = new URL(window.location.href);
    url.searchParams.delete('start');
    window.history.replaceState(null, '', url);
    const s = stored.data;
    if (s && s.pending.length + s.learning.length > 0) void controller.resume();
    else void controller.start(deckId ? [deckId] : null);
  }, [controller, deckId, stored.loading, stored.data]);

  const resumable =
    stored.data && stored.data.pending.length + stored.data.learning.length > 0
      ? {
          remaining: stored.data.pending.length + stored.data.learning.length,
          answered: stored.data.answered,
        }
      : null;

  if (state.phase === 'loading') return <p className="sv-muted">Loading cards…</p>;
  if (inSession) {
    return (
      <Session
        state={state}
        controller={controller}
        timeZone={settings.timeZone}
        onLeave={() => controller.leave()}
      />
    );
  }
  if (state.phase === 'done') {
    return (
      <SessionDone
        state={state}
        controller={controller}
        settings={settings}
        onBack={() => controller.leave()}
        onStartMore={() => void controller.start(null)}
        epoch={epoch}
      />
    );
  }

  return (
    <DeckPicker
      settings={settings}
      overview={overview.data ?? null}
      loading={overview.loading}
      error={overview.error ?? stored.error}
      retry={overview.refresh}
      resumable={resumable}
      sessionError={state.phase === 'error' ? state.error : null}
      notice={state.notice}
      busy={state.busy}
      onStart={(ids) => void controller.start(ids)}
      onResume={() => void controller.resume()}
      onNavigate={onNavigate}
    />
  );
}

function DeckPicker({
  settings,
  overview,
  loading,
  error,
  retry,
  resumable,
  sessionError,
  notice,
  busy,
  onStart,
  onResume,
  onNavigate,
}: {
  settings: StudySettings;
  overview: StudyOverview | null;
  loading: boolean;
  error: string | null;
  retry(): void;
  resumable: { remaining: number; answered: number } | null;
  sessionError: string | null;
  notice: string | null;
  busy: boolean;
  onStart(deckIds: string[] | null): void;
  onResume(): void;
  onNavigate(view: ReviewView): void;
}) {
  const discard = useAction(async () => {
    await clearStudySession();
  });

  if (error) {
    return (
      <InlineNotice
        tone="error"
        title="Your decks could not be loaded"
        action={<Button onClick={retry}>Retry</Button>}
      >
        {error}
      </InlineNotice>
    );
  }
  if (loading || !overview) return <p className="sv-muted">Loading your decks…</p>;

  const { due } = overview;
  const decksByBank = new Map<string | null, DeckOverview[]>();
  for (const d of overview.decks) {
    const list = decksByBank.get(d.deck.bankId) ?? [];
    list.push(d);
    decksByBank.set(d.deck.bankId, list);
  }
  const deferred = overview.deferred.review + overview.deferred.new;

  return (
    <div className="sv-stack" data-testid={TID.deckPicker}>
      {sessionError ? (
        <InlineNotice tone="error" title="The session could not start">
          {sessionError}
        </InlineNotice>
      ) : null}
      {notice ? (
        <InlineNotice tone="info" live>
          {notice}
        </InlineNotice>
      ) : null}

      {resumable ? (
        <InlineNotice
          tone="info"
          title="A session is in progress"
          action={
            <div className="sv-row">
              <Button
                variant="primary"
                data-testid={TID.deckContinue}
                busy={busy}
                onClick={onResume}
              >
                Continue ({resumable.remaining} left)
              </Button>
              <Button
                data-testid={TID.deckDiscard}
                busy={discard.busy}
                onClick={() => void discard.run()}
              >
                Discard it
              </Button>
            </div>
          }
        >
          You answered {resumable.answered} so far. Continuing skips cards you already answered or
          changed.
        </InlineNotice>
      ) : null}
      {discard.error ? <InlineNotice tone="error">{discard.error}</InlineNotice> : null}

      <section className="rv-today sv-stack sv-stack--tight" aria-label="Due today">
        <h2>Today</h2>
        <p>
          <span className="rv-count" data-testid={TID.dueTotal}>
            {due.total}
          </span>{' '}
          {due.total === 1 ? 'card' : 'cards'} to study:{' '}
          <span data-testid={TID.dueNew}>{plural(due.new, 'new card')}</span>,{' '}
          <span data-testid={TID.dueLearning}>{plural(due.learning, 'learning step')}</span>,{' '}
          <span data-testid={TID.dueReview}>{plural(due.review, 'review')}</span>.
        </p>
        {deferred > 0 ? (
          <p className="sv-small sv-muted" data-testid={TID.deferredNote}>
            {plural(deferred, 'more card')} ({overview.deferred.review} reviews,{' '}
            {overview.deferred.new} new) are due but beyond today&rsquo;s daily limits. They stay
            due and are not skipped; raise the limits in deck settings to study them now.
          </p>
        ) : null}
        {overview.nextLearningAt ? (
          <p className="sv-small sv-muted" data-testid={TID.nextLearning}>
            Next learning step: {formatWhen(overview.nextLearningAt, settings.timeZone)}.
          </p>
        ) : null}
        <div className="sv-row">
          <Button
            variant="primary"
            data-testid={TID.deckStartAll}
            busy={busy}
            disabledReason={
              due.total === 0 && !overview.nextLearningAt ? 'Nothing is due right now.' : undefined
            }
            onClick={() => onStart(null)}
          >
            Study everything due
          </Button>
          {due.total === 0 && !overview.nextLearningAt ? (
            <span className="sv-small sv-muted">Nothing is due right now.</span>
          ) : null}
        </div>
      </section>

      {overview.decks.length === 0 ? (
        <div data-testid={TID.deckEmpty}>
          <EmptyState
            title="No flashcards yet"
            action={<Button onClick={() => onNavigate('create')}>Create cards</Button>}
          >
            Make cards from a saved highlight, or type one in by hand. They are stored on this
            device and need no account.
          </EmptyState>
        </div>
      ) : (
        <section className="sv-stack" aria-label="Decks">
          <h2>Decks</h2>
          {[...decksByBank.entries()].map(([bankId, decks]) => {
            const bank = overview.banks.find((b) => b.bankId === bankId);
            return (
              <div key={bankId ?? 'none'} className="sv-stack sv-stack--tight">
                <h3 className="rv-bankhead">
                  {bank?.name ?? 'Decks'}
                  {bank && decks.length > 1 ? (
                    <Button
                      variant="ghost"
                      disabledReason={
                        bank.due.total === 0 ? 'Nothing is due in this bank.' : undefined
                      }
                      onClick={() => onStart(decks.map((d) => d.deck.id))}
                    >
                      Study this bank ({bank.due.total})
                    </Button>
                  ) : null}
                </h3>
                <ul className="rv-decks">
                  {decks.map((d) => (
                    <DeckRow
                      key={d.deck.id}
                      d={d}
                      busy={busy}
                      onStart={() => onStart([d.deck.id])}
                    />
                  ))}
                </ul>
              </div>
            );
          })}
        </section>
      )}

      {overview.backlog.overdue > 0 ? (
        <section className="sv-stack" aria-label="Overdue cards">
          <details className="rv-details" open={overview.backlog.overdue >= 20}>
            <summary>
              {plural(overview.backlog.overdue, 'overdue review')}: recover from the backlog
            </summary>
            <div className="rv-details__body">
              <BacklogRecovery settings={settings} overdue={overview.backlog.overdue} />
            </div>
          </details>
        </section>
      ) : null}
    </div>
  );
}

function DeckRow({ d, busy, onStart }: { d: DeckOverview; busy: boolean; onStart(): void }) {
  const { deck, counts, due } = d;
  return (
    <li className="rv-deck" data-testid={deckRowId(deck.id)}>
      <div className="rv-deck__main">
        <span className="rv-deck__name sv-wrap">{deck.name}</span>
        <span className="sv-small sv-muted">
          {plural(counts.total, 'card')}
          {counts.suspended > 0 ? `, ${counts.suspended} suspended` : ''}
          {counts.overdue > 0 ? `, ${counts.overdue} overdue` : ''}
        </span>
      </div>
      <div className="rv-deck__counts" aria-label="Due now">
        <Badge tone={due.new > 0 ? 'info' : 'neutral'}>New {due.new}</Badge>
        <Badge tone={due.learning > 0 ? 'warning' : 'neutral'}>Learning {due.learning}</Badge>
        <Badge tone={due.review > 0 ? 'success' : 'neutral'}>Review {due.review}</Badge>
      </div>
      <Button
        data-testid={deckStartId(deck.id)}
        busy={busy}
        disabledReason={due.total === 0 ? 'Nothing is due in this deck right now.' : undefined}
        onClick={onStart}
      >
        Study ({due.total})
      </Button>
    </li>
  );
}

// ---------------------------------------------------------------------------------------------

function SessionDone({
  state,
  controller,
  settings,
  onBack,
  onStartMore,
  epoch,
}: {
  state: SessionState;
  controller: ReviewSessionController;
  settings: StudySettings;
  onBack(): void;
  onStartMore(): void;
  epoch: number;
}) {
  const s = state.summary;
  const next = useAsync(
    async () => {
      const input = await getAnalyticsInput({ ...toClock(settings), sinceDays: 1 });
      return computeAnalytics(input);
    },
    [clockKey(settings)],
    [epoch],
  );
  const forecast = next.data?.forecast;
  const tomorrow = forecast?.days[1]?.due ?? null;

  return (
    <section className="rv-card sv-stack" data-testid={TID.summary} aria-labelledby="rv-done-h">
      <h2 id="rv-done-h">{s && s.answered > 0 ? 'Session complete' : 'Nothing was due'}</h2>
      {s && s.answered > 0 ? (
        <>
          <p data-testid={TID.summaryAnswered}>
            You answered <strong>{s.answered}</strong> {s.answered === 1 ? 'card' : 'cards'} in
            about {formatDuration(s.durationMs)}
            {s.passRate !== null ? `, ${percent(s.passRate)} remembered` : ''}.
          </p>
          <div className="rv-tablewrap">
            <table className="rv-table">
              <caption className="sv-sr">Answers by button</caption>
              <thead>
                <tr>
                  {RATINGS.map((r) => (
                    <th key={r} scope="col">
                      {RATING_LABELS[r]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  {RATINGS.map((r) => (
                    <td key={r}>{s.byRating[r]}</td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
          <ul className="rv-list">
            <li>{plural(s.newCards, 'new card')} seen for the first time.</li>
            {s.lapses > 0 ? <li>{plural(s.lapses, 'learned card')} forgotten.</li> : null}
            {s.leeches > 0 ? (
              <li>
                {plural(s.leeches, 'card')} became a leech and {s.leeches === 1 ? 'was' : 'were'}{' '}
                suspended; rewrite {s.leeches === 1 ? 'it' : 'them'} in the Cards view.
              </li>
            ) : null}
          </ul>
        </>
      ) : (
        <p>There was nothing to study right now.</p>
      )}
      <p className="sv-muted" data-testid={TID.summaryNext}>
        {next.error
          ? 'What comes next could not be loaded.'
          : forecast
            ? `${plural(forecast.overdue + (forecast.days[0]?.due ?? 0), 'card')} still due today, ${
                tomorrow === null ? 'none' : tomorrow
              } due tomorrow.`
            : 'Working out what comes next…'}
      </p>
      {state.notice ? <InlineNotice tone="info">{state.notice}</InlineNotice> : null}
      <div className="sv-row">
        <Button variant="primary" onClick={onBack}>
          Back to decks
        </Button>
        <Button data-testid={TID.summaryAgain} onClick={onStartMore}>
          Check for more cards
        </Button>
        <Button
          busy={state.busy}
          disabledReason={state.lastAnswer ? undefined : 'No answer to undo in this session.'}
          onClick={() => void controller.undo()}
        >
          Undo last answer
        </Button>
      </div>
    </section>
  );
}

export type { Deck };
