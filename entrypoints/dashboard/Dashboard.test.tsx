import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { deserializeSavedSearches } from '@search';
import { Dashboard } from './Dashboard';
import { INDEX_KEY, INDEX_STATE_KEY } from '@ui/vault/searchHost';
import { SAVED_SEARCHES_KEY } from './SavedSearches';
import { FakeVault, manyHighlights, type FakeHighlight } from './testing';

const WAIT = { timeout: 4000 };
vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => {
  fakeBrowser.reset();
  window.localStorage.clear();
  window.history.replaceState({}, '', '/dashboard.html');
});
afterEach(() => {
  cleanup();
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});

const BIO: FakeHighlight[] = [
  {
    id: 'hl-00000001',
    quote: 'Mitochondria produce ATP through oxidative phosphorylation.',
    kind: 'essential',
    priority: 4,
    bankIds: ['bank-bio'],
    tagIds: ['tag-energy'],
    title: 'Cell energy',
    host: 'bio.example',
    url: 'https://bio.example/energy',
  },
  {
    id: 'hl-00000002',
    quote: 'The Golgi apparatus modifies and packages proteins.',
    kind: 'formula',
    priority: 2,
    bankIds: ['bank-bio'],
    title: 'Cell organelles',
    host: 'bio.example',
    url: 'https://bio.example/organelles',
  },
  {
    id: 'hl-00000003',
    quote: 'Ribosomes translate messenger RNA into protein.',
    kind: 'exception',
    priority: 5,
    title: 'Translation',
    host: 'genes.example',
    url: 'https://genes.example/translation',
  },
];

function vaultWith(highlights: FakeHighlight[] = BIO) {
  const vault = new FakeVault(highlights);
  vault.addBank('bank-bio', 'Biology');
  vault.tags.push({ id: 'tag-energy', name: 'energy' });
  return vault;
}

async function openDashboard(vault: FakeVault, search = '') {
  window.history.replaceState({}, '', `/dashboard.html${search}`);
  render(<Dashboard api={vault.api()} />);
  await screen.findByTestId('dashboard');
  await waitFor(() => expect(screen.queryByTestId('list-loading')).toBeNull(), WAIT);
}

const rows = () => screen.queryAllByTestId('result-row');
const searchBox = () => screen.getByTestId('search-input') as HTMLInputElement;
const list = (name = 'Highlights') => screen.getByRole('listbox', { name });
const typeQuery = (text: string) => fireEvent.change(searchBox(), { target: { value: text } });

describe('Dashboard: browsing', () => {
  it('lists the vault newest first, with the bank tree and counts', async () => {
    await openDashboard(vaultWith());
    await waitFor(() => expect(rows()).toHaveLength(3), WAIT);
    expect(rows()[0]!.textContent).toContain('Ribosomes translate');
    expect(screen.getByTestId('result-summary').textContent).toContain('3 highlights');
    expect(screen.getByTestId('view-library').textContent).toContain('3');
    const tree = screen.getByRole('tree', { name: 'Banks and folders' });
    expect(within(tree).getByRole('treeitem', { name: /Biology/ })).toBeTruthy();
    expect(within(tree).getByRole('treeitem', { name: /Inbox/ })).toBeTruthy();
  });

  it('shows the exact quote and provenance of the clicked row in the preview', async () => {
    await openDashboard(vaultWith());
    await waitFor(() => expect(rows()).toHaveLength(3), WAIT);
    fireEvent.click(rows()[1]!);
    const quote = await screen.findByTestId('preview-quote', undefined, WAIT);
    expect(quote.textContent).toBe('The Golgi apparatus modifies and packages proteins.');
    expect(screen.getByTestId('preview-provenance').textContent).toContain('Cell organelles');
  });

  it('opens a deep-linked highlight, bank and query', async () => {
    const vault = vaultWith();
    await openDashboard(vault, '?highlight=hl-00000001');
    const quote = await screen.findByTestId('preview-quote', undefined, WAIT);
    expect(quote.textContent).toContain('Mitochondria produce ATP');
    cleanup();

    await openDashboard(vault, '?bank=bank-bio');
    await waitFor(() => expect(rows()).toHaveLength(2), WAIT);
    const lastQuery = vault.called('listHighlights').at(-1)!.args[0] as { bankId?: string };
    expect(lastQuery.bankId).toBe('bank-bio');
    cleanup();

    await openDashboard(vault, '?q=golgi');
    expect(searchBox().value).toBe('golgi');
    await waitFor(
      () => expect(screen.getByTestId('result-summary').textContent).toContain('1 result'),
      WAIT,
    );
  });

  it('scopes the list to a bank when its tree node is chosen', async () => {
    const vault = vaultWith();
    await openDashboard(vault);
    await waitFor(() => expect(rows()).toHaveLength(3), WAIT);
    fireEvent.click(screen.getByRole('treeitem', { name: /Biology/ }));
    await waitFor(() => expect(rows()).toHaveLength(2), WAIT);
    expect(rows().every((r) => !r.textContent?.includes('Ribosomes'))).toBe(true);
  });

  it('narrows by filters and shows them as removable chips', async () => {
    const vault = vaultWith();
    await openDashboard(vault);
    await waitFor(() => expect(rows()).toHaveLength(3), WAIT);
    const kind = screen.getByTestId('filter-kind');
    fireEvent.click(within(kind).getByText('Kind'));
    fireEvent.click(within(kind).getByRole('checkbox', { name: /Formula/ }));
    await waitFor(() => expect(rows()).toHaveLength(1), WAIT);
    expect(rows()[0]!.textContent).toContain('Golgi');
    expect(screen.getByRole('list', { name: 'Active filters' }).textContent).toContain('Formula');

    fireEvent.click(screen.getByTestId('clear-filters'));
    await waitFor(() => expect(rows()).toHaveLength(3), WAIT);
  });

  it('sorts by priority', async () => {
    await openDashboard(vaultWith());
    await waitFor(() => expect(rows()).toHaveLength(3), WAIT);
    fireEvent.change(screen.getByTestId('sort-select'), { target: { value: 'priority-desc' } });
    await waitFor(() => expect(rows()[0]!.textContent).toContain('Ribosomes'), WAIT);
    expect(rows()[2]!.textContent).toContain('Golgi');
  });

  it('moves focus to the preview on Enter and back to the list on Escape', async () => {
    await openDashboard(vaultWith());
    await waitFor(() => expect(rows()).toHaveLength(3), WAIT);
    const box = list();
    act(() => box.focus());
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'Enter' });
    const pane = screen.getByTestId('preview-pane');
    await waitFor(() => expect(document.activeElement).toBe(pane), WAIT);
    await screen.findByTestId('preview-quote', undefined, WAIT);
    fireEvent.keyDown(pane, { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(box), WAIT);
    expect(await screen.findByTestId('preview-empty', undefined, WAIT)).toBeTruthy();
  });

  it('closes a filter popover with Escape and when pressing elsewhere', async () => {
    await openDashboard(vaultWith());
    const kind = screen.getByTestId('filter-kind') as HTMLDetailsElement;
    const summary = within(kind).getByText('Kind');
    fireEvent.click(summary);
    kind.open = true;
    expect(kind.open).toBe(true);
    fireEvent.keyDown(within(kind).getByRole('checkbox', { name: /Formula/ }), { key: 'Escape' });
    expect(kind.open).toBe(false);
    expect(document.activeElement).toBe(summary.closest('summary'));

    kind.open = true;
    fireEvent.pointerDown(searchBox());
    expect(kind.open).toBe(false);
  });

  it('shows the empty vault state', async () => {
    await openDashboard(new FakeVault());
    expect(await screen.findByText('Your vault is empty', undefined, WAIT)).toBeTruthy();
  });
});

describe('Dashboard: search', () => {
  it('searches the hosted index, marks matches as text, and offers facets', async () => {
    await openDashboard(vaultWith());
    typeQuery('golgi');
    await waitFor(() => expect(rows()).toHaveLength(1), WAIT);
    const mark = rows()[0]!.querySelector('mark');
    expect(mark?.textContent?.toLowerCase()).toBe('golgi');
    expect(list('Search results')).toBeTruthy();
    expect(screen.getByTestId('result-summary').textContent).toContain('1 result');
    expect((await screen.findAllByTestId('facet-bank')).length).toBeGreaterThan(0);
  });

  it('turns a facet chip into a query filter', async () => {
    await openDashboard(vaultWith());
    typeQuery('cell OR ribosomes OR mitochondria');
    await waitFor(() => expect(rows().length).toBeGreaterThan(0), WAIT);
    const chips = await screen.findAllByTestId('facet-bank');
    const biology = chips.find((c) => c.textContent?.includes('Biology'))!;
    fireEvent.click(biology);
    await waitFor(() => expect(searchBox().value).toContain('bank:"Biology"'), WAIT);
    await waitFor(() => expect(rows()).toHaveLength(2), WAIT);
    expect(
      screen
        .getAllByTestId('facet-bank')
        .find((c) => c.textContent?.includes('Biology'))!
        .getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('applies the structured filters to a text search through the grammar', async () => {
    await openDashboard(vaultWith());
    // The user's own OR must not swallow the filters appended to it.
    typeQuery('protein OR proteins OR atp');
    await waitFor(
      () => expect(screen.getByTestId('result-summary').textContent).toContain('3 results'),
      WAIT,
    );
    const kind = screen.getByTestId('filter-kind');
    fireEvent.click(within(kind).getByText('Kind'));
    fireEvent.click(within(kind).getByRole('checkbox', { name: /Essential fact/ }));
    await waitFor(() => expect(rows()).toHaveLength(1), WAIT);
    expect(rows()[0]!.textContent).toContain('Mitochondria');
  });

  it('says what happened when nothing matches', async () => {
    await openDashboard(vaultWith());
    typeQuery('qqqqzzzz');
    expect(await screen.findByText(/No results for/, undefined, WAIT)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Clear the search' })).toBeTruthy();
  });

  it('offers a correction for a misspelt word and applies it on request', async () => {
    await openDashboard(vaultWith());
    typeQuery('golgii apparatus');
    const suggestion = await screen.findByTestId('did-you-mean', undefined, WAIT);
    expect(suggestion.textContent).toContain('golgi apparatus');
    fireEvent.click(within(suggestion).getByRole('button', { name: 'golgi apparatus' }));
    expect(searchBox().value).toBe('golgi apparatus');
    await waitFor(() => expect(rows()).toHaveLength(1), WAIT);
  });

  it('documents the grammar and inserts an example into the box', async () => {
    await openDashboard(vaultWith());
    fireEvent.click(screen.getByTestId('search-help-toggle'));
    const help = screen.getByTestId('search-help');
    expect(help.textContent).toContain('bank:Cardiology');
    expect(help.textContent).toContain('priority:>=3');
    const row = within(help).getByText('has:note').closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Use' }));
    expect(searchBox().value).toBe('has:note');
  });

  it('warns about a filter the grammar does not know', async () => {
    await openDashboard(vaultWith());
    typeQuery('colour:red golgi');
    const warnings = await screen.findByTestId('search-warnings', undefined, WAIT);
    expect(warnings.textContent?.toLowerCase()).toContain('colour');
  });

  it('shows the index building state with real progress, and still browses', async () => {
    const vault = vaultWith(manyHighlights(1_300));
    const api = vault.api();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = api.listSearchDocuments;
    let calls = 0;
    api.listSearchDocuments = async (o) => {
      calls++;
      if (calls === 2) await gate; // hold the build half way
      return original(o);
    };
    window.history.replaceState({}, '', '/dashboard.html');
    render(<Dashboard api={api} />);
    await screen.findByTestId('dashboard');
    typeQuery('mitochondria');
    expect(await screen.findByText(/not ready yet/, undefined, WAIT)).toBeTruthy();
    const status = await screen.findByText(/of 1,300/, undefined, WAIT);
    expect(status.textContent).toMatch(/Building the search index: 500 of 1,300/);
    expect(screen.getByRole('progressbar', { name: 'Search index progress' })).toBeTruthy();

    // Clearing the box browses even while the index is still building.
    typeQuery('');
    await waitFor(() => expect(rows().length).toBeGreaterThan(0), WAIT);
    await act(async () => release());
    typeQuery('mitochondria');
    await waitFor(
      () => expect(screen.getByTestId('result-summary').textContent).toMatch(/1,300 results/),
      WAIT,
    );
  });

  it('writes the index to the meta table when the page is hidden', async () => {
    const vault = vaultWith();
    await openDashboard(vault);
    await waitFor(() => expect(screen.getByTestId('search-input')).toBeTruthy());
    typeQuery('golgi');
    await waitFor(() => expect(rows()).toHaveLength(1), WAIT);
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(typeof vault.metaStore.get(INDEX_KEY)).toBe('string'), WAIT);
    expect(vault.metaStore.get(INDEX_STATE_KEY)).toMatchObject({ v: 1 });
  });

  it('keeps search results current when the vault changes', async () => {
    const vault = vaultWith();
    await openDashboard(vault);
    typeQuery('golgi');
    await waitFor(() => expect(rows()).toHaveLength(1), WAIT);
    vault.addHighlight({ id: 'hl-00000009', quote: 'Golgi vesicles bud from the trans face.' });
    // A write from another surface announces itself through the change epoch.
    await act(async () => {
      await fakeBrowser.storage.session.set({ dataEpoch: 'x' });
      await fakeBrowser.storage.local.set({ dataEpoch: String(Math.random()) });
    });
    await waitFor(() => expect(rows()).toHaveLength(2), WAIT);
  });

  it('saves and runs a named search', async () => {
    const vault = vaultWith();
    await openDashboard(vault);
    typeQuery('golgi');
    await waitFor(() => expect(rows()).toHaveLength(1), WAIT);
    const save = screen.getByTestId('saved-search-save');
    fireEvent.change(screen.getByTestId('saved-search-name'), { target: { value: 'Organelles' } });
    fireEvent.click(save);
    await waitFor(() => expect(vault.metaStore.has(SAVED_SEARCHES_KEY)).toBe(true), WAIT);
    expect(
      deserializeSavedSearches(vault.metaStore.get(SAVED_SEARCHES_KEY)).items[0],
    ).toMatchObject({
      name: 'Organelles',
      query: 'golgi',
    });

    typeQuery('');
    await waitFor(() => expect(rows()).toHaveLength(3), WAIT);
    fireEvent.click(await screen.findByTestId('saved-search-run'));
    expect(searchBox().value).toBe('golgi');
    await waitFor(() => expect(rows()).toHaveLength(1), WAIT);
  });
});

describe('Dashboard: selection and bulk actions', () => {
  it('selects with the keyboard, trashes the selection and undoes it', async () => {
    const vault = vaultWith();
    await openDashboard(vault);
    await waitFor(() => expect(rows()).toHaveLength(3), WAIT);
    const box = list();
    act(() => box.focus());
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'ArrowDown', shiftKey: true });
    await waitFor(() => expect(screen.getByTestId('bulk-count').textContent).toContain('2'), WAIT);

    fireEvent.keyDown(box, { key: 'Delete' });
    await waitFor(() => expect(vault.called('bulkDelete')).toHaveLength(1), WAIT);
    expect((vault.called('bulkDelete')[0]!.args[0] as string[]).sort()).toEqual([
      'hl-00000002',
      'hl-00000003',
    ]);
    await waitFor(() => expect(rows()).toHaveLength(1), WAIT);

    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(vault.called('bulkRestore')).toHaveLength(1), WAIT);
    await waitFor(() => expect(rows()).toHaveLength(3), WAIT);
  });

  it('selects everything that matches, beyond the loaded rows, and applies one change', async () => {
    const vault = vaultWith(manyHighlights(250));
    await openDashboard(vault);
    await waitFor(() => expect(rows().length).toBeGreaterThan(0), WAIT);
    fireEvent.click(rows()[0]!);
    fireEvent.click(await screen.findByTestId('select-all-filtered'));
    expect(screen.getByTestId('bulk-count').textContent).toContain('250');

    fireEvent.click(screen.getByTestId('bulk-priority'));
    fireEvent.click(screen.getByRole('menuitem', { name: /Priority 5/ }));
    await waitFor(() => expect(vault.called('bulkSetPriority')).toHaveLength(1), WAIT);
    const ids = vault.called('bulkSetPriority')[0]!.args[0] as string[];
    expect(ids).toHaveLength(250);
    expect(new Set(ids).size).toBe(250);
  });

  it('asks before moving a large selection to the trash', async () => {
    const vault = vaultWith(manyHighlights(60));
    await openDashboard(vault);
    await waitFor(() => expect(rows().length).toBeGreaterThan(0), WAIT);
    const box = list();
    act(() => box.focus());
    fireEvent.keyDown(box, { key: 'a', ctrlKey: true });
    await waitFor(() => expect(screen.getByTestId('bulk-count').textContent).toContain('60'), WAIT);
    fireEvent.keyDown(box, { key: 'Delete' });
    const dialog = screen.getByRole('dialog', { hidden: true });
    expect(dialog.textContent).toContain('60 highlights');
    expect(vault.called('bulkDelete')).toHaveLength(0);
    fireEvent.click(within(dialog).getByTestId('dialog-confirm'));
    await waitFor(() => expect(vault.called('bulkDelete')).toHaveLength(1), WAIT);
  });

  it('moves the selection to another bank', async () => {
    const vault = vaultWith();
    await openDashboard(vault);
    await waitFor(() => expect(rows()).toHaveLength(3), WAIT);
    fireEvent.click(rows()[0]!);
    fireEvent.click(screen.getByTestId('bulk-move'));
    const dialog = screen.getByRole('dialog', { hidden: true });
    fireEvent.change(within(dialog).getByTestId('place-bank'), { target: { value: 'bank-bio' } });
    fireEvent.click(within(dialog).getByTestId('dialog-confirm'));
    await waitFor(() => expect(vault.called('bulkMove')).toHaveLength(1), WAIT);
    expect(vault.called('bulkMove')[0]!.args[0]).toMatchObject({
      highlightIds: ['hl-00000003'],
      toBankId: 'bank-bio',
      folderId: null,
    });
  });

  it('tags the selection, creating a new tag when asked', async () => {
    const vault = vaultWith();
    await openDashboard(vault);
    await waitFor(() => expect(rows()).toHaveLength(3), WAIT);
    fireEvent.click(rows()[0]!);
    fireEvent.click(screen.getByTestId('bulk-tags'));
    const dialog = screen.getByRole('dialog', { hidden: true });
    fireEvent.change(within(dialog).getByTestId('bulk-new-tag'), { target: { value: 'revise' } });
    fireEvent.click(within(dialog).getAllByTestId('bulk-add-tag')[0]!);
    fireEvent.click(within(dialog).getByTestId('dialog-confirm'));
    await waitFor(() => expect(vault.called('bulkTag')).toHaveLength(1), WAIT);
    expect(vault.called('createTag')[0]!.args).toEqual(['revise']);
    const input = vault.called('bulkTag')[0]!.args[0] as { addTagIds: string[] };
    expect(input.addTagIds).toHaveLength(2);
  });
});

describe('Dashboard: large vault', () => {
  it('renders a window of 10,000 highlights and pages the rest in', async () => {
    const vault = vaultWith(manyHighlights(10_000));
    await openDashboard(vault);
    await waitFor(() => expect(rows().length).toBeGreaterThan(0), WAIT);
    expect(rows().length).toBeLessThan(40);
    expect(screen.getByTestId('result-summary').textContent).toContain('10,000 highlights');
    expect(screen.getByTestId('result-summary').textContent).toContain('100 loaded');
    const box = list();
    expect(box.firstElementChild!.getAttribute('style')).toContain('height: 13200px');

    act(() => box.focus());
    box.scrollTop = 13_200 - 600;
    fireEvent.scroll(box);
    await waitFor(() => expect(vault.called('listHighlights').length).toBeGreaterThan(1), WAIT);
    await waitFor(
      () => expect(screen.getByTestId('result-summary').textContent).toContain('200 loaded'),
      WAIT,
    );
    expect(rows().length).toBeLessThan(40);
  }, 30_000);
});

describe('Dashboard: commands and navigation', () => {
  it('opens the palette with Ctrl+K and runs a real action', async () => {
    await openDashboard(vaultWith());
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const input = await screen.findByTestId('palette-input');
    const ids = within(screen.getByTestId('palette-list'))
      .getAllByRole('option')
      .map((o) => o.getAttribute('data-command-id'));
    expect(ids).toEqual(
      expect.arrayContaining([
        'view-trash',
        'view-duplicates',
        'view-storage',
        'focus-search',
        'select-loaded',
        'index-rebuild',
        'bank-bank-bio',
        'theme-dark',
        'density-compact',
        'contrast-toggle',
      ]),
    );
    fireEvent.change(input, { target: { value: 'trash' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByTestId('trash-view', undefined, WAIT)).toBeTruthy();
  });

  it('lists commands that cannot run yet with the reason', async () => {
    await openDashboard(vaultWith());
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const input = await screen.findByTestId('palette-input');
    fireEvent.change(input, { target: { value: 'selection to the trash' } });
    const option = within(screen.getByTestId('palette-list')).getByRole('option');
    expect(option.getAttribute('aria-disabled')).toBe('true');
    expect(option.textContent).toContain('Select highlights in the list first.');
  });

  it('focuses the search box with / and cycles panes with F6', async () => {
    await openDashboard(vaultWith());
    fireEvent.keyDown(document.body, { key: '/' });
    expect(document.activeElement).toBe(searchBox());
    act(() => (document.activeElement as HTMLElement).blur());
    fireEvent.keyDown(document.body, { key: 'F6' });
    // Focus lands on the first pane (the bank tree) and then on each further pane.
    await waitFor(
      () => expect(document.activeElement?.getAttribute('role')).toBe('treeitem'),
      WAIT,
    );
    fireEvent.keyDown(document.activeElement!, { key: 'F6' });
    await waitFor(() => expect(document.activeElement).toBe(searchBox()), WAIT);
  });

  it('switches to the duplicate, trash and storage views', async () => {
    await openDashboard(vaultWith());
    fireEvent.click(screen.getByTestId('view-duplicates'));
    expect(await screen.findByTestId('duplicates-view', undefined, WAIT)).toBeTruthy();
    fireEvent.click(screen.getByTestId('view-trash'));
    expect(await screen.findByTestId('trash-view', undefined, WAIT)).toBeTruthy();
    fireEvent.click(screen.getByTestId('view-storage'));
    expect(await screen.findByTestId('storage-panel', undefined, WAIT)).toBeTruthy();
    expect((await screen.findByTestId('storage-total-rows', undefined, WAIT)).textContent).toMatch(
      /^\d/,
    );
    fireEvent.click(screen.getByTestId('view-library'));
    await waitFor(() => expect(rows()).toHaveLength(3), WAIT);
  });

  it('applies the density and contrast choices to the page', async () => {
    await openDashboard(vaultWith());
    fireEvent.change(screen.getByTestId('opt-contrast'), { target: { value: 'high' } });
    expect(document.documentElement.dataset.contrast).toBe('high');
    const density = screen.getByTestId('opt-density') as HTMLSelectElement;
    await waitFor(() => expect(density.disabled).toBe(false), WAIT);
    fireEvent.change(density, { target: { value: 'compact' } });
    await waitFor(
      () => expect(screen.getByTestId('dashboard').getAttribute('data-density')).toBe('compact'),
      WAIT,
    );
    fireEvent.change(screen.getByTestId('opt-contrast'), { target: { value: 'auto' } });
    expect(document.documentElement.dataset.contrast).toBeUndefined();
  });
});
