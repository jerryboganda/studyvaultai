import type { Locator, Page } from '@playwright/test';
import {
  OVERLAY_HOST,
  boxOf,
  contrastRatio,
  dragSelect,
  expect,
  normalise,
  openFixture,
  pageErrors,
  paintedNormalised,
  paintedRanges,
  reloadAndActivate,
  selectionRect,
  selectionSnapshot,
  setBrowserZoom,
  settleOverlay,
  settleSelection,
  storedHighlights,
  tabRpc,
  test,
  toolbarOf,
  toolbarSightings,
  tripleClick,
  viewportSize,
  watchToolbar,
  activate,
  type Env,
} from './helpers.compat';

const SAVE = 'Save selection';

async function clickSave(page: Page, name = SAVE, toast = 'Saved to Inbox'): Promise<void> {
  await page.getByRole('button', { name, exact: true }).click();
  await expect(page.getByText(toast)).toBeVisible();
}

/** The toolbar is on screen, fully inside the layout viewport, and does not sit on the selection. */
async function expectToolbarSane(page: Page): Promise<void> {
  const bar = toolbarOf(page);
  await expect(bar).toBeVisible();
  await settleOverlay(page);
  const [box, view, sel] = await Promise.all([boxOf(bar), viewportSize(page), selectionRect(page)]);
  expect(box.left, 'toolbar left edge').toBeGreaterThanOrEqual(0);
  expect(box.top, 'toolbar top edge').toBeGreaterThanOrEqual(0);
  expect(box.right, 'toolbar right edge').toBeLessThanOrEqual(view.w);
  expect(box.bottom, 'toolbar bottom edge').toBeLessThanOrEqual(view.h);
  const overlaps =
    box.left < sel.right && box.right > sel.left && box.top < sel.bottom && box.bottom > sel.top;
  expect(
    overlaps,
    `toolbar ${JSON.stringify(box)} must not cover selection ${JSON.stringify(sel)}`,
  ).toBe(false);
}

interface Captured {
  /** Selection.toString() as the page reported it while the toolbar was showing. */
  liveText: string;
}

/**
 * The whole vertical slice for one selection that is already made on `page`:
 * toolbar -> save -> painted -> stored with provenance -> reload -> painted again.
 * `expected` is the whitespace-collapsed quote the user meant to select.
 */
async function saveAndRestore(
  env: Env,
  page: Page,
  expected: string,
  opts: { owner?: string } = {},
): Promise<Captured> {
  await expectToolbarSane(page);
  const live = await selectionSnapshot(page);
  expect(normalise(live.text), 'live selection text').toBe(expected);

  await clickSave(page);

  const stored = await storedHighlights(env, page);
  expect(stored, 'exactly one highlight stored').toHaveLength(1);
  const [h] = stored;
  // Provenance: the quote is what the user saw, byte for byte (trimmed).
  expect(h!.exactQuote).toBe(live.text.trim());
  expect(normalise(h!.exactQuote)).toBe(expected);
  const anchorText = h!.anchorSet.textQuote.exact;

  // Painted immediately (no reload) and identical to the anchor's text slice.
  await expect.poll(() => paintedNormalised(page)).toEqual([normalise(anchorText)]);
  if (opts.owner) {
    const ranges = await paintedRanges(page);
    expect(ranges.map((r) => r.owner)).toEqual([opts.owner]);
  }

  // The whole point of the product: a fresh load of the same URL gets the highlight back.
  await reloadAndActivate(env, page);
  await expect
    .poll(() => paintedNormalised(page), { timeout: 15_000 })
    .toEqual([normalise(anchorText)]);
  if (opts.owner) {
    expect((await paintedRanges(page)).map((r) => r.owner)).toEqual([opts.owner]);
  }
  expect(await storedHighlights(env, page)).toHaveLength(1);
  return { liveText: live.text };
}

// ---------------------------------------------------------------------------------------------
// Matrix 1 + 2: simple article, wrapped lines, nested inline formatting, tables, lists, quotes
// ---------------------------------------------------------------------------------------------

test.describe('capture shapes in real Chromium (matrix 1, 2)', () => {
  test('single-line mouse drag inside a paragraph', async ({ env }) => {
    const page = await openFixture(env, '/article.html');
    const text = 'primary pacemaker of the heart';
    const lines = await dragSelect(page, { selector: '#p-intro', text });
    expect(lines, 'selection stays on one rendered line').toBe(1);
    await saveAndRestore(env, page, text, { owner: 'p-intro' });
    expect(pageErrors(page)).toEqual([]);
  });

  test('triple-click selects and saves a whole paragraph', async ({ env }) => {
    const page = await openFixture(env, '/article.html');
    await tripleClick(page, '#p-intro');
    await saveAndRestore(
      env,
      page,
      'The sinoatrial node is the primary pacemaker of the heart. It initiates each heartbeat by spontaneously depolarising at a rate of roughly seventy beats per minute at rest.',
      { owner: 'p-intro' },
    );
  });

  test('mouse drag across wrapped lines (3+ rendered lines)', async ({ env }) => {
    // The shared fixture's 640px column puts this quote on 3 lines with Windows' Georgia but on only
    // 2 with the serif Linux falls back to. In a 22rem (352px) column the 163 characters would fit
    // on 2 lines only with an average glyph under 4px at 18px, which no real font has, so the
    // property under test -- a selection that really spans several rendered lines -- no longer
    // depends on the OS fonts.
    const page = await openFixture(env, '/article.html', {
      style: '#p-multiline { max-width: 22rem; }',
    });
    const text =
      'spreads from the sinoatrial node across the atria, pauses at the atrioventricular node, and then travels rapidly through the bundle of His and the Purkinje fibres.';
    const lines = await dragSelect(page, { selector: '#p-multiline', text });
    expect(lines, 'selection really wraps over several lines').toBeGreaterThanOrEqual(3);
    await saveAndRestore(env, page, text, { owner: 'p-multiline' });
  });

  test('selection across inline <a>, <strong>, <em>', async ({ env }) => {
    const page = await openFixture(env, '/compat-inline.html');
    // Starts before the link (a drag that starts ON a link would begin a link drag instead).
    const text = 'enzyme phosphofructokinase is rate-limiting for glycolysis';
    await dragSelect(page, { selector: '#inline', text });
    await saveAndRestore(env, page, text, { owner: 'inline' });
  });

  test('selection across inline <code>, <sub>, <sup>', async ({ env }) => {
    const page = await openFixture(env, '/compat-inline.html');
    const text =
      'follows v = Vmax[S] / (Km + [S]) where Km is the Michaelis constant and x2 marks a squared term.';
    await dragSelect(page, { selector: '#inline', text });
    await saveAndRestore(env, page, text, { owner: 'inline' });
  });

  test('selection that ends after a <sup><a> footnote marker', async ({ env }) => {
    const page = await openFixture(env, '/compat-inline.html');
    const text = 'a squared term.[1] Afterwards the pathway';
    await dragSelect(page, { selector: '#inline', text });
    await saveAndRestore(env, page, text, { owner: 'inline' });
  });

  test('inline math built from spans, <em> and <sup>', async ({ env }) => {
    const page = await openFixture(env, '/compat-inline.html');
    const text = 'related by E = mc2 while the variance is σ2 = E[(X − μ)2] for any';
    await dragSelect(page, { selector: '#math', text });
    await saveAndRestore(env, page, text, { owner: 'math' });
  });

  test('nested formatting on the shared article fixture (strong, em, a, i)', async ({ env }) => {
    const page = await openFixture(env, '/article.html');
    const text =
      'volume of blood ejected by one ventricle during a single contraction, see the reference list; the usual symbol is SV';
    await dragSelect(page, { selector: '#p-nested', text });
    await saveAndRestore(env, page, text, { owner: 'p-nested' });
  });

  test('across table cells in one row', async ({ env }) => {
    const page = await openFixture(env, '/article.html');
    await dragSelect(
      page,
      { selector: '#values tr:nth-child(2) td:nth-child(1)', text: 'Heart rate' },
      { selector: '#values tr:nth-child(2) td:nth-child(2)', text: '60-100 beats per minute' },
    );
    const live = await selectionSnapshot(page);
    expect(normalise(live.text)).toBe('Heart rate 60-100 beats per minute');
    await saveAndRestore(env, page, 'Heart rate 60-100 beats per minute');
  });

  test('across table rows', async ({ env }) => {
    const page = await openFixture(env, '/article.html');
    await dragSelect(
      page,
      { selector: '#values tr:nth-child(2) td:nth-child(1)', text: 'Heart rate' },
      { selector: '#values tr:nth-child(3) td:nth-child(2)', text: '55-70 percent' },
    );
    await saveAndRestore(
      env,
      page,
      'Heart rate 60-100 beats per minute Ejection fraction 55-70 percent',
    );
  });

  test('across list items', async ({ env }) => {
    const page = await openFixture(env, '/article.html');
    await dragSelect(
      page,
      { selector: '#list li:nth-child(1)', text: 'ventricular stretch at end diastole.' },
      { selector: '#list li:nth-child(2)', text: 'Afterload is the resistance' },
    );
    await saveAndRestore(
      env,
      page,
      'ventricular stretch at end diastole. Afterload is the resistance',
    );
  });

  test('triple-click on a list item and on a blockquote', async ({ env }) => {
    const page = await openFixture(env, '/article.html');
    await tripleClick(page, '#list li:nth-child(2)');
    await expect(toolbarOf(page)).toBeVisible();
    expect(normalise((await selectionSnapshot(page)).text)).toBe(
      'Afterload is the resistance the ventricle must overcome.',
    );
    await clickSave(page);

    await tripleClick(page, '#quote');
    await expect(toolbarOf(page)).toBeVisible();
    expect(normalise((await selectionSnapshot(page)).text)).toBe(
      'Cardiac output equals heart rate multiplied by stroke volume.',
    );
    await clickSave(page);

    const stored = await storedHighlights(env, page);
    expect(stored.map((h) => normalise(h.exactQuote)).sort()).toEqual([
      'Afterload is the resistance the ventricle must overcome.',
      'Cardiac output equals heart rate multiplied by stroke volume.',
    ]);
    await reloadAndActivate(env, page);
    await expect
      .poll(async () => (await paintedRanges(page)).map((r) => r.owner).sort(), { timeout: 15_000 })
      .toEqual(['list', 'quote']);
  });

  test('across a heading into the next paragraph', async ({ env }) => {
    const page = await openFixture(env, '/article.html');
    await dragSelect(
      page,
      {
        selector: '#p-intro',
        text: 'spontaneously depolarising at a rate of roughly seventy beats per minute at rest.',
      },
      { selector: '#p-multiline', text: 'Depolarisation spreads from the sinoatrial node' },
    );
    await saveAndRestore(
      env,
      page,
      'spontaneously depolarising at a rate of roughly seventy beats per minute at rest. Conduction Depolarisation spreads from the sinoatrial node',
    );
    // The heading context recorded for a quote that starts in the introduction.
    const [h] = await storedHighlights(env, page);
    expect(h!.headingContext).toBe('Introduction');
  });

  test('each toolbar kind button saves that kind', async ({ env }) => {
    const page = await openFixture(env, '/article.html');
    await tripleClick(page, '#p-refs');
    await clickSave(page, 'Save as Formula');
    const [h] = await storedHighlights(env, page);
    expect(h!.kind).toBe('formula');
  });
});

// ---------------------------------------------------------------------------------------------
// Matrix 9: duplicate occurrences need prefix/suffix
// ---------------------------------------------------------------------------------------------

test.describe('repeated identical text (matrix 9)', () => {
  const SHARED =
    'remember that the ejection fraction is the proportion of end-diastolic volume that is ejected with each beat.';

  test('saving the SECOND occurrence restores only the second', async ({ env }) => {
    const page = await openFixture(env, '/article.html');
    await dragSelect(page, { selector: '#p-repeat-2', text: SHARED });
    await saveAndRestore(env, page, SHARED, { owner: 'p-repeat-2' });
  });

  test('saving the FIRST occurrence restores only the first', async ({ env }) => {
    const page = await openFixture(env, '/article.html');
    await dragSelect(page, { selector: '#p-repeat-1', text: SHARED });
    await saveAndRestore(env, page, SHARED, { owner: 'p-repeat-1' });
  });

  test('whole-paragraph triple-click on the second occurrence', async ({ env }) => {
    const page = await openFixture(env, '/article.html');
    await tripleClick(page, '#p-repeat-2');
    await saveAndRestore(env, page, `Second, ${SHARED}`, { owner: 'p-repeat-2' });
  });

  test('both occurrences saved separately both come back, each on its own paragraph', async ({
    env,
  }) => {
    const page = await openFixture(env, '/article.html');
    await dragSelect(page, { selector: '#p-repeat-1', text: SHARED });
    await clickSave(page);
    await dragSelect(page, { selector: '#p-repeat-2', text: SHARED });
    await page.getByRole('button', { name: SAVE, exact: true }).click();
    // The second save must be a NEW highlight, not "Already saved" for the first occurrence.
    await expect(page.getByText('Saved to Inbox')).toBeVisible();
    await expect(page.getByText(/Already saved/)).toHaveCount(0);

    const stored = await storedHighlights(env, page);
    expect(stored).toHaveLength(2);
    await expect
      .poll(async () => (await paintedRanges(page)).map((r) => r.owner).sort())
      .toEqual(['p-repeat-1', 'p-repeat-2']);

    await reloadAndActivate(env, page);
    await expect
      .poll(async () => (await paintedRanges(page)).map((r) => r.owner).sort(), { timeout: 15_000 })
      .toEqual(['p-repeat-1', 'p-repeat-2']);
  });
});

// ---------------------------------------------------------------------------------------------
// Matrix 4: editable surfaces never show the toolbar
// ---------------------------------------------------------------------------------------------

test.describe('editable surfaces (matrix 4)', () => {
  /** Positive control + monitor: proves the toolbar works on this very page before testing absence. */
  async function prepare(env: Env): Promise<{ page: Page; baseline: number }> {
    const page = await openFixture(env, '/editable.html');
    await watchToolbar(page);
    await tripleClick(page, '#plain');
    await expect(toolbarOf(page), 'positive control: plain text shows the toolbar').toBeVisible();
    await page.keyboard.press('Escape'); // not in the toolbar: page selection collapses by clicking away
    await page.locator('h1').click();
    await expect(toolbarOf(page)).toHaveCount(0);
    return { page, baseline: await toolbarSightings(page) };
  }

  async function expectNoToolbar(page: Page, baseline: number, what: string): Promise<void> {
    await settleSelection(page);
    await expect(toolbarOf(page), `${what}: toolbar not rendered`).toHaveCount(0);
    expect(await toolbarSightings(page), `${what}: toolbar never appeared`).toBe(baseline);
  }

  const fields = [
    { id: '#text-input', label: 'text input' },
    { id: '#password', label: 'password input' },
    { id: '#textarea', label: 'textarea' },
  ] as const;

  for (const f of fields) {
    test(`${f.label}: triple-click, Ctrl+A and Shift+Arrow selections`, async ({ env }) => {
      const { page, baseline } = await prepare(env);
      const field = page.locator(f.id);

      await field.click({ clickCount: 3 });
      expect((await selectionSnapshot(page)).activeElement).toContain(f.id.slice(1));
      await expectNoToolbar(page, baseline, `${f.label} triple-click`);

      await field.click();
      await page.keyboard.press('Control+A');
      await expectNoToolbar(page, baseline, `${f.label} Ctrl+A`);

      await field.click();
      await page.keyboard.press('Home');
      for (let i = 0; i < 6; i++) await page.keyboard.press('Shift+ArrowRight');
      await expectNoToolbar(page, baseline, `${f.label} Shift+Arrow`);

      expect(pageErrors(page)).toEqual([]);
    });
  }

  test('contenteditable: drag, triple-click, Ctrl+A and Shift+Arrow selections', async ({
    env,
  }) => {
    const { page, baseline } = await prepare(env);
    await dragSelect(page, { selector: '#rich', text: 'Rich text editor content' });
    expect((await selectionSnapshot(page)).text).toContain('Rich text editor content');
    await expectNoToolbar(page, baseline, 'contenteditable drag');

    await page.locator('#rich').click({ clickCount: 3 });
    await expectNoToolbar(page, baseline, 'contenteditable triple-click');

    await page.locator('#rich').click();
    await page.keyboard.press('Control+A');
    await expectNoToolbar(page, baseline, 'contenteditable Ctrl+A');

    await page.keyboard.press('Home');
    for (let i = 0; i < 8; i++) await page.keyboard.press('Shift+ArrowRight');
    await expectNoToolbar(page, baseline, 'contenteditable Shift+Arrow');
  });

  test('role=textbox surface: drag and triple-click', async ({ env }) => {
    const { page, baseline } = await prepare(env);
    await dragSelect(page, { selector: '#textbox', text: 'ARIA textbox surface' });
    await expectNoToolbar(page, baseline, 'role=textbox drag');
    await page.locator('#textbox').click({ clickCount: 3 });
    await expectNoToolbar(page, baseline, 'role=textbox triple-click');
  });

  test('a drag from plain text into an editor (and back out) is refused', async ({ env }) => {
    const { page, baseline } = await prepare(env);
    await dragSelect(
      page,
      { selector: '#plain', text: 'capturable body text' },
      { selector: '#rich', text: 'Rich text editor' },
    );
    expect((await selectionSnapshot(page)).text).toContain('capturable body text');
    await expectNoToolbar(page, baseline, 'plain -> editor drag');

    await page.locator('h1').click();
    await dragSelect(
      page,
      { selector: '#rich', text: 'Rich text editor' },
      { selector: '#plain', text: 'capturable body text' },
    );
    await expectNoToolbar(page, baseline, 'editor -> plain drag');
  });

  test('quick-save (shortcut / context menu) never captures text from fields or editors', async ({
    env,
  }) => {
    const { page } = await prepare(env);
    const saved = new Set(['created', 'duplicate', 'restored']);
    for (const id of ['#text-input', '#password', '#textarea', '#rich', '#textbox']) {
      await page.locator(id).click({ clickCount: 3 });
      const res = await tabRpc(env, page, 'content.captureSelection', {
        method: 'shortcut',
        bankId: null,
      });
      expect(res.ok, id).toBe(true);
      expect(saved.has((res.data as { status: string }).status), `${id} must not be saved`).toBe(
        false,
      );
    }
    expect(await storedHighlights(env, page)).toEqual([]);
  });

  test('quick-save from a contenteditable says fields and editors are not captured', async ({
    env,
  }) => {
    const { page } = await prepare(env);
    await page.locator('#rich').click({ clickCount: 3 });
    const res = await tabRpc(env, page, 'content.captureSelection', {
      method: 'context-menu',
      bankId: null,
    });
    expect(res.data).toMatchObject({ status: 'blocked' });
    expect((res.data as { reason: string }).reason).toMatch(/form fields or editors/);
  });

  // Chromium reports a selection inside <input>/<textarea> as a COLLAPSED document selection
  // (isCollapsed === true while toString() holds the text), so inspectSelection() answers
  // 'no-selection' before it can reach its designed 'editable' verdict, and the user is told to
  // "select some text" although text is selected. Nothing is saved either way.
  for (const id of ['#text-input', '#password', '#textarea']) {
    test(`quick-save from ${id} explains that form fields are not captured`, async ({ env }) => {
      const { page } = await prepare(env);
      await page.locator(id).click({ clickCount: 3 });
      const res = await tabRpc(env, page, 'content.captureSelection', {
        method: 'shortcut',
        bankId: null,
      });
      expect(res.data).toMatchObject({ status: 'blocked' });
      expect((res.data as { reason: string }).reason).toMatch(/form fields or editors/);
    });
  }

  // ARCHITECTURE.md: "Ignore ... editable app surfaces by default". Dragging INTO an editor is refused
  // (above), so a selection that merely spans one must not smuggle the editor's text into the quote.
  test('a selection that spans an editor does not save the editor text', async ({ env }) => {
    const page = await openFixture(env, '/compat-mixed.html');
    await dragSelect(
      page,
      { selector: '#before', text: 'Public text before' },
      { selector: '#after', text: 'Public text after the draft editor.' },
    );
    expect((await selectionSnapshot(page)).text, 'the drag really spans the editor').toContain(
      'PRIVATE-DRAFT',
    );
    await settleSelection(page);
    let savedQuote = '';
    if ((await toolbarOf(page).count()) > 0) {
      await clickSave(page);
      savedQuote = (await storedHighlights(env, page)).map((h) => h.exactQuote).join('\n');
    }
    expect(savedQuote, 'editor text must be refused or excluded').not.toContain('PRIVATE-DRAFT');
    const painted = (await paintedNormalised(page)).join('\n');
    expect(painted).not.toContain('PRIVATE-DRAFT');
  });

  test('Select All with an editor in the middle of the page does not save the editor text', async ({
    env,
  }) => {
    const page = await openFixture(env, '/compat-mixed.html');
    await page.locator('#mixed-h').click();
    await page.keyboard.press('Control+A');
    expect((await selectionSnapshot(page)).text).toContain('PRIVATE-DRAFT');
    await settleSelection(page);
    let savedQuote = '';
    if ((await toolbarOf(page).count()) > 0) {
      await clickSave(page);
      savedQuote = (await storedHighlights(env, page)).map((h) => h.exactQuote).join('\n');
    }
    expect(savedQuote, 'editor text must be refused or excluded').not.toContain('PRIVATE-DRAFT');
  });

  test('after working inside fields the plain paragraph still saves (no stuck state)', async ({
    env,
  }) => {
    const page = await openFixture(env, '/editable.html');
    await page.locator('#text-input').click({ clickCount: 3 });
    await page.locator('#textarea').click({ clickCount: 3 });
    await page.locator('#rich').click({ clickCount: 3 });
    await tripleClick(page, '#plain');
    await saveAndRestore(
      env,
      page,
      'This ordinary paragraph is capturable body text for contrast.',
      { owner: 'plain' },
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Matrix 5: iframes
// ---------------------------------------------------------------------------------------------

test.describe('iframes (matrix 5)', () => {
  async function overlayHostsInFrames(page: Page): Promise<number[]> {
    const counts: number[] = [];
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      counts.push(
        await frame.evaluate((tag) => document.querySelectorAll(tag).length, OVERLAY_HOST),
      );
    }
    return counts;
  }

  async function ready(env: Env): Promise<Page> {
    const page = await openFixture(env, '/iframe.html');
    // Both frames loaded and laid out.
    for (const frame of page.frames()) await frame.waitForLoadState('load');
    await expect(page.frameLocator('#same').locator('#p-intro')).toBeVisible();
    await expect(page.frameLocator('#cross').locator('#p-intro')).toBeVisible();
    return page;
  }

  test('top-level text works while frames exist, and nothing is injected into the frames', async ({
    env,
  }) => {
    const page = await ready(env);
    expect(await overlayHostsInFrames(page)).toEqual([0, 0]);
    await tripleClick(page, '#outer');
    await saveAndRestore(env, page, 'Top-level paragraph that is capturable.', { owner: 'outer' });
    expect(pageErrors(page)).toEqual([]);
  });

  test('same-origin iframe: selecting inside shows no toolbar and does not throw', async ({
    env,
  }) => {
    const page = await ready(env);
    await watchToolbar(page);
    const inner = page.frameLocator('#same').locator('#p-multiline');
    await inner.click({ clickCount: 3 });
    const frame = await (await page.locator('#same').elementHandle())!.contentFrame();
    const innerText = await frame!.evaluate(() => String(getSelection()));
    expect(innerText.length, 'a selection really exists inside the iframe').toBeGreaterThan(20);
    await settleSelection(page);
    await expect(toolbarOf(page)).toHaveCount(0);
    expect(await toolbarSightings(page)).toBe(0);
    // Quick-save asks the top-level content script; nothing is selected there.
    const res = await tabRpc(env, page, 'content.captureSelection', {
      method: 'shortcut',
      bankId: null,
    });
    expect(res.data).toMatchObject({ status: 'no-selection' });
    expect(await storedHighlights(env, page)).toEqual([]);
    expect(pageErrors(page)).toEqual([]);
  });

  test('cross-origin iframe: selecting inside shows no toolbar and does not throw', async ({
    env,
  }) => {
    const page = await ready(env);
    await watchToolbar(page);
    await page.frameLocator('#cross').locator('#p-multiline').click({ clickCount: 3 });
    await settleSelection(page);
    await expect(toolbarOf(page)).toHaveCount(0);
    expect(await toolbarSightings(page)).toBe(0);
    const res = await tabRpc(env, page, 'content.captureSelection', {
      method: 'shortcut',
      bankId: null,
    });
    expect(res.data).toMatchObject({ status: 'no-selection' });
    expect(pageErrors(page)).toEqual([]);
  });

  test('moving the selection from the page into a frame never leaves a stale toolbar', async ({
    env,
  }) => {
    const page = await ready(env);
    await tripleClick(page, '#outer');
    await expect(toolbarOf(page)).toBeVisible();

    await page.frameLocator('#same').locator('#p-intro').click({ clickCount: 3 });
    // Whatever Chromium does with the parent's selection, the toolbar must agree with it.
    await expect
      .poll(
        async () => {
          const visible = (await toolbarOf(page).count()) > 0;
          const topHasSelection = await page.evaluate(
            () => !getSelection()!.isCollapsed && String(getSelection()).trim().length > 0,
          );
          return visible === topHasSelection;
        },
        { message: 'toolbar visibility follows the top document selection' },
      )
      .toBe(true);
    expect(pageErrors(page)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Matrix 5: third-party components (Shadow DOM)
// ---------------------------------------------------------------------------------------------

test.describe('web components and Shadow DOM (matrix 5)', () => {
  async function expectNeverCaptured(env: Env, page: Page, what: string): Promise<void> {
    await settleSelection(page);
    expect(await toolbarSightings(page), `${what}: toolbar never appeared`).toBe(0);
    const res = await tabRpc(env, page, 'content.captureSelection', {
      method: 'shortcut',
      bankId: null,
    });
    expect(res.ok).toBe(true);
    const data = res.data as { status: string; reason?: string };
    expect(['no-selection', 'blocked'], `${what}: quick-save outcome`).toContain(data.status);
    expect(await storedHighlights(env, page)).toEqual([]);
    expect(pageErrors(page)).toEqual([]);
  }

  test('text inside an open shadow root is not captured (documented v1 limit)', async ({ env }) => {
    const page = await openFixture(env, '/compat-shadow.html');
    await watchToolbar(page);
    await page.locator('x-open p').click({ clickCount: 3 });
    expect(
      (await selectionSnapshot(page)).text,
      'a selection really exists inside the component',
    ).toContain('open shadow root');
    await expectNeverCaptured(env, page, 'open shadow root');
  });

  test('text inside a closed shadow root is not captured', async ({ env }) => {
    const page = await openFixture(env, '/compat-shadow.html');
    await watchToolbar(page);
    await page.locator('x-closed').click({ clickCount: 3 });
    expect((await selectionSnapshot(page)).text).toContain('closed shadow root');
    await expectNeverCaptured(env, page, 'closed shadow root');
  });

  test('slotted light DOM text inside a component is captured and restored', async ({ env }) => {
    const page = await openFixture(env, '/compat-shadow.html');
    const text = 'Slotted light DOM text rendered inside a component slot.';
    await dragSelect(page, { selector: '#slotted', text });
    await saveAndRestore(env, page, text, { owner: 'slotted' });
  });

  test('light DOM text next to the components still works', async ({ env }) => {
    const page = await openFixture(env, '/compat-shadow.html');
    await tripleClick(page, '#light');
    await saveAndRestore(
      env,
      page,
      'A light DOM paragraph that is capturable beside the third-party components.',
      { owner: 'light' },
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Toolbar placement at viewport edges
// ---------------------------------------------------------------------------------------------

test.describe('toolbar placement', () => {
  test('selection at the very top: toolbar flips below and stays on screen', async ({ env }) => {
    const page = await openFixture(env, '/article.html');
    await page.evaluate(() => window.scrollTo(0, 0));
    await tripleClick(page, 'h1');
    await expectToolbarSane(page);
    const [box, sel] = await Promise.all([boxOf(toolbarOf(page)), selectionRect(page)]);
    expect(sel.top, 'the heading is near the top edge').toBeLessThan(box.height + 16);
    expect(box.top, 'toolbar sits below the selection').toBeGreaterThanOrEqual(sel.bottom);
  });

  test('selection at the bottom edge: toolbar sits above and stays on screen', async ({ env }) => {
    const page = await openFixture(env, '/article.html');
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await tripleClick(page, '#p-refs');
    await expectToolbarSane(page);
    const [box, sel] = await Promise.all([boxOf(toolbarOf(page)), selectionRect(page)]);
    expect(box.bottom, 'toolbar sits above the selection').toBeLessThanOrEqual(sel.top);
  });

  test('toolbar follows its selection while the page scrolls', async ({ env }) => {
    const page = await openFixture(env, '/article.html');
    await dragSelect(page, { selector: '#p-multiline', text: 'atrioventricular node, and then' });
    await expectToolbarSane(page);
    const before = await boxOf(toolbarOf(page));
    const selBefore = await selectionRect(page);
    await page.mouse.move(40, 40);
    await page.mouse.wheel(0, 90);
    await expect
      .poll(async () => Math.round(before.top - (await boxOf(toolbarOf(page))).top))
      .toBe(90);
    const selAfter = await selectionRect(page);
    expect(Math.round(selBefore.top - selAfter.top)).toBe(90);
  });
});

// ---------------------------------------------------------------------------------------------
// Matrix 7: restrictive CSS and z-index stacks
// ---------------------------------------------------------------------------------------------

test.describe('hostile page CSS (matrix 7)', () => {
  test('toolbar is visible, in the viewport, usable and not styled by the page', async ({
    env,
  }) => {
    const page = await openFixture(env, '/hostile.html');
    await tripleClick(page, '#hostile-p');
    await expectToolbarSane(page);

    const bar = toolbarOf(page);
    const report = await bar.evaluate((el) => {
      const buttons = Array.from(el.querySelectorAll('button'));
      const host = (el.getRootNode() as ShadowRoot).host as HTMLElement;
      const save = buttons.find((b) => b.getAttribute('aria-label') === 'Save selection')!;
      const style = getComputedStyle(save);
      const hostStyle = getComputedStyle(host);
      const rects = buttons.map((b) => b.getBoundingClientRect());
      const mid = (r: DOMRect) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
      const topmostIsOverlay = rects.map((r) => {
        const p = mid(r);
        return document.elementsFromPoint(p.x, p.y)[0] === host;
      });
      return {
        count: buttons.length,
        display: buttons.map((b) => getComputedStyle(b).display),
        minWidth: Math.min(...rects.map((r) => r.width)),
        minHeight: Math.min(...rects.map((r) => r.height)),
        saveFontSize: style.fontSize,
        saveLetterSpacing: style.letterSpacing,
        saveTextTransform: style.textTransform,
        saveBoxSizing: style.boxSizing,
        saveFontFamily: style.fontFamily,
        saveInnerText: save.innerText,
        hostPosition: hostStyle.position,
        hostZ: hostStyle.zIndex,
        hostLetterSpacing: hostStyle.letterSpacing,
        hostTextTransform: hostStyle.textTransform,
        topmostIsOverlay,
      };
    });

    expect(report.count).toBe(10);
    expect(
      report.display.every((d) => d !== 'none'),
      'page `button{display:none!important}` must not apply',
    ).toBe(true);
    expect(report.minWidth, 'smallest target width (WCAG 2.5.8 min 24px)').toBeGreaterThanOrEqual(
      24,
    );
    expect(report.minHeight, 'smallest target height (WCAG 2.5.8 min 24px)').toBeGreaterThanOrEqual(
      24,
    );
    expect(
      parseFloat(report.saveFontSize),
      'legible: not shrunk by html{font-size:4px}',
    ).toBeGreaterThanOrEqual(12);
    expect(report.saveLetterSpacing, 'page letter-spacing:3px must not leak').toMatch(
      /^(normal|0px)$/,
    );
    expect(report.saveTextTransform, 'page text-transform:uppercase must not leak').toBe('none');
    expect(report.saveInnerText, 'rendered label is not upper-cased').toBe('Save');
    expect(report.saveBoxSizing).toBe('border-box');
    expect(report.saveFontFamily).not.toMatch(/Georgia/i);
    expect(report.hostPosition).toBe('fixed');
    expect(report.hostZ).toBe('2147483647');
    expect(report.hostLetterSpacing).toMatch(/^(normal|0px)$/);
    expect(report.hostTextTransform).toBe('none');
    expect(
      report.topmostIsOverlay.every(Boolean),
      'z-index war: overlay is topmost over every button',
    ).toBe(true);
  });

  test('buttons are usable by a real click and the toast is legible', async ({ env }) => {
    const page = await openFixture(env, '/hostile.html');
    await tripleClick(page, '#hostile-p');
    await clickSave(page);
    const toast = page.locator(`${OVERLAY_HOST} >> .sv-toast-text`);
    await expect(toast).toHaveText('Saved to Inbox');
    const text = await toast.evaluate((el) => ({
      rendered: (el as HTMLElement).innerText,
      fontSize: getComputedStyle(el).fontSize,
      letterSpacing: getComputedStyle(el).letterSpacing,
    }));
    expect(text.rendered).toBe('Saved to Inbox');
    expect(parseFloat(text.fontSize)).toBeGreaterThanOrEqual(12);
    expect(text.letterSpacing).toMatch(/^(normal|0px)$/);

    // And the highlight is restored on the hostile page too.
    await reloadAndActivate(env, page);
    await expect.poll(() => paintedNormalised(page), { timeout: 15_000 }).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Matrix 7: dark theme and colour scheme
// ---------------------------------------------------------------------------------------------

/** Contrast of every visible piece of text inside the overlay against its effective background. */
async function overlayContrast(
  page: Page,
): Promise<Array<{ text: string; ratio: number; fg: string; bg: string; size: string }>> {
  const raw = await page.evaluate((host) => {
    const root = document.querySelector(host)?.shadowRoot;
    if (!root) throw new Error('no overlay shadow root');
    const out: Array<{ text: string; fg: string; bg: string; size: string }> = [];
    const isTransparent = (c: string): boolean => c === 'transparent' || /rgba\(.*,\s*0\)$/.test(c);
    for (const el of Array.from(root.querySelectorAll('*'))) {
      const own = Array.from(el.childNodes)
        .filter((n) => n.nodeType === 3)
        .map((n) => (n.nodeValue ?? '').trim())
        .join(' ')
        .trim();
      const placeholder = el instanceof HTMLTextAreaElement && el.placeholder ? el.placeholder : '';
      if (!own && !placeholder) continue;
      const rect = (el as HTMLElement).getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (el.closest('.sv-sr, [hidden]')) continue;
      const style = getComputedStyle(el);
      let fg = style.color;
      let text = own;
      if (!own && placeholder) {
        fg = getComputedStyle(el, '::placeholder').color;
        text = `placeholder: ${placeholder}`;
      }
      let bg = '';
      for (let n: Element | null = el; n; n = n.parentElement) {
        const c = getComputedStyle(n).backgroundColor;
        if (!isTransparent(c)) {
          bg = c;
          break;
        }
      }
      out.push({ text, fg, bg: bg || 'rgb(255, 255, 255)', size: style.fontSize });
    }
    return out;
  }, OVERLAY_HOST);
  return raw.map((r) => ({ ...r, ratio: contrastRatio(r.fg, r.bg) }));
}

test.describe('themes and contrast (matrix 7)', () => {
  const combos = [
    { page: '/dark.html', scheme: 'dark' as const, selector: '#d' },
    { page: '/dark.html', scheme: 'light' as const, selector: '#d' },
    { page: '/article.html', scheme: 'dark' as const, selector: '#p-intro' },
    { page: '/article.html', scheme: 'light' as const, selector: '#p-intro' },
  ];

  for (const c of combos) {
    test(`overlay text meets 4.5:1 on ${c.page} with prefers-color-scheme: ${c.scheme}`, async ({
      env,
    }) => {
      const page = await openFixture(env, c.page);
      await page.emulateMedia({ colorScheme: c.scheme });
      await tripleClick(page, c.selector);
      await expect(toolbarOf(page)).toBeVisible();

      const failures: string[] = [];
      const audit = async (stage: string): Promise<void> => {
        const rows = await overlayContrast(page);
        expect(rows.length, `${stage}: text found to audit`).toBeGreaterThan(0);
        for (const r of rows) {
          if (r.ratio < 4.5) {
            failures.push(
              `${stage}: "${r.text}" ${r.fg} on ${r.bg} = ${r.ratio.toFixed(2)}:1 (${r.size})`,
            );
          }
        }
      };

      await audit('toolbar');
      await page.getByRole('button', { name: 'More options' }).click();
      await expect(page.getByRole('dialog', { name: 'Save with details' })).toBeVisible();
      await expect(page.getByRole('combobox', { name: 'Bank' })).toBeVisible();
      await audit('more panel');
      await page.getByRole('button', { name: 'Cancel' }).click();
      await page.getByRole('button', { name: 'Add a note' }).click();
      await expect(page.getByRole('dialog', { name: 'Add a note' })).toBeVisible();
      await audit('note composer');
      await page.getByRole('button', { name: 'Cancel' }).click();

      await clickSave(page);
      await audit('toast');
      expect(failures, failures.join('\n')).toEqual([]);
    });
  }

  test('the page being dark does not make the overlay unreadable (dark.html, system light)', async ({
    env,
  }) => {
    const page = await openFixture(env, '/dark.html');
    await page.emulateMedia({ colorScheme: 'light' });
    await tripleClick(page, '#d');
    const colors = await toolbarOf(page).evaluate((el) => {
      const s = getComputedStyle(el);
      const b = el.querySelector('button')!;
      return { bg: s.backgroundColor, text: getComputedStyle(b).color };
    });
    expect(contrastRatio(colors.text, colors.bg)).toBeGreaterThanOrEqual(7);
  });
});

// ---------------------------------------------------------------------------------------------
// Matrix 7: browser page zoom 125% - 200%
// ---------------------------------------------------------------------------------------------

test.describe('browser page zoom (matrix 7)', () => {
  const configs = [
    { name: '125% on 1280x720', zoom: 1.25, viewport: { width: 1280, height: 720 } },
    { name: '200% on 1280x720', zoom: 2, viewport: { width: 1280, height: 720 } },
    // A common laptop window: 1366x768 screen minus browser chrome.
    { name: '200% on a 1366x768 laptop window', zoom: 2, viewport: { width: 1366, height: 657 } },
  ];

  /** Controls of `panel` that are not completely inside the layout viewport. */
  async function clippedControls(
    panel: Locator,
    view: { w: number; h: number },
  ): Promise<string[]> {
    return panel.evaluate((el, dims) => {
      const out: string[] = [];
      for (const c of Array.from(el.querySelectorAll('button, select, textarea'))) {
        const r = c.getBoundingClientRect();
        if (r.left < 0 || r.top < 0 || r.right > dims.w || r.bottom > dims.h) {
          out.push(
            `${c.localName} "${c.getAttribute('aria-label') ?? c.textContent ?? ''}" ` +
              `rect=${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.right)},${Math.round(r.bottom)} ` +
              `viewport=${dims.w}x${dims.h}`,
          );
        }
      }
      return out;
    }, view);
  }

  async function zoomedSelection(env: Env, cfg: (typeof configs)[number]) {
    const page = await openFixture(env, '/article.html');
    await page.setViewportSize(cfg.viewport);
    const view = await setBrowserZoom(env, page, cfg.zoom);
    // Real zoom: devicePixelRatio rises and the CSS viewport shrinks by the same factor.
    expect(view.w).toBe(Math.round(cfg.viewport.width / cfg.zoom));
    expect(view.dpr).toBeCloseTo(cfg.zoom, 2);
    await dragSelect(page, {
      selector: '#p-multiline',
      text: 'pauses at the atrioventricular node, and then travels rapidly',
    });
    return { page, view };
  }

  for (const cfg of configs) {
    test(`toolbar stays on screen and clear of the selection at ${cfg.name}`, async ({ env }) => {
      const { page, view } = await zoomedSelection(env, cfg);
      await expectToolbarSane(page);
      const boxes = await toolbarOf(page).evaluate((el) =>
        Array.from(el.querySelectorAll('button')).map((b) => {
          const r = b.getBoundingClientRect();
          return { l: r.left, t: r.top, r: r.right, b: r.bottom };
        }),
      );
      expect(boxes).toHaveLength(10);
      for (const b of boxes) {
        expect(b.l).toBeGreaterThanOrEqual(0);
        expect(b.r).toBeLessThanOrEqual(view.w);
        expect(b.t).toBeGreaterThanOrEqual(0);
        expect(b.b).toBeLessThanOrEqual(view.h);
      }
    });

    test(`Add a note panel is fully reachable at ${cfg.name}`, async ({ env }) => {
      const { page, view } = await zoomedSelection(env, cfg);
      await page.getByRole('button', { name: 'Add a note' }).click();
      const panel = page.getByRole('dialog', { name: 'Add a note' });
      await expect(panel).toBeVisible();
      expect(await clippedControls(panel, view), 'controls outside the viewport').toEqual([]);
    });

    test(`More options panel is fully reachable at ${cfg.name}`, async ({ env }) => {
      const { page, view } = await zoomedSelection(env, cfg);
      await page.getByRole('button', { name: 'More options' }).click();
      const panel = page.getByRole('dialog', { name: 'Save with details' });
      await expect(panel).toBeVisible();
      await expect(page.getByRole('combobox', { name: 'Bank' })).toBeVisible();
      expect(await clippedControls(panel, view), 'controls outside the viewport').toEqual([]);
    });
  }

  test('the highlight is still restored at 200% zoom', async ({ env }) => {
    const page = await openFixture(env, '/article.html');
    await setBrowserZoom(env, page, 2);
    await tripleClick(page, '#p-intro');
    await clickSave(page);
    await reloadAndActivate(env, page);
    await expect.poll(() => paintedNormalised(page), { timeout: 15_000 }).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Non-interference with the host page
// ---------------------------------------------------------------------------------------------

test.describe('non-interference', () => {
  test('showing the toolbar leaves the page selection, focus and scroll untouched', async ({
    env,
  }) => {
    const page = await openFixture(env, '/compat-inline.html');
    await dragSelect(page, {
      selector: '#focus-p',
      text: 'phosphorylates glucose to glucose six phosphate',
    });
    const right = await selectionSnapshot(page);
    expect(right.text).toBe('phosphorylates glucose to glucose six phosphate');
    await expectToolbarSane(page);
    await settleSelection(page);
    const later = await selectionSnapshot(page);
    expect(later).toEqual(right);
    expect(later.activeElement, 'toolbar does not steal focus from the page').toBe(
      'div#focus-region',
    );
  });

  test('Ctrl+C still copies the selection while the toolbar is open', async ({ env }) => {
    await env.context.grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: env.origin,
    });
    const page = await openFixture(env, '/compat-inline.html');
    await dragSelect(page, {
      selector: '#plain-after',
      text: 'pyruvate kinase and substrate level phosphorylation',
    });
    await expectToolbarSane(page);
    await page.keyboard.press('Control+C');
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { __log: { copy: string[] } }).__log.copy),
      )
      .toEqual(['pyruvate kinase and substrate level phosphorylation']);
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe('pyruvate kinase and substrate level phosphorylation');
  });

  test('a link click still navigates, with the toolbar open and on a saved highlight', async ({
    env,
  }) => {
    const page = await openFixture(env, '/compat-inline.html');
    // Toolbar open for some other text, then follow a link.
    await dragSelect(page, { selector: '#plain-after', text: 'pyruvate kinase' });
    await expect(toolbarOf(page)).toBeVisible();
    await page.locator('#nav-link').click();
    await expect(page).toHaveURL(/\/dark\.html$/);
    await expect(page).toHaveTitle('Dark article');

    // A saved highlight that contains a link: clicking the link must still navigate.
    await page.goBack();
    await expect(page).toHaveURL(/\/compat-inline\.html$/);
    await activate(env, page);
    await dragSelect(
      page,
      { selector: '#nav-p', text: 'Read' },
      { selector: '#nav-p', text: 'for a contrasting theme.' },
    );
    await clickSave(page);
    await expect.poll(() => paintedNormalised(page)).toHaveLength(1);
    await page.locator('#nav-link').click();
    await expect(page).toHaveURL(/\/dark\.html$/);
    expect(pageErrors(page)).toEqual([]);
  });

  test('keyboard Shift+Arrow extends the selection; the toolbar follows and does not take focus', async ({
    env,
  }) => {
    const page = await openFixture(env, '/article.html');
    // Chromium only extends an existing RANGE with Shift+Arrow on read-only text (a bare caret does not).
    await dragSelect(page, { selector: '#p-filler', text: 'intervening' });
    await expect(toolbarOf(page)).toBeVisible();
    expect((await selectionSnapshot(page)).text).toBe('intervening');

    for (let i = 0; i < 10; i++) await page.keyboard.press('Shift+ArrowRight');
    await expect
      .poll(async () => (await selectionSnapshot(page)).text)
      .toBe('intervening paragraph');
    await expectToolbarSane(page);
    // Focus stayed in the page the whole time (the arrow keys did not rove the toolbar buttons).
    expect((await selectionSnapshot(page)).activeElement.startsWith('studyvault')).toBe(false);
    await expect(page.getByRole('button', { name: 'Save selection' })).not.toBeFocused();

    // The toolbar tracks the CURRENT selection, not the one it first appeared for.
    await page.getByRole('button', { name: 'Add a note' }).click();
    await expect(page.getByLabel('Selected text', { exact: true })).toHaveText(
      'intervening paragraph',
    );
    await page.getByRole('textbox', { name: 'Note' }).fill('extended with the keyboard');
    await page
      .getByRole('dialog', { name: 'Add a note' })
      .getByRole('button', { name: 'Save', exact: true })
      .click();
    await expect(page.getByText('Saved to Inbox')).toBeVisible();
    const [h] = await storedHighlights(env, page);
    expect(h!.exactQuote).toBe('intervening paragraph');
    expect(h!.userComment).toBe('extended with the keyboard');
  });

  test('page DOM is untouched apart from the single overlay host', async ({ env }) => {
    const page = await openFixture(env, '/compat-inline.html', { activate: false });
    const before = await page.evaluate(() => {
      const w = window as unknown as {
        __muts: Array<{ type: string; target: string; added: string[] }>;
        __mo: MutationObserver;
      };
      w.__muts = [];
      const describe = (n: Node): string =>
        n.nodeType === 1 ? (n as Element).localName : `#${n.nodeName}`;
      w.__mo = new MutationObserver((records) => {
        for (const r of records) {
          w.__muts.push({
            type: r.type,
            target: describe(r.target),
            added: Array.from(r.addedNodes).map(describe),
          });
        }
      });
      w.__mo.observe(document, {
        childList: true,
        attributes: true,
        characterData: true,
        subtree: true,
      });
      return {
        body: document.body.innerHTML,
        head: document.head.innerHTML,
        htmlAttrs: document.documentElement.getAttributeNames().sort().join(','),
        bodyAttrs: document.body.getAttributeNames().sort().join(','),
        sheets: document.adoptedStyleSheets.length,
        htmlChildren: Array.from(document.documentElement.children).map((c) => c.localName),
      };
    });

    await activate(env, page);
    // A realistic session: select, open the details panel, save with a note, undo, save again, edit via popover.
    await dragSelect(page, {
      selector: '#plain-after',
      text: 'pyruvate kinase and substrate level phosphorylation',
    });
    await page.getByRole('button', { name: 'Add a note' }).click();
    await page.getByRole('textbox', { name: 'Note' }).fill('keep');
    await page
      .getByRole('dialog', { name: 'Add a note' })
      .getByRole('button', { name: 'Save', exact: true })
      .click();
    await expect(page.getByText('Saved to Inbox')).toBeVisible();
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByText('Save undone')).toBeVisible();
    await expect.poll(() => paintedNormalised(page)).toEqual([]);
    await dragSelect(page, {
      selector: '#plain-after',
      text: 'pyruvate kinase and substrate level phosphorylation',
    });
    // Same quote at the same place after an undo: the soft-deleted highlight is brought back.
    await clickSave(page, SAVE, 'Restored in Inbox');
    await expect.poll(() => paintedNormalised(page)).toHaveLength(1);

    const after = await page.evaluate(() => {
      const w = window as unknown as {
        __muts: Array<{ type: string; target: string; added: string[] }>;
        __mo: MutationObserver;
      };
      const pending = w.__mo.takeRecords();
      const describe = (n: Node): string =>
        n.nodeType === 1 ? (n as Element).localName : `#${n.nodeName}`;
      for (const r of pending) {
        w.__muts.push({
          type: r.type,
          target: describe(r.target),
          added: Array.from(r.addedNodes).map(describe),
        });
      }
      return {
        body: document.body.innerHTML,
        head: document.head.innerHTML,
        htmlAttrs: document.documentElement.getAttributeNames().sort().join(','),
        bodyAttrs: document.body.getAttributeNames().sort().join(','),
        sheets: document.adoptedStyleSheets.length,
        htmlChildren: Array.from(document.documentElement.children).map((c) => c.localName),
        mutations: w.__muts,
        hostCount: document.querySelectorAll('studyvault-overlay').length,
        hostLightChildren: document.querySelector('studyvault-overlay')?.childNodes.length ?? -1,
        highlightNames: Array.from(CSS.highlights.keys()),
      };
    });

    expect(after.body, 'document.body.innerHTML unchanged').toBe(before.body);
    expect(after.head, 'document.head.innerHTML unchanged').toBe(before.head);
    expect(after.htmlAttrs).toBe(before.htmlAttrs);
    expect(after.bodyAttrs).toBe(before.bodyAttrs);
    expect(after.htmlChildren).toEqual([...before.htmlChildren, 'studyvault-overlay']);
    expect(after.hostCount).toBe(1);
    expect(after.hostLightChildren, 'overlay renders only into its shadow root').toBe(0);
    // Painting uses exactly one constructed stylesheet (ADR-004) and no DOM.
    expect(after.sheets - before.sheets).toBe(1);
    expect(after.highlightNames.every((n) => n.startsWith('sv-hl-'))).toBe(true);
    // The only mutation the page ever observed is the host being appended / its own attributes.
    const foreign = after.mutations.filter(
      (m) =>
        !(
          m.target === 'studyvault-overlay' ||
          (m.target === 'html' && m.added.every((a) => a === 'studyvault-overlay'))
        ),
    );
    expect(foreign, 'no mutation outside the overlay host').toEqual([]);
  });

  test('Alt+Shift+T is left to the page when there is no toolbar or toast to focus', async ({
    env,
  }) => {
    const page = await openFixture(env, '/compat-inline.html');
    await page.locator('#plain-after').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Alt+Shift+KeyT');
    const log = await page.evaluate(
      () =>
        (
          window as unknown as {
            __log: { keydown: Array<{ code: string; defaultPrevented: boolean }> };
          }
        ).__log.keydown,
    );
    const t = log.filter((k) => k.code === 'KeyT');
    expect(t).toHaveLength(1);
    expect(t[0]!.defaultPrevented, 'no toolbar -> the page keeps its shortcut').toBe(false);
  });

  test('the native context menu event on a selection is not cancelled', async ({ env }) => {
    const page = await openFixture(env, '/compat-inline.html');
    await page.evaluate(() => {
      const w = window as unknown as { __ctx: boolean[] };
      w.__ctx = [];
      document.addEventListener('contextmenu', (e) => {
        // Bubble phase on document: any capture-phase preventDefault by the extension is visible here.
        w.__ctx.push(e.defaultPrevented);
      });
    });
    await dragSelect(page, { selector: '#plain-after', text: 'pyruvate kinase' });
    await expect(toolbarOf(page)).toBeVisible();
    await page.locator('#plain-after').click({ button: 'right', position: { x: 60, y: 10 } });
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __ctx: boolean[] }).__ctx))
      .toEqual([false]);
  });
});

// ---------------------------------------------------------------------------------------------
// Source identity: canonical URLs and tracking parameters
// ---------------------------------------------------------------------------------------------

test.describe('URL identity (canonical, tracking parameters)', () => {
  async function saveOn(
    env: Env,
    path: string,
    selector: string,
  ): Promise<{ page: Page; text: string }> {
    const page = await openFixture(env, path);
    await tripleClick(page, selector);
    await expect(toolbarOf(page)).toBeVisible();
    const text = normalise((await selectionSnapshot(page)).text);
    await clickSave(page);
    return { page, text };
  }

  /** Visit `path` and report what storage matched and what got painted (activate awaits rehydration). */
  async function visit(
    env: Env,
    page: Page,
    path: string,
  ): Promise<{ stored: number; painted: string[] }> {
    await page.goto(`${env.origin}${path}`);
    await activate(env, page);
    return {
      stored: (await storedHighlights(env, page)).length,
      painted: await paintedNormalised(page),
    };
  }

  test('canonical.html: utm_*, ref=, fragment and bare URL are the same source', async ({
    env,
  }) => {
    const { page, text } = await saveOn(env, '/canonical.html?utm_source=x', '#c');
    expect(text).toContain('glomerular filtration rate');

    for (const path of [
      '/canonical.html?ref=y',
      '/canonical.html',
      '/canonical.html#section-2',
      '/canonical.html?utm_source=a&utm_medium=b&fbclid=zzz',
    ]) {
      await page.goto(`${env.origin}${path}`);
      await activate(env, page);
      await expect
        .poll(() => paintedNormalised(page), { message: path, timeout: 15_000 })
        .toEqual([text]);
    }
  });

  test('without a canonical: tracking params and query order are ignored, other params are not', async ({
    env,
  }) => {
    const { page, text } = await saveOn(env, '/article.html?utm_source=x&b=2&a=1', '#p-intro');

    // Same source: tracking parameters stripped, remaining query sorted.
    for (const path of [
      '/article.html?a=1&b=2',
      '/article.html?a=1&b=2&gclid=abc',
      '/article.html?a=1&b=2#intro',
    ]) {
      await page.goto(`${env.origin}${path}`);
      await activate(env, page);
      await expect
        .poll(() => paintedNormalised(page), { message: path, timeout: 15_000 })
        .toEqual([text]);
    }

    // Different source: a non-tracking parameter is real identity and there is no canonical to merge them.
    const other = await visit(env, page, '/article.html?a=1&b=2&ref=y');
    expect(other, 'ref=y is a different page identity when no canonical is declared').toEqual({
      stored: 0,
      painted: [],
    });
    const bare = await visit(env, page, '/article.html');
    expect(bare).toEqual({ stored: 0, painted: [] });
  });

  test('a canonical on another host is not trusted: two pages claiming it stay separate', async ({
    env,
  }) => {
    const a = await saveOn(env, '/compat-canon-a.html', '#fc');
    const page = a.page;
    await page.goto(`${env.origin}/compat-canon-b.html`);
    await activate(env, page);
    // Same sentence on page B, same foreign canonical: must NOT inherit A's highlight.
    expect(await storedHighlights(env, page)).toEqual([]);
    expect(await paintedNormalised(page)).toEqual([]);

    // And A itself still restores.
    await page.goto(`${env.origin}/compat-canon-a.html`);
    await activate(env, page);
    await expect.poll(() => paintedNormalised(page), { timeout: 15_000 }).toEqual([a.text]);
  });

  test('localhost and 127.0.0.1 are different origins and do not share highlights', async ({
    env,
  }) => {
    const { page, text } = await saveOn(env, '/article.html', '#p-intro');
    await page.goto(`${env.altOrigin}/article.html`);
    await activate(env, page);
    expect(await paintedNormalised(page)).toEqual([]);
    await page.goto(`${env.origin}/article.html`);
    await activate(env, page);
    await expect.poll(() => paintedNormalised(page), { timeout: 15_000 }).toEqual([text]);
  });
});
