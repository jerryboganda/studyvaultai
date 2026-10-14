import { useRef, useState } from 'react';
import {
  Bookmark,
  ChevronRight,
  Ellipsis,
  Flame,
  House,
  Layers,
  Library,
  Moon,
  Plus,
  Search,
  Settings,
} from 'lucide-react';
import { BADGES, BANKS, GAME, HEATMAP } from '../data';
import { Heatmap } from '../Heatmap';
import { BankCard, LogoMark, MORE_ITEMS, MoreGrid } from '../shared';
import { VaultBuddy } from '../VaultBuddy';
import { Bar, Button, Freezes, GoalRing, InfoTip, Streak } from '../ui';
import { BadgesSheet } from './BadgesSheet';

const NAV = [
  { id: 'home', label: 'Home', icon: House },
  { id: 'banks', label: 'Banks', icon: Library },
  { id: 'review', label: 'Review', icon: Layers, count: GAME.due },
  { id: 'search', label: 'Search', icon: Search },
  { id: 'more', label: 'More', icon: Ellipsis },
];

const BADGE_ICON = { first: Bookmark, week: Flame, builder: Library, owl: Moon } as const;

export function Dashboard() {
  const [nav, setNav] = useState('home');
  const dialog = useRef<HTMLDialogElement>(null);
  const earned = BADGES.filter((b) => b.earned);
  const next = BADGES.find((b) => !b.earned);

  return (
    <div className="sv-screen db">
      <nav className="db__rail" aria-label="Dashboard">
        <LogoMark size={36} />
        <ul className="db__nav">
          {NAV.map(({ id, label, icon: Icon, count }) => (
            <li key={id}>
              <button
                type="button"
                className="db__navItem"
                aria-current={nav === id ? 'page' : undefined}
                onClick={() => setNav(id)}
              >
                <span className="db__navIcon" aria-hidden="true">
                  <Icon strokeWidth={2.4} />
                  {count !== undefined && <span className="db__navCount">{count}</span>}
                </span>
                {label}
                {count !== undefined && <span className="sv-vh"> ({count} due)</span>}
              </button>
            </li>
          ))}
        </ul>
        <span className="sv-spacer" />
        <button type="button" className="db__navItem">
          <span className="db__navIcon" aria-hidden="true">
            <Settings strokeWidth={2.4} />
          </span>
          Settings
        </button>
      </nav>

      <div className="db__main">
        <section className="db__hero" aria-labelledby="db-hello">
          <span className="db__heroArt" aria-hidden="true">
            <VaultBuddy pose="wave" size={118} />
          </span>
          <div className="db__heroText">
            <h3 id="db-hello">Good morning, {GAME.name}!</h3>
            <p>{GAME.due} cards are ready for you.</p>
            <div className="sv-row db__heroMix">
              <span className="db__pill">{GAME.dueMix.fresh} new</span>
              <span className="db__pill">{GAME.dueMix.learning} learning</span>
              <span className="db__pill">{GAME.dueMix.review} review</span>
            </div>
          </div>
          <Button variant="sun" size="lg" icon={Layers} className="db__heroCta">
            Start review
          </Button>
        </section>

        <section className="sv-card db__today" aria-label="Today">
          <GoalRing value={GAME.todayXp} goal={GAME.goalXp} size={116} stroke={13}>
            <span className="db__ringNum">{GAME.todayXp}</span>
            <span className="db__ringOf">of {GAME.goalXp} XP</span>
          </GoalRing>
          <div className="db__todayCol">
            <div className="sv-row">
              <Streak days={GAME.streak} size="lg" />
              <span className="sv-muted db__days">days</span>
              <span className="sv-spacer" />
              <Freezes held={GAME.freezes} />
            </div>
            <div className="db__lvl">
              <div className="sv-row">
                <strong>Level {GAME.level}</strong>
                <span className="sv-spacer" />
                <span className="sv-muted db__lvlXp">
                  {GAME.levelXp}/{GAME.levelNeed}
                </span>
              </div>
              <Bar value={GAME.levelXp} max={GAME.levelNeed} label="Level progress" size="md" />
            </div>
          </div>
        </section>

        <section className="db__banks" aria-labelledby="db-banks">
          <div className="sv-row db__secHead">
            <h3 id="db-banks">Your banks</h3>
            <span className="sp__hCount">{BANKS.length}</span>
          </div>
          <ul className="db__bankGrid">
            {BANKS.map((b) => (
              <li key={b.id}>
                <BankCard bank={b} />
              </li>
            ))}
            <li>
              <button type="button" className="db__addBank">
                <Plus aria-hidden="true" strokeWidth={2.6} />
                New bank
              </button>
            </li>
          </ul>
        </section>

        <section className="sv-card sv-card--pad db__cal" aria-labelledby="db-cal">
          <div className="sv-row db__secHead">
            <h3 id="db-cal">Streak calendar</h3>
            <InfoTip label="About the calendar" align="end">
              Last 12 weeks. Darker squares mean more XP. Today has a ring.
            </InfoTip>
          </div>
          <Heatmap days={HEATMAP} goal={GAME.goalXp} title="Streak calendar" />
        </section>

        <section className="sv-card sv-card--pad db__more" aria-labelledby="db-more">
          <div className="sv-row db__secHead">
            <h3 id="db-more">More</h3>
          </div>
          <MoreGrid items={MORE_ITEMS.filter((m) => m.id !== 'settings')} cols={6} />
        </section>
        <section className="sv-card sv-card--pad db__badges" aria-labelledby="db-badges">
          <div className="sv-row db__secHead">
            <h3 id="db-badges">Badges</h3>
            <span className="sv-muted">
              {earned.length}/{BADGES.length}
            </span>
            <span className="sv-spacer" />
            <Button
              size="sm"
              variant="ghost"
              iconEnd={ChevronRight}
              onClick={() => dialog.current?.showModal()}
            >
              See all
            </Button>
          </div>
          <ul className="db__badgeRow">
            {earned.map((b) => {
              const Icon = BADGE_ICON[b.id as keyof typeof BADGE_ICON];
              return (
                <li key={b.id} className="db__badge">
                  <span className={`bs__medal sv-art--${b.tone}`} aria-hidden="true">
                    <Icon strokeWidth={2.4} />
                  </span>
                  <span>{b.name}</span>
                </li>
              );
            })}
          </ul>
          {next?.progress && (
            <div className="db__next">
              <span className="bs__medal bs__medal--sm sv-art--neutral" aria-hidden="true">
                <Layers strokeWidth={2.4} />
              </span>
              <span className="db__nextText">
                <span>
                  <span className="sv-muted">Next up:</span> <strong>{next.name}</strong>
                </span>
                <span className="sv-row">
                  <Bar
                    value={next.progress[0]}
                    max={next.progress[1]}
                    label={`${next.name} progress`}
                    tone="primary"
                    size="sm"
                  />
                  <span className="sv-muted">
                    {next.progress[0]}/{next.progress[1]}
                  </span>
                </span>
              </span>
            </div>
          )}
        </section>
      </div>

      <dialog ref={dialog} className="sv-sheetdlg" aria-label="Badges and level">
        <BadgesSheet onClose={() => dialog.current?.close()} />
      </dialog>
    </div>
  );
}
