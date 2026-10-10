import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import {
  activate,
  dragSelect,
  expectPaintedExactly,
  liveHighlights,
  norm,
  openExtensionPage,
  pageCounts,
  paintedDetail,
  readDb,
  saveSelection,
  savedToast,
  selectAndSave,
  tabIdOf,
  tabRpc,
  toastAction,
  toolbarOf,
  tripleClick,
} from './helpers.lifecycle';

/**
 * Lifecycle E2E (real Chromium, real built extension, real input):
 *  - SPA route changes with late-rendering content
 *  - source text mutated after save (edited / removed / prefixed)
 *  - undo, duplicate, delete + undo, two tabs on one URL
 *  - performance evidence on a 1500-paragraph page with 40 highlights
 */

const ROUTE_ONE =
  'Route one explains how the baroreceptor reflex buffers short-term changes in arterial pressure.';
const ROUTE_TWO =
  'Route two explains how the renin angiotensin system defends blood pressure over hours to days.';

// -----------------------------------------------------------------------------------------------
// SPA
// -----------------------------------------------------------------------------------------------

test.describe('SPA navigation (history.pushState, content rendered 350 ms late)', () => {
  test('highlights follow the route and repaint when lazily rendered content returns', async ({
    context,
    extensionId,
    fixtureServer,
  }) => {
    test.setTimeout(150_000);
    const origin = fixtureServer.origin;
    const ext = await openExtensionPage(context, extensionId);
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    await page.goto(`${origin}/spa/one`);
    await expect(page.locator('#view h1')).toHaveText('Route One');
    const tabId = await activate(ext, page);
    await page.bringToFront();

    expect(await selectAndSave(page, { triple: '#view p:nth-of-type(1)' }, 'baroreceptor')).toBe(
      'Saved to Inbox',
    );
    await expectPaintedExactly(page, [ROUTE_ONE]);

    // Sample the painted set every 5 ms together with the path, for the rest of the navigation.
    await page.evaluate(() => {
      const w = window as unknown as {
        __samples: Array<{ path: string; texts: string[] }>;
      };
      w.__samples = [];
      let last = '';
      setInterval(() => {
        const texts: string[] = [];
        for (const [name, hl] of CSS.highlights) {
          if (!name.startsWith('sv-hl-') || name === 'sv-hl-active') continue;
          for (const r of hl as unknown as Iterable<Range>) {
            const t = r.toString().replace(/\s+/g, ' ').trim();
            if (t) texts.push(t);
          }
        }
        texts.sort();
        const key = `${location.pathname}|${texts.join('¦')}`;
        if (key !== last) {
          last = key;
          w.__samples.push({ path: location.pathname, texts });
        }
      }, 5);
    });

    // In-app navigation (the app calls history.pushState and renders 350 ms later).
    await page.locator('#nav-two').click();
    await expect.poll(() => page.evaluate(() => location.pathname)).toBe('/spa/two');
    await expect(page.locator('#view h1')).toHaveText('Route Two');
    // Route two has no highlight yet: the rehydrator must settle on an empty page.
    await expect.poll(async () => (await pageCounts(ext, tabId))?.total).toBe(0);
    await expectPaintedExactly(page, []);

    expect(await selectAndSave(page, { triple: '#view p:nth-of-type(1)' }, 'renin')).toBe(
      'Saved to Inbox',
    );
    await expectPaintedExactly(page, [ROUTE_TWO]);

    // Back (popstate): route one's highlight returns once its text has rendered again.
    await page.goBack();
    await expect.poll(() => page.evaluate(() => location.pathname)).toBe('/spa/one');
    await expect(page.locator('#view h1')).toHaveText('Route One');
    await expectPaintedExactly(page, [ROUTE_ONE]);

    await page.goForward();
    await expect(page.locator('#view h1')).toHaveText('Route Two');
    await expectPaintedExactly(page, [ROUTE_TWO]);

    // Link clicks (not popstate) in both directions.
    await page.locator('#nav-one').click();
    await expect(page.locator('#view h1')).toHaveText('Route One');
    await expectPaintedExactly(page, [ROUTE_ONE]);
    await page.locator('#nav-two').click();
    await expect(page.locator('#view h1')).toHaveText('Route Two');
    await expectPaintedExactly(page, [ROUTE_TWO]);
    await page.locator('#nav-one').click();
    await expect(page.locator('#view h1')).toHaveText('Route One');
    await expectPaintedExactly(page, [ROUTE_ONE]);

    // Never painted on the wrong route, at any sampled moment.
    const samples = await page.evaluate(
      () =>
        (window as unknown as { __samples: Array<{ path: string; texts: string[] }> }).__samples,
    );
    const wrong = samples.filter((s) =>
      s.texts.some((t) =>
        s.path === '/spa/one' ? t !== ROUTE_ONE : s.path === '/spa/two' ? t !== ROUTE_TWO : true,
      ),
    );
    expect(
      wrong,
      `${samples.length} sampled states, none may show a highlight on the wrong route`,
    ).toEqual([]);
    expect(
      samples.some((s) => s.path === '/spa/two' && s.texts.includes(ROUTE_TWO)),
      'route two highlight was painted at some point',
    ).toBe(true);

    // Late rendering must not have been recorded as "lost".
    await expect
      .poll(async () => (await readDb(ext)).highlights.map((h) => h.resolveStatus).sort(), {
        timeout: 15_000,
      })
      .toEqual(['resolved', 'resolved']);

    // Hard reloads (fresh document, lazily rendered content, new content script).
    await page.goto(`${origin}/spa/one`);
    await activate(ext, page);
    await expect(page.locator('#view h1')).toHaveText('Route One');
    await expectPaintedExactly(page, [ROUTE_ONE]);
    await page.reload();
    await activate(ext, page);
    await expectPaintedExactly(page, [ROUTE_ONE]);
    await page.goto(`${origin}/spa/two`);
    await activate(ext, page);
    await expectPaintedExactly(page, [ROUTE_TWO]);

    expect(pageErrors).toEqual([]);
  });

  test('rapid route changes and rapid back/forward end on one consistent paint', async ({
    context,
    extensionId,
    fixtureServer,
  }) => {
    test.setTimeout(150_000);
    const TEXT = {
      a: 'Route A covers the Frank-Starling mechanism relating end-diastolic volume to stroke volume.',
      b: 'Route B covers the Bainbridge reflex that raises heart rate when atrial stretch increases.',
      c: 'Route C covers the Bezold-Jarisch reflex producing bradycardia and hypotension on ventricular stretch.',
    } as const;
    const ext = await openExtensionPage(context, extensionId);
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(`${fixtureServer.origin}/lifecycle-spa.html`);
    await expect(page.locator('#view h1')).toHaveText('Route A');
    await activate(ext, page);
    await page.bringToFront();

    // One highlight per route, saved through the toolbar.
    for (const route of ['a', 'b', 'c'] as const) {
      if (route !== 'a') {
        await page.locator(`#go-${route}`).click();
        await expect(page.locator('#view h1')).toHaveText(`Route ${route.toUpperCase()}`);
      }
      await selectAndSave(page, { triple: '#view p' }, TEXT[route].slice(0, 20));
      await expectPaintedExactly(page, [TEXT[route]]);
    }

    await page.evaluate(() => {
      const w = window as unknown as { __samples: Array<{ search: string; texts: string[] }> };
      w.__samples = [];
      let last = '';
      setInterval(() => {
        const texts: string[] = [];
        for (const [name, hl] of CSS.highlights) {
          if (!name.startsWith('sv-hl-') || name === 'sv-hl-active') continue;
          for (const r of hl as unknown as Iterable<Range>) {
            const t = r.toString().replace(/\s+/g, ' ').trim();
            if (t) texts.push(t);
          }
        }
        const key = `${location.search}|${texts.join('¦')}`;
        if (key !== last) {
          last = key;
          w.__samples.push({ search: location.search, texts });
        }
      }, 5);
    });

    // Five link clicks as fast as real input allows, ending on C.
    // History stack so far: a, b, c (saving), then the five clicks below.
    const stack = ['a', 'b', 'c'];
    for (const route of ['b', 'c', 'a', 'b', 'c'] as const) {
      await page.locator(`#go-${route}`).click();
      stack.push(route);
    }
    await expect(page.locator('#view h1')).toHaveText('Route C');
    await expectPaintedExactly(page, [TEXT.c]);

    // Four history traversals queued back to back: lands four entries back.
    const settled = stack[stack.length - 1 - 4] as keyof typeof TEXT;
    expect(settled).toBe('b');
    await page.evaluate(() => {
      for (let i = 0; i < 4; i++) history.back();
    });
    await expect
      .poll(() => page.evaluate(() => location.search), { message: 'history settled' })
      .toBe(`?r=${settled}`);
    await expect(page.locator('#view h1')).toHaveText(`Route ${settled.toUpperCase()}`);
    await expectPaintedExactly(page, [TEXT[settled]]);

    const samples = await page.evaluate(
      () =>
        (window as unknown as { __samples: Array<{ search: string; texts: string[] }> }).__samples,
    );
    const textFor = (search: string) =>
      TEXT[(new URLSearchParams(search).get('r') ?? 'a') as keyof typeof TEXT];
    const wrong = samples.filter((s) => s.texts.some((t) => t !== textFor(s.search)));
    expect(wrong, `${samples.length} sampled states`).toEqual([]);

    // Late/lost outcomes must not have flagged any highlight as lost.
    await expect
      .poll(async () => (await readDb(ext)).highlights.map((h) => h.resolveStatus).sort(), {
        timeout: 15_000,
      })
      .toEqual(['resolved', 'resolved', 'resolved']);
    expect(pageErrors).toEqual([]);
  });
});

test.describe('hash-routed single-page app (#/route)', () => {
  test('each #/route has its own highlights; a plain fragment is not a route', async ({
    context,
    extensionId,
    fixtureServer,
  }) => {
    test.setTimeout(120_000);
    const ALPHA = 'Alpha route explains how the Frank-Starling curve shifts with contractility.';
    const BETA = 'Beta route explains how afterload reduces the velocity of fibre shortening.';
    const origin = fixtureServer.origin;
    const ext = await openExtensionPage(context, extensionId);
    const page = await context.newPage();
    await page.goto(`${origin}/lifecycle-hash.html#/alpha`);
    await expect(page.locator('#view h1')).toHaveText('Alpha');
    await activate(ext, page);
    await page.bringToFront();
    await selectAndSave(page, { triple: '#view p' }, 'Frank-Starling');
    await expectPaintedExactly(page, [ALPHA]);

    await page.locator('#go-beta').click();
    await expect(page.locator('#view h1')).toHaveText('Beta');
    await expectPaintedExactly(page, []);
    await selectAndSave(page, { triple: '#view p' }, 'afterload');
    await expectPaintedExactly(page, [BETA]);

    await page.goBack();
    await expect(page.locator('#view h1')).toHaveText('Alpha');
    await expectPaintedExactly(page, [ALPHA]);

    // Fresh document at each route.
    await page.goto(`${origin}/lifecycle-hash.html#/beta`);
    await page.reload();
    await activate(ext, page);
    await expect(page.locator('#view h1')).toHaveText('Beta');
    await expectPaintedExactly(page, [BETA]);

    const db = await readDb(ext);
    expect(db.sources.map((x) => x.visitedKey).sort()).toEqual([
      `${origin}/lifecycle-hash.html#/alpha`,
      `${origin}/lifecycle-hash.html#/beta`,
    ]);
    await expect
      .poll(async () => (await readDb(ext)).highlights.map((h) => h.resolveStatus).sort())
      .toEqual(['resolved', 'resolved']);
  });
});

test.describe('input edge cases', () => {
  test('double-clicking Save stores the selection once and reports no error', async ({
    context,
    extensionId,
    fixtureServer,
  }) => {
    test.setTimeout(90_000);
    const ext = await openExtensionPage(context, extensionId);
    const page = await context.newPage();
    await page.goto(`${fixtureServer.origin}/article.html`);
    await activate(ext, page);
    await page.bringToFront();
    await tripleClick(page, '#quote');
    await expect(toolbarOf(page)).toBeVisible();
    await page.getByRole('button', { name: 'Save selection', exact: true }).dblclick();
    await expect(toolbarOf(page)).toHaveCount(0);
    await expectPaintedExactly(page, [QUOTE]);
    await expect(page.locator('.sv-toast-error')).toHaveCount(0);
    const db = await readDb(ext);
    expect(liveHighlights(db)).toHaveLength(1);
    expect(db.highlightBanks).toHaveLength(1);
  });
});

// -----------------------------------------------------------------------------------------------
// Source mutated after save
// -----------------------------------------------------------------------------------------------

const TARGET =
  'Calcium channels open when the membrane depolarises beyond the threshold potential.';
const TARGET_EDITED =
  'Calcium channels open when the membrane repolarises beyond the threshold potential.';
const FILLER = 'An unrelated filler paragraph keeps the page long enough to scroll.';

const recentCard = (page: Page, quoteStart: string) =>
  page.locator('article.hl-card', { hasText: quoteStart });

test.describe('source mutated after save (mutable.html variants)', () => {
  test('edited -> changed and painted; removed -> orphaned and never painted; prefixed -> resolved at the shifted place', async ({
    context,
    extensionId,
    fixtureServer,
  }) => {
    test.setTimeout(240_000);
    const origin = fixtureServer.origin;
    const ext = await openExtensionPage(context, extensionId);
    const statuses = async (): Promise<Record<string, string>> => {
      const db = await readDb(ext);
      return Object.fromEntries(
        liveHighlights(db).map((h) => [norm(h.exactQuote).slice(0, 12), h.resolveStatus]),
      );
    };
    const KEY_TARGET = TARGET.slice(0, 12);
    const KEY_FILLER = FILLER.slice(0, 12);

    try {
      fixtureServer.setVariant('original');
      const page = await context.newPage();
      await page.goto(`${origin}/mutable.html`);
      await activate(ext, page);
      await page.bringToFront();

      // Two highlights: the target sentence and an unrelated filler paragraph.
      expect(
        await selectAndSave(page, { from: { selector: '#target', phrase: TARGET } }, TARGET),
      ).toBe('Saved to Inbox');
      expect(await selectAndSave(page, { triple: 'main > p:last-of-type' }, FILLER)).toBe(
        'Saved to Inbox',
      );
      await expectPaintedExactly(page, [TARGET, FILLER]);
      await expect
        .poll(statuses, { timeout: 15_000 })
        .toEqual({ [KEY_TARGET]: 'resolved', [KEY_FILLER]: 'resolved' });
      const quoteInDb = liveHighlights(await readDb(ext)).map((h) => h.exactQuote);
      const originalTop = await page.evaluate(
        () => document.getElementById('target')!.getBoundingClientRect().top + window.scrollY,
      );

      // ---- (1) one word edited -> changed, still painted ---------------------------------------
      fixtureServer.setVariant('edited');
      await page.reload();
      const tabId = await activate(ext, page);
      await expectPaintedExactly(page, [TARGET_EDITED, FILLER]);
      await expect
        .poll(() => pageCounts(ext, tabId))
        .toMatchObject({ total: 2, resolved: 1, changed: 1, orphaned: 0, ambiguous: 0 });
      await expect
        .poll(statuses, { timeout: 15_000, message: 'edited text persists as "changed"' })
        .toEqual({ [KEY_TARGET]: 'changed', [KEY_FILLER]: 'resolved' });
      const edited = liveHighlights(await readDb(ext)).find((h) =>
        h.exactQuote.startsWith('Calcium'),
      );
      expect(edited?.resolveConfidence ?? 0).toBeGreaterThan(0.85);
      // The saved quote is provenance: it still says what the user originally saw.
      expect(liveHighlights(await readDb(ext)).map((h) => h.exactQuote)).toEqual(quoteInDb);

      // The side panel (Recent) says "Source changed" for it.
      const panel = await openExtensionPage(context, extensionId, 'sidepanel.html');
      await panel.getByRole('tab', { name: /Recent/ }).click();
      await expect(recentCard(panel, 'Calcium channels')).toContainText('Source changed');
      await expect(recentCard(panel, 'An unrelated filler')).toContainText('Resolved');

      // ---- (2) paragraph removed -> orphaned, NOT painted, never on other text ------------------
      fixtureServer.setVariant('removed');
      await page.reload();
      await activate(ext, page);
      await expect
        .poll(() => pageCounts(ext, tabId), { message: 'removed text is reported as orphaned' })
        .toMatchObject({ total: 2, resolved: 1, orphaned: 1, changed: 0 });
      await expectPaintedExactly(page, [FILLER]);
      expect(
        (await paintedDetail(page)).filter((p) => p.hostId === 'target'),
        'nothing may be painted on the text that replaced the removed paragraph',
      ).toEqual([]);
      await expect
        .poll(statuses, { timeout: 15_000, message: 'orphaned state persists' })
        .toEqual({ [KEY_TARGET]: 'orphaned', [KEY_FILLER]: 'resolved' });
      await expect(recentCard(panel, 'Calcium channels')).toContainText('Orphaned');
      await expect(recentCard(panel, 'Calcium channels')).toContainText('Calcium channels');

      // ---- (3) content inserted above -> still resolved, at the shifted position ----------------
      fixtureServer.setVariant('prefixed');
      await page.reload();
      await activate(ext, page);
      await expectPaintedExactly(page, [TARGET, FILLER]);
      const detail = await paintedDetail(page);
      expect(detail.find((d) => norm(d.text) === TARGET)?.hostId).toBe('target');
      const shifted = await page.evaluate(() => {
        const range = [...CSS.highlights]
          .filter(([n]) => n.startsWith('sv-hl-') && n !== 'sv-hl-active')
          .flatMap(([, h]) => [...(h as unknown as Iterable<Range>)])
          .find((r) => r.toString().startsWith('Calcium'));
        const target = document.getElementById('target')!.getBoundingClientRect();
        const painted = range!.getBoundingClientRect();
        return {
          targetTop: target.top + window.scrollY,
          paintedTop: painted.top + window.scrollY,
        };
      });
      expect(Math.abs(shifted.paintedTop - shifted.targetTop)).toBeLessThan(30);
      expect(shifted.targetTop, 'the target really moved down').toBeGreaterThan(originalTop + 60);
      await expect
        .poll(() => pageCounts(ext, tabId))
        .toMatchObject({ total: 2, resolved: 2, orphaned: 0, changed: 0 });
      await expect
        .poll(statuses, { timeout: 15_000, message: 'orphaned -> resolved is persisted again' })
        .toEqual({ [KEY_TARGET]: 'resolved', [KEY_FILLER]: 'resolved' });
      await expect(recentCard(panel, 'Calcium channels')).toContainText('Resolved');
    } finally {
      fixtureServer.setVariant('original');
    }
  });
});

// -----------------------------------------------------------------------------------------------
// Undo / duplicate / delete / two tabs
// -----------------------------------------------------------------------------------------------

const QUOTE = 'Cardiac output equals heart rate multiplied by stroke volume.';
const MULTILINE =
  'Depolarisation spreads from the sinoatrial node across the atria, pauses at the atrioventricular node, and then travels rapidly through the bundle of His and the Purkinje fibres. This delay at the atrioventricular node allows the ventricles to fill completely before they contract, which maximises stroke volume.';

/** Click once on painted text (collapsed selection) to open the highlight popover. */
async function openPopover(page: Page, selector: string): Promise<void> {
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await page
    .locator(selector)
    .first()
    .click({ position: { x: 24, y: 8 } });
  await expect(page.getByRole('dialog', { name: 'Highlight details' })).toBeVisible();
}

test.describe('undo, duplicate, delete and consistency between tabs', () => {
  test('undo removes the highlight, re-saving restores the same row, a duplicate is reported', async ({
    context,
    extensionId,
    fixtureServer,
  }) => {
    test.setTimeout(120_000);
    const ext = await openExtensionPage(context, extensionId);
    const page = await context.newPage();
    await page.goto(`${fixtureServer.origin}/article.html`);
    await activate(ext, page);
    await page.bringToFront();

    // Save, then Undo.
    expect(await selectAndSave(page, { triple: '#quote' }, QUOTE)).toBe('Saved to Inbox');
    await expectPaintedExactly(page, [QUOTE]);
    const created = await readDb(ext);
    expect(liveHighlights(created)).toHaveLength(1);
    const firstId = liveHighlights(created)[0]!.id;

    await toastAction(page, 'Saved to Inbox').click();
    await expect(page.getByText('Save undone')).toBeVisible();
    await expectPaintedExactly(page, []);
    await expect
      .poll(async () => liveHighlights(await readDb(ext)).length, { message: 'undo is persisted' })
      .toBe(0);
    const afterUndo = (await readDb(ext)).highlights.find((h) => h.id === firstId);
    expect(afterUndo?.deletedAt, 'undo is a recoverable soft delete').not.toBeNull();

    // Side panel: gone from Recent.
    const panel = await openExtensionPage(context, extensionId, 'sidepanel.html');
    await panel.getByRole('tab', { name: /Recent/ }).click();
    await expect(panel.getByText('Nothing saved yet')).toBeVisible();

    // Same selection again: the deleted row is restored, not duplicated.
    expect(await selectAndSave(page, { triple: '#quote' }, QUOTE)).toBe('Restored in Inbox');
    await expectPaintedExactly(page, [QUOTE]);
    const restored = await readDb(ext);
    expect(restored.highlights).toHaveLength(1);
    expect(liveHighlights(restored)[0]?.id).toBe(firstId);

    // Same selection a third time: "Already saved", no second row, no second paint, no Undo.
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await tripleClick(page, '#quote');
    await expect(toolbarOf(page)).toBeVisible();
    await page.getByRole('button', { name: 'Save selection', exact: true }).click();
    await expect(page.getByText('Already saved in Inbox')).toBeVisible();
    await expect(toastAction(page, 'Already saved in Inbox')).toHaveCount(0);
    await expectPaintedExactly(page, [QUOTE]);
    const dup = await readDb(ext);
    expect(dup.highlights).toHaveLength(1);
    expect(dup.highlightBanks).toHaveLength(1);
  });

  test('delete from the popover, Undo restores it (page and data)', async ({
    context,
    extensionId,
    fixtureServer,
  }) => {
    test.setTimeout(120_000);
    const ext = await openExtensionPage(context, extensionId);
    const page = await context.newPage();
    await page.goto(`${fixtureServer.origin}/article.html`);
    await activate(ext, page);
    await page.bringToFront();
    await selectAndSave(page, { triple: '#quote' }, QUOTE);
    await expectPaintedExactly(page, [QUOTE]);
    const id = liveHighlights(await readDb(ext))[0]!.id;

    await openPopover(page, '#quote');
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.getByText('Highlight deleted')).toBeVisible();
    await expectPaintedExactly(page, []);
    await expect
      .poll(async () => (await readDb(ext)).highlights.find((h) => h.id === id)?.deletedAt)
      .not.toBeNull();

    await toastAction(page, 'Highlight deleted').click();
    await expect(page.getByText('Highlight restored')).toBeVisible();
    await expectPaintedExactly(page, [QUOTE]);
    await expect
      .poll(async () => (await readDb(ext)).highlights.find((h) => h.id === id)?.deletedAt)
      .toBeNull();
  });

  test('two tabs on the same URL stay consistent (data epoch)', async ({
    context,
    extensionId,
    fixtureServer,
  }) => {
    test.setTimeout(150_000);
    const url = `${fixtureServer.origin}/article.html`;
    const ext = await openExtensionPage(context, extensionId);
    const a = await context.newPage();
    await a.goto(url);
    const b = await context.newPage();
    await b.goto(url);
    expect(a.url()).toBe(b.url());
    expect(await tabIdOf(ext, a)).not.toBe(await tabIdOf(ext, b));
    await activate(ext, a);
    await activate(ext, b);

    // Save in A -> B paints it without a reload.
    await a.bringToFront();
    await selectAndSave(a, { triple: '#quote' }, QUOTE);
    await expectPaintedExactly(a, [QUOTE]);
    await expectPaintedExactly(b, [QUOTE]);

    // A second, different passage saved in B shows up in A.
    await b.bringToFront();
    await selectAndSave(b, { triple: '#p-multiline' }, 'maximises stroke volume');
    await expectPaintedExactly(b, [QUOTE, MULTILINE]);
    await expectPaintedExactly(a, [QUOTE, MULTILINE]);

    // Delete in A -> disappears in B. Undo in A -> reappears in B.
    await a.bringToFront();
    await openPopover(a, '#quote');
    await a.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(a.getByText('Highlight deleted')).toBeVisible();
    await expectPaintedExactly(a, [MULTILINE]);
    await expectPaintedExactly(b, [MULTILINE]);
    await toastAction(a, 'Highlight deleted').click();
    await expectPaintedExactly(a, [QUOTE, MULTILINE]);
    await expectPaintedExactly(b, [QUOTE, MULTILINE]);

    // Editing the kind in B updates the colour painted in A.
    await b.bringToFront();
    await openPopover(b, '#p-multiline');
    await b.getByLabel('Type').selectOption({ label: 'ƒ Formula' });
    await expect
      .poll(async () => (await paintedDetail(a)).find((p) => norm(p.text) === MULTILINE)?.color)
      .toBe('blue');
    expect(liveHighlights(await readDb(ext))).toHaveLength(2);
  });
});

// -----------------------------------------------------------------------------------------------
// A new selection made while a save is still in flight
// -----------------------------------------------------------------------------------------------

test.describe('selection made while a previous save is still in flight', () => {
  test('is not cleared (and its toolbar not closed) when the earlier save completes', async ({
    context,
    extensionId,
    serviceWorker,
    fixtureServer,
  }) => {
    test.setTimeout(120_000);
    const ext = await openExtensionPage(context, extensionId);
    const page = await context.newPage();
    await page.goto(`${fixtureServer.origin}/article.html`);
    await activate(ext, page);
    await page.bringToFront();

    await tripleClick(page, '#quote');
    await expect(toolbarOf(page)).toBeVisible();
    // Hold the service worker for 2.5 s (a cold start, a slow disk, a busy machine): the save
    // below is accepted by the page but cannot complete until the worker answers.
    const held = serviceWorker
      .evaluate(() => {
        const end = Date.now() + 2_500;
        while (Date.now() < end) {
          /* busy */
        }
      })
      .catch(() => undefined);
    await page.getByRole('button', { name: 'Save selection', exact: true }).click();

    // While it is pending the reader moves on and selects the next paragraph (real mouse).
    await tripleClick(page, '#p-multiline');
    const second = norm(await page.evaluate(() => window.getSelection()?.toString() ?? ''));
    expect(second).toContain('Depolarisation spreads from the sinoatrial node');
    await expect(toolbarOf(page)).toBeVisible();

    // The first save completes...
    await held;
    await expect(savedToast(page)).toHaveText('Saved to Inbox');
    await expectPaintedExactly(page, [QUOTE]);
    expect(liveHighlights(await readDb(ext))).toHaveLength(1);

    // ...and must not touch the newer selection.
    expect
      .soft(
        norm(await page.evaluate(() => window.getSelection()?.toString() ?? '')),
        'the second selection is still the live selection',
      )
      .toBe(second);
    await expect.soft(toolbarOf(page), 'the second selection still has its toolbar').toBeVisible();
    expect(await saveSelection(page)).toBe('Saved to Inbox');
    await expectPaintedExactly(page, [QUOTE, MULTILINE]);
  });
});

// -----------------------------------------------------------------------------------------------
// Performance evidence
// -----------------------------------------------------------------------------------------------

const SEEDED = 40;

test.describe('performance evidence: /large.html?paragraphs=1500 with 40 highlights', () => {
  test('rehydrate, toolbar and save latencies stay within generous bounds', async ({
    context,
    extensionId,
    fixtureServer,
  }) => {
    test.setTimeout(300_000);
    const ext = await openExtensionPage(context, extensionId);
    const page = await context.newPage();
    await page.goto(`${fixtureServer.origin}/large.html?paragraphs=1500`);
    const tabId = await activate(ext, page);
    await page.bringToFront();

    // Seed 40 highlights through the real capture pipeline (the shortcut/context-menu path:
    // content.captureSelection on a live selection). Selection is set programmatically here only
    // because 40 mouse gestures would add minutes without adding coverage; real-mouse paths are
    // used for the measured toolbar and save steps below.
    for (let i = 0; i < SEEDED; i++) {
      const index = i * 37;
      await page.evaluate((id) => {
        const p = document.getElementById(id)!;
        window.getSelection()!.selectAllChildren(p);
      }, `p${index}`);
      const res = await tabRpc(ext, tabId, 'content.captureSelection', {
        method: 'shortcut',
        bankId: null,
      });
      expect(res.ok, `seed ${i}`).toBe(true);
      expect((res as { data: { status: string } }).data.status).toBe('created');
    }
    expect(liveHighlights(await readDb(ext))).toHaveLength(SEEDED);
    await expect.poll(async () => (await paintedDetail(page)).length).toBe(SEEDED);

    // ---- activation -> all 40 painted (fresh document, three runs) ------------------------------
    const rehydrate: Array<{ activateRpcMs: number; activationToPaintedMs: number }> = [];
    for (let run = 0; run < 3; run++) {
      await page.reload();
      await page.evaluate((n) => {
        const w = window as unknown as { __paintedAt: number | null };
        w.__paintedAt = null;
        const tick = () => {
          let count = 0;
          for (const [name, hl] of CSS.highlights) {
            if (name.startsWith('sv-hl-') && name !== 'sv-hl-active') count += hl.size;
          }
          if (count >= n) w.__paintedAt = Date.now();
          else setTimeout(tick, 2);
        };
        tick();
      }, SEEDED);
      const tabNow = await tabIdOf(ext, page);
      const res = await ext.evaluate(async (id) => {
        const start = Date.now();
        const r = await chrome.runtime.sendMessage({
          v: 1,
          type: 'tab.activate',
          payload: { tabId: id },
        });
        return { ok: r.ok as boolean, start, ms: Date.now() - start };
      }, tabNow);
      expect(res.ok).toBe(true);
      const t0 = res.start;
      await page.waitForFunction(
        () => (window as unknown as { __paintedAt: number | null }).__paintedAt !== null,
        undefined,
        { timeout: 15_000 },
      );
      const paintedAt = await page.evaluate(
        () => (window as unknown as { __paintedAt: number }).__paintedAt,
      );
      rehydrate.push({ activateRpcMs: res.ms, activationToPaintedMs: paintedAt - t0 });
      expect((await paintedDetail(page)).length).toBe(SEEDED);
    }

    // ---- selection -> toolbar visible, click Save -> saved toast (real mouse, in-page clocks) ----
    const toolbar: number[] = [];
    const save: number[] = [];
    const phrases = [
      { id: 'p11', phrase: 'discusses the physiology of compartment' },
      { id: 'p12', phrase: 'with reference to equation' },
      { id: 'p13', phrase: 'used for locating this passage' },
      { id: 'p14', phrase: 'consectetur adipiscing elit' },
      { id: 'p15', phrase: 'dolore magna aliqua' },
    ];
    for (const [i, { id, phrase }] of phrases.entries()) {
      await page.evaluate(() => {
        const w = window as unknown as { __tb: { up: number | null; shown: number | null } };
        w.__tb = { up: null, shown: null };
        const root = document.querySelector('studyvault-overlay')!.shadowRoot!;
        window.addEventListener(
          'pointerup',
          () => {
            w.__tb.up = performance.now();
          },
          { capture: true, once: true },
        );
        const check = () => {
          const unit = root.querySelector('[role="toolbar"]')?.closest('.sv-unit');
          if (unit && w.__tb.shown === null && getComputedStyle(unit).visibility !== 'hidden') {
            w.__tb.shown = performance.now();
          }
        };
        new MutationObserver(check).observe(root, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['style'],
        });
      });
      await dragSelect(page, { selector: `#${id}`, phrase });
      await expect(toolbarOf(page)).toBeVisible();
      const probe = await page.evaluate(
        () => (window as unknown as { __tb: { up: number; shown: number } }).__tb,
      );
      expect(probe.up, `sample ${i}: pointerup observed`).not.toBeNull();
      expect(probe.shown, `sample ${i}: toolbar became visible`).not.toBeNull();
      toolbar.push(probe.shown - probe.up);

      await page.evaluate(() => {
        const w = window as unknown as { __save: { click: number | null; toast: number | null } };
        w.__save = { click: null, toast: null };
        const root = document.querySelector('studyvault-overlay')!.shadowRoot!;
        // Toasts of earlier saves are still on screen with the same text, so a toast is not a
        // completion signal. The toolbar closes exactly when the save has finished.
        window.addEventListener(
          'click',
          () => {
            w.__save.click = performance.now();
          },
          { capture: true, once: true },
        );
        new MutationObserver(() => {
          if (w.__save.toast !== null || w.__save.click === null) return;
          if (!root.querySelector('[role="toolbar"]')) w.__save.toast = performance.now();
        }).observe(root, { childList: true, subtree: true });
      });
      await page.getByRole('button', { name: 'Save selection', exact: true }).click();
      await expect(toolbarOf(page)).toHaveCount(0);
      await expect(savedToast(page)).toBeVisible();
      const timing = await page.evaluate(
        () => (window as unknown as { __save: { click: number; toast: number } }).__save,
      );
      expect(timing.toast, `sample ${i}: toolbar closed after the save`).not.toBeNull();
      save.push(timing.toast - timing.click);
    }

    const stats = (xs: number[]) => {
      const s = [...xs].sort((a, b) => a - b);
      return {
        n: s.length,
        min: Math.round(s[0]!),
        median: Math.round(s[Math.floor(s.length / 2)]!),
        max: Math.round(s[s.length - 1]!),
      };
    };
    const report = {
      chromium: context.browser()?.version() ?? 'unknown',
      page: '/large.html?paragraphs=1500',
      highlights: SEEDED,
      activationToPaintedMs: rehydrate.map((r) => r.activationToPaintedMs),
      activateRpcMs: rehydrate.map((r) => r.activateRpcMs),
      toolbarMs: toolbar.map((x) => Math.round(x)),
      toolbarStats: stats(toolbar),
      saveMs: save.map((x) => Math.round(x)),
      saveStats: stats(save),
    };
    console.log(`PERF ${JSON.stringify(report)}`);
    test.info().annotations.push({ type: 'perf', description: JSON.stringify(report) });

    for (const r of rehydrate) {
      expect(r.activationToPaintedMs, 'activation -> 40 highlights painted').toBeLessThan(3_000);
    }
    expect(Math.max(...toolbar), 'selection -> toolbar visible').toBeLessThan(500);
    expect(Math.max(...save), 'click Save -> save finished (toolbar closed)').toBeLessThan(2_000);
    expect(liveHighlights(await readDb(ext))).toHaveLength(SEEDED + phrases.length);
  });
});

// -----------------------------------------------------------------------------------------------
// Concurrent writers
// -----------------------------------------------------------------------------------------------

test.describe('concurrent writers on a fresh profile', () => {
  test('two tabs saving different passages at the same instant keep one source and one Inbox', async ({
    context,
    extensionId,
    fixtureServer,
  }) => {
    test.setTimeout(120_000);
    const url = `${fixtureServer.origin}/article.html`;
    const ext = await openExtensionPage(context, extensionId);
    const a = await context.newPage();
    await a.goto(url);
    const b = await context.newPage();
    await b.goto(url);
    await activate(ext, a);
    await activate(ext, b);

    await a.bringToFront();
    await tripleClick(a, '#quote');
    await expect(toolbarOf(a)).toBeVisible();
    await b.bringToFront();
    await tripleClick(b, '#p-multiline');
    await expect(toolbarOf(b)).toBeVisible();

    await Promise.all([
      a.getByRole('button', { name: 'Save selection', exact: true }).click(),
      b.getByRole('button', { name: 'Save selection', exact: true }).click(),
    ]);
    await expect(savedToast(a)).toHaveText('Saved to Inbox');
    await expect(savedToast(b)).toHaveText('Saved to Inbox');
    await expectPaintedExactly(a, [QUOTE, MULTILINE]);
    await expectPaintedExactly(b, [QUOTE, MULTILINE]);

    const db = await readDb(ext);
    expect(db.sources, 'one source for one page').toHaveLength(1);
    expect(
      db.banks.filter((x) => x.id === 'inbox-default'),
      'one Inbox',
    ).toHaveLength(1);
    expect(liveHighlights(db)).toHaveLength(2);
    expect(db.highlightBanks).toHaveLength(2);
  });

  test('the same passage saved from two tabs at the same instant is stored once', async ({
    context,
    extensionId,
    fixtureServer,
  }) => {
    test.setTimeout(120_000);
    const url = `${fixtureServer.origin}/article.html`;
    const ext = await openExtensionPage(context, extensionId);
    const a = await context.newPage();
    await a.goto(url);
    const b = await context.newPage();
    await b.goto(url);
    await activate(ext, a);
    await activate(ext, b);
    await a.bringToFront();
    await tripleClick(a, '#quote');
    await expect(toolbarOf(a)).toBeVisible();
    await b.bringToFront();
    await tripleClick(b, '#quote');
    await expect(toolbarOf(b)).toBeVisible();

    await Promise.all([
      a.getByRole('button', { name: 'Save selection', exact: true }).click(),
      b.getByRole('button', { name: 'Save selection', exact: true }).click(),
    ]);
    await expect(savedToast(a)).toBeVisible();
    await expect(savedToast(b)).toBeVisible();
    const outcomes = [
      (await savedToast(a).textContent()) ?? '',
      (await savedToast(b).textContent()) ?? '',
    ].sort();
    expect(outcomes, 'exactly one tab created it, the other was told it already exists').toEqual([
      'Already saved in Inbox',
      'Saved to Inbox',
    ]);
    await expectPaintedExactly(a, [QUOTE]);
    await expectPaintedExactly(b, [QUOTE]);
    const db = await readDb(ext);
    expect(liveHighlights(db)).toHaveLength(1);
    expect(db.highlightBanks).toHaveLength(1);
    expect(db.sources).toHaveLength(1);
  });
});

// -----------------------------------------------------------------------------------------------
// Page dynamics: re-rendered DOM, late content, busy pages
// -----------------------------------------------------------------------------------------------

const RERENDER =
  'This paragraph is re-created by the framework on every render but always says the same thing.';
const LATE =
  'A late arriving paragraph explains countercurrent multiplication in the loop of Henle.';

test.describe('dynamic pages', () => {
  test('a highlight is repainted after the page re-creates its element', async ({
    context,
    extensionId,
    fixtureServer,
  }) => {
    test.setTimeout(90_000);
    const ext = await openExtensionPage(context, extensionId);
    const page = await context.newPage();
    await page.goto(`${fixtureServer.origin}/lifecycle-dynamic.html`);
    await activate(ext, page);
    await page.bringToFront();
    await selectAndSave(page, { triple: '#rerender' }, 'always says the same thing');
    await expectPaintedExactly(page, [RERENDER]);

    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => {
        (window as unknown as { __old: Element | null }).__old =
          document.getElementById('rerender');
      });
      await page.getByRole('button', { name: 'Re-render' }).click();
      const replaced = await page.evaluate(
        () =>
          (window as unknown as { __old: Element | null }).__old !==
          document.getElementById('rerender'),
      );
      expect(replaced, 'the page really replaced the element').toBe(true);
      // Painted again, on the NEW element, with exactly the same text.
      await expect
        .poll(async () => (await paintedDetail(page)).map((p) => `${p.hostId}:${norm(p.text)}`), {
          timeout: 10_000,
        })
        .toEqual([`rerender:${RERENDER}`]);
      expect(
        await page.evaluate(() => {
          const el = document.getElementById('rerender')!;
          return [...CSS.highlights]
            .filter(([n]) => n.startsWith('sv-hl-') && n !== 'sv-hl-active')
            .flatMap(([, h]) => [...(h as unknown as Iterable<Range>)])
            .every((r) => el.contains(r.startContainer));
        }),
        'the painted range lives in the new element',
      ).toBe(true);
    }
    expect(liveHighlights(await readDb(ext))).toHaveLength(1);
  });

  test('late-arriving text on a quiet page is painted when it appears', async ({
    context,
    extensionId,
    fixtureServer,
  }) => {
    test.setTimeout(90_000);
    const origin = fixtureServer.origin;
    const ext = await openExtensionPage(context, extensionId);
    const seed = await context.newPage();
    await seed.goto(`${origin}/lifecycle-dynamic.html?utm_campaign=late0`);
    await expect(seed.locator('#late')).toBeVisible();
    await activate(ext, seed);
    await seed.bringToFront();
    await selectAndSave(seed, { triple: '#late' }, 'countercurrent multiplication');
    await seed.close();

    const page = await context.newPage();
    await page.goto(`${origin}/lifecycle-dynamic.html?utm_campaign=late5000`);
    await expect(page.locator('#late')).toHaveCount(0);
    const tabId = await activate(ext, page);
    // Before the text exists nothing is painted and nothing wrong is painted instead.
    await expect.poll(async () => (await pageCounts(ext, tabId))?.total).toBe(1);
    await expectPaintedExactly(page, []);
    await expect(page.locator('#late')).toBeVisible({ timeout: 15_000 });
    await expectPaintedExactly(page, [LATE], 15_000);
    // Never left recorded as lost: the final stored state is resolved.
    await expect
      .poll(async () => liveHighlights(await readDb(ext))[0]?.resolveStatus, { timeout: 15_000 })
      .toBe('resolved');
  });

  test('control: text arriving after 5 s on a busy page (DOM changes every 100 ms) is painted', async ({
    context,
    extensionId,
    fixtureServer,
  }) => {
    test.setTimeout(90_000);
    const origin = fixtureServer.origin;
    const ext = await openExtensionPage(context, extensionId);
    const seed = await context.newPage();
    await seed.goto(`${origin}/lifecycle-dynamic.html?utm_campaign=late0`);
    await expect(seed.locator('#late')).toBeVisible();
    await activate(ext, seed);
    await seed.bringToFront();
    await selectAndSave(seed, { triple: '#late' }, 'countercurrent multiplication');
    await seed.close();

    const page = await context.newPage();
    await page.goto(`${origin}/lifecycle-dynamic.html?utm_campaign=late5000-tick`);
    await activate(ext, page);
    await page.bringToFront();
    await expect(page.locator('#late')).toBeVisible({ timeout: 15_000 });
    await expectPaintedExactly(page, [LATE], 10_000);
  });

  test('late-arriving text on a BUSY page (DOM changes every 100 ms) is painted soon after it appears', async ({
    context,
    extensionId,
    fixtureServer,
  }) => {
    test.setTimeout(120_000);
    const origin = fixtureServer.origin;
    const ext = await openExtensionPage(context, extensionId);
    const seed = await context.newPage();
    await seed.goto(`${origin}/lifecycle-dynamic.html?utm_campaign=late0`);
    await expect(seed.locator('#late')).toBeVisible();
    await activate(ext, seed);
    await seed.bringToFront();
    await selectAndSave(seed, { triple: '#late' }, 'countercurrent multiplication');
    await seed.close();

    // Same page, but a ticker rewrites a text node every 100 ms and the paragraph only arrives
    // 20 s after load (infinite scroll, "load more", a late widget).
    const page = await context.newPage();
    const loaded = Date.now();
    await page.goto(`${origin}/lifecycle-dynamic.html?utm_campaign=late20000-tick`);
    await activate(ext, page);
    await page.bringToFront();
    await expect(page.locator('#late')).toBeVisible({ timeout: 30_000 });
    const arrivedAfterMs = Date.now() - loaded;
    // Generous: 10 s after the text is in the document it must be painted.
    await expectPaintedExactly(page, [LATE], 10_000);
    console.log(`BUSY-PAGE late text arrived after ${arrivedAfterMs} ms and was painted`);
  });
});
