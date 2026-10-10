import { describe, expect, it } from 'vitest';
import { errorMessage, plural, truncate } from './text';
import { describeResolveState } from './resolveState';

describe('truncate', () => {
  it('leaves short text alone and adds an ellipsis otherwise', () => {
    expect(truncate('short', 10)).toBe('short');
    expect(truncate('abcdefghij', 5)).toBe('abcde…');
  });

  it('never splits a surrogate pair', () => {
    const text = 'ab😀cd'; // the emoji occupies indexes 2 and 3
    expect(truncate(text, 3)).toBe('ab…');
    expect(truncate(text, 4)).toBe('ab😀…');
  });
});

describe('errorMessage / plural', () => {
  it('uses the real message, else the fallback', () => {
    expect(errorMessage(new Error('Disk full'))).toBe('Disk full');
    expect(errorMessage(new Error('  '), 'fallback')).toBe('fallback');
    expect(errorMessage('boom', 'fallback')).toBe('fallback');
  });

  it('pluralises', () => {
    expect(plural(1, 'highlight')).toBe('1 highlight');
    expect(plural(0, 'highlight')).toBe('0 highlights');
  });
});

describe('describeResolveState', () => {
  it('flags exactly the unpainted states as needing attention, each with a text label', () => {
    const all = (['unchecked', 'resolved', 'changed', 'ambiguous', 'orphaned'] as const).map(
      describeResolveState,
    );
    expect(all.filter((d) => d.attention).map((d) => d.status)).toEqual(['ambiguous', 'orphaned']);
    for (const d of all) {
      expect(d.label.length).toBeGreaterThan(3);
      expect(d.glyph.length).toBeGreaterThan(0);
    }
    expect(describeResolveState('orphaned').label).toMatch(/not found on page/);
    expect(describeResolveState('ambiguous').label).toMatch(/not painted/);
  });
});
