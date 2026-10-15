import AxeBuilder from '@axe-core/playwright';
import { settleAnimations } from './axeSettle';
import { activate, expect, openFixture, test, tripleClick } from './helpers.compat';

/**
 * Typeset TeX in the side panel (docs/adr/015-math-rendering.md, amendment 1). math.spec.ts covers the
 * dashboard; the side panel is a different page with its own copy of the stylesheet bundle, and the
 * typesetter and its CSS are fetched lazily, so this proves that page does the same: a formula in a
 * card note is typeset, nothing is fetched before there is one, the editor shows the TeX as typed,
 * and the result passes axe in both colour schemes.
 */

test.describe.configure({ timeout: 240_000 });

const TEX = String.raw`Heart rate $HR = \frac{60}{RR}$ bpm`;

test('a formula in a side-panel note is typeset, fetched lazily, and edited as typed', async ({
  env,
}) => {
  test.slow(); // saving a highlight, a note, and two axe scans in one test
  const panel = await env.context.newPage();
  const seen: string[] = [];
  panel.on('request', (request) => {
    if (/mathTypeset-[^/]*\.(js|css)$/.test(request.url())) seen.push(request.url());
  });
  await panel.goto(`chrome-extension://${env.extensionId}/sidepanel.html`);

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
  expect(seen, 'a panel without a formula fetches no typesetter').toEqual([]);

  // Study notes sit in the card's "More actions" drawer.
  const more = card.getByTestId('card-more');
  await more.click();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await card.getByRole('button', { name: 'Add a note' }).click();
  await card.getByLabel('New study note (Markdown)').fill(TEX);
  await card.getByRole('button', { name: 'Save note' }).click();

  const note = card.getByTestId('card-note');
  await expect(note.locator('math')).toHaveCount(1);
  await expect(note.locator('code.math')).toHaveCount(0);
  await expect(note.locator('math mfrac')).toHaveCount(1);
  await expect(note).toContainText('Heart rate');
  const box = await note.locator('math').evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { width: r.width, height: r.height, display: getComputedStyle(el).display };
  });
  expect(box.width).toBeGreaterThan(0);
  expect(box.height).toBeGreaterThan(0);
  expect(box.display).toBe('math');
  // one script and one stylesheet, fetched when the formula was first shown
  expect(seen.filter((u) => u.endsWith('.js'))).toHaveLength(1);
  expect(seen.filter((u) => u.endsWith('.css'))).toHaveLength(1);

  // The drawer stays open while the data under it changes (the note saved, the highlight's "Not
  // checked yet" status settling): nothing below reopens it.
  const noteShown = async () => {
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    await expect(note.locator('math')).toHaveCount(1);
  };

  for (const scheme of ['light', 'dark'] as const) {
    await panel.emulateMedia({ colorScheme: scheme });
    await noteShown();
    await settleAnimations(panel);
    const results = await new AxeBuilder({ page: panel })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(
      results.violations.map(
        (v) => `${v.id}: ${v.nodes.map((n) => n.html.slice(0, 120)).join(' | ')}`,
      ),
      `axe violations (${scheme})`,
    ).toEqual([]);
  }

  // The editor shows what was typed, not the rendering.
  await noteShown();
  await card.getByRole('button', { name: /^Edit this note/ }).click();
  await expect(card.getByLabel('Study note (Markdown)')).toHaveValue(TEX);
});
