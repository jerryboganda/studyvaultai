import type { z } from 'zod';
import { uuidv7 } from 'uuidv7';
import { bumpDataEpoch } from '@runtime';
import {
  Bank,
  CaptureInput,
  COLOR_IDS,
  Highlight,
  HighlightBank,
  HighlightPatch,
  Id,
  INBOX_BANK_ID,
  INBOX_BANK_NAME,
  MAX_QUOTE_CHARS,
  MAX_URL_CHARS,
  ResolutionReport,
  SCHEMA_VERSION,
  Source,
  StudyVaultError,
  redactUrl,
  sourceKeys,
  trustedCanonical,
  type AnchorSet,
  type BankLite,
  type CaptureResult,
  type HighlightView,
} from '@shared';
import { withDb, type StudyVaultDb } from './db';
import { normalizeQuote, quoteHash } from './normalize';
import type { BankWithCount, HighlightListItem, RepoApi } from './types';

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

const now = () => new Date().toISOString();
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const notNull = <T>(v: T | null): v is T => v !== null;
const isDeleted = (row: { deletedAt?: unknown }) => typeof row.deletedAt === 'string';
const allTables = (db: StudyVaultDb) => [db.banks, db.sources, db.highlights, db.highlightBanks];

function parseInput<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new StudyVaultError('invalid_request', `Invalid ${what}: ${result.error.message}`);
  }
  return result.data;
}

const requireId = (id: string) => parseInput(Id, id, 'id');

/** Rows are validated on the way out; a corrupt row is skipped (and logged), never fatal. */
function parseRow<T>(schema: z.ZodType<T>, row: unknown, table: string): T | null {
  const result = schema.safeParse(row);
  if (result.success) return result.data;
  const id = (row as { id?: unknown } | null | undefined)?.id;
  console.warn(`[studyvault] skipping invalid ${table} row`, id, result.error.message);
  return null;
}

/**
 * Tell other contexts the data changed. Serialised so two quick writes cannot read the same
 * counter value and collapse into one notification. Never throws: liveness must not fail a write.
 */
let epochChain: Promise<void> = Promise.resolve();
function signalChange(): Promise<void> {
  epochChain = epochChain
    .then(() => bumpDataEpoch())
    .catch((err: unknown) => console.warn('[studyvault] bumpDataEpoch failed', err));
  return epochChain;
}

// ---------------------------------------------------------------------------------------------
// banks
// ---------------------------------------------------------------------------------------------

const defaultInbox = (ts: string): Bank => ({
  id: INBOX_BANK_ID,
  schemaVersion: SCHEMA_VERSION,
  createdAt: ts,
  updatedAt: ts,
  deletedAt: null,
  name: INBOX_BANK_NAME,
  color: 'blue',
  position: 0,
  isInbox: true,
});

const toLite = (b: Bank): BankLite => ({
  id: b.id,
  name: b.name,
  color: b.color,
  isInbox: b.isInbox,
});

/**
 * Live banks in display order. Reads never write (Dexie forbids writes inside liveQuery), so an
 * Inbox that has not been persisted yet is reported virtually; saveCapture/createBank persist it.
 */
async function readBanks(db: StudyVaultDb): Promise<Bank[]> {
  const rows = await db.banks.toArray();
  const banks = rows
    .map((r) => parseRow(Bank, r, 'bank'))
    .filter(notNull)
    .filter((b) => b.deletedAt === null);
  if (!banks.some((b) => b.id === INBOX_BANK_ID))
    banks.push(defaultInbox(new Date(0).toISOString()));
  return banks.sort(
    (a, b) => a.position - b.position || cmp(a.createdAt, b.createdAt) || cmp(a.id, b.id),
  );
}

/** Idempotent. Call only inside a readwrite transaction that includes `banks`. */
async function ensureInbox(db: StudyVaultDb, ts: string): Promise<Bank> {
  const stored = await db.banks.get(INBOX_BANK_ID);
  const parsed = stored ? parseRow(Bank, stored, 'bank') : null;
  if (parsed && parsed.deletedAt === null && parsed.isInbox) return parsed;
  const row: Bank = parsed
    ? { ...parsed, isInbox: true, deletedAt: null, updatedAt: ts }
    : defaultInbox(ts);
  await db.banks.put(row);
  return row;
}

async function resolveTargetBank(
  db: StudyVaultDb,
  bankId: string | null,
  ts: string,
): Promise<Bank> {
  if (bankId && bankId !== INBOX_BANK_ID) {
    const stored = await db.banks.get(bankId);
    const parsed = stored ? parseRow(Bank, stored, 'bank') : null;
    if (parsed && parsed.deletedAt === null) return parsed;
  }
  return ensureInbox(db, ts);
}

// ---------------------------------------------------------------------------------------------
// joins
// ---------------------------------------------------------------------------------------------

const toView = (h: Highlight, bankIds: string[]): HighlightView => ({
  id: h.id,
  sourceId: h.sourceId,
  exactQuote: h.exactQuote,
  anchorSet: h.anchorSet,
  kind: h.kind,
  color: h.color,
  priority: h.priority,
  userComment: h.userComment,
  headingContext: h.headingContext,
  bankIds,
  capturedAt: h.capturedAt,
  resolveStatus: h.resolveStatus,
  resolveConfidence: h.resolveConfidence,
});

/** highlightId -> ids of the live banks it is filed in, oldest membership first. */
async function bankIdsByHighlight(
  db: StudyVaultDb,
  highlightIds: string[],
  liveBankIds: ReadonlySet<string>,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (highlightIds.length === 0) return out;
  const rows = await db.highlightBanks.where('highlightId').anyOf(highlightIds).toArray();
  const members = rows
    .map((r) => parseRow(HighlightBank, r, 'highlightBank'))
    .filter(notNull)
    .filter((m) => liveBankIds.has(m.bankId))
    .sort((a, b) => cmp(a.addedAt, b.addedAt) || cmp(a.bankId, b.bankId));
  for (const m of members) {
    const list = out.get(m.highlightId) ?? [];
    list.push(m.bankId);
    out.set(m.highlightId, list);
  }
  return out;
}

async function toViews(db: StudyVaultDb, rows: Highlight[]): Promise<HighlightView[]> {
  const banks = await readBanks(db);
  const memberships = await bankIdsByHighlight(
    db,
    rows.map((r) => r.id),
    new Set(banks.map((b) => b.id)),
  );
  return rows.map((r) => toView(r, memberships.get(r.id) ?? []));
}

async function toItems(db: StudyVaultDb, rows: Highlight[]): Promise<HighlightListItem[]> {
  const banks = new Map((await readBanks(db)).map((b) => [b.id, b]));
  const memberships = await bankIdsByHighlight(
    db,
    rows.map((r) => r.id),
    new Set(banks.keys()),
  );
  const sourceRows = await db.sources.bulkGet([...new Set(rows.map((r) => r.sourceId))]);
  const sources = new Map<string, Source>();
  for (const row of sourceRows) {
    const source = row ? parseRow(Source, row, 'source') : null;
    if (source) sources.set(source.id, source);
  }
  const items: HighlightListItem[] = [];
  for (const row of rows) {
    const source = sources.get(row.sourceId);
    if (!source) {
      console.warn('[studyvault] skipping highlight without a source', row.id);
      continue;
    }
    const bankIds = memberships.get(row.id) ?? [];
    items.push({
      highlight: toView(row, bankIds),
      source: {
        id: source.id,
        title: source.title,
        host: source.host,
        originalUrl: source.originalUrl,
        canonicalUrl: source.canonicalUrl,
        urlKey: source.urlKey,
      },
      banks: bankIds.flatMap((id) => {
        const bank = banks.get(id);
        return bank ? [toLite(bank)] : [];
      }),
    });
  }
  return items;
}

// ---------------------------------------------------------------------------------------------
// sources & duplicate detection
// ---------------------------------------------------------------------------------------------

interface PageKeys {
  urlKey: string;
  visitedKey: string;
}

/**
 * Every live source that may be this page: its urlKey or visitedKey equals either key of the
 * page. Ordered best-first (urlKey match, then visitedKey match, then cross matches), so the
 * first "primary" entry is the one a capture is filed under.
 */
async function matchSources(db: StudyVaultDb, keys: PageKeys): Promise<Source[]> {
  const probe = [...new Set([keys.urlKey, keys.visitedKey])];
  const found = new Map<string, Source>();
  for (const index of ['urlKey', 'visitedKey'] as const) {
    for (const row of await db.sources.where(index).anyOf(probe).toArray()) found.set(row.id, row);
  }
  const rank = (s: Source) =>
    s.urlKey === keys.urlKey ? 0 : s.visitedKey === keys.visitedKey ? 1 : 2;
  return [...found.values()]
    .map((r) => parseRow(Source, r, 'source'))
    .filter(notNull)
    .filter((s) => s.deletedAt === null)
    .sort((a, b) => rank(a) - rank(b) || cmp(a.createdAt, b.createdAt) || cmp(a.id, b.id));
}

const isPrimary = (s: Source, keys: PageKeys) =>
  s.urlKey === keys.urlKey || s.visitedKey === keys.visitedKey;

/** Live highlights of the given sources in document order. */
async function liveHighlightsOf(db: StudyVaultDb, sourceIds: string[]): Promise<Highlight[]> {
  const out: Highlight[] = [];
  for (const sourceId of sourceIds) {
    for (const row of await db.highlights.where('sourceId').equals(sourceId).toArray()) {
      if (isDeleted(row)) continue;
      const parsed = parseRow(Highlight, row, 'highlight');
      if (parsed) out.push(parsed);
    }
  }
  return out.sort(
    (a, b) =>
      a.anchorSet.textPosition.start - b.anchorSet.textPosition.start ||
      cmp(a.capturedAt, b.capturedAt) ||
      cmp(a.id, b.id),
  );
}

/** Same quote at "the same place": overlapping stream ranges, or identical surrounding context. */
function samePlace(a: AnchorSet, b: AnchorSet): boolean {
  if (a.type !== 'html' || b.type !== 'html') return false;
  const overlap =
    a.textPosition.start < b.textPosition.end && b.textPosition.start < a.textPosition.end;
  return (
    overlap ||
    (a.textQuote.prefix === b.textQuote.prefix && a.textQuote.suffix === b.textQuote.suffix)
  );
}

async function addMembership(
  db: StudyVaultDb,
  highlightId: string,
  bankId: string,
  ts: string,
): Promise<boolean> {
  if (await db.highlightBanks.get([highlightId, bankId])) return false;
  await db.highlightBanks.put({ highlightId, bankId, folderId: null, addedAt: ts });
  return true;
}

// ---------------------------------------------------------------------------------------------
// RepoApi
// ---------------------------------------------------------------------------------------------

export async function saveCapture(input: CaptureInput): Promise<CaptureResult> {
  const capture = parseInput(CaptureInput, input, 'capture');
  const keys = sourceKeys(capture.page.url, capture.page.canonicalUrl);
  // The stored address has no credentials: presigned-URL signatures, OAuth tokens and fragments are
  // not provenance, and a rotating token must not fork one page into many sources.
  const originalUrl = redactUrl(capture.page.url);
  // Normalisation can lengthen a URL (percent-encoding); a record we could not read back is worse
  // than a refused capture.
  if (
    !keys ||
    originalUrl === null ||
    keys.urlKey.length > MAX_URL_CHARS ||
    keys.visitedKey.length > MAX_URL_CHARS ||
    originalUrl.length > MAX_URL_CHARS
  ) {
    throw new StudyVaultError('invalid_request', 'Page URL cannot be stored as a source');
  }
  const canonicalUrl = trustedCanonical(capture.page.url, capture.page.canonicalUrl);
  const normalized = normalizeQuote(capture.exactQuote);
  if (normalized === '') throw new StudyVaultError('invalid_request', 'Quote is empty');
  // Hash before the transaction: awaiting crypto.subtle inside would let IndexedDB auto-commit it.
  const hash = await quoteHash(normalized);
  const ts = now();

  const { result, changed } = await withDb((db) =>
    db.transaction('rw', allTables(db), async () => {
      const bank = await resolveTargetBank(db, capture.bankId, ts);
      const sources = await matchSources(db, keys);

      const same: Highlight[] = [];
      for (const source of sources) {
        const rows = await db.highlights
          .where('[sourceId+quoteHash]')
          .equals([source.id, hash])
          .toArray();
        for (const row of rows) {
          const parsed = parseRow(Highlight, row, 'highlight');
          if (parsed && samePlace(parsed.anchorSet, capture.anchorSet)) same.push(parsed);
        }
      }
      same.sort((a, b) => cmp(a.capturedAt, b.capturedAt) || cmp(a.id, b.id));
      const live = same.find((h) => h.deletedAt === null);
      const deleted = live
        ? undefined
        : same.sort((a, b) => cmp(b.deletedAt ?? '', a.deletedAt ?? ''))[0];

      let highlight: Highlight;
      let status: CaptureResult['status'];
      let addedToBank: boolean;

      if (live) {
        highlight = live;
        status = 'duplicate';
        addedToBank = await addMembership(db, live.id, bank.id, ts);
      } else if (deleted) {
        highlight = { ...deleted, deletedAt: null, updatedAt: ts };
        status = 'restored';
        await db.highlights.update(deleted.id, { deletedAt: null, updatedAt: ts });
        await db.sources.update(deleted.sourceId, { updatedAt: ts });
        addedToBank = await addMembership(db, deleted.id, bank.id, ts);
      } else {
        let source = sources.find((s) => isPrimary(s, keys));
        if (source) {
          // Provenance stays as first seen; only an empty title may be filled in.
          const title = source.title === '' ? capture.page.title : source.title;
          await db.sources.update(source.id, { updatedAt: ts, title });
        } else {
          source = {
            id: uuidv7(),
            schemaVersion: SCHEMA_VERSION,
            createdAt: ts,
            updatedAt: ts,
            deletedAt: null,
            type: 'web',
            urlKey: keys.urlKey,
            visitedKey: keys.visitedKey,
            originalUrl,
            canonicalUrl,
            host: new URL(capture.page.url).hostname,
            title: capture.page.title,
          };
          await db.sources.put(source);
        }
        highlight = {
          id: uuidv7(),
          schemaVersion: SCHEMA_VERSION,
          createdAt: ts,
          updatedAt: ts,
          deletedAt: null,
          sourceId: source.id,
          exactQuote: capture.exactQuote,
          // The hash covers the full normalised text; the stored copy only has to fit the schema.
          normalizedQuote: normalized.slice(0, MAX_QUOTE_CHARS),
          quoteHash: hash,
          anchorSet: capture.anchorSet,
          kind: capture.kind,
          color: capture.color,
          priority: capture.priority,
          userComment: capture.userComment,
          headingContext: capture.headingContext,
          captureMethod: capture.captureMethod,
          capturedAt: ts,
          resolveStatus: 'unchecked',
          resolveConfidence: null,
          lastResolvedAt: null,
        };
        await db.highlights.put(highlight);
        await db.highlightBanks.put({
          highlightId: highlight.id,
          bankId: bank.id,
          folderId: null,
          addedAt: ts,
        });
        status = 'created';
        addedToBank = true;
      }

      const [view] = await toViews(db, [highlight]);
      return {
        result: { status, highlight: view!, bank: toLite(bank), addedToBank },
        changed: status !== 'duplicate' || addedToBank,
      };
    }),
  );
  if (changed) await signalChange();
  return result;
}

export async function getPageHighlights(
  url: string,
  canonicalUrl: string | null,
): Promise<{ sourceId: string | null; highlights: HighlightView[] }> {
  const keys = sourceKeys(url, canonicalUrl);
  if (!keys) return { sourceId: null, highlights: [] };
  return withDb((db) =>
    db.transaction('r', allTables(db), async () => {
      const sources = await matchSources(db, keys);
      const rows = await liveHighlightsOf(
        db,
        sources.map((s) => s.id),
      );
      return { sourceId: sources[0]?.id ?? null, highlights: await toViews(db, rows) };
    }),
  );
}

async function liveHighlight(db: StudyVaultDb, id: string): Promise<Highlight> {
  const row = await db.highlights.get(id);
  const parsed = row && !isDeleted(row) ? parseRow(Highlight, row, 'highlight') : null;
  if (!parsed) throw new StudyVaultError('not_found', 'Highlight not found');
  return parsed;
}

export async function updateHighlight(id: string, patch: HighlightPatch): Promise<HighlightView> {
  requireId(id);
  const parsed = parseInput(HighlightPatch, patch, 'highlight patch');
  const changes = Object.fromEntries(
    Object.entries(parsed).filter(([, value]) => value !== undefined),
  ) as HighlightPatch;
  const { view, changed } = await withDb((db) =>
    db.transaction('rw', allTables(db), async () => {
      const row = await liveHighlight(db, id);
      const differs = (Object.keys(changes) as Array<keyof HighlightPatch>).some(
        (key) => row[key] !== changes[key],
      );
      if (!differs) return { view: (await toViews(db, [row]))[0]!, changed: false };
      const next = { ...row, ...changes, updatedAt: now() };
      await db.highlights.update(id, { ...changes, updatedAt: next.updatedAt });
      return { view: (await toViews(db, [next]))[0]!, changed: true };
    }),
  );
  if (changed) await signalChange();
  return view;
}

export async function softDeleteHighlight(id: string): Promise<void> {
  requireId(id);
  const changed = await withDb((db) =>
    db.transaction('rw', db.highlights, async () => {
      const row = await db.highlights.get(id);
      if (!row) throw new StudyVaultError('not_found', 'Highlight not found');
      if (isDeleted(row)) return false;
      const ts = now();
      await db.highlights.update(id, { deletedAt: ts, updatedAt: ts });
      return true;
    }),
  );
  if (changed) await signalChange();
}

export async function restoreHighlight(id: string): Promise<HighlightView> {
  requireId(id);
  const { view, changed } = await withDb((db) =>
    db.transaction('rw', allTables(db), async () => {
      const stored = await db.highlights.get(id);
      const row = stored ? parseRow(Highlight, stored, 'highlight') : null;
      if (!row) throw new StudyVaultError('not_found', 'Highlight not found');
      if (row.deletedAt === null) return { view: (await toViews(db, [row]))[0]!, changed: false };
      const restored = { ...row, deletedAt: null, updatedAt: now() };
      await db.highlights.update(id, { deletedAt: null, updatedAt: restored.updatedAt });
      return { view: (await toViews(db, [restored]))[0]!, changed: true };
    }),
  );
  if (changed) await signalChange();
  return view;
}

export async function reportResolutions(
  items: Array<{ id: string; status: Highlight['resolveStatus']; confidence: number | null }>,
): Promise<number> {
  const reports = new Map<string, (typeof items)[number]>();
  for (const item of items) {
    reports.set(item.id, parseInput(ResolutionReport, item, 'resolution report'));
  }
  if (reports.size === 0) return 0;
  const { updated, changed } = await withDb((db) =>
    db.transaction('rw', db.highlights, async () => {
      const ts = now();
      let updated = 0;
      let changed = false;
      for (const [id, report] of reports) {
        const row = await db.highlights.get(id);
        if (!row || isDeleted(row)) continue;
        await db.highlights.update(id, {
          resolveStatus: report.status,
          resolveConfidence: report.confidence,
          lastResolvedAt: ts,
        });
        updated++;
        if (row.resolveStatus !== report.status || row.resolveConfidence !== report.confidence) {
          changed = true;
        }
      }
      return { updated, changed };
    }),
  );
  // Only a real outcome change notifies: viewers repaint and re-report on notification, so
  // announcing unchanged reports would loop.
  if (changed) await signalChange();
  return updated;
}

export async function getHighlightSource(
  id: string,
): Promise<{ sourceId: string; urlKey: string; visitedKey: string } | null> {
  requireId(id);
  return withDb(async (db) => {
    const row = await db.highlights.get(id);
    if (!row || isDeleted(row)) return null;
    const stored = await db.sources.get(row.sourceId);
    const source = stored ? parseRow(Source, stored, 'source') : null;
    return source
      ? { sourceId: source.id, urlKey: source.urlKey, visitedKey: source.visitedKey }
      : null;
  });
}

export async function listBanks(): Promise<BankLite[]> {
  return withDb(async (db) => (await readBanks(db)).map(toLite));
}

export async function createBank(name: string): Promise<BankLite> {
  const bankName = parseInput(Bank.shape.name, name, 'bank name');
  const bank = await withDb((db) =>
    db.transaction('rw', db.banks, async () => {
      const ts = now();
      await ensureInbox(db, ts);
      // After the Inbox exists the highest position is at least 0, so user banks start at 1.
      const last = await db.banks.orderBy('position').last();
      const position = Math.floor((last?.position ?? 0) + 1);
      const row: Bank = {
        id: uuidv7(),
        schemaVersion: SCHEMA_VERSION,
        createdAt: ts,
        updatedAt: ts,
        deletedAt: null,
        name: bankName,
        color: COLOR_IDS[(position - 1) % COLOR_IDS.length]!,
        position,
        isInbox: false,
      };
      await db.banks.put(row);
      return row;
    }),
  );
  await signalChange();
  return toLite(bank);
}

export async function listRecentHighlights(limit: number): Promise<HighlightListItem[]> {
  if (!Number.isFinite(limit) || limit < 0) {
    throw new StudyVaultError('invalid_request', 'limit must be a non-negative number');
  }
  const max = Math.floor(limit);
  if (max === 0) return [];
  return withDb((db) =>
    db.transaction('r', allTables(db), async () => {
      const rows: Highlight[] = [];
      await db.highlights
        .orderBy('capturedAt')
        .reverse()
        .until(() => rows.length >= max)
        .each((row) => {
          if (isDeleted(row)) return;
          const parsed = parseRow(Highlight, row, 'highlight');
          if (parsed) rows.push(parsed);
        });
      return toItems(db, rows);
    }),
  );
}

export async function listPageHighlights(
  url: string,
  canonicalUrl: string | null,
): Promise<HighlightListItem[]> {
  const keys = sourceKeys(url, canonicalUrl);
  if (!keys) return [];
  return withDb((db) =>
    db.transaction('r', allTables(db), async () => {
      const sources = await matchSources(db, keys);
      return toItems(
        db,
        await liveHighlightsOf(
          db,
          sources.map((s) => s.id),
        ),
      );
    }),
  );
}

export async function listBanksWithCounts(): Promise<BankWithCount[]> {
  return withDb((db) =>
    db.transaction('r', [db.banks, db.highlights, db.highlightBanks], async () => {
      const banks = await readBanks(db);
      // Keys only: counting must not deserialise every highlight body. A corrupt row that a list
      // would skip still counts here.
      const live = new Set<unknown>(await db.highlights.toCollection().primaryKeys());
      for (const key of await db.highlights.where('deletedAt').above('').primaryKeys()) {
        live.delete(key);
      }
      const counts = new Map<string, number>();
      await db.highlightBanks.each((m) => {
        if (live.has(m.highlightId)) counts.set(m.bankId, (counts.get(m.bankId) ?? 0) + 1);
      });
      return banks.map((b) => ({ bank: toLite(b), count: counts.get(b.id) ?? 0 }));
    }),
  );
}

/** Compile-time proof that every RepoApi member is implemented with the exact signature. */
export const repo = {
  saveCapture,
  getPageHighlights,
  updateHighlight,
  softDeleteHighlight,
  restoreHighlight,
  reportResolutions,
  getHighlightSource,
  listBanks,
  createBank,
  listRecentHighlights,
  listPageHighlights,
  listBanksWithCounts,
} satisfies RepoApi;
