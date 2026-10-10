import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import {
  OVERLAY_HOST,
  activate,
  dragSelect,
  expect,
  openFixture,
  paintedNormalised,
  selectionSnapshot,
  storedHighlights,
  test,
  textPoints,
  toolbarOf,
  tripleClick,
  type Env,
} from './helpers.compat';

/** WCAG 2.2 AA (axe tags). Best-practice rules are deliberately not part of the acceptance gate. */
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];

const KIND_ORDER = [
  'Save selection',
  'Save as Essential fact',
  'Save as Formula',
  'Save as Exception',
  'Save as Differential',
  'Save as Weak area',
  'Save as Verified correction',
  'Save as Question',
  'Add a note',
  'More options',
];

interface Violation {
  id: string;
  impact?: string | null;
  help: string;
  nodes: Array<{ target: unknown; failureSummary?: string; html: string }>;
}

async function axeViolations(page: Page, include?: string): Promise<Violation[]> {
  let builder = new AxeBuilder({ page }).withTags(WCAG_TAGS);
  if (include) builder = builder.include(include);
  const results = await builder.analyze();
  return results.violations as unknown as Violation[];
}

function format(violations: Violation[]): string {
  return violations
    .map((v) => {
      const nodes = v.nodes
        .slice(0, 4)
        .map(
          (n) =>
            `    - ${JSON.stringify(n.target)}\n      ${n.html.slice(0, 160)}\n      ${(n.failureSummary ?? '').replace(/\n/g, ' | ')}`,
        )
        .join('\n');
      return `[${v.impact ?? 'n/a'}] ${v.id}: ${v.help} (${v.nodes.length} node(s))\n${nodes}`;
    })
    .join('\n');
}

async function expectNoViolations(page: Page, include?: string): Promise<void> {
  const violations = await axeViolations(page, include);
  expect(violations, format(violations)).toEqual([]);
}

async function overlayFocusedLabel(page: Page): Promise<string> {
  return page.evaluate((host) => {
    const root = document.querySelector(host)?.shadowRoot;
    const el = root?.activeElement;
    if (!el) return '';
    return el.getAttribute('aria-label') ?? el.textContent?.trim() ?? el.localName;
  }, OVERLAY_HOST);
}

const focusShortcut = (page: Page) => page.keyboard.press('Alt+Shift+KeyT');
const bar = (page: Page) => toolbarOf(page);

async function selectInFocusRegion(page: Page, text = 'phosphorylates glucose'): Promise<void> {
  await dragSelect(page, { selector: '#focus-p', text });
  await expect(bar(page)).toBeVisible();
}

async function pageActiveId(page: Page): Promise<string> {
  return page.evaluate(() => document.activeElement?.id ?? document.activeElement?.localName ?? '');
}

// ---------------------------------------------------------------------------------------------
// In-page overlay: axe + structure
// ---------------------------------------------------------------------------------------------

test.describe('overlay: axe WCAG 2.2 AA', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test.describe(`prefers-color-scheme: ${scheme}`, () => {
      test(`toolbar (${scheme})`, async ({ env }) => {
        const page = await openFixture(env, '/article.html');
        await page.emulateMedia({ colorScheme: scheme });
        await tripleClick(page, '#p-intro');
        await expect(bar(page)).toBeVisible();
        await expectNoViolations(page, OVERLAY_HOST);
      });

      test(`Add a note composer (${scheme})`, async ({ env }) => {
        const page = await openFixture(env, '/article.html');
        await page.emulateMedia({ colorScheme: scheme });
        await tripleClick(page, '#p-intro');
        await page.getByRole('button', { name: 'Add a note' }).click();
        await expect(page.getByRole('dialog', { name: 'Add a note' })).toBeVisible();
        await expectNoViolations(page, OVERLAY_HOST);
      });

      test(`More options panel and new-bank form (${scheme})`, async ({ env }) => {
        const page = await openFixture(env, '/article.html');
        await page.emulateMedia({ colorScheme: scheme });
        await tripleClick(page, '#p-intro');
        await page.getByRole('button', { name: 'More options' }).click();
        await expect(page.getByRole('combobox', { name: 'Bank' })).toBeVisible();
        await expectNoViolations(page, OVERLAY_HOST);
        await page.getByRole('button', { name: 'New bank' }).click();
        await expect(page.getByRole('textbox', { name: 'Bank name' })).toBeVisible();
        await expectNoViolations(page, OVERLAY_HOST);
        // The inline validation error state.
        await page.getByRole('button', { name: 'Create' }).click();
        await expect(page.getByText('Enter a name for the bank.')).toBeVisible();
        await expectNoViolations(page, OVERLAY_HOST);
      });

      test(`highlight popover (${scheme})`, async ({ env }) => {
        const page = await openFixture(env, '/article.html');
        await page.emulateMedia({ colorScheme: scheme });
        await tripleClick(page, '#p-intro');
        await page.getByRole('button', { name: 'Save selection' }).click();
        await expect(page.getByText('Saved to Inbox')).toBeVisible();
        await page.getByRole('button', { name: 'Dismiss notification' }).click();
        // A real click on the painted text opens the popover.
        const p = await textPoints(page, { selector: '#p-intro', text: 'primary pacemaker' });
        await page.mouse.click(p.start.x + 20, p.start.y);
        await expect(page.getByRole('dialog', { name: 'Highlight details' })).toBeVisible();
        await expectNoViolations(page, OVERLAY_HOST);
      });

      test(`toasts: success with Undo (${scheme})`, async ({ env }) => {
        const page = await openFixture(env, '/article.html');
        await page.emulateMedia({ colorScheme: scheme });
        await tripleClick(page, '#p-intro');
        await page.getByRole('button', { name: 'Save selection' }).click();
        await expect(page.getByText('Saved to Inbox')).toBeVisible();
        await expectNoViolations(page, OVERLAY_HOST);
      });
    });
  }

  test('error toast and inline error states', async ({ env }) => {
    const page = await openFixture(env, '/article.html');
    await tripleClick(page, '#p-intro');
    await page.getByRole('button', { name: 'Save selection' }).click();
    await expect(page.getByText('Saved to Inbox')).toBeVisible();
    // The highlight disappears behind the overlay's back (another tab / the side panel deleted it).
    const stored = await storedHighlights(env, page);
    expect(stored).toHaveLength(1);
    await softDeleteFromExtension(env, page, stored[0]!.id);
    // Undo now fails: the error is announced through the alert region.
    await page.getByRole('button', { name: 'Undo' }).click();
    const alert = page.getByRole('alert').filter({ hasText: /./ });
    await expect(alert.first()).toBeVisible();
    await expectNoViolations(page, OVERLAY_HOST);
  });
});

async function softDeleteFromExtension(env: Env, page: Page, id: string): Promise<void> {
  const ext = await env.context.newPage();
  try {
    await ext.goto(`chrome-extension://${env.extensionId}/options.html`);
    const res = await ext.evaluate(
      (payload) => chrome.runtime.sendMessage({ v: 1, type: 'highlight.delete', payload }),
      { id },
    );
    if (!res?.ok) throw new Error(`highlight.delete failed: ${JSON.stringify(res)}`);
  } finally {
    await ext.close();
  }
  void page;
}

test.describe('overlay: semantics', () => {
  // Guards the zero-violation results above against a scanner that silently skips the shadow root.
  test('axe canary: a deliberately broken control inside the overlay IS reported', async ({
    env,
  }) => {
    const page = await openFixture(env, '/article.html');
    await tripleClick(page, '#p-intro');
    await expect(bar(page)).toBeVisible();
    await page.evaluate((host) => {
      const root = document.querySelector(host)!.shadowRoot!;
      const b = root.querySelector('[role="toolbar"] button')!;
      b.removeAttribute('aria-label');
      b.removeAttribute('title');
      b.textContent = '';
    }, OVERLAY_HOST);
    const violations = await axeViolations(page, OVERLAY_HOST);
    expect(violations.map((v) => v.id)).toContain('button-name');
  });

  test('toolbar exposes a named toolbar of named, label-in-name buttons with one tab stop', async ({
    env,
  }) => {
    const page = await openFixture(env, '/article.html');
    await tripleClick(page, '#p-intro');
    await expect(bar(page)).toBeVisible();
    const info = await bar(page).evaluate((el) => {
      const buttons = Array.from(el.querySelectorAll('button'));
      return {
        role: el.getAttribute('role'),
        label: el.getAttribute('aria-label'),
        shortcut: el.getAttribute('aria-keyshortcuts'),
        names: buttons.map((b) => b.getAttribute('aria-label') ?? ''),
        visible: buttons.map((b) => (b.innerText || '').trim()),
        tabIndexes: buttons.map((b) => b.tabIndex),
        types: buttons.map((b) => b.getAttribute('type')),
      };
    });
    expect(info.role).toBe('toolbar');
    expect(info.label).toBe('StudyVault: save selected text');
    expect(info.shortcut).toBe('Alt+Shift+T');
    expect(info.names).toEqual(KIND_ORDER);
    // WCAG 2.5.3 Label in Name: a visible text label is contained in the accessible name.
    info.visible.forEach((text, i) => {
      if (/^[A-Za-z]+$/.test(text)) {
        expect(info.names[i]!.toLowerCase(), `button ${i} visible "${text}"`).toContain(
          text.toLowerCase(),
        );
      }
    });
    expect(info.tabIndexes.filter((t) => t === 0)).toHaveLength(1);
    expect(info.types.every((t) => t === 'button')).toBe(true);
  });

  test('live regions exist before any toast so announcements are not missed', async ({ env }) => {
    const page = await openFixture(env, '/article.html');
    const regions = await page.evaluate((host) => {
      const root = document.querySelector(host)!.shadowRoot!;
      return {
        status: root.querySelectorAll('[role="status"][aria-live="polite"]').length,
        alert: root.querySelectorAll('[role="alert"]').length,
      };
    }, OVERLAY_HOST);
    expect(regions).toEqual({ status: 1, alert: 1 });

    await tripleClick(page, '#p-intro');
    await page.getByRole('button', { name: 'Save selection' }).click();
    // The success toast is inside the polite status region, not the assertive alert region.
    await expect(page.getByRole('status').filter({ hasText: 'Saved to Inbox' })).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: 'Saved to Inbox' })).toHaveCount(0);
  });

  test('panel buttons expose expanded state and the dialogs are named', async ({ env }) => {
    const page = await openFixture(env, '/article.html');
    await tripleClick(page, '#p-intro');
    const note = page.getByRole('button', { name: 'Add a note' });
    const more = page.getByRole('button', { name: 'More options' });
    await expect(note).toHaveAttribute('aria-expanded', 'false');
    await note.click();
    await expect(note).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('dialog', { name: 'Add a note' })).toBeVisible();
    await more.click();
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    await expect(note).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('dialog', { name: 'Save with details' })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------------------------
// Keyboard-only operation
// ---------------------------------------------------------------------------------------------

test.describe('keyboard-only', () => {
  test('Alt+Shift+T focuses the toolbar and arrow keys rove through every button', async ({
    env,
  }) => {
    const page = await openFixture(env, '/compat-inline.html');
    await selectInFocusRegion(page);
    expect(await pageActiveId(page), 'mouse selection left the focusable region focused').toBe(
      'focus-region',
    );

    await focusShortcut(page);
    await expect(page.getByRole('button', { name: 'Save selection', exact: true })).toBeFocused();
    expect(await overlayFocusedLabel(page)).toBe('Save selection');

    const seen: string[] = [await overlayFocusedLabel(page)];
    for (let i = 0; i < KIND_ORDER.length - 1; i++) {
      await page.keyboard.press('ArrowRight');
      seen.push(await overlayFocusedLabel(page));
    }
    expect(seen).toEqual(KIND_ORDER);

    // Wrap-around, Home and End.
    await page.keyboard.press('ArrowRight');
    expect(await overlayFocusedLabel(page)).toBe('Save selection');
    await page.keyboard.press('ArrowLeft');
    expect(await overlayFocusedLabel(page)).toBe('More options');
    await page.keyboard.press('Home');
    expect(await overlayFocusedLabel(page)).toBe('Save selection');
    await page.keyboard.press('End');
    expect(await overlayFocusedLabel(page)).toBe('More options');

    // Roving tabindex follows the focus: exactly one tab stop, on the focused button.
    const stops = await bar(page).evaluate((el) =>
      Array.from(el.querySelectorAll('button')).map((b) => b.tabIndex),
    );
    expect(stops.filter((t) => t === 0)).toHaveLength(1);
    expect(stops[stops.length - 1]).toBe(0);
  });

  test('Alt+Shift+T moves focus to a toolbar button that shows a visible focus ring (WCAG 2.4.7)', async ({
    env,
  }) => {
    const page = await openFixture(env, '/compat-inline.html');
    await selectInFocusRegion(page);
    await focusShortcut(page);
    const saveButton = page.getByRole('button', { name: 'Save selection', exact: true });
    await expect(saveButton).toBeFocused();
    const ring = await saveButton.evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        focusVisible: el.matches(':focus-visible'),
        style: s.outlineStyle,
        width: parseFloat(s.outlineWidth),
      };
    });
    expect(ring, 'the focused button must have a visible indicator').toMatchObject({
      style: 'solid',
    });
    expect(ring.width).toBeGreaterThanOrEqual(2);
  });

  test('Alt+Shift+T moves focus to the toast Undo button with a visible focus ring (WCAG 2.4.7)', async ({
    env,
  }) => {
    const page = await openFixture(env, '/compat-inline.html');
    await selectInFocusRegion(page);
    await page.getByRole('button', { name: 'Save selection', exact: true }).click();
    await expect(page.getByText('Saved to Inbox')).toBeVisible();
    await focusShortcut(page);
    const undo = page.getByRole('button', { name: 'Undo' });
    await expect(undo).toBeFocused();
    const ring = await undo.evaluate((el) => {
      const s = getComputedStyle(el);
      return { style: s.outlineStyle, width: parseFloat(s.outlineWidth) };
    });
    expect(ring, 'the focused Undo button must have a visible indicator').toMatchObject({
      style: 'solid',
    });
    expect(ring.width).toBeGreaterThanOrEqual(2);
  });

  test('Enter on a kind button saves that kind and returns focus to the page element', async ({
    env,
  }) => {
    const page = await openFixture(env, '/compat-inline.html');
    await selectInFocusRegion(page);
    await focusShortcut(page);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    expect(await overlayFocusedLabel(page)).toBe('Save as Formula');
    await page.keyboard.press('Enter');
    await expect(page.getByText('Saved to Inbox')).toBeVisible();
    await expect(bar(page)).toHaveCount(0);
    const [h] = await storedHighlights(env, page);
    expect(h!.kind).toBe('formula');
    expect(h!.exactQuote).toBe('phosphorylates glucose');
    expect(await pageActiveId(page), 'focus is restored to the page').toBe('focus-region');
    await expect.poll(() => paintedNormalised(page)).toEqual(['phosphorylates glucose']);
  });

  test('Space also activates a toolbar button', async ({ env }) => {
    const page = await openFixture(env, '/compat-inline.html');
    await selectInFocusRegion(page);
    await focusShortcut(page);
    await page.keyboard.press('Space');
    await expect(page.getByText('Saved to Inbox')).toBeVisible();
    expect(await storedHighlights(env, page)).toHaveLength(1);
  });

  test('Escape closes the toolbar, clears the selection and restores page focus', async ({
    env,
  }) => {
    const page = await openFixture(env, '/compat-inline.html');
    await selectInFocusRegion(page);
    await focusShortcut(page);
    await expect(page.getByRole('button', { name: 'Save selection', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(bar(page)).toHaveCount(0);
    expect(await pageActiveId(page), 'focus is restored to the page').toBe('focus-region');
    const sel = await selectionSnapshot(page);
    expect(sel.text, 'dismissing clears the page selection so the toolbar does not return').toBe(
      '',
    );
    expect(await storedHighlights(env, page)).toEqual([]);
  });

  test('Add a note by keyboard: focus moves into the note, Escape steps back one level at a time', async ({
    env,
  }) => {
    const page = await openFixture(env, '/compat-inline.html');
    await selectInFocusRegion(page);
    await focusShortcut(page);
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowLeft');
    expect(await overlayFocusedLabel(page)).toBe('Add a note');
    await page.keyboard.press('Enter');

    const note = page.getByRole('textbox', { name: 'Note' });
    await expect(note).toBeFocused();
    await page.keyboard.type('mnemonic: hexokinase traps glucose');
    // Escape closes only the panel and returns to the button that opened it.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Add a note' })).toHaveCount(0);
    await expect(bar(page)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add a note' })).toBeFocused();
    // A second Escape closes the toolbar and returns to the page.
    await page.keyboard.press('Escape');
    await expect(bar(page)).toHaveCount(0);
    expect(await pageActiveId(page)).toBe('focus-region');
  });

  test('Add a note by keyboard: Ctrl+Enter saves the note with the quote', async ({ env }) => {
    const page = await openFixture(env, '/compat-inline.html');
    await selectInFocusRegion(page);
    await focusShortcut(page);
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('textbox', { name: 'Note' })).toBeFocused();
    await page.keyboard.type('hexokinase traps glucose');
    await page.keyboard.press('Control+Enter');
    await expect(page.getByText('Saved to Inbox')).toBeVisible();
    const [h] = await storedHighlights(env, page);
    expect(h!.exactQuote).toBe('phosphorylates glucose');
    expect(h!.userComment).toBe('hexokinase traps glucose');
    expect(await pageActiveId(page)).toBe('focus-region');
  });

  test('More options by keyboard: Tab from the note reaches Save, Enter saves', async ({ env }) => {
    const page = await openFixture(env, '/compat-inline.html');
    await selectInFocusRegion(page);
    await focusShortcut(page);
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('combobox', { name: 'Bank' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Note' })).toBeFocused();
    await page.keyboard.press('Tab');
    const dialog = page.getByRole('dialog', { name: 'Save with details' });
    await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Enter');
    await expect(page.getByText('Saved to Inbox')).toBeVisible();
    expect(await storedHighlights(env, page)).toHaveLength(1);
  });

  test('toast Undo is reachable and operable with the keyboard', async ({ env }) => {
    const page = await openFixture(env, '/compat-inline.html');
    await selectInFocusRegion(page);
    await page.getByRole('button', { name: 'Save selection', exact: true }).click();
    await expect(page.getByText('Saved to Inbox')).toBeVisible();
    await expect.poll(() => paintedNormalised(page)).toHaveLength(1);

    await focusShortcut(page);
    await expect(page.getByRole('button', { name: 'Undo' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Save undone')).toBeVisible();
    await expect.poll(() => paintedNormalised(page)).toEqual([]);
    expect(await pageActiveId(page), 'focus is restored to the page').toBe('focus-region');
  });

  test('highlight popover: focus moves in, Escape closes and restores focus', async ({ env }) => {
    const page = await openFixture(env, '/compat-inline.html');
    await selectInFocusRegion(page);
    await page.getByRole('button', { name: 'Save selection', exact: true }).click();
    await expect(page.getByText('Saved to Inbox')).toBeVisible();
    await page.getByRole('button', { name: 'Dismiss notification' }).click();

    const p = await textPoints(page, { selector: '#focus-p', text: 'phosphorylates glucose' });
    await page.mouse.click(p.start.x + 15, p.start.y);
    const dialog = page.getByRole('dialog', { name: 'Highlight details' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toBeFocused();
    // Tab order stays inside the popover controls in reading order.
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Close highlight details' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('textbox', { name: 'Note' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect(await pageActiveId(page)).toBe('focus-region');
  });

  test('keyboard-only flow works with the keyboard-extended selection', async ({ env }) => {
    const page = await openFixture(env, '/compat-inline.html');
    await selectInFocusRegion(page, 'Hexokinase');
    for (let i = 0; i < 8; i++) await page.keyboard.press('Shift+ArrowRight');
    await expect.poll(async () => (await selectionSnapshot(page)).text).toBe('Hexokinase phospho');
    await expect(bar(page)).toBeVisible();
    await focusShortcut(page);
    await page.keyboard.press('Enter');
    await expect(page.getByText('Saved to Inbox')).toBeVisible();
    const [h] = await storedHighlights(env, page);
    expect(h!.exactQuote).toBe('Hexokinase phospho');
  });
});

// ---------------------------------------------------------------------------------------------
// Extension pages (analysed directly)
// ---------------------------------------------------------------------------------------------

test.describe('extension pages: axe WCAG 2.2 AA', () => {
  async function extensionPage(env: Env, file: string): Promise<Page> {
    const page = await env.context.newPage();
    await page.goto(`chrome-extension://${env.extensionId}/${file}`);
    return page;
  }

  // Guards the zero-violation results below against a scanner that cannot analyse extension pages.
  test('axe canary: a deliberately broken control on an extension page IS reported', async ({
    env,
  }) => {
    const page = await extensionPage(env, 'options.html');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.evaluate(() => {
      document.body.insertAdjacentHTML(
        'beforeend',
        '<button id="canary"></button><img src="x.png">',
      );
    });
    const ids = (await axeViolations(page)).map((v) => v.id);
    expect(ids).toEqual(expect.arrayContaining(['button-name', 'image-alt']));
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`options.html (${scheme})`, async ({ env }) => {
      const page = await extensionPage(env, 'options.html');
      await page.emulateMedia({ colorScheme: scheme });
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.getByText('Loading settings')).toHaveCount(0);
      await expectNoViolations(page);
    });

    test(`popup.html on a browser-internal tab (${scheme})`, async ({ env }) => {
      const page = await extensionPage(env, 'popup.html');
      await page.emulateMedia({ colorScheme: scheme });
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.getByText('Checking this tab')).toHaveCount(0);
      await expectNoViolations(page);
    });

    test(`popup.html for an inactive and then an active page (${scheme})`, async ({ env }) => {
      const popup = await extensionPage(env, 'popup.html');
      await popup.emulateMedia({ colorScheme: scheme });
      const page = await openFixture(env, '/article.html', { activate: false });
      await page.bringToFront();
      await expect(popup.getByRole('button', { name: 'Activate on this tab' })).toBeVisible();
      await expectNoViolations(popup);

      await activate(env, page);
      await tripleClick(page, '#p-intro');
      await page.getByRole('button', { name: 'Save selection', exact: true }).click();
      await expect(page.getByText('Saved to Inbox')).toBeVisible();
      await page.bringToFront();
      await expect(popup.getByText('Active on this tab only')).toBeVisible();
      await expect(popup.getByText('Recent saves')).toBeVisible();
      await expectNoViolations(popup);
    });

    test(`sidepanel.html for an inactive and then a live page (${scheme})`, async ({ env }) => {
      const panel = await extensionPage(env, 'sidepanel.html');
      await panel.emulateMedia({ colorScheme: scheme });
      const page = await openFixture(env, '/article.html', { activate: false });
      await page.bringToFront();
      await expect(panel.getByRole('button', { name: 'Activate on this tab' })).toBeVisible();
      await expectNoViolations(panel);

      await activate(env, page);
      await tripleClick(page, '#p-intro');
      await page.getByRole('button', { name: 'Save selection', exact: true }).click();
      await expect(page.getByText('Saved to Inbox')).toBeVisible();
      await page.bringToFront();
      await expect(panel.getByText('Highlights on this page')).toBeVisible();
      await expectNoViolations(panel);

      // The "Recent" view of the same panel.
      await panel.getByRole('tab', { name: /Recent/ }).click();
      await expectNoViolations(panel);
    });
  }
});
