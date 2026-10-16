// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { questionTerms, retrievalQuery, searchPassages } from './retrieve';
import type { PassageSearch } from './retrieve';

const fakeIndex = (
  docs: { id: string; docType: 'highlight' | 'note' }[],
  seen: { query: string; options: unknown }[] = [],
): PassageSearch => ({
  search(query, options) {
    seen.push({ query, options });
    return { total: docs.length, hits: docs.map((doc) => ({ doc })) };
  },
});

describe('retrieval query', () => {
  it('keeps content words only, as plain lower-case terms', () => {
    expect(questionTerms('What is the first-line treatment for Type 2 diabetes?')).toEqual([
      'first',
      'line',
      'treatment',
      'type',
      'diabetes',
    ]);
  });

  it('cannot carry search operators or filters from the question', () => {
    const q = retrievalQuery('metformin OR NOT bank:"Secrets" -tag:x "quoted" (group) *');
    expect(q).toBe('(metformin OR bank OR secrets OR tag OR quoted OR group OR secret)');
    // Every character that has a meaning in the grammar was split away from the terms.
    expect(q!.replace(/\sOR\s/g, ' ')).not.toMatch(/[:"*-]/);
    // The only operator is the one this module writes: "OR" in a question is too short to be a term.
    expect(questionTerms('A OR B')).toEqual([]);
  });

  it('appends the scope tokens as given, and gives nothing to search for an empty question', () => {
    expect(retrievalQuery('metformin dosing', 'bank:"Cardiology" tag:"drugs"')).toBe(
      '(metformin OR dosing) bank:"Cardiology" tag:"drugs"',
    );
    expect(retrievalQuery('metformin', ' bank:"A" ')).toBe('metformin bank:"A"');
    expect(retrievalQuery('what is it?')).toBeNull();
    expect(retrievalQuery('   ')).toBeNull();
  });

  it('caps the number of terms so the query stays inside the grammar limits', () => {
    const words = Array.from({ length: 40 }, (_, i) => `term${i}word`).join(' ');
    expect(questionTerms(words)).toHaveLength(12);
  });
});

describe('searchPassages', () => {
  it('returns the best topK once each, with the total match count, asking for one hit per highlight', () => {
    const seen: { query: string; options: unknown }[] = [];
    const index = fakeIndex(
      [
        { id: 'h1', docType: 'highlight' },
        { id: 'n1', docType: 'note' },
        { id: 'h1', docType: 'highlight' },
        { id: 'h2', docType: 'highlight' },
        { id: 'h3', docType: 'highlight' },
      ],
      seen,
    );
    const r = searchPassages(index, 'metformin', 3);
    expect(r.refs).toEqual([
      { id: 'h1', kind: 'highlight' },
      { id: 'n1', kind: 'note' },
      { id: 'h2', kind: 'highlight' },
    ]);
    expect(r.total).toBe(5);
    expect(seen[0]?.options).toMatchObject({ collapseNotes: true, facets: false, suggest: false });
  });

  it('an index with no match gives nothing, and nothing is invented', () => {
    expect(searchPassages(fakeIndex([]), 'zzz', 8)).toEqual({ refs: [], total: 0 });
  });
});

describe('stems and abbreviations', () => {
  it('stems plurals and endings lightly', async () => {
    const { stem } = await import('./retrieve');
    expect(stem('inhibitors')).toBe('inhibitor');
    expect(stem('bleeding')).toBe('bleed');
    expect(stem('arteries')).toBe('artery');
    expect(stem('class')).toBe('class');
  });

  it('keeps original words first, adds stems, and replaces a two-letter abbreviation by its words', async () => {
    const { expandTerms, questionTerms } = await import('./retrieve');
    expect(expandTerms(['inhibitors', 'bleeding'])).toEqual([
      'inhibitors',
      'bleeding',
      'inhibitor',
      'bleed',
    ]);
    const terms = expandTerms(questionTerms('What causes HF?'));
    expect(terms).toContain('heart');
    expect(terms).toContain('failure');
    expect(terms).not.toContain('hf');
  });
});
