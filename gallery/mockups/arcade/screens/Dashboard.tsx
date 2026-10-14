// Dashboard home (1280x800): greeting + due CTA, daily goal, level, streak calendar, badges,
// banks with progress, and the "More" area as an icon grid.
import {
  ArrowRight,
  CalendarDays,
  Flame,
  House,
  Layers,
  LayoutGrid,
  Library,
  Play,
  Plus,
  Search,
  Settings,
  Trophy,
} from 'lucide-react';
import { BADGES, BANKS, HEAT, MORE, PLAYER } from '../data';
import { Heatmap } from '../Heatmap';
import {
  BankTile,
  Bar,
  Button,
  Flash,
  Freezes,
  InfoTip,
  Kbd,
  Ring,
  Streak,
  Token,
  Xp,
  useFlash,
} from '../ui';
import { VaultBuddy } from '../VaultBuddy';

export function Dashboard() {
  const [msg, flash] = useFlash();
  // One dashboard per page, so fixed ids keep the in-screen anchors readable.
  const sec = (s: string) => `arc-db-${s}`;
  const earned = BADGES.filter((b) => b.earned).length;
  // The locked badge closest to done.
  const next = BADGES.filter((b) => !b.earned).sort(
    (a, b) => (b.progress ?? 0) - (a.progress ?? 0),
  )[0];

  const nav = [
    { label: 'Home', icon: House, href: `#${sec('top')}`, current: true },
    { label: 'Banks', icon: Library, href: `#${sec('banks')}` },
    { label: 'Review', icon: Layers, href: '#screen-review', count: PLAYER.due },
    { label: 'Search', icon: Search, href: `#${sec('search')}` },
    { label: 'More', icon: LayoutGrid, href: `#${sec('more')}` },
  ];

  return (
    <div className="db">
      <nav className="db-rail" aria-label="Dashboard">
        <div className="db-logo">
          <VaultBuddy pose="wave" size={40} />
          <span>StudyVault</span>
        </div>
        <ul>
          {nav.map((n) => (
            <li key={n.label}>
              <a className="db-nav" href={n.href} aria-current={n.current ? 'page' : undefined}>
                <n.icon aria-hidden size={20} strokeWidth={2.5} />
                <span>{n.label}</span>
                {n.count !== undefined && (
                  <span className="db-nav__count">
                    {n.count}
                    <span className="sv-sr"> due</span>
                  </span>
                )}
              </a>
            </li>
          ))}
        </ul>
        <div className="db-rail__foot">
          <button type="button" className="db-nav" onClick={() => flash('Settings opened')}>
            <Settings aria-hidden size={20} strokeWidth={2.5} />
            <span>Settings</span>
          </button>
        </div>
      </nav>

      <div className="db-main" id={sec('top')}>
        <div className="db-top">
          <label className="db-search" htmlFor={sec('search')}>
            <Search aria-hidden size={18} strokeWidth={2.6} />
            <span className="sv-sr">Search your vault</span>
            <input id={sec('search')} type="search" placeholder="Search your vault" />
            <Kbd>Ctrl K</Kbd>
          </label>
          <span className="db-top__stats">
            <Xp value={PLAYER.xpToday} />
            <Streak days={PLAYER.streak} />
          </span>
        </div>

        <div className="db-grid">
          <section className="sv-card db-hero" aria-labelledby={sec('hello')}>
            <VaultBuddy pose="wave" size={150} />
            <div className="db-hero__text">
              <span className="sv-eyebrow">Wednesday</span>
              <h1 id={sec('hello')}>Hey {PLAYER.name}, ready?</h1>
              <p className="db-hero__due">
                <span className="sv-num">{PLAYER.due}</span> cards due today
              </p>
              <div className="db-hero__cta">
                <Button
                  variant="primary"
                  size="lg"
                  icon={Play}
                  onClick={() => flash('Review started')}
                >
                  Start review
                </Button>
                <span className="sv-badge sv-badge--info">{PLAYER.dueNew} new</span>
              </div>
            </div>
          </section>

          <section className="sv-card db-goal" aria-labelledby={sec('goal')}>
            <div className="db-head">
              <h2 className="sv-card__title" id={sec('goal')}>
                Daily goal
              </h2>
              <span className="db-head__end db-goal__stats">
                <Streak days={PLAYER.streak} />
                <Freezes count={PLAYER.freezes} />
              </span>
            </div>
            <Ring
              value={PLAYER.xpToday}
              max={PLAYER.goal}
              size={120}
              stroke={14}
              label={`${PLAYER.xpToday} of ${PLAYER.goal} XP today`}
            >
              <span className="sv-num db-goal__n">{PLAYER.xpToday}</span>
              <span className="db-goal__of">of {PLAYER.goal} XP</span>
            </Ring>
          </section>

          <section className="sv-card db-level" aria-labelledby={sec('level')}>
            <h2 className="sv-card__title" id={sec('level')}>
              Level
            </h2>
            <div className="db-level__row">
              <span className="sv-levelcoin" aria-hidden>
                <span className="sv-num">{PLAYER.level}</span>
              </span>
              <div>
                <p className="db-level__name">Level {PLAYER.level}</p>
                <p className="sv-muted db-level__xp">
                  <span className="sv-num">{PLAYER.levelXp}</span> / {PLAYER.levelNeed} XP
                </p>
              </div>
            </div>
            <Bar
              value={PLAYER.levelXp}
              max={PLAYER.levelNeed}
              tone="xp"
              size="lg"
              label={`Level ${PLAYER.level} progress`}
            />
            <a className="db-link" href="#screen-badges">
              {PLAYER.levelNeed - PLAYER.levelXp} XP to level {PLAYER.level + 1}
              <ArrowRight aria-hidden size={16} strokeWidth={2.6} />
            </a>
          </section>

          <section className="sv-card db-heat" aria-labelledby={sec('heat')}>
            <div className="db-head">
              <h2 className="sv-card__title" id={sec('heat')}>
                Streak calendar
              </h2>
              <InfoTip label="About the streak">
                A day counts when you earn any XP. Miss a day and a streak freeze is used for you,
                if you have one.
              </InfoTip>
            </div>
            <div className="db-heat__body">
              <Heatmap data={HEAT} cell={14} gap={4} />
              <ul className="db-heat__stats">
                <li className="is-streak">
                  <Flame aria-hidden size={20} strokeWidth={2.6} />
                  <b className="sv-num">{PLAYER.streak}</b>
                  <span>Current</span>
                </li>
                <li>
                  <Trophy aria-hidden size={20} strokeWidth={2.6} />
                  <b className="sv-num">{PLAYER.bestStreak}</b>
                  <span>Best</span>
                </li>
                <li>
                  <CalendarDays aria-hidden size={20} strokeWidth={2.6} />
                  <b className="sv-num">{HEAT.filter((x) => x > 0).length}</b>
                  <span>Active days</span>
                </li>
              </ul>
            </div>
          </section>

          <section className="sv-card db-badges" aria-labelledby={sec('badges')}>
            <div className="db-head">
              <h2 className="sv-card__title" id={sec('badges')}>
                Badges
              </h2>
              <span className="sv-badge">
                {earned} of {BADGES.length}
              </span>
              <a className="db-link db-head__end" href="#screen-badges">
                View all
              </a>
            </div>
            <ul className="db-badges__row">
              {BADGES.slice(0, 5).map((b) => (
                <li key={b.id}>
                  <Token icon={b.icon} tone={b.tone} earned={b.earned} size={58} />
                  <span>{b.name}</span>
                  {!b.earned && <span className="sv-sr">, locked</span>}
                </li>
              ))}
            </ul>
            {next && (
              <div className="db-next">
                <span className="db-next__label">
                  Next: <b>{next.name}</b>
                </span>
                <Bar
                  value={Math.round((next.progress ?? 0) * 100)}
                  max={100}
                  size="sm"
                  tone="pink"
                  label={`${next.name} progress`}
                />
                <span className="sv-num db-next__pct">
                  {Math.round((next.progress ?? 0) * 100)}%
                </span>
              </div>
            )}
          </section>

          <section className="sv-card db-banks" aria-labelledby={sec('banks')}>
            <div className="db-head">
              <h2 className="sv-card__title" id={sec('banks')} tabIndex={-1}>
                Banks
              </h2>
              <a
                className="sv-btn sv-btn--secondary sv-btn--sm db-head__end"
                href="#screen-createbank"
              >
                <Plus aria-hidden size={16} strokeWidth={2.8} />
                <span>New bank</span>
              </a>
            </div>
            <ul className="db-banks__grid">
              {BANKS.map((b) => (
                <li key={b.id}>
                  <BankTile
                    name={b.name}
                    icon={b.icon}
                    color={b.color}
                    items={b.items}
                    due={b.due}
                    pct={Math.round(b.mastery * 100)}
                    onClick={() => flash(`${b.name} opened`)}
                  />
                </li>
              ))}
            </ul>
          </section>

          <section className="sv-card db-more" aria-labelledby={sec('more')}>
            <h2 className="sv-card__title" id={sec('more')} tabIndex={-1}>
              More
            </h2>
            <ul className="db-more__grid">
              {MORE.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    className="sv-tile"
                    onClick={() => flash(`${m.label} opened`)}
                  >
                    <span className="sv-tile__icon" aria-hidden>
                      <m.icon size={20} strokeWidth={2.4} />
                    </span>
                    {m.label}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
      <Flash msg={msg} />
    </div>
  );
}
