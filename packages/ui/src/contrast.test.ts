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
