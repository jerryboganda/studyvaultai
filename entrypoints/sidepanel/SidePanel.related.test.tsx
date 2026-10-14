import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { defaultSettings, type PageStatus, type SearchDocument } from '@shared';
import { makeChromeFakes, makeItem, rpc, store } from '@ui/testing/fakes';
import { SidePanel } from './SidePanel';
import { extras, openCard } from './testing';

/**
 * Related highlights under a card of the side panel: closed and free until asked, then computed by
 * the same lexical index the Search tab uses (opened by this very click, not before).
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

const doc = (id: string, quote: string, over: Partial<SearchDocument> = {}): SearchDocument => ({
  id,
  docType: 'highlight',
  highlightId: id,
  title: 'Cell biology notes',
  url: 'https://example.com/notes',
  host: 'example.com',
  quote,
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

const A = 'Mitochondria produce ATP through oxidative phosphorylation.';
const B =
  'Oxidative phosphorylation takes place in the inner mitochondrial membrane of mitochondria.';
const C = 'Ribosomes build proteins from messenger RNA.';

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

async function openPanel(quotes: string[]) {
  rpc.tab['content.pageStatus'] = () => status();
  rpc.tab['content.refresh'] = () => ({ ok: true });
  const items = quotes.map((q) => makeItem({ highlight: { exactQuote: q } }));
  // only the first one is on the page, so "This page" shows one card
  store.reset(items, [items[0]!.highlight.id]);
  extras.searchDocs = items.map((it, i) =>
    doc(it.highlight.id, quotes[i]!, {
      title: i === 1 ? 'Respiration review' : 'Cell biology notes',
    }),
  );
  await browser.storage.local.set({ settings: defaultSettings() });
  vi.spyOn(browser.tabs, 'query').mockImplementation((async (q: { url?: string }) =>
    q.url
      ? []
      : [
          {
            id: 11,
            url: 'https://example.com/notes',
            title: 'Cell biology notes',
            windowId: 1,
            active: true,
            index: 0,
          },
        ]) as never);
  render(<SidePanel />);
  // Related sits in the card's "More actions".
  await openCard();
  return items;
}

const indexOpened = () => store.calls.some((c) => c.fn === 'listSearchDocuments');

describe('Related highlights in the side panel', () => {
  it('is closed under the card and opens no index until it is asked', async () => {
    await openPanel([A, B, C]);
    const toggle = await screen.findByTestId('related-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await new Promise((r) => setTimeout(r, 100));
    expect(indexOpened()).toBe(false);
    expect(screen.queryByTestId('related-item')).toBeNull();
  });

  it('opens the index, lists the related highlight with its shared words and opens it in the dashboard', async () => {
    const [a, b] = await openPanel([A, B, C]);
    await userEvent.click(await screen.findByTestId('related-toggle'));
    await waitFor(() => expect(indexOpened()).toBe(true));

    const item = await screen.findByTestId('related-item');
    expect(item.getAttribute('data-highlight-id')).toBe(b!.highlight.id);
    expect(item.textContent).toContain('Oxidative phosphorylation takes place');
    const why = within(item).getByTestId('related-why').textContent ?? '';
    expect(why).toMatch(/^shares: /);
    for (const word of ['mitochondria', 'oxidative', 'phosphorylation']) {
      expect(why.toLowerCase()).toContain(word);
    }
    // the ribosome highlight shares nothing, and the card's own highlight is never listed
    expect(screen.getAllByTestId('related-item')).toHaveLength(1);
    expect(screen.queryByText(/Ribosomes/)).toBeNull();

    created.length = 0;
    await userEvent.click(within(item).getByTestId('related-open'));
    await waitFor(() => expect(created).toHaveLength(1));
    const url = new URL(created[0]!);
    expect(url.pathname).toBe('/dashboard.html');
    expect(url.searchParams.get('highlight')).toBe(b!.highlight.id);
    expect(url.searchParams.get('highlight')).not.toBe(a!.highlight.id);
  });

  it('says honestly that nothing shares words yet', async () => {
    await openPanel([A, C]);
    await userEvent.click(await screen.findByTestId('related-toggle'));
    const summary = await screen.findByTestId('related-summary');
    expect(summary.textContent).toMatch(/^No other highlight shares enough words/);
    expect(screen.queryByTestId('related-item')).toBeNull();
  });
});
