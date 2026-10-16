import { chromium, expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { E2E_EXTENSION_PATH } from './fixtures';

/**
 * Helpers for the lifecycle / persistence / resilience specs (lifecycle.spec.ts, resilience.spec.ts,
 * gate10.spec.ts). Everything here drives real Chromium + the real built extension: real mouse
 * input, real chrome.* calls from extension pages, real CDP service-worker control. Nothing mocks
 * a Chrome API.
 */

// Same constant as the Playwright fixtures: honours SV_OUT_DIR, so a parallel agent's private build
// folder is the one that gets launched here too.
export { E2E_EXTENSION_PATH };

/** Whitespace-collapsed, trimmed text: how the extension's text stream sees page text. */
export const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

// -----------------------------------------------------------------------------------------------
// Launching (explicit user data dir, so a test can close and relaunch the same profile)
// -----------------------------------------------------------------------------------------------

export interface Session {
  context: BrowserContext;
  extensionId: string;
  userDataDir: string;
}

export function newUserDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'studyvault-e2e-life-'));
}

/**
 * Abrupt termination (SIGKILL / TerminateProcess) of the browser process and every child process
 * Chrome reports, with no graceful shutdown. Waits until all of them are gone so a relaunch of
 * the same profile cannot race a dying process that still holds the database files.
 */
export async function hardKill(session: Session): Promise<void> {
  const browser = session.context.browser();
  if (!browser) throw new Error('no browser handle to kill');
  const cdp = await browser.newBrowserCDPSession();
  const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
  const main = processInfo.find((p) => p.type === 'browser');
  if (!main) throw new Error('browser process id not reported');
  const ids = [main.id, ...processInfo.filter((p) => p.id !== main.id).map((p) => p.id)];
  for (const id of ids) {
    try {
      process.kill(id, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  const alive = (id: number): boolean => {
    try {
      process.kill(id, 0);
      return true;
    } catch {
      return false;
    }
  };
  for (let i = 0; i < 150 && ids.some(alive); i++) await new Promise((r) => setTimeout(r, 100));
  if (ids.some(alive)) throw new Error('browser processes did not exit after SIGKILL');
  // Playwright's own handle: closing a dead browser may reject or take a moment.
  await Promise.race([
    session.context.close().catch(() => undefined),
    new Promise((r) => setTimeout(r, 10_000)),
  ]);
}

export function removeDir(dir: string): void {
  // Windows keeps handles for a moment after the browser exits.
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
}

export async function launchSession(userDataDir: string): Promise<Session> {
  if (!fs.existsSync(path.join(E2E_EXTENSION_PATH, 'manifest.json'))) {
    throw new Error(`Extension not built at ${E2E_EXTENSION_PATH}`);
  }
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${E2E_EXTENSION_PATH}`,
      `--load-extension=${E2E_EXTENSION_PATH}`,
    ],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  return { context, extensionId: new URL(worker.url()).host, userDataDir };
}

// -----------------------------------------------------------------------------------------------
// Extension pages: RPC, tabs, storage, IndexedDB
// -----------------------------------------------------------------------------------------------

export type Envelope =
  { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };

/** An extension page used as a trusted control surface (same origin as the service worker's DB). */
export async function openExtensionPage(
  context: BrowserContext,
  extensionId: string,
  file = 'options.html',
): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/${file}`);
  return page;
}

/** `chrome.runtime.sendMessage` with the product's wire format, from an extension page. */
export async function rpc(ext: Page, type: string, payload: unknown = {}): Promise<Envelope> {
  return (await ext.evaluate(
    (m) => chrome.runtime.sendMessage({ v: 1, type: m.type, payload: m.payload }),
    { type, payload },
  )) as Envelope;
}

/** `chrome.tabs.sendMessage` (service worker / extension page -> content script). */
export async function tabRpc(
  ext: Page,
  tabId: number,
  type: string,
  payload: unknown = {},
): Promise<Envelope> {
  return (await ext.evaluate(
    async (m) => {
      try {
        return await chrome.tabs.sendMessage(m.tabId, { v: 1, type: m.type, payload: m.payload });
      } catch (err) {
        return { ok: false, error: { code: 'no_receiver', message: String(err) } };
      }
    },
    { tabId, type, payload },
  )) as Envelope;
}

/** Chrome's tab id of a Playwright page (title marker when several tabs share one URL). */
export async function tabIdOf(ext: Page, page: Page): Promise<number> {
  const url = page.url();
  const byUrl = await ext.evaluate(async (u) => {
    const tabs = await chrome.tabs.query({});
    return tabs.filter((t) => t.url === u).map((t) => t.id ?? -1);
  }, url);
  if (byUrl.length === 1 && byUrl[0] !== undefined && byUrl[0] >= 0) return byUrl[0];

  const original = await page.title();
  const marker = `sv-e2e-tab-${Math.random().toString(36).slice(2)}`;
  await page.evaluate((m) => {
    document.title = m;
  }, marker);
  try {
    let id = -1;
    await expect
      .poll(
        async () => {
          id = await ext.evaluate(async (m) => {
            const tabs = await chrome.tabs.query({ title: m });
            return tabs[0]?.id ?? -1;
          }, marker);
          return id;
        },
        { timeout: 5_000, message: `no Chrome tab with title ${marker}` },
      )
      .toBeGreaterThanOrEqual(0);
    return id;
  } finally {
    await page.evaluate((t) => {
      document.title = t;
    }, original);
  }
}

/** Real `tab.activate` RPC for `page` (the path the popup and side panel use). */
export async function activate(ext: Page, page: Page): Promise<number> {
  const tabId = await tabIdOf(ext, page);
  const result = await rpc(ext, 'tab.activate', { tabId });
  if (!result.ok) throw new Error(`tab.activate failed: ${JSON.stringify(result)}`);
  // tab.activate returns as soon as the script answers a ping, which it does BEFORE the overlay is
  // built and its selection listeners exist. `content.pageStatus` waits for the start-up to finish,
  // so any answer from it (even a refusal) means the page really is ready for a selection.
  await expect
    .poll(
      async () => {
        const reply = await tabRpc(ext, tabId, 'content.pageStatus');
        return reply.ok || reply.error.code !== 'no_receiver';
      },
      { timeout: 30_000, message: 'the content script should finish starting after activation' },
    )
    .toBe(true);
  return tabId;
}

export interface Counts {
  total: number;
  resolved: number;
  changed: number;
  ambiguous: number;
  orphaned: number;
  pending: number;
}

/** The content script's live view of the page (what the popup/side panel show). */
export async function pageCounts(ext: Page, tabId: number): Promise<Counts | null> {
  const res = await tabRpc(ext, tabId, 'content.pageStatus');
  return res.ok ? (res.data as { counts: Counts }).counts : null;
}

export interface DbHighlight {
  id: string;
  sourceId: string;
  exactQuote: string;
  quoteHash: string;
  anchorSet: unknown;
  kind: string;
  userComment: string;
  resolveStatus: 'unchecked' | 'resolved' | 'changed' | 'ambiguous' | 'orphaned';
  resolveConfidence: number | null;
  deletedAt: string | null;
  captureMethod: string;
  /** Address (credentials removed) and title of the page when the quote was saved. */
  capturedUrl?: string;
  capturedTitle?: string;
}

export interface DbSource {
  id: string;
  urlKey: string;
  visitedKey: string;
  originalUrl: string;
  host: string;
  title: string;
}

export interface DbSnapshot {
  highlights: DbHighlight[];
  sources: DbSource[];
  banks: Array<{ id: string; name: string }>;
  highlightBanks: Array<{ highlightId: string; bankId: string }>;
}

/**
 * Raw read of IndexedDB "studyvault" from an extension page (same origin as the service worker).
 * Opened without a version so it can never trigger an upgrade; closed immediately.
 */
export async function readDb(ext: Page): Promise<DbSnapshot> {
  return ext.evaluate(async () => {
    const empty = { highlights: [], sources: [], banks: [], highlightBanks: [] };
    const known = await indexedDB.databases();
    if (!known.some((d) => d.name === 'studyvault')) return empty;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('studyvault');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      const all = (store: string) =>
        new Promise<unknown[]>((resolve, reject) => {
          const req = db.transaction(store, 'readonly').objectStore(store).getAll();
          req.onsuccess = () => resolve(req.result as unknown[]);
          req.onerror = () => reject(req.error);
        });
      return {
        highlights: (await all('highlights')) as never,
        sources: (await all('sources')) as never,
        banks: (await all('banks')) as never,
        highlightBanks: (await all('highlightBanks')) as never,
      };
    } finally {
      db.close();
    }
  });
}

export const liveHighlights = (db: DbSnapshot): DbHighlight[] =>
  db.highlights.filter((h) => h.deletedAt === null);

/**
 * Merge `patch` into the settings (missing fields fall back to defaults on read), through the
 * worker's `updateSettings` via the e2e-build-only hook (entrypoints/background/e2e.ts): the
 * worker enforces its own authoritative copy and ignores direct chrome.storage.local writes.
 */
export async function patchSettings(ext: Page, patch: Record<string, unknown>): Promise<void> {
  await ext.evaluate(async (json) => {
    // A JSON string: extension messaging drops null properties of an object argument.
    const reply = (await chrome.runtime.sendMessage({
      v: 1,
      type: 'e2e.settings.patch',
      payload: { json },
    })) as { ok?: boolean; error?: unknown } | undefined;
    if (!reply?.ok) throw new Error(`patchSettings was refused: ${JSON.stringify(reply)}`);
  }, JSON.stringify(patch));
}

export async function registeredScripts(
  ext: Page,
): Promise<Array<{ id: string; matches?: string[]; excludeMatches?: string[] }>> {
  return ext.evaluate(() => chrome.scripting.getRegisteredContentScripts());
}

/**
 * Turns on "Developer mode" on chrome://extensions, the toggle a developer flips by hand.
 * Without it Chrome refuses to RE-load a command-line-loaded unpacked extension, so
 * chrome.runtime.reload() would leave it disabled (a harness property, not a product one).
 */
export async function enableDeveloperMode(context: BrowserContext): Promise<void> {
  const page = await context.newPage();
  try {
    await page.goto('chrome://extensions');
    const toggle = page.getByRole('switch').first();
    if ((await toggle.getAttribute('aria-checked')) !== 'true') await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
  } finally {
    await page.close();
  }
}

// -----------------------------------------------------------------------------------------------
// Service worker control (CDP ServiceWorker domain) and restart evidence
// -----------------------------------------------------------------------------------------------

export interface WorkerState {
  timeOrigin: number;
  probe: string | null;
}

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T | undefined> =>
  Promise.race([promise, new Promise<undefined>((resolve) => setTimeout(resolve, ms))]);

/** State of the currently running extension worker, or null when none answers (stopped). */
export async function workerState(
  context: BrowserContext,
  extensionId: string,
): Promise<WorkerState | null> {
  for (const worker of context.serviceWorkers()) {
    if (!worker.url().startsWith(`chrome-extension://${extensionId}/`)) continue;
    const state = await withTimeout(
      worker
        .evaluate(() => ({
          timeOrigin: performance.timeOrigin,
          probe: ((globalThis as { __svProbe?: string }).__svProbe ?? null) as string | null,
        }))
        .catch(() => undefined),
      2_000,
    );
    if (state) return state;
  }
  return null;
}

/** Plant a marker in the worker's global scope; it vanishes when the worker is restarted. */
export async function markWorker(
  context: BrowserContext,
  extensionId: string,
  token: string,
): Promise<WorkerState> {
  const worker = context
    .serviceWorkers()
    .find((w) => w.url().startsWith(`chrome-extension://${extensionId}/`));
  if (!worker) throw new Error('extension service worker is not running');
  await worker.evaluate((t) => {
    (globalThis as { __svProbe?: string }).__svProbe = t;
  }, token);
  const state = await workerState(context, extensionId);
  if (!state || state.probe !== token) throw new Error('could not mark the service worker');
  return state;
}

/**
 * Stops the extension's service worker with CDP `ServiceWorker.stopWorker` (what Chrome does when
 * it suspends an idle worker) and waits until Chrome reports it stopped.
 * Returns how long the stop took.
 */
export async function stopWorker(
  context: BrowserContext,
  extensionId: string,
  via: Page,
): Promise<number> {
  const cdp = await context.newCDPSession(via);
  try {
    const versions = new Map<string, { scriptURL: string; runningStatus: string }>();
    cdp.on('ServiceWorker.workerVersionUpdated', (event) => {
      for (const v of event.versions) {
        versions.set(v.versionId, { scriptURL: v.scriptURL, runningStatus: v.runningStatus });
      }
    });
    await cdp.send('ServiceWorker.enable');
    const prefix = `chrome-extension://${extensionId}/`;
    const find = () =>
      [...versions].find(
        ([, v]) => v.scriptURL.startsWith(prefix) && v.runningStatus !== 'stopped',
      );
    // Events for the existing workers arrive right after enable().
    let target = find();
    for (let i = 0; i < 40 && !target; i++) {
      await new Promise((r) => setTimeout(r, 50));
      target = find();
    }
    if (!target) throw new Error('no running extension service worker to stop');
    const started = Date.now();
    await cdp.send('ServiceWorker.stopWorker', { versionId: target[0] });
    // A worker with a transaction or an event handler still in flight finishes it before it stops, and
    // a loaded CI runner can take several seconds; ask again every 5 s rather than give up early.
    for (let i = 0; i < 600; i++) {
      if (versions.get(target[0])?.runningStatus === 'stopped') return Date.now() - started;
      if (i > 0 && i % 100 === 0) {
        await cdp.send('ServiceWorker.stopWorker', { versionId: target[0] }).catch(() => undefined);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('the service worker did not stop');
  } finally {
    await cdp.send('ServiceWorker.disable').catch(() => undefined);
    await cdp.detach().catch(() => undefined);
  }
}

/**
 * Wakes the worker (any extension message does) and returns its fresh state. Used as restart
 * evidence together with markWorker(): a different timeOrigin and no probe.
 */
export async function wakeWorker(
  ext: Page,
  context: BrowserContext,
  extensionId: string,
): Promise<WorkerState> {
  const res = await rpc(ext, 'banks.list');
  if (!res.ok) throw new Error(`worker did not answer after wake-up: ${JSON.stringify(res)}`);
  let state: WorkerState | null = null;
  await expect
    .poll(async () => (state = await workerState(context, extensionId)), { timeout: 10_000 })
    .not.toBeNull();
  return state as unknown as WorkerState;
}

// -----------------------------------------------------------------------------------------------
// Content script isolated world (real chrome.runtime sender = the page's tab)
// -----------------------------------------------------------------------------------------------

/**
 * Evaluates `expression` inside the extension's content-script isolated world of `page` through
 * CDP. A `chrome.runtime.sendMessage` made there reaches the service worker exactly like a message
 * from the product's own content script (real `sender.tab` / `sender.url`).
 */
export async function evalInContentScript<T>(
  context: BrowserContext,
  page: Page,
  extensionId: string,
  expression: string,
): Promise<T> {
  const cdp = await context.newCDPSession(page);
  try {
    const worlds: number[] = [];
    cdp.on('Runtime.executionContextCreated', (event) => {
      const aux = event.context.auxData as { type?: string; isDefault?: boolean } | undefined;
      if (aux?.type === 'isolated' || aux?.isDefault === false) worlds.push(event.context.id);
    });
    await cdp.send('Runtime.enable');
    for (let i = 0; i < 20 && worlds.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    for (const contextId of worlds) {
      const probe = await cdp
        .send('Runtime.evaluate', {
          expression: 'typeof chrome !== "undefined" && chrome.runtime ? chrome.runtime.id : null',
          contextId,
          returnByValue: true,
        })
        .catch(() => null);
      if (probe?.result?.value !== extensionId) continue;
      const out = await cdp.send('Runtime.evaluate', {
        expression,
        contextId,
        awaitPromise: true,
        returnByValue: true,
      });
      if (out.exceptionDetails) {
        throw new Error(`content-script evaluation failed: ${out.exceptionDetails.text}`);
      }
      return out.result.value as T;
    }
    throw new Error('the extension content script is not running in this page');
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

// -----------------------------------------------------------------------------------------------
// Page: selection, toolbar, painted highlights
// -----------------------------------------------------------------------------------------------

export interface Painted {
  text: string;
  color: string;
  /** Kind part of the registry name (`sv-hl-<color>-<kind>`), null for a kind-less entry. */
  kind: string | null;
  /** Closest ancestor element id of the painted range ('' when none). */
  hostId: string;
}

/**
 * Every non-empty range in an sv-hl-* registry, with where it sits. Registries are named
 * `sv-hl-<color>` or `sv-hl-<color>-<kind>`; colour ids have no hyphen, so the colour is the first
 * segment and `kind` is whatever follows (null for a kind-less entry).
 */
export async function paintedDetail(page: Page): Promise<Painted[]> {
  return page.evaluate(() => {
    const out: Array<{ text: string; color: string; kind: string | null; hostId: string }> = [];
    for (const [name, hl] of CSS.highlights) {
      if (!name.startsWith('sv-hl-') || name === 'sv-hl-active') continue;
      const rest = name.slice('sv-hl-'.length);
      const dash = rest.indexOf('-');
      const color = dash < 0 ? rest : rest.slice(0, dash);
      const kind = dash < 0 ? null : rest.slice(dash + 1);
      for (const abstract of hl as unknown as Iterable<AbstractRange>) {
        const range = abstract as Range;
        const text = range.toString();
        if (text === '') continue;
        const container = range.commonAncestorContainer;
        const el = container.nodeType === 1 ? (container as Element) : container.parentElement;
        out.push({ text, color, kind, hostId: el?.closest('[id]')?.id ?? '' });
      }
    }
    return out;
  });
}

export async function paintedNormalized(page: Page): Promise<string[]> {
  return (await paintedDetail(page)).map((p) => norm(p.text)).sort();
}

/** Waits until exactly `expected` (whitespace-normalised, any order) is painted: no more, no less. */
export async function expectPaintedExactly(
  page: Page,
  expected: readonly string[],
  timeout = 15_000,
): Promise<void> {
  const want = expected.map(norm).sort();
  await expect
    .poll(() => paintedNormalized(page), {
      timeout,
      message: `painted texts on ${page.url()} should be exactly the saved passages`,
    })
    .toEqual(want);
}

export const toolbarOf = (page: Page) => page.getByRole('toolbar', { name: /StudyVault/ });

/** Real triple-click near the top-left of an element (avoids links in the middle of a block). */
export async function tripleClick(page: Page, selector: string): Promise<void> {
  await page
    .locator(selector)
    .first()
    .click({ clickCount: 3, position: { x: 4, y: 4 } });
}

export interface DragEnd {
  selector: string;
  phrase: string;
}

/**
 * Real mouse drag from the first character of `from.phrase` (inside `from.selector`) to the last
 * character of `to.phrase` (default: the same element/phrase). Whitespace in the phrase is the
 * collapsed form. Returns the page's selection text.
 */
export async function dragSelect(page: Page, from: DragEnd, to: DragEnd = from): Promise<string> {
  await page.locator(from.selector).first().scrollIntoViewIfNeeded();
  const pts = await page.evaluate(
    ({ from, to }) => {
      const locate = (selector: string, phrase: string) => {
        const root = document.querySelector(selector);
        if (!root) throw new Error(`no element ${selector}`);
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const map: Array<{ node: Text; offset: number }> = [];
        let text = '';
        let lastSpace = true;
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const t = n as Text;
          for (let i = 0; i < t.data.length; i++) {
            const ch = t.data.charAt(i);
            if (/\s/.test(ch)) {
              if (lastSpace) continue;
              text += ' ';
              lastSpace = true;
            } else {
              text += ch;
              lastSpace = false;
            }
            map.push({ node: t, offset: i });
          }
        }
        const idx = text.indexOf(phrase);
        if (idx === -1) throw new Error(`phrase not found in ${selector}: ${phrase}`);
        return { first: map[idx]!, last: map[idx + phrase.length - 1]! };
      };
      const rectOfChar = (node: Text, offset: number) => {
        const r = document.createRange();
        r.setStart(node, offset);
        r.setEnd(node, offset + 1);
        return r.getBoundingClientRect();
      };
      const a = locate(from.selector, from.phrase);
      const b = locate(to.selector, to.phrase);
      const ra = rectOfChar(a.first.node, a.first.offset);
      const rb = rectOfChar(b.last.node, b.last.offset);
      return {
        sx: ra.left + ra.width * 0.25,
        sy: ra.top + ra.height / 2,
        ex: rb.left + rb.width * 0.75,
        ey: rb.top + rb.height / 2,
      };
    },
    { from, to },
  );
  await page.mouse.move(pts.sx, pts.sy);
  await page.mouse.down();
  await page.mouse.move((pts.sx + pts.ex) / 2, (pts.sy + pts.ey) / 2, { steps: 4 });
  await page.mouse.move(pts.ex, pts.ey, { steps: 8 });
  await page.mouse.up();
  return page.evaluate(() => window.getSelection()?.toString() ?? '');
}

export const savedToast = (page: Page) =>
  page.getByText(/^(Saved to|Already saved|Restored in)/).first();

/** The action button (default "Undo") of the toast that contains `toastText`. */
export const toastAction = (page: Page, toastText: string | RegExp, label = 'Undo') =>
  page
    .locator('.sv-toast', { hasText: toastText })
    .getByRole('button', { name: label, exact: true });

/**
 * Click a toolbar button (default "Save selection") and wait until THAT save has finished: the
 * toolbar closes only when the save succeeded, whereas a toast from an earlier save can still be
 * on screen (and has the same text), so a toast alone is not a completion signal.
 * Returns the toast text.
 */
export async function saveSelection(page: Page, label = 'Save selection'): Promise<string> {
  await expect(toolbarOf(page)).toBeVisible();
  await page.getByRole('button', { name: label, exact: true }).click({ timeout: 10_000 });
  await expect(toolbarOf(page)).toHaveCount(0, { timeout: 20_000 });
  await expect(savedToast(page)).toBeVisible();
  return (await savedToast(page).textContent()) ?? '';
}

/** Select by real input, check what was selected, save through the toolbar. */
export async function selectAndSave(
  page: Page,
  how: { triple: string } | { from: DragEnd; to?: DragEnd },
  mustContain: string,
): Promise<string> {
  if ('triple' in how) await tripleClick(page, how.triple);
  else await dragSelect(page, how.from, how.to);
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '');
  // Chrome returns text-transformed text from Selection.toString() (hostile.html uppercases).
  expect(
    norm(selected).toLowerCase(),
    'the real mouse gesture selected the intended text',
  ).toContain(norm(mustContain).toLowerCase());
  return saveSelection(page);
}

/** Pick `option` in the overlay radio group `group` ("Kind" or "Priority") of a dialog. */
export const pickIn = (dialog: Locator, group: 'Kind' | 'Priority', option: string) =>
  dialog.getByRole('radiogroup', { name: group }).getByRole('radio', { name: option, exact: true });

/** Open the side panel's Recent list (every page, newest first): a page under the More tab. */
export async function openRecent(panel: Page): Promise<void> {
  await panel.getByRole('tab', { name: 'More', exact: true }).click();
  await panel.getByRole('button', { name: 'Recent' }).click();
  await expect(panel.getByRole('heading', { name: 'Recent', exact: true })).toBeVisible();
}

/**
 * Create a bank through the side panel's "New bank" wizard (name, then the default icon and colour),
 * close its "Bank ready!" screen and wait for the confirmation.
 */
export async function createBankInPanel(panel: Page, name: string): Promise<void> {
  await panel.getByRole('tab', { name: 'Banks', exact: true }).click();
  await panel.getByRole('button', { name: 'New bank', exact: true }).click();
  const wizard = panel.getByRole('dialog', { name: 'New bank' });
  await wizard.getByLabel('Bank name').fill(name);
  for (let step = 0; step < 3; step++) {
    await wizard.getByRole('button', { name: 'Next', exact: true }).click();
  }
  await wizard.getByRole('button', { name: 'Create bank', exact: true }).click();
  await expect(panel.getByText(`Bank "${name}" created.`)).toBeVisible();
  const done = panel.getByTestId('new-bank-done');
  await done.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(done).toHaveCount(0);
}

/** HTML of <body>: page markup must be byte-identical with and without StudyVault. */
export async function bodyMarkup(page: Page): Promise<string> {
  return page.evaluate(() => document.body.innerHTML);
}

export async function overlayHostCount(page: Page): Promise<number> {
  return page.locator('studyvault-overlay').count();
}

// -----------------------------------------------------------------------------------------------
// Network evidence
// -----------------------------------------------------------------------------------------------

export function recordRequests(context: BrowserContext): { urls: string[]; stop(): void } {
  const urls: string[] = [];
  const onRequest = (request: { url(): string }) => {
    urls.push(request.url());
  };
  context.on('request', onRequest);
  return { urls, stop: () => context.off('request', onRequest) };
}
