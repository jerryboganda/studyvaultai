import { describe, expect, it } from 'vitest';
import { createSearchIndex } from '@search';
import {
  collectBrowseIds,
  collectSearchIds,
  dedupeRows,
  fetchBrowsePage,
  fetchSearchPage,
  rowFromHit,
  rowFromItem,
} from './results';
import { EMPTY_FILTERS } from './filters';
import { FakeVault, manyHighlights } from './testing';

function indexOf(vault: FakeVault) {
  const index = createSearchIndex();
  index.applyChanges(vault.searchDocs());
  return index;
}

describe('rows', () => {
  it('builds a browse row from a vault item', async () => {
    const vault = new FakeVault([
      {
        id: 'hl-00000001',
        quote: 'Mitochondria produce ATP.',
        kind: 'formula',
        priority: 5,
        resolveStatus: 'orphaned',
        pdfPage: 12,
        documentId: 'doc-0000001',
        tagIds: ['t1'],
      },
    ]);
    vault.tags.push({ id: 't1', name: 'bioenergetics' });
    const page = await vault.api().listHighlights({});
    const row = rowFromItem(page.items[0]!);
    expect(row).toMatchObject({
      key: 'hl-00000001',
      highlightId: 'hl-00000001',
      kind: 'formula',
      color: 'amber',
      priority: 5,
      resolveStatus: 'orphaned',
      tags: ['bioenergetics'],
      banks: ['Inbox'],
      sourceType: 'pdf',
      pageNumber: 12,
    });
    expect(row.segments).toEqual([{ text: 'Mitochondria produce ATP.', match: false }]);
  });

  it('builds a search row with highlighted segments as text, never markup', () => {
    const vault = new FakeVault([
      { id: 'hl-00000001', quote: 'The <script>alert(1)</script> membrane is a bilayer.' },
    ]);
    const hit = indexOf(vault).search('membrane').hits[0]!;
    const row = rowFromHit(hit);
    expect(row.highlightId).toBe('hl-00000001');
    const joined = row.segments.map((s) => s.text).join('');
    expect(joined).toContain('<script>alert(1)</script>');
    expect(row.segments.some((s) => s.match && s.text.toLowerCase() === 'membrane')).toBe(true);
  });

  it('maps a note hit to its highlight and shows the matching note text', () => {
    const vault = new FakeVault([{ id: 'hl-00000001', quote: 'Ribosomes make proteins.' }]);
    const api = vault.api();
    void api.createNote({ highlightId: 'hl-00000001', body: 'Remember the golgi apparatus.' });
    const hit = indexOf(vault).search('golgi').hits[0]!;
    const row = rowFromHit(hit);
    expect(row.docType).toBe('note');
    expect(row.highlightId).toBe('hl-00000001');
    expect(row.matchNote?.field).toBe('comment');
    expect(row.matchNote?.segments.some((s) => s.match)).toBe(true);
  });

  it('dedupes rows of one highlight (quote hit plus note hit)', () => {
    const vault = new FakeVault([{ id: 'hl-00000001', quote: 'Golgi packages proteins.' }]);
    void vault.api().createNote({ highlightId: 'hl-00000001', body: 'golgi again' });
    const rows = indexOf(vault).search('golgi').hits.map(rowFromHit);
    expect(rows).toHaveLength(2);
    expect(dedupeRows(rows, new Set())).toHaveLength(1);
  });
});

describe('pages', () => {
  it('browses with cursor paging and a total on the first page only', async () => {
    const vault = new FakeVault(manyHighlights(25));
    const api = vault.api();
    const first = await fetchBrowsePage(api, {
      scope: { bankId: null, folderId: null },
      filters: EMPTY_FILTERS,
      sort: 'captured-desc',
      withTotal: true,
      limit: 10,
    });
    expect(first.rows).toHaveLength(10);
    expect(first.total).toBe(25);
    expect(first.next).toMatchObject({ kind: 'browse' });
    const next = first.next;
    const second = await fetchBrowsePage(api, {
      scope: { bankId: null, folderId: null },
      filters: EMPTY_FILTERS,
      sort: 'captured-desc',
      withTotal: false,
      cursor: next?.kind === 'browse' ? next.cursor : null,
      limit: 10,
    });
    expect(second.total).toBe(-1);
    expect(second.rows[0]!.key).not.toBe(first.rows[0]!.key);
    expect(vault.called('countHighlights')).toHaveLength(1);
  });

  it('pages search results by offset and reports facets once', () => {
    const vault = new FakeVault(manyHighlights(30));
    const index = indexOf(vault);
    const first = fetchSearchPage(index, {
      query: 'mitochondria',
      sort: 'relevance',
      offset: 0,
      limit: 12,
      idSet: null,
    });
    expect(first.rows).toHaveLength(12);
    expect(first.total).toBe(30);
    expect(first.extras?.facets).not.toBeNull();
    expect(first.next).toEqual({ kind: 'search', offset: 12 });
    const last = fetchSearchPage(index, {
      query: 'mitochondria',
      sort: 'relevance',
      offset: 24,
      limit: 12,
      idSet: null,
    });
    expect(last.rows).toHaveLength(6);
    expect(last.next).toBeNull();
    expect(last.extras).toBeNull();
  });

  it('restricts search hits to an id set (source and date filters)', () => {
    const vault = new FakeVault(manyHighlights(30));
    const index = indexOf(vault);
    const allowed = new Set(['hl-000003', 'hl-000007', 'hl-000011']);
    const page = fetchSearchPage(index, {
      query: 'mitochondria',
      sort: 'relevance',
      offset: 0,
      idSet: allowed,
    });
    expect(page.rows.map((r) => r.highlightId).sort()).toEqual([...allowed].sort());
    expect(page.total).toBe(3);
    expect(page.next).toBeNull();
  });
});

describe('whole-result id resolution', () => {
  it('walks every page of a browse query', async () => {
    const vault = new FakeVault(manyHighlights(1_234));
    const all = await collectBrowseIds(
      vault.api(),
      { bankId: null, folderId: null },
      EMPTY_FILTERS,
    );
    expect(all.ids).toHaveLength(1_234);
    expect(new Set(all.ids).size).toBe(1_234);
    expect(all.capped).toBe(false);
  });

  it('collects every matching highlight id of a search, once each', () => {
    const vault = new FakeVault(manyHighlights(40));
    void vault.api().createNote({ highlightId: 'hl-000001', body: 'mitochondria note' });
    const r = collectSearchIds(indexOf(vault), 'mitochondria', null);
    expect(r.ids).toHaveLength(40);
    expect(new Set(r.ids).size).toBe(40);
  });
});
