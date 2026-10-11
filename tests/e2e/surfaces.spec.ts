import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { SETTINGS_SECTIONS } from '@ui/shell/paths';
import { describeCommand } from '@ui/shortcuts';
import { proseDoc } from '../fixtures/pdf/docs';
import { startPdfServer, type PdfServer } from '../fixtures/pdf/server';
import {
  expect,
  layoutReport,
  openExt,
  openFixture,
  patchSettings,
  storedSettings,
  test,
  viewing,
  type Env,
} from './helpers.pages';

/**
 * The surfaces that tie the finished modules together: the settings page (section list, review,
 * AI, sync, backup, storage), the popup's study bar and PDF reader button, and the welcome tour.
 * Real Chromium with the real built extension; nothing is mocked. The native permission prompt
 * cannot be driven, and nothing here needs it: the tour requests nothing, and the e2e build holds
 * loopback host permissions for the PDF address.
 */

// Axe over the whole settings page and several tabs open at once are slow on a shared runner.
test.describe.configure({ timeout: 300_000 });

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** Console errors and uncaught exceptions of a page opened by `extPage`. */
const ERRORS = new WeakMap<Page, string[]>();
const problemsOf = (page: Page): string[] => ERRORS.get(page) ?? [];

async function extPage(env: Env, file: string): Promise<Page> {
  const page = await env.context.newPage();
  const problems: string[] = [];
  ERRORS.set(page, problems);
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console.error: ${m.text()}`);
  });
  await page.goto(`chrome-extension://${env.extensionId}/${file}`);
  return page;
}

async function violationsOf(page: Page, include?: string): Promise<string> {
  let builder = new AxeBuilder({ page }).withTags(WCAG_TAGS);
  if (include) builder = builder.include(include);
  const { violations } = await builder.analyze();
  return violations
    .map(
      (v) =>
        `[${v.impact}] ${v.id}: ${v.help}\n` +
        v.nodes
          .slice(0, 3)
          .map((n) => `   ${JSON.stringify(n.target)} ${n.html.slice(0, 140)}`)
          .join('\n'),
    )
    .join('\n');
}

/** Rows of one table of the vault database, read-only from any extension page. */
async function readTable(page: Page, store: string): Promise<Array<Record<string, unknown>>> {
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

const live = (rows: Array<Record<string, unknown>>) => rows.filter((r) => r.deletedAt === null);

async function setZoom(page: Page, factor: number): Promise<void> {
  const zoomed = await page.evaluate(async (f) => {
    const tab = await chrome.tabs.getCurrent();
    await chrome.tabs.setZoom(tab?.id ?? 0, f);
    return chrome.tabs.getZoom(tab?.id ?? 0);
  }, factor);
  expect(zoomed).toBe(factor);
}

// =============================================================================================
// SETTINGS PAGE
// =============================================================================================

test.describe('options: section list', () => {
  test('is a landmark with deep links, one tab stop, arrow/Home/End keys and keyboard activation', async ({
    env,
  }) => {
    const page = await openExt(env, 'options');
    const nav = page.getByRole('navigation', { name: 'Settings sections' });
    await expect(nav).toBeVisible();
    const links = nav.getByRole('link');
    await expect(links).toHaveText(SETTINGS_SECTIONS.map((s) => s.label));
    // The deep-link ids are a contract with the tour, the docs and other pages.
    await expect(links).toHaveCount(11);
    for (const { id } of SETTINGS_SECTIONS) {
      await expect(nav.locator(`a[href="#${id}"]`)).toHaveCount(1);
      const target = page.locator(`[id="${id}"]`);
      await expect(target).toHaveCount(1);
      await expect(target.getByRole('heading', { level: 2 }).first()).toBeVisible();
    }

    // One tab stop; the arrows move it and focus together.
    const stops = nav.locator('a[tabindex="0"]');
    await expect(stops).toHaveCount(1);
    await links.first().focus();
    await page.keyboard.press('ArrowDown');
    await expect(links.nth(1)).toBeFocused();
    await expect(links.nth(1)).toHaveAttribute('tabindex', '0');
    await expect(links.first()).toHaveAttribute('tabindex', '-1');
    await page.keyboard.press('End');
    await expect(links.last()).toBeFocused();
    await page.keyboard.press('Home');
    await expect(links.first()).toBeFocused();
    await page.keyboard.press('ArrowUp'); // wraps
    await expect(links.last()).toBeFocused();

    // Enter follows the link: the address and the current-location mark follow it.
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/options\.html#data$/);
    await expect(links.last()).toHaveAttribute('aria-current', 'location');
    await expect(page.locator('#data').getByRole('heading', { level: 2 })).toBeInViewport();

    // Tab leaves the list after its one stop (it does not walk through 11 links).
    await links.first().focus();
    await page.keyboard.press('Tab');
    await expect(nav.locator(':focus')).toHaveCount(0);
    expect(problemsOf(page)).toEqual([]);
  });

  test('a section address opens scrolled to that section, even though sections load after settings', async ({
    env,
  }) => {
    const page = await extPage(env, 'options.html#storage');
    await expect(page.locator('#storage').getByRole('heading', { level: 2 })).toBeInViewport();
    await expect(
      page.getByRole('navigation', { name: 'Settings sections' }).locator('a[href="#storage"]'),
    ).toHaveAttribute('aria-current', 'location');
    // An unknown hash is ignored: no error, the page simply opens at the top.
    const other = await extPage(env, 'options.html#not-a-section');
    await expect(other.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(other.locator('#site-access')).toBeVisible();
    expect(await other.evaluate(() => window.scrollY)).toBe(0);
  });
});

test.describe('options: sections explain themselves and honour their flags', () => {
  test('AI and sync show their consent explanation first and make no request until enabled', async ({
    env,
  }) => {
    const external: string[] = [];
    env.context.on('request', (r) => {
      if (!/^(chrome-extension|data|blob|about):/.test(r.url())) external.push(r.url());
    });
    const permissionsBefore = await (
      await extPage(env, 'options.html')
    ).evaluate(() => chrome.permissions.getAll());
    const page = await openExt(env, 'options');
    const ai = page.locator('#ai');
    await expect(ai.getByRole('heading', { name: /AI assistance/ })).toBeVisible();
    await expect(ai).toContainText('While this is off, StudyVault sends nothing anywhere');
    await expect(ai.getByRole('checkbox', { name: 'Turn on AI features' })).not.toBeChecked();
    await expect(ai.getByLabel('Provider address')).toHaveCount(0);

    const sync = page.locator('#sync');
    await expect(sync.getByRole('heading', { name: /Sync between devices/ })).toBeVisible();
    await expect(sync.getByTestId('sync-explanation')).toContainText(
      'There is no StudyVault server',
    );
    await expect(sync.getByTestId('sync-explanation')).toContainText('off by default');
    await expect(sync.getByRole('button', { name: /Turn on sync/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await expect(sync.getByRole('button', { name: /Sign in/ })).toHaveCount(0);

    // Let everything on the page settle, then: nothing left the browser, nothing was granted.
    await page.waitForTimeout(1500);
    expect(external, 'no network request from the settings page').toEqual([]);
    // Nothing may have switched a feature on (nothing stored yet means the defaults: both off).
    const settings = await storedSettings(page);
    const features = (settings?.features ?? {}) as { ai?: boolean; sync?: boolean };
    expect(features.ai ?? false).toBe(false);
    expect(features.sync ?? false).toBe(false);
    const after = await page.evaluate(() => chrome.permissions.getAll());
    expect(after.permissions?.sort()).toEqual(permissionsBefore.permissions?.sort());
    expect(after.origins?.sort()).toEqual(permissionsBefore.origins?.sort());
    expect(problemsOf(page)).toEqual([]);
  });

  test('turning AI on shows the provider setup and still sends nothing', async ({ env }) => {
    const external: string[] = [];
    env.context.on('request', (r) => {
      if (!/^(chrome-extension|data|blob|about):/.test(r.url())) external.push(r.url());
    });
    const page = await openExt(env, 'options');
    await page.getByRole('checkbox', { name: 'Turn on AI features' }).click();
    await expect(page.getByLabel('Provider address')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Test connection' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await expect
      .poll(async () => (await storedSettings(page))?.features)
      .toMatchObject({
        ai: true,
        sync: false,
      });
    await page.waitForTimeout(1000);
    expect(external).toEqual([]);
  });

  test('review: the switch hides the study settings and the popup count, and back', async ({
    env,
  }) => {
    const ext = await openExt(env, 'options');
    await expect(ext.getByRole('heading', { name: 'Review and study day' })).toBeVisible();
    await expect(ext.getByRole('button', { name: 'Open review' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );

    const toggle = ext.getByRole('checkbox', { name: 'Show review in StudyVault' });
    await toggle.click();
    await expect
      .poll(async () => (await storedSettings(ext))?.features)
      .toMatchObject({
        review: false,
      });
    await expect(ext.getByRole('heading', { name: 'Review and study day' })).toHaveCount(0);
    await expect(ext.getByRole('button', { name: 'Open review' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );

    // The popup follows without a reload: no count, no review button, dashboard still offered.
    const page = await openFixture(env, '/article.html', { activate: false });
    const popup = await viewing(env, 'popup', page);
    await expect(popup.getByRole('button', { name: 'Open dashboard' })).toBeVisible();
    await expect(popup.getByTestId('popup-due')).toHaveCount(0);
    await expect(popup.getByTestId('popup-review')).toHaveCount(0);

    await ext.bringToFront();
    await toggle.click();
    await expect(popup.getByTestId('popup-due')).toBeVisible();
  });

  test('density and the PDF reader switch persist across a reload', async ({ env }) => {
    const ext = await openExt(env, 'options');
    await ext.getByRole('radio', { name: /^Compact/ }).click();
    await ext.getByRole('checkbox', { name: 'Use the StudyVault PDF reader' }).click();
    await expect
      .poll(async () => storedSettings(ext))
      .toMatchObject({
        density: 'compact',
        features: { pdfReader: false },
      });
    await ext.reload();
    await expect(ext.getByRole('radio', { name: /^Compact/ })).toBeChecked();
    await expect(
      ext.getByRole('checkbox', { name: 'Use the StudyVault PDF reader' }),
    ).not.toBeChecked();
  });

  test('delete-all lives under Your data and Privacy lists the optional permissions', async ({
    env,
  }) => {
    const ext = await openExt(env, 'options');
    await expect(
      ext.locator('#data').getByRole('button', { name: /^Delete all StudyVault data/ }),
    ).toBeVisible();
    await expect(
      ext.locator('#privacy').getByRole('button', { name: /^Delete all StudyVault data/ }),
    ).toHaveCount(0);
    const privacy = ext.locator('#privacy');
    await expect(privacy.getByText('identity', { exact: true })).toBeVisible();
    await expect(privacy.getByText('alarms', { exact: true })).toBeVisible();
    await expect(privacy).toContainText('Everything stays on this device by default');
  });
});

test.describe('options: storage', () => {
  test('shows counts from the real database and removes a stored PDF copy kept in the reader', async ({
    env,
  }) => {
    const ext = await openExt(env, 'options');
    const section = ext.locator('#storage');
    await expect(section.getByTestId('no-cached-pdfs')).toBeVisible();
    await expect(section.getByTestId('storage-pdf-bytes')).toHaveText('0 B');

    // Keep a copy of a PDF through the real reader.
    const reader = await extPage(env, 'pdf-reader.html');
    const [chooser] = await Promise.all([
      reader.waitForEvent('filechooser'),
      reader.getByTestId('pdf-choose-file').click(),
    ]);
    await chooser.setFiles({ name: 'renal.pdf', mimeType: 'application/pdf', buffer: proseDoc(4) });
    await expect(reader.getByTestId('pdf-viewer')).toBeVisible({ timeout: 30_000 });
    await reader.getByTestId('pdf-props').locator('summary').click();
    await reader.getByTestId('pdf-keep-copy').click();
    await expect(reader.getByTestId('pdf-props-copy')).toContainText('Kept on this device');

    // The settings page, open since before, picked it up (live) and shows real numbers.
    await ext.bringToFront();
    const copies = section.getByTestId('cached-pdfs');
    await expect(copies).toContainText('Renal physiology');
    await expect(copies).toContainText(/KB|MB/);
    await expect(section.getByTestId('storage-pdf-bytes')).not.toHaveText('0 B');
    const rows = await readTable(ext, 'attachments');
    expect(rows).toHaveLength(1);
    const bytes = Number(rows[0]!.byteLength);
    expect(bytes).toBeGreaterThan(1000);
    await expect(section.getByTestId('storage-table')).toContainText('PDF documents');

    await section
      .getByRole('button', { name: 'Remove the stored copy of Renal physiology' })
      .click();
    await expect(section.getByTestId('no-cached-pdfs')).toBeVisible();
    await expect(section.getByTestId('storage-pdf-bytes')).toHaveText('0 B');
    expect(await readTable(ext, 'attachments')).toHaveLength(0);
    // The document record (and any highlights on it) stays.
    expect(live(await readTable(ext, 'documents'))).toHaveLength(1);
    await expect(section.getByRole('heading', { name: 'Stored PDF copies' })).toBeFocused();
    expect(problemsOf(reader)).toEqual([]);
  });
});

test.describe('options: accessibility and reflow', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test(`the whole page, every section included, has no WCAG 2.2 A/AA violations (${scheme})`, async ({
      env,
    }) => {
      const page = await extPage(env, 'options.html');
      await page.emulateMedia({ colorScheme: scheme });
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.getByText('Loading settings')).toHaveCount(0);
      // Sections read their own data first (AI settings, sync status): wait for each heading.
      for (const { id } of SETTINGS_SECTIONS) {
        await expect(
          page.locator(`[id="${id}"]`).getByRole('heading', { level: 2 }).first(),
        ).toBeVisible();
      }
      // One scan of the whole page (every section is on it). Axe is slow on this much markup, so
      // a failure is attributed to its section afterwards instead of scanning section by section.
      const { violations } = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
      const report: string[] = [];
      for (const v of violations) {
        for (const node of v.nodes) {
          const selector = node.target[node.target.length - 1];
          const section = await page.evaluate(
            (sel) =>
              typeof sel === 'string'
                ? (document.querySelector(sel)?.closest('main > div')?.id ?? 'outside the sections')
                : 'unknown',
            selector,
          );
          report.push(
            `[${section}] ${v.id}: ${JSON.stringify(node.target)} ${node.html.slice(0, 120)}`,
          );
        }
      }
      expect(report, 'WCAG violations by section').toEqual([]);
    });
  }

  test('the AI setup form and a turned-off review are clean too', async ({ env }) => {
    const page = await extPage(env, 'options.html');
    await patchSettings(page, {
      features: { review: false, pdfReader: true, ai: true, sync: false },
    });
    await page.reload();
    await expect(page.getByLabel('Provider address')).toBeVisible();
    expect(await violationsOf(page, '#ai')).toBe('');
    expect(await violationsOf(page, '#review')).toBe('');
  });

  test('no horizontal scroll or clipped control at 320 px and at 200% zoom', async ({ env }) => {
    const page = await extPage(env, 'options.html');
    await page.setViewportSize({ width: 320, height: 700 });
    await expect(page.getByText('Loading settings')).toHaveCount(0);
    for (const { id } of SETTINGS_SECTIONS) {
      await expect(
        page.locator(`[id="${id}"]`).getByRole('heading', { level: 2 }).first(),
      ).toBeVisible();
    }
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(320);
    let report = await layoutReport(page);
    expect(report.scrollWidth, 'no horizontal scroll at 320 px').toBeLessThanOrEqual(
      report.innerWidth,
    );
    expect(report.offenders, report.offenders.join('\n')).toEqual([]);

    // Real browser zoom: 320 -> 160 CSS px wide.
    await setZoom(page, 2);
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(160);
    report = await layoutReport(page);
    expect(report.scrollWidth, 'no horizontal scroll at 200% zoom').toBeLessThanOrEqual(
      report.innerWidth,
    );
    expect(report.offenders, report.offenders.join('\n')).toEqual([]);
  });
});

// =============================================================================================
// POPUP
// =============================================================================================

test.describe('popup: study bar', () => {
  /** Create `n` typed cards through the real review page. */
  async function makeCards(env: Env, n: number): Promise<void> {
    const review = await extPage(env, 'review.html');
    await review.getByRole('tab', { name: 'Create cards' }).click();
    await review.getByRole('tab', { name: 'Typed card' }).click();
    for (let i = 1; i <= n; i++) {
      const manual = review.getByTestId('rv-manual');
      await manual.getByLabel('Question', { exact: true }).fill(`Study bar question ${i}?`);
      await manual.getByLabel('Answer', { exact: true }).fill(`Answer ${i}`);
      await review.getByTestId('rv-save-cards').click();
      await expect(review.getByText('Created 1 card.')).toBeVisible();
      // The confirmation toast sits over the save button until it goes, and a pointer resting on
      // it pauses its timer: move the pointer away.
      await review.mouse.move(0, 0);
      await expect(review.getByText('Created 1 card.')).toBeHidden({ timeout: 20_000 });
    }
    await review.close();
  }

  test('with no cards it says so, without a zero or a promise to start', async ({ env }) => {
    const page = await openFixture(env, '/article.html', { activate: false });
    const popup = await viewing(env, 'popup', page);
    await expect(popup.getByTestId('popup-due')).toHaveText('No flashcards yet');
    await expect(popup.getByRole('button', { name: 'Start review' })).toHaveCount(0);
    await expect(popup.getByRole('button', { name: 'Open review' })).toBeVisible();
    await expect(popup.getByRole('button', { name: 'Open side panel' })).toBeVisible();
    await expect(popup.getByRole('button', { name: 'Open dashboard' })).toBeVisible();
  });

  test('shows the real count, live, and Start review opens the session', async ({ env }) => {
    await makeCards(env, 2);
    const page = await openFixture(env, '/article.html', { activate: false });
    const popup = await viewing(env, 'popup', page);
    await expect(popup.getByTestId('popup-due')).toHaveText('2 cards due');
    await expect(popup.getByText('2 new · 0 learning · 0 review')).toBeVisible();

    // Live: a third card made in another window raises the count with no reload.
    await makeCards(env, 1);
    await page.bringToFront();
    await expect(popup.getByTestId('popup-due')).toHaveText('3 cards due');

    const opened = env.context.waitForEvent('page');
    await popup.getByRole('button', { name: 'Start review' }).click();
    const review = await opened;
    await expect(review).toHaveURL(/review\.html\?.*start=1/);
    await expect(review.getByTestId('rv-question')).toContainText('Study bar question');
  });

  test('Open dashboard opens the dashboard page', async ({ env }) => {
    const page = await openFixture(env, '/article.html', { activate: false });
    const popup = await viewing(env, 'popup', page);
    const opened = env.context.waitForEvent('page');
    await popup.getByRole('button', { name: 'Open dashboard' }).click();
    const dash = await opened;
    await expect(dash).toHaveURL(/dashboard\.html$/);
    await expect(dash.getByRole('heading', { level: 1 })).toBeVisible();
  });

  test('is clean for accessibility and fits the popup column in every state', async ({ env }) => {
    const page = await openFixture(env, '/article.html', { activate: false });
    const popup = await viewing(env, 'popup', page);
    await expect(popup.getByTestId('popup-due')).toBeVisible();
    expect(await violationsOf(popup)).toBe('');
    await popup.setViewportSize({ width: 360, height: 640 });
    const report = await layoutReport(popup);
    expect(report.scrollWidth).toBeLessThanOrEqual(report.innerWidth);
    expect(report.offenders, report.offenders.join('\n')).toEqual([]);
  });
});

test.describe('popup: PDF tabs', () => {
  let server: PdfServer;
  test.beforeAll(async () => {
    server = await startPdfServer({
      '/docs/renal.pdf': { body: proseDoc(3, 'Popup reader PDF') },
    });
  });
  test.afterAll(async () => {
    await server.close();
  });

  test('offers the StudyVault reader in Chrome’s built-in viewer, and it opens that PDF', async ({
    env,
  }) => {
    const page = await env.context.newPage();
    await page.goto(`${server.origin}/docs/renal.pdf`);
    // The built-in viewer is an extension frame embedded in the tab.
    await expect
      .poll(() => page.frames().some((f) => f.url().startsWith('chrome-extension://')))
      .toBe(true);

    const popup = await viewing(env, 'popup', page);
    await expect(popup.getByText("PDFs open in Chrome's built-in viewer")).toBeVisible();
    await expect(popup.getByText(/cannot highlight here/)).toHaveCount(1);
    await expect(popup.getByRole('button', { name: 'Activate on this tab' })).toHaveCount(0);
    await expect(popup.getByRole('button', { name: 'Open side panel' })).toBeVisible();
    await expect(popup.getByRole('button', { name: 'Open dashboard' })).toBeVisible();
    expect(await violationsOf(popup)).toBe('');
    // Axe opens a scratch tab; the popup follows the active tab, so show the PDF again.
    await page.bringToFront();
    await expect(popup.getByRole('button', { name: 'Open in StudyVault reader' })).toBeVisible();

    const opened = env.context.waitForEvent('page');
    await popup.getByRole('button', { name: 'Open in StudyVault reader' }).click();
    const reader = await opened;
    const url = new URL(reader.url());
    expect(url.pathname).toBe('/pdf-reader.html');
    expect(url.searchParams.get('src')).toBe(`${server.origin}/docs/renal.pdf`);
    await expect(reader.getByTestId('pdf-viewer')).toBeVisible({ timeout: 30_000 });
    await expect(reader.locator('.sv-doc__title')).toHaveText('Popup reader PDF');
  });

  test('is not offered while the PDF reader is turned off', async ({ env }) => {
    const ext = await openExt(env, 'options');
    await patchSettings(ext, {
      features: { review: true, pdfReader: false, ai: false, sync: false },
    });
    const page = await env.context.newPage();
    await page.goto(`${server.origin}/docs/renal.pdf`);
    const popup = await viewing(env, 'popup', page);
    await expect(popup.getByText(/PDF reader is turned off/)).toBeVisible();
    await expect(popup.getByRole('button', { name: /StudyVault reader/ })).toHaveCount(0);
    await expect(popup.getByRole('button', { name: 'Open side panel' })).toBeVisible();
  });
});

// =============================================================================================
// WELCOME TOUR
// =============================================================================================

test.describe('welcome tour', () => {
  const STEPS = ['welcome', 'privacy', 'access', 'banks', 'look', 'keys', 'done'] as const;
  const step = (page: Page, id: (typeof STEPS)[number]) => page.getByTestId(`ob-step-${id}`);

  /**
   * From the first step to `target`, one button press per step. Each press waits for the next
   * step to be on screen: a second press on a button that is still being replaced would run the
   * same step's handler again and land on the same step.
   */
  async function walkTo(page: Page, target: (typeof STEPS)[number]): Promise<void> {
    await expect(step(page, 'welcome')).toBeVisible();
    for (const id of STEPS.slice(1, STEPS.indexOf(target) + 1)) {
      await page.getByRole('button', { name: /^(Start|Next)$/ }).click();
      await expect(step(page, id)).toBeVisible();
    }
  }

  async function stored(page: Page): Promise<Record<string, unknown> | undefined> {
    return page.evaluate(async () => {
      const got = await chrome.storage.local.get('onboarding');
      return got.onboarding as Record<string, unknown> | undefined;
    });
  }

  /** Banks of the vault with the folders under each, read from the database. */
  async function vaultBanks(page: Page) {
    const banks = live(await readTable(page, 'banks')).filter((b) => b.isInbox !== true);
    const folders = live(await readTable(page, 'folders'));
    return banks.map((b) => ({
      name: String(b.name),
      folders: folders.filter((f) => f.bankId === b.id).map((f) => String(f.name)),
    }));
  }

  test('a first look stores nothing, starts on the heading, and every step is keyboard-reachable', async ({
    env,
  }) => {
    const page = await extPage(env, 'onboarding.html');
    await expect(step(page, 'welcome')).toBeVisible();
    await expect(page.getByRole('heading', { level: 2 })).toBeFocused();
    await expect(page.getByText('Everything stays on this device by default')).toBeVisible();
    expect(await stored(page)).toBeUndefined();

    // From the heading, Tab reaches the primary action; Enter moves on and focus follows.
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Start' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(step(page, 'privacy')).toBeVisible();
    await expect(page.getByRole('heading', { level: 2 })).toBeFocused();
    await expect(page.getByTestId('ob-progress')).toHaveText('Step 2 of 7');
    expect(await stored(page)).toMatchObject({ status: 'pending', step: 'privacy' });
    expect(problemsOf(page)).toEqual([]);
  });

  test('privacy choices default to the safe answers, save at once, and AI and sync stay off', async ({
    env,
  }) => {
    const page = await extPage(env, 'onboarding.html');
    await walkTo(page, 'privacy');
    await expect(page.getByTestId('ob-ai-status')).toContainText('Off');
    await expect(page.getByTestId('ob-sync-status')).toContainText('Off');
    await expect(page.getByTestId('ob-private-windows')).not.toBeChecked();
    await expect(page.getByTestId('ob-paint-highlights')).toBeChecked();
    await expect(page.getByTestId('ob-paint-highlights')).toHaveAccessibleDescription(
      /scripts that a site itself runs can read which passages you marked/,
    );
    await expect(page.getByText(/starter list of common sign-in, mail, payment/)).toBeVisible();

    await page.getByTestId('ob-private-windows').click();
    await page.getByTestId('ob-paint-highlights').click();
    await expect
      .poll(async () => storedSettings(page))
      .toMatchObject({ allowIncognitoCapture: true, paintHighlights: false });
    expect((await storedSettings(page))?.features).toMatchObject({ ai: false, sync: false });
  });

  test('site access is explained and nothing is requested from Chrome', async ({ env }) => {
    const page = await extPage(env, 'onboarding.html');
    const before = await page.evaluate(() => chrome.permissions.getAll());
    await walkTo(page, 'access');
    for (const level of ['This tab', 'This site', 'All sites']) {
      await expect(page.getByText(level, { exact: true })).toBeVisible();
    }
    await expect(page.getByText('Nothing is requested during this tour')).toBeVisible();
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(step(page, 'banks')).toBeVisible();
    const after = await page.evaluate(() => chrome.permissions.getAll());
    expect(after).toEqual(before);
  });

  test('the Diagnostic Radiology preset is created once: unticked folders left out, re-running adds nothing', async ({
    env,
  }) => {
    const page = await extPage(env, 'onboarding.html');
    await walkTo(page, 'banks');

    await page.getByTestId('ob-preset-radiology').check();
    const tree = page.getByRole('list', { name: 'Preview of Diagnostic Radiology' });
    await expect(tree.getByRole('checkbox')).toHaveCount(13);
    await page.getByTestId('ob-node-Diagnostic Radiology/Breast').uncheck();
    await expect(page.getByTestId('ob-plan')).toContainText('with 11 folders');
    expect(await vaultBanks(page), 'nothing exists before the button').toEqual([]);

    await page.getByTestId('ob-create').click();
    await expect(page.getByTestId('ob-applied')).toHaveText(
      'Created the bank "Diagnostic Radiology" with 11 folders.',
    );
    let banks = await vaultBanks(page);
    expect(banks).toHaveLength(1);
    expect(banks[0]!.name).toBe('Diagnostic Radiology');
    expect(banks[0]!.folders).toHaveLength(11);
    expect(banks[0]!.folders).not.toContain('Breast');
    expect(banks[0]!.folders).toEqual(
      expect.arrayContaining([
        'Physics',
        'Ultrasound',
        'CT',
        'MRI',
        'Nuclear Medicine',
        'Neuroradiology',
        'MSK',
        'Chest',
        'Abdomen',
        'Pediatrics',
        'Interventional',
      ]),
    );

    // The choice survives a reload (resume), and running it again changes nothing.
    await page.reload();
    await expect(step(page, 'banks')).toBeVisible();
    await expect(page.getByTestId('ob-preset-radiology')).toBeChecked();
    await expect(page.getByTestId('ob-node-Diagnostic Radiology/Breast')).not.toBeChecked();
    await page.getByTestId('ob-create').click();
    await expect(page.getByTestId('ob-applied')).toContainText(
      'already there, so nothing was added',
    );
    banks = await vaultBanks(page);
    expect(banks).toHaveLength(1);
    expect(banks[0]!.folders).toHaveLength(11);

    // Ticking Breast back and creating again adds exactly that one folder to the same bank.
    await page.getByTestId('ob-node-Diagnostic Radiology/Breast').check();
    await page.getByTestId('ob-create').click();
    await expect(page.getByTestId('ob-applied')).toContainText(
      'Added 1 folder to the existing bank',
    );
    banks = await vaultBanks(page);
    expect(banks).toHaveLength(1);
    expect(banks[0]!.folders).toHaveLength(12);
    expect(new Set(banks[0]!.folders).size).toBe(12);
  });

  test('two tour tabs creating the same preset at once never duplicate it', async ({ env }) => {
    const a = await extPage(env, 'onboarding.html');
    const b = await extPage(env, 'onboarding.html');
    for (const p of [a, b]) {
      await walkTo(p, 'banks');
      await p.getByTestId('ob-preset-medicine').check();
    }
    await Promise.all([a.getByTestId('ob-create').click(), b.getByTestId('ob-create').click()]);
    await expect(a.getByTestId('ob-applied')).toBeVisible();
    await expect(b.getByTestId('ob-applied')).toBeVisible();
    const banks = await vaultBanks(a);
    expect(banks.map((x) => x.name)).toEqual(['Medicine']);
    expect(banks[0]!.folders).toHaveLength(15); // 2 groups + 6 + 6 + 1
    expect(new Set(banks[0]!.folders).size).toBe(15);
  });

  test('theme and density apply at once and the shortcut list is what Chrome reports', async ({
    env,
  }) => {
    const page = await extPage(env, 'onboarding.html');
    // The blank preset has nothing to create, so banks -> look is a plain Next.
    await walkTo(page, 'look');
    await page.getByTestId('ob-theme-dark').click();
    await page.getByTestId('ob-density-compact').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect
      .poll(async () => storedSettings(page))
      .toMatchObject({ theme: 'dark', density: 'compact' });

    await page.getByRole('button', { name: 'Next' }).click();
    await expect(step(page, 'keys')).toBeVisible();
    const commands = await page.evaluate(() => chrome.commands.getAll());
    const list = page.getByTestId('ob-shortcuts');
    for (const c of commands) {
      // Chrome reports the toolbar-button command without a description: the page names it.
      const label = describeCommand(c.name ?? '', c.description);
      const row = list.getByRole('listitem').filter({ hasText: label });
      await expect(row.first(), c.name).toBeVisible();
      if (c.shortcut) await expect(row.first()).toContainText(c.shortcut);
      else await expect(row.first()).toContainText('Not set');
    }
  });

  test('finish opens the side panel from the click and completes the tour', async ({ env }) => {
    const page = await extPage(env, 'onboarding.html');
    await walkTo(page, 'done');
    await expect(page.getByText(/Click the StudyVault icon in the Chrome toolbar/)).toBeVisible();

    await page.getByTestId('ob-open-panel').click();
    await expect(page.getByText('The side panel is open next to this tab.')).toBeVisible();
    await page.getByTestId('ob-finish').click();
    await expect(page.getByTestId('ob-finished')).toBeVisible();
    expect(await stored(page)).toMatchObject({ status: 'completed', step: 'done' });

    // Opened again, it starts from the beginning and does not unfinish itself.
    await page.reload();
    await expect(step(page, 'welcome')).toBeVisible();
    expect(await stored(page)).toMatchObject({ status: 'completed' });
  });

  test('skipping is possible at any step, changes nothing else, and is remembered', async ({
    env,
  }) => {
    const page = await extPage(env, 'onboarding.html');
    await walkTo(page, 'access');
    await page.getByRole('button', { name: 'Skip the tour' }).click();
    await expect(page.getByTestId('ob-skipped')).toBeVisible();
    await expect(page.getByText(/open this tour again any time from Settings/)).toBeVisible();
    expect(await stored(page)).toMatchObject({ status: 'skipped' });
    expect(await vaultBanks(page)).toEqual([]);

    // And it can be opened again from Settings: an open tour tab is brought forward, not doubled...
    const ext = await openExt(env, 'options');
    const before = env.context.pages().filter((p) => /onboarding\.html/.test(p.url())).length;
    await ext.getByRole('button', { name: 'Show the welcome tour' }).click();
    await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe('visible');
    expect(env.context.pages().filter((p) => /onboarding\.html/.test(p.url()))).toHaveLength(
      before,
    );
    // ...and with none open, a new one is made.
    await page.close();
    await ext.bringToFront();
    const opened = env.context.waitForEvent('page');
    await ext.getByRole('button', { name: 'Show the welcome tour' }).click();
    const tour = await opened;
    await expect(tour).toHaveURL(/onboarding\.html$/);
    await expect(tour.getByTestId('ob-step-welcome')).toBeVisible();
  });

  test('a tour left part-way is resumed, and Settings offers to resume it', async ({ env }) => {
    const page = await extPage(env, 'onboarding.html');
    await walkTo(page, 'banks');
    await page.getByTestId('ob-preset-general').check();
    await page.close();

    const again = await extPage(env, 'onboarding.html');
    await expect(step(again, 'banks')).toBeVisible();
    await expect(again.getByTestId('ob-preset-general')).toBeChecked();
    const ext = await openExt(env, 'options');
    await expect(ext.getByRole('button', { name: 'Resume the welcome tour' })).toBeVisible();
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`every step has no WCAG 2.2 A/AA violations and reflows to 320 px and 200% (${scheme})`, async ({
      env,
    }) => {
      const page = await extPage(env, 'onboarding.html');
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: 320, height: 700 });
      for (let i = 0; i < STEPS.length; i++) {
        const id = STEPS[i]!;
        await expect(step(page, id)).toBeVisible();
        if (id === 'banks') await page.getByTestId('ob-preset-medicine').check();
        expect(await violationsOf(page), `step ${id}`).toBe('');
        const report = await layoutReport(page);
        expect(report.scrollWidth, `step ${id} must not scroll horizontally`).toBeLessThanOrEqual(
          report.innerWidth,
        );
        expect(report.offenders, `${id}: ${report.offenders.join('\n')}`).toEqual([]);
        if (i < STEPS.length - 1) {
          await page
            .getByRole('button', { name: /^(Start|Next|Create the bank and folders)$/ })
            .click();
          if (id === 'banks') {
            await expect(page.getByTestId('ob-applied')).toBeVisible();
            await page.getByRole('button', { name: 'Next' }).click();
          }
        }
      }
      // 200% browser zoom on the last step.
      await setZoom(page, 2);
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(160);
      const zoomed = await layoutReport(page);
      expect(zoomed.scrollWidth).toBeLessThanOrEqual(zoomed.innerWidth);
      expect(zoomed.offenders, zoomed.offenders.join('\n')).toEqual([]);
      expect(problemsOf(page)).toEqual([]);
    });
  }
});
