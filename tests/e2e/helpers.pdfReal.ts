import { chromium, test as base, type BrowserContext, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RealPdf, RealTextStatus } from '../fixtures/pdf/real/manifest';
import { E2E_EXTENSION_PATH } from './fixtures';
import { expect, type Env } from './helpers.pages';

/**
 * Helpers for the real-PDF specs (pdf-real.spec.ts, pdf-real-memory.spec.ts). Everything drives the
 * real reader in real Chromium: a real file chooser, real selection ranges, the real save bar.
 * Documents come from tests/fixtures/pdf/real (SOURCES.md is the manifest).
 */

/** What the reader prints in the header for each verdict. */
export const STATUS_LABEL: Record<RealTextStatus, string> = {
  text: 'Selectable text',
  scanned: 'No text',
  partial: 'Partly scanned',
};

/** Overlay vs text boxes: real fonts are not the generator's Helvetica, so a little more slack. */
export const ALIGN_TOLERANCE_PX = 12;

export interface Reader {
  page: Page;
  /** Uncaught exceptions and console errors seen since the page opened. */
  errors: string[];
}

export function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    if (msg.location().url.endsWith('/favicon.ico')) return;
    errors.push(`console.error: ${msg.text()}`);
  });
  return errors;
}

export async function openReaderIn(context: BrowserContext, extensionId: string): Promise<Reader> {
  const page = await context.newPage();
  const errors = watchErrors(page);
  await page.goto(`chrome-extension://${extensionId}/pdf-reader.html`);
  await expect(page.getByTestId('pdf-reader')).toBeVisible();
  return { page, errors };
}

export const openReader = (env: Env): Promise<Reader> => openReaderIn(env.context, env.extensionId);

export const bytesOf = (pdf: RealPdf): Buffer => fs.readFileSync(pdf.path);

/** Choose the document through the real file chooser behind "Choose a PDF". */
export async function chooseFile(page: Page, pdf: RealPdf, bytes = bytesOf(pdf)): Promise<void> {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByTestId('pdf-choose-file').click(),
  ]);
  await chooser.setFiles({ name: pdf.file, mimeType: 'application/pdf', buffer: bytes });
}

export interface Opened extends Reader {
  bytes: Buffer;
  /** File chosen -> viewer on screen, in ms. */
  openMs: number;
}

export async function openRealPdf(env: Env, pdf: RealPdf): Promise<Opened> {
  const reader = await openReader(env);
  const bytes = bytesOf(pdf);
  const t0 = Date.now();
  await chooseFile(reader.page, pdf, bytes);
  await expect(reader.page.getByTestId('pdf-viewer')).toBeVisible({ timeout: 60_000 });
  return { ...reader, bytes, openMs: Date.now() - t0 };
}

/**
 * Wait until page `n` is drawn: a canvas exists, has pixels and is not blank (so a document that
 * "rendered" as a white rectangle fails). Returns the share of non-white samples (0..1).
 */
export async function expectPageDrawn(page: Page, n: number, timeout = 60_000): Promise<number> {
  let share = 0;
  await expect
    .poll(
      async () => {
        share = await page.evaluate((pageNumber) => {
          const c = document.querySelector<HTMLCanvasElement>(
            `[data-testid="pdf-page-${pageNumber}"] canvas.sv-pdf-canvas`,
          );
          if (!c || c.width < 2 || c.height < 2) return -1;
          // A 48 x 48 thumbnail of the canvas: cheap, and averaging cannot make real ink vanish.
          const probe = document.createElement('canvas');
          probe.width = 48;
          probe.height = 48;
          const ctx = probe.getContext('2d');
          if (!ctx) return -1;
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, 48, 48);
          ctx.drawImage(c, 0, 0, c.width, c.height, 0, 0, 48, 48);
          const px = ctx.getImageData(0, 0, 48, 48).data;
          let ink = 0;
          for (let i = 0; i < px.length; i += 4) {
            if (Math.min(px[i]!, px[i + 1]!, px[i + 2]!) < 245) ink++;
          }
          return ink / (48 * 48);
        }, n);
        return share;
      },
      { message: `page ${n} should be drawn (non-blank canvas)`, timeout },
    )
    .toBeGreaterThan(0);
  return share;
}

/** Wait for page `n` to have its text layer with text; returns that text. */
export async function textOnPage(page: Page, n: number, timeout = 60_000): Promise<string> {
  const layer = page.locator(`[data-testid="pdf-page-${n}"] .sv-textlayer`);
  await expect(layer).toBeAttached({ timeout });
  await expect
    .poll(async () => ((await layer.textContent()) ?? '').trim().length, { timeout })
    .toBeGreaterThan(0);
  return (await layer.textContent()) ?? '';
}

export async function goToPage(page: Page, n: number): Promise<void> {
  await page.getByTestId('pdf-page-input').fill(String(n));
  await page.getByTestId('pdf-page-input').press('Enter');
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Screen box of the text-layer span(s) of page `n` whose text contains `text` (raw text content). */
export async function spanBox(page: Page, n: number, text: string): Promise<Box> {
  const box = await page.evaluate(
    ({ n, text }) => {
      const rects: DOMRect[] = [];
      for (const sp of document.querySelectorAll<HTMLElement>(
        `[data-testid="pdf-page-${n}"] .sv-textlayer span`,
      )) {
        const node = sp.firstChild;
        if (!node || node.nodeType !== 3) continue;
        const at = (sp.textContent ?? '').indexOf(text);
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + text.length);
        rects.push(range.getBoundingClientRect());
      }
      if (rects.length === 0) return null;
      const x0 = Math.min(...rects.map((r) => r.left));
      const y0 = Math.min(...rects.map((r) => r.top));
      return {
        x: x0,
        y: y0,
        w: Math.max(...rects.map((r) => r.right)) - x0,
        h: Math.max(...rects.map((r) => r.bottom)) - y0,
      };
    },
    { n, text },
  );
  if (!box) throw new Error(`"${text}" is not in the text layer of page ${n}`);
  return box;
}

/** Union box of the painted highlight rectangles of one page. */
export async function highlightBox(page: Page, n: number): Promise<Box | null> {
  return page.evaluate((pageNumber) => {
    const nodes = [
      ...document.querySelectorAll<HTMLElement>(
        `[data-testid="pdf-page-${pageNumber}"] .sv-pdf-hl`,
      ),
    ];
    if (nodes.length === 0) return null;
    const rects = nodes.map((el) => el.getBoundingClientRect());
    const x0 = Math.min(...rects.map((r) => r.left));
    const y0 = Math.min(...rects.map((r) => r.top));
    return {
      x: x0,
      y: y0,
      w: Math.max(...rects.map((r) => r.right)) - x0,
      h: Math.max(...rects.map((r) => r.bottom)) - y0,
    };
  }, n);
}

export interface Passage {
  pageNumber: number;
  /** Raw text of the first and the last span of the passage (may be the same span). */
  first: string;
  last: string;
}

/**
 * Find a passage of real prose on page `n`: two consecutive, vertically adjacent lines of the same
 * column (a wrapped sentence), else one line. Spans must be unique on the page, so a box measured
 * by text means exactly them. Returns null when the page has nothing worth selecting. With
 * `belowFold` only text that is wholly under the bottom edge of the window qualifies.
 */
export async function findPassage(
  page: Page,
  n: number,
  opts: { belowFold?: boolean } = {},
): Promise<Passage | null> {
  return page.evaluate(
    ({ pageNumber, belowFold }) => {
      const leafs = [
        ...document.querySelectorAll<HTMLElement>(
          `[data-testid="pdf-page-${pageNumber}"] .sv-textlayer span`,
        ),
      ].filter((sp) => sp.firstChild?.nodeType === 3 && sp.children.length === 0);
      const raw = leafs.map((sp) => sp.textContent ?? '');
      const count = new Map<string, number>();
      for (const t of raw) count.set(t, (count.get(t) ?? 0) + 1);
      const letters = (t: string): number => (t.match(/\p{L}/gu) ?? []).length;
      const rects = leafs.map((sp) => sp.getBoundingClientRect());
      const usable = (i: number, min: number): boolean => {
        const t = raw[i]!;
        const r = rects[i]!;
        return (
          count.get(t) === 1 &&
          t.trim() === t &&
          t.length <= 200 &&
          letters(t) >= min &&
          r.width > 8 &&
          r.height > 4 &&
          (!belowFold || r.top > window.innerHeight + 40)
        );
      };
      for (let i = 0; i + 1 < leafs.length; i++) {
        if (!usable(i, 12) || !usable(i + 1, 8)) continue;
        const a = rects[i]!;
        const b = rects[i + 1]!;
        const below = b.top > a.top + a.height * 0.5;
        const sameColumn = Math.abs(b.left - a.left) < 60;
        const adjacent = b.top - a.bottom < a.height * 2;
        if (below && sameColumn && adjacent) {
          return { pageNumber, first: raw[i]!, last: raw[i + 1]! };
        }
      }
      for (let i = 0; i < leafs.length; i++) {
        if (usable(i, 10)) return { pageNumber, first: raw[i]!, last: raw[i]! };
      }
      return null;
    },
    { pageNumber: n, belowFold: opts.belowFold === true },
  );
}

/**
 * Select a passage by range (first span's start to last span's end), as a drag would. By default the
 * passage is first scrolled to the middle of the window (a person selects what is on screen);
 * `scroll: false` selects it where it is, even if that is off screen.
 */
export async function selectPassage(
  page: Page,
  p: Passage,
  opts: { scroll?: boolean } = {},
): Promise<void> {
  await page.evaluate(
    ({ pageNumber, first, last, scroll }) => {
      const leafs = [
        ...document.querySelectorAll<HTMLElement>(
          `[data-testid="pdf-page-${pageNumber}"] .sv-textlayer span`,
        ),
      ].filter((sp) => sp.firstChild?.nodeType === 3);
      const a = leafs.find((sp) => sp.textContent === first);
      const b = leafs.find((sp) => sp.textContent === last);
      if (!a?.firstChild || !b?.firstChild) throw new Error('passage is not on the page any more');
      // Instantly: a smooth scroll would move the passage again under the save bar.
      if (scroll) a.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      document
        .getSelection()!
        .setBaseAndExtent(a.firstChild, 0, b.firstChild, (b.textContent ?? '').length);
    },
    { ...p, scroll: opts.scroll !== false },
  );
  await expect(page.getByTestId('pdf-savebar')).toBeVisible();
}

export async function saveSelection(page: Page): Promise<void> {
  await page.getByTestId('pdf-save').click();
  await expect(page.getByTestId('pdf-savebar')).toHaveCount(0);
  await expect(page.getByTestId('pdf-highlight-card').first()).toBeVisible();
}

export async function storedHighlights(page: Page): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('studyvault');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const all = db.transaction('highlights', 'readonly').objectStore('highlights').getAll();
          all.onsuccess = () => {
            db.close();
            resolve(all.result as Array<Record<string, unknown>>);
          };
          all.onerror = () => reject(all.error);
        };
      }),
  );
}

/** The recognised-text rows of the vault (one per recognised page), as stored. */
export async function storedOcrPages(page: Page): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('studyvault');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const all = db.transaction('ocrPages', 'readonly').objectStore('ocrPages').getAll();
          all.onsuccess = () => {
            db.close();
            resolve(all.result as Array<Record<string, unknown>>);
          };
          all.onerror = () => reject(all.error);
        };
      }),
  );
}

/** Wait until the painted highlight of page `n` covers the same screen box as the words it quotes. */
export async function expectOverlayOnWords(
  page: Page,
  n: number,
  parts: string[],
  label: string,
  timeout = 20_000,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const hl = await highlightBox(page, n);
        if (!hl) return 'no overlay';
        const boxes = await Promise.all(parts.map((p) => spanBox(page, n, p)));
        const x0 = Math.min(...boxes.map((b) => b.x));
        const y0 = Math.min(...boxes.map((b) => b.y));
        const x1 = Math.max(...boxes.map((b) => b.x + b.w));
        const y1 = Math.max(...boxes.map((b) => b.y + b.h));
        const off = Math.max(
          Math.abs(hl.x - x0),
          Math.abs(hl.y - y0),
          Math.abs(hl.x + hl.w - x1),
          Math.abs(hl.y + hl.h - y1),
        );
        return off <= ALIGN_TOLERANCE_PX ? 'aligned' : `off by ${Math.round(off)}px`;
      },
      { message: label, timeout },
    )
    .toBe('aligned');
}

/** A query that must occur in `text`: its longest word (CJK runs are cut to four characters). */
export function queryFrom(text: string): string {
  const words = text.split(/[\s,.;:!?()[\]{}"“”'’‘—–\-/\\|•·]+/u).filter(Boolean);
  const longest = words.sort((a, b) => b.length - a.length)[0] ?? text.trim();
  return longest.slice(0, 12);
}

export const squash = (s: string): string => s.replace(/\s+/gu, '');

// ---------------------------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------------------------

/**
 * A context like the shared fixture's, plus `--enable-precise-memory-info` (without it Chromium
 * coarsens `performance.memory`, which would make "after the traversal vs after the first page" noise).
 */
export const preciseMemoryTest = base.extend<{
  memory: { context: BrowserContext; extensionId: string };
}>({
  // Playwright requires an object-destructuring first argument, even when empty.
  // eslint-disable-next-line no-empty-pattern
  memory: async ({}, use) => {
    if (!fs.existsSync(path.join(E2E_EXTENSION_PATH, 'manifest.json'))) {
      throw new Error(`Extension not built at ${E2E_EXTENSION_PATH}. Build it first.`);
    }
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyvault-e2e-mem-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: true,
      args: [
        `--disable-extensions-except=${E2E_EXTENSION_PATH}`,
        `--load-extension=${E2E_EXTENSION_PATH}`,
        '--enable-precise-memory-info',
      ],
    });
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await use({ context, extensionId: new URL(worker.url()).host });
    await context.close().catch(() => undefined);
    fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  },
});

export interface HeapSample {
  /** CDP Performance.getMetrics JSHeapUsedSize after two forced collections, bytes. */
  heapBytes: number;
  /** performance.memory.usedJSHeapSize read in the page right after, bytes. */
  perfMemoryBytes: number | null;
  /** CDP Memory.getDOMCounters: live DOM nodes and event listeners of the whole renderer. */
  domNodes: number;
  listeners: number;
}

/** Force garbage collection and read the heap of the page's renderer. */
export async function sampleHeap(context: BrowserContext, page: Page): Promise<HeapSample> {
  const cdp = await context.newCDPSession(page);
  try {
    await cdp.send('Performance.enable');
    await cdp.send('HeapProfiler.enable');
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.send('HeapProfiler.collectGarbage');
    const { metrics } = await cdp.send('Performance.getMetrics');
    const heap = metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? -1;
    const counters = await cdp.send('Memory.getDOMCounters');
    const perf = await page.evaluate(
      () =>
        (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
          ?.usedJSHeapSize ?? null,
    );
    return {
      heapBytes: heap,
      perfMemoryBytes: perf,
      domNodes: counters.nodes,
      listeners: counters.jsEventListeners,
    };
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

export const mb = (bytes: number): number => Math.round((bytes / 1048576) * 10) / 10;

// ---------------------------------------------------------------------------------------------
// Real mouse input and cross-page selection
// ---------------------------------------------------------------------------------------------

/**
 * `count` consecutive, vertically adjacent, unique lines of one column on page `n` (the raw text of
 * their spans, top to bottom) together with the texts of the spans that sit beside them in the
 * band they cover but outside their column, or null. Reading order is the DOM order of the text
 * layer. With `needOthers` only a band that really has another column beside it qualifies.
 */
export async function findColumnBand(
  page: Page,
  n: number,
  count: number,
  needOthers: boolean,
): Promise<{ lines: string[]; others: string[] } | null> {
  return page.evaluate(
    ({ n, count, needOthers }) => {
      const leafs = [
        ...document.querySelectorAll<HTMLElement>(
          `[data-testid="pdf-page-${n}"] .sv-textlayer span`,
        ),
      ].filter((sp) => sp.firstChild?.nodeType === 3 && sp.children.length === 0);
      const raw = leafs.map((sp) => sp.textContent ?? '');
      const seen = new Map<string, number>();
      for (const t of raw) seen.set(t, (seen.get(t) ?? 0) + 1);
      const rects = leafs.map((sp) => sp.getBoundingClientRect());
      const ok = (i: number): boolean =>
        seen.get(raw[i]!) === 1 &&
        raw[i]!.trim() === raw[i] &&
        (raw[i]!.match(/\p{L}/gu) ?? []).length >= 8 &&
        rects[i]!.width > 20 &&
        rects[i]!.height > 4;
      for (let i = 0; i + count <= leafs.length; i++) {
        let good = true;
        for (let k = 0; k < count && good; k++) {
          if (!ok(i + k)) good = false;
          if (good && k > 0) {
            const a = rects[i + k - 1]!;
            const b = rects[i + k]!;
            good =
              b.top > a.top + a.height * 0.5 &&
              Math.abs(b.left - a.left) < 40 &&
              b.top - a.bottom < a.height * 1.5;
          }
        }
        if (!good) continue;
        const band = rects.slice(i, i + count);
        const x0 = Math.min(...band.map((r) => r.left));
        const x1 = Math.max(...band.map((r) => r.right));
        const y0 = Math.min(...band.map((r) => r.top));
        const y1 = Math.max(...band.map((r) => r.bottom));
        const others: string[] = [];
        rects.forEach((r, j) => {
          if (j >= i && j < i + count) return;
          const beside = r.left > x1 + 5 || r.right < x0 - 5;
          const sameBand = r.bottom > y0 && r.top < y1;
          if (beside && sameBand && (raw[j] ?? '').trim().length >= 3) others.push(raw[j]!);
        });
        if (needOthers && others.length < 2) continue;
        return { lines: raw.slice(i, i + count), others };
      }
      return null;
    },
    { n, count, needOthers },
  );
}

/** Scroll the span with this exact text to the middle of the viewer (instantly). */
export async function scrollSpanIntoView(page: Page, n: number, text: string): Promise<void> {
  await page.evaluate(
    ({ n, text }) => {
      const sp = [
        ...document.querySelectorAll<HTMLElement>(
          `[data-testid="pdf-page-${n}"] .sv-textlayer span`,
        ),
      ].find((s) => s.textContent === text);
      if (!sp) throw new Error('span not found');
      sp.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    },
    { n, text },
  );
}

/** Real mouse drag from the start of the span `from` to the end of the span `to` (horizontal text). */
export async function dragAcross(page: Page, n: number, from: string, to: string): Promise<void> {
  await scrollSpanIntoView(page, n, from);
  // Boxes are read after the scroll and the redraw it may cause have stopped moving them.
  let a = await spanBox(page, n, from);
  let b = await spanBox(page, n, to);
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(100);
    const a2 = await spanBox(page, n, from);
    const b2 = await spanBox(page, n, to);
    const still = Math.abs(a2.x - a.x) + Math.abs(a2.y - a.y) + Math.abs(b2.y - b.y) < 1;
    a = a2;
    b = b2;
    if (still) break;
  }
  await page.mouse.move(a.x + 1, a.y + a.h / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.w - 1, b.y + b.h / 2, { steps: 12 });
  await page.mouse.up();
  await expect(page.getByTestId('pdf-savebar')).toBeVisible();
}

/**
 * Select from the last text of page `n` to the first text of page `n + 1` (a range across the page
 * boundary, as dragging over it would make). Returns the two texts.
 */
export async function selectAcrossBoundary(
  page: Page,
  n: number,
): Promise<{ from: string; to: string }> {
  const picked = await page.evaluate((n) => {
    const leafsOf = (p: number): HTMLElement[] =>
      [
        ...document.querySelectorAll<HTMLElement>(
          `[data-testid="pdf-page-${p}"] .sv-textlayer span`,
        ),
      ].filter(
        (sp) =>
          sp.firstChild?.nodeType === 3 &&
          sp.children.length === 0 &&
          (sp.textContent ?? '').trim().length >= 3,
      );
    const before = leafsOf(n);
    const after = leafsOf(n + 1);
    const a = before[before.length - 1];
    const b = after[0];
    if (!a?.firstChild || !b?.firstChild) return null;
    a.scrollIntoView({ block: 'end', inline: 'nearest', behavior: 'instant' });
    document
      .getSelection()!
      .setBaseAndExtent(a.firstChild, 0, b.firstChild, (b.textContent ?? '').length);
    return { from: a.textContent ?? '', to: b.textContent ?? '' };
  }, n);
  if (!picked) throw new Error(`no text on pages ${n} and ${n + 1}`);
  await expect(page.getByTestId('pdf-savebar')).toBeVisible();
  return picked;
}

// ---------------------------------------------------------------------------------------------
// Words of recognised (OCR) text
// ---------------------------------------------------------------------------------------------

/**
 * Select `count` consecutive words of recognised text on page `n`, all on one line, starting about a
 * third of the way into the page's words (past any heading). Recognised text is one span per word, and
 * words repeat, so the passage is addressed by position and its box is returned relative to the page
 * (stable under scrolling). Null when the page has no such run.
 */
export async function selectWords(
  page: Page,
  n: number,
  count: number,
): Promise<{ text: string; box: Box } | null> {
  // A text layer is selectable once it holds words AND its end-of-content sentinel is placed. The
  // spans are drawn before the page finishes painting but are put into stream order (each one detached
  // and attached again, which cuts a selection loose) only after that, so on a slow machine a
  // selection made as soon as the first span exists is lost and no save bar follows it. A redraw (the
  // recognised words arriving) replaces the layer: wait for the new, complete one.
  const complete = page.locator(
    `[data-testid="pdf-page-${n}"] .sv-textlayer:has(> .endOfContent):has(> span)`,
  );
  const selectOnce = async (): Promise<{ text: string; box: Box } | null> => {
    await expect(complete).toBeAttached({ timeout: 30_000 });
    return pickWords(page, n, count);
  };
  for (let attempt = 1; ; attempt++) {
    const picked = await selectOnce();
    if (!picked) return null;
    try {
      // `data-sv-drag` is the selection gate's hold: absent unless a button is down in the text.
      await expect(page.locator('html')).not.toHaveAttribute('data-sv-drag');
      await expect(page.getByTestId('pdf-savebar')).toBeVisible({
        timeout: attempt < 3 ? 4_000 : 10_000,
      });
      return picked;
    } catch (error) {
      // The layer was rebuilt under the selection and the selection collapsed: select again.
      if (attempt >= 3) throw error;
    }
  }
}

async function pickWords(
  page: Page,
  n: number,
  count: number,
): Promise<{ text: string; box: Box } | null> {
  return page.evaluate(
    ({ n, count }) => {
      const host = document.querySelector<HTMLElement>(`[data-testid="pdf-page-${n}"] .sv-page`);
      const leafs = [
        ...document.querySelectorAll<HTMLElement>(
          `[data-testid="pdf-page-${n}"] .sv-textlayer span`,
        ),
      ].filter((sp) => sp.firstChild?.nodeType === 3 && sp.children.length === 0);
      if (!host || leafs.length < count) return null;
      const rects = leafs.map((sp) => sp.getBoundingClientRect());
      const word = (i: number): boolean =>
        (leafs[i]!.textContent ?? '').trim().length >= 3 &&
        rects[i]!.width > 4 &&
        rects[i]!.height > 4;
      const start = Math.floor(leafs.length / 3);
      for (let k = 0; k < leafs.length; k++) {
        const i = (start + k) % Math.max(1, leafs.length - count + 1);
        let good = true;
        for (let j = 0; j < count && good; j++) {
          if (!word(i + j)) good = false;
          else if (j > 0) {
            const a = rects[i + j - 1]!;
            const b = rects[i + j]!;
            good = Math.abs(b.top - a.top) < a.height * 0.5 && b.left >= a.left;
          }
        }
        if (!good) continue;
        const first = leafs[i]!;
        const last = leafs[i + count - 1]!;
        first.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
        document
          .getSelection()!
          .setBaseAndExtent(
            first.firstChild!,
            0,
            last.firstChild!,
            (last.textContent ?? '').length,
          );
        const band = leafs.slice(i, i + count).map((sp) => sp.getBoundingClientRect());
        const h = host.getBoundingClientRect();
        const x0 = Math.min(...band.map((r) => r.left));
        const y0 = Math.min(...band.map((r) => r.top));
        return {
          text: leafs
            .slice(i, i + count)
            .map((sp) => sp.textContent ?? '')
            .join(''),
          box: {
            x: x0 - h.left,
            y: y0 - h.top,
            w: Math.max(...band.map((r) => r.right)) - x0,
            h: Math.max(...band.map((r) => r.bottom)) - y0,
          },
        };
      }
      return null;
    },
    { n, count },
  );
}

/** The painted highlight of page `n` sits on `box` (relative to the page), within the tolerance. */
export async function expectOverlayOnBox(
  page: Page,
  n: number,
  box: Box,
  label: string,
  timeout = 20_000,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const rel = await page.evaluate((pageNumber) => {
          const host = document.querySelector<HTMLElement>(
            `[data-testid="pdf-page-${pageNumber}"] .sv-page`,
          );
          const nodes = [
            ...document.querySelectorAll<HTMLElement>(
              `[data-testid="pdf-page-${pageNumber}"] .sv-pdf-hl`,
            ),
          ];
          if (!host || nodes.length === 0) return null;
          const h = host.getBoundingClientRect();
          const rects = nodes.map((el) => el.getBoundingClientRect());
          const x0 = Math.min(...rects.map((r) => r.left));
          const y0 = Math.min(...rects.map((r) => r.top));
          return {
            x: x0 - h.left,
            y: y0 - h.top,
            w: Math.max(...rects.map((r) => r.right)) - x0,
            h: Math.max(...rects.map((r) => r.bottom)) - y0,
          };
        }, n);
        if (!rel) return 'no overlay';
        const off = Math.max(
          Math.abs(rel.x - box.x),
          Math.abs(rel.y - box.y),
          Math.abs(rel.x + rel.w - (box.x + box.w)),
          Math.abs(rel.y + rel.h - (box.y + box.h)),
        );
        return off <= ALIGN_TOLERANCE_PX ? 'aligned' : `off by ${Math.round(off)}px`;
      },
      { message: label, timeout },
    )
    .toBe('aligned');
}
