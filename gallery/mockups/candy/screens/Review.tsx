// Review session (1280x800): flip card, four rating buttons with key hints, progress, a +1 XP
// float per answer (rating-neutral), then the session-complete celebration.
import { useRef, useState, type KeyboardEvent } from 'react';
import { flushSync } from 'react-dom';
import {
  ArrowLeft,
  Brain,
  Feather,
  Layers,
  Quote,
  RotateCcw,
  RotateCw,
  ThumbsUp,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { CARDS, ME, bankOf } from '../data';
import { VaultBuddy } from '../VaultBuddy';
import { Bar, Btn, Confetti, FlameIcon, IconButton, Ring, StreakFlame, useGo } from '../ui';

type Rating = { id: string; label: string; key: string; tone: string; icon: LucideIcon };
const RATINGS: Rating[] = [
  { id: 'again', label: 'Again', key: '1', tone: 'rose', icon: RotateCcw },
  { id: 'hard', label: 'Hard', key: '2', tone: 'peach', icon: Brain },
  { id: 'good', label: 'Good', key: '3', tone: 'mint', icon: ThumbsUp },
  { id: 'easy', label: 'Easy', key: '4', tone: 'sky', icon: Feather },
];

export function Review({ startDone = false }: { startDone?: boolean }) {
  const go = useGo();
  const [idx, setIdx] = useState(startDone ? CARDS.length : 0);
  const [flipped, setFlipped] = useState(false);
  const [rated, setRated] = useState<string[]>(
    startDone ? ['good', 'good', 'again', 'easy', 'good'] : [],
  );
  const [floats, setFloats] = useState(0);
  const showBtn = useRef<HTMLButtonElement>(null);
  const firstRating = useRef<HTMLButtonElement>(null);
  const done = idx >= CARDS.length;
  const card = CARDS[Math.min(idx, CARDS.length - 1)]!;
  const bank = bankOf(card.bank);
  const BankIcon = bank.icon;
  const xp = rated.length;

  const flip = () => {
    flushSync(() => setFlipped(true));
    firstRating.current?.focus();
  };
  const rate = (r: Rating) => {
    flushSync(() => {
      setRated((list) => [...list, r.id]);
      setFloats((f) => f + 1);
      setFlipped(false);
      setIdx((i) => i + 1);
    });
    showBtn.current?.focus();
  };
  const restart = () => {
    flushSync(() => {
      setIdx(0);
      setRated([]);
      setFlipped(false);
    });
    showBtn.current?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (done || e.altKey || e.ctrlKey || e.metaKey) return;
    if (!flipped && (e.key === ' ' || e.key === 'Enter') && e.target === e.currentTarget) {
      e.preventDefault();
      flip();
      return;
    }
    const r = flipped ? RATINGS.find((x) => x.key === e.key) : undefined;
    if (r) {
      e.preventDefault();
      rate(r);
    }
  };

  if (done) return <Complete rated={rated} onAgain={restart} onHome={() => go('dashboard')} />;

  return (
    <div className="rv" tabIndex={-1} onKeyDown={onKey}>
      <header className="rv-top">
        <IconButton label="End session" icon={X} tip="below" onClick={() => go('dashboard')} />
        <div className="rv-progress">
          <Bar
            value={idx}
            max={CARDS.length}
            label="Session progress"
            valueText={`${idx} of ${CARDS.length} cards`}
            className="rv-progress__bar"
          />
          <span className="rv-progress__n" aria-hidden="true">
            {idx}/{CARDS.length}
          </span>
        </div>
        <span className="rv-xp">
          <Zap aria-hidden="true" strokeWidth={2.6} />
          {xp} XP
          <span className="sv-vh"> this session</span>
          {floats > 0 && (
            <span key={floats} className="sv-xpfloat rv-xp__float" aria-hidden="true">
              +1 XP
            </span>
          )}
        </span>
        <StreakFlame days={ME.streak} size={24} />
      </header>

      <div className="rv-stage">
        <p className="rv-meta">
          <span className="sv-chip" data-tone={bank.tone}>
            <BankIcon aria-hidden="true" strokeWidth={2.6} />
            {bank.name}
          </span>
          <span className="sv-chip">
            <Layers aria-hidden="true" strokeWidth={2.6} />
            Card {idx + 1} of {CARDS.length}
          </span>
        </p>

        <div
          className="rv-card"
          key={card.id}
          data-flipped={flipped || undefined}
          onClick={flipped ? undefined : flip}
        >
          <div className="rv-card__inner">
            <section className="rv-face rv-face--front" aria-label="Question" inert={flipped}>
              <span className="rv-face__tag">Question</span>
              <p className="rv-face__text">{card.front}</p>
              <span className="rv-face__blob" aria-hidden="true" />
            </section>
            <section className="rv-face rv-face--back" aria-label="Answer" inert={!flipped}>
              <p className="rv-face__q">{card.front}</p>
              <span className="rv-face__tag rv-face__tag--a">Answer</span>
              <p className="rv-face__text">{card.back}</p>
              {card.source ? (
                <figure className="rv-source">
                  <Quote aria-hidden="true" strokeWidth={2.6} />
                  <blockquote>{card.source}</blockquote>
                  <figcaption className="sv-hint">From your highlight</figcaption>
                </figure>
              ) : (
                <p className="sv-hint rv-source--none">Typed card, no source</p>
              )}
            </section>
          </div>
        </div>

        <div className="rv-actions" aria-live="polite">
          {!flipped ? (
            <Btn
              variant="primary"
              size="lg"
              icon={RotateCw}
              onClick={flip}
              btnRef={showBtn}
              trailing={<kbd className="sv-kbd rv-kbd">Space</kbd>}
            >
              Show answer
            </Btn>
          ) : (
            <div className="rv-rates" role="group" aria-label="How well did you know it?">
              {RATINGS.map((r, i) => {
                const Icon = r.icon;
                return (
                  <button
                    key={r.id}
                    ref={i === 0 ? firstRating : undefined}
                    type="button"
                    className="rv-rate"
                    data-tone={r.tone}
                    aria-keyshortcuts={r.key}
                    onClick={() => rate(r)}
                  >
                    <kbd className="sv-kbd rv-rate__key" aria-hidden="true">
                      {r.key}
                    </kbd>
                    <Icon aria-hidden="true" strokeWidth={2.5} />
                    <span className="rv-rate__label">{r.label}</span>
                    <span className="rv-rate__when">
                      <span className="sv-vh">next in </span>
                      {card.intervals[i]}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          <p className="sv-hint rv-keys">
            Keys: <kbd className="sv-kbd">Space</kbd> flip · <kbd className="sv-kbd">1</kbd>–
            <kbd className="sv-kbd">4</kbd> rate
          </p>
        </div>
      </div>
    </div>
  );
}

function Complete({
  rated,
  onAgain,
  onHome,
}: {
  rated: string[];
  onAgain: () => void;
  onHome: () => void;
}) {
  const xp = rated.length + 5;
  const remembered = Math.round(
    (rated.filter((r) => r !== 'again').length / Math.max(1, rated.length)) * 100,
  );
  const today = Math.min(ME.goal, ME.todayXp + xp);
  return (
    <div className="rv rv-done">
      <Confetti />
      <div className="rv-done__body">
        <VaultBuddy pose="cheer" size={176} label="Vault buddy cheering" />
        <h2 className="rv-done__title">Session complete!</h2>
        <p className="sv-muted">You finished all {rated.length} cards.</p>
        <ul className="rv-done__stats">
          <li data-tone="butter">
            <span className="sv-well">
              <Zap aria-hidden="true" strokeWidth={2.6} />
            </span>
            <strong>+{xp} XP</strong>
            <span className="sv-hint">incl. +5 bonus</span>
          </li>
          <li data-tone="peach">
            <span className="sv-well">
              <FlameIcon size={24} />
            </span>
            <strong>{ME.streak + 1} days</strong>
            <span className="sv-chip" data-tone="peach">
              Streak +1
            </span>
          </li>
          <li data-tone="mint">
            <Ring
              value={today}
              max={ME.goal}
              size={48}
              stroke={6}
              label={`Daily goal: ${today} of ${ME.goal} XP`}
            >
              <span className="rv-done__ring">{today}</span>
            </Ring>
            <strong>
              {today}/{ME.goal} XP
            </strong>
            <span className="sv-hint">{ME.goal - today} to goal</span>
          </li>
          <li data-tone="lavender">
            <span className="sv-well">
              <Brain aria-hidden="true" strokeWidth={2.6} />
            </span>
            <strong>{remembered}%</strong>
            <span className="sv-hint">remembered</span>
          </li>
        </ul>
        <div className="rv-done__actions">
          <Btn variant="primary" size="lg" icon={ArrowLeft} onClick={onHome}>
            Back home
          </Btn>
          <Btn variant="soft" size="lg" icon={RotateCcw} onClick={onAgain}>
            Study again
          </Btn>
        </div>
      </div>
    </div>
  );
}
