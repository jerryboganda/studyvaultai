import { useEffect, useRef, useState } from 'react';
import {
  Check,
  CircleCheck,
  CircleX,
  Feather,
  Flame,
  Hourglass,
  Layers,
  Lightbulb,
  LocateFixed,
  Pause,
  Pencil,
  RotateCcw,
  Sunrise,
  Undo2,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { RATINGS, RATING_LABELS, type Card, type Rating } from '@study';
import { getCardSourceContext, type CardSourceContext } from '@storage';
import {
  BarMeter,
  Button,
  ChunkyButton,
  IconButton,
  InfoTip,
  InlineNotice,
  LOCAL_PREF_KEYS,
  StatChip,
  VaultBuddy,
  errorMessage,
  truncate,
  useAction,
  useAsync,
  useLatest,
  useXpFloat,
} from '@ui';
import { XP, type GameView } from '@ui/game';
import {
  CardFace,
  TID,
  formatWhen,
  isFieldTarget,
  keyAction,
  ratingId,
  untilLabel,
  type KeyAction,
  type ReviewSessionController,
  type SessionState,
} from '@ui/review';
import { CardEditForm } from './CardEditForm';
import { ExplainPanel } from './ExplainPanel';
import { openSource, type JumpResult } from './jump';

const TYPE_LABEL = {
  basic: 'Q&A',
  cloze: 'Fill in',
  definition: 'Definition',
  compare: 'Compare',
  mcq: 'Multiple choice',
} as const;

/** One icon per rating (UX_DESIGN section 4); the label is always shown next to it. */
export const RATING_ICON: Record<Rating, LucideIcon> = {
  1: RotateCcw,
  2: Hourglass,
  3: Check,
  4: Feather,
};

/** Per-viewer convenience (localStorage): whether the single-key shortcuts act (WCAG 2.1.4). */
const KEYS_PREF = LOCAL_PREF_KEYS.reviewKeys;
function readKeysPref(): boolean {
  try {
    return window.localStorage.getItem(KEYS_PREF) !== 'off';
  } catch {
    return true;
  }
}

export function Session({
  state,
  controller,
  game,
  timeZone,
  onLeave,
}: {
  state: SessionState;
  controller: ReviewSessionController;
  game: GameView;
  timeZone: string;
  onLeave(): void;
}) {
  const { current, phase } = state;
  const [editing, setEditing] = useState(false);
  const [explaining, setExplaining] = useState(false);
  const [jump, setJump] = useState<JumpResult | null>(null);
  /** What "Jump to source" is doing right now ("Opening the page…"), while it runs. */
  const [jumpNote, setJumpNote] = useState<string | null>(null);
  const jumping = useRef(false);
  const cardId = current?.card.id ?? null;
  const [lastCardId, setLastCardId] = useState<string | null>(null);

  // A new card starts with the editor and explanation closed (state reset during render, not in an
  // effect: React re-renders immediately with the new values).
  if (cardId !== lastCardId) {
    setLastCardId(cardId);
    setEditing(false);
    setExplaining(false);
    setJump(null);
    setJumpNote(null);
  }

  const [keysOn, setKeysOn] = useState(readKeysPref);
  const setKeys = (on: boolean) => {
    setKeysOn(on);
    try {
      window.localStorage.setItem(KEYS_PREF, on ? 'on' : 'off');
    } catch {
      /* a convenience: the choice then lasts until the page closes */
    }
  };
  const latest = useLatest({ state, editing, explaining, keysOn });
  const article = useRef<HTMLElement>(null);
  const waitUntil = state.waitUntil;
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Game mode on and the ledger ready: today's XP, the streak and a "+1 XP" float per new answer.
  const g = game.data;
  const play = g?.ready && g.mode ? g : null;
  const float = useXpFloat();
  const award = float.award;
  const fresh = state.lastAnswer?.fresh ? state.lastAnswer.logId : null;
  const showFloat = play !== null;
  // Only an answer given on this screen floats (not one that was there when it opened).
  const floated = useRef(fresh);
  useEffect(() => {
    if (!fresh || fresh === floated.current) return;
    floated.current = fresh;
    if (showFloat) award(XP.review);
  }, [fresh, showFloat, award]);

  // Waiting for a learning step: show the next card by itself when its time comes.
  useEffect(() => {
    if (phase !== 'waiting' || !waitUntil) return undefined;
    const wake = setTimeout(
      () => void controller.tick(),
      Math.max(0, Date.parse(waitUntil) - Date.now()) + 50,
    );
    const clock = setInterval(() => setNowMs(Date.now()), 15_000);
    return () => {
      clearTimeout(wake);
      clearInterval(clock);
    };
  }, [controller, phase, waitUntil]);

  const openSourceAction = useAction(async () => {
    // One jump at a time: the page can take many seconds to load, and a second key press must not
    // open a second tab.
    if (!cardId || jumping.current) return;
    jumping.current = true;
    setJump(null);
    try {
      const ctx = await getCardSourceContext(cardId);
      setJump(
        await openSource(ctx, undefined, {
          onProgress: (message) => {
            // Only for the card that asked: the learner may have moved on while the tab loaded.
            if (latest.current.state.current?.card.id === cardId) setJumpNote(message);
          },
        }),
      );
    } finally {
      jumping.current = false;
      setJumpNote(null);
    }
  });

  // Keyboard: one listener for the whole session surface.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { state: s, editing: ed, keysOn: on } = latest.current;
      // WCAG 2.1.4: single keys can be turned off.
      if (!on) return;
      // Space and Enter press the control that has focus; they must not also reveal the card.
      if (
        (e.key === ' ' || e.key === 'Enter') &&
        e.target instanceof Element &&
        e.target.closest('button, a[href], summary, [role="button"], input')
      ) {
        return;
      }
      const action = keyAction(e, isFieldTarget(e.target), {
        phase: s.phase,
        choosing: s.current?.card.cardType === 'mcq' && s.current.choiceId === null,
        editing: ed,
        canUndo: s.lastAnswer !== null && !s.busy,
        choiceCount: s.current?.choices.length ?? 0,
      });
      if (!action) return;
      e.preventDefault();
      run(action);
    };
    const run = (action: KeyAction) => {
      const { state: s } = latest.current;
      if (s.busy && action.type !== 'reveal') return;
      switch (action.type) {
        case 'reveal':
          controller.reveal();
          break;
        case 'rate':
          void controller.rate(action.rating);
          break;
        case 'choose': {
          const choice = s.current?.choices[action.index];
          if (choice) controller.choose(choice.id);
          break;
        }
        case 'undo':
          void controller.undo();
          break;
        case 'edit':
          setEditing(true);
          break;
        case 'suspend':
          void controller.suspend();
          break;
        case 'bury':
          void controller.bury();
          break;
        case 'source':
          void openSourceAction.run();
          break;
        case 'explain':
          setExplaining((v) => !v);
          break;
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [controller, latest, openSourceAction]);

  // A new card takes focus (a rating button that had it is gone), so keyboard and screen-reader
  // users are never left on <body>.
  useEffect(() => {
    if (cardId) article.current?.focus({ preventScroll: true });
  }, [cardId]);

  const total = state.answered + state.remaining;
  // The XP of the answer just given is spoken with the next card, never as a message of its own.
  const xpNote = play && state.lastAnswer?.fresh ? `Plus ${XP.review} XP. ` : '';
  const announcement =
    phase === 'question'
      ? `${xpNote}Question ${state.answered + 1} of ${total}.`
      : phase === 'answer'
        ? 'Answer shown. Press 1 for Again, 2 for Hard, 3 for Good or 4 for Easy.'
        : '';
  const percent = total === 0 ? 0 : Math.round((state.answered / total) * 100);
  const mcq = current?.card.cardType === 'mcq';
  // Question-and-answer faces turn over; cloze and multiple choice change in place.
  const flips = current !== null && !mcq && current.card.cardType !== 'cloze';

  return (
    <main className="rv-session" data-testid={TID.session} aria-label="Review session">
      <header className="rv-top">
        <IconButton
          icon={X}
          label="Leave session"
          tipSide="right"
          data-testid={TID.leave}
          onClick={onLeave}
        />
        <div className="rv-pill" data-testid={TID.progress}>
          <span className="rv-pill__count" aria-hidden="true">
            {state.answered}/{total}
          </span>
          <BarMeter value={state.answered} max={Math.max(1, total)} label="Session progress" />
          <span className="sv-vh" data-testid={TID.progressText}>
            {state.answered} answered, {state.remaining} left ({percent}%)
          </span>
        </div>
        <div className="rv-top__stats">
          {play ? (
            <>
              <span className="rv-top__xp">
                <StatChip icon={Zap} tone="sun" value={play.today.xp} label="XP today" />
                {float.node}
              </span>
              <StatChip
                icon={Flame}
                tone="flame"
                value={play.streak.current}
                label="day streak"
                hideLabel
              />
            </>
          ) : null}
        </div>
      </header>

      {state.notice ? (
        <div data-testid={TID.notice}>
          <InlineNotice
            tone="info"
            live
            action={
              <Button variant="ghost" onClick={() => controller.dismissNotice()}>
                Dismiss
              </Button>
            }
          >
            {state.notice}
          </InlineNotice>
        </div>
      ) : null}
      {state.error ? (
        <InlineNotice
          tone="error"
          title="That did not work"
          action={
            phase === 'answer' && current ? (
              <span className="sv-small">Press the answer again to retry.</span>
            ) : undefined
          }
        >
          {state.error}
        </InlineNotice>
      ) : null}

      {phase === 'waiting' && state.waitUntil ? (
        <section className="rv-wait" data-testid={TID.waiting} aria-labelledby="rv-wait-h">
          <VaultBuddy pose="sleep" size={132} />
          <h2 id="rv-wait-h" className="rv-wait__title">
            Next card soon
          </h2>
          <p className="rv-wait__line">
            Back {untilLabel(state.waitUntil, nowMs)} ({formatWhen(state.waitUntil, timeZone)}). It
            shows by itself.
          </p>
          <div className="rv-wait__actions">
            <ChunkyButton
              variant="primary"
              data-testid={TID.waitNow}
              onClick={() => void controller.tick({ early: true })}
            >
              Show it now
            </ChunkyButton>
            <ChunkyButton onClick={onLeave}>Leave for now</ChunkyButton>
          </div>
        </section>
      ) : null}

      {current && (phase === 'question' || phase === 'answer') ? (
        <>
          <p className="sv-sr" role="status" aria-live="polite">
            {announcement}
          </p>
          <article
            ref={article}
            tabIndex={-1}
            className="rv-stage"
            data-testid={TID.card}
            aria-label="Card"
          >
            <div className="rv-card">
              <div className="rv-card__meta">
                <span className="rv-chip rv-chip--deck">
                  <Layers aria-hidden="true" strokeWidth={2.5} />
                  {current.deck.name}
                </span>
                <span className="rv-chip">{TYPE_LABEL[current.card.cardType]}</span>
                {/* Only "New" says something to the learner; learning/review states are scheduler terms. */}
                {current.card.fsrs.state === 'new' ? (
                  <span className="rv-chip rv-chip--info">New</span>
                ) : null}
                {current.card.createdBy === 'ai' ? (
                  <span className="rv-chip rv-chip--warning">AI-made</span>
                ) : null}
                {current.card.needsHumanVerification ? (
                  <span className="rv-chip rv-chip--warning" data-testid={TID.unverified}>
                    Needs your check
                  </span>
                ) : null}
              </div>
              {current.card.needsHumanVerification ? (
                <div className="rv-unverified">
                  <span className="sv-small">Not checked by you yet</span>
                  <InfoTip label="About unchecked cards" align="start">
                    The answer key and wording of this card have not been checked by you. Compare it
                    with the source before you rely on it.
                  </InfoTip>
                  <Button
                    data-testid={TID.verify}
                    busy={state.busy}
                    onClick={() => void controller.verify()}
                  >
                    I checked it
                  </Button>
                </div>
              ) : null}

              <div
                key={phase}
                className={`rv-card__face${flips && phase === 'answer' && !editing ? ' rv-flipin' : ''}`}
              >
                {editing ? (
                  <CardEditForm
                    key={current.card.id}
                    card={current.card}
                    busy={state.busy}
                    error={state.error}
                    onCancel={() => setEditing(false)}
                    onSave={async (patch) => {
                      const ok = await controller.edit(patch);
                      if (ok) setEditing(false);
                      return ok;
                    }}
                  />
                ) : (
                  <CardFace
                    card={current.card}
                    reveal={phase === 'answer'}
                    revealedBlanks={current.revealedBlanks}
                    onRevealBlank={(i) => controller.revealBlank(i)}
                    choices={current.choices}
                    choiceId={current.choiceId}
                    grade={current.grade}
                    onChoose={(id) => controller.choose(id)}
                  />
                )}
              </div>

              {phase === 'answer' && current.grade ? (
                <p
                  className={`rv-mcq-result rv-mcq-result--${current.grade.correct ? 'ok' : 'no'}`}
                  data-testid={TID.mcqResult}
                  role="status"
                >
                  {current.grade.correct ? (
                    <CircleCheck aria-hidden="true" strokeWidth={2.6} />
                  ) : (
                    <CircleX aria-hidden="true" strokeWidth={2.6} />
                  )}
                  {current.grade.correct
                    ? 'Correct. Good is suggested.'
                    : 'Not quite. Again is suggested.'}
                </p>
              ) : null}
              {phase === 'answer' && mcq && current.card.explanation ? (
                <div className="rv-explanation" data-testid={TID.mcqExplanation}>
                  <p className="sv-label">Why</p>
                  <p className="rv-prewrap">{current.card.explanation}</p>
                </div>
              ) : null}
            </div>

            <div className="rv-controls">
              {phase === 'question' && !editing ? (
                <div className="rv-show">
                  <ChunkyButton
                    variant="primary"
                    size="lg"
                    className="rv-show__btn"
                    data-testid={TID.reveal}
                    aria-keyshortcuts={keysOn ? 'Space' : undefined}
                    onClick={() => controller.reveal()}
                  >
                    Show answer
                  </ChunkyButton>
                  {keysOn ? (
                    <span className="rv-hint">
                      or <kbd className="sv-kbd">Space</kbd>
                      {mcq ? (
                        <>
                          {' '}
                          · pick <kbd className="sv-kbd">1</kbd>–
                          <kbd className="sv-kbd">{current.choices.length}</kbd>
                        </>
                      ) : null}
                    </span>
                  ) : null}
                </div>
              ) : null}

              {phase === 'answer' ? (
                <div
                  className="rv-ratings"
                  role="group"
                  aria-label="How well did you remember?"
                  data-testid={TID.ratings}
                >
                  {RATINGS.map((r) => {
                    const p = current.previews[r];
                    const Icon = RATING_ICON[r];
                    const suggested =
                      current.grade !== null && r === (current.grade.correct ? 3 : 1);
                    return (
                      <button
                        key={r}
                        type="button"
                        className={`rv-rating rv-rating--${r}`}
                        data-testid={ratingId(r)}
                        aria-disabled={state.busy || undefined}
                        aria-keyshortcuts={keysOn ? String(r) : undefined}
                        aria-label={`${RATING_LABELS[r]}, next review in ${p.label}. Key ${r}.`}
                        onClick={() => {
                          if (!state.busy) void controller.rate(r);
                        }}
                      >
                        <span className="rv-rating__main">
                          <Icon aria-hidden="true" strokeWidth={2.6} />
                          {RATING_LABELS[r]}
                        </span>
                        <span className="rv-rating__sub">
                          <span className="rv-rating__interval">{p.label}</span>
                          {keysOn ? <kbd className="rv-rating__key">{r}</kbd> : null}
                        </span>
                        {suggested ? <span className="rv-rating__suggest">Suggested</span> : null}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          </article>

          <div className="rv-tools" role="group" aria-label="Card actions">
            <ChunkyButton
              size="sm"
              variant="ghost"
              icon={Undo2}
              data-testid={TID.undo}
              aria-busy={state.busy || undefined}
              aria-keyshortcuts={keysOn ? 'Z' : undefined}
              disabledReason={state.lastAnswer ? undefined : 'Nothing to undo yet.'}
              onClick={() => void controller.undo()}
            >
              Undo
            </ChunkyButton>
            <ChunkyButton
              size="sm"
              variant="ghost"
              icon={Pencil}
              data-testid={TID.edit}
              aria-pressed={editing}
              aria-keyshortcuts={keysOn ? 'E' : undefined}
              onClick={() => setEditing((v) => !v)}
            >
              Edit
            </ChunkyButton>
            <ChunkyButton
              size="sm"
              variant="ghost"
              icon={Pause}
              data-testid={TID.suspend}
              aria-busy={state.busy || undefined}
              aria-keyshortcuts={keysOn ? 'S' : undefined}
              onClick={() => void controller.suspend()}
            >
              Suspend
            </ChunkyButton>
            <ChunkyButton
              size="sm"
              variant="ghost"
              icon={Sunrise}
              data-testid={TID.bury}
              aria-busy={state.busy || undefined}
              aria-keyshortcuts={keysOn ? 'B' : undefined}
              onClick={() => void controller.bury()}
            >
              Bury
            </ChunkyButton>
            <ChunkyButton
              size="sm"
              variant="ghost"
              icon={LocateFixed}
              data-testid={TID.source}
              aria-busy={openSourceAction.busy || undefined}
              aria-keyshortcuts={keysOn ? 'J' : undefined}
              disabledReason={
                current.card.highlightId
                  ? undefined
                  : 'This card has no source: it was typed in by hand.'
              }
              onClick={() => void openSourceAction.run()}
            >
              Source
            </ChunkyButton>
            <ChunkyButton
              size="sm"
              variant="ghost"
              icon={Lightbulb}
              data-testid={TID.explain}
              aria-pressed={phase === 'answer' ? explaining : undefined}
              aria-keyshortcuts={keysOn ? 'X' : undefined}
              disabledReason={
                phase === 'answer' ? undefined : 'Show the answer first to see the explanation.'
              }
              onClick={() => setExplaining((v) => !v)}
            >
              Explain
            </ChunkyButton>
            <span className="rv-tools__keys">
              <label className="sv-check">
                <input
                  type="checkbox"
                  role="switch"
                  className="sv-switch"
                  data-testid={TID.keysToggle}
                  checked={keysOn}
                  onChange={(e) => setKeys(e.target.checked)}
                />
                <span>Key shortcuts</span>
              </label>
              <InfoTip label="Keyboard shortcuts" align="end" side="top">
                Space shows the answer and 1 to 4 grade it. Z undo, E edit, S suspend, B bury, J
                source, X explain. Keys act only while this page has focus.
              </InfoTip>
            </span>
          </div>

          {state.lastAnswer ? (
            <p className="rv-last">
              Last: {RATING_LABELS[state.lastAnswer.rating]} on &ldquo;
              {truncate(state.lastAnswer.front, 60)}&rdquo;
            </p>
          ) : null}
          {openSourceAction.error ? (
            <InlineNotice tone="error">{openSourceAction.error}</InlineNotice>
          ) : null}
          {jumpNote ? (
            <InlineNotice tone="info" live>
              {jumpNote}
            </InlineNotice>
          ) : null}
          {jump ? (
            <InlineNotice
              tone={jump.ok && jump.scrolled ? 'success' : jump.ok ? 'info' : 'warning'}
              live
            >
              {jump.message}
            </InlineNotice>
          ) : null}

          {explaining && phase === 'answer' ? <ExplainSection card={current.card} /> : null}
        </>
      ) : null}

      {phase === 'loading' ? <p className="sv-muted">Loading cards…</p> : null}
    </main>
  );
}

function ExplainSection({ card }: { card: Card }) {
  const ctx = useAsync<CardSourceContext>(() => getCardSourceContext(card.id), [card.id]);
  if (ctx.error) {
    return (
      <InlineNotice tone="error" title="The explanation could not be loaded">
        {errorMessage(ctx.error)}
      </InlineNotice>
    );
  }
  if (!ctx.data) return <p className="sv-muted">Loading the source…</p>;
  return (
    <ExplainPanel
      context={ctx.data}
      explanation={card.cardType === 'mcq' ? undefined : card.explanation}
    />
  );
}
