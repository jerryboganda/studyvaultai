import { expect, test } from './fixtures';
import {
  activate,
  bodyMarkup,
  expectPaintedExactly,
  liveHighlights,
  norm,
  openExtensionPage,
  pageCounts,
  paintedDetail,
  readDb,
  selectAndSave,
  tripleClick,
  type DragEnd,
} from './helpers.lifecycle';

/**
 * GATE (Phase 1 acceptance): >= 10 distinct passages over >= 6 varied pages, each reloaded and
 * revisited; every passage must be painted with exactly its own text and nothing else.
 * All selections are real mouse gestures; every save goes through the real toolbar.
 */

type How = { triple: string } | { from: DragEnd; to?: DragEnd };

interface Passage {
  name: string;
  how: How;
  /** What the gesture must have selected (checked from the live page selection). */
  mustContain: string;
  /** The DOM text that must end up painted, whitespace-collapsed. */
  expected: string;
  /** Element id the painted range must sit in ('' = spans several blocks, not checked). */
  hostId: string;
}

interface PageSpec {
  path: string;
  /** Visible once the page's own content has rendered (lazy SPA content). */
  ready: string;
  passages: Passage[];
  /** Static pages: <body> markup must be untouched by StudyVault. */
  staticMarkup: boolean;
}

const REPEAT =
  'the ejection fraction is the proportion of end-diastolic volume that is ejected with each beat.';

const PAGES: PageSpec[] = [
  {
    path: '/article.html',
    ready: '#p-refs',
    staticMarkup: true,
    passages: [
      {
        name: 'whole multi-line paragraph (triple click)',
        how: { triple: '#p-multiline' },
        mustContain: 'which maximises stroke volume.',
        expected:
          'Depolarisation spreads from the sinoatrial node across the atria, pauses at the atrioventricular node, and then travels rapidly through the bundle of His and the Purkinje fibres. This delay at the atrioventricular node allows the ventricles to fill completely before they contract, which maximises stroke volume.',
        hostId: 'p-multiline',
      },
      {
        name: 'phrase across inline markup (drag)',
        how: {
          from: {
            selector: '#p-nested',
            phrase: 'volume of blood ejected by one ventricle during a single contraction',
          },
        },
        mustContain: 'volume of blood ejected by one ventricle during a single contraction',
        expected: 'volume of blood ejected by one ventricle during a single contraction',
        hostId: 'p-nested',
      },
      {
        name: 'selection across a paragraph and a heading (multi-block drag)',
        how: {
          from: { selector: '#p-intro', phrase: 'It initiates each heartbeat' },
          to: { selector: '#conduction', phrase: 'Conduction' },
        },
        mustContain: 'at rest.',
        expected:
          'It initiates each heartbeat by spontaneously depolarising at a rate of roughly seventy beats per minute at rest. Conduction',
        hostId: '',
      },
      {
        name: 'blockquote (triple click)',
        how: { triple: '#quote' },
        mustContain: 'Cardiac output equals heart rate multiplied by stroke volume.',
        expected: 'Cardiac output equals heart rate multiplied by stroke volume.',
        hostId: 'quote',
      },
      {
        name: 'list item (triple click)',
        how: { triple: '#list li:first-child' },
        mustContain: 'Preload is the ventricular stretch at end diastole.',
        expected: 'Preload is the ventricular stretch at end diastole.',
        hostId: 'list',
      },
      {
        name: 'repeated sentence, first occurrence (drag)',
        how: { from: { selector: '#p-repeat-1', phrase: REPEAT } },
        mustContain: REPEAT,
        expected: REPEAT,
        hostId: 'p-repeat-1',
      },
      {
        name: 'repeated sentence, second occurrence (drag)',
        how: { from: { selector: '#p-repeat-2', phrase: REPEAT } },
        mustContain: REPEAT,
        expected: REPEAT,
        hostId: 'p-repeat-2',
      },
    ],
  },
  {
    path: '/spa/one',
    ready: '#view p',
    staticMarkup: false,
    passages: [
      {
        name: 'SPA route one (lazy content)',
        how: { triple: '#view p:nth-of-type(1)' },
        mustContain: 'baroreceptor reflex',
        expected:
          'Route one explains how the baroreceptor reflex buffers short-term changes in arterial pressure.',
        hostId: '',
      },
    ],
  },
  {
    path: '/spa/two',
    ready: '#view p',
    staticMarkup: false,
    passages: [
      {
        name: 'SPA route two (lazy content)',
        how: { triple: '#view p:nth-of-type(1)' },
        mustContain: 'renin angiotensin system',
        expected:
          'Route two explains how the renin angiotensin system defends blood pressure over hours to days.',
        hostId: '',
      },
    ],
  },
  {
    path: '/canonical.html',
    ready: '#c',
    staticMarkup: true,
    passages: [
      {
        name: 'page with a same-host canonical link',
        how: { triple: '#c' },
        mustContain: 'afferent arteriolar tone.',
        expected:
          'The canonical page states that glomerular filtration rate is regulated by afferent arteriolar tone.',
        hostId: 'c',
      },
    ],
  },
  {
    path: '/dark.html',
    ready: '#d',
    staticMarkup: true,
    passages: [
      {
        name: 'dark colour-scheme page',
        how: { triple: '#d' },
        mustContain: 'thick ascending limb.',
        expected:
          'Furosemide inhibits the sodium potassium chloride cotransporter in the thick ascending limb.',
        hostId: 'd',
      },
    ],
  },
  {
    path: '/hostile.html',
    ready: '#hostile-p',
    staticMarkup: true,
    passages: [
      {
        name: 'hostile CSS page (4px root font, zoom, uppercase, hidden buttons)',
        how: { triple: '#hostile-p' },
        mustContain: 'must still be visible and usable.',
        expected:
          'This paragraph lives on a page that sets a four pixel root font size, transforms the body, and hides every button element. The capture interface must still be visible and usable.',
        hostId: 'hostile-p',
      },
    ],
  },
  {
    path: '/mutable.html',
    ready: '#target',
    staticMarkup: true,
    passages: [
      {
        name: 'mutable page, original text',
        how: {
          from: {
            selector: '#target',
            phrase:
              'Calcium channels open when the membrane depolarises beyond the threshold potential.',
          },
        },
        mustContain: 'beyond the threshold potential.',
        expected:
          'Calcium channels open when the membrane depolarises beyond the threshold potential.',
        hostId: 'target',
      },
    ],
  },
];

const TOTAL = PAGES.reduce((n, p) => n + p.passages.length, 0);

test.describe('GATE: >= 10 passages over >= 6 pages survive reload and revisit', () => {
  test('every passage is painted with exactly its own text, nothing else', async ({
    context,
    extensionId,
    fixtureServer,
  }) => {
    test.setTimeout(420_000);
    expect(TOTAL).toBeGreaterThanOrEqual(10);
    expect(new Set(PAGES.map((p) => p.path)).size).toBeGreaterThanOrEqual(6);
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: fixtureServer.origin,
    });
    const ext = await openExtensionPage(context, extensionId);
    const pageErrors: string[] = [];

    // ---- Phase 1: capture --------------------------------------------------------------------
    const markupBefore = new Map<string, string>();
    for (const spec of PAGES) {
      const page = await context.newPage();
      page.on('pageerror', (e) => pageErrors.push(`${spec.path}: ${e.message}`));
      await page.goto(`${fixtureServer.origin}${spec.path}`);
      await expect(page.locator(spec.ready).first()).toBeVisible();
      if (spec.staticMarkup) markupBefore.set(spec.path, await bodyMarkup(page));
      await activate(ext, page);
      await page.bringToFront();

      const painted: string[] = [];
      for (const passage of spec.passages) {
        const toast = await selectAndSave(page, passage.how, passage.mustContain);
        expect(toast, `${spec.path} :: ${passage.name}`).toBe('Saved to Inbox');
        painted.push(passage.expected);
        // The save paints immediately, and only what has been saved on this page so far.
        await expectPaintedExactly(page, painted);
      }
      if (spec.staticMarkup) {
        expect(await bodyMarkup(page), `${spec.path}: page markup untouched`).toBe(
          markupBefore.get(spec.path),
        );
      }
      await page.close();
    }

    const afterCapture = await readDb(ext);
    expect(liveHighlights(afterCapture)).toHaveLength(TOTAL);
    expect(afterCapture.sources).toHaveLength(PAGES.length);
    const provenance = (db: typeof afterCapture) =>
      JSON.stringify(
        db.highlights
          .map((h) => ({ id: h.id, q: h.exactQuote, a: h.anchorSet, hash: h.quoteHash }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      );
    const provenanceAfterCapture = provenance(afterCapture);

    // ---- Phase 2: revisit in a fresh tab, then hard reload ------------------------------------
    for (const spec of PAGES) {
      const want = spec.passages.map((p) => p.expected);
      const page = await context.newPage();
      page.on('pageerror', (e) => pageErrors.push(`${spec.path}: ${e.message}`));
      await page.goto(`${fixtureServer.origin}${spec.path}`);
      await expect(page.locator(spec.ready).first()).toBeVisible();
      await activate(ext, page);
      await page.bringToFront();

      await expectPaintedExactly(page, want);
      const detail = await paintedDetail(page);
      for (const passage of spec.passages) {
        if (passage.hostId === '') continue;
        // "Own place": a range with this text lives in the element the user selected it in.
        // (Two passages may have identical text; they are told apart by where they sit.)
        const own = detail.filter(
          (d) => norm(d.text) === norm(passage.expected) && d.hostId === passage.hostId,
        );
        expect(
          own,
          `${spec.path} :: ${passage.name} painted once, in #${passage.hostId} (found ${JSON.stringify(
            detail.filter((d) => norm(d.text) === norm(passage.expected)).map((d) => d.hostId),
          )})`,
        ).toHaveLength(1);
      }

      // Non-breakage on the painted page: a real triple-click still selects the passage's own
      // text, and a real Ctrl+C copies exactly that text (case-insensitive: hostile.html
      // upper-cases what it renders).
      const probe = spec.passages.find((p) => 'triple' in p.how);
      if (probe && 'triple' in probe.how) {
        await tripleClick(page, probe.how.triple);
        const selected = norm(await page.evaluate(() => window.getSelection()?.toString() ?? ''));
        expect(selected.toLowerCase(), `${spec.path}: selection on a painted passage`).toBe(
          norm(probe.expected).toLowerCase(),
        );
        await page.keyboard.press('Control+C');
        const copied = norm(await page.evaluate(() => navigator.clipboard.readText()));
        expect(copied.toLowerCase(), `${spec.path}: copy from a painted passage`).toBe(
          selected.toLowerCase(),
        );
      }
      // Links keep working: the article's in-page reference link and the SPA's own navigation.
      if (spec.path === '/article.html') {
        await page.locator('#link-refs').click();
        await expect.poll(() => page.evaluate(() => location.hash)).toBe('#refs');
        await expectPaintedExactly(page, want);
      }
      if (spec.path === '/spa/one') {
        await page.locator('#nav-two').click();
        await expect.poll(() => page.evaluate(() => location.pathname)).toBe('/spa/two');
        await expect(page.locator('#view h1')).toHaveText('Route Two');
        await expectPaintedExactly(page, [PAGES[2]!.passages[0]!.expected]);
        await page.goBack();
        await expect(page.locator('#view h1')).toHaveText('Route One');
        await expectPaintedExactly(page, want);
      }

      await page.reload();
      await expect(page.locator(spec.ready).first()).toBeVisible();
      await activate(ext, page);
      await expectPaintedExactly(page, want);
      if (spec.staticMarkup) {
        expect(await bodyMarkup(page), `${spec.path}: markup untouched after rehydration`).toBe(
          markupBefore.get(spec.path),
        );
      }
      await page.close();
    }

    // ---- Phase 3: identity: tracking parameters (utm_*, fbclid, ...) fold into the same source -----
    for (const query of ['?utm_source=newsletter', '?utm_campaign=somewhere']) {
      const page = await context.newPage();
      await page.goto(`${fixtureServer.origin}/canonical.html${query}`);
      await activate(ext, page);
      await expectPaintedExactly(page, [
        'The canonical page states that glomerular filtration rate is regulated by afferent arteriolar tone.',
      ]);
      await page.close();
    }

    // ---- Final data checks ----------------------------------------------------------------------
    const final = await readDb(ext);
    expect(liveHighlights(final)).toHaveLength(TOTAL);
    expect(final.sources, 'revisiting must not create new sources').toHaveLength(PAGES.length);
    expect(provenance(final), 'exactQuote and anchors are never modified by rehydration').toBe(
      provenanceAfterCapture,
    );
    await expect
      .poll(async () => (await readDb(ext)).highlights.map((h) => h.resolveStatus).sort(), {
        timeout: 15_000,
        message: 'every passage is persisted as resolved',
      })
      .toEqual(Array(TOTAL).fill('resolved'));
    expect(pageErrors, 'no uncaught page errors').toEqual([]);
  });

  test('identity: fragments and tracking parameters are the same page; other origins and queries are not', async ({
    context,
    extensionId,
    fixtureServer,
  }) => {
    test.setTimeout(120_000);
    const QUOTE = 'Cardiac output equals heart rate multiplied by stroke volume.';
    const ext = await openExtensionPage(context, extensionId);
    const first = await context.newPage();
    await first.goto(`${fixtureServer.origin}/article.html`);
    await activate(ext, first);
    await first.bringToFront();
    await selectAndSave(first, { triple: '#quote' }, QUOTE);
    await first.close();

    const same = [
      '/article.html#refs',
      '/article.html?utm_source=newsletter#refs',
      '/article.html?fbclid=abc&utm_medium=email',
    ];
    for (const path of same) {
      const page = await context.newPage();
      await page.goto(`${fixtureServer.origin}${path}`);
      await activate(ext, page);
      await expectPaintedExactly(page, [QUOTE]);
      await page.close();
    }

    // A real query parameter, or another origin (localhost vs 127.0.0.1), is another page: the
    // highlight must not be painted there, and nothing may be reported as lost.
    const different = [
      `${fixtureServer.origin}/article.html?section=2`,
      `${fixtureServer.altOrigin}/article.html`,
    ];
    for (const url of different) {
      const page = await context.newPage();
      await page.goto(url);
      const tabId = await activate(ext, page);
      await expect
        .poll(async () => (await pageCounts(ext, tabId))?.total, { message: url })
        .toBe(0);
      expect(await paintedDetail(page), url).toEqual([]);
      await page.close();
    }
    const db = await readDb(ext);
    expect(liveHighlights(db)).toHaveLength(1);
    expect(db.sources).toHaveLength(1);
  });

  test('painted pages stay usable: selection, copy, in-page and cross-page links', async ({
    context,
    extensionId,
    fixtureServer,
  }) => {
    test.setTimeout(120_000);
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: fixtureServer.origin,
    });
    const ext = await openExtensionPage(context, extensionId);
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(`${fixtureServer.origin}/lifecycle-links.html`);
    const before = await bodyMarkup(page);
    await activate(ext, page);
    await page.bringToFront();

    // A highlight that contains two links.
    const para =
      'Review the dark article for contrast, or jump to the end of this page for the summary of the topic.';
    await selectAndSave(page, { triple: '#para' }, 'summary of the topic.');
    await expectPaintedExactly(page, [para]);
    expect(await bodyMarkup(page)).toBe(before);

    // Selection inside and across painted text still works, and copy is untouched.
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await tripleClick(page, '#second');
    const second =
      'A second paragraph about glomerular filtration stays unhighlighted for the selection checks.';
    expect(norm(await page.evaluate(() => window.getSelection()?.toString() ?? ''))).toBe(second);
    await page.keyboard.press('Control+C');
    expect(norm(await page.evaluate(() => navigator.clipboard.readText()))).toBe(second);

    // In-page link inside a painted highlight: the page's own handling runs.
    await page.locator('#jump').click();
    await expect.poll(() => page.evaluate(() => location.hash)).toBe('#end');
    await expect
      .poll(() => page.evaluate(() => window.scrollY), { message: 'page scrolled to #end' })
      .toBeGreaterThan(500);
    // A fragment jump is not a route change: the highlight is still painted, unchanged.
    await expectPaintedExactly(page, [para]);

    // Cross-document link inside a painted highlight navigates.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator('#go').click();
    await expect(page).toHaveURL(`${fixtureServer.origin}/dark.html`);
    await expect(page.locator('#d')).toBeVisible();
    expect(await paintedDetail(page), 'nothing from the previous page is painted').toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
