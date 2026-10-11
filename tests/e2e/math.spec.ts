import type { Locator } from '@playwright/test';
import {
  buildDataset,
  ensureVault,
  expect,
  expectAxeClean,
  expectResult,
  externalRequests,
  openControl,
  openDashboard,
  openPreview,
  pageErrors,
  rowEl,
  settle,
  test,
  writeDataset,
  type Env,
} from './helpers.dashboard';

/**
 * TeX in notes (docs/adr/015-math-rendering.md). The renderer is deliberately NOT a typesetter: the
 * smallest MIT TeX-to-MathML library measured 164 KB minified, over the 120 KB ceiling. TeX is kept
 * as its source in `<code class="math">`, so these specs prove what that promises in a real loaded
 * extension: the source survives (render, edit, reload, search), Markdown does not mangle it, and
 * hostile TeX and markup stay inert.
 */

test.describe.configure({ timeout: 240_000 });

const sourceA = (env: Env) => `${env.origin}/dash-source-a.html`;

const INLINE = String.raw`$e^{i\pi} + 1 = 0$`;
const DISPLAY = String.raw`$$
\int_0^1 x\,dx = \frac{1}{2}
$$`;
const NOTE = `Euler: ${INLINE} and *see $a*b$ here*\n\n${DISPLAY}\n\nIt costs $5 and $10.`;

async function seed(env: Env, withHostileNote: boolean) {
  const ctrl = await openControl(env);
  await ensureVault(ctrl);
  const hostile = hostileNote(env);
  const ds = buildDataset({
    sources: [{ key: 's', url: sourceA(env), title: 'Dash Source A: Cell Biology' }],
    highlights: [
      { key: 'tex', quote: 'Euler found a remarkable identity.', source: 's' },
      {
        key: 'bad',
        quote: 'A passage with a hostile note.',
        source: 's',
        ...(withHostileNote ? { notes: [{ body: hostile }] } : {}),
      },
    ],
  });
  await writeDataset(ctrl, ds);
  return { ds };
}

/** TeX a typesetter would act on, and ways to leave the math element, in one note. */
function hostileNote(env: Env): string {
  return [
    String.raw`$\href{javascript:window.__svPwned=1}{click}$`,
    String.raw`$\url{javascript:window.__svPwned=2}$`,
    String.raw`$\includegraphics{${env.origin}/pixel.png}$`,
    '$<img src=x onerror="window.__svPwned=3">$',
    '$$<script>window.__svPwned=4</script>$$',
    '$</code><img src=x onerror="window.__svPwned=5"><code>$',
    '$x" onmouseover="window.__svPwned=6$',
    `$$\n<iframe src="${env.origin}/index.html"></iframe>\n$$`,
    '<code class="math" onclick="window.__svPwned=7">raw</code>',
    '```math\n<svg onload="window.__svPwned=8"></svg>\n```',
    '[safe link](https://example.org/safe)',
  ].join('\n\n');
}

test.describe('TeX math in notes', () => {
  test('a note with inline and display math keeps its source through render, edit, reload and search', async ({
    env,
  }) => {
    const { ds } = await seed(env, false);
    const page = await openDashboard(env);
    await openPreview(page, ds.id.hl('tex'));
    const notes = page.getByTestId('preview-notes');

    await notes.getByTestId('note-add').click();
    await notes.getByTestId('note-body').fill(NOTE);
    await notes.getByRole('button', { name: 'Preview' }).click();

    // The editor preview and the saved note go through the same renderer.
    const expectRendered = async (root: Locator) => {
      const math = root.locator('code.math');
      await expect(math).toHaveCount(3);
      await expect(math.nth(0)).toHaveText(INLINE);
      await expect(math.nth(1)).toHaveText('$a*b$');
      await expect(math.nth(2)).toHaveText(DISPLAY);
      await expect(math.nth(2)).toHaveClass('math math-display');
      // Not only equal after whitespace folding: the line breaks of the source are intact.
      expect(await math.nth(2).evaluate((el) => el.textContent)).toBe(DISPLAY);
      // Markdown did not read the formula's own stars as emphasis, but did honour the real emphasis.
      await expect(root.locator('em')).toHaveCount(1);
      await expect(root.locator('em code.math')).toHaveText('$a*b$');
      // Prices are not math.
      await expect(root).toContainText('It costs $5 and $10.');
    };
    await expectRendered(notes.getByTestId('note-preview'));

    await notes.getByRole('button', { name: 'Back to editing' }).click();
    await notes.getByTestId('note-save').click();
    const note = notes.getByTestId('note').first();
    await expectRendered(note.locator('.sv-md'));

    // The raw TeX is searchable: the index holds the note body, not its rendering.
    await page.getByTestId('search-input').fill('frac');
    await expectResult(page, ['tex'], ds);
    await expect(rowEl(page, ds.id.hl('tex'))).toContainText('Matched a note');
    await page.getByTestId('search-input').fill('');

    // Survives a reload; editing shows the body exactly as typed, not the rendered text.
    await page.reload();
    await settle(page);
    await openPreview(page, ds.id.hl('tex'));
    const reloaded = page.getByTestId('preview-notes').getByTestId('note').first();
    await expectRendered(reloaded.locator('.sv-md'));
    await reloaded.getByTestId('note-edit').click();
    await expect(page.getByTestId('note-body')).toHaveValue(NOTE);

    expect(pageErrors(page)).toEqual([]);
    expect(externalRequests(page), 'rendering math made no network request').toEqual([]);
  });

  test('hostile TeX and markup stay inert text', async ({ env }) => {
    const { ds } = await seed(env, true);
    const page = await openDashboard(env);
    await openPreview(page, ds.id.hl('bad'));

    const saved = page.getByTestId('preview-notes').getByTestId('note').locator('.sv-md');
    await expect(saved).toContainText('safe link');

    const report = await saved.evaluate((el) => ({
      forbidden: el.querySelectorAll(
        'img, script, iframe, object, embed, svg, style, form, input, link, meta, base, video, audio, math',
      ).length,
      handlers: Array.from(el.querySelectorAll('*')).filter((n) =>
        Array.from(n.attributes).some((a) => a.name.toLowerCase().startsWith('on')),
      ).length,
      styled: el.querySelectorAll('[style]').length,
      classes: Array.from(el.querySelectorAll('[class]')).map(
        (n) => `${n.tagName.toLowerCase()}.${n.getAttribute('class')}`,
      ),
      links: Array.from(el.querySelectorAll('a')).map((a) => a.getAttribute('href')),
      text: el.textContent ?? '',
    }));
    expect(report.forbidden, 'no img/script/iframe/svg/math element was created').toBe(0);
    expect(report.handlers, 'no event-handler attribute').toBe(0);
    expect(report.styled, 'no style attribute').toBe(0);
    // The only class on the page's note is the math marker, and only on <code>.
    expect(report.classes.length).toBeGreaterThan(0);
    for (const c of report.classes) expect(c).toMatch(/^code\.math( math-display)?$/);
    // The one link is the plain https one; \href and \url became text.
    expect(report.links).toEqual(['https://example.org/safe']);
    // Every TeX source is still readable, verbatim.
    expect(report.text).toContain(String.raw`\href{javascript:window.__svPwned=1}{click}`);
    expect(report.text).toContain(String.raw`\url{javascript:window.__svPwned=2}`);
    expect(report.text).toContain(String.raw`\includegraphics{${env.origin}/pixel.png}`);
    expect(report.text).toContain('<img src=x onerror="window.__svPwned=3">');
    expect(report.text).toContain('<script>window.__svPwned=4</script>');
    expect(report.text).toContain('<code class="math" onclick="window.__svPwned=7">raw</code>');

    expect(await page.evaluate(() => (window as { __svPwned?: number }).__svPwned)).toBe(undefined);
    expect(externalRequests(page), 'no image or frame was requested').toEqual([]);
    expect(pageErrors(page)).toEqual([]);
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`rendered and previewed math has no axe violations (${scheme})`, async ({ env }) => {
      const { ds } = await seed(env, false);
      const page = await openDashboard(env);
      await page.emulateMedia({ colorScheme: scheme });
      await openPreview(page, ds.id.hl('tex'));
      const notes = page.getByTestId('preview-notes');

      await notes.getByTestId('note-add').click();
      await notes.getByTestId('note-body').fill(NOTE);
      await notes.getByRole('button', { name: 'Preview' }).click();
      await expect(notes.getByTestId('note-preview').locator('code.math')).toHaveCount(3);
      await expectAxeClean(page, '[data-testid="preview-notes"]');

      await notes.getByRole('button', { name: 'Back to editing' }).click();
      await notes.getByTestId('note-save').click();
      await expect(notes.getByTestId('note').locator('code.math')).toHaveCount(3);
      await expectAxeClean(page, '[data-testid="preview-notes"]');
    });
  }
});
