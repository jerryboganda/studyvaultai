import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, render, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { browser } from 'wxt/browser';
import { defaultSettings, type PageStatus } from '@shared';
import { createRelation, listAllRelations, softDeleteHighlight } from '@storage';
import { freshDatabase, save } from '@storage/test-vault';
import { STUDY_SETTINGS_KEY, defaultStudySettings } from '@ui/review';
import { makeChromeFakes, rpc } from '@ui/testing/fakes';
import { SidePanel } from './SidePanel';
import { openCard } from './testing';

/**
 * Links under a card of the side panel, against the REAL vault: closed and free until asked, the
 * other end named, the dashboard and its graph one click away, and a link made from the card or
 * from a Related suggestion.
 */

vi.mock('@runtime', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { rpc: fake } = await import('@ui/testing/fakes');
  return { ...actual, callBackground: fake.callBackground, callTab: fake.callTab } as never;
});

vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 10_000 });

const PAGE_URL = 'https://example.com/notes/pharm';

const status = (): PageStatus => ({
  url: PAGE_URL,
  canonicalUrl: null,
  title: 'Pharmacology notes',
  counts: { total: 0, resolved: 0, changed: 0, ambiguous: 0, orphaned: 0, pending: 0 },
  paintingSupported: true,
  hasSelection: false,
  blocked: null,
});

let created: string[];

async function open() {
  window.history.replaceState(null, '', '/');
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

const A = 'Aspirin irreversibly inhibits cyclooxygenase in platelets.';
const B = 'Clopidogrel blocks the P2Y12 receptor on platelets.';

/** The card of a highlight, with its "More actions" (where Links lives) open. */
const cardOf = async (id: string) => {
  await waitFor(() => expect(document.querySelector(`[data-highlight-id="${id}"]`)).toBeTruthy());
  const card = document.querySelector<HTMLElement>(`article[data-highlight-id="${id}"]`)!;
  await openCard(card);
  return card;
};

describe('Links on a card', () => {
  it('is closed until asked, then names the other end and opens the dashboard and its graph', async () => {
    const a = await save(A);
    const b = await save(B);
    await createRelation({
      fromKind: 'highlight',
      fromId: a.id,
      toKind: 'highlight',
      toId: b.id,
      type: 'contradicts',
    });
    await open();
    const card = await cardOf(a.id);
    const toggle = within(card).getByTestId('links-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toBe('Show links');
    expect(within(card).queryByTestId('link-item')).toBeNull();

    await userEvent.click(toggle);
    const item = await within(card).findByTestId('link-item');
    expect(within(item).getByTestId('link-phrase').textContent).toBe('Contradicts');
    expect(within(item).getByTestId('link-text').textContent).toBe(B);

    await userEvent.click(within(item).getByTestId('link-open'));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(new URL(created[0]!).searchParams.get('highlight')).toBe(b.id);

    await userEvent.click(within(card).getByTestId('link-graph'));
    await waitFor(() => expect(created).toHaveLength(2));
    const graph = new URL(created[1]!);
    expect(graph.pathname).toBe('/dashboard.html');
    expect(graph.searchParams.get('view')).toBe('graph');
    expect(graph.searchParams.get('highlight')).toBe(a.id);
  });

  it('adds a link from the card; the section follows a trashed end', async () => {
    const a = await save(A);
    const b = await save(B);
    await open();
    const card = await cardOf(a.id);
    await userEvent.click(within(card).getByTestId('links-toggle'));
    await userEvent.click(await within(card).findByTestId('link-add'));
    await userEvent.type(within(card).getByTestId('link-search'), 'clopidogrel');
    const candidate = await within(card).findByTestId('link-candidate');
    expect(candidate.getAttribute('data-id')).toBe(b.id);
    await userEvent.click(within(candidate).getByRole('radio'));
    await userEvent.selectOptions(within(card).getByTestId('link-new-type'), 'prerequisite');
    await userEvent.click(within(card).getByTestId('link-submit'));

    const item = await within(card).findByTestId('link-item');
    expect(item.getAttribute('data-type')).toBe('prerequisite');
    expect(await listAllRelations()).toMatchObject([
      { fromId: a.id, toId: b.id, type: 'prerequisite' },
    ]);

    await softDeleteHighlight(b.id);
    await waitFor(() => expect(within(card).queryByTestId('link-item')).toBeNull());
  });

  it('turns a Related suggestion into a link with one click', async () => {
    const a = await save('Warfarin inhibits vitamin K epoxide reductase and prolongs the INR.');
    const b = await save('Bleeding on warfarin is monitored by the INR and dietary vitamin K.');
    await open();
    const card = await cardOf(a.id);
    await userEvent.click(within(card).getByTestId('related-toggle'));
    // The row for b. ponytail: on a slow runner the search index of the previous test can be
    // persisted (3 s timer) and reloaded here with its stale rows; pick b's row instead of "the one".
    await waitFor(async () =>
      expect(
        (await within(card).findAllByTestId('related-item')).map((r) =>
          r.getAttribute('data-highlight-id'),
        ),
      ).toContain(b.id),
    );
    const suggestion = within(card)
      .getAllByTestId('related-item')
      .find((r) => r.getAttribute('data-highlight-id') === b.id)!;
    await userEvent.click(within(suggestion).getByTestId('related-link'));
    expect((await within(suggestion).findByTestId('related-linked')).textContent).toBe(
      'Linked as Related',
    );
    expect(await listAllRelations()).toMatchObject([{ fromId: a.id, toId: b.id, type: 'related' }]);
  });
});
