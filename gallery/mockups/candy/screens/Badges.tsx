// Badges & level sheet: level progress, streak and freezes, earned/locked badges, Game mode switch.
import { useEffect, useId, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Lock, Snowflake, Trophy, X } from 'lucide-react';
import { BADGES, ME } from '../data';
import { VaultBuddy } from '../VaultBuddy';
import {
  Bar,
  Btn,
  Freezes,
  GO_EVENT,
  IconButton,
  InfoTip,
  Medal,
  StreakFlame,
  Switch,
  trapTab,
} from '../ui';

export function Badges() {
  const ids = useId();
  const [open, setOpen] = useState(true);
  const [game, setGame] = useState(true);
  const [picked, setPicked] = useState('week');
  const opener = useRef<HTMLButtonElement>(null);
  const head = useRef<HTMLHeadingElement>(null);
  const b = BADGES.find((x) => x.id === picked)!;
  const earned = BADGES.filter((x) => x.earned).length;
  const PickedIcon = b.icon;

  const close = () => {
    flushSync(() => setOpen(false));
    opener.current?.focus();
  };
  const show = () => {
    flushSync(() => setOpen(true));
    head.current?.focus();
  };

  // "All badges" elsewhere reopens the sheet.
  useEffect(() => {
    const on = (e: Event) => {
      if ((e as CustomEvent<string>).detail === 'badges' && !open) show();
    };
    window.addEventListener(GO_EVENT, on);
    return () => window.removeEventListener(GO_EVENT, on);
  });

  return (
    <div className="bs">
      {!open ? (
        <div className="bs-closed">
          <VaultBuddy pose="wave" size={110} />
          <Btn variant="primary" icon={Trophy} onClick={show} btnRef={opener}>
            Your progress
          </Btn>
        </div>
      ) : (
        <section
          className="bs-sheet"
          role="dialog"
          aria-labelledby={`${ids}-t`}
          onKeyDown={(e) => {
            if (e.key === 'Escape') close();
            trapTab(e);
          }}
        >
          <span className="bs-grab" aria-hidden="true" />
          <header className="bs-head">
            <h3 id={`${ids}-t`} ref={head} tabIndex={-1}>
              Your progress
            </h3>
            <IconButton label="Close" icon={X} tip="below-end" onClick={close} />
          </header>

          {game ? (
            <div className="bs-scroll">
              <div className="bs-level" data-tone="lavender">
                <span className="bs-level__star" aria-hidden="true">
                  <svg viewBox="0 0 64 64" width="64" height="64">
                    <path
                      d="M32 4c3 0 4.5 6 7 7.6s8.6-.7 10.6 1.6 0 8.2 1.3 10.8 7.1 4.7 7.1 8-5.8 5.4-7.1 8 .7 8.5-1.3 10.8-8.1 0-10.6 1.6S35 60 32 60s-4.5-6-7-7.6-8.6.7-10.6-1.6 0-8.2-1.3-10.8S6 35.3 6 32s5.8-5.4 7.1-8-.7-8.5 1.3-10.8 8.1 0 10.6-1.6S29 4 32 4Z"
                      fill="var(--sv-primary)"
                    />
                  </svg>
                  <span>{ME.level}</span>
                </span>
                <div className="bs-level__main">
                  <p className="bs-level__name">
                    Level {ME.level}
                    <InfoTip label="How XP works" align="end">
                      <strong>XP never depends on ratings.</strong> Review a card +1 · save a
                      highlight +2 · make a card +3 · finish a session +5. Each level needs a bit
                      more.
                    </InfoTip>
                  </p>
                  <Bar
                    value={ME.levelXp}
                    max={ME.levelNeed}
                    label={`Level ${ME.level} progress`}
                    valueText={`${ME.levelXp} of ${ME.levelNeed} XP`}
                  />
                  <p className="sv-hint">
                    {ME.levelNeed - ME.levelXp} XP to Level {ME.level + 1}
                  </p>
                </div>
              </div>

              <div className="bs-minis">
                <div className="bs-mini" data-tone="peach">
                  <StreakFlame days={ME.streak} size={26} />
                  <span className="sv-hint">Day streak</span>
                </div>
                <div className="bs-mini" data-tone="sky">
                  <Freezes held={ME.freezes} />
                  <span className="sv-hint bs-mini__row">
                    Freezes
                    <InfoTip label="About freezes" align="end">
                      <Snowflake aria-hidden="true" className="bs-inline-ico" strokeWidth={2.6} />{' '}
                      Earn 1 per 7-day streak, hold up to 2. Used for you on a missed day.
                    </InfoTip>
                  </span>
                </div>
                <div className="bs-mini" data-tone="butter">
                  <span className="bs-mini__big">
                    <Trophy aria-hidden="true" strokeWidth={2.6} />
                    {earned}
                  </span>
                  <span className="sv-hint">Badges</span>
                </div>
              </div>

              <div className="bs-badges">
                <h4>
                  Badges <span className="sv-hint">{`${earned} of ${BADGES.length}`}</span>
                </h4>
                <p className="bs-detail" role="status" data-tone={b.earned ? b.tone : 'plain'}>
                  <span className="sv-well sv-well--sm">
                    {b.earned ? (
                      <PickedIcon aria-hidden="true" strokeWidth={2.4} />
                    ) : (
                      <Lock aria-hidden="true" strokeWidth={2.6} />
                    )}
                  </span>
                  <span>
                    <strong>{b.name}</strong>
                    <span className="sv-hint">
                      {' '}
                      ·{' '}
                      {b.earned ? `Earned ${b.earned}` : `${b.progress?.[0]} of ${b.progress?.[1]}`}
                    </span>
                    <span className="bs-detail__how">{b.how}</span>
                  </span>
                </p>
                <ul className="bs-grid">
                  {BADGES.map((x) => (
                    <li key={x.id}>
                      <Medal b={x} selected={picked === x.id} onSelect={() => setPicked(x.id)} />
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ) : (
            <div className="sv-empty bs-off">
              <VaultBuddy pose="sleep" size={140} />
              <h4>Game mode is off</h4>
              <p>XP, streaks and badges are hidden.</p>
            </div>
          )}

          <footer className="bs-foot">
            <Switch label="Game mode" checked={game} onChange={setGame} />
            <span className="sv-hint">{game ? 'On' : 'Off'} · stays on this device</span>
          </footer>
        </section>
      )}
    </div>
  );
}
