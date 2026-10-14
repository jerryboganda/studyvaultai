import { uuidv7 } from 'uuidv7';
import {
  DEFAULT_LEARN_AHEAD_MS,
  RATING_LABELS,
  answerInSession,
  clozeSegments,
  gradeMcq,
  nextInSession,
  orderChoices,
  preview,
  undoInSession,
  type Card,
  type Choice,
  type Deck,
  type McqGrade,
  type PreviewOutcome,
  type Rating,
  type ReviewSession,
} from '@study';
import * as repo from '@storage';
import { cardVersion, type ResumedSession } from '@storage';
import { choiceRandom, summarizeSession, type SessionSummary } from './model';
import { errorMessage } from '../text';

/**
 * The review session as a small state machine with no React in it, so the whole flow (reveal,
 * grade, undo, learning steps, resume, concurrent edits) is testable against a real database.
 *
 * Rules it keeps:
 *  - a card is answered through `reviewCard` with an idempotency key and the card version the
 *    learner saw, so a double submit or a second window can never write a second answer;
 *  - the session (the order of cards still to show) is persisted after every change, and
 *    `resumeStudySession` reconciles it with the cards, so a reload neither repeats nor loses one;
 *  - what is shown as the next interval is `preview()` of the same card with the same settings.
 */

export type StudyPort = Pick<
  typeof repo,
  | 'startStudySession'
  | 'resumeStudySession'
  | 'saveStudySession'
  | 'completeStudySession'
  | 'getCard'
  | 'getDeck'
  | 'reviewCard'
  | 'undoLastReview'
  | 'updateCard'
  | 'setCardsSuspended'
  | 'buryCards'
  | 'listReviewLogs'
  | 'markCardVerified'
>;

export const defaultPort: StudyPort = {
  startStudySession: repo.startStudySession,
  resumeStudySession: repo.resumeStudySession,
  saveStudySession: repo.saveStudySession,
  completeStudySession: repo.completeStudySession,
  getCard: repo.getCard,
  getDeck: repo.getDeck,
  reviewCard: repo.reviewCard,
  undoLastReview: repo.undoLastReview,
  updateCard: repo.updateCard,
  setCardsSuspended: repo.setCardsSuspended,
  buryCards: repo.buryCards,
  listReviewLogs: repo.listReviewLogs,
  markCardVerified: repo.markCardVerified,
};

export type SessionPhase =
  'idle' | 'loading' | 'question' | 'answer' | 'waiting' | 'done' | 'error';

export interface CurrentCard {
  card: Card;
  deck: Deck;
  /** Real outcome of each button (`preview()` with the deck's settings and the study-day frame). */
  previews: Record<Rating, PreviewOutcome>;
  version: string;
  /** Idempotency key of the answer to this card: a retry reuses it. */
  logId: string;
  shownAt: number;
  from: 'learning' | 'pending';
  /** Multiple choice: options in display order (stable per repetition). */
  choices: Choice[];
  choiceId: string | null;
  grade: McqGrade | null;
  /** Cloze: deletion numbers the learner uncovered one by one. */
  revealedBlanks: number[];
}

export interface LastAnswer {
  cardId: string;
  logId: string;
  rating: Rating;
  leech: boolean;
  front: string;
}

export interface SessionState {
  phase: SessionPhase;
  session: ReviewSession | null;
  current: CurrentCard | null;
  /** Cards still to show (queue plus learning steps), counting the one on screen. */
  remaining: number;
  answered: number;
  waitUntil: string | null;
  lastAnswer: LastAnswer | null;
  summary: SessionSummary | null;
  /**
   * The session bonus (ADR-022) once the session is done: `awarded` now, `already` earlier (an
   * undo after the done screen keeps it), `no_answers` when nothing was answered. Null otherwise.
   */
  bonus: repo.CompleteSessionStatus | null;
  notice: string | null;
  error: string | null;
  busy: boolean;
}

export interface ControllerDeps {
  port?: StudyPort;
  /** Epoch ms; injected so tests control time. */
  now?: () => number;
  /** Learning steps due within this window are shown early instead of waited for. */
  learnAheadMs?: number;
  /** Queue preferences handed to a new session. */
  prefs?: repo.QueuePrefs;
  boundary?: repo.StudyClockOptions['boundary'];
}

const INITIAL: SessionState = {
  phase: 'idle',
  session: null,
  current: null,
  remaining: 0,
  answered: 0,
  waitUntil: null,
  lastAnswer: null,
  summary: null,
  bonus: null,
  notice: null,
  error: null,
  busy: false,
};

const UNDO_REFUSED: Record<string, string> = {
  missing: 'That card no longer exists.',
  no_review: 'There is nothing to undo for that card.',
  not_last_review: 'That answer cannot be undone any more: the card was changed since.',
  already_undone: 'That answer was already undone.',
  card_mismatch: 'That answer belongs to another card.',
};

const without = (s: ReviewSession, cardId: string): ReviewSession => ({
  ...s,
  pending: s.pending.filter((id) => id !== cardId),
  learning: s.learning.filter((l) => l.cardId !== cardId),
});

export class ReviewSessionController {
  private state: SessionState = INITIAL;
  private readonly listeners = new Set<() => void>();
  private readonly port: StudyPort;
  private readonly now: () => number;
  private learnAheadMs: number;
  private prefs: repo.QueuePrefs;
  private boundary: repo.StudyClockOptions['boundary'];
  private locked = false;
  private decks = new Map<string, Deck>();

  constructor(deps: ControllerDeps = {}) {
    this.port = deps.port ?? defaultPort;
    this.now = deps.now ?? Date.now;
    this.learnAheadMs = deps.learnAheadMs ?? DEFAULT_LEARN_AHEAD_MS;
    this.prefs = deps.prefs ?? {};
    this.boundary = deps.boundary;
  }

  // -- external-store contract ------------------------------------------------------------

  getState = (): SessionState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<SessionState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of [...this.listeners]) l();
  }

  /** Settings changed while the page is open: applies to the next card and the next session. */
  configure(deps: Pick<ControllerDeps, 'learnAheadMs' | 'prefs' | 'boundary'>): void {
    if (deps.learnAheadMs !== undefined) this.learnAheadMs = deps.learnAheadMs;
    if (deps.prefs) this.prefs = deps.prefs;
    if (deps.boundary) this.boundary = deps.boundary;
  }

  // -- lifecycle --------------------------------------------------------------------------

  /** Build today's queue for `deckIds` (null = every deck) and show the first card. */
  async start(deckIds: readonly string[] | null): Promise<void> {
    await this.guard('loading', async () => {
      const started = await this.port.startStudySession({
        now: this.now(),
        ...(this.boundary ? { boundary: this.boundary } : {}),
        ...this.prefs,
        deckIds: deckIds && deckIds.length > 0 ? deckIds : null,
      });
      this.set({ summary: null, bonus: null, lastAnswer: null, answered: 0, notice: null });
      await this.open(started.session);
    });
  }

  /** Continue the stored session after reconciling it with the cards as they are now. */
  async resume(): Promise<ResumedSession | null> {
    const found = await this.guard<ResumedSession | null>('loading', async () => {
      const resumed = await this.port.resumeStudySession({
        now: this.now(),
        ...(this.boundary ? { boundary: this.boundary } : {}),
      });
      if (!resumed) {
        this.set({ phase: 'idle', session: null, current: null });
        return null;
      }
      if (resumed.stale) {
        this.set({
          phase: 'idle',
          session: null,
          current: null,
          notice: 'That session was from an earlier study day, so it was closed. Start a new one.',
        });
        return resumed;
      }
      const dropped = resumed.dropped.length;
      this.set({
        summary: null,
        bonus: null,
        lastAnswer: null,
        notice:
          dropped > 0
            ? `${dropped} ${dropped === 1 ? 'card was' : 'cards were'} left out because ${
                dropped === 1 ? 'it was' : 'they were'
              } answered, changed or removed since.`
            : null,
      });
      await this.open(resumed.session);
      return resumed;
    });
    return found ?? null;
  }

  /** Leave the session; it is saved and can be continued. */
  leave(): void {
    this.set({ phase: 'idle', current: null, waitUntil: null, notice: null });
  }

  // -- the card on screen -----------------------------------------------------------------

  reveal(): void {
    const cur = this.state.current;
    if (!cur || this.state.phase !== 'question') return;
    this.set({ phase: 'answer', current: { ...cur } });
  }

  /** Cloze: uncover one deletion; the answer phase starts when every blank is uncovered. */
  revealBlank(index: number): void {
    const cur = this.state.current;
    if (!cur || this.state.phase !== 'question' || cur.card.cardType !== 'cloze') return;
    const revealedBlanks = cur.revealedBlanks.includes(index)
      ? cur.revealedBlanks
      : [...cur.revealedBlanks, index];
    const blanks = new Set(
      clozeSegments(cur.card, false).flatMap((s) => (s.kind === 'blank' ? [s.index] : [])),
    );
    const all = [...blanks].every((i) => revealedBlanks.includes(i));
    this.set({
      phase: all ? 'answer' : 'question',
      current: { ...cur, revealedBlanks },
    });
  }

  /** Multiple choice: mark an option; the key and the explanation appear. */
  choose(choiceId: string): void {
    const cur = this.state.current;
    if (!cur || this.state.phase !== 'question' || cur.card.cardType !== 'mcq') return;
    const grade = gradeMcq(cur.card, choiceId);
    if (!grade) return;
    this.set({ phase: 'answer', current: { ...cur, choiceId, grade } });
  }

  async rate(rating: Rating): Promise<void> {
    const cur = this.state.current;
    const session = this.state.session;
    if (!cur || !session || this.state.phase !== 'answer' || this.locked) return;
    this.locked = true;
    this.set({ busy: true, error: null });
    try {
      const outcome = await this.port.reviewCard(cur.card.id, rating, {
        now: this.now(),
        boundary: session.boundary,
        sessionId: session.id,
        durationMs: Math.max(0, this.now() - cur.shownAt),
        logId: cur.logId,
        expectedVersion: cur.version,
      });
      switch (outcome.status) {
        case 'reviewed':
        case 'duplicate': {
          const answered = outcome.card;
          const next = answered
            ? answerInSession(session, answered, { logId: outcome.log.id, rating })
            : without(session, cur.card.id);
          const leech = outcome.status === 'reviewed' && outcome.leech;
          this.setSession(next);
          const warning = await this.persist(next);
          this.set({
            lastAnswer: {
              cardId: cur.card.id,
              logId: outcome.log.id,
              rating,
              leech,
              front: cur.card.front,
            },
            notice: leech
              ? 'This card keeps being forgotten (a leech), so it was suspended. Rewrite it, or unsuspend it from the Cards view.'
              : outcome.status === 'duplicate'
                ? 'That answer was already recorded.'
                : warning,
          });
          break;
        }
        case 'stale': {
          // Another window answered, rescheduled or suspended it. Reconcile the whole session with
          // the cards as they are: a card answered elsewhere is dropped, never answered twice.
          const resumed = await this.port.resumeStudySession({
            now: this.now(),
            boundary: session.boundary,
          });
          const next = resumed && !resumed.stale ? resumed.session : without(session, cur.card.id);
          this.setSession(next);
          this.set({
            notice: 'This card was changed in another window, so its current state is used.',
          });
          break;
        }
        case 'unavailable': {
          const next = without(session, cur.card.id);
          this.setSession(next);
          const warning = await this.persist(next);
          this.set({
            notice: [
              outcome.reason === 'suspended'
                ? 'This card was suspended in another window and was skipped.'
                : 'This card is no longer available and was skipped.',
              warning,
            ]
              .filter(Boolean)
              .join(' '),
          });
          break;
        }
      }
      await this.advance();
    } catch (err) {
      this.set({ error: errorMessage(err, 'The answer could not be saved.') });
    } finally {
      this.locked = false;
      this.set({ busy: false });
    }
  }

  async undo(): Promise<void> {
    const last = this.state.lastAnswer;
    const session = this.state.session;
    if (!last || !session || this.locked) return;
    this.locked = true;
    this.set({ busy: true, error: null });
    try {
      const out = await this.port.undoLastReview(last.cardId, {
        now: this.now(),
        expectLogId: last.logId,
      });
      if (out.status === 'undone') {
        const next = undoInSession(session, out.card);
        this.setSession(next);
        const warning = await this.persist(next);
        this.set({
          lastAnswer: null,
          notice: [`Undid ${RATING_LABELS[last.rating]} on "${last.front}".`, warning]
            .filter(Boolean)
            .join(' '),
          summary: null,
          bonus: null,
          phase: 'question',
        });
        await this.presentCard(out.card, 'pending');
      } else {
        this.set({ lastAnswer: null, notice: UNDO_REFUSED[out.reason] ?? 'Could not undo.' });
      }
    } catch (err) {
      this.set({ error: errorMessage(err, 'Could not undo the last answer.') });
    } finally {
      this.locked = false;
      this.set({ busy: false });
    }
  }

  /** The learner checked the answer key and the wording: clears the "needs verification" flag. */
  async verify(): Promise<void> {
    const cur = this.state.current;
    if (!cur || this.locked) return;
    this.locked = true;
    this.set({ busy: true, error: null });
    try {
      const card = await this.port.markCardVerified(cur.card.id);
      const latest = this.state.current;
      if (latest && latest.card.id === card.id) {
        this.set({ current: { ...latest, card }, notice: 'Marked as checked by you.' });
      }
    } catch (err) {
      this.set({ error: errorMessage(err, 'Could not save that.') });
    } finally {
      this.locked = false;
      this.set({ busy: false });
    }
  }

  async suspend(): Promise<void> {
    await this.removeCurrent(async (card) => {
      await this.port.setCardsSuspended([card.id], true, this.now());
      return 'Card suspended. Unsuspend it from the Cards view.';
    });
  }

  async bury(): Promise<void> {
    await this.removeCurrent(async (card) => {
      await this.port.buryCards([card.id], {
        now: this.now(),
        ...(this.state.session ? { boundary: this.state.session.boundary } : {}),
      });
      return 'Card buried until the next study day.';
    });
  }

  /** Edit the card on screen in place; scheduling is untouched. */
  async edit(patch: repo.CardPatch): Promise<boolean> {
    const cur = this.state.current;
    if (!cur || this.locked) return false;
    this.locked = true;
    this.set({ busy: true, error: null });
    try {
      const card = await this.port.updateCard(cur.card.id, patch, this.now());
      const latest = this.state.current;
      if (latest && latest.card.id === card.id) {
        const choices =
          card.cardType === 'mcq' && card.choices
            ? orderChoices(card.choices, choiceRandom(card))
            : [];
        this.set({ current: { ...latest, card, choices }, notice: 'Card saved.' });
      }
      return true;
    } catch (err) {
      this.set({ error: errorMessage(err, 'The card could not be saved.') });
      return false;
    } finally {
      this.locked = false;
      this.set({ busy: false });
    }
  }

  /** The wait for a learning step is over (or the learner does not want to wait). */
  async tick(options: { early?: boolean } = {}): Promise<void> {
    if (this.state.phase !== 'waiting' || this.locked) return;
    this.locked = true;
    try {
      await this.advance(options.early === true);
    } catch (err) {
      this.set({ error: errorMessage(err) });
    } finally {
      this.locked = false;
    }
  }

  dismissNotice(): void {
    this.set({ notice: null });
  }

  // -- internals --------------------------------------------------------------------------

  private async guard<T = void>(phase: SessionPhase, fn: () => Promise<T>): Promise<T | undefined> {
    if (this.locked) return undefined;
    this.locked = true;
    this.set({ phase, busy: true, error: null });
    try {
      return await fn();
    } catch (err) {
      this.set({
        phase: 'error',
        error: errorMessage(err, 'The review session could not be loaded.'),
      });
      return undefined;
    } finally {
      this.locked = false;
      this.set({ busy: false });
    }
  }

  private setSession(next: ReviewSession): void {
    this.set({
      session: next,
      remaining: next.pending.length + next.learning.length,
      answered: next.answered,
    });
  }

  /**
   * Persist the session. The answers themselves are already committed, so a failure is only a
   * warning (returned, so the caller can show it with the notice it is about to set).
   */
  private async persist(session: ReviewSession): Promise<string | null> {
    try {
      await this.port.saveStudySession(session);
      return null;
    } catch (err) {
      return `Your place in the session could not be saved (${errorMessage(err)}). Answers are safe.`;
    }
  }

  private async open(session: ReviewSession): Promise<void> {
    this.setSession(session);
    await this.advance();
  }

  private async deckOf(card: Card): Promise<Deck | null> {
    const known = this.decks.get(card.deckId);
    if (known) return known;
    const deck = await this.port.getDeck(card.deckId);
    if (deck) this.decks.set(deck.id, deck);
    return deck;
  }

  /** Show the next card the session says is due, dropping ids that can no longer be studied. */
  private async advance(early = false): Promise<void> {
    let session = this.state.session;
    if (!session) return;
    // Bounded: every iteration either returns or removes one id from the session.
    for (let guard = 0; guard < 10_000; guard += 1) {
      const next = nextInSession(session, this.now(), early ? Infinity : this.learnAheadMs);
      if (next.kind === 'done') {
        await this.finish(session);
        return;
      }
      if (next.kind === 'wait') {
        this.set({ phase: 'waiting', current: null, waitUntil: next.until });
        return;
      }
      const card = await this.port.getCard(next.cardId);
      const deck = card ? await this.deckOf(card) : null;
      if (!card || card.suspended || !deck) {
        session = without(session, next.cardId);
        this.setSession(session);
        const warning = await this.persist(session);
        if (warning) this.set({ notice: warning });
        continue;
      }
      await this.presentCard(card, next.from, deck);
      return;
    }
  }

  private async presentCard(
    card: Card,
    from: 'learning' | 'pending',
    knownDeck?: Deck,
  ): Promise<void> {
    const session = this.state.session;
    const deck = knownDeck ?? (await this.deckOf(card));
    if (!session || !deck) return;
    const nowMs = this.now();
    const choices =
      card.cardType === 'mcq' && card.choices ? orderChoices(card.choices, choiceRandom(card)) : [];
    this.set({
      phase: 'question',
      waitUntil: null,
      current: {
        card,
        deck,
        previews: preview(card, nowMs, deck.settings, { boundary: session.boundary }),
        version: cardVersion(card),
        logId: uuidv7(),
        shownAt: nowMs,
        from,
        choices,
        choiceId: null,
        grade: null,
        revealedBlanks: [],
      },
    });
  }

  /** Clears the stored session and records its bonus (once per session) in one transaction. */
  private async finish(session: ReviewSession): Promise<void> {
    const { status } = await this.port.completeStudySession(session.id, { now: this.now() });
    const logs = await this.port.listReviewLogs({ since: session.startedAt });
    this.set({
      phase: 'done',
      current: null,
      waitUntil: null,
      summary: summarizeSession(logs, session.id),
      bonus: status,
    });
  }

  private async removeCurrent(action: (card: Card) => Promise<string>): Promise<void> {
    const cur = this.state.current;
    const session = this.state.session;
    if (!cur || !session || this.locked) return;
    this.locked = true;
    this.set({ busy: true, error: null });
    try {
      const notice = await action(cur.card);
      const next = without(session, cur.card.id);
      this.setSession(next);
      const warning = await this.persist(next);
      await this.advance();
      this.set({ notice: [notice, warning].filter(Boolean).join(' ') });
    } catch (err) {
      this.set({ error: errorMessage(err) });
    } finally {
      this.locked = false;
      this.set({ busy: false });
    }
  }
}
