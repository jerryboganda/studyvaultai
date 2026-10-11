import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import type { Locator, Page } from '@playwright/test';
import { KIND_LABELS } from '@shared';
import { dragSelect, setBrowserZoom } from './helpers.compat';
import {
  OVERLAY_HOST,
  activate,
  expect,
  highlightsOf,
  openExt,
  openFixture,
  pageLuminance,
  patchSettings,
  publishedRangeCount,
  saveBlock,
  test,
  toolbarOf,
  tripleClickBlock,
  viewing,
  waitForPageList,
  type Env,
} from './helpers.pages';

/**
 * Real-browser screenshots for the release review (ROADMAP Phase 7, STORE_LISTING.md "Screenshots").
 *
 * Every picture is taken from the REAL built extension in real Chromium, through the same helpers
 * the functional specs use, and saved to test-results/screenshots/<name>.png with a manifest.json
 * (what each shows, size, colour variety, sha256). CI uploads the folder as an artifact.
 *
 * This is a normal spec: it fails when a surface is not what it claims to be.
 *  - the tab must not be a browser error page, StudyVault's crash screen or an error notice;
 *  - the PNG must be a valid image with real content (not blank): size floor plus colour variety,
 *    decoded here so a uniformly dark or white render cannot pass for "non-empty".
 * It deliberately asserts little else: layout and behaviour belong to the functional specs.
 */

const OUT_DIR = path.resolve('test-results', 'screenshots');
const MANIFEST_PATH = path.join(OUT_DIR, 'manifest.json');

/** 1280x800 is a Chrome Web Store screenshot size, so page shots can be used as they are. */
const DESKTOP = { width: 1280, height: 800 };
/** Typical Chrome side panel width. */
const PANEL = { width: 400, height: 760 };
/** The action popup is a 360 px column. */
const POPUP = { width: 360, height: 640 };
const NOTE_BUTTON = 'Save and add a note in the side panel';

const MIN_BYTES = 1_500;
const MIN_COLOURS = 8;

/**
 * Copy that identifies each popup state: the same strings tests/e2e/pages.spec.ts and a11y.spec.ts
 * assert, each known to match exactly one element. One place to edit when the wording changes.
 */
const POPUP_STATE = {
  unsupported: 'StudyVault cannot run on this page',
  inactive: 'StudyVault is not running on this tab',
  active: 'Active on this tab only',
  denied: 'StudyVault is off on localhost',
};

/** What an error page or a failure notice looks like in rendered text. */
const FAILURE_TEXT =
  /ERR_[A-Z_]{4,}|This (?:site|page) can.t be reached|isn.t working|^Not found: \/|\bcould not (?:show|check|read|load|open|save|update|create)\b/im;

// ---------------------------------------------------------------------------------------------
// PNG inspection (8-bit RGB / RGBA, non-interlaced: what Chromium writes)
// ---------------------------------------------------------------------------------------------

const PNG_SIGNATURE = '89504e470d0a1a0a';

/** Dimensions and the number of distinct colours (capped at 64); colours is -1 when not decodable. */
function inspectPng(png: Buffer): { width: number; height: number; colours: number } {
  let width = 0;
  let height = 0;
  let bytesPerPixel = 0;
  const idat: Buffer[] = [];
  for (let pos = 8; pos + 12 <= png.length;) {
    const length = png.readUInt32BE(pos);
    const type = png.toString('latin1', pos + 4, pos + 8);
    const data = png.subarray(pos + 8, pos + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] === 8 && data[12] === 0) {
        bytesPerPixel = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 0;
      }
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    pos += 12 + length;
  }
  if (bytesPerPixel === 0) return { width, height, colours: -1 };
  try {
    const raw = inflateSync(Buffer.concat(idat));
    const stride = width * bytesPerPixel;
    const seen = new Set<number>();
    let previous = Buffer.alloc(stride);
    for (let y = 0; y < height && seen.size < 64; y++) {
      const filter = raw[y * (stride + 1)];
      const row = Buffer.alloc(stride);
      for (let i = 0; i < stride; i++) {
        const left = i >= bytesPerPixel ? row[i - bytesPerPixel]! : 0;
        const up = previous[i]!;
        const upLeft = i >= bytesPerPixel ? previous[i - bytesPerPixel]! : 0;
        let value = raw[y * (stride + 1) + 1 + i]!;
        if (filter === 1) value += left;
        else if (filter === 2) value += up;
        else if (filter === 3) value += (left + up) >> 1;
        else if (filter === 4) {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
        }
        row[i] = value & 255;
      }
      for (let x = 0; x < width && seen.size < 64; x++) {
        const o = x * bytesPerPixel;
        seen.add((row[o]! << 16) | (row[o + 1]! << 8) | row[o + 2]!);
      }
      previous = row;
    }
    return { width, height, colours: seen.size };
  } catch {
    return { width, height, colours: -1 };
  }
}

// ---------------------------------------------------------------------------------------------
// Capture + manifest
// ---------------------------------------------------------------------------------------------

interface ShotMeta {
  /** File name without extension; the leading number orders the review. */
  name: string;
  surface: string;
  /** What a reviewer should see in this picture. */
  description: string;
  scheme?: 'light' | 'dark';
  /** Browser zoom factor when not 1. */
  zoom?: number;
  /** Whole scrollable page instead of the viewport (Page targets only). */
  fullPage?: boolean;
}

interface ShotRecord extends Omit<ShotMeta, 'fullPage'> {
  file: string;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  colours: number;
  capturedAt: string;
}

interface ManifestFile {
  generatedAt: string;
  browser: string;
  platform: string;
  screenshots: ShotRecord[];
}

function readManifest(): ManifestFile | null {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as ManifestFile;
  } catch {
    return null;
  }
}

/** Read-merge-write, so a retry or a restarted worker never loses earlier entries. */
function record(entry: ShotRecord, browser: string): void {
  const others = (readManifest()?.screenshots ?? []).filter((s) => s.name !== entry.name);
  const manifest: ManifestFile = {
    generatedAt: new Date().toISOString(),
    browser,
    platform: process.platform,
    screenshots: [...others, entry].sort((a, b) => a.name.localeCompare(b.name)),
  };
  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
}

const isLocator = (target: Page | Locator): target is Locator =>
  typeof (target as Locator).page === 'function';

/** The tab is a real StudyVault / fixture surface, not an error page or a failure notice. */
async function expectRendered(page: Page, name: string): Promise<void> {
  expect(page.url(), `${name}: the tab is a browser error page`).not.toMatch(/^chrome-error:/);
  const probe = await page.evaluate(() => ({
    title: document.title,
    text: document.body?.innerText ?? '',
    crashed: document.querySelector('.sv-crash') !== null,
  }));
  expect(probe.crashed, `${name}: StudyVault's crash screen is showing`).toBe(false);
  expect(`${probe.title}\n${probe.text}`, `${name}: shows an error`).not.toMatch(FAILURE_TEXT);
}

/** Returns a `snap(target, meta)` function bound to this test's browser. */
function shooter(env: Env) {
  const browser = env.context.browser()?.version() ?? 'unknown';
  return async (target: Page | Locator, meta: ShotMeta): Promise<void> => {
    await expectRendered(isLocator(target) ? target.page() : target, meta.name);
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const file = `${meta.name}.png`;
    const options = {
      path: path.join(OUT_DIR, file),
      animations: 'disabled',
      caret: 'hide',
    } as const;
    const png = isLocator(target)
      ? await target.screenshot(options)
      : await target.screenshot({ ...options, fullPage: meta.fullPage === true });

    expect(png.subarray(0, 8).toString('hex'), `${meta.name}: not a PNG`).toBe(PNG_SIGNATURE);
    expect(png.length, `${meta.name}: screenshot is empty`).toBeGreaterThan(MIN_BYTES);
    const info = inspectPng(png);
    if (info.colours !== -1) {
      expect(info.colours, `${meta.name}: screenshot is blank`).toBeGreaterThanOrEqual(MIN_COLOURS);
    }
    const { fullPage: _fullPage, ...described } = meta;
    record(
      {
        ...described,
        file,
        width: info.width,
        height: info.height,
        bytes: png.length,
        sha256: createHash('sha256').update(png).digest('hex'),
        colours: info.colours,
        capturedAt: new Date().toISOString(),
      },
      browser,
    );
  };
}

const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[\d()]+/g, ' ')
    .replace(/[^a-z]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** Real browser zoom of an extension page (fixture pages use setBrowserZoom from helpers.compat). */
async function zoomExtensionPage(page: Page, factor: number): Promise<void> {
  await page.evaluate(async (zoom) => {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id === undefined) throw new Error('this page is not a tab');
    await chrome.tabs.setZoomSettings(tab.id, { mode: 'automatic', scope: 'per-tab' });
    await chrome.tabs.setZoom(tab.id, zoom);
  }, factor);
  await expect.poll(() => page.evaluate(() => window.devicePixelRatio)).toBeCloseTo(factor, 1);
}

const kindButton = (kind: keyof typeof KIND_LABELS) => `Save as ${KIND_LABELS[kind].label}`;

// ---------------------------------------------------------------------------------------------

test.describe('release screenshots (real loaded extension)', () => {
  test.describe.configure({ timeout: 120_000 });

  test('in-page toolbar: selection, caption, details panel, saved highlight', async ({ env }) => {
    const snap = shooter(env);
    const page = await openFixture(env, '/article.html');
    await page.setViewportSize(DESKTOP);

    await tripleClickBlock(page, '#p-intro');
    await expect(toolbarOf(page)).toBeVisible();
    await snap(page, {
      name: '01-toolbar-over-article',
      surface: 'in-page toolbar',
      description: 'Floating toolbar above a selected paragraph of a fixture article.',
    });

    await page.getByRole('button', { name: kindButton('formula'), exact: true }).hover();
    await expect(page.locator(`${OVERLAY_HOST} .sv-caption`)).toHaveText(kindButton('formula'));
    await snap(page, {
      name: '02-toolbar-caption',
      surface: 'in-page toolbar',
      description: 'Hovering a kind button shows its full name as a caption.',
    });

    const more = page.getByRole('button', { name: 'More options', exact: true });
    await more.click();
    const details = page.getByRole('dialog', { name: 'Save with details' });
    await expect(details).toBeVisible();
    await snap(page, {
      name: '03-save-with-details',
      surface: 'in-page toolbar',
      description: 'The "Save with details" panel: pickers only, no text field in the page.',
    });
    await more.click();
    await expect(details).toHaveCount(0);

    await page.getByRole('button', { name: 'Save selection', exact: true }).click();
    await expect(page.getByText('Saved to Inbox')).toBeVisible();
    await expect.poll(() => publishedRangeCount(page)).toBeGreaterThan(0);
    await snap(page, {
      name: '04-saved-toast-and-highlight',
      surface: 'in-page toolbar',
      description: 'The saved passage is painted on the page and the toast offers Undo.',
    });
  });

  test('note hand-over: "Save and add a note" lands the cursor in the side panel', async ({
    env,
  }) => {
    const snap = shooter(env);
    const ext = await openExt(env, 'options');
    const page = await openFixture(env, '/article.html');
    const side = await viewing(env, 'sidepanel', page);
    await side.setViewportSize(PANEL);

    await tripleClickBlock(page, '#p-intro');
    await expect(toolbarOf(page)).toBeVisible();
    await page.getByRole('button', { name: NOTE_BUTTON }).click();
    await expect.poll(async () => (await highlightsOf(ext, page.url())).length).toBe(1);

    // The panel scrolled to the new card and put the cursor in its note field.
    await expect(side.locator('textarea:focus')).toHaveCount(1);
    await snap(side, {
      name: '05-note-handover-side-panel',
      surface: 'side panel',
      description:
        'Side panel after the note hand-over: the new highlight card, note field focused.',
    });
  });

  test('side panel: every tab with highlights saved', async ({ env }) => {
    const snap = shooter(env);
    const ext = await openExt(env, 'options');
    const page = await openFixture(env, '/article.html');
    await saveBlock(ext, page, '#p-intro', kindButton('formula'));
    await saveBlock(ext, page, '#p-multiline', kindButton('question'));
    await saveBlock(ext, page, '#p-refs', kindButton('exception'));

    const side = await viewing(env, 'sidepanel', page);
    await side.setViewportSize(PANEL);
    await waitForPageList(side);

    const tabs = side.getByRole('tablist').first().getByRole('tab');
    const count = await tabs.count();
    expect(count, 'the side panel offers tabs').toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const label = (await tabs.nth(i).innerText()).trim();
      await tabs.nth(i).click();
      await expect(tabs.nth(i)).toHaveAttribute('aria-selected', 'true');
      await expect(side.getByRole('tabpanel')).toBeVisible();
      await snap(side, {
        name: `06-sidepanel-tab-${i + 1}-${slug(label) || 'tab'}`,
        surface: 'side panel',
        description: `Side panel, tab "${label}", with three highlights saved from the fixture article.`,
      });
    }
  });

  test('popup: unsupported, not running, running and denied states', async ({ env }) => {
    const snap = shooter(env);
    const ext = await openExt(env, 'options');

    // 1. Unsupported: the popup opened as a tab is its own active tab (an extension page).
    const own = await openExt(env, 'popup');
    await own.setViewportSize(POPUP);
    await expect(own.getByText(POPUP_STATE.unsupported)).toBeVisible();
    await snap(own, {
      name: '07-popup-unsupported',
      surface: 'popup',
      description: 'Popup on a page extensions cannot run on: says why and offers the side panel.',
    });
    await own.close();

    // 2. A normal page StudyVault is not running on yet.
    const page = await openFixture(env, '/article.html', { activate: false });
    const inactive = await viewing(env, 'popup', page);
    await inactive.setViewportSize(POPUP);
    await expect(inactive.getByText(POPUP_STATE.inactive)).toBeVisible();
    await snap(inactive, {
      name: '08-popup-not-running',
      surface: 'popup',
      description: 'Popup on a normal page before activation: explains the one-click activation.',
    });
    await inactive.close();

    // 3. Running, with recent saves.
    await activate(env, page);
    await saveBlock(ext, page, '#p-intro', kindButton('formula'));
    const running = await viewing(env, 'popup', page);
    await running.setViewportSize(POPUP);
    await expect(running.getByText(POPUP_STATE.active)).toBeVisible();
    await snap(running, {
      name: '09-popup-running',
      surface: 'popup',
      description: 'Popup on an active page: highlight count, recent saves, last-used bank.',
    });
    await running.close();

    // 4. A host on the deny list (localhost is the fixture server's second origin).
    await patchSettings(ext, { denyList: ['localhost'] });
    const deniedPage = await openFixture(env, '/article.html', {
      activate: false,
      origin: env.altOrigin,
    });
    const denied = await viewing(env, 'popup', deniedPage);
    await denied.setViewportSize(POPUP);
    await expect(denied.getByText(POPUP_STATE.denied)).toBeVisible();
    await snap(denied, {
      name: '10-popup-denied-site',
      surface: 'popup',
      description: 'Popup on a deny-listed site: StudyVault is off there and says how to allow it.',
    });
  });

  test('settings page: every section', async ({ env }) => {
    const snap = shooter(env);
    const options = await openExt(env, 'options');
    await options.setViewportSize(DESKTOP);
    await expect(options.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(options.getByText('Loading settings')).toHaveCount(0);

    const ids = await options
      .locator('nav a[href^="#"]')
      .evaluateAll((links) =>
        links.map((a) => (a.getAttribute('href') ?? '').slice(1)).filter((id) => id !== ''),
      );
    expect(ids.length, 'the settings page lists its sections').toBeGreaterThan(0);
    for (const id of ids) {
      const section = options.locator(`[id="${id}"]`);
      await expect(section).toBeVisible();
      await snap(section, {
        name: `11-options-${slug(id) || 'section'}`,
        surface: 'settings',
        description: `Settings section "${id}".`,
      });
    }
    await snap(options, {
      name: '12-options-full-page',
      surface: 'settings',
      description: 'The whole settings page, top to bottom.',
      fullPage: true,
    });
  });

  test('dark mode: toolbar, side panel, popup and settings', async ({ env }) => {
    const snap = shooter(env);
    const page = await openFixture(env, '/article.html');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.setViewportSize(DESKTOP);
    await tripleClickBlock(page, '#p-intro');
    await expect(toolbarOf(page)).toBeVisible();
    await snap(page, {
      name: '13-dark-toolbar',
      surface: 'in-page toolbar',
      description: 'Toolbar with prefers-color-scheme: dark.',
      scheme: 'dark',
    });
    await page.getByRole('button', { name: 'Save selection', exact: true }).click();
    await expect(page.getByText('Saved to Inbox')).toBeVisible();

    const side = await viewing(env, 'sidepanel', page);
    await side.emulateMedia({ colorScheme: 'dark' });
    await side.setViewportSize(PANEL);
    await waitForPageList(side);
    await expect.poll(() => pageLuminance(side)).toBeLessThan(0.3);
    await snap(side, {
      name: '14-dark-side-panel',
      surface: 'side panel',
      description: 'Side panel in dark mode with one saved highlight.',
      scheme: 'dark',
    });

    const popup = await viewing(env, 'popup', page);
    await popup.emulateMedia({ colorScheme: 'dark' });
    await popup.setViewportSize(POPUP);
    await expect.poll(() => pageLuminance(popup)).toBeLessThan(0.3);
    await snap(popup, {
      name: '15-dark-popup',
      surface: 'popup',
      description: 'Popup in dark mode on an active page.',
      scheme: 'dark',
    });

    const options = await openExt(env, 'options');
    await options.emulateMedia({ colorScheme: 'dark' });
    await options.setViewportSize(DESKTOP);
    await expect(options.getByText('Loading settings')).toHaveCount(0);
    await expect.poll(() => pageLuminance(options)).toBeLessThan(0.3);
    await snap(options, {
      name: '16-dark-options',
      surface: 'settings',
      description: 'Settings page in dark mode.',
      scheme: 'dark',
      fullPage: true,
    });
  });

  test('narrow and zoomed layouts: 320 px panel and settings, 200% panel and toolbar', async ({
    env,
  }) => {
    const snap = shooter(env);
    const ext = await openExt(env, 'options');
    const page = await openFixture(env, '/article.html');
    await saveBlock(ext, page, '#p-intro', kindButton('formula'));
    await saveBlock(ext, page, '#p-refs', kindButton('exception'));

    const side = await viewing(env, 'sidepanel', page);
    await side.setViewportSize({ width: 320, height: 700 });
    await expect.poll(() => side.evaluate(() => window.innerWidth)).toBe(320);
    await waitForPageList(side);
    await snap(side, {
      name: '17-side-panel-320px',
      surface: 'side panel',
      description: 'Side panel at the 320 px minimum width (WCAG 1.4.10 reflow).',
    });

    // Real browser zoom: 320 -> 160 CSS px wide. Taken before any other tab opens, so the panel
    // keeps following the fixture page as its active tab.
    await zoomExtensionPage(side, 2);
    await expect.poll(() => side.evaluate(() => window.innerWidth)).toBe(160);
    await snap(side, {
      name: '18-side-panel-200pct',
      surface: 'side panel',
      description: 'Side panel at 200% browser zoom on a 320 px wide panel.',
      zoom: 2,
    });

    const options = await openExt(env, 'options');
    await options.setViewportSize({ width: 320, height: 700 });
    await expect(options.getByText('Loading settings')).toHaveCount(0);
    await snap(options, {
      name: '19-options-320px',
      surface: 'settings',
      description: 'Settings page at 320 px wide.',
      fullPage: true,
    });

    await page.bringToFront();
    await page.setViewportSize({ width: 1280, height: 720 });
    await setBrowserZoom(env, page, 2);
    await dragSelect(page, {
      selector: '#p-multiline',
      text: 'pauses at the atrioventricular node, and then travels rapidly',
    });
    await expect(toolbarOf(page)).toBeVisible();
    await snap(page, {
      name: '20-toolbar-200pct',
      surface: 'in-page toolbar',
      description: 'Toolbar over a selection at 200% browser zoom on a 1280 px window.',
      zoom: 2,
    });
  });

  test('the manifest lists exactly the screenshots on disk', async () => {
    const manifest = readManifest();
    if (manifest === null) {
      test.skip(true, 'no screenshots were captured in this run (filtered run?)');
      return;
    }
    expect(manifest.screenshots.length).toBeGreaterThan(0);
    for (const shot of manifest.screenshots) {
      const bytes = fs.readFileSync(path.join(OUT_DIR, shot.file));
      expect(bytes.length, `${shot.file} size`).toBe(shot.bytes);
      expect(createHash('sha256').update(bytes).digest('hex'), `${shot.file} sha256`).toBe(
        shot.sha256,
      );
    }
    const listed = new Set(manifest.screenshots.map((s) => s.file));
    const stray = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.png') && !listed.has(f));
    expect(stray, 'PNG files that are not in manifest.json').toEqual([]);
  });
});
