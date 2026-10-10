import { act, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { makeHost, rect } from './testHarness';

interface FakeCall {
  options: {
    name: string;
    position: string;
    mode?: string;
    isolateEvents?: boolean | string[];
    anchor?: () => Element;
    append?: string;
  };
  shadowHost: HTMLElement;
  shadow: ShadowRoot;
  markedAtMount: boolean | null;
  removed: number;
}

const calls = vi.hoisted(() => [] as unknown[]);

// WXT's real createShadowRootUi fetches the injected stylesheet through chrome.runtime; this stand-in
// keeps its contract (host appended at the anchor, onMount/onRemove) so index.tsx runs unchanged.
vi.mock('wxt/utils/content-script-ui/shadow-root', () => ({
  createShadowRootUi: vi.fn(
    async (_ctx: unknown, options: FakeCall['options'] & Record<string, unknown>) => {
      const shadowHost = document.createElement(options.name);
      const shadow = shadowHost.attachShadow({ mode: 'open' });
      const uiContainer = document.createElement('div');
      shadow.append(uiContainer);
      let mounted: unknown;
      const call: FakeCall = { options, shadowHost, shadow, markedAtMount: null, removed: 0 };
      calls.push(call);
      return {
        shadowHost,
        shadow,
        uiContainer,
        get mounted() {
          return mounted;
        },
        mount() {
          call.markedAtMount = shadowHost.hasAttribute('data-studyvault');
          options.anchor?.().append(shadowHost);
          mounted = (options.onMount as (...a: unknown[]) => unknown)(
            uiContainer,
            shadow,
            shadowHost,
          );
        },
        remove() {
          call.removed += 1;
          (options.onRemove as ((m: unknown) => void) | undefined)?.(mounted);
          shadowHost.remove();
          mounted = undefined;
        },
      };
    },
  ),
}));

afterEach(() => {
  for (const call of calls.splice(0) as FakeCall[]) call.shadowHost.remove();
});

async function create() {
  const { createCaptureUi } = await import('./index');
  const host = makeHost();
  let ui!: Awaited<ReturnType<typeof createCaptureUi>>;
  // The first render is scheduled by React; act flushes it.
  await act(async () => {
    ui = await createCaptureUi({} as ContentScriptContext, host);
  });
  const call = calls[calls.length - 1] as FakeCall;
  return { ui, host, call, q: within(call.shadow as unknown as HTMLElement) };
}

describe('createCaptureUi', () => {
  it('builds a Shadow DOM host marked for the text stream, appended to <html>', async () => {
    const { call } = await create();
    expect(call.options.name).toBe('studyvault-overlay');
    expect(call.shadowHost.localName).toBe('studyvault-overlay');
    expect(call.shadowHost.hasAttribute('data-studyvault')).toBe(true);
    // Marked before it enters the page, so observers never see an unmarked host.
    expect(call.markedAtMount).toBe(true);
    expect(call.shadowHost.parentElement).toBe(document.documentElement);
    expect(call.options.anchor?.()).toBe(document.documentElement);
  });

  it('leaves layout to the stylesheet and keeps page hotkeys out of the overlay', async () => {
    const { call } = await create();
    expect(call.options.position).toBe('inline');
    expect(call.options.isolateEvents).toBe(true);
    // Closed in every build except `--mode e2e`, where Playwright needs to pierce it.
    expect(call.options.mode).toBe('closed');
  });

  it('renders through the returned CaptureUi and applies the theme to the host', async () => {
    const { ui, call, q } = await create();
    expect(call.shadowHost.getAttribute('data-theme')).toBe('system');
    act(() => ui.showToolbar({ text: 'hello', rect: rect() }));
    expect(q.getByRole('toolbar')).toBeTruthy();
    act(() => ui.toast({ text: 'Hello there', tone: 'info' }));
    expect(q.getByText('Hello there')).toBeTruthy();
  });

  it('destroy removes the host and tears the tree down, and is safe to repeat', async () => {
    const { ui, call } = await create();
    act(() => ui.destroy());
    expect(call.shadowHost.isConnected).toBe(false);
    expect(call.shadow.querySelector('[role="toolbar"]')).toBeNull();
    expect(() => act(() => ui.destroy())).not.toThrow();
  });
});
