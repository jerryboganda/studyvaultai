import type { Locator, Page } from '@playwright/test';
import {
  buildDataset,
  ensureVault,
  expect,
  openControl,
  writeDataset,
  type Env,
} from './helpers.dashboard';

/**
 * Helpers for math.spec.ts: typeset TeX in notes (docs/adr/015-math-rendering.md). The renderer paints
 * the source text first and swaps in <math> once the lazily loaded typesetter (chunks/mathTypeset-*.js
 * and its stylesheet) has arrived, so every wait here is on the DOM, never on time.
 */

export const sourceA = (env: Env) => `${env.origin}/dash-source-a.html`;

export const INLINE = String.raw`$e^{i\pi} + 1 = 0$`;
export const DISPLAY = String.raw`$$
\int_0^1 x\,dx = \frac{1}{2}
$$`;
/** Two inline formulas (one inside emphasis, with its own star), one display block, and a price. */
export const NOTE = `Euler: ${INLINE} and *see $a*b$ here*\n\n${DISPLAY}\n\nIt costs $5 and $10.`;

/** Every kind of construct the typesetter is expected to carry, one per line. */
export const VARIED = [
  String.raw`Fraction $\frac{a+b}{c}$, chemistry $\ce{H2O}$ and $\mathrm{H_2SO_4}$, strike $\cancel{x}$.`,
  String.raw`$$\begin{pmatrix} a & b \\ c & d \end{pmatrix} = \begin{cases} x & x>0 \\ -x & x\le 0 \end{cases}$$`,
  String.raw`$$\sum_{i=1}^{n} i = \frac{n(n+1)}{2} \qquad \boxed{E = mc^2} \qquad \overline{AB} \qquad \vec{v}$$`,
  String.raw`$$\begin{aligned} a &= b + c \\ &= d \end{aligned}$$`,
].join('\n\n');

/** TeX a typesetter would act on, and ways to leave the math element, in one note. */
export function hostileNote(env: Env): string {
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
    // The same markup as the TeX of a formula that DOES typeset (no underscore: it is not valid in
    // text mode): it must end up as text in an <mtext>, never as elements.
    String.raw`$\text{<img src=x onerror="window.svPwned=9">}$`,
    String.raw`$\text{<math><mtext><table><mglyph><style><img src=x onerror="window.svPwned=10">}$`,
    String.raw`$\mathrm{</mtext><img src=x onerror="window.svPwned=11"><mtext>}$`,
    '<math><mtext><table><mglyph><style><img src=x onerror="window.__svPwned=12"></style></mglyph></table></mtext></math>',
    '<math><annotation-xml encoding="text/html"><img src=x onerror="window.__svPwned=13"></annotation-xml></math>',
    String.raw`$\htmlClass{a}{x}$ $\htmlStyle{background:url(${'https://tracker.example/x'})}{y}$ $\color{red}z$`,
    '[safe link](https://example.org/safe)',
  ].join('\n\n');
}

/** A dataset with one highlight `tex` (and, with a hostile note, one more `bad`) on source A. */
export async function seed(env: Env, options: { hostile?: boolean; note?: string } = {}) {
  const ctrl = await openControl(env);
  await ensureVault(ctrl);
  const ds = buildDataset({
    sources: [{ key: 's', url: sourceA(env), title: 'Dash Source A: Cell Biology' }],
    highlights: [
      {
        key: 'tex',
        quote: 'Euler found a remarkable identity.',
        source: 's',
        ...(options.note ? { notes: [{ body: options.note }] } : {}),
      },
      {
        key: 'bad',
        quote: 'A passage with a hostile note.',
        source: 's',
        ...(options.hostile ? { notes: [{ body: hostileNote(env) }] } : {}),
      },
    ],
  });
  await writeDataset(ctrl, ds);
  return { ds };
}

/** Requests for the lazily loaded typesetter, collected from now on. */
export function watchTypesetter(page: Page): { js: string[]; css: string[] } {
  const seen = { js: [] as string[], css: [] as string[] };
  page.on('request', (request) => {
    const url = request.url();
    if (/\/chunks\/mathTypeset-[^/]*\.js$/.test(url)) seen.js.push(url);
    if (/\/assets\/mathTypeset-[^/]*\.css$/.test(url)) seen.css.push(url);
  });
  return seen;
}

/** `root` shows exactly `count` typeset formulas and none as source text. */
export async function expectTypeset(root: Locator, count: number): Promise<void> {
  await expect(root.locator('math')).toHaveCount(count);
  await expect(root.locator('code.math')).toHaveCount(0);
}

/** Every formula of `root` has a box on screen, and display math is laid out as a block. */
export async function expectLaidOut(root: Locator): Promise<void> {
  const report = await root.evaluate((el) =>
    Array.from(el.querySelectorAll('math')).map((m) => {
      const r = m.getBoundingClientRect();
      return {
        width: r.width,
        height: r.height,
        display: getComputedStyle(m).display,
        block: m.getAttribute('display') === 'block',
      };
    }),
  );
  expect(report.length).toBeGreaterThan(0);
  for (const m of report) {
    expect(m.width, 'a typeset formula has a width').toBeGreaterThan(0);
    expect(m.height, 'a typeset formula has a height').toBeGreaterThan(0);
    expect(m.display).toBe(m.block ? 'block math' : 'math');
  }
}
