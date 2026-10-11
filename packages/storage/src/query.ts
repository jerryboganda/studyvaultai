import type { Collection } from 'dexie';
import { z } from 'zod';
import {
  BankRecord,
  Folder,
  Highlight,
  HIGHLIGHT_KINDS,
  HighlightKind,
  Id,
  IsoDate,
  Note,
  Priority,
  ResolveStatus,
  StudyVaultError,
  Tag,
} from '@shared';
import {
  cmp,
  FOLDER_PATH_DEPTH,
  inChunks,
  keysWhereIn,
  rowsWhereIn,
  isDeleted,
  notNull,
  parseInput,
  parseRow,
  readBanks,
  readFolderChains,
  readSources,
  requireId,
  samePlace,
  toLite,
  toSourceRef,
  toView,
  unique,
} from './core';
import { withDb, type StudyVaultDb } from './db';
import { childrenIndex, loadFolders, subtreeIds } from './hierarchy';
import type {
  DashboardItem,
  DuplicateCluster,
  DuplicateMember,
  FolderRef,
  HighlightDetail,
  HighlightListItem,
  HighlightPage,
  HighlightQuery,
  Location,
  TagLite,
  VaultCounts,
} from './types';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
/** Up to this many candidates the page is built from them directly (fetch, sort); beyond it the index is walked. */
const CANDIDATE_FETCH_MAX = 2000;

/** Everything a dashboard read touches; narrower than db.tables so writers elsewhere do not block it. */
const READ_TABLES = (db: StudyVaultDb) => [
  db.banks,
  db.sources,
  db.highlights,
  db.highlightBanks,
  db.highlightTags,
  db.tags,
  db.folders,
  db.notes,
];

const SortBy = z.enum(['capturedAt', 'updatedAt', 'priority']);

const QueryInput = z
  .object({
    bankId: Id.optional(),
    folderId: Id.nullable().optional(),
    tagIds: z.array(Id).max(100).optional(),
    tagMode: z.enum(['any', 'all']).optional(),
    kinds: z.array(HighlightKind).max(HIGHLIGHT_KINDS.length).optional(),
    priorities: z.array(Priority).max(5).optional(),
    resolveStatuses: z.array(ResolveStatus).max(5).optional(),
    sourceId: Id.optional(),
    hasNote: z.boolean().optional(),
    dateRange: z
      .object({
        field: z.enum(['capturedAt', 'updatedAt']).optional(),
        from: IsoDate.optional(),
        to: IsoDate.optional(),
      })
      .optional(),
    sort: z.object({ by: SortBy, dir: z.enum(['asc', 'desc']).optional() }).optional(),
    cursor: z.string().max(600).nullable().optional(),
    limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------------------------
// candidate sets
// ---------------------------------------------------------------------------------------------

interface Plan {
  /** Highlight ids that satisfy every set-shaped filter; null = no such filter. */
  candidates: Set<string> | null;
  /** Highlight ids that must NOT appear (hasNote: false). */
  exclude: Set<string> | null;
}

const EMPTY: Plan = { candidates: new Set(), exclude: null };

function intersect(a: Set<string> | null, b: Set<string>): Set<string> {
  if (a === null) return b;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  const out = new Set<string>();
  for (const id of small) if (big.has(id)) out.add(id);
  return out;
}

const idsOf = (keys: unknown[]): string[] =>
  keys.map((k) => (Array.isArray(k) ? String(k[0]) : String(k)));

async function planQuery(db: StudyVaultDb, q: z.infer<typeof QueryInput>): Promise<Plan> {
  let candidates: Set<string> | null = null;
  let exclude: Set<string> | null = null;

  if (q.folderId !== undefined && q.folderId !== null) {
    const row = await db.folders.get(q.folderId);
    const folder = row && !isDeleted(row) ? parseRow(Folder, row, 'folder') : null;
    if (!folder) return EMPTY;
    if (q.bankId !== undefined && q.bankId !== folder.bankId) return EMPTY;
    const tree = subtreeIds(childrenIndex(await loadFolders(db, folder.bankId)), folder.id);
    // A folder id belongs to one bank, so the folder index alone identifies its members.
    candidates = new Set(idsOf(await keysWhereIn(db.highlightBanks, 'folderId', tree)));
  } else if (q.bankId !== undefined) {
    const stored = await db.banks.get(q.bankId);
    const bank = stored ? parseRow(BankRecord, stored, 'bank') : null;
    if (!bank || bank.deletedAt !== null) return EMPTY;
    if (q.folderId === null) {
      const rows = await db.highlightBanks.where('bankId').equals(q.bankId).toArray();
      candidates = new Set(rows.filter((m) => m.folderId === null).map((m) => m.highlightId));
    } else {
      // Keys only: [highlightId, bankId] is the primary key.
      candidates = new Set(
        idsOf(await db.highlightBanks.where('bankId').equals(q.bankId).primaryKeys()),
      );
    }
  } else if (q.folderId === null) {
    throw new StudyVaultError('invalid_request', 'folderId: null needs a bankId');
  }

  if (q.tagIds !== undefined && q.tagIds.length > 0) {
    const tagRows = await db.tags.bulkGet(q.tagIds);
    const live = tagRows.map((r) => (r ? parseRow(Tag, r, 'tag') : null));
    const mode = q.tagMode ?? 'any';
    if (mode === 'all' && live.some((t) => t === null || t.deletedAt !== null)) return EMPTY;
    const liveIds = live
      .filter(notNull)
      .filter((t) => t.deletedAt === null)
      .map((t) => t.id);
    if (liveIds.length === 0) return EMPTY;
    let tagged: Set<string> | null = null;
    for (const tagId of liveIds) {
      const keys = await db.highlightTags.where('tagId').equals(tagId).primaryKeys();
      const ids = new Set(idsOf(keys));
      if (mode === 'any') {
        tagged ??= new Set();
        for (const id of ids) tagged.add(id);
      } else {
        tagged = intersect(tagged, ids);
      }
    }
    candidates = intersect(candidates, tagged ?? new Set());
  }

  const byIndex = async (index: string, values: ReadonlyArray<string | number>) =>
    new Set(idsOf(await keysWhereIn(db.highlights, index, values)));
  if (q.kinds !== undefined && q.kinds.length > 0) {
    candidates = intersect(candidates, await byIndex('kind', q.kinds));
  }
  if (q.priorities !== undefined && q.priorities.length > 0) {
    candidates = intersect(candidates, await byIndex('priority', q.priorities));
  }
  if (q.resolveStatuses !== undefined && q.resolveStatuses.length > 0) {
    candidates = intersect(candidates, await byIndex('resolveStatus', q.resolveStatuses));
  }
  if (q.sourceId !== undefined) {
    candidates = intersect(candidates, await byIndex('sourceId', [q.sourceId]));
  }
  if (q.hasNote !== undefined) {
    // One getAll beats a cursor walk (notes are few next to highlights).
    const withNote = new Set<string>();
    for (const n of await db.notes.toArray()) {
      if (!isDeleted(n) && n.highlightId !== null) withNote.add(n.highlightId);
    }
    if (q.hasNote) candidates = intersect(candidates, withNote);
    else exclude = withNote;
  }
  return { candidates, exclude };
}

// ---------------------------------------------------------------------------------------------
// ordering and cursor
// ---------------------------------------------------------------------------------------------

type SortKey = Array<string | number>;
type SortBy = z.infer<typeof SortBy>;

function sortKey(
  by: SortBy,
  row: Pick<Highlight, 'capturedAt' | 'updatedAt' | 'priority'>,
): SortKey {
  if (by === 'priority') return [row.priority, row.capturedAt];
  return [by === 'capturedAt' ? row.capturedAt : row.updatedAt];
}

function compareTuple(
  a: ReadonlyArray<string | number>,
  b: ReadonlyArray<string | number>,
): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x === y) continue;
    return x < y ? -1 : 1;
  }
  return 0;
}

interface Cursor {
  by: SortBy;
  dir: 'asc' | 'desc';
  key: SortKey;
  id: string;
}

const encodeCursor = (c: Cursor) => JSON.stringify([c.by, c.dir, c.key, c.id]);

function decodeCursor(raw: string, by: SortBy, dir: 'asc' | 'desc'): Cursor {
  const bad = () => new StudyVaultError('invalid_request', 'Invalid cursor');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw bad();
  }
  if (!Array.isArray(parsed) || parsed.length !== 4) throw bad();
  const [cBy, cDir, key, id] = parsed as [unknown, unknown, unknown, unknown];
  if (cBy !== by || cDir !== dir || typeof id !== 'string' || !Array.isArray(key)) throw bad();
  if (!key.every((k) => typeof k === 'string' || typeof k === 'number')) throw bad();
  return { by, dir, key: key as SortKey, id };
}

// ---------------------------------------------------------------------------------------------
// listHighlights
// ---------------------------------------------------------------------------------------------

export async function listHighlights(query: HighlightQuery = {}): Promise<HighlightPage> {
  const q = parseInput(QueryInput, query, 'highlight query');
  const limit = q.limit ?? DEFAULT_LIMIT;
  const by: SortBy = q.sort?.by ?? 'capturedAt';
  const dir = q.sort?.dir ?? 'desc';
  const sign = dir === 'desc' ? -1 : 1;
  const cursor = q.cursor ? decodeCursor(q.cursor, by, dir) : null;
  const range = q.dateRange
    ? { field: q.dateRange.field ?? 'capturedAt', from: q.dateRange.from, to: q.dateRange.to }
    : null;

  return withDb((db) =>
    db.transaction('r', READ_TABLES(db), async () => {
      const plan = await planQuery(db, q);
      if (plan.candidates !== null && plan.candidates.size === 0) {
        return { items: [], nextCursor: null };
      }

      const passes = (row: Highlight | (Record<string, unknown> & { id: string })): boolean => {
        const r = row as Highlight;
        if (isDeleted(r)) return false;
        if (plan.candidates && !plan.candidates.has(r.id)) return false;
        if (plan.exclude?.has(r.id)) return false;
        if (range) {
          const v = r[range.field];
          if (range.from !== undefined && v < range.from) return false;
          if (range.to !== undefined && v > range.to) return false;
        }
        if (cursor) {
          const t = compareTuple([...sortKey(by, r), r.id], [...cursor.key, cursor.id]);
          if (t * sign <= 0) return false; // keep only rows strictly after the cursor in page order
        }
        return true;
      };

      const matched: Highlight[] = [];
      if (plan.candidates !== null && plan.candidates.size <= CANDIDATE_FETCH_MAX) {
        // Few candidates: fetch them, order them by their raw sort keys, and validate (Zod) only
        // as many rows as the page needs.
        const fetched = await db.highlights.bulkGet([...plan.candidates]);
        const rows = fetched.filter((r): r is Highlight => r !== undefined && passes(r));
        rows.sort(
          (a, b) => sign * compareTuple([...sortKey(by, a), a.id], [...sortKey(by, b), b.id]),
        );
        for (const row of rows) {
          if (matched.length > limit) break;
          const parsed = parseRow(Highlight, row, 'highlight');
          if (parsed) matched.push(parsed);
        }
      } else {
        // Walk the sort index. Only the bounds that are really needed are declared: an unbounded
        // walk is the cheap path in every engine (and ~10x cheaper in fake-indexeddb), and a
        // cursor/range bound only appears from the second page on or with a date range.
        const index = by === 'priority' ? '[priority+capturedAt]' : by;
        let lower: unknown = null;
        let upper: unknown = null;
        if (by === 'priority') {
          // Plain bounds: IndexedDB engines disagree about Infinity/[] sentinels inside array keys.
          if (cursor) {
            if (sign > 0) lower = [cursor.key[0]!, cursor.key[1]!];
            else upper = [cursor.key[0]!, cursor.key[1]!];
          }
        } else {
          if (range && range.field === by) {
            lower = range.from ?? null;
            upper = range.to ?? null;
          }
          if (cursor) {
            const c = String(cursor.key[0]);
            if (sign < 0 && (upper === null || c < String(upper))) upper = c;
            if (sign > 0 && (lower === null || c > String(lower))) lower = c;
          }
        }
        let collection: Collection<Highlight, string>;
        if (lower === null && upper === null) collection = db.highlights.orderBy(index);
        else if (upper === null)
          collection = db.highlights.where(index).aboveOrEqual(lower as never);
        else if (lower === null)
          collection = db.highlights.where(index).belowOrEqual(upper as never);
        else
          collection = db.highlights
            .where(index)
            .between(lower as never, upper as never, true, true);
        if (sign < 0) collection = collection.reverse();
        await collection
          .until(() => matched.length > limit)
          .each((row) => {
            if (!passes(row)) return;
            const parsed = parseRow(Highlight, row, 'highlight');
            if (parsed) matched.push(parsed);
          });
      }

      const page = matched.slice(0, limit);
      const last = page.at(-1);
      const nextCursor =
        matched.length > limit && last
          ? encodeCursor({ by, dir, key: sortKey(by, last), id: last.id })
          : null;
      return { items: await toDashboardItems(db, page), nextCursor };
    }),
  );
}

export async function countHighlights(
  query: Omit<HighlightQuery, 'cursor' | 'limit' | 'sort'> = {},
): Promise<number> {
  const q = parseInput(QueryInput, query, 'highlight query');
  const range = q.dateRange
    ? { field: q.dateRange.field ?? 'capturedAt', from: q.dateRange.from, to: q.dateRange.to }
    : null;
  return withDb((db) =>
    db.transaction('r', READ_TABLES(db), async () => {
      const plan = await planQuery(db, q);
      const trashed = new Set(
        (await db.highlights.where('deletedAt').above('').primaryKeys()) as string[],
      );
      let ids: string[];
      if (plan.candidates !== null) ids = [...plan.candidates];
      else if (!range && !plan.exclude) {
        return (await db.highlights.count()) - trashed.size;
      } else ids = (await db.highlights.toCollection().primaryKeys()) as string[];
      ids = ids.filter((id) => !trashed.has(id) && !plan.exclude?.has(id));
      if (!range) return ids.length;
      let n = 0;
      for (const row of await inChunks(ids, 500, (chunk) => db.highlights.bulkGet(chunk))) {
        if (!row) continue;
        const v = row[range.field];
        if (range.from !== undefined && v < range.from) continue;
        if (range.to !== undefined && v > range.to) continue;
        n++;
      }
      return n;
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// dashboard items
// ---------------------------------------------------------------------------------------------

/** Joins for dashboard rows. Call inside a read transaction over db.tables. */
export async function toDashboardItems(
  db: StudyVaultDb,
  rows: Highlight[],
): Promise<DashboardItem[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const banks = new Map((await readBanks(db)).map((b) => [b.id, b]));
  const sources = await readSources(
    db,
    rows.map((r) => r.sourceId),
  );
  const memberships = await rowsWhereIn(db.highlightBanks, 'highlightId', ids);
  const links = await rowsWhereIn(db.highlightTags, 'highlightId', ids);
  const noteRows = await rowsWhereIn(db.notes, 'highlightId', ids);

  const tags = new Map<string, Tag>();
  for (const row of await db.tags.bulkGet(unique(links.map((l) => l.tagId)))) {
    const tag = row ? parseRow(Tag, row, 'tag') : null;
    if (tag && tag.deletedAt === null) tags.set(tag.id, tag);
  }
  // Only the folders these memberships name and their parents, not every folder of every bank
  // that appears on the page (a 50-row page of a bank with 5,000 folders read 5,000).
  const folders = await readFolderChains(
    db,
    memberships.filter((m) => banks.has(m.bankId)).map((m) => m.folderId),
  );
  const pathOf = (folderId: string | null): FolderRef[] => {
    const out: FolderRef[] = [];
    let cursor = folderId;
    for (let i = 0; cursor !== null && i < FOLDER_PATH_DEPTH; i++) {
      const f = folders.get(cursor);
      if (!f) break;
      out.unshift({ id: f.id, name: f.name });
      cursor = f.parentFolderId;
    }
    return out;
  };

  const noteCount = new Map<string, number>();
  for (const n of noteRows) {
    if (isDeleted(n) || n.highlightId === null) continue;
    noteCount.set(n.highlightId, (noteCount.get(n.highlightId) ?? 0) + 1);
  }

  const membersOf = new Map<string, typeof memberships>();
  for (const m of memberships) {
    if (!banks.has(m.bankId)) continue;
    const list = membersOf.get(m.highlightId) ?? [];
    list.push(m);
    membersOf.set(m.highlightId, list);
  }
  const tagsOf = new Map<string, TagLite[]>();
  for (const l of links) {
    const tag = tags.get(l.tagId);
    if (!tag) continue;
    const list = tagsOf.get(l.highlightId) ?? [];
    list.push({ id: tag.id, name: tag.name, color: tag.color });
    tagsOf.set(l.highlightId, list);
  }

  const items: DashboardItem[] = [];
  for (const row of rows) {
    const source = sources.get(row.sourceId);
    if (!source) {
      console.warn('[StudyVault] skipping highlight without a source', row.id);
      continue;
    }
    const own = (membersOf.get(row.id) ?? []).sort(
      (a, b) => cmp(a.addedAt, b.addedAt) || cmp(a.bankId, b.bankId),
    );
    const locations: Location[] = own.map((m) => ({
      bank: toLite(banks.get(m.bankId)!),
      folderPath: pathOf(m.folderId),
    }));
    items.push({
      highlight: toView(
        row,
        own.map((m) => m.bankId),
      ),
      source: toSourceRef(source),
      banks: locations.map((l) => l.bank),
      tags: (tagsOf.get(row.id) ?? []).sort((a, b) =>
        cmp(a.name.toLowerCase(), b.name.toLowerCase()),
      ),
      locations,
      noteCount: noteCount.get(row.id) ?? 0,
      customFields: row.customFields ?? {},
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }
  return items;
}

// ---------------------------------------------------------------------------------------------
// counts
// ---------------------------------------------------------------------------------------------

export async function getCounts(): Promise<VaultCounts> {
  return withDb((db) =>
    db.transaction('r', READ_TABLES(db), async () => {
      // Index counts include trashed highlights; those few are looked up and subtracted.
      const trashedRows = (await db.highlights
        .where('deletedAt')
        .above('')
        .toArray()) as Highlight[];
      const trashedIds = trashedRows.map((r) => r.id);
      const total = (await db.highlights.count()) - trashedRows.length;

      const kinds: Record<string, number> = {};
      for (const kind of HIGHLIGHT_KINDS) {
        const n = await db.highlights.where('kind').equals(kind).count();
        const gone = trashedRows.filter((r) => r.kind === kind).length;
        if (n - gone > 0) kinds[kind] = n - gone;
      }
      const priorities: Record<string, number> = {};
      for (const p of [1, 2, 3, 4, 5]) {
        const n = await db.highlights.where('priority').equals(p).count();
        const gone = trashedRows.filter((r) => r.priority === p).length;
        if (n - gone > 0) priorities[String(p)] = n - gone;
      }
      const resolveStatuses: Record<string, number> = {};
      for (const status of ResolveStatus.options) {
        const n = await db.highlights.where('resolveStatus').equals(status).count();
        const gone = trashedRows.filter((r) => r.resolveStatus === status).length;
        if (n - gone > 0) resolveStatuses[status] = n - gone;
      }

      const trashedMemberships = await rowsWhereIn(db.highlightBanks, 'highlightId', trashedIds);
      const banks: Record<string, number> = {};
      for (const bank of await readBanks(db)) {
        const n = await db.highlightBanks.where('bankId').equals(bank.id).count();
        const gone = trashedMemberships.filter((m) => m.bankId === bank.id).length;
        banks[bank.id] = Math.max(0, n - gone);
      }

      const folders: Record<string, number> = {};
      for (const row of await db.folders.toArray()) {
        if (isDeleted(row)) continue;
        const n = await db.highlightBanks.where('folderId').equals(row.id).count();
        const gone = trashedMemberships.filter((m) => m.folderId === row.id).length;
        if (n - gone > 0) folders[row.id] = n - gone;
      }

      const trashedLinks = await rowsWhereIn(db.highlightTags, 'highlightId', trashedIds);
      const tags: Record<string, number> = {};
      for (const row of await db.tags.toArray()) {
        if (isDeleted(row)) continue;
        const n = await db.highlightTags.where('tagId').equals(row.id).count();
        const gone = trashedLinks.filter((l) => l.tagId === row.id).length;
        if (n - gone > 0) tags[row.id] = n - gone;
      }

      return { total, banks, folders, tags, kinds, priorities, resolveStatuses };
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// detail and duplicates
// ---------------------------------------------------------------------------------------------

async function memberOf(
  db: StudyVaultDb,
  rows: Highlight[],
  sources: Map<string, HighlightListItem['source']>,
): Promise<DuplicateMember[]> {
  const memberships = await rowsWhereIn(
    db.highlightBanks,
    'highlightId',
    rows.map((r) => r.id),
  );
  return rows.map((r) => {
    const source = sources.get(r.sourceId);
    return {
      highlightId: r.id,
      sourceId: r.sourceId,
      sourceTitle: source?.title ?? '',
      host: source?.host ?? '',
      originalUrl: source?.originalUrl ?? '',
      sourceType: source?.type ?? 'web',
      bankIds: memberships.filter((m) => m.highlightId === r.id).map((m) => m.bankId),
      capturedAt: r.capturedAt,
      pageNumber: r.anchorSet.type === 'pdf' ? r.anchorSet.pageNumber : null,
      ...(source?.documentId === undefined ? {} : { documentId: source.documentId }),
    };
  });
}

export async function getHighlightDetail(
  id: string,
  options: { includeDeleted?: boolean } = {},
): Promise<HighlightDetail> {
  requireId(id);
  return withDb((db) =>
    db.transaction('r', READ_TABLES(db), async () => {
      const stored = await db.highlights.get(id);
      const row = stored ? parseRow(Highlight, stored, 'highlight') : null;
      if (!row || (row.deletedAt !== null && options.includeDeleted !== true)) {
        throw new StudyVaultError('not_found', 'Highlight not found');
      }
      const [item] = await toDashboardItems(db, [row]);
      if (!item) throw new StudyVaultError('not_found', 'The highlight’s source was not found');

      const notes = (await db.notes.where('highlightId').equals(id).toArray())
        .filter((n) => !isDeleted(n))
        .map((n) => parseRow(Note, n, 'note'))
        .filter(notNull)
        .sort(
          (a, b) =>
            Number(b.pinned) - Number(a.pinned) || cmp(b.updatedAt, a.updatedAt) || cmp(a.id, b.id),
        );

      const twins = (await db.highlights.where('quoteHash').equals(row.quoteHash).toArray())
        .filter((r) => r.id !== id && !isDeleted(r))
        .map((r) => parseRow(Highlight, r, 'highlight'))
        .filter(notNull);
      const sources = await readSources(
        db,
        twins.map((t) => t.sourceId),
      );
      const refs = new Map([...sources].map(([k, s]) => [k, toSourceRef(s)]));
      const duplicates = await memberOf(db, twins, refs);

      return {
        ...item,
        notes,
        duplicates,
        deletedAt: row.deletedAt,
        capturedUrl: row.capturedUrl ?? null,
        capturedTitle: row.capturedTitle ?? null,
        captureMethod: row.captureMethod,
      };
    }),
  );
}

export async function findDuplicateClusters(
  options: { limit?: number } = {},
): Promise<DuplicateCluster[]> {
  const limit = Math.min(Math.max(Math.floor(options.limit ?? 100), 1), 1000);
  return withDb((db) =>
    db.transaction('r', READ_TABLES(db), async () => {
      // Index keys only: a hash that appears twice (or more) is a candidate.
      const hashes = (await db.highlights.orderBy('quoteHash').keys()) as string[];
      const repeated: string[] = [];
      for (let i = 1; i < hashes.length; i++) {
        if (hashes[i] === hashes[i - 1] && repeated.at(-1) !== hashes[i]) repeated.push(hashes[i]!);
      }
      const clusters: Array<{ quoteHash: string; rows: Highlight[] }> = [];
      for (const hash of repeated) {
        const rows = (await db.highlights.where('quoteHash').equals(hash).toArray())
          .filter((r) => !isDeleted(r))
          .map((r) => parseRow(Highlight, r, 'highlight'))
          .filter(notNull);
        if (rows.length < 2) continue;
        // Two rows at the same place of the same source are one anchor, not a duplicate pair.
        const anchors: Highlight[] = [];
        for (const r of rows) {
          if (
            !anchors.some((a) => a.sourceId === r.sourceId && samePlace(a.anchorSet, r.anchorSet))
          ) {
            anchors.push(r);
          }
        }
        if (anchors.length >= 2) clusters.push({ quoteHash: hash, rows });
      }
      clusters.sort(
        (a, b) =>
          b.rows.length - a.rows.length ||
          cmp(
            b.rows
              .map((r) => r.capturedAt)
              .sort()
              .at(-1) ?? '',
            a.rows
              .map((r) => r.capturedAt)
              .sort()
              .at(-1) ?? '',
          ) ||
          cmp(a.quoteHash, b.quoteHash),
      );
      const page = clusters.slice(0, limit);
      const allRows = page.flatMap((c) => c.rows);
      const sources = await readSources(
        db,
        allRows.map((r) => r.sourceId),
      );
      const refs = new Map([...sources].map(([k, s]) => [k, toSourceRef(s)]));
      const out: DuplicateCluster[] = [];
      for (const c of page) {
        const members = await memberOf(
          db,
          [...c.rows].sort((a, b) => cmp(a.capturedAt, b.capturedAt) || cmp(a.id, b.id)),
          refs,
        );
        out.push({
          quoteHash: c.quoteHash,
          quote: c.rows[0]!.exactQuote,
          members,
          sourceCount: new Set(c.rows.map((r) => r.sourceId)).size,
        });
      }
      return out;
    }),
  );
}
