import type { BrowserContext, TestInfo } from '@playwright/test';
import { readRealPdfs, stemOf, type RealPdf } from '../fixtures/pdf/real/manifest';
import { expect } from './helpers.pages';
import {
  bytesOf,
  chooseFile,
  expectPageDrawn,
  goToPage,
  mb,
  openReaderIn,
  preciseMemoryTest as test,
  sampleHeap,
  type HeapSample,
} from './helpers.pdfReal';

/**
 * Windowing and memory on the long real documents (TEST_PLAN PDF matrix item 4: "Long PDF (100+ pages)
 * and memory pressure; lazy render"). Every page of the document is brought on screen, one after the
 * other, through the reader's own scroll position, and the page records:
 *
 *  - the most canvases and text layers that ever existed at once (a MutationObserver sees transient
 *    states too, not only the settled ones): the lazy window must stay bounded whatever the page count;
 *  - the main thread's JS heap after the first page and after the whole traversal, each read after two
 *    forced collections (CDP HeapProfiler.collectGarbage + Performance.getMetrics, and
 *    performance.memory under --enable-precise-memory-info): growth is bounded, so a leak that keeps
 *    one text layer or one page proxy per page visited is caught;
 *  - live DOM nodes and listeners (CDP Memory.getDOMCounters).
 *
 * Limits, stated rather than hidden: pdf.js's own worker heap and the GPU/bitmap memory of canvases
 * are not part of the main thread's JS heap and are not measured here; the canvas bound is what limits
 * them. Numbers are measured on the runner that executes this spec and printed; the bounds below were
 * set from measurements recorded in docs/PERF_REVIEW.md (addendum), with headroom for runner noise.
 */

/** Pages held at once: the pages in view plus one neighbour on each side, two pages in view at most. */
const MAX_CANVASES = 4;
/** The heap may grow by this much over the first-page reading (MB), whatever the page count. */
const MAX_HEAP_GROWTH_MB = 80;
/** ... and by at most this factor. */
const MAX_HEAP_FACTOR = 3;
/** Live DOM nodes after the traversal vs after the first page (a text layer is ~hundreds of nodes). */
const MAX_DOM_GROWTH = 4000;

const LONG = readRealPdfs().filter((p) => p.pages >= 50 && p.text !== 'scanned');

interface Traversal {
  steps: number;
  maxCanvases: number;
  maxTextLayers: number;
  ms: number;
}

function sampleFields(prefix: string, s: HeapSample): Record<string, number | null> {
  return {
    [`${prefix}HeapMB`]: mb(s.heapBytes),
    [`${prefix}PerfMemoryMB`]: s.perfMemoryBytes === null ? null : mb(s.perfMemoryBytes),
    [`${prefix}DomNodes`]: s.domNodes,
    [`${prefix}Listeners`]: s.listeners,
  };
}

async function measure(
  pdf: RealPdf,
  fixture: { context: BrowserContext; extensionId: string },
  testInfo: TestInfo,
): Promise<void> {
  const { page, errors } = await openReaderIn(fixture.context, fixture.extensionId);
  await chooseFile(page, pdf, bytesOf(pdf));
  await expect(page.getByTestId('pdf-viewer')).toBeVisible({ timeout: 60_000 });
  await expectPageDrawn(page, 1);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const first = await sampleHeap(fixture.context, page);

  const t0 = Date.now();
  const traversal: Traversal = await page.evaluate(async (pages) => {
    const scroller = document.querySelector<HTMLElement>('[data-testid="pdf-viewer"]');
    if (!scroller) throw new Error('no viewer');
    let maxCanvases = 0;
    let maxTextLayers = 0;
    const look = (): void => {
      maxCanvases = Math.max(maxCanvases, document.querySelectorAll('canvas.sv-pdf-canvas').length);
      maxTextLayers = Math.max(maxTextLayers, document.querySelectorAll('.sv-textlayer').length);
    };
    const watcher = new MutationObserver(look);
    watcher.observe(scroller, { childList: true, subtree: true });
    const drawn = (n: number): Promise<void> =>
      new Promise((resolve, reject) => {
        const since = performance.now();
        const tick = (): void => {
          look();
          const done = document.querySelector(
            `[data-testid="pdf-page-${n}"] .sv-textlayer .endOfContent`,
          );
          if (done) resolve();
          else if (performance.now() - since > 90_000) reject(new Error(`page ${n} was not drawn`));
          else setTimeout(tick, 15);
        };
        tick();
      });
    let steps = 0;
    for (let n = 1; n <= pages; n++) {
      const slot = document.querySelector<HTMLElement>(`[data-testid="pdf-page-${n}"]`);
      if (!slot) throw new Error(`no slot for page ${n}`);
      scroller.scrollTop = Math.max(0, slot.offsetTop - 8);
      await drawn(n);
      steps++;
    }
    watcher.disconnect();
    return { steps, maxCanvases, maxTextLayers, ms: 0 };
  }, pdf.pages);
  traversal.ms = Date.now() - t0;

  await expect(page.getByTestId('pdf-page-input')).toHaveValue(String(pdf.pages));
  const last = await sampleHeap(fixture.context, page);
  await goToPage(page, 1);
  await expect(page.getByTestId('pdf-page-input')).toHaveValue('1');
  await expectPageDrawn(page, 1);
  const back = await sampleHeap(fixture.context, page);

  const growthMB = mb(last.heapBytes - first.heapBytes);
  const line = JSON.stringify({
    file: pdf.file,
    pages: pdf.pages,
    bytes: pdf.bytes,
    ...sampleFields('afterFirstPage', first),
    ...sampleFields('afterTraversal', last),
    ...sampleFields('afterReturnToPage1', back),
    heapGrowthMB: growthMB,
    heapFactor: Math.round((last.heapBytes / first.heapBytes) * 100) / 100,
    domGrowth: last.domNodes - first.domNodes,
    maxCanvasesAtOnce: traversal.maxCanvases,
    maxTextLayersAtOnce: traversal.maxTextLayers,
    pagesVisited: traversal.steps,
    traversalMs: traversal.ms,
    msPerPage: Math.round(traversal.ms / pdf.pages),
  });
  console.log(`[real-pdf-memory] ${line}`);
  testInfo.annotations.push({ type: 'real-pdf-memory', description: line });
  await testInfo.attach(`memory-${stemOf(pdf)}.json`, {
    body: line,
    contentType: 'application/json',
  });

  // Every page was visited, and the window stayed a window.
  expect(traversal.steps).toBe(pdf.pages);
  expect(traversal.maxCanvases, 'canvases alive at once').toBeLessThanOrEqual(MAX_CANVASES);
  expect(traversal.maxTextLayers, 'text layers alive at once').toBeLessThanOrEqual(MAX_CANVASES);
  // Heap: bounded growth over the first page, after a forced collection each time.
  expect(first.heapBytes).toBeGreaterThan(0);
  expect(mb(last.heapBytes - first.heapBytes), 'heap growth over the first page (MB)').toBeLessThan(
    MAX_HEAP_GROWTH_MB,
  );
  expect(last.heapBytes / first.heapBytes, 'heap factor over the first page').toBeLessThan(
    MAX_HEAP_FACTOR,
  );
  expect(last.domNodes - first.domNodes, 'live DOM nodes gained').toBeLessThan(MAX_DOM_GROWTH);
  // Coming back does not keep growing: what was held is a window, not a history.
  expect(back.heapBytes / last.heapBytes).toBeLessThan(1.25);
  expect(errors, 'no uncaught exception or console error').toEqual([]);
}

test.describe('long documents: lazy window and heap', () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });

  for (const pdf of LONG) {
    test(`${stemOf(pdf)} (${pdf.pages} pages): canvases stay bounded and the heap does not grow with pages visited`, async ({
      memory,
    }, testInfo) => {
      await measure(pdf, memory, testInfo);
    });
  }
});
