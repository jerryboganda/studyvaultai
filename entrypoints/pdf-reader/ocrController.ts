import { useCallback, useEffect, useRef, useState } from 'react';
import { pageHasText, type PdfDocument, type PdfStore } from '@pdf';
import { emptyCorrections, revertLine, setLineText, type OcrCorrections } from '@ocr/corrections';
import { toOcrError } from '@ocr/errors';
import type { OcrJobProgress, RenderedPage } from '@ocr/runner';
import type { OcrService } from './ocr';
import {
  describeOutcome,
  pageOcrFromStored,
  readingFrom,
  storedInputFrom,
  swapReading,
  wordsByPage,
  type OcrOutcome,
  type PageOcr,
} from './ocrModel';
import type { RerunPageResult } from './ocrRerun';

/** Reading a page again needs this module; opening a document and recognising pages does not. */
const loadRerun = () => import('./ocrRerun');

/** 300 dpi is what the engine is tuned for; the pixel cap keeps one page's canvas near 36 MB. */
const TARGET_SCALE = 300 / 72;
const MAX_PIXELS = 9_000_000;

/**
 * One page as an image for recognition, at the orientation the page is shown in by default (a scan
 * stored sideways with /Rotate 90 is upright here). `rotation` tells the engine how the image relates
 * to the page box, so word boxes come back in the raw page frame that anchors are stored in. A scan
 * that is sideways or upside down as it is shown (stored with /Rotate 0) is turned by the job runner
 * when its first reading is poor (`@ocr/orientation`); the turn is added to `rotation` there.
 */
export async function renderForOcr(
  doc: Pick<PdfDocument, 'getPage'>,
  pageNumber: number,
  signal: AbortSignal,
): Promise<RenderedPage> {
  const page = await doc.getPage(pageNumber);
  const rotation = ((((page.rotate ?? 0) % 360) + 360) % 360) as 0 | 90 | 180 | 270;
  const unit = page.getViewport({ scale: 1 });
  const scale = Math.min(
    TARGET_SCALE,
    Math.sqrt(MAX_PIXELS / Math.max(1, unit.width * unit.height)),
  );
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const task = page.render({ canvas, viewport });
  const onAbort = (): void => task.cancel();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    await task.promise;
  } catch (err) {
    canvas.width = 0;
    canvas.height = 0;
    if (signal.aborted) throw new DOMException('Cancelled.', 'AbortError');
    throw err;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  return {
    image: canvas,
    rotation,
    scale,
    release: () => {
      canvas.width = 0;
      canvas.height = 0;
    },
  };
}

export interface OcrRun {
  scope: 'document' | 'page';
  /** Pages that already have recognised text are being read again (nothing is skipped). */
  again?: boolean;
  /** While the pages that need recognising are being found: pages checked so far. */
  finding: { checked: number; total: number } | null;
  progress: OcrJobProgress | null;
}

export interface UseOcrArgs {
  doc: PdfDocument;
  documentId: string;
  store: PdfStore;
  service: OcrService | undefined;
  /** False in a private window without consent: results are kept for this session only. */
  persist: boolean;
  initial: ReadonlyMap<number, PageOcr>;
  /** A page's recognised text or corrections changed: draw it again. */
  onTextChanged(pageNumber: number): void;
}

export interface OcrController {
  pages: ReadonlyMap<number, PageOcr>;
  /** Bumps whenever any page's text changed (highlights are resolved again). */
  revision: number;
  run: OcrRun | null;
  outcome: OcrOutcome | null;
  /** Milliseconds a page took in the last run on this device (null before one finished a page). */
  msPerPage: number | null;
  start(scope: 'document' | 'page', pageNumber?: number): void;
  /**
   * Read recognised pages again: one page, or every page that has recognised text. A page keeps its
   * old text until its new reading succeeded and is then replaced in one write; the replaced reading
   * is kept for one step back (`restore`).
   */
  rerun(scope: 'document' | 'page', pageNumber?: number): void;
  /** Put a page's kept earlier reading back (the reading it replaces is kept in turn). */
  restore(pageNumber: number): Promise<void>;
  cancel(): void;
  dismissOutcome(): void;
  setLine(pageNumber: number, line: number, text: string): Promise<void>;
  revertLine(pageNumber: number, line: number): Promise<void>;
  revertPage(pageNumber: number): Promise<void>;
}

export function useOcr(args: UseOcrArgs): OcrController {
  const { doc, documentId, store, service, persist, onTextChanged } = args;
  const [pages, setPages] = useState(args.initial);
  const pagesRef = useRef(pages);
  const [revision, setRevision] = useState(0);
  const [run, setRun] = useState<OcrRun | null>(null);
  const [outcome, setOutcome] = useState<OcrOutcome | null>(null);
  const [msPerPage, setMsPerPage] = useState<number | null>(null);
  const abort = useRef<AbortController | null>(null);
  const latest = useRef({ doc, documentId, store, service, persist, onTextChanged });
  // The newest props for the callbacks below, which must stay stable across renders.
  useEffect(() => {
    latest.current = { doc, documentId, store, service, persist, onTextChanged };
  });

  const commit = useCallback((next: Map<number, PageOcr>, pageNumber: number): void => {
    pagesRef.current = next;
    setPages(next);
    latest.current.doc.setOcrPages(wordsByPage(next));
    setRevision((r) => r + 1);
    latest.current.onTextChanged(pageNumber);
  }, []);

  // Closing the document (or the page) stops a job in flight: the worker must not outlive it.
  useEffect(
    () => () => {
      abort.current?.abort();
    },
    [],
  );

  const begin = useCallback(
    (scope: 'document' | 'page', pageNumber: number | undefined, again: boolean): void => {
      const { doc, documentId, store, service, persist } = latest.current;
      if (!service || abort.current) return;
      const ac = new AbortController();
      abort.current = ac;
      setOutcome(null);
      void (async () => {
        // What each page that was read again did to the corrections and the highlights on it.
        const results: RerunPageResult[] = [];
        try {
          let targets: number[] = [];
          if (scope === 'page' && pageNumber !== undefined) {
            targets = again && !pagesRef.current.has(pageNumber) ? [] : [pageNumber];
          } else if (again) {
            // Every page that has recognised text: nothing to find, and nothing is skipped.
            targets = [...pagesRef.current.keys()].sort((a, b) => a - b);
          } else {
            setRun({ scope, finding: { checked: 0, total: doc.pageCount }, progress: null });
            for (let n = 1; n <= doc.pageCount && !ac.signal.aborted; n++) {
              // A page already recognised has OCR text and is not a target (resume); a page whose
              // text could not be read is not evidence either way.
              const pt = await doc.pageText(n).catch(() => null);
              if (pt && !pageHasText(pt)) targets.push(n);
              if (n % 8 === 0 || n === doc.pageCount) {
                setRun({ scope, finding: { checked: n, total: doc.pageCount }, progress: null });
              }
            }
          }
          if (ac.signal.aborted) {
            setOutcome(
              describeOutcome({
                status: 'cancelled',
                requested: 0,
                skipped: [],
                saved: [],
                reoriented: [],
                failed: [],
                durationMs: 0,
              }),
            );
            return;
          }
          if (targets.length === 0) {
            setOutcome(
              again
                ? {
                    tone: 'info',
                    title: 'Nothing to read again',
                    detail: 'No page of this document has recognised text yet.',
                    codes: [],
                  }
                : {
                    tone: 'info',
                    title: 'Every page already has text',
                    detail: 'There is nothing to recognise in this document.',
                    codes: [],
                  },
            );
            return;
          }
          // Read once, before the run: the highlights as they are when the person confirmed.
          const highlights = again ? await store.listPdfHighlights(documentId).catch(() => []) : [];
          const rr = again ? await loadRerun() : null;
          setRun({ scope, again, finding: null, progress: null });
          const summary = await service.run({
            pages: targets,
            signal: ac.signal,
            renderPage: (n, signal) => renderForOcr(doc, n, signal),
            force: again,
            store: {
              // Resume: pages already recognised (in the vault or this session) are skipped. A forced
              // run does not ask.
              storedPageNumbers: async () => {
                const rows =
                  persist && store.getOcrPages ? await store.getOcrPages(documentId) : [];
                return new Set([...rows.map((r) => r.pageNumber), ...pagesRef.current.keys()]);
              },
              saveOcrPage: async (page) => {
                const old = again ? pagesRef.current.get(page.pageNumber) : undefined;
                if (old && old.page.words.length > 0 && page.words.length === 0) {
                  // A reading that found no words is a page that could not be read, not a better
                  // text: the earlier text stays and the result says so.
                  results.push({
                    pageNumber: page.pageNumber,
                    kept: [],
                    dropped: [],
                    anchors: [],
                    unchanged: true,
                  });
                  return;
                }
                // The runner calls this only once the page's new reading succeeded: until now the old
                // text was the page's text, and it is replaced here in one write.
                const carried = old && rr ? rr.carryCorrections(old, page) : null;
                let po: PageOcr = { page, corrections: carried?.corrections ?? emptyCorrections() };
                if (old) po = { ...po, previous: readingFrom(old, new Date().toISOString()) };
                if (persist) {
                  if (old && store.replaceOcrPage) {
                    const row = await store.replaceOcrPage(storedInputFrom(documentId, po));
                    if (row.previousReading) po = { ...po, previous: row.previousReading };
                  } else if (store.saveOcrPage) {
                    await store.saveOcrPage(storedInputFrom(documentId, po));
                  }
                }
                if (old && carried) {
                  results.push({
                    pageNumber: page.pageNumber,
                    kept: carried.kept,
                    dropped: carried.dropped,
                    anchors: rr ? rr.checkAnchors(highlights, page.pageNumber, old, po) : [],
                  });
                }
                commit(new Map(pagesRef.current).set(page.pageNumber, po), page.pageNumber);
              },
            },
            onProgress: (progress) => setRun({ scope, again, finding: null, progress }),
          });
          setOutcome(rr ? rr.describeRerun(summary, results) : describeOutcome(summary));
          const timed = summary.saved.length + summary.failed.length;
          if (timed > 0 && summary.status !== 'failed') {
            setMsPerPage(Math.max(1, Math.round(summary.durationMs / timed)));
          }
        } catch (err) {
          const e = toOcrError(err, 'init');
          setOutcome({
            tone: 'error',
            title: 'Text recognition could not start',
            detail: e.code === 'failed' && e.detail ? `${e.message} (${e.detail})` : e.message,
            codes: [e.code],
          });
        } finally {
          abort.current = null;
          setRun(null);
        }
      })();
    },
    [commit],
  );

  const start = useCallback(
    (scope: 'document' | 'page', pageNumber?: number): void => begin(scope, pageNumber, false),
    [begin],
  );
  const rerun = useCallback(
    (scope: 'document' | 'page', pageNumber?: number): void => begin(scope, pageNumber, true),
    [begin],
  );

  const restore = useCallback(
    async (pageNumber: number): Promise<void> => {
      const po = pagesRef.current.get(pageNumber);
      const { store, persist, documentId } = latest.current;
      if (!po?.previous || abort.current) return;
      // The vault swaps inside one transaction and answers with the row it now holds; without it (a
      // window that saves nothing) the same swap is made on the page in memory.
      const next =
        persist && store.swapOcrReading
          ? pageOcrFromStored(await store.swapOcrReading(documentId, pageNumber))
          : swapReading(po, new Date().toISOString());
      if (!next) return;
      const highlights = await store.listPdfHighlights(documentId).catch(() => []);
      const rr = await loadRerun();
      setOutcome(rr.describeRestore(pageNumber, rr.checkAnchors(highlights, pageNumber, po, next)));
      commit(new Map(pagesRef.current).set(pageNumber, next), pageNumber);
    },
    [commit],
  );

  const cancel = useCallback((): void => {
    abort.current?.abort();
  }, []);

  const edit = useCallback(
    async (pageNumber: number, change: (po: PageOcr) => OcrCorrections): Promise<void> => {
      const po = pagesRef.current.get(pageNumber);
      if (!po) return;
      // The kept earlier reading belongs to the page, not to its corrections: it stays.
      const next: PageOcr = { ...po, corrections: change(po) };
      const { store, persist, documentId } = latest.current;
      if (persist && store.saveOcrPage) await store.saveOcrPage(storedInputFrom(documentId, next));
      commit(new Map(pagesRef.current).set(pageNumber, next), pageNumber);
    },
    [commit],
  );

  return {
    pages,
    revision,
    run,
    outcome,
    msPerPage,
    start,
    rerun,
    restore,
    cancel,
    dismissOutcome: useCallback(() => setOutcome(null), []),
    setLine: useCallback(
      (n, line, text) => edit(n, (po) => setLineText(po.corrections, po.page, line, text)),
      [edit],
    ),
    revertLine: useCallback((n, line) => edit(n, (po) => revertLine(po.corrections, line)), [edit]),
    revertPage: useCallback((n) => edit(n, () => emptyCorrections()), [edit]),
  };
}
