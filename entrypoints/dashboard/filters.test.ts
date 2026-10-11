import { describe, expect, it } from 'vitest';
import {
  EMPTY_FILTERS,
  browseSort,
  facetToken,
  filterCount,
  hasFacetToken,
  localDayRange,
  needsIdSet,
  normalizeSort,
  searchSort,
  toCountQuery,
  toHighlightQuery,
  toSearchQuery,
  toggleFacetToken,
  type Filters,
} from './filters';
import { parseQuery } from '@search';

const filters = (over: Partial<Filters>): Filters => ({ ...EMPTY_FILTERS, ...over });
const ALL = { bankId: null, folderId: null };

describe('toHighlightQuery', () => {
  it('maps an empty state to just the default sort', () => {
    expect(toHighlightQuery({ scope: ALL, filters: EMPTY_FILTERS, sort: 'captured-desc' })).toEqual(
      {
        sort: { by: 'capturedAt', dir: 'desc' },
      },
    );
  });

  it('maps scope, every filter, sort and paging', () => {
    const q = toHighlightQuery({
      scope: { bankId: 'bank-1', folderId: 'folder-1' },
      filters: filters({
        tagIds: ['t1', 't2'],
        tagMode: 'all',
        kinds: ['formula', 'exception'],
        priorities: [4, 5],
        statuses: ['orphaned'],
        source: { id: 'src-1', label: 'Cells' },
        hasNote: false,
        dateField: 'updatedAt',
        dateFrom: '2026-10-01',
        dateTo: '2026-10-11',
      }),
      sort: 'priority-asc',
      cursor: 'abc',
      limit: 200,
    });
    expect(q).toEqual({
      folderId: 'folder-1', // a folder implies its bank
      tagIds: ['t1', 't2'],
      tagMode: 'all',
      kinds: ['formula', 'exception'],
      priorities: [4, 5],
      resolveStatuses: ['orphaned'],
      sourceId: 'src-1',
      hasNote: false,
      dateRange: {
        field: 'updatedAt',
        from: new Date(2026, 9, 1, 0, 0, 0, 0).toISOString(),
        to: new Date(2026, 9, 11, 23, 59, 59, 999).toISOString(),
      },
      sort: { by: 'priority', dir: 'asc' },
      cursor: 'abc',
      limit: 200,
    });
  });

  it('uses the bank when no folder is chosen', () => {
    expect(
      toHighlightQuery({
        scope: { bankId: 'b', folderId: null },
        filters: EMPTY_FILTERS,
        sort: 'updated-desc',
      }),
    ).toEqual({ bankId: 'b', sort: { by: 'updatedAt', dir: 'desc' } });
  });

  it('toCountQuery drops paging and sorting', () => {
    const q = toCountQuery({ bankId: 'b', folderId: null }, filters({ kinds: ['formula'] }));
    expect(q).toEqual({ bankId: 'b', kinds: ['formula'] });
  });
});

describe('localDayRange', () => {
  it('covers whole local days, inclusive at both ends', () => {
    const r = localDayRange('2026-03-05', '2026-03-05')!;
    expect(new Date(r.from!).getTime()).toBe(new Date(2026, 2, 5).getTime());
    expect(new Date(r.to!).getTime()).toBe(new Date(2026, 2, 5, 23, 59, 59, 999).getTime());
  });
  it('takes one open end', () => {
    expect(localDayRange('2026-03-05', '')).toEqual({ from: new Date(2026, 2, 5).toISOString() });
    expect(localDayRange('', '2026-03-05')).toEqual({
      to: new Date(2026, 2, 5, 23, 59, 59, 999).toISOString(),
    });
  });
  it('swaps reversed days and ignores impossible ones', () => {
    const swapped = localDayRange('2026-03-09', '2026-03-02')!;
    expect(new Date(swapped.from!).getDate()).toBe(2);
    expect(new Date(swapped.to!).getDate()).toBe(9);
    expect(localDayRange('2026-02-30', '')).toBeNull();
    expect(localDayRange('not a date', '')).toBeNull();
    expect(localDayRange('', '')).toBeNull();
  });
});

describe('sorting', () => {
  it('only offers what the engine can do', () => {
    expect(normalizeSort('captured-asc', true)).toBe('relevance');
    expect(normalizeSort('relevance', false)).toBe('captured-desc');
    expect(normalizeSort('updated-desc', true)).toBe('updated-desc');
    expect(normalizeSort('priority-asc', false)).toBe('priority-asc');
  });
  it('maps onto each engine', () => {
    expect(browseSort('captured-asc')).toEqual({ by: 'capturedAt', dir: 'asc' });
    expect(searchSort('relevance')).toBe('relevance');
    expect(searchSort('updated-desc')).toBe('updated');
    expect(searchSort('priority-desc')).toBe('priority');
    expect(searchSort('captured-desc')).toBe('relevance');
  });
});

describe('toSearchQuery', () => {
  const names = { bank: 'Cardiology', folder: 'Valves', tags: ['exam pearl', 'neuro'] };

  it('appends scope and filters in the documented grammar', () => {
    const q = toSearchQuery(
      'mitral stenosis',
      { bankId: 'b', folderId: 'f' },
      filters({
        tagIds: ['t1', 't2'],
        kinds: ['formula', 'exception'],
        priorities: [3],
        statuses: ['orphaned', 'ambiguous'],
        hasNote: true,
      }),
      names,
    );
    expect(q).toBe(
      'mitral stenosis bank:"Cardiology" folder:"Valves" (tag:"exam pearl" OR tag:"neuro") ' +
        '(kind:formula OR kind:exception) priority:=3 (status:orphaned OR status:ambiguous) has:note',
    );
  });

  it('requires every tag in "all" mode and expresses "no note" as a negation', () => {
    const q = toSearchQuery(
      'x',
      ALL,
      filters({ tagIds: ['a', 'b'], tagMode: 'all', hasNote: false }),
      names,
    );
    expect(q).toBe('x tag:"exam pearl" tag:"neuro" -has:note');
  });

  it('escapes quotes and backslashes in names', () => {
    const q = toSearchQuery('', { bankId: 'b', folderId: null }, EMPTY_FILTERS, {
      bank: 'The "best" \\ bank',
      folder: null,
      tags: [],
    });
    expect(q).toBe('bank:"The \\"best\\" \\\\ bank"');
    // ... and the engine reads it back as one value.
    const parsed = parseQuery(q);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.root).toMatchObject({ type: 'filter', key: 'bank' });
  });

  it('produces queries the search grammar accepts without warnings', () => {
    const q = toSearchQuery(
      'beta-blocker',
      { bankId: 'b', folderId: 'f' },
      filters({
        tagIds: ['t'],
        kinds: ['essential'],
        priorities: [1, 2],
        statuses: ['resolved'],
        hasNote: true,
      }),
      { bank: 'Pharm', folder: 'Drugs', tags: ['hot'] },
    );
    expect(parseQuery(q).warnings).toEqual([]);
  });

  it('groups a typed OR so appended filters apply to all of it', () => {
    const q = toSearchQuery('protein OR atp', ALL, filters({ kinds: ['essential'] }), names);
    expect(q).toBe('(protein OR atp) kind:essential');
    const parsed = parseQuery(q);
    expect(parsed.root).toMatchObject({ type: 'and' });
    // Already grouped, or no filters to append: left exactly as typed.
    expect(toSearchQuery('(a OR b)', ALL, filters({ kinds: ['essential'] }), names)).toBe(
      '(a OR b) kind:essential',
    );
    expect(toSearchQuery('a OR b', ALL, EMPTY_FILTERS, names)).toBe('a OR b');
  });

  it('leaves date and source to the id set', () => {
    expect(needsIdSet(EMPTY_FILTERS)).toBe(false);
    expect(needsIdSet(filters({ source: { id: 's', label: 'x' } }))).toBe(true);
    expect(needsIdSet(filters({ dateFrom: '2026-01-01' }))).toBe(true);
    expect(needsIdSet(filters({ dateFrom: 'garbage' }))).toBe(false);
    const q = toSearchQuery(
      'x',
      ALL,
      filters({ source: { id: 's', label: 'x' }, dateFrom: '2026-01-01' }),
      names,
    );
    expect(q).toBe('x');
  });
});

describe('facet tokens', () => {
  it('toggles a token in the query text', () => {
    let q = 'valve';
    q = toggleFacetToken(q, 'bank', 'Cardiology');
    expect(q).toBe('valve bank:"Cardiology"');
    expect(hasFacetToken(q, 'bank', 'Cardiology')).toBe(true);
    q = toggleFacetToken(q, 'tag', 'exam pearl');
    expect(q).toBe('valve bank:"Cardiology" tag:"exam pearl"');
    q = toggleFacetToken(q, 'bank', 'Cardiology');
    expect(q).toBe('valve tag:"exam pearl"');
    // A typed OR is grouped before a facet is appended, and un-grouped when it goes again.
    expect(toggleFacetToken('a OR b', 'kind', 'formula')).toBe('(a OR b) kind:"formula"');
    expect(toggleFacetToken('(a OR b) kind:"formula"', 'kind', 'formula')).toBe('a OR b');
    expect(toggleFacetToken('', 'kind', 'formula')).toBe(facetToken('kind', 'formula'));
  });
});

describe('filterCount', () => {
  it('counts each active group once', () => {
    expect(filterCount(EMPTY_FILTERS)).toBe(0);
    expect(
      filterCount(
        filters({
          tagIds: ['a', 'b'],
          kinds: ['formula'],
          dateFrom: '2026-01-01',
          dateTo: '2026-02-01',
        }),
      ),
    ).toBe(3);
  });
});
