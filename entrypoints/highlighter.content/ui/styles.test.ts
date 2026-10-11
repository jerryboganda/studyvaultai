import { describe, expect, it } from 'vitest';
import {
  SCENARIOS,
  STYLES_CSS,
  TOKENS_CSS,
  colorOf,
  computeTokens,
  contrast,
  declsFor,
  describeScenario,
  parseCss,
  readCss,
  stripComments,
} from './testCss';

const styles = parseCss(readCss(STYLES_CSS));
const tokensCss = readCss(TOKENS_CSS);
const tokenRules = parseCss(tokensCss);

const px = (value: string | undefined): number => {
  const m = /^(-?\d+(?:\.\d+)?)px$/.exec(value ?? '');
  if (!m) throw new Error(`not a px length: ${value}`);
  return Number(m[1]);
};

// ---------------------------------------------------------------------------------------------
// Contrast: every colour pair the overlay can paint, in every theme (WCAG 1.4.3, 1.4.11)
// ---------------------------------------------------------------------------------------------

const BG = '--sv-bg';
const SURFACE = '--sv-surface';
const RAISED = '--sv-surface-raised';
const SURFACES = [BG, SURFACE, RAISED];

/** Text (>= 4.5:1): which token is painted as text on which surfaces. */
const TEXT: Array<[fg: string, on: string[]]> = [
  ['--sv-text', SURFACES],
  // Quote, labels, status, icon buttons, and the textarea placeholder (on --sv-bg).
  ['--sv-text-muted', SURFACES],
  // Text buttons and links, also on their hover fill (--sv-surface).
  ['--sv-accent', SURFACES],
  ['--sv-accent-text', ['--sv-accent', '--sv-accent-hover']],
  ['--sv-danger', SURFACES],
  // Toast tick; the toast sits on the raised surface.
  ['--sv-success', SURFACES],
];

/** Non-text (>= 3:1): control edges, state bars, focus indicator, swatch edge. */
const UI: Array<[fg: string, on: string[]]> = [
  // Field and swatch edges.
  ['--sv-border-strong', SURFACES],
  // Invalid field edge, danger button edge, error toast bar.
  ['--sv-danger', [BG, RAISED]],
  ['--sv-success', [RAISED]],
  // Quote bar (on --sv-surface) and toast bar.
  ['--sv-accent', [SURFACE, RAISED]],
  // The ring sits on the surface or, at the edge of a surface, on the page: against the halo it
  // always has 3:1, which is what keeps it visible on any page.
  ['--sv-focus', [...SURFACES, '--sv-focus-halo']],
  // The halo touches the control: the primary button is the one with a fill of its own.
  ['--sv-focus-halo', ['--sv-accent', '--sv-accent-hover']],
];

describe('overlay colours reach WCAG AA in every theme', () => {
  for (const scenario of SCENARIOS) {
    describe(describeScenario(scenario), () => {
      const tokens = computeTokens(tokenRules, scenario);
      const ratio = (fg: string, bg: string): number =>
        contrast(colorOf(tokens, fg), colorOf(tokens, bg));

      it('text is at least 4.5:1 on every surface it is painted on', () => {
        const failures: string[] = [];
        for (const [fg, on] of TEXT) {
          for (const bg of on) {
            const r = ratio(fg, bg);
            if (r < 4.5) failures.push(`${fg} on ${bg} = ${r.toFixed(2)}:1`);
          }
        }
        expect(failures).toEqual([]);
      });

      it('control edges, state bars and the focus indicator are at least 3:1', () => {
        const failures: string[] = [];
        for (const [fg, on] of UI) {
          for (const bg of on) {
            const r = ratio(fg, bg);
            if (r < 3) failures.push(`${fg} on ${bg} = ${r.toFixed(2)}:1`);
          }
        }
        expect(failures).toEqual([]);
      });
    });
  }

  it('measures what Chromium measured: the UA placeholder #757575 on the dark field is 4.04:1', () => {
    // The CI failure (compat.spec.ts, matrix 7): rgb(117,117,117) on rgb(16,19,24).
    expect(contrast('#757575', '#101318')).toBeCloseTo(4.04, 2);
  });

  it('the placeholder uses the muted text colour at full opacity', () => {
    const decls = declsFor(styles, '.sv-control::placeholder');
    expect(decls.get('color')).toBe('var(--sv-text-muted)');
    expect(decls.get('opacity')).toBe('1');
  });

  it('more contrast really applies in dark mode (equal specificity to the dark blocks)', () => {
    for (const attr of ['system', 'dark'] as const) {
      const tokens = computeTokens(tokenRules, { system: 'dark', attr, contrast: true });
      expect(colorOf(tokens, '--sv-text-muted'), `theme ${attr}`).toBe(
        colorOf(tokens, '--sv-text'),
      );
      expect(colorOf(tokens, '--sv-border'), `theme ${attr}`).toBe(colorOf(tokens, '--sv-text'));
    }
  });

  it('the two dark blocks (system and explicit) define the same values', () => {
    const system = computeTokens(tokenRules, { system: 'dark', attr: 'system', contrast: false });
    const explicit = computeTokens(tokenRules, { system: 'light', attr: 'dark', contrast: false });
    expect([...explicit].sort()).toEqual([...system].sort());
  });

  it('every colour token styles.css paints with is part of this audit', () => {
    const light = computeTokens(tokenRules, { system: 'light', attr: 'light', contrast: false });
    const isColor = (name: string): boolean => /^(#|currentcolor)/i.test(light.get(name) ?? '');
    const audited = new Set([...TEXT, ...UI].flatMap(([fg, on]) => [fg, ...on]));
    // --sv-border is only the hairline around floating surfaces (the shadow and the surface
    // difference separate them); fields use --sv-border-strong. The highlight palette is user data.
    const exempt = new Set(['--sv-border', '--sv-shadow']);
    const used = new Set<string>();
    for (const rule of styles) {
      for (const value of rule.decls.values()) {
        for (const m of value.matchAll(/var\((--sv-[\w-]+)\)/g)) {
          if (isColor(m[1]!)) used.add(m[1]!);
        }
      }
    }
    expect(used.size).toBeGreaterThan(8);
    const unaudited = [...used].filter((t) => !audited.has(t) && !exempt.has(t));
    expect(unaudited, 'add the new colour token to TEXT or UI above').toEqual([]);
  });

  it('styles.css has no raw colour values that would bypass the audit', () => {
    const code = stripComments(readCss(STYLES_CSS));
    expect(code).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(code).not.toMatch(/\b(?:rgb|rgba|hsl|hsla)\(/i);
  });
});

// ---------------------------------------------------------------------------------------------
// Focus indicator (WCAG 2.4.7)
// ---------------------------------------------------------------------------------------------

describe('focus indicator', () => {
  const ring = declsFor(styles, '.sv-root :focus');

  it('is an always-on, offset outline of at least 2px, not a :focus-visible heuristic', () => {
    expect(ring.get('outline')).toMatch(/^(\d+)px solid var\(--sv-focus\)$/);
    expect(px(ring.get('outline')?.split(' ')[0])).toBeGreaterThanOrEqual(2);
    expect(px(ring.get('outline-offset'))).toBeGreaterThanOrEqual(1);
    // The halo is painted in the offset gap and is the only job of box-shadow here.
    expect(ring.get('box-shadow')).toBe('0 0 0 2px var(--sv-focus-halo)');
  });

  it('is not gated by :focus-visible anywhere except the programmatically focused dialog', () => {
    const gated = styles.filter((r) =>
      r.selectors.some((s) => s.includes(':focus-visible') && !s.startsWith('.sv-popover')),
    );
    expect(gated.map((r) => r.selectors)).toEqual([]);
  });

  it('never removes an outline except on the dialog container, which has an inset ring instead', () => {
    const removed = styles.filter((r) => {
      const o = r.decls.get('outline');
      return o !== undefined && /^(none|0)$/.test(o);
    });
    expect(removed.flatMap((r) => r.selectors)).toEqual(['.sv-popover:focus']);
    const inset = declsFor(styles, '.sv-popover:focus-visible');
    expect(inset.get('outline')).toBe('2px solid var(--sv-focus)');
    expect(px(inset.get('outline-offset'))).toBeLessThan(0);
  });

  it('keeps the popover drop shadow while it is focused', () => {
    for (const sel of ['.sv-popover:focus', '.sv-popover:focus-visible']) {
      expect(declsFor(styles, sel).get('box-shadow'), sel).toBe('var(--sv-shadow)');
    }
  });

  it('has a forced-colors fallback that keeps the outline and uses a system colour', () => {
    const forced = declsFor(styles, '.sv-root :focus', '(forced-colors: active)');
    expect(forced.get('outline-color')).toBe('Highlight');
    expect(forced.get('box-shadow')).toBe('none');
    // Not outline: none / transparent anywhere in forced colors.
    expect(forced.get('outline')).toBeUndefined();
  });

  it('leaves room for the ring: the padding of what holds a button covers offset + width', () => {
    const reach = px(ring.get('outline-offset')) + 2;
    const tokens = computeTokens(tokenRules, { system: 'light', attr: 'light', contrast: false });
    // Toolbar: padding is var(--sv-space-1). Toast: 6px. Panel and popover: 8px or more.
    expect(declsFor(styles, '.sv-toolbar').get('padding')).toBe('var(--sv-space-1)');
    expect(px(tokens.get('--sv-space-1'))).toBeGreaterThanOrEqual(reach);
    expect(declsFor(styles, '.sv-toast').get('padding')).toMatch(/^6px 6px 6px /);
    expect(6).toBeGreaterThanOrEqual(reach);
    expect(px(tokens.get('--sv-space-2'))).toBeGreaterThanOrEqual(reach);
  });
});

// ---------------------------------------------------------------------------------------------
// Reflow (WCAG 1.4.10): nothing the overlay shows can be taller or wider than the viewport
// ---------------------------------------------------------------------------------------------

describe('reflow', () => {
  it('limits the toolbar unit to the viewport and keeps the toolbar from shrinking', () => {
    const unit = declsFor(styles, '.sv-unit');
    expect(unit.get('max-height')).toBe('calc(100vh - 16px)');
    expect(unit.get('max-width')).toBe('calc(100vw - 16px)');
    expect(declsFor(styles, '.sv-toolbar').get('flex')).toBe('none');
  });

  it('lets a panel or popover scroll inside itself instead of leaving the screen', () => {
    for (const sel of ['.sv-panel', '.sv-popover']) {
      const rule = styles.find(
        (r) => r.media === '' && r.selectors.includes(sel) && r.decls.has('overflow'),
      );
      expect(rule?.decls.get('overflow'), sel).toBe('hidden auto');
      expect(rule?.decls.get('min-height'), sel).toBe('0');
    }
    expect(declsFor(styles, '.sv-popover').get('max-height')).toBe('calc(100vh - 16px)');
    expect(declsFor(styles, '.sv-panel').get('max-width')).toBe('100%');
  });

  it('keeps the action row pinned to the bottom of the scrolling surface', () => {
    const actions = declsFor(styles, '.sv-actions');
    expect(actions.get('position')).toBe('sticky');
    expect(actions.get('bottom')).toBe('0');
    // Opaque: scrolled content must not show through behind the buttons.
    expect(actions.get('background')).toBe('var(--sv-surface-raised)');
  });

  it('tightens up on short viewports before it resorts to scrolling', () => {
    const short = '(max-height: 520px)';
    expect(declsFor(styles, '.sv-quote', short).get('-webkit-line-clamp')).toBe('2');
    expect(declsFor(styles, '.sv-textarea', short).get('height')).toBe('48px');
    const panel = declsFor(styles, '.sv-panel', short);
    expect(panel.get('padding')).toBeDefined();
  });

  it('puts More options in two columns on a short but wide viewport', () => {
    const wide = '(max-height: 520px) and (min-width: 480px)';
    const grid = declsFor(styles, ".sv-panel[data-mode='advanced']", wide);
    expect(grid.get('display')).toBe('grid');
    expect(grid.get('grid-template-areas')).toBe(
      "'quote quote' 'bank note' 'kind note' 'actions actions'",
    );
    // A fixed width, but never wider than the unit (max-width: 100%), which is capped to the viewport.
    expect(grid.get('width')).toBe('560px');
    expect(grid.get('max-width')).toBeUndefined();
    expect(declsFor(styles, '.sv-panel').get('max-width')).toBe('100%');
  });

  it('constrains toasts to the viewport width and wraps long messages', () => {
    expect(declsFor(styles, '.sv-toasts').get('max-width')).toBe('calc(100vw - 32px)');
    expect(declsFor(styles, '.sv-toast').get('max-width')).toBe('100%');
    expect(declsFor(styles, '.sv-toast-text').get('overflow-wrap')).toBe('anywhere');
  });
});
