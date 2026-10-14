import { useState } from 'react';
import {
  Bookmark,
  Crown,
  Flame,
  Layers,
  Library,
  Lock,
  Moon,
  Star,
  Trophy,
  X,
  Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { BADGES, GAME } from '../data';
import { Bar, Freezes, IconButton, InfoTip, Streak, Switch } from '../ui';

const BADGE_ICON: Record<string, LucideIcon> = {
  first: Bookmark,
  week: Flame,
  builder: Library,
  owl: Moon,
  hundred: Layers,
  month: Trophy,
  perfect: Star,
  scholar: Crown,
};

export function LevelEmblem({
  level,
  size = 72,
  label,
}: {
  level: number;
  size?: number;
  /** Name it only where no visible "Level n" text sits next to it. */
  label?: string;
}) {
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true as const };
  return (
    <svg width={size} height={size} viewBox="0 0 72 72" className="sv-emblem" {...a11y}>
      {label && <title>{label}</title>}
      <path
        d="M36 4 L63 18 V44 Q63 58 36 68 Q9 58 9 44 V18 Z"
        fill="#ffc83d"
        stroke="#b37e00"
        strokeWidth="4"
        strokeLinejoin="round"
      />
      <path d="M36 12 L55 22 V43 Q55 53 36 60 Q17 53 17 43 V22 Z" fill="#ffe08a" />
      <text x="36" y="47" textAnchor="middle" className="sv-emblem__num">
        {level}
      </text>
    </svg>
  );
}

export function BadgesSheet({ onClose }: { onClose?: () => void }) {
  const [sel, setSel] = useState(BADGES[0]!.id);
  const [game, setGame] = useState(true);
  const picked = BADGES.find((b) => b.id === sel) ?? BADGES[0]!;
  const PickedIcon = BADGE_ICON[picked.id] ?? Star;
  return (
    <div className="sv-screen bs">
      <header className="sv-row bs__head">
        <LevelEmblem level={GAME.level} />
        <div className="bs__lvl">
          <div className="sv-row bs__title">
            <h3>Level {GAME.level}</h3>
            <InfoTip label="How XP works" align="start">
              Review a card: 1 XP. Save a highlight: 2. New card: 3. Finish a session: +5.
            </InfoTip>
          </div>
          <Bar value={GAME.levelXp} max={GAME.levelNeed} label="Level progress" size="lg" />
          <span className="sv-muted bs__toGo">
            {GAME.levelXp}/{GAME.levelNeed} XP · {GAME.levelNeed - GAME.levelXp} to go
          </span>
        </div>
        {onClose && <IconButton icon={X} label="Close" onClick={onClose} tipSide="left" />}
      </header>

      <div className="bs__stats">
        <div className="sv-card bs__stat">
          <Streak days={GAME.streak} size="lg" />
          <span className="sv-muted">Day streak</span>
        </div>
        <div className="sv-card bs__stat">
          <Freezes held={GAME.freezes} />
          <span className="sv-muted sv-row bs__freezeLabel">
            Freezes
            <InfoTip label="About streak freezes" align="end">
              Earn one every 7-day streak. Hold up to 2. A freeze saves a missed day for you.
            </InfoTip>
          </span>
        </div>
        <div className="sv-card bs__stat">
          <span className="sv-xp bs__total">
            <Zap aria-hidden="true" strokeWidth={2.6} />
            2,340
          </span>
          <span className="sv-muted">Total XP</span>
        </div>
      </div>

      <ol className="bs__road" aria-label="Next levels">
        {[0, 1, 2, 3].map((k) => {
          const lv = GAME.level + k;
          return (
            <li key={lv} className={k === 0 ? 'is-now' : undefined}>
              <span className="bs__roadDot" aria-hidden="true">
                {lv}
              </span>
              <span className="sv-vh">Level {lv}</span>
              <span className="bs__roadXp">{k === 0 ? 'Now' : `${150 + 50 * (lv - 1)} XP`}</span>
            </li>
          );
        })}
      </ol>

      <h4 className="bs__h">Badges</h4>
      <ul className="bs__grid">
        {BADGES.map((b) => {
          const Icon = BADGE_ICON[b.id] ?? Star;
          return (
            <li key={b.id}>
              <button
                type="button"
                className={`bs__badge${b.earned ? '' : ' is-locked'}`}
                aria-pressed={sel === b.id}
                onClick={() => setSel(b.id)}
              >
                <span
                  className={`bs__medal sv-art--${b.earned ? b.tone : 'neutral'}`}
                  aria-hidden="true"
                >
                  <Icon strokeWidth={2.4} />
                  {!b.earned && (
                    <span className="bs__lock">
                      <Lock strokeWidth={3} />
                    </span>
                  )}
                </span>
                <span className="bs__name">{b.name}</span>
                <span className="sv-vh">{b.earned ? ', earned' : ', locked'}</span>
              </button>
            </li>
          );
        })}
      </ul>

      <div className="sv-card bs__detail" role="status">
        <span
          className={`bs__medal bs__medal--sm sv-art--${picked.earned ? picked.tone : 'neutral'}`}
          aria-hidden="true"
        >
          <PickedIcon strokeWidth={2.4} />
        </span>
        <span className="bs__detailText">
          <strong>{picked.name}</strong>
          <span className="sv-muted">{picked.hint}</span>
          {picked.progress && (
            <span className="sv-row bs__prog">
              <Bar
                value={picked.progress[0]}
                max={picked.progress[1]}
                label={`${picked.name} progress`}
                tone="primary"
                size="sm"
              />
              <span className="sv-muted">
                {picked.progress[0]}/{picked.progress[1]}
              </span>
            </span>
          )}
        </span>
        {picked.earned && <span className="sv-badge sv-badge--success">Earned</span>}
      </div>

      <footer className="sv-row bs__foot">
        <Switch checked={game} onChange={setGame} label="Game mode" />
        <span className="sv-spacer" />
        <span className="sv-muted bs__note">
          {game ? 'XP, streaks, badges' : 'Hidden everywhere'}
        </span>
      </footer>
    </div>
  );
}
