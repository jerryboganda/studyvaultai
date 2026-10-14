// Badges & level sheet: level progress, how XP is earned, badge tokens, freezes, game switches.
import { useState } from 'react';
import { BookmarkPlus, CheckCheck, Layers, SquarePlus, X, type LucideIcon } from 'lucide-react';
import { BADGES, PLAYER } from '../data';
import { Bar, Flash, Freezes, IconButton, InfoTip, Switch, Token, useFlash } from '../ui';
import { VaultBuddy } from '../VaultBuddy';

const EARN: { label: string; xp: number; icon: LucideIcon }[] = [
  { label: 'Review card', xp: 1, icon: Layers },
  { label: 'Save highlight', xp: 2, icon: BookmarkPlus },
  { label: 'Make card', xp: 3, icon: SquarePlus },
  { label: 'Finish session', xp: 5, icon: CheckCheck },
];

export function BadgesSheet() {
  const [pick, setPick] = useState('streak30');
  const [game, setGame] = useState(true);
  const [sound, setSound] = useState(false);
  const [msg, flash] = useFlash();
  const b = BADGES.find((x) => x.id === pick) ?? BADGES[0];
  const earned = BADGES.filter((x) => x.earned).length;

  return (
    <div className="bs">
      <header className="bs-head">
        <h2>Level &amp; badges</h2>
        <IconButton tip="below-end" label="Close" icon={X} onClick={() => flash('Sheet closed')} />
      </header>

      {game ? (
        <>
          <section className="bs-level" aria-label="Level">
            <span className="sv-levelcoin sv-levelcoin--lg" aria-hidden>
              <span className="sv-num">{PLAYER.level}</span>
            </span>
            <div className="bs-level__text">
              <p className="bs-level__name">Level {PLAYER.level}</p>
              <Bar
                value={PLAYER.levelXp}
                max={PLAYER.levelNeed}
                tone="xp"
                size="lg"
                label={`Level ${PLAYER.level} progress`}
              />
              <p className="sv-muted bs-level__xp">
                <b className="sv-num">{PLAYER.levelXp}</b> / {PLAYER.levelNeed} XP ·{' '}
                {PLAYER.levelNeed - PLAYER.levelXp} to go
              </p>
            </div>
          </section>

          <section className="bs-sec" aria-labelledby="bs-earn">
            <h3 className="sv-eyebrow" id="bs-earn">
              Earn XP
            </h3>
            <ul className="bs-earn">
              {EARN.map((e) => (
                <li key={e.label}>
                  <e.icon aria-hidden size={18} strokeWidth={2.6} />
                  <span>{e.label}</span>
                  <b className="sv-num">+{e.xp}</b>
                </li>
              ))}
            </ul>
          </section>

          <section className="bs-sec" aria-labelledby="bs-badges">
            <div className="bs-sec__head">
              <h3 className="sv-eyebrow" id="bs-badges">
                Badges
              </h3>
              <span className="sv-badge">
                {earned} of {BADGES.length}
              </span>
            </div>
            <ul className="bs-grid">
              {BADGES.map((x) => (
                <li key={x.id}>
                  <button
                    type="button"
                    className="bs-badge"
                    aria-pressed={pick === x.id}
                    onClick={() => setPick(x.id)}
                  >
                    <Token icon={x.icon} tone={x.tone} earned={x.earned} size={46} />
                    <span className="bs-badge__name">{x.name}</span>
                    {!x.earned && <span className="sv-sr">, locked</span>}
                  </button>
                </li>
              ))}
            </ul>
            {b && (
              <div className="bs-detail" aria-live="polite">
                <p className="bs-detail__name">
                  {b.name}
                  {b.earned ? (
                    <span className="sv-badge sv-badge--ok">Earned</span>
                  ) : (
                    <span className="sv-badge">Locked</span>
                  )}
                </p>
                <p className="sv-muted">{b.how}</p>
                {!b.earned && (
                  <Bar
                    value={Math.round((b.progress ?? 0) * 100)}
                    max={100}
                    size="sm"
                    tone="pink"
                    label={`${b.name} progress`}
                  />
                )}
              </div>
            )}
          </section>

          <section className="bs-row" aria-label="Streak freezes">
            <Freezes count={PLAYER.freezes} />
            <span className="bs-row__label">Streak freezes</span>
            <b className="sv-num">{PLAYER.freezes}/2</b>
            <InfoTip label="About streak freezes">
              Earn one for every 7-day streak and hold up to 2. One is used for you on a day you
              miss.
            </InfoTip>
          </section>
        </>
      ) : (
        <div className="bs-off">
          <VaultBuddy pose="sleep" size={120} />
          <p className="bs-off__title">Game mode is off</p>
          <p className="sv-muted">Your study data stays.</p>
        </div>
      )}

      <section className="bs-switches" aria-label="Game settings">
        <div className="bs-row">
          <Switch checked={game} onChange={setGame} label="Game mode" />
          <InfoTip label="About game mode">
            XP, levels, streaks and badges. Turning it off hides them; your reviews and saves are
            not touched.
          </InfoTip>
        </div>
        <div className="bs-row">
          <Switch checked={sound} onChange={setSound} label="Sounds" />
        </div>
      </section>
      <Flash msg={msg} />
    </div>
  );
}
