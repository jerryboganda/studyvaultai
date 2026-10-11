import { BankRecord, Folder, Highlight, IsoDate, Note, Tag, type SearchDocument } from '@shared';
import {
  cmp,
  keysWhereIn,
  rowsWhereIn,
  isDeleted,
  LOCAL_PDF_URL_PREFIX,
  notNull,
  parseInput,
  parseRow,
  readSources,
  unique,
} from './core';
import { withDb, type StudyVaultDb } from './db';

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

/** A local PDF has no address; do not index the synthetic one. */
const visibleUrl = (url: string) => (url.startsWith(LOCAL_PDF_URL_PREFIX) ? '' : url);

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

  const bankNames = new Map<string, string>();
  for (const row of await db.banks.toArray()) {
    const bank = isDeleted(row) ? null : parseRow(BankRecord, row, 'bank');
    if (bank) bankNames.set(bank.id, bank.name);
  }
  const folders = new Map<string, Folder>();
  for (const row of await db.folders.toArray()) {
    const f = isDeleted(row) ? null : parseRow(Folder, row, 'folder');
    if (f) folders.set(f.id, f);
  }
  const folderPath = (id: string | null): string[] => {
    const names: string[] = [];
    let cursor = id;
    for (let i = 0; cursor !== null && i < 16; i++) {
      const f = folders.get(cursor);
      if (!f) break;
      names.unshift(f.name);
      cursor = f.parentFolderId;
    }
    return names;
  };

  const memberships = await rowsWhereIn(db.highlightBanks, 'highlightId', hIds);
  const links = await rowsWhereIn(db.highlightTags, 'highlightId', hIds);
  const tags = new Map<string, Tag>();
  for (const row of await db.tags.bulkGet(unique(links.map((l) => l.tagId)))) {
    const tag = row ? parseRow(Tag, row, 'tag') : null;
    if (tag && tag.deletedAt === null) tags.set(tag.id, tag);
  }

  const facets = (highlightId: string) => {
    const mine = memberships.filter((m) => m.highlightId === highlightId);
    const bankList = unique(
      mine.map((m) => bankNames.get(m.bankId)).filter((n): n is string => n !== undefined),
    );
    const paths = unique(mine.flatMap((m) => folderPath(m.folderId)));
    const tagNames = unique(
      links
        .filter((l) => l.highlightId === highlightId)
        .flatMap((l) => {
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
      url: visibleUrl(h.capturedUrl ?? source?.originalUrl ?? ''),
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
      url: visibleUrl(h?.capturedUrl ?? source?.originalUrl ?? ''),
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

/** Everything, in id order. Page with `afterId` = the last document's id until an empty array. */
export async function listSearchDocuments(
  options: { afterId?: string; limit?: number } = {},
): Promise<SearchDocument[]> {
  const limit = clampLimit(options.limit);
  const after = options.afterId;
  return withDb((db) =>
    db.transaction('r', READ_TABLES(db), async () => {
      const page = (table: typeof db.highlights | typeof db.notes) =>
        (after === undefined ? table.orderBy(':id') : table.where(':id').above(after))
          .limit(limit)
          .toArray();
      const [h, n] = await Promise.all([page(db.highlights), page(db.notes)]);
      // Merge the two id-ordered streams and keep the first `limit` ids; the rest come next time.
      const ids = unique([...h.map((r) => r.id), ...n.map((r) => r.id)])
        .sort(cmp)
        .slice(0, limit);
      const keep = new Set(ids);
      return buildDocuments(
        db,
        parseHighlights(h.filter((r) => keep.has(r.id))),
        parseNotes(n.filter((r) => keep.has(r.id))),
      );
    }),
  );
}

/**
 * Documents whose indexed content may have changed since `since` (an ISO time: the largest
 * `updatedAt` the caller has seen). Includes trashed ones (`deletedAt` set) so the index can drop
 * them. A purge leaves no row to report: compare `getLastPurgeAt()` and rebuild when it is newer.
 */
export async function listSearchDocumentsChangedSince(options: {
  since: string;
  afterId?: string;
  limit?: number;
}): Promise<SearchDocument[]> {
  const since = parseInput(IsoDate, options.since, 'since');
  const limit = clampLimit(options.limit);
  const after = options.afterId;
  return withDb((db) =>
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

      const page = [...ids]
        .filter((id) => after === undefined || id > after)
        .sort(cmp)
        .slice(0, limit);
      const [h, n] = await Promise.all([db.highlights.bulkGet(page), db.notes.bulkGet(page)]);
      return buildDocuments(db, parseHighlights(h), parseNotes(n));
    }),
  );
}
