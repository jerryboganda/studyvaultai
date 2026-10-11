import { describe, expect, it } from 'vitest';
import {
  EMPTY_SELECTION,
  click,
  extendTo,
  isEmpty,
  isSelected,
  prune,
  rangeBetween,
  resolveIds,
  selectAllFiltered,
  selectAllLoaded,
  selectedCount,
  toggle,
} from './selection';

const order = ['a', 'b', 'c', 'd', 'e', 'f'];

describe('selection model', () => {
  it('a plain click selects only that row', () => {
    const s = click(click(EMPTY_SELECTION, order, 'b'), order, 'd');
    expect([...s.ids]).toEqual(['d']);
    expect(s.anchor).toBe('d');
  });

  it('ctrl/cmd click toggles and keeps the rest', () => {
    let s = click(EMPTY_SELECTION, order, 'a');
    s = click(s, order, 'c', { toggle: true });
    s = click(s, order, 'e', { toggle: true });
    expect([...s.ids].sort()).toEqual(['a', 'c', 'e']);
    s = click(s, order, 'c', { toggle: true });
    expect([...s.ids].sort()).toEqual(['a', 'e']);
  });

  it('shift click selects the range from the anchor, in either direction', () => {
    let s = click(EMPTY_SELECTION, order, 'b');
    s = click(s, order, 'e', { shift: true });
    expect([...s.ids]).toEqual(['b', 'c', 'd', 'e']);
    s = click(s, order, 'a', { shift: true });
    expect([...s.ids]).toEqual(['a', 'b']);
    expect(s.anchor).toBe('b');
  });

  it('shift+ctrl click adds a range to what is already selected', () => {
    let s = click(EMPTY_SELECTION, order, 'a');
    s = click(s, order, 'e', { toggle: true });
    s = click(s, order, 'f', { shift: true, toggle: true });
    expect([...s.ids].sort()).toEqual(['a', 'e', 'f']);
  });

  it('shift click without an anchor behaves like a plain click', () => {
    const s = click(EMPTY_SELECTION, order, 'c', { shift: true });
    expect([...s.ids]).toEqual(['c']);
  });

  it('shift+arrow grows and shrinks the range around the anchor', () => {
    let s = click(EMPTY_SELECTION, order, 'c');
    s = extendTo(s, order, 'd');
    s = extendTo(s, order, 'e');
    expect([...s.ids]).toEqual(['c', 'd', 'e']);
    s = extendTo(s, order, 'd');
    expect([...s.ids]).toEqual(['c', 'd']);
    s = extendTo(s, order, 'a');
    expect([...s.ids]).toEqual(['a', 'b', 'c']);
  });

  it('rangeBetween ignores unknown ids', () => {
    expect(rangeBetween(order, 'a', 'zzz')).toEqual([]);
    expect(rangeBetween(order, 'c', 'a')).toEqual(['a', 'b', 'c']);
  });

  it('select all loaded selects every row in order', () => {
    const s = selectAllLoaded(order);
    expect(selectedCount(s, 100)).toBe(6);
    expect(resolveIds(s, null)).toEqual(order);
  });

  it('select all filtered stands for the whole result and counts exclusions', () => {
    let s = selectAllFiltered('a');
    expect(selectedCount(s, 10_000)).toBe(10_000);
    expect(isSelected(s, 'anything')).toBe(true);
    s = toggle(s, 'c');
    expect(isSelected(s, 'c')).toBe(false);
    expect(selectedCount(s, 10_000)).toBe(9_999);
    const all = ['a', 'b', 'c', 'd'];
    expect(resolveIds(s, all)).toEqual(['a', 'b', 'd']);
    expect(isEmpty(selectAllFiltered(), 0)).toBe(true);
  });

  it('a plain click leaves all-filtered mode', () => {
    const s = click(selectAllFiltered('a'), order, 'b');
    expect(s.allFiltered).toBe(false);
    expect([...s.ids]).toEqual(['b']);
  });

  it('shift click inside all-filtered mode re-ticks the range from the anchor', () => {
    let s = selectAllFiltered('b');
    s = toggle(s, 'c');
    s = toggle(s, 'd'); // the anchor is now d
    expect([...s.ids].sort()).toEqual(['c', 'd']);
    s = click(s, order, 'e', { shift: true });
    expect(s.allFiltered).toBe(true);
    expect([...s.ids]).toEqual(['c']);
  });

  it('prune drops rows that vanished and keeps the rest', () => {
    const s = prune(selectAllLoaded(order), new Set(['a', 'c']));
    expect([...s.ids]).toEqual(['a', 'c']);
    expect(prune(s, new Set(['a', 'c', 'z']))).toBe(s);
    const all = selectAllFiltered();
    expect(prune(all, new Set())).toBe(all);
  });
});
