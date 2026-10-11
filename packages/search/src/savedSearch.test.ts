import { describe, expect, it } from 'vitest';
import {
  createSavedSearch,
  deserializeSavedSearches,
  parseSavedSearch,
  serializeSavedSearches,
} from './savedSearch';
import type { SavedSearch } from './savedSearch';
import { createSearchIndex } from './searchIndex';
import { doc } from './testUtils';

const NOW = new Date('2026-10-11T12:00:00.000Z');

function make(name: string, query: string, id = `s-${name}`): SavedSearch {
  const r = createSavedSearch({ name, query, id, now: NOW });
  if (!r.ok) throw new Error(r.error);
  return r.search;
}

describe('createSavedSearch', () => {
  it('trims the name and stamps the creation time', () => {
    const r = createSavedSearch({
      name: '  High-yield valves  ',
      query: 'valve priority:>=4',
      id: 'x',
      now: NOW,
    });
    expect(r).toEqual({
      ok: true,
      warnings: [],
      search: {
        id: 'x',
        name: 'High-yield valves',
        query: 'valve priority:>=4',
        createdAt: '2026-10-11T12:00:00.000Z',
      },
    });
  });

  it('generates an id when none is given', () => {
    const r = createSavedSearch({ name: 'A', query: 'b', now: NOW });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.search.id.length).toBeGreaterThan(8);
  });

  it('rejects empty names, empty queries and oversized queries', () => {
    expect(createSavedSearch({ name: '   ', query: 'a', id: 'x' }).ok).toBe(false);
    expect(createSavedSearch({ name: 'n', query: '', id: 'x' }).ok).toBe(false);
    expect(createSavedSearch({ name: 'n', query: '!!!', id: 'x' }).ok).toBe(false);
    expect(createSavedSearch({ name: 'n', query: 'a '.repeat(400), id: 'x' }).ok).toBe(false);
    expect(createSavedSearch({ name: 'x'.repeat(200), query: 'a', id: 'x' }).ok).toBe(false);
  });

  it('keeps queries with warnings and returns the warnings', () => {
    const r = createSavedSearch({ name: 'n', query: 'a priority:high', id: 'x', now: NOW });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings.map((w) => w.code)).toEqual(['invalid-value']);
  });

  it('a saved search runs through the engine', () => {
    const index = createSearchIndex();
    index.applyChanges([
      doc({ id: 'hi', quote: 'valve notes', priority: 5 }),
      doc({ id: 'lo', quote: 'valve notes', priority: 1 }),
    ]);
    const s = make('Important', 'valve priority:>=4');
    expect(index.search(s.query).hits.map((h) => h.id)).toEqual(['hi']);
  });
});

describe('parseSavedSearch', () => {
  it('accepts a valid object and rejects junk', () => {
    expect(parseSavedSearch(make('a', 'x')).ok).toBe(true);
    for (const bad of [
      null,
      42,
      'x',
      {},
      { id: 'a', name: '', query: 'q', createdAt: 't' },
      { id: 'a', name: 'n', query: 5, createdAt: 't' },
    ]) {
      expect(parseSavedSearch(bad).ok).toBe(false);
    }
  });
});

describe('serialise / deserialise', () => {
  it('round-trips', () => {
    const items = [make('One', 'a1'), make('Two', 'bank:Cardiology "b c"')];
    const r = deserializeSavedSearches(serializeSavedSearches(items));
    expect(r).toEqual({ items, rejected: 0 });
  });

  it('skips invalid and duplicate entries, keeps the rest', () => {
    const good = make('Good', 'a1');
    const text = JSON.stringify({
      format: 'studyvault-saved-searches',
      version: 1,
      items: [good, { id: 'bad' }, good, null, { ...good, id: 'other', name: 'Other' }],
    });
    const r = deserializeSavedSearches(text);
    expect(r.items.map((i) => i.id)).toEqual([good.id, 'other']);
    expect(r.rejected).toBe(3);
    expect(r.error).toBeUndefined();
  });

  it('unusable payloads come back as an error, not an exception', () => {
    for (const bad of [
      '',
      '{',
      'null',
      '{}',
      JSON.stringify({ format: 'x', version: 1, items: [] }),
      JSON.stringify({ format: 'studyvault-saved-searches', version: 2, items: [] }),
      42,
      undefined,
    ]) {
      const r = deserializeSavedSearches(bad);
      expect(r.items).toEqual([]);
      expect(r.error).toBeTruthy();
    }
  });
});
