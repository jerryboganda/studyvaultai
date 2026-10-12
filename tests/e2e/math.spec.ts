import {
  expect,
  expectAxeClean,
  expectResult,
  externalRequests,
  openDashboard,
  openPreview,
  pageErrors,
  recordPerf,
  rowEl,
  settle,
  test,
} from './helpers.dashboard';
import {
  DISPLAY,
  INLINE,
  NOTE,
  VARIED,
  expectLaidOut,
  expectTypeset,
  seed,
  watchTypesetter,
} from './helpers.math';

/**
 * TeX in notes (docs/adr/015-math-rendering.md, amendment 1). `$...$` and `$$...$$` are typeset to
 * native MathML by temml, loaded with `import()` the first time a note holds a formula. These specs
 * prove, in a real loaded extension with Chromium's real MathML layout: formulas are typeset, the
 * stored note body is still the TeX, search finds it, hostile TeX and markup stay inert, a formula the
 * typesetter refuses (or cannot fetch) stays readable source text, and nothing is fetched for pages
 * without math.
 */

test.describe.configure({ timeout: 240_000 });

test.describe('TeX math in notes', () => {
  test('a note with inline and display math is typeset, and its TeX survives edit, reload and search', async ({
    env,
  }) => {
    const { ds } = await seed(env);
    const page = await openDashboard(env);
    const typesetter = watchTypesetter(page);

    await openPreview(page, ds.id.hl('tex'));
    expect(typesetter.js, 'a note without formulas loads no typesetter').toEqual([]);
    const notes = page.getByTestId('preview-notes');

    await notes.getByTestId('note-add').click();
    await notes.getByTestId('note-body').fill(NOTE);
    await notes.getByRole('button', { name: 'Preview' }).click();

    // The editor preview and the saved note go through the same renderer.
    const expectRendered = async (root: ReturnType<typeof notes.locator>) => {
      await expectTypeset(root, 3);
      const math = root.locator('math');
      await expect(math.nth(0)).toHaveText('eiπ+1=0');
      // the star is the formula's, not emphasis; the real emphasis around it is still emphasis
      await expect(math.nth(1)).toHaveText('a∗b');
      await expect(root.locator('em')).toHaveCount(1);
      await expect(root.locator('em math')).toHaveText('a∗b');
      await expect(math.nth(2)).toHaveAttribute('display', 'block');
      await expect(math.nth(2).locator('mfrac')).toHaveCount(1);
      await expect(root.locator('math[display="block"]')).toHaveCount(1);
      // Prices are not math.
      await expect(root).toContainText('It costs $5 and $10.');
      // Real MathML layout: a block formula is a block, a fraction stacks its numerator on top.
      await expectLaidOut(root);
      const fraction = await math
        .nth(2)
        .locator('mfrac')
        .evaluate((el) => {
          const [top, bottom] = Array.from(el.children).map((c) => c.getBoundingClientRect());
          return { above: top!.bottom <= bottom!.top + 1, widthOk: top!.width > 0 };
        });
      expect(fraction).toEqual({ above: true, widthOk: true });
    };
    await expectRendered(notes.getByTestId('note-preview'));
    // fetched once the first formula was shown, as one script and its stylesheet
    expect(typesetter.js).toHaveLength(1);
    expect(typesetter.css).toHaveLength(1);

    await notes.getByRole('button', { name: 'Back to editing' }).click();
    await notes.getByTestId('note-save').click();
    const note = notes.getByTestId('note').first();
    await expectRendered(note.locator('.sv-md'));
    expect(typesetter.js, 'the typesetter is fetched once per page').toHaveLength(1);

    // The raw TeX is searchable: the index holds the note body, not its rendering.
    await page.getByTestId('search-input').fill('frac');
    await expectResult(page, ['tex'], ds);
    await expect(rowEl(page, ds.id.hl('tex'))).toContainText('Matched a note');
    await page.getByTestId('search-input').fill('');

    // Survives a reload (typeset again); editing shows the body exactly as typed, not the rendering.
    await page.reload();
    await settle(page);
    await openPreview(page, ds.id.hl('tex'));
    const reloaded = page.getByTestId('preview-notes').getByTestId('note').first();
    await expectRendered(reloaded.locator('.sv-md'));
    await reloaded.getByTestId('note-edit').click();
    await expect(page.getByTestId('note-body')).toHaveValue(NOTE);
    expect(NOTE).toContain(INLINE);
    expect(NOTE).toContain(DISPLAY);

    expect(pageErrors(page)).toEqual([]);
    expect(externalRequests(page), 'typesetting made no network request').toEqual([]);
  });

  test('a formula the typesetter refuses stays source text next to one it typesets', async ({
    env,
  }) => {
    const refused = [
      String.raw`$\color{red}x$`,
      String.raw`$\notacommand$`,
      '$\\label{a}\\ref{a}$',
    ];
    const note = String.raw`Typeset $\frac{a}{b}$ then ${refused.join(' and ')}.`;
    const { ds } = await seed(env, { note });
    const page = await openDashboard(env);
    await openPreview(page, ds.id.hl('tex'));
    const saved = page.getByTestId('preview-notes').getByTestId('note').locator('.sv-md');
    await expect(saved.locator('math')).toHaveCount(1);
    await expect(saved.locator('math mfrac')).toHaveCount(1);
    // the three it refuses are on screen exactly as typed, as code, in document order
    await expect(saved.locator('code.math')).toHaveText(refused);
    expect(pageErrors(page)).toEqual([]);
  });

  test('hostile TeX and markup stay inert, in text or in the typeset formula', async ({ env }) => {
    const { ds } = await seed(env, { hostile: true });
    const page = await openDashboard(env);
    await openPreview(page, ds.id.hl('bad'));

    const saved = page.getByTestId('preview-notes').getByTestId('note').locator('.sv-md');
    await expect(saved).toContainText('safe link');
    // the formulas that do typeset (the \text ones) have arrived before the report is read
    await expect(saved.locator('math').first()).toBeVisible();

    const report = await saved.evaluate((el) => {
      const MML = 'http://www.w3.org/1998/Math/MathML';
      const all = Array.from(el.querySelectorAll('*'));
      return {
        forbidden: el.querySelectorAll(
          'img, script, iframe, object, embed, svg, style, form, input, link, meta, base, video, audio, annotation, annotation-xml, semantics, maction, mglyph, malignmark',
        ).length,
        handlers: all.filter((n) =>
          Array.from(n.attributes).some((a) => a.name.toLowerCase().startsWith('on')),
        ).length,
        // the only inline style a formula may carry is spacing
        styles: Array.from(el.querySelectorAll('[style]')).map(
          (n) => n.getAttribute('style') ?? '',
        ),
        classes: Array.from(el.querySelectorAll('[class]')).map(
          (n) =>
            `${n.namespaceURI === MML ? 'mathml' : 'html'}:${n.localName}.${n.getAttribute('class')}`,
        ),
        // every MathML element sits in the MathML namespace, under a <math>
        strayMath: all.filter((n) => n.namespaceURI === MML && !n.closest('math')).length,
        htmlInMath: Array.from(el.querySelectorAll('math *')).filter((n) => n.namespaceURI !== MML)
          .length,
        links: Array.from(el.querySelectorAll('a')).map((a) => a.getAttribute('href')),
        ids: el.querySelectorAll('[id]').length,
        mtext: Array.from(el.querySelectorAll('math mtext')).map((n) => n.textContent ?? ''),
        codes: Array.from(el.querySelectorAll('code.math')).map((n) => n.textContent ?? ''),
        text: el.textContent ?? '',
      };
    });
    expect(report.forbidden, 'no img/script/iframe/svg/annotation/mglyph element exists').toBe(0);
    expect(report.handlers, 'no event-handler attribute').toBe(0);
    expect(report.ids, 'no id attribute').toBe(0);
    for (const style of report.styles) {
      expect(style, 'inline style on a formula').toMatch(
        /^[a-z-]+: [-0-9.a-z% ]+;?( [a-z-]+: [-0-9.a-z% ]+;?)*$/,
      );
      expect(style).not.toMatch(/color|background|url|position|display/);
    }
    expect(report.strayMath, 'MathML only inside <math>').toBe(0);
    expect(report.htmlInMath, 'no HTML element inside <math>').toBe(0);
    // The classes on the page's note: the math marker on <code>, nothing else outside MathML.
    for (const c of report.classes) {
      expect(c).toMatch(/^(html:code\.math( math-display)?|mathml:[a-z]+\.[a-z0-9 -]+)$/);
    }
    // The one link is the plain https one; \href, \url and the HTML ones became text or were refused.
    expect(report.links).toEqual(['https://example.org/safe']);
    // Markup typed inside \text is text of an <mtext>, not an element.
    expect(report.mtext.some((t) => t.includes('<img'))).toBe(true);
    // Everything refused is still readable, verbatim.
    expect(report.text).toContain(String.raw`\href{javascript:window.__svPwned=1}{click}`);
    expect(report.text).toContain(String.raw`\url{javascript:window.__svPwned=2}`);
    expect(report.text).toContain(String.raw`\includegraphics{${env.origin}/pixel.png}`);
    expect(report.text).toContain('<img src=x onerror="window.__svPwned=3">');
    expect(report.text).toContain('<script>window.__svPwned=4</script>');
    expect(report.text).toContain('<code class="math" onclick="window.__svPwned=7">raw</code>');
    expect(report.text).toContain(String.raw`\htmlClass{a}{x}`);
    expect(report.text).toContain(String.raw`\color{red}z`);

    // Nothing ran, and nothing was requested on the hostile note's behalf.
    expect(
      await page.evaluate(() => {
        const w = window as { __svPwned?: number; svPwned?: number };
        return [w.__svPwned, w.svPwned];
      }),
    ).toEqual([undefined, undefined]);
    expect(externalRequests(page), 'no image, frame or stylesheet was requested').toEqual([]);
    expect(pageErrors(page)).toEqual([]);
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`typeset math has no axe violations (${scheme})`, async ({ env }) => {
      const { ds } = await seed(env, { note: `${NOTE}\n\n${VARIED}` });
      const page = await openDashboard(env);
      await page.emulateMedia({ colorScheme: scheme });
      await openPreview(page, ds.id.hl('tex'));
      const notes = page.getByTestId('preview-notes');
      await expect(notes.getByTestId('note').locator('math')).toHaveCount(3 + 7);
      await expect(notes.getByTestId('note').locator('code.math')).toHaveCount(0);
      await expectAxeClean(page, '[data-testid="preview-notes"]');

      // and the editor's preview of the same text
      await notes.getByTestId('note-edit').click();
      await notes.getByRole('button', { name: 'Preview' }).click();
      await expectTypeset(notes.getByTestId('note-preview'), 3 + 7);
      await expectAxeClean(page, '[data-testid="preview-notes"]');
    });
  }

  test('typeset math follows forced colours and keeps its direction in a right-to-left note', async ({
    env,
  }) => {
    const note = `غشاء البلازما $x_1^2$ طبقة ثنائية\n\n$$\\cancel{y} + \\frac{1}{2}$$`;
    const { ds } = await seed(env, { note });
    const page = await openDashboard(env);
    await page.emulateMedia({ forcedColors: 'active' });
    await openPreview(page, ds.id.hl('tex'));
    const saved = page.getByTestId('preview-notes').getByTestId('note').locator('.sv-md');
    await expectTypeset(saved, 2);

    const report = await saved.evaluate((el) => {
      const inline = el.querySelector('math:not([display])')!;
      const strike = el.querySelector('.tml-cancel')!;
      return {
        noteDir: getComputedStyle(el).direction,
        formulaDir: getComputedStyle(inline).direction,
        isolate: getComputedStyle(inline).unicodeBidi,
        adjust: getComputedStyle(strike).forcedColorAdjust,
        strikeBackground: getComputedStyle(strike).backgroundColor,
      };
    });
    expect(report.noteDir).toBe('rtl');
    expect(report.formulaDir).toBe('ltr');
    expect(report.isolate).toBe('isolate');
    // the strike is a filled shape: forced colours must not paint it with the page background
    expect(report.adjust).toBe('none');
    await expectAxeClean(page, '[data-testid="preview-notes"]');
  });

  test('Chromium exposes a typeset formula to assistive technology as structure, with no label of its own', async ({
    env,
  }) => {
    const { ds } = await seed(env, { note: String.raw`A $\frac{a}{b}$ and $\sqrt{x^2+1}$.` });
    const page = await openDashboard(env);
    await openPreview(page, ds.id.hl('tex'));
    const saved = page.getByTestId('preview-notes').getByTestId('note').locator('.sv-md');
    await expectTypeset(saved, 2);
    // No accessible name is invented from the TeX: a name would replace the structure below.
    await expect(
      saved.locator('math[aria-label], math[role], math[title], annotation'),
    ).toHaveCount(0);

    // Chromium's own accessibility tree (the DevTools protocol), not a screen reader: the formula is
    // there as MathML roles with its text, which is what a screen reader's MathML support reads.
    const client = await page.context().newCDPSession(page);
    await client.send('Accessibility.enable');
    const { nodes } = (await client.send('Accessibility.getFullAXTree')) as {
      nodes: Array<{ role?: { value: string }; ignored?: boolean; name?: { value: string } }>;
    };
    const roles = nodes.filter((n) => !n.ignored).map((n) => n.role?.value ?? '');
    expect(roles.filter((r) => r === 'MathMLMath')).toHaveLength(2);
    for (const role of ['MathMLFraction', 'MathMLSquareRoot', 'MathMLIdentifier', 'MathMLNumber']) {
      expect(roles, role).toContain(role);
    }
    // the TeX source is not exposed as a name or as text
    expect(nodes.some((n) => (n.name?.value ?? '').includes('\frac'))).toBe(false);
  });

  test('the source text stays when the typesetter cannot be fetched', async ({ env, context }) => {
    const { ds } = await seed(env, { note: NOTE });
    const blocked: string[] = [];
    await context.route(/\/chunks\/mathTypeset-[^/]*\.js$/, async (route) => {
      blocked.push(route.request().url());
      await route.abort();
    });
    const page = await openDashboard(env);
    await openPreview(page, ds.id.hl('tex'));
    const saved = page.getByTestId('preview-notes').getByTestId('note').locator('.sv-md');
    await expect(saved.locator('code.math')).toHaveCount(3);
    await expect
      .poll(() => blocked.length, { message: 'the fetch was attempted' })
      .toBeGreaterThan(0);
    // still complete after the failed fetch: no formula was lost, none half-typeset
    await expect(saved.locator('code.math').nth(0)).toHaveText(INLINE);
    await expect(saved.locator('code.math').nth(2)).toHaveText(DISPLAY);
    await expect(saved.locator('math')).toHaveCount(0);
    await expect(saved).toContainText('It costs $5 and $10.');
    // the aborted requests are logged by the browser; nothing was thrown
    expect(pageErrors(page).filter((e) => !/Failed to load resource/.test(e))).toEqual([]);
  });

  test('fifty formulas are typeset on first use and again on a later render', async ({ env }) => {
    const formulas = Array.from(
      { length: 50 },
      (_, i) => String.raw`$\frac{x_{${i}}+1}{\sqrt{y^{2}+${i}}} = \sum_{k=0}^{${i}} k$`,
    );
    const body = formulas.map((f, i) => `${i + 1}. ${f}`).join('\n');
    const { ds } = await seed(env);
    const page = await openDashboard(env);
    await openPreview(page, ds.id.hl('tex'));
    const notes = page.getByTestId('preview-notes');
    await notes.getByTestId('note-add').click();
    await notes.getByTestId('note-body').fill(body);

    // Clicks the button inside the page and times it until the preview shows `count` matches.
    const timeTo = (label: string, selector: string, count: number) =>
      page.evaluate(
        async ({ label, selector, count }) => {
          const scope = document.querySelector('[data-testid="preview-notes"]')!;
          const button = Array.from(scope.querySelectorAll('button')).find(
            (b) => b.textContent?.trim() === label,
          )!;
          const started = performance.now();
          button.click();
          await new Promise<void>((resolve, reject) => {
            const check = () => {
              const n = scope.querySelectorAll(selector).length;
              if (n === count) return resolve();
              if (performance.now() - started > 20_000) return reject(new Error(`only ${n}`));
              requestAnimationFrame(check);
            };
            check();
          });
          return performance.now() - started;
        },
        { label, selector, count },
      );
    const preview = notes.getByTestId('note-preview');

    // first use: the preview opens, the chunk is fetched, 50 formulas are typeset
    const first = await timeTo('Preview', '[data-testid="note-preview"] math', 50);
    await expectTypeset(preview, 50);
    // a later render: the typesetter is there, formulas are typeset in the same task as the paint
    await notes.getByRole('button', { name: 'Back to editing' }).click();
    const again = await timeTo('Preview', '[data-testid="note-preview"] math', 50);
    await expectTypeset(preview, 50);
    // the same note with the formulas spoiled so they are not math ("$ x $"): what the render costs
    // without the typesetter, so the difference is the cost of typesetting 50 formulas
    await notes.getByRole('button', { name: 'Back to editing' }).click();
    const plain = formulas.map(
      (f, i) => `${i + 1}. ${f.replace(/^\$/, '$ ').replace(/\$$/, ' $')}`,
    );
    await notes.getByTestId('note-body').fill(plain.join('\n'));
    const without = await timeTo('Preview', '[data-testid="note-preview"] li', 50);
    await expect(preview.locator('math')).toHaveCount(0);
    recordPerf('math: 50 formulas, first use (fetch + typeset)', first);
    recordPerf('math: 50 formulas, typesetter loaded', again);
    recordPerf('math: the same 50 lines as text (no typesetting)', without);
    recordPerf('math: typesetting 50 formulas (loaded minus text)', again - without);
    // a bound that catches a freeze, not a benchmark (CI runners are slow and noisy)
    expect(first).toBeLessThan(10_000);
    expect(again).toBeLessThan(5_000);
    expect(pageErrors(page)).toEqual([]);
  });
});
