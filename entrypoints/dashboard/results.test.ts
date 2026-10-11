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

describe('the fake vault clock', () => {
  // The search host catches up with rows changed "since its start minus 5 s" by REAL time. A fixed
  // calendar date in the fake aged out of that window during the day, and a live-search test that
  // passed in the morning failed in the afternoon.
  it('stamps rows strictly increasing and never behind the wall clock', () => {
    const vault = new FakeVault();
    const before = Date.now();
    const stamps = Array.from({ length: 50 }, () => vault.tick());
    expect(new Date(stamps[0]!).getTime()).toBeGreaterThanOrEqual(before);
    for (let i = 1; i < stamps.length; i++) expect(stamps[i]! > stamps[i - 1]!).toBe(true);
  });
});

/**
 * A note document repeats its highlight's quote, so one highlight matches through its own document
 * and through each note. The list shows highlights: the count, the pages and the facets must too.
 */
describe('search counts highlights, not documents', () => {
  async function vaultWithNotes() {
    const vault = new FakeVault([
      { id: 'hl-a', quote: 'Hemoglobin carries oxygen from the lungs.' },
      { id: 'hl-b', quote: 'Alveoli exchange oxygen and carbon dioxide.', tagIds: ['t1'] },
      { id: 'hl-c', quote: 'Beta-blockers reduce myocardial oxygen demand.' },
    ]);
    vault.tags.push({ id: 't1', name: 'lungs' });
    const api = vault.api();
    await api.createNote({ highlightId: 'hl-b', body: 'Oxygen diffuses across the wall.' });
    await api.createNote({ highlightId: 'hl-b', body: 'Surfactant lowers surface tension.' });
    await api.createNote({ highlightId: 'hl-c', body: 'Reduces the heart rate as well.' });
    return vault;
  }
  const first = (query: string, extra: { limit?: number; idSet?: Set<string> | null } = {}) => ({
    query,
    sort: 'relevance' as const,
    offset: 0,
    idSet: null,
    ...extra,
  });

  it('is one result for a highlight whose quote and notes all match', async () => {
    const index = indexOf(await vaultWithNotes());
    // 3 highlights and 3 notes: every note repeats its highlight's quote, so each one matches too
    expect(index.search('oxygen').total).toBe(6);
    const page = fetchSearchPage(index, first('oxygen'));
    expect(page.total).toBe(3);
    expect(page.rows).toHaveLength(3);
    expect(page.next).toBeNull();
    expect(new Set(page.rows.map((r) => r.highlightId))).toEqual(new Set(['hl-a', 'hl-b', 'hl-c']));
    // the facets count the same highlights (hl-b once, not once per note)
    expect(page.extras?.facets?.bank).toEqual([{ value: 'Inbox', count: 3 }]);
    expect(page.extras?.facets?.tag).toEqual([{ value: 'lungs', count: 1 }]);
  });

  it('shows a match that is only inside a note as that highlight, with the note text', async () => {
    const page = fetchSearchPage(indexOf(await vaultWithNotes()), first('surfactant'));
    expect(page.total).toBe(1);
    const [row] = page.rows;
    expect(row).toMatchObject({ highlightId: 'hl-b', docType: 'note', hasNote: true });
    expect(row!.matchNote?.field).toBe('comment');
    expect(row!.matchNote?.segments.filter((s) => s.match).map((s) => s.text)).toEqual([
      'Surfactant',
    ]);
  });

  it('pages without a repeat or a gap where a highlight has several documents', async () => {
    const vault = new FakeVault(manyHighlights(7));
    const api = vault.api();
    // 3, 0, 2, 1, 3, 0 and 2 notes: 18 documents for 7 highlights, all of them matching
    for (const [i, count] of [3, 0, 2, 1, 3, 0, 2].entries()) {
      for (let n = 0; n < count; n++) {
        await api.createNote({
          highlightId: `hl-${String(i).padStart(6, '0')}`,
          body: `Remember mitochondria point ${n}`,
        });
      }
    }
    const index = indexOf(vault);
    expect(index.search('mitochondria').total).toBe(18);

    const seen: string[] = [];
    const sizes: number[] = [];
    let offset = 0;
    for (let guard = 0; guard < 10; guard++) {
      const page = fetchSearchPage(index, { ...first('mitochondria'), offset, limit: 2 });
      expect(page.total).toBe(7);
      sizes.push(page.rows.length);
      seen.push(...page.rows.map((r) => r.highlightId!));
      if (page.next === null) break;
      expect(page.next.kind).toBe('search');
      offset = page.next.kind === 'search' ? page.next.offset : -1;
    }
    expect(sizes).toEqual([2, 2, 2, 1]);
    expect(new Set(seen).size).toBe(7);
    expect(seen).toHaveLength(7);
  });

  it('counts an id-set restriction in highlights too', async () => {
    const index = indexOf(await vaultWithNotes());
    const page = fetchSearchPage(index, first('oxygen', { idSet: new Set(['hl-b', 'hl-c']) }));
    expect(page.total).toBe(2);
    expect(page.rows.map((r) => r.highlightId).sort()).toEqual(['hl-b', 'hl-c']);
  });

  it('resolves select-all to each highlight once, across the engine page boundary', async () => {
    // 520 highlights, a note on each of the first 120: 640 documents, so one 500-document page
    // would end inside a highlight's documents
    const vault = new FakeVault(manyHighlights(520));
    const api = vault.api();
    for (let i = 0; i < 120; i++) {
      await api.createNote({
        highlightId: `hl-${String(i).padStart(6, '0')}`,
        body: 'A note about mitochondria',
      });
    }
    const index = indexOf(vault);
    expect(index.search('mitochondria').total).toBe(640);
    const all = collectSearchIds(index, 'mitochondria', null);
    expect(all.capped).toBe(false);
    expect(all.ids).toHaveLength(520);
    expect(new Set(all.ids).size).toBe(520);
    const some = collectSearchIds(index, 'mitochondria', new Set(['hl-000003', 'hl-000510']));
    expect(some.ids.sort()).toEqual(['hl-000003', 'hl-000510']);
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
