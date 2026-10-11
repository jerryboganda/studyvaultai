// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { openPdf, type PdfDocument } from './engine';
import {
  MAX_OUTLINE_DEPTH,
  MAX_OUTLINE_ENTRIES,
  buildOutline,
  headingFor,
  type OutlineEntry,
} from './outline';
import { buildPdf, proseFixture } from './testing/pdfWriter';

describe('buildOutline', () => {
  it('flattens in order with depth, cleans titles and tolerates broken destinations', async () => {
    const raw = [
      {
        title: ' 1  Renal\u0000 physiology ',
        dest: 'a',
        items: [{ title: '1.1 Filtration', dest: 'b', items: [{ title: '1.1.1 GFR', dest: 'c' }] }],
      },
      { title: '', dest: 'ignored' },
      { title: '2 Transport', dest: 'broken' },
    ];
    const pages: Record<string, { pageNumber: number; top: number | null }> = {
      a: { pageNumber: 1, top: 700 },
      b: { pageNumber: 2, top: null },
      c: { pageNumber: 3, top: 500 },
    };
    const out = await buildOutline(raw, async (dest) => {
      const hit = pages[String(dest)];
      if (!hit) throw new Error('bad destination');
      return hit;
    });
    expect(out.map((e) => [e.title, e.depth, e.pageNumber])).toEqual([
      ['1 Renal physiology', 0, 1],
      ['1.1 Filtration', 1, 2],
      ['1.1.1 GFR', 2, 3],
      ['2 Transport', 0, null],
    ]);
  });

  it('bounds size and depth', async () => {
    const deep: Record<string, unknown> = { title: 'd0' };
    let cursor = deep;
    for (let i = 1; i < MAX_OUTLINE_DEPTH + 4; i++) {
      const next: Record<string, unknown> = { title: `d${i}` };
      cursor.items = [next];
      cursor = next;
    }
    const flat = await buildOutline([deep], async () => ({ pageNumber: 1, top: null }));
    expect(flat).toHaveLength(MAX_OUTLINE_DEPTH);

    const many = Array.from({ length: MAX_OUTLINE_ENTRIES + 50 }, (_, i) => ({ title: `t${i}` }));
    const capped = await buildOutline(many, async () => ({ pageNumber: 1, top: null }));
    expect(capped).toHaveLength(MAX_OUTLINE_ENTRIES);
    expect(await buildOutline(null, async () => ({ pageNumber: 1, top: null }))).toEqual([]);
  });
});

describe('headingFor', () => {
  const view = [0, 0, 612, 792];
  const e = (title: string, pageNumber: number | null, top: number | null): OutlineEntry => ({
    title,
    pageNumber,
    top,
    depth: 0,
  });
  const entries = [
    e('Intro', 1, 720),
    e('Methods', 3, 700), // near the top of page 3
    e('Results', 3, 300), // lower half of page 3
    e('Unplaced', null, null),
    e('Discussion', 5, 700),
  ];

  it('picks the nearest heading above the passage, on the same page by position', () => {
    expect(headingFor(entries, 3, 0.1, view)).toBe('Intro'); // above Methods: previous page's heading
    expect(headingFor(entries, 3, 0.2, view)).toBe('Methods');
    expect(headingFor(entries, 3, 0.8, view)).toBe('Results');
  });

  it('falls back to the last heading of the nearest earlier page, or null before any', () => {
    expect(headingFor(entries, 4, 0.5, view)).toBe('Results');
    expect(headingFor(entries, 2, null, view)).toBe('Intro');
    expect(headingFor([e('Late', 4, 700)], 2, 0.5, view)).toBeNull();
    expect(headingFor([], 1, 0.5, view)).toBeNull();
  });

  it('without a position the last heading that starts on the page counts', () => {
    expect(headingFor(entries, 3, null, view)).toBe('Results');
  });
});

describe('outline of a real PDF (pdf.js)', () => {
  const open: PdfDocument[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((d) => d.destroy()));
  });

  it('resolves bookmarks to pages and heights, and a file without bookmarks has none', async () => {
    const bytes = buildPdf(proseFixture(4), {
      outline: [
        {
          title: 'Part one',
          page: 1,
          children: [
            { title: 'Chapter A', page: 2, fromTop: 100 },
            { title: 'Chapter B', page: 3, fromTop: 400 },
          ],
        },
        { title: 'Part two', page: 4 },
      ],
    });
    const doc = await openPdf(bytes);
    open.push(doc);
    const outline = await doc.getOutline();
    expect(outline.map((o) => [o.title, o.depth, o.pageNumber])).toEqual([
      ['Part one', 0, 1],
      ['Chapter A', 1, 2],
      ['Chapter B', 1, 3],
      ['Part two', 0, 4],
    ]);
    // /XYZ top = page height - fromTop (792 - 400)
    expect(outline[2]!.top).toBe(392);
    expect(headingFor(outline, 3, 0.9, [0, 0, 612, 792])).toBe('Chapter B');

    const plain = await openPdf(buildPdf(proseFixture(1)));
    open.push(plain);
    expect(await plain.getOutline()).toEqual([]);
  });
});
