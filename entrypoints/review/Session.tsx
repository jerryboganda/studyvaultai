import { useEffect, useRef, useState } from 'react';
import { RATINGS, RATING_LABELS, type Card, type Rating } from '@study';
import { getCardSourceContext, type CardSourceContext } from '@storage';
import {
  Badge,
  Button,
  InlineNotice,
  Kbd,
  errorMessage,
  truncate,
  useAction,
  useAsync,
  useLatest,
} from '@ui';
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
  basic: 'Question and answer',
  cloze: 'Fill in the blank',
  definition: 'Definition',
  compare: 'Compare',
  mcq: 'Multiple choice',
} as const;

const STATE_LABEL = {
  new: 'New',
  learning: 'Learning',
  review: 'Review',
  relearning: 'Relearning',
} as const;

/** Per-viewer convenience (localStorage): whether the single-key shortcuts act (WCAG 2.1.4). */
const KEYS_PREF = 'sv.review.keys';
function readKeysPref(): boolean {
  try {
    return window.localStorage.getItem(KEYS_PREF) !== 'off';
  } catch {
    return true;
  }
}

const RATING_HINT: Record<Rating, string> = {
  1: 'Forgot it',
  2: 'Hard to recall',
  3: 'Recalled',
  4: 'Easy',
};

export function Session({
  state,
  controller,
  timeZone,
  onLeave,
}: {
  state: SessionState;
  controller: ReviewSessionController;
  timeZone: string;
  onLeave(): void;
}) {
  const { current, phase } = state;
  const [editing, setEditing] = useState(false);
  const [explaining, setExplaining] = useState(false);
  const [jump, setJump] = useState<JumpResult | null>(null);
  const cardId = current?.card.id ?? null;
  const [lastCardId, setLastCardId] = useState<string | null>(null);

  // A new card starts with the editor and explanation closed (state reset during render, not in an
  // effect: React re-renders immediately with the new values).
  if (cardId !== lastCardId) {
    setLastCardId(cardId);
    setEditing(false);
    setExplaining(false);
    setJump(null);
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
    if (!cardId) return;
    const ctx = await getCardSourceContext(cardId);
    setJump(await openSource(ctx));
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
        e.target.closest('button, a[href], summary, [role="button"]')
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
  const announcement =
    phase === 'question'
      ? `Question ${state.answered + 1} of ${total}.`
      : phase === 'answer'
        ? 'Answer shown. Press 1 for Again, 2 for Hard, 3 for Good or 4 for Easy.'
        : '';
  const percent = total === 0 ? 0 : Math.round((state.answered / total) * 100);

  return (
    <main className="rv-session" data-testid={TID.session} aria-label="Review session">
      <header className="rv-session__head">
        <div className="rv-session__progress">
          <progress
            data-testid={TID.progress}
            value={state.answered}
            max={Math.max(1, total)}
            aria-label="Session progress"
          />
          <span className="sv-small" data-testid={TID.progressText}>
            {state.answered} answered, {state.remaining} left ({percent}%)
          </span>
        </div>
        <Button
          variant="ghost"
          data-testid={TID.leave}
          onClick={onLeave}
          title="Your place is saved. Continue later from the deck list."
        >
          Leave session
        </Button>
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
        <section className="rv-card rv-waiting" data-testid={TID.waiting}>
          <h2>Nothing is due this minute</h2>
          <p>
            The next learning step comes back {untilLabel(state.waitUntil, nowMs)} (
            {formatWhen(state.waitUntil, timeZone)}). This page shows it automatically.
          </p>
          <div className="sv-row">
            <Button
              variant="primary"
              data-testid={TID.waitNow}
              onClick={() => void controller.tick({ early: true })}
            >
              Show it now
            </Button>
            <Button onClick={onLeave}>Leave and come back later</Button>
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
            className="rv-card"
            data-testid={TID.card}
            aria-label="Card"
          >
            <div className="sv-row rv-card__meta">
              <Badge>{current.deck.name}</Badge>
              <Badge>{TYPE_LABEL[current.card.cardType]}</Badge>
              <Badge tone={current.card.fsrs.state === 'new' ? 'info' : 'neutral'}>
                {STATE_LABEL[current.card.fsrs.state]}
              </Badge>
              {current.card.createdBy === 'ai' ? <Badge tone="warning">AI-made</Badge> : null}
              {current.card.needsHumanVerification ? (
                <span data-testid={TID.unverified}>
                  <Badge tone="warning">Needs your check</Badge>
                </span>
              ) : null}
            </div>
            {current.card.needsHumanVerification ? (
              <div className="rv-unverified">
                <p className="sv-small">
                  The answer key and wording of this card have not been checked by you. It may be
                  wrong; compare it with the source before you rely on it.
                </p>
                <Button
                  data-testid={TID.verify}
                  busy={state.busy}
                  onClick={() => void controller.verify()}
                >
                  I checked this card
                </Button>
              </div>
            ) : null}

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

            {phase === 'answer' && current.grade ? (
              <p className="rv-mcq-result" data-testid={TID.mcqResult} role="status">
                {current.grade.correct
                  ? '✓ Correct. Good is suggested.'
                  : '✕ Not quite. Again is suggested.'}
              </p>
            ) : null}
            {phase === 'answer' && current.card.cardType === 'mcq' && current.card.explanation ? (
              <div className="rv-explanation" data-testid={TID.mcqExplanation}>
                <p className="sv-label">Why</p>
                <p className="rv-face--small">{current.card.explanation}</p>
              </div>
            ) : null}

            {phase === 'question' && !editing ? (
              <div className="sv-row">
                <Button
                  variant="primary"
                  data-testid={TID.reveal}
                  onClick={() => controller.reveal()}
                >
                  {current.card.cardType === 'mcq'
                    ? 'Show the answer without choosing'
                    : 'Show answer'}{' '}
                  <Kbd shortcut="Space" />
                </Button>
                {current.card.cardType === 'mcq' ? (
                  <span className="sv-small sv-muted">
                    or press 1 to {current.choices.length} to pick an option
                  </span>
                ) : null}
              </div>
            ) : null}
          </article>

          {phase === 'answer' ? (
            <section aria-label="How well did you remember?">
              <div className="rv-ratings" data-testid={TID.ratings}>
                {RATINGS.map((r) => {
                  const p = current.previews[r];
                  const suggested = current.grade !== null && r === (current.grade.correct ? 3 : 1);
                  return (
                    <button
                      key={r}
                      type="button"
                      className={`rv-rating rv-rating--${r}`}
                      data-testid={ratingId(r)}
                      aria-disabled={state.busy || undefined}
                      aria-label={`${RATING_LABELS[r]}, next review in ${p.label}. Key ${r}.`}
                      onClick={() => {
                        if (!state.busy) void controller.rate(r);
                      }}
                    >
                      <span className="rv-rating__label">{RATING_LABELS[r]}</span>
                      <span className="rv-rating__interval">{p.label}</span>
                      <span className="rv-rating__hint">
                        {RATING_HINT[r]} <kbd className="sv-kbd">{r}</kbd>
                      </span>
                      {suggested ? <span className="rv-rating__suggest">Suggested</span> : null}
                    </button>
                  );
                })}
              </div>
            </section>
          ) : null}

          <div className="rv-tools sv-row" role="group" aria-label="Card actions">
            <Button
              data-testid={TID.undo}
              busy={state.busy}
              disabledReason={state.lastAnswer ? undefined : 'Nothing to undo yet.'}
              onClick={() => void controller.undo()}
            >
              Undo <Kbd shortcut="Z" />
            </Button>
            <Button data-testid={TID.edit} onClick={() => setEditing((v) => !v)}>
              {editing ? 'Close editor' : 'Edit'} <Kbd shortcut="E" />
            </Button>
            <Button
              data-testid={TID.suspend}
              busy={state.busy}
              onClick={() => void controller.suspend()}
            >
              Suspend <Kbd shortcut="S" />
            </Button>
            <Button data-testid={TID.bury} busy={state.busy} onClick={() => void controller.bury()}>
              Bury until tomorrow <Kbd shortcut="B" />
            </Button>
            <Button
              data-testid={TID.source}
              busy={openSourceAction.busy}
              disabledReason={
                current.card.highlightId
                  ? undefined
                  : 'This card has no source: it was typed in by hand.'
              }
              onClick={() => void openSourceAction.run()}
            >
              Jump to source <Kbd shortcut="J" />
            </Button>
            <Button
              data-testid={TID.explain}
              disabledReason={
                phase === 'answer' ? undefined : 'Show the answer first to see the explanation.'
              }
              onClick={() => setExplaining((v) => !v)}
            >
              {explaining ? 'Hide explanation' : 'Explain answer'} <Kbd shortcut="X" />
            </Button>
          </div>

          {state.lastAnswer ? (
            <p className="sv-small sv-muted">
              Last answer: {RATING_LABELS[state.lastAnswer.rating]} on &ldquo;
              {truncate(state.lastAnswer.front, 60)}&rdquo;.
            </p>
          ) : null}
          {openSourceAction.error ? (
            <InlineNotice tone="error">{openSourceAction.error}</InlineNotice>
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

          {keysOn ? (
            <p className="sv-small sv-muted rv-keys" aria-label="Keyboard shortcuts">
              Keys: <Kbd shortcut="Space" /> show answer, <kbd className="sv-kbd">1</kbd>{' '}
              <kbd className="sv-kbd">2</kbd> <kbd className="sv-kbd">3</kbd>{' '}
              <kbd className="sv-kbd">4</kbd> grade, <Kbd shortcut="Z" /> undo, <Kbd shortcut="E" />{' '}
              edit, <Kbd shortcut="X" /> explain, <Kbd shortcut="J" /> source.
            </p>
          ) : (
            <p className="sv-small sv-muted">
              Single-key shortcuts are off. Every action above is a button.
            </p>
          )}
          <div>
            <Button variant="ghost" data-testid={TID.keysToggle} onClick={() => setKeys(!keysOn)}>
              {keysOn ? 'Turn single-key shortcuts off' : 'Turn single-key shortcuts on'}
            </Button>
          </div>
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
