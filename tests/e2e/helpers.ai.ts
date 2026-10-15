import fs from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { settleAnimations } from './axeSettle';
import type { Locator, Page } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';
import { startFakeProvider, type ChatMessage, type FakeProvider } from './aiServer';
import {
  activeTabId,
  expect,
  highlightsOf,
  openExt,
  openFixture,
  saveBlock,
  storedSettings,
  test as base,
  waitForPageList,
  type Env,
  type HighlightRow,
} from './helpers.pages';

export { expect, highlightsOf, openExt, openFixture, saveBlock, storedSettings };
export type { Env, HighlightRow };

/**
 * Helpers for ai.spec.ts: the optional AI feature in a real loaded extension against the local fake
 * provider of ./aiServer.ts (no real key, no internet).
 *
 * Settings go through the UI the way a person does it (the switch, the setup wizard, the key field
 * under "Advanced"): the worker enforces a trusted copy of `settings`, so a raw storage write would
 * be ignored. Direct IndexedDB access is READ-ONLY and used to assert what was really persisted.
 */

/** A syntactically valid fake key (printable ASCII, 8 to 512 characters). Never a real key. */
export const FAKE_KEY = 'sk-e2e-fake-Zp3Qv7Lm9Rt2Xc8B';
export const OTHER_KEY = 'sk-e2e-other-Hn5Yw1Kd4Js6Ge0A';
export const MODEL = 'fake-model-1';

export const maskOf = (key: string): string => `••••••••${key.slice(-4)}`;

export const test = base.extend<{ provider: FakeProvider }>({
  // Playwright requires an object-destructuring first argument, even when empty.
  // eslint-disable-next-line no-empty-pattern
  provider: async ({}, use) => {
    const provider = await startFakeProvider({ apiKey: FAKE_KEY });
    await use(provider);
    await provider.close();
  },
});

// ---------------------------------------------------------------------------------------------
// What left the browser, what was printed
// ---------------------------------------------------------------------------------------------

export interface Traffic {
  /** "METHOD url" of every http(s) request any page or worker of the context made. */
  external: string[];
  /** Console output and uncaught page errors of every page opened after the watch started. */
  console: string[];
}

export function watchTraffic(env: Env): Traffic {
  const traffic: Traffic = { external: [], console: [] };
  env.context.on('request', (r) => {
    if (/^https?:/i.test(r.url())) traffic.external.push(`${r.method()} ${r.url()}`);
  });
  env.context.on('page', (p) => {
    p.on('console', (m) => traffic.console.push(`${m.type()}: ${m.text()}`));
    p.on('pageerror', (e) => traffic.console.push(`pageerror: ${e.message}`));
  });
  return traffic;
}

/** Requests to anything but the fixture page server. */
export const nonFixture = (env: Env, traffic: Traffic): string[] =>
  traffic.external.filter((u) => !u.includes(env.origin));

// ---------------------------------------------------------------------------------------------
// Reading what was persisted
// ---------------------------------------------------------------------------------------------

/** Rows of one table of the vault database (read-only; never creates or upgrades it). */
export async function readTable(
  page: Page,
  store: string,
): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(async (name) => {
    const known = await indexedDB.databases();
    if (!known.some((d) => d.name === 'studyvault')) return [];
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('studyvault');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      if (!Array.from(db.objectStoreNames).includes(name)) return [];
      return await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
        const req = db.transaction(name, 'readonly').objectStore(name).getAll();
        req.onsuccess = () => resolve(req.result as never);
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  }, store);
}

/** The `value` of one `meta` row (aiSettings, aiKey, aiBudget), undefined when there is none. */
export async function metaValue<T = Record<string, unknown>>(
  page: Page,
  key: string,
): Promise<T | undefined> {
  const row = (await readTable(page, 'meta')).find((r) => r.key === key);
  return row?.value as T | undefined;
}

/** Every chrome.storage area and the page's own web storage, as one string. */
export async function storageDump(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const out: Record<string, unknown> = {};
    for (const area of ['local', 'session', 'sync'] as const) {
      try {
        out[area] = await chrome.storage[area].get(null);
      } catch (e) {
        out[area] = `unreadable: ${String(e)}`;
      }
    }
    out.localStorage = { ...localStorage };
    out.sessionStorage = { ...sessionStorage };
    return JSON.stringify(out);
  });
}

/** Everything a person (or a screen reader) could get from the page: markup, text, field values. */
export async function pageContents(page: Page): Promise<string> {
  return page.evaluate(() => {
    const values = Array.from(document.querySelectorAll('input, textarea, select')).map(
      (e) => (e as HTMLInputElement).value,
    );
    return [document.documentElement.outerHTML, document.body.innerText, ...values].join('\n');
  });
}

// ---------------------------------------------------------------------------------------------
// Settings through the UI
// ---------------------------------------------------------------------------------------------

export const aiSwitch = (options: Page): Locator =>
  options.getByRole('checkbox', { name: 'Turn on AI features' });

/**
 * Patience for the first write of a fresh profile. The vault database is created on first use, and a
 * CI runner can stall its disk for tens of seconds (a first attempt was observed to leave the page on
 * "Loading decks…" for the whole default 10 s, and its retry took 40 s instead of 7). The wait is on
 * the real condition, so a healthy machine still passes in milliseconds.
 */
const COLD_WRITE_MS = 45_000;

/** Open one section of the settings page (only the current section is mounted), as its link does. */
export async function showSection(page: Page, id: string): Promise<void> {
  if (new URL(page.url()).hash !== `#${id}`) {
    await page.evaluate((hash) => {
      window.location.hash = hash;
    }, id);
  }
  await expect(page.locator(`#${id}`)).toBeAttached();
}

/** The AI section of the settings page, with its switch on screen. */
export async function showAiSection(options: Page): Promise<void> {
  await showSection(options, 'ai');
  await expect(aiSwitch(options)).toBeVisible({ timeout: COLD_WRITE_MS });
}

/** What a stalled first write looks like from the page: Web Locks, databases, pending texts. */
async function stallReport(options: Page): Promise<string> {
  return options.evaluate(async () => {
    const out: Record<string, unknown> = {};
    try {
      out.locks = await navigator.locks.query();
    } catch (e) {
      out.locks = String(e);
    }
    try {
      out.databases = await indexedDB.databases();
    } catch (e) {
      out.databases = String(e);
    }
    out.pendingText = Array.from(document.querySelectorAll('main p, main span'))
      .map((el) => (el.textContent ?? '').trim())
      .filter((t) => /^(Loading|Checking Chrome|Reading )/.test(t));
    out.settings = (await chrome.storage.local.get('settings')).settings ?? null;
    return JSON.stringify(out, null, 2);
  });
}

/** The settings page has finished its first loads (database open, worker answered). */
async function pageLoaded(options: Page): Promise<void> {
  await expect(options.getByText(/^(Loading|Checking Chrome|Reading )/)).toHaveCount(0, {
    timeout: COLD_WRITE_MS,
  });
}

/** What the switch guards once it is on: the setup wizard, or the status card of an earlier setup. */
const aiSetupOrStatus = (options: Page): Locator =>
  options.getByTestId('ai-setup').or(options.getByTestId('ai-status'));

export async function enableAi(options: Page): Promise<void> {
  await showAiSection(options);
  // Not while the page is still starting its own reads: the write would queue behind them (and the
  // click is the first thing to touch the database on a fresh profile).
  await pageLoaded(options);
  await aiSwitch(options).click();
  try {
    // The real condition: the switch is checked AND the section it guards has appeared.
    await expect(aiSwitch(options)).toBeChecked({ timeout: COLD_WRITE_MS });
    await expect(aiSetupOrStatus(options)).toBeVisible({ timeout: COLD_WRITE_MS });
    await expect
      .poll(
        async () => ((await storedSettings(options))?.features as { ai?: boolean } | undefined)?.ai,
        { timeout: COLD_WRITE_MS },
      )
      .toBe(true);
  } catch (error) {
    await test.info().attach('ai-switch-stall.json', {
      body: await stallReport(options).catch((e: unknown) => String(e)),
      contentType: 'application/json',
    });
    throw error;
  }
}

/** Open the closed "Advanced" part under the status card (key, access, limits, providers, ledger). */
export async function openAdvanced(options: Page): Promise<Locator> {
  const advanced = options.getByTestId('ai-advanced');
  await expect(advanced).toBeVisible({ timeout: COLD_WRITE_MS });
  if (!(await advanced.evaluate((d) => (d as HTMLDetailsElement).open))) {
    await advanced.locator(':scope > summary').click();
  }
  await expect(advanced).toHaveJSProperty('open', true);
  return advanced;
}

/** Pick a picture card the way a person does: click the card (its radio is visually hidden). */
export async function pickCard(page: Page, testId: string): Promise<void> {
  const radio = page.getByTestId(testId);
  await page.locator('label').filter({ has: radio }).click();
  await expect(radio).toBeChecked();
}

/** A step title of the setup wizard. */
export const setupStep = (options: Page, name: string | RegExp): Locator =>
  options.getByTestId('ai-setup').getByRole('heading', { level: 3, name });

/**
 * Point the AI settings at `baseUrl` and `model` through the setup wizard ("Edit setup" when it was
 * set up before): provider card, address and model, the key step when the wizard asks for one (not
 * for a local address), the daily limit, then "Save". Never "Save and test": configuring sends nothing.
 */
export async function configureProvider(
  options: Page,
  cfg: { baseUrl: string; model?: string; key?: string; preset?: 'custom' | 'anthropic' },
): Promise<void> {
  const status = options.getByTestId('ai-status');
  const setup = options.getByTestId('ai-setup');
  const next = setup.getByTestId('ai-setup-next');
  await expect(aiSetupOrStatus(options)).toBeVisible({ timeout: COLD_WRITE_MS });
  if (await status.isVisible()) await options.getByTestId('ai-edit-setup').click();

  await expect(setupStep(options, 'Pick a provider')).toBeVisible();
  await pickCard(options, `ai-preset-${cfg.preset ?? 'custom'}`);
  await next.click();
  await expect(setupStep(options, 'Address and model')).toBeVisible();
  await options.getByTestId('ai-base-url').fill(cfg.baseUrl);
  await options.getByTestId('ai-model').fill(cfg.model ?? MODEL);
  await next.click();
  await expect(setupStep(options, /^(API key|Daily limit)$/)).toBeVisible();
  if (await setupStep(options, 'API key').isVisible()) {
    if (!cfg.key) throw new Error(`the setup asks for an API key for ${cfg.baseUrl}`);
    await options.getByTestId('ai-key-input').fill(cfg.key);
    await next.click();
  }
  await expect(setupStep(options, 'Daily limit')).toBeVisible();
  await next.click();
  await expect(setupStep(options, 'Save and test')).toBeVisible();
  await setup.getByTestId('ai-setup-save').click();

  await expect
    .poll(async () => (await metaValue<{ baseUrl?: string }>(options, 'aiSettings'))?.baseUrl, {
      timeout: COLD_WRITE_MS,
    })
    .toBe(cfg.baseUrl);
  // Saved: the wizard gives way to the status card.
  await expect(status).toBeVisible();
  await expect(setup).toHaveCount(0);
}

/** Save `key` with the key field under "Advanced"; the status card shows its mask. */
export async function saveKey(options: Page, key: string): Promise<void> {
  await openAdvanced(options);
  await options.getByTestId('ai-key-input').fill(key);
  await options.getByTestId('ai-key-save').click();
  await expect(options.getByTestId('ai-key-mask')).toHaveText(maskOf(key), {
    timeout: COLD_WRITE_MS,
  });
  await expect(options.getByTestId('ai-key-input')).toHaveValue('');
}

/** Switch on, set the address and the model, save the key. Sends nothing. */
export async function setUpAi(
  options: Page,
  provider: Pick<FakeProvider, 'baseUrl'>,
  key: string | null = FAKE_KEY,
): Promise<void> {
  await enableAi(options);
  await configureProvider(options, { baseUrl: provider.baseUrl });
  if (key !== null) await saveKey(options, key);
}

/**
 * Make a plain backup through the Backup section (in a settings tab of its own, so the page under
 * test keeps its section), bring `back` to the front again and return the archive as one text.
 */
export async function backupText(env: Env, back: Page): Promise<string> {
  const page = await openExt(env, 'options');
  await showSection(page, 'backup');
  // "Back up" is the default task, and its first step ("Lock it?") defaults to no passphrase.
  await page.getByTestId('backup-export-flow-next').click();
  const download = page.waitForEvent('download');
  await page.getByTestId('backup-export-start').click();
  const file = await (await download).path();
  await page.close();
  await back.bringToFront();
  return Object.values(unzipSync(new Uint8Array(fs.readFileSync(file))))
    .map((bytes) => strFromU8(bytes))
    .join('\n');
}

// ---------------------------------------------------------------------------------------------
// A saved highlight, the side panel, the consent dialog
// ---------------------------------------------------------------------------------------------

/** Open the AI fixture page and save the paragraph at `selector` through the real toolbar. */
export async function saveHighlight(
  env: Env,
  options: Page,
  selector: string,
): Promise<{ page: Page; highlight: HighlightRow }> {
  const page = await openFixture(env, '/ai-source.html');
  await saveBlock(options, page, selector);
  const rows = await highlightsOf(options, page.url());
  const highlight = rows[rows.length - 1];
  if (!highlight) throw new Error('the highlight was not saved');
  return { page, highlight };
}

/** The side panel showing `page`, with its highlight list loaded. */
export async function openSide(env: Env, page: Page): Promise<Page> {
  // ponytail: the steps of helpers.pages `viewing`, whose wait still names the old "cannot run"
  // copy in this tree; go back to `viewing` once that helper waits for "Can't run here".
  const side = await openExt(env, 'sidepanel');
  // The panel's own first answer (its tab is an extension page) before the tab switch, so the
  // switch event cannot land before its listener exists.
  await expect(side.getByRole('heading', { name: "Can't run here" })).toBeVisible();
  await page.bringToFront();
  await activeTabId(side);
  await waitForPageList(side);
  return side;
}

export const cardOf = (side: Page, highlightId: string): Locator =>
  side.locator(`article[data-highlight-id="${highlightId}"]`);

/** Open a card's "More actions" drawer (tags, notes, links, AI drafts, Delete); returns the card. */
export async function openDrawer(side: Page, highlightId: string): Promise<Locator> {
  const card = cardOf(side, highlightId);
  const more = card.getByTestId('card-more');
  if ((await more.getAttribute('aria-expanded')) !== 'true') await more.click();
  await expect(card.getByTestId('card-drawer')).toBeVisible();
  return card;
}

/** Reveal the AI actions of a card and open the consent dialog for `kind`; waits for the preview. */
export async function openConsent(
  side: Page,
  highlightId: string,
  kind: string = 'exam_pearl',
): Promise<Locator> {
  const card = await openDrawer(side, highlightId);
  const toggle = card.getByTestId('card-ai-toggle');
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await card.getByTestId(`ai-action-${kind}`).click();
  const dialog = card.getByTestId('ai-consent-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('ai-outbound')).toBeVisible();
  return dialog;
}

/** The text the dialog shows as "exactly what will be sent". */
export const outboundOf = (dialog: Locator): Promise<string> =>
  dialog.getByTestId('ai-outbound').evaluate((el) => el.textContent ?? '');

/** The same text, rebuilt from a request body: what the person was shown is what was sent. */
export function renderOutbound(messages: readonly ChatMessage[]): string {
  return messages.map((m) => `[${m.role}]\n${m.content}`).join('\n\n');
}

// ---------------------------------------------------------------------------------------------
// Accessibility (WCAG 2.2 AA, the same tags as the other specs)
// ---------------------------------------------------------------------------------------------

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];

/**
 * axe violations under `include` (a CSS selector) or the whole page, as readable text ('' = none).
 *
 * Legacy mode on purpose: the default mode finishes its run in a temporary NEW TAB, which becomes the
 * active tab for a moment. The side panel follows the active tab, so it would drop the highlight (and
 * the open consent dialog) it is showing. Legacy mode runs axe in the page itself; the only thing it
 * gives up is cross-origin iframes, and these pages have none.
 */
export async function axeReport(page: Page, include?: string): Promise<string> {
  await settleAnimations(page);
  let builder = new AxeBuilder({ page }).withTags(WCAG_TAGS).setLegacyMode(true);
  if (include) builder = builder.include(include);
  const { violations } = await builder.analyze();
  return violations
    .map(
      (v) =>
        `[${v.impact}] ${v.id}: ${v.help}\n` +
        v.nodes
          .slice(0, 4)
          .map((n) => `   ${JSON.stringify(n.target)} ${n.html.slice(0, 160)}`)
          .join('\n'),
    )
    .join('\n');
}
