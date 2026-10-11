/** Test-only helpers for the overlay (never imported by production code). */
import { configure, createEvent, fireEvent, within } from '@testing-library/dom';
import { act as preactAct } from 'preact/test-utils';
import { vi } from 'vitest';
import {
  defaultSettings,
  type AnchorSet,
  type BankLite,
  type CaptureResult,
  type HighlightView,
  type Settings,
} from '@shared';
import type { CaptureHost, CaptureUi } from '../contract';
import { mountCaptureUi } from './mount';

/** One macrotask turn: every promise continuation already queued has run when it resolves. */
function macrotask(): Promise<void> {
  return new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = () => {
      port1.close();
      resolve();
    };
    port2.postMessage(null);
  });
}

/**
 * The overlay renders with Preact (docs/adr/012; vitest.config.ts routes its `react` imports there),
 * so the tests drive Preact's act instead of React Testing Library's. A synchronous callback is
 * flushed (renders, then effects) before it returns. An async one also waits for the promise chain
 * it started to run out, as React's act does: Preact's returns as soon as the callback's own promise
 * settles, and an `.then()` chained on that promise would still be pending.
 */
export function act(callback: () => Promise<unknown>): Promise<void>;
export function act(callback: () => void): void;
export function act(callback: () => unknown): Promise<void> | void {
  let returned: unknown;
  const flushed = preactAct(() => {
    returned = callback();
    return returned as void | Promise<void>;
  });
  if (typeof (returned as { then?: unknown } | null)?.then !== 'function') return;
  return flushed.then(async () => {
    await macrotask();
    await preactAct(() => undefined);
  });
}

// Every event the Testing Library helpers (and user-event) dispatch is delivered inside act, so the
// DOM is up to date when the call returns.
configure({
  eventWrapper: (dispatch) => {
    let result: unknown;
    act(() => {
      result = dispatch();
    });
    return result;
  },
});

export { createEvent, fireEvent, within };

export const INBOX: BankLite = { id: 'inbox-default', name: 'Inbox', color: 'blue', isInbox: true };
export const BIOLOGY: BankLite = {
  id: 'bank-bio00001',
  name: 'Biology',
  color: 'green',
  isInbox: false,
};

const ANCHOR: AnchorSet = {
  type: 'html',
  textAlgorithm: 'sv-text-v1',
  textQuote: { exact: 'x', prefix: '', suffix: '' },
  textPosition: { start: 0, end: 1 },
  structuralPath: null,
  contentSignature: 'abc',
  documentTextLength: 10,
};

export function makeHighlight(over: Partial<HighlightView> = {}): HighlightView {
  return {
    id: 'hl-00000001',
    sourceId: 'src-00000001',
    exactQuote: 'Mitochondria are the powerhouse of the cell.',
    anchorSet: ANCHOR,
    kind: 'essential',
    color: 'amber',
    priority: 3,
    userComment: '',
    headingContext: null,
    bankIds: [INBOX.id],
    capturedAt: '2026-10-11T10:00:00.000Z',
    resolveStatus: 'resolved',
    resolveConfidence: 1,
    ...over,
  };
}

export function makeResult(over: Partial<CaptureResult> = {}): CaptureResult {
  return {
    status: 'created',
    highlight: makeHighlight(),
    bank: INBOX,
    addedToBank: false,
    ...over,
  };
}

/** A viewport rect. jsdom has no layout, so a plain object stands in for DOMRect. */
export function rect(left = 100, top = 200, width = 120, height = 20): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  };
}

export type MockHost = {
  [K in keyof CaptureHost]: CaptureHost[K] & ReturnType<typeof vi.fn>;
};

export function makeHost(settings: Settings = defaultSettings(), over: Partial<CaptureHost> = {}) {
  const host = {
    settings: vi.fn(() => settings),
    save: vi.fn(async () => makeResult()),
    listBanks: vi.fn(async () => ({ banks: [INBOX, BIOLOGY], lastBankId: BIOLOGY.id })),
    createBank: vi.fn(async (name: string): Promise<BankLite> => ({
      id: 'bank-new00001',
      name,
      color: 'purple',
      isInbox: false,
    })),
    undo: vi.fn(async () => undefined),
    update: vi.fn(async (_id: string, patch: Partial<HighlightView>) => makeHighlight(patch)),
    remove: vi.fn(async () => undefined),
    restore: vi.fn(async () => makeHighlight()),
    dismissSelection: vi.fn(),
    openInSidePanel: vi.fn(async (_highlightId: string | null) => true),
    ...over,
  };
  return host as unknown as MockHost;
}

const mounted: Array<{ ui: CaptureUi; hostEl: HTMLElement }> = [];

/** Mounts the overlay into a real (open) shadow root, the way the extension does. */
export function mountUi(over: { settings?: Settings; host?: Partial<CaptureHost> } = {}) {
  const hostEl = document.createElement('studyvault-overlay');
  hostEl.setAttribute('data-studyvault', '');
  document.documentElement.append(hostEl);
  const shadow = hostEl.attachShadow({ mode: 'open' });
  const container = document.createElement('div');
  shadow.append(container);
  const host = makeHost(over.settings, over.host);
  // The first render is scheduled by React; act flushes it so queries see the tree at once.
  let ui!: CaptureUi;
  act(() => {
    ui = mountCaptureUi({ container, shadowHost: hostEl, host });
  });
  mounted.push({ ui, hostEl });
  return { ui, host, hostEl, shadow, container, q: within(container) };
}

export function cleanupUi(): void {
  for (const { ui, hostEl } of mounted.splice(0)) {
    act(() => ui.destroy());
    hostEl.remove();
  }
  document.body.innerHTML = '';
}

/**
 * What the page logic does on the `focus-toolbar` command: ask the overlay to take keyboard focus.
 * The overlay listens for no key of its own, so there is no key to press here.
 */
export function focusToolbar(ui: CaptureUi): boolean {
  let focused = false;
  act(() => {
    focused = ui.focusToolbar();
  });
  return focused;
}
