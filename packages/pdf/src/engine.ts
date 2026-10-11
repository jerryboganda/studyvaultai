import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type * as PdfjsNamespace from 'pdfjs-dist/legacy/build/pdf.mjs';
import { ocrWordsToContent, type OcrWordInput } from './ocr';
import { buildPageText, type PageText, type PageTextItem } from './pageText';
import { pageHasText } from './textStatus';

/**
 * Thin wrapper around pdf.js. Everything is local: the worker and its data files are bundled by Vite
 * and handed in through `configurePdfRuntime` (see assets.ts); nothing is fetched from a CDN and
 * pdf.js never receives an address to load (the caller fetches bytes, see source.ts).
 *
 * The LEGACY build is used on purpose: the modern pdfjs-dist 6.x build calls Promise.try,
 * Map.prototype.getOrInsertComputed and Math.sumPrecise natively, which are missing in Chrome 120.
 */
type PdfjsModule = typeof PdfjsNamespace;
export type TextContent = Awaited<ReturnType<PDFPageProxy['getTextContent']>>;

export interface BinaryDataFactoryCtor {
  new (opts: { cMapUrl?: string; standardFontDataUrl?: string; wasmUrl?: string }): {
    fetch(req: { kind: string; filename: string }): Promise<Uint8Array>;
  };
}

export interface PdfRuntime {
  /** URL of the bundled pdf.worker (an extension-origin asset). */
  workerSrc: string;
  /** Resolves cMaps / standard fonts / wasm from bundled assets; see assets.ts. */
  BinaryDataFactory?: BinaryDataFactoryCtor;
}

let runtime: PdfRuntime | null = null;
let loading: Promise<PdfjsModule> | null = null;

export function configurePdfRuntime(rt: PdfRuntime): void {
  runtime = rt;
}

export function loadPdfjs(): Promise<PdfjsModule> {
  loading ??= import('pdfjs-dist/legacy/build/pdf.mjs').then((m) => {
    if (runtime) m.GlobalWorkerOptions.workerSrc = runtime.workerSrc;
    return m;
  });
  return loading;
}

export type PdfOpenErrorKind =
  'password-cancelled' | 'password' | 'invalid' | 'missing' | 'aborted' | 'unknown';

export class PdfOpenError extends Error {
  constructor(
    readonly kind: PdfOpenErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'PdfOpenError';
  }
}

export interface OpenOptions {
  /** Ask the user for the password. Resolve null to give up. The reader never stores what it returns. */
  onPassword?: (reason: 'needed' | 'incorrect') => Promise<string | null>;
  onProgress?: (loaded: number, total: number | null) => void;
}

const MESSAGES: Record<PdfOpenErrorKind, string> = {
  'password-cancelled': 'This PDF is password protected and was not opened.',
  password: 'This PDF is password protected.',
  invalid:
    'This file is not a readable PDF. It may be damaged, cut short by an interrupted download, or not a PDF at all.',
  missing: 'The PDF could not be found.',
  aborted: 'Loading was cancelled.',
  unknown: 'The PDF could not be opened.',
};

export function classifyOpenError(err: unknown): PdfOpenError {
  if (err instanceof PdfOpenError) return err;
  const name = err instanceof Error ? err.name : '';
  const kind: PdfOpenErrorKind =
    name === 'PasswordException'
      ? 'password'
      : name === 'InvalidPDFException' || name === 'FormatError'
        ? 'invalid'
        : name === 'MissingPDFException'
          ? 'missing'
          : name === 'AbortException'
            ? 'aborted'
            : 'unknown';
  return new PdfOpenError(kind, MESSAGES[kind]);
}

export interface PdfDocument {
  readonly pageCount: number;
  /** pdf.js's own fingerprint (MD5 of leading bytes); only the huge-file fallback uses it. */
  readonly pdfjsFingerprint: string | null;
  readonly title: string | null;
  getPage(pageNumber: number): Promise<PDFPageProxy>;
  /** Reading-order text stream of a page (cached; at most CACHE_PAGES pages are kept). */
  pageText(pageNumber: number): Promise<PageText>;
  /** The raw pdf.js text content the text layer is built from (same cache as pageText). */
  textContent(pageNumber: number): Promise<TextContent>;
  /**
   * Where the page's text comes from: the PDF itself, or recognised text (OCR) standing in for a
   * page that has none. OCR text is machine output and may contain errors.
   */
  textSource(pageNumber: number): Promise<'embedded' | 'ocr'>;
  /** Replace the recognised text of pages that have no embedded text; clears the page-text cache. */
  setOcrPages(pages: ReadonlyMap<number, readonly OcrWordInput[]>): void;
  /** The document's original bytes (for a user-approved stored copy). */
  getBytes(): Promise<Uint8Array>;
  destroy(): Promise<void>;
}

const CACHE_PAGES = 24;

function toItems(content: TextContent): PageTextItem[] {
  const out: PageTextItem[] = [];
  for (const it of content.items) {
    if ('str' in it) {
      out.push({
        str: it.str,
        transform: it.transform,
        width: it.width,
        height: it.height,
        dir: it.dir,
      });
    }
  }
  return out;
}

export async function openPdf(bytes: Uint8Array, opts: OpenOptions = {}): Promise<PdfDocument> {
  const pdfjs = await loadPdfjs();
  const Factory = runtime?.BinaryDataFactory;
  const task = pdfjs.getDocument({
    data: bytes,
    // Bundled data files are served through the main thread (see assets.ts); without a factory
    // (unit tests in Node) pdf.js falls back to its own Node loader.
    ...(Factory ? { BinaryDataFactory: Factory, useWorkerFetch: false } : {}),
    enableXfa: false,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
  });
  let cancelled = false;
  let unanswered = false;
  task.onPassword = (update: (password: string) => void, reason: number) => {
    const ask = opts.onPassword;
    if (!ask) {
      unanswered = true;
      void task.destroy();
      return;
    }
    ask(reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD ? 'incorrect' : 'needed').then(
      (pw) => {
        if (pw === null) {
          cancelled = true;
          void task.destroy();
        } else update(pw);
      },
      () => {
        cancelled = true;
        void task.destroy();
      },
    );
  };
  if (opts.onProgress) {
    task.onProgress = (p: { loaded: number; total?: number }) =>
      opts.onProgress?.(p.loaded, p.total ?? null);
  }

  let doc: PDFDocumentProxy;
  try {
    doc = await task.promise;
  } catch (err) {
    if (unanswered) throw new PdfOpenError('password', MESSAGES.password);
    if (cancelled) throw new PdfOpenError('password-cancelled', MESSAGES['password-cancelled']);
    throw classifyOpenError(err);
  }

  let title: string | null = null;
  try {
    const meta = await doc.getMetadata();
    const t = (meta.info as { Title?: unknown } | undefined)?.Title;
    if (typeof t === 'string' && t.trim() !== '') title = t.trim();
  } catch {
    /* metadata is optional */
  }

  let ocrPages: ReadonlyMap<number, readonly OcrWordInput[]> = new Map();
  const cache = new Map<
    number,
    Promise<{ text: PageText; content: TextContent; source: 'embedded' | 'ocr' }>
  >();
  const pages = new Map<number, Promise<PDFPageProxy>>();
  const getPage = (n: number): Promise<PDFPageProxy> => {
    let p = pages.get(n);
    if (!p) {
      p = doc.getPage(n);
      pages.set(n, p);
      p.catch(() => pages.delete(n));
    }
    return p;
  };
  const load = (n: number) => {
    let hit = cache.get(n);
    if (hit) {
      cache.delete(n); // refresh LRU position
    } else {
      hit = (async () => {
        const page = await getPage(n);
        const geometry = { viewBox: page.view, rotate: page.rotate };
        let content = await page.getTextContent();
        let text = buildPageText(toItems(content), geometry);
        let source: 'embedded' | 'ocr' = 'embedded';
        const words = ocrPages.get(n);
        if (!pageHasText(text) && words && words.length > 0) {
          content = ocrWordsToContent(words, page.view);
          text = buildPageText(toItems(content), geometry);
          source = 'ocr';
        }
        return { text, content, source };
      })();
      hit.catch(() => cache.delete(n));
    }
    cache.set(n, hit);
    while (cache.size > CACHE_PAGES) cache.delete(cache.keys().next().value as number);
    return hit;
  };

  return {
    pageCount: doc.numPages,
    pdfjsFingerprint: doc.fingerprints[0] ?? null,
    title,
    getPage,
    pageText: async (n) => (await load(n)).text,
    textContent: async (n) => (await load(n)).content,
    textSource: async (n) => (await load(n)).source,
    setOcrPages: (pages) => {
      ocrPages = pages;
      cache.clear();
    },
    getBytes: () => task.getData(),
    destroy: () => task.destroy(),
  };
}
