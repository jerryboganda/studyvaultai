import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { createMemoryPdfStore } from '@pdf/testing/memoryStore';
import type { OcrWordInput, PdfDocument } from '@pdf';
import type { OcrJobSummary, RunOcrJobOptions } from '@ocr/runner';
import type { OcrPage } from '@ocr/types';
import type { OcrService } from './ocr';
import { renderForOcr, useOcr } from './ocrController';
import { pageOcrFromStored, storedInputFrom } from './ocrModel';

afterEach(cleanup);

const DOC_ID = 'd'.repeat(64);

function recognised(pageNumber: number): OcrPage {
  return pageOcrFromStored({
    pageNumber,
    text: 'Hello world\nsecond line',
    correctedText: null,
    language: 'eng',
    engine: 'tesseract 5.1.1',
    confidence: 0.9,
    words: [
      { text: 'Hello', x: 0.1, y: 0.1, w: 0.1, h: 0.02, confidence: 0.9 },
      { text: 'world', x: 0.22, y: 0.1, w: 0.1, h: 0.02, confidence: 0.5 },
      { text: 'second', x: 0.1, y: 0.14, w: 0.12, h: 0.02, confidence: 0.9 },
      { text: 'line', x: 0.24, y: 0.14, w: 0.08, h: 0.02, confidence: 0.9 },
    ],
  }).page;
}

/** A document whose pages 2 and 4 have no text. */
function fakeDoc(noText: number[] = [2, 4], pageCount = 5) {
  const setOcrPages = vi.fn<(pages: ReadonlyMap<number, readonly OcrWordInput[]>) => void>();
  const doc = {
    pageCount,
    pageText: async (n: number) => ({ text: noText.includes(n) ? '' : 'plenty of real text here' }),
    textSource: async () => 'embedded' as const,
    getPage: async () => {
      throw new Error('not rendered in this test');
    },
    setOcrPages,
  } as unknown as PdfDocument;
  return { doc, setOcrPages };
}

function service(
  work: (options: Omit<RunOcrJobOptions, 'engine'>) => Promise<OcrJobSummary>,
): OcrService & { run: ReturnType<typeof vi.fn> } {
  return { run: vi.fn(work), dispose: vi.fn(async () => undefined) };
}

const completed = (saved: number[]): OcrJobSummary => ({
  status: 'completed',
  requested: saved.length,
  skipped: [],
  saved,
  failed: [],
  durationMs: 1,
});

describe('useOcr', () => {
  it('finds pages without text, recognises them through the job runner and keeps each page', async () => {
    const { doc, setOcrPages } = fakeDoc();
    const store = createMemoryPdfStore();
    const changed: number[] = [];
    const svc = service(async (opts) => {
      for (const n of opts.pages) {
        opts.onProgress?.({
          phase: 'recognizing',
          pageNumber: n,
          completed: 0,
          total: opts.pages.length,
          progress: 0.5,
        });
        await opts.store.saveOcrPage(recognised(n));
      }
      return completed([...opts.pages]);
    });
    const { result } = renderHook(() =>
      useOcr({
        doc,
        documentId: DOC_ID,
        store,
        service: svc,
        persist: true,
        initial: new Map(),
        onTextChanged: (n) => changed.push(n),
      }),
    );

    act(() => result.current.start('document'));
    await waitFor(() => expect(result.current.outcome).not.toBeNull());

    expect(svc.run.mock.calls[0]![0].pages).toEqual([2, 4]);
    expect([...result.current.pages.keys()]).toEqual([2, 4]);
    expect(changed).toEqual([2, 4]);
    expect(result.current.outcome).toMatchObject({ tone: 'success', title: 'Recognised 2 pages' });
    expect(result.current.run).toBeNull();
    // Stored in the vault exactly as recognised, no corrections.
    const rows = await store.getOcrPages!(DOC_ID);
    expect(rows.map((r) => [r.pageNumber, r.correctedText])).toEqual([
      [2, null],
      [4, null],
    ]);
    expect(rows[0]!.text).toBe('Hello world\nsecond line');
    // The document is told the words (with their lines) so its text layer and streams update.
    const lastWords = setOcrPages.mock.lastCall![0].get(4)!;
    expect(lastWords.map((w) => w.text)).toEqual(['Hello', 'world', 'second', 'line']);
    expect(lastWords.map((w) => w.line)).toEqual([0, 0, 1, 1]);
  });

  it('a page job recognises only that page, and does nothing when no service is available', async () => {
    const { doc } = fakeDoc();
    const svc = service(async (opts) => {
      await opts.store.saveOcrPage(recognised(opts.pages[0]!));
      return completed([...opts.pages]);
    });
    const { result } = renderHook(() =>
      useOcr({
        doc,
        documentId: DOC_ID,
        store: createMemoryPdfStore(),
        service: svc,
        persist: true,
        initial: new Map(),
        onTextChanged: () => undefined,
      }),
    );
    act(() => result.current.start('page', 2));
    await waitFor(() => expect(result.current.outcome).not.toBeNull());
    expect(svc.run.mock.calls[0]![0].pages).toEqual([2]);

    const none = renderHook(() =>
      useOcr({
        doc,
        documentId: DOC_ID,
        store: createMemoryPdfStore(),
        service: undefined,
        persist: true,
        initial: new Map(),
        onTextChanged: () => undefined,
      }),
    );
    act(() => none.result.current.start('document'));
    expect(none.result.current.run).toBeNull();
    expect(none.result.current.outcome).toBeNull();
  });

  it('cancel aborts the signal the runner got and reports what was kept', async () => {
    const { doc } = fakeDoc();
    let signal: AbortSignal | undefined;
    const svc = service(async (opts) => {
      signal = opts.signal;
      await opts.store.saveOcrPage(recognised(2));
      await new Promise<void>((resolve) => opts.signal?.addEventListener('abort', () => resolve()));
      return { ...completed([2]), status: 'cancelled' };
    });
    const { result } = renderHook(() =>
      useOcr({
        doc,
        documentId: DOC_ID,
        store: createMemoryPdfStore(),
        service: svc,
        persist: true,
        initial: new Map(),
        onTextChanged: () => undefined,
      }),
    );
    act(() => result.current.start('document'));
    await waitFor(() => expect(result.current.pages.size).toBe(1));
    expect(result.current.run).not.toBeNull();
    act(() => result.current.cancel());
    await waitFor(() => expect(result.current.outcome).not.toBeNull());
    expect(signal?.aborted).toBe(true);
    expect(result.current.outcome).toMatchObject({ tone: 'info', codes: ['cancelled'] });
    expect(result.current.pages.size).toBe(1);
  });

  it('resume: pages already stored are handed to the runner as stored', async () => {
    const { doc } = fakeDoc();
    const store = createMemoryPdfStore();
    await store.saveOcrPage!({
      documentId: DOC_ID,
      pageNumber: 2,
      text: 'a',
      words: [],
      language: 'eng',
      engine: 'tesseract 5',
      confidence: null,
    });
    let seen: number[] = [];
    const svc = service(async (opts) => {
      seen = [...(await opts.store.storedPageNumbers())];
      return completed([]);
    });
    const { result } = renderHook(() =>
      useOcr({
        doc,
        documentId: DOC_ID,
        store,
        service: svc,
        persist: true,
        initial: new Map(),
        onTextChanged: () => undefined,
      }),
    );
    act(() => result.current.start('document'));
    await waitFor(() => expect(result.current.outcome).not.toBeNull());
    expect(seen).toEqual([2]);
  });

  it('the engine failing to load is shown with the error taxonomy, not thrown', async () => {
    const { doc } = fakeDoc();
    const svc = service(async () => {
      throw new Error('Failed to fetch dynamically imported module');
    });
    const { result } = renderHook(() =>
      useOcr({
        doc,
        documentId: DOC_ID,
        store: createMemoryPdfStore(),
        service: svc,
        persist: true,
        initial: new Map(),
        onTextChanged: () => undefined,
      }),
    );
    act(() => result.current.start('document'));
    await waitFor(() => expect(result.current.outcome).not.toBeNull());
    expect(result.current.outcome).toMatchObject({ tone: 'error', codes: ['asset-missing'] });
    expect(result.current.run).toBeNull();
  });

  it('a private window keeps recognised text for the session only', async () => {
    const { doc } = fakeDoc();
    const store = createMemoryPdfStore();
    const save = vi.spyOn(store, 'saveOcrPage');
    const svc = service(async (opts) => {
      await opts.store.saveOcrPage(recognised(2));
      return completed([2]);
    });
    const { result } = renderHook(() =>
      useOcr({
        doc,
        documentId: DOC_ID,
        store,
        service: svc,
        persist: false,
        initial: new Map(),
        onTextChanged: () => undefined,
      }),
    );
    act(() => result.current.start('page', 2));
    await waitFor(() => expect(result.current.pages.size).toBe(1));
    expect(save).not.toHaveBeenCalled();
  });

  it('corrections are stored beside the recognition, reverted exactly, and bump the revision', async () => {
    const { doc, setOcrPages } = fakeDoc();
    const store = createMemoryPdfStore();
    const first = { page: recognised(2), corrections: { words: {}, lines: {} } };
    await store.saveOcrPage!(storedInputFrom(DOC_ID, first));
    const initial = new Map([[2, first]]);
    const { result } = renderHook(() =>
      useOcr({
        doc,
        documentId: DOC_ID,
        store,
        service: undefined,
        persist: true,
        initial,
        onTextChanged: () => undefined,
      }),
    );
    const rev = result.current.revision;
    await act(async () => {
      await result.current.setLine(2, 1, 'second paragraph');
    });
    expect(result.current.revision).toBe(rev + 1);
    expect((await store.getOcrPages!(DOC_ID))[0]!.correctedText).toBe(
      'Hello world\nsecond paragraph',
    );
    expect(setOcrPages.mock.lastCall![0].get(2)!.map((w) => w.text)).toEqual([
      'Hello',
      'world',
      'second',
      'paragraph',
    ]);

    await act(async () => {
      await result.current.revertLine(2, 1);
    });
    expect((await store.getOcrPages!(DOC_ID))[0]!.correctedText).toBeNull();
    expect(setOcrPages.mock.lastCall![0].get(2)!.map((w) => w.text)).toEqual([
      'Hello',
      'world',
      'second',
      'line',
    ]);

    // A failing save leaves the page as it was and surfaces the error to the caller.
    vi.spyOn(store, 'saveOcrPage').mockRejectedValueOnce(new Error('disk full'));
    await expect(
      act(async () => {
        await result.current.setLine(2, 0, 'Changed');
      }),
    ).rejects.toThrow('disk full');
    expect(result.current.pages.get(2)!.corrections.lines).toEqual({});
  });
});

describe('renderForOcr', () => {
  it('renders at 300 dpi within the pixel cap, in the page orientation, and reports the rotation', async () => {
    const render = vi.fn((_args: { canvas: HTMLCanvasElement; viewport: unknown }) => ({
      promise: Promise.resolve(),
      cancel: vi.fn(),
    }));
    const page = {
      rotate: 90,
      getViewport: ({ scale }: { scale: number }) => ({ width: 612 * scale, height: 792 * scale }),
      render,
    };
    const out = await renderForOcr(
      { getPage: async () => page } as unknown as PdfDocument,
      1,
      new AbortController().signal,
    );
    expect(out.rotation).toBe(90);
    expect(out.scale).toBeCloseTo(300 / 72, 3);
    const canvas = render.mock.calls[0]![0].canvas;
    expect(canvas.width * canvas.height).toBeLessThanOrEqual(9_000_000);
    out.release?.();
    expect(canvas.width).toBe(0);
  });

  it('a huge page is scaled down to the pixel cap', async () => {
    const page = {
      rotate: 0,
      getViewport: ({ scale }: { scale: number }) => ({
        width: 2000 * scale,
        height: 3000 * scale,
      }),
      render: () => ({ promise: Promise.resolve(), cancel: () => undefined }),
    };
    const out = await renderForOcr(
      { getPage: async () => page } as unknown as PdfDocument,
      1,
      new AbortController().signal,
    );
    expect(out.scale).toBeLessThan(300 / 72);
    const canvas = out.image as HTMLCanvasElement;
    expect(canvas.width * canvas.height).toBeLessThanOrEqual(9_000_000);
  });
});
