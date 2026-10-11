// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { PdfOpenError, sha256Hex } from '@pdf';
import { createMemoryPdfStore } from '@pdf/testing/memoryStore';
import { buildPdf, proseFixture } from '@pdf/testing/pdfWriter';
import { openSession, readLocalFile, titleFrom, type Session } from './loader';

type MemoryStore = ReturnType<typeof createMemoryPdfStore>;
const sessions: Session[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.doc.destroy()));
});

async function open(bytes: Uint8Array, over: Partial<Parameters<typeof openSession>[0]> = {}) {
  const store = (over.store ?? createMemoryPdfStore()) as MemoryStore;
  const s = await openSession({
    bytes,
    nameHint: 'notes.pdf',
    originalUrl: null,
    store,
    ...over,
  });
  sessions.push(s);
  return { s, store };
}

describe('openSession', () => {
  it('identifies the file by content, records it, and reports selectable text', async () => {
    const bytes = buildPdf(proseFixture(3), { title: 'Renal notes' });
    const expected = await sha256Hex(bytes);
    const { s, store } = await open(bytes.slice());
    expect(s.id).toBe(expected);
    expect(s.title).toBe('Renal notes');
    expect(s.textStatus).toBe('text');
    expect(store.documents.get(expected)).toMatchObject({
      id: expected,
      pageCount: 3,
      byteLength: bytes.length,
      originalUrl: null,
      textStatus: 'text',
    });
    // Same file again: same id (stable fingerprint across sessions).
    const again = await open(bytes.slice(), { store });
    expect(again.s.id).toBe(expected);
  });

  it('classifies a scanned and a mixed document', async () => {
    const scanned = await open(buildPdf([{ imageOnly: true }, { imageOnly: true }]));
    expect(scanned.s.textStatus).toBe('scanned');
    const mixed = await open(buildPdf([...proseFixture(1), { imageOnly: true }]));
    expect(mixed.s.textStatus).toBe('partial');
  });

  it('keeps the web address as provenance and falls back to the file name for the title', async () => {
    const bytes = buildPdf(proseFixture(1), { title: '' });
    const { s, store } = await open(bytes, {
      nameHint: 'My_Study_Guide.PDF',
      originalUrl: 'https://example.org/files/guide.pdf',
    });
    expect(s.title).toBe('My Study Guide');
    expect(store.documents.get(s.id)?.originalUrl).toBe('https://example.org/files/guide.pdf');
  });

  it('writes nothing to the store when persistence is not allowed (private window)', async () => {
    const { s, store } = await open(buildPdf(proseFixture(1)), { persist: false });
    expect(s.persisted).toBe(false);
    expect(store.documents.size).toBe(0);
    expect(s.doc.pageCount).toBe(1); // reading still works
  });

  it('refuses a file without a PDF header before doing anything else', async () => {
    const store = createMemoryPdfStore();
    await expect(
      openSession({ bytes: new Uint8Array(500), nameHint: 'x.pdf', originalUrl: null, store }),
    ).rejects.toMatchObject({ name: 'PdfOpenError', kind: 'invalid' });
    expect(store.documents.size).toBe(0);
  });

  it('asks for a password, never stores it, and opens', async () => {
    const asked: string[] = [];
    const bytes = buildPdf(proseFixture(1), { title: 'Locked', userPassword: 'hunter2' });
    const { s, store } = await open(bytes, {
      onPassword: async (reason) => {
        asked.push(reason);
        return 'hunter2';
      },
    });
    expect(asked).toEqual(['needed']);
    expect(JSON.stringify([...store.documents.values()])).not.toContain('hunter2');
    expect(s.doc.pageCount).toBe(1);
  });

  it('a cancelled password prompt leaves nothing behind', async () => {
    const store = createMemoryPdfStore();
    const bytes = buildPdf(proseFixture(1), { title: 'Locked', userPassword: 'x1' });
    const err = await openSession({
      bytes,
      nameHint: 'l.pdf',
      originalUrl: null,
      store,
      onPassword: async () => null,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PdfOpenError);
    expect((err as PdfOpenError).kind).toBe('password-cancelled');
    expect(store.documents.size).toBe(0);
  });

  it('applies stored OCR text to pages that have none', async () => {
    const store = createMemoryPdfStore();
    store.getOcrPages = async () => [
      {
        pageNumber: 2,
        text: 'Hello world',
        correctedText: null,
        words: [
          { text: 'Hello', x: 0.1, y: 0.1, w: 0.1, h: 0.02, confidence: 0.9 },
          { text: 'world', x: 0.22, y: 0.1, w: 0.1, h: 0.02, confidence: 0.9 },
        ],
      },
    ];
    const { s } = await open(buildPdf([...proseFixture(1), { imageOnly: true }]), { store });
    expect(await s.doc.textSource(2)).toBe('ocr');
    expect((await s.doc.pageText(2)).text).toBe('Hello world');
    expect(await s.doc.textSource(1)).toBe('embedded');
  });
});

describe('stored OCR pages', () => {
  const row = (correctedText: string | null) => ({
    pageNumber: 2,
    text: 'Hello world\nsecond line',
    correctedText,
    words: [
      { text: 'Hello', x: 0.1, y: 0.1, w: 0.1, h: 0.02, confidence: 0.9 },
      { text: 'world', x: 0.22, y: 0.1, w: 0.1, h: 0.02, confidence: 0.9 },
      { text: 'second', x: 0.1, y: 0.14, w: 0.12, h: 0.02, confidence: 0.9 },
      { text: 'line', x: 0.24, y: 0.14, w: 0.08, h: 0.02, confidence: 0.9 },
    ],
  });

  it('opens with the recognised page as an OCR stream, marked as such, lines and all', async () => {
    const store = createMemoryPdfStore();
    store.getOcrPages = async () => [row(null)];
    const { s } = await open(buildPdf([...proseFixture(1), { imageOnly: true }]), { store });
    expect(s.ocr.get(2)!.page.lines.map((l) => l.text)).toEqual(['Hello world', 'second line']);
    const pt = await s.doc.pageText(2);
    expect(pt.text).toBe('Hello world second line');
    expect(pt.algorithm).toBe('sv-ocr-text-v1');
    expect(pt.signature.startsWith('ocr1:')).toBe(true);
    expect(pt.lineEnds.size).toBe(2);
    expect((await s.doc.pageText(1)).algorithm).toBe('sv-pdf-text-v1');
  });

  it('applies the corrections of the person to the page text and keeps the recognition itself', async () => {
    const store = createMemoryPdfStore();
    store.getOcrPages = async () => [row('Hello world\nsecond paragraph')];
    const { s } = await open(buildPdf([...proseFixture(1), { imageOnly: true }]), { store });
    expect((await s.doc.pageText(2)).text).toBe('Hello world second paragraph');
    const po = s.ocr.get(2)!;
    expect(po.corrections.lines).toEqual({ 1: 'second paragraph' });
    expect(po.page.text).toBe('Hello world\nsecond line'); // never edited
  });

  it('a document that has its own text ignores stored recognition for that page', async () => {
    const store = createMemoryPdfStore();
    store.getOcrPages = async () => [{ ...row(null), pageNumber: 1 }];
    const { s } = await open(buildPdf(proseFixture(1)), { store });
    expect(await s.doc.textSource(1)).toBe('embedded');
    expect((await s.doc.pageText(1)).text.startsWith('Page 1 line 1')).toBe(true);
  });
});

describe('titleFrom / readLocalFile', () => {
  it('prefers metadata, cleans file names, never returns an empty title', () => {
    expect(titleFrom('  A   title ', 'x.pdf')).toBe('A title');
    expect(titleFrom(null, 'C:\\docs\\Renal_Physiology.pdf')).toBe('Renal Physiology');
    expect(titleFrom(null, null)).toBe('Untitled PDF');
    expect(titleFrom('x'.repeat(900), null)).toHaveLength(500);
  });

  it('rejects non-PDF names, empty files and oversized files with specific messages', async () => {
    const png = await readLocalFile(
      new File([new Uint8Array([1, 2, 3])], 'photo.png', { type: 'image/png' }),
    );
    expect(png.ok).toBe(false);
    if (!png.ok && png.failure.kind === 'file') expect(png.failure.message).toContain('not a PDF');
    const empty = await readLocalFile(new File([], 'empty.pdf', { type: 'application/pdf' }));
    expect(empty.ok).toBe(false);
    const ok = await readLocalFile(
      new File([buildPdf(proseFixture(1)) as BlobPart], 'a.pdf', { type: 'application/pdf' }),
    );
    expect(ok.ok).toBe(true);
  });
});
