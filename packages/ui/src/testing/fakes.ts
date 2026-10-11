/** Test-only doubles for the extension pages (never imported by production code). */
import { vi } from 'vitest';
import {
  StudyVaultError,
  type AnchorSet,
  type BankLite,
  type HighlightPatch,
  type HighlightView,
  type SiteStatus,
} from '@shared';
import type { HighlightListItem } from '@storage';

// ---------------------------------------------------------------------------------------------
// Data builders
// ---------------------------------------------------------------------------------------------

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
  documentTextLength: 100,
};

let counter = 0;

export function makeItem(
  over: {
    highlight?: Partial<HighlightView>;
    source?: Partial<HighlightListItem['source']>;
    banks?: BankLite[];
    start?: number;
  } = {},
): HighlightListItem {
  counter += 1;
  const n = String(counter).padStart(8, '0');
  const start = over.start ?? counter * 10;
  const exact = over.highlight?.exactQuote ?? `Quote number ${n}.`;
  return {
    highlight: {
      id: `hl-${n}`,
      sourceId: 'src-00000001',
      exactQuote: exact,
      anchorSet: {
        ...ANCHOR,
        textQuote: { exact, prefix: '', suffix: '' },
        textPosition: { start, end: start + exact.length },
      },
      kind: 'essential',
      color: 'amber',
      priority: 3,
      userComment: '',
      headingContext: null,
      bankIds: [INBOX.id],
      capturedAt: `2026-10-11T10:00:${String(counter % 60).padStart(2, '0')}.000Z`,
      resolveStatus: 'resolved',
      resolveConfidence: 1,
      ...over.highlight,
    },
    source: {
      id: 'src-00000001',
      title: 'Cell biology notes',
      host: 'example.com',
      originalUrl: 'https://example.com/notes',
      canonicalUrl: null,
      urlKey: 'https://example.com/notes',
      ...over.source,
    },
    banks: over.banks ?? [INBOX],
  };
}

export function siteStatus(over: Partial<SiteStatus> = {}): SiteStatus {
  return {
    supported: true,
    denied: false,
    pattern: 'https://example.com/*',
    access: 'none',
    active: false,
    allSites: false,
    ...over,
  };
}

// ---------------------------------------------------------------------------------------------
// In-memory @storage
// ---------------------------------------------------------------------------------------------

/**
 * Stand-in for the @storage functions the pages use. `observe` re-runs its query after every
 * mutation, like Dexie's liveQuery. Every mutating call is recorded in `calls`.
 */
export class FakeStore {
  items: HighlightListItem[] = [];
  banks: BankLite[] = [INBOX];
  calls: Array<{ fn: string; args: unknown[] }> = [];
  failNext: Partial<Record<string, Error>> = {};
  private watchers = new Set<() => void>();
  private trash = new Map<string, HighlightListItem>();
  /** Items whose source is the page being viewed; `listPageHighlights` returns these. */
  pageIds = new Set<string>();

  reset(items: HighlightListItem[] = [], pageIds: string[] | 'all' = 'all') {
    this.items = [...items];
    this.pageIds = new Set(pageIds === 'all' ? items.map((i) => i.highlight.id) : pageIds);
    this.banks = [INBOX];
    this.calls = [];
    this.failNext = {};
    this.watchers.clear();
    this.trash.clear();
  }

  notify() {
    for (const run of [...this.watchers]) run();
  }

  private record(fn: string, args: unknown[]) {
    this.calls.push({ fn, args });
    const err = this.failNext[fn];
    if (err) {
      delete this.failNext[fn];
      throw err;
    }
  }

  private find(id: string) {
    const item = this.items.find((i) => i.highlight.id === id);
    if (!item) throw new StudyVaultError('not_found', 'Highlight not found');
    return item;
  }

  readonly module = {
    observe: <T>(query: () => Promise<T>) => ({
      subscribe: (next: (v: T) => void, error?: (e: unknown) => void) => {
        let live = true;
        const run = () => {
          query().then(
            (v) => live && next(v),
            (e: unknown) => live && error?.(e),
          );
        };
        this.watchers.add(run);
        run();
        return () => {
          live = false;
          this.watchers.delete(run);
        };
      },
    }),
    listPageHighlights: async (url: string, canonicalUrl: string | null) => {
      this.record('listPageHighlights', [url, canonicalUrl]);
      return this.items.filter((i) => this.pageIds.has(i.highlight.id));
    },
    listRecentHighlights: async (limit: number) => {
      this.record('listRecentHighlights', [limit]);
      return [...this.items]
        .sort((a, b) => b.highlight.capturedAt.localeCompare(a.highlight.capturedAt))
        .slice(0, limit);
    },
    listBanks: async () => [...this.banks],
    listBanksWithCounts: async () =>
      this.banks.map((bank) => ({
        bank,
        count: this.items.filter((i) => i.banks.some((b) => b.id === bank.id)).length,
      })),
    createBank: async (name: string) => {
      this.record('createBank', [name]);
      const bank: BankLite = {
        id: `bank-new${String(this.banks.length).padStart(4, '0')}`,
        name: name.trim(),
        color: 'teal',
        isInbox: false,
      };
      this.banks = [...this.banks, bank];
      this.notify();
      return bank;
    },
    updateHighlight: async (id: string, patch: HighlightPatch) => {
      this.record('updateHighlight', [id, patch]);
      const item = this.find(id);
      Object.assign(item.highlight, patch);
      this.notify();
      return item.highlight;
    },
    softDeleteHighlight: async (id: string) => {
      this.record('softDeleteHighlight', [id]);
      const item = this.find(id);
      this.items = this.items.filter((i) => i !== item);
      this.trash.set(id, item);
      this.notify();
    },
    wipeAllData: async () => {
      this.record('wipeAllData', []);
      this.items = [];
      this.banks = [INBOX];
      this.trash.clear();
      this.notify();
    },
    restoreHighlight: async (id: string) => {
      this.record('restoreHighlight', [id]);
      const back = this.trash.get(id);
      if (!back) throw new StudyVaultError('not_found', 'Highlight not found');
      this.items.push(back);
      this.trash.delete(id);
      this.notify();
      return back.highlight;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------------------------

type Handler = (payload: never) => unknown;

/** Programmable `callBackground` / `callTab`: register a handler per message type. */
export class FakeRpc {
  background: Record<string, Handler> = {};
  tab: Record<string, Handler> = {};
  calls: Array<{ side: 'background' | 'tab'; type: string; tabId?: number; payload: unknown }> = [];

  reset() {
    this.background = {};
    this.tab = {};
    this.calls = [];
  }

  callBackground = async (type: string, payload: unknown): Promise<unknown> => {
    this.calls.push({ side: 'background', type, payload });
    const handler = this.background[type];
    if (!handler) throw new StudyVaultError('not_found', `No fake handler for ${type}`);
    return handler(payload as never);
  };

  callTab = async (tabId: number, type: string, payload: unknown): Promise<unknown> => {
    this.calls.push({ side: 'tab', type, tabId, payload });
    const handler = this.tab[type];
    if (!handler) {
      throw new StudyVaultError('unsupported_page', 'Could not establish connection. No receiver.');
    }
    return handler(payload as never);
  };

  called(type: string) {
    return this.calls.filter((c) => c.type === type);
  }
}

// ---------------------------------------------------------------------------------------------
// Chrome namespaces fakeBrowser does not implement
// ---------------------------------------------------------------------------------------------

function event() {
  const listeners = new Set<(...args: never[]) => unknown>();
  return {
    addListener: (l: (...args: never[]) => unknown) => listeners.add(l),
    removeListener: (l: (...args: never[]) => unknown) => listeners.delete(l),
    hasListeners: () => listeners.size > 0,
    emit: (...args: never[]) => listeners.forEach((l) => l(...args)),
  };
}

/** What `commands.getAll` answers with the manifest's suggested keys (wxt.config.ts). */
export const COMMANDS = [
  {
    name: 'open-side-panel',
    description: 'Open the StudyVault side panel',
    shortcut: 'Alt+Shift+S',
  },
  { name: 'quick-save', description: 'Quick-save the current selection', shortcut: 'Alt+Shift+H' },
  {
    name: 'focus-toolbar',
    description: 'Move keyboard focus into the selection toolbar',
    shortcut: 'Alt+Shift+Y',
  },
  {
    name: 'next-highlight',
    description: 'Go to the next highlight on the page',
    shortcut: 'Alt+Shift+Period',
  },
  {
    name: 'previous-highlight',
    description: 'Go to the previous highlight on the page',
    shortcut: '',
  },
];

export function makeChromeFakes() {
  return {
    commands: {
      getAll: vi.fn(async () => COMMANDS.map((c) => ({ ...c }))),
      onCommand: event(),
    },
    permissions: {
      request: vi.fn(async (_p: { origins?: string[] }) => true),
      remove: vi.fn(async (_p: { origins?: string[] }) => true),
      contains: vi.fn(async (_p: { origins?: string[] }) => false),
      getAll: vi.fn(async () => ({ origins: [] as string[], permissions: [] as string[] })),
      onAdded: event(),
      onRemoved: event(),
    },
    sidePanel: { open: vi.fn(async (_o: { windowId?: number }) => undefined) },
  };
}

/** Singletons: `vi.mock` factories and the test file must see the same instances. */
export const store = new FakeStore();
export const rpc = new FakeRpc();
