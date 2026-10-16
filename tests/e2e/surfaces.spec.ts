import AxeBuilder from '@axe-core/playwright';
import { settleAnimations } from './axeSettle';
import type { Page } from '@playwright/test';
import { SETTINGS_SECTIONS } from '@ui/shell/paths';
import { describeCommand } from '@ui/shortcuts';
import { proseDoc } from '../fixtures/pdf/docs';
import { startPdfServer, type PdfServer } from '../fixtures/pdf/server';
import { enableAi } from './helpers.ai';
import { openDisclosure } from './helpers.backup';
import { pickCard } from './helpers.graph';
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
  await settleAnimations(page);
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

/**
 * Every settings view, in rail and home-tile order (`OPTION_SECTIONS` of the options page), with
 * its label: the view's h1 and its rail entry. Only the current view is on the page
 * (`options.html#<id>`; no hash is the settings home). The `SETTINGS_SECTIONS` ids are a public
 * deep-link contract and must all be here.
 */
const VIEWS = [
  { id: 'game', label: 'Game' },
  { id: 'site-access', label: 'Site access' },
  { id: 'capture', label: 'Capture' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'shortcuts', label: 'Shortcuts' },
  { id: 'review', label: 'Review' },
  { id: 'reminders', label: 'Reminders' },
  { id: 'backup', label: 'Backup' },
  { id: 'storage', label: 'Storage' },
  { id: 'privacy', label: 'Privacy' },
  { id: 'data', label: 'Your data' },
  { id: 'ai', label: 'AI' },
  { id: 'sync', label: 'Sync' },
  { id: 'about', label: 'About' },
] as const;
type ViewId = (typeof VIEWS)[number]['id'];

/**
 * Show one settings view through the address, as a link or Back would (null: the home), and wait
 * until it is drawn: its h1, and for a section its content (the sections that read the database
 * mount one task after the settings). The h1 of AI, Sync and Backup is visually hidden
 * (their own title card shows), so it is checked by text, not visibility.
 */
async function showView(page: Page, id: ViewId | null): Promise<void> {
  await page.evaluate((hash) => {
    window.location.hash = hash;
  }, id ?? '');
  const label = id ? VIEWS.find((v) => v.id === id)!.label : 'Settings';
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(label);
  if (id) await expect(page.locator(`[id="${id}"] > *`).first()).toBeVisible();
  await expect(page.getByText(/^Loading/)).toHaveCount(0);
}

test.describe('options: section list', () => {
  test('is a landmark with deep links, one tab stop, arrow/Home/End keys and keyboard activation', async ({
    env,
  }) => {
    const page = await openExt(env, 'options');
    const nav = page.getByRole('navigation', { name: 'Settings sections' });
    await expect(nav).toBeVisible();
    const links = nav.getByRole('link');
    // The home comes first, then one entry per view.
    await expect(links).toHaveText(['Home', ...VIEWS.map((v) => v.label)]);
    await expect(links).toHaveCount(VIEWS.length + 1);
    // The deep-link ids are a contract with the tour, the docs and other pages.
    for (const { id } of SETTINGS_SECTIONS) {
      await expect(nav.locator(`a[href="#${id}"]`)).toHaveCount(1);
    }
    // Each link opens its own view: the address, the view's h1 and section, the current mark.
    for (const { id, label } of VIEWS) {
      await nav.locator(`a[href="#${id}"]`).click();
      await expect(page).toHaveURL(new RegExp(`options\\.html#${id}$`));
      const target = page.locator(`[id="${id}"]`);
      await expect(target).toHaveCount(1);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(label);
      await expect(target.locator(':scope > *').first()).toBeVisible();
      await expect(nav.locator('[aria-current="page"]')).toHaveAttribute('href', `#${id}`);
    }
    await nav.getByRole('link', { name: 'Home' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Settings');
    await expect(nav.locator('[aria-current="page"]')).toHaveAttribute('href', '#');

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

    // Enter follows the link: the address, the current mark and focus (the new view's h1) follow.
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/options\.html#about$/);
    await expect(links.last()).toHaveAttribute('aria-current', 'page');
    const title = page.getByRole('heading', { level: 1 });
    await expect(title).toHaveText('About');
    await expect(title).toBeFocused();
    await expect(title).toBeInViewport();

    // Tab leaves the list after its one stop (it does not walk through every link).
    await links.first().focus();
    await page.keyboard.press('Tab');
    await expect(nav.locator(':focus')).toHaveCount(0);
    expect(problemsOf(page)).toEqual([]);
  });

  test('a section address opens that section, even though sections load after settings', async ({
    env,
  }) => {
    const page = await extPage(env, 'options.html#storage');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Storage');
    await expect(page.getByRole('heading', { level: 1 })).toBeInViewport();
    // Storage reads the database, so it mounts after the settings: its first card is there too.
    await expect(
      page.locator('#storage').getByRole('heading', { name: 'Space used' }),
    ).toBeInViewport();
    await expect(
      page.getByRole('navigation', { name: 'Settings sections' }).locator('a[href="#storage"]'),
    ).toHaveAttribute('aria-current', 'page');
    // An unknown hash is ignored: no error, the page simply opens at the top of the settings home,
    // whose tiles lead to every section (no section is mounted on the home).
    const other = await extPage(env, 'options.html#not-a-section');
    await expect(other.getByRole('heading', { level: 1 })).toHaveText('Settings');
    await expect(other.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(other.getByRole('link', { name: /^Site access, / })).toBeVisible();
    await expect(other.locator('#site-access')).toHaveCount(0);
    expect(await other.evaluate(() => window.scrollY)).toBe(0);
    expect(problemsOf(page)).toEqual([]);
    expect(problemsOf(other)).toEqual([]);
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
    const page = await openExt(env, 'options', 'ai');
    const ai = page.locator('#ai');
    await expect(ai.getByRole('heading', { name: /AI assistance/ })).toBeVisible();
    // The explanation is one click away, under "What is sent".
    await openDisclosure(ai, 'What is sent');
    await expect(
      ai.getByText('While AI is off, StudyVault sends nothing anywhere', { exact: false }),
    ).toBeVisible();
    await expect(ai.getByRole('checkbox', { name: 'Turn on AI features' })).not.toBeChecked();
    await expect(ai.getByLabel('Provider address')).toHaveCount(0);

    await showView(page, 'sync');
    const sync = page.locator('#sync');
    await expect(sync.getByRole('heading', { name: /Sync between devices/ })).toBeVisible();
    // The setup starts on what is shared; the whole explanation is under "Every detail".
    await expect(sync.getByRole('heading', { name: 'What is shared' })).toBeVisible();
    await openDisclosure(sync, 'Every detail');
    await expect(sync.getByTestId('sync-explanation')).toBeVisible();
    await expect(sync.getByTestId('sync-explanation')).toContainText(
      'There is no StudyVault server',
    );
    await expect(sync.getByTestId('sync-explanation')).toContainText('off by default');
    // "Turn on sync" is only offered on the setup's last step, after the server, the sign-in
    // provider and the acknowledgement (it was a disabled button on the old single form).
    await expect(sync.getByRole('button', { name: /Turn on sync/ })).toHaveCount(0);
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
    const page = await openExt(env, 'options', 'ai');
    // The switch, then: it is on, the setup wizard shows and `features.ai` is stored.
    await enableAi(page);
    const setup = page.getByTestId('ai-setup');
    await expect(setup.getByRole('heading', { name: 'Pick a provider' })).toBeVisible();
    await pickCard(page.getByTestId('ai-preset-custom'));
    await setup.getByTestId('ai-setup-next').click();
    await expect(page.getByLabel('Provider address')).toBeVisible();
    // Nothing can be tested before a setup is saved: the wizard's last step is "Save and test",
    // and the status card's "Test connection" does not exist yet.
    await expect(page.getByRole('button', { name: 'Test connection' })).toHaveCount(0);
    await expect(page.getByTestId('ai-test')).toHaveCount(0);
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
    // "Open review" is on the settings home; the switch and the study settings are under Review.
    const openReview = ext.getByRole('button', { name: 'Open review' });
    await expect(openReview).toBeVisible();
    await expect(openReview).not.toHaveAttribute('aria-disabled', 'true');
    await showView(ext, 'review');
    await expect(ext.getByRole('heading', { name: 'Review settings', exact: true })).toBeVisible();

    const toggle = ext.getByRole('checkbox', { name: 'Show review' });
    await toggle.click();
    await expect
      .poll(async () => (await storedSettings(ext))?.features)
      .toMatchObject({
        review: false,
      });
    await expect(ext.getByRole('heading', { name: 'Review settings', exact: true })).toHaveCount(0);
    await expect(ext.getByRole('heading', { name: 'Review is off' })).toBeVisible();
    await showView(ext, null);
    await expect(openReview).toHaveAttribute('aria-disabled', 'true');

    // The popup follows without a reload: no count, no review button, dashboard still offered.
    const page = await openFixture(env, '/article.html', { activate: false });
    const popup = await viewing(env, 'popup', page);
    await expect(popup.getByRole('button', { name: 'Open dashboard' })).toBeVisible();
    await expect(popup.getByTestId('popup-due')).toHaveCount(0);
    await expect(popup.getByTestId('popup-review')).toHaveCount(0);

    await ext.bringToFront();
    await showView(ext, 'review');
    await toggle.click();
    await expect(ext.getByRole('heading', { name: 'Review settings', exact: true })).toBeVisible();
    await expect(popup.getByTestId('popup-due')).toBeVisible();
  });

  test('density and the PDF reader switch persist across a reload', async ({ env }) => {
    const ext = await openExt(env, 'options', 'appearance');
    await pickCard(ext.getByRole('radio', { name: /^Compact/ }));
    await showView(ext, 'capture');
    await ext.getByRole('checkbox', { name: 'PDF reader' }).click();
    await expect
      .poll(async () => storedSettings(ext))
      .toMatchObject({
        density: 'compact',
        features: { pdfReader: false },
      });
    await ext.reload();
    await expect(ext.getByRole('checkbox', { name: 'PDF reader' })).not.toBeChecked();
    await showView(ext, 'appearance');
    await expect(ext.getByRole('radio', { name: /^Compact/ })).toBeChecked();
  });

  test('delete-all lives under Your data and Privacy lists the optional permissions', async ({
    env,
  }) => {
    const ext = await openExt(env, 'options', 'data');
    await expect(
      ext.locator('#data').getByRole('button', { name: /^Delete all data/ }),
    ).toBeVisible();
    await showView(ext, 'privacy');
    const privacy = ext.locator('#privacy');
    await expect(privacy.getByRole('button', { name: /^Delete all/ })).toHaveCount(0);
    // The permission list is one click away, under its own disclosure.
    await openDisclosure(privacy, 'Permissions this extension holds');
    await expect(privacy.getByText('identity', { exact: true })).toBeVisible();
    await expect(privacy.getByText('alarms', { exact: true })).toBeVisible();
    await expect(privacy).toContainText('Everything stays on this device by default');
  });
});

test.describe('options: storage', () => {
  test('shows counts from the real database and removes a stored PDF copy kept in the reader', async ({
    env,
  }) => {
    const ext = await openExt(env, 'options', 'storage');
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
      // One section is on the page at a time: the home, then each view in turn. A failure is
      // attributed to its view.
      const report: string[] = [];
      for (const view of [null, ...VIEWS.map((v) => v.id)]) {
        await showView(page, view);
        await settleAnimations(page);
        const { violations } = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
        for (const v of violations) {
          for (const node of v.nodes) {
            report.push(
              `[${view ?? 'home'}] ${v.id}: ${JSON.stringify(node.target)} ${node.html.slice(0, 120)}`,
            );
          }
        }
      }
      expect(report, 'WCAG violations by view').toEqual([]);
    });
  }

  test('the AI setup form and a turned-off review are clean too', async ({ env }) => {
    const page = await extPage(env, 'options.html');
    await patchSettings(page, {
      features: { review: false, pdfReader: true, ai: true, sync: false },
    });
    await page.reload();
    await showView(page, 'ai');
    // The setup form: its first step (the provider cards), then the address and model step.
    const setup = page.getByTestId('ai-setup');
    await expect(setup.getByRole('heading', { name: 'Pick a provider' })).toBeVisible();
    expect(await violationsOf(page, '#ai')).toBe('');
    await pickCard(page.getByTestId('ai-preset-custom'));
    await setup.getByTestId('ai-setup-next').click();
    await expect(page.getByLabel('Provider address')).toBeVisible();
    expect(await violationsOf(page, '#ai')).toBe('');
    await showView(page, 'review');
    await expect(page.getByRole('heading', { name: 'Review is off' })).toBeVisible();
    expect(await violationsOf(page, '#review')).toBe('');
  });

  test('no horizontal scroll or clipped control at 320 px and at 200% zoom', async ({ env }) => {
    const page = await extPage(env, 'options.html');
    await page.setViewportSize({ width: 320, height: 700 });
    await expect(page.getByText('Loading settings')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(320);
    // Every view: the home and each section, at 320 px and then at real 200% browser zoom.
    const views = [null, ...VIEWS.map((v) => v.id)];
    for (const view of views) {
      await showView(page, view);
      const report = await layoutReport(page);
      expect(
        report.scrollWidth,
        `${view ?? 'home'}: no horizontal scroll at 320 px`,
      ).toBeLessThanOrEqual(report.innerWidth);
      expect(report.offenders, `${view ?? 'home'}: ${report.offenders.join('\n')}`).toEqual([]);
    }

    // Real browser zoom: 320 -> 160 CSS px wide.
    await setZoom(page, 2);
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(160);
    for (const view of views) {
      await showView(page, view);
      const report = await layoutReport(page);
      expect(
        report.scrollWidth,
        `${view ?? 'home'}: no horizontal scroll at 200% zoom`,
      ).toBeLessThanOrEqual(report.innerWidth);
      expect(report.offenders, `${view ?? 'home'}: ${report.offenders.join('\n')}`).toEqual([]);
    }
  });
});

// =============================================================================================
// POPUP
// =============================================================================================

test.describe('popup: study bar', () => {
  /**
   * Create `n` typed cards through the real review page: the Create wizard's "Blank card" path
   * (Start from, Card type, Write the card, Pick a deck), then "Make another" for each further card.
   */
  async function makeCards(env: Env, n: number): Promise<void> {
    const review = await extPage(env, 'review.html');
    await review.getByRole('tab', { name: 'Create', exact: true }).click();
    const next = review.getByRole('button', { name: 'Next', exact: true });
    const choose = async (group: string, option: string) => {
      const set = review.getByRole('radiogroup', { name: group });
      await set.getByText(option, { exact: true }).click();
      await expect(set.getByRole('radio', { name: option })).toBeChecked();
    };
    await choose('Start from', 'Blank card');
    await next.click();
    await choose('Card type', 'Q and A');
    await next.click();
    for (let i = 1; i <= n; i++) {
      if (i > 1) await review.getByRole('button', { name: 'Make another' }).click();
      const manual = review.getByTestId('rv-manual');
      await manual.getByLabel('Question', { exact: true }).fill(`Study bar question ${i}?`);
      await manual.getByLabel('Answer', { exact: true }).fill(`Answer ${i}`);
      await next.click(); // to "Pick a deck", where the automatic deck is already chosen
      await review.getByRole('button', { name: 'Create card', exact: true }).click();
      await expect(review.getByRole('heading', { name: 'Card created!' })).toBeVisible();
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
    await expect(popup.getByText('Chrome PDF viewer', { exact: true })).toBeVisible();
    await expect(popup.getByRole('button', { name: 'Turn on' })).toHaveCount(0);
    await expect(popup.getByRole('button', { name: 'Open side panel' })).toBeVisible();
    await expect(popup.getByRole('button', { name: 'Open dashboard' })).toBeVisible();
    // Why it cannot be marked up here is said once, behind the (i) next to the reader button.
    await popup.getByRole('button', { name: 'About PDFs' }).click();
    await expect(popup.getByText(/built-in viewer, which extensions cannot mark up/)).toHaveCount(
      1,
    );
    await expect(popup.getByText(/built-in viewer, which extensions cannot mark up/)).toBeVisible();
    expect(await violationsOf(popup)).toBe('');
    // Axe opens a scratch tab; the popup follows the active tab, so show the PDF again.
    await page.bringToFront();
    await expect(popup.getByRole('button', { name: 'Open in StudyVault' })).toBeVisible();

    const opened = env.context.waitForEvent('page');
    await popup.getByRole('button', { name: 'Open in StudyVault' }).click();
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
    await expect(popup.getByText('PDF reader is off.')).toBeVisible();
    await expect(
      popup.getByRole('button', { name: /^(Open in StudyVault|Open reader)$/ }),
    ).toHaveCount(0);
    // Where to turn it back on is one click away.
    await expect(popup.getByRole('button', { name: 'Open Settings' })).toBeVisible();
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
    // The privacy promise is now three chips ("On this device", "No account", "No tracking").
    const promises = page.getByRole('list', { name: 'Your privacy' });
    await expect(promises).toBeVisible();
    await expect(promises).toContainText('On this device');
    expect(await stored(page)).toBeUndefined();

    // From the heading, Tab reaches the primary action (past the (i) and the daily goal cards, a
    // few stops at most); Enter moves on and focus follows.
    const start = page.getByRole('button', { name: 'Start' });
    for (let i = 0; i < 12 && !(await start.evaluate((b) => b === document.activeElement)); i++) {
      await page.keyboard.press('Tab');
    }
    await expect(start).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(step(page, 'privacy')).toBeVisible();
    await expect(page.getByRole('heading', { level: 2 })).toBeFocused();
    await expect(page.getByTestId('ob-progress')).toHaveText('2/7');
    await expect(page.getByRole('progressbar', { name: 'Welcome tour progress' })).toHaveAttribute(
      'aria-valuetext',
      /^Step 2 of 7: /,
    );
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
    // The starter blocked-sites note is behind the (i) next to the AI, Sync and Blocked tiles.
    await page.getByRole('button', { name: 'About AI, sync and blocked sites' }).click();
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
    // "This site" is now "One site".
    for (const level of ['This tab', 'One site', 'All sites']) {
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
    // The folder checklist is folded away under "Choose folders".
    await openDisclosure(step(page, 'banks'), 'Choose folders');
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
    // The full list is folded away under "All shortcuts".
    await openDisclosure(step(page, 'keys'), 'All shortcuts');
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
    // The toolbar route is behind the (i) next to the button.
    await page.getByRole('button', { name: 'Other ways to open it' }).click();
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

    // And it can be opened again from Settings (About, button "Welcome tour"): an open tour tab is
    // brought forward, not doubled...
    const ext = await openExt(env, 'options', 'about');
    const before = env.context.pages().filter((p) => /onboarding\.html/.test(p.url())).length;
    await ext.getByRole('button', { name: 'Welcome tour' }).click();
    await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe('visible');
    expect(env.context.pages().filter((p) => /onboarding\.html/.test(p.url()))).toHaveLength(
      before,
    );
    // ...and with none open, a new one is made.
    await page.close();
    await ext.bringToFront();
    const opened = env.context.waitForEvent('page');
    await ext.getByRole('button', { name: 'Welcome tour' }).click();
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
    const ext = await openExt(env, 'options', 'about');
    await expect(ext.getByRole('button', { name: 'Resume tour' })).toBeVisible();
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
        if (id === 'banks') {
          await page.getByTestId('ob-preset-medicine').check();
          // The folder checklist is folded away: open it so its checkboxes are checked too.
          await openDisclosure(step(page, 'banks'), 'Choose folders');
        }
        expect(await violationsOf(page), `step ${id}`).toBe('');
        const report = await layoutReport(page);
        expect(report.scrollWidth, `step ${id} must not scroll horizontally`).toBeLessThanOrEqual(
          report.innerWidth,
        );
        expect(report.offenders, `${id}: ${report.offenders.join('\n')}`).toEqual([]);
        if (i < STEPS.length - 1) {
          await page.getByRole('button', { name: /^(Start|Next|Create bank)$/ }).click();
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
