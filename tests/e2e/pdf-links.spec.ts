import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import {
  DENSE_LINK_COUNT,
  GLOSSARY_HEADING,
  LINK_EXTERNAL_URL,
  LINK_TEXTS,
  PAGE_THREE_HEADING,
  denseLinksDoc,
  linkedDoc,
  linkedRotatedDoc,
} from '../fixtures/pdf/docs';
import { readRealPdfs, type RealPdf } from '../fixtures/pdf/real/manifest';
import { settleAnimations } from './axeSettle';
import { expect, test } from './helpers.pages';
import {
  anchorsOf,
  boxOf,
  clickLink,
  labelsOf,
  openBytes,
  overlapShare,
  spoken,
  stubWeb,
} from './helpers.pdfLinks';
import {
  expectPageDrawn,
  goToPage,
  openRealPdf,
  scrollSpanIntoView,
  spanBox,
  textOnPage,
} from './helpers.pdfReal';

/**
 * Links in the PDF reader (ADR-006, Amendment 3), in real Chromium with the real built extension, real
 * mouse and keyboard input. Generated documents say exactly what each link is; the real NIST CSF 2.0
 * (tests/fixtures/pdf/real, 103 link annotations: table of contents, web addresses, a mailto) and the
 * CDC STI guideline (3,779 clickable links, 48 dense pages) say what real files do.
 *
 * Nothing leaves the machine: every address a test may open is answered by a stub (`stubWeb`).
 * Harness limit: the popup is found with `context.waitForEvent('page')`; a window opened with
 * `noopener` is not reported as a popup of its opener.
 */

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];
const REFUSED = 'Link that StudyVault will not open';
const OPEN = 'Open in a new tab';
const PER_TEST_MS = 90_000;

async function violations(page: Page): Promise<string> {
  await settleAnimations(page);
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  return results.violations
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

const pageInput = (page: Page) => page.getByTestId('pdf-page-input');
const dialogOf = (page: Page) => page.getByRole('dialog', { name: 'Open this link in a new tab?' });

/** Distance of a text line's top edge below the top edge of the viewer, in CSS px. */
async function belowViewerTop(page: Page, n: number, text: string): Promise<number> {
  const viewer = await page.getByTestId('pdf-viewer').boundingBox();
  const line = await spanBox(page, n, text);
  return line.y - viewer!.y;
}

test.describe('links in a generated PDF', () => {
  test.describe.configure({ timeout: PER_TEST_MS });

  test('a link to a page and a named destination go there, focus the page, say so, and Back returns', async ({
    env,
  }) => {
    const { page, errors } = await openBytes(env, 'linked.pdf', linkedDoc());
    await expect(anchorsOf(page, 1)).toHaveCount(6);
    // One anchor per link, in reading order (top to bottom), each with its own accessible name.
    expect(await labelsOf(page, 1)).toEqual([
      'Link to page 3',
      'Link to page 2',
      'External link to example.org',
      REFUSED,
      REFUSED,
      'External link to example.org',
    ]);
    const back = page.getByTestId('pdf-back');
    await expect(back).toHaveAttribute('aria-disabled', 'true');
    await expect(back).toHaveAttribute('title', 'No link has been followed yet.');

    const viewer = page.getByTestId('pdf-viewer');
    await boxOf(anchorsOf(page, 1).nth(0));
    const before = await viewer.evaluate((el) => el.scrollTop);

    // GoTo page 3, 100 pt below its top edge.
    await clickLink(page, anchorsOf(page, 1).nth(0));
    await expect(pageInput(page)).toHaveValue('3');
    await expect(page.getByTestId('pdf-page-3')).toBeFocused();
    await expect(spoken(page)).toContainText('Went to page 3.');
    await expect(back).toHaveText('Back to page 1');
    await expect(back).not.toHaveAttribute('aria-disabled', 'true');
    await textOnPage(page, 3);
    // The destination is near the top of the view, with room for the line it names.
    await expect
      .poll(() => belowViewerTop(page, 3, PAGE_THREE_HEADING), { message: 'target is at the top' })
      .toBeLessThan(160);
    expect(await belowViewerTop(page, 3, PAGE_THREE_HEADING)).toBeGreaterThanOrEqual(0);

    // Alt+Left: back to where the link was.
    await page.keyboard.press('Alt+ArrowLeft');
    await expect(pageInput(page)).toHaveValue('1');
    await expect(spoken(page)).toContainText('Back on page 1.');
    await expect(back).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByTestId('pdf-page-1')).toBeFocused();
    expect(Math.abs((await viewer.evaluate((el) => el.scrollTop)) - before)).toBeLessThanOrEqual(
      24,
    );

    // A named destination (the file's own /Dests): page 2, 200 pt below its top edge.
    await clickLink(page, anchorsOf(page, 1).nth(1));
    await expect(pageInput(page)).toHaveValue('2');
    await expect(spoken(page)).toContainText('Went to page 2.');
    await textOnPage(page, 2);
    await expect.poll(() => belowViewerTop(page, 2, GLOSSARY_HEADING)).toBeLessThan(160);
    // The Back button does the same as the key.
    await back.click();
    await expect(pageInput(page)).toHaveValue('1');
    expect(errors).toEqual([]);
  });

  test('an address opens only after the person confirms, in a new tab without an opener or referrer', async ({
    env,
  }) => {
    const requested = await stubWeb(env.context);
    const { page, errors } = await openBytes(env, 'linked.pdf', linkedDoc());
    await expect(anchorsOf(page, 1)).toHaveCount(6);
    const tabs = env.context.pages().length;

    await clickLink(page, anchorsOf(page, 1).nth(2));
    const dialog = dialogOf(page);
    await expect(dialog).toBeVisible();
    // The whole address and the site, as text, and the safe choice has focus.
    await expect(dialog.getByTestId('pdf-link-address')).toHaveText(LINK_EXTERNAL_URL);
    await expect(dialog.getByTestId('pdf-link-host')).toHaveText('example.org');
    await expect(dialog.getByTestId('pdf-link-always')).not.toBeChecked();
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    // Nothing was opened and nothing was requested while it is only asked.
    expect(env.context.pages()).toHaveLength(tabs);
    expect(requested).toEqual([]);

    const [popup] = await Promise.all([
      env.context.waitForEvent('page'),
      dialog.getByRole('button', { name: OPEN }).click(),
    ]);
    await popup.waitForLoadState('domcontentloaded');
    expect(popup.url()).toBe(LINK_EXTERNAL_URL);
    expect(await popup.evaluate(() => window.opener)).toBeNull();
    expect(await popup.evaluate(() => document.referrer)).toBe('');
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('pdf-viewer')).toBeVisible();
    await expect(spoken(page)).toContainText('Opening example.org in a new tab.');
    expect(errors).toEqual([]);
  });

  test('Cancel and Escape open nothing; "always allow this site" lets the same site through for this reader only', async ({
    env,
  }) => {
    const requested = await stubWeb(env.context);
    const { page } = await openBytes(env, 'linked.pdf', linkedDoc());
    await expect(anchorsOf(page, 1)).toHaveCount(6);
    const external = anchorsOf(page, 1).nth(2);
    const tabs = env.context.pages().length;

    await clickLink(page, external);
    await dialogOf(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(dialogOf(page)).toBeHidden();
    await clickLink(page, external);
    await expect(dialogOf(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialogOf(page)).toBeHidden();
    expect(env.context.pages()).toHaveLength(tabs);
    expect(requested).toEqual([]);

    // Allow the site: the first time still asks (and opens), the second time does not ask.
    await clickLink(page, external);
    await dialogOf(page).getByTestId('pdf-link-always').check();
    const [first] = await Promise.all([
      env.context.waitForEvent('page'),
      dialogOf(page).getByRole('button', { name: OPEN }).click(),
    ]);
    await first.waitForLoadState('domcontentloaded');
    const [second] = await Promise.all([
      env.context.waitForEvent('page'),
      clickLink(page, external),
    ]);
    await second.waitForLoadState('domcontentloaded');
    await expect(dialogOf(page)).toBeHidden();
    expect(second.url()).toBe(LINK_EXTERNAL_URL);

    // It lasts for this page load only: a reload of the reader forgets it.
    await page.reload();
    await openBytesAgain(page, 'linked.pdf');
    await clickLink(page, anchorsOf(page, 1).nth(2));
    await expect(dialogOf(page)).toBeVisible();
    await expect(dialogOf(page).getByTestId('pdf-link-always')).not.toBeChecked();
  });

  test('a script address and a mail address are refused with a notice and nothing is opened', async ({
    env,
  }) => {
    const requested = await stubWeb(env.context);
    const { page, errors } = await openBytes(env, 'linked.pdf', linkedDoc());
    await expect(anchorsOf(page, 1)).toHaveCount(6);
    const tabs = env.context.pages().length;
    const notice = page.getByTestId('pdf-link-notice');

    await clickLink(page, anchorsOf(page, 1).nth(3)); // javascript:alert(1)
    await expect(notice).toContainText('"javascript:"');
    await expect(notice).toContainText('only web addresses');
    await expect(dialogOf(page)).toHaveCount(0);

    await clickLink(page, anchorsOf(page, 1).nth(4)); // mailto:
    await expect(notice).toContainText('"mailto:"');
    await expect(dialogOf(page)).toHaveCount(0);

    expect(env.context.pages()).toHaveLength(tabs);
    expect(requested).toEqual([]);
    await page.getByRole('button', { name: 'Dismiss' }).click();
    await expect(notice).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('a drag across a link selects its text and does not follow it; a plain click still does', async ({
    env,
  }) => {
    const requested = await stubWeb(env.context);
    const { page } = await openBytes(env, 'linked.pdf', linkedDoc());
    await textOnPage(page, 1);
    await expect(anchorsOf(page, 1)).toHaveCount(6);
    const tabs = env.context.pages().length;
    const anchor = anchorsOf(page, 1).nth(2);
    // The anchors take no pointer events: the drag below starts on text, not on a link.
    expect(await anchor.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');
    expect(await anchor.evaluate((el) => getComputedStyle(el.parentElement!).pointerEvents)).toBe(
      'none',
    );

    await scrollSpanIntoView(page, 1, LINK_TEXTS.external);
    const line = await spanBox(page, 1, LINK_TEXTS.external);
    await page.mouse.move(line.x + 1, line.y + line.h / 2);
    await page.mouse.down();
    await page.mouse.move(line.x + line.w - 1, line.y + line.h / 2, { steps: 12 });
    await page.mouse.up();
    await expect(page.getByTestId('pdf-savebar')).toBeVisible();
    const selected = await page.evaluate(() => document.getSelection()?.toString() ?? '');
    expect(selected).toContain('External link');
    await expect(dialogOf(page)).toHaveCount(0);
    expect(env.context.pages()).toHaveLength(tabs);

    // With the selection gone a click on the link asks, as it always did.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('pdf-savebar')).toHaveCount(0);
    await clickLink(page, anchor);
    await expect(dialogOf(page)).toBeVisible();
    expect(requested).toEqual([]);
  });

  test('links are reachable and followed from the keyboard, and keys still work on the page they land on', async ({
    env,
  }) => {
    const { page } = await openBytes(env, 'linked.pdf', linkedDoc());
    await expect(anchorsOf(page, 1)).toHaveCount(6);
    await page.getByTestId('pdf-viewer').focus();
    await page.keyboard.press('Tab');
    await expect(page.locator(':focus')).toHaveAttribute('aria-label', 'Link to page 3');
    await expect(page.locator(':focus')).toHaveAttribute('role', 'link');
    await page.keyboard.press('Tab');
    await expect(page.locator(':focus')).toHaveAttribute('aria-label', 'Link to page 2');
    // The focus ring is drawn (the anchor is transparent otherwise).
    const ring = await page
      .locator(':focus')
      .evaluate((el) => parseFloat(getComputedStyle(el).outlineWidth));
    expect(ring).toBeGreaterThanOrEqual(2);

    await page.keyboard.press('Enter');
    await expect(pageInput(page)).toHaveValue('2');
    await expect(page.getByTestId('pdf-page-2')).toBeFocused();
    await expect(spoken(page)).toContainText('Went to page 2.');
    // The viewer's own keys work with focus on the page the link landed on.
    await page.keyboard.press(']');
    await expect(pageInput(page)).toHaveValue('3');
  });

  test('the Links list of the navigation pane follows the same links', async ({ env }) => {
    const requested = await stubWeb(env.context);
    const { page } = await openBytes(env, 'linked.pdf', linkedDoc());
    await expect(anchorsOf(page, 1)).toHaveCount(6);
    await page.getByTestId('pdf-toggle-sidepane').click();
    await page.getByRole('tab', { name: 'Links (6)' }).click();
    const list = page.getByRole('list', { name: 'Links on this page' });
    const items = list.getByRole('button');
    await expect(items).toHaveCount(6);
    await expect(items.nth(0)).toHaveText('Link to page 3');
    await expect(items.nth(2)).toContainText(`External link to example.org · ${LINK_EXTERNAL_URL}`);
    await expect(items.nth(3)).toContainText('will not be opened');

    await items.nth(3).click();
    await expect(page.getByTestId('pdf-link-notice')).toContainText('"javascript:"');
    await items.nth(2).click();
    await expect(dialogOf(page)).toBeVisible();
    await dialogOf(page).getByRole('button', { name: 'Cancel' }).click();
    expect(requested).toEqual([]);

    await items.nth(0).click();
    await expect(pageInput(page)).toHaveValue('3');
    await expect(page.getByTestId('pdf-page-3')).toBeFocused();
    await expect(page.getByTestId('pdf-links-empty')).toHaveText('Page 3 has no links.');
  });

  test('a link on a page with /Rotate 90 sits over its words, and keeps doing so after rotating and zooming', async ({
    env,
  }) => {
    const { page } = await openBytes(env, 'rotated-link.pdf', linkedRotatedDoc());
    await textOnPage(page, 1);
    await expect(anchorsOf(page, 1)).toHaveCount(1);
    const share = async (): Promise<number> => {
      const words = await spanBox(page, 1, 'Rotated page text');
      const a = await anchorsOf(page, 1).first().boundingBox();
      return a ? overlapShare({ x: a.x, y: a.y, w: a.width, h: a.height }, words) : 0;
    };
    // Displayed upright: a wide strip over the first words, not a tall one.
    await expect.poll(share, { message: 'anchor over its words' }).toBeGreaterThan(0.9);
    const strip = (await anchorsOf(page, 1).first().boundingBox())!;
    expect(strip.width).toBeGreaterThan(strip.height);

    await page.getByTestId('pdf-rotate').click(); // 90 + 90: upside down
    await expect.poll(share, { message: 'after rotating' }).toBeGreaterThan(0.9);
    await page.getByTestId('pdf-zoom').selectOption('2');
    await expect.poll(share, { message: 'after zooming' }).toBeGreaterThan(0.9);
  });

  test('a page with many links is one tab stop, with arrow keys and a list as the way through it', async ({
    env,
  }) => {
    const { page } = await openBytes(env, 'many.pdf', denseLinksDoc());
    await expect(anchorsOf(page, 1)).toHaveCount(DENSE_LINK_COUNT);
    const layer = page.locator('[data-testid="pdf-page-1"] .sv-pdf-layer--links');
    await expect(layer).toHaveAttribute('role', 'group');
    await expect(layer).toHaveAttribute('aria-label', /arrow keys/);
    await expect(layer.locator('a[tabindex="0"]')).toHaveCount(1);
    await expect(layer.locator('a[tabindex="-1"]')).toHaveCount(DENSE_LINK_COUNT - 1);

    await page.getByTestId('pdf-viewer').focus();
    await page.keyboard.press('Tab');
    await expect(page.locator(':focus')).toHaveAttribute('data-sv-link', '0');
    await page.keyboard.press('ArrowRight');
    await expect(page.locator(':focus')).toHaveAttribute('data-sv-link', '1');
    await expect(layer.locator('a[tabindex="0"]')).toHaveCount(1);
    // Tab leaves the layer instead of walking its 45 links.
    await page.keyboard.press('Tab');
    expect(
      await page.evaluate(() => document.activeElement?.closest('.sv-pdf-layer--links')),
    ).toBeNull();

    // The list is the primary way: every link, by name.
    await page.getByTestId('pdf-toggle-sidepane').click();
    await page.getByRole('tab', { name: `Links (${DENSE_LINK_COUNT})` }).click();
    await expect(page.getByTestId('pdf-links-list').getByRole('button')).toHaveCount(
      DENSE_LINK_COUNT,
    );
    await page.getByTestId('pdf-links-list').getByRole('button').first().click();
    await expect(pageInput(page)).toHaveValue('2');
  });

  test('the page with its links, the Links list and the confirmation dialog have no WCAG A/AA violations', async ({
    env,
  }) => {
    await stubWeb(env.context);
    const { page } = await openBytes(env, 'linked.pdf', linkedDoc());
    await expect(anchorsOf(page, 1)).toHaveCount(6);
    expect(await violations(page)).toBe('');

    await page.getByTestId('pdf-toggle-sidepane').click();
    await page.getByRole('tab', { name: 'Links (6)' }).click();
    await expect(page.getByTestId('pdf-links-list')).toBeVisible();
    expect(await violations(page)).toBe('');

    await clickLink(page, anchorsOf(page, 1).nth(2));
    await expect(dialogOf(page)).toBeVisible();
    expect(await violations(page)).toBe('');
  });
});

/** After a reload the reader is empty: choose the same file again. */
async function openBytesAgain(page: Page, name: string): Promise<void> {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByTestId('pdf-choose-file').click(),
  ]);
  await chooser.setFiles({ name, mimeType: 'application/pdf', buffer: linkedDoc() });
  await expect(page.getByTestId('pdf-viewer')).toBeVisible({ timeout: 60_000 });
  await expect(anchorsOf(page, 1)).toHaveCount(6);
}

// =============================================================================================
// Real documents
// =============================================================================================

const PDFS = readRealPdfs();
const byName = (file: string): RealPdf => {
  const pdf = PDFS.find((p) => p.file === file);
  if (!pdf) throw new Error(`${file} is not listed in tests/fixtures/pdf/real/SOURCES.md`);
  return pdf;
};

test.describe('links in real documents', () => {
  test.describe.configure({ timeout: PER_TEST_MS });

  test('nist-cswp29-csf-2-0: a table-of-contents entry goes to its page and Back returns', async ({
    env,
  }) => {
    const { page, errors } = await openRealPdf(env, byName('nist-cswp29-csf-2-0.pdf'));
    await goToPage(page, 4);
    await expect(pageInput(page)).toHaveValue('4');
    await expect(anchorsOf(page, 4)).toHaveCount(18, { timeout: 60_000 });
    const labels = await labelsOf(page, 4);
    expect(labels[0]).toBe('Link to page 6'); // "1. Cybersecurity Framework (CSF) Overview"
    expect(labels.every((l) => /^Link to page \d+$/.test(l))).toBe(true);

    await clickLink(page, anchorsOf(page, 4).first());
    await expect(pageInput(page)).toHaveValue('6');
    await expect(page.getByTestId('pdf-page-6')).toBeFocused();
    await expect(spoken(page)).toContainText('Went to page 6.');
    await expectPageDrawn(page, 6);
    await expect(page.getByTestId('pdf-back')).toHaveText('Back to page 4');

    await page.keyboard.press('Alt+ArrowLeft');
    await expect(pageInput(page)).toHaveValue('4');
    expect(errors).toEqual([]);
  });

  test('nist-cswp29-csf-2-0: a web address opens in a new tab only after confirmation; a mailto is refused', async ({
    env,
  }) => {
    const requested = await stubWeb(env.context);
    const { page, errors } = await openRealPdf(env, byName('nist-cswp29-csf-2-0.pdf'));
    await goToPage(page, 2);
    await expect(anchorsOf(page, 2)).toHaveCount(2, { timeout: 60_000 });
    expect(await labelsOf(page, 2)).toEqual(['External link to www.nist.gov', REFUSED]);
    const tabs = env.context.pages().length;

    await clickLink(page, anchorsOf(page, 2).nth(0));
    const dialog = dialogOf(page);
    await expect(dialog.getByTestId('pdf-link-address')).toHaveText(
      'https://www.nist.gov/cyberframework',
    );
    await expect(dialog.getByTestId('pdf-link-host')).toHaveText('www.nist.gov');
    expect(env.context.pages()).toHaveLength(tabs);
    expect(requested).toEqual([]);
    const [popup] = await Promise.all([
      env.context.waitForEvent('page'),
      dialog.getByRole('button', { name: OPEN }).click(),
    ]);
    await popup.waitForLoadState('domcontentloaded');
    expect(popup.url()).toBe('https://www.nist.gov/cyberframework');
    expect(await popup.evaluate(() => window.opener)).toBeNull();

    await clickLink(page, anchorsOf(page, 2).nth(1));
    await expect(page.getByTestId('pdf-link-notice')).toContainText('"mailto:"');
    await expect(dialogOf(page)).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('nist-cswp29-csf-2-0: dragging across a link of a real page selects text and follows nothing', async ({
    env,
  }) => {
    const requested = await stubWeb(env.context);
    const { page } = await openRealPdf(env, byName('nist-cswp29-csf-2-0.pdf'));
    await goToPage(page, 2);
    await textOnPage(page, 2);
    await expect(anchorsOf(page, 2)).toHaveCount(2, { timeout: 60_000 });
    const tabs = env.context.pages().length;
    const link = await boxOf(anchorsOf(page, 2).nth(0));
    const y = link.y + link.h / 2;
    await page.mouse.move(Math.max(4, link.x - 40), y);
    await page.mouse.down();
    await page.mouse.move(link.x + link.w + 40, y, { steps: 16 });
    await page.mouse.up();
    await expect(page.getByTestId('pdf-savebar')).toBeVisible();
    const selected = await page.evaluate(() => document.getSelection()?.toString() ?? '');
    expect(selected.trim().length).toBeGreaterThan(3);
    await expect(dialogOf(page)).toHaveCount(0);
    expect(env.context.pages()).toHaveLength(tabs);
    expect(requested).toEqual([]);
  });

  test('cdc-sti-guidelines-2021: a reference page with dozens of links is one tab stop and a full list', async ({
    env,
  }) => {
    const { page, errors } = await openRealPdf(env, byName('cdc-sti-guidelines-2021.pdf'));
    await goToPage(page, 138);
    await expect(pageInput(page)).toHaveValue('138');
    await expect.poll(() => anchorsOf(page, 138).count(), { timeout: 60_000 }).toBeGreaterThan(40);
    const n = await anchorsOf(page, 138).count();
    const layer = page.locator('[data-testid="pdf-page-138"] .sv-pdf-layer--links');
    await expect(layer.locator('a[tabindex="0"]')).toHaveCount(1);

    // Only the drawn window has anchors (a few pages, never the 3,779 of the file), and a page with
    // more than 40 links adds one tab stop to the sequence, not one per link: what is left is at most
    // 40 per sparse page (page 137 holds 40) and one per dense page.
    const stops = await page
      .locator('[data-testid="pdf-viewer"] .sv-pdf-layer--links a[tabindex="0"]')
      .count();
    const anchors = await page.locator('[data-testid="pdf-viewer"] .sv-pdf-layer--links a').count();
    const drawn = await page.locator('[data-testid="pdf-viewer"] canvas.sv-pdf-canvas').count();
    expect(drawn).toBeLessThanOrEqual(4);
    expect(stops).toBeLessThanOrEqual(40 * drawn);
    expect(stops).toBeLessThan(anchors);
    expect(anchors).toBeLessThan(600);

    await page.getByTestId('pdf-toggle-sidepane').click();
    await page.getByRole('tab', { name: `Links (${n})` }).click();
    await expect(page.getByTestId('pdf-links-list').getByRole('button')).toHaveCount(n);
    expect(errors).toEqual([]);
  });
});
