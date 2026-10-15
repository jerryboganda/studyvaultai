import type { Page } from '@playwright/test';
import { MAX_FOLDER_DEPTH } from '@shared';
import { wrappedDoc } from '../fixtures/pdf/docs';
import { downloadOf, openBackupPage, writeDatasetKeepingInbox } from './helpers.backup';
import {
  buildDataset,
  createFolderUi,
  ensureVault,
  expect,
  expectAxeClean,
  openControl,
  openDashboard,
  openPalette,
  runCommand,
  settle,
  test,
  toast,
  treeItem,
  treeOutline,
  type DatasetInput,
  type Env,
} from './helpers.dashboard';
import { openExt, storedSettings } from './helpers.pages';

/**
 * Leftovers closed by the polish pass, each driven through the real controls of the real built
 * extension:
 *  - the single-file JSON export in Settings > Backup (same scope choice as the other exports);
 *  - pending feedback on controls whose change is an async settings write;
 *  - WCAG 1.4.12 text spacing on the dashboard list, 2.1.4 single-key switch, 2.2.1 toasts;
 *  - folders nested to the new depth limit at 320 px;
 *  - the PDF reader's keyboard route to the save bar;
 *  - the search box taking focus on the "focus-search" hand-over.
 *
 * What cannot be driven here, and why: the native shortcut key of the `focus-search` command (no
 * suggested key; Playwright cannot press a browser-level shortcut), so the worker's hand-over value
 * is written the way the worker writes it and the surfaces are driven from it (the worker's
 * handler itself is unit-tested); Chrome's caret browsing (F7), so the selection a caret-browsing
 * user ends up with is made with the Selection API while the viewer holds focus.
 */

test.describe.configure({ timeout: 240_000 });

const QUOTE_ATP = 'Mitochondria produce ATP through oxidative phosphorylation.';
const QUOTE_MEMBRANE = 'The cell membrane is a selectively permeable phospholipid bilayer.';
const QUOTE_PUMP = 'Sodium potassium ATPase moves three sodium ions out for two potassium ions in.';
const QUOTE_TRASHED = 'This fact was in the trash when the export was made.';

const sourceA = (env: Env) => `${env.origin}/dash-source-a.html`;

function smallInput(env: Env): DatasetInput {
  return {
    banks: [{ key: 'cardio', name: 'Cardiology' }],
    folders: [
      { key: 'hemo', bank: 'cardio', name: 'Haemodynamics' },
      { key: 'press', bank: 'cardio', parent: 'hemo', name: 'Pressure' },
    ],
    tags: [{ key: 'exam', name: 'exam' }],
    sources: [{ key: 'a', url: sourceA(env), title: 'Cell biology notes' }],
    highlights: [
      {
        key: 'atp',
        quote: QUOTE_ATP,
        source: 'a',
        places: [{ bank: 'cardio', folder: 'press' }],
        tags: ['exam'],
        comment: 'Four complexes.',
        notes: [{ title: 'Gradient', body: 'Remember the proton gradient.' }],
      },
      { key: 'mem', quote: QUOTE_MEMBRANE, source: 'a' },
      { key: 'pump', quote: QUOTE_PUMP, source: 'a', places: [{ bank: 'cardio' }] },
      { key: 'gone', quote: QUOTE_TRASHED, source: 'a', trashed: true },
    ],
  };
}

/** A vault seeded through the extension-origin raw writer (validated with the product's schemas). */
async function seed(env: Env, input: DatasetInput) {
  const ctrl = await openControl(env);
  await ensureVault(ctrl);
  const ds = buildDataset(input);
  await writeDatasetKeepingInbox(ctrl, ds);
  return { ctrl, ds };
}

/** `features.<name>` of the stored settings (false until the first write). */
async function featureOf(ext: Page, name: 'ai' | 'sync'): Promise<boolean> {
  const features = (await storedSettings(ext))?.features as Record<string, boolean> | undefined;
  return features?.[name] ?? false;
}

const blur = (page: Page) =>
  page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

// ===============================================================================================
// 1. The single-file JSON export
// ===============================================================================================

test.describe('JSON export', () => {
  test('is offered with the same scope choice as the other exports, downloads real JSON and leaves the trash out', async ({
    env,
  }) => {
    const { ds } = await seed(env, smallInput(env));
    const page = await openBackupPage(env);
    const readable = page.getByTestId('backup-readable');
    await expect(readable.getByRole('heading', { level: 3 })).toHaveText(
      'Export to Markdown, CSV, Anki or JSON',
    );

    await readable.getByTestId('readable-format-json').check();
    await expect(readable.getByTestId('readable-format-json')).toHaveAccessibleDescription(
      /does not import it back/,
    );
    // Markdown's own options are not shown for it.
    await expect(readable.getByTestId('readable-markdown-options')).toHaveCount(0);

    // Everything.
    await readable.getByTestId('readable-prepare').click();
    await expect(readable.getByTestId('readable-summary')).toHaveText('3 highlights in 1 file.');
    await expectAxeClean(page, '[data-testid="backup-readable"]');
    const file = await downloadOf(page, () => readable.getByTestId('readable-download').click());
    expect(file.name).toMatch(/^studyvault-highlights-\d{8}-\d{6}\.json$/);
    const text = file.bytes.toString('utf8');
    expect(text, 'the trash is not exported').not.toContain(QUOTE_TRASHED);
    const rows = JSON.parse(text) as Array<{
      id: string;
      quote: string;
      comment: string;
      source: { title: string; url: string | null; type: string };
      tags: string[];
      notes: Array<{ body: string }>;
      banks: Array<{ name: string; folder: string[] }>;
      quoteHash: string;
      deleted: boolean;
    }>;
    expect(rows.map((r) => r.id).sort()).toEqual(
      [ds.id.hl('atp'), ds.id.hl('mem'), ds.id.hl('pump')].sort(),
    );
    const atp = rows.find((r) => r.id === ds.id.hl('atp'))!;
    expect(atp).toMatchObject({
      quote: QUOTE_ATP,
      comment: 'Four complexes.',
      source: { title: 'Cell biology notes', url: sourceA(env), type: 'web' },
      tags: ['exam'],
      banks: [{ name: 'Cardiology', folder: ['Haemodynamics', 'Pressure'] }],
      deleted: false,
    });
    expect(atp.notes.map((n) => n.body)).toContain('Remember the proton gradient.');
    expect(atp.quoteHash).toMatch(/^[0-9a-f]{64}$/);

    // One chosen bank.
    await readable.getByTestId('readable-scope-banks').check();
    await readable.getByTestId(`readable-bank-${ds.id.bank('cardio')}`).check();
    await readable.getByTestId('readable-prepare').click();
    await expect(readable.getByTestId('readable-summary')).toHaveText('2 highlights in 1 file.');
    const cardio = await downloadOf(page, () => readable.getByTestId('readable-download').click());
    const cardioText = cardio.bytes.toString('utf8');
    expect(cardioText).toContain(QUOTE_ATP);
    expect(cardioText).toContain(QUOTE_PUMP);
    expect(cardioText).not.toContain(QUOTE_MEMBRANE);
  });
});

// ===============================================================================================
// 2. Pending feedback on async writes
// ===============================================================================================

/**
 * Holds the next `chrome.storage.local.set` of this page until `release()` is called. The settings
 * write is a trusted-copy write followed by this one, so the control stays pending in between.
 */
async function holdNextSettingsWrite(page: Page): Promise<() => Promise<void>> {
  const token = `__release_${Math.random().toString(36).slice(2)}`;
  await page.evaluate((name) => {
    const local = chrome.storage.local as unknown as { set(...args: unknown[]): Promise<void> };
    const real = local.set.bind(local);
    const gate = new Promise<void>((resolve) => {
      (window as unknown as Record<string, () => void>)[name] = resolve;
    });
    let held = false;
    local.set = async (...args: unknown[]) => {
      if (!held) {
        held = true;
        await gate;
      }
      return real(...args);
    };
  }, token);
  return () =>
    page.evaluate((name) => {
      (window as unknown as Record<string, () => void>)[name]?.();
    }, token);
}

test.describe('pending writes', () => {
  test('the AI switch and a settings switch show their choice at once, are busy until stored, and never snap back', async ({
    env,
  }) => {
    const ext = await openExt(env, 'options');

    const ai = ext.getByTestId('ai-enable');
    await expect(ai).not.toBeChecked();
    const releaseAi = await holdNextSettingsWrite(ext);
    await ai.click();
    await expect(ai).toBeChecked();
    await expect(ai).toHaveAttribute('aria-busy', 'true');
    await expect(ext.locator('#ai').getByText('Saving…')).toBeVisible();
    // Two animation frames later it is still showing the choice, not the stored value.
    await ext.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await expect(ai).toBeChecked();
    expect(await featureOf(ext, 'ai')).toBe(false);

    await releaseAi();
    await expect(ai).not.toHaveAttribute('aria-busy', 'true');
    await expect(ai).toBeChecked();
    await expect.poll(() => featureOf(ext, 'ai')).toBe(true);
    await expect(ext.locator('#ai').getByText('Saving…')).toHaveCount(0);

    // A switch of the same kind in another section.
    const toolbar = ext.getByRole('checkbox', {
      name: 'Show the floating toolbar when I select text',
    });
    await expect(toolbar).toBeChecked();
    const releaseToolbar = await holdNextSettingsWrite(ext);
    await toolbar.click();
    await expect(toolbar).not.toBeChecked();
    await expect(toolbar).toHaveAttribute('aria-busy', 'true');
    await releaseToolbar();
    await expect(toolbar).not.toHaveAttribute('aria-busy', 'true');
    await expect(toolbar).not.toBeChecked();
    await expect.poll(async () => (await storedSettings(ext))?.toolbarEnabled).toBe(false);
  });

  test('"Turn on sync" says it is waiting for Chrome and refuses a second press', async ({
    env,
  }) => {
    const ext = await openExt(env, 'options');
    const section = ext.locator('#sync');
    await section.getByTestId('sync-server-url').fill('https://sync.example.org');
    await section.getByTestId('sync-issuer').fill('https://id.example.org');
    await section.getByTestId('sync-client-id').fill('studyvault');
    await section.getByTestId('sync-ack').check();
    const enable = section.getByTestId('sync-enable');
    await expect(section.getByTestId('sync-enable-status')).toHaveCount(0);

    await enable.click(); // the native prompt cannot be answered here: it stays pending
    await expect(enable).toHaveAttribute('aria-busy', 'true');
    await expect(section.getByTestId('sync-enable-status')).toContainText(
      'Turning on sync… Chrome may ask',
    );
    expect(await featureOf(ext, 'sync')).toBe(false);
  });
});

// ===============================================================================================
// 3. Dashboard: single-key switch, text spacing, depth, toasts
// ===============================================================================================

test.describe('dashboard', () => {
  test('the "/" and "?" keys can be switched off, stay off after a reload, and Ctrl+K and F6 keep working', async ({
    env,
  }) => {
    await seed(env, smallInput(env));
    const page = await openDashboard(env);
    const search = page.getByTestId('search-input');

    // On by default.
    await blur(page);
    await page.keyboard.press('/');
    await expect(search).toBeFocused();
    await blur(page);

    await page.locator('summary', { hasText: 'View options' }).click();
    const control = page.getByTestId('opt-singlekeys');
    await control.selectOption('off');
    await blur(page);
    await page.keyboard.press('/');
    await expect(search).not.toBeFocused();
    await page.keyboard.press('?');
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // Not single keys: they are not affected.
    const palette = await openPalette(page);
    await page.keyboard.press('Escape');
    await expect(palette).toHaveCount(0);
    await blur(page);
    await page.keyboard.press('F6');
    await expect(page.locator(':focus')).not.toHaveCount(0);
    await expect(page.locator('body')).not.toBeFocused();

    // Remembered by this browser.
    await page.reload();
    await settle(page);
    await blur(page);
    await page.keyboard.press('/');
    await expect(search).not.toBeFocused();
    await page.locator('summary', { hasText: 'View options' }).click();
    await expect(page.getByTestId('opt-singlekeys')).toHaveValue('off');

    // And back on from the palette.
    await runCommand(page, 'single-keys-toggle');
    await blur(page);
    await page.keyboard.press('/');
    await expect(search).toBeFocused();
  });

  test('rows grow under a text-spacing override instead of clipping their text (WCAG 1.4.12)', async ({
    env,
  }) => {
    await seed(env, smallInput(env));
    const page = await openDashboard(env);
    const rowsOf = () =>
      page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('.sv-vrow')].map((row) => ({
          height: row.getBoundingClientRect().height,
          // What the row's content needs (its box is what the list sizes the rows to).
          needs: (row.firstElementChild as HTMLElement).getBoundingClientRect().height + 1,
          clipped: row.scrollHeight > row.clientHeight + 1,
        })),
      );
    const before = await rowsOf();
    expect(before.length).toBe(3);
    expect(before.every((r) => !r.clipped)).toBe(true);
    const baseHeight = Math.max(...before.map((r) => r.height));

    // The values WCAG 1.4.12 names, as a user stylesheet would apply them. A constructable sheet:
    // the extension's CSP refuses an inline <style>, but not CSSOM.
    await page.evaluate(() => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(
        '* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }',
      );
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    });
    await expect
      .poll(async () => Math.max(...(await rowsOf()).map((r) => r.height)), {
        message: 'the rows are taller than before the override',
      })
      .toBeGreaterThan(baseHeight);
    const after = await rowsOf();
    for (const row of after) {
      expect(row.clipped, 'no row clips its content').toBe(false);
      expect(row.height).toBeGreaterThanOrEqual(row.needs - 1);
    }
    // Rows do not overlap: each starts where the previous one ends.
    const tops = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('.sv-vrow')].map((row) => ({
        top: row.getBoundingClientRect().top,
        bottom: row.getBoundingClientRect().bottom,
      })),
    );
    for (let i = 1; i < tops.length; i++) {
      expect(Math.abs(tops[i]!.top - tops[i - 1]!.bottom)).toBeLessThan(1.5);
    }
  });

  test('a chain at the depth limit is listed in full and does not overflow a 320 px panel', async ({
    env,
  }) => {
    const folders = Array.from({ length: MAX_FOLDER_DEPTH }, (_, i) => ({
      key: `l${i + 1}`,
      bank: 'deep',
      parent: i === 0 ? null : `l${i}`,
      name: `Level ${i + 1}`,
    }));
    await seed(env, {
      banks: [{ key: 'deep', name: 'Deep' }],
      folders,
      sources: [{ key: 's', url: sourceA(env), title: 'A' }],
      highlights: [
        {
          key: 'h',
          quote: QUOTE_ATP,
          source: 's',
          places: [{ bank: 'deep', folder: `l${MAX_FOLDER_DEPTH}` }],
        },
      ],
    });
    const page = await openDashboard(env);
    await page.setViewportSize({ width: 320, height: 800 });
    await page.getByTestId('toggle-tree').click();
    await expect
      .poll(async () => (await treeOutline(page)).at(-1), { timeout: 15_000 })
      .toBe(`${MAX_FOLDER_DEPTH + 1}:Level ${MAX_FOLDER_DEPTH}`);

    const deepest = treeItem(page, `Level ${MAX_FOLDER_DEPTH}`);
    await deepest.scrollIntoViewIfNeeded();
    const fit = await page.evaluate(() => {
      const panel = document.querySelector('.dash-left') as HTMLElement;
      const items = [...panel.querySelectorAll<HTMLElement>('[role="treeitem"]')];
      const last = items.at(-1)!.getBoundingClientRect();
      const box = panel.getBoundingClientRect();
      return {
        panelScrollsSideways: panel.scrollWidth > panel.clientWidth,
        lastInside: last.left >= box.left - 0.5 && last.right <= box.right + 0.5,
        // The label keeps room: indentation is capped, not proportional to depth.
        labelWidth: items.at(-1)!.querySelector('.dash-tree__name')!.getBoundingClientRect().width,
        pageScrollsSideways:
          document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    });
    expect(fit.panelScrollsSideways).toBe(false);
    expect(fit.lastInside).toBe(true);
    expect(fit.labelWidth).toBeGreaterThan(60);
    expect(fit.pageScrollsSideways).toBe(false);
  });

  test('notifications close on their own, wait under the pointer, and stay when asked to', async ({
    env,
  }) => {
    await seed(env, smallInput(env));
    const dash = await openDashboard(env);

    // Default: closes by itself, a real timer. (A new bank now ends on its own "Bank ready!" screen
    // instead of a notification; a new folder still says so in one.)
    await createFolderUi(dash, 'Cardiology', 'Renal');
    await expect(toast(dash, 'Created folder Renal.')).toBeVisible();
    await expect(toast(dash, 'Created folder Renal.')).toHaveCount(0, { timeout: 12_000 });

    // The viewer asks for them to stay (Settings > Appearance, kept in this browser).
    const ext = await openExt(env, 'options');
    const keep = ext.getByRole('checkbox', {
      name: 'Keep notifications on screen until I close them',
    });
    await expect(keep).not.toBeChecked();
    await keep.check();
    await expect(keep).toBeChecked();
    await ext.close();

    await dash.bringToFront();
    await createFolderUi(dash, 'Cardiology', 'Neuro');
    const kept = toast(dash, 'Created folder Neuro.');
    await expect(kept).toBeVisible();
    // Time itself is the assertion here: the default would have closed it after 5 s.
    await dash.waitForTimeout(6_500);
    await expect(kept).toBeVisible();

    // Escape closes the toast under the pointer.
    await kept.hover();
    await dash.keyboard.press('Escape');
    await expect(kept).toHaveCount(0);
  });
});

// ===============================================================================================
// 4. PDF reader: the keyboard route to the save bar
// ===============================================================================================

test.describe('PDF reader keyboard', () => {
  async function openReaderWith(env: Env, name: string, bytes: Buffer): Promise<Page> {
    const page = await env.context.newPage();
    await page.goto(`chrome-extension://${env.extensionId}/pdf-reader.html`);
    await expect(page.getByTestId('pdf-reader')).toBeVisible();
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByTestId('pdf-choose-file').click(),
    ]);
    await chooser.setFiles({ name, mimeType: 'application/pdf', buffer: bytes });
    await expect(page.getByTestId('pdf-viewer')).toBeVisible({ timeout: 30_000 });
    const layer = page.locator('[data-testid="pdf-page-1"] .sv-textlayer');
    await expect(layer).toBeAttached({ timeout: 30_000 });
    await expect
      .poll(async () => ((await layer.textContent()) ?? '').trim().length)
      .toBeGreaterThan(0);
    return page;
  }

  /** What a caret-browsing user ends up with: a text selection, with focus left on the viewer. */
  async function selectLikeCaretBrowsing(page: Page, from: string, to: string): Promise<void> {
    await page.evaluate(
      ({ from, to }) => {
        const spans = [
          ...document.querySelectorAll('[data-testid="pdf-page-1"] .sv-textlayer span'),
        ] as HTMLElement[];
        const pick = (needle: string) => spans.find((s) => (s.textContent ?? '').includes(needle));
        const a = pick(from);
        const b = pick(to);
        if (!a?.firstChild || !b?.firstChild) throw new Error('text not found');
        const start = (a.textContent ?? '').indexOf(from);
        const end = (b.textContent ?? '').indexOf(to) + to.length;
        (document.querySelector('[data-testid="pdf-viewer"]') as HTMLElement).focus();
        document.getSelection()!.setBaseAndExtent(a.firstChild, start, b.firstChild, end);
      },
      { from, to },
    );
  }

  test('S or Enter on a selection opens the save bar with focus in it, Escape gives focus back, and nothing selected says how to select', async ({
    env,
  }) => {
    const page = await openReaderWith(env, 'wrapped.pdf', wrappedDoc());
    const viewer = page.getByTestId('pdf-viewer');
    await expect(page.getByTestId('pdf-keyboard-hint')).toContainText('F7');

    // Nothing selected: the reader says what to do, and opens nothing.
    await viewer.focus();
    await page.keyboard.press('s');
    await expect(toast(page, 'Nothing is selected.')).toContainText('F7');
    await expect(page.getByTestId('pdf-savebar')).toHaveCount(0);

    // S: the bar opens and focus moves into it, even before the selection gate's pause is over.
    await selectLikeCaretBrowsing(page, 'glomerulus filters', 'tubule reabsorbs');
    await page.keyboard.press('s');
    await expect(page.getByTestId('pdf-savebar')).toBeVisible();
    await expect(page.getByTestId('pdf-save-kind')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('pdf-savebar')).toHaveCount(0);
    await expect(viewer).toBeFocused();

    // Enter on a selection does the same, and the highlight is saved with the keyboard alone.
    await selectLikeCaretBrowsing(page, 'glomerulus filters', 'tubule reabsorbs');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('pdf-save-kind')).toBeFocused();
    await page.getByTestId('pdf-save').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('pdf-highlight-card').first()).toContainText(
      'glomerulus filters plasma',
    );
  });
});

// ===============================================================================================
// 5. The focus-search hand-over
// ===============================================================================================

test.describe('focus-search', () => {
  /** What the worker's command handler writes for a surface (entrypoints/background/platform.ts). */
  async function handOver(ctrl: Page, target: 'panel' | 'dashboard'): Promise<void> {
    await ctrl.evaluate((value) => chrome.storage.session.set({ 'sv.pendingSearch': value }), {
      target,
      at: Date.now(),
    });
  }

  test('the side panel switches to Search and puts the cursor in the box', async ({ env }) => {
    const ctrl = await openControl(env);
    const panel = await openExt(env, 'sidepanel');
    await expect(panel.getByRole('tab', { name: /This page/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    await handOver(ctrl, 'panel');
    await expect(panel.getByRole('tab', { name: 'Search' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(
      panel.getByRole('searchbox', { name: 'Search highlights and notes' }),
    ).toBeFocused();
    await expect
      .poll(() => ctrl.evaluate(() => chrome.storage.session.get('sv.pendingSearch')))
      .toEqual({});
  });

  test("the dashboard takes it for its own search box, and leaves the panel's request alone", async ({
    env,
  }) => {
    const ctrl = await openControl(env);
    const page = await openDashboard(env);
    const search = page.getByTestId('search-input');
    await blur(page);

    await handOver(ctrl, 'panel');
    await expect
      .poll(() => ctrl.evaluate(() => chrome.storage.session.get('sv.pendingSearch')))
      .toMatchObject({ 'sv.pendingSearch': { target: 'panel' } });
    await expect(search).not.toBeFocused();

    await handOver(ctrl, 'dashboard');
    await expect(search).toBeFocused();
  });
});
