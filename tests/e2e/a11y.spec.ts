import AxeBuilder from '@axe-core/playwright';
import { settleAnimations } from './axeSettle';
import type { Page } from '@playwright/test';
import { HIGHLIGHT_KINDS, KIND_LABELS } from '@shared';
import {
  OVERLAY_HOST,
  activate,
  backgroundRpc,
  dragSelect,
  expect,
  focusToolbar,
  openFixture,
  paintedNormalised,
  removeHighlightRow,
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

/** The note button saves with the default kind and hands the note over to the side panel (ADR-005). */
const NOTE_BUTTON = 'Save and add a note in the side panel';

/** The bank chip names the bank every save from the toolbar goes to: the Inbox in a fresh vault. */
const BANK_CHIP = 'Bank: Inbox';

const KIND_BUTTONS = HIGHLIGHT_KINDS.map((kind) => `Save as ${KIND_LABELS[kind].label}`);

/**
 * Toolbar buttons in DOM order (UX_DESIGN 7.6): the seven kind dots, Save, Note, the bank chip, More.
 * The kind buttons are named after the product's own kind labels.
 */
const KIND_ORDER = [...KIND_BUTTONS, 'Save selection', NOTE_BUTTON, BANK_CHIP, 'More options'];

/** The roving tab stop starts on Save (the one-click default), so arrows visit from there on. */
const ROVE_FROM_SAVE = [
  ...KIND_ORDER.slice(KIND_ORDER.indexOf('Save selection')),
  ...KIND_ORDER.slice(0, KIND_ORDER.indexOf('Save selection')),
];

interface Violation {
  id: string;
  impact?: string | null;
  help: string;
  nodes: Array<{ target: unknown; failureSummary?: string; html: string }>;
}

async function axeViolations(page: Page, include?: string): Promise<Violation[]> {
  await settleAnimations(page);
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

const bar = (page: Page) => toolbarOf(page);

/**
 * The manifest command "focus-toolbar" (the in-page Alt+Shift+T is gone: it collided with Chrome's own
 * accelerator and a page-level key handler swallowed it). Chrome delivers the command to the worker,
 * which sends TabRpc content.focusToolbar; Playwright cannot press manifest shortcuts, so the same
 * message is sent from an extension page.
 */
async function pressFocusToolbar(env: Env, page: Page): Promise<void> {
  expect(await focusToolbar(env, page), 'content.focusToolbar found something to focus').toBe(true);
}

async function selectInFocusRegion(page: Page, text = 'phosphorylates glucose'): Promise<void> {
  await dragSelect(page, { selector: '#focus-p', text });
  await expect(bar(page)).toBeVisible();
  // The chip reads just "Bank" until the bank list has loaded; the button order is final after that.
  await expect(page.getByRole('button', { name: BANK_CHIP })).toBeVisible();
}

async function pageActiveId(page: Page): Promise<string> {
  return page.evaluate(() => document.activeElement?.id ?? document.activeElement?.localName ?? '');
}

// ---------------------------------------------------------------------------------------------
// In-page overlay: axe + structure
// ---------------------------------------------------------------------------------------------

/** Replace the note of a stored highlight through the same RPC the side panel uses. */
async function setNoteFromExtension(env: Env, id: string, userComment: string): Promise<void> {
  const res = await backgroundRpc(env, 'highlight.update', { id, patch: { userComment } });
  if (!res.ok) throw new Error(`highlight.update failed: ${JSON.stringify(res)}`);
}

/** Free-text controls inside the overlay's shadow root (there must be none: ADR-005). */
async function overlayTextControls(page: Page): Promise<string[]> {
  return page.evaluate((host) => {
    const root = document.querySelector(host)?.shadowRoot;
    if (!root) throw new Error('overlay shadow root is not reachable');
    return Array.from(root.querySelectorAll<HTMLElement>('*'))
      .filter(
        (el) =>
          el.localName === 'input' ||
          el.localName === 'textarea' ||
          el.isContentEditable ||
          ['textbox', 'searchbox'].includes(el.getAttribute('role') ?? ''),
      )
      .map((el) => `${el.localName}[role=${el.getAttribute('role') ?? ''}]`);
  }, OVERLAY_HOST);
}

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

      test(`toolbar with a button caption shown (${scheme})`, async ({ env }) => {
        const page = await openFixture(env, '/article.html');
        await page.emulateMedia({ colorScheme: scheme });
        await tripleClick(page, '#p-intro');
        await page.getByRole('button', { name: 'Save as Formula' }).hover();
        await expect(page.locator(`${OVERLAY_HOST} .sv-caption`)).toHaveText('Save as Formula');
        await expectNoViolations(page, OVERLAY_HOST);
      });

      test(`note hand-over notice after "${NOTE_BUTTON}" (${scheme})`, async ({ env }) => {
        const page = await openFixture(env, '/article.html');
        await page.emulateMedia({ colorScheme: scheme });
        await tripleClick(page, '#p-intro');
        await page.getByRole('button', { name: NOTE_BUTTON }).click();
        // Saved first (default kind), then the side panel is asked to open on the new highlight.
        await expect(page.getByText(/^Saved/).first()).toBeVisible();
        await expect.poll(async () => (await storedHighlights(env, page)).length).toBe(1);
        await expectNoViolations(page, OVERLAY_HOST);
      });

      test(`More options panel (${scheme})`, async ({ env }) => {
        const page = await openFixture(env, '/article.html');
        await page.emulateMedia({ colorScheme: scheme });
        await tripleClick(page, '#p-intro');
        await page.getByRole('button', { name: 'More options' }).click();
        const dialog = page.getByRole('dialog', { name: 'Save with details' });
        await expect(dialog.getByRole('combobox', { name: 'Bank' })).toBeVisible();
        await expect(dialog.getByRole('button', { name: 'New bank...' })).toBeVisible();
        // ADR-005: pickers only. Nothing in the panel takes typed text.
        await expect(dialog.getByRole('textbox')).toHaveCount(0);
        expect(await overlayTextControls(page)).toEqual([]);
        await expectNoViolations(page, OVERLAY_HOST);
      });

      test(`bank menu (${scheme})`, async ({ env }) => {
        const page = await openFixture(env, '/article.html');
        await page.emulateMedia({ colorScheme: scheme });
        await tripleClick(page, '#p-intro');
        await page.getByRole('button', { name: BANK_CHIP }).click();
        const menu = page.getByRole('menu', { name: 'Save to bank' });
        await expect(
          menu.getByRole('menuitemradio', { name: 'Inbox', checked: true }),
        ).toBeVisible();
        await expect(menu.getByRole('menuitem', { name: 'New bank...' })).toBeVisible();
        await expectNoViolations(page, OVERLAY_HOST);
      });

      test(`highlight popover without and with a note (${scheme})`, async ({ env }) => {
        const page = await openFixture(env, '/article.html');
        await page.emulateMedia({ colorScheme: scheme });
        await tripleClick(page, '#p-intro');
        await page.getByRole('button', { name: 'Save selection' }).click();
        await expect(page.getByText('Saved to Inbox')).toBeVisible();
        await page.getByRole('button', { name: 'Dismiss notification' }).click();
        // A real click on the painted text opens the popover.
        const p = await textPoints(page, { selector: '#p-intro', text: 'primary pacemaker' });
        await page.mouse.click(p.start.x + 20, p.start.y);
        const dialog = page.getByRole('dialog', { name: 'Highlight details' });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByText('No note yet.')).toBeVisible();
        await expect(dialog.getByRole('button', { name: 'Edit note in side panel' })).toBeVisible();
        await expect(dialog.getByRole('textbox')).toHaveCount(0);
        await expectNoViolations(page, OVERLAY_HOST);

        // The note is shown read-only once it exists (it is typed in the side panel).
        const [h] = await storedHighlights(env, page);
        await setNoteFromExtension(env, h!.id, 'Resting rate is about seventy beats per minute.');
        // The page learns of an edit made elsewhere through the (debounced) data-change refresh, so
        // the popover is opened again until it carries the note.
        await expect(async () => {
          await page.keyboard.press('Escape');
          await expect(dialog).toHaveCount(0);
          await page.mouse.click(p.start.x + 20, p.start.y);
          await expect(
            dialog.getByText('Resting rate is about seventy beats per minute.'),
          ).toBeVisible({ timeout: 1_000 });
        }).toPass({ timeout: 15_000 });
        await expect(dialog.getByRole('textbox')).toHaveCount(0);
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
    // The highlight's row disappears behind the overlay's back (all data deleted, a restore from an
    // older backup). A repeated delete of a SOFT-deleted row is idempotent now, so it has to be
    // gone for good for Undo to fail.
    const stored = await storedHighlights(env, page);
    expect(stored).toHaveLength(1);
    await removeHighlightRow(env, stored[0]!.id);
    // Undo now fails: the error is announced through the alert region.
    await page.getByRole('button', { name: 'Undo' }).click();
    const alert = page.getByRole('alert').filter({ hasText: /./ });
    await expect(alert.first()).toBeVisible();
    await expectNoViolations(page, OVERLAY_HOST);
  });
});

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
    await expect(page.getByRole('button', { name: BANK_CHIP })).toBeVisible();
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
    // The focus key is a remappable manifest command now; the page cannot know what the user chose.
    expect(info.shortcut, 'no fixed aria-keyshortcuts: the key belongs to the user').toBeNull();
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
        // The silent announcer (CaptureUi.announce) is a plain aria-live region, not a second status.
        announcer: root.querySelectorAll('[data-sv-announcer][aria-live="polite"]').length,
        announcerRole: root.querySelector('[data-sv-announcer]')?.getAttribute('role') ?? null,
      };
    }, OVERLAY_HOST);
    expect(regions).toEqual({ status: 1, alert: 1, announcer: 1, announcerRole: null });

    await tripleClick(page, '#p-intro');
    await page.getByRole('button', { name: 'Save selection' }).click();
    // The success toast is inside the polite status region, not the assertive alert region.
    await expect(page.getByRole('status').filter({ hasText: 'Saved to Inbox' })).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: 'Saved to Inbox' })).toHaveCount(0);
  });

  test('only More options and the bank chip open popups; they expose their state and the popups are named', async ({
    env,
  }) => {
    const page = await openFixture(env, '/article.html');
    await tripleClick(page, '#p-intro');
    const note = page.getByRole('button', { name: NOTE_BUTTON });
    const more = page.getByRole('button', { name: 'More options' });
    const chip = page.getByRole('button', { name: BANK_CHIP });
    // The note button is an action (save + hand over), not a panel: it has no expanded state.
    await expect(note).not.toHaveAttribute('aria-expanded', /.*/);
    await expect(note).not.toHaveAttribute('aria-haspopup', /.*/);
    await expect(more).toHaveAttribute('aria-haspopup', 'dialog');
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await more.click();
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('dialog', { name: 'Save with details' })).toBeVisible();
    await more.click();
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('dialog', { name: 'Save with details' })).toHaveCount(0);

    // The bank chip is a menu button.
    await expect(chip).toHaveAttribute('aria-haspopup', 'menu');
    await expect(chip).toHaveAttribute('aria-expanded', 'false');
    await chip.click();
    await expect(chip).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('menu', { name: 'Save to bank' })).toBeVisible();
    await chip.click();
    await expect(chip).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('menu', { name: 'Save to bank' })).toHaveCount(0);
  });

  test('the full name of the hovered or focused button is shown in an aria-hidden caption', async ({
    env,
  }) => {
    const page = await openFixture(env, '/compat-inline.html');
    await selectInFocusRegion(page);
    const caption = page.locator(`${OVERLAY_HOST} .sv-caption`);
    await expect(caption).toHaveAttribute('aria-hidden', 'true');
    await page.getByRole('button', { name: 'Save as Exception' }).hover();
    await expect(caption).toHaveText('Save as Exception');
    await page.mouse.move(2, 2);
    await expect(caption).not.toHaveText('Save as Exception');
    // Keyboard focus shows the same caption.
    await pressFocusToolbar(env, page);
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    await expect(caption).toHaveText('Save as Formula');
  });
});

// ---------------------------------------------------------------------------------------------
// Keyboard-only operation
// ---------------------------------------------------------------------------------------------

test.describe('keyboard-only', () => {
  test('the focus-toolbar command focuses the toolbar and arrow keys rove through every button', async ({
    env,
  }) => {
    const page = await openFixture(env, '/compat-inline.html');
    await selectInFocusRegion(page);
    expect(await pageActiveId(page), 'mouse selection left the focusable region focused').toBe(
      'focus-region',
    );

    await pressFocusToolbar(env, page);
    await expect(page.getByRole('button', { name: 'Save selection', exact: true })).toBeFocused();
    expect(await overlayFocusedLabel(page)).toBe('Save selection');

    // From Save, Right walks Note, the bank chip and More, wraps to the first kind dot and comes
    // round to Save again: every button once.
    const seen: string[] = [await overlayFocusedLabel(page)];
    for (let i = 0; i < KIND_ORDER.length - 1; i++) {
      await page.keyboard.press('ArrowRight');
      seen.push(await overlayFocusedLabel(page));
    }
    expect(seen).toEqual(ROVE_FROM_SAVE);
    await page.keyboard.press('ArrowRight');
    expect(await overlayFocusedLabel(page)).toBe('Save selection');
    await page.keyboard.press('ArrowLeft');
    expect(await overlayFocusedLabel(page)).toBe(
      KIND_ORDER[KIND_ORDER.indexOf('Save selection') - 1],
    );

    // Home and End, and wrap-around at both ends.
    await page.keyboard.press('Home');
    expect(await overlayFocusedLabel(page)).toBe(KIND_ORDER[0]);
    await page.keyboard.press('ArrowLeft');
    expect(await overlayFocusedLabel(page)).toBe('More options');
    await page.keyboard.press('ArrowRight');
    expect(await overlayFocusedLabel(page)).toBe(KIND_ORDER[0]);
    await page.keyboard.press('End');
    expect(await overlayFocusedLabel(page)).toBe('More options');

    // Roving tabindex follows the focus: exactly one tab stop, on the focused button.
    const stops = await bar(page).evaluate((el) =>
      Array.from(el.querySelectorAll('button')).map((b) => b.tabIndex),
    );
    expect(stops.filter((t) => t === 0)).toHaveLength(1);
    expect(stops[stops.length - 1]).toBe(0);
  });

  test('focus-toolbar reports focused:false when there is nothing to focus', async ({ env }) => {
    const page = await openFixture(env, '/compat-inline.html');
    await page.locator('#focus-region').focus();
    expect(await focusToolbar(env, page), 'no toolbar and no toast with an action').toBe(false);
    expect(await pageActiveId(page), 'the page keeps focus').toBe('focus-region');
  });

  test('the focus-toolbar command moves focus to a button that shows a visible focus ring (WCAG 2.4.7)', async ({
    env,
  }) => {
    const page = await openFixture(env, '/compat-inline.html');
    await selectInFocusRegion(page);
    await pressFocusToolbar(env, page);
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

  test('the focus-toolbar command moves focus to the toast Undo button with a visible focus ring (WCAG 2.4.7)', async ({
    env,
  }) => {
    const page = await openFixture(env, '/compat-inline.html');
    await selectInFocusRegion(page);
    await page.getByRole('button', { name: 'Save selection', exact: true }).click();
    await expect(page.getByText('Saved to Inbox')).toBeVisible();
    // The toast names the way in: the (remappable) "Focus toolbar" shortcut, never a fixed key.
    await expect(page.getByText('Undo: use the Focus toolbar shortcut')).toBeVisible();
    await pressFocusToolbar(env, page);
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
    await pressFocusToolbar(env, page);
    await page.keyboard.press('Home');
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
    await pressFocusToolbar(env, page);
    await page.keyboard.press('Space');
    await expect(page.getByText('Saved to Inbox')).toBeVisible();
    expect(await storedHighlights(env, page)).toHaveLength(1);
  });

  test('Escape closes the toolbar, clears the selection and restores page focus', async ({
    env,
  }) => {
    const page = await openFixture(env, '/compat-inline.html');
    await selectInFocusRegion(page);
    await pressFocusToolbar(env, page);
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

  test('the note button by keyboard saves with the default kind and has no text field to type into', async ({
    env,
  }) => {
    const page = await openFixture(env, '/compat-inline.html');
    await selectInFocusRegion(page);
    await pressFocusToolbar(env, page);
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowLeft');
    expect(await overlayFocusedLabel(page)).toBe(BANK_CHIP);
    await page.keyboard.press('ArrowLeft');
    expect(await overlayFocusedLabel(page)).toBe(NOTE_BUTTON);
    await page.keyboard.press('Enter');

    // Saved at once with the default kind and no comment: the note is typed in the side panel.
    await expect.poll(async () => (await storedHighlights(env, page)).length).toBe(1);
    const [h] = await storedHighlights(env, page);
    expect(h).toMatchObject({
      kind: 'essential',
      exactQuote: 'phosphorylates glucose',
      userComment: '',
    });
    await expect(page.getByText(/^Saved/).first()).toBeVisible();
    expect(await overlayTextControls(page), 'no text field appeared in the page').toEqual([]);
    await expect(page.getByRole('textbox')).toHaveCount(0);
  });

  test('More options by keyboard: focus moves in, Tab walks pickers in reading order, Escape steps back', async ({
    env,
  }) => {
    const page = await openFixture(env, '/compat-inline.html');
    await selectInFocusRegion(page);
    await pressFocusToolbar(env, page);
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Save with details' });
    await expect(dialog.getByRole('combobox', { name: 'Bank' })).toBeVisible();
    await expect(dialog).toBeFocused();

    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('combobox', { name: 'Bank' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'New bank...' })).toBeFocused();
    // Kind and Priority are radio groups: one tab stop each, on the checked option.
    await page.keyboard.press('Tab');
    await expect(
      dialog.getByRole('radiogroup', { name: 'Kind' }).getByRole('radio', { checked: true }),
    ).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(
      dialog.getByRole('radiogroup', { name: 'Priority' }).getByRole('radio', { checked: true }),
    ).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();

    // Escape closes only the panel and returns to the More button; the second Escape closes the bar.
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(bar(page)).toBeVisible();
    await expect(page.getByRole('button', { name: 'More options' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(bar(page)).toHaveCount(0);
    expect(await pageActiveId(page)).toBe('focus-region');
  });

  test('More options by keyboard: Enter on Save saves with the chosen type', async ({ env }) => {
    const page = await openFixture(env, '/compat-inline.html');
    await selectInFocusRegion(page);
    await pressFocusToolbar(env, page);
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Save with details' });
    await expect(dialog).toBeFocused();
    // Tab to the Kind group (after Bank and New bank...); an arrow key moves and chooses.
    for (let i = 0; i < 3; i++) await page.keyboard.press('Tab');
    await expect(dialog.getByRole('radio', { name: 'Essential fact' })).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(dialog.getByRole('radio', { name: 'Formula' })).toBeFocused();
    await expect(dialog.getByRole('radio', { name: 'Formula' })).toBeChecked();
    await page.keyboard.press('Tab'); // Priority
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Saved to Inbox')).toBeVisible();
    const [h] = await storedHighlights(env, page);
    expect(h).toMatchObject({ kind: 'formula', userComment: '' });
  });

  test('toast Undo is reachable and operable with the keyboard', async ({ env }) => {
    const page = await openFixture(env, '/compat-inline.html');
    await selectInFocusRegion(page);
    await page.getByRole('button', { name: 'Save selection', exact: true }).click();
    await expect(page.getByText('Saved to Inbox')).toBeVisible();
    await expect.poll(() => paintedNormalised(page)).toHaveLength(1);

    await pressFocusToolbar(env, page);
    await expect(page.getByRole('button', { name: 'Undo' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Save undone')).toBeVisible();
    await expect.poll(() => paintedNormalised(page)).toEqual([]);
    expect(await pageActiveId(page), 'focus is restored to the page').toBe('focus-region');
  });

  test('highlight popover: focus moves in, Tab order is reading order, Escape closes and restores focus', async ({
    env,
  }) => {
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
    // Tab order stays inside the popover controls in reading order. The note is read-only text with
    // an "Edit note in side panel" button where there used to be a textbox; Kind and Priority are
    // radio groups with one tab stop each, on the checked option.
    const order = [
      dialog.getByRole('button', { name: 'Close highlight details', exact: true }),
      dialog.getByRole('button', { name: 'Edit note in side panel', exact: true }),
      dialog.getByRole('radiogroup', { name: 'Kind' }).getByRole('radio', { checked: true }),
      dialog.getByRole('radiogroup', { name: 'Priority' }).getByRole('radio', { checked: true }),
      dialog.getByRole('button', { name: 'Delete', exact: true }),
      dialog.getByRole('button', { name: 'Close', exact: true }),
    ];
    for (const control of order) {
      await page.keyboard.press('Tab');
      await expect(control).toBeFocused();
    }
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
    await pressFocusToolbar(env, page);
    await page.keyboard.press('Enter');
    await expect(page.getByText('Saved to Inbox')).toBeVisible();
    const [h] = await storedHighlights(env, page);
    expect(h!.exactQuote).toBe('Hexokinase phospho');
  });

  test('a keyboard save keeps Undo around longer than a pointer save, so the shortcut can reach it', async ({
    env,
  }) => {
    const page = await openFixture(env, '/compat-inline.html');
    await selectInFocusRegion(page);
    await pressFocusToolbar(env, page);
    await page.keyboard.press('Enter'); // Save selection, started from the keyboard
    await expect(page.getByText('Saved to Inbox')).toBeVisible();
    // A pointer save is gone after 6 s; a keyboard save is kept (about 15 s). Checked against the
    // 6 s mark with a margin rather than against the exact constant.
    await page.waitForTimeout(8_000);
    await expect(page.getByText('Saved to Inbox')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible();
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
    test(`options.html: the settings home and every section (${scheme})`, async ({ env }) => {
      test.slow(); // one axe scan per settings view
      const page = await extensionPage(env, 'options.html');
      await page.emulateMedia({ colorScheme: scheme });
      await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
      await expect(page.getByText('Loading settings')).toHaveCount(0);
      await expectNoViolations(page);

      // Only the current section is on the page (options.html#<id>), so each one is shown and
      // scanned in turn, through the links of the section navigation.
      const nav = page.getByRole('navigation', { name: 'Settings sections' });
      const ids = await nav
        .locator('a[href^="#"]')
        .evaluateAll((links) =>
          links.map((a) => (a.getAttribute('href') ?? '').slice(1)).filter((id) => id !== ''),
        );
      expect(ids.length, 'the settings page lists its sections').toBeGreaterThanOrEqual(14);
      for (const id of ids) {
        await page.evaluate((hash) => (window.location.hash = hash), id);
        await expect(page.locator(`[id="${id}"]`)).toBeVisible();
        await expect(nav.locator(`a[href="#${id}"]`)).toHaveAttribute('aria-current', 'page');
        await expect(page.getByText('Loading settings')).toHaveCount(0);
        const violations = await axeViolations(page);
        expect(violations, `options.html#${id}\n${format(violations)}`).toEqual([]);
      }
    });

    test(`popup.html on a browser-internal tab (${scheme})`, async ({ env }) => {
      const page = await extensionPage(env, 'popup.html');
      await page.emulateMedia({ colorScheme: scheme });
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      // Opened as a tab, the popup is its own active tab: an extension page it cannot run on.
      await expect(page.getByRole('heading', { name: "Can't run here" })).toBeVisible();
      await expect(page.getByText('Checking this tab')).toHaveCount(0);
      await expectNoViolations(page);
    });

    test(`popup.html for an inactive and then an active page (${scheme})`, async ({ env }) => {
      const popup = await extensionPage(env, 'popup.html');
      await popup.emulateMedia({ colorScheme: scheme });
      const page = await openFixture(env, '/article.html', { activate: false });
      await page.bringToFront();
      await expect(popup.getByText('Off', { exact: true })).toBeVisible();
      await expect(popup.getByRole('button', { name: 'Turn on' })).toBeVisible();
      await expectNoViolations(popup);

      await activate(env, page);
      await tripleClick(page, '#p-intro');
      await page.getByRole('button', { name: 'Save selection', exact: true }).click();
      await expect(page.getByText('Saved to Inbox')).toBeVisible();
      await page.bringToFront();
      // Active on this tab only: the "Always on" switch is there and off.
      await expect(popup.getByRole('switch', { name: 'Always on' })).not.toBeChecked();
      await expect(popup.getByTestId('popup-page-count')).toHaveText('1 highlight on this page');
      await expect(
        popup.getByRole('region', { name: 'Recent saves' }).getByRole('listitem'),
      ).toHaveCount(1);
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
      await expect(panel.getByRole('heading', { level: 3, name: /^On this page/ })).toBeVisible();
      await expect(panel.getByRole('article')).toHaveCount(1);
      await expectNoViolations(panel);

      // The More tab, then its "Recent" page.
      await panel.getByRole('tab', { name: 'More', exact: true }).click();
      await expect(panel.getByRole('button', { name: 'Recent', exact: true })).toBeVisible();
      await expectNoViolations(panel);
      await panel.getByRole('button', { name: 'Recent', exact: true }).click();
      await expect(panel.getByRole('heading', { level: 2, name: 'Recent' })).toBeVisible();
      await expect(panel.getByRole('article')).toHaveCount(1);
      await expectNoViolations(panel);
    });

    test(`sidepanel.html Banks tab and the New bank wizard, with and without a validation error (${scheme})`, async ({
      env,
    }) => {
      const panel = await extensionPage(env, 'sidepanel.html');
      await panel.emulateMedia({ colorScheme: scheme });
      await panel.getByRole('tab', { name: 'Banks' }).click();
      await expect(panel.getByRole('button', { name: 'New bank' })).toBeVisible();
      await expect(panel.getByRole('list', { name: 'Your banks' })).toBeVisible();
      await expectNoViolations(panel);

      await panel.getByRole('button', { name: 'New bank' }).click();
      const wizard = panel.getByRole('dialog', { name: 'New bank' });
      await expect(wizard.getByLabel('Bank name')).toBeVisible();
      await expectNoViolations(panel);
      // Next without a name: the step says what is missing and marks the field.
      await wizard.getByRole('button', { name: 'Next' }).click();
      await expect(
        wizard.getByRole('alert').filter({ hasText: 'Enter a name for the bank.' }),
      ).toBeVisible();
      await expect(wizard.getByLabel('Bank name')).toHaveAttribute('aria-invalid', 'true');
      await expectNoViolations(panel);
    });

    test(`sidepanel.html card with tags and a note editor, Search and Review (${scheme})`, async ({
      env,
    }) => {
      test.slow(); // five axe scans of one panel, plus saving a highlight, in one test
      const panel = await extensionPage(env, 'sidepanel.html');
      await panel.emulateMedia({ colorScheme: scheme });
      const page = await openFixture(env, '/article.html', { activate: false });
      await page.bringToFront();
      await expect(panel.getByRole('button', { name: 'Activate on this tab' })).toBeVisible();
      await activate(env, page);
      await tripleClick(page, '#p-intro');
      await page.getByRole('button', { name: 'Save selection', exact: true }).click();
      await expect(page.getByText('Saved to Inbox')).toBeVisible();
      await page.bringToFront();
      const card = panel.getByRole('article');
      await expect(card).toHaveCount(1);

      // A card with its "More actions" drawer open, a tag chip, a rendered note, and both editors open.
      await card.getByTestId('card-more').click();
      await expect(card.getByTestId('card-more')).toHaveAttribute('aria-expanded', 'true');
      await expect(card.getByTestId('card-drawer')).toBeVisible();
      await card.getByLabel('Add a tag').fill('exam pearl');
      await card.getByRole('button', { name: 'Add tag' }).click();
      await expect(card.getByRole('list', { name: 'Tags' })).toBeVisible();
      await card.getByRole('button', { name: 'Add a note' }).click();
      await card.getByLabel('New study note (Markdown)').fill('Rate **60-100** bpm');
      await card.getByRole('button', { name: 'Save note' }).click();
      await expect(card.getByTestId('card-note')).toBeVisible();
      await card.getByRole('button', { name: /^Edit this note/ }).click();
      await expect(card.getByLabel('Study note (Markdown)')).toBeVisible();
      await expectNoViolations(panel);

      // Search: syntax help open, facets open, results, then "no results".
      await panel.getByRole('tab', { name: 'Search' }).click();
      await panel.getByRole('searchbox').fill('sinoatrial');
      await expect(panel.getByTestId('search-results').getByRole('article')).toHaveCount(1);
      await panel.getByRole('button', { name: 'Search syntax' }).click();
      await panel.getByRole('button', { name: 'Narrow results' }).click();
      await expectNoViolations(panel);
      await panel.getByRole('searchbox').fill('zyzzyva');
      await expect(panel.getByText('No results')).toBeVisible();
      await expectNoViolations(panel);

      // Review: the empty state.
      await panel.getByRole('tab', { name: 'Review' }).click();
      await expect(panel.getByRole('heading', { level: 3, name: 'No cards yet' })).toBeVisible();
      await expectNoViolations(panel);
    });

    test(`popup.html on a denied host (${scheme})`, async ({ env }) => {
      const popup = await extensionPage(env, 'popup.html');
      await popup.emulateMedia({ colorScheme: scheme });
      // The fixture host is put on the deny list the way the options page stores it: through the
      // worker's updateSettings (e2e-build hook), not a raw chrome.storage.local write.
      const options = await extensionPage(env, 'options.html');
      await options.evaluate(async () => {
        const reply = (await chrome.runtime.sendMessage({
          v: 1,
          type: 'e2e.settings.patch',
          payload: { json: JSON.stringify({ denyList: ['127.0.0.1', 'paypal.com'] }) },
        })) as { ok?: boolean } | undefined;
        if (!reply?.ok) throw new Error('the deny list could not be set');
      });
      const page = await openFixture(env, '/article.html', { activate: false });
      await page.bringToFront();
      await expect(popup.getByRole('heading', { name: '127.0.0.1', exact: true })).toBeVisible();
      await expect(popup.getByText('Not allowed', { exact: true })).toBeVisible();
      await expect(popup.getByText('On your deny list', { exact: true })).toBeVisible();
      await expect(popup.getByRole('button', { name: 'Allow this site' })).toBeVisible();
      await expect(popup.getByRole('button', { name: 'Open side panel' })).toBeVisible();
      await expectNoViolations(popup);
    });
  }
});
