// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { formatHlc, maxHlc, parseHlc, receive, tick } from './hlc.ts';

describe('hybrid logical clock', () => {
  it('orders lexicographically by (wall, counter, node)', () => {
    const a = formatHlc(1_000, 0, 'a-node');
    const b = formatHlc(1_000, 1, 'a-node');
    const c = formatHlc(1_001, 0, 'a-node');
    const d = formatHlc(1_001, 0, 'b-node');
    expect([d, b, c, a].sort()).toEqual([a, b, c, d]);
    expect(parseHlc(b)).toEqual({ wall: 1_000, counter: 1, node: 'a-node' });
    expect(parseHlc('nonsense')).toBeNull();
  });

  it('is strictly increasing even when the wall clock stalls or goes backwards', () => {
    let state = { wall: 0, counter: 0 };
    const seen: string[] = [];
    for (const now of [5_000, 5_000, 5_000, 4_000, 6_000]) {
      const t = tick(state, now, 'node-aaa');
      state = t.state;
      seen.push(t.hlc);
    }
    expect([...seen].sort()).toEqual(seen);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('exceeds every clock in the floor, even when its own state is stale', () => {
    const remote = formatHlc(9_000_000, 7, 'other-node');
    const t = tick({ wall: 0, counter: 0 }, 1_000, 'node-aaa', [remote, null, undefined]);
    expect(t.hlc > remote).toBe(true);
  });

  it('receive moves past a remote timestamp and never goes backwards', () => {
    const remote = formatHlc(50_000, 3, 'other-node');
    const s = receive({ wall: 10_000, counter: 9 }, remote, 20_000);
    expect(s.wall).toBe(50_000);
    expect(s.counter).toBe(4);
    expect(receive(s, formatHlc(1, 0, 'x'), 1_000)).toEqual({ wall: 50_000, counter: 5 });
  });

  it('clamps a far-future remote so one bad device cannot poison the clock', () => {
    const day = 24 * 60 * 60 * 1000;
    const remote = formatHlc(Date.UTC(2999, 0, 1), 0, 'evil-node');
    const s = receive({ wall: 0, counter: 0 }, remote, 1_000_000, day);
    expect(s.wall).toBeLessThanOrEqual(1_000_000 + day);
  });

  it('maxHlc treats null as absent', () => {
    expect(maxHlc(null, null)).toBeNull();
    expect(maxHlc('b', null)).toBe('b');
    expect(maxHlc('a', 'b')).toBe('b');
  });
});
