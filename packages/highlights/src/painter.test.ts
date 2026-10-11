import { COLOR_IDS, COLOR_SWATCH, HIGHLIGHT_KINDS } from '@shared/constants';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HighlightPainter, KIND_DECORATION } from './painter';
import { rangeOver, setBody } from './testUtils';
import type { PaintEntry } from './types';

class FakeHighlight {
  ranges: Range[];
  priority = 0;
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}

class FakeSheet {
  css = '';
  replaceSync(css: string): void {
    this.css = css;
  }
}

// The test pokes DOM members that jsdom lacks (or that TS types as required), hence the loose view.
const loose = (): Record<string, unknown> => document as unknown as Record<string, unknown>;

let registry: Map<string, unknown>;

function newPainter(): HighlightPainter {
  return new HighlightPainter(document, {
    registry,
    highlightCtor: FakeHighlight,
    styleSheetCtor: FakeSheet,
  });
}

function sheets(): FakeSheet[] {
  return (loose().adoptedStyleSheets ?? []) as FakeSheet[];
}

function entry(
  id: string,
  color: PaintEntry['color'],
  needle: string,
  occurrence = 0,
  kind?: PaintEntry['kind'],
): PaintEntry {
  return { id, color, range: rangeOver(needle, occurrence), ...(kind ? { kind } : {}) };
}

/** Declarations of the first rule whose selector list names `name` (the base block comes first). */
function bodyOf(css: string, name: string): string {
  for (const line of css.split('\n')) {
    const m = /^(::highlight\([^)]+\)(?:,::highlight\([^)]+\))*)\{(.*)\}$/.exec(line);
    if (m && m[1]!.split(',').includes(`::highlight(${name})`)) return m[2]!;
  }
  throw new Error(`no rule for ${name}`);
}

/** The lines inside `@media <query>{ ... }`, or null when that block is absent. */
function mediaBlock(css: string, query: string): string | null {
  const lines = css.split('\n');
  const start = lines.indexOf(`@media ${query}{`);
  if (start < 0) return null;
  return lines.slice(start + 1, lines.indexOf('}', start)).join('\n');
}

const prop = (body: string, name: string): string => {
  const m = new RegExp(`(?:^|;)${name}:([^;]*);`).exec(body);
  if (!m) throw new Error(`no ${name} in ${body}`);
  return m[1]!;
};

/** Painter with `setStyle(mode)` applied (when given); returns the adopted stylesheet's CSS. */
function cssFor(mode?: 'auto' | 'normal' | 'strong'): string {
  const painter = newPainter();
  if (mode) painter.setStyle(mode);
  return sheets()[sheets().length - 1]!.css; // each call adopts its own sheet
}

// WCAG 2.x relative luminance / contrast, used to check what actually ships.
type Rgb = [number, number, number];
const hexRgb = (h: string): Rgb => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
const channel = (c: number): number => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: Rgb): number =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const ratio = (a: Rgb, b: Rgb): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};
const blend = (fg: Rgb, alpha: number, bg: Rgb): Rgb =>
  fg.map((c, i) => c * alpha + bg[i]! * (1 - alpha)) as Rgb;
const parseRgba = (v: string): { rgb: Rgb; alpha: number } => {
  const m = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(v);
  if (!m) throw new Error(`not rgba: ${v}`);
  return { rgb: [Number(m[1]), Number(m[2]), Number(m[3])], alpha: Number(m[4]) };
};

beforeEach(() => {
  registry = new Map();
  Object.defineProperty(document, 'adoptedStyleSheets', {
    value: [],
    writable: true,
    configurable: true,
  });
  setBody('<p id="p">Alpha beta gamma delta epsilon</p><p id="q">Second paragraph here</p>');
});

afterEach(() => {
  delete loose().adoptedStyleSheets;
  delete loose().caretPositionFromPoint;
  delete loose().caretRangeFromPoint;
});

describe('support detection', () => {
  it('is unsupported in jsdom (no CSS.highlights) and every method is a safe no-op', () => {
    expect(HighlightPainter.isSupported(window)).toBe(false);
    const painter = new HighlightPainter(document);
    expect(painter.supported).toBe(false);
    expect(() => {
      painter.paint([entry('a', 'amber', 'beta')]);
      painter.setActive('a');
      painter.clear();
      painter.destroy();
    }).not.toThrow();
    expect(painter.hitTest(1, 1)).toBeNull();
    expect(sheets()).toHaveLength(0);
  });

  it('isSupported needs Highlight, CSS.highlights, constructable sheets and adoptedStyleSheets', () => {
    const win = {
      Highlight: FakeHighlight,
      CSS: { highlights: new Map() },
      CSSStyleSheet: FakeSheet,
      document: { adoptedStyleSheets: [] },
    };
    expect(HighlightPainter.isSupported(win as unknown as Window)).toBe(true);
    expect(
      HighlightPainter.isSupported({ ...win, Highlight: undefined } as unknown as Window),
    ).toBe(false);
    expect(HighlightPainter.isSupported({ ...win, CSS: {} } as unknown as Window)).toBe(false);
    expect(HighlightPainter.isSupported({ ...win, document: {} } as unknown as Window)).toBe(false);
  });

  it('is unsupported (not throwing) when the stylesheet cannot be constructed', () => {
    const painter = new HighlightPainter(document, {
      registry,
      highlightCtor: FakeHighlight,
      styleSheetCtor: class {
        constructor() {
          throw new Error('Illegal constructor');
        }
        replaceSync(): void {}
      },
    });
    expect(painter.supported).toBe(false);
  });
});

describe('paint', () => {
  it('registers one Highlight per colour named sv-hl-<color>', () => {
    const painter = newPainter();
    expect(painter.supported).toBe(true);
    painter.paint([
      entry('a', 'amber', 'beta'),
      entry('b', 'blue', 'delta'),
      entry('c', 'amber', 'paragraph'),
    ]);
    expect([...registry.keys()].sort()).toEqual(['sv-hl-amber', 'sv-hl-blue']);
    const amber = registry.get('sv-hl-amber') as FakeHighlight;
    expect(amber.ranges.map((r) => r.toString())).toEqual(['beta', 'paragraph']);
    expect((registry.get('sv-hl-blue') as FakeHighlight).ranges.map(String)).toEqual(['delta']);
  });

  it('is replace-all: colours that disappear are removed', () => {
    const painter = newPainter();
    painter.paint([entry('a', 'amber', 'beta'), entry('b', 'red', 'gamma')]);
    painter.paint([entry('b', 'red', 'gamma')]);
    expect([...registry.keys()]).toEqual(['sv-hl-red']);
    painter.paint([]);
    expect(registry.size).toBe(0);
  });

  it('adopts exactly one stylesheet with a rule per colour and the active style', () => {
    const painter = newPainter();
    painter.paint([entry('a', 'amber', 'beta')]);
    painter.paint([entry('a', 'amber', 'beta')]);
    expect(sheets()).toHaveLength(1);
    const css = sheets()[0]!.css;
    for (const [color, swatch] of Object.entries(COLOR_SWATCH)) {
      expect(css).toContain(`::highlight(sv-hl-${color})`);
      expect(css).toContain(swatch.bg);
    }
    expect(css).toContain('::highlight(sv-hl-active)');
  });

  it('never adds DOM nodes or attributes to the page', () => {
    const before = document.documentElement.outerHTML;
    const painter = newPainter();
    painter.paint([entry('a', 'amber', 'beta')]);
    painter.setActive('a');
    expect(document.documentElement.outerHTML).toBe(before);
  });

  it('ignores collapsed ranges', () => {
    const painter = newPainter();
    const r = rangeOver('beta');
    r.collapse(true);
    painter.paint([{ id: 'x', color: 'green', range: r }]);
    expect(registry.size).toBe(0);
  });

  it('re-adopts its stylesheet if page script replaced adoptedStyleSheets', () => {
    const painter = newPainter();
    loose().adoptedStyleSheets = [];
    painter.paint([entry('a', 'amber', 'beta')]);
    expect(sheets()).toHaveLength(1);
  });

  it('survives a throwing registry without propagating', () => {
    const bad = new Map<string, unknown>();
    bad.set = () => {
      throw new Error('boom');
    };
    const painter = new HighlightPainter(document, {
      registry: bad,
      highlightCtor: FakeHighlight,
      styleSheetCtor: FakeSheet,
    });
    expect(() => painter.paint([entry('a', 'amber', 'beta')])).not.toThrow();
  });
});

describe('setActive', () => {
  it('uses a separate sv-hl-active entry with higher priority', () => {
    const painter = newPainter();
    painter.paint([entry('a', 'amber', 'beta'), entry('b', 'blue', 'delta')]);
    painter.setActive('b');
    const active = registry.get('sv-hl-active') as FakeHighlight;
    expect(active.ranges.map(String)).toEqual(['delta']);
    expect(active.priority).toBeGreaterThan(0);
    // The colour registry entries are untouched.
    expect((registry.get('sv-hl-blue') as FakeHighlight).ranges.map(String)).toEqual(['delta']);
    painter.setActive('a');
    expect((registry.get('sv-hl-active') as FakeHighlight).ranges.map(String)).toEqual(['beta']);
    painter.setActive(null);
    expect(registry.has('sv-hl-active')).toBe(false);
  });

  it('ignores unknown ids and drops the active entry when its highlight is repainted away', () => {
    const painter = newPainter();
    painter.paint([entry('a', 'amber', 'beta')]);
    painter.setActive('missing');
    expect(registry.has('sv-hl-active')).toBe(false);
    painter.setActive('a');
    painter.paint([entry('a', 'amber', 'beta')]);
    expect(registry.has('sv-hl-active')).toBe(true); // persists across repaint
    painter.paint([entry('z', 'amber', 'gamma')]);
    expect(registry.has('sv-hl-active')).toBe(false);
  });

  it('the active style is stronger than every colour fill', () => {
    newPainter();
    const css = sheets()[0]!.css;
    const active = css.split('\n').find((l) => l.includes('sv-hl-active'))!;
    expect(active).toMatch(/background-color:rgba\(255,190,0,0\.92\)/);
    expect(active).toContain('text-decoration-line:underline');
  });
});

describe('clear / destroy', () => {
  it('clear removes every painted entry but keeps the stylesheet', () => {
    const painter = newPainter();
    painter.paint([entry('a', 'amber', 'beta')]);
    painter.setActive('a');
    painter.clear();
    expect(registry.size).toBe(0);
    expect(sheets()).toHaveLength(1);
    painter.paint([entry('a', 'amber', 'beta')]);
    expect(registry.has('sv-hl-amber')).toBe(true);
  });

  it('does not touch registry entries it does not own', () => {
    registry.set('page-own-highlight', { x: 1 });
    const painter = newPainter();
    painter.paint([entry('a', 'amber', 'beta')]);
    painter.clear();
    expect(registry.has('page-own-highlight')).toBe(true);
  });

  it('destroy clears, un-adopts the stylesheet and makes the painter inert', () => {
    loose().adoptedStyleSheets = [{ preexisting: true }];
    const painter = newPainter();
    painter.paint([entry('a', 'amber', 'beta')]);
    painter.destroy();
    expect(registry.size).toBe(0);
    expect(sheets()).toEqual([{ preexisting: true }]);
    expect(painter.supported).toBe(false);
    painter.paint([entry('a', 'amber', 'beta')]);
    expect(registry.size).toBe(0);
    expect(() => painter.destroy()).not.toThrow();
  });
});

describe('hitTest', () => {
  function caretAt(node: Node, offset: number): void {
    loose().caretPositionFromPoint = () => ({ offsetNode: node, offset });
  }

  it('returns the smallest enclosing highlight', () => {
    const painter = newPainter();
    painter.paint([
      entry('outer', 'amber', 'Alpha beta gamma delta epsilon'),
      entry('inner', 'blue', 'beta gamma'),
    ]);
    const text = document.getElementById('p')!.firstChild!;
    caretAt(text, 8); // inside "beta gamma"
    expect(painter.hitTest(10, 10)).toBe('inner');
    caretAt(text, 2); // inside outer only
    expect(painter.hitTest(10, 10)).toBe('outer');
  });

  it('returns null outside every highlight or when there is no caret', () => {
    const painter = newPainter();
    painter.paint([entry('a', 'amber', 'beta')]);
    caretAt(document.getElementById('q')!.firstChild!, 3);
    expect(painter.hitTest(10, 10)).toBeNull();
    loose().caretPositionFromPoint = () => null;
    expect(painter.hitTest(10, 10)).toBeNull();
    delete loose().caretPositionFromPoint;
    expect(painter.hitTest(10, 10)).toBeNull();
  });

  it('falls back to caretRangeFromPoint', () => {
    const painter = newPainter();
    painter.paint([entry('a', 'amber', 'beta')]);
    const text = document.getElementById('p')!.firstChild!;
    loose().caretRangeFromPoint = () => {
      const r = document.createRange();
      r.setStart(text, 7);
      r.collapse(true);
      return r;
    };
    expect(painter.hitTest(5, 5)).toBe('a');
  });

  it('is geometry-checked where the engine provides client rects', () => {
    const painter = newPainter();
    painter.paint([entry('a', 'amber', 'beta')]);
    const stored = (painter as unknown as { entries: Map<string, PaintEntry> }).entries.get('a')!;
    (stored.range as unknown as { getClientRects: () => unknown }).getClientRects = () => [
      { left: 100, right: 140, top: 10, bottom: 30 },
    ];
    caretAt(document.getElementById('p')!.firstChild!, 7);
    expect(painter.hitTest(120, 20)).toBe('a');
    expect(painter.hitTest(400, 20)).toBeNull(); // caret snapped here but the point is far away
  });

  it('is null when nothing is painted', () => {
    expect(newPainter().hitTest(1, 1)).toBeNull();
  });

  it('still returns the smallest enclosing highlight across colour+kind registries', () => {
    const painter = newPainter();
    painter.paint([
      entry('outer', 'amber', 'Alpha beta gamma delta epsilon', 0, 'essential'),
      entry('inner', 'blue', 'beta gamma', 0, 'formula'),
    ]);
    const text = document.getElementById('p')!.firstChild!;
    caretAt(text, 8);
    expect(painter.hitTest(10, 10)).toBe('inner');
    caretAt(text, 2);
    expect(painter.hitTest(10, 10)).toBe('outer');
  });
});

describe('kind cues', () => {
  it('registers one Highlight per colour + kind (sv-hl-<color>-<kind>); no kind keeps sv-hl-<color>', () => {
    const painter = newPainter();
    painter.paint([
      entry('a', 'amber', 'beta', 0, 'essential'),
      entry('b', 'amber', 'delta', 0, 'essential'),
      entry('c', 'amber', 'gamma', 0, 'formula'),
      entry('d', 'amber', 'paragraph'),
      entry('e', 'orange', 'Alpha', 0, 'weak_area'),
    ]);
    expect([...registry.keys()].sort()).toEqual([
      'sv-hl-amber',
      'sv-hl-amber-essential',
      'sv-hl-amber-formula',
      'sv-hl-orange-weak_area',
    ]);
    const essential = registry.get('sv-hl-amber-essential') as FakeHighlight;
    expect(essential.ranges.map(String)).toEqual(['beta', 'delta']);
    expect((registry.get('sv-hl-amber') as FakeHighlight).ranges.map(String)).toEqual([
      'paragraph',
    ]);
    expect([...registry.keys()].every((n) => n.startsWith('sv-hl-'))).toBe(true);
  });

  it('is replace-all across kinds: a changed kind removes its old registry entry', () => {
    const painter = newPainter();
    painter.paint([entry('a', 'amber', 'beta', 0, 'essential')]);
    painter.paint([entry('a', 'amber', 'beta', 0, 'formula')]);
    expect([...registry.keys()]).toEqual(['sv-hl-amber-formula']);
    painter.paint([entry('a', 'amber', 'beta')]);
    expect([...registry.keys()]).toEqual(['sv-hl-amber']);
  });

  it('falls back to the plain colour fill for an unknown kind', () => {
    const painter = newPainter();
    painter.paint([{ ...entry('a', 'blue', 'beta'), kind: 'toString' as never }]);
    expect([...registry.keys()]).toEqual(['sv-hl-blue']);
  });

  it('every registry name a painter can produce has a rule with that kind decoration', () => {
    const painter = newPainter();
    painter.paint(
      COLOR_IDS.flatMap((c) => HIGHLIGHT_KINDS.map((k) => entry(`${c}-${k}`, c, 'beta', 0, k))),
    );
    const css = sheets()[0]!.css;
    expect(registry.size).toBe(COLOR_IDS.length * HIGHLIGHT_KINDS.length);
    for (const name of registry.keys()) {
      const kind = HIGHLIGHT_KINDS.find((k) => name.endsWith(`-${k}`))!;
      const body = bodyOf(css, name);
      expect(prop(body, 'text-decoration-line')).toBe('underline');
      expect(prop(body, 'text-decoration-style')).toBe(KIND_DECORATION[kind].style);
      expect(prop(body, 'text-decoration-thickness')).toBe(`${KIND_DECORATION[kind].thickness}px`);
    }
  });

  it("colour-only entries keep today's fill-only style", () => {
    const css = cssFor();
    for (const c of COLOR_IDS) {
      expect(bodyOf(css, `sv-hl-${c}`)).toBe(`background-color:${COLOR_SWATCH[c].bg};`);
    }
  });

  it('KIND_DECORATION covers every kind with a unique (style, thickness) pair and label', () => {
    expect(Object.keys(KIND_DECORATION).sort()).toEqual([...HIGHLIGHT_KINDS].sort());
    const pairs = HIGHLIGHT_KINDS.map(
      (k) => `${KIND_DECORATION[k].style}/${KIND_DECORATION[k].thickness}`,
    );
    expect(new Set(pairs).size).toBe(HIGHLIGHT_KINDS.length);
    const labels = HIGHLIGHT_KINDS.map((k) => KIND_DECORATION[k].label);
    expect(new Set(labels).size).toBe(HIGHLIGHT_KINDS.length);
    for (const k of HIGHLIGHT_KINDS) {
      expect(Number.isInteger(KIND_DECORATION[k].thickness)).toBe(true);
      expect(KIND_DECORATION[k].thickness).toBeGreaterThan(0);
      expect(KIND_DECORATION[k].label.trim()).not.toBe('');
    }
  });

  it('the shipped CSS keeps the 7 kinds distinct in normal and strong strength', () => {
    for (const mode of ['normal', 'strong'] as const) {
      const css = cssFor(mode);
      const pairs = HIGHLIGHT_KINDS.map((k) => {
        const body = bodyOf(css, `sv-hl-blue-${k}`);
        return `${prop(body, 'text-decoration-style')}/${prop(body, 'text-decoration-thickness')}`;
      });
      expect(new Set(pairs).size).toBe(7);
    }
  });

  it('works with the active highlight, clear and destroy', () => {
    const painter = newPainter();
    painter.paint([entry('a', 'red', 'beta', 0, 'exception'), entry('b', 'teal', 'delta')]);
    painter.setActive('a');
    expect([...registry.keys()].sort()).toEqual([
      'sv-hl-active',
      'sv-hl-red-exception',
      'sv-hl-teal',
    ]);
    expect((registry.get('sv-hl-active') as FakeHighlight).ranges.map(String)).toEqual(['beta']);
    painter.clear();
    expect(registry.size).toBe(0);
    painter.paint([entry('a', 'red', 'beta', 0, 'exception')]);
    painter.destroy();
    expect(registry.size).toBe(0);
  });

  it('never adds DOM nodes or attributes for kind entries', () => {
    const before = document.documentElement.outerHTML;
    const painter = newPainter();
    painter.paint([entry('a', 'amber', 'beta', 0, 'formula')]);
    painter.setActive('a');
    painter.setStyle('strong');
    expect(document.documentElement.outerHTML).toBe(before);
  });
});

describe('strength: setStyle, prefers-contrast, forced-colors', () => {
  it('swaps the rules of the one adopted stylesheet in place', () => {
    const painter = newPainter();
    const sheet = sheets()[0]!;
    const normal = sheet.css;
    painter.setStyle('strong');
    expect(sheets()).toEqual([sheet]);
    expect(sheet.css).not.toBe(normal);
    painter.setStyle('normal');
    expect(sheet.css).toBe(cssFor('normal'));
  });

  it('strong = heavier fill (higher alpha, capped) and 1px thicker underlines', () => {
    const normal = cssFor('normal');
    const strong = cssFor('strong');
    for (const c of COLOR_IDS) {
      const before = parseRgba(prop(bodyOf(normal, `sv-hl-${c}`), 'background-color'));
      const after = parseRgba(prop(bodyOf(strong, `sv-hl-${c}`), 'background-color'));
      expect(after.alpha).toBeGreaterThan(before.alpha);
      expect(after.alpha).toBeLessThanOrEqual(0.55);
      expect(after.rgb).toEqual(before.rgb);
    }
    for (const k of HIGHLIGHT_KINDS) {
      const thickness = (css: string): number =>
        parseInt(prop(bodyOf(css, `sv-hl-green-${k}`), 'text-decoration-thickness'), 10);
      expect(thickness(strong)).toBe(thickness(normal) + 1);
      expect(thickness(normal)).toBe(KIND_DECORATION[k].thickness);
    }
  });

  it('default is auto: prefers-contrast: more upgrades to the strong rules, explicit modes do not', () => {
    const query = '(prefers-contrast: more)';
    const base = (css: string): string =>
      prop(bodyOf(css, 'sv-hl-amber-formula'), 'text-decoration-thickness');
    const auto = cssFor();
    const block = mediaBlock(auto, query)!;
    expect(block).not.toBeNull();
    expect(prop(bodyOf(block, 'sv-hl-amber-formula'), 'text-decoration-thickness')).toBe('4px');
    expect(base(auto)).toBe('3px');
    expect(cssFor('auto')).toBe(auto);

    const normal = cssFor('normal');
    expect(mediaBlock(normal, query)).toBeNull();
    expect(base(normal)).toBe('3px');

    const strong = cssFor('strong');
    expect(mediaBlock(strong, query)).toBeNull();
    expect(base(strong)).toBe('4px');
  });

  it('ignores an unknown style and is a no-op when unsupported', () => {
    const painter = newPainter();
    const before = sheets()[0]!.css;
    painter.setStyle('bogus' as never);
    expect(sheets()[0]!.css).toBe(before);
    painter.destroy();
    expect(() => painter.setStyle('strong')).not.toThrow();
    expect(() => new HighlightPainter(document).setStyle('strong')).not.toThrow();
  });

  it('keeps the sheet when replaceSync throws', () => {
    const painter = newPainter();
    const sheet = sheets()[0]!;
    const before = sheet.css;
    sheet.replaceSync = () => {
      throw new Error('boom');
    };
    expect(() => painter.setStyle('strong')).not.toThrow();
    expect(sheet.css).toBe(before);
  });

  it('forced-colors: system colours only, last in the sheet, in every mode', () => {
    for (const mode of [undefined, 'normal', 'strong'] as const) {
      const css = cssFor(mode);
      const block = mediaBlock(css, '(forced-colors: active)');
      expect(block).not.toBeNull();
      expect(css.trimEnd().endsWith('}')).toBe(true);
      expect(css.lastIndexOf('@media (forced-colors: active){')).toBeGreaterThan(
        css.lastIndexOf('@media (prefers-contrast: more){'),
      );
      // No hard-coded palette inside: only CanvasText / Highlight / HighlightText / transparent.
      expect(block).not.toMatch(/#[0-9a-f]{3,8}|rgba?\(|color-mix/i);
      const kinds = HIGHLIGHT_KINDS.flatMap((k) => COLOR_IDS.map((c) => `sv-hl-${c}-${k}`));
      for (const name of [...COLOR_IDS.map((c) => `sv-hl-${c}`), ...kinds]) {
        const body = bodyOf(block!, name);
        expect(prop(body, 'background-color')).toBe('transparent');
        expect(prop(body, 'text-decoration-color')).toBe('CanvasText');
        // Kind-less highlights get under+overline: never identical to any kind's cue.
        expect(prop(body, 'text-decoration-line')).toBe(
          kinds.includes(name) ? 'underline' : 'underline overline',
        );
      }
      const active = bodyOf(block!, 'sv-hl-active');
      expect(prop(active, 'background-color')).toBe('Highlight');
      expect(prop(active, 'color')).toBe('HighlightText');
      // The kind cue survives: still seven distinct pairs.
      const pairs = HIGHLIGHT_KINDS.map((k) => {
        const body = bodyOf(block!, `sv-hl-red-${k}`);
        return `${prop(body, 'text-decoration-style')}/${prop(body, 'text-decoration-thickness')}`;
      });
      expect(new Set(pairs).size).toBe(7);
    }
  });
});

describe('contrast of the non-colour cue', () => {
  // Reference pages: white with #111111 text, and the dark theme #101318 with #e8eaed text.
  const PAGES = [
    { name: 'white page', bg: hexRgb('#ffffff'), text: hexRgb('#111111') },
    { name: 'dark page', bg: hexRgb('#101318'), text: hexRgb('#e8eaed') },
  ];

  it('the underline is >= 3:1 against the page AND against its own fill; text keeps >= 3:1 on the fill', () => {
    const failures: string[] = [];
    for (const mode of ['normal', 'strong'] as const) {
      const css = cssFor(mode);
      for (const color of COLOR_IDS) {
        for (const kind of HIGHLIGHT_KINDS) {
          const body = bodyOf(css, `sv-hl-${color}-${kind}`);
          const fill = parseRgba(prop(body, 'background-color'));
          const mix = /^color-mix\(in srgb, (#[0-9a-f]{6}) (\d+)%, currentcolor\)$/.exec(
            prop(body, 'text-decoration-color'),
          );
          if (!mix) {
            failures.push(`${mode} ${color}-${kind}: unexpected decoration colour`);
            continue;
          }
          const hue = hexRgb(mix[1]!);
          const share = Number(mix[2]) / 100;
          for (const page of PAGES) {
            // color-mix(in srgb, hue p%, currentcolor): currentcolor is the page's text colour.
            const deco = blend(hue, share, page.text);
            const fillOnPage = blend(fill.rgb, fill.alpha, page.bg);
            const checks: Array<[string, number]> = [
              ['underline/page', ratio(deco, page.bg)],
              ['underline/fill', ratio(deco, fillOnPage)],
              ['text/fill', ratio(page.text, fillOnPage)],
            ];
            for (const [what, value] of checks) {
              if (value < 3) {
                failures.push(`${mode} ${color}-${kind} ${page.name} ${what}=${value.toFixed(2)}`);
              }
            }
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('documents why: the translucent fill alone is below 3:1 against a white page', () => {
    // The fill is decoration, not the cue; this pins the premise the underline design rests on.
    const white = hexRgb('#ffffff');
    for (const c of COLOR_IDS) {
      const { rgb, alpha } = parseRgba(COLOR_SWATCH[c].bg);
      expect(ratio(blend(rgb, alpha, white), white)).toBeLessThan(3);
    }
  });
});
