// @vitest-environment node
// Runs the REAL pdf.js (legacy build, main-thread fake worker) on PDFs generated in code. What this
// cannot prove is canvas rendering, the text layer and selection: those need a browser (ADR-006).
import { afterEach, describe, expect, it } from 'vitest';
import { buildPdfAnchor, resolvePdfAnchor } from './anchor';
import { openPdf, PdfOpenError, type PdfDocument } from './engine';
import { documentFingerprint, sha256Hex } from './fingerprint';
import { rectsForRange } from './pageText';
import { hasPdfHeader } from './source';
import { pageHasText, samplePageNumbers, summarizeTextStatus } from './textStatus';
import { buildPdf, proseFixture, type FixturePage } from './testing/pdfWriter';

const open: PdfDocument[] = [];
const load = async (pages: FixturePage[], opts?: Parameters<typeof buildPdf>[1]) => {
  const doc = await openPdf(buildPdf(pages, opts));
  open.push(doc);
  return doc;
};
afterEach(async () => {
  await Promise.all(open.splice(0).map((d) => d.destroy()));
});

describe('real PDFs through pdf.js', () => {
  it('plain 10-page document: page count, title and reading-order text', async () => {
    const doc = await load(proseFixture(10), { title: 'Renal physiology' });
    expect(doc.pageCount).toBe(10);
    expect(doc.title).toBe('Renal physiology');
    const t = (await doc.pageText(3)).text;
    expect(
      t.startsWith('Page 3 line 1: the quick brown fox jumps over the lazy dog. Page 3 line 2:'),
    ).toBe(true);
    expect(t.endsWith('Page 3 line 6: the quick brown fox jumps over the lazy dog.')).toBe(true);
  });

  it('two-column page emitted column-interleaved reads column by column', async () => {
    const texts = Array.from({ length: 8 }, (_, i) => [
      { x: 72, y: 700 - i * 14, text: `left column row ${i + 1} words` },
      { x: 330, y: 700 - i * 14, text: `right column row ${i + 1} words` },
    ]).flat();
    const doc = await load([{ texts }]);
    const t = (await doc.pageText(1)).text;
    expect(t.indexOf('left column row 8')).toBeLessThan(t.indexOf('right column row 1'));
    expect(t.indexOf('left column row 1')).toBe(0);
  });

  it('rotated page (/Rotate 90) reads in displayed order', async () => {
    const doc = await load([
      {
        rotate: 90,
        texts: [
          { x: 160, y: 72, text: 'Second line of the rotated page', angle: 90 },
          { x: 120, y: 72, text: 'First line of the rotated page', angle: 90 },
        ],
      },
    ]);
    const t = (await doc.pageText(1)).text;
    expect(t).toBe('First line of the rotated page Second line of the rotated page');
  });

  it('table with superscript keeps rows together', async () => {
    const doc = await load([
      {
        texts: [
          { x: 72, y: 700, text: 'Dose' },
          { x: 200, y: 700, text: 'Effect' },
          { x: 72, y: 684, text: '5 mg' },
          { x: 200, y: 684, text: 'mild' },
          { x: 72, y: 668, text: 'Area is 3 cm' },
          { x: 133, y: 673, text: '2', size: 8 },
        ],
      },
    ]);
    const t = (await doc.pageText(1)).text;
    expect(t).toBe('Dose Effect 5 mg mild Area is 3 cm2');
  });

  it('image-only page has no text and is reported as scanned', async () => {
    const doc = await load([{ imageOnly: true }, { imageOnly: true }]);
    const pt = await doc.pageText(1);
    expect(pt.text).toBe('');
    expect(pageHasText(pt)).toBe(false);
    expect(
      summarizeTextStatus(
        new Map([
          [1, false],
          [2, false],
        ]),
      ),
    ).toBe('scanned');
  });

  it('mixed document is partial', async () => {
    const doc = await load([...proseFixture(1), { imageOnly: true }]);
    const known = new Map<number, boolean>();
    for (const n of samplePageNumbers(doc.pageCount))
      known.set(n, pageHasText(await doc.pageText(n)));
    expect(summarizeTextStatus(known)).toBe('partial');
  });

  it('a 150-page document yields text for any page without touching the others', async () => {
    const doc = await load(proseFixture(150, 3));
    expect(doc.pageCount).toBe(150);
    expect((await doc.pageText(150)).text).toContain('Page 150 line 1');
  });
});

describe('opening failures', () => {
  const encrypted = () => buildPdf(proseFixture(2), { title: 'Locked', userPassword: 'secret' });

  it('asks for the password, retries on a wrong one and opens on the right one', async () => {
    const reasons: string[] = [];
    const answers = ['wrong', 'secret'];
    const doc = await openPdf(encrypted(), {
      onPassword: async (reason) => {
        reasons.push(reason);
        return answers.shift() ?? null;
      },
    });
    open.push(doc);
    expect(reasons).toEqual(['needed', 'incorrect']);
    expect(doc.pageCount).toBe(2);
    expect((await doc.pageText(1)).text).toContain('Page 1 line 1');
  });

  it('cancelling the password prompt is reported as such', async () => {
    await expect(openPdf(encrypted(), { onPassword: async () => null })).rejects.toMatchObject({
      name: 'PdfOpenError',
      kind: 'password-cancelled',
    });
  });

  it('a protected file with no way to ask reports a password error', async () => {
    await expect(openPdf(encrypted())).rejects.toMatchObject({ kind: 'password' });
  });

  it('garbage is classified as invalid, not an unknown crash', async () => {
    const junk = new Uint8Array(2048).map((_, i) => (i * 31) & 255);
    const err = await openPdf(junk).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PdfOpenError);
    expect((err as PdfOpenError).kind).toBe('invalid');
    expect(hasPdfHeader(junk)).toBe(false);
  });

  it('a truncated file either opens what is recoverable or fails with a clear message', async () => {
    const whole = buildPdf(proseFixture(3));
    const cut = whole.slice(0, Math.floor(whole.length * 0.6));
    expect(hasPdfHeader(cut)).toBe(true);
    const res = await openPdf(cut).then(
      (d) => {
        open.push(d);
        return 'opened';
      },
      (e: unknown) => (e instanceof PdfOpenError ? e.kind : 'unclassified'),
    );
    expect(['opened', 'invalid']).toContain(res);
  });
});

describe('stable identity and anchors across reopen', () => {
  it('same bytes give the same sha-256 id; different bytes do not', async () => {
    const a = buildPdf(proseFixture(2));
    const b = buildPdf(proseFixture(3));
    expect((await documentFingerprint(a, 'x'.repeat(32))).id).toBe(await sha256Hex(a));
    expect(await sha256Hex(a)).toBe(await sha256Hex(a.slice()));
    expect(await sha256Hex(a)).not.toBe(await sha256Hex(b));
    expect(await sha256Hex(new Uint8Array(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('an anchor captured in one session resolves by position after reopening the file', async () => {
    const bytes = buildPdf(proseFixture(4));
    const first = await openPdf(bytes.slice());
    open.push(first);
    const pt = await first.pageText(2);
    const quote = 'quick brown fox jumps over the lazy dog. Page 2 line 3';
    const at = pt.text.indexOf(quote);
    expect(at).toBeGreaterThan(-1);
    const built = buildPdfAnchor({
      documentFingerprint: await sha256Hex(bytes),
      pageNumber: 2,
      rotation: 0,
      pageText: pt,
      start: at,
      end: at + quote.length,
      rects: rectsForRange(pt, at, at + quote.length),
    });
    if (!built.ok) throw new Error('capture failed');
    // The page text is a pure function of the file, so a fresh document gives the same stream.
    const second = await openPdf(bytes.slice());
    open.push(second);
    const res = resolvePdfAnchor(built.anchorSet, await second.pageText(2));
    expect(res).toMatchObject({ status: 'resolved', method: 'position', confidence: 1 });
    expect(res.rects).toEqual(built.anchorSet.rects);
  });
});

describe('OCR text standing in for a scanned page', () => {
  it('uses recognised words when the page has no embedded text, and says so', async () => {
    const doc = await load([...proseFixture(1), { imageOnly: true }]);
    expect(await doc.textSource(2)).toBe('embedded');
    expect((await doc.pageText(2)).text).toBe('');
    // Words are normalised to the raw page frame (what the store keeps).
    doc.setOcrPages(
      new Map([
        [
          2,
          [
            { text: 'Recognised', x: 0.1, y: 0.1, w: 0.2, h: 0.02 },
            { text: 'by', x: 0.31, y: 0.1, w: 0.03, h: 0.02 },
            { text: 'machine', x: 0.35, y: 0.1, w: 0.12, h: 0.02 },
            { text: 'second', x: 0.1, y: 0.13, w: 0.1, h: 0.02 },
            { text: 'line', x: 0.21, y: 0.13, w: 0.07, h: 0.02 },
          ],
        ],
      ]),
    );
    expect(await doc.textSource(2)).toBe('ocr');
    expect((await doc.pageText(2)).text).toBe('Recognised by machine second line');
    // A page that has real text is never replaced by OCR.
    doc.setOcrPages(new Map([[1, [{ text: 'bogus', x: 0.1, y: 0.1, w: 0.1, h: 0.02 }]]]));
    expect(await doc.textSource(1)).toBe('embedded');
  });
});
