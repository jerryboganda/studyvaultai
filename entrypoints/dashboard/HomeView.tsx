import { useState, type ReactNode } from 'react';
import {
  Bike,
  Bookmark,
  ChevronRight,
  Coffee,
  Flame,
  Layers,
  Plus,
  Rocket,
  RotateCcw,
  type LucideIcon,
} from 'lucide-react';
import { setDailyGoal } from '@storage';
import {
  BarMeter,
  ChoiceCards,
  ChunkyButton,
  Heatmap,
  InfoTip,
  ProgressRing,
  StatChip,
  VaultBuddy,
  errorMessage,
  plural,
  type ArtTone,
} from '@ui';
import { DAILY_GOALS, useGame, type DailyGoal, type GameState } from '@ui/game';
import { reviewPageUrl, toBoundary, useStudySettings, type DueCount } from '@ui/review';
import { useApi } from './api';
import { BankCardView } from './BankCard';
import { BadgeMedal, BadgesSheet, Freezes, levelSpan } from './BadgesSheet';
import { useVaultQuery } from './hooks';
import { dayKeyDate, earnedBadges, greeting, nextBadge, badgeName } from './homeModel';
import { useTreeData } from './treeData';

type Ready = Extract<GameState, { ready: true }>;

/** Bank cards shown on Home; the rest are one click away under Banks. */
const HOME_BANKS = 8;

const GOAL_NAMES: Record<DailyGoal, string> = {
  10: 'Casual',
  30: 'Regular',
  50: 'Serious',
  100: 'Intense',
};
/** The same pictures as the welcome tour and Settings > Game, so a goal looks the same everywhere. */
const GOAL_LOOK: Record<DailyGoal, { icon: LucideIcon; tone: ArtTone }> = {
  10: { icon: Coffee, tone: 'success' },
  30: { icon: Bike, tone: 'primary' },
  50: { icon: Rocket, tone: 'violet' },
  100: { icon: Flame, tone: 'danger' },
};

/**
 * The dashboard's landing view (UX_DESIGN 7.3): greeting and "Start review", today's goal, level
 * and streak, your banks, badges and the More tiles. Every number is read from the vault; game
 * parts show only with Game mode on and never before the ledger is ready.
 */
export function HomeView({
  due,
  onOpenBank,
  onAllBanks,
  onNewBank,
  more,
  treeError,
  onRetryTree,
}: {
  /** Cards ready today (shared with the rail's badge). */
  due: DueCount;
  onOpenBank(bankId: string): void;
  onAllBanks(): void;
  onNewBank(): void;
  /** The More tiles. */
  more: ReactNode;
  treeError: string | null;
  onRetryTree(): void;
}) {
  const game = useGame();
  const g = game.data;
  const ready = g?.ready === true && g.mode ? g : null;
  const [sheet, setSheet] = useState(false);

  return (
    <div className="home" data-testid="home">
      <Hero due={due} />
      <div className="home__side">
        {ready && !ready.goal.chosen ? <GoalPicker /> : null}
        <TodayCard game={game} />
        {ready ? <CalendarCard game={ready} /> : null}
        {ready ? <BadgesCard game={ready} onSeeAll={() => setSheet(true)} /> : null}
      </div>
      <div className="home__rest">
        <BanksSection
          due={due}
          onOpenBank={onOpenBank}
          onAllBanks={onAllBanks}
          onNewBank={onNewBank}
          error={treeError}
          onRetry={onRetryTree}
        />
        <section className="home-card home-card--pad" aria-labelledby="home-more">
          <h2 id="home-more" className="home-h">
            More
          </h2>
          {more}
        </section>
      </div>
      {sheet && ready ? <BadgesSheet game={ready} onClose={() => setSheet(false)} /> : null}
    </div>
  );
}

type Due = DueCount;

function Hero({ due }: { due: Due }) {
  const total = due.summary?.total;
  const count = due.count;
  const canStart = (count ?? 0) > 0 || due.resumable !== null;
  const line =
    due.error !== null
      ? 'Could not count your cards.'
      : count === null
        ? 'Counting your cards…'
        : count > 0
          ? `${plural(count, 'card')} ready`
          : due.resumable
            ? 'Your session is waiting'
            : 'Nothing due right now';
  return (
    <section className="home__hero" aria-labelledby="home-hello" data-testid="home-hero">
      <span className="home__heroArt" aria-hidden="true">
        <VaultBuddy pose="wave" size={112} />
      </span>
      <div className="home__heroText">
        <h1 id="home-hello">{greeting(new Date().getHours())}</h1>
        <p>{line}</p>
        {total && count ? (
          <ul className="home__mix" aria-label="Due mix">
            {total.new > 0 ? <li>{total.new} new</li> : null}
            {total.learning > 0 ? <li>{total.learning} learning</li> : null}
            {total.review > 0 ? <li>{total.review} review</li> : null}
          </ul>
        ) : null}
      </div>
      {due.error !== null ? (
        <ChunkyButton icon={RotateCcw} onClick={due.refresh} className="home__heroCta">
          Try again
        </ChunkyButton>
      ) : (
        <a
          className={`sv-chunky sv-chunky--lg home__heroCta ${canStart ? 'sv-chunky--sun' : 'sv-chunky--secondary'}`}
          href={reviewPageUrl(canStart ? { start: true } : {})}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="home-start-review"
        >
          <Layers aria-hidden="true" className="sv-chunky__icon" strokeWidth={2.5} />
          {canStart ? (due.resumable && !count ? 'Continue' : 'Start review') : 'Open review'}
        </a>
      )}
    </section>
  );
}

function GoalPicker() {
  const [goal, setGoal] = useState<DailyGoal>(30);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="home-card home-card--pad home-goal" aria-labelledby="home-goal">
      <div className="sv-row home-goal__head">
        <VaultBuddy pose="think" size={48} />
        <h2 id="home-goal" className="home-h">
          Pick your daily goal
        </h2>
      </div>
      <ChoiceCards
        labelledBy="home-goal"
        columns={2}
        value={String(goal) as `${DailyGoal}`}
        onChange={(v) => setGoal(Number(v) as DailyGoal)}
        options={DAILY_GOALS.map((v) => ({
          value: String(v) as `${DailyGoal}`,
          label: GOAL_NAMES[v],
          hint: `${v} XP a day${v === 30 ? ' · Suggested' : ''}`,
          ...GOAL_LOOK[v],
        }))}
      />
      {error ? (
        <p className="home-error" role="alert">
          {error}
        </p>
      ) : null}
      <ChunkyButton
        variant="primary"
        block
        disabledReason={busy ? 'Saving…' : undefined}
        onClick={() => {
          setBusy(true);
          setError(null);
          setDailyGoal(goal).then(
            () => setBusy(false),
            (err: unknown) => {
              setBusy(false);
              setError(errorMessage(err, 'Could not save. Try again.'));
            },
          );
        }}
        data-testid="home-goal-save"
      >
        Set goal
      </ChunkyButton>
    </section>
  );
}

function TodayCard({ game }: { game: ReturnType<typeof useGame> }) {
  const g = game.data;
  let body: ReactNode;
  if (game.error && !g) {
    body = (
      <Quiet pose="think" text="Could not read your progress.">
        <ChunkyButton size="sm" icon={RotateCcw} onClick={game.reload}>
          Try again
        </ChunkyButton>
      </Quiet>
    );
  } else if (!g) {
    body = <Quiet pose="think" text="Loading your progress…" />;
  } else if (!g.ready) {
    const { status, done, total } = g.backfill;
    // Game mode off hides XP, so the wait is named without it.
    const counting = g.mode ? 'Counting your XP' : 'Counting today';
    body =
      status === 'failed' ? (
        <Quiet pose="think" text={g.mode ? 'Could not count your XP.' : 'Could not count today.'}>
          <ChunkyButton size="sm" icon={RotateCcw} onClick={() => void game.retryBackfill()}>
            Try again
          </ChunkyButton>
        </Quiet>
      ) : (
        <Quiet pose="think" text={`${counting}…`}>
          {total > 0 ? (
            <span className="home-today__progress">
              <BarMeter
                value={done}
                max={total}
                label={counting}
                valueText={`${done} of ${total}`}
                size="sm"
              />
              <span className="home-muted">
                {done.toLocaleString()}/{total.toLocaleString()}
              </span>
            </span>
          ) : null}
        </Quiet>
      );
  } else if (!g.mode) {
    // Game mode off: today's plain counts, as pictures with numbers (no XP, ring or streak).
    const plain = [
      { icon: Layers, tone: 'primary', value: g.today.reviews, label: 'reviewed' },
      { icon: Bookmark, tone: 'sun', value: g.today.saves, label: 'saved' },
      {
        icon: Plus,
        tone: 'violet',
        value: g.today.cards,
        label: g.today.cards === 1 ? 'card made' : 'cards made',
      },
    ] as const;
    body = (
      <ul className="home-today__plain">
        {plain.map(({ icon: Icon, tone, value, label }) => (
          <li key={tone}>
            <span className={`home-today__art sv-art--${tone}`} aria-hidden="true">
              <Icon strokeWidth={2.4} />
            </span>
            <strong>{value.toLocaleString()}</strong> {label}
          </li>
        ))}
      </ul>
    );
  } else {
    const { into, span } = levelSpan(g);
    body = (
      <div className="home-today__game">
        <ProgressRing
          value={g.today.xp}
          max={g.goal.value}
          label="Daily goal"
          unit="XP"
          size={112}
          stroke={13}
        >
          <span className="home-today__xp">{g.today.xp}</span>
          <span className="home-today__of">of {g.goal.value} XP</span>
        </ProgressRing>
        <div className="home-today__col">
          <div className="sv-row home-today__streak">
            <StatChip icon={Flame} value={g.streak.current} label="day streak" tone="flame" />
            <Freezes held={g.streak.freezes} />
          </div>
          <div className="home-today__lvl">
            <span className="sv-row">
              <strong>Level {g.level.level}</strong>
              <span className="home-muted">
                {into}/{span}
              </span>
            </span>
            <BarMeter
              value={into}
              max={span}
              label={`Level ${g.level.level}`}
              valueText={`${into} of ${span} XP`}
              tone="sun"
            />
          </div>
        </div>
      </div>
    );
  }
  return (
    <section
      className="home-card home-card--pad home-today"
      aria-labelledby="home-today"
      data-testid="home-today"
    >
      <h2 id="home-today" className="home-h sv-vh">
        Today
      </h2>
      {body}
    </section>
  );
}

function Quiet({
  pose,
  text,
  children,
}: {
  pose: 'think' | 'sleep';
  text: string;
  children?: ReactNode;
}) {
  return (
    <div className="home-quiet">
      <VaultBuddy pose={pose} size={48} />
      <span className="home-quiet__text">
        <span>{text}</span>
        {children}
      </span>
    </div>
  );
}

function CalendarCard({ game }: { game: Ready }) {
  const days = game.days;
  const last = days.at(-1);
  return (
    <section className="home-card home-card--pad" aria-labelledby="home-cal">
      <div className="sv-row home-head">
        <h2 id="home-cal" className="home-h">
          Streak calendar
        </h2>
        <InfoTip label="About the calendar" align="end">
          Last 12 weeks. Darker squares mean more XP. Today has a ring.
        </InfoTip>
      </div>
      {!days.some((d) => d.xp > 0) || !last ? (
        // No XP on any day yet: an empty state, never a calendar of zeros (UX_DESIGN 5).
        <Quiet pose="sleep" text="No study days yet" />
      ) : (
        <Heatmap
          days={days.map((d) => d.xp)}
          goal={game.goal.value}
          title="Streak calendar"
          frozen={days.flatMap((d, i) => (d.frozen ? [i] : []))}
          end={dayKeyDate(last.dayKey)}
        />
      )}
    </section>
  );
}

function BadgesCard({ game, onSeeAll }: { game: Ready; onSeeAll(): void }) {
  const earned = earnedBadges(game.badges);
  const next = nextBadge(game.badges);
  return (
    <section className="home-card home-card--pad" aria-labelledby="home-badges">
      <div className="sv-row home-head">
        <h2 id="home-badges" className="home-h">
          Badges
        </h2>
        <span className="home-count">
          {earned.length}/{game.badges.length}
        </span>
        <span className="sv-grow" />
        <ChunkyButton
          size="sm"
          variant="ghost"
          iconEnd={ChevronRight}
          onClick={onSeeAll}
          data-testid="home-badges-all"
        >
          See all
        </ChunkyButton>
      </div>
      {earned.length > 0 ? (
        <ul className="home-badges">
          {earned.slice(0, 4).map((b) => (
            <li key={b.id}>
              <BadgeMedal badge={b} />
              <span>{badgeName(b.id)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {next ? (
        <div className="home-next">
          <BadgeMedal badge={next} small />
          <span className="home-next__text">
            <span>
              <span className="home-muted">Next up:</span> <strong>{badgeName(next.id)}</strong>
            </span>
            <span className="sv-row home-next__bar">
              <BarMeter
                value={Math.min(next.value, next.target)}
                max={next.target}
                label={`${badgeName(next.id)} progress`}
                size="sm"
              />
              <span className="home-muted">
                {Math.min(next.value, next.target).toLocaleString()}/{next.target.toLocaleString()}
              </span>
            </span>
          </span>
        </div>
      ) : null}
    </section>
  );
}

function BanksSection({
  due,
  onOpenBank,
  onAllBanks,
  onNewBank,
  error,
  onRetry,
}: {
  due: Due;
  onOpenBank(bankId: string): void;
  onAllBanks(): void;
  onNewBank(): void;
  error: string | null;
  onRetry(): void;
}) {
  const api = useApi();
  const tree = useTreeData();
  const { settings } = useStudySettings();
  const boundary = settings ? toBoundary(settings) : null;
  const study = useVaultQuery(
    async () => (boundary ? api.bankStudy({ boundary }) : null),
    [boundary ? JSON.stringify(boundary) : null],
  );
  const loading = tree.counts === null && error === null;
  const shown = tree.banks.slice(0, HOME_BANKS);

  return (
    <section className="home-banks" aria-labelledby="home-banks" aria-busy={loading || undefined}>
      <div className="sv-row home-head">
        <h2 id="home-banks" className="home-h">
          Your banks
        </h2>
        {!loading && error === null ? (
          <span className="home-count">{tree.banks.length}</span>
        ) : null}
        <InfoTip label="About the bank cards" align="start">
          The bar is how often you recalled mature cards in the last year. It shows n/a until 5
          reviews.
        </InfoTip>
      </div>
      {error !== null ? (
        <div className="home-quiet" role="alert">
          <VaultBuddy pose="think" size={48} />
          <span className="home-quiet__text">
            <span>Could not read your banks.</span>
            <ChunkyButton size="sm" icon={RotateCcw} onClick={onRetry}>
              Try again
            </ChunkyButton>
          </span>
        </div>
      ) : (
        <ul className="home-bankgrid">
          {loading
            ? [0, 1, 2].map((i) => (
                <li key={i}>
                  <span className="home-skeleton" />
                </li>
              ))
            : shown.map((b) => {
                const s = study.data?.[b.id];
                return (
                  <li key={b.id}>
                    <BankCardView
                      testId="home-bank"
                      onOpen={() => onOpenBank(b.id)}
                      bank={{
                        name: b.name,
                        icon: b.icon,
                        color: b.color,
                        saved: tree.counts?.banks[b.id] ?? 0,
                        cards: study.data ? (s?.cards ?? 0) : null,
                        retention: study.data ? (s?.retention ?? null) : undefined,
                        due: due.summary ? (due.summary.byBank[b.id]?.total ?? 0) : null,
                      }}
                    />
                  </li>
                );
              })}
          {loading ? null : (
            <li>
              <button
                type="button"
                className="home-addbank"
                onClick={onNewBank}
                data-testid="home-new-bank"
              >
                <Plus aria-hidden="true" strokeWidth={2.6} />
                New bank
              </button>
            </li>
          )}
          {!loading && tree.banks.length > HOME_BANKS ? (
            <li>
              <button type="button" className="home-addbank" onClick={onAllBanks}>
                All {tree.banks.length} banks
                <ChevronRight aria-hidden="true" strokeWidth={2.6} />
              </button>
            </li>
          ) : null}
        </ul>
      )}
    </section>
  );
}
