/** Test-only helpers for the overlay (never imported by production code). */
import { vi } from 'vitest';
import { act, createEvent, fireEvent, within } from '@testing-library/react';
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
 * Sets a text field the way typing would, as far as React can tell. user-event's own typing cannot
 * be used inside a shadow root: it prepares elements from a document-level focus listener, which
 * sees the retargeted shadow host, so React's value tracker misses the change.
 */
export function typeInto(field: HTMLElement, value: string): void {
  fireEvent.change(field, { target: { value } });
}

/** Alt+Shift+T on the document, as a user would press it. Returns the event for default-prevented checks. */
export function pressFocusShortcut(): KeyboardEvent {
  const event = createEvent.keyDown(document.body, {
    key: 'T',
    code: 'KeyT',
    altKey: true,
    shiftKey: true,
  });
  act(() => {
    document.body.dispatchEvent(event);
  });
  return event as KeyboardEvent;
}
