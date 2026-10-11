import {
  MAX_PDF_BYTES,
  PdfOpenError,
  documentFingerprint,
  fetchPdf,
  hasPdfHeader,
  openPdf,
  pageHasText,
  readFile,
  samplePageNumbers,
  summarizeTextStatus,
  type FetchFailure,
  type OcrWordInput,
  type PdfDocument,
  type PdfStore,
  type TextStatus,
} from '@pdf';
import { MAX_TITLE_CHARS } from '@shared';

/** Opening a document: bytes -> identity -> pdf.js -> text status -> store. UI-free and testable. */

export interface Session {
  doc: PdfDocument;
  /** Content fingerprint; also the document id in the store. */
  id: string;
  title: string;
  byteLength: number;
  originalUrl: string | null;
  fingerprintNote: string | null;
  textStatus: TextStatus;
  /** The document row exists in the store (it is not written from a private window). */
  persisted: boolean;
  /** Per-page "has embedded text" verdicts learned so far (sampled at open, refined while reading). */
  known: Map<number, boolean>;
}

export interface OpenInput {
  bytes: Uint8Array;
  /** File name or address the bytes came from; used only to name an untitled document. */
  nameHint: string | null;
  originalUrl: string | null;
  store: PdfStore;
  onPassword?: (reason: 'needed' | 'incorrect') => Promise<string | null>;
  onStage?: (stage: string) => void;
  /** False in a private window without consent: nothing about the document is stored. Default true. */
  persist?: boolean;
}

export function titleFrom(metaTitle: string | null, nameHint: string | null): string {
  const clean = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_CHARS);
  if (metaTitle && clean(metaTitle) !== '') return clean(metaTitle);
  if (nameHint) {
    const base = nameHint.split(/[\\/]/).pop() ?? nameHint;
    const stem = base.replace(/\.pdf$/i, '').replace(/[_]+/g, ' ');
    if (clean(stem) !== '') return clean(stem);
  }
  return 'Untitled PDF';
}

export async function openSession(input: OpenInput): Promise<Session> {
  const { bytes, store } = input;
  if (!hasPdfHeader(bytes)) {
    throw new PdfOpenError('invalid', 'This file does not look like a PDF (no %PDF header).');
  }
  input.onStage?.('Identifying the document');
  const byteLength = bytes.byteLength;
  const fp = await documentFingerprint(bytes, null);

  input.onStage?.('Opening');
  const doc = await openPdf(bytes, input.onPassword ? { onPassword: input.onPassword } : {});
  try {
    input.onStage?.('Checking for selectable text');
    const known = new Map<number, boolean>();
    for (const n of samplePageNumbers(doc.pageCount)) {
      try {
        known.set(n, pageHasText(await doc.pageText(n)));
      } catch {
        /* an unreadable page is not evidence either way */
      }
    }
    const textStatus: TextStatus = known.size === 0 ? 'text' : summarizeTextStatus(known);
    const title = titleFrom(doc.title, input.nameHint);

    if (store.getOcrPages) {
      const stored = await store.getOcrPages(fp.id).catch(() => []);
      const pages = new Map<number, OcrWordInput[]>();
      for (const p of stored) {
        if (p.words.length > 0)
          pages.set(
            p.pageNumber,
            p.words.map((w) => ({ text: w.text, x: w.x, y: w.y, w: w.w, h: w.h })),
          );
      }
      if (pages.size > 0) doc.setOcrPages(pages);
    }

    const persisted = input.persist !== false;
    if (persisted) {
      await store.upsertDocument({
        id: fp.id,
        title,
        pageCount: doc.pageCount,
        byteLength,
        originalUrl: input.originalUrl,
        textStatus,
      });
    }
    return {
      doc,
      id: fp.id,
      title,
      byteLength,
      originalUrl: input.originalUrl,
      fingerprintNote: fp.note,
      textStatus,
      persisted,
      known,
    };
  } catch (err) {
    await doc.destroy().catch(() => undefined);
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------------------------

export type LoadFailure =
  | { kind: 'fetch'; failure: FetchFailure }
  | { kind: 'open'; error: PdfOpenError }
  | { kind: 'file'; message: string };

export async function readLocalFile(
  file: File,
  opts: { signal?: AbortSignal; onProgress?: (loaded: number, total: number) => void } = {},
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; failure: LoadFailure }> {
  const looksPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  if (!looksPdf) {
    return {
      ok: false,
      failure: {
        kind: 'file',
        message: `"${file.name}" is not a PDF file. Choose a file that ends in .pdf.`,
      },
    };
  }
  if (file.size === 0)
    return { ok: false, failure: { kind: 'file', message: 'That file is empty.' } };
  if (file.size > MAX_PDF_BYTES) {
    return {
      ok: false,
      failure: {
        kind: 'file',
        message: `That file is ${Math.round(file.size / 1048576)} MB; the reader opens PDFs up to ${Math.round(MAX_PDF_BYTES / 1048576)} MB.`,
      },
    };
  }
  try {
    return { ok: true, bytes: await readFile(file, opts) };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { ok: false, failure: { kind: 'file', message: 'Loading was cancelled.' } };
    }
    return {
      ok: false,
      failure: { kind: 'file', message: 'The file could not be read from your device.' },
    };
  }
}

export { fetchPdf };
