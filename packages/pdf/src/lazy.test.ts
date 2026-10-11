import { describe, expect, it } from 'vitest';
import { findInDocument, queryRegExp } from './search';
import { LazyPages, pagesToKeep } from './virtualizer';

describe('pagesToKeep', () => {
  it('keeps visible pages and one neighbour on each side, within bounds', () => {
    expect(pagesToKeep([1], 5)).toEqual([1, 2]);
    expect(pagesToKeep([3], 5)).toEqual([2, 3, 4]);
    expect(pagesToKeep([5], 5)).toEqual([4, 5]);
    expect(pagesToKeep([2, 3], 10)).toEqual([1, 2, 3, 4]);
    expect(pagesToKeep([], 10)).toEqual([]);
  });
});

describe('LazyPages (100+ page lazy rendering)', () => {
  function harness(pageCount: number) {
    const live = new Set<number>();
    const renders: number[] = [];
    let peak = 0;
    const lazy = new LazyPages<number>(
      {
        render: async (n) => {
          renders.push(n);
          live.add(n);
          peak = Math.max(peak, live.size);
          return n;
        },
        release: (n) => void live.delete(n),
      },
      pageCount,
    );
    return { lazy, live, renders, peak: () => peak };
  }
  // Microtasks only: the hooks settle in promise callbacks, and 300 real timers take seconds on Windows.
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  };

  it('renders only the window, never the whole document', async () => {
    const h = harness(250);
    h.lazy.setVisible([1]);
    await settle();
    expect([...h.live].sort((a, b) => a - b)).toEqual([1, 2]);
    h.lazy.setVisible([120, 121]);
    await settle();
    expect([...h.live].sort((a, b) => a - b)).toEqual([119, 120, 121, 122]);
    expect(h.renders).toEqual([1, 2, 119, 120, 121, 122]);
  });

  it('scrolling through the whole document keeps a bounded number of pages alive', async () => {
    const h = harness(300);
    for (let n = 1; n <= 300; n++) {
      h.lazy.setVisible([n]);
      await settle();
    }
    expect(h.peak()).toBeLessThanOrEqual(4);
    expect(h.renders).toHaveLength(300); // each page drawn exactly once on a single downward pass
    expect(h.live.size).toBeLessThanOrEqual(2);
  });

  it('a page that scrolls away before its render finishes is released, not leaked', async () => {
    const live = new Set<number>();
    let resolveFirst: (() => void) | null = null;
    const lazy = new LazyPages<number>(
      {
        render: (n) =>
          new Promise<number>((resolve) => {
            if (n === 1) {
              resolveFirst = () => {
                live.add(n);
                resolve(n);
              };
            } else {
              live.add(n);
              resolve(n);
            }
          }),
        release: (n) => void live.delete(n),
      },
      100,
    );
    lazy.setVisible([1]);
    lazy.setVisible([50]);
    resolveFirst!();
    await settle();
    expect(live.has(1)).toBe(false);
    expect([...live].sort((a, b) => a - b)).toEqual([49, 50, 51]);
  });

  it('invalidate() redraws the kept pages (zoom or rotation changed)', async () => {
    const h = harness(20);
    h.lazy.setVisible([10]);
    await settle();
    h.lazy.invalidate();
    await settle();
    expect(h.renders).toEqual([9, 10, 11, 9, 10, 11]);
    h.lazy.destroy();
    expect(h.live.size).toBe(0);
  });

  it('invalidatePage() redraws one kept page and ignores a page that is not kept', async () => {
    const h = harness(20);
    h.lazy.setVisible([10]);
    await settle();
    expect(h.renders).toEqual([9, 10, 11]);
    h.lazy.invalidatePage(10);
    await settle();
    expect(h.renders).toEqual([9, 10, 11, 10]);
    h.lazy.invalidatePage(3); // not kept: nothing is drawn for it
    await settle();
    expect(h.renders).toEqual([9, 10, 11, 10]);
    expect([...h.live].sort((a, b) => a - b)).toEqual([9, 10, 11]);
  });

  it('a failing page is reported once and does not stop the others', async () => {
    const errors: number[] = [];
    const lazy = new LazyPages<number>(
      {
        render: async (n) => {
          if (n === 2) throw new Error('broken page');
          return n;
        },
        release: () => undefined,
        onError: (n) => errors.push(n),
      },
      5,
    );
    lazy.setVisible([2]);
    await settle();
    lazy.setVisible([2]);
    await settle();
    expect(errors).toEqual([2]);
    expect(lazy.active).toEqual([1, 2, 3]);
  });
});

describe('document search', () => {
  const pages = ['The Renal cortex.', 'no hit here', 'renal  medulla and RENAL pelvis'];
  const getText = async (n: number) => pages[n - 1]!;

  it('finds case-insensitive matches across pages with stream offsets', async () => {
    const seen: number[] = [];
    const res = await findInDocument({
      query: 'renal',
      pageCount: 3,
      getText,
      onMatches: (b) => seen.push(b.length),
    });
    expect(res.matches.map((m) => [m.page, m.start])).toEqual([
      [1, 4],
      [3, 0],
      [3, 19],
    ]);
    expect(seen).toEqual([1, 2]);
    expect(res.truncated).toBe(false);
  });

  it('treats whitespace in the query as any whitespace run and escapes punctuation', async () => {
    const r = await findInDocument({ query: 'renal medulla', pageCount: 3, getText });
    expect(r.matches).toHaveLength(1);
    expect(queryRegExp('a.b (c)')!.test('A.B (C)')).toBe(true);
    expect(queryRegExp('a.b')!.test('axb')).toBe(false);
    expect(queryRegExp('   ')).toBeNull();
  });

  it('can be cancelled and caps the result size', async () => {
    const ac = new AbortController();
    const res = await findInDocument({
      query: 'renal',
      pageCount: 3,
      signal: ac.signal,
      getText: async (n) => {
        if (n === 2) ac.abort();
        return pages[n - 1]!;
      },
    });
    expect(res.cancelled).toBe(true);
    const capped = await findInDocument({
      query: 'a',
      pageCount: 1,
      getText: async () => 'a'.repeat(50),
      maxMatches: 10,
    });
    expect(capped.matches).toHaveLength(10);
    expect(capped.truncated).toBe(true);
  });
});
