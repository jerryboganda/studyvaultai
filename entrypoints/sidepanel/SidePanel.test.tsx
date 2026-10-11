import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  PENDING_FOCUS_KEY,
  StudyVaultError,
  defaultSettings,
  type PageStatus,
  type Settings,
} from '@shared';
import { COMMANDS, INBOX, BIOLOGY, makeChromeFakes, makeItem, rpc, store } from '@ui/testing/fakes';
import { SidePanel } from './SidePanel';

vi.mock('@storage', async () => (await import('@ui/testing/fakes')).store.module);
vi.mock('@runtime', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { rpc: fake } = await import('@ui/testing/fakes');
  return { ...actual, callBackground: fake.callBackground, callTab: fake.callTab } as never;
});

interface FakeTab {
  id: number;
  url: string | undefined;
  title: string;
}
let current: FakeTab;

function status(over: Partial<PageStatus> = {}): PageStatus {
  return {
    url: 'https://example.com/notes',
    canonicalUrl: null,
    title: 'Cell biology notes',
    counts: { total: 0, resolved: 0, changed: 0, ambiguous: 0, orphaned: 0, pending: 0 },
    paintingSupported: true,
    hasSelection: false,
    blocked: null,
    ...over,
  };
}

async function open(settings: Partial<Settings> = {}, tab: Partial<FakeTab> = {}) {
  current = { id: 11, url: 'https://example.com/notes', title: 'Cell biology notes', ...tab };
  await browser.storage.local.set({ settings: { ...defaultSettings(), ...settings } });
  vi.spyOn(browser.tabs, 'query').mockImplementation(
    async () => [{ ...current, windowId: 1, active: true, index: 0 }] as never,
  );
  return render(<SidePanel />);
}

const live = () => {
  rpc.tab['content.pageStatus'] = () => status();
  rpc.tab['content.refresh'] = () => ({ ok: true });
};

beforeEach(() => {
  fakeBrowser.reset();
  store.reset();
  rpc.reset();
  Object.assign(browser, makeChromeFakes());
  Object.assign(browser.runtime, { openOptionsPage: vi.fn(async () => undefined) });
});
afterEach(cleanup);

describe('This page', () => {
  it('lists highlights with kind, state, banks and quote as text', async () => {
    live();
    store.reset([
      makeItem({
        highlight: { exactQuote: 'Mitochondria make ATP.', kind: 'formula', color: 'blue' },
        banks: [INBOX, BIOLOGY],
      }),
    ]);
    await open();

    expect(await screen.findByText('Mitochondria make ATP.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Cell biology notes' })).toBeTruthy();
    expect(screen.getByText('1 highlight')).toBeTruthy();
    const card = screen.getByRole('article');
    expect(within(card).getByText('Formula')).toBeTruthy();
    expect(within(card).getByText('Found on page')).toBeTruthy();
    expect(within(card).getByText('Inbox')).toBeTruthy();
    expect(within(card).getByText('Biology')).toBeTruthy();
    expect(rpc.called('content.pageStatus')[0]?.tabId).toBe(11);
  });

  it('groups ambiguous and orphaned highlights first with an explanation', async () => {
    live();
    store.reset([
      makeItem({ start: 5, highlight: { exactQuote: 'Fine quote.', resolveStatus: 'resolved' } }),
      makeItem({ start: 40, highlight: { exactQuote: 'Lost quote.', resolveStatus: 'orphaned' } }),
      makeItem({
        start: 20,
        highlight: { exactQuote: 'Twice quote.', resolveStatus: 'ambiguous' },
      }),
      makeItem({ start: 10, highlight: { exactQuote: 'Edited quote.', resolveStatus: 'changed' } }),
    ]);
    await open();

    const heading = await screen.findByRole('heading', { name: 'Needs attention (2)' });
    expect(screen.getByText(/could not be placed on the page/)).toBeTruthy();
    const attention = heading.closest('section')!;
    expect(within(attention).getAllByRole('article')).toHaveLength(2);
    expect(within(attention).getByText('Ambiguous · not painted')).toBeTruthy();
    expect(within(attention).getByText('Orphaned · not found on page')).toBeTruthy();

    const all = screen.getAllByRole('article').map((a) => a.textContent ?? '');
    expect(all[0]).toContain('Twice quote.');
    expect(all[1]).toContain('Lost quote.');
    expect(all[2]).toContain('Fine quote.'); // reading order: offset 5 before offset 10
    expect(all[3]).toContain('Edited quote.');
    expect(screen.getByText('4 highlights')).toBeTruthy();
    expect(screen.getByText(/2 need attention/)).toBeTruthy();
    expect(screen.getByText('Source changed')).toBeTruthy();
  });

  it('shows the empty state when the page has no highlights, naming the real keys', async () => {
    live();
    const fakes = makeChromeFakes();
    fakes.commands.getAll.mockResolvedValue(
      COMMANDS.map((c) => (c.name === 'quick-save' ? { ...c, shortcut: 'Ctrl+Shift+8' } : c)),
    );
    Object.assign(browser, fakes);
    await open();
    expect(await screen.findByText('No highlights on this page yet')).toBeTruthy();
    const empty = screen.getByText('No highlights on this page yet').parentElement!;
    expect(await within(empty).findByText('Ctrl+Shift+8')).toBeTruthy();
    expect(within(empty).queryByText('Alt+Shift+H')).toBeNull(); // read from Chrome, not hard-coded
    expect(within(empty).getByText('Alt+Shift+Y')).toBeTruthy();
  });

  it('lets the browser pick the direction of quotes, notes and titles (Arabic, Hebrew)', async () => {
    live();
    const arabicTitle = '\u0645\u0644\u0627\u062d\u0638\u0627\u062a';
    const arabicQuote =
      '\u0627\u0644\u0645\u064a\u062a\u0648\u0643\u0648\u0646\u062f\u0631\u064a\u0627';
    const arabicHeading = '\u0645\u0642\u062f\u0645\u0629';
    rpc.tab['content.pageStatus'] = () => status({ title: arabicTitle });
    store.reset([
      makeItem({
        highlight: { exactQuote: arabicQuote, headingContext: arabicHeading },
        source: { title: arabicTitle },
      }),
    ]);
    await open();
    const quote = await screen.findByText(arabicQuote);
    expect(quote.getAttribute('dir')).toBe('auto');
    expect(screen.getByLabelText('Your note').getAttribute('dir')).toBe('auto');
    expect(screen.getByRole('heading', { name: arabicTitle }).getAttribute('dir')).toBe('auto');
    expect(screen.getByText(`Under: ${arabicHeading}`).getAttribute('dir')).toBe('auto');
  });

  it('collapses long quotes and expands them on request', async () => {
    live();
    const long = `${'word '.repeat(120)}END`;
    store.reset([makeItem({ highlight: { exactQuote: long } })]);
    await open();

    const toggle = await screen.findByRole('button', { name: 'Show full quote' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText(/END$/)).toBeNull();
    await userEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded')).toBe(
      'true',
    );
    expect(screen.getByText(/END$/)).toBeTruthy();
  });

  it('autosaves the note after typing and reports saved', async () => {
    live();
    store.reset([makeItem()]);
    await open();
    const note = await screen.findByLabelText('Your note');

    await userEvent.type(note, 'Remember this');

    await waitFor(
      () =>
        expect(store.calls.filter((c) => c.fn === 'updateHighlight').map((c) => c.args[1])).toEqual(
          [{ userComment: 'Remember this' }],
        ),
      { timeout: 3000 },
    );
    expect(await screen.findByText('Saved')).toBeTruthy();
    expect(rpc.called('content.refresh').length).toBeGreaterThan(0);
  });

  it('flushes the note immediately on blur', async () => {
    live();
    store.reset([makeItem()]);
    await open();
    const note = await screen.findByLabelText('Your note');

    await userEvent.type(note, 'Quick');
    await userEvent.tab();

    await waitFor(() => expect(store.calls.some((c) => c.fn === 'updateHighlight')).toBe(true));
    expect(store.items[0]!.highlight.userComment).toBe('Quick');
  });

  it('shows a failed save with the real error and retries', async () => {
    live();
    store.reset([makeItem()]);
    store.failNext.updateHighlight = new StudyVaultError('internal', 'Disk hiccup');
    await open();
    const note = await screen.findByLabelText('Your note');

    await userEvent.type(note, 'Oops');
    await userEvent.tab();

    expect(await screen.findByText(/Not saved: Disk hiccup/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Saved')).toBeTruthy();
    expect(store.items[0]!.highlight.userComment).toBe('Oops');
  });

  it('shows storage_unavailable as a message, without a blind Retry', async () => {
    live();
    store.reset([makeItem()]);
    store.failNext.updateHighlight = new StudyVaultError(
      'storage_unavailable',
      'Your data was saved by a newer version of StudyVault.',
    );
    await open();
    const note = await screen.findByLabelText('Your note');

    await userEvent.type(note, 'Stuck');
    await userEvent.tab();

    expect(
      await screen.findByText(/Your data was saved by a newer version of StudyVault/),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('changes kind (and the colour that goes with it) and priority', async () => {
    live();
    store.reset([makeItem()]);
    await open({ palette: { ...defaultSettings().palette, formula: 'teal' } });

    await userEvent.selectOptions(await screen.findByLabelText('Kind'), 'formula');
    await waitFor(() =>
      expect(store.calls.find((c) => c.fn === 'updateHighlight')?.args[1]).toEqual({
        kind: 'formula',
        color: 'teal',
      }),
    );
    await userEvent.selectOptions(screen.getByLabelText('Priority'), '5');
    await waitFor(() =>
      expect(store.calls.filter((c) => c.fn === 'updateHighlight').at(-1)?.args[1]).toEqual({
        priority: 5,
      }),
    );
  });

  it('deletes with an Undo toast that restores the highlight', async () => {
    live();
    store.reset([makeItem({ highlight: { exactQuote: 'Delete me.' } })]);
    const id = store.items[0]!.highlight.id;
    await open();

    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.queryByText('Delete me.')).toBeNull());
    expect(store.calls.some((c) => c.fn === 'softDeleteHighlight' && c.args[0] === id)).toBe(true);
    expect(rpc.called('content.refresh').length).toBeGreaterThan(0);
    // Honest about soft delete: a copy stays until the user wipes everything.
    expect(
      await screen.findByText(
        'Highlight deleted. A copy stays on this device until you delete all data in Settings.',
      ),
    ).toBeTruthy();
    // The card that had focus is gone: Undo takes it instead of <body>.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Undo' }));

    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));

    expect(await screen.findByText('Delete me.')).toBeTruthy();
    expect(store.calls.some((c) => c.fn === 'restoreHighlight' && c.args[0] === id)).toBe(true);
    expect(await screen.findByText('Highlight restored.')).toBeTruthy();
    // The toast closed with focus inside it: focus goes back to the panel content, not <body>.
    expect(document.activeElement).toBe(screen.getByRole('tabpanel'));
  });

  it('puts the toast region before the page content in DOM order', async () => {
    live();
    store.reset([makeItem()]);
    const { container } = await open();
    await screen.findByRole('article');
    const region = screen.getByRole('status');
    const main = container.querySelector('main')!;
    expect(region.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  it('error toasts are persistent alerts with a text prefix and a dismiss button', async () => {
    live();
    store.reset([makeItem({ highlight: { exactQuote: 'Restore me.' } })]);
    await open();
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    store.failNext.restoreHighlight = new StudyVaultError('storage_unavailable', 'Disk is full');
    await userEvent.click(await screen.findByRole('button', { name: 'Undo' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Error:');
    expect(alert.textContent).toContain('Could not restore the highlight: Disk is full');
    expect(within(alert).getByRole('button', { name: 'Dismiss notification' })).toBeTruthy();
    // No timer: still there well after a neutral toast would be gone.
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.getByRole('alert')).toBeTruthy();
    await userEvent.click(within(alert).getByRole('button', { name: 'Dismiss notification' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows on page, and says so when the highlight cannot be found', async () => {
    live();
    store.reset([makeItem()]);
    const id = store.items[0]!.highlight.id;
    let found = false;
    rpc.tab['content.reveal'] = () => ({ found });
    await open();

    await userEvent.click(await screen.findByRole('button', { name: 'Show on page' }));
    const card = screen.getByRole('article');
    expect(await within(card).findByText(/could not find this highlight on the page/)).toBeTruthy();
    expect(rpc.called('content.reveal')[0]?.payload).toEqual({ id });
    // Also spoken through the surface's one status region.
    expect(screen.getByRole('status').textContent).toContain('could not find this highlight');

    found = true;
    await userEvent.click(screen.getByRole('button', { name: 'Show on page' }));
    expect(await within(card).findByText('Showing this highlight on the page.')).toBeTruthy();
  });

  it('without a content script: explains, still lists saved highlights, then activates', async () => {
    store.reset([makeItem({ highlight: { exactQuote: 'Saved earlier.' } })]);
    let active = false;
    rpc.tab['content.pageStatus'] = () => {
      if (!active) throw new StudyVaultError('unsupported_page', 'No receiver');
      return status();
    };
    rpc.background['tab.activate'] = () => {
      active = true;
      return { ok: true };
    };
    await open();

    expect(await screen.findByText('StudyVault is not running on this tab')).toBeTruthy();
    expect(await screen.findByText('Saved earlier.')).toBeTruthy();
    const reveal = screen.getByRole('button', { name: 'Show on page' });
    expect(reveal.getAttribute('aria-disabled')).toBe('true');
    expect(reveal.getAttribute('title')).toMatch(/not running in the current tab/);
    expect(store.calls.find((c) => c.fn === 'listPageHighlights')?.args).toEqual([
      'https://example.com/notes',
      null,
    ]);

    await userEvent.click(screen.getByRole('button', { name: 'Activate on this tab' }));

    await waitFor(() =>
      expect(screen.queryByText('StudyVault is not running on this tab')).toBeNull(),
    );
    expect(rpc.called('tab.activate')[0]?.payload).toEqual({ tabId: 11 });
    expect(
      screen.getByRole('button', { name: 'Show on page' }).getAttribute('aria-disabled'),
    ).toBeNull();
  });

  it('activation failure shows the real error text', async () => {
    rpc.background['tab.activate'] = () => {
      throw new StudyVaultError('forbidden', 'StudyVault has not been given access to this tab.');
    };
    await open();
    await userEvent.click(await screen.findByRole('button', { name: 'Activate on this tab' }));
    expect(
      await screen.findByText('StudyVault has not been given access to this tab.'),
    ).toBeTruthy();
  });

  it('explains unsupported pages instead of showing an empty list', async () => {
    await open({}, { url: 'chrome://extensions', title: 'Extensions' });
    expect(await screen.findByText('StudyVault cannot run on this page')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Activate on this tab' })).toBeNull();
  });

  it('follows the active tab', async () => {
    live();
    store.reset([makeItem()]);
    await open();
    await screen.findByText('Cell biology notes', { selector: 'h2' });
    expect(rpc.called('content.pageStatus').map((c) => c.tabId)).toEqual([11]);

    rpc.tab['content.pageStatus'] = () =>
      status({ url: 'https://other.org/b', title: 'Other page' });
    current = { id: 12, url: 'https://other.org/b', title: 'Other page' };
    await act(async () => {
      await fakeBrowser.tabs.onActivated.trigger({ tabId: 12, windowId: 1 });
    });

    expect(await screen.findByRole('heading', { name: 'Other page' })).toBeTruthy();
    expect(rpc.called('content.pageStatus').at(-1)?.tabId).toBe(12);
  });

  it('surfaces a storage error with Retry', async () => {
    live();
    store.reset([makeItem({ highlight: { exactQuote: 'Back again.' } })]);
    store.failNext.listPageHighlights = new StudyVaultError('internal', 'IndexedDB hiccup');
    await open();
    expect(await screen.findByText('IndexedDB hiccup')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Back again.')).toBeTruthy();
  });

  it('storage_unavailable on the list shows its message and no Retry', async () => {
    live();
    store.failNext.listPageHighlights = new StudyVaultError(
      'storage_unavailable',
      'The Inbox could not be read.',
    );
    await open();
    expect(await screen.findByText('The Inbox could not be read.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});

describe('Recent', () => {
  it('lists saves across pages; reveal is disabled off the active page with the reason', async () => {
    live();
    const here = makeItem({ highlight: { exactQuote: 'On this page.' } });
    const elsewhere = makeItem({
      highlight: { exactQuote: 'From another site.' },
      source: {
        id: 'src-other001',
        title: 'Other site',
        host: 'other.org',
        originalUrl: 'https://other.org/x',
      },
    });
    store.reset([here, elsewhere], [here.highlight.id]);
    await open();
    await userEvent.click(await screen.findByRole('tab', { name: 'Recent' }));

    expect(await screen.findByText('From another site.')).toBeTruthy();
    const card = screen.getByText('From another site.').closest('article')!;
    expect(within(card).getByText(/Other site · other.org/)).toBeTruthy();
    const link = within(card).getByRole('link', { name: 'Open page' });
    expect(link.getAttribute('href')).toBe('https://other.org/x');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(
      within(card).getByRole('button', { name: 'Show on page' }).getAttribute('aria-disabled'),
    ).toBe('true');
    expect(within(card).getAllByText(/from another page/).length).toBeGreaterThan(0);

    const mine = screen.getByText('On this page.').closest('article')!;
    expect(
      within(mine).getByRole('button', { name: 'Show on page' }).getAttribute('aria-disabled'),
    ).toBeNull();
  });

  it('shows an empty state', async () => {
    live();
    await open();
    await userEvent.click(await screen.findByRole('tab', { name: 'Recent' }));
    expect(await screen.findByText('Nothing saved yet')).toBeTruthy();
  });

  it('refuses javascript: links from stored data', async () => {
    live();
    store.reset(
      [
        makeItem({
          highlight: { exactQuote: 'Sneaky.' },
          source: { originalUrl: 'javascript:alert(1)' as never },
        }),
      ],
      [],
    );
    await open();
    await userEvent.click(await screen.findByRole('tab', { name: 'Recent' }));
    await screen.findByText('Sneaky.');
    expect(screen.queryByRole('link', { name: 'Open page' })).toBeNull();
  });
});

const sessionEntry = async (value: unknown) =>
  browser.storage.session.set({ [PENDING_FOCUS_KEY]: value });
const storedEntry = async () =>
  (await browser.storage.session.get(PENDING_FOCUS_KEY))[PENDING_FOCUS_KEY];

describe('Note hand-over from the page overlay', () => {
  it('opens on the requested highlight: scrolls to it, focuses its note, clears the request', async () => {
    live();
    store.reset([makeItem({ start: 5 }), makeItem({ start: 50 })]);
    const target = store.items[1]!.highlight.id;
    await sessionEntry({ highlightId: target, at: Date.now() });
    await open();

    await waitFor(() => {
      const notes = screen.getAllByLabelText('Your note');
      expect(notes).toHaveLength(2);
      expect(document.activeElement).toBe(notes[1]);
    });
    await waitFor(async () => expect(await storedEntry()).toBeUndefined());
    // Focus moved on the page overlay's request: it is announced, with the quote it is about.
    expect(screen.getByRole('status').textContent).toContain(
      `Editing note for "${store.items[1]!.highlight.exactQuote}"`,
    );
  });

  it('follows a request that arrives while the panel is already open', async () => {
    live();
    store.reset([makeItem({ start: 5 }), makeItem({ start: 50 })]);
    const target = store.items[0]!.highlight.id;
    await open();
    await screen.findAllByLabelText('Your note');
    expect(document.activeElement).toBe(document.body);

    await act(async () => {
      await sessionEntry({ highlightId: target, at: Date.now() });
    });

    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getAllByLabelText('Your note')[0]),
    );
    await waitFor(async () => expect(await storedEntry()).toBeUndefined());
  });

  it('waits for the card to appear before focusing', async () => {
    live();
    store.reset([]);
    await sessionEntry({ highlightId: 'hl-late0001', at: Date.now() });
    await open();
    await screen.findByText('No highlights on this page yet');
    expect(document.activeElement).toBe(document.body);
    expect(await storedEntry()).toBeDefined(); // still waiting

    const late = makeItem();
    late.highlight.id = 'hl-late0001';
    store.items.push(late);
    store.pageIds.add('hl-late0001');
    act(() => store.notify());

    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Your note')));
  });

  it('switches from another tab to "This page" so the card exists', async () => {
    live();
    store.reset([makeItem()]);
    const target = store.items[0]!.highlight.id;
    await open();
    await userEvent.click(await screen.findByRole('tab', { name: 'Banks' }));
    expect(screen.queryByLabelText('Your note')).toBeNull();

    await act(async () => {
      await sessionEntry({ highlightId: target, at: Date.now() });
    });

    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Your note')));
    expect(screen.getByRole('tab', { name: /This page/ }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  it('ignores and removes a request older than 30 seconds, or a malformed one', async () => {
    live();
    store.reset([makeItem()]);
    const id = store.items[0]!.highlight.id;
    await sessionEntry({ highlightId: id, at: Date.now() - 60_000 });
    await open();
    await screen.findByLabelText('Your note');
    await waitFor(async () => expect(await storedEntry()).toBeUndefined());
    expect(document.activeElement).toBe(document.body);

    await act(async () => {
      await sessionEntry({ highlightId: 42, at: 'now' });
    });
    await waitFor(async () => expect(await storedEntry()).toBeUndefined());
    expect(document.activeElement).toBe(document.body);
  });

  it('does not take the cursor again after the user has moved on', async () => {
    live();
    store.reset([makeItem({ start: 5 }), makeItem({ start: 50 })]);
    const first = store.items[0]!.highlight.id;
    await sessionEntry({ highlightId: first, at: Date.now() });
    await open();
    const notes = await screen.findAllByLabelText('Your note');
    await waitFor(() => expect(document.activeElement).toBe(notes[0]));

    await userEvent.click(notes[1]!);
    await userEvent.type(notes[1]!, 'mine');
    expect(document.activeElement).toBe(notes[1]);
  });
});

describe('Banks tab', () => {
  async function openBanks() {
    live();
    await open();
    await userEvent.click(await screen.findByRole('tab', { name: 'Banks' }));
  }

  it('lists banks with their highlight counts', async () => {
    store.reset([makeItem({ banks: [INBOX, BIOLOGY] }), makeItem({ banks: [INBOX] })]);
    store.banks = [INBOX, BIOLOGY];
    await openBanks();

    const list = await screen.findByRole('list', { name: 'Your banks' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows[0]!.textContent).toContain('Inbox');
    expect(rows[0]!.textContent).toContain('2 highlights');
    expect(rows[1]!.textContent).toContain('Biology');
    expect(rows[1]!.textContent).toContain('1 highlight');
  });

  it('creates a bank from a labelled field, shows it in the list and clears the field', async () => {
    await openBanks();
    const field = await screen.findByLabelText('New bank');

    await userEvent.type(field, '  Cardiology  ');
    await userEvent.click(screen.getByRole('button', { name: 'Create bank' }));

    expect(await screen.findByText('Bank "Cardiology" created.')).toBeTruthy();
    expect(store.calls.filter((c) => c.fn === 'createBank').map((c) => c.args)).toEqual([
      ['Cardiology'],
    ]);
    const list = screen.getByRole('list', { name: 'Your banks' });
    expect(within(list).getByText('Cardiology')).toBeTruthy();
    expect((field as HTMLInputElement).value).toBe('');
  });

  it('submits with Enter', async () => {
    await openBanks();
    await userEvent.type(await screen.findByLabelText('New bank'), 'Renal{Enter}');
    await waitFor(() => expect(store.calls.some((c) => c.fn === 'createBank')).toBe(true));
  });

  it('explains an empty or over-long name and creates nothing', async () => {
    await openBanks();
    const field = await screen.findByLabelText('New bank');

    await userEvent.type(field, '   ');
    await userEvent.click(screen.getByRole('button', { name: 'Create bank' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Enter a name for the bank.');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(field.getAttribute('aria-describedby')).toBe(alert.id);

    await userEvent.clear(field);
    await userEvent.click(field);
    await userEvent.paste('x'.repeat(81));
    await userEvent.click(screen.getByRole('button', { name: 'Create bank' }));
    expect((await screen.findByRole('alert')).textContent).toContain('80 characters or fewer');

    await userEvent.type(field, 'y'); // typing clears the message
    expect(screen.queryByRole('alert')).toBeNull();
    expect(store.calls.some((c) => c.fn === 'createBank')).toBe(false);
  });

  it('shows the real storage error, keeps the name and retries', async () => {
    store.failNext.createBank = new StudyVaultError('internal', 'IndexedDB hiccup');
    await openBanks();
    const field = await screen.findByLabelText('New bank');
    await userEvent.type(field, 'Neurology');
    await userEvent.click(screen.getByRole('button', { name: 'Create bank' }));

    expect(await screen.findByText('IndexedDB hiccup')).toBeTruthy();
    expect((field as HTMLInputElement).value).toBe('Neurology');

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Bank "Neurology" created.')).toBeTruthy();
  });
});

describe('Tabs and safety', () => {
  it('uses roving tabindex and arrow keys', async () => {
    live();
    await open();
    const pageTab = await screen.findByRole('tab', { name: /This page/ });
    const recentTab = screen.getByRole('tab', { name: 'Recent' });
    expect(pageTab.getAttribute('tabindex')).toBe('0');
    expect(recentTab.getAttribute('tabindex')).toBe('-1');

    pageTab.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(recentTab.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(recentTab);
    await userEvent.keyboard('{Home}');
    expect(pageTab.getAttribute('aria-selected')).toBe('true');
    await userEvent.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Banks' }).getAttribute('aria-selected')).toBe('true');
    await userEvent.keyboard('{ArrowLeft}');
    expect(recentTab.getAttribute('aria-selected')).toBe('true');
  });

  it('renders every page-derived string as text', async () => {
    live();
    rpc.tab['content.pageStatus'] = () => status({ title: '<img src=x onerror=1>Page' });
    store.reset([
      makeItem({
        highlight: {
          exactQuote: '<script>window.__x=1</script><b>q</b>',
          userComment: '<i>note</i>',
          headingContext: '<u>Heading</u>',
        },
        banks: [{ id: 'bank-evil0001', name: '<svg onload=1>', color: 'red', isInbox: false }],
      }),
    ]);
    const { container } = await open();

    expect(await screen.findByText('<script>window.__x=1</script><b>q</b>')).toBeTruthy();
    expect(screen.getByText('<svg onload=1>')).toBeTruthy();
    expect((screen.getByLabelText('Your note') as HTMLTextAreaElement).value).toBe('<i>note</i>');
    expect(container.querySelector('script, img, b, i, u, svg')).toBeNull();
  });
});
