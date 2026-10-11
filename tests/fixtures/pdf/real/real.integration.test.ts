// @vitest-environment node
// Real public-domain PDFs (this folder, described in SOURCES.md) through the reader's own open path:
// header check -> content fingerprint -> pdf.js (the legacy build, main-thread fake worker) -> sampled
// text status -> document row. What this cannot prove is canvas rendering, the text layer and
// selection: tests/e2e/pdf-real.spec.ts does that in a real browser.
//
// Always on: every file opens in well under a second on a laptop (the unit job prints the measured
// times below), so there is no env gate to forget. Each file is its own describe so a failure names it.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pageHasText, sha256Hex } from '@pdf';
import { createMemoryPdfStore } from '@pdf/testing/memoryStore';
import { openSession, type Session } from '../../../../entrypoints/pdf-reader/loader';
import { readRealPdfs, REAL_PDF_DIR, type RealPdf } from './manifest';

const pdfs = readRealPdfs();
const MAX_TOTAL_BYTES = 25 * 1024 * 1024; // the owner's approval: "under 25 MB total"
const OPEN_BUDGET_MS = 15_000; // generous: a hang or a quadratic regression, not a benchmark

const timings: Array<{ file: string; pages: number; openMs: number; probeMs: number }> = [];

describe('SOURCES.md and the folder', () => {
  it('lists about ten documents', () => {
    expect(pdfs.length).toBeGreaterThanOrEqual(10);
  });

  it('describes every PDF in the folder, and nothing else is there', () => {
    const onDisk = fs
      .readdirSync(REAL_PDF_DIR)
      .filter((f) => /\.pdf$/i.test(f))
      .sort();
    expect(onDisk).toEqual(pdfs.map((p) => p.file).sort());
  });

  it('stays under the 25 MB the owner approved', () => {
    const total = pdfs.reduce((n, p) => n + fs.statSync(p.path).size, 0);
    expect(total).toBeLessThan(MAX_TOTAL_BYTES);
  });
});

describe.each(pdfs)('$file', (pdf: RealPdf) => {
  let bytes: Uint8Array;
  let session: Session;
  let openMs = 0;
  const store = createMemoryPdfStore();

  beforeAll(async () => {
    bytes = new Uint8Array(fs.readFileSync(pdf.path));
    const t0 = performance.now();
    session = await openSession({
      bytes: bytes.slice(),
      nameHint: path.basename(pdf.file),
      originalUrl: null,
      store,
    });
    openMs = performance.now() - t0;
  }, 30_000);

  afterAll(async () => {
    await session?.doc.destroy().catch(() => undefined);
  });

  it('is the file SOURCES.md describes (size, header, SHA-256)', async () => {
    expect(bytes.byteLength).toBe(pdf.bytes);
    expect(Buffer.from(bytes.subarray(0, 5)).toString('latin1')).toBe('%PDF-');
    expect(await sha256Hex(bytes)).toBe(pdf.sha256);
  });

  it('opens through the reader loader: page count, identity and document row', () => {
    expect(session.doc.pageCount).toBe(pdf.pages);
    expect(session.id).toBe(pdf.sha256); // the document id is the content hash
    expect(session.byteLength).toBe(pdf.bytes);
    expect(store.documents.get(session.id)).toMatchObject({
      id: pdf.sha256,
      pageCount: pdf.pages,
      byteLength: pdf.bytes,
      textStatus: pdf.text,
    });
    expect(openMs).toBeLessThan(OPEN_BUDGET_MS);
  });

  it('reports the text status SOURCES.md records, from real page text', async () => {
    expect(session.textStatus).toBe(pdf.text);
    const sampled = [...session.known.keys()];
    expect(sampled.length).toBeGreaterThan(0);
    const withText = sampled.filter((n) => session.known.get(n));
    if (pdf.text === 'text') {
      expect(withText).toHaveLength(sampled.length);
      const stream = (await session.doc.pageText(withText[0]!)).text;
      expect(stream.length).toBeGreaterThan(40);
      expect(stream).toMatch(/[\p{L}]{3,}/u);
    } else if (pdf.text === 'scanned') {
      expect(withText).toEqual([]);
      for (const n of sampled) {
        expect(pageHasText(await session.doc.pageText(n))).toBe(false);
        expect(await session.doc.textSource(n)).toBe('embedded');
      }
    } else {
      expect(withText.length).toBeGreaterThan(0);
      expect(withText.length).toBeLessThan(sampled.length);
    }
  });

  it('builds the outline SOURCES.md records (bookmarks that resolve to pages)', async () => {
    const outline = await session.doc.getOutline();
    expect(outline).toHaveLength(pdf.outline);
    for (const e of outline) {
      expect(e.title.length).toBeGreaterThan(0);
      expect(e.depth).toBeGreaterThanOrEqual(0);
      if (e.pageNumber !== null) {
        expect(e.pageNumber).toBeGreaterThanOrEqual(1);
        expect(e.pageNumber).toBeLessThanOrEqual(pdf.pages);
      }
    }
    if (pdf.outline > 0) expect(outline.some((e) => e.pageNumber !== null)).toBe(true);
  });

  it('reads the geometry of every page: orientation and /Rotate match SOURCES.md', async () => {
    const t0 = performance.now();
    let landscape = 0;
    let rotated = 0;
    for (let n = 1; n <= pdf.pages; n++) {
      const page = await session.doc.getPage(n);
      const [x0, y0, x1, y1] = page.view as [number, number, number, number];
      const w = x1 - x0;
      const h = y1 - y0;
      expect(w).toBeGreaterThan(0);
      expect(h).toBeGreaterThan(0);
      expect([0, 90, 180, 270]).toContain(((page.rotate % 360) + 360) % 360);
      const turned = page.rotate % 180 !== 0;
      if (turned ? h > w : w > h) landscape++;
      if (page.rotate % 360 !== 0) rotated++;
    }
    expect({ landscape, rotated }).toEqual({ landscape: pdf.landscape, rotated: pdf.rotated });
    timings.push({
      file: pdf.file,
      pages: pdf.pages,
      openMs: Math.round(openMs),
      probeMs: Math.round(performance.now() - t0),
    });
  });

  it('extracts text content from sampled pages without an exception', async () => {
    const sampled = [...session.known.keys()];
    let items = 0;
    for (const n of sampled) {
      const content = await session.doc.textContent(n);
      items += content.items.length;
      const text = await session.doc.pageText(n);
      expect(typeof text.text).toBe('string');
    }
    if (pdf.text === 'text') expect(items).toBeGreaterThan(0);
  });
});

afterAll(() => {
  // Printed in the unit job's log: the measured cost behind "always on".
  const rows = timings.map(
    (t) => `${t.file.padEnd(46)} ${String(t.pages).padStart(4)} pages  open ${String(t.openMs).padStart(5)} ms  geometry ${String(t.probeMs).padStart(5)} ms`,
  );
  console.info(`real PDFs through the reader loader:\n${rows.join('\n')}`);
});
