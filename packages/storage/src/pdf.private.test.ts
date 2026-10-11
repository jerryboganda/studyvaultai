// @vitest-environment node
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { PdfAnchorSet, PdfHighlightInput } from '@shared';
import { getDb } from './db';
import {
  assertPdfWriteAllowed,
  cacheDocumentBytes,
  clearOcr,
  deleteDocument,
  getDocument,
  getDocumentBytes,
  getOcrPages,
  listDocuments,
  listPdfHighlights,
  removeDocumentBytes,
  saveOcrPage,
  savePdfHighlight,
  setPdfWriteRestriction,
  upsertDocument,
} from './pdf';
import { freshDatabase } from './test-vault';

/**
 * The private-window rule at the storage write path: whatever page code calls, a PDF write from a
 * restricted page is refused unless "Save from private windows" is on, and nothing is written.
 */

const DOC = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const REASON = 'StudyVault does not save from private (incognito) windows.';

const doc = (id = DOC) => ({
  id,
  title: 'Cardiac physiology',
  pageCount: 12,
  byteLength: 2048,
  originalUrl: 'https://example.org/papers/cardiac.pdf',
  textStatus: 'text' as const,
});

const anchor: PdfAnchorSet = {
  type: 'pdf',
  textAlgorithm: 'sv-pdf-text-v1',
  documentFingerprint: DOC,
  pageNumber: 1,
  rotation: 0,
  rects: [{ x: 0.1, y: 0.2, w: 0.5, h: 0.03 }],
  textQuote: { exact: 'Preload is end-diastolic volume.', prefix: 'pre ', suffix: ' post' },
  textPosition: { start: 40, end: 72 },
  contentSignature: 'sig-1',
  documentTextLength: 3000,
};

const highlight: PdfHighlightInput = {
  documentId: DOC,
  anchorSet: anchor,
  exactQuote: 'Preload is end-diastolic volume.',
  kind: 'essential',
  color: 'amber',
  bankId: null,
  userComment: '',
  priority: 3,
  captureMethod: 'toolbar',
};

const ocrPage = {
  documentId: DOC,
  pageNumber: 2,
  text: 'Recognised text',
  words: [],
  language: 'eng',
  engine: 'tesseract',
  confidence: 0.9,
};

const pdfBytes = () => new Blob(['%PDF-1.7 fake'], { type: 'application/pdf' });

async function setAllowIncognito(allow: boolean): Promise<void> {
  await fakeBrowser.storage.local.set({
    settings: { schemaVersion: 1, allowIncognitoCapture: allow },
  });
}

async function counts() {
  const db = getDb();
  return {
    documents: await db.documents.count(),
    highlights: await db.highlights.count(),
    attachments: await db.attachments.count(),
    ocrPages: await db.ocrPages.count(),
  };
}

beforeEach(async () => {
  await freshDatabase();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => setPdfWriteRestriction(null));

describe('PDF writes from a restricted page (private window)', () => {
  it('refuses the document row, a highlight, a kept copy and recognised text, and writes nothing', async () => {
    await upsertDocument(doc()); // known from a normal window
    const before = await counts();
    setPdfWriteRestriction(() => REASON);

    const refusals = [
      upsertDocument(doc('b'.repeat(64))),
      savePdfHighlight(highlight),
      cacheDocumentBytes(DOC, pdfBytes()),
      saveOcrPage(ocrPage),
    ];
    for (const attempt of refusals) {
      await expect(attempt).rejects.toMatchObject({ code: 'forbidden', message: REASON });
    }

    expect(await counts()).toEqual(before);
    expect(await getDocument('b'.repeat(64))).toBeNull();
  });

  it('is decided at the moment of the write: the setting applies without a reload', async () => {
    setPdfWriteRestriction(() => REASON);
    await expect(upsertDocument(doc())).rejects.toMatchObject({ code: 'forbidden' });

    await setAllowIncognito(true);
    await upsertDocument(doc());
    await savePdfHighlight(highlight);
    await cacheDocumentBytes(DOC, pdfBytes());
    await saveOcrPage(ocrPage);
    expect(await counts()).toEqual({ documents: 1, highlights: 1, attachments: 1, ocrPages: 1 });

    await setAllowIncognito(false);
    await expect(
      savePdfHighlight({ ...highlight, exactQuote: 'Afterload.' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect((await counts()).highlights).toBe(1);
  });

  it('a restriction that reports nothing to restrict (a normal window) lets writes through', async () => {
    setPdfWriteRestriction(() => null);
    await upsertDocument(doc());
    await savePdfHighlight(highlight);
    expect(await counts()).toMatchObject({ documents: 1, highlights: 1 });
  });

  it('an async restriction is awaited', async () => {
    setPdfWriteRestriction(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return REASON;
    });
    await expect(upsertDocument(doc())).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('a page with no restriction registered (service worker, import, tests) is not restricted', async () => {
    setPdfWriteRestriction(null);
    await expect(assertPdfWriteAllowed()).resolves.toBeUndefined();
    await upsertDocument(doc());
    expect((await getDocument(DOC))?.id).toBe(DOC);
  });

  it('never guesses in favour of writing: a failing check refuses the write', async () => {
    setPdfWriteRestriction(() => {
      throw new Error('could not tell');
    });
    await expect(upsertDocument(doc())).rejects.toThrow('could not tell');
    expect((await counts()).documents).toBe(0);

    setPdfWriteRestriction(() => REASON);
    const getItem = vi
      .spyOn(fakeBrowser.storage.local, 'get')
      .mockRejectedValue(new Error('storage unavailable'));
    await expect(upsertDocument(doc())).rejects.toThrow('storage unavailable');
    getItem.mockRestore();
    expect((await counts()).documents).toBe(0);
  });

  it('reading, deleting and removing what is already stored stay available', async () => {
    await upsertDocument(doc());
    await savePdfHighlight(highlight);
    await cacheDocumentBytes(DOC, pdfBytes());
    await saveOcrPage(ocrPage);
    setPdfWriteRestriction(() => REASON);

    expect((await getDocument(DOC))?.id).toBe(DOC);
    expect(await listPdfHighlights(DOC)).toHaveLength(1);
    expect((await listDocuments()).map((d) => d.document.id)).toEqual([DOC]);
    expect(await getOcrPages(DOC)).toHaveLength(1);
    expect(await getDocumentBytes(DOC)).not.toBeNull();

    expect(await removeDocumentBytes(DOC)).toBe(true);
    expect(await clearOcr(DOC)).toBe(1);
    await deleteDocument(DOC);
    expect(await getDocument(DOC)).toBeNull();
  });
});
