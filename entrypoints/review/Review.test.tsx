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

vi.setConfig({ testTimeout: 30_000 });
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

async function startAll(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByTestId(TID.deckStartAll));
  await screen.findByTestId(TID.card);
}

describe('review page: deck picker', () => {
  it('says there is nothing yet instead of showing empty decks', async () => {
    render(<Review />);
    expect(await screen.findByTestId(TID.deckEmpty)).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Study everything due' }).getAttribute('aria-disabled'),
    ).toBe('true');
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
    expect(undo.getAttribute('title')).toBe('Nothing to undo yet.');
    expect(screen.getByTestId(TID.explain).getAttribute('title')).toMatch(/Show the answer first/);
    expect(screen.getByTestId(TID.source).getAttribute('title')).toMatch(/no source/);

    await user.click(screen.getByTestId(TID.reveal));
    await user.click(screen.getByTestId(ratingId(4)));
    const summary = await screen.findByTestId(TID.summary);
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
    ).toEqual(['Study', 'Create cards', 'Cards', 'Analytics', 'Settings']);
  });
});
