import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configure, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { browser } from 'wxt/browser';
import { preview } from '@study';
import {
  closeDb,
  createDeck,
  createManualCards,
  getCard,
  listReviewLogs,
  loadStudySession,
  setGameMode,
  type TemplateInput,
} from '@storage';
import { freshDatabase } from '@storage/test-vault';
import { STUDY_SETTINGS_KEY, TID, ratingId, defaultStudySettings, deckStartId } from '@ui/review';
import { Review } from './Review';

const basic = (n: number): TemplateInput => ({
  template: 'basic',
  question: `Question ${n}?`,
  answer: `Answer ${n}`,
  explanation: `Because ${n}.`,
});

/** UTC with no rollover keeps "today" simple for cards created a moment ago. */
const settings = { ...defaultStudySettings(), timeZone: 'UTC', rolloverHour: 0 };

async function seed(n: number, deckSettings: Record<string, unknown> = {}) {
  const deck = await createDeck({ name: 'Cardiology', settings: deckSettings });
  const cards = await createManualCards(
    Array.from({ length: n }, (_, i) => basic(i + 1)),
    { deckId: deck.id },
  );
  return { deck, cards };
}

vi.setConfig({ testTimeout: 60_000 });
// Several agents and CI shards share the CPU: waiting for the page is not a failure.
configure({ asyncUtilTimeout: 10_000 });

beforeEach(async () => {
  await freshDatabase();
  await browser.storage.local.set({ [STUDY_SETTINGS_KEY]: settings });
  window.history.replaceState(null, '', '/review.html');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(cleanup);

const question = () => within(screen.getByTestId(TID.card)).getByTestId(TID.question).textContent;
/** Why a control is unavailable: the tooltip it points at (aria-describedby). */
const reason = (el: HTMLElement) =>
  document.getElementById(el.getAttribute('aria-describedby') ?? '')?.textContent ?? null;

async function startAll(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByTestId(TID.deckStartAll));
  await screen.findByTestId(TID.card);
}

describe('review page: deck picker', () => {
  it('says there is nothing yet instead of showing empty decks', async () => {
    const user = userEvent.setup();
    render(<Review />);
    const empty = await screen.findByTestId(TID.deckEmpty);
    expect(within(empty).getByRole('heading', { name: 'No cards yet' })).toBeTruthy();
    // No start button and no zero counts: the one action is making cards.
    expect(screen.queryByTestId(TID.deckStartAll)).toBeNull();
    expect(screen.queryByTestId(TID.dueTotal)).toBeNull();
    await user.click(within(empty).getByRole('button', { name: 'Create cards' }));
    expect(screen.getByRole('tab', { name: 'Create' }).getAttribute('aria-selected')).toBe('true');
  });

  it('with nothing due, start says why it cannot act', async () => {
    const user = userEvent.setup();
    await seed(1);
    render(<Review />);
    await startAll(user);
    await user.keyboard(' ');
    await user.keyboard('4');
    // The done screen waits for the session to close (a busy CI box can be slow).
    const summary = await screen.findByTestId(TID.summary, {}, { timeout: 20_000 });
    await user.click(within(summary).getByRole('button', { name: 'Back to decks' }));
    const start = await screen.findByTestId(TID.deckStartAll, {}, { timeout: 20_000 });
    expect(start.getAttribute('aria-disabled')).toBe('true');
    expect(reason(start)).toBe('Nothing is due right now.');
    expect(screen.getByText('Nothing is due right now.', { selector: 'p' })).toBeTruthy();
  });

  it('shows real counts per deck and reports cards beyond the daily limit', async () => {
    const { deck } = await seed(3, { newPerDay: 2 });
    render(<Review />);
    expect((await screen.findByTestId(TID.dueTotal)).textContent).toBe('2');
    expect(screen.getByTestId(TID.dueNew).textContent).toBe('2 new cards');
    expect(screen.getByTestId(TID.deferredNote).textContent).toMatch(/1 more card/);
    expect(screen.getByTestId(deckStartId(deck.id)).textContent).toBe('Study (2)');
  });
});

describe('review page: the session', () => {
  it('shows real intervals, grades with the keyboard, and undoes with Z', async () => {
    const user = userEvent.setup();
    const { deck, cards } = await seed(2);
    render(<Review />);
    await startAll(user);

    const first = question()!;
    expect(first).toMatch(/Question \d\?/);
    expect(screen.queryByTestId(TID.ratings)).toBeNull();

    await user.keyboard(' ');
    const ratings = await screen.findByTestId(TID.ratings);
    // The button text is the engine's own preview for this card.
    const card = cards.find((c) => c.front === first)!;
    const expected = preview(card, Date.now(), deck.settings, {
      boundary: { timeZone: 'UTC', rolloverHour: 0 },
    });
    for (const r of [1, 2, 3, 4] as const) {
      const button = within(ratings).getByTestId(ratingId(r));
      expect(button.textContent).toContain(expected[r].label);
    }
    expect(screen.getByTestId(TID.answer).textContent).toBe(card.back);

    await user.keyboard('3');
    await waitFor(() => expect(question()).not.toBe(first));
    expect(await listReviewLogs()).toHaveLength(1);
    expect((await getCard(card.id))!.fsrs.reps).toBe(1);
    expect(screen.getByTestId(TID.progressText).textContent).toMatch(/1 answered, 2 left/);

    await user.keyboard('z');
    await waitFor(() => expect(question()).toBe(first));
    expect(screen.getByTestId(TID.notice).textContent).toMatch(/Undid Good/);
    expect(await listReviewLogs()).toHaveLength(0);
    expect((await getCard(card.id))!.fsrs).toEqual(card.fsrs);
  });

  it('finishes with a summary, and every control reports why it is unavailable', async () => {
    const user = userEvent.setup();
    await seed(1);
    render(<Review />);
    await startAll(user);

    const undo = screen.getByTestId(TID.undo);
    expect(undo.getAttribute('aria-disabled')).toBe('true');
    expect(reason(undo)).toBe('Nothing to undo yet.');
    expect(reason(screen.getByTestId(TID.explain))).toMatch(/Show the answer first/);
    expect(reason(screen.getByTestId(TID.source))).toMatch(/no source/);

    await user.click(screen.getByTestId(TID.reveal));
    await user.click(screen.getByTestId(ratingId(4)));
    const summary = await screen.findByTestId(TID.summary, {}, { timeout: 20_000 });
    expect(summary.textContent).toMatch(/Session complete/);
    expect(screen.getByTestId(TID.summaryAnswered).textContent).toMatch(/answered 1 card/);
  });

  it('explains the answer from the card and shows what the learner wrote', async () => {
    const user = userEvent.setup();
    await seed(1);
    render(<Review />);
    await startAll(user);
    await user.keyboard(' ');
    await user.keyboard('x');
    const panel = await screen.findByTestId(TID.explainPanel);
    expect(panel.textContent).toContain('Because 1.');
    // A card typed by hand has no quote and says so instead of inventing one.
    expect(panel.textContent).toMatch(/not linked to a highlight/);
  });

  it('suspend removes the card from the session and the queue', async () => {
    const user = userEvent.setup();
    const { cards } = await seed(2);
    render(<Review />);
    await startAll(user);
    const first = question()!;
    await user.keyboard('s');
    await waitFor(() => expect(question()).not.toBe(first));
    const suspended = cards.find((c) => c.front === first)!;
    expect((await getCard(suspended.id))!.suspended).toBe(true);
    expect(screen.getByTestId(TID.progressText).textContent).toMatch(/0 answered, 1 left/);
  });

  it('edits a card in place with E and saves without touching the schedule', async () => {
    const user = userEvent.setup();
    const { cards } = await seed(1);
    render(<Review />);
    await startAll(user);
    await user.keyboard('e');
    const form = await screen.findByRole('form', { name: 'Edit card' });
    const front = within(form).getByLabelText('Front');
    await user.clear(front);
    await user.type(front, 'Sharper question?');
    await user.click(within(form).getByRole('button', { name: 'Save card' }));
    await waitFor(() => expect(question()).toBe('Sharper question?'));
    const stored = (await getCard(cards[0]!.id))!;
    expect(stored.front).toBe('Sharper question?');
    expect(stored.fsrs).toEqual(cards[0]!.fsrs);
  });

  it('resumes after a reload and never shows an answered card again', async () => {
    const user = userEvent.setup();
    const { cards } = await seed(3);
    const first = render(<Review />);
    await startAll(user);
    const answered = question()!;
    await user.keyboard(' ');
    await user.keyboard('3');
    await waitFor(() => expect(question()).not.toBe(answered));
    await waitFor(async () => expect(await loadStudySession()).not.toBeNull());

    // Reload: the page is gone, the connection is closed, a new page opens.
    first.unmount();
    closeDb();
    render(<Review />);
    const cont = await screen.findByTestId(TID.deckContinue);
    expect(cont.textContent).toMatch(/Continue \(\d left\)/);
    await user.click(cont);
    await screen.findByTestId(TID.card);
    // The answered card is a learning step ten minutes away: it is not offered again right now.
    expect(question()).not.toBe(answered);
    expect(screen.getByTestId(TID.progressText).textContent).toMatch(/1 answered, 3 left/);
    expect(await listReviewLogs()).toHaveLength(1);
    expect(cards).toHaveLength(3);
  });
});

describe('review page: navigation', () => {
  it('opens on the section named in the address and keeps the card author reachable', async () => {
    window.history.replaceState(null, '', '/review.html?view=analytics');
    render(<Review />);
    expect(await screen.findByTestId(TID.analyticsEmpty)).toBeTruthy();
    const nav = screen.getByRole('tablist', { name: 'Review sections' });
    expect(
      within(nav)
        .getAllByRole('tab')
        .map((t) => t.textContent),
    ).toEqual(['Study', 'Exam', 'Create', 'Cards', 'Stats', 'Settings']);
  });
});

describe('review page: keyboard rules', () => {
  beforeEach(() => window.localStorage.removeItem('sv.review.keys'));

  it('Enter on a focused button presses that button instead of revealing the card', async () => {
    const user = userEvent.setup();
    await seed(1);
    render(<Review />);
    await startAll(user);

    screen.getByTestId(TID.edit).focus();
    await user.keyboard('{Enter}');
    // The editor opened (the button's own action) and the answer stayed hidden.
    expect(await screen.findByRole('form', { name: 'Edit card' })).toBeTruthy();
    expect(screen.queryByTestId(TID.ratings)).toBeNull();
  });

  it('single-key shortcuts can be turned off, and stay off (WCAG 2.1.4)', async () => {
    const user = userEvent.setup();
    await seed(1);
    const first = render(<Review />);
    await startAll(user);

    const toggle = () => screen.getByRole('switch', { name: 'Key shortcuts' }) as HTMLInputElement;
    expect(toggle().getAttribute('data-testid')).toBe(TID.keysToggle);
    await user.click(toggle());
    expect(window.localStorage.getItem('sv.review.keys')).toBe('off');
    expect(toggle().checked).toBe(false);
    // The key hints go with the keys.
    expect(screen.queryByText('Space', { selector: 'kbd' })).toBeNull();

    // The card does not react to keys any more; the buttons still do everything.
    screen.getByTestId(TID.card).focus();
    await user.keyboard(' ');
    expect(screen.queryByTestId(TID.ratings)).toBeNull();
    await user.click(screen.getByTestId(TID.reveal));
    expect(await screen.findByTestId(TID.ratings)).toBeTruthy();
    await user.keyboard('4');
    expect(screen.getByTestId(TID.ratings)).toBeTruthy();
    expect(await listReviewLogs()).toHaveLength(0);

    // A later visit starts with the keys off, and they can be turned back on.
    first.unmount();
    closeDb();
    render(<Review />);
    await user.click(await screen.findByTestId(TID.deckContinue));
    await screen.findByTestId(TID.card);
    expect(toggle().checked).toBe(false);
    await user.click(toggle());
    expect(window.localStorage.getItem('sv.review.keys')).toBe('on');
    screen.getByTestId(TID.card).focus();
    await user.keyboard(' ');
    expect(await screen.findByTestId(TID.ratings)).toBeTruthy();
  });
});

describe('review page: game layer', () => {
  it('shows XP, a +1 float per answer and the session XP with its bonus (Game mode on)', async () => {
    const user = userEvent.setup();
    await seed(2);
    render(<Review />);
    await startAll(user);
    // The ledger is ready: today's XP sits in the session bar.
    await screen.findByText('XP today', {}, { timeout: 30_000 });
    await user.keyboard(' ');
    await user.keyboard('4');
    await waitFor(() => expect(document.querySelector('.sv-xpfloat')?.textContent).toBe('+1 XP'));
    // The XP is spoken with the next card, not as a message of its own.
    expect(await screen.findByText(/^Plus 1 XP\. Question 2 of 2\.$/)).toBeTruthy();
    await user.keyboard(' ');
    await user.keyboard('4');
    const summary = await screen.findByTestId(TID.summary, {}, { timeout: 20_000 });
    // Two answers and the session bonus.
    expect(await within(summary).findByText('+7 XP', {}, { timeout: 15_000 })).toBeTruthy();
    expect(within(summary).getByText(/5 bonus/)).toBeTruthy();
    expect(within(summary).getByRole('img', { name: /^Daily goal: \d+ of 30 XP/ })).toBeTruthy();
    expect(document.activeElement).toBe(within(summary).getByRole('heading', { level: 2 }));
  });

  it('hides every game number when Game mode is off, and keeps the plain facts', async () => {
    const user = userEvent.setup();
    await setGameMode(false);
    await seed(1);
    render(<Review />);
    await startAll(user);
    await user.keyboard(' ');
    await user.keyboard('4');
    const summary = await screen.findByTestId(TID.summary, {}, { timeout: 20_000 });
    expect(within(summary).getByText('Answered')).toBeTruthy();
    expect(within(summary).queryByText(/XP/)).toBeNull();
    expect(within(summary).queryByRole('img', { name: /Daily goal/ })).toBeNull();
    expect(screen.queryByText('XP today')).toBeNull();
    expect(screen.queryByTestId('sv-confetti')).toBeNull();
  });
});
