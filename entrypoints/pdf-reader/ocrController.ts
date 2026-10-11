import { useCallback, useEffect, useRef, useState } from 'react';
import { pageHasText, type PdfDocument, type PdfStore } from '@pdf';
import { emptyCorrections, revertLine, setLineText, type OcrCorrections } from '@ocr/corrections';
import { toOcrError } from '@ocr/errors';
import type { OcrJobProgress, RenderedPage } from '@ocr/runner';
import type { OcrService } from './ocr';
import {
  describeOutcome,
  storedInputFrom,
  wordsByPage,
  type OcrOutcome,
  type PageOcr,
} from './ocrModel';

/** 300 dpi is what the engine is tuned for; the pixel cap keeps one page's canvas near 36 MB. */
const TARGET_SCALE = 300 / 72;
const MAX_PIXELS = 9_000_000;

/**
 * One page as an image for recognition, at the orientation the page is shown in by default (a scan
 * stored sideways with /Rotate 90 is upright here). `rotation` tells the engine how the image relates
 * to the page box, so word boxes come back in the raw page frame that anchors are stored in.
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
  start(scope: 'document' | 'page', pageNumber?: number): void;
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

  const start = useCallback(
    (scope: 'document' | 'page', pageNumber?: number): void => {
      const { doc, documentId, store, service, persist } = latest.current;
      if (!service || abort.current) return;
      const ac = new AbortController();
      abort.current = ac;
      setOutcome(null);
      void (async () => {
        try {
          let targets: number[] = [];
          if (scope === 'page' && pageNumber !== undefined) targets = [pageNumber];
          else {
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
                failed: [],
                durationMs: 0,
              }),
            );
            return;
          }
          if (targets.length === 0) {
            setOutcome({
              tone: 'info',
              title: 'Every page already has text',
              detail: 'There is nothing to recognise in this document.',
              codes: [],
            });
            return;
          }
          setRun({ scope, finding: null, progress: null });
          const summary = await service.run({
            pages: targets,
            signal: ac.signal,
            renderPage: (n, signal) => renderForOcr(doc, n, signal),
            store: {
              // Resume: pages already recognised (in the vault or this session) are skipped.
              storedPageNumbers: async () => {
                const rows =
                  persist && store.getOcrPages ? await store.getOcrPages(documentId) : [];
                return new Set([...rows.map((r) => r.pageNumber), ...pagesRef.current.keys()]);
              },
              saveOcrPage: async (page) => {
                const po: PageOcr = { page, corrections: emptyCorrections() };
                if (persist && store.saveOcrPage) {
                  await store.saveOcrPage(storedInputFrom(documentId, po));
                }
                commit(new Map(pagesRef.current).set(page.pageNumber, po), page.pageNumber);
              },
            },
            onProgress: (progress) => setRun({ scope, finding: null, progress }),
          });
          setOutcome(describeOutcome(summary));
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

  const cancel = useCallback((): void => {
    abort.current?.abort();
  }, []);

  const edit = useCallback(
    async (pageNumber: number, change: (po: PageOcr) => OcrCorrections): Promise<void> => {
      const po = pagesRef.current.get(pageNumber);
      if (!po) return;
      const next: PageOcr = { page: po.page, corrections: change(po) };
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
    start,
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
