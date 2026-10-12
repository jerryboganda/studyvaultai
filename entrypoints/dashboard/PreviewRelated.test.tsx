import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { createSearchIndex, type SearchDocument } from '@search';
import type { RelatedPort } from '@ui/vault';
import { Preview } from './Preview';
import { clearNoteDrafts } from './PreviewNotes';
import { Harness } from './testHarness';
import { FakeVault, type FakeHighlight } from './testing';
import { loadTreeData } from './treeData';

/**
 * The Related section of the preview, against the real lexical engine: what it asks, when, and what
 * it shows. The engine's own behaviour is covered in packages/search/src/related.test.ts.
 */

beforeEach(() => {
  fakeBrowser.reset();
  clearNoteDrafts();
});
afterEach(cleanup);

const doc = (id: string, quote: string, over: Partial<SearchDocument> = {}): SearchDocument => ({
  id,
  docType: 'highlight',
  highlightId: id,
  title: 'Pharmacology',
  url: null,
  host: 'pharm.example',
  quote,
  comment: '',
  headingContext: null,
  tags: [],
  banks: [],
  folderPath: [],
  kind: 'essential',
  priority: 3,
  resolveStatus: 'resolved',
  updatedAt: '2026-10-11T10:00:00.000Z',
  deletedAt: null,
  ...over,
});

const H1 = 'Warfarin inhibits vitamin K epoxide reductase and prolongs the INR';
const H2 = 'Bleeding on warfarin is monitored by the INR and dietary vitamin K intake';
const H3 = 'The mitral valve separates the left atrium from the left ventricle';

function indexOf(docs: SearchDocument[]) {
  const index = createSearchIndex();
  expect(index.applyChanges(docs).rejected).toEqual([]);
  return index;
}

async function open(
  docs: SearchDocument[],
  port: (find: RelatedPort['find']) => RelatedPort = (find) => ({
    state: { phase: 'ready', documents: docs.length, rejected: 0 },
    revision: 1,
    find,
  }),
) {
  const highlights: FakeHighlight[] = [
    { id: 'hl-00000001', quote: H1 },
    { id: 'hl-00000002', quote: H2, title: 'Clinical monitoring' },
    { id: 'hl-00000003', quote: H3 },
  ];
  const vault = new FakeVault(highlights);
  const api = vault.api();
  const index = indexOf(docs);
  const find = vi.fn((id: string, options: Parameters<RelatedPort['find']>[1]) =>
    index.related(id, options),
  );
  const handlers = {
    onFilterSource: vi.fn(),
    onShow: vi.fn(),
    onReviewDuplicates: vi.fn(),
  };
  const related = port(find);
  render(
    <Harness api={api} tree={await loadTreeData(api)}>
      <Preview id="hl-00000001" {...handlers} related={related} />
    </Harness>,
  );
  await screen.findByTestId('preview');
  return { find, handlers };
}

const corpus = [
  doc('hl-00000001', H1),
  doc('hl-00000002', H2, { title: 'Clinical monitoring', host: 'clinic.example' }),
  doc('hl-00000003', H3),
];

describe('Preview: related highlights', () => {
  it('is a collapsed section that computes nothing until it is opened', async () => {
    const { find } = await open(corpus);
    const section = screen.getByTestId('preview-related');
    expect(within(section).getByRole('heading', { name: 'Related' })).toBeTruthy();
    const toggle = within(section).getByTestId('related-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(find).not.toHaveBeenCalled();
    expect(within(section).queryByTestId('related-item')).toBeNull();
  });

  it('lists what shares words with this highlight, says which words, and shows one', async () => {
    const { find, handlers } = await open(corpus);
    fireEvent.click(screen.getByTestId('related-toggle'));
    expect(find).toHaveBeenCalledWith('hl-00000001', { limit: 10, excludeSameSource: false });

    const items = screen.getAllByTestId('related-item');
    expect(items).toHaveLength(1); // the mitral valve highlight shares nothing
    expect(items[0]!.getAttribute('data-highlight-id')).toBe('hl-00000002');
    expect(items[0]!.textContent).toContain(H2);
    const why = within(items[0]!).getByTestId('related-why').textContent ?? '';
    expect(why).toMatch(/^shares: /);
    for (const word of ['Warfarin', 'INR', 'vitamin']) expect(why).toContain(word);

    fireEvent.click(within(items[0]!).getByTestId('related-open'));
    expect(handlers.onShow).toHaveBeenCalledWith('hl-00000002');
  });

  it('says honestly that nothing is related', async () => {
    await open([doc('hl-00000001', H1), doc('hl-00000003', H3)]);
    fireEvent.click(screen.getByTestId('related-toggle'));
    expect(screen.queryByTestId('related-item')).toBeNull();
    expect(screen.getByTestId('related-summary').textContent).toMatch(
      /^No other highlight shares enough words/,
    );
  });

  it('waits for an index that is still building instead of reporting nothing', async () => {
    const { find } = await open(corpus, (f) => ({
      state: { phase: 'building', reason: 'missing', done: 3, total: 10 },
      revision: 0,
      find: f,
    }));
    fireEvent.click(screen.getByTestId('related-toggle'));
    expect(screen.getByText(/Building the search index: 3 of 10/)).toBeTruthy();
    expect(find).not.toHaveBeenCalled();
    expect(screen.queryByTestId('related-summary')).toBeNull();
  });

  it('is left out when the surface has no index to offer', async () => {
    const vault = new FakeVault([{ id: 'hl-00000001', quote: H1 }]);
    const api = vault.api();
    render(
      <Harness api={api} tree={await loadTreeData(api)}>
        <Preview
          id="hl-00000001"
          onFilterSource={() => undefined}
          onShow={() => undefined}
          onReviewDuplicates={() => undefined}
        />
      </Harness>,
    );
    await screen.findByTestId('preview');
    expect(screen.queryByTestId('preview-related')).toBeNull();
  });
});
