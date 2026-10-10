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
    main(ctx: unknown): void;
  };
}

describe('content script entry', () => {
  it('is a runtime-registered, ui-mode script for http(s) pages', async () => {
    const def = await definition();
    expect(def.registration).toBe('runtime');
    expect(def.cssInjectionMode).toBe('ui');
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
