import type { Page } from '@playwright/test';
import { KIND_DECORATION } from '@highlights';
import {
  DEFAULT_DENY_HOSTS,
  DEFAULT_PALETTE,
  HIGHLIGHT_KINDS,
  KIND_LABELS,
  PENDING_FOCUS_KEY,
} from '@shared';
import {
  OVERLAY_HOST,
  activate,
  activeTexts,
  bg,
  bgData,
  expect,
  focusToolbarVia,
  highlightRuleFor,
  highlightsOf,
  openExt,
  openFixture,
  paintedByRegistry,
  patchSettings,
  pendingFocusLog,
  publishedRangeCount,
  recordPendingFocus,
  saveBlock,
  stepHighlightVia,
  tabIdOf,
  test,
  toolbarOf,
  tripleClickBlock,
  viewing,
  type Env,
} from './helpers.pages';

/**
 * The in-page overlay contract after ADR-005 (free text only in extension origins) and the wave-4
 * work: hand-over to the side panel, no text fields in the page, keyboard navigation between
 * highlights, per-kind decoration, the deny list defaults, and what the content script announces to
 * the page. Everything is driven through real input and real extension messaging.
 */

const NOTE_BUTTON = 'Save and add a note in the side panel';

/** Free-text controls inside the overlay's (open, in the e2e build) shadow root. Must be none. */
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

/** Pickers inside the overlay: the bank <select> and the button-based Kind / Priority radio groups. */
async function overlayPickerCount(page: Page): Promise<number> {
  return page.evaluate(
    (host) =>
      document.querySelector(host)?.shadowRoot?.querySelectorAll('select, [role="radiogroup"]')
        .length ?? 0,
    OVERLAY_HOST,
  );
}

/** Click painted text of `selector` (collapsed selection) to open its highlight popover. */
async function openPopoverOn(page: Page, selector: string): Promise<void> {
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await page
    .locator(selector)
    .first()
    .click({ position: { x: 24, y: 8 } });
  await expect(page.getByRole('dialog', { name: 'Highlight details' })).toBeVisible();
}

const noteIn = (side: Page, highlightId: string) =>
  side.locator(`article[data-highlight-id="${highlightId}"] textarea`);

// =============================================================================================
// Hand-over: notes and bank names are typed in the side panel
// =============================================================================================

test.describe('hand-over to the side panel (ADR-005)', () => {
  test('"Save and add a note" quick-saves with the default kind, hands the highlight over, and the panel focuses its note', async ({
    env,
  }) => {
    const ext = await openExt(env, 'options');
    await recordPendingFocus(ext);
    const page = await openFixture(env, '/article.html');
    // The panel is already open (as a tab, with the page as its active tab), so it receives the
    // storage change live; the "panel opens later" path has its own test below.
    const side = await viewing(env, 'sidepanel', page);

    await tripleClickBlock(page, '#p-intro');
    await expect(toolbarOf(page)).toBeVisible();
    await page.getByRole('button', { name: NOTE_BUTTON }).click();

    // 1. Saved at once, with the default kind and no comment (nothing is typed in the page).
    await expect.poll(async () => (await highlightsOf(ext, page.url())).length).toBe(1);
    const [row] = await highlightsOf(ext, page.url());
    expect(row).toMatchObject({ kind: 'essential', userComment: '' });
    await expect(toolbarOf(page)).toHaveCount(0);

    // 2. The worker handed the highlight id over through chrome.storage.session.
    await expect
      .poll(async () => (await pendingFocusLog(ext)).map((e) => e.highlightId), {
        message: `chrome.storage.session ${PENDING_FOCUS_KEY} should have received the id`,
      })
      .toContain(row!.id);
    const handed = (await pendingFocusLog(ext)).find((e) => e.highlightId === row!.id)!;
    expect(Math.abs(Date.now() - handed.at), 'the hand-over is stamped now').toBeLessThan(60_000);

    // 3. The panel scrolled to the card and put the cursor in its note.
    await expect(noteIn(side, row!.id)).toBeFocused();

    // 4. What is typed there reaches storage through the panel (the page never sees the keys).
    await noteIn(side, row!.id).fill('Typed in the side panel, not in the page.');
    await expect
      .poll(async () => (await highlightsOf(ext, page.url()))[0]?.userComment)
      .toBe('Typed in the side panel, not in the page.');
    await expect.poll(async () => (await pendingFocusLog(ext)).length).toBeGreaterThan(0);
  });

  test('a hand-over written before the panel exists is honoured when it opens, then removed; a stale one is dropped', async ({
    env,
  }) => {
    const ext = await openExt(env, 'options');
    const page = await openFixture(env, '/article.html');
    await saveBlock(ext, page, '#p-intro');
    await saveBlock(ext, page, '#p-refs');
    const rows = await highlightsOf(ext, page.url());
    const intro = rows.find((r) => r.exactQuote.includes('sinoatrial'))!;
    const refs = rows.find((r) => r.exactQuote.includes('Guyton'))!;

    const put = (value: unknown) =>
      ext.evaluate(
        async ({ key, value }) => {
          await chrome.storage.session.set({ [key]: value });
        },
        { key: PENDING_FOCUS_KEY, value },
      );
    const stored = () =>
      ext.evaluate(
        async (key) => (await chrome.storage.session.get(key))[key] ?? null,
        PENDING_FOCUS_KEY,
      );

    // Fresh: the panel that opens within the window jumps to that card's note.
    await put({ highlightId: refs.id, at: Date.now() });
    const side = await viewing(env, 'sidepanel', page);
    await expect(noteIn(side, refs.id)).toBeFocused();
    await expect.poll(stored, { message: 'the entry is consumed once' }).toBeNull();
    await side.close();

    // Stale (older than 30 s): ignored and cleaned up, focus stays where it would be by default.
    await put({ highlightId: intro.id, at: Date.now() - 31_000 });
    const later = await viewing(env, 'sidepanel', page);
    await expect(later.getByRole('article')).toHaveCount(2);
    await expect.poll(stored, { message: 'a stale entry is removed' }).toBeNull();
    await expect(noteIn(later, intro.id)).not.toBeFocused();

    // Malformed: dropped as well, nothing throws.
    await put({ highlightId: 42, at: 'now' });
    await expect.poll(stored).toBeNull();
  });

  test('"Edit note in side panel" on a popover hands the same highlight over; the note shown in the page is read-only', async ({
    env,
  }) => {
    const ext = await openExt(env, 'options');
    const page = await openFixture(env, '/article.html');
    await saveBlock(ext, page, '#quote');
    const [row] = await highlightsOf(ext, page.url());
    const reply = await bg(ext, 'highlight.update', {
      id: row!.id,
      patch: { userComment: 'Existing note, written earlier.' },
    });
    expect(reply.ok).toBe(true);
    const side = await viewing(env, 'sidepanel', page);
    await recordPendingFocus(ext);

    await openPopoverOn(page, '#quote');
    const dialog = page.getByRole('dialog', { name: 'Highlight details' });
    await expect(dialog.getByText('Existing note, written earlier.')).toBeVisible();
    expect(await overlayTextControls(page)).toEqual([]);

    await dialog.getByRole('button', { name: 'Edit note in side panel' }).click();
    await expect
      .poll(async () => (await pendingFocusLog(ext)).map((e) => e.highlightId))
      .toContain(row!.id);
    await expect(noteIn(side, row!.id)).toBeFocused();
    await expect(noteIn(side, row!.id)).toHaveValue('Existing note, written earlier.');
  });

  test('banks are created in the side panel, then picked in the page: "New bank..." only points there', async ({
    env,
  }) => {
    const ext = await openExt(env, 'options');
    await recordPendingFocus(ext);
    const page = await openFixture(env, '/article.html');
    const side = await viewing(env, 'sidepanel', page);

    // The page's panel has no way to name a bank; its button hands over to the panel (no highlight).
    await tripleClickBlock(page, '#p-intro');
    await page.getByRole('button', { name: 'More options', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Save with details' });
    await expect(dialog.getByRole('textbox')).toHaveCount(0);
    const newBank = dialog.getByRole('button', { name: 'New bank...' });
    await expect(newBank).toHaveAccessibleDescription('A new bank is named in the side panel.');
    await newBank.click();
    await page.waitForTimeout(500);
    expect(await pendingFocusLog(ext), 'no highlight to focus: nothing is handed over').toEqual([]);
    await expect(dialog).toBeVisible(); // the page's panel stays open for the user to come back to

    // The Banks tab's "New bank" wizard validates, creates, and lists.
    await side.getByRole('tab', { name: 'Banks' }).click();
    await side.getByRole('button', { name: 'New bank', exact: true }).click();
    const wizard = side.getByRole('dialog', { name: 'New bank' });
    const next = wizard.getByRole('button', { name: 'Next', exact: true });
    await next.click();
    await expect(
      wizard.getByRole('alert').filter({ hasText: 'Enter a name for the bank.' }),
    ).toBeVisible();
    await wizard.getByLabel('Bank name').fill('Cardiology');
    for (let step = 0; step < 3; step++) await next.click(); // name, icon, colour
    await wizard.getByRole('button', { name: 'Create bank', exact: true }).click();
    await expect(side.getByText('Bank "Cardiology" created.')).toBeVisible();
    const done = side.getByTestId('new-bank-done');
    await expect(done.getByRole('heading', { name: 'Bank ready!' })).toBeVisible();
    await done.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(done).toHaveCount(0);
    await expect(wizard).toHaveCount(0);
    await expect(side.getByRole('list', { name: 'Your banks' })).toContainText('Cardiology');

    // Back in the page: the overlay refreshes its bank list when the page window regains focus.
    // Playwright pins focus emulation on, so no real focus event is ever delivered: send the one
    // the browser would have sent (the listener does not look at isTrusted).
    await page.bringToFront();
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(dialog.getByRole('combobox', { name: 'Bank' })).toContainText('Cardiology');
    await dialog.getByRole('combobox', { name: 'Bank' }).selectOption({ label: 'Cardiology' });
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Saved to Cardiology')).toBeVisible();

    const { banks } = await bgData<{ banks: Array<{ id: string; name: string }> }>(
      ext,
      'banks.list',
    );
    const cardiology = banks.find((b) => b.name === 'Cardiology');
    expect(cardiology).toBeDefined();
    const [row] = await highlightsOf(ext, page.url());
    expect(row?.bankIds).toEqual([cardiology!.id]);
  });
});

// =============================================================================================
// Security: nothing typed in the page, nothing observable beyond non-text input
// =============================================================================================

test.describe('overlay exposes no free-text surface to the page (ADR-005)', () => {
  test('no input, textarea or contenteditable in any overlay state; only pickers and buttons', async ({
    env,
  }) => {
    const ext = await openExt(env, 'options');
    const page = await openFixture(env, '/article.html');
    const states: string[] = [];
    const audit = async (what: string, minPickers = 0): Promise<void> => {
      const found = await overlayTextControls(page);
      expect(found, `${what}: free-text controls in the overlay`).toEqual([]);
      expect(await overlayPickerCount(page), `${what}: pickers present`).toBeGreaterThanOrEqual(
        minPickers,
      );
      states.push(what);
    };

    await audit('idle');
    await tripleClickBlock(page, '#p-intro');
    await expect(toolbarOf(page)).toBeVisible();
    await audit('toolbar');
    await page.getByRole('button', { name: 'More options', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Save with details' })).toBeVisible();
    // The bank picker appears once the list of banks has loaded.
    await expect(page.getByRole('combobox', { name: 'Bank' })).toBeVisible();
    await audit('More options panel', 3); // bank, kind, priority
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('button', { name: 'Save selection', exact: true }).click();
    await expect(page.getByText('Saved to Inbox')).toBeVisible();
    await audit('toast');

    // Even with a long note stored, the popover shows it as text.
    const [row] = await highlightsOf(ext, page.url());
    await bgData(ext, 'highlight.update', {
      id: row!.id,
      patch: { userComment: 'A long private thought. '.repeat(30) },
    });
    await page.getByRole('button', { name: 'Dismiss notification' }).click();
    // The page learns of an edit made elsewhere through the data-change refresh (debounced), so the
    // popover is opened again until it carries the note.
    const popover = page.getByRole('dialog', { name: 'Highlight details' });
    await expect(async () => {
      await page.keyboard.press('Escape');
      await openPopoverOn(page, '#p-intro');
      await expect(popover).toContainText('A long private thought.', { timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
    await audit('popover with a note', 2); // kind, priority
    expect(states).toHaveLength(5);
  });

  test('capture-phase page listeners see no text input from the overlay; pointer use produces no key events at all', async ({
    env,
  }) => {
    const ext = await openExt(env, 'options');
    const page = await openFixture(env, '/article.html');
    await page.evaluate(() => {
      const log: Array<{
        type: string;
        key: string | null;
        data: string | null;
        isInputEvent: boolean;
      }> = [];
      (window as unknown as { __textLog: typeof log }).__textLog = log;
      const types = [
        'keydown',
        'keyup',
        'keypress',
        'beforeinput',
        'input',
        'compositionstart',
        'compositionupdate',
        'compositionend',
        'paste',
        'cut',
      ];
      // A hostile page: capture phase on window runs before anything inside a shadow tree.
      for (const type of types) {
        window.addEventListener(
          type,
          (e) =>
            log.push({
              type,
              key: e instanceof KeyboardEvent ? e.key : null,
              data: (e as InputEvent).data ?? null,
              isInputEvent: e instanceof InputEvent,
            }),
          true,
        );
      }
    });
    const logged = () =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __textLog: Array<{
                type: string;
                key: string | null;
                data: string | null;
                isInputEvent: boolean;
              }>;
            }
          ).__textLog,
      );

    // ---- pointer-only session: every control except a typed key --------------------------------
    await tripleClickBlock(page, '#p-intro');
    await expect(toolbarOf(page)).toBeVisible();
    await page.getByRole('button', { name: 'Save as Formula' }).hover();
    await page.getByRole('button', { name: 'More options', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Save with details' });
    await dialog
      .getByRole('radiogroup', { name: 'Kind' })
      .getByRole('radio', { name: 'Formula' })
      .click();
    await dialog
      .getByRole('radiogroup', { name: 'Priority' })
      .getByRole('radio', { name: '5 (highest)' })
      .click();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Saved to Inbox')).toBeVisible();
    await page.getByRole('button', { name: 'Dismiss notification' }).click();
    await openPopoverOn(page, '#p-intro');
    const popover = page.getByRole('dialog', { name: 'Highlight details' });
    await popover
      .getByRole('radiogroup', { name: 'Priority' })
      .getByRole('radio', { name: '2', exact: true })
      .click();
    await expect(popover.getByText('Saved', { exact: true })).toBeVisible();
    await popover.getByRole('button', { name: 'Close highlight details' }).click();

    const pointerLog = await logged();
    expect(
      pointerLog.filter((e) => e.type !== 'input'),
      'no key, composition, paste or beforeinput event may come from a pointer session',
    ).toEqual([]);
    // The pickers are buttons (role=radio) and the bank <select> was not touched, so there should be
    // no input event at all; a <select> would report a plain `input` Event (no data, not an
    // InputEvent): the page could tell that a picker moved, never what text was typed (none can be).
    for (const e of pointerLog) {
      expect(e.isInputEvent, 'select input events are plain Events').toBe(false);
      expect(e.data).toBeNull();
    }
    await expect
      .poll(async () => (await highlightsOf(ext, page.url()))[0])
      .toMatchObject({
        kind: 'formula',
        priority: 2,
      });

    // ---- keyboard session: only navigation keys are used, and none reaches a text sink ----------
    const before = pointerLog.length;
    await tripleClickBlock(page, '#p-refs');
    await expect(toolbarOf(page)).toBeVisible();
    const tabId = await tabIdOf(ext, page);
    const focused = await focusToolbarVia(ext, tabId);
    expect(focused).toMatchObject({ ok: true, data: { focused: true } });
    for (const key of ['ArrowRight', 'ArrowRight', 'ArrowLeft', 'End', 'Home', 'Escape']) {
      await page.keyboard.press(key);
    }
    const keys = (await logged()).slice(before);
    expect(keys.filter((e) => e.type === 'beforeinput' || e.type === 'input')).toEqual([]);
    expect(
      keys.filter((e) => e.type === 'keydown').every((e) => (e.key ?? '').length > 1),
      `only named navigation keys were pressed: ${JSON.stringify(keys.map((e) => e.key))}`,
    ).toBe(true);
    expect(
      await overlayTextControls(page),
      'there is no sink a typed character could land in',
    ).toEqual([]);
  });
});

// =============================================================================================
// Alt+Shift+] / Alt+Shift+[ : next / previous highlight
// =============================================================================================

test.describe('keyboard navigation between highlights', () => {
  const NEXT = 'Alt+Shift+BracketRight';
  const PREVIOUS = 'Alt+Shift+BracketLeft';

  /** Three highlights in document order on article.html: intro, the quote block, the references. */
  async function seed(env: Env) {
    const ext = await openExt(env, 'options');
    const page = await openFixture(env, '/article.html');
    await page.setViewportSize({ width: 900, height: 360 });
    await saveBlock(ext, page, '#p-intro');
    await saveBlock(ext, page, '#quote', 'Save as Formula');
    await saveBlock(ext, page, '#p-refs');
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator('h1').click(); // a collapsed selection somewhere neutral
    return { ext, page };
  }

  const popoverQuote = (page: Page) =>
    page.getByRole('dialog', { name: 'Highlight details' }).locator('.sv-quote-block');

  test('next / previous walk the painted highlights in document order and wrap, opening each popover with focus inside', async ({
    env,
  }) => {
    const { page } = await seed(env);
    const dialog = page.getByRole('dialog', { name: 'Highlight details' });
    const announcer = page.locator(`${OVERLAY_HOST} [data-sv-announcer]`);

    const expected = [
      'sinoatrial node is the primary pacemaker',
      'Cardiac output equals heart rate',
      'Guyton and Hall',
    ];
    // Forward through all three and around once more.
    for (const [i, want] of [...expected, expected[0]!].entries()) {
      await page.keyboard.press(NEXT);
      await expect(dialog).toBeVisible();
      await expect(dialog).toBeFocused();
      await expect(popoverQuote(page)).toContainText(want);
      // The reader is told where they are, and the highlight is emphasised and in view.
      await expect(announcer).toContainText(`Highlight ${(i % 3) + 1} of 3`);
      await expect.poll(() => activeTexts(page)).toEqual([expect.stringContaining(want)]);
      const inView = await page.evaluate(() => {
        const range = CSS.highlights.get('sv-hl-active');
        const r = range
          ? (Array.from(range as unknown as Iterable<Range>)[0] as Range).getBoundingClientRect()
          : null;
        return r !== null && r.top >= 0 && r.bottom <= window.innerHeight;
      });
      expect(inView, `${want}: scrolled into the viewport`).toBe(true);
      // Hand the page focus back so the next key press goes to the page, as a reader would.
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
    }

    // The walk ended on the first highlight, so backwards wraps to the last, then steps up.
    for (const want of [
      'Guyton and Hall',
      'Cardiac output equals heart rate',
      'sinoatrial node is the primary pacemaker',
    ]) {
      await page.keyboard.press(PREVIOUS);
      await expect(popoverQuote(page)).toContainText(want);
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
    }
  });

  test('a highlight whose text is hidden is skipped in both directions, and the key is consumed', async ({
    env,
  }) => {
    const { page } = await seed(env);
    // The middle highlight's text goes away behind a collapsed panel (display:none).
    await page.evaluate(() => {
      document.getElementById('quote')!.style.display = 'none';
    });
    await page.keyboard.press(NEXT);
    await expect(popoverQuote(page)).toContainText('sinoatrial node is the primary pacemaker');
    await page.keyboard.press('Escape');
    await page.keyboard.press(NEXT);
    await expect(popoverQuote(page)).toContainText('Guyton and Hall'); // quote skipped
    await page.keyboard.press('Escape');
    await page.keyboard.press(PREVIOUS);
    await expect(popoverQuote(page)).toContainText('sinoatrial node is the primary pacemaker');

    // The key is consumed: page listeners further down the chain see it as already handled.
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      (window as unknown as { __seen: boolean[] }).__seen = [];
      document.addEventListener('keydown', (e) => {
        // The modifier presses (Alt, Shift) arrive first and belong to the page; only "]" is ours.
        if (e.code === 'BracketRight') {
          (window as unknown as { __seen: boolean[] }).__seen.push(e.defaultPrevented);
        }
      });
    });
    await page.keyboard.press(NEXT);
    expect(
      await page.evaluate(() => (window as unknown as { __seen: boolean[] }).__seen),
      'a handled shortcut reaches page listeners as defaultPrevented',
    ).toEqual([true]);
  });

  test('Escape closes the popover, ends the emphasis and returns focus to the page element that had it', async ({
    env,
  }) => {
    const ext = await openExt(env, 'options');
    const page = await openFixture(env, '/compat-inline.html');
    await saveBlock(ext, page, '#focus-p');
    await saveBlock(ext, page, '#plain-after');
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator('#focus-region').focus();
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('focus-region');

    await page.keyboard.press('Alt+Shift+BracketRight');
    const dialog = page.getByRole('dialog', { name: 'Highlight details' });
    await expect(dialog).toBeFocused();
    await expect.poll(() => activeTexts(page)).not.toEqual([]);

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect(await page.evaluate(() => document.activeElement?.id), 'focus returned').toBe(
      'focus-region',
    );
    await expect.poll(() => activeTexts(page), { message: 'the held emphasis ended' }).toEqual([]);
  });

  test('ignored while the user is typing in a field; the key then belongs to the page', async ({
    env,
  }) => {
    const ext = await openExt(env, 'options');
    const page = await openFixture(env, '/editable.html');
    await saveBlock(ext, page, '#plain');
    await page.locator('#text-input').focus();
    await page.evaluate(() => {
      (window as unknown as { __seen: boolean[] }).__seen = [];
      document.addEventListener('keydown', (e) => {
        if (e.code === 'BracketRight') {
          (window as unknown as { __seen: boolean[] }).__seen.push(e.defaultPrevented);
        }
      });
    });
    await page.keyboard.press('Alt+Shift+BracketRight');
    await page.waitForTimeout(300);
    await expect(page.getByRole('dialog', { name: 'Highlight details' })).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __seen: boolean[] }).__seen)).toEqual([
      false,
    ]);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('text-input');
  });

  test('with nothing painted the key says so instead of doing nothing', async ({ env }) => {
    const page = await openFixture(env, '/article.html');
    await page.locator('h1').click();
    await page.keyboard.press('Alt+Shift+BracketRight');
    await expect(page.getByText('No highlights on this page yet.')).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Highlight details' })).toHaveCount(0);
  });

  test('the manifest commands (TabRpc stepHighlight / focusToolbar) drive the same navigation', async ({
    env,
  }) => {
    const { ext, page } = await seed(env);
    const tabId = await tabIdOf(ext, page);
    const dialog = page.getByRole('dialog', { name: 'Highlight details' });

    expect(await stepHighlightVia(ext, tabId, 'next')).toMatchObject({
      ok: true,
      data: { found: true },
    });
    await expect(popoverQuote(page)).toContainText('sinoatrial node is the primary pacemaker');
    expect(await stepHighlightVia(ext, tabId, 'next')).toMatchObject({ data: { found: true } });
    await expect(popoverQuote(page)).toContainText('Cardiac output equals heart rate');
    expect(await stepHighlightVia(ext, tabId, 'previous')).toMatchObject({ data: { found: true } });
    await expect(popoverQuote(page)).toContainText('sinoatrial node is the primary pacemaker');
    await expect(dialog).toBeFocused();

    // Nothing selected and no toast with an action: nothing to focus, and it says so (no throw).
    // The saves above left Undo toasts behind; those are something to focus, so clear them first.
    const dismiss = page.getByRole('button', { name: 'Dismiss notification' });
    while ((await dismiss.count()) > 0) await dismiss.first().click();
    expect(await focusToolbarVia(ext, tabId)).toMatchObject({ ok: true, data: { focused: false } });

    // Everything hidden: found:false, with a toast, and no popover.
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      for (const id of ['p-intro', 'quote', 'p-refs'])
        document.getElementById(id)!.style.display = 'none';
    });
    expect(await stepHighlightVia(ext, tabId, 'next')).toMatchObject({
      ok: true,
      data: { found: false },
    });
    await expect(page.getByText('No visible highlights on this page.')).toBeVisible();
  });
});

// =============================================================================================
// Painted highlights carry a per-kind decoration (not colour alone)
// =============================================================================================

test.describe('per-kind highlight decoration', () => {
  /** One block per kind, in article.html. */
  const BLOCKS: Array<[(typeof HIGHLIGHT_KINDS)[number], string]> = [
    ['essential', '#p-intro'],
    ['formula', '#p-multiline'],
    ['exception', '#p-nested'],
    ['differential', '#p-repeat-1'],
    ['weak_area', '#p-filler'],
    ['correction', '#quote'],
    ['question', '#p-refs'],
  ];

  async function paintAllKinds(env: Env) {
    const ext = await openExt(env, 'options');
    const page = await openFixture(env, '/article.html');
    for (const [kind, selector] of BLOCKS) {
      await saveBlock(ext, page, selector, `Save as ${KIND_LABELS[kind].label}`);
    }
    return { ext, page };
  }

  test('each kind is published under its own registry name and carries its own underline', async ({
    env,
  }) => {
    const { page } = await paintAllKinds(env);
    const want = BLOCKS.map(([kind]) => `sv-hl-${DEFAULT_PALETTE[kind]}-${kind}`).sort();
    await expect
      .poll(async () => Object.keys(await paintedByRegistry(page)).sort(), {
        message: 'one registry per kind (colour + kind)',
      })
      .toEqual(want);
    expect(new Set(want).size, 'registry names are distinct per kind').toBe(HIGHLIGHT_KINDS.length);

    // Every kind's rule really draws the underline the contract names, and the pairs are unique.
    const pairs = new Set<string>();
    for (const [kind] of BLOCKS) {
      const name = `sv-hl-${DEFAULT_PALETTE[kind]}-${kind}`;
      const rule = await highlightRuleFor(page, name);
      expect(rule, `${name}: a rule is adopted into the page`).not.toBeNull();
      const deco = KIND_DECORATION[kind];
      expect(rule!.line, `${kind}: underlined`).toBe('underline');
      expect(rule!.style, `${kind}: style`).toBe(deco.style);
      expect(rule!.thickness, `${kind}: thickness`).toBe(`${deco.thickness}px`);
      pairs.add(`${rule!.style}/${rule!.thickness}`);
    }
    expect(pairs.size, 'no two kinds share (style, thickness)').toBe(HIGHLIGHT_KINDS.length);
  });

  test('"Strong" thickens every underline by 1px; "Show highlights" off publishes nothing but still saves', async ({
    env,
  }) => {
    const { ext, page } = await paintAllKinds(env);
    await expect.poll(() => publishedRangeCount(page)).toBe(HIGHLIGHT_KINDS.length);

    await patchSettings(ext, { highlightStyle: 'strong' });
    for (const [kind] of BLOCKS) {
      const name = `sv-hl-${DEFAULT_PALETTE[kind]}-${kind}`;
      await expect
        .poll(async () => (await highlightRuleFor(page, name))?.thickness, { message: name })
        .toBe(`${KIND_DECORATION[kind].thickness + 1}px`);
    }

    // Quiet mode: the page's registry is left alone; captures still reach the database.
    await patchSettings(ext, { paintHighlights: false });
    await expect.poll(() => publishedRangeCount(page)).toBe(0);
    const before = (await highlightsOf(ext, page.url())).length;
    await tripleClickBlock(page, '#list li:nth-child(1)');
    await expect(toolbarOf(page)).toBeVisible();
    await page.getByRole('button', { name: 'Save selection', exact: true }).click();
    await expect.poll(async () => (await highlightsOf(ext, page.url())).length).toBe(before + 1);
    expect(await publishedRangeCount(page), 'still nothing published in quiet mode').toBe(0);

    await patchSettings(ext, { paintHighlights: true });
    await expect.poll(() => publishedRangeCount(page)).toBe(before + 1);
  });

  test("changing a kind in the side panel moves the highlight to the new kind's registry", async ({
    env,
  }) => {
    const ext = await openExt(env, 'options');
    const page = await openFixture(env, '/article.html');
    await saveBlock(ext, page, '#p-intro');
    await expect
      .poll(async () => Object.keys(await paintedByRegistry(page)))
      .toEqual(['sv-hl-amber-essential']);
    const side = await viewing(env, 'sidepanel', page);
    // Kind and priority sit in the card's "More actions" drawer. The radio shows the new kind once
    // the save has finished (it follows the stored value), so it is clicked, then awaited.
    await side.getByTestId('card-more').click();
    const weak = side
      .getByTestId('card-drawer')
      .getByRole('radio', { name: KIND_LABELS.weak_area.label });
    await weak.click();
    await expect(weak).toBeChecked();
    await expect
      .poll(async () => Object.keys(await paintedByRegistry(page)))
      .toEqual([`sv-hl-${DEFAULT_PALETTE.weak_area}-weak_area`]);
  });
});

// =============================================================================================
// Deny list: the starter list, and hosts spelled with a trailing dot
// =============================================================================================

test.describe('deny list defaults', () => {
  test('a fresh profile lists exactly the starter list and registers every entry as an exclusion', async ({
    env,
  }) => {
    expect(
      DEFAULT_DENY_HOSTS.length,
      'the starter list is imported, not counted by hand',
    ).toBeGreaterThan(0);
    const ext = await openExt(env, 'options');
    const list = ext.getByRole('group', { name: 'Deny list' }).getByRole('listitem');
    await expect(list).toHaveCount(DEFAULT_DENY_HOSTS.length);
    const shown = (await list.allInnerTexts()).map((t) => t.split('\n')[0]!.trim()).sort();
    expect(shown).toEqual([...DEFAULT_DENY_HOSTS].sort());

    // Every entry becomes an excludeMatches pattern of the persistent registration.
    await patchSettings(ext, { persistentOrigins: ['http://127.0.0.1/*'] });
    expect(await bg(ext, 'site.sync')).toMatchObject({ ok: true });
    const [script] = await ext.evaluate(() => chrome.scripting.getRegisteredContentScripts());
    const excluded = new Set(script?.excludeMatches ?? []);
    const missing = DEFAULT_DENY_HOSTS.filter((h) => !excluded.has(`*://*.${h}/*`));
    expect(missing, 'starter hosts missing from excludeMatches').toEqual([]);
  });

  test('a host spelled with a trailing dot is treated as the host itself', async ({ env }) => {
    // Chrome loads http://localhost.:PORT/ (the DNS root label) from the same server. A deny entry
    // for "localhost" must cover it; a trailing dot must not be a way around the list.
    const ext = await openExt(env, 'options');
    await patchSettings(ext, { denyList: ['localhost'] });
    const dotted = env.altOrigin.replace('//localhost:', '//localhost.:');
    const page = await env.context.newPage();
    const response = await page.goto(`${dotted}/article.html`).catch(() => null);
    test.skip(!response?.ok(), `Chromium could not load ${dotted} in this environment`);
    const tabId = await tabIdOf(ext, page);

    // Without host access to the dotted origin Chrome hides the tab URL and injection is refused,
    // which is not the policy under test: probe it first and skip with the reason when so.
    const visible = await ext.evaluate(
      async (id) => (await chrome.tabs.get(id)).url ?? null,
      tabId,
    );
    test.skip(
      visible === null,
      `the e2e build's http://localhost/* host permission does not cover "localhost." (tab url hidden); ` +
        'deny-list matching of trailing-dot hosts is covered by packages/shared urls.test.ts',
    );
    const reply = await bg(ext, 'tab.activate', { tabId });
    expect(reply).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    await expect(page.locator(OVERLAY_HOST)).toHaveCount(0);
  });
});

// =============================================================================================
// What the content script announces to the page
// =============================================================================================

test.describe('content-script start', () => {
  test('no window message carrying the extension id is posted to the page', async ({ env }) => {
    const page = await openFixture(env, '/article.html', { activate: false });
    await page.evaluate(() => {
      const seen: string[] = [];
      (window as unknown as { __msgs: string[] }).__msgs = seen;
      window.addEventListener(
        'message',
        (e) => {
          try {
            seen.push(JSON.stringify(e.data));
          } catch {
            seen.push(String(e.data));
          }
        },
        true,
      );
    });
    await activate(env, page); // injects, mounts, and waits for the first rehydration
    // Let anything queued by the boot sequence (and the supersede handshake) run.
    await page.waitForTimeout(500);
    const msgs = await page.evaluate(() => (window as unknown as { __msgs: string[] }).__msgs);
    const leaked = msgs.filter(
      (m) => m.includes(env.extensionId) || m.includes('content-script-started'),
    );
    expect(leaked, 'the extension id must not be announced to page scripts').toEqual([]);
    // Positive control: the content script really did start.
    await expect(page.locator(OVERLAY_HOST)).toHaveCount(1);
  });
});

// =============================================================================================
// Incognito
// =============================================================================================

test.describe('private windows', () => {
  test.fixme('saving from an incognito tab is refused with an explanation unless "Save from private windows" is on', () => {
    // NOT DRIVABLE in this harness: Playwright's persistent context exposes one (non-incognito)
    // browser context, an unpacked extension is disabled in incognito until "Allow in Incognito" is
    // switched on its chrome://extensions details page, and the incognito targets that
    // chrome.windows.create({incognito:true}) would produce are not attached to Playwright pages.
    // The worker's refusal (sender.tab.incognito) is covered by the handler unit tests in
    // entrypoints/background/handlers.test.ts.
  });
});
