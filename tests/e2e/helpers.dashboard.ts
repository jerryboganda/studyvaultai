import AxeBuilder from '@axe-core/playwright';
import { settleAnimations } from './axeSettle';
import type { Locator, Page } from '@playwright/test';
import {
  BankRecord as BankRecordSchema,
  DEFAULT_PALETTE,
  Folder as FolderSchema,
  Highlight as HighlightSchema,
  HighlightBank as HighlightBankSchema,
  HighlightTag as HighlightTagSchema,
  INBOX_BANK_ID,
  Note as NoteSchema,
  SCHEMA_VERSION,
  Source as SourceSchema,
  Tag as TagSchema,
  type ColorId,
  type HighlightKind,
  type ResolveStatus,
} from '@shared';
import { bg, bgData, expect, test, type Env } from './helpers.pages';

export { expect, test };
export type { Env };

/**
 * Helpers for dashboard.spec.ts (the full-page knowledge workspace, dashboard.html).
 *
 * Everything drives real Chromium with the real built extension. Nothing mocks a Chrome API or the
 * vault.
 *
 * SEEDING (documented once, used everywhere)
 * ------------------------------------------
 * Node cannot import @storage (Dexie and wxt/browser need an extension context), so data reaches the
 * vault in exactly two real ways:
 *
 *  1. THROUGH THE PRODUCT: `captureQuote()` sends the extension's own `capture.save` RPC from an
 *     extension page (extension callers have no sender restrictions), and `createBankRpc()` sends
 *     `bank.create`. The worker validates, hashes and stores exactly as it does for a real capture.
 *     The few tests that prove the end-to-end path also use the real toolbar on fixture pages.
 *
 *  2. BULK, BYPASSING THE CAPTURE PATH: `buildDataset()` turns a declarative description (banks,
 *     folders, tags, sources, highlights with places / tags / notes / custom fields) into rows in the
 *     exact shapes of packages/shared (schemaVersion 1, ISO dates, 64-character quote hashes, the
 *     Inbox row `inbox-default`). Every row is validated in Node with the product's own Zod schemas
 *     before it is written, so a synthetic row can never be "schema-invalid by accident".
 *     `writeDataset()` then writes the rows with `indexedDB.open('studyvault')` from an extension
 *     page: one readwrite transaction per chunk, `put` semantics, no schema version change.
 *     Call `ensureVault()` first (it makes the worker create the v3 database).
 *
 * Seed BEFORE the first dashboard load. A raw write does not bump the cross-context data epoch and
 * the dashboard's search index only catches up on rows whose `updatedAt` is recent, so rows seeded
 * under an already running dashboard need `updatedAt: <now>` and a reload.
 */

// -----------------------------------------------------------------------------------------------
// Opening pages
// -----------------------------------------------------------------------------------------------

// Tall on purpose: the list is windowed, and a taller window shows more rows per scroll step.
export const VIEWPORT = { width: 1440, height: 1800 } as const;

const WATCH = new WeakMap<Page, { errors: string[]; external: string[] }>();

function watch(page: Page): void {
  const state = { errors: [] as string[], external: [] as string[] };
  WATCH.set(page, state);
  page.on('pageerror', (err) => state.errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') state.errors.push(`console.error: ${msg.text()}`);
  });
  page.on('request', (request) => {
    const url = request.url();
    if (/^(https?|ftp|ws)s?:/i.test(url)) state.external.push(url);
  });
}

/** Uncaught exceptions and console.error output of a page opened by these helpers. */
export const pageErrors = (page: Page): string[] => WATCH.get(page)?.errors ?? [];
/** http(s) requests a dashboard page made. The dashboard is local-first: expected to be none. */
export const externalRequests = (page: Page): string[] => WATCH.get(page)?.external ?? [];

/** An extension page used as a trusted control surface (same origin as the vault's database). */
export async function openControl(env: Env): Promise<Page> {
  const page = await env.context.newPage();
  await page.goto(`chrome-extension://${env.extensionId}/options.html`);
  return page;
}

export interface DashTarget {
  q?: string;
  bank?: string;
  highlight?: string;
}

/** Page-side recorder installed before the dashboard's scripts run (see `probeOf`). */
function installProbe(): void {
  const probe = { firstRowAt: null as number | null, status: [] as string[] };
  (window as unknown as { __svProbe: typeof probe }).__svProbe = probe;
  const scan = () => {
    if (probe.firstRowAt === null && document.querySelector('[data-testid="result-row"]')) {
      probe.firstRowAt = performance.now();
    }
    const el = document.querySelector('.dash-search__status');
    const text = (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const head =
      /^(Opening the search index|Building the search index|Rebuilding as requested|Items were permanently deleted)/.exec(
        text,
      )?.[1];
    if (head && probe.status[probe.status.length - 1] !== head) probe.status.push(head);
  };
  new MutationObserver(scan).observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
  });
}

export interface Probe {
  /** ms since navigation start when the first list row was in the DOM (null: none yet). */
  firstRowAt: number | null;
  /** Distinct index states the search bar announced, in order ("Building the search index", ...). */
  status: string[];
}

export async function probeOf(page: Page): Promise<Probe> {
  return page.evaluate(
    () => (window as unknown as { __svProbe: Probe }).__svProbe ?? { firstRowAt: null, status: [] },
  );
}

export function dashboardHref(env: Env, target: DashTarget = {}): string {
  const params = new URLSearchParams();
  if (target.highlight) params.set('highlight', target.highlight);
  if (target.bank) params.set('bank', target.bank);
  if (target.q) params.set('q', target.q);
  const query = params.toString();
  return `chrome-extension://${env.extensionId}/dashboard.html${query ? `?${query}` : ''}`;
}

/** Open dashboard.html in a new tab at a desktop size (three docked panes) and wait for the list. */
export async function openDashboard(
  env: Env,
  target: DashTarget = {},
  options: { settle?: boolean } = {},
): Promise<Page> {
  const page = await env.context.newPage();
  await page.setViewportSize(VIEWPORT);
  watch(page);
  await page.addInitScript(installProbe);
  await page.goto(dashboardHref(env, target));
  await expect(page.getByTestId('dashboard')).toBeVisible();
  if (options.settle !== false) await settle(page);
  return page;
}

/** The library list has finished its first load of the current query (rows or an empty state). */
export async function settle(page: Page, timeout = 15_000): Promise<void> {
  await expect(page.getByTestId('list-loading')).toHaveCount(0, { timeout });
  await expect(page.getByTestId('result-summary')).toHaveText(
    /^\s*[\d,]+ (highlights?|results?)|^\s*[\d,]+ loaded/,
    { timeout },
  );
}

// -----------------------------------------------------------------------------------------------
// Vault access from an extension page
// -----------------------------------------------------------------------------------------------

/** Make the worker create the v3 database (a raw open without a version would create an empty v1). */
export async function ensureVault(ctrl: Page): Promise<void> {
  await bgData(ctrl, 'banks.list');
  await expect
    .poll(
      () =>
        ctrl.evaluate(async () => {
          const found = (await indexedDB.databases()).find((d) => d.name === 'studyvault');
          return found?.version ?? 0;
        }),
      { message: 'the vault database should exist at schema v3 (IndexedDB version 30)' },
    )
    .toBeGreaterThanOrEqual(30);
}

export type TableName =
  | 'banks'
  | 'folders'
  | 'tags'
  | 'sources'
  | 'highlights'
  | 'highlightBanks'
  | 'highlightTags'
  | 'notes'
  | 'meta'
  | 'documents'
  | 'attachments'
  | 'knowledgePoints'
  | 'cards'
  | 'reviewLogs'
  | 'aiResults'
  | 'ocrPages';

/** Raw `put` of rows into object stores of the existing database (one readwrite transaction). */
export async function rawPut(
  ctrl: Page,
  rows: Partial<Record<TableName, readonly unknown[]>>,
): Promise<void> {
  await ctrl.evaluate(async (payload) => {
    const known = await indexedDB.databases();
    if (!known.some((d) => d.name === 'studyvault')) {
      throw new Error('the vault database does not exist yet: call ensureVault() first');
    }
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('studyvault');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      const names = Object.keys(payload);
      if (names.length === 0) return;
      const tx = db.transaction(names, 'readwrite');
      const done = new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
      });
      for (const [name, list] of Object.entries(payload)) {
        const store = tx.objectStore(name);
        for (const row of list as unknown[]) store.put(row);
      }
      await done;
    } finally {
      db.close();
    }
  }, rows);
}

/** Every row of a table (raw read; opened without a version so it can never upgrade). */
export async function readTable<T = Record<string, unknown>>(
  ctrl: Page,
  table: TableName,
): Promise<T[]> {
  return ctrl.evaluate(async (name) => {
    const known = await indexedDB.databases();
    if (!known.some((d) => d.name === 'studyvault')) return [];
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('studyvault');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      return await new Promise<unknown[]>((resolve, reject) => {
        const req = db.transaction(name, 'readonly').objectStore(name).getAll();
        req.onsuccess = () => resolve(req.result as unknown[]);
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  }, table) as Promise<T[]>;
}

/** Row count of several tables. */
export async function countTables(
  ctrl: Page,
  tables: readonly TableName[],
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const name of tables) out[name] = (await readTable(ctrl, name)).length;
  return out;
}

export interface StoredHighlight {
  id: string;
  sourceId: string;
  exactQuote: string;
  normalizedQuote: string;
  quoteHash: string;
  anchorSet: unknown;
  kind: string;
  color: string;
  priority: number;
  userComment: string;
  headingContext: string | null;
  capturedAt: string;
  updatedAt: string;
  deletedAt: string | null;
  capturedUrl?: string;
  capturedTitle?: string;
  customFields?: Record<string, string | number | boolean>;
}

export const storedHighlights = (ctrl: Page) => readTable<StoredHighlight>(ctrl, 'highlights');

// -----------------------------------------------------------------------------------------------
// Product-path seeding
// -----------------------------------------------------------------------------------------------

export interface QuoteInput {
  url: string;
  title: string;
  quote: string;
  /** Bank id; default is the Inbox (explicit, so "last used bank" never redirects a seed). */
  bankId?: string;
  kind?: HighlightKind;
  priority?: 1 | 2 | 3 | 4 | 5;
  comment?: string;
  heading?: string | null;
  /** Offset in the page's text stream; distinct values keep same-quote captures apart. */
  at?: number;
}

export interface Captured {
  id: string;
  status: 'created' | 'duplicate' | 'restored';
}

/** `capture.save` through the worker, from an extension page. */
export async function captureQuote(ctrl: Page, input: QuoteInput): Promise<Captured> {
  const at = input.at ?? 0;
  const kind = input.kind ?? 'essential';
  const result = await bgData<{ status: Captured['status']; highlight: { id: string } }>(
    ctrl,
    'capture.save',
    {
      page: { url: input.url, canonicalUrl: null, title: input.title },
      exactQuote: input.quote,
      anchorSet: {
        type: 'html',
        textAlgorithm: 'sv-text-v1',
        textQuote: { exact: input.quote, prefix: '', suffix: '' },
        textPosition: { start: at, end: at + input.quote.length },
        structuralPath: null,
        contentSignature: 'e2e-dash',
        documentTextLength: 100_000,
      },
      headingContext: input.heading ?? null,
      kind,
      color: DEFAULT_PALETTE[kind],
      bankId: input.bankId ?? INBOX_BANK_ID,
      userComment: input.comment ?? '',
      priority: input.priority ?? 3,
      captureMethod: 'toolbar',
    },
  );
  return { id: result.highlight.id, status: result.status };
}

/** `bank.create` through the worker; returns the new bank's id. */
export async function createBankRpc(ctrl: Page, name: string): Promise<string> {
  const bank = await bgData<{ id: string }>(ctrl, 'bank.create', { name });
  return bank.id;
}

export { bg, bgData };

// -----------------------------------------------------------------------------------------------
// Bulk seeding: declarative dataset -> schema-valid rows
// -----------------------------------------------------------------------------------------------

export interface PlaceSpec {
  /** Bank key ('inbox' is the protected Inbox). */
  bank: string;
  folder?: string | null;
}

export interface NoteSpec {
  title?: string;
  body: string;
  pinned?: boolean;
}

export interface HighlightSpec {
  key: string;
  quote: string;
  /** Source key. */
  source: string;
  /** Default: the Inbox. */
  places?: PlaceSpec[];
  kind?: HighlightKind;
  priority?: 1 | 2 | 3 | 4 | 5;
  status?: ResolveStatus;
  comment?: string;
  heading?: string | null;
  capturedAt?: string;
  updatedAt?: string;
  /** Tag keys. */
  tags?: string[];
  notes?: NoteSpec[];
  fields?: Record<string, string | number | boolean>;
  trashed?: boolean;
}

export interface DatasetInput {
  banks?: Array<{ key: string; name: string; color?: ColorId; icon?: string }>;
  folders?: Array<{ key: string; bank: string; parent?: string | null; name: string }>;
  tags?: Array<{ key: string; name: string }>;
  sources: Array<{ key: string; url: string; title: string }>;
  highlights: HighlightSpec[];
}

export interface Dataset {
  input: DatasetInput;
  rows: {
    banks: unknown[];
    folders: unknown[];
    tags: unknown[];
    sources: unknown[];
    highlights: unknown[];
    highlightBanks: unknown[];
    highlightTags: unknown[];
    notes: unknown[];
  };
  /** Key -> id. */
  id: {
    bank(key: string): string;
    folder(key: string): string;
    tag(key: string): string;
    src(key: string): string;
    hl(key: string): string;
  };
}

/** 1 March 2026, 12:00 UTC: far from every date boundary in any time zone. */
export const BASE_TIME = Date.UTC(2026, 2, 1, 12, 0, 0);
export const DAY_MS = 86_400_000;
const KEY = /^[0-9A-Za-z_-]{1,40}$/;

/** Deterministic stand-in for SHA-256: 64 hex characters, equal for equal text. */
export function hash64(text: string): string {
  let out = '';
  for (let seed = 0; seed < 8; seed++) {
    let h = (0x811c9dc5 ^ Math.imul(seed + 1, 0x9e3779b1)) >>> 0;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out += h.toString(16).padStart(8, '0');
  }
  return out;
}

export function buildDataset(
  input: DatasetInput,
  options: { validate?: 'all' | 'sample' } = {},
): Dataset {
  const ids = {
    bank: (key: string) => (key === 'inbox' ? INBOX_BANK_ID : `e2e-bank-${key}`),
    folder: (key: string) => `e2e-folder-${key}`,
    tag: (key: string) => `e2e-tag-${key}`,
    src: (key: string) => `e2e-src-${key}`,
    hl: (key: string) => `e2e-hl-${key}`,
  };
  const check = (key: string) => {
    if (!KEY.test(key)) throw new Error(`dataset key "${key}" must match ${KEY}`);
    return key;
  };
  const created = new Date(Date.UTC(2026, 0, 1)).toISOString();
  const meta = { schemaVersion: SCHEMA_VERSION, createdAt: created, updatedAt: created };

  const banks: unknown[] = [
    {
      ...meta,
      id: INBOX_BANK_ID,
      deletedAt: null,
      name: 'Inbox',
      color: 'blue',
      position: 0,
      isInbox: true,
    },
  ];
  (input.banks ?? []).forEach((b, i) => {
    banks.push({
      ...meta,
      id: ids.bank(check(b.key)),
      deletedAt: null,
      name: b.name,
      color: b.color ?? 'blue',
      position: i + 1,
      isInbox: false,
      ...(b.icon ? { icon: b.icon } : {}),
    });
  });

  const folderPositions = new Map<string, number>();
  const folders = (input.folders ?? []).map((f) => {
    const slot = `${f.bank}/${f.parent ?? ''}`;
    const position = (folderPositions.get(slot) ?? 0) + 1;
    folderPositions.set(slot, position);
    return {
      ...meta,
      id: ids.folder(check(f.key)),
      deletedAt: null,
      bankId: ids.bank(f.bank),
      parentFolderId: f.parent ? ids.folder(f.parent) : null,
      name: f.name,
      position,
    };
  });

  const tags = (input.tags ?? []).map((t) => ({
    ...meta,
    id: ids.tag(check(t.key)),
    deletedAt: null,
    name: t.name,
    nameKey: t.name.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase(),
    color: null,
    aliases: [] as string[],
  }));

  const sourceById = new Map<string, { url: string; title: string }>();
  const sources = input.sources.map((s) => {
    sourceById.set(s.key, s);
    return {
      ...meta,
      id: ids.src(check(s.key)),
      deletedAt: null,
      type: 'web' as const,
      urlKey: s.url,
      visitedKey: s.url,
      originalUrl: s.url,
      canonicalUrl: null,
      host: new URL(s.url).hostname,
      title: s.title,
    };
  });

  const highlights: unknown[] = [];
  const highlightBanks: unknown[] = [];
  const highlightTags: unknown[] = [];
  const notes: unknown[] = [];
  input.highlights.forEach((h, n) => {
    const source = sourceById.get(h.source);
    if (!source) throw new Error(`highlight ${h.key}: unknown source ${h.source}`);
    const kind = h.kind ?? 'essential';
    const capturedAt = h.capturedAt ?? new Date(BASE_TIME + n * 60_000).toISOString();
    const updatedAt = h.updatedAt ?? capturedAt;
    const id = ids.hl(check(h.key));
    const start = n * 1_000;
    highlights.push({
      schemaVersion: SCHEMA_VERSION,
      createdAt: capturedAt,
      updatedAt,
      deletedAt: h.trashed ? new Date(Date.parse(updatedAt) + 5 * 60_000).toISOString() : null,
      id,
      sourceId: ids.src(h.source),
      exactQuote: h.quote,
      normalizedQuote: h.quote.toLowerCase(),
      quoteHash: hash64(h.quote),
      anchorSet: {
        type: 'html',
        textAlgorithm: 'sv-text-v1',
        textQuote: { exact: h.quote, prefix: '', suffix: '' },
        textPosition: { start, end: start + h.quote.length },
        structuralPath: null,
        contentSignature: 'e2e-seed',
        documentTextLength: 1_000_000,
      },
      kind,
      color: DEFAULT_PALETTE[kind],
      priority: h.priority ?? 3,
      userComment: h.comment ?? '',
      headingContext: h.heading ?? null,
      captureMethod: 'toolbar',
      capturedAt,
      resolveStatus: h.status ?? 'unchecked',
      resolveConfidence: null,
      lastResolvedAt: null,
      capturedUrl: source.url,
      capturedTitle: source.title,
      ...(h.fields ? { customFields: h.fields } : {}),
    });
    for (const place of h.places ?? [{ bank: 'inbox' }]) {
      highlightBanks.push({
        highlightId: id,
        bankId: ids.bank(place.bank),
        folderId: place.folder ? ids.folder(place.folder) : null,
        addedAt: capturedAt,
      });
    }
    for (const tag of h.tags ?? []) {
      highlightTags.push({ highlightId: id, tagId: ids.tag(tag), addedAt: capturedAt });
    }
    (h.notes ?? []).forEach((note, i) => {
      notes.push({
        ...meta,
        id: `e2e-note-${h.key}-${i}`,
        createdAt: capturedAt,
        updatedAt,
        deletedAt: null,
        highlightId: id,
        sourceId: ids.src(h.source),
        title: note.title ?? '',
        body: note.body,
        pinned: note.pinned ?? false,
      });
    });
  });

  // The product's own schemas decide validity (a sample for the 10k workload keeps Node fast).
  const sampled = <T>(rows: T[]): T[] =>
    options.validate === 'sample'
      ? rows.filter((_, i) => i % 97 === 0 || i === rows.length - 1)
      : rows;
  const parse = (schema: { parse(v: unknown): unknown }, rows: unknown[]) => {
    for (const row of sampled(rows)) schema.parse(row);
  };
  parse(BankRecordSchema, banks);
  parse(FolderSchema, folders);
  parse(TagSchema, tags);
  parse(SourceSchema, sources);
  parse(HighlightSchema, highlights);
  parse(HighlightBankSchema, highlightBanks);
  parse(HighlightTagSchema, highlightTags);
  parse(NoteSchema, notes);

  return {
    input,
    rows: { banks, folders, tags, sources, highlights, highlightBanks, highlightTags, notes },
    id: ids,
  };
}

/** Write a dataset into the vault in chunks (see the SEEDING note at the top of this file). */
export async function writeDataset(ctrl: Page, ds: Dataset, chunk = 1_500): Promise<void> {
  for (const [table, list] of Object.entries(ds.rows)) {
    for (let i = 0; i < list.length; i += chunk) {
      await rawPut(ctrl, { [table]: list.slice(i, i + chunk) } as Partial<
        Record<TableName, unknown[]>
      >);
    }
  }
}

/** Expected-value helpers computed from the declarative description, never from the product. */
export class Model {
  readonly live: HighlightSpec[];

  constructor(readonly input: DatasetInput) {
    this.live = input.highlights.filter((h) => !h.trashed);
  }

  placesOf(h: HighlightSpec): PlaceSpec[] {
    return h.places ?? [{ bank: 'inbox' }];
  }

  inBank(bank: string): HighlightSpec[] {
    return this.live.filter((h) => this.placesOf(h).some((p) => p.bank === bank));
  }

  /** Folder keys of `folder` and everything below it. */
  folderTree(folder: string): Set<string> {
    const out = new Set<string>([folder]);
    for (let grew = true; grew;) {
      grew = false;
      for (const f of this.input.folders ?? []) {
        if (f.parent && out.has(f.parent) && !out.has(f.key)) {
          out.add(f.key);
          grew = true;
        }
      }
    }
    return out;
  }

  inFolder(folder: string, deep = true): HighlightSpec[] {
    const keys = deep ? this.folderTree(folder) : new Set([folder]);
    return this.live.filter((h) =>
      this.placesOf(h).some(
        (p) => p.folder !== undefined && p.folder !== null && keys.has(p.folder),
      ),
    );
  }

  keys(list: HighlightSpec[]): string[] {
    return list.map((h) => h.key);
  }
}

// -----------------------------------------------------------------------------------------------
// Reading the list
// -----------------------------------------------------------------------------------------------

export const listbox = (page: Page): Locator => page.getByRole('listbox').first();

export const rowEl = (page: Page, id: string): Locator =>
  page.locator(`[data-testid="result-row"][data-highlight-id="${id}"]`);

/** Highlight ids of the rows currently in the DOM, in list order. */
export async function renderedIds(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid="result-row"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-highlight-id') ?? ''));
}

/** Wait until the rendered rows are exactly `ids`, in order. */
export async function expectRendered(page: Page, ids: readonly string[]): Promise<void> {
  await expect.poll(() => renderedIds(page), { timeout: 15_000 }).toEqual([...ids]);
}

/** Wait until the rendered rows are exactly `ids`, in any order. */
export async function expectRenderedSet(page: Page, ids: readonly string[]): Promise<void> {
  await expect
    .poll(async () => (await renderedIds(page)).sort(), { timeout: 15_000 })
    .toEqual([...ids].sort());
}

/** Number in "1,234 highlights" / "5 results" of the summary line (null while loading). */
export async function summaryTotal(page: Page): Promise<number | null> {
  const text = (await page.getByTestId('result-summary').textContent()) ?? '';
  const m = /^\s*([\d,]+) (?:highlights?|results?)/.exec(text);
  return m ? Number(m[1]!.replace(/,/g, '')) : null;
}

export async function expectTotal(page: Page, total: number): Promise<void> {
  await expect.poll(() => summaryTotal(page), { timeout: 15_000 }).toBe(total);
}

/**
 * Every highlight id of the loaded list, in order. The list is windowed (only the rows in view are
 * in the DOM), so this scrolls the listbox from top to bottom and collects what each window shows;
 * more pages load on the way down and are collected too.
 */
export async function collectIds(page: Page): Promise<string[]> {
  // An empty result has no listbox at all (an empty state is shown instead).
  if ((await listbox(page).count()) === 0) return [];
  return listbox(page).evaluate(async (el) => {
    const seen = new Map<number, string>();
    const frame = () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 25)));
    const take = () => {
      for (const row of el.querySelectorAll('[role="option"]')) {
        const index = Number(row.getAttribute('data-index'));
        const id = row
          .querySelector('[data-testid="result-row"]')
          ?.getAttribute('data-highlight-id');
        if (id) seen.set(index, id);
      }
    };
    el.scrollTop = 0;
    let idle = 0;
    for (let guard = 0; guard < 2_000; guard++) {
      await frame();
      take();
      const max = el.scrollHeight - el.clientHeight;
      if (el.scrollTop >= max - 1) {
        // At the bottom: give a next page (loaded when the window nears the end) time to arrive.
        const before = el.scrollHeight;
        await new Promise((r) => setTimeout(r, 150));
        await frame();
        take();
        if (el.scrollHeight === before && ++idle >= 2) break;
        continue;
      }
      idle = 0;
      el.scrollTop = Math.min(max, el.scrollTop + Math.max(100, el.clientHeight - 150));
    }
    return [...seen.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
  });
}

/** Wait until the whole loaded list is exactly `ids` (in order unless `ordered` is false). */
export async function expectList(
  page: Page,
  ids: readonly string[],
  options: { ordered?: boolean; total?: number } = {},
): Promise<void> {
  await expectTotal(page, options.total ?? ids.length);
  const want = options.ordered === false ? [...ids].sort() : [...ids];
  await expect
    .poll(
      async () => {
        const got = await collectIds(page);
        return options.ordered === false ? got.sort() : got;
      },
      { timeout: 20_000, message: 'the loaded list should hold exactly the expected highlights' },
    )
    .toEqual(want);
}

/** The list for a query given as dataset keys. */
export async function expectResult(
  page: Page,
  keys: readonly string[],
  ds: Dataset,
  ordered = false,
): Promise<void> {
  await expectList(
    page,
    keys.map((k) => ds.id.hl(k)),
    { ordered },
  );
}

// -----------------------------------------------------------------------------------------------
// Tree, dialogs, toasts, palette
// -----------------------------------------------------------------------------------------------

export const treeOf = (page: Page): Locator =>
  page.getByRole('tree', { name: 'Banks and folders' });

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A tree node by its exact name. A node's accessible name is "<name> [(protected)] <n> highlight(s)",
 * so "Source" never matches "Source folder".
 */
export function treeItem(page: Page, name: string): Locator {
  return treeOf(page).getByRole('treeitem', {
    name: new RegExp(`^${escapeRe(name)}(?: \\(protected\\))? [\\d,]+ highlights?$`),
  });
}

/** Names of the visible tree nodes in order, with their level. */
export async function treeOutline(page: Page): Promise<string[]> {
  return treeOf(page)
    .getByRole('treeitem')
    .evaluateAll((els) =>
      els.map((el) => {
        const name = el.querySelector('.dash-tree__name')?.textContent ?? '';
        return `${el.getAttribute('aria-level') ?? '?'}:${name}`;
      }),
    );
}

/** The count shown on a tree node. */
export async function treeCount(page: Page, name: string): Promise<number> {
  const text = (await treeItem(page, name).locator('.dash-tree__count').textContent()) ?? '';
  return Number(text.replace(/[^\d]/g, ''));
}

/** Wait until the tree reads exactly this outline (the tree loads independently of the list). */
export async function expectOutline(page: Page, outline: readonly string[]): Promise<void> {
  await expect
    .poll(() => treeOutline(page), { message: 'the bank tree outline', timeout: 15_000 })
    .toEqual([...outline]);
}

/** Wait until a tree node shows this count (counts refresh a moment after a write). */
export async function expectTreeCount(page: Page, name: string, count: number): Promise<void> {
  await expect
    .poll(() => treeCount(page, name), { message: `count of ${name}`, timeout: 15_000 })
    .toBe(count);
}

export const toast = (page: Page, text: string | RegExp): Locator =>
  page.locator('.sv-toast', { hasText: text });

export const dialogOf = (page: Page, name: string | RegExp): Locator =>
  page.getByRole('dialog', { name });

/** Create a bank through the "New bank" button and wait until it is in the tree. */
export async function createBankUi(page: Page, name: string): Promise<void> {
  await page.getByTestId('new-bank').click();
  const dialog = dialogOf(page, 'New bank');
  await dialog.getByTestId('name-input').fill(name);
  await dialog.getByTestId('dialog-confirm').click();
  await expect(dialog).toHaveCount(0);
  await expect(treeItem(page, name)).toBeVisible();
}

/** Right-click a tree node and pick an item of its action menu. */
export async function treeMenu(page: Page, node: string, item: string | RegExp): Promise<void> {
  await treeItem(page, node).click({ button: 'right' });
  await page.getByRole('menu').getByRole('menuitem', { name: item }).click();
}

/** Create a folder under a bank or folder node through its context menu. */
export async function createFolderUi(page: Page, parent: string, name: string): Promise<void> {
  await treeMenu(page, parent, /^New (folder here|subfolder)/);
  const dialog = dialogOf(page, /^New (folder|subfolder) in/);
  await dialog.getByTestId('name-input').fill(name);
  await dialog.getByTestId('dialog-confirm').click();
  await expect(dialog).toHaveCount(0);
  await expect(treeItem(page, name)).toBeVisible();
}

export async function openPalette(page: Page): Promise<Locator> {
  await page.keyboard.press('Control+K');
  const palette = page.getByTestId('command-palette');
  await expect(palette).toBeVisible();
  return palette;
}

/** Ctrl+K, then click the command with this id. */
export async function runCommand(page: Page, commandId: string): Promise<void> {
  const palette = await openPalette(page);
  await palette.locator(`[data-command-id="${commandId}"]`).click();
  await expect(palette).toHaveCount(0);
}

// -----------------------------------------------------------------------------------------------
// Preview
// -----------------------------------------------------------------------------------------------

/** Click a list row and wait until the preview shows that highlight. */
export async function openPreview(page: Page, id: string): Promise<Locator> {
  await rowEl(page, id).click();
  const preview = page.getByTestId('preview');
  await expect(preview).toHaveAttribute('data-highlight-id', id);
  return preview;
}

// -----------------------------------------------------------------------------------------------
// Accessibility
// -----------------------------------------------------------------------------------------------

/** WCAG 2.2 AA axe tags, as in a11y.spec.ts. Best-practice rules are not part of the gate. */
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];

interface Violation {
  id: string;
  impact?: string | null;
  help: string;
  nodes: Array<{ target: unknown; failureSummary?: string; html: string }>;
}

export async function axeViolations(page: Page, include?: string): Promise<string> {
  await settleAnimations(page);
  let builder = new AxeBuilder({ page }).withTags(WCAG_TAGS);
  if (include) builder = builder.include(include);
  const results = await builder.analyze();
  return (results.violations as unknown as Violation[])
    .map((v) => {
      const nodes = v.nodes
        .slice(0, 4)
        .map(
          (n) =>
            `    - ${JSON.stringify(n.target)}\n      ${n.html.slice(0, 160)}\n      ${(n.failureSummary ?? '').replace(/\n/g, ' | ')}`,
        )
        .join('\n');
      return `[${v.impact ?? 'n/a'}] ${v.id}: ${v.help} (${v.nodes.length} node(s))\n${nodes}`;
    })
    .join('\n');
}

export async function expectAxeClean(page: Page, include?: string): Promise<void> {
  expect(await axeViolations(page, include), 'axe WCAG 2.2 AA violations').toBe('');
}

// -----------------------------------------------------------------------------------------------
// Measurements
// -----------------------------------------------------------------------------------------------

/** Print a measurement and attach it to the test (shows in the list reporter and the HTML report). */
export function recordPerf(name: string, ms: number): void {
  const description = `${name}: ${Math.round(ms).toLocaleString('en-US')} ms`;
  console.log(`PERF ${description}`);
  test.info().annotations.push({ type: 'perf', description });
}
