import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  configure,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { makeCard } from '@study/testUtils';
import {
  createDeck,
  createManualCards,
  getCard,
  getDb,
  reviewCard,
  type TemplateInput,
} from '@storage';
import { freshDatabase } from '@storage/test-vault';
import { ToastProvider } from '@ui';
import { TID, cardRowId, defaultStudySettings } from '@ui/review';
import { Analytics } from './Analytics';
import { BacklogRecovery } from './Backlog';
import { CardBrowser } from './CardBrowser';

const DAY = 86_400_000;
const settings = { ...defaultStudySettings(), timeZone: 'UTC', rolloverHour: 0 };
const boundary = { timeZone: 'UTC', rolloverHour: 0 };

const basic = (n: number): TemplateInput => ({
  template: 'basic',
  question: `Question ${n}?`,
  answer: `Answer ${n}`,
});

vi.setConfig({ testTimeout: 30_000 });
// Several agents and CI shards share the CPU: waiting for the page is not a failure.
configure({ asyncUtilTimeout: 10_000 });

beforeEach(async () => {
  await freshDatabase();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(cleanup);

describe('analytics', () => {
  it('shows an honest empty state before there are cards or reviews', async () => {
    render(<Analytics settings={settings} />);
    expect(await screen.findByTestId(TID.analyticsEmpty)).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('with cards but no reviews: forecast from real due dates, retention says not enough data', async () => {
    const deck = await createDeck({ name: 'Cardiology' });
    await createManualCards([basic(1), basic(2)], { deckId: deck.id });
    const now = Date.now();
    await getDb().cards.put(
      makeCard('card-future-001', {
        deckId: deck.id,
        state: 'review',
        due: new Date(now + 3 * DAY).toISOString(),
        lastReview: new Date(now - 4 * DAY).toISOString(),
        stability: 9,
      }),
    );
    render(<Analytics settings={settings} />);
    await screen.findByTestId(TID.forecast);

    const chart = within(screen.getByTestId(TID.forecast)).getByRole('img');
    expect(chart.getAttribute('aria-labelledby')).toBeTruthy();
    expect(chart.textContent).toMatch(/1 cards come due in the next 30 days/);
    // Every chart has its data as a table.
    const table = screen.getByTestId(TID.forecastTable);
    expect(within(table).getAllByRole('row')).toHaveLength(31);
    expect(within(table).getByText(/^Today, /)).toBeTruthy();

    expect(screen.getByTestId(TID.retentionInsufficient).textContent).toMatch(
      /Needs 20 reviews of learned cards; you have 0/,
    );
    // No ring and no percentage while there is not enough data.
    expect(within(screen.getByTestId(TID.retention)).queryByRole('img')).toBeNull();
    expect(screen.getByTestId(TID.studyLog).textContent).toMatch(/No reviews in the last 30 days/);
    expect(screen.getByTestId(TID.streak).textContent).toMatch(/^0/);
    // 2 new cards, 1 review card.
    const counts = screen.getByTestId(TID.counts);
    // The bar names the whole mix; the table behind "Show as table" has the same numbers.
    expect(
      within(counts).getByRole('img', {
        name: 'Cardiology: 3 cards, 2 new, 0 learning, 1 review, 0 suspended',
      }),
    ).toBeTruthy();
    const countsTable = within(counts).getByRole('table');
    expect(within(countsTable).getByText('Cardiology').closest('tr')!.textContent).toMatch(
      /Cardiology3201/,
    );
  });

  it('with enough reviews: true retention with its sample size, rating shares, daily log', async () => {
    const deck = await createDeck({ name: 'Heart' });
    const start = Date.now() - 40 * DAY;
    await getDb().cards.put(
      makeCard('card-mature-001', {
        deckId: deck.id,
        state: 'review',
        due: new Date(start).toISOString(),
        lastReview: new Date(start - 5 * DAY).toISOString(),
        stability: 30,
      }),
    );
    for (let i = 0; i < 22; i += 1) {
      const out = await reviewCard('card-mature-001', i === 5 ? 1 : 3, {
        now: start + i * DAY,
        boundary,
        durationMs: 4000,
      });
      expect(out.status).toBe('reviewed');
    }
    render(<Analytics settings={settings} />);
    const retention = await screen.findByTestId(TID.retention);
    await waitFor(() =>
      expect(retention.textContent).toMatch(/reviews of learned cards were remembered/),
    );
    // 22 answers; the one right after the lapse is a relearning step, not a mature review.
    expect(retention.textContent).toMatch(/95\.2%\s*of 21 reviews/);
    // The ring is named with its number, so the picture is never the only carrier.
    expect(within(retention).getByRole('img').getAttribute('aria-label')).toBe(
      'Retention: 95.2 of 100 %',
    );
    expect(screen.queryByTestId(TID.retentionInsufficient)).toBeNull();
    expect(within(retention).getByText(/Again/)).toBeTruthy();
    // The study log has 30 daily rows and counts only the days that had reviews.
    const log = screen.getByTestId(TID.studyLog);
    expect(log.textContent).toMatch(/reviews on \d+ of the last 30 study days/);
  });
});

describe('backlog recovery', () => {
  it('previews what moves, applies it after confirmation, and leaves memory state alone', async () => {
    const user = userEvent.setup();
    const deck = await createDeck({ name: 'Late', settings: { reviewsPerDay: 2 } });
    const now = Date.now();
    const rows = Array.from({ length: 5 }, (_, i) =>
      makeCard(`card-late-${String(i).padStart(4, '0')}`, {
        deckId: deck.id,
        state: 'review',
        due: new Date(now - (10 + i) * DAY).toISOString(),
        lastReview: new Date(now - (20 + i) * DAY).toISOString(),
        stability: 12,
      }),
    );
    await getDb().cards.bulkPut(rows);

    render(
      <ToastProvider>
        <BacklogRecovery settings={settings} overdue={5} />
      </ToastProvider>,
    );
    const plan = await screen.findByTestId(TID.backlogPlan);
    expect(plan.textContent).toMatch(/2 overdue cards stay due today/);
    expect(plan.textContent).toMatch(/3 cards move to later days/);
    expect(screen.queryByTestId(TID.backlogResult)).toBeNull();
    // Previewing wrote nothing.
    expect((await getCard(rows[0]!.id))!.dueAt).toBe(rows[0]!.dueAt);

    await user.click(screen.getByTestId(TID.backlogApply));
    const dialog = await screen.findByRole('dialog', { hidden: true });
    expect(within(dialog).getByText(/memory strength is kept/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Move the cards' }));

    const result = await screen.findByTestId(TID.backlogResult);
    expect(result.textContent).toMatch(/Moved 3 cards/);
    const after = await Promise.all(rows.map((r) => getCard(r.id)));
    expect(after.filter((c) => c!.dueAt !== rows.find((r) => r.id === c!.id)!.dueAt)).toHaveLength(
      3,
    );
    expect(after.every((c) => c!.fsrs.stability === 12)).toBe(true);
  });

  it('rejects a nonsense budget with a reason and computes no plan', async () => {
    const user = userEvent.setup();
    await createDeck({ name: 'Any' });
    render(
      <ToastProvider>
        <BacklogRecovery settings={settings} overdue={1} />
      </ToastProvider>,
    );
    await user.type(screen.getByLabelText('Daily cap per deck'), '0');
    expect(await screen.findByText(/whole number between 1 and 9999/)).toBeTruthy();
    expect(screen.queryByTestId(TID.backlogPlan)).toBeNull();
  });

  it('spreads over the days the slider names', async () => {
    await createDeck({ name: 'Any' });
    render(
      <ToastProvider>
        <BacklogRecovery settings={settings} overdue={1} />
      </ToastProvider>,
    );
    const days = screen.getByTestId(TID.backlogDays);
    expect(days.getAttribute('aria-valuetext')).toBe('7 days, today included');
    fireEvent.change(days, { target: { value: '0' } });
    expect(days.getAttribute('aria-valuetext')).toBe('2 days, today included');
    expect(screen.getByLabelText(/^Spread over 2 days/)).toBe(days);
    fireEvent.change(days, { target: { value: '7' } });
    expect(days.getAttribute('aria-valuetext')).toBe('30 days, today included');
  });
});

describe('card browser', () => {
  const renderBrowser = () =>
    render(
      <ToastProvider>
        <CardBrowser settings={settings} />
      </ToastProvider>,
    );
  const chip = (name: string) =>
    within(screen.getByTestId(TID.browserFilter)).getByRole('button', { name });

  it('suspends and unsuspends, filters with chips, and deletes with an undo', async () => {
    const user = userEvent.setup();
    const deck = await createDeck({ name: 'Cardiology' });
    const [a, b] = await createManualCards([basic(1), basic(2)], { deckId: deck.id });
    renderBrowser();
    const rowA = await screen.findByTestId(cardRowId(a!.id));

    await user.click(within(rowA).getByRole('button', { name: 'Suspend' }));
    await waitFor(() => expect(within(rowA).getByText('Suspended')).toBeTruthy());
    expect((await getCard(a!.id))!.suspended).toBe(true);

    await user.click(chip('Suspended'));
    expect(chip('Suspended').getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(screen.queryByTestId(cardRowId(b!.id))).toBeNull());
    await user.click(
      within(screen.getByTestId(cardRowId(a!.id))).getByRole('button', { name: 'Unsuspend' }),
    );
    await waitFor(async () => expect((await getCard(a!.id))!.suspended).toBe(false));

    await user.click(chip('All cards'));
    const row = await screen.findByTestId(cardRowId(b!.id));
    await user.click(within(row).getByRole('button', { name: 'Delete' }));
    await waitFor(async () => expect(await getCard(b!.id)).toBeNull());
    expect(await screen.findByText(/Card deleted/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect(await getCard(b!.id)).not.toBeNull());
  });

  it('asks before resetting progress, and resets only after the yes', async () => {
    const user = userEvent.setup();
    const deck = await createDeck({ name: 'Cardiology' });
    const now = Date.now();
    await getDb().cards.put(
      makeCard('card-learned-01', {
        deckId: deck.id,
        state: 'review',
        due: new Date(now + 3 * DAY).toISOString(),
        lastReview: new Date(now - 4 * DAY).toISOString(),
        stability: 9,
      }),
    );
    renderBrowser();
    const row = await screen.findByTestId(cardRowId('card-learned-01'));
    await user.click(within(row).getByRole('button', { name: 'Reset progress' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reset this card?' });
    // The safe choice has focus, and cancelling changes nothing.
    expect(document.activeElement?.textContent).toBe('Cancel');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect((await getCard('card-learned-01'))!.fsrs.state).toBe('review');

    await user.click(within(row).getByRole('button', { name: 'Reset progress' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Reset progress' }),
    );
    await waitFor(async () => expect((await getCard('card-learned-01'))!.fsrs.state).toBe('new'));
  });

  it('edits a card in a side sheet and saves it', async () => {
    const user = userEvent.setup();
    const deck = await createDeck({ name: 'Cardiology' });
    const [a] = await createManualCards([basic(1)], { deckId: deck.id });
    renderBrowser();
    const row = await screen.findByTestId(cardRowId(a!.id));
    await user.click(within(row).getByRole('button', { name: 'Edit' }));
    const sheet = await screen.findByRole('dialog', { name: 'Edit card' });
    const form = within(sheet).getByRole('form', { name: 'Edit card' });
    const front = within(form).getByLabelText('Front');
    await user.clear(front);
    await user.type(front, 'Sharper question?');
    await user.click(within(form).getByRole('button', { name: 'Save card' }));
    await waitFor(async () => expect((await getCard(a!.id))!.front).toBe('Sharper question?'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('makes a deck and explains why create is unavailable until it has a name', async () => {
    const user = userEvent.setup();
    renderBrowser();
    await user.click(await screen.findByRole('button', { name: 'New deck' }));
    const create = screen.getByTestId(TID.newDeck);
    expect(create.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(screen.getByTestId(TID.newDeckName));
    await user.type(screen.getByTestId(TID.newDeckName), 'Pharmacology');
    await user.click(create);
    await waitFor(() =>
      expect(within(screen.getByTestId(TID.browserDeck)).getByText('Pharmacology')).toBeTruthy(),
    );
  });
});
