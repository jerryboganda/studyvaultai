import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

const mocks = vi.hoisted(() => ({
  startController: vi.fn(() => ({ ready: Promise.resolve(), destroy: vi.fn() })),
}));
vi.mock('./controller', () => ({ startController: mocks.startController }));
vi.mock('./ui', () => ({ createCaptureUi: vi.fn() }));

const KEY = '__studyvaultContent';

/** The slice of ContentScriptContext the entry uses. */
function ctxStub() {
  const listeners = new Set<() => void>();
  const ctx = {
    isValid: true,
    onInvalidated(cb: () => void) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    invalidate() {
      ctx.isValid = false;
      for (const l of [...listeners]) l();
    },
  };
  return ctx;
}

beforeEach(() => {
  // fake-browser has no manifest; the entry only reads `version` from it.
  vi.spyOn(fakeBrowser.runtime, 'getManifest').mockReturnValue({ version: '1.2.3' } as never);
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[KEY];
  mocks.startController.mockClear();
});

async function definition() {
  const mod = await import('./index');
  return mod.default as unknown as {
    matches: string[];
    registration: string;
    cssInjectionMode: string;
    noScriptStartedPostMessage?: boolean;
    main(ctx: unknown): void;
  };
}

/** What WXT's runtime does with the definition: `main` is split off, the rest are the options. */
async function realContext(name = 'highlighter') {
  const { main: _main, ...options } = await definition();
  const { ContentScriptContext } = await import('wxt/utils/content-script-context');
  return new ContentScriptContext(name, options as never);
}

describe('content script entry', () => {
  it('is a runtime-registered script for http(s) pages with inlined (manual) CSS', async () => {
    const def = await definition();
    expect(def.registration).toBe('runtime');
    // 'manual' keeps WXT from emitting a web_accessible_resources entry; ui/index.tsx inlines the CSS.
    expect(def.cssInjectionMode).toBe('manual');
    expect(def.matches).toEqual(['https://*/*', 'http://*/*']);
  });

  it('boots one controller with the real wiring, even when executed twice', async () => {
    const def = await definition();
    def.main(ctxStub());
    def.main(ctxStub());

    expect(mocks.startController).toHaveBeenCalledTimes(1);
    const calls = mocks.startController.mock.calls as unknown as Array<[Record<string, unknown>]>;
    const deps = calls[0]![0];
    expect(deps.version).toBe('1.2.3');
    expect(deps.win).toBe(window);
    expect(typeof deps.call).toBe('function');
    expect(typeof deps.serve).toBe('function');
    expect(typeof deps.getSettings).toBe('function');
    expect(typeof deps.watchSettings).toBe('function');
    expect(typeof deps.watchDataEpoch).toBe('function');
    expect(typeof deps.createUi).toBe('function');
  });

  describe('privacy: the page is never told the extension id', () => {
    const messageEvents: MessageEvent[] = [];
    const record = (e: Event): void => void messageEvents.push(e as MessageEvent);
    beforeEach(() => {
      messageEvents.length = 0;
      window.addEventListener('message', record);
    });
    afterEach(() => window.removeEventListener('message', record));

    const leaked = (): string[] =>
      messageEvents
        .map((e) => JSON.stringify(e.data))
        .filter((data) => data.includes(String(fakeBrowser.runtime.id)));

    it('opts out of the started-message broadcast', async () => {
      expect((await definition()).noScriptStartedPostMessage).toBe(true);
    });

    it('starting a content script posts no message to the page window', async () => {
      const post = vi.spyOn(window, 'postMessage');
      await realContext();
      expect(post).not.toHaveBeenCalled();
      await new Promise((resolve) => setTimeout(resolve, 20)); // a posted message arrives async
      expect(messageEvents).toEqual([]);
      expect(leaked()).toEqual([]);
    });

    it('the control: without the option WXT does post it (so the test above can fail)', async () => {
      const { ContentScriptContext } = await import('wxt/utils/content-script-context');
      const post = vi.spyOn(window, 'postMessage');
      new ContentScriptContext('highlighter', {} as never);
      expect(post).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(post.mock.calls[0]![0])).toContain(String(fakeBrowser.runtime.id));
    });

    it('a newer injection still supersedes the older script, through the document event', async () => {
      const def = await definition();
      const older = await realContext();
      def.main(older);
      const controller = mocks.startController.mock.results[0]!.value as {
        destroy: ReturnType<typeof vi.fn>;
      };
      expect(older.isValid).toBe(true);

      const newer = await realContext(); // the same script started again in this world
      expect(older.signal.aborted).toBe(true);
      expect(newer.signal.aborted).toBe(false);
      expect(controller.destroy).toHaveBeenCalledTimes(1);

      def.main(newer); // and the slot is free for the newer one
      expect(mocks.startController).toHaveBeenCalledTimes(2);
      expect(leaked()).toEqual([]);
    });
  });

  it('tears the controller down when the context is invalidated and frees the slot', async () => {
    const def = await definition();
    const ctx = ctxStub();
    def.main(ctx);
    const controller = mocks.startController.mock.results[0]!.value as {
      destroy: ReturnType<typeof vi.fn>;
    };
    ctx.invalidate();
    expect(controller.destroy).toHaveBeenCalledTimes(1);

    def.main(ctxStub());
    expect(mocks.startController).toHaveBeenCalledTimes(2);
  });
});
