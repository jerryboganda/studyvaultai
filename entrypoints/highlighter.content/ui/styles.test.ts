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
// The hover tint of every transparent button, and the quote and chip fill.
const HOVER = '--sv-primary-soft';
const SUNK = '--sv-sunk';

/** Text (>= 4.5:1): which token is painted as text on which surfaces. */
const TEXT: Array<[fg: string, on: string[]]> = [
  // Body text, the quote and the bank chip (on the sunk fill), any button on its hover tint.
  ['--sv-text', [...SURFACES, SUNK, HOVER]],
  // Labels, hints, status and icon buttons.
  ['--sv-text-muted', [...SURFACES, HOVER]],
  // Text buttons and links, also on their hover tint.
  ['--sv-accent', [...SURFACES, HOVER]],
  // The filled (3D) buttons: Save and Delete.
  ['--sv-on-primary', ['--sv-primary', '--sv-danger-fill']],
  ['--sv-danger', SURFACES],
  // Toast tick; the toast sits on the raised surface.
  ['--sv-success', SURFACES],
  // The caption row is an ink tooltip (UX_DESIGN 6.3).
  ['--sv-surface-raised', ['--sv-ink']],
  // "+2 XP" on its sunshine chip.
  ['--sv-on-sun', ['--sv-sun']],
];

/** Non-text (>= 3:1): control edges, state bars, focus indicator, swatch edge. */
const UI: Array<[fg: string, on: string[]]> = [
  // Field and swatch edges.
  ['--sv-border-strong', SURFACES],
  // Invalid field edge, danger button edge, error toast bar.
  ['--sv-danger', [BG, RAISED]],
  ['--sv-success', [RAISED]],
  // Quote bar (on the sunk fill) and toast bar.
  ['--sv-accent', [SUNK, RAISED]],
  // The ring sits on the surface or, at the edge of a surface, on the page: against the halo it
  // always has 3:1, which is what keeps it visible on any page.
  ['--sv-focus', [...SURFACES, '--sv-focus-halo']],
  // The halo touches the control: the filled buttons are the ones with a fill of their own.
  ['--sv-focus-halo', ['--sv-primary', '--sv-danger-fill']],
  // Toast tone icons on their tinted discs (the shape tells the tone; the tint repeats it).
  ['--sv-success', ['--sv-success-bg']],
  ['--sv-danger', ['--sv-danger-bg']],
  ['--sv-info', ['--sv-info-bg']],
  // The ring of a kind dot and of the checked dot.
  ['--sv-text-muted', [RAISED]],
  ['--sv-text', [RAISED]],
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
    // Aliases (--sv-text: var(--sv-ink)) count: a token is a colour if it resolves to one.
    const isColor = (name: string): boolean => {
      try {
        colorOf(light, name);
        return true;
      } catch {
        return false;
      }
    };
    const audited = new Set([...TEXT, ...UI].flatMap(([fg, on]) => [fg, ...on]));
    // --sv-border is only the outline around floating surfaces (the shadow and the surface
    // difference separate them); fields use --sv-border-strong. The 3D edges under the filled
    // buttons are decoration (UX_DESIGN 2.7): the label and the fill identify the button.
    const exempt = new Set(['--sv-border', '--sv-shadow', '--sv-primary-edge', '--sv-danger-edge']);
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

  it('the kind glyph sits on the audited surface; the palette colour is only its rim', () => {
    // The glyph is the non-colour cue of a kind dot (1.4.1); e2e audits every overlay text at 4.5:1
    // (--sv-text on --sv-surface-raised is in TEXT above). A tint of the palette colour would not
    // reach it for every colour in both themes.
    const dot = declsFor(styles, '.sv-swatch');
    expect(dot.get('color')).toBe('var(--sv-text)');
    expect(dot.get('background')).toBe('var(--sv-surface-raised)');
    expect(dot.get('border')).toBe('5px solid var(--dot)');
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

  // The surfaces that take focus themselves (programmatically) so Tab and Escape work from them.
  const DIALOGS = ['.sv-popover', '.sv-panel'];

  it('is not gated by :focus-visible anywhere except the programmatically focused dialogs', () => {
    const gated = styles.filter((r) =>
      r.selectors.some(
        (s) => s.includes(':focus-visible') && !DIALOGS.some((d) => s.startsWith(d)),
      ),
    );
    expect(gated.map((r) => r.selectors)).toEqual([]);
  });

  it('never removes an outline except on a dialog container, which has an inset ring instead', () => {
    const removed = styles.filter((r) => {
      const o = r.decls.get('outline');
      return o !== undefined && /^(none|0)$/.test(o);
    });
    expect(removed.flatMap((r) => r.selectors)).toEqual(DIALOGS.map((d) => `${d}:focus`));
    for (const d of DIALOGS) {
      const inset = declsFor(styles, `${d}:focus-visible`);
      expect(inset.get('outline'), d).toBe('2px solid var(--sv-focus)');
      expect(px(inset.get('outline-offset')), d).toBeLessThan(0);
    }
  });

  it('keeps the elevation of a dialog while it is focused', () => {
    for (const d of DIALOGS) {
      const own = declsFor(styles, d).get('box-shadow');
      expect(own, d).toBe('var(--sv-raise)');
      for (const sel of [`${d}:focus`, `${d}:focus-visible`]) {
        expect(declsFor(styles, sel).get('box-shadow'), sel).toBe(own);
      }
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

  it('scrolls rather than squashing a child: the clipped quote kept collapsing to half a line', () => {
    for (const sel of ['.sv-panel > *', '.sv-popover > *']) {
      expect(declsFor(styles, sel).get('flex-shrink'), sel).toBe('0');
    }
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
    const panel = declsFor(styles, '.sv-panel', short);
    expect(panel.get('padding')).toBeDefined();
  });

  it('puts More options in two columns on a short but wide viewport', () => {
    const wide = '(max-height: 520px) and (min-width: 480px)';
    const grid = declsFor(styles, '.sv-panel', wide);
    expect(grid.get('display')).toBe('grid');
    expect(grid.get('grid-template-areas')).toBe("'quote quote' 'bank kind' 'actions actions'");
    // A fixed width, but never wider than the unit (max-width: 100%), which is capped to the viewport.
    expect(grid.get('width')).toBe('560px');
    expect(grid.get('max-width')).toBeUndefined();
    expect(declsFor(styles, '.sv-panel').get('max-width')).toBe('100%');
  });

  it('constrains toasts to the viewport width and wraps long messages', () => {
    expect(declsFor(styles, '.sv-toasts').get('max-width')).toBe('calc(100vw - 32px)');
    expect(declsFor(styles, '.sv-toast').get('max-width')).toBe('100%');
    expect(declsFor(styles, '.sv-toast-text').get('overflow-wrap')).toBe('anywhere');
    // The buttons wrap as one right-aligned group, so the dismiss button never strands alone.
    const actions = declsFor(styles, '.sv-toast-actions');
    expect(actions.get('margin-left')).toBe('auto');
    expect(actions.get('flex-wrap')).toBe('wrap');
  });
});

// ---------------------------------------------------------------------------------------------
// Multi-click seam: the toolbar appears next to the word a double click selected, while the third
// click of a triple click is still on its way. It must not take that click.
// ---------------------------------------------------------------------------------------------

describe('toolbar is click-through while it animates in', () => {
  const css = stripComments(readCss(STYLES_CSS));
  const unit = declsFor(styles, '.sv-unit');

  it('holds pointer-events: none for exactly the duration of the enter animation', () => {
    const names = (unit.get('animation') ?? '').split(',').map((a) => a.trim());
    const enter = names.find((a) => a.startsWith('sv-in '));
    const arm = names.find((a) => a.startsWith('sv-arm '));
    expect(enter, 'enter animation').toBeDefined();
    expect(arm, 'click-through animation').toBeDefined();
    // Same duration token: the toolbar is interactive the moment it has finished appearing.
    const duration = (a: string | undefined): string => a?.split(' ')[1] ?? '';
    expect(duration(arm)).toBe('var(--sv-motion)');
    expect(duration(arm)).toBe(duration(enter));
  });

  it('the keyframes disable pointer events at both ends and nothing else', () => {
    const block = /@keyframes sv-arm\s*\{([\s\S]*?\})\s*\}/.exec(css);
    expect(block, '@keyframes sv-arm').not.toBeNull();
    expect(block?.[1]?.replace(/\s+/g, ' ').trim()).toBe('from, to { pointer-events: none; }');
  });

  it('is interactive afterwards: the unit itself never sets pointer-events', () => {
    expect(unit.has('pointer-events')).toBe(false);
    for (const rule of styles.filter((r) =>
      r.selectors.some((s) => /(^|\s)\.sv-(unit|toolbar|panel)\b/.test(s)),
    )) {
      expect(rule.decls.get('pointer-events'), rule.selectors.join(', ')).toBeUndefined();
    }
  });

  it('is interactive at once with reduced motion: every animation is off', () => {
    const off = declsFor(styles, '.sv-root *', '(prefers-reduced-motion: reduce)');
    expect(off.get('animation')).toBe('none !important');
    // And the duration token is zero there, for the animations that read it.
    const tokens = computeTokens(tokenRules, { system: 'light', attr: 'light', contrast: false });
    expect(tokens.get('--sv-motion')).toBe('140ms');
    const reduced = tokenRules.filter(
      (r) => r.media === '(prefers-reduced-motion: reduce)' && r.decls.has('--sv-motion'),
    );
    expect(reduced.map((r) => r.decls.get('--sv-motion'))).toEqual(['0ms']);
  });

  it('only the toolbar unit goes click-through, not the popover or the toasts', () => {
    expect(declsFor(styles, '.sv-popover').get('animation')).toBeUndefined();
    expect(declsFor(styles, '.sv-float').get('animation')).toBe('sv-in var(--sv-motion) ease-out');
  });
});

// ---------------------------------------------------------------------------------------------
// Privacy: the shadow host is visible to page scripts, so no style may depend on an attribute of it
// ---------------------------------------------------------------------------------------------

describe('theme and density are applied inside the shadow root', () => {
  it('no stylesheet selects on an attribute of the host element', () => {
    for (const [name, css] of [
      ['styles.css', readCss(STYLES_CSS)],
      ['tokens.css', tokensCss],
    ] as const) {
      expect(stripComments(css), name).not.toMatch(/:host\([^)]*\[/);
      expect(stripComments(css), name).not.toMatch(/:host\[/);
    }
  });

  it('the theme attribute is read from .sv-root, and its colour scheme follows it', () => {
    expect(declsFor(styles, ".sv-root[data-theme='light']").get('color-scheme')).toBe('light');
    expect(declsFor(styles, ".sv-root[data-theme='dark']").get('color-scheme')).toBe('dark');
    const darkTokens = declsFor(tokenRules, "[data-theme='dark']");
    expect(darkTokens.get('--sv-surface-raised')).toBeDefined();
    const system = declsFor(
      tokenRules,
      ".sv-root:not([data-theme='light'])",
      '(prefers-color-scheme: dark)',
    );
    expect(system.get('--sv-surface-raised')).toBe(darkTokens.get('--sv-surface-raised'));
  });
});

// ---------------------------------------------------------------------------------------------
// The caption row names the hovered or focused button; it must never move or resize the unit
// ---------------------------------------------------------------------------------------------

describe('caption row', () => {
  const caption = declsFor(styles, '.sv-caption');

  it('is always laid out and one line, so it cannot change the unit height', () => {
    expect(caption.get('flex')).toBe('none');
    expect(caption.get('white-space')).toBe('nowrap');
    expect(caption.get('max-width')).toBe('100%');
    expect(caption.get('overflow')).toBe('hidden');
    expect(declsFor(styles, '.sv-caption[data-empty]').get('visibility')).toBe('hidden');
    expect(caption.has('display')).toBe(false);
    expect(caption.has('position')).toBe(false);
  });

  it('is an ink tooltip (audited pair) and sits on the side away from the selection', () => {
    const surface = styles.find(
      (r) => r.media === '' && r.selectors.includes('.sv-caption') && r.decls.has('background'),
    );
    expect(surface?.decls.get('background')).toBe('var(--sv-ink)');
    expect(surface?.decls.get('color')).toBe('var(--sv-surface-raised)');
    expect(
      declsFor(styles, ".sv-unit[data-placement='above'] > .sv-bar-group").get('flex-direction'),
    ).toBe('column-reverse');
    expect(declsFor(styles, '.sv-bar-group').get('flex')).toBe('none');
  });

  it('keeps its border in forced colours', () => {
    const forced = styles.find(
      (r) => r.media === '(forced-colors: active)' && r.selectors.includes('.sv-caption'),
    );
    expect(forced?.decls.get('border')).toBe('1px solid CanvasText');
  });
});

describe('forced colours', () => {
  it("paints the quote's transparent spacing border in the canvas colour, not as black bars", () => {
    expect(declsFor(styles, '.sv-quote').get('border-block')).toBe('8px solid transparent');
    expect(declsFor(styles, '.sv-quote', '(forced-colors: active)').get('border-block-color')).toBe(
      'Canvas',
    );
  });
});
