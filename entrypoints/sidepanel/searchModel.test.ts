import { describe, expect, it } from 'vitest';
import { createSearchIndex, type SearchHit } from '@search';
import type { SearchDocument } from '@shared';
import { toIndexDocument } from '@ui/vault/searchHost';
import { describeIndex, hitReveal, rowsFromHits } from './searchModel';

const doc = (id: string, over: Partial<SearchDocument> = {}): SearchDocument => ({
  id,
  docType: 'highlight',
  highlightId: id,
  title: 'Cell biology',
  url: 'https://example.com/cells',
  host: 'example.com',
  quote: `Mitochondria produce ATP (${id}).`,
  comment: '',
  headingContext: null,
  tags: ['energy'],
  banks: ['Biology'],
  folderPath: [],
  kind: 'essential',
  priority: 3,
  resolveStatus: 'resolved',
  updatedAt: '2026-10-11T10:00:00.000Z',
  deletedAt: null,
  ...over,
});

function search(docs: SearchDocument[], query: string): SearchHit[] {
  const index = createSearchIndex();
  index.applyChanges(docs.map(toIndexDocument));
  return index.search(query).hits;
}

describe('rowsFromHits', () => {
  it('flags matched words in the quote and keeps highlight facts', () => {
    const [row] = rowsFromHits(search([doc('hl-00000001')], 'mitochondria'));
    expect(row).toMatchObject({
      key: 'hl-00000001',
      highlightId: 'hl-00000001',
      docType: 'highlight',
      kind: 'essential',
      resolveStatus: 'resolved',
      priority: 3,
      banks: ['Biology'],
      tags: ['energy'],
      host: 'example.com',
    });
    const marked = row!.quote.segments.filter((s) => s.match).map((s) => s.text);
    expect(marked).toEqual(['Mitochondria']);
    expect(row!.quote.segments.map((s) => s.text).join('')).toContain('produce ATP');
  });

  it('lists a highlight once even when its quote and its note both match', () => {
    const hits = search(
      [
        doc('hl-00000001'),
        doc('note-0000001', {
          docType: 'note',
          highlightId: 'hl-00000001',
          quote: 'Mitochondria are the powerhouse.',
          kind: null,
          priority: null,
          resolveStatus: null,
        }),
      ],
      'mitochondria',
    );
    expect(hits.length).toBeGreaterThan(1);
    const rows = rowsFromHits(hits);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.highlightId).toBe('hl-00000001');
  });

  it('keeps a free-standing note as a note without highlight actions', () => {
    const hits = search(
      [
        doc('note-0000002', {
          docType: 'note',
          highlightId: null,
          quote: 'Remember the Krebs cycle.',
          kind: null,
          priority: null,
          resolveStatus: null,
        }),
      ],
      'krebs',
    );
    const [row] = rowsFromHits(hits);
    expect(row).toMatchObject({ docType: 'note', highlightId: null, kind: null, hasNote: true });
  });

  it('shows the field a second match came from (a tag, your note)', () => {
    const hits = search([doc('hl-00000003', { comment: 'revise the electron chain' })], 'chain');
    const [row] = rowsFromHits(hits);
    expect(row!.match?.field).toBe('comment');
    expect(row!.match?.snippet.segments.some((s) => s.match)).toBe(true);
  });

  it('keeps stored markup as plain text segments', () => {
    const hits = search(
      [doc('hl-00000004', { quote: '<img src=x onerror=1> mitochondria' })],
      'mitochondria',
    );
    const [row] = rowsFromHits(hits);
    expect(row!.quote.segments.map((s) => s.text).join('')).toContain('<img src=x onerror=1>');
  });
});

describe('hitReveal', () => {
  it('is enabled for a placed highlight of the live active page', () => {
    expect(hitReveal({ live: true, onActivePage: true, resolveStatus: 'resolved' })).toEqual({
      enabled: true,
    });
    expect(hitReveal({ live: true, onActivePage: true, resolveStatus: 'changed' })).toEqual({
      enabled: true,
    });
  });

  it('says why not: not running, another page, or not painted', () => {
    expect(hitReveal({ live: false, onActivePage: true, resolveStatus: 'resolved' })).toMatchObject(
      { enabled: false, reason: expect.stringContaining('not running') },
    );
    expect(hitReveal({ live: true, onActivePage: false, resolveStatus: 'resolved' })).toMatchObject(
      { enabled: false, reason: expect.stringContaining('another page') },
    );
    expect(hitReveal({ live: true, onActivePage: true, resolveStatus: 'orphaned' })).toMatchObject({
      enabled: false,
      reason: expect.stringContaining('not painted'),
    });
    expect(hitReveal({ live: true, onActivePage: true, resolveStatus: 'ambiguous' })).toMatchObject(
      { enabled: false },
    );
  });
});

describe('describeIndex', () => {
  it('says nothing when the index is ready and complete', () => {
    expect(describeIndex({ phase: 'ready', documents: 10, rejected: 0 })).toBeNull();
  });

  it('reports real build progress and that search cannot answer yet', () => {
    const note = describeIndex({ phase: 'building', reason: 'missing', done: 120, total: 540 });
    expect(note).toMatchObject({
      usable: false,
      failed: false,
      progress: { done: 120, total: 540 },
    });
    expect(note!.text).toContain('120 of 540');
    const unknown = describeIndex({ phase: 'building', reason: 'purge', done: 5, total: null });
    expect(unknown!.text).toContain('5 so far');
    expect(unknown!.text).toContain('permanently deleted');
    expect(unknown!.progress).toEqual({ done: 5, total: null });
  });

  it('marks results as possibly stale while the index catches up', () => {
    const note = describeIndex({ phase: 'updating', documents: 10 });
    expect(note).toMatchObject({ usable: true, tone: 'info' });
    expect(note!.text).toContain('may not include');
  });

  it('reports a failure with the reason and offers recovery', () => {
    const note = describeIndex({ phase: 'error', message: 'Disk hiccup' });
    expect(note).toMatchObject({ tone: 'error', failed: true, usable: false });
    expect(note!.text).toContain('Disk hiccup');
  });

  it('tells how many items could not be indexed', () => {
    expect(describeIndex({ phase: 'ready', documents: 10, rejected: 2 })!.text).toContain(
      '2 items could not be indexed',
    );
    expect(describeIndex({ phase: 'ready', documents: 10, rejected: 1 })!.text).toContain(
      '1 item could not',
    );
    expect(describeIndex({ phase: 'idle' })!.usable).toBe(false);
  });
});
