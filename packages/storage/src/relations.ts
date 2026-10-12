import { uuidv7 } from 'uuidv7';
import type { z } from 'zod';
import {
  MAX_RELATION_NOTE_CHARS,
  RELATION_ENTITY_KINDS,
  Relation,
  RelationEntityKind,
  RelationType,
  SCHEMA_VERSION,
  StudyVaultError,
} from '@shared';
import {
  cmp,
  isDeleted,
  keysWhereIn,
  notNull,
  now,
  parseRow,
  requireId,
  signalChange,
  unique,
} from './core';
import { withDb, withWritableDb, type StudyVaultDb } from './db';
import { invalid, nextStamp, parseStrict, type SaveOutcome } from './organisation';
import { relationKey } from './registry';

/**
 * Relations (schema v4, ADR-011): directed links between the person's own highlights, knowledge
 * points and notes. They never touch what the ends say.
 *
 *  - A link is unique by (fromKind, fromId, toKind, toId, type); "related" has no direction, so
 *    A -> B and B -> A count as the same link. `createRelation` returns the existing one.
 *  - No item links to itself.
 *  - An end that is in the trash hides the relation (it is not deleted: restoring the end shows it
 *    again, with nothing to un-delete). An end that is purged takes its relations with it, in the
 *    purge's own transaction (`dropRelationsOf`, called by trash.ts).
 */

const TABLE_OF: Record<RelationEntityKind, 'highlights' | 'notes' | 'knowledgePoints'> = {
  highlight: 'highlights',
  note: 'notes',
  knowledgePoint: 'knowledgePoints',
};

const LABEL: Record<RelationEntityKind, string> = {
  highlight: 'Highlight',
  note: 'Note',
  knowledgePoint: 'Knowledge point',
};

export interface RelationRef {
  kind: RelationEntityKind;
  id: string;
}

export interface RelationInput {
  fromKind: RelationEntityKind;
  fromId: string;
  toKind: RelationEntityKind;
  toId: string;
  type: RelationType;
  /** Up to 500 characters; optional. */
  note?: string;
}

export type CreateRelationStatus = 'created' | 'existing' | 'restored';

const TABLES = (db: StudyVaultDb) => [db.relations, db.highlights, db.notes, db.knowledgePoints];

function cleanNote(note: string | undefined): string | undefined {
  if (note === undefined) return undefined;
  const text = String(note).trim();
  if (text.length > MAX_RELATION_NOTE_CHARS) {
    throw invalid(`A note can have at most ${MAX_RELATION_NOTE_CHARS} characters.`);
  }
  return text === '' ? undefined : text;
}

/** The end must exist and not be in the trash. */
async function assertLiveEnd(
  db: StudyVaultDb,
  kind: RelationEntityKind,
  id: string,
): Promise<void> {
  const row = (await db.table(TABLE_OF[kind]).get(id)) as { deletedAt?: unknown } | undefined;
  if (!row || isDeleted(row)) throw new StudyVaultError('not_found', `${LABEL[kind]} not found`);
}

/** A value of a closed set, or an `invalid_request` that names what was meant (never a ZodError). */
function oneOf<T extends string>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalid(`Invalid ${what}: "${String(value)}".`);
  return parsed.data;
}

const readRelations = (rows: readonly unknown[]): Relation[] =>
  rows.map((row) => parseRow(Relation, row, 'relation')).filter(notNull);

const oldestFirst = (a: Relation, b: Relation) => cmp(a.createdAt, b.createdAt) || cmp(a.id, b.id);

/**
 * `kind:id` of every end (of `rows`) that exists and is not in the trash. A note or knowledge point
 * counts as in the trash while the highlight it belongs to is: moving a highlight to the trash does
 * not stamp them, but nothing of theirs can be opened until it is back.
 */
async function liveEnds(db: StudyVaultDb, rows: readonly Relation[]): Promise<Set<string>> {
  const wanted: Record<RelationEntityKind, string[]> = {
    highlight: [],
    note: [],
    knowledgePoint: [],
  };
  for (const r of rows) {
    wanted[r.fromKind].push(r.fromId);
    wanted[r.toKind].push(r.toId);
  }
  const live = new Set<string>();
  const host = new Map<string, string>();
  for (const kind of RELATION_ENTITY_KINDS) {
    const ids = unique(wanted[kind]);
    if (ids.length === 0) continue;
    const found = (await db.table(TABLE_OF[kind]).bulkGet(ids)) as Array<
      { deletedAt?: unknown; highlightId?: unknown } | undefined
    >;
    found.forEach((row, i) => {
      if (row === undefined || isDeleted(row)) return;
      const key = `${kind}:${ids[i]}`;
      live.add(key);
      if (kind !== 'highlight' && typeof row.highlightId === 'string')
        host.set(key, row.highlightId);
    });
  }
  const hostIds = unique([...host.values()]);
  if (hostIds.length > 0) {
    const rowsOf = await db.highlights.bulkGet(hostIds);
    const open = new Set(
      hostIds.filter((_, i) => rowsOf[i] !== undefined && !isDeleted(rowsOf[i]!)),
    );
    for (const [key, hostId] of host) if (!open.has(hostId)) live.delete(key);
  }
  return live;
}

/** Visible relations of `rows`: own row not deleted, both ends live, repeats of one link folded. */
async function visible(db: StudyVaultDb, rows: Relation[]): Promise<Relation[]> {
  const own = rows.filter((r) => r.deletedAt === null);
  const ends = await liveEnds(db, own);
  const seen = new Set<string>();
  return own
    .filter((r) => ends.has(`${r.fromKind}:${r.fromId}`) && ends.has(`${r.toKind}:${r.toId}`))
    .sort(oldestFirst)
    .filter((r) => {
      const key = relationKey(r);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

// ---------------------------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------------------------

/**
 * The visible relations that touch one item, oldest first. `direction`: links that start at it
 * (`from`), end at it (`to`), or both (default).
 */
export async function listRelationsFor(
  ref: RelationRef,
  options: { direction?: 'from' | 'to' | 'both'; types?: readonly RelationType[] } = {},
): Promise<Relation[]> {
  const kind = oneOf(RelationEntityKind, ref.kind, 'kind of item');
  requireId(ref.id);
  const direction = options.direction ?? 'both';
  const types = options.types === undefined ? null : new Set(options.types);
  return withDb((db) =>
    db.transaction('r', TABLES(db), async () => {
      const rows: unknown[] = [];
      if (direction !== 'to') {
        rows.push(
          ...(await db.relations.where('[fromKind+fromId]').equals([kind, ref.id]).toArray()),
        );
      }
      if (direction !== 'from') {
        rows.push(...(await db.relations.where('[toKind+toId]').equals([kind, ref.id]).toArray()));
      }
      const parsed = [...new Map(readRelations(rows).map((r) => [r.id, r])).values()];
      return visible(
        db,
        parsed.filter((r) => types === null || types.has(r.type)),
      );
    }),
  );
}

/** Every visible relation (what the graph draws), oldest first, at most `limit` (default 5000). */
export async function listAllRelations(
  options: { types?: readonly RelationType[]; limit?: number } = {},
): Promise<Relation[]> {
  const limit = Math.min(Math.max(Math.floor(options.limit ?? 5000), 1), 50_000);
  const types = options.types === undefined ? null : new Set(options.types);
  return withDb((db) =>
    db.transaction('r', TABLES(db), async () => {
      const rows = readRelations(await db.relations.toArray());
      const out = await visible(
        db,
        rows.filter((r) => types === null || types.has(r.type)),
      );
      return out.slice(0, limit);
    }),
  );
}

/** One relation by id, if its own row is not deleted (its ends are not looked at). */
export async function getRelation(id: string): Promise<Relation | null> {
  requireId(id);
  return withDb(async (db) => {
    const row = await db.relations.get(id);
    const relation = row ? parseRow(Relation, row, 'relation') : null;
    return relation && relation.deletedAt === null ? relation : null;
  });
}

// ---------------------------------------------------------------------------------------------
// writing
// ---------------------------------------------------------------------------------------------

/**
 * Link two items. Both must exist and not be in the trash, and they must differ. When the same link
 * is already there nothing is created: `existing` returns it (the note of this call is not applied;
 * use `updateRelationNote`), and a deleted one is brought back as `restored`.
 */
export async function createRelation(
  input: RelationInput,
): Promise<{ relation: Relation; status: CreateRelationStatus }> {
  const fromKind = oneOf(RelationEntityKind, input.fromKind, 'kind of item');
  const toKind = oneOf(RelationEntityKind, input.toKind, 'kind of item');
  const type = oneOf(RelationType, input.type, 'type of link');
  const fromId = requireId(input.fromId);
  const toId = requireId(input.toId);
  if (fromKind === toKind && fromId === toId) throw invalid('An item cannot be linked to itself.');
  const note = cleanNote(input.note);
  const out = await withWritableDb((db) =>
    db.transaction('rw', TABLES(db), async () => {
      await assertLiveEnd(db, fromKind, fromId);
      await assertLiveEnd(db, toKind, toId);
      const key = relationKey({ fromKind, fromId, toKind, toId, type });
      const near = await db.relations
        .where('[fromKind+fromId]')
        .equals([fromKind, fromId])
        .toArray();
      if (type === 'related') {
        near.push(
          ...(await db.relations.where('[fromKind+fromId]').equals([toKind, toId]).toArray()),
        );
      }
      const same = readRelations(near)
        .filter((r) => relationKey(r) === key)
        .sort(oldestFirst);
      const live = same.find((r) => r.deletedAt === null);
      if (live) return { relation: live, status: 'existing' as const, changed: false };
      const trashed = same[0];
      if (trashed) {
        const { note: kept, ...rest } = trashed;
        const keep = note ?? (input.note === undefined ? kept : undefined);
        const relation: Relation = {
          ...rest,
          ...(keep === undefined ? {} : { note: keep }),
          deletedAt: null,
          updatedAt: nextStamp(trashed.updatedAt, now()),
        };
        await db.relations.put(relation);
        return { relation, status: 'restored' as const, changed: true };
      }
      const ts = now();
      const relation = parseStrict(
        Relation,
        {
          id: uuidv7(),
          schemaVersion: SCHEMA_VERSION,
          createdAt: ts,
          updatedAt: ts,
          deletedAt: null,
          fromKind,
          fromId,
          toKind,
          toId,
          type,
          ...(note === undefined ? {} : { note }),
        },
        'relation',
      );
      await db.relations.add(relation);
      return { relation, status: 'created' as const, changed: true };
    }),
  );
  if (out.changed) await signalChange();
  return { relation: out.relation, status: out.status };
}

/**
 * Set (or, with '', remove) a relation's note. With `expectedVersion` (the relation's `updatedAt` as
 * the editor read it) a relation that changed since is left alone and returned as `stale`.
 */
export async function updateRelationNote(
  id: string,
  note: string,
  options: { expectedVersion?: string } = {},
): Promise<SaveOutcome<Relation>> {
  requireId(id);
  const cleaned = cleanNote(note);
  const { outcome, changed } = await withWritableDb((db) =>
    db.transaction('rw', db.relations, async () => {
      const row = await db.relations.get(id);
      const current = row && !isDeleted(row) ? parseRow(Relation, row, 'relation') : null;
      if (!current) throw new StudyVaultError('not_found', 'Relation not found');
      if (options.expectedVersion !== undefined && options.expectedVersion !== current.updatedAt) {
        return { outcome: { status: 'stale', row: current } as const, changed: false };
      }
      if (cleaned === current.note) {
        return { outcome: { status: 'saved', row: current } as const, changed: false };
      }
      const { note: _old, ...rest } = current;
      const next: Relation = {
        ...rest,
        ...(cleaned === undefined ? {} : { note: cleaned }),
        updatedAt: nextStamp(current.updatedAt, now()),
      };
      await db.relations.put(next);
      return { outcome: { status: 'saved', row: next } as const, changed: true };
    }),
  );
  if (changed) await signalChange();
  return outcome;
}

/** Soft delete (undo with `restoreRelation`). Deleting a deleted relation is not an error. */
export async function deleteRelation(id: string): Promise<void> {
  requireId(id);
  const changed = await withWritableDb((db) =>
    db.transaction('rw', db.relations, async () => {
      const row = await db.relations.get(id);
      const relation = row ? parseRow(Relation, row, 'relation') : null;
      if (!relation) throw new StudyVaultError('not_found', 'Relation not found');
      if (relation.deletedAt !== null) return false;
      const ts = nextStamp(relation.updatedAt, now());
      await db.relations.put({ ...relation, deletedAt: ts, updatedAt: ts });
      return true;
    }),
  );
  if (changed) await signalChange();
}

export async function restoreRelation(id: string): Promise<Relation> {
  requireId(id);
  const { relation, changed } = await withWritableDb((db) =>
    db.transaction('rw', db.relations, async () => {
      const row = await db.relations.get(id);
      const found = row ? parseRow(Relation, row, 'relation') : null;
      if (!found) throw new StudyVaultError('not_found', 'Relation not found');
      if (found.deletedAt === null) return { relation: found, changed: false };
      const next: Relation = {
        ...found,
        deletedAt: null,
        updatedAt: nextStamp(found.updatedAt, now()),
      };
      await db.relations.put(next);
      return { relation: next, changed: true };
    }),
  );
  if (changed) await signalChange();
  return relation;
}

/** Remove deleted relations for good: the given ids (each must be deleted), or all when omitted. */
export async function purgeRelations(ids?: readonly string[]): Promise<number> {
  const wanted = ids === undefined ? null : unique(ids.map(requireId));
  const removed = await withWritableDb((db) =>
    db.transaction('rw', db.relations, async () => {
      const doomed: string[] = [];
      if (wanted === null) {
        await db.relations
          .where('deletedAt')
          .above('')
          .each((row) => {
            doomed.push(row.id);
          });
      } else {
        for (const row of await db.relations.bulkGet(wanted)) {
          if (!row) continue;
          if (!isDeleted(row)) {
            throw invalid('Only deleted relations can be removed for good; nothing was removed.');
          }
          doomed.push(row.id);
        }
      }
      if (doomed.length > 0) await db.relations.bulkDelete(doomed);
      return doomed.length;
    }),
  );
  if (removed > 0) await signalChange();
  return removed;
}

/**
 * Remove relations (deleted or not) whose end does not exist at all, which only a restore, an import
 * or a sync of inconsistent data can leave behind (a purge removes them itself). Returns how many.
 */
export async function pruneDanglingRelations(): Promise<number> {
  const removed = await withWritableDb((db) =>
    db.transaction('rw', TABLES(db), async () => {
      const rows = readRelations(await db.relations.toArray());
      const wanted: Record<RelationEntityKind, string[]> = {
        highlight: [],
        note: [],
        knowledgePoint: [],
      };
      for (const r of rows) {
        wanted[r.fromKind].push(r.fromId);
        wanted[r.toKind].push(r.toId);
      }
      const exists = new Set<string>();
      for (const kind of RELATION_ENTITY_KINDS) {
        const found = unique(wanted[kind]);
        if (found.length === 0) continue;
        const keys = await db.table(TABLE_OF[kind]).bulkGet(found);
        keys.forEach((row, i) => {
          if (row !== undefined) exists.add(`${kind}:${found[i]}`);
        });
      }
      const doomed = rows
        .filter(
          (r) => !exists.has(`${r.fromKind}:${r.fromId}`) || !exists.has(`${r.toKind}:${r.toId}`),
        )
        .map((r) => r.id);
      if (doomed.length > 0) await db.relations.bulkDelete(doomed);
      return doomed.length;
    }),
  );
  if (removed > 0) await signalChange();
  return removed;
}

/**
 * For the purge transaction (trash.ts): delete every relation that starts or ends at one of
 * `entityIds` (ids are unique across tables, so the kind is not needed) and return their ids. Call
 * inside a readwrite transaction that includes `relations`.
 */
export async function dropRelationsOf(
  db: StudyVaultDb,
  entityIds: readonly string[],
): Promise<string[]> {
  if (entityIds.length === 0) return [];
  const doomed = new Set<string>();
  for (const index of ['fromId', 'toId'] as const) {
    for (const key of await keysWhereIn(db.relations, index, entityIds)) doomed.add(String(key));
  }
  if (doomed.size > 0) await db.relations.bulkDelete([...doomed]);
  return [...doomed];
}
