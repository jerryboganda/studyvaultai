import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { HighlightView } from '@shared';
import { buildTextStream, type TextStream } from '@highlights';
import { Rehydrator, type PageRef, type RehydratorDeps } from './rehydrator';
import type { ReportItem } from './reportTracker';
import { RetryBudget } from './retryBudget';
import { FakePainter, flushPromises, setBody, storedHighlight } from './testUtils';

const PAGE_A: PageRef = { url: 'https://example.com/a', canonicalUrl: null };

const MITO = 'mitochondria is the powerhouse of the cell and makes ATP';

interface Rig {
  rehydrator: Rehydrator;
  painter: FakePainter;
  rows: HighlightView[];
  fetch: Mock<(page: PageRef) => Promise<HighlightView[]>>;
  report: Mock<(items: ReportItem[]) => Promise<unknown>>;
  streams: { built: number };
  page: { current: PageRef | null };
}

function rig(rows: HighlightView[], over: Partial<RehydratorDeps> = {}): Rig {
  const painter = new FakePainter();
  const page = { current: PAGE_A as PageRef | null };
  const streams = { built: 0 };
  const state = { rows };
  const fetch = vi.fn(async (_page: PageRef) => [...state.rows]);
  const report = vi.fn(async (items: ReportItem[]) => ({ updated: items.length }));
  const rehydrator = new Rehydrator({
    painter,
    page: () => page.current,
    fetchHighlights: fetch,
    report,
    buildStream: (): TextStream => {
      streams.built += 1;
      return buildTextStream();
    },
    ...over,
  });
  return {
    rehydrator,
    painter,
    get rows() {
      return state.rows;
    },
    set rows(next: HighlightView[]) {
      state.rows = next;
    },
    fetch,
    report,
    streams,
    page,
  } as Rig;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  setBody('');
});

describe('refresh: what gets painted', () => {
  it('paints resolved and changed highlights, never ambiguous or orphaned', async () => {
    const repeated =
      '<p>Dosage guidance written in plain words for context. REPEAT QUOTE VALUE here and then more trailing words that follow.</p>';
    const page = (mito: string, footer: string): string =>
      `<p>The ${mito}. Further reading continues in the next section of this text.</p>` +
      repeated +
      repeated +
      '<p>Quick brown fox jumps over the lazy dog today.</p>' +
      footer;

    setBody(page(MITO, ''));
    const exact = storedHighlight('Quick brown fox jumps over the lazy dog today');
    const fuzzy = storedHighlight(MITO);
    const twin = storedHighlight('REPEAT QUOTE VALUE');
    const gone = storedHighlight('Quick brown fox jumps');
    gone.anchorSet.textQuote.exact = 'text that is nowhere on this page at all';

    // The page changes after capture: one word edited and a footer appended, so neither the
    // position nor the content signature match any more.
    setBody(page(MITO.replace('powerhouse', 'powerhouses'), '<p>Appended footer.</p>'));

    const r = rig([exact, fuzzy, twin, gone]);
    await r.rehydrator.refresh();

    expect(r.painter.ids).toEqual([exact.id, fuzzy.id].sort());
    expect(r.rehydrator.counts()).toEqual({
      total: 4,
      resolved: 1,
      changed: 1,
      ambiguous: 1,
      orphaned: 1,
      pending: 0,
    });
    expect(r.rehydrator.rangeOf(exact.id)?.toString()).toBe(
      'Quick brown fox jumps over the lazy dog today',
    );
    expect(r.rehydrator.rangeOf(twin.id)).toBeNull();
    expect(r.rehydrator.rangeOf(gone.id)).toBeNull();
  });

  it('paints with the highlight colour', async () => {
    setBody('<p>Alpha beta gamma delta epsilon zeta eta theta.</p>');
    const blue = storedHighlight('beta gamma delta', { color: 'blue' });
    const r = rig([blue]);
    await r.rehydrator.refresh();
    expect(r.painter.painted.map((p) => p.color)).toEqual(['blue']);
  });

  it('keeps what is painted when the worker cannot be reached', async () => {
    setBody('<p>Alpha beta gamma delta epsilon zeta eta theta.</p>');
    const h = storedHighlight('beta gamma delta');
    const r = rig([h]);
    await r.rehydrator.refresh();
    r.fetch.mockRejectedValueOnce(new Error('Extension context invalidated'));
    await r.rehydrator.refresh();
    expect(r.painter.ids).toEqual([h.id]);
    expect(r.painter.clearCalls).toBe(0);
  });

  it('does nothing for a page that cannot hold highlights', async () => {
    const r = rig([]);
    r.page.current = null;
    await r.rehydrator.refresh();
    expect(r.fetch).not.toHaveBeenCalled();
  });

  it('coalesces overlapping refresh calls into one follow-up fetch', async () => {
    setBody('<p>Alpha beta gamma delta epsilon zeta eta theta.</p>');
    const r = rig([storedHighlight('beta gamma delta')]);
    const first = r.rehydrator.refresh();
    const second = r.rehydrator.refresh();
    const third = r.rehydrator.refresh();
    await Promise.all([first, second, third]);
    expect(r.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('onLoaded', () => {
  it('runs after each load that replaced the views, not after a failed one', async () => {
    setBody('<p>Alpha beta gamma delta epsilon zeta eta theta.</p>');
    const h = storedHighlight('beta gamma delta');
    const notes: Array<string | undefined> = [];
    const r = rig([h], {
      onLoaded: () => notes.push(r.rehydrator.viewOf(h.id)?.userComment),
    });
    await r.rehydrator.refresh();

    // A note typed in the side panel: the next load has the view with it, already readable.
    r.rows = [{ ...h, userComment: 'written in the side panel' }];
    await r.rehydrator.refresh();
    expect(notes).toEqual(['', 'written in the side panel']);

    r.fetch.mockRejectedValueOnce(new Error('Extension context invalidated'));
    await r.rehydrator.refresh();
    expect(notes).toHaveLength(2);
  });
});

describe('resolution reports', () => {
  it('reports resolved at once and unresolved only after the page has settled', async () => {
    setBody(
      '<p>Alpha beta gamma delta epsilon zeta eta theta.</p><p>Second paragraph words go here.</p>',
    );
    const ok = storedHighlight('beta gamma delta');
    const lost = storedHighlight('Second paragraph words');
    lost.anchorSet.textQuote.exact = 'text that is nowhere on this page at all';
    const r = rig([ok, lost]);

    await r.rehydrator.refresh();
    expect(r.report).toHaveBeenCalledTimes(1);
    expect(r.report.mock.calls[0]![0]).toEqual([{ id: ok.id, status: 'resolved', confidence: 1 }]);

    await vi.advanceTimersByTimeAsync(1600);
    expect(r.report).toHaveBeenCalledTimes(2);
    expect(r.report.mock.calls[1]![0]).toEqual([
      { id: lost.id, status: 'orphaned', confidence: 0 },
    ]);
  });

  it('a page that finishes rendering within the settle window never records a false orphan', async () => {
    setBody('<p>Alpha beta gamma delta epsilon zeta eta theta.</p>');
    const late = storedHighlight('beta gamma delta');
    setBody('<p>Loading...</p>'); // the app shell has not rendered the article yet

    const r = rig([late]);
    await r.rehydrator.refresh();
    expect(r.rehydrator.counts().orphaned).toBe(1);
    expect(r.report).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    setBody('<p>Alpha beta gamma delta epsilon zeta eta theta.</p>');
    r.rehydrator.retryPass();
    expect(r.painter.ids).toEqual([late.id]);

    await vi.advanceTimersByTimeAsync(5000);
    expect(r.report.mock.calls.map((c) => c[0])).toEqual([
      [{ id: late.id, status: 'resolved', confidence: 1 }],
    ]);
  });

  it('report storm guard: the echo of our own report triggers no further report', async () => {
    setBody('<p>Alpha beta gamma delta epsilon zeta eta theta.</p>');
    const h = storedHighlight('beta gamma delta');
    const r = rig([h]);

    await r.rehydrator.refresh();
    expect(r.report).toHaveBeenCalledTimes(1);

    // The worker stored our report and (as in production) the change signal makes us re-fetch.
    r.rows = [{ ...h, resolveStatus: 'resolved', resolveConfidence: 1 }];
    for (let i = 0; i < 5; i++) await r.rehydrator.refresh();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(r.report).toHaveBeenCalledTimes(1);
  });

  it('does not report rows that already carry the computed outcome', async () => {
    setBody('<p>Alpha beta gamma delta epsilon zeta eta theta.</p>');
    const h = storedHighlight('beta gamma delta', {
      resolveStatus: 'resolved',
      resolveConfidence: 1,
    });
    const r = rig([h]);
    await r.rehydrator.refresh();
    await vi.advanceTimersByTimeAsync(5000);
    expect(r.report).not.toHaveBeenCalled();
  });

  it('retries a failed report on the next pass instead of losing it', async () => {
    setBody('<p>Alpha beta gamma delta epsilon zeta eta theta.</p>');
    const h = storedHighlight('beta gamma delta');
    const r = rig([h]);
    r.report.mockRejectedValueOnce(new Error('worker asleep'));
    await r.rehydrator.refresh();
    await flushPromises();
    await r.rehydrator.refresh();
    expect(r.report).toHaveBeenCalledTimes(2);
  });

  it('splits very large reports into protocol-sized batches', async () => {
    setBody('<p>Alpha beta gamma delta epsilon zeta eta theta.</p>');
    const base = storedHighlight('beta gamma delta');
    const rows = Array.from({ length: 501 }, (_, i) => ({
      ...base,
      id: `bulk-${String(i).padStart(8, '0')}`,
    }));
    const r = rig(rows);
    await r.rehydrator.refresh();
    expect(r.report.mock.calls.map((c) => c[0].length)).toEqual([500, 1]);
  });
});

describe('dynamic pages', () => {
  it('re-resolves an unpainted highlight when its text arrives, within the retry budget', async () => {
    setBody('<p>Static intro text only.</p>');
    setBody(
      '<p>Static intro text only.</p><p>Lazy loaded section about enzymes and catalysis.</p>',
    );
    const h = storedHighlight('section about enzymes and catalysis');
    setBody('<p>Static intro text only.</p>');

    const r = rig([h]);
    await r.rehydrator.refresh();
    expect(r.painter.ids).toEqual([]);
    const builtAfterLoad = r.streams.built;

    setBody(
      '<p>Static intro text only.</p><p>Lazy loaded section about enzymes and catalysis.</p>',
    );
    r.rehydrator.retryPass();
    expect(r.streams.built).toBe(builtAfterLoad + 1);
    expect(r.painter.ids).toEqual([h.id]);
  });

  it('spaces passes for unpainted highlights: a burst of calls costs one stream, not one each', async () => {
    setBody('<p>Lazy loaded section about enzymes and catalysis.</p>');
    const h = storedHighlight('section about enzymes and catalysis');
    setBody('<p>Nothing here.</p>');

    const r = rig([h], { retry: new RetryBudget(1_000, 20) });
    await r.rehydrator.refresh();
    const base = r.streams.built;

    for (let i = 0; i < 20; i++) r.rehydrator.retryPass();
    expect(r.streams.built - base).toBe(1);
  });

  it('a refused pass is deferred to when it is due, so text that arrives right after a pass is not lost', async () => {
    setBody('<p>Lazy loaded section about enzymes and catalysis.</p>');
    const h = storedHighlight('section about enzymes and catalysis');
    setBody('<p>Nothing here.</p>');
    const r = rig([h], { retry: new RetryBudget(1_000, 20) });
    await r.rehydrator.refresh();

    r.rehydrator.retryPass(); // a pass finds nothing and starts the spacing
    setBody('<p>Lazy loaded section about enzymes and catalysis.</p>');
    await vi.advanceTimersByTimeAsync(300);
    r.rehydrator.retryPass(); // the mutation burst's debounce fires: too soon, refused
    expect(r.painter.ids).toEqual([]);

    // No further mutation ever comes. The deferred pass still runs, once, when it is due.
    const built = r.streams.built;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(r.painter.ids).toEqual([h.id]);
    expect(r.streams.built).toBe(built + 1);
  });

  it('keeps looking for late text for as long as the page lives, at a bounded rate', async () => {
    setBody('<p>Lazy loaded section about enzymes and catalysis.</p>');
    const h = storedHighlight('section about enzymes and catalysis');
    setBody('<p>Nothing here.</p>');
    const r = rig([h], { retry: new RetryBudget(1_000, 20) });
    await r.rehydrator.refresh();
    const base = r.streams.built;

    // 10 minutes of a page that mutates constantly: a pass is attempted on every mutation burst.
    for (let s = 0; s < 600; s++) {
      r.rehydrator.retryPass();
      r.rehydrator.retryPass();
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(r.streams.built - base).toBeLessThanOrEqual(601); // <= 1 per second, however often asked
    expect(r.streams.built - base).toBeGreaterThan(500);

    setBody('<p>Lazy loaded section about enzymes and catalysis.</p>');
    r.rehydrator.retryPass();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(r.painter.ids).toEqual([h.id]);
  });

  it('charges the budget for what a pass really cost (a heavy page is retried less often)', async () => {
    setBody('<p>Lazy loaded section about enzymes and catalysis.</p>');
    const h = storedHighlight('section about enzymes and catalysis');
    setBody('<p>Nothing here.</p>');
    let clock = 0;
    const r = rig([h], {
      retry: new RetryBudget(1_000, 20, () => clock),
      buildStream: (): TextStream => {
        clock += 100; // building and searching this page costs 100 ms
        return buildTextStream();
      },
    });
    await r.rehydrator.refresh();
    const base = clock;
    r.rehydrator.retryPass();
    expect(clock - base).toBe(100);

    clock += 1_999; // 1 s would do for a cheap page; this one asked for 2 s (20 x 100 ms)
    r.rehydrator.retryPass();
    expect(clock - base).toBe(100 + 1_999);
    clock += 1;
    r.rehydrator.retryPass();
    expect(clock - base).toBe(100 + 2_000 + 100);
  });

  it('a route change starts over: the next pass is due at once and a deferred one is dropped', async () => {
    setBody('<p>Lazy loaded section about enzymes and catalysis.</p>');
    const h = storedHighlight('section about enzymes and catalysis');
    setBody('<p>Nothing here.</p>');
    const r = rig([h], { retry: new RetryBudget(1_000, 20) });
    await r.rehydrator.refresh();
    r.rehydrator.retryPass();
    r.rehydrator.retryPass(); // refused: arms the deferred pass

    r.rows = [];
    await r.rehydrator.onRouteChange();
    const built = r.streams.built;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(r.streams.built).toBe(built);
  });

  it('destroy cancels a deferred pass', async () => {
    setBody('<p>Lazy loaded section about enzymes and catalysis.</p>');
    const h = storedHighlight('section about enzymes and catalysis');
    setBody('<p>Nothing here.</p>');
    const r = rig([h], { retry: new RetryBudget(1_000, 20) });
    await r.rehydrator.refresh();
    r.rehydrator.retryPass();
    r.rehydrator.retryPass();
    r.rehydrator.destroy();
    const built = r.streams.built;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(r.streams.built).toBe(built);
  });

  it('does no work for a mutation when everything is painted and attached', async () => {
    setBody('<p>Alpha beta gamma delta epsilon zeta eta theta.</p><div id="ticker">1</div>');
    const h = storedHighlight('beta gamma delta');
    const r = rig([h]);
    await r.rehydrator.refresh();
    const built = r.streams.built;
    const paints = r.painter.paintCalls;

    document.getElementById('ticker')!.textContent = '2';
    r.rehydrator.retryPass();
    expect(r.streams.built).toBe(built);
    expect(r.painter.paintCalls).toBe(paints);
  });

  it('re-resolves a painted highlight whose nodes were replaced', async () => {
    setBody('<div id="root"><p>Alpha beta gamma delta epsilon zeta eta theta.</p></div>');
    const h = storedHighlight('beta gamma delta');
    const r = rig([h]);
    await r.rehydrator.refresh();
    const before = r.rehydrator.rangeOf(h.id)!;

    // A framework re-render: same text, new nodes.
    document.getElementById('root')!.innerHTML =
      '<p>Alpha beta gamma delta epsilon zeta eta theta.</p>';
    expect(before.collapsed).toBe(true); // DOM removal steps collapse a live range onto the parent
    r.rehydrator.retryPass();

    const after = r.rehydrator.rangeOf(h.id)!;
    expect(after).not.toBeNull();
    expect(after.startContainer.isConnected).toBe(true);
    expect(after.toString()).toBe('beta gamma delta');
    expect(r.painter.painted[0]!.range).toBe(after);
  });

  it('re-resolves a painted highlight whose text was edited in place', async () => {
    setBody('<p>Alpha beta gamma delta epsilon zeta eta theta.</p>');
    const h = storedHighlight('beta gamma delta epsilon zeta');
    const r = rig([h]);
    await r.rehydrator.refresh();
    expect(r.painter.ids).toEqual([h.id]);

    const node = document.querySelector('p')!.firstChild as Text;
    node.data = 'Completely different words now live here instead.';
    r.rehydrator.retryPass();
    expect(r.painter.ids).toEqual([]);
    expect(r.rehydrator.counts().orphaned).toBe(1);
  });

  it('route change clears the old page, then paints the new route', async () => {
    setBody('<p>Route one text about mitosis and meiosis phases.</p>');
    const one = storedHighlight('text about mitosis and meiosis');
    setBody('<p>Route two text about osmosis and diffusion gradients.</p>');
    const two = storedHighlight('text about osmosis and diffusion');

    setBody('<p>Route one text about mitosis and meiosis phases.</p>');
    const r = rig([one]);
    await r.rehydrator.refresh();
    expect(r.painter.ids).toEqual([one.id]);

    r.rows = [two];
    r.page.current = { url: 'https://example.com/b', canonicalUrl: null };
    setBody('<p>Route two text about osmosis and diffusion gradients.</p>');
    await r.rehydrator.onRouteChange();

    expect(r.painter.clearCalls).toBe(1);
    expect(r.fetch).toHaveBeenLastCalledWith({ url: 'https://example.com/b', canonicalUrl: null });
    expect(r.painter.ids).toEqual([two.id]);
    expect(r.rehydrator.has(one.id)).toBe(false);
    expect(r.rehydrator.counts().total).toBe(1);
  });

  it('a fetch that was in flight during a route change is discarded', async () => {
    setBody('<p>Route one text about mitosis and meiosis phases.</p>');
    const one = storedHighlight('text about mitosis and meiosis');
    const r = rig([one]);
    let release!: (rows: HighlightView[]) => void;
    r.fetch.mockImplementationOnce(
      () => new Promise<HighlightView[]>((resolve) => (release = resolve)),
    );
    const stale = r.rehydrator.refresh();
    await flushPromises();

    r.rows = [];
    const navigated = r.rehydrator.onRouteChange();
    release([one]); // the old route's answer arrives late
    await Promise.all([stale, navigated]);
    expect(r.painter.ids).toEqual([]);
    expect(r.rehydrator.counts().total).toBe(0);
  });
});

describe('local edits', () => {
  it('upsert paints a freshly saved highlight from the capture stream and reports it', async () => {
    setBody('<p>Alpha beta gamma delta epsilon zeta eta theta.</p>');
    const r = rig([]);
    await r.rehydrator.refresh();

    const saved = storedHighlight('beta gamma delta');
    r.rehydrator.upsert(saved, { stream: buildTextStream(), generation: r.rehydrator.generation });
    expect(r.painter.ids).toEqual([saved.id]);
    expect(r.report).toHaveBeenCalledWith([{ id: saved.id, status: 'resolved', confidence: 1 }]);
  });

  it('an older fetch must not undo a save or resurrect a delete made while it was in flight', async () => {
    setBody(
      '<p>Alpha beta gamma delta epsilon zeta eta theta.</p><p>Second line of study notes here.</p>',
    );
    const existing = storedHighlight('Second line of study notes');
    const saved = storedHighlight('beta gamma delta');
    const r = rig([existing]);

    let release!: (rows: HighlightView[]) => void;
    r.fetch.mockImplementationOnce(
      () => new Promise<HighlightView[]>((resolve) => (release = resolve)),
    );
    const loading = r.rehydrator.refresh();
    await flushPromises();

    r.rehydrator.upsert(saved); // saved while the request is out
    r.rehydrator.drop(existing.id); // deleted while the request is out
    release([existing]); // the snapshot predates both
    await loading;

    expect(r.rehydrator.has(saved.id)).toBe(true);
    expect(r.rehydrator.has(existing.id)).toBe(false);
    expect(r.painter.ids).toEqual([saved.id]);
  });

  it('ignores a save result that arrives after a route change', async () => {
    setBody('<p>Alpha beta gamma delta epsilon zeta eta theta.</p>');
    const r = rig([]);
    await r.rehydrator.refresh();
    const generation = r.rehydrator.generation;
    r.page.current = { url: 'https://example.com/b', canonicalUrl: null };
    await r.rehydrator.onRouteChange();

    r.rehydrator.upsert(storedHighlight('beta gamma delta'), { generation });
    expect(r.rehydrator.counts().total).toBe(0);
  });

  it('a metadata update keeps the resolution and repaints the new colour', async () => {
    setBody('<p>Alpha beta gamma delta epsilon zeta eta theta.</p>');
    const h = storedHighlight('beta gamma delta', { color: 'amber' });
    const r = rig([h]);
    await r.rehydrator.refresh();
    const built = r.streams.built;

    r.rehydrator.upsert({ ...h, color: 'green' });
    expect(r.painter.painted.map((p) => p.color)).toEqual(['green']);
    expect(r.streams.built).toBe(built);
  });

  it('drop removes the paint', async () => {
    setBody('<p>Alpha beta gamma delta epsilon zeta eta theta.</p>');
    const h = storedHighlight('beta gamma delta');
    const r = rig([h]);
    await r.rehydrator.refresh();
    r.rehydrator.drop(h.id);
    expect(r.painter.ids).toEqual([]);
  });
});

describe('destroy', () => {
  it('stops everything: no fetch, no report, no timers', async () => {
    setBody(
      '<p>Alpha beta gamma delta epsilon zeta eta theta.</p><p>Second paragraph words go here.</p>',
    );
    const lost = storedHighlight('Second paragraph words');
    lost.anchorSet.textQuote.exact = 'text that is nowhere on this page at all';
    const r = rig([lost]);
    await r.rehydrator.refresh();
    r.rehydrator.destroy();

    await vi.advanceTimersByTimeAsync(5000); // the settle timer must have been cleared
    expect(r.report).not.toHaveBeenCalled();
    await r.rehydrator.refresh();
    expect(r.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('a failed load is not the end of the page', () => {
  const TEXT = '<p>Alpha beta gamma delta epsilon zeta eta theta.</p>';

  it('retries after 1 s, 2 s, 4 s ... and paints as soon as the worker answers', async () => {
    setBody(TEXT);
    const h = storedHighlight('beta gamma delta');
    const r = rig([h]);
    r.fetch
      .mockRejectedValueOnce(new Error('worker asleep'))
      .mockRejectedValueOnce(new Error('worker asleep'));

    await r.rehydrator.refresh(); // returns after the first attempt: the caller is not held up
    expect(r.fetch).toHaveBeenCalledTimes(1);
    expect(r.painter.ids).toEqual([]);

    await vi.advanceTimersByTimeAsync(999);
    expect(r.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); // 1 s: second attempt, fails again
    expect(r.fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(r.fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); // 2 s later: third attempt succeeds
    await flushPromises();
    expect(r.fetch).toHaveBeenCalledTimes(3);
    expect(r.painter.ids).toEqual([h.id]);

    await vi.advanceTimersByTimeAsync(120_000); // success ends it
    expect(r.fetch).toHaveBeenCalledTimes(3);
  });

  it('gives up after five retries (1 + 2 + 4 + 8 + 16 s) and stays quiet', async () => {
    setBody(TEXT);
    const r = rig([storedHighlight('beta gamma delta')]);
    r.fetch.mockRejectedValue(new Error('worker gone'));
    await r.rehydrator.refresh();

    await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 4_000 + 8_000 + 16_000);
    expect(r.fetch).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(r.fetch).toHaveBeenCalledTimes(6);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a caller with a reason to look again (data change, tab visible) starts a fresh backoff', async () => {
    setBody(TEXT);
    const h = storedHighlight('beta gamma delta');
    const r = rig([h]);
    r.fetch.mockRejectedValue(new Error('worker gone'));
    await r.rehydrator.refresh();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(r.fetch).toHaveBeenCalledTimes(6);

    r.fetch.mockReset();
    r.fetch.mockResolvedValue([h]);
    await r.rehydrator.refresh();
    expect(r.painter.ids).toEqual([h.id]);
  });

  it('a route change cancels the pending retry of the old page', async () => {
    setBody(TEXT);
    const r = rig([storedHighlight('beta gamma delta')]);
    r.fetch.mockRejectedValueOnce(new Error('worker asleep'));
    await r.rehydrator.refresh();
    r.page.current = { url: 'https://example.com/b', canonicalUrl: null };
    r.rows = [];
    r.rehydrator.routeChanged();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(r.fetch).toHaveBeenCalledTimes(1); // nothing was fetched for the route nobody loaded
  });

  it('destroy cancels the pending retry', async () => {
    setBody(TEXT);
    const r = rig([storedHighlight('beta gamma delta')]);
    r.fetch.mockRejectedValueOnce(new Error('worker asleep'));
    await r.rehydrator.refresh();
    r.rehydrator.destroy();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps what is painted and does not clear it while retrying', async () => {
    setBody(TEXT);
    const h = storedHighlight('beta gamma delta');
    const r = rig([h]);
    await r.rehydrator.refresh();
    r.fetch.mockRejectedValueOnce(new Error('worker asleep'));
    await r.rehydrator.refresh();
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();
    expect(r.painter.ids).toEqual([h.id]);
    expect(r.painter.clearCalls).toBe(0);
  });
});

describe('siblings: text another highlight owns is never taken over', () => {
  const NEIGHBOUR = 'The daily dose for adults is five tablets taken after food';
  const LOST = 'The daily dose for adults is five tablets taken before food';

  /** The first paragraph (LOST) is gone and the neighbour has moved up into its place. */
  function pageWithLostPassage() {
    setBody(`<p>${LOST}.</p><p>${NEIGHBOUR}.</p>`);
    const neighbour = storedHighlight(NEIGHBOUR);
    const lost = storedHighlight(LOST);
    setBody(`<p>${NEIGHBOUR}.</p>`);
    return { neighbour, lost };
  }

  it('a retry pass of the lost passage alone does not bind it onto the painted neighbour', async () => {
    const { neighbour, lost } = pageWithLostPassage();
    const r = rig([neighbour, lost]);
    await r.rehydrator.refresh();
    expect(r.painter.ids).toEqual([neighbour.id]); // the whole batch protects each other
    expect(r.rehydrator.counts().orphaned).toBe(1);

    // A mutation burst: the pass resolves the unpainted one only. Without the neighbour among the
    // siblings its stored text would be a free, 90 % similar place to land.
    r.rehydrator.retryPass();
    expect(r.painter.ids).toEqual([neighbour.id]);
    expect(r.rehydrator.counts()).toMatchObject({ resolved: 1, changed: 0, orphaned: 1 });
    expect(r.rehydrator.rangeOf(lost.id)).toBeNull();
  });

  it('a saved or restored highlight whose own text is gone does not land on a neighbour either', async () => {
    const { neighbour, lost } = pageWithLostPassage();
    const r = rig([neighbour]);
    await r.rehydrator.refresh();
    expect(r.painter.ids).toEqual([neighbour.id]);

    r.rehydrator.upsert(lost); // e.g. restore of a deleted highlight
    expect(r.painter.ids).toEqual([neighbour.id]);
    expect(r.rehydrator.counts().orphaned).toBe(1);

    r.rehydrator.upsert({ ...lost, id: 'hl-restored-2' }, { stream: buildTextStream() });
    expect(r.painter.ids).toEqual([neighbour.id]);
  });

  it('a load that keeps a locally edited neighbour protects it from the fetched ones', async () => {
    const { neighbour, lost } = pageWithLostPassage();
    const r = rig([neighbour, lost]);
    let release!: (rows: HighlightView[]) => void;
    r.fetch.mockImplementationOnce(
      () => new Promise<HighlightView[]>((resolve) => (release = resolve)),
    );
    const loading = r.rehydrator.refresh();
    await flushPromises();

    r.rehydrator.upsert({ ...neighbour, color: 'green' }); // edited while the request is out
    release([neighbour, lost]);
    await loading;

    expect(r.painter.ids).toEqual([neighbour.id]);
    expect(r.rehydrator.counts()).toMatchObject({ resolved: 1, orphaned: 1 });
  });

  it('still binds an edited passage that no one else owns', async () => {
    setBody('<p>The daily dose for adults is five tablets taken before food each day.</p>');
    const edited = storedHighlight('The daily dose for adults is five tablets taken before food');
    setBody('<p>The daily dose for adults is five tablets taken before meals each day.</p>');
    const other = storedHighlight('each day');
    const r = rig([edited, other]);
    await r.rehydrator.refresh();
    expect(r.rehydrator.counts().changed).toBe(1);
    r.rehydrator.retryPass();
    expect(r.painter.ids).toEqual([edited.id, other.id].sort());
  });
});

describe('no highlight, no stream', () => {
  it('a page without highlights never builds a text stream, however it is looked at', async () => {
    setBody('<p>Alpha beta gamma delta epsilon zeta eta theta.</p>');
    const r = rig([]);
    await r.rehydrator.refresh();
    r.rehydrator.retryPass();
    await r.rehydrator.onRouteChange();
    r.rehydrator.invalidate();
    r.rehydrator.retryPass();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(r.streams.built).toBe(0);
    expect(r.fetch).toHaveBeenCalledTimes(2);
  });

  it('one highlight builds one stream', async () => {
    setBody('<p>Alpha beta gamma delta epsilon zeta eta theta.</p>');
    const r = rig([storedHighlight('beta gamma delta')]);
    r.streams.built = 0;
    await r.rehydrator.refresh();
    expect(r.streams.built).toBe(1);
  });
});

describe('a resolution that fails is an orphan, not a pending highlight', () => {
  it('a page text that cannot be built orphans the batch, and the next pass tries again', async () => {
    setBody('<p>Alpha beta gamma delta epsilon zeta eta theta.</p>');
    const h = storedHighlight('beta gamma delta');
    let broken = true;
    const r = rig([h], {
      buildStream: () => {
        if (broken) throw new Error('walker failed');
        return buildTextStream();
      },
    });
    await r.rehydrator.refresh();
    expect(r.rehydrator.counts()).toMatchObject({ pending: 0, orphaned: 1 });

    broken = false;
    r.rehydrator.retryPass();
    expect(r.painter.ids).toEqual([h.id]);
    expect(r.rehydrator.counts()).toMatchObject({ pending: 0, resolved: 1 });
  });

  it('one anchor the engine cannot handle does not take the rest of the batch down', async () => {
    setBody('<p>Alpha beta gamma delta epsilon zeta eta theta.</p><p>Second paragraph words.</p>');
    const good = storedHighlight('beta gamma delta');
    const bad = storedHighlight('Second paragraph words');
    (bad.anchorSet as { textQuote: unknown }).textQuote = null; // a stored row the engine chokes on
    const r = rig([bad, good]);
    await r.rehydrator.refresh();

    expect(r.painter.ids).toEqual([good.id]);
    expect(r.rehydrator.counts()).toMatchObject({ pending: 0, resolved: 1, orphaned: 1 });
  });

  it('an upsert that cannot be resolved leaves an orphan, never a pending entry', async () => {
    setBody('<p>Alpha beta gamma delta epsilon zeta eta theta.</p>');
    const r = rig([]);
    await r.rehydrator.refresh();
    const bad = storedHighlight('beta gamma delta');
    (bad.anchorSet as { textQuote: unknown }).textQuote = null;
    expect(() => r.rehydrator.upsert(bad)).not.toThrow();
    expect(r.rehydrator.counts()).toMatchObject({ pending: 0, orphaned: 1 });
  });
});

describe('route change', () => {
  it('forgets the old page at once, and loads on request', async () => {
    setBody('<p>Alpha beta gamma delta epsilon zeta eta theta.</p>');
    const h = storedHighlight('beta gamma delta');
    const r = rig([h]);
    await r.rehydrator.refresh();
    const before = r.rehydrator.generation;

    r.page.current = { url: 'https://example.com/b', canonicalUrl: null };
    r.rehydrator.routeChanged();
    expect(r.painter.clearCalls).toBe(1);
    expect(r.rehydrator.has(h.id)).toBe(false);
    expect(r.rehydrator.generation).toBe(before + 1);
    expect(r.fetch).toHaveBeenCalledTimes(1); // nothing loaded yet: that is the caller's debounce
  });

  it('onto the same source keys it forgets nothing (no clear, same generation), still re-resolving on load', async () => {
    setBody('<p>Alpha beta gamma delta epsilon zeta eta theta.</p>');
    const h = storedHighlight('beta gamma delta');
    const r = rig([h]);
    await r.rehydrator.refresh();
    const before = r.rehydrator.generation;

    r.page.current = { ...PAGE_A }; // another object, the same page
    r.rehydrator.routeChanged();
    expect(r.painter.clearCalls).toBe(0);
    expect(r.rehydrator.has(h.id)).toBe(true);
    expect(r.rehydrator.generation).toBe(before);
    expect(r.painter.ids).toEqual([h.id]);

    const built = r.streams.built;
    await r.rehydrator.refresh();
    expect(r.streams.built).toBe(built + 1); // the page text is new: the cached stream went
    expect(r.painter.ids).toEqual([h.id]);
  });

  it('a canonical the worker trusts changes the source key, an untrusted one does not', async () => {
    setBody('<p>Alpha beta gamma delta epsilon zeta eta theta.</p>');
    const r = rig([storedHighlight('beta gamma delta')]);
    await r.rehydrator.refresh();

    // A canonical that names another page is not trusted: the keys are the visited URL's.
    r.page.current = { url: PAGE_A.url, canonicalUrl: 'https://example.com/another-page' };
    r.rehydrator.routeChanged();
    expect(r.painter.clearCalls).toBe(0);

    // The www. spelling of the same page is trusted and becomes the source key.
    r.page.current = { url: PAGE_A.url, canonicalUrl: 'https://www.example.com/a' };
    r.rehydrator.routeChanged();
    expect(r.painter.clearCalls).toBe(1);
  });
});

describe('quiet mode and kinds', () => {
  const TEXT = '<p>Alpha beta gamma delta epsilon zeta eta theta.</p>';

  it('paints the highlight kind with every entry', async () => {
    setBody(TEXT);
    const r = rig([storedHighlight('beta gamma delta', { kind: 'formula' })]);
    await r.rehydrator.refresh();
    expect(r.painter.painted.map((p) => p.kind)).toEqual(['formula']);
  });

  it('publishes nothing while paintEnabled says no, but still resolves and reports', async () => {
    setBody(TEXT);
    const h = storedHighlight('beta gamma delta');
    const state = { paint: false };
    const r = rig([h], { paintEnabled: () => state.paint });
    await r.rehydrator.refresh();

    expect(r.painter.painted).toEqual([]);
    expect(r.rehydrator.counts().resolved).toBe(1);
    expect(r.rehydrator.rangeOf(h.id)?.toString()).toBe('beta gamma delta');
    expect(r.report).toHaveBeenCalledWith([{ id: h.id, status: 'resolved', confidence: 1 }]);

    state.paint = true;
    r.rehydrator.repaint();
    expect(r.painter.ids).toEqual([h.id]);
    state.paint = false;
    r.rehydrator.repaint();
    expect(r.painter.painted).toEqual([]);
  });
});

describe('an orphaned script winds down', () => {
  it('no timer does any work once alive() says the context is gone', async () => {
    setBody('<p>Alpha beta gamma delta epsilon zeta eta theta.</p>');
    const lost = storedHighlight('beta gamma delta');
    lost.anchorSet.textQuote.exact = 'text that is nowhere on this page at all';
    const state = { alive: true };
    const r = rig([lost], { alive: () => state.alive, retry: new RetryBudget(1_000, 20) });
    r.fetch.mockRejectedValueOnce(new Error('asleep'));
    await r.rehydrator.refresh(); // arms the load retry
    state.alive = false;

    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.fetch).toHaveBeenCalledTimes(1);
    expect(r.report).not.toHaveBeenCalled();
    r.rehydrator.retryPass();
    expect(r.streams.built).toBe(0);
  });

  it('the settle and deferred-pass timers stop too', async () => {
    setBody('<p>Alpha beta gamma delta epsilon zeta eta theta.</p>');
    const lost = storedHighlight('beta gamma delta');
    lost.anchorSet.textQuote.exact = 'text that is nowhere on this page at all';
    const state = { alive: true };
    const r = rig([lost], { alive: () => state.alive, retry: new RetryBudget(1_000, 20) });
    await r.rehydrator.refresh(); // orphaned: its report waits for the page to settle
    r.rehydrator.retryPass();
    r.rehydrator.retryPass(); // refused: arms the deferred pass
    const built = r.streams.built;
    state.alive = false;

    await vi.advanceTimersByTimeAsync(10_000);
    expect(r.streams.built).toBe(built);
    expect(r.report).not.toHaveBeenCalled();
  });
});
