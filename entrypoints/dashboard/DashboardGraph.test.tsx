import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { browser } from 'wxt/browser';
import { createRelation, listAllRelations, restoreHighlight, softDeleteHighlight } from '@storage';
import { freshDatabase, save } from '@storage/test-vault';
import { makeChromeFakes } from '@ui/testing/fakes';
import { Dashboard } from './Dashboard';

/**
 * The dashboard against the REAL vault (Dexie on fake-indexeddb): the Links section of the preview,
 * the way into the graph view, and back. The pieces are covered on their own in Links.test.tsx and
 * GraphView.test.tsx.
 */

configure({ asyncUtilTimeout: 15_000 });
vi.setConfig({ testTimeout: 60_000 });

const Q1 = 'Aspirin irreversibly inhibits cyclooxygenase in platelets.';
const Q2 = 'Clopidogrel blocks the P2Y12 receptor on platelets.';

beforeEach(async () => {
  await freshDatabase();
  Object.assign(browser, makeChromeFakes());
  window.localStorage.clear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(cleanup);

async function vault() {
  const h1 = await save(Q1, {}, 100);
  const h2 = await save(Q2, {}, 600);
  await createRelation({
    fromKind: 'highlight',
    fromId: h1.id,
    toKind: 'highlight',
    toId: h2.id,
    type: 'supports',
  });
  return { h1, h2 };
}

async function open(search: string) {
  window.history.replaceState({}, '', `/dashboard.html${search}`);
  render(<Dashboard />);
  await screen.findByTestId('dashboard');
  await screen.findByTestId('preview');
}

const toggle = () => screen.getByTestId('links-toggle');
const previewQuote = () => screen.getByTestId('preview-quote').textContent;

describe('Dashboard: links and the graph', () => {
  it('shows the links of the previewed highlight, collapsed, with their count', async () => {
    const { h1 } = await vault();
    await open(`?highlight=${h1.id}`);
    const section = screen.getByTestId('preview-links');
    expect(within(section).getByRole('heading', { name: 'Links' })).toBeTruthy();
    await waitFor(() => expect(toggle().textContent).toBe('Show links (1)'));
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('link-item')).toBeNull();

    await userEvent.click(toggle());
    const item = await screen.findByTestId('link-item');
    expect(within(item).getByTestId('link-phrase').textContent).toBe('Supports');
    expect(within(item).getByTestId('link-text').textContent).toBe(Q2);
  });

  it('opens the graph around the highlight, walks it with the keyboard and opens the other end', async () => {
    const { h1, h2 } = await vault();
    await open(`?highlight=${h1.id}`);
    await userEvent.click(toggle());
    await userEvent.click(await screen.findByTestId('link-graph'));

    const view = await screen.findByTestId('graph-view');
    expect(within(view).getByRole('heading', { name: 'Knowledge graph', level: 2 })).toBeTruthy();
    expect(screen.getByTestId('view-graph').getAttribute('aria-current')).toBe('page');
    await waitFor(() => expect(screen.getAllByTestId('graph-node')).toHaveLength(2));
    expect(screen.getByTestId('graph-summary').textContent).toBe('2 items and 1 link.');
    const nodeOf = (id: string) =>
      screen
        .getAllByTestId('graph-node')
        .find((n) => n.getAttribute('data-node') === `highlight:${id}`)!;
    await waitFor(() => expect(nodeOf(h2.id).getAttribute('aria-label')).toContain('Clopidogrel'));

    act(() => nodeOf(h1.id).focus());
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(nodeOf(h2.id));
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });

    // The list and preview come back, showing the item that was opened.
    await waitFor(() => expect(screen.queryByTestId('graph-view')).toBeNull());
    await waitFor(() => expect(previewQuote()).toBe(Q2));
    // ... and its link is the same one, seen from the other end.
    await waitFor(() => expect(toggle().textContent).toBe('Show links (1)'));
    await userEvent.click(toggle());
    const back = await screen.findByTestId('link-item');
    expect(within(back).getByTestId('link-phrase').textContent).toBe('Supported by');
    expect(within(back).getByTestId('link-text').textContent).toBe(Q1);
  });

  it('returns to the list with Escape, and the nav button and the palette open the graph', async () => {
    const { h1 } = await vault();
    await open(`?highlight=${h1.id}&view=graph`);
    const view = await screen.findByTestId('graph-view');
    await waitFor(() => expect(screen.getAllByTestId('graph-node')).toHaveLength(2));

    fireEvent.keyDown(view, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('graph-view')).toBeNull());
    expect(screen.getByTestId('view-library').getAttribute('aria-current')).toBe('page');

    await userEvent.click(screen.getByTestId('view-graph'));
    await screen.findByTestId('graph-view');
    await waitFor(() => expect(screen.getAllByTestId('graph-node')).toHaveLength(2));
    await userEvent.click(screen.getByTestId('graph-back'));
    await waitFor(() => expect(screen.queryByTestId('graph-view')).toBeNull());

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const input = await screen.findByTestId('palette-input');
    fireEvent.change(input, { target: { value: 'knowledge graph' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await screen.findByTestId('graph-view');
  });

  it('adds a link from the preview, and an end in the trash hides it until it is restored', async () => {
    const h1 = await save(Q1, {}, 100);
    const h2 = await save(Q2, {}, 600);
    await open(`?highlight=${h1.id}`);
    await waitFor(() => expect(toggle().textContent).toBe('Show links (0)'));
    await userEvent.click(toggle());
    await userEvent.click(screen.getByTestId('link-add'));

    await userEvent.type(screen.getByTestId('link-search'), 'clopidogrel');
    const candidate = await screen.findByTestId('link-candidate');
    await userEvent.click(within(candidate).getByRole('radio'));
    await userEvent.selectOptions(screen.getByTestId('link-new-type'), 'example');
    await userEvent.click(screen.getByTestId('link-submit'));
    await waitFor(() => expect(screen.getAllByTestId('link-item')).toHaveLength(1));
    expect((await listAllRelations()).map((r) => [r.fromId, r.toId, r.type])).toEqual([
      [h1.id, h2.id, 'example'],
    ]);

    await softDeleteHighlight(h2.id);
    await waitFor(() => expect(screen.queryAllByTestId('link-item')).toHaveLength(0));
    await waitFor(() => expect(toggle().textContent).toBe('Hide links'));
    await restoreHighlight(h2.id);
    await waitFor(() => expect(screen.getAllByTestId('link-item')).toHaveLength(1));
  });
});
