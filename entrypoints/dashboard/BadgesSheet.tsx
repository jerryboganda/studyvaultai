import { useEffect, useId, useRef, useState } from 'react';
import {
  Award,
  Bookmark,
  CircleCheckBig,
  Crown,
  Flame,
  Layers,
  Library,
  Lock,
  Medal,
  Moon,
  Snowflake,
  Target,
  Trophy,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import {
  BarMeter,
  IconButton,
  InfoTip,
  StatChip,
  trapTab,
  useModalDialog,
  type ArtTone,
} from '@ui';
import { xpForLevel, type BadgeId, type GameState } from '@ui/game';
import { BADGE_HINT, badgeName, type BadgeView } from './homeModel';

type Ready = Extract<GameState, { ready: true }>;

export const BADGE_ART: Record<BadgeId, { icon: LucideIcon; tone: ArtTone }> = {
  first_save: { icon: Bookmark, tone: 'sun' },
  first_card: { icon: Layers, tone: 'primary' },
  first_session: { icon: CircleCheckBig, tone: 'success' },
  cards_100: { icon: Trophy, tone: 'violet' },
  bank_builder: { icon: Library, tone: 'primary' },
  reviews_1000: { icon: Medal, tone: 'warning' },
  streak_7: { icon: Flame, tone: 'danger' },
  streak_30: { icon: Crown, tone: 'danger' },
  goal_getter: { icon: Target, tone: 'success' },
  night_owl: { icon: Moon, tone: 'violet' },
  level_10: { icon: Award, tone: 'sun' },
};

/** A badge medal: coloured when earned, grey with a lock when not (the lock is the non-colour cue). */
export function BadgeMedal({ badge, small }: { badge: BadgeView; small?: boolean }) {
  const { icon: Icon, tone } = BADGE_ART[badge.id];
  const earned = badge.unlockedDayKey !== null;
  return (
    <span
      className={`badge-medal sv-art--${earned ? tone : 'neutral'}${small ? ' badge-medal--sm' : ''}`}
      aria-hidden="true"
    >
      <Icon strokeWidth={2.4} />
      {earned ? null : (
        <span className="badge-medal__lock">
          <Lock strokeWidth={3} />
        </span>
      )}
    </span>
  );
}

/** Level emblem (a shield with the number); decorative where "Level n" is written next to it. */
export function LevelEmblem({ level, size = 64 }: { level: number; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 72 72" className="level-emblem" aria-hidden="true">
      <path
        d="M36 4 L63 18 V44 Q63 58 36 68 Q9 58 9 44 V18 Z"
        fill="#ffc83d"
        stroke="#b37e00"
        strokeWidth="4"
        strokeLinejoin="round"
      />
      <path d="M36 12 L55 22 V43 Q55 53 36 60 Q17 53 17 43 V22 Z" fill="#ffe08a" />
      <text x="36" y="47" textAnchor="middle" className="level-emblem__num">
        {level}
      </text>
    </svg>
  );
}

/** Streak freezes held, as two snowflakes (filled or hollow) named "1 of 2 streak freezes". */
export function Freezes({ held }: { held: 0 | 1 | 2 }) {
  return (
    <span className="freezes" role="img" aria-label={`${held} of 2 streak freezes`}>
      {[0, 1].map((i) => (
        <Snowflake
          key={i}
          aria-hidden="true"
          strokeWidth={2.6}
          className={i < held ? 'freezes__on' : 'freezes__off'}
        />
      ))}
    </span>
  );
}

/** XP into the current level and the size of the level. */
export const levelSpan = (g: Ready) => ({
  into: g.totalXp - g.level.floorXp,
  span: g.level.nextXp - g.level.floorXp,
});

/** "Badges and level" sheet (dialog): level, streak, freezes, total XP, level road, every badge. */
export function BadgesSheet({ game, onClose }: { game: Ready; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  useModalDialog(dialog);
  // After showModal moved focus to the first control: start at the title instead.
  useEffect(() => title.current?.focus(), []);
  const [picked, setPicked] = useState<BadgeId>(game.badges[0]?.id ?? 'first_save');
  const badge = game.badges.find((b) => b.id === picked) ?? game.badges[0];
  const { into, span } = levelSpan(game);
  const earned = game.badges.filter((b) => b.unlockedDayKey !== null).length;
  return (
    <dialog
      ref={dialog}
      className="badges-sheet"
      aria-labelledby={titleId}
      data-testid="badges-sheet"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onKeyDown={(e) => trapTab(e, e.currentTarget)}
    >
      <header className="badges-sheet__head">
        <LevelEmblem level={game.level.level} />
        <div className="badges-sheet__lvl">
          <div className="sv-row badges-sheet__title">
            <h2 id={titleId} ref={title} tabIndex={-1}>
              Level {game.level.level}
            </h2>
            <InfoTip label="How XP works" align="start">
              Review a card: 1 XP. Save a highlight: 2. New card: 3. Finish a session: +5.
            </InfoTip>
          </div>
          <BarMeter
            value={into}
            max={span}
            label="Level progress"
            valueText={`${into} of ${span} XP`}
            tone="sun"
            size="lg"
          />
          <span className="badges-sheet__togo">
            {into}/{span} XP · {span - into} to go
          </span>
        </div>
        <IconButton icon={X} label="Close" tipSide="left" onClick={onClose} />
      </header>

      <div className="badges-sheet__stats">
        <div className="home-card badges-sheet__stat">
          <StatChip icon={Flame} value={game.streak.current} label="day streak" tone="flame" />
        </div>
        <div className="home-card badges-sheet__stat">
          <Freezes held={game.streak.freezes} />
          <span className="sv-row badges-sheet__freeze">
            Freezes
            <InfoTip label="About streak freezes" align="end">
              Earn one every 7-day streak. Hold up to 2. A freeze saves a missed day for you.
            </InfoTip>
          </span>
        </div>
        <div className="home-card badges-sheet__stat">
          <StatChip icon={Zap} value={game.totalXp.toLocaleString()} label="total XP" tone="sun" />
        </div>
      </div>

      <ol className="level-road" aria-label="Next levels">
        {[0, 1, 2, 3].map((k) => {
          const lv = game.level.level + k;
          return (
            <li key={lv} className={k === 0 ? 'is-now' : undefined}>
              <span className="level-road__dot" aria-hidden="true">
                {lv}
              </span>
              <span className="sv-vh">Level {lv}: </span>
              <span className="level-road__xp">
                {k === 0 ? 'Now' : `${xpForLevel(lv).toLocaleString()} XP`}
              </span>
            </li>
          );
        })}
      </ol>

      <div className="sv-row badges-sheet__h">
        <h3>Badges</h3>
        <span className="home-count">
          {earned}/{game.badges.length}
        </span>
      </div>
      <ul className="badges-grid">
        {game.badges.map((b) => (
          <li key={b.id}>
            <button
              type="button"
              className={`badges-grid__btn${b.unlockedDayKey ? '' : ' is-locked'}`}
              aria-pressed={picked === b.id}
              onClick={() => setPicked(b.id)}
            >
              <BadgeMedal badge={b} />
              <span className="badges-grid__name">{badgeName(b.id)}</span>
              <span className="sv-vh">{b.unlockedDayKey ? ', earned' : ', locked'}</span>
            </button>
          </li>
        ))}
      </ul>

      {badge ? (
        <div className="home-card badges-sheet__detail" aria-live="polite">
          <BadgeMedal badge={badge} small />
          <span className="badges-sheet__detailText">
            <strong>{badgeName(badge.id)}</strong>
            <span className="home-muted">{BADGE_HINT[badge.id]}</span>
            {badge.unlockedDayKey ? null : (
              <span className="sv-row badges-sheet__prog">
                <BarMeter
                  value={Math.min(badge.value, badge.target)}
                  max={badge.target}
                  label={`${badgeName(badge.id)} progress`}
                  size="sm"
                />
                <span className="home-muted">
                  {Math.min(badge.value, badge.target).toLocaleString()}/
                  {badge.target.toLocaleString()}
                </span>
              </span>
            )}
          </span>
          {badge.unlockedDayKey ? <span className="sv-badge sv-badge--success">Earned</span> : null}
        </div>
      ) : null}
    </dialog>
  );
}
