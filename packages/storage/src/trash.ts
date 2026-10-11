import type { Table } from 'dexie';
import {
  BankRecord,
  Folder,
  Highlight,
  INBOX_BANK_ID,
  Note,
  PdfDocument,
  Source,
  StudyVaultError,
  Tag,
} from '@shared';
import {
  cmp,
  ensureInbox,
  keysWhereIn,
  rowsWhereIn,
  isDeleted,
  notNull,
  now,
  parseRow,
  readBanks,
  requireId,
  signalChange,
  touchHighlights,
  unique,
} from './core';
import { STUDYVAULT_SYNC_POLICY, encodeEntityId } from '@sync';
import { withDb, withWritableDb, type MetaRow, type StudyVaultDb } from './db';
import { tableRegistry } from './registry';
import type { SyncOpRow } from './sync';
import type { PurgeResult, TrashItem, TrashKind, TrashRef } from './types';

/**
 * Soft-deleted rows ("trash") and the explicit, destructive purge. Soft deletion is how every
 * delete in StudyVault works; purge is the only place rows are physically removed, and it removes
 * what hangs off them in the same transaction so nothing is left pointing at a missing row.
 */

export const TRASH_KINDS: readonly TrashKind[] = [
  'highlight',
  'note',
  'folder',
  'bank',
  'tag',
  'document',
] as const;

const KIND_TABLE: Record<TrashKind, keyof StudyVaultDb & string> = {
  highlight: 'highlights',
  note: 'notes',
  folder: 'folders',
  bank: 'banks',
  tag: 'tags',
  document: 'documents',
};

const LAST_PURGE_KEY = 'lastPurgeAt';

const emptyResult = (): PurgeResult => ({
  purged: { highlight: 0, note: 0, folder: 0, bank: 0, tag: 0, document: 0 },
  related: {
    memberships: 0,
    tagLinks: 0,
    notes: 0,
    sources: 0,
    folders: 0,
    knowledgePoints: 0,
    cards: 0,
    reviewLogs: 0,
    aiResults: 0,
    attachments: 0,
    ocrPages: 0,
  },
});

const snippet = (text: string, max = 160) =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

function checkKinds(kinds: readonly TrashKind[] | undefined): TrashKind[] {
  const list = kinds ?? TRASH_KINDS;
  for (const k of list) {
    if (!TRASH_KINDS.includes(k)) {
      throw new StudyVaultError('invalid_request', `Unknown trash kind: ${String(k)}`);
    }
  }
  return unique(list);
}

/** Keys of the trashed rows of `kind`, optionally only those deleted before `cutoff`. */
async function trashedKeys(db: StudyVaultDb, kind: TrashKind, cutoff?: string): Promise<string[]> {
  if (kind === 'bank') {
    // `banks` has no deletedAt index (v1 layout kept); the table is tiny.
    return (await db.banks.toArray())
      .filter((b) => isDeleted(b) && (cutoff === undefined || b.deletedAt! < cutoff))
      .map((b) => b.id);
  }
  const table = db.table(KIND_TABLE[kind]) as Table<unknown, string>;
  // Rows that are not deleted have a null deletedAt, which IndexedDB leaves out of the index.
  const range =
    cutoff === undefined
      ? table.where('deletedAt').above('')
      : table.where('deletedAt').below(cutoff);
  return (await range.primaryKeys()) as string[];
}

// ---------------------------------------------------------------------------------------------
// listing
// ---------------------------------------------------------------------------------------------

export async function listTrash(
  options: { kinds?: TrashKind[]; limit?: number } = {},
): Promise<TrashItem[]> {
  const kinds = checkKinds(options.kinds);
  const limit = Math.min(Math.max(Math.floor(options.limit ?? 200), 1), 1000);
  return withDb((db) =>
    db.transaction('r', db.tables, async () => {
      const items: TrashItem[] = [];
      const bankNames = new Map<string, string>();
      for (const row of await db.banks.toArray()) {
        const bank = parseRow(BankRecord, row, 'bank');
        if (bank) bankNames.set(bank.id, bank.name);
      }
      for (const kind of kinds) {
        if (kind === 'highlight') {
          const rows: Highlight[] = [];
          await db.highlights
            .where('deletedAt')
            .above('')
            .reverse()
            .until(() => rows.length >= limit)
            .each((r) => {
              const h = parseRow(Highlight, r, 'highlight');
              if (h) rows.push(h);
            });
          const sources = new Map<string, Source>();
          for (const row of await db.sources.bulkGet(unique(rows.map((r) => r.sourceId)))) {
            const s = row ? parseRow(Source, row, 'source') : null;
            if (s) sources.set(s.id, s);
          }
          for (const h of rows) {
            items.push({
              kind,
              id: h.id,
              label: snippet(h.exactQuote),
              context: sources.get(h.sourceId)?.title ?? '',
              deletedAt: h.deletedAt!,
            });
          }
        } else if (kind === 'note') {
          const rows = await db.notes.where('deletedAt').above('').reverse().limit(limit).toArray();
          for (const row of rows) {
            const n = parseRow(Note, row, 'note');
            if (n) {
              items.push({
                kind,
                id: n.id,
                label: snippet(n.title || n.body),
                context: '',
                deletedAt: n.deletedAt!,
              });
            }
          }
        } else if (kind === 'folder') {
          const rows = await db.folders
            .where('deletedAt')
            .above('')
            .reverse()
            .limit(limit)
            .toArray();
          for (const row of rows) {
            const f = parseRow(Folder, row, 'folder');
            if (f) {
              items.push({
                kind,
                id: f.id,
                label: f.name,
                context: bankNames.get(f.bankId) ?? '',
                deletedAt: f.deletedAt!,
              });
            }
          }
        } else if (kind === 'bank') {
          for (const row of await db.banks.toArray()) {
            const b = isDeleted(row) ? parseRow(BankRecord, row, 'bank') : null;
            if (b) {
              items.push({ kind, id: b.id, label: b.name, context: '', deletedAt: b.deletedAt! });
            }
          }
        } else if (kind === 'tag') {
          const rows = await db.tags.where('deletedAt').above('').reverse().limit(limit).toArray();
          for (const row of rows) {
            const t = parseRow(Tag, row, 'tag');
            if (t)
              items.push({ kind, id: t.id, label: t.name, context: '', deletedAt: t.deletedAt! });
          }
        } else {
          const rows = await db.documents
            .where('deletedAt')
            .above('')
            .reverse()
            .limit(limit)
            .toArray();
          for (const row of rows) {
            const d = parseRow(PdfDocument, row, 'document');
            if (d) {
              items.push({
                kind,
                id: d.id,
                label: d.title || d.id,
                context: `${d.pageCount} pages`,
                deletedAt: d.deletedAt!,
              });
            }
          }
        }
      }
      return items.sort((a, b) => cmp(b.deletedAt, a.deletedAt) || cmp(a.id, b.id)).slice(0, limit);
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------------------------

async function rowOf(db: StudyVaultDb, kind: TrashKind, id: string): Promise<unknown> {
  return (db.table(KIND_TABLE[kind]) as Table<unknown, string>).get(id);
}

/** Resolve plain ids by probing the tables; a ref names its table. `null` when nothing is there. */
async function resolveRef(
  db: StudyVaultDb,
  ref: string | TrashRef,
): Promise<{ ref: TrashRef; row: { deletedAt?: unknown } } | null> {
  if (typeof ref !== 'string') {
    requireId(ref.id);
    if (!TRASH_KINDS.includes(ref.kind)) {
      throw new StudyVaultError('invalid_request', `Unknown trash kind: ${String(ref.kind)}`);
    }
    const row = await rowOf(db, ref.kind, ref.id);
    return row ? { ref, row: row as { deletedAt?: unknown } } : null;
  }
  requireId(ref);
  let live: { ref: TrashRef; row: { deletedAt?: unknown } } | null = null;
  for (const kind of TRASH_KINDS) {
    const row = await rowOf(db, kind, ref);
    if (!row) continue;
    const found = { ref: { kind, id: ref }, row: row as { deletedAt?: unknown } };
    if (isDeleted(found.row)) return found;
    live ??= found;
  }
  return live;
}

/**
 * Un-delete highlights (inside a rw transaction over banks, sources, highlights, highlightBanks).
 * Their source is revived if it was deleted, and a highlight whose banks are all gone is filed in
 * the Inbox again, so a restored highlight is always visible somewhere. Returns how many were
 * actually deleted before.
 */
export async function reviveHighlights(
  db: StudyVaultDb,
  ids: readonly string[],
  ts: string,
): Promise<number> {
  const rows = await db.highlights.bulkGet([...ids]);
  if (rows.some((r) => r === undefined)) {
    throw new StudyVaultError(
      'not_found',
      'Some of the selected highlights no longer exist; nothing was changed.',
    );
  }
  const revived = rows.filter((r): r is Highlight => r !== undefined && isDeleted(r));
  if (revived.length === 0) return 0;
  for (const row of revived) {
    await db.highlights.update(row.id, { deletedAt: null, updatedAt: ts });
  }
  for (const sourceId of unique(revived.map((r) => r.sourceId))) {
    const source = await db.sources.get(sourceId);
    if (source && isDeleted(source)) {
      await db.sources.update(sourceId, { deletedAt: null, updatedAt: ts });
    }
  }
  const liveBankIds = new Set((await readBanks(db)).map((b) => b.id));
  const members = await rowsWhereIn(
    db.highlightBanks,
    'highlightId',
    revived.map((r) => r.id),
  );
  const homed = new Set(members.filter((m) => liveBankIds.has(m.bankId)).map((m) => m.highlightId));
  const homeless = revived.filter((r) => !homed.has(r.id));
  if (homeless.length > 0) {
    const inbox = await ensureInbox(db, ts);
    for (const row of homeless) {
      await db.highlightBanks.put({
        highlightId: row.id,
        bankId: inbox.id,
        folderId: null,
        addedAt: ts,
      });
    }
  }
  return revived.length;
}

export async function restore(refs: Array<string | TrashRef>): Promise<{ restored: number }> {
  if (refs.length === 0) return { restored: 0 };
  const result = await withWritableDb((db) =>
    db.transaction('rw', db.tables, async () => {
      const ts = now();
      const resolved: TrashRef[] = [];
      let missing = 0;
      for (const ref of refs) {
        const hit = await resolveRef(db, ref);
        if (!hit) missing++;
        else if (isDeleted(hit.row)) resolved.push(hit.ref);
      }
      if (missing > 0) {
        throw new StudyVaultError(
          'not_found',
          `${missing} item(s) are no longer in the trash; nothing was restored.`,
        );
      }
      const ids = (kind: TrashKind) =>
        unique(resolved.filter((r) => r.kind === kind).map((r) => r.id));
      let restored = 0;

      // Banks first: folders and highlights restored in the same call may belong to them.
      for (const id of ids('bank')) {
        const row = parseRow(BankRecord, await db.banks.get(id), 'bank');
        if (!row) throw new StudyVaultError('internal', 'The bank record could not be read');
        const deletedAt = row.deletedAt;
        await db.banks.update(id, { deletedAt: null, updatedAt: ts });
        // Folders that went to the trash together with the bank come back with it.
        for (const f of await db.folders.where('bankId').equals(id).toArray()) {
          if (f.deletedAt !== null && f.deletedAt === deletedAt) {
            await db.folders.update(f.id, { deletedAt: null, updatedAt: ts });
          }
        }
        // Highlights that deleteBank also filed in the Inbox return to just this bank.
        const members = await db.highlightBanks.where('bankId').equals(id).toArray();
        for (const m of members) {
          const inbox = await db.highlightBanks.get([m.highlightId, INBOX_BANK_ID]);
          if (inbox && deletedAt !== null && inbox.addedAt === deletedAt) {
            await db.highlightBanks.delete([m.highlightId, INBOX_BANK_ID]);
          }
        }
        await touchHighlights(
          db,
          members.map((m) => m.highlightId),
          ts,
        );
        restored++;
      }

      for (const id of ids('document')) {
        await db.documents.update(id, { deletedAt: null, updatedAt: ts });
        restored++;
      }

      for (const id of ids('tag')) {
        const row = parseRow(Tag, await db.tags.get(id), 'tag');
        if (!row) throw new StudyVaultError('internal', 'The tag record could not be read');
        const clash = (await db.tags.toArray())
          .map((r) => parseRow(Tag, r, 'tag'))
          .filter(notNull)
          .find((t) => t.deletedAt === null && t.id !== id && t.nameKey === row.nameKey);
        if (clash) {
          throw new StudyVaultError(
            'invalid_request',
            `A tag called "${clash.name}" exists already; merge instead of restoring "${row.name}".`,
          );
        }
        await db.tags.update(id, { deletedAt: null, updatedAt: ts });
        restored++;
      }

      const folderIds = ids('folder');
      for (const id of folderIds) {
        const row = parseRow(Folder, await db.folders.get(id), 'folder');
        if (!row) throw new StudyVaultError('internal', 'The folder record could not be read');
        const bank = await db.banks.get(row.bankId);
        if (!bank || isDeleted(bank)) {
          throw new StudyVaultError(
            'invalid_request',
            'Restore the bank this folder belonged to first.',
          );
        }
        await db.folders.update(id, { deletedAt: null, updatedAt: ts });
        restored++;
      }
      // A folder whose parent is still in the trash (or gone) comes back at the bank root.
      for (const id of folderIds) {
        const row = await db.folders.get(id);
        if (!row || row.parentFolderId === null) continue;
        const parent = await db.folders.get(row.parentFolderId);
        if (!parent || isDeleted(parent)) {
          await db.folders.update(id, { parentFolderId: null });
        }
      }

      const highlightIds = ids('highlight');
      if (highlightIds.length > 0) restored += await reviveHighlights(db, highlightIds, ts);

      for (const id of ids('note')) {
        const row = parseRow(Note, await db.notes.get(id), 'note');
        if (!row) throw new StudyVaultError('internal', 'The note record could not be read');
        await db.notes.update(id, { deletedAt: null, updatedAt: ts });
        if (row.highlightId !== null) await touchHighlights(db, [row.highlightId], ts);
        restored++;
      }
      return { restored };
    }),
  );
  if (result.restored > 0) await signalChange();
  return result;
}

// ---------------------------------------------------------------------------------------------
// purge
// ---------------------------------------------------------------------------------------------

/** Rows physically removed by one purge: table name and primary key (an array when compound). */
type Gone = Array<readonly [table: string, key: unknown]>;

/**
 * Delete every row of `table` whose `index` value is in `values`, noting each in `gone`; returns
 * their primary keys.
 */
async function deleteWhere(
  gone: Gone,
  table: Table<unknown, unknown>,
  index: string,
  values: readonly string[],
): Promise<unknown[]> {
  if (values.length === 0) return [];
  const keys = await keysWhereIn(table as never, index, values);
  // Compound keys are arrays: dedupe by their JSON form.
  const distinct = [...new Map(keys.map((k) => [JSON.stringify(k), k])).values()];
  await table.bulkDelete(distinct);
  for (const key of distinct) gone.push([table.name, key]);
  return distinct;
}

const loose = (table: unknown) => table as Table<unknown, unknown>;

const isText = (v: unknown): v is string => typeof v === 'string';

/**
 * Knowledge points that outlive a purge (their own highlight is not purged) may still cite a purged
 * highlight. As primary quote it is re-homed to the point's own highlight, which always exists; as
 * claim evidence it is removed, and a point that was `source_supported` only by that evidence goes
 * back to `not_checked`, the label the schema requires of a point without evidence. Rows are read
 * raw: one that is not shaped like a knowledge point is left exactly as it is.
 */
async function repairKnowledgePoints(
  db: StudyVaultDb,
  doomed: ReadonlySet<string>,
  ts: string,
): Promise<void> {
  const evidenceOf = (claim: unknown): string[] => {
    const list = (claim as { evidenceHighlightIds?: unknown } | null)?.evidenceHighlightIds;
    return Array.isArray(list) ? list.filter(isText) : [];
  };
  const citesPurged = (claim: unknown) => evidenceOf(claim).some((id) => doomed.has(id));
  const affected = await db.knowledgePoints
    .filter(
      (kp) =>
        (isText(kp.primaryQuoteId) && doomed.has(kp.primaryQuoteId)) ||
        (Array.isArray(kp.claims) && kp.claims.some(citesPurged)),
    )
    .toArray();
  for (const kp of affected) {
    const changes: Record<string, unknown> = { updatedAt: ts };
    if (isText(kp.primaryQuoteId) && doomed.has(kp.primaryQuoteId) && isText(kp.highlightId)) {
      changes.primaryQuoteId = kp.highlightId;
    }
    if (Array.isArray(kp.claims)) {
      const claims: unknown[] = kp.claims.map((c: unknown) =>
        citesPurged(c)
          ? {
              ...(c as object),
              evidenceHighlightIds: evidenceOf(c).filter((id) => !doomed.has(id)),
            }
          : c,
      );
      changes.claims = claims;
      if (
        kp.verificationStatus === 'source_supported' &&
        !claims.some((c) => evidenceOf(c).length)
      ) {
        changes.verificationStatus = 'not_checked';
      }
    }
    await db.knowledgePoints.update(kp.id, changes);
  }
}

/**
 * Removes the AI results derived from any of `inputIds` (purged highlights and notes). A result holds
 * model output and verbatim evidence quotes copied from ALL of its inputs, but its `highlightId`
 * index names only the first input that is a highlight, so purging any other input, or a note, would
 * otherwise leave that text behind. `inputSourceIds` has no index and the table holds one row per AI
 * request, so it is scanned here, inside the purge transaction. Rows are read raw: an unreadable
 * row that names a purged input still goes. Returns how many rows were removed.
 */
async function dropAiResults(db: StudyVaultDb, inputIds: ReadonlySet<string>): Promise<number> {
  const keys = new Set((await keysWhereIn(db.aiResults, 'highlightId', [...inputIds])).map(String));
  await db.aiResults.each((row) => {
    const inputs = (row as { inputSourceIds?: unknown }).inputSourceIds;
    if (Array.isArray(inputs) && inputs.some((id) => isText(id) && inputIds.has(id))) {
      keys.add(row.id);
    }
  });
  if (keys.size > 0) await db.aiResults.bulkDelete([...keys]);
  return keys.size;
}

const SYNCED_TABLES: ReadonlySet<string> = new Set(Object.keys(STUDYVAULT_SYNC_POLICY));

/**
 * Sync bookkeeping that still holds the text of rows this purge removed. The removal itself reaches
 * other devices as a content-free tombstone: with sync capture on, the write interceptor has already
 * put one in the outbox for each removed row (and reconcile writes it later when capture was off).
 * Here, in the same transaction:
 *  - conflict records (both versions of the text) and quarantined operations of these entities go;
 *  - acknowledged outbox copies go: nothing reads a sent operation again but the retention prune;
 *  - unsent upserts go ONLY when the entity was never delivered: every outbox row of it is still
 *    unattempted and the first of them is the entity's first operation (baseRevision 0). Then no
 *    server or device has any state of it, so nothing is lost and no causal context is broken.
 * Unsent edits of an entity that HAS been delivered stay: the tombstone's causal context (`prev`)
 * names the clocks of those edits, so removing them would make receivers raise a spurious
 * "deleted remotely" conflict. They reach the server once and are removed by the tombstone behind
 * them. The merge metadata of a purged entity (clocks, fingerprints, tag-alias members) is kept
 * until tombstone retention prunes it: it is what makes the tombstone win.
 */
async function scrubSyncBookkeeping(db: StudyVaultDb, gone: Gone): Promise<void> {
  if (gone.length === 0) return;
  // Sync never ran here (or was cleared): the usual case costs three counts.
  const present =
    (await db.syncOps.count()) +
    (await db.syncConflicts.count()) +
    (await db.syncQuarantine.count());
  if (present === 0) return;

  const primaryKeys = new Map(tableRegistry.tables.map((t) => [t.name, t.primaryKey] as const));
  const entities = new Map<string, [entityType: string, entityId: string]>();
  for (const [table, key] of gone) {
    const primaryKey = primaryKeys.get(table);
    if (primaryKey === undefined || !SYNCED_TABLES.has(table)) continue;
    const fields = typeof primaryKey === 'string' ? [primaryKey] : primaryKey;
    const parts: unknown[] = Array.isArray(key) ? key : [key];
    try {
      const entityId = encodeEntityId(
        primaryKey,
        Object.fromEntries(fields.map((f, i) => [f, parts[i]])),
      );
      entities.set(`${table}\u0000${entityId}`, [table, entityId]);
    } catch {
      /* a key that cannot be an entity id has no operations */
    }
  }
  if (entities.size === 0) return;
  const pairs = [...entities.values()];
  const idOf = (type: unknown, id: unknown) => `${String(type)}\u0000${String(id)}`;

  const chains = new Map<string, SyncOpRow[]>();
  const ops = (await db.syncOps
    .where('[entityType+entityId]')
    .anyOf(pairs)
    .toArray()) as unknown as SyncOpRow[];
  for (const row of ops) {
    const k = idOf(row.entityType, row.entityId);
    chains.set(k, [...(chains.get(k) ?? []), row]);
  }
  const doomedOps: string[] = [];
  for (const chain of chains.values()) {
    const upserts = chain.filter((r) => r.op?.opType === 'upsert').sort((a, b) => a.seq - b.seq);
    for (const r of upserts) if (r.pending !== 1) doomedOps.push(r.id);
    const unsent = upserts.filter((r) => r.pending === 1);
    const neverDelivered = chain.every((r) => r.pending === 1 && r.attempts === 0);
    if (neverDelivered && unsent[0]?.op.baseRevision === 0) {
      for (const r of unsent) doomedOps.push(r.id);
    }
  }
  if (doomedOps.length > 0) await db.syncOps.bulkDelete(doomedOps);

  const conflicts = await db.syncConflicts
    .where('[entityType+entityId]')
    .anyOf(pairs)
    .primaryKeys();
  if (conflicts.length > 0) await db.syncConflicts.bulkDelete(conflicts);

  const quarantined = await db.syncQuarantine
    .where('entityType')
    .anyOf([...new Set(pairs.map(([type]) => type))])
    .filter((q) => entities.has(idOf(q.entityType, q.entityId)))
    .primaryKeys();
  if (quarantined.length > 0) await db.syncQuarantine.bulkDelete(quarantined);
}

/** Inside a rw transaction over every table. */
async function purgeInTx(db: StudyVaultDb, refs: readonly TrashRef[]): Promise<PurgeResult> {
  const out = emptyResult();
  const ts = now();
  const ids = (kind: TrashKind) => unique(refs.filter((r) => r.kind === kind).map((r) => r.id));
  const touchedHighlights = new Set<string>();
  /** Every row removed: the sync bookkeeping that refers to them is scrubbed at the end. */
  const gone: Gone = [];
  /** Highlights and notes removed: AI results derived from any of them go too. */
  const textIds = new Set<string>();
  const dropWhere = (table: unknown, index: string, values: readonly string[]) =>
    deleteWhere(gone, loose(table), index, values);
  /** A source goes when nothing (live or trashed) still refers to it. */
  const dropUnreferencedSources = async (sourceIds: readonly string[]) => {
    for (const sourceId of unique(sourceIds)) {
      const highlights = await db.highlights.where('sourceId').equals(sourceId).count();
      const notes = await db.notes.where('sourceId').equals(sourceId).count();
      if (highlights === 0 && notes === 0 && (await db.sources.get(sourceId))) {
        await db.sources.delete(sourceId);
        gone.push(['sources', sourceId]);
        out.related.sources++;
      }
    }
  };

  // ---- highlights and everything that hangs off them
  const highlightIds = ids('highlight');
  if (highlightIds.length > 0) {
    const rows = (await db.highlights.bulkGet(highlightIds)).filter(
      (r): r is Highlight => r !== undefined,
    );
    const doomed = rows.map((r) => r.id);
    const sourceIds = rows.map((r) => r.sourceId);
    for (const id of doomed) textIds.add(id);

    out.related.memberships += (await dropWhere(db.highlightBanks, 'highlightId', doomed)).length;
    out.related.tagLinks += (await dropWhere(db.highlightTags, 'highlightId', doomed)).length;
    // Notes written on these highlights go with them; their source may then be unreferenced.
    const noteRows = await rowsWhereIn(db.notes, 'highlightId', doomed);
    await db.notes.bulkDelete(noteRows.map((n) => n.id));
    for (const n of noteRows) {
      gone.push(['notes', n.id]);
      textIds.add(n.id);
      if (n.sourceId !== null) sourceIds.push(n.sourceId);
    }
    out.related.notes += noteRows.length;

    const kpIds = unique(
      (await keysWhereIn(db.knowledgePoints, 'highlightId', doomed)).map(String),
    );
    const cardIds = unique(
      [
        ...(await keysWhereIn(db.cards, 'highlightId', doomed)),
        ...(await keysWhereIn(db.cards, 'knowledgePointId', kpIds)),
      ].map(String),
    );
    out.related.reviewLogs += (await dropWhere(db.reviewLogs, 'cardId', cardIds)).length;
    if (cardIds.length > 0) await db.cards.bulkDelete(cardIds);
    for (const id of cardIds) gone.push(['cards', id]);
    out.related.cards += cardIds.length;
    if (kpIds.length > 0) await db.knowledgePoints.bulkDelete(kpIds);
    for (const id of kpIds) gone.push(['knowledgePoints', id]);
    out.related.knowledgePoints += kpIds.length;
    // A surviving point may cite a purged highlight as primary quote or as claim evidence.
    await repairKnowledgePoints(db, new Set(doomed), ts);

    await db.highlights.bulkDelete(doomed);
    for (const id of doomed) gone.push(['highlights', id]);
    out.purged.highlight += doomed.length;

    await dropUnreferencedSources(sourceIds);
  }

  // ---- notes
  const noteIds = ids('note');
  if (noteIds.length > 0) {
    const rows = (await db.notes.bulkGet(noteIds)).filter((r): r is Note => r !== undefined);
    for (const r of rows) if (r.highlightId !== null) touchedHighlights.add(r.highlightId);
    await db.notes.bulkDelete(rows.map((r) => r.id));
    for (const r of rows) {
      gone.push(['notes', r.id]);
      textIds.add(r.id);
    }
    out.purged.note += rows.length;
    // A source that only this note kept alive goes with it.
    await dropUnreferencedSources(rows.flatMap((r) => (r.sourceId === null ? [] : [r.sourceId])));
  }

  // ---- documents: the file's bytes and OCR text go; highlights made in it stay as quotes
  for (const id of ids('document')) {
    if (!(await db.documents.get(id))) continue;
    out.related.attachments += (await dropWhere(db.attachments, 'documentId', [id])).length;
    out.related.ocrPages += (await dropWhere(db.ocrPages, 'documentId', [id])).length;
    await db.documents.delete(id);
    gone.push(['documents', id]);
    out.purged.document++;
  }

  // ---- tags
  for (const id of ids('tag')) {
    if (!(await db.tags.get(id))) continue;
    const links = await db.highlightTags.where('tagId').equals(id).toArray();
    for (const l of links) touchedHighlights.add(l.highlightId);
    const linkKeys = links.map((l) => [l.highlightId, l.tagId] as [string, string]);
    await db.highlightTags.bulkDelete(linkKeys);
    for (const key of linkKeys) gone.push(['highlightTags', key]);
    out.related.tagLinks += links.length;
    await db.tags.delete(id);
    gone.push(['tags', id]);
    out.purged.tag++;
  }

  // ---- folders: whatever still points at them goes to the bank root
  for (const id of ids('folder')) {
    const row = await db.folders.get(id);
    if (!row) continue;
    for (const m of await db.highlightBanks.where('folderId').equals(id).toArray()) {
      await db.highlightBanks.update([m.highlightId, m.bankId], { folderId: null });
      touchedHighlights.add(m.highlightId);
    }
    for (const c of await db.folders.where('parentFolderId').equals(id).toArray()) {
      await db.folders.update(c.id, { parentFolderId: row.parentFolderId, updatedAt: ts });
    }
    await db.folders.delete(id);
    gone.push(['folders', id]);
    out.purged.folder++;
  }

  // ---- banks (the Inbox is never purged)
  for (const id of ids('bank')) {
    if (id === INBOX_BANK_ID) {
      throw new StudyVaultError('invalid_request', 'The Inbox cannot be purged.');
    }
    if (!(await db.banks.get(id))) continue;
    const members = await db.highlightBanks.where('bankId').equals(id).toArray();
    for (const m of members) touchedHighlights.add(m.highlightId);
    const memberKeys = members.map((m) => [m.highlightId, m.bankId] as [string, string]);
    await db.highlightBanks.bulkDelete(memberKeys);
    for (const key of memberKeys) gone.push(['highlightBanks', key]);
    out.related.memberships += members.length;
    const folderKeys = await db.folders.where('bankId').equals(id).primaryKeys();
    await db.folders.bulkDelete(folderKeys);
    for (const key of folderKeys) gone.push(['folders', key]);
    out.related.folders += folderKeys.length;
    // A deck that studied this bank becomes a free-standing deck (its bank is nullable), so it, its
    // cards and their review history do not dangle on a bank that no longer exists.
    for (const deckId of await db.decks.where('bankId').equals(id).primaryKeys()) {
      await db.decks.update(deckId, { bankId: null, updatedAt: ts });
    }
    await db.banks.delete(id);
    gone.push(['banks', id]);
    out.purged.bank++;
  }
  if (out.purged.bank > 0) {
    // A highlight that lost its last membership with a purged bank is filed in the Inbox.
    const liveIds = new Set((await readBanks(db)).map((b) => b.id));
    for (const hid of touchedHighlights) {
      const row = await db.highlights.get(hid);
      if (!row || isDeleted(row)) continue;
      const kept = await db.highlightBanks.where('highlightId').equals(hid).toArray();
      if (!kept.some((m) => liveIds.has(m.bankId))) {
        const inbox = await ensureInbox(db, ts);
        await db.highlightBanks.put({
          highlightId: hid,
          bankId: inbox.id,
          folderId: null,
          addedAt: ts,
        });
      }
    }
  }

  if (textIds.size > 0) out.related.aiResults += await dropAiResults(db, textIds);
  await scrubSyncBookkeeping(db, gone);

  await touchHighlights(db, [...touchedHighlights], ts);
  const total = Object.values(out.purged).reduce((a, b) => a + b, 0);
  if (total > 0) {
    const marker: MetaRow = { key: LAST_PURGE_KEY, value: ts, updatedAt: ts };
    await db.meta.put(marker);
  }
  return out;
}

/** Only trashed rows may be purged: a live id is refused so a stale UI cannot destroy live data. */
async function purgeRefs(
  refs: Array<string | TrashRef>,
  selector?: (db: StudyVaultDb) => Promise<TrashRef[]>,
): Promise<PurgeResult> {
  const result = await withWritableDb((db) =>
    db.transaction('rw', db.tables, async () => {
      const resolved: TrashRef[] = [];
      if (selector) resolved.push(...(await selector(db)));
      for (const ref of refs) {
        const hit = await resolveRef(db, ref);
        if (!hit) continue; // already gone: the goal state holds
        if (!isDeleted(hit.row)) {
          throw new StudyVaultError(
            'invalid_request',
            'Only items in the trash can be permanently deleted; nothing was removed.',
          );
        }
        resolved.push(hit.ref);
      }
      return purgeInTx(db, resolved);
    }),
  );
  if (Object.values(result.purged).some((n) => n > 0)) await signalChange();
  return result;
}

export const purge = (refs: Array<string | TrashRef>) => purgeRefs(refs);

export async function emptyTrash(kinds?: TrashKind[]): Promise<PurgeResult> {
  const list = checkKinds(kinds);
  return purgeRefs([], async (db) => {
    const out: TrashRef[] = [];
    for (const kind of list) {
      for (const id of await trashedKeys(db, kind)) out.push({ kind, id });
    }
    return out;
  });
}

export async function purgeOlderThan(
  days: number,
  options: { kinds?: TrashKind[]; now?: Date } = {},
): Promise<PurgeResult> {
  if (!Number.isFinite(days) || days < 0) {
    throw new StudyVaultError('invalid_request', 'days must be a non-negative number');
  }
  const list = checkKinds(options.kinds);
  const cutoff = new Date((options.now ?? new Date()).getTime() - days * 86_400_000).toISOString();
  return purgeRefs([], async (db) => {
    const out: TrashRef[] = [];
    for (const kind of list) {
      for (const id of await trashedKeys(db, kind, cutoff)) out.push({ kind, id });
    }
    return out;
  });
}

export async function getLastPurgeAt(): Promise<string | null> {
  return withDb(async (db) => {
    const row = await db.meta.get(LAST_PURGE_KEY);
    return typeof row?.value === 'string' ? row.value : null;
  });
}
