import { useState } from 'react';
import {
  Bike,
  Bookmark,
  Coffee,
  Flame,
  Gamepad2,
  Layers,
  Plus,
  Rocket,
  Snowflake,
  Trophy,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { setDailyGoal, setGameMode } from '@storage';
import {
  BarMeter,
  Button,
  ChoiceCards,
  InlineNotice,
  ProgressRing,
  StatChip,
  VaultBuddy,
  useAction,
  useToast,
  type ArtTone,
} from '@ui';
import { DAILY_GOALS, XP, useGame, type DailyGoal, type GameState } from '@ui/game';
import { GOAL_NAMES } from './model';
import { Card, LevelEmblem, SettingRow } from './ui';

const GOAL_LOOK: Record<DailyGoal, { icon: LucideIcon; tone: ArtTone }> = {
  10: { icon: Coffee, tone: 'success' },
  30: { icon: Bike, tone: 'primary' },
  50: { icon: Rocket, tone: 'violet' },
  100: { icon: Flame, tone: 'danger' },
};

const GOAL_CHOICES = DAILY_GOALS.map((g) => ({
  value: String(g) as `${DailyGoal}`,
  label: GOAL_NAMES[g],
  hint: `${g} XP a day`,
  ...GOAL_LOOK[g],
}));

/** How XP is earned (ADR-022), as chips: the same numbers the engine uses. */
const EARN = [
  { icon: Layers, label: 'Review', xp: XP.review, tone: 'primary' },
  { icon: Bookmark, label: 'Save', xp: XP.save, tone: 'sun' },
  { icon: Plus, label: 'New card', xp: XP.card, tone: 'violet' },
  { icon: Trophy, label: 'Session', xp: XP.session, tone: 'success' },
] as const;

type Ready = Extract<GameState, { ready: true }>;

/** Today, the streak and the level, drawn from the ledger (Game mode on only). */
function Progress({ state }: { state: Ready }) {
  const { today, goal, streak, level, totalXp } = state;
  const span = level.nextXp - level.floorXp;
  const into = totalXp - level.floorXp;
  return (
    <Card title="Today" icon={Zap} tone="sun" className="opt-today">
      <div className="opt-today__body">
        <ProgressRing
          value={today.xp}
          max={goal.value}
          label="Daily goal"
          unit="XP"
          size={116}
          stroke={13}
        >
          <span className="opt-ring__num">{today.xp}</span>
          <span className="opt-ring__of">of {goal.value} XP</span>
        </ProgressRing>
        <div className="opt-today__facts">
          <div className="opt-today__row opt-today__row--start">
            <StatChip icon={Flame} value={streak.current} label="day streak" tone="flame" />
            {/* The written count says how many are held: never the snowflakes' colour alone. */}
            <span
              className="opt-freezes"
              role="img"
              aria-label={`${streak.freezes} of 2 streak freezes`}
            >
              {[0, 1].map((i) => (
                <Snowflake
                  key={i}
                  aria-hidden="true"
                  strokeWidth={2.4}
                  className={i < streak.freezes ? 'is-held' : 'is-empty'}
                />
              ))}
              <span className="opt-freezes__count">{streak.freezes}/2</span>
            </span>
          </div>
          <div className="opt-level">
            <LevelEmblem level={level.level} size={48} />
            <div className="opt-level__text">
              <div className="opt-today__row">
                <strong>Level {level.level}</strong>
                <span className="sv-muted opt-level__xp">
                  {into}/{span} XP
                </span>
              </div>
              <BarMeter
                value={into}
                max={span}
                label={`Level ${level.level} progress`}
                valueText={`${into} of ${span} XP to level ${level.level + 1}`}
                tone="sun"
              />
            </div>
          </div>
          <p className="sv-muted opt-today__total">
            {totalXp.toLocaleString('en')} XP in all · best streak {streak.longest}
          </p>
        </div>
      </div>
    </Card>
  );
}

/** Game mode off: plain counts for today, no XP, ring, streak or level (UX_DESIGN 11). */
function PlainToday({ state }: { state: Ready }) {
  const { reviews, saves, cards } = state.today;
  return (
    <Card title="Today" icon={Zap} tone="neutral">
      <ul className="opt-chips" aria-label="Today so far">
        <li>
          <StatChip icon={Layers} value={reviews} label="reviewed" tone="primary" />
        </li>
        <li>
          <StatChip icon={Bookmark} value={saves} label="saved" tone="neutral" />
        </li>
        <li>
          <StatChip icon={Plus} value={cards} label="cards made" tone="neutral" />
        </li>
      </ul>
    </Card>
  );
}

function GoalPicker({ goal }: { goal: DailyGoal }) {
  const { announce } = useToast();
  // The person's pick while it is written; it gives way as soon as the ledger's goal changes.
  const [pending, setPending] = useState<{ value: DailyGoal; from: DailyGoal } | null>(null);
  const shown = pending && pending.from === goal ? pending.value : goal;
  const save = useAction(async (next: DailyGoal) => {
    try {
      await setDailyGoal(next);
    } catch (err) {
      setPending(null);
      throw err;
    }
    announce(`Daily goal: ${next} XP.`);
  });
  return (
    <Card
      title="Daily goal"
      icon={Trophy}
      tone="sun"
      info="A change counts from today's study day. A day counts for your streak once you reach the goal."
    >
      <ChoiceCards
        label="Daily goal"
        options={GOAL_CHOICES}
        value={String(shown) as `${DailyGoal}`}
        columns={4}
        onChange={(v) => {
          const next = Number(v) as DailyGoal;
          setPending({ value: next, from: goal });
          void save.run(next);
        }}
      />
      <div className="opt-earn">
        <span className="opt-earn__label">Earn XP</span>
        <ul className="opt-chips" aria-label="How you earn XP">
          {EARN.map(({ icon: Icon, label, xp, tone }) => (
            <li key={label} className={`opt-earn__chip sv-art--${tone}`}>
              <Icon aria-hidden="true" strokeWidth={2.4} />
              {label} +{xp}
            </li>
          ))}
        </ul>
      </div>
      {save.error ? (
        <InlineNotice
          tone="error"
          title="Your goal was not saved"
          action={
            save.retryable ? (
              <Button busy={save.busy} onClick={save.retry}>
                Retry
              </Button>
            ) : undefined
          }
        >
          {save.error}
        </InlineNotice>
      ) : null}
    </Card>
  );
}

function ModeSwitch({ mode }: { mode: boolean }) {
  const save = useAction((on: boolean) => setGameMode(on));
  return (
    <div className="opt-card opt-card--single">
      <SettingRow
        icon={Gamepad2}
        tone="sun"
        label="Game mode"
        hint="XP, streak, level and badges."
        info="Off hides XP, the goal ring, streak, level, badges and confetti everywhere. Your progress keeps counting, so turning it on again shows the true state."
        checked={mode}
        onChange={(on) => save.run(on)}
      />
      {save.error ? (
        <InlineNotice tone="error" title="Your change was not saved">
          {save.error}
        </InlineNotice>
      ) : null}
    </div>
  );
}

/** Not ready yet: the history is being added up. Real progress only, never a number before it. */
function Backfill({
  state,
  retry,
}: {
  state: Extract<GameState, { ready: false }>;
  retry(): void;
}) {
  const { status, done, total, error } = state.backfill;
  if (status === 'failed') {
    return (
      <InlineNotice
        tone="error"
        title="Could not add up your history"
        action={<Button onClick={retry}>Retry</Button>}
      >
        {error ?? 'Something went wrong.'}
      </InlineNotice>
    );
  }
  return (
    <Card title="Counting history" className="opt-backfill">
      <div className="opt-backfill__body">
        <VaultBuddy pose="think" size={64} />
        <div className="opt-backfill__bar">
          {total > 0 ? (
            <>
              <BarMeter value={done} max={total} label="Adding up your history" tone="sun" />
              <span className="sv-muted">
                {done.toLocaleString('en')} of {total.toLocaleString('en')}
              </span>
            </>
          ) : (
            <span className="sv-muted">Adding up your history…</span>
          )}
        </div>
      </div>
    </Card>
  );
}

/** Settings > Game (ADR-022): the daily goal, Game mode, and where you stand today. */
export function Game() {
  const game = useGame();
  const { data } = game;
  if (game.error && !data) {
    return (
      <InlineNotice
        tone="error"
        title="Could not read your progress"
        action={game.retryable ? <Button onClick={game.reload}>Retry</Button> : undefined}
      >
        {game.error}
      </InlineNotice>
    );
  }
  if (!data) {
    return (
      <div className="opt-loading">
        <VaultBuddy pose="think" size={64} />
        <p className="sv-muted">Reading your progress…</p>
      </div>
    );
  }
  return (
    <div className="opt-stack">
      {!data.ready ? (
        <Backfill state={data} retry={() => void game.retryBackfill()} />
      ) : data.mode ? (
        <Progress state={data} />
      ) : (
        <PlainToday state={data} />
      )}
      {/* Game mode off hides XP everywhere (UX_DESIGN 11), the goal's XP cards included. */}
      {data.ready && data.mode ? <GoalPicker goal={data.goal.value} /> : null}
      <ModeSwitch mode={data.mode} />
    </div>
  );
}
