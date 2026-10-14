import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Sunny Vault token contrast (WCAG 1.4.3 text >= 4.5:1, 1.4.11 non-text >= 3:1), computed from
 * the real design/tokens.css in light, dark and high contrast, var() chains included. Also proves
 * every legacy --sv-* name is still defined, so swapping the token file cannot leave a page with
 * an undefined variable.
 */
const read = (name: string) =>
  readFileSync(new URL(name, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const tokens = read('./tokens.css').replace(/\/\*[\s\S]*?\*\//g, '');

function block(css: string, selectorStart: string, from = 0): string {
  const at = css.indexOf(selectorStart, from);
  expect(at, `selector ${selectorStart}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', at);
  return css.slice(open + 1, css.indexOf('}', open));
}
function decls(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of body.matchAll(/(--sv-[a-z0-9-]+):\s*([^;]+);/g)) out.set(m[1]!, m[2]!.trim());
  return out;
}
const merge = (...maps: Map<string, string>[]) => new Map(maps.flatMap((m) => [...m]));

const independent = decls(block(tokens, ':root,\n:host {'));
const light = decls(block(tokens, ":root,\n:host,\n[data-theme='light'] {"));
const darkMedia = decls(block(tokens, ":root:not([data-theme='light']),"));
const dark = decls(block(tokens, "[data-theme='dark'] {"));
const contrastMedia = decls(block(tokens, '@media (prefers-contrast: more)'));
const contrast = decls(block(tokens, "[data-contrast='more'],"));
const aliases = decls(block(tokens, ':root,\n:host,\n.sv-root,'));

const SCOPES = {
  light: merge(independent, light, aliases),
  dark: merge(independent, light, dark, aliases),
  'light high-contrast': merge(independent, light, contrast, aliases),
  'dark high-contrast': merge(independent, light, dark, contrast, aliases),
};

function resolve(scope: Map<string, string>, name: string): string {
  let value = scope.get(name);
  for (let hops = 0; value?.startsWith('var('); hops++) {
    expect(hops, `var() cycle at ${name}`).toBeLessThan(8);
    value = scope.get(/var\((--sv-[a-z0-9-]+)\)/.exec(value)![1]!);
  }
  expect(value, `${name} resolves to a hex colour`).toMatch(/^#[0-9a-f]{6}$/i);
  return value!;
}
function luminance(hex: string): number {
  const channel = (i: number) => {
    const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}
function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const SURFACES = ['--sv-canvas', '--sv-surface', '--sv-surface-2'];
const on = (fg: string, bgs: string[]): Array<[string, string]> => bgs.map((bg) => [fg, bg]);

const TEXT: Array<[string, string]> = [
  ...on('--sv-ink', [...SURFACES, '--sv-sunk', '--sv-primary-soft']),
  ...on('--sv-ink-2', [...SURFACES, '--sv-sunk', '--sv-primary-soft']),
  ...on('--sv-primary-soft-ink', [...SURFACES, '--sv-primary-soft']),
  ['--sv-on-primary', '--sv-primary'],
  ['--sv-on-primary', '--sv-primary-edge'],
  ['--sv-on-sun', '--sv-sun'],
  ...on('--sv-sun-soft-ink', ['--sv-sun-soft', '--sv-surface']),
  ...on('--sv-flame-ink', SURFACES),
  // Chunky tone buttons carry white text on their fill.
  ...on('--sv-on-primary', [
    '--sv-success-fill',
    '--sv-danger-fill',
    '--sv-warning-fill',
    '--sv-violet-fill',
  ]),
  ...['success', 'danger', 'warning', 'violet'].flatMap((t) =>
    on(`--sv-${t}-ink`, [`--sv-${t}-soft`, '--sv-surface', '--sv-canvas']),
  ),
  // The tooltip is drawn in the inverse of the surface.
  ['--sv-surface', '--sv-ink'],
  // Legacy pairs from packages/ui/src/contrast.test.ts, now on Sunny values.
  ...on('--sv-text', ['--sv-bg', '--sv-surface', '--sv-info-bg', '--sv-danger-bg']),
  ...on('--sv-text', ['--sv-warning-bg', '--sv-surface-raised']),
  ...on('--sv-text-muted', ['--sv-bg', '--sv-surface', '--sv-info-bg', '--sv-surface-raised']),
  ...on('--sv-accent', ['--sv-bg', '--sv-surface', '--sv-info-bg']),
  ...on('--sv-accent-text', ['--sv-accent', '--sv-accent-hover']),
  ...on('--sv-danger', ['--sv-bg', '--sv-danger-bg']),
  ...on('--sv-success', ['--sv-bg', '--sv-success-bg']),
  ['--sv-info', '--sv-info-bg'],
  ['--sv-warning', '--sv-warning-bg'],
  ['--sv-bg', '--sv-text'],
];

const NON_TEXT: Array<[string, string]> = [
  ...on('--sv-focus', [...SURFACES, '--sv-sunk', '--sv-primary-soft', '--sv-danger-bg']),
  ...on('--sv-line-strong', [...SURFACES, '--sv-sunk', '--sv-primary-soft']),
  // Selected choice card / tab ring and the switch-on track against the card.
  ...on('--sv-primary', ['--sv-surface', '--sv-canvas']),
  // Progress against its track and its card (yellow carries a --sv-sun-line outline).
  ...on('--sv-sun-line', ['--sv-sunk', '--sv-surface']),
  ...on('--sv-bar-primary', ['--sv-sunk', '--sv-surface']),
  ...on('--sv-bar-success', ['--sv-sunk', '--sv-surface']),
  ...on('--sv-bar-violet', ['--sv-sunk', '--sv-surface']),
  ...on('--sv-ice', ['--sv-surface', '--sv-canvas']),
  ...on('--sv-border-strong', ['--sv-bg', '--sv-surface', '--sv-info-bg', '--sv-surface-raised']),
  // Heatmap: the busiest day and today's flame ring must stand out from the card.
  ['--sv-heat-4', '--sv-surface'],
  ['--sv-heat-3', '--sv-surface'],
  // Goal-met dot on the two "met" shades, and the freeze snowflake on an empty day.
  ['--sv-surface', '--sv-heat-3'],
  ['--sv-surface', '--sv-heat-4'],
  ['--sv-ice', '--sv-heat-0'],
  // Two-tone focus: ring against its halo, halo against a blue hero (UX_DESIGN 2.2).
  ['--sv-focus', '--sv-focus-halo'],
  ['--sv-focus-halo', '--sv-primary'],
  // Invalid field border on the input fill; the ring's "done" badge on the card.
  ['--sv-danger-ink', '--sv-surface-2'],
  ['--sv-success-fill', '--sv-surface'],
];

describe('design tokens', () => {
  it('keeps the dark media block and the [data-theme=dark] block identical', () => {
    expect([...darkMedia]).toEqual([...dark]);
    expect([...contrastMedia]).toEqual([...contrast]);
  });

  it('defines every legacy --sv-* name in every theme', () => {
    const legacy = [
      ...read('../tokens.css').matchAll(/(--sv-[a-z0-9-]+):/g),
      ...block(read('../components.css'), ':root {').matchAll(/(--sv-[a-z0-9-]+):/g),
    ].map((m) => m[1]!);
    expect(legacy.length).toBeGreaterThan(50);
    for (const scope of Object.values(SCOPES)) {
      for (const name of new Set(legacy)) expect(scope.has(name), name).toBe(true);
    }
  });

  for (const [mode, scope] of Object.entries(SCOPES)) {
    it(`${mode}: text pairs are at least 4.5:1`, () => {
      for (const [fg, bg] of TEXT) {
        const r = ratio(resolve(scope, fg), resolve(scope, bg));
        expect(r, `${fg} on ${bg} = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      }
    });
    it(`${mode}: focus ring, control edges, bars and markers are at least 3:1`, () => {
      for (const [fg, bg] of NON_TEXT) {
        const r = ratio(resolve(scope, fg), resolve(scope, bg));
        expect(r, `${fg} on ${bg} = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(3);
      }
    });
  }

  it('high contrast turns muted text into body text and every border into a strong line', () => {
    for (const mode of ['light high-contrast', 'dark high-contrast'] as const) {
      const s = SCOPES[mode];
      expect(resolve(s, '--sv-text-muted')).toBe(resolve(s, '--sv-text'));
      expect(ratio(resolve(s, '--sv-border'), resolve(s, '--sv-surface'))).toBeGreaterThan(7);
    }
  });
});
