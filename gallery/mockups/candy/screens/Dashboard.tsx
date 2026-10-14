// Dashboard home (1280x800): greeting with the mascot, "Due today" call to action, goal ring,
// level, streak heatmap, bank cards, badges strip and the More tools grid.
import { useId, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  CircleCheck,
  Clock,
  House,
  LayoutGrid,
  Layers,
  Library,
  Play,
  Plus,
  Search,
  Sparkle,
  Star,
  X,
} from 'lucide-react';
import { BADGES, BANKS, ME, MORE } from '../data';
import { LogoMark, VaultBuddy } from '../VaultBuddy';
import {
  Bar,
  Btn,
  Freezes,
  Heatmap,
  IconButton,
  InfoTip,
  Medal,
  Ring,
  StreakFlame,
  trapTab,
  useGo,
  useReducedMotion,
} from '../ui';
import { SearchBox } from './Search';

export function Dashboard() {
  const go = useGo();
  const reduced = useReducedMotion();
  const ids = useId();
  const main = useRef<HTMLDivElement>(null);
  const searchBtn = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const tool = MORE.find((m) => m.id === picked);
  const earned = BADGES.filter((b) => b.earned);

  const jump = (id: string) => {
    const el = main.current?.querySelector<HTMLElement>(`[data-anchor="${id}"]`);
    el?.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
    el?.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
  };
  const openSearch = () => {
    flushSync(() => setSearch(true));
    searchInput.current?.focus();
  };
  const closeSearch = () => {
    setSearch(false);
    searchBtn.current?.focus();
  };

  return (
    <div className="db">
      <nav className="db-nav" aria-label="Dashboard" inert={search}>
        <div className="db-brand">
          <LogoMark size={34} />
          <span>StudyVault</span>
        </div>
        <ul className="db-nav__list">
          <li>
            <button type="button" className="db-navitem" aria-current="page">
              <House aria-hidden="true" strokeWidth={2.4} />
              Home
            </button>
          </li>
          <li>
            <button type="button" className="db-navitem" onClick={() => jump('banks')}>
              <Library aria-hidden="true" strokeWidth={2.4} />
              Banks
            </button>
          </li>
          <li>
            <button type="button" className="db-navitem" onClick={() => go('review')}>
              <Layers aria-hidden="true" strokeWidth={2.4} />
              Review
              <span className="sv-count">
                {ME.due}
                <span className="sv-vh"> due</span>
              </span>
            </button>
          </li>
          <li>
            <button ref={searchBtn} type="button" className="db-navitem" onClick={openSearch}>
              <Search aria-hidden="true" strokeWidth={2.4} />
              Search
              <kbd className="sv-kbd">/</kbd>
            </button>
          </li>
          <li className="db-nav__sep" aria-hidden="true" />
          <li>
            <button type="button" className="db-navitem" onClick={() => jump('more')}>
              <LayoutGrid aria-hidden="true" strokeWidth={2.4} />
              More
            </button>
          </li>
        </ul>
        <div className="db-nav__card" data-tone="sky">
          <Freezes held={ME.freezes} />
          <p>
            <strong>{ME.freezes} freezes</strong>
          </p>
          <p className="sv-hint">Saves a missed day.</p>
        </div>
      </nav>

      <div className="db-main" ref={main} inert={search}>
        <header className="db-top">
          <div>
            <p className="db-date">Wednesday, 14 October</p>
            <h1 className="db-hello">Good evening, {ME.name}!</h1>
          </div>
          <div className="db-top__end">
            <Btn variant="soft" icon={Plus} onClick={() => go('create-bank')}>
              New bank
            </Btn>
            <button type="button" className="db-lvl" onClick={() => go('badges')}>
              <Star aria-hidden="true" strokeWidth={2.6} />
              Level {ME.level}
            </button>
          </div>
        </header>

        <div className="db-hero">
          <section className="db-due" aria-labelledby={`${ids}-due`}>
            <span className="db-due__blob" aria-hidden="true" />
            <VaultBuddy pose="wave" size={168} />
            <div className="db-due__body">
              <p className="db-due__kicker">
                <Sparkle aria-hidden="true" strokeWidth={2.6} />
                Due today
              </p>
              <h2 id={`${ids}-due`} className="db-due__title">
                {ME.due} cards
              </h2>
              <div className="db-due__mix">
                <span className="sv-chip" data-tone="sky">
                  {ME.mix.new} new
                </span>
                <span className="sv-chip" data-tone="butter">
                  {ME.mix.learning} learning
                </span>
                <span className="sv-chip" data-tone="mint">
                  {ME.mix.review} review
                </span>
                <span className="sv-chip">
                  <Clock aria-hidden="true" strokeWidth={2.6} />
                  ~6 min
                </span>
              </div>
              <Btn variant="go" size="lg" icon={Play} onClick={() => go('review')}>
                Start review
              </Btn>
            </div>
          </section>

          <section className="db-goal sv-card" aria-labelledby={`${ids}-goal`}>
            <div className="db-card__head">
              <h2 id={`${ids}-goal`}>Daily goal</h2>
              <InfoTip label="About the daily goal" align="end">
                <strong>Regular · 30 XP</strong>. Review a card +1, save +2, make a card +3, finish
                a session +5.
              </InfoTip>
            </div>
            <Ring
              value={ME.todayXp}
              max={ME.goal}
              size={132}
              stroke={14}
              label={`Daily goal: ${ME.todayXp} of ${ME.goal} XP`}
            >
              <span className="sv-ring__value db-goal__v">{ME.todayXp}</span>
              <span className="sv-ring__unit">of {ME.goal} XP</span>
            </Ring>
            <p className="db-goal__left">{ME.goal - ME.todayXp} XP to go</p>
          </section>
        </div>

        <div className="db-row">
          <section className="db-level sv-card" aria-labelledby={`${ids}-lvl`}>
            <div className="db-card__head">
              <span className="db-level__badge" aria-hidden="true">
                {ME.level}
              </span>
              <h2 id={`${ids}-lvl`}>Level {ME.level}</h2>
            </div>
            <Bar
              value={ME.levelXp}
              max={ME.levelNeed}
              label={`Level ${ME.level} progress`}
              valueText={`${ME.levelXp} of ${ME.levelNeed} XP`}
            />
            <p className="db-level__nums">
              <strong>{ME.levelXp}</strong> / {ME.levelNeed} XP
            </p>
            <ul className="db-level__today" aria-label="XP today">
              <li data-tone="lavender">
                <span>+10</span> reviews
              </li>
              <li data-tone="butter">
                <span>+6</span> saves
              </li>
              <li data-tone="mint">
                <span>+2</span> cards
              </li>
            </ul>
          </section>

          <section className="db-streak sv-card" aria-labelledby={`${ids}-streak`}>
            <div className="db-card__head">
              <h2 id={`${ids}-streak`} className="db-streak__title">
                <StreakFlame days={ME.streak} size={26} />
                <span aria-hidden="true">day streak</span>
              </h2>
              <span className="db-streak__freeze">
                <Freezes held={ME.freezes} />
                <InfoTip label="About streak freezes" align="end">
                  Earn 1 freeze per 7-day streak and hold up to 2. One is used for you on a missed
                  day.
                </InfoTip>
              </span>
            </div>
            <Heatmap cell={15} gap={4} />
          </section>
        </div>

        <section className="db-sec" data-anchor="banks" aria-labelledby={`${ids}-banks`}>
          <div className="db-sec__head">
            <h2 id={`${ids}-banks`} tabIndex={-1}>
              Your banks
            </h2>
            <span className="sv-hint">{BANKS.length} banks</span>
          </div>
          <ul className="db-banks">
            {BANKS.map((b) => {
              const Icon = b.icon;
              return (
                <li key={b.id} className="db-bank" data-tone={b.tone}>
                  <span className="db-bank__blob" aria-hidden="true" />
                  <div className="db-bank__top">
                    <span className="sv-well">
                      <Icon aria-hidden="true" strokeWidth={2.4} />
                    </span>
                    {b.due > 0 ? (
                      <span className="sv-chip" data-tone="peach">
                        <Clock aria-hidden="true" strokeWidth={2.6} />
                        {b.due} due
                      </span>
                    ) : (
                      <span className="sv-chip" data-tone="mint">
                        <CircleCheck aria-hidden="true" strokeWidth={2.6} />
                        All done
                      </span>
                    )}
                  </div>
                  <h3 className="db-bank__name">{b.name}</h3>
                  <p className="sv-hint">{b.items} items</p>
                  <div className="db-bank__bar">
                    <Bar
                      tone={b.tone}
                      size="sm"
                      value={b.learned}
                      max={100}
                      label={`${b.name} learned`}
                      valueText={`${b.learned}% learned`}
                    />
                    <span>{b.learned}%</span>
                  </div>
                  <Btn
                    size="sm"
                    variant="soft"
                    icon={Play}
                    label={`Review ${b.name}`}
                    onClick={() => go('review')}
                    disabledReason={b.due === 0 ? 'Nothing due today' : undefined}
                  >
                    Review
                  </Btn>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="db-sec" aria-labelledby={`${ids}-badges`}>
          <div className="db-sec__head">
            <h2 id={`${ids}-badges`}>Badges</h2>
            <span className="sv-hint">
              {earned.length} of {BADGES.length}
            </span>
            <span className="db-sec__spacer" />
            <Btn size="sm" variant="ghost" onClick={() => go('badges')}>
              All badges
            </Btn>
          </div>
          <ul className="db-badges">
            {earned.map((b) => (
              <li key={b.id}>
                <Medal b={b} compact />
              </li>
            ))}
          </ul>
        </section>

        <section className="db-sec" data-anchor="more" aria-labelledby={`${ids}-more`}>
          <div className="db-sec__head">
            <h2 id={`${ids}-more`} tabIndex={-1}>
              More tools
            </h2>
          </div>
          <ul className="db-more">
            {MORE.slice(0, 10).map((m) => {
              const Icon = m.icon;
              return (
                <li key={m.id}>
                  <button
                    type="button"
                    className="db-tile"
                    aria-pressed={picked === m.id}
                    onClick={() => setPicked((p) => (p === m.id ? null : m.id))}
                  >
                    <span className="sv-well" data-tone="lavender">
                      <Icon aria-hidden="true" strokeWidth={2.3} />
                    </span>
                    <span className="db-tile__label">{m.label}</span>
                    {m.status && <span className="db-tile__st">{m.status}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="db-more__detail" role="status">
            {tool ? (
              <>
                <strong>{tool.label}</strong> · {tool.hint}
              </>
            ) : (
              <span className="sv-hint">Pick a tool to see what it does.</span>
            )}
          </p>
        </section>
      </div>

      {search && (
        <div
          className="sv-scrim db-search"
          onClick={(e) => e.target === e.currentTarget && closeSearch()}
        >
          <div
            className="sv-dialog db-search__box"
            role="dialog"
            aria-label="Search"
            onKeyDown={(e) => {
              if (e.key === 'Escape') closeSearch();
              trapTab(e);
            }}
          >
            <IconButton
              className="sv-dialog__close"
              label="Close search"
              icon={X}
              onClick={closeSearch}
            />
            <h2 className="db-search__title">Search</h2>
            <SearchBox inputRef={searchInput} />
          </div>
        </div>
      )}
    </div>
  );
}
