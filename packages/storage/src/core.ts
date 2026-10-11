import Dexie, { type Table } from 'dexie';
import type { z } from 'zod';
import { bumpDataEpoch, bumpResolutionEpoch } from '@runtime';
import {
  BankRecord,
  Folder,
  Highlight,
  HighlightBank,
  Id,
  INBOX_BANK_ID,
  INBOX_BANK_NAME,
  PLACEHOLDER_SOURCE_PREFIX,
  SCHEMA_VERSION,
  Source,
  StudyVaultError,
  type AnchorSet,
  type BankLite,
  type HighlightView,
} from '@shared';
import type { StudyVaultDb } from './db';
import { normaliseRow } from './rows';
import type { HighlightListItem } from './types';

/** Helpers shared by every storage module. Nothing here is part of the public API. */

export const now = () => new Date().toISOString();
export const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export const notNull = <T>(v: T | null): v is T => v !== null;
export const isDeleted = (row: { deletedAt?: unknown }) => typeof row.deletedAt === 'string';
/** The v1 tables: what capture, restore and list functions touch. */
export const allTables = (db: StudyVaultDb) => [
  db.banks,
  db.sources,
  db.highlights,
  db.highlightBanks,
];

export function parseInput<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new StudyVaultError('invalid_request', `Invalid ${what}: ${result.error.message}`);
  }
  return result.data;
}

export const requireId = (id: string) => parseInput(Id, id, 'id');

/**
 * Rows are validated on the way out (after `normaliseRow`, so every schemaVersion >= 1 is read);
 * a corrupt row is skipped (and logged), never fatal. A row that fails here is only ever skipped:
 * no code path may write over a row it could not read.
 */
export function parseRow<T>(schema: z.ZodType<T>, row: unknown, table: string): T | null {
  const result = schema.safeParse(normaliseRow(row));
  if (result.success) return result.data;
  const id = (row as { id?: unknown } | null | undefined)?.id;
  console.warn(`[StudyVault] skipping invalid ${table} row`, id, result.error.message);
  return null;
}

/**
 * Tell other contexts something changed. Serialised so two quick writes cannot read the same
 * counter value and collapse into one notification. Never throws: liveness must not fail a write.
 */
function signaller(bump: () => Promise<void>, name: string): () => Promise<void> {
  let chain: Promise<void> = Promise.resolve();
  return () => {
    chain = chain
      .then(bump)
      .catch((err: unknown) => console.warn(`[StudyVault] ${name} failed`, err));
    return chain;
  };
}

/** Highlights, notes or banks changed: every viewer re-fetches. */
export const signalChange = signaller(bumpDataEpoch, 'bumpDataEpoch');
/** Only resolver outcomes changed: panels refresh their badges, content scripts are not woken. */
export const signalResolution = signaller(bumpResolutionEpoch, 'bumpResolutionEpoch');

/**
 * `originalUrl` of a PDF source that has no address (a local import): Source requires an http(s)
 * URL, and `.invalid` is reserved (RFC 2606) so this can never resolve. Never shown or indexed.
 */
export const LOCAL_PDF_URL_PREFIX = `${PLACEHOLDER_SOURCE_PREFIX}pdf/`;

/** Dedupe, keeping first occurrences. */
export const unique = <T>(items: readonly T[]): T[] => [...new Set(items)];

/**
 * Rows whose `index` equals any of `values`, one equals() query per value. Deliberately not
 * `anyOf`: that walks the index key by key (a cursor hop per value and per row), which is
 * pathological in some IndexedDB engines (fake-indexeddb: seconds for a few thousand rows).
 * Returns a Dexie promise from a plain function (not an async one): an async wrapper loses
 * Dexie's transaction zone and the next request in the caller's transaction fails as
 * "committed too early" (seen inside liveQuery).
 */
export function rowsWhereIn<T, K, I>(
  table: Table<T, K, I>,
  index: string,
  values: readonly (string | number)[],
): PromiseLike<T[]> {
  return Dexie.Promise.all(
    [...new Set(values)].map((value) => table.where(index).equals(value).toArray()),
  ).then((lists) => lists.flat());
}

/** Primary keys of the rows whose `index` equals any of `values` (see rowsWhereIn). */
export function keysWhereIn<T, K, I>(
  table: Table<T, K, I>,
  index: string,
  values: readonly (string | number)[],
): PromiseLike<unknown[]> {
  return Dexie.Promise.all(
    [...new Set(values)].map((value) => table.where(index).equals(value).primaryKeys()),
  ).then((lists) => lists.flat());
}

/** `fn` over `items` in slices, so one call never carries tens of thousands of keys. */
export async function inChunks<T, R>(
  items: readonly T[],
  size: number,
  fn: (chunk: T[]) => Promise<R[]>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await fn(items.slice(i, i + size))));
  return out;
}

// ---------------------------------------------------------------------------------------------
// banks
// ---------------------------------------------------------------------------------------------

export const defaultInbox = (ts: string): BankRecord => ({
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

export const toLite = (b: BankRecord): BankLite => ({
  id: b.id,
  name: b.name,
  color: b.color,
  isInbox: b.isInbox,
});

/**
 * Live banks in display order. Reads never write (Dexie forbids writes inside liveQuery), so an
 * Inbox that has not been persisted yet is reported virtually; saveCapture/createBank persist it.
 */
export async function readBanks(db: StudyVaultDb): Promise<BankRecord[]> {
  const rows = await db.banks.toArray();
  const banks = rows
    .map((r) => parseRow(BankRecord, r, 'bank'))
    .filter(notNull)
    .filter((b) => b.deletedAt === null);
  if (!banks.some((b) => b.id === INBOX_BANK_ID))
    banks.push(defaultInbox(new Date(0).toISOString()));
  return banks.sort(
    (a, b) => a.position - b.position || cmp(a.createdAt, b.createdAt) || cmp(a.id, b.id),
  );
}

/** Most parents a folder path follows (and shows); deeper chains are cut. */
const FOLDER_PATH_DEPTH = 16;

/**
 * The live folders named by `ids` and their ancestors, keyed by id: what a folder path needs, read
 * by id instead of every folder of every bank involved. A deleted or unreadable folder is absent,
 * which ends a path there. Call inside a read transaction that includes `folders`.
 */
export async function readFolderChains(
  db: StudyVaultDb,
  ids: readonly (string | null)[],
): Promise<Map<string, Folder>> {
  const folders = new Map<string, Folder>();
  const asked = new Set<string>();
  let wanted = unique(ids.filter((id): id is string => id !== null));
  for (let level = 0; level < FOLDER_PATH_DEPTH && wanted.length > 0; level++) {
    for (const id of wanted) asked.add(id);
    const parents: string[] = [];
    for (const row of await db.folders.bulkGet(wanted)) {
      const folder = !row || isDeleted(row) ? null : parseRow(Folder, row, 'folder');
      if (!folder) continue;
      folders.set(folder.id, folder);
      if (folder.parentFolderId !== null && !asked.has(folder.parentFolderId)) {
        parents.push(folder.parentFolderId);
      }
    }
    wanted = unique(parents);
  }
  return folders;
}

/**
 * Idempotent. Call only inside a readwrite transaction that includes `banks`. A row that exists is
 * never replaced: a deleted Inbox is revived field by field, and one that cannot be read stops the
 * write instead of being overwritten by a fresh default (which would also hide the data in it).
 */
export async function ensureInbox(db: StudyVaultDb, ts: string): Promise<BankRecord> {
  const stored = await db.banks.get(INBOX_BANK_ID);
  if (stored === undefined) {
    const inbox = defaultInbox(ts);
    await db.banks.add(inbox);
    return inbox;
  }
  const parsed = parseRow(BankRecord, stored, 'bank');
  if (!parsed) {
    throw new StudyVaultError(
      'storage_unavailable',
      'The Inbox record in the local database could not be read, so nothing was saved and nothing was overwritten. Choose another bank, or export your data and report this.',
    );
  }
  if (parsed.deletedAt === null && parsed.isInbox) return parsed;
  const revived = { isInbox: true, deletedAt: null, updatedAt: ts };
  await db.banks.update(INBOX_BANK_ID, revived);
  return { ...parsed, ...revived };
}

export async function resolveTargetBank(
  db: StudyVaultDb,
  bankId: string | null,
  ts: string,
): Promise<BankRecord> {
  if (bankId && bankId !== INBOX_BANK_ID) {
    const stored = await db.banks.get(bankId);
    const parsed = stored ? parseRow(BankRecord, stored, 'bank') : null;
    if (parsed && parsed.deletedAt === null) return parsed;
  }
  return ensureInbox(db, ts);
}

/** A bank that exists and is not deleted; throws not_found otherwise. Inbox is virtual until saved. */
export async function liveBank(db: StudyVaultDb, id: string): Promise<BankRecord> {
  const stored = await db.banks.get(id);
  const parsed = stored ? parseRow(BankRecord, stored, 'bank') : null;
  if (parsed && parsed.deletedAt === null) return parsed;
  if (id === INBOX_BANK_ID && stored === undefined) return ensureInbox(db, now());
  throw new StudyVaultError('not_found', 'Bank not found');
}

// ---------------------------------------------------------------------------------------------
// joins
// ---------------------------------------------------------------------------------------------

export const toView = (h: Highlight, bankIds: string[]): HighlightView => ({
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
export async function bankIdsByHighlight(
  db: StudyVaultDb,
  highlightIds: string[],
  liveBankIds: ReadonlySet<string>,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (highlightIds.length === 0) return out;
  const rows = await rowsWhereIn(db.highlightBanks, 'highlightId', highlightIds);
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

export async function toViews(db: StudyVaultDb, rows: Highlight[]): Promise<HighlightView[]> {
  // Nothing to join: touching the database again would run requests across a gap in which an
  // idle read transaction auto-commits (Dexie PrematureCommit seen on CI for an empty page).
  if (rows.length === 0) return [];
  const banks = await readBanks(db);
  const memberships = await bankIdsByHighlight(
    db,
    rows.map((r) => r.id),
    new Set(banks.map((b) => b.id)),
  );
  return rows.map((r) => toView(r, memberships.get(r.id) ?? []));
}

export const toSourceRef = (source: Source): HighlightListItem['source'] => ({
  id: source.id,
  title: source.title,
  host: source.host,
  originalUrl: source.originalUrl,
  canonicalUrl: source.canonicalUrl,
  urlKey: source.urlKey,
  // Only a PDF says what it is: web items keep the exact shape older callers were written against.
  ...(source.type === 'pdf' ? { type: 'pdf' as const } : {}),
  ...(source.documentId === undefined ? {} : { documentId: source.documentId }),
});

export async function readSources(
  db: StudyVaultDb,
  ids: readonly string[],
): Promise<Map<string, Source>> {
  const sources = new Map<string, Source>();
  if (ids.length === 0) return sources;
  const rows = await db.sources.bulkGet([...new Set(ids)]);
  for (const row of rows) {
    const source = row ? parseRow(Source, row, 'source') : null;
    if (source) sources.set(source.id, source);
  }
  return sources;
}

export async function toItems(db: StudyVaultDb, rows: Highlight[]): Promise<HighlightListItem[]> {
  if (rows.length === 0) return []; // see toViews: no database work for an empty result
  const banks = new Map((await readBanks(db)).map((b) => [b.id, b]));
  const memberships = await bankIdsByHighlight(
    db,
    rows.map((r) => r.id),
    new Set(banks.keys()),
  );
  const sources = await readSources(
    db,
    rows.map((r) => r.sourceId),
  );
  const items: HighlightListItem[] = [];
  for (const row of rows) {
    const source = sources.get(row.sourceId);
    if (!source) {
      console.warn('[StudyVault] skipping highlight without a source', row.id);
      continue;
    }
    const bankIds = memberships.get(row.id) ?? [];
    items.push({
      highlight: toView(row, bankIds),
      source: toSourceRef(source),
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

export interface PageKeys {
  urlKey: string;
  visitedKey: string;
}

/**
 * Every live source that may be this page: its urlKey or visitedKey equals either key of the
 * page. Ordered best-first (urlKey match, then visitedKey match, then cross matches), so the
 * first "primary" entry is the one a capture is filed under.
 */
export async function matchSources(db: StudyVaultDb, keys: PageKeys): Promise<Source[]> {
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

export const isPrimary = (s: Source, keys: PageKeys) =>
  s.urlKey === keys.urlKey || s.visitedKey === keys.visitedKey;

/** Live highlights of the given sources in document order. */
export async function liveHighlightsOf(
  db: StudyVaultDb,
  sourceIds: string[],
): Promise<Highlight[]> {
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

/**
 * Same quote at "the same place". Offsets only mean something inside one version of the document,
 * so they count only when both captures saw the same text stream (equal signature and length): an
 * edited page shifts every offset, and an unrelated repeat of the sentence can land on an old range.
 *  - same document: overlapping ranges, or identical context on both sides (a repeated block);
 *  - otherwise: the text just before OR just after must match (the page changed on one side).
 * PDF anchors additionally need the same document and page, and count overlapping rectangles.
 */
export function samePlace(a: AnchorSet, b: AnchorSet): boolean {
  if (a.type === 'pdf' && b.type === 'pdf') {
    if (a.documentFingerprint !== b.documentFingerprint || a.pageNumber !== b.pageNumber) {
      return false;
    }
    if (rectsOverlap(a.rects, b.rects)) return true;
  } else if (a.type !== 'html' || b.type !== 'html') {
    return false;
  }
  const sameStream =
    a.contentSignature === b.contentSignature && a.documentTextLength === b.documentTextLength;
  if (sameStream) {
    const overlap =
      a.textPosition.start < b.textPosition.end && b.textPosition.start < a.textPosition.end;
    return (
      overlap ||
      (a.textQuote.prefix === b.textQuote.prefix && a.textQuote.suffix === b.textQuote.suffix)
    );
  }
  return a.textQuote.prefix === b.textQuote.prefix || a.textQuote.suffix === b.textQuote.suffix;
}

type Rect = { x: number; y: number; w: number; h: number };

/** True when some rectangle of `a` covers at least half of the smaller of the two it meets. */
function rectsOverlap(a: readonly Rect[], b: readonly Rect[]): boolean {
  for (const r of a) {
    for (const s of b) {
      const w = Math.min(r.x + r.w, s.x + s.w) - Math.max(r.x, s.x);
      const h = Math.min(r.y + r.h, s.y + s.h) - Math.max(r.y, s.y);
      if (w <= 0 || h <= 0) continue;
      const smaller = Math.min(r.w * r.h, s.w * s.h);
      if (smaller > 0 && (w * h) / smaller >= 0.5) return true;
    }
  }
  return false;
}

export async function addMembership(
  db: StudyVaultDb,
  highlightId: string,
  bankId: string,
  ts: string,
  folderId: string | null = null,
): Promise<boolean> {
  if (await db.highlightBanks.get([highlightId, bankId])) return false;
  await db.highlightBanks.put({ highlightId, bankId, folderId, addedAt: ts });
  return true;
}

export async function liveHighlight(db: StudyVaultDb, id: string): Promise<Highlight> {
  const row = await db.highlights.get(id);
  const parsed = row && !isDeleted(row) ? parseRow(Highlight, row, 'highlight') : null;
  if (!parsed) throw new StudyVaultError('not_found', 'Highlight not found');
  return parsed;
}

/**
 * Highlights whose indexed view changed (membership, tag, note, custom field): bump `updatedAt` so
 * incremental search indexing and sync merge ordering see them. Rows that do not exist are skipped.
 */
export async function touchHighlights(
  db: StudyVaultDb,
  ids: readonly string[],
  ts: string,
): Promise<void> {
  for (const id of unique(ids)) {
    await db.highlights.update(id, { updatedAt: ts });
  }
}
