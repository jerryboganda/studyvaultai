import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, configure, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { browser } from 'wxt/browser';
import { PENDING_SEARCH_KEY, defaultSettings, type PageStatus } from '@shared';
import {
  addToBank,
  attachTags,
  createBank,
  createCardsFromHighlight,
  createFolder,
  createNote,
  createTag,
  getHighlightDetail,
  listNotes,
  listTags,
} from '@storage';
import { freshDatabase, save } from '@storage/test-vault';
import { STUDY_SETTINGS_KEY, defaultStudySettings } from '@ui/review';
import { makeChromeFakes, rpc } from '@ui/testing/fakes';
import { SidePanel } from './SidePanel';
import { openCard, showRecent } from './testing';

/**
 * The panel against the REAL vault (Dexie on fake-indexeddb): search index, tags, notes, folders,
 * the bank filter and the due count are the production code paths, not fakes.
 */

vi.mock('@runtime', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { rpc: fake } = await import('@ui/testing/fakes');
  return { ...actual, callBackground: fake.callBackground, callTab: fake.callTab } as never;
});

vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 10_000 });

const PAGE_URL = 'https://example.com/notes/pharm';

function status(): PageStatus {
  return {
    url: PAGE_URL,
    canonicalUrl: null,
    title: 'Pharmacology notes',
    counts: { total: 0, resolved: 0, changed: 0, ambiguous: 0, orphaned: 0, pending: 0 },
    paintingSupported: true,
    hasSelection: false,
    blocked: null,
  };
}

let created: string[];

async function open(hash = '') {
  window.history.replaceState(null, '', `/${hash}`);
  await browser.storage.local.set({
    settings: defaultSettings(),
    [STUDY_SETTINGS_KEY]: { ...defaultStudySettings(), timeZone: 'UTC', rolloverHour: 0 },
  });
  vi.spyOn(browser.tabs, 'query').mockImplementation((async (q: { url?: string }) =>
    q.url
      ? []
      : [
          {
            id: 11,
            url: PAGE_URL,
            title: 'Pharmacology notes',
            windowId: 1,
            active: true,
            index: 0,
          },
        ]) as never);
  return render(<SidePanel />);
}

beforeEach(async () => {
  await freshDatabase();
  rpc.reset();
  rpc.tab['content.pageStatus'] = () => status();
  rpc.tab['content.refresh'] = () => ({ ok: true });
  Object.assign(browser, makeChromeFakes());
  Object.assign(browser.runtime, { openOptionsPage: vi.fn(async () => undefined) });
  created = [];
  vi.spyOn(browser.tabs, 'create').mockImplementation((async (p: { url?: string }) => {
    created.push(p.url ?? '');
    return { id: 99 };
  }) as never);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(cleanup);

const queryBox = () => screen.getByRole('searchbox', { name: 'Search highlights and notes' });

describe('Search over the real vault', () => {
  it('finds a quote, a tag and a note text, each through the one index', async () => {
    const aspirin = await save('Aspirin irreversibly inhibits cyclooxygenase.');
    const warfarin = await save('Warfarin inhibits vitamin K epoxide reductase.');
    const { tag } = await createTag('antiplatelet');
    await attachTags({ highlightIds: [aspirin.id], tagIds: [tag.id] });
    await createNote({ highlightId: warfarin.id, body: 'Compare with **carvedilol** dosing.' });
    await open('#search');

    await userEvent.type(await screen.findByRole('searchbox'), 'aspirin');
    let card = await screen.findByTestId('search-result');
    expect(card.querySelector('mark')?.textContent).toBe('Aspirin');
    expect(card.getAttribute('data-highlight-id')).toBe(aspirin.id);
    expect(screen.queryByText(/Warfarin/)).toBeNull();

    await userEvent.clear(queryBox());
    await userEvent.type(queryBox(), 'tag:antiplatelet');
    await waitFor(() =>
      expect(screen.getByTestId('search-result').getAttribute('data-highlight-id')).toBe(
        aspirin.id,
      ),
    );

    await userEvent.clear(queryBox());
    await userEvent.type(queryBox(), 'carvedilol');
    await waitFor(() =>
      expect(screen.getByTestId('search-result').getAttribute('data-highlight-id')).toBe(
        warfarin.id,
      ),
    );
    card = screen.getByTestId('search-result');
    expect(within(card).getByText('Matched a note')).toBeTruthy();
    expect(screen.getAllByTestId('search-result')).toHaveLength(1);
  });

  it('counts a highlight once however many of its notes match the same word', async () => {
    const hl = await save('Warfarin inhibits vitamin K epoxide reductase.');
    await createNote({ highlightId: hl.id, body: 'Warfarin dosing needs regular INR checks.' });
    await createNote({ highlightId: hl.id, body: 'Warfarin interacts with many other drugs.' });
    await open('#search');

    await userEvent.type(await screen.findByRole('searchbox'), 'warfarin');
    await waitFor(() =>
      expect(screen.getByTestId('search-status').textContent).toMatch(/^1 match in/),
    );
    // the timing is shown but not read aloud
    expect(
      screen.getByTestId('search-status').querySelector('[aria-hidden="true"]')?.textContent,
    ).toMatch(/^ in \d+ ms$/);
    expect(screen.getAllByTestId('search-result')).toHaveLength(1);
    expect(screen.getByTestId('search-result').getAttribute('data-highlight-id')).toBe(hl.id);
    // the count and the list agree, so there is nothing more to show
    expect(screen.queryByTestId('search-more')).toBeNull();
  });

  it('acts on a hit: shows it on the page, opens the dashboard and the flashcard author', async () => {
    const hl = await save('Aspirin irreversibly inhibits cyclooxygenase.');
    rpc.tab['content.reveal'] = () => ({ found: true });
    await open('#search');
    await userEvent.type(await screen.findByRole('searchbox'), 'aspirin');
    const card = await screen.findByTestId('search-result');

    // The page being viewed owns this highlight, so it can be shown there.
    const show = await within(card).findByRole('button', { name: 'Show on page' });
    await waitFor(() => expect(show.getAttribute('aria-disabled')).toBeNull());
    await userEvent.click(show);
    expect(await within(card).findByText('Showing this highlight on the page.')).toBeTruthy();
    expect(rpc.called('content.reveal')[0]?.payload).toEqual({ id: hl.id });

    await userEvent.click(within(card).getByRole('button', { name: 'Open in dashboard' }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(new URL(created[0]!).searchParams.get('highlight')).toBe(hl.id);

    await userEvent.click(within(card).getByRole('button', { name: 'Make flashcard' }));
    await waitFor(() => expect(created).toHaveLength(2));
    const author = new URL(created[1]!);
    expect(author.pathname).toBe('/review.html');
    expect(author.searchParams.get('view')).toBe('create');
    expect(author.searchParams.get('highlight')).toBe(hl.id);
  });

  it('says there are no results instead of guessing', async () => {
    await save('Aspirin irreversibly inhibits cyclooxygenase.');
    await open('#search');
    await userEvent.type(await screen.findByRole('searchbox'), 'zyzzyva');
    expect(await screen.findByText('No results')).toBeTruthy();
  });

  it('picks up a highlight saved after the index was built', async () => {
    await save('Aspirin irreversibly inhibits cyclooxygenase.');
    await open('#search');
    await userEvent.type(await screen.findByRole('searchbox'), 'heparin');
    expect(await screen.findByText('No results')).toBeTruthy();

    await save('Heparin potentiates antithrombin III.');
    expect(await screen.findByTestId('search-result')).toBeTruthy();
  });
});

describe('Tags and notes on a card, in the real vault', () => {
  it('adds and removes a tag; the tag is stored once and suggested next time', async () => {
    const hl = await save('Aspirin irreversibly inhibits cyclooxygenase.');
    await open();
    await openCard();
    await userEvent.type(await screen.findByLabelText('Add a tag'), 'antiplatelet{Enter}');
    const chips = await screen.findByRole('list', { name: 'Tags' });
    expect(within(chips).getByText('antiplatelet')).toBeTruthy();

    expect((await listTags()).map((t) => t.tag.name)).toEqual(['antiplatelet']);
    expect((await getHighlightDetail(hl.id)).tags.map((t) => t.name)).toEqual(['antiplatelet']);

    await userEvent.click(screen.getByRole('button', { name: 'Remove tag antiplatelet' }));
    await waitFor(async () => expect((await getHighlightDetail(hl.id)).tags).toEqual([]));
    // The tag still exists as vocabulary: the field suggests it.
    const field = screen.getByLabelText('Add a tag');
    const options = document.getElementById(field.getAttribute('list')!)!;
    await waitFor(() =>
      expect([...options.querySelectorAll('option')].map((o) => o.getAttribute('value'))).toEqual([
        'antiplatelet',
      ]),
    );
  });

  it('writes a Markdown note that is stored, rendered safely, and editable', async () => {
    const hl = await save('Aspirin irreversibly inhibits cyclooxygenase.');
    const { container } = await open();
    await openCard();
    await userEvent.click(await screen.findByRole('button', { name: 'Add a note' }));
    await userEvent.type(
      screen.getByLabelText('New study note (Markdown)'),
      'Remember **COX-1** <img src=x onerror=1>',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save note' }));

    const shown = await screen.findByTestId('card-note');
    expect(within(shown).getByText('COX-1').tagName).toBe('STRONG');
    expect(container.querySelector('img')).toBeNull();
    const stored = await listNotes({ highlightId: hl.id });
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      body: 'Remember **COX-1** <img src=x onerror=1>',
      highlightId: hl.id,
      sourceId: hl.sourceId,
    });

    await userEvent.click(within(shown).getByRole('button', { name: /^Edit this note/ }));
    const editor = screen.getByLabelText('Study note (Markdown)');
    await userEvent.clear(editor);
    await userEvent.type(editor, 'Edited text');
    await userEvent.click(screen.getByRole('button', { name: 'Save note' }));
    await waitFor(async () =>
      expect((await listNotes({ highlightId: hl.id })).map((n) => n.body)).toEqual(['Edited text']),
    );
    expect(await screen.findByText('Edited text')).toBeTruthy();
  });

  it('a note editor kept open across a tab switch does not take the cursor from the search box', async () => {
    const hl = await save('The sinoatrial node is the primary pacemaker of the heart.');
    await open();
    await openCard();
    await userEvent.click(await screen.findByRole('button', { name: 'Add a note' }));
    // Opening the editor by hand puts the cursor in it.
    const editor = screen.getByLabelText('New study note (Markdown)');
    expect(document.activeElement).toBe(editor);
    await userEvent.type(editor, 'Rate 60-100');

    // Search shows the same card under Recent, its editor restored from the card memory.
    await userEvent.click(screen.getByRole('tab', { name: 'Search' }));
    const restored = await screen.findByLabelText('New study note (Markdown)');
    expect((restored as HTMLTextAreaElement).value).toBe('Rate 60-100');
    expect(document.activeElement).not.toBe(restored);

    await userEvent.click(queryBox());
    await userEvent.type(queryBox(), 'sinoatrial');
    expect((queryBox() as HTMLInputElement).value).toBe('sinoatrial');
    expect((screen.getByLabelText('New study note (Markdown)') as HTMLTextAreaElement).value).toBe(
      'Rate 60-100',
    );
    await waitFor(() =>
      expect(screen.getByTestId('search-result').getAttribute('data-highlight-id')).toBe(hl.id),
    );
  });
});

describe('Banks, folders and the bank filter in the real vault', () => {
  it('shows the folder tree with counts and narrows Recent and Search to a folder', async () => {
    const inFolder = await save('Aspirin irreversibly inhibits cyclooxygenase.');
    await save('Warfarin inhibits vitamin K epoxide reductase.');
    const bank = await createBank('Cardiology');
    const folder = await createFolder({ bankId: bank.id, name: 'Antiplatelets' });
    await addToBank({ highlightId: inFolder.id, bankId: bank.id, folderId: folder.id });
    await open('#banks');
    await userEvent.click(await screen.findByRole('button', { name: /^Cardiology/ }));

    await userEvent.click(
      await screen.findByRole('button', { name: 'Show folders of Cardiology' }),
    );
    const tree = await screen.findByRole('list', { name: 'Folders in Cardiology' });
    expect(within(tree).getByText('Antiplatelets')).toBeTruthy();
    expect(within(tree).getByText('1')).toBeTruthy();
    await userEvent.click(
      within(tree).getByRole('button', { name: 'Show Antiplatelets in Recent and Search' }),
    );
    expect(screen.getByTestId('folder-scope').textContent).toContain('Only Antiplatelets');

    await showRecent();
    await waitFor(() => expect(screen.getAllByRole('article')).toHaveLength(1));
    expect(screen.getByRole('article').getAttribute('data-highlight-id')).toBe(inFolder.id);

    await userEvent.click(screen.getByRole('tab', { name: 'Search' }));
    await userEvent.type(await screen.findByRole('searchbox'), 'inhibits');
    const card = await screen.findByTestId('search-result');
    expect(card.getAttribute('data-highlight-id')).toBe(inFolder.id);
    expect(screen.queryByText(/Warfarin/)).toBeNull();
  });
});

describe('Review in the real vault', () => {
  it('shows the live due count on the tab and in the review tab', async () => {
    const hl = await save('Aspirin irreversibly inhibits cyclooxygenase.');
    await createCardsFromHighlight(hl.id, [
      { template: 'basic', question: 'What does aspirin inhibit?', answer: 'COX' },
    ]);
    await open('#review');

    expect(await screen.findByRole('tab', { name: /^Review.*1/ })).toBeTruthy();
    expect((await screen.findByTestId('rv-tab-count')).textContent).toBe('1');
    await userEvent.click(screen.getByRole('button', { name: 'Start review' }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(new URL(created[0]!).searchParams.get('start')).toBe('1');
  });
});

describe('the focus-search command', () => {
  const request = (value: unknown) =>
    act(async () => {
      await browser.storage.session.set({ [PENDING_SEARCH_KEY]: value });
    });
  const stored = async () =>
    (await browser.storage.session.get(PENDING_SEARCH_KEY))[PENDING_SEARCH_KEY];

  it('opens on Search with the cursor in the box, and removes the request', async () => {
    await browser.storage.session.set({
      [PENDING_SEARCH_KEY]: { target: 'panel', at: Date.now() },
    });
    await open();
    await waitFor(() => expect(document.activeElement).toBe(queryBox()));
    expect(screen.getByRole('tab', { name: 'Search' }).getAttribute('aria-selected')).toBe('true');
    await waitFor(async () => expect(await stored()).toBeUndefined());
  });

  it('moves an open panel from another tab to Search and focuses the box', async () => {
    await save('Aspirin irreversibly inhibits cyclooxygenase.');
    await open();
    await userEvent.click(await screen.findByRole('tab', { name: 'Banks' }));
    expect(screen.queryByRole('searchbox')).toBeNull();

    await request({ target: 'panel', at: Date.now() });

    await waitFor(() => expect(document.activeElement).toBe(queryBox()));
    expect(screen.getByRole('tab', { name: 'Search' }).getAttribute('aria-selected')).toBe('true');
  });

  it('leaves a request for the dashboard alone', async () => {
    await open();
    await screen.findByRole('tab', { name: 'Search' });
    await request({ target: 'dashboard', at: Date.now() });
    await Promise.resolve();
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(await stored()).toMatchObject({ target: 'dashboard' });
  });

  it('ignores and removes a stale request', async () => {
    await browser.storage.session.set({
      [PENDING_SEARCH_KEY]: { target: 'panel', at: Date.now() - 60_000 },
    });
    await open();
    await screen.findByRole('tab', { name: 'Search' });
    await waitFor(async () => expect(await stored()).toBeUndefined());
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });
});
