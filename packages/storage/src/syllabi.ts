import { uuidv7 } from 'uuidv7';
import {
  INBOX_BANK_ID,
  MAX_SYLLABI,
  MAX_SYLLABUS_DEPTH,
  MAX_SYLLABUS_NODES,
  SCHEMA_VERSION,
  StudyVaultError,
  Syllabus,
  flattenSyllabus,
  measureSyllabus,
  type SyllabusNode,
} from '@shared';
import {
  cmp,
  isDeleted,
  liveBank,
  notNull,
  now,
  parseRow,
  requireId,
  signalChange,
  unique,
} from './core';
import { withDb, withWritableDb, type StudyVaultDb } from './db';
import {
  cleanIds,
  invalid,
  nextStamp,
  parseStrict,
  sameRow,
  type SaveOutcome,
} from './organisation';
import { assertLiveTags } from './tags';

/**
 * Syllabi (schema v4, ADR-011): a named outline of topics, each pointing at banks and tags. The tree
 * is stored whole, in one row, so an edit is one transaction and a restore or a sync can never leave
 * half a tree. Pure helpers for walking a tree (`flattenSyllabus`, `measureSyllabus`) are in @shared.
 * Soft-deleted (undo) and purged on request, like rules.
 */

export interface SyllabusNodeInput {
  /** Keep the id of an existing topic when editing; omitted for a new one (a fresh id is made). */
  id?: string;
  title: string;
  children?: SyllabusNodeInput[];
  bankIds?: string[];
  tagIds?: string[];
  /** Greater than 0. Absent means an equal share. */
  weight?: number;
}

export interface SyllabusProblem {
  syllabusId: string;
  nodeId: string;
  field: 'bankIds' | 'tagIds';
  id: string;
  problem: 'missing' | 'deleted';
}

const tooBig = () =>
  invalid(
    `A syllabus holds at most ${MAX_SYLLABUS_NODES} topics, nested at most ${MAX_SYLLABUS_DEPTH} levels deep.`,
  );

/** Input tree -> stored shape: ids filled in, lists deduplicated, limits checked before any recursion goes deep. */
function buildNodes(
  inputs: readonly SyllabusNodeInput[],
  depth = 1,
  count = { n: 0 },
): SyllabusNode[] {
  if (!Array.isArray(inputs)) throw invalid('Invalid topics: expected a list.');
  if (inputs.length > 0 && depth > MAX_SYLLABUS_DEPTH) throw tooBig();
  return inputs.map((input) => {
    if (++count.n > MAX_SYLLABUS_NODES) throw tooBig();
    if (typeof input !== 'object' || input === null) throw invalid('Invalid topic.');
    const node: SyllabusNode = {
      id: input.id === undefined ? uuidv7() : requireId(input.id),
      title: input.title,
      children: buildNodes(input.children ?? [], depth + 1, count),
      bankIds: cleanIds(input.bankIds, 'bank id'),
      tagIds: cleanIds(input.tagIds, 'tag id'),
    };
    if (input.weight !== undefined) node.weight = input.weight;
    return node;
  });
}

function checkTree(nodes: readonly SyllabusNode[]): void {
  const { duplicateIds } = measureSyllabus(nodes);
  if (duplicateIds.length > 0) throw invalid('Two topics share an id. Every topic needs its own.');
}

const byName = (a: Syllabus, b: Syllabus) =>
  cmp(a.name.toLowerCase(), b.name.toLowerCase()) ||
  cmp(a.createdAt, b.createdAt) ||
  cmp(a.id, b.id);

async function readSyllabi(db: StudyVaultDb): Promise<Syllabus[]> {
  return (await db.syllabi.toArray())
    .map((row) => parseRow(Syllabus, row, 'syllabus'))
    .filter(notNull)
    .sort(byName);
}

async function liveSyllabus(db: StudyVaultDb, id: string): Promise<Syllabus> {
  const row = await db.syllabi.get(id);
  const syllabus = row && !isDeleted(row) ? parseRow(Syllabus, row, 'syllabus') : null;
  if (!syllabus) throw new StudyVaultError('not_found', 'Syllabus not found');
  return syllabus;
}

/** Banks and tags a tree points at. */
function refsOf(nodes: readonly SyllabusNode[]): { bankIds: Set<string>; tagIds: Set<string> } {
  const bankIds = new Set<string>();
  const tagIds = new Set<string>();
  for (const { node } of flattenSyllabus(nodes)) {
    for (const id of node.bankIds) bankIds.add(id);
    for (const id of node.tagIds) tagIds.add(id);
  }
  return { bankIds, tagIds };
}

/** Only banks and tags that the tree did not point at before must exist (see rules.ts). */
async function assertNewReferences(
  db: StudyVaultDb,
  next: readonly SyllabusNode[],
  before: readonly SyllabusNode[],
): Promise<void> {
  const after = refsOf(next);
  const old = refsOf(before);
  for (const id of after.bankIds) if (!old.bankIds.has(id)) await liveBank(db, id);
  await assertLiveTags(
    db,
    [...after.tagIds].filter((id) => !old.tagIds.has(id)),
  );
}

const TABLES = (db: StudyVaultDb) => [db.syllabi, db.banks, db.tags];

// ---------------------------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------------------------

/** Syllabi by name (case-insensitive). Deleted ones only with `includeDeleted`. */
export async function listSyllabi(options: { includeDeleted?: boolean } = {}): Promise<Syllabus[]> {
  return withDb(async (db) =>
    (await readSyllabi(db)).filter((s) => options.includeDeleted === true || s.deletedAt === null),
  );
}

export async function getSyllabus(id: string): Promise<Syllabus | null> {
  requireId(id);
  return withDb(async (db) => {
    const row = await db.syllabi.get(id);
    const syllabus = row ? parseRow(Syllabus, row, 'syllabus') : null;
    return syllabus && syllabus.deletedAt === null ? syllabus : null;
  });
}

// ---------------------------------------------------------------------------------------------
// writing
// ---------------------------------------------------------------------------------------------

export async function createSyllabus(input: {
  name: string;
  nodes?: SyllabusNodeInput[];
}): Promise<Syllabus> {
  const nodes = buildNodes(input.nodes ?? []);
  checkTree(nodes);
  const syllabus = await withWritableDb((db) =>
    db.transaction('rw', TABLES(db), async () => {
      const live = (await readSyllabi(db)).filter((s) => s.deletedAt === null);
      if (live.length >= MAX_SYLLABI) {
        throw invalid(`You can have at most ${MAX_SYLLABI} syllabi. Delete one first.`);
      }
      await assertNewReferences(db, nodes, []);
      const ts = now();
      const row = parseStrict(
        Syllabus,
        {
          id: uuidv7(),
          schemaVersion: SCHEMA_VERSION,
          createdAt: ts,
          updatedAt: ts,
          deletedAt: null,
          name: input.name,
          nodes,
        },
        'syllabus',
      );
      await db.syllabi.add(row);
      return row;
    }),
  );
  await signalChange();
  return syllabus;
}

/**
 * Rename a syllabus and/or replace its whole tree (send the complete new tree; topics that keep
 * their `id` stay the same topics for coverage). With `expectedVersion` (the `updatedAt` the editor
 * read) a syllabus that changed since is left alone and returned as `stale`.
 */
export async function updateSyllabus(
  id: string,
  patch: { name?: string; nodes?: SyllabusNodeInput[] },
  options: { expectedVersion?: string } = {},
): Promise<SaveOutcome<Syllabus>> {
  requireId(id);
  const nodes = patch.nodes === undefined ? undefined : buildNodes(patch.nodes);
  if (nodes !== undefined) checkTree(nodes);
  const { outcome, changed } = await withWritableDb((db) =>
    db.transaction('rw', TABLES(db), async () => {
      const current = await liveSyllabus(db, id);
      if (options.expectedVersion !== undefined && options.expectedVersion !== current.updatedAt) {
        return { outcome: { status: 'stale', row: current } as const, changed: false };
      }
      const next = parseStrict(
        Syllabus,
        {
          ...current,
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(nodes === undefined ? {} : { nodes }),
        },
        'syllabus',
      );
      if (sameRow(next, current)) {
        return { outcome: { status: 'saved', row: current } as const, changed: false };
      }
      await assertNewReferences(db, next.nodes, current.nodes);
      const row = { ...next, updatedAt: nextStamp(current.updatedAt, now()) };
      await db.syllabi.put(row);
      return { outcome: { status: 'saved', row } as const, changed: true };
    }),
  );
  if (changed) await signalChange();
  return outcome;
}

/** Soft delete (the syllabus can be restored). Deleting a deleted syllabus is not an error. */
export async function deleteSyllabus(id: string): Promise<void> {
  requireId(id);
  const changed = await withWritableDb((db) =>
    db.transaction('rw', db.syllabi, async () => {
      const row = await db.syllabi.get(id);
      const syllabus = row ? parseRow(Syllabus, row, 'syllabus') : null;
      if (!syllabus) throw new StudyVaultError('not_found', 'Syllabus not found');
      if (syllabus.deletedAt !== null) return false;
      const ts = nextStamp(syllabus.updatedAt, now());
      await db.syllabi.put({ ...syllabus, deletedAt: ts, updatedAt: ts });
      return true;
    }),
  );
  if (changed) await signalChange();
}

export async function restoreSyllabus(id: string): Promise<Syllabus> {
  requireId(id);
  const { syllabus, changed } = await withWritableDb((db) =>
    db.transaction('rw', db.syllabi, async () => {
      const all = await readSyllabi(db);
      const found = all.find((s) => s.id === id);
      if (!found) throw new StudyVaultError('not_found', 'Syllabus not found');
      if (found.deletedAt === null) return { syllabus: found, changed: false };
      if (all.filter((s) => s.deletedAt === null).length >= MAX_SYLLABI) {
        throw invalid(`You can have at most ${MAX_SYLLABI} syllabi. Delete one first.`);
      }
      const row: Syllabus = {
        ...found,
        deletedAt: null,
        updatedAt: nextStamp(found.updatedAt, now()),
      };
      await db.syllabi.put(row);
      return { syllabus: row, changed: true };
    }),
  );
  if (changed) await signalChange();
  return syllabus;
}

/** Remove deleted syllabi for good: the given ids (each must be deleted), or all when omitted. */
export async function purgeSyllabi(ids?: readonly string[]): Promise<number> {
  const wanted = ids === undefined ? null : unique(ids.map(requireId));
  const removed = await withWritableDb((db) =>
    db.transaction('rw', db.syllabi, async () => {
      const rows = await db.syllabi.toArray();
      const doomed: string[] = [];
      if (wanted === null) {
        for (const row of rows) if (isDeleted(row)) doomed.push(row.id);
      } else {
        const byId = new Map(rows.map((r) => [r.id, r]));
        for (const id of wanted) {
          const row = byId.get(id);
          if (!row) continue;
          if (!isDeleted(row)) {
            throw invalid('Only deleted syllabi can be removed for good; nothing was removed.');
          }
          doomed.push(id);
        }
      }
      if (doomed.length > 0) await db.syllabi.bulkDelete(doomed);
      return doomed.length;
    }),
  );
  if (removed > 0) await signalChange();
  return removed;
}

// ---------------------------------------------------------------------------------------------
// problems
// ---------------------------------------------------------------------------------------------

/**
 * Banks and tags that live syllabi point at and that are gone or in the trash. A purged bank leaves
 * the id in the tree on purpose (the person's outline is theirs); the topic simply covers nothing
 * until it is pointed somewhere else.
 */
export async function checkSyllabi(): Promise<SyllabusProblem[]> {
  return withDb((db) =>
    db.transaction('r', [db.syllabi, db.banks, db.tags], async () => {
      const live = (await readSyllabi(db)).filter((s) => s.deletedAt === null);
      const bankIds = new Set<string>();
      const tagIds = new Set<string>();
      for (const s of live) {
        const refs = refsOf(s.nodes);
        for (const id of refs.bankIds) if (id !== INBOX_BANK_ID) bankIds.add(id);
        for (const id of refs.tagIds) tagIds.add(id);
      }
      const bankList = [...bankIds];
      const tagList = [...tagIds];
      const banks = await db.banks.bulkGet(bankList);
      const tags = await db.tags.bulkGet(tagList);
      const bankState = new Map(bankList.map((id, i) => [id, banks[i]] as const));
      const tagState = new Map(tagList.map((id, i) => [id, tags[i]] as const));
      const stateOf = (row: { deletedAt?: unknown } | undefined) =>
        row === undefined ? 'missing' : isDeleted(row) ? 'deleted' : 'ok';
      const out: SyllabusProblem[] = [];
      for (const s of live) {
        for (const { node } of flattenSyllabus(s.nodes)) {
          for (const id of node.bankIds) {
            if (id === INBOX_BANK_ID) continue;
            const state = stateOf(bankState.get(id));
            if (state !== 'ok') {
              out.push({ syllabusId: s.id, nodeId: node.id, field: 'bankIds', id, problem: state });
            }
          }
          for (const id of node.tagIds) {
            const state = stateOf(tagState.get(id));
            if (state !== 'ok') {
              out.push({ syllabusId: s.id, nodeId: node.id, field: 'tagIds', id, problem: state });
            }
          }
        }
      }
      return out;
    }),
  );
}
