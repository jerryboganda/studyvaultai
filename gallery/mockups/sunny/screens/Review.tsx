import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Check, Clock, Flame, Hourglass, RotateCcw, Sparkles, Target, X, Zap } from 'lucide-react';
import { CARDS, GAME, RATINGS } from '../data';
import { BankChip } from '../shared';
import { VaultBuddy } from '../VaultBuddy';
import {
  Announce,
  Badge,
  Bar,
  Button,
  Confetti,
  GoalRing,
  IconButton,
  Kbd,
  Streak,
  Xp,
} from '../ui';

const RATE_ICON = { again: RotateCcw, hard: Hourglass, good: Check, easy: Sparkles } as const;
const SESSION_BONUS = 5;

export function Review() {
  const [i, setI] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [ratings, setRatings] = useState<string[]>([]);
  const [done, setDone] = useState(false);
  const [say, setSay] = useState('');
  const stage = useRef<HTMLDivElement>(null);
  const showBtn = useRef<HTMLButtonElement>(null);
  const doneHead = useRef<HTMLHeadingElement>(null);
  const card = CARDS[i]!;
  const xp = ratings.length + (done && ratings.length > 0 ? SESSION_BONUS : 0);

  // Keep keyboard focus inside the session as buttons appear and disappear.
  useEffect(() => {
    if (done) doneHead.current?.focus();
    else if (flipped) stage.current?.focus();
  }, [flipped, done]);

  const flip = () => {
    setFlipped(true);
    setSay(`Answer: ${card.back}`);
  };
  const rate = (id: string) => {
    const next = [...ratings, id];
    setRatings(next);
    setFlipped(false);
    if (i + 1 >= CARDS.length) {
      setDone(true);
      setSay(`Session complete. ${next.length + SESSION_BONUS} XP earned.`);
    } else {
      setI(i + 1);
      setSay(`Plus 1 XP. Card ${i + 2} of ${CARDS.length}.`);
      requestAnimationFrame(() => showBtn.current?.focus());
    }
  };
  const restart = () => {
    setI(0);
    setFlipped(false);
    setRatings([]);
    setDone(false);
    setSay('New session started.');
    requestAnimationFrame(() => showBtn.current?.focus());
  };
  // Single-key shortcuts only act while focus is inside the session (WCAG 2.1.4).
  const onKey = (e: KeyboardEvent) => {
    if (done || e.altKey || e.ctrlKey || e.metaKey) return;
    const onControl = (e.target as HTMLElement).closest('button, input, a');
    if (!flipped && (e.key === ' ' || e.key === 'Enter') && !onControl) {
      e.preventDefault();
      flip();
    }
    const r = RATINGS.find((x) => x.key === e.key);
    if (flipped && r) {
      e.preventDefault();
      rate(r.id);
    }
  };

  if (done) {
    const remembered = ratings.filter((r) => r !== 'again').length;
    const pct = ratings.length ? Math.round((remembered / ratings.length) * 100) : 0;
    const today = GAME.todayXp + xp;
    const facts = [
      { icon: Zap, tone: 'sun', value: `+${xp} XP`, label: 'Earned' },
      { icon: Flame, tone: 'warning', value: `${GAME.streak + 1} days`, label: 'Streak' },
      { icon: Target, tone: 'success', value: `${pct}%`, label: 'Recalled' },
      { icon: Clock, tone: 'primary', value: '3:12', label: 'Time' },
    ];
    return (
      <div className="sv-screen rv rv--done">
        <Confetti />
        <div className="rv__doneBox">
          <VaultBuddy pose="cheer" size={160} />
          <h3 className="rv__doneTitle" tabIndex={-1} ref={doneHead}>
            Session complete!
          </h3>
          {/* One summary card: today's goal ring plus the session facts. */}
          <section className="sv-card rv__sum" aria-label="Session summary">
            <GoalRing value={today} goal={GAME.goalXp} size={116} stroke={13}>
              <span className="rv__ringNum">{today}</span>
              <span className="rv__ringOf">/{GAME.goalXp} XP</span>
            </GoalRing>
            <ul className="rv__facts">
              {facts.map(({ icon: Icon, tone, value, label }) => (
                <li key={label} className="rv__fact">
                  <span className={`rv__factIcon sv-art--${tone}`} aria-hidden="true">
                    <Icon strokeWidth={2.6} />
                  </span>
                  <strong>{value}</strong>
                  <span>{label}</span>
                </li>
              ))}
            </ul>
          </section>
          <div className="sv-row rv__doneActions">
            <Button variant="secondary" size="lg" icon={RotateCcw} onClick={restart}>
              Review again
            </Button>
            <Button variant="primary" size="lg">
              Done
            </Button>
          </div>
        </div>
        <Announce text={say} />
      </div>
    );
  }

  return (
    <div className="sv-screen rv" onKeyDown={onKey}>
      <header className="rv__top">
        <IconButton icon={X} label="End session" onClick={() => setDone(true)} />
        <div className="sv-card rv__prog">
          <span className="rv__count">
            {i}/{CARDS.length}
          </span>
          <Bar value={i} max={CARDS.length} label="Session progress" tone="primary" />
        </div>
        <div className="rv__stats">
          <span className="rv__xpWrap">
            <Xp value={xp} />
            {ratings.length > 0 && (
              <span key={ratings.length} className="rv__float" aria-hidden="true">
                +1 XP
              </span>
            )}
          </span>
          <Streak days={GAME.streak} />
        </div>
      </header>

      <div className="rv__stage" ref={stage} tabIndex={-1} role="group" aria-label="Flashcard">
        <div className={`rv__card${flipped ? ' is-flipped' : ''}`}>
          <section
            className="sv-card rv__face rv__face--front"
            inert={flipped}
            aria-label="Question"
          >
            <div className="sv-row rv__meta">
              <BankChip id={card.deck} />
              <Badge>{card.kind}</Badge>
            </div>
            <p className="rv__q">{card.front}</p>
          </section>
          <section className="sv-card rv__face rv__face--back" inert={!flipped} aria-label="Answer">
            <div className="sv-row rv__meta">
              <BankChip id={card.deck} />
              <Badge tone="success" icon={Check}>
                Answer
              </Badge>
            </div>
            <p className="rv__qSmall">{card.front}</p>
            <p className="rv__a">{card.back}</p>
          </section>
        </div>
      </div>

      <div className="rv__controls">
        {!flipped ? (
          <div className="rv__show">
            <Button
              ref={showBtn}
              variant="primary"
              size="lg"
              onClick={flip}
              aria-keyshortcuts="Space"
            >
              Show answer
            </Button>
            <span className="sv-muted rv__hint">
              or <Kbd>Space</Kbd>
            </span>
          </div>
        ) : (
          <div className="rv__rates" role="group" aria-label="How well did you know it?">
            {RATINGS.map((r) => {
              const Icon = RATE_ICON[r.id];
              return (
                <Button
                  key={r.id}
                  variant={r.variant}
                  size="lg"
                  className="rv__rate"
                  aria-label={`${r.label}, next in ${r.interval}`}
                  aria-keyshortcuts={r.key}
                  onClick={() => rate(r.id)}
                >
                  <span className="rv__rateMain">
                    <Icon aria-hidden="true" strokeWidth={2.6} />
                    {r.label}
                  </span>
                  <span className="rv__rateSub" aria-hidden="true">
                    {r.interval}
                    <kbd className="rv__key">{r.key}</kbd>
                  </span>
                </Button>
              );
            })}
          </div>
        )}
      </div>
      <Announce text={say} />
    </div>
  );
}
