import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  configure,
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { browser } from 'wxt/browser';
import {
  createBank,
  createDeck,
  createManualCards,
  getDeck,
  startStudySession,
  type TemplateInput,
} from '@storage';
import { freshDatabase } from '@storage/test-vault';
import { DeckSettingsForm } from './DeckSettingsForm';
import { useDueCount } from './hooks';
import { ReviewSettingsSection, StudyDaySettings } from './ReviewSettingsSection';
import { ReviewTab } from './ReviewTab';
import { STUDY_SETTINGS_KEY, defaultStudySettings, getStudySettings } from './settings';
import { TID } from './testids';

const basic = (n: number): TemplateInput => ({
  template: 'basic',
  question: `Question ${n}?`,
  answer: `Answer ${n}`,
});
const UTC = { ...defaultStudySettings(), timeZone: 'UTC', rolloverHour: 0 };

vi.setConfig({ testTimeout: 30_000 });
// Several agents and CI shards share the CPU: waiting for the page is not a failure.
configure({ asyncUtilTimeout: 10_000 });

beforeEach(async () => {
  await freshDatabase();
  await browser.storage.local.set({ [STUDY_SETTINGS_KEY]: UTC });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(cleanup);

describe('useDueCount', () => {
  it('follows the database: new cards raise the count without a reload', async () => {
    const deck = await createDeck({ name: 'Cardiology' });
    const { result } = renderHook(() => useDueCount());
    await waitFor(() => expect(result.current.count).toBe(0));

    await act(async () => {
      await createManualCards([basic(1), basic(2)], { deckId: deck.id });
    });
    await waitFor(() => expect(result.current.count).toBe(2));
    expect(result.current.summary?.total).toMatchObject({ new: 2, learning: 0, review: 0 });
    expect(result.current.resumable).toBeNull();
  });

  it('knows when a session can be continued', async () => {
    const deck = await createDeck({ name: 'Cardiology' });
    await createManualCards([basic(1), basic(2), basic(3)], { deckId: deck.id });
    await startStudySession({ boundary: { timeZone: 'UTC', rolloverHour: 0 } });
    const { result } = renderHook(() => useDueCount());
    await waitFor(() => expect(result.current.resumable).toEqual({ remaining: 3, answered: 0 }));
  });
});

describe('ReviewTab', () => {
  it('invites the first card instead of showing zeroes', async () => {
    const open = vi.fn();
    const user = userEvent.setup();
    render(<ReviewTab open={open} />);
    const empty = await screen.findByTestId(TID.tabEmpty);
    expect(empty.textContent).toMatch(/Turn a saved highlight into a flashcard/);
    await user.click(screen.getByTestId(TID.tabCreate));
    expect(open).toHaveBeenCalledWith({ view: 'create' });
  });

  it('shows what is due, by bank, and starts a session on the full page', async () => {
    const bank = await createBank('Cardiology');
    const deck = await createDeck({
      name: 'Cardiology',
      bankId: bank.id,
      settings: { newPerDay: 2 },
    });
    await createManualCards([basic(1), basic(2), basic(3)], { deckId: deck.id });
    const open = vi.fn();
    const user = userEvent.setup();
    render(<ReviewTab open={open} />);

    expect((await screen.findByTestId(TID.tabCount)).textContent).toBe('2');
    expect(screen.getByTestId(TID.deferredNote).textContent).toMatch(/1 more card/);
    const bankRow = screen.getByTestId(`rv-bank-${bank.id}`);
    await waitFor(() => expect(bankRow.textContent).toMatch(/Cardiology/));
    expect(bankRow.textContent).toMatch(/2$/);

    await user.click(screen.getByTestId(TID.tabStart));
    expect(open).toHaveBeenCalledWith({ view: 'study', start: true });
    await user.click(screen.getByTestId(TID.tabOpen));
    expect(open).toHaveBeenLastCalledWith({ view: 'study' });
  });

  it('offers to continue a stored session', async () => {
    const deck = await createDeck({ name: 'Cardiology' });
    await createManualCards([basic(1), basic(2)], { deckId: deck.id });
    await startStudySession({ boundary: { timeZone: 'UTC', rolloverHour: 0 } });
    render(<ReviewTab open={vi.fn()} />);
    const cont = await screen.findByTestId(TID.tabContinue);
    expect(cont.textContent).toMatch(/Continue session \(2 left\)/);
    expect(screen.queryByTestId(TID.tabStart)).toBeNull();
  });

  it('reports a failure it cannot recover from without a useless retry button', async () => {
    const open = vi.fn().mockRejectedValue(new Error('No tab could be opened.'));
    const user = userEvent.setup();
    const deck = await createDeck({ name: 'Cardiology' });
    await createManualCards([basic(1)], { deckId: deck.id });
    render(<ReviewTab open={open} />);
    await user.click(await screen.findByTestId(TID.tabStart));
    expect(await screen.findByText('No tab could be opened.')).toBeTruthy();
  });
});

describe('DeckSettingsForm', () => {
  it('explains every field, blocks a bad value with a reason, and saves a good one', async () => {
    const user = userEvent.setup();
    const deck = await createDeck({ name: 'Cardiology' });
    const onSaved = vi.fn();
    render(<DeckSettingsForm deck={deck} onSaved={onSaved} />);
    const form = screen.getByRole('form', { name: /Settings of deck Cardiology/ });
    const save = within(form).getByTestId(TID.deckSettingsSave);
    expect(save.getAttribute('aria-disabled')).toBe('true');
    expect(save.getAttribute('title')).toBe('There are no changes to save.');
    expect(within(form).getAllByText(/./).length).toBeGreaterThan(10);

    const retention = within(form).getByLabelText('Target retention (%)');
    await user.clear(retention);
    await user.type(retention, '55');
    expect(within(form).getByText(/between 70% and 99%/)).toBeTruthy();
    expect(save.getAttribute('title')).toMatch(/Fix the fields/);
    expect(retention.getAttribute('aria-invalid')).toBe('true');

    await user.clear(retention);
    await user.type(retention, '85');
    await user.clear(within(form).getByLabelText('New cards per day'));
    await user.type(within(form).getByLabelText('New cards per day'), '7');
    await user.clear(within(form).getByLabelText('Learning steps'));
    await user.type(within(form).getByLabelText('Learning steps'), '2m 15m 1h');
    await user.click(within(form).getByRole('checkbox'));
    await user.click(save);

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const stored = await getDeck(deck.id);
    expect(stored!.settings).toMatchObject({
      targetRetention: 0.85,
      newPerDay: 7,
      learningSteps: ['2m', '15m', '1h'],
      enableFuzz: false,
    });
    expect(await screen.findByText(/apply from the next answer/)).toBeTruthy();
  });

  it('restores the documented defaults into the form without saving them', async () => {
    const user = userEvent.setup();
    const deck = await createDeck({ name: 'Cardiology', settings: { newPerDay: 3 } });
    render(<DeckSettingsForm deck={deck} />);
    const field = screen.getByLabelText('New cards per day') as HTMLInputElement;
    expect(field.value).toBe('3');
    await user.click(screen.getByTestId(TID.deckSettingsReset));
    expect(field.value).toBe('20');
    expect((await getDeck(deck.id))!.settings.newPerDay).toBe(3);
  });
});

describe('study day settings', () => {
  it('validates the time zone, shows the effect, and saves under its own key', async () => {
    const user = userEvent.setup();
    render(<StudyDaySettings nowMs={Date.parse('2026-03-02T15:00:00.000Z')} />);
    const zone = (await screen.findByTestId(TID.timeZone)) as HTMLInputElement;
    const save = screen.getByTestId(TID.studyDaySave);
    expect(save.getAttribute('aria-disabled')).toBe('true');

    fireEvent.change(zone, { target: { value: 'Mars/Olympus' } });
    expect(screen.getByText(/not a time zone name Chrome knows/)).toBeTruthy();
    expect(save.getAttribute('aria-disabled')).toBe('true');

    fireEvent.change(zone, { target: { value: 'America/New_York' } });
    await user.selectOptions(screen.getByTestId(TID.rollover), '5');
    // The preview is computed from the real rules: 15:00Z is 10:00 in New York on 2 March.
    expect(screen.getByText(/study day 2026-03-02 now; the next one starts/)).toBeTruthy();
    await user.click(save);

    await waitFor(async () => {
      expect(await getStudySettings()).toMatchObject({
        timeZone: 'America/New_York',
        rolloverHour: 5,
      });
    });
    const raw = await browser.storage.local.get(STUDY_SETTINGS_KEY);
    expect(raw[STUDY_SETTINGS_KEY]).toMatchObject({ timeZone: 'America/New_York' });
    // The shared Settings object is untouched.
    expect((await browser.storage.local.get('settings')).settings).toBeUndefined();
  });

  it('the options-page section lists decks with their own rules', async () => {
    await createDeck({ name: 'Cardiology' });
    render(<ReviewSettingsSection />);
    const section = await screen.findByTestId(TID.settingsSection);
    await waitFor(() => expect(within(section).getByText('Cardiology')).toBeTruthy());
    expect(within(section).getByRole('heading', { name: 'Review and study day' })).toBeTruthy();
  });
});
