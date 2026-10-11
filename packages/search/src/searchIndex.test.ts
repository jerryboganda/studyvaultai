import { describe, expect, it } from 'vitest';
import { createSearchIndex, deserializeSearchIndex, searchCoreIsAccelerated } from './searchIndex';
import type { SearchIndex, SearchOptions } from './searchIndex';
import type { SearchDocument } from './schema';
import { doc, prng } from './testUtils';

function build(docs: SearchDocument[]): SearchIndex {
  const index = createSearchIndex();
  const r = index.applyChanges(docs);
  expect(r.rejected).toEqual([]);
  return index;
}

const ids = (index: SearchIndex, q: string, o?: SearchOptions): string[] =>
  index.search(q, o).hits.map((h) => h.id);

describe('field weights and ranking', () => {
  it('quote outranks comment and tags, which outrank the host, for the same word', () => {
    const q = doc({ id: 'q', quote: 'the aorta carries blood' });
    const c = doc({ id: 'c', comment: 'the aorta carries blood' });
    const h = doc({ id: 'h', host: 'aorta.example.org' });
    const t = doc({ id: 't', tags: ['aorta'] });
    const index = build([h, c, q, t]);
    const order = ids(index, 'aorta');
    expect(order[0]).toBe('q');
    expect(new Set(order.slice(1, 3))).toEqual(new Set(['c', 't']));
    expect(order[3]).toBe('h');
  });

  it('matched fields are reported heaviest first', () => {
    const d = doc({ id: 'a', quote: 'aorta', comment: 'aorta', tags: ['aorta'], title: 'Aorta' });
    const hit = build([d]).search('aorta').hits[0]!;
    expect(hit.matchedFields).toEqual(['quote', 'comment', 'tags', 'title']);
  });

  it('exact beats prefix beats fuzzy', () => {
    const index = build([
      doc({ id: 'fuzzy', quote: 'the membrne was thin' }),
      doc({ id: 'prefix', quote: 'the membranes were thin' }),
      doc({ id: 'exact', quote: 'the membrane was thin' }),
    ]);
    expect(ids(index, 'membrane')).toEqual(['exact', 'prefix', 'fuzzy']);
  });

  it('an exact adjacent phrase beats the same words scattered, which beats fuzzy', () => {
    const index = build([
      doc({ id: 'fuzzy', quote: 'cell membrne dynamics' }),
      doc({ id: 'scattered', quote: 'membrane of the cell and its nucleus' }),
      doc({ id: 'adjacent', quote: 'a cell membrane is a lipid bilayer' }),
    ]);
    expect(ids(index, 'cell membrane')).toEqual(['adjacent', 'scattered', 'fuzzy']);
  });

  it('rarer terms weigh more than common ones (BM25 idf)', () => {
    const common = Array.from({ length: 20 }, (_, i) =>
      doc({ id: `c${i}`, quote: 'heart muscle' }),
    );
    const rare = doc({ id: 'rare', quote: 'heart sarcoidosis' });
    const index = build([...common, rare]);
    expect(ids(index, 'heart sarcoidosis')[0]).toBe('rare');
  });

  it('is deterministic: equal scores order by recency then id', () => {
    const index = build([
      doc({ id: 'b', quote: 'aorta', updatedAt: '2026-02-01T00:00:00Z' }),
      doc({ id: 'a', quote: 'aorta', updatedAt: '2026-02-01T00:00:00Z' }),
      doc({ id: 'z', quote: 'aorta', updatedAt: '2026-03-01T00:00:00Z' }),
    ]);
    expect(ids(index, 'aorta')).toEqual(['z', 'a', 'b']);
  });
});

describe('fuzzy and prefix', () => {
  const index = build([
    doc({ id: '1', quote: 'Hemorrhage into the ventricle' }),
    doc({ id: '2', quote: 'The MRI shows a lesion' }),
    doc({ id: '3', quote: 'T2 hyperintensity in the cerebellum' }),
  ]);

  it('tolerates typos in terms of 4+ letters', () => {
    expect(ids(index, 'hemorhage')).toEqual(['1']);
    expect(ids(index, 'ventrikle')).toEqual(['1']);
    expect(ids(index, 'cerebelum')).toEqual(['3']);
  });

  it('allows two edits for long terms only', () => {
    expect(ids(index, 'hemorhagge')).toEqual(['1']);
    expect(ids(index, 'cerebelum')).toEqual(['3']);
    expect(ids(index, 'cerbelm')).toEqual([]); // 3 edits
  });

  it('does not fuzz short terms or numbers', () => {
    expect(ids(index, 'mir')).toEqual([]); // 1 edit from "mri" but only 3 letters
    expect(ids(index, 'mri')).toEqual(['2']);
    expect(ids(index, 'T3')).toEqual([]);
  });

  it('matches word starts', () => {
    expect(ids(index, 'hemorr')).toEqual(['1']);
    expect(ids(index, 'cereb')).toEqual(['3']);
  });

  it('can be switched off', () => {
    expect(ids(index, 'hemorhage', { fuzzy: false })).toEqual([]);
    expect(ids(index, 'hemorr', { prefix: false })).toEqual([]);
  });
});

describe('units, numbers and short medical tokens', () => {
  const index = build([
    doc({ id: 'sep', quote: 'Give 5 mg of morphine' }),
    doc({ id: 'joined', quote: 'Give 5mg of morphine' }),
    doc({ id: 'fifty', quote: 'Give 50 mg of morphine' }),
    doc({ id: 'dec', quote: 'Creatinine 3.5 mg/dL' }),
    doc({ id: 't2a', quote: 'T2-weighted image' }),
    doc({ id: 't2b', quote: 'a T2 weighted sequence' }),
    doc({ id: 'as', quote: 'AS is aortic stenosis' }),
  ]);

  it('"5 mg" finds both spellings but not 50 mg', () => {
    expect(new Set(ids(index, '5 mg'))).toEqual(new Set(['sep', 'joined']));
  });

  it('"5mg" finds "5 mg" too', () => {
    expect(new Set(ids(index, '5mg'))).toEqual(new Set(['sep', 'joined']));
  });

  it('decimals are single tokens', () => {
    expect(ids(index, '3.5')).toEqual(['dec']);
    expect(ids(index, 'mg/dL')).toEqual(['dec']);
    expect(ids(index, '3')).toEqual([]);
  });

  it('T2-weighted matches T2 weighted and vice versa', () => {
    expect(new Set(ids(index, 'T2-weighted'))).toEqual(new Set(['t2a', 't2b']));
    expect(new Set(ids(index, 't2 weighted'))).toEqual(new Set(['t2a', 't2b']));
  });

  it('keeps upper-case abbreviations that look like function words', () => {
    expect(ids(index, 'AS')).toEqual(['as']);
    expect(ids(index, 'AS stenosis')).toEqual(['as']);
  });

  it('function words are optional beside real terms', () => {
    expect(ids(index, 'the morphine')).toHaveLength(3);
    expect(ids(index, 'of the')).toEqual([]);
  });
});

describe('scripts', () => {
  const index = build([
    doc({ id: 'cjk', quote: '患者は糖尿病と診断された' }),
    doc({ id: 'cjk2', quote: '高血圧の治療' }),
    doc({ id: 'ar', quote: 'يُعتبَرُ القَلْبُ عضلةً مهمة' }),
    doc({ id: 'he', quote: 'הלב הוא שריר חשוב' }),
    doc({ id: 'latin', quote: 'cafe au lait spots' }),
  ]);

  it('CJK: phrase, partial and single characters', () => {
    expect(ids(index, '糖尿病')).toEqual(['cjk']);
    expect(ids(index, '尿病')).toEqual(['cjk']);
    expect(ids(index, '病')).toEqual(['cjk']);
    expect(ids(index, '高血圧 治療')).toEqual(['cjk2']);
    expect(ids(index, '糖病')).toEqual([]); // not adjacent
  });

  it('Arabic ignores diacritics in both directions', () => {
    expect(ids(index, 'القلب')).toEqual(['ar']);
    expect(ids(index, 'القَلْبُ')).toEqual(['ar']);
    expect(ids(index, 'عضله')).toEqual(['ar']); // teh marbuta folded
  });

  it('Hebrew', () => {
    expect(ids(index, 'שריר')).toEqual(['he']);
    expect(ids(index, 'הלב')).toEqual(['he']);
  });

  it('accent-insensitive Latin', () => {
    expect(ids(index, 'café')).toEqual(['latin']);
    expect(ids(index, 'CAFÉ')).toEqual(['latin']);
  });
});

describe('phrases and boolean operators', () => {
  const index = build([
    doc({ id: 'both', quote: 'mitral valve stenosis in rheumatic disease' }),
    doc({ id: 'mitral', quote: 'mitral regurgitation' }),
    doc({ id: 'aortic', quote: 'aortic valve stenosis' }),
    doc({ id: 'split', quote: 'valve of the mitral annulus', comment: 'stenosis noted' }),
    doc({ id: 'across', quote: 'mitral', comment: 'valve' }),
  ]);

  it('quoted phrases require adjacency inside one field', () => {
    expect(ids(index, '"mitral valve"')).toEqual(['both']);
    expect(ids(index, '"valve stenosis"').sort()).toEqual(['aortic', 'both']);
    expect(ids(index, '"stenosis valve"')).toEqual([]);
  });

  it('phrases are exact: no fuzzy, no prefix', () => {
    expect(ids(index, '"mitral valv"')).toEqual([]);
    expect(ids(index, '"mitrall valve"')).toEqual([]);
  });

  it('phrases may contain function words', () => {
    const idx = build([
      doc({ id: 'a', quote: 'the cell of origin; to be or not to be' }),
      doc({ id: 'b', quote: 'cell origin; be to' }),
    ]);
    expect(ids(idx, '"cell of origin"')).toEqual(['a']);
    expect(ids(idx, '"to be"')).toEqual(['a']); // only function words: verified by scanning, not the index
  });

  it('AND is the default and explicit', () => {
    expect(new Set(ids(index, 'mitral valve'))).toEqual(new Set(['both', 'split', 'across']));
    expect(new Set(ids(index, 'mitral AND valve'))).toEqual(new Set(['both', 'split', 'across']));
  });

  it('OR, NOT, minus and grouping', () => {
    expect(new Set(ids(index, 'regurgitation OR aortic'))).toEqual(new Set(['mitral', 'aortic']));
    expect(new Set(ids(index, 'stenosis NOT aortic'))).toEqual(new Set(['both', 'split']));
    expect(new Set(ids(index, 'stenosis -aortic'))).toEqual(new Set(['both', 'split']));
    expect(new Set(ids(index, '(mitral OR aortic) stenosis'))).toEqual(
      new Set(['both', 'split', 'aortic']),
    );
    expect(new Set(ids(index, 'valve -(mitral OR aortic)'))).toEqual(new Set());
  });

  it('a purely negative query returns everything else', () => {
    expect(new Set(ids(index, '-mitral'))).toEqual(new Set(['aortic']));
  });

  it('malformed queries still return results', () => {
    expect(ids(index, '"mitral valve')).toEqual(['both']);
    expect(new Set(ids(index, '(mitral OR aortic'))).toEqual(
      new Set(['both', 'mitral', 'aortic', 'split', 'across']),
    );
    const r = index.search('((( )) mitral priority:abc OR');
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});

describe('filters', () => {
  const docs = [
    doc({
      id: 'a',
      quote: 'alpha finding',
      banks: ['Cardiology'],
      tags: ['exam-pearl', 'valves'],
      kind: 'formula',
      host: 'en.wikipedia.org',
      priority: 5,
      resolveStatus: 'resolved',
      folderPath: ['Valves', 'Mitral'],
      comment: 'my own note',
      headingContext: 'Mitral valve',
    }),
    doc({
      id: 'b',
      quote: 'beta finding',
      banks: ['Neurology', 'Cardiology'],
      tags: ['exam'],
      kind: 'essential-fact',
      host: 'radiopaedia.org',
      priority: 2,
      resolveStatus: 'orphaned',
    }),
    doc({
      id: 'c',
      quote: 'gamma finding',
      banks: ['Renal'],
      tags: [],
      kind: 'formula',
      host: 'wikipedia.org',
      priority: 3,
      resolveStatus: 'approximate',
    }),
    doc({ id: 'n1', docType: 'note', highlightId: 'b', quote: '', comment: 'a note about beta' }),
  ];
  const index = build(docs);
  const set = (q: string): Set<string> => new Set(ids(index, q));

  it('bank, case and accent insensitive, any bank of a multi-bank highlight', () => {
    expect(set('bank:cardiology')).toEqual(new Set(['a', 'b']));
    expect(set('bank:NEUROLOGY')).toEqual(new Set(['b']));
    expect(set('bank:cardio')).toEqual(new Set()); // exact unless a trailing *
    expect(set('bank:cardio*')).toEqual(new Set(['a', 'b']));
  });

  it('tag exact vs prefix', () => {
    expect(set('tag:exam')).toEqual(new Set(['b']));
    expect(set('tag:exam*')).toEqual(new Set(['a', 'b']));
    expect(set('tag:"exam pearl"')).toEqual(new Set(['a'])); // punctuation folds to space
  });

  it('kind, status, folder, type', () => {
    expect(set('kind:formula')).toEqual(new Set(['a', 'c']));
    expect(set('status:orphaned')).toEqual(new Set(['b']));
    expect(set('folder:mitral')).toEqual(new Set(['a']));
    expect(set('type:note')).toEqual(new Set(['n1']));
    expect(set('type:highlight')).toEqual(new Set(['a', 'b', 'c']));
  });

  it('host matches subdomains', () => {
    expect(set('host:wikipedia.org')).toEqual(new Set(['a', 'c']));
    expect(set('host:en.wikipedia.org')).toEqual(new Set(['a']));
    expect(set('host:ipedia.org')).toEqual(new Set()); // not a label boundary
  });

  it('priority comparators', () => {
    expect(set('priority:>=3')).toEqual(new Set(['a', 'c', 'n1']));
    expect(set('priority:>3')).toEqual(new Set(['a']));
    expect(set('priority:<3')).toEqual(new Set(['b']));
    expect(set('priority:=3')).toEqual(new Set(['c', 'n1']));
  });

  it('has:note counts own comments, note documents and notes attached to the highlight', () => {
    expect(set('has:note')).toEqual(new Set(['a', 'b', 'n1']));
    expect(set('has:tag')).toEqual(new Set(['a', 'b']));
    expect(set('has:bank')).toEqual(new Set(['a', 'b', 'c']));
    expect(set('has:heading')).toEqual(new Set(['a']));
  });

  it('combines with text and negation', () => {
    expect(set('finding bank:cardiology kind:formula')).toEqual(new Set(['a']));
    expect(set('finding -bank:cardiology')).toEqual(new Set(['c']));
    expect(set('finding priority:>=3 OR tag:exam')).toEqual(new Set(['a', 'b', 'c']));
  });

  it('removing a note updates has:note of its highlight', () => {
    const idx = build(docs);
    expect(new Set(ids(idx, 'has:note'))).toContain('b');
    idx.remove('n1');
    expect(new Set(ids(idx, 'has:note'))).toEqual(new Set(['a']));
  });
});

describe('a note attached to no highlight (null kind, priority and status)', () => {
  const standalone = (id: string, comment: string) => ({
    ...doc({ id, docType: 'note', highlightId: null, quote: '', comment }),
    kind: null,
    priority: null,
    resolveStatus: null,
  });

  it('is accepted and held as an empty kind and status and priority 0', () => {
    const index = createSearchIndex();
    const result = index.applyChanges([
      standalone('n1', 'Free standing note about ribosomes'),
      doc({ id: 'h1', quote: 'Ribosomes make proteins', kind: 'formula', priority: 5 }),
    ]);
    expect(result.rejected).toEqual([]);
    expect(result.added).toBe(2);

    const hit = index.search('ribosomes').hits.find((h) => h.id === 'n1');
    expect(hit?.doc).toMatchObject({ kind: '', priority: 0, resolveStatus: '' });
  });

  it('matches no kind or status filter and is not counted in those facets', () => {
    const index = createSearchIndex();
    index.applyChanges([
      standalone('n1', 'ribosomes in a note'),
      doc({
        id: 'h1',
        quote: 'ribosomes in a highlight',
        kind: 'formula',
        resolveStatus: 'resolved',
      }),
    ]);
    expect(index.search('ribosomes kind:formula').hits.map((h) => h.id)).toEqual(['h1']);
    expect(index.search('ribosomes status:resolved').hits.map((h) => h.id)).toEqual(['h1']);
    const facets = index.search('ribosomes').facets!;
    expect(facets.kind).toEqual([{ value: 'formula', count: 1 }]);
    expect(facets.status).toEqual([{ value: 'resolved', count: 1 }]);
  });

  it('sorts last by priority and survives serialisation unchanged', () => {
    const index = createSearchIndex();
    index.applyChanges([
      standalone('n1', 'ribosomes in a note'),
      doc({ id: 'h1', quote: 'ribosomes in a highlight', priority: 1 }),
    ]);
    expect(index.search('ribosomes', { sort: 'priority' }).hits.map((h) => h.id)).toEqual([
      'h1',
      'n1',
    ]);
    const loaded = deserializeSearchIndex(index.serialize());
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.index.search('ribosomes').hits.find((h) => h.id === 'n1')?.doc).toMatchObject({
      kind: '',
      priority: 0,
      resolveStatus: '',
    });
    // the same document again is unchanged (null and '' are one value)
    expect(loaded.index.applyChanges([standalone('n1', 'ribosomes in a note')]).unchanged).toBe(1);
  });
});

describe('deleted documents', () => {
  const index = build([
    doc({ id: 'live', quote: 'aorta' }),
    doc({ id: 'gone', quote: 'aorta', deletedAt: '2026-02-01T00:00:00Z' }),
  ]);

  it('are excluded by default and included on request', () => {
    expect(ids(index, 'aorta')).toEqual(['live']);
    expect(new Set(ids(index, 'aorta', { includeDeleted: true }))).toEqual(
      new Set(['live', 'gone']),
    );
    expect(ids(index, '', { includeDeleted: false })).toEqual(['live']);
    expect(index.search('aorta').total).toBe(1);
  });

  it('restoring a document makes it searchable again', () => {
    const idx = build([doc({ id: 'x', quote: 'aorta', deletedAt: '2026-02-01T00:00:00Z' })]);
    expect(ids(idx, 'aorta')).toEqual([]);
    idx.upsert(
      doc({ id: 'x', quote: 'aorta', deletedAt: null, updatedAt: '2026-03-01T00:00:00Z' }),
    );
    expect(ids(idx, 'aorta')).toEqual(['x']);
  });
});

describe('facets', () => {
  const index = build([
    doc({
      id: '1',
      quote: 'valve',
      banks: ['Cardiology'],
      tags: ['t1', 't2'],
      kind: 'formula',
      host: 'a.org',
      resolveStatus: 'resolved',
    }),
    doc({
      id: '2',
      quote: 'valve',
      banks: ['cardiology', 'Renal'],
      tags: ['t1'],
      kind: 'formula',
      host: 'b.org',
      resolveStatus: 'orphaned',
    }),
    doc({
      id: '3',
      quote: 'valve',
      banks: ['Renal'],
      tags: [],
      kind: 'question',
      host: 'a.org',
      resolveStatus: 'resolved',
    }),
    doc({
      id: '4',
      quote: 'kidney',
      banks: ['Renal'],
      tags: ['t9'],
      kind: 'question',
      host: 'a.org',
    }),
    doc({
      id: '5',
      quote: 'valve',
      banks: ['Cardiology'],
      tags: ['t1'],
      deletedAt: '2026-01-02T00:00:00Z',
    }),
  ]);

  it('count over all matches of the current query, not the whole corpus', () => {
    const f = index.search('valve').facets!;
    expect(f.bank).toEqual([
      { value: 'Cardiology', count: 2 },
      { value: 'Renal', count: 2 },
    ]);
    expect(f.tag).toEqual([
      { value: 't1', count: 2 },
      { value: 't2', count: 1 },
    ]);
    expect(f.kind).toEqual([
      { value: 'formula', count: 2 },
      { value: 'question', count: 1 },
    ]);
    expect(f.host).toEqual([
      { value: 'a.org', count: 2 },
      { value: 'b.org', count: 1 },
    ]);
    expect(f.status).toEqual([
      { value: 'resolved', count: 2 },
      { value: 'orphaned', count: 1 },
    ]);
  });

  it('are computed before paging and can be skipped', () => {
    expect(index.search('valve', { limit: 1 }).facets!.bank.reduce((n, b) => n + b.count, 0)).toBe(
      4,
    );
    expect(index.search('valve', { facets: false }).facets).toBeNull();
  });
});

describe('did you mean', () => {
  const index = build([
    doc({ id: '1', quote: 'The mitochondria produce ATP' }),
    doc({ id: '2', quote: 'Mitochondria and the ribosome' }),
    doc({ id: '3', quote: 'Mitochondrial DNA' }),
  ]);

  it('suggests the closest vocabulary term for an unknown word', () => {
    const r = index.search('mitocondria');
    expect(r.didYouMean).toEqual({
      query: 'mitochondria',
      changes: [{ from: 'mitocondria', to: 'mitochondria' }],
    });
  });

  it('corrects inside a longer query and keeps the rest', () => {
    const r = index.search('ribosom mitocondria -atp');
    expect(r.didYouMean?.query).toBe('ribosom mitochondria -atp');
  });

  it('is absent for known words, prefixes, numbers and short terms', () => {
    expect(index.search('mitochondria').didYouMean).toBeNull();
    expect(index.search('mitoch').didYouMean).toBeNull();
    expect(index.search('xyzzyplugh').didYouMean).toBeNull();
    expect(index.search('atq').didYouMean).toBeNull();
    expect(index.search('mitocondria', { suggest: false }).didYouMean).toBeNull();
  });
});

describe('snippets', () => {
  it('returns text segments with exact verbatim slices', () => {
    const quote =
      'Cells keep a stable internal environment. The cell membrane regulates transport.';
    const hit = build([doc({ id: 'a', quote })]).search('membrane').hits[0]!;
    const quoteSnippet = hit.highlights[0]!;
    expect(quoteSnippet.field).toBe('quote');
    expect(quoteSnippet.segments.map((s) => s.text).join('')).toBe(quote);
    expect(quoteSnippet.segments.filter((s) => s.match).map((s) => s.text)).toEqual(['membrane']);
    expect(quoteSnippet.truncatedStart).toBe(false);
    expect(quoteSnippet.truncatedEnd).toBe(false);
  });

  it('merges adjacent matches separated by whitespace', () => {
    const hit = build([doc({ id: 'a', quote: 'the cell membrane is thin' })]).search(
      'cell membrane',
    ).hits[0]!;
    expect(hit.highlights[0]!.segments.filter((s) => s.match).map((s) => s.text)).toEqual([
      'cell membrane',
    ]);
  });

  it('highlights prefix and fuzzy matches by the document word', () => {
    const hit = build([doc({ id: 'a', quote: 'a membranous layer' })]).search('membran').hits[0]!;
    expect(hit.highlights[0]!.segments.filter((s) => s.match).map((s) => s.text)).toEqual([
      'membranous',
    ]);
    const typo = build([doc({ id: 'a', quote: 'the Hemorrhage grew' })]).search('hemorhage')
      .hits[0]!;
    expect(typo.highlights[0]!.segments.filter((s) => s.match).map((s) => s.text)).toEqual([
      'Hemorrhage',
    ]);
  });

  it('windows long fields around the match and flags truncation', () => {
    const filler = 'lorem ipsum dolor sit amet '.repeat(40);
    const quote = `${filler}needle in the haystack ${filler}`;
    const hit = build([doc({ id: 'a', quote })]).search('needle', { snippetLength: 100 }).hits[0]!;
    const sn = hit.highlights[0]!;
    const text = sn.segments.map((s) => s.text).join('');
    expect(text.length).toBeLessThan(180);
    expect(quote.includes(text)).toBe(true);
    expect(text).toContain('needle');
    expect(sn.truncatedStart).toBe(true);
    expect(sn.truncatedEnd).toBe(true);
    expect(sn.segments.find((s) => s.match)?.text).toBe('needle');
  });

  it('snippetLength Infinity returns the whole field', () => {
    const quote = 'x '.repeat(500) + 'needle';
    const sn = build([doc({ id: 'a', quote })]).search('needle', { snippetLength: Infinity })
      .hits[0]!.highlights[0]!;
    expect(sn.segments.map((s) => s.text).join('')).toBe(quote);
  });

  it('adds highlights for the other fields that matched', () => {
    const d = doc({
      id: 'a',
      quote: 'plain text',
      comment: 'my aorta note',
      tags: ['aorta', 'other'],
      banks: ['Aortic Disease'],
    });
    const hit = build([d]).search('aorta').hits[0]!;
    const fields = hit.highlights.map((h) => `${h.field}${h.index ?? ''}`);
    expect(fields).toEqual(['quote', 'comment', 'tags0']);
    expect(hit.highlights[0]!.segments).toEqual([{ text: 'plain text', match: false }]);
  });

  it('CJK highlights only the matching characters', () => {
    const hit = build([doc({ id: 'a', quote: '患者は糖尿病と診断された' })]).search('糖尿')
      .hits[0]!;
    expect(hit.highlights[0]!.segments.filter((s) => s.match).map((s) => s.text)).toEqual(['糖尿']);
  });

  it('is XSS-safe: hostile text only ever appears as plain segment strings', () => {
    const evil = [
      '<script>alert(1)</script> aorta',
      '"><img src=x onerror=alert(1)> aorta',
      '<svg/onload=alert(1)>aorta</svg>',
      'aorta &lt;b&gt; javascript:alert(1) {{constructor.constructor("x")()}}',
    ];
    const docs = evil.map((quote, i) =>
      doc({ id: `x${i}`, quote, comment: quote, tags: [quote], title: quote }),
    );
    const result = build(docs).search('aorta', { limit: 10 });
    expect(result.hits).toHaveLength(4);

    const host = document.createElement('div');
    for (const hit of result.hits) {
      for (const h of hit.highlights) {
        const original = (
          h.field === 'tags'
            ? hit.doc.tags[h.index ?? 0]!
            : (hit.doc as Record<string, unknown>)[h.field]
        ) as string;
        const text = h.segments.map((s) => s.text).join('');
        expect(original.includes(text)).toBe(true);
        for (const seg of h.segments) {
          expect(Object.keys(seg).sort()).toEqual(['match', 'text']);
          expect(typeof seg.text).toBe('string');
          // exactly how a UI is told to render: text nodes
          const el = document.createElement(seg.match ? 'mark' : 'span');
          el.textContent = seg.text;
          host.appendChild(el);
        }
      }
    }
    expect(host.querySelector('script, img, svg, iframe')).toBeNull();
    expect(host.textContent).toContain('<script>alert(1)</script>');
  });
});

describe('paging, sorting and browsing', () => {
  const docs = Array.from({ length: 12 }, (_, i) =>
    doc({
      id: `p${String(i).padStart(2, '0')}`,
      quote: 'common word',
      priority: (i % 5) + 1,
      updatedAt: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    }),
  );
  const index = build(docs);

  it('paginates with a stable total', () => {
    const p1 = index.search('common', { limit: 5, offset: 0 });
    const p2 = index.search('common', { limit: 5, offset: 5 });
    const p3 = index.search('common', { limit: 5, offset: 10 });
    expect(p1.total).toBe(12);
    expect(p1.hits).toHaveLength(5);
    expect(p3.hits).toHaveLength(2);
    expect(new Set([...p1.hits, ...p2.hits, ...p3.hits].map((h) => h.id)).size).toBe(12);
  });

  it('clamps nonsense limits', () => {
    expect(index.search('common', { limit: 0 }).limit).toBe(1);
    expect(index.search('common', { limit: 9999 }).limit).toBe(500);
    expect(index.search('common', { offset: -4 }).offset).toBe(0);
  });

  it('empty query browses newest first', () => {
    const r = index.search('');
    expect(r.total).toBe(12);
    expect(r.hits[0]!.id).toBe('p11');
    expect(r.warnings).toEqual([]);
  });

  it('sort by updated and by priority', () => {
    expect(ids(index, 'common', { sort: 'updated', limit: 2 })).toEqual(['p11', 'p10']);
    const byPriority = index
      .search('common', { sort: 'priority', limit: 3 })
      .hits.map((h) => h.doc.priority);
    expect(byPriority).toEqual([5, 5, 4]);
  });
});

describe('robustness', () => {
  it('searching an empty index is fine', () => {
    const r = createSearchIndex().search('anything "at all" bank:x');
    expect(r.hits).toEqual([]);
    expect(r.total).toBe(0);
    expect(r.facets).toEqual({ bank: [], tag: [], kind: [], host: [], status: [] });
  });

  it('never throws on arbitrary query text (seeded fuzz)', () => {
    const index = build([doc({ id: 'a', quote: 'aorta valve 5 mg', tags: ['x'] })]);
    const rand = prng(5);
    const alphabet = [
      'aorta',
      ' ',
      '"',
      '(',
      ')',
      '-',
      'OR',
      'AND',
      'NOT',
      'bank:',
      'tag:',
      'priority:>=',
      '*',
      '5',
      'mg',
      '糖',
      'ق',
      '\\',
      ':',
      '\u0000',
    ];
    for (let i = 0; i < 500; i++) {
      let q = '';
      const n = Math.floor(rand() * 25);
      for (let j = 0; j < n; j++) q += alphabet[Math.floor(rand() * alphabet.length)]!;
      expect(() => index.search(q), JSON.stringify(q)).not.toThrow();
    }
  });

  it('rejects invalid documents without throwing and keeps the old version', () => {
    const index = build([doc({ id: 'a', quote: 'aorta' })]);
    const r = index.applyChanges([
      { id: 'a', quote: 42 },
      null,
      'nope',
      { ...doc({ id: 'b' }), priority: Number.NaN },
      doc({ id: 'ok', quote: 'valve' }),
    ]);
    expect(r.added).toBe(1);
    expect(r.rejected).toHaveLength(4);
    expect(index.get('a')?.quote).toBe('aorta');
    expect(ids(index, 'aorta')).toEqual(['a']);
  });

  it('holds its own frozen copy of every document', () => {
    const source = doc({ id: 'a', quote: 'aorta', tags: ['t'] });
    const index = build([source]);
    source.quote = 'changed';
    source.tags.push('mutated');
    expect(index.get('a')?.quote).toBe('aorta');
    expect(index.get('a')?.tags).toEqual(['t']);
    expect(() => {
      (index.get('a') as SearchDocument).quote = 'x';
    }).toThrow();
    expect(ids(index, 'aorta')).toEqual(['a']);
    index.remove('a'); // would corrupt the postings if the index had kept the caller's mutated object
    expect(index.stats()).toMatchObject({ documents: 0, terms: 0 });
  });

  it('stats', () => {
    const index = build([
      doc({ id: 'a', quote: 'aorta' }),
      doc({ id: 'b', quote: 'x', deletedAt: '2026-01-01' }),
    ]);
    expect(index.stats()).toMatchObject({ documents: 2, deleted: 1 });
    expect(index.size).toBe(2);
  });
});

describe('term cache in front of the radix tree', () => {
  it('is active for the pinned minisearch version', () => {
    // If this fails after a dependency bump the engine still works, just slower: re-check the hooks.
    expect(searchCoreIsAccelerated()).toBe(true);
  });

  it('survives a term disappearing and coming back', () => {
    const index = createSearchIndex();
    index.upsert(doc({ id: 'a', quote: 'zebrafish embryo' }));
    expect(ids(index, 'zebrafish')).toEqual(['a']);
    index.remove('a');
    expect(index.stats().terms).toBe(0);
    index.upsert(doc({ id: 'b', quote: 'zebrafish larva' }));
    index.upsert(doc({ id: 'c', quote: 'zebrafish' }));
    expect(new Set(ids(index, 'zebrafish'))).toEqual(new Set(['b', 'c']));
    expect(new Set(ids(index, 'embryo'))).toEqual(new Set());
    expect(index.stats().terms).toBe(2); // zebrafish, larva
  });
});
