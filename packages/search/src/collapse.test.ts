import { describe, expect, it } from 'vitest';
import { createSearchIndex } from './searchIndex';
import type { SearchHit, SearchIndex, SearchOptions } from './searchIndex';
import type { SearchDocument } from './schema';
import { doc, generateCorpus } from './testUtils';

/**
 * `collapseNotes`: a note document repeats its highlight's quote and facets, so one highlight matches
 * through several documents. Collapsed, every highlight is ONE hit and `total`, the page boundaries
 * and the facets all count highlights; the default (one hit per document) is unchanged.
 */

function build(docs: SearchDocument[]): SearchIndex {
  const index = createSearchIndex();
  expect(index.applyChanges(docs).rejected).toEqual([]);
  return index;
}

/** A highlight document as the vault builds it (its own id is its `highlightId`). */
const highlight = (id: string, over: Partial<SearchDocument> = {}): SearchDocument =>
  doc({ id, highlightId: id, ...over });

/** A note document as the vault builds it: the highlight's quote and facets plus the note's own text. */
const noteOf = (
  h: SearchDocument,
  id: string,
  comment: string,
  over: Partial<SearchDocument> = {},
): SearchDocument =>
  doc({
    id,
    docType: 'note',
    highlightId: h.id,
    title: h.title,
    url: h.url,
    host: h.host,
    quote: h.quote,
    comment,
    headingContext: h.headingContext,
    tags: h.tags,
    banks: h.banks,
    folderPath: h.folderPath,
    kind: h.kind,
    priority: h.priority,
    resolveStatus: h.resolveStatus,
    updatedAt: h.updatedAt,
    deletedAt: h.deletedAt,
    ...over,
  });

/** A note attached to nothing (the vault holds a null kind, priority and status; the index '' and 0). */
const standalone = (id: string, comment: string): SearchDocument =>
  doc({
    id,
    docType: 'note',
    highlightId: null,
    quote: '',
    comment,
    kind: '',
    priority: 0,
    resolveStatus: '',
  });

const C = { collapseNotes: true } as const;
const highlightOf = (hit: SearchHit): string => hit.doc.highlightId ?? hit.doc.id;
const owners = (index: SearchIndex, q: string, o: SearchOptions = {}): string[] =>
  index.search(q, { ...C, ...o }).hits.map(highlightOf);
const textOf = (hit: SearchHit, field: string): string =>
  (hit.highlights.find((h) => h.field === field)?.segments ?? []).map((s) => s.text).join('');
const marked = (hit: SearchHit, field: string): string[] =>
  (hit.highlights.find((h) => h.field === field)?.segments ?? [])
    .filter((s) => s.match)
    .map((s) => s.text);

describe('one hit per highlight', () => {
  const a = highlight('a', { quote: 'Oxygen binds haemoglobin' });
  const b = highlight('b', { quote: 'Oxygen is carried in blood' });
  const c = highlight('c', { quote: 'Oxygen diffuses into tissue' });
  const index = build([
    a,
    b,
    noteOf(b, 'b-n1', 'remember this'),
    c,
    noteOf(c, 'c-n1', 'first'),
    noteOf(c, 'c-n2', 'second'),
    noteOf(c, 'c-n3', 'third'),
  ]);

  it('a highlight with no note, one note or three notes is one hit and one in the total', () => {
    const r = index.search('oxygen', C);
    expect(r.total).toBe(3);
    expect(r.hits).toHaveLength(3);
    expect(new Set(r.hits.map(highlightOf))).toEqual(new Set(['a', 'b', 'c']));
  });

  it('keeps the default: every document is a hit and the total counts documents', () => {
    expect(index.search('oxygen').total).toBe(7);
    expect(index.search('oxygen').hits).toHaveLength(7);
    expect(index.search('oxygen', { collapseNotes: false }).total).toBe(7);
  });

  it('is the identity on a corpus with no notes attached to highlights', () => {
    const corpus = build(generateCorpus(400));
    for (const q of ['mitochondria', 'valve bank:Cardiology', 'tag:tag-3', 'has:note', '']) {
      for (const sort of ['relevance', 'updated', 'priority'] as const) {
        const plain = corpus.search(q, { sort, limit: 500 });
        const folded = corpus.search(q, { sort, limit: 500, ...C });
        expect(folded.total).toBe(plain.total);
        expect(folded.hits.map((h) => h.id)).toEqual(plain.hits.map((h) => h.id));
        expect(folded.facets).toEqual(plain.facets);
      }
    }
  });
});

describe('which document stands for the highlight', () => {
  it('a match only inside a note returns the highlight with the note as the snippet', () => {
    const h = highlight('lungs', { quote: 'Alveoli exchange gases' });
    const index = build([h, noteOf(h, 'lungs-n', 'Surfactant lowers surface tension')]);

    const r = index.search('surfactant', C);
    expect(r.total).toBe(1);
    const hit = r.hits[0]!;
    expect(hit.doc).toMatchObject({ id: 'lungs-n', docType: 'note', highlightId: 'lungs' });
    expect(hit.matchedFields).toContain('comment');
    expect(marked(hit, 'comment')).toEqual(['Surfactant']);
    // the note document carries the highlight's quote, so the row still leads with it
    expect(textOf(hit, 'quote')).toBe('Alveoli exchange gases');
  });

  it('a match in the quote and in a note is one hit that keeps the note match info', () => {
    const h = highlight('lungs', { quote: 'Alveoli exchange oxygen and carbon dioxide' });
    const index = build([h, noteOf(h, 'lungs-n', 'Oxygen diffuses across the alveolar wall')]);

    const plain = index.search('oxygen');
    expect(plain.total).toBe(2);
    const r = index.search('oxygen', C);
    expect(r.total).toBe(1);
    const hit = r.hits[0]!;
    // the words also matched inside the note, so the note document outscores the highlight's own
    expect(hit.id).toBe('lungs-n');
    expect(hit.score).toBe(Math.max(...plain.hits.map((x) => x.score)));
    expect(marked(hit, 'quote')).toEqual(['oxygen']);
    expect(marked(hit, 'comment')).toEqual(['Oxygen']);
  });

  it('a tie goes to the highlight itself, whatever the order or the recency', () => {
    const h = highlight('h', { quote: 'Mitral valve', updatedAt: '2026-01-01T00:00:00.000Z' });
    const n = noteOf(h, 'n', 'unrelated words', { updatedAt: '2026-06-01T00:00:00.000Z' });
    for (const docs of [
      [h, n],
      [n, h],
    ]) {
      const r = build(docs).search('mitral', C);
      expect(r.total).toBe(1);
      expect(r.hits[0]!.doc).toMatchObject({ id: 'h', docType: 'highlight' });
    }
  });

  it('merges the score as the best of the group, not their sum', () => {
    const h = highlight('h', { quote: 'aorta' });
    const n1 = noteOf(h, 'n1', 'aorta root');
    const n2 = noteOf(h, 'n2', 'aorta valve');
    const index = build([h, n1, n2]);
    const best = Math.max(...index.search('aorta').hits.map((x) => x.score));
    expect(index.search('aorta', C).hits[0]!.score).toBe(best);
  });

  it('notes of nothing stand for themselves; notes of a highlight that is not indexed fold', () => {
    const index = build([
      standalone('s1', 'ribosomes in a free note'),
      standalone('s2', 'ribosomes in another'),
      doc({ id: 'x1', docType: 'note', highlightId: 'gone', comment: 'ribosomes one' }),
      doc({ id: 'x2', docType: 'note', highlightId: 'gone', comment: 'ribosomes two' }),
    ]);
    expect(index.search('ribosomes').total).toBe(4);
    const r = index.search('ribosomes', C);
    expect(r.total).toBe(3);
    expect(new Set(r.hits.map(highlightOf))).toEqual(new Set(['s1', 's2', 'gone']));
  });

  it('does not count a trashed note, and counts a trashed highlight once when asked for', () => {
    const live = highlight('live', { quote: 'aorta' });
    const gone = highlight('gone', { quote: 'aorta', deletedAt: '2026-02-01T00:00:00.000Z' });
    const index = build([
      live,
      noteOf(live, 'live-n', 'aorta valve'),
      noteOf(live, 'live-trashed', 'aorta root', { deletedAt: '2026-02-01T00:00:00.000Z' }),
      gone,
      noteOf(gone, 'gone-n', 'aorta', { deletedAt: gone.deletedAt }),
    ]);
    expect(owners(index, 'aorta')).toEqual(['live']);
    expect(index.search('aorta', C).total).toBe(1);
    const all = index.search('aorta', { ...C, includeDeleted: true });
    expect(all.total).toBe(2);
    expect(new Set(all.hits.map(highlightOf))).toEqual(new Set(['live', 'gone']));
  });
});

describe('paging over collapsed highlights', () => {
  // highlights with 3, 0, 2, 1, 3, 0 and 2 notes: 18 documents, 7 highlights
  const NOTES = [3, 0, 2, 1, 3, 0, 2];
  const stamp = (n: number): string => new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString();
  const docs: SearchDocument[] = [];
  NOTES.forEach((count, i) => {
    const h = highlight(`h${i}`, {
      quote: 'oxygen carriage',
      priority: 1 + (i % 5),
      updatedAt: stamp(i),
    });
    docs.push(h);
    for (let n = 0; n < count; n++) {
      docs.push(
        noteOf(h, `h${i}-n${n}`, `remember item ${n}`, { updatedAt: stamp(100 + i * 10 + n) }),
      );
    }
  });
  const index = build(docs);

  it.each(['relevance', 'updated', 'priority'] as const)(
    'pages of 3 neither repeat nor skip a highlight (%s)',
    (sort) => {
      const all = index.search('oxygen', { ...C, sort, limit: 500 });
      expect(all.total).toBe(7);
      expect(all.hits).toHaveLength(7);

      const sizes: number[] = [];
      const seen: string[] = [];
      for (let offset = 0; offset < 7; offset += 3) {
        const page = index.search('oxygen', { ...C, sort, limit: 3, offset });
        expect(page.total).toBe(7);
        expect(page.offset).toBe(offset);
        sizes.push(page.hits.length);
        seen.push(...page.hits.map(highlightOf));
      }
      expect(sizes).toEqual([3, 3, 1]);
      expect(new Set(seen).size).toBe(7);
      expect(seen).toEqual(all.hits.map(highlightOf));
    },
  );

  it('counts the same query as 18 documents without the option, and 7 with it', () => {
    expect(index.search('oxygen').total).toBe(18);
    expect(index.search('oxygen', C).total).toBe(7);
  });

  it('answers past the end with no hits and the same total', () => {
    const r = index.search('oxygen', { ...C, limit: 3, offset: 7 });
    expect(r.hits).toEqual([]);
    expect(r.total).toBe(7);
  });

  it('puts a highlight where its newest document says (updated sort)', () => {
    const h1 = highlight('h1', { quote: 'aorta', updatedAt: '2026-01-01T00:00:00.000Z' });
    const h2 = highlight('h2', { quote: 'aorta', updatedAt: '2026-02-01T00:00:00.000Z' });
    expect(owners(build([h1, h2]), 'aorta', { sort: 'updated' })).toEqual(['h2', 'h1']);
    const edited = noteOf(h1, 'n1', 'plain words', { updatedAt: '2026-03-01T00:00:00.000Z' });
    expect(owners(build([h1, h2, edited]), 'aorta', { sort: 'updated' })).toEqual(['h1', 'h2']);
  });

  it('keeps the adjacent-phrase boost over the collapsed list', () => {
    const scattered = highlight('scattered', { quote: 'membrane of the cell and its nucleus' });
    const adjacent = highlight('adjacent', { quote: 'a cell membrane is a lipid bilayer' });
    const withNotes = build([
      scattered,
      noteOf(scattered, 's-n1', 'more words'),
      noteOf(scattered, 's-n2', 'still more'),
      adjacent,
      noteOf(adjacent, 'a-n', 'other words'),
    ]);
    expect(withNotes.search('cell membrane', C).total).toBe(2);
    expect(owners(withNotes, 'cell membrane')).toEqual(['adjacent', 'scattered']);
  });
});

describe('filters and facets over collapsed highlights', () => {
  const a = highlight('a', {
    quote: 'oxygen in the blood',
    banks: ['Cardiology'],
    tags: ['exam'],
    kind: 'formula',
    host: 'a.org',
    resolveStatus: 'resolved',
  });
  const b = highlight('b', {
    quote: 'oxygen demand of the heart',
    banks: ['Cardiology', 'Renal'],
    tags: ['exam', 'pearl'],
    kind: 'formula',
    host: 'a.org',
    resolveStatus: 'orphaned',
  });
  const c = highlight('c', {
    quote: 'oxygen at altitude',
    banks: ['Renal'],
    tags: [],
    kind: 'question',
    host: 'b.org',
    resolveStatus: 'resolved',
    comment: 'my own remark',
  });
  const index = build([
    a,
    noteOf(a, 'a1', 'first note'),
    noteOf(a, 'a2', 'second note'),
    b,
    noteOf(b, 'b1', 'third note'),
    c,
  ]);
  const facet = (list: Array<{ value: string; count: number }>) =>
    list.map((f) => [f.value, f.count]);

  it('counts every facet once per highlight, so the counts agree with the total', () => {
    const r = index.search('oxygen', C);
    expect(r.total).toBe(3);
    const f = r.facets!;
    expect(facet(f.bank)).toEqual([
      ['Cardiology', 2],
      ['Renal', 2],
    ]);
    expect(facet(f.tag)).toEqual([
      ['exam', 2],
      ['pearl', 1],
    ]);
    expect(facet(f.kind)).toEqual([
      ['formula', 2],
      ['question', 1],
    ]);
    expect(facet(f.host)).toEqual([
      ['a.org', 2],
      ['b.org', 1],
    ]);
    expect(facet(f.status)).toEqual([
      ['resolved', 2],
      ['orphaned', 1],
    ]);
    // one value per highlight here, so each single-valued facet adds up to the total
    for (const list of [f.kind, f.host, f.status]) {
      expect(list.reduce((n, x) => n + x.count, 0)).toBe(r.total);
    }
  });

  it('without the option the same facets count documents', () => {
    const f = index.search('oxygen').facets!;
    expect(f.bank.find((x) => x.value === 'Cardiology')!.count).toBe(5);
    expect(f.kind.find((x) => x.value === 'formula')!.count).toBe(5);
  });

  it('keeps the grammar: has:note, type:note, tag:, status:, bank: and negation', () => {
    // has:note = an own comment, or any note: a (2 notes), b (1 note), c (a comment)
    expect(new Set(owners(index, 'has:note'))).toEqual(new Set(['a', 'b', 'c']));
    expect(index.search('has:note', C).total).toBe(3);
    expect(index.search('has:note').total).toBe(6);
    // only note documents match: still one hit for the highlight that has two of them
    expect(index.search('type:note').total).toBe(3);
    expect(new Set(owners(index, 'type:note'))).toEqual(new Set(['a', 'b']));
    expect(index.search('type:note', C).total).toBe(2);
    expect(index.search('type:highlight', C).total).toBe(3);
    expect(owners(index, 'tag:pearl')).toEqual(['b']);
    expect(owners(index, 'status:orphaned')).toEqual(['b']);
    expect(new Set(owners(index, 'bank:renal'))).toEqual(new Set(['b', 'c']));
    expect(owners(index, 'oxygen -tag:exam')).toEqual(['c']);
    expect(index.search('tag:exam', C).total).toBe(2);
    expect(facet(index.search('tag:exam', C).facets!.bank)).toEqual([
      ['Cardiology', 2],
      ['Renal', 1],
    ]);
  });

  it('finds a note by its own words and counts the highlight once', () => {
    const r = index.search('note', C);
    expect(r.total).toBe(2);
    expect(new Set(r.hits.map(highlightOf))).toEqual(new Set(['a', 'b']));
    expect(r.hits.every((h) => h.doc.docType === 'note')).toBe(true);
    expect(facet(r.facets!.bank)).toEqual([
      ['Cardiology', 2],
      ['Renal', 1],
    ]);
  });
});
