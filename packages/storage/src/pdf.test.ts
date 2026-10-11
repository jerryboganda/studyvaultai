// @vitest-environment node
import 'fake-indexeddb/auto';
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { INBOX_BANK_ID, type PdfAnchorSet, type PdfHighlightInput } from '@shared';
import { getDb } from './db';
import { createFolder } from './hierarchy';
import { findDuplicateClusters, getHighlightDetail, listHighlights } from './query';
import { createBank, getPageHighlights, listRecentHighlights, wipeAllData } from './repo';
import { listSearchDocuments } from './search';
import {
  MAX_CACHED_PDF_BYTES,
  cacheDocumentBytes,
  clearOcr,
  deleteDocument,
  getDocument,
  getDocumentBytes,
  getOcrPages,
  listDocuments,
  listPdfHighlights,
  removeDocumentBytes,
  replaceOcrPage,
  saveOcrPage,
  savePdfHighlight,
  swapOcrReading,
  upsertDocument,
} from './pdf';
import { createBackupTarget, createSnapshotSource } from './backupTarget';
import { getStorageUsage } from './usage';
import { createNote } from './notes';
import { attachTags, createTag } from './tags';
import { freshDatabase, save } from './test-vault';

beforeEach(async () => {
  await freshDatabase();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

const DOC = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

const doc = (over: Partial<Parameters<typeof upsertDocument>[0]> = {}) => ({
  id: DOC,
  title: 'Cardiac physiology',
  pageCount: 12,
  byteLength: 2048,
  originalUrl: 'https://example.org/papers/cardiac.pdf?token=secret&page=2',
  textStatus: 'text' as const,
  ...over,
});

function anchor(
  page: number,
  exact: string,
  start: number,
  over: Partial<PdfAnchorSet> = {},
): PdfAnchorSet {
  return {
    type: 'pdf',
    textAlgorithm: 'sv-pdf-text-v1',
    documentFingerprint: DOC,
    pageNumber: page,
    rotation: 0,
    rects: [{ x: 0.1, y: 0.2 + start / 10_000, w: 0.5, h: 0.03 }],
    textQuote: { exact, prefix: 'pre ', suffix: ' post' },
    textPosition: { start, end: start + exact.length },
    contentSignature: 'sig-1',
    documentTextLength: 3000,
    ...over,
  };
}

const highlightInput = (
  page: number,
  exact: string,
  start: number,
  over: Partial<PdfHighlightInput> = {},
): PdfHighlightInput => ({
  documentId: DOC,
  anchorSet: anchor(page, exact, start),
  exactQuote: exact,
  kind: 'essential',
  color: 'amber',
  bankId: null,
  userComment: '',
  priority: 3,
  captureMethod: 'toolbar',
  ...over,
});

describe('duplicates across a web page and a PDF', () => {
  it('say which document a PDF member belongs to, so a viewer can open it at that page', async () => {
    const quote = 'Cardiac output is stroke volume times heart rate.';
    await upsertDocument(doc());
    const pdf = (await savePdfHighlight(highlightInput(7, quote, 40))).highlight;
    const web = await save(quote);

    const [cluster] = await findDuplicateClusters();
    expect(cluster?.members).toHaveLength(2);
    const pdfMember = cluster!.members.find((m) => m.highlightId === pdf.id)!;
    const webMember = cluster!.members.find((m) => m.highlightId === web.id)!;
    expect(pdfMember).toMatchObject({ sourceType: 'pdf', pageNumber: 7, documentId: DOC });
    expect('documentId' in webMember).toBe(false); // web members keep the shape callers know

    // the same member is described the same way from the other highlight's detail
    const detail = await getHighlightDetail(web.id);
    expect(detail.duplicates.find((m) => m.highlightId === pdf.id)).toEqual(pdfMember);
  });
});

describe('documents', () => {
  it('upserts by content fingerprint: create, update, keep the first address, revive', async () => {
    const first = await upsertDocument(doc());
    // Credentials never become provenance.
    expect(first.originalUrl).toBe('https://example.org/papers/cardiac.pdf?page=2');
    expect(first).toMatchObject({ id: DOC, pageCount: 12, textStatus: 'text', deletedAt: null });

    const again = await upsertDocument(
      doc({ title: 'Renamed', pageCount: 13, originalUrl: null, textStatus: 'partial' }),
    );
    expect(again).toMatchObject({
      createdAt: first.createdAt,
      title: 'Renamed',
      pageCount: 13,
      textStatus: 'partial',
      originalUrl: first.originalUrl, // a local reopen does not erase where it came from
    });
    expect(await getDb().documents.count()).toBe(1);

    await deleteDocument(DOC);
    expect(await getDocument(DOC)).toBeNull();
    expect((await upsertDocument(doc())).deletedAt).toBeNull();
    expect((await getDocument(DOC))?.id).toBe(DOC);
  });

  it('stores no address for a non-http origin and rejects bad input', async () => {
    const local = await upsertDocument(doc({ originalUrl: 'file:///C:/papers/cardiac.pdf' }));
    expect(local.originalUrl).toBeNull();
    await expect(upsertDocument(doc({ id: 'short' }))).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(upsertDocument(doc({ textStatus: 'weird' as never }))).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(upsertDocument(doc({ pageCount: -1 }))).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });

  it('lists documents with highlight counts and cached sizes', async () => {
    await upsertDocument(doc());
    await upsertDocument(doc({ id: 'b'.repeat(64), title: 'Second' }));
    await savePdfHighlight(highlightInput(1, 'Cardiac output is stroke volume times rate.', 40));
    await savePdfHighlight(highlightInput(2, 'Preload is end-diastolic volume.', 80));
    await cacheDocumentBytes(DOC, new Blob(['%PDF-1.7 fake'], { type: 'application/pdf' }));

    const list = await listDocuments();
    const first = list.find((l) => l.document.id === DOC)!;
    const second = list.find((l) => l.document.id === 'b'.repeat(64))!;
    expect(first).toMatchObject({ highlightCount: 2, cachedBytes: 13 });
    expect(second).toMatchObject({ highlightCount: 0, cachedBytes: null });
  });

  it('does not count a trashed highlight, and counts what is restored again', async () => {
    const { softDeleteHighlight, restoreHighlight } = await import('./repo');
    await upsertDocument(doc());
    await savePdfHighlight(highlightInput(1, 'Cardiac output is stroke volume times rate.', 40));
    const second = await savePdfHighlight(
      highlightInput(2, 'Preload is end-diastolic volume.', 80),
    );
    const count = async () => (await listDocuments()).find((l) => l.document.id === DOC)!;

    expect((await count()).highlightCount).toBe(2);
    await softDeleteHighlight(second.highlight.id);
    expect((await count()).highlightCount).toBe(1);
    await restoreHighlight(second.highlight.id);
    expect((await count()).highlightCount).toBe(2);
  });
});

describe('PDF highlights', () => {
  beforeEach(async () => {
    await upsertDocument(doc());
  });

  it('creates a pdf Source keyed by the document and a highlight with a pdf anchor', async () => {
    const result = await savePdfHighlight(
      highlightInput(3, 'Starling law links filling and output.', 120),
    );
    expect(result).toMatchObject({
      status: 'created',
      addedToBank: true,
      bank: { id: INBOX_BANK_ID },
      highlight: { exactQuote: 'Starling law links filling and output.', bankIds: [INBOX_BANK_ID] },
    });
    expect(result.highlight.anchorSet).toMatchObject({ type: 'pdf', pageNumber: 3 });

    const db = getDb();
    const [source] = await db.sources.toArray();
    expect(source).toMatchObject({
      type: 'pdf',
      documentId: DOC,
      urlKey: `pdf:${DOC}`,
      visitedKey: `pdf:${DOC}`,
      title: 'Cardiac physiology',
      originalUrl: 'https://example.org/papers/cardiac.pdf?page=2',
      host: 'example.org',
    });
    const [row] = await db.highlights.toArray();
    expect(row).toMatchObject({
      sourceId: source!.id,
      captureMethod: 'toolbar',
      resolveStatus: 'unchecked',
      capturedTitle: 'Cardiac physiology',
      capturedUrl: 'https://example.org/papers/cardiac.pdf?page=2',
    });
    expect(row!.quoteHash).toBe(
      createHash('sha256').update('starling law links filling and output.').digest('hex'),
    );
  });

  it('a local document gets a placeholder address that is never shown or indexed', async () => {
    const localId = 'c'.repeat(64);
    await upsertDocument({ ...doc({ id: localId, originalUrl: null }) });
    const input = highlightInput(1, 'Local pdf quote here.', 10, {
      documentId: localId,
      anchorSet: anchor(1, 'Local pdf quote here.', 10, { documentFingerprint: localId }),
    });
    await savePdfHighlight(input);
    const source = (await getDb().sources.toArray()).find((s) => s.documentId === localId)!;
    expect(source.host).toBe('');
    expect(source.originalUrl.startsWith('https://studyvault.invalid/pdf/')).toBe(true);
    const [searchDoc] = await listSearchDocuments({});
    expect(searchDoc).toMatchObject({ url: '', host: '', title: 'Cardiac physiology' });
  });

  it('detects duplicates by document + page + quote + overlap, and restores deleted ones', async () => {
    const q = 'Afterload is the pressure the ventricle works against.';
    const first = await savePdfHighlight(highlightInput(4, q, 500));
    const same = await savePdfHighlight(highlightInput(4, q, 510)); // overlapping text range
    expect(same).toMatchObject({ status: 'duplicate', addedToBank: false });
    expect(same.highlight.id).toBe(first.highlight.id);

    // The same sentence on another page is a different highlight.
    const otherPage = await savePdfHighlight(highlightInput(7, q, 500));
    expect(otherPage.status).toBe('created');
    // Same page, far away, different context: a distinct passage.
    const farAway = await savePdfHighlight(
      highlightInput(4, q, 2500, {
        anchorSet: anchor(4, q, 2500, {
          textQuote: { exact: q, prefix: 'elsewhere ', suffix: ' other' },
        }),
      }),
    );
    expect(farAway.status).toBe('created');
    expect(await getDb().highlights.count()).toBe(3);

    // A duplicate into another bank only adds the membership.
    const bank = await createBank('Physiology');
    const filed = await savePdfHighlight(highlightInput(4, q, 505, { bankId: bank.id }));
    expect(filed).toMatchObject({ status: 'duplicate', addedToBank: true });
    expect(filed.highlight.bankIds.sort()).toEqual([INBOX_BANK_ID, bank.id].sort());

    const { softDeleteHighlight } = await import('./repo');
    await softDeleteHighlight(first.highlight.id);
    const back = await savePdfHighlight(highlightInput(4, q, 500));
    expect(back).toMatchObject({ status: 'restored' });
    expect(back.highlight.id).toBe(first.highlight.id);
  });

  it('files into a bank and folder; validates the folder', async () => {
    const bank = await createBank('Physiology');
    const other = await createBank('Pharmacology');
    const folder = await createFolder({ bankId: bank.id, name: 'Heart' });
    const wrong = await createFolder({ bankId: other.id, name: 'Elsewhere' });
    const ok = await savePdfHighlight(
      highlightInput(1, 'Folder filed pdf quote.', 5, { bankId: bank.id, folderId: folder.id }),
    );
    const page = await listHighlights({ folderId: folder.id });
    expect(page.items.map((i) => i.highlight.id)).toEqual([ok.highlight.id]);
    await expect(
      savePdfHighlight(
        highlightInput(1, 'Wrong folder quote.', 50, { bankId: bank.id, folderId: wrong.id }),
      ),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('rejects an unknown or trashed document, a foreign fingerprint and an empty quote', async () => {
    const stranger = highlightInput(1, 'Stray quote.', 5, { documentId: 'd'.repeat(64) });
    await expect(savePdfHighlight(stranger)).rejects.toMatchObject({ code: 'invalid_request' });
    const unknown = 'e'.repeat(64);
    await expect(
      savePdfHighlight(
        highlightInput(1, 'Stray quote.', 5, {
          documentId: unknown,
          anchorSet: anchor(1, 'Stray quote.', 5, { documentFingerprint: unknown }),
        }),
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(savePdfHighlight(highlightInput(1, '   ', 5))).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await deleteDocument(DOC);
    await expect(savePdfHighlight(highlightInput(1, 'After delete.', 5))).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(await getDb().highlights.count()).toBe(0);
  });

  it('lists a document highlights in page and position order, and mixes with web ones elsewhere', async () => {
    const a = await savePdfHighlight(highlightInput(5, 'Fifth page, late in the page.', 900));
    const b = await savePdfHighlight(highlightInput(2, 'Second page.', 100));
    const c = await savePdfHighlight(highlightInput(5, 'Fifth page, early in the page.', 20));
    const web = await save('A web quote, not in the document');

    const list = await listPdfHighlights(DOC);
    expect(list.map((h) => h.id)).toEqual([b.highlight.id, c.highlight.id, a.highlight.id]);
    expect(await listPdfHighlights('f'.repeat(64))).toEqual([]);

    // Web page lookups never return PDF highlights (no overlap of keys).
    expect(
      (await getPageHighlights('https://example.com/notes/pharm', null)).highlights.map(
        (h) => h.id,
      ),
    ).toEqual([web.id]);
    // Dashboards and recent lists do include them, flagged as pdf sources.
    const recent = await listRecentHighlights(10);
    const pdf = recent.find((i) => i.highlight.id === a.highlight.id)!;
    expect(pdf.source).toMatchObject({ type: 'pdf', documentId: DOC });
    expect(recent.find((i) => i.highlight.id === web.id)!.source).not.toHaveProperty('type');
    const dash = await listHighlights({ sourceId: pdf.source.id });
    expect(dash.items).toHaveLength(3);
  });
});

describe('cached bytes', () => {
  beforeEach(async () => {
    await upsertDocument(doc());
  });

  it('stores one copy per document, with size and sha-256, and gives the same bytes back', async () => {
    const bytes = new TextEncoder().encode('%PDF-1.7\nhello pdf bytes');
    const info = await cacheDocumentBytes(DOC, new Blob([bytes], { type: 'application/pdf' }));
    expect(info).toMatchObject({
      documentId: DOC,
      byteLength: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      matchesDocumentId: false,
    });
    const back = await getDocumentBytes(DOC);
    expect(new Uint8Array(await back!.arrayBuffer())).toEqual(bytes);
    expect(back!.type).toBe('application/pdf');

    // Replace: still one attachment.
    await cacheDocumentBytes(DOC, new Blob(['second copy']));
    expect(await getDb().attachments.count()).toBe(1);
    expect(await removeDocumentBytes(DOC)).toBe(true);
    expect(await removeDocumentBytes(DOC)).toBe(false);
    expect(await getDocumentBytes(DOC)).toBeNull();
  });

  it('knows when the document id is the content hash', async () => {
    const bytes = new TextEncoder().encode('content addressed');
    const id = createHash('sha256').update(bytes).digest('hex');
    await upsertDocument(doc({ id }));
    expect((await cacheDocumentBytes(id, new Blob([bytes]))).matchesDocumentId).toBe(true);
  });

  it('refuses empty, oversized and unknown-document copies', async () => {
    await expect(cacheDocumentBytes(DOC, new Blob([]))).rejects.toMatchObject({
      code: 'invalid_request',
    });
    const huge = {
      size: MAX_CACHED_PDF_BYTES + 1,
      type: 'application/pdf',
      arrayBuffer: async () => new ArrayBuffer(0),
    };
    await expect(cacheDocumentBytes(DOC, huge as unknown as Blob)).rejects.toMatchObject({
      code: 'quota_exceeded',
    });
    await expect(cacheDocumentBytes('9'.repeat(64), new Blob(['x']))).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(cacheDocumentBytes(DOC, 'not a blob' as never)).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(await getDb().attachments.count()).toBe(0);
  });
});

describe('OCR pages', () => {
  beforeEach(async () => {
    await upsertDocument(doc({ textStatus: 'scanned' }));
  });

  it('saves, reads in page order, keeps a user correction across re-recognition, and clears', async () => {
    const words = [
      { text: 'Hello', x: 0.1, y: 0.1, w: 0.1, h: 0.02, confidence: 0.93 },
      { text: 'world', x: 0.22, y: 0.1, w: 0.1, h: 0.02, confidence: 0.5 },
    ];
    await saveOcrPage({
      documentId: DOC,
      pageNumber: 2,
      text: 'Hello world',
      words,
      language: 'eng',
      engine: 'tesseract-7',
      confidence: 0.7,
    });
    const first = await saveOcrPage({
      documentId: DOC,
      pageNumber: 1,
      text: 'Page one',
      language: 'eng',
      engine: 'tesseract-7',
    });
    expect(first).toMatchObject({ words: [], correctedText: null, confidence: null });

    const fixed = await saveOcrPage({
      documentId: DOC,
      pageNumber: 2,
      text: 'Hello world',
      words,
      language: 'eng',
      engine: 'tesseract-7',
      correctedText: 'Hello, world.',
    });
    expect(fixed.correctedText).toBe('Hello, world.');

    // Re-running the recogniser replaces the OCR text but not the user's correction.
    const rerun = await saveOcrPage({
      documentId: DOC,
      pageNumber: 2,
      text: 'Hello world!',
      words,
      language: 'eng',
      engine: 'tesseract-7',
    });
    expect(rerun).toMatchObject({
      text: 'Hello world!',
      correctedText: 'Hello, world.',
      createdAt: fixed.createdAt,
    });
    // null clears it.
    expect(
      (
        await saveOcrPage({
          documentId: DOC,
          pageNumber: 2,
          text: 'x',
          language: 'eng',
          engine: 'e',
          correctedText: null,
        })
      ).correctedText,
    ).toBeNull();

    expect((await getOcrPages(DOC)).map((p) => p.pageNumber)).toEqual([1, 2]);
    expect(await clearOcr(DOC, [1])).toBe(1);
    expect((await getOcrPages(DOC)).map((p) => p.pageNumber)).toEqual([2]);
    expect(await clearOcr(DOC)).toBe(1);
    expect(await getOcrPages(DOC)).toEqual([]);
  });

  it('records the turn a sideways scan needed, keeps it through a correction and an omitted value', async () => {
    const base = {
      documentId: DOC,
      pageNumber: 1,
      text: 'Technology Goals',
      words: [{ text: 'Technology', x: 0.1, y: 0.2, w: 0.04, h: 0.3, confidence: 0.9 }],
      language: 'eng',
      engine: 'tesseract-7',
      confidence: 0.9,
    };
    // a page recognised before orientation checks has no field: read as 0 by every consumer
    const old = await saveOcrPage(base);
    expect(old.orientation).toBeUndefined();
    expect('orientation' in old).toBe(false);

    const turned = await saveOcrPage({ ...base, orientation: 90 });
    expect(turned.orientation).toBe(90);
    expect((await getOcrPages(DOC))[0]!.orientation).toBe(90);

    // a correction saved without the turn does not forget it
    const fixed = await saveOcrPage({ ...base, correctedText: 'Technology Goals!' });
    expect(fixed).toMatchObject({ orientation: 90, correctedText: 'Technology Goals!' });

    // a re-recognition that read the page upright says so
    expect((await saveOcrPage({ ...base, orientation: 0 })).orientation).toBe(0);

    // only quarter turns are stored
    await expect(saveOcrPage({ ...base, orientation: 45 as never })).rejects.toThrow();
  });

  describe('reading a page again', () => {
    const word = (text: string, y: number) => ({
      text,
      x: 0.1,
      y,
      w: 0.2,
      h: 0.02,
      confidence: 0.8,
    });
    const first = {
      documentId: DOC,
      pageNumber: 1,
      text: 'tbe cat sat',
      words: [word('tbe', 0.1), word('cat', 0.14), word('sat', 0.18)],
      language: 'eng',
      engine: 'tesseract-7',
      confidence: 0.8,
    };
    const second = {
      ...first,
      text: 'the cat sat',
      words: [word('the', 0.1), word('cat', 0.14), word('sat', 0.18)],
      confidence: 0.9,
    };

    it('puts the new reading in place and keeps the replaced one, corrections and turn included', async () => {
      await saveOcrPage({ ...first, correctedText: 'the cat sat', orientation: 90 });
      const put = vi.spyOn((await getDb()).ocrPages, 'put');
      const row = await replaceOcrPage({ ...second, orientation: 0 });
      // new text and the replaced reading are ONE write
      expect(put).toHaveBeenCalledTimes(1);
      expect(put.mock.calls[0]![0]).toMatchObject({
        text: 'the cat sat',
        previousReading: { text: 'tbe cat sat' },
      });
      put.mockRestore();
      expect(row).toMatchObject({
        text: 'the cat sat',
        correctedText: null, // the old correction belongs to the old reading
        orientation: 0,
        previousReading: {
          text: 'tbe cat sat',
          correctedText: 'the cat sat',
          orientation: 90,
          confidence: 0.8,
          engine: 'tesseract-7',
        },
      });
      expect(row.previousReading!.words.map((w) => w.text)).toEqual(['tbe', 'cat', 'sat']);
      expect(row.previousReading!.replacedAt).toBe(row.updatedAt);
      expect((await getOcrPages(DOC))[0]).toEqual(row);
    });

    it('carries the corrections the caller mapped, and a first reading has no earlier one', async () => {
      const fresh = await replaceOcrPage({ ...first, correctedText: 'the cat sat' });
      expect(fresh.previousReading).toBeUndefined();
      expect('previousReading' in fresh).toBe(false);
      const again = await replaceOcrPage({ ...second, correctedText: 'The cat sat.' });
      expect(again.correctedText).toBe('The cat sat.');
      expect(again.previousReading?.text).toBe('tbe cat sat');
    });

    it('is one transaction: a write that fails leaves the stored reading as it was', async () => {
      await saveOcrPage({ ...first, correctedText: 'fixed' });
      const before = (await getOcrPages(DOC))[0]!;
      const db = await getDb();
      const put = vi.spyOn(db.ocrPages, 'put').mockRejectedValueOnce(new Error('disk full'));
      await expect(replaceOcrPage(second)).rejects.toThrow();
      put.mockRestore();
      expect((await getOcrPages(DOC))[0]).toEqual(before);
      expect(before.previousReading).toBeUndefined();
    });

    it('validates before it writes: a bad box changes nothing', async () => {
      await saveOcrPage(first);
      await expect(
        replaceOcrPage({ ...second, words: [{ ...word('x', 0.1), x: 4 }] }),
      ).rejects.toMatchObject({ code: 'invalid_request' });
      expect((await getOcrPages(DOC))[0]).toMatchObject({ text: 'tbe cat sat' });
    });

    it('keeps the earlier reading through a correction and swaps both ways without losing either', async () => {
      await saveOcrPage({ ...first, correctedText: 'old fix' });
      await replaceOcrPage(second);
      const edited = await saveOcrPage({ ...second, correctedText: 'new fix' });
      expect(edited.previousReading?.text).toBe('tbe cat sat'); // a correction does not use it up

      const back = await swapOcrReading(DOC, 1);
      expect(back).toMatchObject({
        text: 'tbe cat sat',
        correctedText: 'old fix',
        words: first.words,
        previousReading: { text: 'the cat sat', correctedText: 'new fix', confidence: 0.9 },
      });
      const forward = await swapOcrReading(DOC, 1);
      expect(forward).toMatchObject({
        text: 'the cat sat',
        correctedText: 'new fix',
        previousReading: { text: 'tbe cat sat', correctedText: 'old fix' },
      });
    });

    it('refuses a swap with nothing to swap, an unknown page and an unknown document', async () => {
      await saveOcrPage(first);
      await expect(swapOcrReading(DOC, 1)).rejects.toMatchObject({ code: 'not_found' });
      await expect(swapOcrReading(DOC, 9)).rejects.toMatchObject({ code: 'not_found' });
      await expect(swapOcrReading('z'.repeat(64), 1)).rejects.toMatchObject({ code: 'not_found' });
      await expect(swapOcrReading(DOC, 0)).rejects.toMatchObject({ code: 'invalid_request' });
    });

    it('a damaged slot reads as absent and never makes the page unreadable', async () => {
      await saveOcrPage(first);
      await replaceOcrPage(second);
      const db = await getDb();
      await db.ocrPages.update([DOC, 1], { previousReading: { text: 7 } as never });
      const [page] = await getOcrPages(DOC);
      expect(page).toMatchObject({ text: 'the cat sat' });
      expect(page!.previousReading).toBeUndefined();
    });

    it('never goes into a backup, but the rest of the row does', async () => {
      await saveOcrPage(first);
      await replaceOcrPage(second);
      const kept = await (await getDb()).ocrPages.get([DOC, 1]);
      expect(kept?.previousReading?.text).toBe('tbe cat sat'); // it is stored...

      const snapshot = await createSnapshotSource();
      const exported = (await snapshot.readTable('ocrPages', {
        limit: 10,
      })) as readonly Record<string, unknown>[];
      expect(exported).toHaveLength(1);
      expect(exported[0]).toMatchObject({ text: 'the cat sat', pageNumber: 1 });
      expect('previousReading' in exported[0]!).toBe(false); // ...and left out of the archive

      const live = (await createBackupTarget().readTable('ocrPages', {
        limit: 10,
      })) as readonly Record<string, unknown>[];
      expect('previousReading' in live[0]!).toBe(false);
    });

    it('goes with the page when its text is cleared', async () => {
      await saveOcrPage(first);
      await replaceOcrPage(second);
      expect(await clearOcr(DOC, [1])).toBe(1);
      expect(await getOcrPages(DOC)).toEqual([]);
      expect(await (await getDb()).ocrPages.count()).toBe(0);
    });
  });

  it('validates word boxes and the document', async () => {
    const bad = (words: unknown) =>
      expect(
        saveOcrPage({
          documentId: DOC,
          pageNumber: 1,
          text: 't',
          language: 'eng',
          engine: 'e',
          words: words as never,
        }),
      ).rejects.toMatchObject({ code: 'invalid_request' });
    await bad([{ text: 'a', x: 2, y: 0, w: 0.1, h: 0.1, confidence: 0.5 }]);
    await bad([{ text: 'a', x: 0, y: 0, w: 0.1, h: 0.1, confidence: 7 }]);
    await expect(
      saveOcrPage({ documentId: DOC, pageNumber: 0, text: 't', language: 'eng', engine: 'e' }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      saveOcrPage({
        documentId: 'z'.repeat(64),
        pageNumber: 1,
        text: 't',
        language: 'eng',
        engine: 'e',
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('storage usage and wiping', () => {
  it('reports rows per table, cached bytes and the browser estimate when there is one', async () => {
    await upsertDocument(doc());
    await cacheDocumentBytes(DOC, new Blob(['123456789']));
    await save('Counted row');
    expect(await getStorageUsage()).toMatchObject({
      rows: { highlights: 1, documents: 1, attachments: 1, banks: 1, sources: 1 },
      cachedPdfBytes: 9,
      cachedPdfCount: 1,
      estimate: null, // Node has no navigator.storage
    });
    vi.stubGlobal('navigator', {
      storage: { estimate: async () => ({ usage: 1234, quota: 99_999 }) },
    });
    try {
      expect((await getStorageUsage()).estimate).toEqual({ usage: 1234, quota: 99_999 });
    } finally {
      vi.unstubAllGlobals();
    }
    const usage = await getStorageUsage();
    expect(Object.keys(usage.rows).sort()).toEqual(
      [
        'aiResults',
        'attachments',
        'banks',
        'cards',
        'decks',
        'documents',
        'filingRules',
        'folders',
        'highlightBanks',
        'highlightTags',
        'highlights',
        'knowledgePoints',
        'meta',
        'notes',
        'ocrPages',
        'relations',
        'reviewLogs',
        'sources',
        'syllabi',
        'syncConflicts',
        'syncEntityMeta',
        'syncOps',
        'syncQuarantine',
        'tags',
      ].sort(),
    );
  });

  it('wipeAllData empties every table, including other modules, bytes and OCR', async () => {
    await upsertDocument(doc());
    await cacheDocumentBytes(DOC, new Blob(['bytes']));
    await saveOcrPage({ documentId: DOC, pageNumber: 1, text: 't', language: 'eng', engine: 'e' });
    const h = await save('To be wiped');
    const tag = (await createTag('Wiped tag')).tag;
    await attachTags({ highlightIds: [h.id], tagIds: [tag.id] });
    await createNote({ highlightId: h.id, body: 'wiped note' });
    const db = getDb();
    await db.cards.put({ id: 'card-0000001' });
    await db.reviewLogs.put({ id: 'log-0000001', cardId: 'card-0000001' });
    await db.syncOps.put({ id: 'op-00000001' });
    await db.meta.put({ key: 'custom', value: 1, updatedAt: '2026-01-01T00:00:00.000Z' });
    await fakeBrowser.storage.local.set({ settings: { x: 1 } });

    await wipeAllData();

    const after = await getStorageUsage();
    // Every table is empty but one row: the search-index generation that tells open pages to drop
    // the text they hold (an opaque token, no content).
    expect(Object.entries(after.rows).filter(([name, n]) => name !== 'meta' && n !== 0)).toEqual(
      [],
    );
    expect((await getDb().meta.toArray()).map((r) => r.key)).toEqual(['searchIndexStale']);
    expect(after.totalRows).toBe(1);
    expect(await fakeBrowser.storage.local.get('settings')).toEqual({});
    // And the recreated database is a normal, writable database.
    expect((await save('After the wipe')).bankIds).toEqual([INBOX_BANK_ID]);
  });
});
