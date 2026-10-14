import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { Dashboard } from './Dashboard';
import { FakeVault, type FakeHighlight } from './testing';

const WAIT = { timeout: 4000 };
vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => {
  fakeBrowser.reset();
  window.localStorage.clear();
  window.history.replaceState({}, '', '/dashboard.html?view=library');
});
afterEach(cleanup);

const HIGHLIGHTS: FakeHighlight[] = [
  {
    id: 'hl-00000001',
    quote: 'Mitochondria produce ATP through oxidative phosphorylation.',
    kind: 'essential',
    priority: 4,
    bankIds: ['bank-bio'],
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
];

async function open() {
  const vault = new FakeVault(HIGHLIGHTS);
  vault.addBank('bank-bio', 'Biology');
  render(<Dashboard api={vault.api()} />);
  await screen.findByTestId('dashboard');
  await waitFor(() => expect(screen.queryByTestId('list-loading')).toBeNull(), WAIT);
  await waitFor(() => expect(screen.queryAllByTestId('result-row')).toHaveLength(2), WAIT);
}

/** What the surface's one polite status region holds (the toast provider's). */
const spoken = () => document.querySelector('.sv-toasts__polite')?.textContent ?? '';

describe('dashboard accessibility', () => {
  it('keeps keyboard focus in the list when the bulk bar closes under its own button', async () => {
    await open();
    fireEvent.click(screen.getAllByTestId('result-row')[0]!);
    const clear = await screen.findByTestId('bulk-clear', undefined, WAIT);
    act(() => clear.focus());
    expect(document.activeElement).toBe(clear);

    fireEvent.click(clear);
    await waitFor(() => expect(screen.queryByTestId('bulk-bar')).toBeNull(), WAIT);
    const list = screen.getByRole('listbox', { name: 'Highlights' });
    await waitFor(() => expect(document.activeElement).toBe(list), WAIT);
  });

  it('says which view is showing when a view button replaces the page under it', async () => {
    await open();
    expect(spoken()).not.toContain('Trash');
    fireEvent.click(screen.getByTestId('nav-more'));
    fireEvent.click(screen.getByTestId('view-trash'));
    await screen.findByTestId('trash-view', undefined, WAIT);
    await waitFor(() => expect(spoken()).toContain('Trash'), WAIT);
  });

  it('says how many highlights a filter leaves, without announcing the first load', async () => {
    await open();
    expect(spoken()).toBe('');
    const kind = screen.getByTestId('filter-kind');
    fireEvent.click(within(kind).getByText('Kind'));
    fireEvent.click(within(kind).getByRole('checkbox', { name: /Formula/ }));
    await waitFor(() => expect(screen.queryAllByTestId('result-row')).toHaveLength(1), WAIT);
    await waitFor(() => expect(spoken()).toContain('1 highlight'), WAIT);
  });

  it('lets the / and ? keys be turned off (WCAG 2.1.4)', async () => {
    await open();
    const search = screen.getByTestId('search-input');
    fireEvent.keyDown(document.body, { key: '/' });
    expect(document.activeElement).toBe(search);
    act(() => (search as HTMLElement).blur());
    fireEvent.keyDown(document.body, { key: '?' });
    const legend = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    fireEvent.click(within(legend).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), WAIT);

    fireEvent.change(screen.getByTestId('opt-singlekeys'), { target: { value: 'off' } });
    fireEvent.keyDown(document.body, { key: '/' });
    expect(document.activeElement).not.toBe(search);
    fireEvent.keyDown(document.body, { key: '?' });
    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull();

    // The same switch is a palette command, and Ctrl+K (a modified key) is unaffected.
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const input = await screen.findByTestId('palette-input');
    fireEvent.change(input, { target: { value: 'shortcut keys' } });
    const option = within(screen.getByTestId('palette-list')).getByRole('option');
    expect(option.getAttribute('data-command-id')).toBe('single-keys-toggle');
    expect(option.textContent).toContain('on');
  });
});

describe('dashboard accessibility: narrow layouts, where the panes are panels over the page', () => {
  const narrow = (matches: boolean) => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({
        matches,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    });
  };
  afterEach(() => {
    Reflect.deleteProperty(window, 'matchMedia');
  });

  it('the Banks button takes focus into the tree, Escape closes the panel and returns to it', async () => {
    narrow(true);
    await open();
    const toggle = screen.getByTestId('toggle-tree');
    const dash = screen.getByTestId('dashboard');
    expect(dash.getAttribute('data-tree-open')).toBe('false');

    fireEvent.click(toggle);
    await waitFor(() => expect(dash.getAttribute('data-tree-open')).toBe('true'), WAIT);
    await waitFor(
      () => expect(document.activeElement?.getAttribute('role')).toBe('treeitem'),
      WAIT,
    );

    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(dash.getAttribute('data-tree-open')).toBe('false'), WAIT);
    expect(document.activeElement).toBe(toggle);
  });

  it('choosing another view closes the panel instead of leaving it over that view', async () => {
    narrow(true);
    await open();
    const dash = screen.getByTestId('dashboard');
    fireEvent.click(screen.getByTestId('toggle-tree'));
    await waitFor(() => expect(dash.getAttribute('data-tree-open')).toBe('true'), WAIT);
    fireEvent.click(screen.getByTestId('nav-more'));
    await screen.findByTestId('more-view', undefined, WAIT);
    expect(dash.getAttribute('data-tree-open')).toBe('false');
  });

  it('Escape in the list closes the preview panel the arrow keys opened', async () => {
    narrow(true);
    await open();
    const list = screen.getByRole('listbox', { name: 'Highlights' });
    act(() => list.focus());
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(await screen.findByTestId('preview-quote', undefined, WAIT)).toBeTruthy();
    const dash = screen.getByTestId('dashboard');
    expect(dash.getAttribute('data-preview-open')).toBe('true');

    fireEvent.keyDown(list, { key: 'Escape' });
    await waitFor(() => expect(dash.getAttribute('data-preview-open')).toBe('false'), WAIT);
    expect(document.activeElement).toBe(list);
  });

  it('leaves the docked preview alone on wide screens', async () => {
    narrow(false);
    await open();
    const list = screen.getByRole('listbox', { name: 'Highlights' });
    act(() => list.focus());
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    await screen.findByTestId('preview-quote', undefined, WAIT);
    fireEvent.keyDown(list, { key: 'Escape' });
    expect(screen.getByTestId('dashboard').getAttribute('data-preview-open')).toBe('true');
  });
});
