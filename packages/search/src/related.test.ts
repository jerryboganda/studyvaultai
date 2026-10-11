import { describe, expect, it } from 'vitest';
import { createSearchIndex, deserializeSearchIndex } from './searchIndex';
import type { SearchIndex } from './searchIndex';
import type { SearchDocument } from './schema';
import { doc } from './testUtils';

/**
 * Related highlights: the lexical index asked "what shares the telling words of this document?".
 * Fixtures are small and hand-made so every expectation can be read off the words.
 */

function build(docs: SearchDocument[]): SearchIndex {
  const index = createSearchIndex();
  expect(index.applyChanges(docs).rejected).toEqual([]);
  return index;
}

/** A highlight document as the vault builds it (its own id is its `highlightId`). */
const hl = (id: string, quote: string, over: Partial<SearchDocument> = {}): SearchDocument =>
  doc({ id, highlightId: id, quote, ...over });

/** A note document: the highlight's quote and facets plus the note's own words. */
const noteOf = (h: SearchDocument, id: string, comment: string): SearchDocument =>
  doc({
    ...h,
    id,
    docType: 'note',
    highlightId: h.id,
    comment,
    updatedAt: h.updatedAt,
    deletedAt: h.deletedAt,
  });

const ids = (r: { hits: Array<{ highlightId: string }> }): string[] =>
  r.hits.map((h) => h.highlightId);

const w1 = hl('w1', 'Warfarin inhibits vitamin K epoxide reductase and prolongs the INR', {
  title: 'Anticoagulants',
  host: 'pharm.example',
  tags: ['anticoagulation'],
});
const w2 = hl(
  'w2',
  'Bleeding on warfarin is monitored by the INR and by dietary vitamin K intake',
  {
    title: 'Clinical monitoring',
    host: 'clinic.example',
  },
);
const w3 = hl('w3', 'Heparin activates antithrombin and is monitored by the aPTT', {
  title: 'Anticoagulants',
  host: 'pharm.example',
});
const x1 = hl('x1', 'The mitral valve separates the left atrium from the left ventricle', {
  title: 'Anticoagulants',
  host: 'pharm.example',
});
const x2 = hl('x2', 'Action potentials depend on voltage gated sodium channels');

describe('related highlights', () => {
  const index = build([w1, w2, w3, x1, x2]);

  it('ranks highlights that share telling words first and says which words', () => {
    const r = index.related('w1');
    expect(r.found).toBe(true);
    expect(ids(r)[0]).toBe('w2');
    const top = r.hits[0]!;
    // as the source wrote them ("Warfarin" opens its sentence, the acronym keeps its capitals)
    expect([...top.sharedTerms].sort()).toEqual(['INR', 'Warfarin', 'vitamin']);
    expect(top.explanation).toMatch(/^shares: /);
    for (const word of top.sharedTerms) expect(top.explanation).toContain(word);
    // heparin and the unrelated facts share no content word with it
    expect(ids(r)).toEqual(['w2']);
  });

  it('never returns the document itself and compares by content, not by site or title', () => {
    // x1 shares its page title and site with w1 and w3 and none of their words
    expect(ids(index.related('w1'))).not.toContain('w1');
    expect(ids(index.related('x1'))).toEqual([]);
    expect(index.related('x1').found).toBe(true);
  });

  it('reports a document that is not indexed', () => {
    const r = index.related('missing');
    expect(r).toMatchObject({ found: false, hits: [], total: 0, terms: [] });
  });

  it('leaves out function words, numbers and single letters from the terms it compares by', () => {
    const r = index.related('w1');
    const lower = r.terms.map((t) => t.toLowerCase());
    for (const stop of ['and', 'the', 'k']) expect(lower).not.toContain(stop);
    const odd = build([
      hl('a', 'In 2019 the 5 of it and a were'),
      hl('b', 'In 2019 the 5 of it and a were'),
    ]);
    expect(odd.related('a')).toMatchObject({ found: true, hits: [], terms: [] });
  });
});

describe('what is never related', () => {
  const source = hl('s', 'Spironolactone antagonises aldosterone and raises serum potassium');
  const twin = hl('twin', 'Aldosterone antagonists such as spironolactone raise serum potassium');
  const trashed = hl('trashed', 'Spironolactone and eplerenone block aldosterone', {
    deletedAt: '2026-02-01T00:00:00.000Z',
  });
  const stray = doc({
    id: 'stray',
    docType: 'note',
    highlightId: null,
    quote: '',
    comment: 'spironolactone aldosterone potassium',
    kind: '',
    priority: 0,
    resolveStatus: '',
  });
  const own = noteOf(source, 'own-note', 'spironolactone aldosterone potassium everywhere');
  const orphan = noteOf(
    hl('gone', ''),
    'orphan-note',
    'spironolactone aldosterone potassium serum',
  );
  const index = build([source, twin, trashed, stray, own, orphan]);

  it('skips the document, its own notes, trashed highlights, free-standing and orphaned notes', () => {
    expect(ids(index.related('s'))).toEqual(['twin']);
  });

  it('brings trashed highlights back only when asked', () => {
    expect(ids(index.related('s', { includeDeleted: true })).sort()).toEqual(['trashed', 'twin']);
  });

  it('relates a note through its own words and still leaves its highlight out', () => {
    const r = index.related('own-note');
    expect(ids(r)).toEqual(['twin']);
    expect(ids(r)).not.toContain('s');
  });
});

describe('one hit per highlight', () => {
  const src = hl('src', 'Furosemide inhibits the sodium potassium chloride cotransporter');
  const target = hl('target', 'Loop diuretics inhibit the sodium potassium chloride cotransporter');
  const note = noteOf(target, 'target-note', 'Furosemide is the loop diuretic I should remember');
  const other = hl('other', 'Thiazides inhibit the sodium chloride cotransporter');
  const index = build([src, target, note, other]);

  it('folds a highlight and its notes into the best of them', () => {
    const r = index.related('src');
    expect(ids(r).filter((i) => i === 'target')).toHaveLength(1);
    expect(r.total).toBe(2);
    const lead = r.hits.find((h) => h.highlightId === 'target')!;
    // the note repeats the quote and adds "furosemide", so it is the better document
    expect(lead.doc.id).toBe('target-note');
    expect(lead.highlightId).toBe('target');
    expect(lead.sharedTerms.map((t) => t.toLowerCase())).toContain('furosemide');
  });

  it('counts related highlights past the page', () => {
    const r = index.related('src', { limit: 1 });
    expect(r.hits).toHaveLength(1);
    expect(r.total).toBe(2);
  });
});

describe('same source', () => {
  const a1 = hl('a1', 'Troponin rises within hours of myocardial infarction', {
    title: 'Cardiac markers',
    host: 'cardio.example',
  });
  const a2 = hl('a2', 'Troponin remains elevated for days after myocardial infarction', {
    title: 'Cardiac markers',
    host: 'cardio.example',
  });
  const b1 = hl('b1', 'Myocardial infarction is diagnosed from troponin and the ECG', {
    title: 'Chest pain',
    host: 'emerg.example',
  });
  const index = build([a1, a2, b1]);

  it('is included by default and dropped on request', () => {
    expect(ids(index.related('a1')).sort()).toEqual(['a2', 'b1']);
    expect(ids(index.related('a1', { excludeSameSource: true }))).toEqual(['b1']);
  });
});

describe('terms that say nothing', () => {
  it('drops words that are in a large part of the vault', () => {
    const docs: SearchDocument[] = [hl('s', 'Patient presented with prolonged warfarin toxicity')];
    for (let i = 0; i < 30; i++) {
      docs.push(
        hl(`p${i}`, `Patient number ${i} complained about unrelated topic${'x'.repeat(i)}`),
      );
    }
    docs.push(hl('t', 'Warfarin toxicity is reversed with vitamin K'));
    const r = build(docs).related('s');
    expect(r.terms.map((t) => t.toLowerCase())).not.toContain('patient');
    expect(ids(r)).toEqual(['t']);
  });

  it('judges terms without the source highlight’s own notes', () => {
    // 20 rare words only the source and its three notes hold, and two words it shares with "far".
    const rare = Array.from({ length: 20 }, (_, i) => `zorbl${String.fromCharCode(97 + i)}x`);
    const src = hl('src', `${rare.join(' ')} nomogram warfarin`);
    const notes = [1, 2, 3].map((n) => noteOf(src, `n${n}`, 'my own words'));
    const far = hl('far', 'A nomogram guides warfarin dosing');
    const index = build([src, ...notes, far, hl('pad1', 'alpha beta'), hl('pad2', 'gamma delta')]);
    // Without the correction the 20 rare words (document frequency 4) outrank "nomogram" (5).
    expect(ids(index.related('src', { maxTerms: 3 }))).toEqual(['far']);
    // The same holds for an index restored from its cache (the notes are re-attached on load).
    const restored = deserializeSearchIndex(index.serialize());
    expect(restored.ok && ids(restored.index.related('src', { maxTerms: 3 }))).toEqual(['far']);
  });

  it('keeps counting a source’s trashed or removed notes as its own', () => {
    const rare = Array.from({ length: 20 }, (_, i) => `quorbl${String.fromCharCode(97 + i)}x`);
    const src = hl('src', `${rare.join(' ')} nomogram warfarin`);
    const notes = [1, 2, 3].map((n) => noteOf(src, `n${n}`, 'my own words'));
    const far = hl('far', 'A nomogram guides warfarin dosing');
    const pad = [hl('pad1', 'alpha beta'), hl('pad2', 'gamma delta')];
    const index = build([src, ...notes, far, ...pad]);
    // all three notes are trashed together with the highlight's own words still indexed
    for (const n of notes) index.upsert({ ...n, deletedAt: '2026-02-01T00:00:00.000Z' });
    expect(ids(index.related('src', { maxTerms: 3 }))).toEqual(['far']);
    // once a note is gone for good its words stop counting, and nothing is left dangling
    index.remove('n1');
    index.remove('n2');
    index.remove('n3');
    expect(ids(index.related('src', { maxTerms: 3 }))).toEqual(['far']);
  });

  it('caps the number of query terms and keeps the most telling ones', () => {
    const rare = ['serotonin', 'dopamine', 'glutamate', 'histamine'];
    const src = hl('s', `${rare.join(' ')} neurons`);
    const index = build([src, hl('d', `${rare.join(' ')} neurons`), hl('e', 'neurons only')]);
    expect(ids(index.related('s'))).toEqual(['d', 'e']);
    const r = index.related('s', { maxTerms: 2 });
    expect(r.terms).toHaveLength(2);
    // "neurons" is the most common of the five, so it is the one that was left out
    expect(ids(r)).toEqual(['d']);
  });

  it('shows at most five shared words and counts the rest', () => {
    const words = ['aaa', 'bbb', 'ccc', 'ddd', 'eee', 'fff', 'ggg'].map((w) => `${w}ology`);
    const index = build([hl('s', words.join(' ')), hl('t', words.join(' '))]);
    const hit = index.related('s').hits[0]!;
    expect(hit.sharedTerms).toHaveLength(7);
    expect(hit.explanation).toMatch(/^shares: (\w+, ){4}\w+ \+2$/);
  });
});

describe('order and persistence', () => {
  const quote = 'Cardiac tamponade presents with the Beck triad';
  const source = hl('s', 'Beck triad and cardiac tamponade');
  const a = hl('a', quote, { updatedAt: '2026-03-01T00:00:00.000Z' });
  const b = hl('b', quote, { updatedAt: '2026-05-01T00:00:00.000Z' });
  const c = hl('c', quote, { updatedAt: '2026-05-01T00:00:00.000Z' });
  const weaker = hl('d', 'The Beck triad includes hypotension');

  it('is stable: ties go to the newer, then the lower id, whatever order was indexed', () => {
    const first = build([source, a, b, c, weaker]).related('s');
    const second = build([weaker, c, b, a, source]).related('s');
    expect(ids(first)).toEqual(['b', 'c', 'a', 'd']);
    expect(ids(second)).toEqual(ids(first));
    expect(second.hits.map((h) => h.score)).toEqual(first.hits.map((h) => h.score));
  });

  it('gives the same answer from a restored index', () => {
    const live = build([source, a, b, c, weaker]);
    const loaded = deserializeSearchIndex(live.serialize());
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const before = live.related('s');
    const after = loaded.index.related('s');
    expect(ids(after)).toEqual(ids(before));
    expect(after.terms).toEqual(before.terms);
    expect(after.hits.map((h) => h.explanation)).toEqual(before.hits.map((h) => h.explanation));
  });

  it('follows the index when a highlight changes', () => {
    const index = build([source, a, weaker]);
    expect(ids(index.related('s'))).toEqual(['a', 'd']);
    index.upsert({
      ...a,
      quote: 'Unrelated words entirely',
      updatedAt: '2026-06-01T00:00:00.000Z',
    });
    expect(ids(index.related('s'))).toEqual(['d']);
    index.remove('d');
    expect(ids(index.related('s'))).toEqual([]);
  });
});

describe('related to free text', () => {
  const index = build([
    hl('h1', 'Methotrexate inhibits dihydrofolate reductase'),
    hl('h2', 'Folate antagonists include methotrexate and trimethoprim'),
    hl('h3', 'Unrelated cranial nerve facts'),
  ]);

  it('finds highlights for a knowledge point and excludes nothing as its own', () => {
    const r = index.relatedToText('Methotrexate is a folate antagonist; dihydrofolate reductase');
    expect(ids(r)).toEqual(['h1', 'h2']);
    expect(r.hits[0]!.sharedTerms.length).toBeGreaterThan(0);
  });

  it('answers an empty text with no terms', () => {
    expect(index.relatedToText('')).toMatchObject({ found: true, hits: [], terms: [] });
  });
});
