import type { BrowserContext, CDPSession, Locator, Page, Worker } from '@playwright/test';
import net from 'node:net';
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

export async function openExt(env: Env, name: ExtPageName): Promise<Page> {
  const page = await env.context.newPage();
  watchErrors(page);
  await page.goto(`chrome-extension://${env.extensionId}/${name}.html`);
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

/** tab.activate through the real RPC, then wait until the overlay host is mounted. */
export async function activate(env: Env, page: Page): Promise<void> {
  await activateTab(env.context, env.extensionId, page);
  await expect(page.locator(OVERLAY_HOST)).toHaveCount(1);
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

/** Write settings fields the way the options page would persist them (parseSettings fills the rest). */
export async function patchSettings(ext: Page, patch: Record<string, unknown>): Promise<void> {
  await ext.evaluate(async (p) => {
    const got = await chrome.storage.local.get('settings');
    const current = (got.settings as Record<string, unknown> | undefined) ?? {};
    await chrome.storage.local.set({ settings: { ...current, ...p } });
  }, patch);
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
 */
export async function sendFromContentWorld(
  ext: Page,
  tabId: number,
  message: unknown,
): Promise<Envelope | { thrown: string } | undefined> {
  return ext.evaluate(
    async ({ tabId, message }) => {
      const out = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'ISOLATED',
        args: [message],
        func: async (m: unknown) => {
          try {
            return (await chrome.runtime.sendMessage(m)) as unknown;
          } catch (err) {
            return { thrown: String((err as Error)?.message ?? err) };
          }
        },
      });
      return out[0]?.result as Envelope | { thrown: string } | undefined;
    },
    { tabId, message },
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
  await target.bringToFront();
  await activeTabId(ext);
  return ext;
}

/** Make `target` the active tab again (e.g. after a helper opened and closed a temporary page). */
export async function show(target: Page): Promise<void> {
  await target.bringToFront();
}

// ---------------------------------------------------------------------------------------------
// Real pointer input on fixture pages
// ---------------------------------------------------------------------------------------------

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
  await page.locator(selector).click({ clickCount: 3 });
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
  await page.locator(selector).click({ clickCount: 3 });
  await expect(toolbarOf(page)).toBeVisible();
  await page.getByRole('button', { name: 'More options', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Save with details' });
  await dialog.getByRole('combobox', { name: 'Bank' }).selectOption({ label: bankName });
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(async () => (await highlightsOf(ext, page.url())).length).toBe(before + 1);
}

/** Painted texts per colour registry (`sv-hl-<color>`), excluding the active one. */
export async function paintedByColor(page: Page): Promise<Record<string, string[]>> {
  return page.evaluate(() => {
    const out: Record<string, string[]> = {};
    for (const [name, hl] of CSS.highlights) {
      if (!name.startsWith('sv-hl-') || name === 'sv-hl-active') continue;
      const texts = Array.from(hl as unknown as Iterable<AbstractRange>).map((r) =>
        (r as Range).toString(),
      );
      if (texts.length > 0) out[name.slice('sv-hl-'.length)] = texts;
    }
    return out;
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
 */
export class RawTarget {
  private readonly waiters = new Map<number, (reply: CdpReply) => void>();
  private nextId = 1;
  private sessionId = '';

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
      if (reply.id !== undefined) raw.waiters.get(reply.id)?.(reply);
    });
    const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: false });
    raw.sessionId = attached.sessionId;
    return raw;
  }

  private send(method: string, params: object = {}): Promise<CdpReply> {
    return new Promise((resolve) => {
      const id = this.nextId++;
      this.waiters.set(id, (reply) => {
        this.waiters.delete(id);
        resolve(reply);
      });
      void this.cdp.send('Target.sendMessageToTarget', {
        sessionId: this.sessionId,
        message: JSON.stringify({ id, method, params }),
      });
    });
  }

  async eval<T>(expression: string): Promise<T> {
    const reply = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    const details = reply.result?.exceptionDetails;
    if (details)
      throw new Error(details.exception?.description ?? details.text ?? 'evaluate failed');
    return reply.result?.result?.value as T;
  }

  text(): Promise<string> {
    return this.eval<string>('document.body ? document.body.innerText : ""');
  }

  async waitForText(re: RegExp, timeoutMs = 10_000): Promise<string> {
    let last = '';
    await expect
      .poll(
        async () => {
          last = await this.text().catch(() => '');
          return re.test(last);
        },
        { timeout: timeoutMs, message: `popup text should match ${re}` },
      )
      .toBe(true);
    return last;
  }

  /** Centre of the first button whose text matches; null when there is none. */
  private buttonCentre(label: string): Promise<{ x: number; y: number } | null> {
    return this.eval(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
  }

  async hasButton(label: string): Promise<boolean> {
    return (await this.buttonCentre(label)) !== null;
  }

  /** Trusted left click (Input.dispatchMouseEvent) on the button with exactly this text. */
  async clickButton(label: string): Promise<void> {
    await expect
      .poll(async () => this.hasButton(label), { message: `button "${label}" in popup` })
      .toBe(true);
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
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: c.x,
      y: c.y,
      button: 'left',
      clickCount: 1,
    });
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
