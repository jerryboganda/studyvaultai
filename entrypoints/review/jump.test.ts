import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LOAD_TIMEOUT_MS,
  LOOKING_MESSAGE,
  OPENING_MESSAGE,
  REVEAL_WINDOW_MS,
  openSource,
  type JumpDeps,
  type JumpResult,
} from './jump';

const deps = (over: Partial<JumpDeps> = {}): JumpDeps => ({
  createTab: vi.fn(async () => ({ id: 7 })),
  waitForLoad: vi.fn(async () => true),
  reveal: vi.fn(async () => true),
  extensionUrl: (p) => `chrome-extension://abc/${p}`,
  sleep: vi.fn(async () => undefined),
  ...over,
});

const WEB = {
  highlightId: 'hl-00000001',
  jump: { kind: 'web' as const, url: 'https://example.com/notes#x' },
};

describe('openSource', () => {
  it('opens the PDF reader at the document, page and highlight', async () => {
    const d = deps();
    const out = await openSource(
      {
        highlightId: 'hl-00000001',
        jump: {
          kind: 'pdf',
          documentId: 'a'.repeat(64),
          pageNumber: 7,
          highlightId: 'hl-00000001',
        },
      },
      d,
    );
    expect(out).toMatchObject({ ok: true, scrolled: true });
    const url = (d.createTab as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(url).toBe(
      `chrome-extension://abc/pdf-reader.html?doc=${'a'.repeat(64)}&page=7&highlight=hl-00000001`,
    );
  });

  it('opens a web page and scrolls to the passage when the content script answers', async () => {
    const d = deps();
    const out = await openSource(WEB, d);
    expect(out).toEqual({
      ok: true,
      scrolled: true,
      message: 'Opened the source and showed the passage.',
    });
    expect(d.reveal).toHaveBeenCalledWith(7, 'hl-00000001');
  });

  it('says so when StudyVault is not active on that site, after a bounded number of tries', async () => {
    let clock = 0; // virtual: every pause advances it, nothing really waits
    const d = deps({
      reveal: vi.fn(async () => Promise.reject(new Error('no receiver'))),
      now: () => clock,
      sleep: vi.fn(async (ms: number) => {
        clock += ms;
      }),
    });
    const out = await openSource(WEB, d);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.scrolled).toBe(false);
      expect(out.message).toMatch(/could not show the passage/);
    }
    expect(clock).toBeGreaterThanOrEqual(REVEAL_WINDOW_MS);
    expect(clock).toBeLessThan(REVEAL_WINDOW_MS + 1);
    const tries = vi.mocked(d.reveal).mock.calls.length;
    expect(tries).toBeGreaterThanOrEqual(8);
    expect(tries).toBeLessThanOrEqual(16);
  });

  it('does not wait forever for a page that never finishes loading', async () => {
    const d = deps({ waitForLoad: vi.fn(async () => false) });
    const out = await openSource(WEB, d);
    expect(out).toMatchObject({ ok: true, scrolled: false });
    expect(out.message).toMatch(/slow to load/);
    expect(d.reveal).not.toHaveBeenCalled();
  });

  it('refuses an address that is not http(s), and a card with no source', async () => {
    const d = deps();
    const bad = await openSource(
      { highlightId: 'hl-00000001', jump: { kind: 'web', url: 'javascript:alert(1)' } },
      d,
    );
    expect(bad.ok).toBe(false);
    expect(d.createTab).not.toHaveBeenCalled();
    const none = await openSource({ highlightId: null, jump: null }, d);
    expect(none).toMatchObject({ ok: false });
    expect(none.message).toMatch(/no linked source/);
  });

  it('reports a tab that could not be created', async () => {
    const d = deps({ createTab: vi.fn(async () => Promise.reject(new Error('blocked'))) });
    const out = await openSource(WEB, d);
    expect(out).toMatchObject({ ok: false });
    expect(out.message).toMatch(/blocked/);
  });
});

describe('openSource on a slow machine (fake timers)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const slowDeps = (over: Partial<JumpDeps> = {}) => deps({ sleep, ...over });

  /** Runs openSource to the end while fake time passes; returns result and elapsed fake ms. */
  async function run(
    d: JumpDeps,
    progress: string[] = [],
  ): Promise<{ out: JumpResult; elapsed: number }> {
    const started = Date.now();
    let out: JumpResult | undefined;
    const done = openSource(WEB, d, { onProgress: (m) => progress.push(m) }).then((r) => {
      out = r;
    });
    for (let i = 0; i < 400 && out === undefined; i += 1) await vi.advanceTimersByTimeAsync(250);
    await done;
    return { out: out as JumpResult, elapsed: Date.now() - started };
  }

  it(
    'gives the tab ' + LOAD_TIMEOUT_MS / 1000 + ' s to load, so a page that needs 25 s still works',
    async () => {
      const d = slowDeps({
        waitForLoad: vi.fn(async (_id, timeoutMs) => {
          await sleep(25_000);
          return timeoutMs >= 25_000;
        }),
      });
      const { out } = await run(d);
      expect(d.waitForLoad).toHaveBeenCalledWith(7, LOAD_TIMEOUT_MS);
      expect(out).toMatchObject({ ok: true, scrolled: true });
    },
  );

  it('keeps looking for the passage while the content script starts, and reports progress', async () => {
    const readyAt = Date.now() + 12_000; // the content script answers "found" 12 s from now
    const d = slowDeps({
      reveal: vi.fn(async () => {
        if (Date.now() < readyAt) throw new Error('Could not establish connection');
        return true;
      }),
    });
    const progress: string[] = [];
    const { out, elapsed } = await run(d, progress);
    expect(out).toEqual({
      ok: true,
      scrolled: true,
      message: 'Opened the source and showed the passage.',
    });
    expect(progress).toEqual([OPENING_MESSAGE, LOOKING_MESSAGE]);
    expect(elapsed).toBeGreaterThanOrEqual(12_000);
    expect(elapsed).toBeLessThan(REVEAL_WINDOW_MS);
    // Backoff, not a tight loop: a handful of tries, not one every 250 ms.
    expect(vi.mocked(d.reveal).mock.calls.length).toBeLessThanOrEqual(12);
  });

  it('a highlight the page has not painted yet (found: false) is retried too', async () => {
    const readyAt = Date.now() + 6_000;
    const d = slowDeps({ reveal: vi.fn(async () => Date.now() >= readyAt) });
    const { out } = await run(d);
    expect(out).toMatchObject({ ok: true, scrolled: true });
  });

  it('gives up honestly after the window, with a bounded number of tries', async () => {
    const d = slowDeps({ reveal: vi.fn(async () => false) });
    const progress: string[] = [];
    const { out, elapsed } = await run(d, progress);
    expect(out).toMatchObject({ ok: true, scrolled: false });
    expect(out.message).toMatch(/could not show the passage/);
    expect(progress).toEqual([OPENING_MESSAGE, LOOKING_MESSAGE]);
    expect(elapsed).toBeGreaterThanOrEqual(REVEAL_WINDOW_MS);
    expect(elapsed).toBeLessThan(REVEAL_WINDOW_MS + 3_000);
    const tries = vi.mocked(d.reveal).mock.calls.length;
    expect(tries).toBeGreaterThanOrEqual(8);
    expect(tries).toBeLessThanOrEqual(16);
  });

  it('a page that never loads ends at the load limit with the honest message and no reveal', async () => {
    const d = slowDeps({
      waitForLoad: vi.fn(async (_id, timeoutMs) => {
        await sleep(timeoutMs);
        return false;
      }),
    });
    const progress: string[] = [];
    const { out, elapsed } = await run(d, progress);
    expect(out.message).toBe(
      'Opened the source page; it was slow to load, so the passage was not located.',
    );
    expect(progress).toEqual([OPENING_MESSAGE]);
    expect(elapsed).toBeGreaterThanOrEqual(LOAD_TIMEOUT_MS);
    expect(d.reveal).not.toHaveBeenCalled();
  });
});
