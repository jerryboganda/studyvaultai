import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The extension pages' form fields must be found by their edge (WCAG 1.4.11, >= 3:1) and their
 * placeholder must be readable (1.4.3, >= 4.5:1). Computed from the real CSS, so a token edit that
 * breaks either in light or dark fails here.
 */
const read = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');
const tokens = read('./tokens.css');
const components = read('./components.css');

function block(css: string, selectorStart: string): string {
  const at = css.indexOf(selectorStart);
  expect(at, `selector ${selectorStart} in tokens.css`).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf('}', at));
}
function token(scope: string, name: string): string {
  const m = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(scope);
  expect(m, `${name} in scope`).not.toBeNull();
  return m![1]!;
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

const SCOPES = {
  light: block(tokens, ':root,\n:host {'),
  dark: block(tokens, ":root[data-theme='dark'],"),
};

describe('form control contrast', () => {
  it('draws the control boundary and the placeholder from the strong tokens', () => {
    const control = block(components, '.sv-control {');
    expect(control).toContain('border: 1px solid var(--sv-border-strong)');
    const placeholder = block(components, '.sv-control::placeholder');
    expect(placeholder).toContain('color: var(--sv-text-muted)');
    expect(placeholder).toContain('opacity: 1');
  });

  for (const [mode, scope] of Object.entries(SCOPES)) {
    it(`${mode}: boundary >= 3:1 and placeholder >= 4.5:1 against the field background`, () => {
      const field = token(scope, '--sv-surface-raised');
      expect(ratio(token(scope, '--sv-border-strong'), field)).toBeGreaterThanOrEqual(3);
      expect(ratio(token(scope, '--sv-text-muted'), field)).toBeGreaterThanOrEqual(4.5);
      // Against the page too: a field sitting directly on the page background.
      expect(
        ratio(token(scope, '--sv-border-strong'), token(scope, '--sv-bg')),
      ).toBeGreaterThanOrEqual(3);
    });
  }
});

/**
 * The status and text pairs the extension pages actually draw (WCAG 1.4.3 text, 1.4.11 non-text),
 * read from the real token files so an edit to either mode that breaks one fails here.
 */
describe('token pairs', () => {
  const status = {
    light: block(components, ':root {'),
    dark: block(components, ":root[data-theme='dark'] {"),
  };
  const colour = (mode: 'light' | 'dark', name: string): string =>
    token(
      name.startsWith('--sv-info') || /warning|danger-bg|success-bg/.test(name)
        ? status[mode]
        : SCOPES[mode],
      name,
    );

  const TEXT: Array<[string, string]> = [
    ['--sv-text', '--sv-bg'],
    ['--sv-text', '--sv-surface'],
    ['--sv-text', '--sv-info-bg'],
    ['--sv-text-muted', '--sv-bg'],
    ['--sv-text-muted', '--sv-surface'],
    ['--sv-text-muted', '--sv-info-bg'],
    ['--sv-accent', '--sv-bg'],
    ['--sv-accent', '--sv-surface'],
    ['--sv-accent', '--sv-info-bg'],
    ['--sv-accent-text', '--sv-accent'],
    ['--sv-accent-text', '--sv-accent-hover'],
    ['--sv-danger', '--sv-bg'],
    ['--sv-danger', '--sv-danger-bg'],
    ['--sv-success', '--sv-bg'],
    ['--sv-success', '--sv-success-bg'],
    ['--sv-info', '--sv-info-bg'],
    ['--sv-warning', '--sv-warning-bg'],
    ['--sv-text', '--sv-danger-bg'],
    ['--sv-text', '--sv-warning-bg'],
    // The toast is drawn in the inverse of the page.
    ['--sv-bg', '--sv-text'],
  ];
  const NON_TEXT: Array<[string, string]> = [
    ['--sv-focus', '--sv-bg'],
    ['--sv-focus', '--sv-surface'],
    ['--sv-focus', '--sv-info-bg'],
    ['--sv-focus', '--sv-danger-bg'],
    ['--sv-border-strong', '--sv-bg'],
    ['--sv-border-strong', '--sv-surface'],
    ['--sv-border-strong', '--sv-info-bg'],
    ['--sv-accent', '--sv-bg'],
    // The focus ring on the (inverse) toast takes the page colour.
    ['--sv-bg', '--sv-text'],
  ];

  for (const mode of ['light', 'dark'] as const) {
    it(`${mode}: text pairs are at least 4.5:1`, () => {
      for (const [fg, bg] of TEXT) {
        expect(ratio(colour(mode, fg), colour(mode, bg)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    });
    it(`${mode}: focus ring, control edges and bars are at least 3:1`, () => {
      for (const [fg, bg] of NON_TEXT) {
        expect(ratio(colour(mode, fg), colour(mode, bg)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(
          3,
        );
      }
    });
  }

  it('the toast ring is the page colour, and only the tinted error toast keeps the blue', () => {
    const neutral = block(components, '.sv-toast :focus-visible');
    expect(neutral).toContain('outline-color: var(--sv-bg)');
    const error = block(components, '.sv-toast--error :focus-visible');
    expect(error).toContain('outline-color: var(--sv-focus)');
  });
});
