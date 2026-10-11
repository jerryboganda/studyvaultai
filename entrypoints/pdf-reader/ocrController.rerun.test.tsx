import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { createMemoryPdfStore } from '@pdf/testing/memoryStore';
import {
  buildOcrPageText,
  buildPdfAnchor,
  usableOcrWords,
  type OcrWordInput,
  type PdfDocument,
  type SavePdfHighlightInput,
} from '@pdf';
import type { OcrJobSummary, RunOcrJobOptions } from '@ocr/runner';
import type { OcrPage } from '@ocr/types';
import type { OcrService } from './ocr';
import { useOcr } from './ocrController';
import { pageOcrFromStored, storedInputFrom, wordsFor, type PageOcr } from './ocrModel';

afterEach(cleanup);

const DOC_ID = 'd'.repeat(64);

/** Two lines of text; `first` and `second` are the words of line one and line two. */
function readingOf(
  pageNumber: number,
  first: string[],
  second: string[],
  corrected: Record<number, string> = {},
): PageOcr {
  const words = [
    ...first.map((text, i) => ({
      text,
      x: 0.1 + i * 0.12,
      y: 0.1,
      w: 0.1,
      h: 0.02,
      confidence: 0.9,
    })),
    ...second.map((text, i) => ({
      text,
      x: 0.1 + i * 0.12,
      y: 0.14,
      w: 0.1,
      h: 0.02,
      confidence: 0.9,
    })),
  ];
  const po = pageOcrFromStored({
    pageNumber,
    text: `${first.join(' ')}\n${second.join(' ')}`,
    correctedText: null,
    language: 'eng',
    engine: 'tesseract 5.1.1',
    confidence: 0.9,
    words,
  });
  po.corrections = { words: {}, lines: corrected };
  return po;
}

const OLD_FIRST = ['Hello', 'world'];
const OLD_SECOND = ['second', 'lien'];
const NEW_FIRST = ['Hallo', 'world'];
const NEW_SECOND = ['second', 'line'];

function fakeDoc(pageCount = 5) {
  const setOcrPages = vi.fn<(pages: ReadonlyMap<number, readonly OcrWordInput[]>) => void>();
  const doc = {
    pageCount,
    pageText: async () => ({ text: 'plenty of real text here' }),
    textSource: async () => 'embedded' as const,
    getPage: async () => {
      throw new Error('not rendered in this test');
    },
    setOcrPages,
  } as unknown as PdfDocument;
  return { doc, setOcrPages };
}

function service(work: (options: Omit<RunOcrJobOptions, 'engine'>) => Promise<OcrJobSummary>) {
  return { run: vi.fn(work), dispose: vi.fn(async () => undefined) } satisfies OcrService & {
    run: ReturnType<typeof vi.fn>;
  };
}

const summary = (over: Partial<OcrJobSummary> = {}): OcrJobSummary => ({
  status: 'completed',
  requested: 1,
  skipped: [],
  saved: [],
  reoriented: [],
  failed: [],
  durationMs: 1,
  ...over,
});

interface Setup {
  oldPages: Map<number, PageOcr>;
  store: ReturnType<typeof createMemoryPdfStore>;
}

/** A vault holding the given recognised pages, and the same pages as the reader has them. */
async function vaultWith(pages: Array<[number, PageOcr]>): Promise<Setup> {
  const store = createMemoryPdfStore();
  for (const [, po] of pages) await store.saveOcrPage!(storedInputFrom(DOC_ID, po));
  return { store, oldPages: new Map(pages) };
}

const mount = (
  s: Setup,
  svc: OcrService | undefined,
  doc: PdfDocument,
  persist = true,
  changed: number[] = [],
) =>
  renderHook(() =>
    useOcr({
      doc,
      documentId: DOC_ID,
      store: s.store,
      service: svc,
      persist,
      initial: s.oldPages,
      onTextChanged: (n) => changed.push(n),
    }),
  );

describe('useOcr: reading recognised pages again', () => {
  it('reads every recognised page with force, replaces each in one write and carries the corrections', async () => {
    const { doc, setOcrPages } = fakeDoc();
    const s = await vaultWith([
      [2, readingOf(2, OLD_FIRST, OLD_SECOND, { 1: 'second line' })],
      [4, readingOf(4, OLD_FIRST, OLD_SECOND)],
    ]);
    const replace = vi.spyOn(s.store, 'replaceOcrPage');
    const save = vi.spyOn(s.store, 'saveOcrPage');
    const changed: number[] = [];
    const svc = service(async (opts) => {
      for (const n of opts.pages) {
        await opts.store.saveOcrPage(readingOf(n, NEW_FIRST, OLD_SECOND).page);
      }
      return summary({ saved: [...opts.pages], requested: opts.pages.length });
    });
    const { result } = mount(s, svc, doc, true, changed);

    act(() => result.current.rerun('document'));
    await waitFor(() => expect(result.current.outcome).not.toBeNull());

    const options = svc.run.mock.calls[0]![0] as RunOcrJobOptions;
    expect(options.pages).toEqual([2, 4]);
    expect(options.force).toBe(true);
    expect(replace).toHaveBeenCalledTimes(2);
    expect(save).not.toHaveBeenCalled(); // a new reading is a replace, never a plain save
    expect(changed).toEqual([2, 4]);

    const rows = await s.store.getOcrPages!(DOC_ID);
    expect(rows.map((r) => [r.pageNumber, r.text, r.correctedText])).toEqual([
      [2, 'Hallo world\nsecond lien', 'Hallo world\nsecond line'], // the correction followed its line
      [4, 'Hallo world\nsecond lien', null],
    ]);
    // the reading each page had is kept, corrections and all
    expect(rows[0]!.previousReading).toMatchObject({
      text: 'Hello world\nsecond lien',
      correctedText: 'Hello world\nsecond line',
    });
    expect(rows[1]!.previousReading?.correctedText).toBeNull();

    // the reader's own copy is the new text, with the step back available
    const page2 = result.current.pages.get(2)!;
    expect(page2.page.text).toBe('Hallo world\nsecond lien');
    expect(page2.corrections.lines).toEqual({ 1: 'second line' });
    expect(page2.previous?.text).toBe('Hello world\nsecond lien');
    expect(setOcrPages.mock.lastCall![0].get(2)!.map((w) => w.text)).toEqual([
      'Hallo',
      'world',
      'second',
      'line',
    ]);
    expect(result.current.outcome).toMatchObject({
      tone: 'success',
      title: 'Recognised 2 pages again',
    });
    expect(result.current.outcome!.detail).toContain('Your corrections: 1 kept.');
  });

  it('keeps the old text until the new reading succeeded, then replaces it', async () => {
    const { doc } = fakeDoc();
    const s = await vaultWith([[2, readingOf(2, OLD_FIRST, OLD_SECOND)]]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reading = false;
    const svc = service(async (opts) => {
      reading = true;
      await gate; // the recogniser is still working on page 2
      await opts.store.saveOcrPage(readingOf(2, NEW_FIRST, NEW_SECOND).page);
      return summary({ saved: [2] });
    });
    const { result } = mount(s, svc, doc);

    act(() => result.current.rerun('page', 2));
    await waitFor(() => expect(reading).toBe(true));
    expect(result.current.run).toMatchObject({ scope: 'page', again: true });
    expect(result.current.pages.get(2)!.page.text).toBe('Hello world\nsecond lien');
    expect((await s.store.getOcrPages!(DOC_ID))[0]!.text).toBe('Hello world\nsecond lien');

    release();
    await waitFor(() => expect(result.current.outcome).not.toBeNull());
    expect(result.current.pages.get(2)!.page.text).toBe('Hallo world\nsecond line');
    expect((await s.store.getOcrPages!(DOC_ID))[0]!.text).toBe('Hallo world\nsecond line');
  });

  it('a cancel keeps the new text of the pages already read and the old text of the others', async () => {
    const { doc } = fakeDoc();
    const s = await vaultWith([
      [1, readingOf(1, OLD_FIRST, OLD_SECOND)],
      [2, readingOf(2, OLD_FIRST, OLD_SECOND)],
      [3, readingOf(3, OLD_FIRST, OLD_SECOND)],
    ]);
    const svc = service(async (opts) => {
      await opts.store.saveOcrPage(readingOf(1, NEW_FIRST, NEW_SECOND).page);
      // page 2 is read, but the run is cancelled before page 3
      await new Promise<void>((resolve) => opts.signal?.addEventListener('abort', () => resolve()));
      return summary({ status: 'cancelled', saved: [1], requested: 3 });
    });
    const { result } = mount(s, svc, doc);
    act(() => result.current.rerun('document'));
    await waitFor(() => expect(result.current.pages.get(1)!.page.text).toContain('Hallo'));
    act(() => result.current.cancel());
    await waitFor(() => expect(result.current.outcome).not.toBeNull());

    expect(result.current.outcome).toMatchObject({
      tone: 'info',
      title: 'Reading again cancelled',
    });
    expect(result.current.outcome!.detail).toContain('Every other page keeps its earlier text');
    const rows = await s.store.getOcrPages!(DOC_ID);
    expect(rows.map((r) => [r.pageNumber, r.text.startsWith('Hallo')])).toEqual([
      [1, true],
      [2, false],
      [3, false],
    ]);
    expect(result.current.pages.get(2)!.previous).toBeUndefined();
  });

  it('a failed write leaves the page as it was and says the run stopped', async () => {
    const { doc } = fakeDoc();
    const s = await vaultWith([[2, readingOf(2, OLD_FIRST, OLD_SECOND)]]);
    vi.spyOn(s.store, 'replaceOcrPage').mockRejectedValue(new Error('disk full'));
    const svc = service(async (opts) => {
      try {
        await opts.store.saveOcrPage(readingOf(2, NEW_FIRST, NEW_SECOND).page);
      } catch (cause) {
        return summary({
          status: 'failed',
          error: {
            code: 'failed',
            message: `could not save OCR text for page 2: ${String(cause)}`,
          },
        });
      }
      return summary({ saved: [2] });
    });
    const { result } = mount(s, svc, doc);
    act(() => result.current.rerun('page', 2));
    await waitFor(() => expect(result.current.outcome).not.toBeNull());
    expect(result.current.outcome).toMatchObject({ tone: 'error' });
    expect(result.current.pages.get(2)!.page.text).toBe('Hello world\nsecond lien');
    expect(result.current.pages.get(2)!.previous).toBeUndefined();
    expect((await s.store.getOcrPages!(DOC_ID))[0]!.text).toBe('Hello world\nsecond lien');
  });

  it('a reading that found no words is not a better text: nothing is replaced', async () => {
    const { doc, setOcrPages } = fakeDoc();
    const s = await vaultWith([[2, readingOf(2, OLD_FIRST, OLD_SECOND)]]);
    const blank: OcrPage = { ...readingOf(2, [], []).page, words: [], lines: [], text: '' };
    const svc = service(async (opts) => {
      await opts.store.saveOcrPage(blank);
      return summary({ saved: [2] });
    });
    const replace = vi.spyOn(s.store, 'replaceOcrPage');
    const { result } = mount(s, svc, doc);
    act(() => result.current.rerun('page', 2));
    await waitFor(() => expect(result.current.outcome).not.toBeNull());
    expect(replace).not.toHaveBeenCalled();
    expect(setOcrPages).not.toHaveBeenCalled();
    expect(result.current.pages.get(2)!.page.text).toBe('Hello world\nsecond lien');
    expect(result.current.outcome).toMatchObject({
      tone: 'warning',
      title: 'No page was replaced',
    });
  });

  it('lists a correction that found no line, and keeps it in the earlier reading', async () => {
    const { doc } = fakeDoc();
    const s = await vaultWith([[2, readingOf(2, OLD_FIRST, OLD_SECOND, { 1: 'second line' })]]);
    // the new reading has one line, and nothing where the corrected line was
    const lonely = readingOf(2, NEW_FIRST, []).page;
    const svc = service(async (opts) => {
      await opts.store.saveOcrPage(lonely);
      return summary({ saved: [2] });
    });
    const { result } = mount(s, svc, doc);
    act(() => result.current.rerun('page', 2));
    await waitFor(() => expect(result.current.outcome).not.toBeNull());
    expect(result.current.outcome!.lines![0]).toContain('Page 2, line 2');
    expect(result.current.outcome!.lines![0]).toContain('second line');
    expect(result.current.pages.get(2)!.corrections.lines).toEqual({});
    expect(result.current.pages.get(2)!.previous?.correctedText).toBe('Hello world\nsecond line');
  });

  it('checks the highlights of the page against the new text and lists the ones it cannot place', async () => {
    const { doc } = fakeDoc();
    const old = readingOf(2, OLD_FIRST, OLD_SECOND);
    const s = await vaultWith([[2, old]]);
    const stream = buildOcrPageText(usableOcrWords(wordsFor(old)));
    const built = buildPdfAnchor({
      documentFingerprint: DOC_ID,
      pageNumber: 2,
      rotation: 0,
      pageText: stream,
      start: stream.text.indexOf('second'),
      end: stream.text.length,
      rects: [],
    });
    if (!built.ok) throw new Error('anchor');
    await s.store.savePdfHighlight({
      documentId: DOC_ID,
      anchorSet: built.anchorSet,
      exactQuote: built.exactQuote,
      kind: 'essential',
      color: 'yellow',
      bankId: null,
      userComment: 'keep me',
      priority: 3,
      captureMethod: 'selection',
    } as unknown as SavePdfHighlightInput);
    // the new reading has other words in that place
    const svc = service(async (opts) => {
      await opts.store.saveOcrPage(readingOf(2, NEW_FIRST, ['entirely', 'different']).page);
      return summary({ saved: [2] });
    });
    const { result } = mount(s, svc, doc);
    act(() => result.current.rerun('page', 2));
    await waitFor(() => expect(result.current.outcome).not.toBeNull());

    expect(result.current.outcome!.tone).toBe('warning');
    expect(result.current.outcome!.detail).toContain('0 found again, 1 could not be placed');
    expect(result.current.outcome!.lines!.join(' ')).toContain('second lien');
    // never deleted: it is still the person's highlight, with its note
    const kept = await s.store.listPdfHighlights(DOC_ID);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.userComment).toBe('keep me');
  });

  it('measures the time a page took, for the next estimate', async () => {
    const { doc } = fakeDoc();
    const s = await vaultWith([
      [2, readingOf(2, OLD_FIRST, OLD_SECOND)],
      [4, readingOf(4, OLD_FIRST, OLD_SECOND)],
    ]);
    const svc = service(async (opts) => {
      for (const n of opts.pages)
        await opts.store.saveOcrPage(readingOf(n, NEW_FIRST, NEW_SECOND).page);
      return summary({ saved: [2, 4], requested: 2, durationMs: 12_000 });
    });
    const { result } = mount(s, svc, doc);
    expect(result.current.msPerPage).toBeNull();
    act(() => result.current.rerun('document'));
    await waitFor(() => expect(result.current.msPerPage).toBe(6_000));
  });

  it('has nothing to do for a page with no recognised text, and without an engine', async () => {
    const { doc } = fakeDoc();
    const s = await vaultWith([[2, readingOf(2, OLD_FIRST, OLD_SECOND)]]);
    const svc = service(async () => summary());
    const { result } = mount(s, svc, doc);
    act(() => result.current.rerun('page', 3));
    await waitFor(() => expect(result.current.outcome).not.toBeNull());
    expect(result.current.outcome).toMatchObject({ title: 'Nothing to read again' });
    expect(svc.run).not.toHaveBeenCalled();

    const none = mount(s, undefined, doc);
    act(() => none.result.current.rerun('document'));
    expect(none.result.current.run).toBeNull();
    expect(none.result.current.outcome).toBeNull();
  });

  it('a private window reads again for the session only: nothing is written', async () => {
    const { doc } = fakeDoc();
    const s = await vaultWith([[2, readingOf(2, OLD_FIRST, OLD_SECOND)]]);
    const replace = vi.spyOn(s.store, 'replaceOcrPage');
    const save = vi.spyOn(s.store, 'saveOcrPage');
    const swap = vi.spyOn(s.store, 'swapOcrReading');
    const svc = service(async (opts) => {
      await opts.store.saveOcrPage(readingOf(2, NEW_FIRST, NEW_SECOND).page);
      return summary({ saved: [2] });
    });
    const { result } = mount(s, svc, doc, false);
    act(() => result.current.rerun('page', 2));
    await waitFor(() => expect(result.current.pages.get(2)!.page.text).toContain('Hallo'));
    expect(result.current.pages.get(2)!.previous?.text).toBe('Hello world\nsecond lien');
    expect(replace).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();

    // the step back works on the page in memory
    await waitFor(() => expect(result.current.run).toBeNull());
    await act(async () => {
      await result.current.restore(2);
    });
    expect(result.current.pages.get(2)!.page.text).toBe('Hello world\nsecond lien');
    expect(swap).not.toHaveBeenCalled();
    expect((await s.store.getOcrPages!(DOC_ID))[0]!.text).toBe('Hello world\nsecond lien');
  });
});

describe('useOcr: restoring the previous reading', () => {
  it('swaps in the vault, brings the corrections back, and can be swapped back', async () => {
    const { doc, setOcrPages } = fakeDoc();
    const s = await vaultWith([[2, readingOf(2, OLD_FIRST, OLD_SECOND, { 1: 'second line' })]]);
    const svc = service(async (opts) => {
      await opts.store.saveOcrPage(readingOf(2, NEW_FIRST, NEW_SECOND).page);
      return summary({ saved: [2] });
    });
    const { result } = mount(s, svc, doc);
    act(() => result.current.rerun('page', 2));
    await waitFor(() => expect(result.current.outcome).not.toBeNull());
    expect(result.current.pages.get(2)!.page.text).toBe('Hallo world\nsecond line');

    await act(async () => {
      await result.current.restore(2);
    });
    const back = result.current.pages.get(2)!;
    expect(back.page.text).toBe('Hello world\nsecond lien');
    expect(back.corrections.lines).toEqual({ 1: 'second line' }); // the correction is back
    expect(back.previous?.text).toBe('Hallo world\nsecond line');
    const row = (await s.store.getOcrPages!(DOC_ID))[0]!;
    expect(row).toMatchObject({
      text: 'Hello world\nsecond lien',
      correctedText: 'Hello world\nsecond line',
    });
    expect(setOcrPages.mock.lastCall![0].get(2)!.map((w) => w.text)).toEqual([
      'Hello',
      'world',
      'second',
      'line',
    ]);
    expect(result.current.outcome).toMatchObject({
      title: 'Restored the earlier reading of page 2',
    });

    // nothing was lost: the reading it replaced is one more swap away
    await act(async () => {
      await result.current.restore(2);
    });
    expect(result.current.pages.get(2)!.page.text).toBe('Hallo world\nsecond line');
  });

  it('does nothing for a page that was never read again, and surfaces a failing write', async () => {
    const { doc } = fakeDoc();
    const s = await vaultWith([[2, readingOf(2, OLD_FIRST, OLD_SECOND)]]);
    const swap = vi.spyOn(s.store, 'swapOcrReading');
    const { result } = mount(s, undefined, doc);
    await act(async () => {
      await result.current.restore(2);
    });
    expect(swap).not.toHaveBeenCalled();

    const kept = {
      ...readingOf(2, OLD_FIRST, OLD_SECOND),
      previous: {
        text: 'x y',
        correctedText: null,
        words: [],
        language: 'eng',
        engine: 'tesseract 5',
        confidence: null,
        replacedAt: '2026-01-01T00:00:00.000Z',
      },
    };
    const s2 = await vaultWith([[2, kept]]);
    vi.spyOn(s2.store, 'swapOcrReading').mockRejectedValue(new Error('disk full'));
    const failing = mount(s2, undefined, doc);
    await expect(
      act(async () => {
        await failing.result.current.restore(2);
      }),
    ).rejects.toThrow('disk full');
    expect(failing.result.current.pages.get(2)!.page.text).toBe('Hello world\nsecond lien');
  });

  it('keeps the earlier reading through a correction of the page', async () => {
    const { doc } = fakeDoc();
    const s = await vaultWith([[2, readingOf(2, OLD_FIRST, OLD_SECOND)]]);
    const svc = service(async (opts) => {
      await opts.store.saveOcrPage(readingOf(2, NEW_FIRST, NEW_SECOND).page);
      return summary({ saved: [2] });
    });
    const { result } = mount(s, svc, doc);
    act(() => result.current.rerun('page', 2));
    await waitFor(() => expect(result.current.outcome).not.toBeNull());
    await act(async () => {
      await result.current.setLine(2, 0, 'Hello world!');
    });
    expect(result.current.pages.get(2)!.previous?.text).toBe('Hello world\nsecond lien');
    expect((await s.store.getOcrPages!(DOC_ID))[0]!.previousReading?.text).toBe(
      'Hello world\nsecond lien',
    );
  });
});
