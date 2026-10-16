import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Check,
  Clock,
  Flame,
  GraduationCap,
  Hourglass,
  Layers,
  Play,
  Repeat2,
  RotateCcw,
  Sprout,
  Target,
  Undo2,
  Zap,
  type LucideIcon,
} from 'lucide-react';
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
  BarMeter,
  BuddyEmptyState,
  Button,
  ChunkyButton,
  Confetti,
  InfoTip,
  InlineNotice,
  ProgressRing,
  VaultBuddy,
  plural,
  useAction,
  useAsync,
  useDataEpoch,
  useObserved,
  type ArtTone,
} from '@ui';
import { useCelebrations, type GameView } from '@ui/game';
import {
  TID,
  celebrationText,
  clockKey,
  computeAnalytics,
  deckRowId,
  deckStartId,
  formatDuration,
  formatWhen,
  leftAfterSession,
  percent,
  sessionXp,
  toBoundary,
  toClock,
  toQueuePrefs,
  useDueCount,
  useReviewSession,
  useTick,
  type ReviewView,
  type SessionState,
  type StudySettings,
  type ReviewSessionController,
} from '@ui/review';
import { BacklogRecovery } from './Backlog';
import { RATING_ICON, Session } from './Session';

/** A quiet wait: the mascot appears only when loading takes a moment (CSS delay), never a number. */
export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="rv-loading" role="status">
      <VaultBuddy pose="think" size={72} />
      <p className="sv-muted">{label}</p>
    </div>
  );
}

export function StudyView({
  settings,
  game,
  start,
  deckId,
  onFocusMode,
  onNavigate,
}: {
  settings: StudySettings;
  game: GameView;
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

  if (state.phase === 'loading') return <Loading label="Loading cards…" />;
  if (inSession) {
    return (
      <Session
        state={state}
        controller={controller}
        game={game}
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
        game={game}
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

/** Decorative tile colour per deck, stable across renders (colour carries no meaning here). */
const DECK_TONES: ArtTone[] = ['primary', 'violet', 'success', 'warning', 'sun', 'danger'];
function toneOf(id: string): ArtTone {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return DECK_TONES[h % DECK_TONES.length]!;
}

/** "8 new cards" chip: icon + the count in words, so colour is never the only cue. */
function MixChip({
  icon: Icon,
  tone,
  testId,
  zero = false,
  children,
}: {
  icon: LucideIcon;
  tone: 'primary' | 'warning' | 'success';
  testId?: string;
  /** A count of 0 stays (it is a fact) but steps back. */
  zero?: boolean;
  children: ReactNode;
}) {
  return (
    <li className={`rv-mix__chip rv-mix__chip--${zero ? 'zero' : tone}`}>
      <Icon aria-hidden="true" strokeWidth={2.5} />
      <span data-testid={testId}>{children}</span>
    </li>
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
  if (loading || !overview) return <Loading label="Loading your decks…" />;

  const { due } = overview;
  const decksByBank = new Map<string | null, DeckOverview[]>();
  for (const d of overview.decks) {
    const list = decksByBank.get(d.deck.bankId) ?? [];
    list.push(d);
    decksByBank.set(d.deck.bankId, list);
  }
  const deferred = overview.deferred.review + overview.deferred.new;
  const nothingDue = due.total === 0 && !overview.nextLearningAt;
  const start = () => {
    if (!busy) onStart(null);
  };

  return (
    <div className="rv-study" data-testid={TID.deckPicker}>
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
        <section className="rv-resume" aria-labelledby="rv-resume-h">
          <span className="rv-resume__art sv-art--sun" aria-hidden="true">
            <Play strokeWidth={2.4} />
          </span>
          <div className="rv-resume__body">
            <h2 id="rv-resume-h" className="rv-resume__title">
              Session in progress
            </h2>
            <BarMeter
              value={resumable.answered}
              max={resumable.answered + resumable.remaining}
              label="Session progress"
              valueText={`${resumable.answered} answered, ${resumable.remaining} left`}
              tone="sun"
            />
            <p className="rv-resume__line">
              {resumable.answered} done · {resumable.remaining} left
              <InfoTip label="About continuing">
                Continuing skips cards you already answered or changed since.
              </InfoTip>
            </p>
          </div>
          <div className="rv-resume__actions">
            <Button variant="primary" data-testid={TID.deckContinue} busy={busy} onClick={onResume}>
              Continue ({resumable.remaining} left)
            </Button>
            <Button
              variant="ghost"
              data-testid={TID.deckDiscard}
              busy={discard.busy}
              onClick={() => void discard.run()}
            >
              Discard
            </Button>
          </div>
        </section>
      ) : null}
      {discard.error ? <InlineNotice tone="error">{discard.error}</InlineNotice> : null}

      {overview.decks.length === 0 ? (
        <div data-testid={TID.deckEmpty}>
          <BuddyEmptyState
            pose="sleep"
            title="No cards yet"
            text="Make cards from your saved highlights."
            heading="h2"
            mascotSize={140}
            action={{ label: 'Create cards', icon: Layers, onClick: () => onNavigate('create') }}
          />
        </div>
      ) : (
        <>
          <section className="rv-hero" aria-labelledby="rv-hero-h">
            <VaultBuddy
              pose={nothingDue ? 'sleep' : 'wave'}
              size={112}
              className="rv-hero__buddy"
            />
            <div className="rv-hero__main">
              <h2 id="rv-hero-h" className="rv-hero__title">
                <span className="rv-hero__num" data-testid={TID.dueTotal}>
                  {due.total}
                </span>{' '}
                {due.total === 1 ? 'card' : 'cards'} ready
              </h2>
              <ul className="rv-mix" aria-label="Due today">
                <MixChip icon={Sprout} tone="primary" testId={TID.dueNew} zero={due.new === 0}>
                  {plural(due.new, 'new card')}
                </MixChip>
                <MixChip
                  icon={GraduationCap}
                  tone="warning"
                  testId={TID.dueLearning}
                  zero={due.learning === 0}
                >
                  {plural(due.learning, 'learning step')}
                </MixChip>
                <MixChip
                  icon={Repeat2}
                  tone="success"
                  testId={TID.dueReview}
                  zero={due.review === 0}
                >
                  {plural(due.review, 'review')}
                </MixChip>
              </ul>
              {deferred > 0 ? (
                <p className="rv-hero__line" data-testid={TID.deferredNote}>
                  {plural(deferred, 'more card')} over daily limits
                  <InfoTip label="About daily limits" align="start">
                    {plural(deferred, 'more card')} ({overview.deferred.review} reviews,{' '}
                    {overview.deferred.new} new) are due but beyond today&rsquo;s daily limits. They
                    stay due and are not skipped.
                  </InfoTip>
                  <Button variant="ghost" onClick={() => onNavigate('settings')}>
                    Raise limits
                  </Button>
                </p>
              ) : null}
              {overview.nextLearningAt ? (
                <p className="rv-hero__line" data-testid={TID.nextLearning}>
                  <Clock aria-hidden="true" strokeWidth={2.5} />
                  Next learning step: {formatWhen(overview.nextLearningAt, settings.timeZone)}.
                </p>
              ) : null}
            </div>
            <div className="rv-hero__go">
              <ChunkyButton
                variant="sun"
                size="lg"
                icon={Play}
                data-testid={TID.deckStartAll}
                aria-busy={busy || undefined}
                disabledReason={nothingDue ? 'Nothing is due right now.' : undefined}
                onClick={start}
              >
                Start review
              </ChunkyButton>
              {nothingDue ? <p className="rv-hero__none">Nothing is due right now.</p> : null}
            </div>
          </section>

          <section className="rv-decks" aria-labelledby="rv-decks-h">
            <h2 id="rv-decks-h" className="rv-sechead">
              Your decks
            </h2>
            <ul className="rv-deckgrid">
              {[...decksByBank.entries()].flatMap(([bankId, decks]) => {
                const bank = overview.banks.find((b) => b.bankId === bankId);
                const items = decks.map((d) => (
                  <DeckCard
                    key={d.deck.id}
                    d={d}
                    bankName={bank && bank.bankId !== null && decks.length === 1 ? bank.name : null}
                    busy={busy}
                    onStart={() => onStart([d.deck.id])}
                  />
                ));
                if (!bank || decks.length < 2) return items;
                return [
                  <li key={`bank-${bankId ?? 'none'}`} className="rv-bankrow">
                    <h3 className="rv-bankrow__name">{bank.name}</h3>
                    <Button
                      variant="ghost"
                      disabledReason={
                        bank.due.total === 0 ? 'Nothing is due in this bank.' : undefined
                      }
                      onClick={() => onStart(decks.map((d) => d.deck.id))}
                    >
                      Study this bank ({bank.due.total})
                    </Button>
                  </li>,
                  ...items,
                ];
              })}
            </ul>
          </section>
        </>
      )}

      {overview.backlog.overdue > 0 ? (
        <details className="rv-catchup" open={overview.backlog.overdue >= 20}>
          <summary className="rv-catchup__summary">
            <span className="rv-catchup__art sv-art--warning" aria-hidden="true">
              <Hourglass strokeWidth={2.4} />
            </span>
            <span className="rv-catchup__text">
              <strong>{plural(overview.backlog.overdue, 'overdue review')}</strong>
              <span className="sv-small sv-muted">Spread them over a few days</span>
            </span>
          </summary>
          <div className="rv-catchup__body">
            <BacklogRecovery settings={settings} overdue={overview.backlog.overdue} />
          </div>
        </details>
      ) : null}
    </div>
  );
}

function DeckCard({
  d,
  bankName,
  busy,
  onStart,
}: {
  d: DeckOverview;
  /** Shown above the deck name when it says something the name does not. */
  bankName: string | null;
  busy: boolean;
  onStart(): void;
}) {
  const { deck, counts, due } = d;
  const meta = [
    plural(counts.total, 'card'),
    counts.suspended > 0 ? `${counts.suspended} suspended` : null,
    counts.overdue > 0 ? `${counts.overdue} overdue` : null,
  ].filter(Boolean);
  return (
    <li className="rv-deckcard" data-testid={deckRowId(deck.id)}>
      <div className="rv-deckcard__top">
        <span className={`rv-deckcard__art sv-art--${toneOf(deck.id)}`} aria-hidden="true">
          <Layers strokeWidth={2.4} />
        </span>
        <span className={`rv-deckcard__due${due.total === 0 ? ' is-done' : ''}`}>
          {due.total > 0 ? (
            <>
              {due.total}
              <span className="sv-vh"> due</span>
            </>
          ) : (
            <>
              <Check aria-hidden="true" strokeWidth={3} />
              <span className="sv-vh">Nothing due</span>
            </>
          )}
        </span>
      </div>
      <div className="rv-deckcard__body">
        {bankName && bankName !== deck.name ? (
          <span className="rv-deckcard__bank">{bankName}</span>
        ) : null}
        <h3 className="rv-deckcard__name">{deck.name}</h3>
        <p className="rv-deckcard__meta">{meta.join(' · ')}</p>
      </div>
      {due.total > 0 ? (
        <ul className="rv-mix rv-mix--small" aria-label="Due now">
          {due.new > 0 ? (
            <MixChip icon={Sprout} tone="primary">
              {due.new} new
            </MixChip>
          ) : null}
          {due.learning > 0 ? (
            <MixChip icon={GraduationCap} tone="warning">
              {due.learning} learning
            </MixChip>
          ) : null}
          {due.review > 0 ? (
            <MixChip icon={Repeat2} tone="success">
              {due.review} review
            </MixChip>
          ) : null}
        </ul>
      ) : null}
      <Button
        className="rv-deckcard__go"
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

function Fact({
  icon: Icon,
  tone,
  value,
  label,
  extra,
}: {
  icon: LucideIcon;
  tone: ArtTone;
  value: ReactNode;
  label: string;
  extra?: ReactNode;
}) {
  return (
    <li className="rv-fact">
      <span className={`rv-fact__icon sv-art--${tone}`} aria-hidden="true">
        <Icon strokeWidth={2.6} />
      </span>
      <span className="rv-fact__text">
        <strong>{value}</strong>
        <span>
          {label}
          {extra}
        </span>
      </span>
    </li>
  );
}

function SessionDone({
  state,
  controller,
  game,
  settings,
  onBack,
  onStartMore,
  epoch,
}: {
  state: SessionState;
  controller: ReviewSessionController;
  game: GameView;
  settings: StudySettings;
  onBack(): void;
  onStartMore(): void;
  epoch: number;
}) {
  const s = state.summary;
  const answered = s !== null && s.answered > 0;
  const title = useRef<HTMLHeadingElement>(null);
  const next = useAsync(
    async () => {
      const input = await getAnalyticsInput({ ...toClock(settings), sinceDays: 1 });
      return computeAnalytics(input);
    },
    [clockKey(settings)],
    [epoch],
  );
  const forecast = next.data?.forecast;
  // The same count as the page header's "due now", so the two numbers never disagree.
  const due = useDueCount();

  const g = game.data;
  const gameOn = g?.mode === true;
  const ready = g?.ready === true && g.mode ? g : null;
  // Celebrations wait for the end of the session (ADR-022): this screen is that moment.
  const celebrate = useCelebrations(g, { enabled: true });
  const party = celebrate.current;
  const partyText = party ? celebrationText(party) : null;
  // One burst for the finished session, then one per goal or level celebration (Game mode on).
  const [burst, setBurst] = useState<string | null>(() => (gameOn && answered ? 'done' : null));
  const partyKey = party && (party.kind === 'goal' || party.kind === 'level') ? party.key : null;
  const [lastParty, setLastParty] = useState<string | null>(null);
  if (partyKey !== lastParty) {
    setLastParty(partyKey);
    if (partyKey) setBurst(partyKey);
  }

  useEffect(() => {
    title.current?.focus({ preventScroll: true });
  }, []);

  const xp = s ? sessionXp(s.answered, state.bonus) : 0;
  const bonus = answered && (state.bonus === 'awarded' || state.bonus === 'already');

  return (
    <section className="rv-done" data-testid={TID.summary} aria-labelledby="rv-done-h">
      {burst && gameOn ? <Confetti key={burst} onDone={() => setBurst(null)} /> : null}
      <div className="rv-done__buddy">
        <VaultBuddy pose={answered ? 'cheer' : 'sleep'} size={160} />
      </div>
      <h2 id="rv-done-h" ref={title} tabIndex={-1} className="rv-done__title">
        {answered ? 'Session complete!' : 'Nothing was due'}
      </h2>
      {s && answered ? (
        <>
          <p className="rv-done__line" data-testid={TID.summaryAnswered}>
            You answered {s.answered} {s.answered === 1 ? 'card' : 'cards'} in about{' '}
            {formatDuration(s.durationMs)}
            {s.passRate !== null ? `, ${percent(s.passRate)} remembered` : ''}.
          </p>
          <div className="rv-sum">
            {ready ? (
              <ProgressRing
                value={ready.today.xp}
                max={ready.goal.value}
                label="Daily goal"
                unit="XP"
                size={116}
                stroke={13}
              >
                <span className="rv-ring__num">{ready.today.xp}</span>
                <span className="rv-ring__of">/{ready.goal.value} XP</span>
              </ProgressRing>
            ) : gameOn && g && !g.ready ? (
              <div className="rv-sum__counting">
                <span className="sv-small">Counting XP</span>
                <BarMeter
                  value={g.backfill.done}
                  max={Math.max(1, g.backfill.total)}
                  label="Counting your XP"
                  valueText={`${g.backfill.done} of ${g.backfill.total}`}
                  size="sm"
                />
              </div>
            ) : null}
            <ul className="rv-facts">
              {gameOn ? (
                <Fact
                  icon={Zap}
                  tone="sun"
                  value={`+${xp} XP`}
                  label="Earned"
                  extra={bonus ? <span className="rv-fact__bonus"> · 5 bonus</span> : null}
                />
              ) : (
                <Fact icon={Layers} tone="primary" value={s.answered} label="Answered" />
              )}
              {ready ? (
                <Fact
                  icon={Flame}
                  tone="warning"
                  value={plural(ready.streak.current, 'day')}
                  label={ready.streak.todayCounts ? 'Streak extended' : 'Streak'}
                />
              ) : (
                <Fact icon={Sprout} tone="violet" value={s.newCards} label="New cards" />
              )}
              <Fact icon={Target} tone="success" value={percent(s.passRate)} label="Recalled" />
              <Fact icon={Clock} tone="primary" value={formatDuration(s.durationMs)} label="Time" />
            </ul>
          </div>
          {s.leeches > 0 ? (
            <InlineNotice tone="warning">
              {plural(s.leeches, 'card')} became a leech and {s.leeches === 1 ? 'was' : 'were'}{' '}
              suspended; rewrite {s.leeches === 1 ? 'it' : 'them'} in the Cards view.
            </InlineNotice>
          ) : null}
          <details className="rv-details rv-done__more">
            <summary>Details</summary>
            <div className="rv-details__body">
              <div className="rv-tablewrap">
                <table className="rv-ratemix">
                  <caption className="sv-vh">Answers by button</caption>
                  <thead>
                    <tr>
                      {RATINGS.map((r) => {
                        const Icon = RATING_ICON[r];
                        return (
                          <th key={r} scope="col" className={`rv-ratemix--${r}`}>
                            <Icon aria-hidden="true" strokeWidth={2.6} />
                            {RATING_LABELS[r]}
                          </th>
                        );
                      })}
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
              <ul className="rv-donelist">
                <li>{plural(s.newCards, 'new card')} seen for the first time.</li>
                {s.lapses > 0 ? <li>{plural(s.lapses, 'learned card')} forgotten.</li> : null}
              </ul>
            </div>
          </details>
        </>
      ) : (
        <p className="rv-done__line">There was nothing to study right now.</p>
      )}

      {party && partyText ? (
        <div className="rv-party">
          <VaultBuddy pose="cheer" size={56} />
          <span className="rv-party__text">
            <strong>{partyText.title}</strong>
            <span>{partyText.line}</span>
          </span>
          <Button onClick={celebrate.dismiss}>{celebrate.queued > 0 ? 'Next' : 'Nice'}</Button>
        </div>
      ) : null}
      {/* Each celebration is spoken once here; it never takes focus. */}
      <p className="sv-vh" role="status" aria-live="polite">
        {partyText ? `${partyText.title}. ${partyText.line}.` : ''}
      </p>

      <p className="rv-done__next" data-testid={TID.summaryNext}>
        {next.error || due.error
          ? 'What comes next could not be loaded.'
          : forecast && due.summary
            ? leftAfterSession(due.summary.total, forecast.days[1]?.due ?? 0)
            : 'Working out what comes next…'}
      </p>
      {state.notice ? <InlineNotice tone="info">{state.notice}</InlineNotice> : null}
      <div className="rv-done__actions">
        <ChunkyButton
          variant="secondary"
          size="lg"
          icon={RotateCcw}
          data-testid={TID.summaryAgain}
          onClick={onStartMore}
        >
          Review again
        </ChunkyButton>
        <ChunkyButton variant="primary" size="lg" onClick={onBack}>
          Back to decks
        </ChunkyButton>
      </div>
      <Button
        variant="ghost"
        busy={state.busy}
        disabledReason={state.lastAnswer ? undefined : 'No answer to undo in this session.'}
        onClick={() => void controller.undo()}
      >
        <Undo2 aria-hidden="true" className="rv-icon" strokeWidth={2.5} />
        Undo last answer
      </Button>
    </section>
  );
}

export type { Deck };
