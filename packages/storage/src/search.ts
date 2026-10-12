import {
  BankRecord,
  Highlight,
  IsoDate,
  Note,
  Tag,
  visibleSourceUrl,
  type SearchDocument,
} from '@shared';
import {
  cmp,
  FOLDER_PATH_DEPTH,
  keysWhereIn,
  rowsWhereIn,
  isDeleted,
  notNull,
  parseInput,
  parseRow,
  readFolderChains,
  readSources,
  unique,
} from './core';
import { withDb, type StudyVaultDb } from './db';
import type { SearchFeedOptions } from './types';

/**
 * The feed the search package indexes. Plain objects, derived from the tables each time (the index
 * is never authoritative). Paging is by id order across highlights and notes together, so a caller
 * can pass the last document's id as `afterId` of the next call.
 */

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;

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

const clampLimit = (limit: number | undefined) =>
  Math.min(Math.max(Math.floor(limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);

async function buildDocuments(
  db: StudyVaultDb,
  highlights: Highlight[],
  notes: Note[],
): Promise<SearchDocument[]> {
  if (highlights.length === 0 && notes.length === 0) return [];
  // Notes of highlights that are not in this page still need their highlight's quote and facets.
  const have = new Map(highlights.map((h) => [h.id, h]));
  const extraIds = unique(
    notes.map((n) => n.highlightId).filter((id): id is string => id !== null && !have.has(id)),
  );
  for (const row of await db.highlights.bulkGet(extraIds)) {
    const h = row ? parseRow(Highlight, row, 'highlight') : null;
    if (h) have.set(h.id, h);
  }
  const hIds = [...have.keys()];

  const sources = await readSources(db, [
    ...[...have.values()].map((h) => h.sourceId),
    ...notes.map((n) => n.sourceId).filter((id): id is string => id !== null),
  ]);

  const memberships = await rowsWhereIn(db.highlightBanks, 'highlightId', hIds);
  const links = await rowsWhereIn(db.highlightTags, 'highlightId', hIds);

  // Only the banks and folders this page's memberships name (and the parents of those folders):
  // this runs once per page of 500 documents and once per catch-up, so reading every bank and
  // folder of the vault each time made a full build cost pages x folders row parses.
  const bankNames = new Map<string, string>();
  for (const row of await db.banks.bulkGet(unique(memberships.map((m) => m.bankId)))) {
    const bank = !row || isDeleted(row) ? null : parseRow(BankRecord, row, 'bank');
    if (bank) bankNames.set(bank.id, bank.name);
  }
  const folders = await readFolderChains(
    db,
    memberships.map((m) => m.folderId),
  );
  const folderPath = (id: string | null): string[] => {
    const names: string[] = [];
    let cursor = id;
    for (let i = 0; cursor !== null && i < FOLDER_PATH_DEPTH; i++) {
      const f = folders.get(cursor);
      if (!f) break;
      names.unshift(f.name);
      cursor = f.parentFolderId;
    }
    return names;
  };

  const tags = new Map<string, Tag>();
  for (const row of await db.tags.bulkGet(unique(links.map((l) => l.tagId)))) {
    const tag = row ? parseRow(Tag, row, 'tag') : null;
    if (tag && tag.deletedAt === null) tags.set(tag.id, tag);
  }

  // Grouped once: filtering both lists for every highlight made a page quadratic in its size.
  const group = <T extends { highlightId: string }>(rows: readonly T[]): Map<string, T[]> => {
    const out = new Map<string, T[]>();
    for (const r of rows) {
      const list = out.get(r.highlightId);
      if (list) list.push(r);
      else out.set(r.highlightId, [r]);
    }
    return out;
  };
  const membershipsOf = group(memberships);
  const linksOf = group(links);

  const facets = (highlightId: string) => {
    const mine = membershipsOf.get(highlightId) ?? [];
    const bankList = unique(
      mine.map((m) => bankNames.get(m.bankId)).filter((n): n is string => n !== undefined),
    );
    const paths = unique(mine.flatMap((m) => folderPath(m.folderId)));
    const tagNames = unique(
      (linksOf.get(highlightId) ?? []).flatMap((l) => {
        const t = tags.get(l.tagId);
        return t ? [t.name, ...t.aliases] : [];
      }),
    );
    return { tags: tagNames, banks: bankList, folderPath: paths };
  };

  const docs: SearchDocument[] = [];
  for (const h of highlights) {
    const source = sources.get(h.sourceId);
    docs.push({
      id: h.id,
      docType: 'highlight',
      highlightId: h.id,
      title: source?.title ?? h.capturedTitle ?? '',
      url: visibleSourceUrl(h.capturedUrl ?? source?.originalUrl),
      host: source?.host ?? '',
      quote: h.exactQuote,
      comment: h.userComment,
      headingContext: h.headingContext,
      ...facets(h.id),
      kind: h.kind,
      priority: h.priority,
      resolveStatus: h.resolveStatus,
      updatedAt: h.updatedAt,
      deletedAt: h.deletedAt,
    });
  }
  for (const n of notes) {
    const h = n.highlightId === null ? undefined : have.get(n.highlightId);
    const source = sources.get(h?.sourceId ?? n.sourceId ?? '');
    docs.push({
      id: n.id,
      docType: 'note',
      highlightId: n.highlightId,
      title: source?.title ?? n.title,
      url: visibleSourceUrl(h?.capturedUrl ?? source?.originalUrl),
      host: source?.host ?? '',
      quote: h?.exactQuote ?? '',
      comment: n.title ? `${n.title}\n${n.body}` : n.body,
      headingContext: h?.headingContext ?? null,
      ...(h ? facets(h.id) : { tags: [], banks: [], folderPath: [] }),
      kind: h?.kind ?? null,
      priority: h?.priority ?? null,
      resolveStatus: h?.resolveStatus ?? null,
      updatedAt: n.updatedAt,
      // A note of a trashed highlight is not findable either.
      deletedAt: n.deletedAt ?? h?.deletedAt ?? null,
    });
  }
  return docs.sort((a, b) => cmp(a.id, b.id));
}

const parseHighlights = (rows: Array<unknown | undefined>) =>
  rows.map((r) => (r ? parseRow(Highlight, r, 'highlight') : null)).filter(notNull);
const parseNotes = (rows: Array<unknown | undefined>) =>
  rows.map((r) => (r ? parseRow(Note, r, 'note') : null)).filter(notNull);

/**
 * Everything, in id order, `limit` documents at a time. A row that exists but cannot be read is
 * passed over (counted in `onSkipped`) and the page is filled from the rows after it, so a page
 * shorter than `limit` is the last one: callers page with "fewer than `limit` means done".
 */
export async function listSearchDocuments(
  options: SearchFeedOptions = {},
): Promise<SearchDocument[]> {
  const limit = clampLimit(options.limit);
  const docs: SearchDocument[] = [];
  let skipped = 0;
  await withDb((db) =>
    db.transaction('r', READ_TABLES(db), async () => {
      let after = options.afterId;
      while (docs.length < limit) {
        const need = limit - docs.length;
        const page = (table: typeof db.highlights | typeof db.notes) =>
          (after === undefined ? table.orderBy(':id') : table.where(':id').above(after))
            .limit(need)
            .toArray();
        const [h, n] = await Promise.all([page(db.highlights), page(db.notes)]);
        // Merge the two id-ordered streams and keep the first `need` ids; the rest come next time.
        const ids = unique([...h.map((r) => r.id), ...n.map((r) => r.id)])
          .sort(cmp)
          .slice(0, need);
        if (ids.length === 0) break;
        const keep = new Set(ids);
        const hRows = h.filter((r) => keep.has(r.id));
        const nRows = n.filter((r) => keep.has(r.id));
        const hs = parseHighlights(hRows);
        const ns = parseNotes(nRows);
        skipped += hRows.length + nRows.length - hs.length - ns.length;
        docs.push(...(await buildDocuments(db, hs, ns)));
        after = ids[ids.length - 1];
        if (ids.length < need) break; // both tables are exhausted
      }
    }),
  );
  if (skipped > 0) options.onSkipped?.(skipped);
  return docs;
}

/**
 * Documents whose indexed content may have changed since `since` (an ISO time: the largest
 * `updatedAt` the caller has seen). Includes trashed ones (`deletedAt` set) so the index can drop
 * them. A purge leaves no row to report: compare `getLastPurgeAt()` and rebuild when it is newer.
 * Paged like `listSearchDocuments`. An id that names no row (a tag link or membership left behind
 * a purged highlight) is nothing to index: it is passed over and not counted as skipped.
 */
export async function listSearchDocumentsChangedSince(
  options: SearchFeedOptions & { since: string },
): Promise<SearchDocument[]> {
  const since = parseInput(IsoDate, options.since, 'since');
  const limit = clampLimit(options.limit);
  const after = options.afterId;
  const docs: SearchDocument[] = [];
  let skipped = 0;
  await withDb((db) =>
    db.transaction('r', READ_TABLES(db), async () => {
      const ids = new Set<string>();
      const add = (keys: Array<unknown | undefined>) => {
        for (const k of keys) if (typeof k === 'string') ids.add(k);
      };
      add(await db.highlights.where('updatedAt').aboveOrEqual(since).primaryKeys());
      add(await db.notes.where('updatedAt').aboveOrEqual(since).primaryKeys());

      // Renamed or deleted tags/banks/folders change every document that uses them.
      const tagIds = (await db.tags
        .where('updatedAt')
        .aboveOrEqual(since)
        .primaryKeys()) as string[];
      const links = await rowsWhereIn(db.highlightTags, 'tagId', tagIds);
      add(links.map((l) => l.highlightId));
      const bankIds = (await db.banks.toArray())
        .filter((b) => b.updatedAt >= since)
        .map((b) => b.id);
      const folderIds = (await db.folders
        .where('updatedAt')
        .aboveOrEqual(since)
        .primaryKeys()) as string[];
      const members = [
        ...(await rowsWhereIn(db.highlightBanks, 'bankId', bankIds)),
        ...(await rowsWhereIn(db.highlightBanks, 'folderId', folderIds)),
      ];
      add(members.map((m) => m.highlightId));
      // A note's document carries its highlight's facets, so it moves with the highlight.
      const ofChanged = await keysWhereIn(db.notes, 'highlightId', [...ids]);
      add(ofChanged);

      const eligible = [...ids].filter((id) => after === undefined || id > after).sort(cmp);
      // Chunks of what is still missing from the page: ids without a row, and rows that cannot be
      // read, make a chunk yield less than it holds, and the next chunk fills the page.
      for (let at = 0; docs.length < limit && at < eligible.length;) {
        const chunk = eligible.slice(at, at + (limit - docs.length));
        at += chunk.length;
        const [h, n] = await Promise.all([db.highlights.bulkGet(chunk), db.notes.bulkGet(chunk)]);
        const hs = parseHighlights(h);
        const ns = parseNotes(n);
        skipped += h.filter(Boolean).length + n.filter(Boolean).length - hs.length - ns.length;
        docs.push(...(await buildDocuments(db, hs, ns)));
      }
    }),
  );
  if (skipped > 0) options.onSkipped?.(skipped);
  return docs;
}
