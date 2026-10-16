import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { defaultSettings, type FilingSuggestion, type PageStatus } from '@shared';
import { makeChromeFakes, makeItem, rpc, store } from '@ui/testing/fakes';
import { SidePanel } from './SidePanel';
import { extras } from './testing';

/**
 * A filing rule's pending suggestion on a card of "This page" (docs/adr/017-filing-rules.md): kept
 * until it is filed or dismissed, with the rule, bank and folder it names written out.
 */

vi.mock('@storage', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { store: fakeStore } = await import('@ui/testing/fakes');
  const { extras: more } = await import('./testing');
  return { ...actual, ...fakeStore.module, ...more.module };
});
vi.mock('@runtime', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { rpc: fake } = await import('@ui/testing/fakes');
  return { ...actual, callBackground: fake.callBackground, callTab: fake.callTab } as never;
});

configure({ asyncUtilTimeout: 5_000 });

const status = (): PageStatus => ({
  url: 'https://example.com/notes',
  canonicalUrl: null,
  title: 'Cell biology notes',
  counts: { total: 0, resolved: 0, changed: 0, ambiguous: 0, orphaned: 0, pending: 0 },
  paintingSupported: true,
  hasSelection: false,
  blocked: null,
});

let withSuggestion: string;

beforeEach(() => {
  fakeBrowser.reset();
  store.reset();
  extras.reset();
  rpc.reset();
  window.history.replaceState(null, '', '/');
  Object.assign(browser, makeChromeFakes());
  Object.assign(browser.runtime, { openOptionsPage: vi.fn(async () => undefined) });
});
afterEach(cleanup);

async function open() {
  rpc.tab['content.pageStatus'] = () => status();
  rpc.tab['content.refresh'] = () => ({ ok: true });
  const a = makeItem({ highlight: { exactQuote: 'Ribosomes build proteins.' } });
  const b = makeItem({ highlight: { exactQuote: 'Mitochondria make ATP.' } });
  withSuggestion = a.highlight.id;
  store.reset([a, b]);
  const suggestion: FilingSuggestion = {
    highlightId: withSuggestion,
    at: Date.now(),
    ruleName: 'Biology sites',
    bankId: 'bank-bio00001',
    bankName: 'Biology',
    folderId: 'folder-w1-0001',
    folderName: 'Week 1',
    addTagIds: ['tag-00000001'],
  };
  extras.suggestions = [suggestion];
  await browser.storage.local.set({ settings: defaultSettings() });
  vi.spyOn(browser.tabs, 'query').mockImplementation(
    async () =>
      [
        { id: 11, url: 'https://example.com/notes', title: 'Cell', windowId: 1, active: true },
      ] as never,
  );
  return render(<SidePanel />);
}

const cardOf = (quote: string) =>
  screen.getAllByRole('article').find((a) => a.textContent?.includes(quote))!;
const called = (fn: string) => store.calls.filter((c) => c.fn === fn);

describe('a pending suggestion', () => {
  it('shows on its own card only, naming the rule, the place and the tags', async () => {
    await open();
    await screen.findByText('Ribosomes build proteins.');
    const chip = await within(cardOf('Ribosomes')).findByTestId('card-suggestion');
    expect(chip.textContent).toContain('File in Biology / Week 1?');
    expect(chip.textContent).toContain('Rule: Biology sites');
    expect(chip.textContent).toContain('+1 tag');
    // The button names the bank it files into.
    expect(within(chip).getByRole('button', { name: 'File in Biology' })).toBeTruthy();
    expect(within(cardOf('Mitochondria')).queryByTestId('card-suggestion')).toBeNull();
  });

  it('File files it, offers Undo and removes the chip', async () => {
    await open();
    await screen.findByText('Ribosomes build proteins.');
    const user = userEvent.setup();
    await user.click(await within(cardOf('Ribosomes')).findByTestId('suggestion-file'));

    await waitFor(() =>
      expect(called('acceptFiling').map((c) => c.args[0])).toEqual([withSuggestion]),
    );
    await waitFor(() =>
      expect(within(cardOf('Ribosomes')).queryByTestId('card-suggestion')).toBeNull(),
    );
    expect(
      await screen.findByText("Filed in Biology / Week 1 by rule 'Biology sites'."),
    ).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() =>
      expect(called('undoFiling').map((c) => c.args[0])).toEqual([withSuggestion]),
    );
    expect(await screen.findByText(/Filing undone/)).toBeTruthy();
  });

  it('Not now drops it without filing', async () => {
    await open();
    await screen.findByText('Ribosomes build proteins.');
    await userEvent
      .setup()
      .click(await within(cardOf('Ribosomes')).findByTestId('suggestion-dismiss'));
    await waitFor(() =>
      expect(within(cardOf('Ribosomes')).queryByTestId('card-suggestion')).toBeNull(),
    );
    expect(called('dismissFiling').map((c) => c.args[0])).toEqual([withSuggestion]);
    expect(called('acceptFiling')).toHaveLength(0);
  });

  it('says why when the suggestion could not be filed and drops the chip', async () => {
    await open();
    await screen.findByText('Ribosomes build proteins.');
    // The worker answers "unavailable" (the bank was deleted since).
    extras.acceptAnswer = {
      status: 'unavailable',
      ruleName: 'Biology sites',
      reason: 'Nothing was filed: its bank no longer exists.',
    };
    await userEvent
      .setup()
      .click(await within(cardOf('Ribosomes')).findByTestId('suggestion-file'));
    expect(await screen.findByText('Nothing was filed: its bank no longer exists.')).toBeTruthy();
    await waitFor(() =>
      expect(within(cardOf('Ribosomes')).queryByTestId('card-suggestion')).toBeNull(),
    );
  });
});
