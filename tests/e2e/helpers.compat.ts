import type { BrowserContext, Locator, Page } from '@playwright/test';
import { activateTab } from './helpers';
import { expect, test as base } from './fixtures';

export { expect };

/** Custom element carrying the overlay's (open, in the e2e build) shadow root. */
export const OVERLAY_HOST = 'studyvault-overlay';

/** controller.ts SELECTION_DEBOUNCE_MS: the product's documented delay before a selectionchange is evaluated. */
export const SELECTION_DEBOUNCE_MS = 60;

export interface Env {
  context: BrowserContext;
  extensionId: string;
  /** http://127.0.0.1:PORT */
  origin: string;
  /** http://localhost:PORT */
  altOrigin: string;
}

/** `env` bundles what every compat test needs: the context, extension id and both fixture origins. */
export const test = base.extend<{ env: Env }>({
  env: async ({ context, extensionId, fixtureServer }, use) => {
    await use({
      context,
      extensionId,
      origin: fixtureServer.origin,
      altOrigin: fixtureServer.altOrigin,
    });
  },
});

const ERRORS = new WeakMap<Page, string[]>();

/** Uncaught page exceptions and console errors seen on `page` (including its frames) since it was opened. */
export function pageErrors(page: Page): string[] {
  return ERRORS.get(page) ?? [];
}

/**
 * Open a fixture page in a new tab and (by default) activate the content script through the real RPC.
 *
 * `style` is CSS appended to the document on every load of this tab, including reloads. Use it to
 * pin geometry that would otherwise depend on the OS font fallback (the fixtures name Georgia, which
 * Linux runners do not have), e.g. a column narrow enough that a quote wraps on every platform.
 */
export async function openFixture(
  env: Env,
  pathAndQuery: string,
  opts: { activate?: boolean; style?: string } = {},
): Promise<Page> {
  const page = await env.context.newPage();
  const errors: string[] = [];
  ERRORS.set(page, errors);
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    // The fixture server has no favicon; Chromium's automatic request for one logs a 404.
    if (msg.location().url.endsWith('/favicon.ico')) return;
    errors.push(`console.error: ${msg.text()}`);
  });
  if (opts.style) {
    await page.addInitScript((css) => {
      document.addEventListener('DOMContentLoaded', () => {
        const el = document.createElement('style');
        el.textContent = css;
        document.head.append(el);
      });
    }, opts.style);
  }
  await page.goto(`${env.origin}${pathAndQuery}`);
  if (opts.activate !== false) await activate(env, page);
  return page;
}

/**
 * Inject the content script into `page` and wait until it is fully running: the overlay host is
 * mounted and `content.pageStatus` (which awaits the controller's first rehydration) has answered.
 */
export async function activate(env: Env, page: Page): Promise<void> {
  await activateTab(env.context, env.extensionId, page);
  await expect(page.locator(OVERLAY_HOST)).toHaveCount(1);
  const status = await tabRpc(env, page, 'content.pageStatus');
  expect(status.ok, `content.pageStatus: ${JSON.stringify(status)}`).toBe(true);
}

/** Reload `page` (the injected script does not survive a navigation) and activate again. */
export async function reloadAndActivate(env: Env, page: Page): Promise<void> {
  await page.reload();
  await activate(env, page);
}

export const toolbarOf = (page: Page): Locator =>
  page.getByRole('toolbar', { name: 'StudyVault: save selected text' });

export const normalise = (s: string): string => s.replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------------------------
// Real pointer selection
// ---------------------------------------------------------------------------------------------

export interface TextRef {
  selector: string;
  /** Visible text (whitespace collapsed) to locate inside the element. */
  text: string;
  /** Which occurrence inside the element (0 based). */
  occurrence?: number;
}

export interface Point {
  x: number;
  y: number;
}

/**
 * Viewport coordinates of the first and last character of `ref.text`, found in the element's
 * rendered text (whitespace runs collapsed like the browser does). Scrolls the element to the
 * vertical centre first when `scroll` is true.
 */
export async function textPoints(
  page: Page,
  ref: TextRef,
  scroll = true,
): Promise<{ start: Point; end: Point; lineCount: number }> {
  return page.evaluate(
    ({ selector, text, occurrence, scroll: doScroll }) => {
      const root = document.querySelector(selector);
      if (!root) throw new Error(`no element for ${selector}`);
      if (doScroll) root.scrollIntoView({ block: 'center', inline: 'nearest' });
      const chars: Array<{ node: Text; offset: number }> = [];
      let flat = '';
      let lastSpace = true;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const node = n as Text;
        for (let i = 0; i < node.data.length; i++) {
          const c = node.data.charAt(i);
          if (/[\t\n\v\f\r \u00A0]/.test(c)) {
            if (lastSpace) continue;
            flat += ' ';
            lastSpace = true;
          } else {
            flat += c;
            lastSpace = false;
          }
          chars.push({ node, offset: i });
        }
      }
      let idx = -1;
      for (let k = 0; k <= occurrence; k++) {
        idx = flat.indexOf(text, idx + 1);
        if (idx < 0) throw new Error(`"${text}" (#${occurrence}) not found in ${selector}`);
      }
      const first = chars[idx]!;
      const last = chars[idx + text.length - 1]!;
      const charRect = (c: { node: Text; offset: number }): DOMRect => {
        const r = document.createRange();
        r.setStart(c.node, c.offset);
        r.setEnd(c.node, c.offset + 1);
        return r.getBoundingClientRect();
      };
      const s = charRect(first);
      const e = charRect(last);
      const whole = document.createRange();
      whole.setStart(first.node, first.offset);
      whole.setEnd(last.node, last.offset + 1);
      const tops = new Set(Array.from(whole.getClientRects()).map((r) => Math.round(r.top)));
      return {
        // One CSS pixel inside the character box: the caret lands before the first / after the last char.
        start: { x: s.left + 1, y: s.top + s.height / 2 },
        end: { x: e.right - 1, y: e.top + e.height / 2 },
        lineCount: tops.size,
      };
    },
    { selector: ref.selector, text: ref.text, occurrence: ref.occurrence ?? 0, scroll },
  );
}

/**
 * Select text with a real mouse drag from the first character of `from` to the last character
 * of `to` (default: the same text). Returns the number of rendered lines the drag covered.
 */
export async function dragSelect(page: Page, from: TextRef, to: TextRef = from): Promise<number> {
  const a = await textPoints(page, from, true);
  const b = to === from ? a : await textPoints(page, to, false);
  const viewport = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  for (const p of [a.start, b.end]) {
    if (p.x < 0 || p.y < 0 || p.x > viewport.w || p.y > viewport.h) {
      throw new Error(
        `drag point ${JSON.stringify(p)} is outside the viewport ${JSON.stringify(viewport)}`,
      );
    }
  }
  await page.mouse.move(a.start.x, a.start.y);
  await page.mouse.down();
  await page.mouse.move(b.end.x, b.end.y, { steps: 12 });
  await page.mouse.up();
  return a.lineCount;
}

/** Triple-click inside the element: selects its block. */
export async function tripleClick(page: Page, selector: string): Promise<void> {
  await page.locator(selector).click({ clickCount: 3 });
}

// ---------------------------------------------------------------------------------------------
// Page-state probes
// ---------------------------------------------------------------------------------------------

/** Compact description of the page selection that can be compared before and after. */
export async function selectionSnapshot(page: Page): Promise<{
  text: string;
  rangeCount: number;
  start: string;
  end: string;
  activeElement: string;
  scrollY: number;
}> {
  return page.evaluate(() => {
    const pathOf = (node: Node | null): string => {
      const parts: number[] = [];
      for (let n: Node | null = node; n && n !== document; n = n.parentNode) {
        parts.push(Array.prototype.indexOf.call(n.parentNode?.childNodes ?? [], n));
      }
      return parts.reverse().join('/');
    };
    const sel = getSelection();
    const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
    const active = document.activeElement;
    return {
      text: sel ? sel.toString() : '',
      rangeCount: sel ? sel.rangeCount : 0,
      start: range ? `${pathOf(range.startContainer)}:${range.startOffset}` : '',
      end: range ? `${pathOf(range.endContainer)}:${range.endOffset}` : '',
      activeElement: active ? `${active.localName}#${active.id}` : '',
      scrollY: window.scrollY,
    };
  });
}

/** Painted highlight ranges with the id of the nearest element that has one (to tell repeats apart). */
export async function paintedRanges(page: Page): Promise<Array<{ text: string; owner: string }>> {
  return page.evaluate(() => {
    const out: Array<{ text: string; owner: string }> = [];
    for (const [name, hl] of CSS.highlights) {
      if (!name.startsWith('sv-hl-') || name === 'sv-hl-active') continue;
      for (const abstract of hl as unknown as Iterable<AbstractRange>) {
        const range = abstract as Range;
        const el =
          range.startContainer.nodeType === 1
            ? (range.startContainer as Element)
            : range.startContainer.parentElement;
        out.push({ text: range.toString(), owner: el?.closest('[id]')?.id ?? '' });
      }
    }
    return out;
  });
}

/** Everything the page-side CSS Custom Highlight registries hold, whitespace-collapsed. */
export async function paintedNormalised(page: Page): Promise<string[]> {
  return (await paintedRanges(page)).map((r) => normalise(r.text));
}

/**
 * Start a monitor, inside the page, that remembers whether a toolbar element has EVER been added to
 * the overlay's shadow root. Lets a test assert "never appeared" instead of "not visible right now".
 */
export async function watchToolbar(page: Page): Promise<void> {
  await page.evaluate(
    ({ host }) => {
      const w = window as unknown as { __svToolbarSeen?: number };
      w.__svToolbarSeen = 0;
      const root = document.querySelector(host)?.shadowRoot;
      if (!root)
        throw new Error('overlay shadow root is not reachable (closed root or not mounted)');
      const check = (): void => {
        if (root.querySelector('[role="toolbar"]'))
          w.__svToolbarSeen = (w.__svToolbarSeen ?? 0) + 1;
      };
      new MutationObserver(check).observe(root, { childList: true, subtree: true });
      check();
    },
    { host: OVERLAY_HOST },
  );
}

/** How many times a toolbar was observed in the shadow root since `watchToolbar`. */
export async function toolbarSightings(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as { __svToolbarSeen?: number }).__svToolbarSeen ?? -1,
  );
}

/** Let the product's documented selection debounce elapse several times over. */
export async function settleSelection(page: Page): Promise<void> {
  await page.waitForTimeout(SELECTION_DEBOUNCE_MS * 5);
}

/** Wait for the overlay's enter animations (4px slide, 120ms) so geometry can be measured exactly. */
export async function settleOverlay(page: Page): Promise<void> {
  await page.evaluate(async (host) => {
    const root = document.querySelector(host)?.shadowRoot;
    if (!root) return;
    await Promise.all(root.getAnimations().map((a) => a.finished.catch(() => undefined)));
  }, OVERLAY_HOST);
}

/** Bounding box of a locator relative to the layout viewport, in CSS pixels. */
export async function boxOf(locator: Locator): Promise<{
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}> {
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return {
      left: r.left,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
      width: r.width,
      height: r.height,
    };
  });
}

export async function viewportSize(page: Page): Promise<{ w: number; h: number; dpr: number }> {
  return page.evaluate(() => ({
    w: document.documentElement.clientWidth,
    h: document.documentElement.clientHeight,
    dpr: window.devicePixelRatio,
  }));
}

/** Bounding rect of the page's current selection, viewport relative. */
export async function selectionRect(
  page: Page,
): Promise<{ left: number; top: number; right: number; bottom: number }> {
  return page.evaluate(() => {
    const sel = getSelection();
    if (!sel || sel.rangeCount === 0) throw new Error('no selection');
    const r = sel.getRangeAt(0).getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  });
}

// ---------------------------------------------------------------------------------------------
// Extension-page backed probes (real runtime messaging, nothing mocked)
// ---------------------------------------------------------------------------------------------

async function withExtensionPage<T>(env: Env, run: (ext: Page) => Promise<T>): Promise<T> {
  const ext = await env.context.newPage();
  try {
    await ext.goto(`chrome-extension://${env.extensionId}/options.html`);
    return await run(ext);
  } finally {
    await ext.close();
  }
}

export interface StoredHighlight {
  id: string;
  exactQuote: string;
  userComment: string;
  kind: string;
  headingContext: string | null;
  resolveStatus: string;
  anchorSet: { textQuote: { exact: string; prefix: string; suffix: string } };
}

/** Highlights the service worker returns for the page's current address (and declared canonical). */
export async function storedHighlights(env: Env, page: Page): Promise<StoredHighlight[]> {
  const identity = await page.evaluate(() => ({
    url: location.href,
    canonicalUrl:
      (document.querySelector('link[rel~="canonical"]') as HTMLLinkElement | null)?.href ?? null,
  }));
  return withExtensionPage(env, async (ext) => {
    const res = await ext.evaluate(async (payload) => {
      return chrome.runtime.sendMessage({ v: 1, type: 'page.highlights', payload });
    }, identity);
    if (!res?.ok) throw new Error(`page.highlights failed: ${JSON.stringify(res)}`);
    return res.data.highlights as StoredHighlight[];
  });
}

/** Send a TabRpc request to the content script of `page` from an extension page. */
export async function tabRpc(
  env: Env,
  page: Page,
  type: string,
  payload: unknown = {},
): Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }> {
  const url = page.url();
  return withExtensionPage(env, (ext) =>
    ext.evaluate(
      async ({ pageUrl, type: t, payload: p }) => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find((x) => x.url === pageUrl);
        if (!tab?.id)
          return { ok: false, error: { code: 'not_found', message: `no tab for ${pageUrl}` } };
        return chrome.tabs.sendMessage(tab.id, { v: 1, type: t, payload: p });
      },
      { pageUrl: url, type, payload },
    ),
  );
}

/**
 * Real browser page zoom through chrome.tabs.setZoom (per-tab). `factor` 1.25 = 125 %.
 * Returns the resulting layout viewport so callers can assert the zoom actually applied.
 */
export async function setBrowserZoom(
  env: Env,
  page: Page,
  factor: number,
): Promise<{ w: number; h: number; dpr: number }> {
  const url = page.url();
  await withExtensionPage(env, (ext) =>
    ext.evaluate(
      async ({ pageUrl, zoom }) => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find((x) => x.url === pageUrl);
        if (!tab?.id) throw new Error(`no tab for ${pageUrl}`);
        await chrome.tabs.setZoomSettings(tab.id, { mode: 'automatic', scope: 'per-tab' });
        await chrome.tabs.setZoom(tab.id, zoom);
      },
      { pageUrl: url, zoom: factor },
    ),
  );
  await expect
    .poll(async () => (await viewportSize(page)).dpr, { message: `page zoom ${factor} applied` })
    .toBeCloseTo(factor, 2);
  return viewportSize(page);
}

// ---------------------------------------------------------------------------------------------
// Colour maths (WCAG 2.x relative luminance)
// ---------------------------------------------------------------------------------------------

export function parseRgb(css: string): [number, number, number, number] {
  const m = /rgba?\(([^)]+)\)/.exec(css);
  if (!m) throw new Error(`not an rgb colour: ${css}`);
  const parts = m[1]!
    .split(/[ ,/]+/)
    .filter(Boolean)
    .map(Number);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1];
}

function luminance([r, g, b]: [number, number, number, number]): number {
  const lin = (v: number): number => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(fg: string, bg: string): number {
  const a = luminance(parseRgb(fg));
  const b = luminance(parseRgb(bg));
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}
