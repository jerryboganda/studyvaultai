import type { BrowserContext, CDPSession, Locator, Page, Worker } from '@playwright/test';
import net from 'node:net';
import { PENDING_FOCUS_KEY } from '@shared';
import { activateTab } from './helpers';
import { expect, prodTest as prodBase, test as base } from './fixtures';

export { expect };

/**
 * Helpers for the extension-pages / permissions / restricted-contexts specs (pages.spec.ts,
 * permissions.spec.ts). Everything drives real Chromium with the real built extension: real
 * pointer input, real chrome.* calls from extension pages, real CDP target control. No Chrome API
 * is mocked.
 *
 * THE "WHICH TAB IS ACTIVE" PROBLEM
 *   popup.html / sidepanel.html call tabs.query({active, currentWindow}). Opened as an ordinary tab
 *   they would see themselves. Two techniques make the shipped code path see a fixture page:
 *   1. Background tab (`viewing`): keep the extension page in a background tab of the same window and
 *      bring the fixture page to the front. Chrome fires tabs.onActivated in the extension page,
 *      which re-queries and now gets the fixture page. Fully drivable with Playwright locators.
 *   2. Real popup (`RealPopup`): chrome.action.openPopup() from the service worker opens the genuine
 *      popup window (default_popup from the manifest). Playwright does not attach to that target, so
 *      it is driven through raw CDP (Target.attachToTarget + Runtime/Input domains).
 */

export const OVERLAY_HOST = 'studyvault-overlay';

export interface Env {
  context: BrowserContext;
  extensionId: string;
  serviceWorker: Worker;
  /** http://127.0.0.1:PORT */
  origin: string;
  /** http://localhost:PORT */
  altOrigin: string;
}

function envFixture() {
  return {
    env: async (
      {
        context,
        extensionId,
        serviceWorker,
        fixtureServer,
      }: {
        context: BrowserContext;
        extensionId: string;
        serviceWorker: Worker;
        fixtureServer: { origin: string; altOrigin: string };
      },
      use: (env: Env) => Promise<void>,
    ) => {
      await use({
        context,
        extensionId,
        serviceWorker,
        origin: fixtureServer.origin,
        altOrigin: fixtureServer.altOrigin,
      });
    },
  };
}

/** E2E build (loopback host permissions, open shadow root). */
export const test = base.extend<{ env: Env }>(envFixture());
/** Production build (shipped manifest, closed shadow root). */
export const prodTest = prodBase.extend<{ env: Env }>(envFixture());

// ---------------------------------------------------------------------------------------------
// Console / page error capture
// ---------------------------------------------------------------------------------------------

const ERRORS = new WeakMap<Page, string[]>();

/** Uncaught exceptions and console.error output seen on `page` since it was opened by a helper. */
export function errorsOf(page: Page): string[] {
  return ERRORS.get(page) ?? [];
}

function watchErrors(page: Page): void {
  const errors: string[] = [];
  ERRORS.set(page, errors);
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    if (msg.location().url.endsWith('/favicon.ico')) return; // fixture server has no favicon
    errors.push(`console.error: ${msg.text()}`);
  });
}

// ---------------------------------------------------------------------------------------------
// Opening pages
// ---------------------------------------------------------------------------------------------

export type ExtPageName = 'popup' | 'sidepanel' | 'options';

/**
 * `view` opens one settings view (`options.html#<id>`): the settings page mounts only the current
 * section, and without a hash it shows its home.
 */
export async function openExt(env: Env, name: ExtPageName, view?: string): Promise<Page> {
  const page = await env.context.newPage();
  watchErrors(page);
  await page.goto(`chrome-extension://${env.extensionId}/${name}.html${view ? `#${view}` : ''}`);
  return page;
}

/** Open a fixture page; by default also activate the content script through the real RPC. */
export async function openFixture(
  env: Env,
  pathAndQuery: string,
  opts: { activate?: boolean; origin?: string } = {},
): Promise<Page> {
  const page = await env.context.newPage();
  watchErrors(page);
  await page.goto(`${opts.origin ?? env.origin}${pathAndQuery}`);
  if (opts.activate !== false) await activate(env, page);
  return page;
}

/**
 * tab.activate through the real RPC, then wait until the content script is fully running: the
 * overlay host is mounted AND its first rehydration has finished (content.pageStatus answers only
 * after it). Without the second wait a test that opens the side panel right away races the page's
 * own first `page.highlights` round trip, which is what creates the database on a fresh profile.
 */
export async function activate(env: Env, page: Page): Promise<void> {
  await activateTab(env.context, env.extensionId, page);
  await expect(page.locator(OVERLAY_HOST)).toHaveCount(1);
  const ext = await env.context.newPage();
  try {
    await ext.goto(`chrome-extension://${env.extensionId}/options.html`);
    const url = page.url();
    await expect
      .poll(
        () =>
          ext.evaluate(async (pageUrl) => {
            const tab = (await chrome.tabs.query({})).find((t) => t.url === pageUrl);
            if (tab?.id === undefined) return 'no tab';
            try {
              const reply = (await chrome.tabs.sendMessage(tab.id, {
                v: 1,
                type: 'content.pageStatus',
                payload: {},
              })) as { ok: boolean; error?: { code: string } } | undefined;
              // Any answer means the controller finished starting (a refusal such as an address
              // that is too long to store is still an answer).
              return reply ? 'ready' : 'no reply';
            } catch (err) {
              return `not yet: ${String((err as Error)?.message ?? err)}`;
            }
          }, url),
        { message: 'content script should finish its first rehydration' },
      )
      .toBe('ready');
  } finally {
    await ext.close();
  }
}

export const toolbarOf = (page: Page): Locator =>
  page.getByRole('toolbar', { name: 'StudyVault: save selected text' });

// ---------------------------------------------------------------------------------------------
// Extension RPC and storage from an extension page
// ---------------------------------------------------------------------------------------------

export type Envelope =
  { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };

/** BackgroundRpc request sent from an extension page (the same transport the popup uses). */
export async function bg(ext: Page, type: string, payload: unknown = {}): Promise<Envelope> {
  return ext.evaluate(
    async ({ type, payload }) => {
      const reply: unknown = await chrome.runtime.sendMessage({ v: 1, type, payload });
      return reply as Envelope;
    },
    { type, payload },
  );
}

/** Like `bg` but requires success and returns `data`. */
export async function bgData<T>(ext: Page, type: string, payload: unknown = {}): Promise<T> {
  const reply = await bg(ext, type, payload);
  if (!reply.ok) throw new Error(`${type} failed: ${JSON.stringify(reply.error)}`);
  return reply.data as T;
}

export interface HighlightRow {
  id: string;
  exactQuote: string;
  kind: string;
  color: string;
  priority: number;
  userComment: string;
  resolveStatus: string;
  bankIds: string[];
}

export async function highlightsOf(ext: Page, url: string): Promise<HighlightRow[]> {
  const res = await bgData<{ highlights: HighlightRow[] }>(ext, 'page.highlights', {
    url,
    canonicalUrl: null,
  });
  return res.highlights;
}

/** Id of the tab currently active in `ext`'s window (polls until it is not `ext` itself). */
export async function activeTabId(ext: Page): Promise<number> {
  const self = await ext.evaluate(async () => (await chrome.tabs.getCurrent())?.id ?? -1);
  let id = -1;
  await expect
    .poll(async () => {
      id = await ext.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        return tab?.id ?? -1;
      });
      return id !== -1 && id !== self;
    })
    .toBe(true);
  return id;
}

/** Bring `page` to the front and return its Chrome tab id (seen from the extension page `ext`). */
export async function tabIdOf(ext: Page, page: Page): Promise<number> {
  await page.bringToFront();
  return activeTabId(ext);
}

/** Raw stored settings (undefined until the first write). */
export async function storedSettings(ext: Page): Promise<Record<string, unknown> | undefined> {
  return ext.evaluate(async () => {
    const got = await chrome.storage.local.get('settings');
    return got.settings as Record<string, unknown> | undefined;
  });
}

/**
 * Change settings fields the way an extension page does (parseSettings fills the rest): through the
 * worker's `updateSettings`, via the e2e-build-only hook (entrypoints/background/e2e.ts). A write
 * straight into chrome.storage.local is what a content script could do, and the worker ignores it.
 */
export async function patchSettings(ext: Page, patch: Record<string, unknown>): Promise<void> {
  // A JSON string: extension messaging drops null properties of an object argument.
  const reply = await bg(ext, 'e2e.settings.patch', { json: JSON.stringify(patch) });
  if (!reply.ok) throw new Error(`patchSettings was refused: ${JSON.stringify(reply.error)}`);
}

export async function dataEpoch(ext: Page): Promise<string | undefined> {
  return ext.evaluate(async () => {
    const got = await chrome.storage.local.get('dataEpoch');
    return got.dataEpoch as string | undefined;
  });
}

/**
 * Send `message` from the extension's ISOLATED world inside `tabId`: the same kind of sender a
 * content script has (sender.tab set, sender.url = the page, not chrome-extension://). Uses only
 * the public scripting.executeScript API, so no production code is touched or mocked.
 *
 * The message travels as a JSON STRING. Chrome's extension-API argument conversion drops every
 * `null` property of an object argument, so `{ canonicalUrl: null }` would arrive as `{}` and the
 * worker (correctly) answer `invalid_request` before any sender policy ran. A string is delivered
 * verbatim, which makes the message the worker sees exactly the one the test wrote.
 */
export async function sendFromContentWorld(
  ext: Page,
  tabId: number,
  message: unknown,
): Promise<Envelope | { thrown: string } | undefined> {
  return ext.evaluate(
    async ({ tabId, json }) => {
      const out = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'ISOLATED',
        args: [json],
        func: async (wire: string) => {
          try {
            return (await chrome.runtime.sendMessage(JSON.parse(wire))) as unknown;
          } catch (err) {
            return { thrown: String((err as Error)?.message ?? err) };
          }
        },
      });
      return out[0]?.result as Envelope | { thrown: string } | undefined;
    },
    { tabId, json: JSON.stringify(message) },
  );
}

// ---------------------------------------------------------------------------------------------
// "Fixture page is the active tab" for popup / side panel
// ---------------------------------------------------------------------------------------------

/**
 * Open `name` in a new tab, then bring `target` to the front so the extension page's
 * tabs.query({active:true,currentWindow:true}) answers with `target`. Returns once Chrome reports
 * `target` as the active tab; the page's own re-render is awaited by locator assertions.
 */
export async function viewing(env: Env, name: ExtPageName, target: Page): Promise<Page> {
  const ext = await openExt(env, name);
  if (name !== 'options') {
    // The page reads the active tab when it mounts and then follows tab events. Its `load` event
    // comes before React has mounted, so switching tabs right away can land between the page's
    // first query and its listener registration: the event is lost and the page stays on its own
    // tab. Wait for the page's own first answer (it is the active tab, an extension page, and says
    // it cannot run there) before switching.
    await expect(ext.getByRole('heading', { name: "Can't run here" })).toBeVisible();
  }
  await target.bringToFront();
  await activeTabId(ext);
  return ext;
}

/** Make `target` the active tab again (e.g. after a helper opened and closed a temporary page). */
export async function show(target: Page): Promise<void> {
  await target.bringToFront();
}

// ---------------------------------------------------------------------------------------------
// Side panel state
// ---------------------------------------------------------------------------------------------

/**
 * What the "This page" list of a side panel shows right now: `loading` (nothing decided yet),
 * `empty` (the empty state), `cards:<n>`, or `error: <message>` (the load failed and the panel says
 * so, with a Retry). Read from the DOM the user sees.
 */
export async function pageListState(side: Page): Promise<string> {
  return side.evaluate(() => {
    const text = document.body.innerText;
    const failed = Array.from(document.querySelectorAll('[role="alert"]')).find((el) =>
      /Could not load highlights/.test(el.textContent ?? ''),
    );
    if (failed) return `error: ${(failed.textContent ?? '').replace(/\s+/g, ' ').trim()}`;
    if (text.includes('Could not load highlights')) return 'error: Could not load highlights';
    const cards = document.querySelectorAll('article').length;
    if (cards > 0) return `cards:${cards}`;
    const empty = Array.from(document.querySelectorAll('h3')).some(
      (h) => h.textContent?.trim() === 'Nothing saved yet',
    );
    if (empty) return 'empty';
    return 'loading';
  });
}

/** Wait until the "This page" list has left `loading` (it answered, or it failed and says so). */
export async function waitForPageList(side: Page, timeout = 15_000): Promise<void> {
  await expect
    .poll(() => pageListState(side), {
      timeout,
      message: 'the side panel list should settle (loaded or failed), not stay on "loading"',
    })
    .not.toBe('loading');
}

// ---------------------------------------------------------------------------------------------
// Real pointer input on fixture pages
// ---------------------------------------------------------------------------------------------

/**
 * Select the whole block at `selector` with a real triple-click and wait until the page selection
 * really is that block.
 *
 * Why not `locator.click({ clickCount: 3 })`: Playwright aims at the centre of the element's box.
 * For a paragraph that wraps to two lines the centre is the seam between the lines, a few pixels
 * ABOVE the glyphs of line 2. The second click of the gesture selects the word under that point and
 * the toolbar appears directly above the word, covering the seam, so on a platform whose font wraps
 * the block that way the third click lands on the toolbar and the selection stays one word.
 * Measured with a Times New Roman / Liberation Serif layout and `#p-gfr`: pointerdown #3 targets a
 * <div> inside <studyvault-overlay>, and the saved quote is "millilitres" (as on the Linux runner).
 * The point used here is the middle of the block's first word: on a glyph, and never under a
 * toolbar that is placed above or below that word.
 */
export async function tripleClickBlock(page: Page, selector: string): Promise<void> {
  const block = page.locator(selector);
  await block.scrollIntoViewIfNeeded();
  const position = await block.evaluate((el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n as Text;
      // A click on a link or control would follow / press it instead of selecting.
      if (text.parentElement?.closest('a, button, input, textarea, select, summary')) continue;
      const word = /\S+/.exec(text.data);
      if (!word) continue;
      const range = document.createRange();
      range.setStart(text, word.index);
      range.setEnd(text, word.index + word[0].length);
      const rect = range.getClientRects()[0];
      if (!rect || rect.width === 0) continue;
      const box = el.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2 - box.left - el.clientLeft,
        y: rect.top + rect.height / 2 - box.top - el.clientTop,
      };
    }
    return null;
  });
  if (!position) throw new Error(`${selector} has no rendered text to triple-click`);
  await block.click({ clickCount: 3, position });
  // The toolbar already shows after the second click (for the word), so wait for the third click's
  // effect explicitly; otherwise a Save click could race the selection it is meant to save.
  await expect
    .poll(
      () =>
        block.evaluate((el) => {
          const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
          return squash(getSelection()?.toString() ?? '') === squash(el.textContent ?? '');
        }),
      { message: `triple-click should select all of ${selector}` },
    )
    .toBe(true);
}

/**
 * Select the block at `selector` with a real triple-click, click the toolbar button called
 * `button`, and wait until the highlight is in storage (observed through the RPC from `ext`).
 */
export async function saveBlock(
  ext: Page,
  page: Page,
  selector: string,
  button = 'Save selection',
): Promise<void> {
  const before = (await highlightsOf(ext, page.url())).length;
  await page.bringToFront();
  await tripleClickBlock(page, selector);
  await expect(toolbarOf(page)).toBeVisible();
  await page.getByRole('button', { name: button, exact: true }).click();
  await expect.poll(async () => (await highlightsOf(ext, page.url())).length).toBe(before + 1);
}

/** Same as `saveBlock`, through "More options" with an explicit bank. */
export async function saveBlockToBank(
  ext: Page,
  page: Page,
  selector: string,
  bankName: string,
): Promise<void> {
  const before = (await highlightsOf(ext, page.url())).length;
  await page.bringToFront();
  await tripleClickBlock(page, selector);
  await expect(toolbarOf(page)).toBeVisible();
  await page.getByRole('button', { name: 'More options', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Save with details' });
  await dialog.getByRole('combobox', { name: 'Bank' }).selectOption({ label: bankName });
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(async () => (await highlightsOf(ext, page.url())).length).toBe(before + 1);
}

/**
 * Select the whole block at `selector` through the DOM Selection API: no pointer input, no
 * focus change, no `bringToFront`. For flows that must leave a browser-owned popup alone, because
 * Chrome closes an action popup the moment its window is activated by anything else.
 */
export async function selectBlockProgrammatically(page: Page, selector: string): Promise<void> {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`no element for ${sel}`);
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, selector);
}

/**
 * Save the live selection of tab `tabId` through the content script's `content.captureSelection`
 * RPC, the path the keyboard shortcut and the context menu take. Sent from the extension page
 * `ext`, so it needs no input on the page.
 */
export async function captureSelectionVia(ext: Page, tabId: number): Promise<Envelope> {
  return ext.evaluate(async (id) => {
    const reply: unknown = await chrome.tabs.sendMessage(id, {
      v: 1,
      type: 'content.captureSelection',
      payload: { method: 'shortcut', bankId: null },
    });
    return reply as Envelope;
  }, tabId);
}

/**
 * Manifest command "focus-toolbar" as the worker sends it: TabRpc content.focusToolbar to the
 * content script of tab `tabId`, from an extension page (Playwright cannot press manifest shortcuts).
 */
export async function focusToolbarVia(ext: Page, tabId: number): Promise<Envelope> {
  return ext.evaluate(async (id) => {
    const reply: unknown = await chrome.tabs.sendMessage(id, {
      v: 1,
      type: 'content.focusToolbar',
      payload: {},
    });
    return reply as Envelope;
  }, tabId);
}

/** Manifest commands "next-highlight" / "previous-highlight": TabRpc content.stepHighlight. */
export async function stepHighlightVia(
  ext: Page,
  tabId: number,
  direction: 'next' | 'previous',
): Promise<Envelope> {
  return ext.evaluate(
    async ({ id, direction }) => {
      const reply: unknown = await chrome.tabs.sendMessage(id, {
        v: 1,
        type: 'content.stepHighlight',
        payload: { direction },
      });
      return reply as Envelope;
    },
    { id: tabId, direction },
  );
}

/**
 * Start recording every change of the service worker -> side panel hand-over key
 * (chrome.storage.session `sv.pendingFocus`, ADR-005) in extension page `ext`. A real side panel
 * removes the entry as soon as it has acted on it, so reading the key afterwards would race; the
 * log keeps each value that was ever written.
 */
export async function recordPendingFocus(ext: Page): Promise<void> {
  await ext.evaluate((key) => {
    const w = window as unknown as { __svPending?: Array<{ highlightId: string; at: number }> };
    w.__svPending = [];
    chrome.storage.onChanged.addListener((changes, area) => {
      const change = changes[key];
      if (area !== 'session' || !change || change.newValue == null) return;
      w.__svPending?.push(change.newValue as { highlightId: string; at: number });
    });
  }, PENDING_FOCUS_KEY);
}

/** Values written to the hand-over key since `recordPendingFocus`. */
export async function pendingFocusLog(
  ext: Page,
): Promise<Array<{ highlightId: string; at: number }>> {
  return ext.evaluate(
    () =>
      (window as unknown as { __svPending?: Array<{ highlightId: string; at: number }> })
        .__svPending ?? [],
  );
}

/**
 * The CSS the painter adopted into the page, per registry name: the declarations of the rule that
 * lists `::highlight(<name>)`. Reads `document.adoptedStyleSheets` (public to the page), so it sees
 * exactly what the browser paints with. Only unconditional rules are read (not @media blocks).
 */
export async function highlightRuleFor(
  page: Page,
  registryName: string,
): Promise<{ style: string; thickness: string; line: string; fill: string } | null> {
  return page.evaluate((name) => {
    const wanted = `::highlight(${name})`;
    for (const sheet of document.adoptedStyleSheets) {
      for (const rule of Array.from(sheet.cssRules)) {
        if (!(rule instanceof CSSStyleRule)) continue;
        const names = rule.selectorText.split(',').map((s) => s.trim());
        if (!names.includes(wanted)) continue;
        return {
          style: rule.style.getPropertyValue('text-decoration-style'),
          thickness: rule.style.getPropertyValue('text-decoration-thickness'),
          line: rule.style.getPropertyValue('text-decoration-line'),
          fill: rule.style.getPropertyValue('background-color'),
        };
      }
    }
    return null;
  }, registryName);
}

/**
 * Painted texts per colour, excluding the active one. Registries are named `sv-hl-<color>` for a
 * kind-less entry and `sv-hl-<color>-<kind>` otherwise (packages/highlights painter.ts); colour ids
 * contain no hyphen, so the colour is the first segment and every kind of one colour is merged.
 */
export async function paintedByColor(page: Page): Promise<Record<string, string[]>> {
  return page.evaluate(() => {
    const out: Record<string, string[]> = {};
    for (const [name, hl] of CSS.highlights) {
      if (!name.startsWith('sv-hl-') || name === 'sv-hl-active') continue;
      const rest = name.slice('sv-hl-'.length);
      const color = rest.split('-')[0] ?? rest;
      const texts = Array.from(hl as unknown as Iterable<AbstractRange>).map((r) =>
        (r as Range).toString(),
      );
      if (texts.length > 0) (out[color] ??= []).push(...texts);
    }
    return out;
  });
}

/** Painted texts per full registry name (`sv-hl-<color>[-<kind>]`), excluding the active one. */
export async function paintedByRegistry(page: Page): Promise<Record<string, string[]>> {
  return page.evaluate(() => {
    const out: Record<string, string[]> = {};
    for (const [name, hl] of CSS.highlights) {
      if (!name.startsWith('sv-hl-') || name === 'sv-hl-active') continue;
      const texts = Array.from(hl as unknown as Iterable<AbstractRange>).map((r) =>
        (r as Range).toString(),
      );
      if (texts.length > 0) out[name] = texts;
    }
    return out;
  });
}

/** Number of ranges currently published under any `sv-hl-*` registry (the active one included). */
export async function publishedRangeCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    let n = 0;
    for (const [name, hl] of CSS.highlights) if (name.startsWith('sv-hl-')) n += hl.size;
    return n;
  });
}

/** Texts in the `sv-hl-active` registry (the "Show on page" flash). */
export async function activeTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const hl = CSS.highlights.get('sv-hl-active');
    if (!hl) return [];
    return Array.from(hl as unknown as Iterable<AbstractRange>).map((r) => (r as Range).toString());
  });
}

export const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------------------------
// Layout probes (extension pages at narrow widths)
// ---------------------------------------------------------------------------------------------

export interface LayoutReport {
  innerWidth: number;
  scrollWidth: number;
  /** Interactive elements that leave [0, innerWidth] or violate the WCAG 2.5.8 target-size rules. */
  offenders: string[];
}

/**
 * Horizontal-overflow and target-size probe for an extension page.
 *  - Every interactive element must lie inside [0, innerWidth].
 *  - Targets smaller than `minTarget` x `minTarget` CSS px must satisfy a WCAG 2.5.8 exception:
 *    inline links inside a sentence, a checkbox/radio whose label makes the clickable area big
 *    enough, or "spacing" (a 24 px circle centred on the target touches no other target).
 */
export async function layoutReport(page: Page, minTarget = 24): Promise<LayoutReport> {
  return page.evaluate((min) => {
    const w = window.innerWidth;
    const offenders: string[] = [];
    const sel = 'button, a[href], select, textarea, input, [role="tab"]';
    interface Target {
      el: HTMLElement;
      label: string;
      r: {
        left: number;
        top: number;
        right: number;
        bottom: number;
        width: number;
        height: number;
      };
    }
    const targets: Target[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      let box = el.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      const isToggle =
        el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio');
      const wrapper = isToggle ? el.closest('label') : null;
      if (wrapper) box = wrapper.getBoundingClientRect();
      const label = (el.getAttribute('aria-label') ?? el.textContent ?? el.localName)
        .trim()
        .slice(0, 40);
      targets.push({
        el,
        label: `${el.localName} "${label}"`,
        r: {
          left: box.left,
          top: box.top,
          right: box.right,
          bottom: box.bottom,
          width: box.width,
          height: box.height,
        },
      });
    }
    const small = (t: Target) => t.r.width < min || t.r.height < min;
    const circle = (t: Target) => ({
      x: (t.r.left + t.r.right) / 2,
      y: (t.r.top + t.r.bottom) / 2,
    });
    const distToRect = (p: { x: number; y: number }, r: Target['r']) => {
      const dx = Math.max(r.left - p.x, 0, p.x - r.right);
      const dy = Math.max(r.top - p.y, 0, p.y - r.bottom);
      return Math.hypot(dx, dy);
    };
    for (const t of targets) {
      if (t.r.left < -0.5 || t.r.right > w + 0.5) {
        offenders.push(`${t.label} spans ${t.r.left.toFixed(0)}..${t.r.right.toFixed(0)} of ${w}`);
        continue;
      }
      if (!small(t)) continue;
      if (
        t.el.localName === 'a' &&
        t.el.closest('p, li') !== null &&
        t.el.closest('nav') === null
      ) {
        continue; // inline link in running text
      }
      const c = circle(t);
      const radius = min / 2;
      const crowded = targets.some((o) => {
        if (o === t) return false;
        if (o.el.contains(t.el) || t.el.contains(o.el)) return false;
        if (small(o)) {
          const oc = circle(o);
          return Math.hypot(oc.x - c.x, oc.y - c.y) < min;
        }
        return distToRect(c, o.r) < radius;
      });
      if (crowded) {
        offenders.push(
          `${t.label} is ${t.r.width.toFixed(0)}x${t.r.height.toFixed(0)} with no spacing exception`,
        );
      }
    }
    return { innerWidth: w, scrollWidth: document.documentElement.scrollWidth, offenders };
  }, minTarget);
}

/** Perceived luminance (0..1) of an element's computed background colour (-1 when unparsable). */
export async function luminanceOf(locator: Locator): Promise<number> {
  return locator.evaluate((el) => {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(el).backgroundColor);
    if (!m) return -1;
    const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  });
}

/** Luminance of the page body background as the user sees it. */
export const pageLuminance = (page: Page): Promise<number> => luminanceOf(page.locator('body'));

// ---------------------------------------------------------------------------------------------
// Real popup (chrome.action.openPopup) driven through raw CDP
// ---------------------------------------------------------------------------------------------

type CdpReply = {
  id?: number;
  result?: {
    result?: { value?: unknown };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  };
  error?: { message: string };
};

/**
 * A browser-owned extension target that Playwright does not attach to (chrome.action.openPopup
 * popups and the side panel). Commands go through the non-flattened Target.sendMessageToTarget
 * channel of a browser-level CDP session, so Runtime.evaluate and trusted Input events work.
 *
 * (The flattened mode would need a `sessionId` on every message, which Playwright's CDPSession.send
 * cannot express for a browser-level session.)
 *
 * Lifecycle: Chrome closes an action popup as soon as its window loses activation, and a target
 * that is gone invalidates the session. Both used to surface as an unhandled "No session with given
 * id" rejection plus a command that never settled. The session is now tracked: when the browser
 * detaches it, every pending and later command rejects at once with a message that says the target
 * closed, and `closed` tells a test whether that happened.
 */
export class RawTarget {
  private readonly waiters = new Map<
    number,
    { resolve(reply: CdpReply): void; reject(err: Error): void }
  >();
  private nextId = 1;
  private sessionId = '';
  private gone: string | null = null;

  private constructor(
    private readonly cdp: CDPSession,
    readonly targetId: string,
  ) {}

  static async attach(context: BrowserContext, targetId: string): Promise<RawTarget> {
    const browser = context.browser();
    if (!browser) throw new Error('no browser handle');
    const cdp = await browser.newBrowserCDPSession();
    const raw = new RawTarget(cdp, targetId);
    cdp.on('Target.receivedMessageFromTarget', (event) => {
      if (event.sessionId !== raw.sessionId) return;
      const reply = JSON.parse(event.message) as CdpReply;
      if (reply.id !== undefined) raw.waiters.get(reply.id)?.resolve(reply);
    });
    cdp.on('Target.detachedFromTarget', (event) => {
      if (event.sessionId === raw.sessionId) raw.markGone('the browser detached the session');
    });
    cdp.on('Target.targetDestroyed', (event) => {
      if (event.targetId === targetId) raw.markGone('the target was destroyed');
    });
    const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: false });
    raw.sessionId = attached.sessionId;
    return raw;
  }

  /** True once the browser has closed this target (a popup closes itself on blur and on window.close()). */
  get closed(): boolean {
    return this.gone !== null;
  }

  private markGone(why: string): void {
    if (this.gone !== null) return;
    this.gone = why;
    for (const waiter of this.waiters.values()) {
      waiter.reject(new Error(`target ${this.targetId} closed: ${why}`));
    }
    this.waiters.clear();
  }

  private send(method: string, params: object = {}): Promise<CdpReply> {
    if (this.gone !== null) {
      return Promise.reject(new Error(`target ${this.targetId} closed: ${this.gone}`));
    }
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.waiters.set(id, {
        resolve: (reply) => {
          this.waiters.delete(id);
          resolve(reply);
        },
        reject,
      });
      this.cdp
        .send('Target.sendMessageToTarget', {
          sessionId: this.sessionId,
          message: JSON.stringify({ id, method, params }),
        })
        .catch((err: unknown) => {
          // "No session with given id": the target went away between our last reply and now.
          this.waiters.delete(id);
          this.markGone(String((err as Error)?.message ?? err));
          reject(new Error(`target ${this.targetId} closed: ${this.gone}`));
        });
    });
  }

  async eval<T>(expression: string): Promise<T> {
    const reply = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (reply.error) throw new Error(`Runtime.evaluate failed: ${reply.error.message}`);
    const details = reply.result?.exceptionDetails;
    if (details)
      throw new Error(details.exception?.description ?? details.text ?? 'evaluate failed');
    return reply.result?.result?.value as T;
  }

  text(): Promise<string> {
    return this.eval<string>('document.body ? document.body.innerText : ""');
  }

  /** Poll until `check` is true; fails at once, with the reason, when the target has closed. */
  private async until(check: () => Promise<boolean>, what: string, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.gone !== null) throw new Error(`${what}: target closed (${this.gone})`);
      let ok = false;
      try {
        ok = await check();
      } catch {
        if (this.gone !== null) throw new Error(`${what}: target closed (${this.gone})`);
        // anything else (page still loading, execution context replaced) is retried until the deadline
      }
      if (ok) return;
      if (Date.now() > deadline) throw new Error(`${what}: not satisfied within ${timeoutMs} ms`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async waitForText(re: RegExp, timeoutMs = 10_000): Promise<string> {
    let last = '';
    await this.until(
      async () => {
        last = await this.text();
        return re.test(last);
      },
      `popup text should match ${re}`,
      timeoutMs,
    );
    return last;
  }

  /**
   * Centre of the first button named `label`: its aria-label, else its text without the parts hidden
   * from assistive technology (a shortcut hint such as "Open side panel Alt+Shift+S" is aria-hidden).
   */
  private buttonCentre(label: string): Promise<{ x: number; y: number } | null> {
    return this.eval(`(() => {
      const nameOf = (x) => {
        if (x.hasAttribute('aria-label')) return x.getAttribute('aria-label').trim();
        const copy = x.cloneNode(true);
        copy.querySelectorAll('[aria-hidden="true"]').forEach((h) => h.remove());
        return copy.textContent.replace(/\\s+/g, ' ').trim();
      };
      const b = [...document.querySelectorAll('button')].find((x) => nameOf(x) === ${JSON.stringify(label)});
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
  }

  async hasButton(label: string): Promise<boolean> {
    return (await this.buttonCentre(label)) !== null;
  }

  /**
   * Trusted left click (Input.dispatchMouseEvent) on the button with exactly this text. A click
   * that makes the target close itself (popup "Open side panel" calls window.close()) is a success:
   * the browser may detach the session before the release is acknowledged.
   */
  async clickButton(label: string): Promise<void> {
    await this.until(() => this.hasButton(label), `button "${label}" in popup`, 10_000);
    const c = await this.buttonCentre(label);
    if (!c) throw new Error(`button "${label}" disappeared`);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: c.x,
      y: c.y,
      button: 'left',
      clickCount: 1,
    });
    try {
      await this.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: c.x,
        y: c.y,
        button: 'left',
        clickCount: 1,
      });
    } catch (err) {
      if (!this.closed) throw err;
    }
  }

  async close(): Promise<void> {
    await this.cdp.send('Target.closeTarget', { targetId: this.targetId }).catch(() => undefined);
  }
}

/** Target ids currently reported by the browser whose URL ends with `suffix`. */
export async function targetIds(context: BrowserContext, suffix: string): Promise<string[]> {
  const browser = context.browser();
  if (!browser) throw new Error('no browser handle');
  const cdp = await browser.newBrowserCDPSession();
  const { targetInfos } = await cdp.send('Target.getTargets');
  await cdp.detach().catch(() => undefined);
  return targetInfos.filter((t) => t.url.endsWith(suffix)).map((t) => t.targetId);
}

/**
 * chrome.action.openPopup() from the service worker, then attach to the popup target Chrome
 * creates. The active tab of the window is whatever the test brought to the front beforehand.
 */
export async function openRealPopup(env: Env): Promise<RawTarget> {
  const before = new Set(await targetIds(env.context, '/popup.html'));
  const outcome = await env.serviceWorker.evaluate(async () => {
    try {
      await chrome.action.openPopup();
      return 'ok';
    } catch (err) {
      return `error: ${(err as Error).message}`;
    }
  });
  if (outcome !== 'ok') throw new Error(`chrome.action.openPopup failed: ${outcome}`);
  let found: string | undefined;
  await expect
    .poll(
      async () => {
        found = (await targetIds(env.context, '/popup.html')).find((id) => !before.has(id));
        return found !== undefined;
      },
      { message: 'popup target should appear after chrome.action.openPopup()' },
    )
    .toBe(true);
  return RawTarget.attach(env.context, found as string);
}

// ---------------------------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------------------------

/** A TCP port that nothing listens on (connection refused), for real browser error pages. */
export async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** A minimal, valid one-page PDF (correct xref offsets) so Chrome's built-in viewer opens it. */
export function minimalPdf(text: string): Buffer {
  const stream = `BT /F1 18 Tf 20 70 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
