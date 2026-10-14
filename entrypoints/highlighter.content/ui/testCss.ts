/**
 * Test-only: a deliberately small CSS reader for styles.css and tokens.css (flat rules plus
 * @media), and WCAG 2.x contrast maths. Never imported by production code.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface Rule {
  /** Enclosing media conditions, joined with " and "; '' at top level. */
  media: string;
  selectors: string[];
  decls: Map<string, string>;
  /** Source order. */
  order: number;
}

export const UI_DIR = __dirname;
export const STYLES_CSS = path.join(UI_DIR, 'styles.css');
export const TOKENS_CSS = path.resolve(UI_DIR, '../../../packages/ui/src/tokens.css');

export function readCss(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

export function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function parseDecls(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of body.split(';')) {
    const i = part.indexOf(':');
    if (i === -1) continue;
    const prop = part.slice(0, i).trim();
    if (prop)
      out.set(
        prop,
        part
          .slice(i + 1)
          .trim()
          .replace(/\s+/g, ' '),
      );
  }
  return out;
}

/** A selector list split at its top-level commas (not the ones inside :is() or :not()). */
function splitSelectors(head: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < head.length; i += 1) {
    if (head[i] === '(') depth += 1;
    else if (head[i] === ')') depth -= 1;
    else if (head[i] === ',' && depth === 0) {
      out.push(head.slice(start, i));
      start = i + 1;
    }
  }
  out.push(head.slice(start));
  return out.map((s) => s.trim().replace(/\s+/g, ' '));
}

export function parseCss(css: string): Rule[] {
  const text = stripComments(css).replace(/@import[^;]+;/g, '');
  const rules: Rule[] = [];
  const walk = (src: string, media: string): void => {
    let i = 0;
    while (i < src.length) {
      const open = src.indexOf('{', i);
      if (open === -1) break;
      const head = src.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      while (j < src.length && depth > 0) {
        if (src[j] === '{') depth += 1;
        else if (src[j] === '}') depth -= 1;
        j += 1;
      }
      const body = src.slice(open + 1, j - 1);
      if (head.startsWith('@media')) {
        walk(body, [media, head.slice(6).trim()].filter(Boolean).join(' and '));
      } else if (!head.startsWith('@')) {
        rules.push({
          media,
          selectors: splitSelectors(head),
          decls: parseDecls(body),
          order: rules.length,
        });
      }
      i = j;
    }
  };
  walk(text, '');
  return rules;
}

/** Declarations of every rule that has `selector` among its selectors (and the given media). */
export function declsFor(rules: Rule[], selector: string, media = ''): Map<string, string> {
  const merged = new Map<string, string>();
  for (const r of rules) {
    if (r.media === media && r.selectors.includes(selector)) {
      for (const [k, v] of r.decls) merged.set(k, v);
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------------------------
// Token cascade
// ---------------------------------------------------------------------------------------------

export interface Scenario {
  /** The operating-system colour scheme (prefers-color-scheme). */
  system: 'light' | 'dark';
  /** data-theme on .sv-root (inside the shadow root): the user's own Theme setting. */
  attr: 'system' | 'light' | 'dark';
  /** prefers-contrast: more. */
  contrast: boolean;
}

export const SCENARIOS: Scenario[] = (['light', 'dark'] as const).flatMap((system) =>
  (['system', 'light', 'dark'] as const).flatMap((attr) =>
    [false, true].map((contrast): Scenario => ({ system, attr, contrast })),
  ),
);

export const describeScenario = (s: Scenario): string =>
  `system ${s.system}, theme ${s.attr}${s.contrast ? ', more contrast' : ''}`;

function mediaApplies(media: string, s: Scenario): boolean {
  if (!media) return true;
  return media.split(' and ').every((q) => {
    switch (q) {
      case '(prefers-color-scheme: dark)':
        return s.system === 'dark';
      case '(prefers-contrast: more)':
        return s.contrast;
      case '(prefers-reduced-motion: reduce)':
        return false;
      default:
        throw new Error(`tokens.css media query not modelled by the contrast test: ${q}`);
    }
  });
}

/**
 * Only the selector forms tokens.css uses; anything else must be modelled before it ships. The
 * overlay's .sv-root always carries data-theme (system, light or dark) and never data-contrast;
 * density only changes spacing, so the model is the comfortable default.
 */
function selectorMatch(selector: string, s: Scenario): { applies: boolean; specificity: number } {
  switch (selector) {
    case ':root':
    case ':host':
    case '.sv-root':
    case '[data-theme]':
      return { applies: true, specificity: 1 };
    case "[data-theme='light']":
      return { applies: s.attr === 'light', specificity: 1 };
    case "[data-theme='dark']":
      return { applies: s.attr === 'dark', specificity: 1 };
    case ":root:not([data-theme='light'])":
    case ".sv-root:not([data-theme='light'])":
      return { applies: s.attr !== 'light', specificity: 2 };
    case '[data-contrast]':
    case "[data-contrast='more']":
    case "[data-contrast='high']":
      return { applies: false, specificity: 1 };
    case ":root:is([data-contrast='more'], [data-contrast='high'])":
    case ".sv-root:is([data-contrast='more'], [data-contrast='high'])":
      return { applies: false, specificity: 2 };
    case "[data-density='compact']":
      return { applies: false, specificity: 1 };
    default:
      throw new Error(`tokens.css selector not modelled by the contrast test: ${selector}`);
  }
}

/**
 * Custom properties as the cascade resolves them for the overlay in the given scenario: the host
 * (:host) and its .sv-root container are one element here, because .sv-root inherits from the host
 * and every .sv-root rule is at least as specific as the :host one it overrides.
 */
export function computeTokens(rules: Rule[], s: Scenario): Map<string, string> {
  const winner = new Map<string, { value: string; specificity: number; order: number }>();
  for (const rule of rules) {
    if (!mediaApplies(rule.media, s)) continue;
    for (const selector of rule.selectors) {
      const m = selectorMatch(selector, s);
      if (!m.applies) continue;
      for (const [prop, value] of rule.decls) {
        if (!prop.startsWith('--')) continue;
        const prev = winner.get(prop);
        if (
          !prev ||
          m.specificity > prev.specificity ||
          (m.specificity === prev.specificity && rule.order > prev.order)
        ) {
          winner.set(prop, { value, specificity: m.specificity, order: rule.order });
        }
      }
    }
  }
  return new Map([...winner].map(([k, v]) => [k, v.value]));
}

/** A token's colour as `#rrggbb`, following var() and currentColor (which is the text colour). */
export function colorOf(tokens: Map<string, string>, name: string, depth = 0): string {
  if (depth > 5) throw new Error(`token cycle at ${name}`);
  const raw = tokens.get(name);
  if (raw === undefined) throw new Error(`token ${name} is not defined`);
  const ref = /^var\((--[\w-]+)\)$/.exec(raw);
  if (ref) return colorOf(tokens, ref[1]!, depth + 1);
  if (/^currentcolor$/i.test(raw)) return colorOf(tokens, '--sv-text', depth + 1);
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw);
  if (!hex) throw new Error(`token ${name} is not a plain hex colour: ${raw}`);
  const h = hex[1]!;
  return `#${h.length === 3 ? [...h].map((c) => c + c).join('') : h}`.toLowerCase();
}

// ---------------------------------------------------------------------------------------------
// WCAG 2.x contrast
// ---------------------------------------------------------------------------------------------

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const lin = (v: number): number => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}
