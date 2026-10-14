// Review session (1280x800): flip card, four rating buttons with key hints, session progress,
// a rating-neutral +1 XP float, and the session-complete celebration.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowRight, Flame, Home, Play, X, Zap } from 'lucide-react';
import { BANKS, CARDS, PLAYER, RATINGS, type RatingId } from '../data';
import { Bar, Button, Chip, Confetti, InfoTip, Kbd, Ring, Streak, Xp } from '../ui';
import { VaultBuddy } from '../VaultBuddy';

const FINISH_BONUS = 5;
const ZERO: Record<RatingId, number> = { again: 0, hard: 0, good: 0, easy: 0 };

function Complete({ counts, onAgain }: { counts: Record<RatingId, number>; onAgain: () => void }) {
  const cards = Object.values(counts).reduce((a, b) => a + b, 0);
  const xp = cards + FINISH_BONUS;
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    // Only move focus when the session ended in this view, not when the frame first renders.
    if (heading.current?.closest('[data-live]')) heading.current.focus();
  }, []);
  return (
    <div className="rv-done">
      <Confetti />
      <VaultBuddy pose="cheer" size={168} label="Vault buddy cheering" />
      <h2 ref={heading} tabIndex={-1}>
        Session complete!
      </h2>
      <div className="rv-done__tiles">
        <div className="rv-tile rv-tile--xp">
          <Zap aria-hidden size={28} strokeWidth={2.6} />
          <span className="sv-num rv-tile__n">+{xp}</span>
          <span className="rv-tile__label">
            XP earned
            <InfoTip label="How XP was counted">
              {cards} cards × 1 XP, plus {FINISH_BONUS} for finishing. Ratings never change XP.
            </InfoTip>
          </span>
        </div>
        <div className="rv-tile rv-tile--streak">
          <Flame aria-hidden size={28} strokeWidth={2.6} />
          <span className="sv-num rv-tile__n">{PLAYER.streak + 1}</span>
          <span className="rv-tile__label">
            day streak <span className="sv-badge sv-badge--ok">+1</span>
          </span>
        </div>
        <div className="rv-tile rv-tile--goal">
          <Ring
            value={PLAYER.xpToday + xp}
            max={PLAYER.goal}
            size={64}
            stroke={8}
            label={`Daily goal: ${PLAYER.xpToday + xp} of ${PLAYER.goal} XP`}
          >
            <span className="sv-num rv-tile__ring">{PLAYER.xpToday + xp}</span>
          </Ring>
          <span className="rv-tile__label">of {PLAYER.goal} XP goal</span>
        </div>
      </div>
      <ul className="rv-done__mix" aria-label="Your answers">
        {RATINGS.map((r) => (
          <li key={r.id} className={`rv-mix rv-mix--${r.id}`}>
            <span className="sv-num">{counts[r.id]}</span> {r.label}
          </li>
        ))}
      </ul>
      <div className="rv-done__cta">
        <a className="sv-btn sv-btn--secondary sv-btn--lg" href="#screen-dashboard">
          <Home aria-hidden size={20} strokeWidth={2.5} />
          <span>Home</span>
        </a>
        <Button variant="primary" size="lg" icon={Play} onClick={onAgain}>
          Keep going
        </Button>
      </div>
    </div>
  );
}

export function Review({ initial = 'card' }: { initial?: 'card' | 'complete' }) {
  const [index, setIndex] = useState(initial === 'complete' ? CARDS.length : 0);
  const [flipped, setFlipped] = useState(false);
  const [counts, setCounts] = useState<Record<RatingId, number>>(
    initial === 'complete' ? { again: 1, hard: 1, good: 2, easy: 1 } : ZERO,
  );
  const [floats, setFloats] = useState<{ id: number; slot: number }[]>([]);
  const [said, setSaid] = useState('');
  const [live, setLive] = useState(false);
  const showBtn = useRef<HTMLButtonElement>(null);
  const back = useRef<HTMLDivElement>(null);

  const done = index >= CARDS.length;
  const card = CARDS[Math.min(index, CARDS.length - 1)];
  const bank = BANKS.find((b) => b.name === card?.bank);
  const sessionXp = Object.values(counts).reduce((a, b) => a + b, 0);

  useEffect(() => {
    if (!live) return;
    if (flipped) back.current?.focus();
    else showBtn.current?.focus();
  }, [flipped, index, live]);

  const reveal = () => {
    setLive(true);
    setFlipped(true);
  };

  const rate = (id: RatingId, slot: number) => {
    if (!flipped) return;
    setLive(true);
    setCounts((c) => ({ ...c, [id]: c[id] + 1 }));
    setFloats((f) => [...f, { id: Date.now(), slot }]);
    setSaid(`${RATINGS[slot]?.label}. Plus 1 XP.`);
    setFlipped(false);
    setIndex((i) => i + 1);
  };

  const onKey = (e: KeyboardEvent) => {
    if (done || e.altKey || e.ctrlKey || e.metaKey) return;
    // Links and fields keep their own keys.
    if ((e.target as HTMLElement).closest('a, input, textarea, select')) return;
    if ((e.key === ' ' || e.key === 'Enter') && !flipped) {
      e.preventDefault();
      reveal();
      return;
    }
    const slot = ['1', '2', '3', '4'].indexOf(e.key);
    const r = RATINGS[slot];
    if (flipped && r) {
      e.preventDefault();
      rate(r.id, slot);
    }
  };

  return (
    <div className="rv" onKeyDown={onKey} data-live={live || undefined}>
      <header className="rv-top">
        <a className="sv-iconbtn rv-close" href="#screen-dashboard" aria-label="End session">
          <X aria-hidden size={22} strokeWidth={2.6} />
        </a>
        <div className="rv-progress">
          <Bar
            value={Math.min(index, CARDS.length)}
            max={CARDS.length}
            size="lg"
            label={`Session progress: ${Math.min(index, CARDS.length)} of ${CARDS.length} cards`}
          />
        </div>
        <span className="rv-top__count sv-num">
          {Math.min(index + (done ? 0 : 1), CARDS.length)}/{CARDS.length}
        </span>
        <Xp value={`+${sessionXp + (done ? FINISH_BONUS : 0)}`} />
        <Streak days={done ? PLAYER.streak + 1 : PLAYER.streak} />
      </header>

      {done ? (
        <Complete
          counts={counts}
          onAgain={() => {
            setCounts(ZERO);
            setIndex(0);
            setFlipped(false);
            setLive(true);
          }}
        />
      ) : (
        <div className="rv-stage">
          <div className={`rv-card${flipped ? ' is-flipped' : ''}`}>
            <div className="rv-card__inner">
              <div className="rv-face rv-face--front" inert={flipped} aria-hidden={flipped}>
                {bank && (
                  <Chip color={bank.color} icon={bank.icon}>
                    {bank.name}
                  </Chip>
                )}
                <p className="rv-q">{card?.front}</p>
                <span className="rv-face__hint">Question</span>
              </div>
              <div
                className="rv-face rv-face--back"
                ref={back}
                tabIndex={-1}
                inert={!flipped}
                aria-hidden={!flipped}
                aria-label="Answer"
              >
                <p className="rv-q rv-q--small">{card?.front}</p>
                <p className="rv-a">
                  <span>{card?.back}</span>
                </p>
                <a className="rv-src" href="#screen-inpage">
                  {card?.source}
                  <ArrowRight aria-hidden size={14} strokeWidth={2.6} />
                </a>
              </div>
            </div>
          </div>

          <div className="rv-answer">
            {!flipped ? (
              <button
                ref={showBtn}
                type="button"
                className="sv-btn sv-btn--primary sv-btn--lg rv-show"
                onClick={reveal}
              >
                <span>Show answer</span>
                <Kbd>Space</Kbd>
              </button>
            ) : (
              <div className="rv-rates" role="group" aria-label="How well did you know it?">
                {RATINGS.map((r, slot) => (
                  <button
                    key={r.id}
                    type="button"
                    className={`rv-rate rv-rate--${r.id}`}
                    aria-keyshortcuts={r.key}
                    onClick={() => rate(r.id, slot)}
                  >
                    <span className="rv-rate__label">{r.label}</span>
                    <span className="rv-rate__int">{r.interval}</span>
                    <Kbd>{r.key}</Kbd>
                  </button>
                ))}
              </div>
            )}
            {floats.map((f) => (
              <span
                key={f.id}
                className="sv-float rv-float"
                style={{ left: `${12.5 + f.slot * 25}%` }}
                aria-hidden
                onAnimationEnd={() => setFloats((xs) => xs.filter((x) => x.id !== f.id))}
              >
                <Zap size={16} strokeWidth={3} />
                +1 XP
              </span>
            ))}
          </div>
          <p className="rv-keys">
            <Kbd>Space</Kbd> flip · <Kbd>1</Kbd>–<Kbd>4</Kbd> rate
          </p>
        </div>
      )}
      <p className="sv-sr" role="status">
        {said}
      </p>
    </div>
  );
}
