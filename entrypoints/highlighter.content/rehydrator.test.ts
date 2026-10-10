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

  it('stops re-resolving after 8 attempts until the route changes', async () => {
    setBody('<p>Lazy loaded section about enzymes and catalysis.</p>');
    const h = storedHighlight('section about enzymes and catalysis');
    setBody('<p>Nothing here.</p>');

    const r = rig([h], { retry: new RetryBudget(8, 30_000) });
    await r.rehydrator.refresh();
    const base = r.streams.built;

    for (let i = 0; i < 20; i++) r.rehydrator.retryPass();
    expect(r.streams.built - base).toBe(8);

    // The content arrives too late for this navigation...
    setBody('<p>Lazy loaded section about enzymes and catalysis.</p>');
    r.rehydrator.retryPass();
    expect(r.painter.ids).toEqual([]);

    // ...but a route change starts a fresh budget (and a fresh fetch).
    await r.rehydrator.onRouteChange();
    expect(r.painter.ids).toEqual([h.id]);
  });

  it('stops re-resolving once 30 s have passed', async () => {
    setBody('<p>Lazy loaded section about enzymes and catalysis.</p>');
    const h = storedHighlight('section about enzymes and catalysis');
    setBody('<p>Nothing here.</p>');
    const r = rig([h]);
    await r.rehydrator.refresh();
    const base = r.streams.built;

    await vi.advanceTimersByTimeAsync(31_000);
    setBody('<p>Lazy loaded section about enzymes and catalysis.</p>');
    r.rehydrator.retryPass();
    expect(r.streams.built).toBe(base);
    expect(r.painter.ids).toEqual([]);
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
