import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  StudyVaultError,
  defaultSettings,
  type PageStatus,
  type SearchDocument,
  type Settings,
} from '@shared';
import { readReminderFlag, writeReminderFlag } from '@ui/review/reminders';
import { BIOLOGY, INBOX, makeChromeFakes, makeItem, rpc, store } from '@ui/testing/fakes';
import { SidePanel } from './SidePanel';
import { description, extras, openCard, showRecent } from './testing';

// The real module underneath (review's session port binds to it at import time); the panel's
// reads and writes are the in-memory fakes, which share one item list and one change signal.
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
// The AI engine is covered by its own suite; here only that the card hands it the right highlight.
vi.mock('@ui/ai', async () => {
  const { createElement } = await import('react');
  return {
    HighlightAiActions: ({
      highlights,
      onOpenSettings,
    }: {
      highlights: Array<{ id: string }>;
      onOpenSettings?: () => void;
    }) =>
      createElement(
        'div',
        { 'data-testid': 'ai-actions-stub' },
        highlights.map((h) => h.id).join(','),
        createElement('button', { type: 'button', onClick: onOpenSettings }, 'Open AI settings'),
      ),
  };
});

// Several agents and CI shards share the CPU: waiting for the panel is not a failure.
configure({ asyncUtilTimeout: 5_000 });

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
  // The dashboard is looked for by address; the active tab is everything else.
  vi.spyOn(browser.tabs, 'query').mockImplementation((async (q: { url?: string }) =>
    q.url ? [] : [{ ...current, windowId: 1, active: true, index: 0 }]) as never);
  return render(<SidePanel />);
}

const live = () => {
  rpc.tab['content.pageStatus'] = () => status();
  rpc.tab['content.refresh'] = () => ({ ok: true });
};

const features = (over: Partial<Settings['features']>) => ({
  features: { ...defaultSettings().features, ...over },
});

let created: string[];

beforeEach(() => {
  fakeBrowser.reset();
  store.reset();
  extras.reset();
  rpc.reset();
  window.history.replaceState(null, '', '/');
  Object.assign(browser, makeChromeFakes());
  Object.assign(browser.runtime, { openOptionsPage: vi.fn(async () => undefined) });
  created = [];
  vi.spyOn(browser.tabs, 'create').mockImplementation((async (p: { url?: string }) => {
    created.push(p.url ?? '');
    return { id: 99 };
  }) as never);
});
afterEach(cleanup);

const doc = (id: string, over: Partial<SearchDocument> = {}): SearchDocument => ({
  id,
  docType: 'highlight',
  highlightId: id,
  title: 'Cell biology notes',
  url: 'https://example.com/notes',
  host: 'example.com',
  quote: 'Mitochondria produce ATP.',
  comment: '',
  headingContext: null,
  tags: [],
  banks: ['Inbox'],
  folderPath: [],
  kind: 'essential',
  priority: 3,
  resolveStatus: 'resolved',
  updatedAt: '2026-10-11T10:00:00.000Z',
  deletedAt: null,
  ...over,
});

// ---------------------------------------------------------------------------------------------

describe('tabs, header and address hash', () => {
  it('offers This page, Banks, Review, Search and More in that order', async () => {
    live();
    await open();
    const tabs = await screen.findAllByRole('tab');
    expect(tabs.map((t) => (t.textContent ?? '').replace(/\s*\(\d+\)$/, ''))).toEqual([
      'This page',
      'Banks',
      'Review',
      'Search',
      'More',
    ]);
    expect(tabs.filter((t) => t.getAttribute('aria-selected') === 'true')).toHaveLength(1);
  });

  it('opens on the tab named in the hash and keeps the hash current', async () => {
    live();
    window.history.replaceState(null, '', '/#banks');
    await open();
    expect((await screen.findByRole('tab', { name: 'Banks' })).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(await screen.findByRole('button', { name: 'New bank' })).toBeTruthy();

    await showRecent();
    expect(window.location.hash).toBe('#recent');
    // Recent is a page of More: the More tab stays selected.
    expect(screen.getByRole('tab', { name: 'More' }).getAttribute('aria-selected')).toBe('true');

    window.location.hash = '#search';
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Search' }).getAttribute('aria-selected')).toBe(
        'true',
      ),
    );
  });

  it('ignores a hash that is not a tab', async () => {
    live();
    window.history.replaceState(null, '', '/#inbox');
    await open();
    expect(
      (await screen.findByRole('tab', { name: /This page/ })).getAttribute('aria-selected'),
    ).toBe('true');
  });

  it('names the page and its status on This page, and counts its highlights on the tab', async () => {
    live();
    store.reset([makeItem(), makeItem()]);
    await open();
    const context = await screen.findByTestId('page-context');
    expect(within(context).getByRole('heading', { name: 'Cell biology notes' })).toBeTruthy();
    expect(within(context).getByText('example.com')).toBeTruthy();
    expect(within(context).getByText('On')).toBeTruthy();
    expect(await screen.findByRole('tab', { name: /^This page\s?\(2\)$/ })).toBeTruthy();
  });

  it('opens Settings from the header', async () => {
    live();
    await open();
    await userEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    expect(browser.runtime.openOptionsPage).toHaveBeenCalled();
  });

  it('opens the dashboard from the header', async () => {
    live();
    await open();
    await userEvent.click(await screen.findByRole('button', { name: 'Open dashboard' }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toMatch(/dashboard\.html$/);
  });
});

// ---------------------------------------------------------------------------------------------

describe('card actions', () => {
  it('Make flashcard opens the review authoring view for this highlight', async () => {
    live();
    store.reset([makeItem()]);
    const id = store.items[0]!.highlight.id;
    await open();
    await userEvent.click(await screen.findByRole('button', { name: 'Make flashcard' }));
    await waitFor(() => expect(created).toHaveLength(1));
    const url = new URL(created[0]!);
    expect(url.pathname).toBe('/review.html');
    expect(url.searchParams.get('view')).toBe('create');
    expect(url.searchParams.get('highlight')).toBe(id);
  });

  it('Open in dashboard opens the dashboard on this highlight', async () => {
    live();
    store.reset([makeItem()]);
    const id = store.items[0]!.highlight.id;
    await open();
    await userEvent.click(await screen.findByRole('button', { name: 'Open in dashboard' }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(new URL(created[0]!).searchParams.get('highlight')).toBe(id);
    expect(new URL(created[0]!).pathname).toBe('/dashboard.html');
  });

  it('says why Make flashcard is unavailable when review is turned off', async () => {
    live();
    store.reset([makeItem()]);
    await open(features({ review: false }));
    const button = await screen.findByRole('button', { name: 'Make flashcard' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(description(button)).toMatch(/Review is turned off in Settings/);
    await userEvent.click(button);
    expect(created).toEqual([]);
  });

  it('shows a failure of the action with Retry', async () => {
    live();
    store.reset([makeItem()]);
    await open();
    created.length = 0;
    vi.spyOn(browser.tabs, 'create').mockRejectedValueOnce(new Error('Tab limit reached'));
    await userEvent.click(await screen.findByRole('button', { name: 'Make flashcard' }));
    expect(await screen.findByText('Tab limit reached')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------------------------

describe('tags', () => {
  it('adds a tag by name: creates it, attaches it, shows the chip and clears the field', async () => {
    live();
    store.reset([makeItem()]);
    const id = store.items[0]!.highlight.id;
    await open();
    await openCard();
    const field = await screen.findByLabelText('Add a tag');

    await userEvent.type(field, '  exam pearl ');
    await userEvent.click(screen.getByRole('button', { name: 'Add tag' }));

    const tags = await screen.findByRole('list', { name: 'Tags' });
    expect(within(tags).getByText('exam pearl')).toBeTruthy();
    expect(store.calls.find((c) => c.fn === 'createTag')?.args).toEqual(['exam pearl']);
    const attach = store.calls.find((c) => c.fn === 'attachTags')?.args[0] as {
      highlightIds: string[];
    };
    expect(attach.highlightIds).toEqual([id]);
    expect((field as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('status').textContent).toContain('Tag "exam pearl" added.');
  });

  it('suggests existing tags and reuses one instead of creating a duplicate', async () => {
    live();
    store.reset([makeItem()]);
    extras.tags = [{ id: 'tag-existing1', name: 'neuro', color: null, nameKey: 'neuro' }];
    await open();
    await openCard();
    const field = (await screen.findByLabelText('Add a tag')) as HTMLInputElement;
    const list = document.getElementById(field.getAttribute('list')!)!;
    await waitFor(() =>
      expect([...list.querySelectorAll('option')].map((o) => o.getAttribute('value'))).toEqual([
        'neuro',
      ]),
    );

    await userEvent.type(field, 'neuro{Enter}');
    expect(await screen.findByRole('list', { name: 'Tags' })).toBeTruthy();
    expect(extras.tags).toHaveLength(1);
    expect(extras.links.get(store.items[0]!.highlight.id)?.has('tag-existing1')).toBe(true);
  });

  it('removes a tag from the highlight without deleting the tag', async () => {
    live();
    store.reset([makeItem()]);
    const id = store.items[0]!.highlight.id;
    extras.tags = [{ id: 'tag-existing1', name: 'neuro', color: null, nameKey: 'neuro' }];
    extras.links.set(id, new Set(['tag-existing1']));
    await open();
    // Closed card: the tag is a read-only chip (once the card's details have loaded).
    await waitFor(() =>
      expect(screen.getByRole('list', { name: 'Banks and tags' }).textContent).toContain('#neuro'),
    );
    await openCard();

    await userEvent.click(await screen.findByRole('button', { name: 'Remove tag neuro' }));

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Remove tag neuro' })).toBeNull(),
    );
    expect(await screen.findByText('No tags yet.')).toBeTruthy();
    expect(extras.tags).toHaveLength(1);
  });

  it('explains an empty or over-long name and creates nothing', async () => {
    live();
    store.reset([makeItem()]);
    await open();
    await openCard();
    const field = await screen.findByLabelText('Add a tag');

    await userEvent.click(screen.getByRole('button', { name: 'Add tag' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Enter a tag name.');
    expect(field.getAttribute('aria-invalid')).toBe('true');

    await userEvent.click(field);
    await userEvent.paste('y'.repeat(60));
    await userEvent.click(screen.getByRole('button', { name: 'Add tag' }));
    expect((await screen.findByRole('alert')).textContent).toContain('50 characters or fewer');
    expect(store.calls.some((c) => c.fn === 'createTag')).toBe(false);
  });

  it('shows the real error when the tag cannot be saved', async () => {
    live();
    store.reset([makeItem()]);
    extras.failNext.createTag = new StudyVaultError('internal', 'Tag table is locked');
    await open();
    await openCard();
    await userEvent.type(await screen.findByLabelText('Add a tag'), 'neuro{Enter}');
    expect((await screen.findByRole('alert')).textContent).toContain('Tag table is locked');
  });
});

// ---------------------------------------------------------------------------------------------

describe('notes', () => {
  it('shows existing notes as sanitised Markdown', async () => {
    live();
    store.reset([makeItem()]);
    const id = store.items[0]!.highlight.id;
    await extras.module.createNote({
      highlightId: id,
      body: '**Key point**\n\n<script>window.__x=1</script>\n\n[site](https://example.org)',
    });
    const { container } = await open();
    // Closed card: a chip counts the study notes.
    expect(await screen.findByText('study note', { exact: false })).toBeTruthy();
    await openCard();

    const note = await screen.findByTestId('card-note');
    expect(within(note).getByText('Key point').tagName).toBe('STRONG');
    expect(within(note).getByRole('link', { name: 'site' }).getAttribute('rel')).toContain(
      'noopener',
    );
    expect(container.querySelector('script')).toBeNull();
    expect(note.textContent).toContain('<script>window.__x=1</script>');
  });

  it('adds a note inline, keeps the highlight id and source, and renders it', async () => {
    live();
    store.reset([makeItem()]);
    const item = store.items[0]!;
    await open();
    await openCard();

    await userEvent.click(await screen.findByRole('button', { name: 'Add a note' }));
    const editor = await screen.findByLabelText('New study note (Markdown)');
    expect(document.activeElement).toBe(editor);
    await userEvent.type(editor, 'Remember **ATP**');
    await userEvent.click(screen.getByRole('button', { name: 'Save note' }));

    const shown = await screen.findByTestId('card-note');
    expect(within(shown).getByText('ATP').tagName).toBe('STRONG');
    expect(store.calls.find((c) => c.fn === 'createNote')?.args[0]).toEqual({
      highlightId: item.highlight.id,
      sourceId: item.highlight.sourceId,
      body: 'Remember **ATP**',
    });
    expect(screen.queryByLabelText('New study note (Markdown)')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('Note saved.');
  });

  it('edits a note in place and cancels with Escape without saving', async () => {
    live();
    store.reset([makeItem()]);
    const id = store.items[0]!.highlight.id;
    const note = await extras.module.createNote({ highlightId: id, body: 'First draft' });
    await open();
    await openCard();

    await userEvent.click(
      await screen.findByRole('button', { name: /^Edit this note: First draft/ }),
    );
    const editor = (await screen.findByLabelText('Study note (Markdown)')) as HTMLTextAreaElement;
    expect(editor.value).toBe('First draft');
    await userEvent.type(editor, ' and more{Escape}');
    expect(screen.queryByLabelText('Study note (Markdown)')).toBeNull();
    expect(note.body).toBe('First draft');

    await userEvent.click(screen.getByRole('button', { name: /^Edit this note/ }));
    const again = await screen.findByLabelText('Study note (Markdown)');
    await userEvent.clear(again);
    await userEvent.type(again, 'Final text');
    await userEvent.click(screen.getByRole('button', { name: 'Save note' }));

    expect(await screen.findByText('Final text')).toBeTruthy();
    expect(store.calls.find((c) => c.fn === 'updateNote')?.args).toEqual([
      note.id,
      { body: 'Final text' },
    ]);
  });

  it('refuses an empty note and keeps the text when saving fails', async () => {
    live();
    store.reset([makeItem()]);
    await open();
    await openCard();
    await userEvent.click(await screen.findByRole('button', { name: 'Add a note' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save note' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Write something, or cancel.');
    expect(store.calls.some((c) => c.fn === 'createNote')).toBe(false);

    extras.failNext.createNote = new StudyVaultError('internal', 'Disk hiccup');
    const editor = screen.getByLabelText('New study note (Markdown)');
    await userEvent.type(editor, 'Do not lose me');
    await userEvent.click(screen.getByRole('button', { name: 'Save note' }));
    expect(await screen.findByText(/Not saved: Disk hiccup/)).toBeTruthy();
    expect((editor as HTMLTextAreaElement).value).toBe('Do not lose me');

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Do not lose me')).toBeTruthy();
  });

  it('keeps the first text area of a card for the quick note, so the hand-over still lands there', async () => {
    live();
    store.reset([makeItem()]);
    await open();
    await openCard();
    await userEvent.click(await screen.findByRole('button', { name: 'Add a note' }));
    const card = screen.getByRole('article');
    expect(card.querySelector('textarea')?.id).toBe(
      screen.getByLabelText('Your note').getAttribute('id'),
    );
  });
});

// ---------------------------------------------------------------------------------------------

describe('AI on a card', () => {
  it('explains how to turn AI on and links to the AI section of Options when it is off', async () => {
    live();
    store.reset([makeItem()]);
    await open();
    // Said once, inside the card's More actions (not repeated on every closed card).
    expect(screen.queryByTestId('card-ai-hint')).toBeNull();
    await openCard();
    const hint = await screen.findByTestId('card-ai-hint');
    expect(hint.textContent).toContain('AI drafts are off');
    const link = within(hint).getByRole('link', { name: 'Turn on AI drafts in Options' });
    expect(link.getAttribute('href')).toMatch(/options\.html#ai$/);
    expect(screen.queryByTestId('ai-actions-stub')).toBeNull();
  });

  it('offers the AI actions for this highlight only when the flag is on, and only on request', async () => {
    live();
    store.reset([makeItem()]);
    const id = store.items[0]!.highlight.id;
    await open(features({ ai: true }));
    await openCard();
    const toggle = await screen.findByRole('button', { name: 'AI drafts' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('card-ai-hint')).toBeNull();
    expect(screen.queryByTestId('ai-actions-stub')).toBeNull();

    await userEvent.click(toggle);
    expect((await screen.findByTestId('ai-actions-stub')).textContent).toContain(id);
    await userEvent.click(screen.getByRole('button', { name: 'Open AI settings' }));
    await waitFor(() => expect(created.some((u) => /options\.html#ai$/.test(u))).toBe(true));
  });
});

// ---------------------------------------------------------------------------------------------

describe('Review tab', () => {
  it('shows the live due count on the tab and opens the review page to study', async () => {
    live();
    extras.due = { total: 3, new: 2, learning: 1, review: 0 };
    await open();
    const tab = await screen.findByRole('tab', { name: /^Review.*3/ });
    await userEvent.click(tab);

    expect((await screen.findByTestId('rv-tab-count')).textContent).toBe('3');
    expect(screen.getByRole('list', { name: 'Due mix' }).textContent).toBe(
      '2 new1 learning0 review',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Start review' }));
    await waitFor(() => expect(created).toHaveLength(1));
    const url = new URL(created[0]!);
    expect(url.pathname).toBe('/review.html');
    expect(url.searchParams.get('view')).toBe('study');
    expect(url.searchParams.get('start')).toBe('1');
  });

  it('invites the first flashcard when there are none', async () => {
    live();
    await open();
    await userEvent.click(await screen.findByRole('tab', { name: 'Review' }));
    expect(await screen.findByText('No cards yet')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Create cards' }));
    await waitFor(() => expect(new URL(created[0]!).searchParams.get('view')).toBe('create'));
  });

  it('explains that review is off and where to turn it on', async () => {
    live();
    extras.due = { total: 4, new: 4, learning: 0, review: 0 };
    await open(features({ review: false }));
    const tab = await screen.findByRole('tab', { name: 'Review' }); // no count while it is off
    await userEvent.click(tab);
    expect(await screen.findByText('Review is off')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Start review' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    await waitFor(() => expect(created.some((u) => /options\.html#review$/.test(u))).toBe(true));
  });
});

// ---------------------------------------------------------------------------------------------

describe('daily review notice', () => {
  const raise = () => writeReminderFlag({ at: Date.now(), expiresAt: Date.now() + 3_600_000 });

  it('says how many cards are due above every tab, opens Review, and can be dismissed', async () => {
    live();
    extras.due = { total: 5, new: 5, learning: 0, review: 0 };
    await raise();
    await open();

    expect(await screen.findByText('Time to review: 5 cards due')).toBeTruthy();
    // Above the tabs: it is there on "This page" and stays when another tab is chosen.
    expect(screen.getByRole('tab', { name: /^This page/, selected: true })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Show review' }));
    expect(screen.getByRole('tab', { name: /^Review/, selected: true })).toBeTruthy();
    expect(screen.getByText('Time to review: 5 cards due')).toBeTruthy();
    // On Review itself Start is right there: no "Show review" that would do nothing.
    expect(screen.queryByRole('button', { name: 'Show review' })).toBeNull();
    await waitFor(() => expect(document.activeElement).not.toBe(document.body)); // its button went away

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.queryByText(/Time to review/)).toBeNull());
    expect(await readReminderFlag()).toBeNull();
    expect(document.activeElement?.getAttribute('role')).toBe('tabpanel'); // not <body>
  });

  it('is not there when nothing is due, when none was raised, or while review is off', async () => {
    live();
    await raise();
    await open(); // nothing due
    await screen.findByRole('tab', { name: 'Review' });
    expect(screen.queryByText(/Time to review/)).toBeNull();
    cleanup();

    extras.due = { total: 2, new: 2, learning: 0, review: 0 };
    await writeReminderFlag(null);
    await open();
    await screen.findByRole('tab', { name: /^Review.*2/ });
    expect(screen.queryByText(/Time to review/)).toBeNull();
    cleanup();

    await raise();
    await open(features({ review: false }));
    await screen.findByRole('tab', { name: 'Review' });
    expect(screen.queryByText(/Time to review/)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------

describe('sources', () => {
  it('opens a PDF source in the StudyVault reader at the highlight page and hides the made-up address', async () => {
    live();
    const base = makeItem({ highlight: { exactQuote: 'From the lecture PDF.' } });
    const item = {
      ...base,
      highlight: {
        ...base.highlight,
        anchorSet: { ...base.highlight.anchorSet, type: 'pdf', pageNumber: 12 } as never,
      },
      source: {
        ...base.source,
        title: 'Lecture 4.pdf',
        host: 'studyvault.invalid',
        originalUrl: 'https://studyvault.invalid/pdf/doc-00000001',
        type: 'pdf' as const,
        documentId: 'doc-00000001',
      },
    };
    store.reset([item], []);
    await open();
    await showRecent();

    const card = (await screen.findByText('From the lecture PDF.')).closest('article')!;
    const link = within(card).getByRole('link', { name: 'Open in the PDF reader, page 12' });
    const url = new URL(link.getAttribute('href')!);
    expect(url.pathname).toBe('/pdf-reader.html');
    expect(url.searchParams.get('doc')).toBe('doc-00000001');
    expect(url.searchParams.get('page')).toBe('12');
    expect(url.searchParams.get('highlight')).toBe(item.highlight.id);
    expect(within(card).getByText(/From Lecture 4\.pdf/)).toBeTruthy();
    expect(card.textContent).not.toContain('studyvault.invalid');
    expect(within(card).queryByRole('link', { name: 'Open page' })).toBeNull();
  });

  it('shows no link for an imported highlight that has no reachable address', async () => {
    live();
    const item = makeItem({
      highlight: { exactQuote: 'Imported quote.' },
      source: {
        title: '',
        host: 'studyvault.invalid',
        originalUrl: 'https://studyvault.invalid/imported/abc',
      },
    });
    store.reset([item], []);
    await open();
    await showRecent();
    const card = (await screen.findByText('Imported quote.')).closest('article')!;
    expect(within(card).queryByRole('link', { name: /Open page|PDF reader/ })).toBeNull();
    expect(card.textContent).toContain('From an imported source');
    expect(card.textContent).not.toContain('studyvault.invalid');
  });
});

// ---------------------------------------------------------------------------------------------

describe('bank filter', () => {
  const folder = (id: string, name: string, totalCount: number, children: unknown[] = []) =>
    ({ folder: { id, name }, depth: 1, count: totalCount, totalCount, children }) as never;

  async function openBanks() {
    live();
    const inBio = makeItem({ highlight: { exactQuote: 'Biology only.' }, banks: [BIOLOGY] });
    const inInbox = makeItem({ highlight: { exactQuote: 'Inbox only.' }, banks: [INBOX] });
    store.reset([inBio, inInbox], []);
    store.banks = [INBOX, BIOLOGY];
    await open();
    await userEvent.click(await screen.findByRole('tab', { name: 'Banks' }));
  }
  const openBiology = async () =>
    userEvent.click(await screen.findByRole('button', { name: /^Biology/ }));

  it('opens a bank with its own highlights, narrows Recent to it, then clears', async () => {
    await openBanks();
    await openBiology();
    const head = screen.getByTestId('bank-scope');
    expect(within(head).getByRole('heading', { name: 'Biology' })).toBeTruthy();
    // The open bank lists its highlights in place.
    expect(await screen.findByText('Biology only.')).toBeTruthy();
    expect(screen.queryByText('Inbox only.')).toBeNull();

    await showRecent();
    expect(await screen.findByText('Biology only.')).toBeTruthy();
    expect(screen.queryByText('Inbox only.')).toBeNull();
    expect(screen.getByTestId('recent-scope').textContent).toContain('Only Biology');
    expect(store.calls.find((c) => c.fn === 'listHighlights')?.args[0]).toMatchObject({
      bankId: BIOLOGY.id,
    });

    await userEvent.click(screen.getByRole('button', { name: 'Show everything' }));
    expect(await screen.findByText('Inbox only.')).toBeTruthy();
    expect(screen.queryByTestId('recent-scope')).toBeNull();
    // Back in Banks, the list of banks shows again.
    await userEvent.click(screen.getByRole('tab', { name: 'Banks' }));
    expect(await screen.findByRole('list', { name: 'Your banks' })).toBeTruthy();
  });

  it('goes back to all banks', async () => {
    await openBanks();
    await openBiology();
    await userEvent.click(screen.getByRole('button', { name: 'All banks' }));
    expect(await screen.findByRole('list', { name: 'Your banks' })).toBeTruthy();
    expect(screen.queryByTestId('bank-scope')).toBeNull();
  });

  it('shows folders with counts, expands children and filters to a folder', async () => {
    await openBanks();
    extras.folders[BIOLOGY.id] = [
      folder('fold-cell0001', 'Cell', 5, [folder('fold-organ001', 'Organelles', 2)]),
    ];
    await openBiology();
    const toggle = screen.getByRole('button', { name: 'Show folders of Biology' });
    await userEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    const list = await screen.findByRole('list', { name: 'Folders in Biology' });
    expect(within(list).getByText('Cell')).toBeTruthy();
    expect(within(list).getByText('5')).toBeTruthy();
    expect(within(list).queryByText('Organelles')).toBeNull();

    await userEvent.click(within(list).getByRole('button', { name: 'Expand Cell' }));
    expect(within(list).getByText('Organelles')).toBeTruthy();

    await userEvent.click(
      within(list).getByRole('button', { name: 'Show Organelles in Recent and Search' }),
    );
    expect(screen.getByTestId('folder-scope').textContent).toContain('Only Organelles');
    await userEvent.click(screen.getByRole('button', { name: 'Show all of Biology' }));
    expect(screen.queryByTestId('folder-scope')).toBeNull();
  });

  it('offers chat with a bank only while AI is on; off, the button says why and opens nothing', async () => {
    live();
    store.reset([makeItem({ highlight: { exactQuote: 'Biology only.' }, banks: [BIOLOGY] })], []);
    store.banks = [INBOX, BIOLOGY];
    await open();
    await userEvent.click(await screen.findByRole('tab', { name: 'Banks' }));
    await openBiology();
    const off = await screen.findByRole('button', { name: 'Chat with the notes of Biology (AI)' });
    expect(off.getAttribute('aria-disabled')).toBe('true');
    expect(description(off)).toMatch(/AI features are off/);
    await userEvent.click(off);
    expect(created).toHaveLength(0);
  });

  it('opens the dashboard chat view scoped to the bank when AI is on', async () => {
    live();
    store.reset([makeItem({ highlight: { exactQuote: 'Biology only.' }, banks: [BIOLOGY] })], []);
    store.banks = [INBOX, BIOLOGY];
    await open(features({ ai: true }));
    await userEvent.click(await screen.findByRole('tab', { name: 'Banks' }));
    await openBiology();
    const chat = await screen.findByRole('button', { name: 'Chat with the notes of Biology (AI)' });
    await waitFor(() => expect(chat.getAttribute('aria-disabled')).toBeNull());
    await userEvent.click(chat);
    await waitFor(() => expect(created).toHaveLength(1));
    const url = new URL(created[0]!);
    expect(url.searchParams.get('bank')).toBe(BIOLOGY.id);
    expect(url.searchParams.get('view')).toBe('chat');
  });

  it('says so when a bank has no folders, and offers the dashboard for managing them', async () => {
    await openBanks();
    await openBiology();
    await userEvent.click(screen.getByRole('button', { name: 'Show folders of Biology' }));
    expect(await screen.findByText('No folders in this bank yet.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Open Biology in the dashboard' }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(new URL(created[0]!).searchParams.get('bank')).toBe(BIOLOGY.id);
  });
});

// ---------------------------------------------------------------------------------------------

describe('Search tab', () => {
  async function openSearch() {
    live();
    const a = makeItem({ highlight: { exactQuote: 'Mitochondria produce ATP.' } });
    const b = makeItem({ highlight: { exactQuote: 'Ribosomes build proteins.' } });
    store.reset([a, b], [a.highlight.id]);
    extras.searchDocs = [
      doc(a.highlight.id, {
        quote: 'Mitochondria produce ATP.',
        tags: ['energy'],
        banks: ['Biology'],
      }),
      doc(b.highlight.id, { quote: 'Ribosomes build proteins.', tags: ['protein'] }),
    ];
    await open();
    await userEvent.click(await screen.findByRole('tab', { name: 'Search' }));
    return { a, b };
  }

  const queryBox = () => screen.getByRole('searchbox', { name: 'Search highlights and notes' });

  it('does not open the index until the tab is shown', async () => {
    live();
    await open();
    await screen.findByRole('tab', { name: /This page/ });
    await new Promise((r) => setTimeout(r, 100));
    expect(store.calls.some((c) => c.fn === 'listSearchDocuments')).toBe(false);
    await userEvent.click(screen.getByRole('tab', { name: 'Search' }));
    await waitFor(() => expect(store.calls.some((c) => c.fn === 'listSearchDocuments')).toBe(true));
  });

  it('finds a highlight, marks the matched word as text and reports honest counts', async () => {
    await openSearch();
    await userEvent.type(queryBox(), 'mitochondria');

    const list = await screen.findByTestId('search-results');
    const card = within(list).getByRole('article');
    expect(card.textContent).toContain('Mitochondria produce ATP.');
    expect(card.querySelector('mark')?.textContent).toBe('Mitochondria');
    expect(within(card).getByText('energy')).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId('search-status').textContent).toMatch(/^1 match in/),
    );
    expect(within(list).queryByText(/Ribosomes/)).toBeNull();
  });

  it('shows no results honestly', async () => {
    await openSearch();
    await userEvent.type(queryBox(), 'zyzzyva');
    expect(await screen.findByText('No results')).toBeTruthy();
    expect(screen.queryByTestId('search-results')).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId('search-status').textContent).toBe('No matches.'),
    );
  });

  it('Show on page works for a highlight of the active page and is disabled with a reason otherwise', async () => {
    const { a, b } = await openSearch();
    rpc.tab['content.reveal'] = () => ({ found: true });
    await userEvent.type(queryBox(), 'mitochondria OR ribosomes');
    // Typing is debounced: wait for the whole query, not a match of its first word.
    await waitFor(() => expect(screen.getAllByTestId('search-result')).toHaveLength(2));
    const cards = screen.getAllByTestId('search-result');
    const mine = cards.find((c) => c.getAttribute('data-highlight-id') === a.highlight.id)!;
    const other = cards.find((c) => c.getAttribute('data-highlight-id') === b.highlight.id)!;

    const off = within(other).getByRole('button', { name: 'Show on page' });
    expect(off.getAttribute('aria-disabled')).toBe('true');
    expect(description(off)).toMatch(/from another page/);

    await userEvent.click(within(mine).getByRole('button', { name: 'Show on page' }));
    expect(await within(mine).findByText('Showing this highlight on the page.')).toBeTruthy();
    expect(rpc.called('content.reveal')[0]?.payload).toEqual({ id: a.highlight.id });
  });

  it('opens the dashboard and the flashcard author for a hit', async () => {
    const { a } = await openSearch();
    await userEvent.type(queryBox(), 'mitochondria');
    const card = await screen.findByTestId('search-result');

    await userEvent.click(within(card).getByRole('button', { name: 'Make flashcard' }));
    await waitFor(() => expect(created).toHaveLength(1));
    const flash = new URL(created[0]!);
    expect(flash.pathname).toBe('/review.html');
    expect(flash.searchParams.get('view')).toBe('create');
    expect(flash.searchParams.get('highlight')).toBe(a.highlight.id);

    await userEvent.click(within(card).getByRole('button', { name: 'Open in dashboard' }));
    await waitFor(() => expect(created).toHaveLength(2));
    expect(new URL(created[1]!).searchParams.get('highlight')).toBe(a.highlight.id);
  });

  it('adds facet values and syntax examples to the query with one click', async () => {
    await openSearch();
    await userEvent.type(queryBox(), 'mitochondria');
    await screen.findByTestId('search-results');

    await userEvent.click(screen.getByRole('button', { name: 'Narrow results' }));
    const group = screen.getByRole('group', { name: 'Narrow the results' });
    const chip = within(group).getByRole('button', { name: /^energy/ });
    expect(chip.getAttribute('aria-pressed')).toBe('false');
    await userEvent.click(chip);
    expect((queryBox() as HTMLInputElement).value).toBe('mitochondria tag:"energy"');
    expect(
      within(group)
        .getByRole('button', { name: /^energy/ })
        .getAttribute('aria-pressed'),
    ).toBe('true');

    await userEvent.click(screen.getByRole('button', { name: 'Search syntax' }));
    await userEvent.click(screen.getByRole('button', { name: 'Use kind:formula' }));
    expect((queryBox() as HTMLInputElement).value).toBe('mitochondria tag:"energy" kind:formula');
  });

  it('is confined by the bank filter, says so, and can search everywhere', async () => {
    await openSearch();
    store.banks = [INBOX, BIOLOGY];
    await userEvent.click(screen.getByRole('tab', { name: 'Banks' }));
    await userEvent.click(await screen.findByRole('button', { name: /^Biology/ }));
    await userEvent.click(screen.getByRole('tab', { name: 'Search' }));
    expect(screen.getByTestId('search-scope').textContent).toContain('Only in Biology');

    await userEvent.type(queryBox(), 'ribosomes');
    // The ribosome highlight is not in the Biology bank (its document names no bank).
    expect(await screen.findByText('No results')).toBeTruthy();
    await userEvent.click(screen.getByTestId('search-everywhere'));
    expect(await screen.findByTestId('search-results')).toBeTruthy();
    expect(screen.queryByTestId('search-scope')).toBeNull();
  });

  it('keeps what was typed when another tab is visited', async () => {
    await openSearch();
    await userEvent.type(queryBox(), 'mitochondria');
    await userEvent.click(screen.getByRole('tab', { name: 'Banks' }));
    await userEvent.click(screen.getByRole('tab', { name: 'Search' }));
    expect((queryBox() as HTMLInputElement).value).toBe('mitochondria');
    expect(await screen.findByTestId('search-results')).toBeTruthy();
  });

  it('reports a failed index with the reason and recovers on Retry', async () => {
    live();
    const a = makeItem();
    store.reset([a], []);
    extras.searchDocs = [doc(a.highlight.id)];
    extras.failNext.listSearchDocuments = new Error('Index store unavailable');
    await open();
    await userEvent.click(await screen.findByRole('tab', { name: 'Search' }));

    const note = await screen.findByTestId('search-index-state');
    expect(note.textContent).toContain('Search is unavailable: Index store unavailable');
    await userEvent.click(within(note).getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(screen.queryByTestId('search-index-state')).toBeNull());
    await userEvent.type(queryBox(), 'mitochondria');
    expect(await screen.findByTestId('search-results')).toBeTruthy();
  });

  it('lists what search syntax offers from the engine itself', async () => {
    await openSearch();
    await userEvent.click(screen.getByRole('button', { name: 'Search syntax' }));
    const help = screen.getByTestId('search-help');
    expect(within(help).getByText('kind:formula')).toBeTruthy();
    expect(within(help).getByText('has:note')).toBeTruthy();
  });
});
