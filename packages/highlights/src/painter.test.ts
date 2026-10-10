import { COLOR_SWATCH } from '@shared/constants';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HighlightPainter } from './painter';
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

function entry(id: string, color: PaintEntry['color'], needle: string, occurrence = 0): PaintEntry {
  return { id, color, range: rangeOver(needle, occurrence) };
}

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
});
