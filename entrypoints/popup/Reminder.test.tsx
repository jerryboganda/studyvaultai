import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { browser } from 'wxt/browser';
import { defaultSettings, type Settings } from '@shared';
import { createDeck, createManualCards } from '@storage';
import { freshDatabase } from '@storage/test-vault';
import { readReminderFlag, writeReminderFlag } from '@ui/review/reminders';
import { makeChromeFakes, rpc, siteStatus, store } from '@ui/testing/fakes';
import { gameState, type GameFake } from './testGame';
import { Popup } from './Popup';

// The same arrangement as Popup.test.tsx: pages' highlight reads are fakes, review counts are real.
vi.mock('@storage', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { store: fake } = await import('@ui/testing/fakes');
  return { ...actual, ...fake.module } as never;
});
const game = vi.hoisted(() => ({ current: null as unknown as GameFake }));
vi.mock('@ui/game', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useGame: () => game.current,
}));
// The Sunny popup draws more on each render; jsdom on a busy machine needs longer than 1 s.
configure({ asyncUtilTimeout: 10_000 });

vi.mock('@runtime', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { rpc: fake } = await import('@ui/testing/fakes');
  return { ...actual, callBackground: fake.callBackground, callTab: fake.callTab } as never;
});

const basic = (n: number) => ({
  template: 'basic' as const,
  question: `Question ${n}?`,
  answer: `Answer ${n}`,
});

async function openPopup(settings: Partial<Settings> = {}) {
  await browser.storage.local.set({ settings: { ...defaultSettings(), ...settings } });
  vi.spyOn(browser.tabs, 'query').mockImplementation((async (q?: { url?: unknown }) =>
    q && 'url' in q
      ? []
      : [
          {
            id: 7,
            windowId: 3,
            url: 'https://example.com/notes',
            title: 'Tab',
            active: true,
            index: 0,
          },
        ]) as never);
  return render(<Popup />);
}

const raise = () => writeReminderFlag({ at: Date.now(), expiresAt: Date.now() + 3_600_000 });

beforeEach(async () => {
  game.current = gameState();
  await freshDatabase(); // also resets fakeBrowser
  store.reset();
  rpc.reset();
  Object.assign(browser, makeChromeFakes());
  Object.assign(browser.runtime, { openOptionsPage: vi.fn(async () => undefined) });
  vi.spyOn(window, 'close').mockImplementation(() => undefined);
  rpc.background['site.status'] = () => siteStatus();
});
afterEach(cleanup);

describe('popup: the daily review notice', () => {
  it('says "Time to review: N cards due" once the daily time came, and Dismiss removes it', async () => {
    const deck = await createDeck({ name: 'Cardiology' });
    await createManualCards([basic(1), basic(2), basic(3)], { deckId: deck.id });
    await raise();
    await openPopup();

    const notice = await screen.findByText('Time to review: 3 cards due');
    expect(notice.closest('[role="status"]')).not.toBeNull(); // announced, not only drawn
    expect(screen.getByRole('button', { name: /^Start review/ })).toBeTruthy();
    // The notice takes the detail line's place (the popup keeps its height).
    expect(screen.queryByText(/\d+ new · \d+ learning/)).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.queryByText(/Time to review/)).toBeNull());
    expect(await screen.findByText('3 new · 0 learning · 0 review')).toBeTruthy();
    expect(await readReminderFlag()).toBeNull();
    // Focus did not fall to <body>: the title took it.
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }));
    // The count itself is still there.
    expect((await screen.findByTestId('popup-due')).textContent).toContain('3 cards due');
  });

  it('shows nothing when no daily time came, when it expired, or when nothing is due', async () => {
    const deck = await createDeck({ name: 'Cardiology' });
    await createManualCards([basic(1)], { deckId: deck.id });
    await openPopup();
    await screen.findByTestId('popup-due');
    expect(screen.queryByText(/Time to review/)).toBeNull();
    cleanup();

    await writeReminderFlag({ at: Date.now() - 7_200_000, expiresAt: Date.now() - 3_600_000 });
    await openPopup();
    await screen.findByTestId('popup-due');
    expect(screen.queryByText(/Time to review/)).toBeNull();
  });

  it('is not shown while review is off', async () => {
    const deck = await createDeck({ name: 'Cardiology' });
    await createManualCards([basic(1)], { deckId: deck.id });
    await raise();
    await openPopup({ features: { ...defaultSettings().features, review: false } });
    expect(await screen.findByRole('button', { name: 'Open dashboard' })).toBeTruthy();
    expect(screen.queryByText(/Time to review/)).toBeNull();
  });

  it('appears when the worker raises it while the popup is open, and goes when another context dismisses', async () => {
    const deck = await createDeck({ name: 'Cardiology' });
    await createManualCards([basic(1)], { deckId: deck.id });
    await openPopup();
    await screen.findByTestId('popup-due');
    expect(screen.queryByText(/Time to review/)).toBeNull();

    await raise();
    expect(await screen.findByText('Time to review: 1 card due')).toBeTruthy();
    await writeReminderFlag(null);
    await waitFor(() => expect(screen.queryByText(/Time to review/)).toBeNull());
  });
});
