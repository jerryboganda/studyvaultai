import { uuidv7 } from 'uuidv7';
import {
  FilingRule,
  INBOX_BANK_ID,
  MAX_FILING_RULES,
  SCHEMA_VERSION,
  StudyVaultError,
  hasFilingCriteria,
  normalizeFilingHost,
  type FilingRuleMatch,
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
import { assertFolderInBank } from './membership';
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
 * Auto-filing rules (schema v4, ADR-011). Persistence only: whether a rule matches and what a set of
 * matches means is `matchFilingRules` / `planFiling` in @shared, and applying a plan (filing a
 * highlight, asking the person) is the caller's. Rules are soft-deleted (undo) and purged on request.
 *
 * Rules that point at something that is gone are kept, not rewritten: `checkFilingRules` reports
 * them and `listApplicableFilingRules` leaves them out, so a restored bank or tag brings its rules
 * back to life by itself.
 */

export interface FilingRuleInput {
  name: string;
  /** Default true. */
  enabled?: boolean;
  /** At least one condition (see `FilingRuleMatch`). Values are normalised: hosts lower-cased, repeats dropped. */
  match: FilingRuleMatch;
  action: { bankId: string; folderId?: string | null; addTagIds?: string[] };
  /** Default true: the person confirms before the rule files anything. */
  requireConfirm?: boolean;
}

export type FilingRulePatch = Partial<FilingRuleInput>;

/** A rule's reference that no longer holds. */
export interface FilingRuleProblem {
  ruleId: string;
  field: 'action.bankId' | 'action.folderId' | 'action.addTagIds' | 'match.tagIds';
  /** The id that is gone or in the trash. */
  id: string;
  /** `wrong_bank`: the folder exists but belongs to another bank than the rule's. */
  problem: 'missing' | 'deleted' | 'wrong_bank';
}

const noCondition = () =>
  invalid(
    'Add at least one condition (a site, an address, a word, a tag, a kind or a source type).',
  );

// ---------------------------------------------------------------------------------------------
// input cleaning
// ---------------------------------------------------------------------------------------------

/** An optional list field: absent is empty, anything else that is not an array is refused. */
function listOf<T>(value: readonly T[] | undefined, field: string): readonly T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalid(`Invalid rule: ${field} must be a list.`);
  return value;
}

/** Words as typed: trimmed, inner whitespace collapsed, empty ones and case-insensitive repeats dropped. */
function words(list: readonly string[] | undefined, field: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of listOf(list, field)) {
    const word = String(raw).replace(/\s+/g, ' ').trim();
    const key = word.toLowerCase();
    if (word !== '' && !seen.has(key)) {
      seen.add(key);
      out.push(word);
    }
  }
  return out;
}

function cleanMatch(input: FilingRuleMatch): FilingRuleMatch {
  if (typeof input !== 'object' || input === null) throw noCondition();
  const out: FilingRuleMatch = {};
  const hosts = unique(
    listOf(input.hosts, 'match.hosts').map((entry) => {
      const host = normalizeFilingHost(String(entry));
      if (host === null) {
        throw invalid(`"${String(entry)}" is not a site name. Use a name such as example.com.`);
      }
      return host;
    }),
  );
  if (hosts.length > 0) out.hosts = hosts;
  const prefixes = unique(
    listOf(input.urlPrefixes, 'match.urlPrefixes')
      .map((p) => String(p).trim())
      .filter(Boolean),
  );
  if (prefixes.length > 0) out.urlPrefixes = prefixes;
  const title = words(input.titleContains, 'match.titleContains');
  if (title.length > 0) out.titleContains = title;
  const quote = words(input.quoteContains, 'match.quoteContains');
  if (quote.length > 0) out.quoteContains = quote;
  const tagIds = cleanIds(input.tagIds, 'tag id');
  if (tagIds.length > 0) out.tagIds = tagIds;
  const kinds = listOf(input.kinds, 'match.kinds');
  if (kinds.length > 0) out.kinds = unique(kinds);
  const sourceTypes = listOf(input.sourceTypes, 'match.sourceTypes');
  if (sourceTypes.length > 0) out.sourceTypes = unique(sourceTypes);
  return out;
}

function cleanAction(input: FilingRuleInput['action']): FilingRule['action'] {
  if (typeof input !== 'object' || input === null) throw invalid('Choose the bank to file into.');
  return {
    bankId: requireId(input.bankId),
    folderId:
      input.folderId === undefined || input.folderId === null ? null : requireId(input.folderId),
    addTagIds: cleanIds(input.addTagIds, 'tag id'),
  };
}

// ---------------------------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------------------------

const byRank = (a: FilingRule, b: FilingRule) =>
  a.order - b.order || cmp(a.createdAt, b.createdAt) || cmp(a.id, b.id);

async function readRules(db: StudyVaultDb): Promise<FilingRule[]> {
  return (await db.filingRules.toArray())
    .map((row) => parseRow(FilingRule, row, 'filing rule'))
    .filter(notNull)
    .sort(byRank);
}

async function liveRule(db: StudyVaultDb, id: string): Promise<FilingRule> {
  const row = await db.filingRules.get(id);
  const rule = row && !isDeleted(row) ? parseRow(FilingRule, row, 'filing rule') : null;
  if (!rule) throw new StudyVaultError('not_found', 'Rule not found');
  return rule;
}

/** Rules in rank order (`order`, then oldest first). Deleted rules only with `includeDeleted`. */
export async function listFilingRules(
  options: { includeDeleted?: boolean; enabledOnly?: boolean } = {},
): Promise<FilingRule[]> {
  return withDb(async (db) =>
    (await readRules(db)).filter(
      (rule) =>
        (options.includeDeleted === true || rule.deletedAt === null) &&
        (options.enabledOnly !== true || rule.enabled),
    ),
  );
}

export async function getFilingRule(id: string): Promise<FilingRule | null> {
  requireId(id);
  return withDb(async (db) => {
    const row = await db.filingRules.get(id);
    const rule = row ? parseRow(FilingRule, row, 'filing rule') : null;
    return rule && rule.deletedAt === null ? rule : null;
  });
}

// ---------------------------------------------------------------------------------------------
// references
// ---------------------------------------------------------------------------------------------

interface RuleRefs {
  bankId: string;
  folderId: string | null;
  tagIds: string[];
}

const refsOf = (rule: Pick<FilingRule, 'match' | 'action'>): RuleRefs => ({
  bankId: rule.action.bankId,
  folderId: rule.action.folderId ?? null,
  tagIds: unique([...(rule.action.addTagIds ?? []), ...(rule.match.tagIds ?? [])]),
});

/**
 * What the rule points at must exist and be live, but only what is NEW is checked: a rule whose bank
 * was deleted since it was made can still be renamed or switched off.
 */
async function assertNewReferences(
  db: StudyVaultDb,
  next: RuleRefs,
  before: RuleRefs | null,
): Promise<void> {
  if (next.bankId !== before?.bankId) await liveBank(db, next.bankId);
  if (
    next.folderId !== null &&
    (next.folderId !== before?.folderId || next.bankId !== before.bankId)
  ) {
    await assertFolderInBank(db, next.folderId, next.bankId);
  }
  const known = new Set(before?.tagIds ?? []);
  await assertLiveTags(
    db,
    next.tagIds.filter((id) => !known.has(id)),
  );
}

const TABLES = (db: StudyVaultDb) => [db.filingRules, db.banks, db.folders, db.tags];

// ---------------------------------------------------------------------------------------------
// writing
// ---------------------------------------------------------------------------------------------

/** A new rule goes last. At most `MAX_FILING_RULES` live rules. */
export async function createFilingRule(input: FilingRuleInput): Promise<FilingRule> {
  const match = cleanMatch(input.match);
  const action = cleanAction(input.action);
  if (!hasFilingCriteria(match)) throw noCondition();
  const rule = await withWritableDb((db) =>
    db.transaction('rw', TABLES(db), async () => {
      const live = (await readRules(db)).filter((r) => r.deletedAt === null);
      if (live.length >= MAX_FILING_RULES) {
        throw invalid(`You can have at most ${MAX_FILING_RULES} rules. Delete one first.`);
      }
      await assertNewReferences(db, refsOf({ match, action }), null);
      const ts = now();
      const row = parseStrict(
        FilingRule,
        {
          id: uuidv7(),
          schemaVersion: SCHEMA_VERSION,
          createdAt: ts,
          updatedAt: ts,
          deletedAt: null,
          name: input.name,
          enabled: input.enabled ?? true,
          order: live.reduce((max, r) => Math.max(max, r.order), -1) + 1,
          match,
          action,
          requireConfirm: input.requireConfirm ?? true,
        },
        'rule',
      );
      await db.filingRules.add(row);
      return row;
    }),
  );
  await signalChange();
  return rule;
}

/**
 * Change a rule. `match` and `action` replace the whole value (send the complete new one). With
 * `expectedVersion` (the rule's `updatedAt` as the editor read it) a rule that changed since is left
 * alone and returned as `stale`. A patch that changes nothing writes nothing.
 */
export async function updateFilingRule(
  id: string,
  patch: FilingRulePatch,
  options: { expectedVersion?: string } = {},
): Promise<SaveOutcome<FilingRule>> {
  requireId(id);
  const match = patch.match === undefined ? undefined : cleanMatch(patch.match);
  const action = patch.action === undefined ? undefined : cleanAction(patch.action);
  if (match !== undefined && !hasFilingCriteria(match)) throw noCondition();
  const { outcome, changed } = await withWritableDb((db) =>
    db.transaction('rw', TABLES(db), async () => {
      const current = await liveRule(db, id);
      if (options.expectedVersion !== undefined && options.expectedVersion !== current.updatedAt) {
        return { outcome: { status: 'stale', row: current } as const, changed: false };
      }
      const next = parseStrict(
        FilingRule,
        {
          ...current,
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
          ...(patch.requireConfirm === undefined ? {} : { requireConfirm: patch.requireConfirm }),
          ...(match === undefined ? {} : { match }),
          ...(action === undefined ? {} : { action }),
        },
        'rule',
      );
      if (sameRow(next, current)) {
        return { outcome: { status: 'saved', row: current } as const, changed: false };
      }
      await assertNewReferences(db, refsOf(next), refsOf(current));
      const row = { ...next, updatedAt: nextStamp(current.updatedAt, now()) };
      await db.filingRules.put(row);
      return { outcome: { status: 'saved', row } as const, changed: true };
    }),
  );
  if (changed) await signalChange();
  return outcome;
}

/**
 * Put the listed rules first, in this order; live rules not listed follow in their current order.
 * `order` is rewritten as 0, 1, 2 ... for the rules whose rank changes. All or nothing.
 */
export async function reorderFilingRules(orderedIds: readonly string[]): Promise<FilingRule[]> {
  const wanted = unique(orderedIds.map(requireId));
  const { rules, changed } = await withWritableDb((db) =>
    db.transaction('rw', db.filingRules, async () => {
      const live = (await readRules(db)).filter((r) => r.deletedAt === null);
      const byId = new Map(live.map((r) => [r.id, r]));
      for (const id of wanted) {
        if (!byId.has(id)) throw new StudyVaultError('not_found', 'Rule not found');
      }
      const sequence = [
        ...wanted.map((id) => byId.get(id) as FilingRule),
        ...live.filter((r) => !wanted.includes(r.id)),
      ];
      const ts = now();
      const rewritten: FilingRule[] = [];
      const out = sequence.map((rule, index) => {
        if (rule.order === index) return rule;
        const row = { ...rule, order: index, updatedAt: nextStamp(rule.updatedAt, ts) };
        rewritten.push(row);
        return row;
      });
      if (rewritten.length > 0) await db.filingRules.bulkPut(rewritten);
      return { rules: out, changed: rewritten.length > 0 };
    }),
  );
  if (changed) await signalChange();
  return rules;
}

/** Soft delete (the rule can be restored). Deleting a deleted rule is not an error. */
export async function deleteFilingRule(id: string): Promise<void> {
  requireId(id);
  const changed = await withWritableDb((db) =>
    db.transaction('rw', db.filingRules, async () => {
      const row = await db.filingRules.get(id);
      const rule = row ? parseRow(FilingRule, row, 'filing rule') : null;
      if (!rule) throw new StudyVaultError('not_found', 'Rule not found');
      if (rule.deletedAt !== null) return false;
      const ts = nextStamp(rule.updatedAt, now());
      await db.filingRules.put({ ...rule, deletedAt: ts, updatedAt: ts });
      return true;
    }),
  );
  if (changed) await signalChange();
}

/** Undo `deleteFilingRule`. The rule comes back last in the order. */
export async function restoreFilingRule(id: string): Promise<FilingRule> {
  requireId(id);
  const { rule, changed } = await withWritableDb((db) =>
    db.transaction('rw', db.filingRules, async () => {
      const all = await readRules(db);
      const found = all.find((r) => r.id === id);
      if (!found) throw new StudyVaultError('not_found', 'Rule not found');
      if (found.deletedAt === null) return { rule: found, changed: false };
      const live = all.filter((r) => r.deletedAt === null);
      if (live.length >= MAX_FILING_RULES) {
        throw invalid(`You can have at most ${MAX_FILING_RULES} rules. Delete one first.`);
      }
      const row: FilingRule = {
        ...found,
        deletedAt: null,
        order: live.reduce((max, r) => Math.max(max, r.order), -1) + 1,
        updatedAt: nextStamp(found.updatedAt, now()),
      };
      await db.filingRules.put(row);
      return { rule: row, changed: true };
    }),
  );
  if (changed) await signalChange();
  return rule;
}

/**
 * Remove deleted rules for good: the given ids (each must be in the deleted state, so a stale screen
 * cannot destroy a live rule), or every deleted rule when `ids` is omitted. Returns how many.
 */
export async function purgeFilingRules(ids?: readonly string[]): Promise<number> {
  const wanted = ids === undefined ? null : unique(ids.map(requireId));
  const removed = await withWritableDb((db) =>
    db.transaction('rw', db.filingRules, async () => {
      const rows = await db.filingRules.toArray();
      const doomed: string[] = [];
      if (wanted === null) {
        for (const row of rows) if (isDeleted(row)) doomed.push(row.id);
      } else {
        const byId = new Map(rows.map((r) => [r.id, r]));
        for (const id of wanted) {
          const row = byId.get(id);
          if (!row) continue; // already gone: the goal state holds
          if (!isDeleted(row)) {
            throw invalid('Only deleted rules can be removed for good; nothing was removed.');
          }
          doomed.push(id);
        }
      }
      if (doomed.length > 0) await db.filingRules.bulkDelete(doomed);
      return doomed.length;
    }),
  );
  if (removed > 0) await signalChange();
  return removed;
}

// ---------------------------------------------------------------------------------------------
// problems
// ---------------------------------------------------------------------------------------------

async function problemsOf(
  db: StudyVaultDb,
  rules: readonly FilingRule[],
): Promise<FilingRuleProblem[]> {
  const live = rules.filter((r) => r.deletedAt === null);
  const folderIds = unique(live.flatMap((r) => (r.action.folderId ? [r.action.folderId] : [])));
  const tagIds = unique(live.flatMap((r) => refsOf(r).tagIds));
  const bankIds = unique(live.map((r) => r.action.bankId).filter((id) => id !== INBOX_BANK_ID));
  // One after another: a native Promise.all would leave Dexie's transaction zone.
  const banks = await db.banks.bulkGet(bankIds);
  const folders = await db.folders.bulkGet(folderIds);
  const tags = await db.tags.bulkGet(tagIds);
  const bank = new Map(bankIds.map((id, i) => [id, banks[i]] as const));
  const folder = new Map(folderIds.map((id, i) => [id, folders[i]] as const));
  const tag = new Map(tagIds.map((id, i) => [id, tags[i]] as const));
  const state = (row: { deletedAt?: unknown } | undefined): 'ok' | 'missing' | 'deleted' =>
    row === undefined ? 'missing' : isDeleted(row) ? 'deleted' : 'ok';

  const out: FilingRuleProblem[] = [];
  for (const rule of live) {
    const add = (
      field: FilingRuleProblem['field'],
      id: string,
      problem: FilingRuleProblem['problem'],
    ) => out.push({ ruleId: rule.id, field, id, problem });
    if (rule.action.bankId !== INBOX_BANK_ID) {
      const s = state(bank.get(rule.action.bankId));
      if (s !== 'ok') add('action.bankId', rule.action.bankId, s);
    }
    const folderId = rule.action.folderId ?? null;
    if (folderId !== null) {
      const row = folder.get(folderId);
      const s = state(row);
      if (s !== 'ok') add('action.folderId', folderId, s);
      else if (row?.bankId !== rule.action.bankId) add('action.folderId', folderId, 'wrong_bank');
    }
    for (const id of rule.action.addTagIds ?? []) {
      const s = state(tag.get(id));
      if (s !== 'ok') add('action.addTagIds', id, s);
    }
    for (const id of rule.match.tagIds ?? []) {
      const s = state(tag.get(id));
      if (s !== 'ok') add('match.tagIds', id, s);
    }
  }
  return out;
}

/** Every broken reference of every live rule (empty when all rules are sound). */
export async function checkFilingRules(): Promise<FilingRuleProblem[]> {
  return withDb((db) =>
    db.transaction('r', [db.filingRules, db.banks, db.folders, db.tags], async () =>
      problemsOf(db, await readRules(db)),
    ),
  );
}

/**
 * The rules a caller may apply right now: enabled, not deleted, and whose bank, folder and tags to
 * add all exist. In rank order. Hand this (not `listFilingRules`) to `matchFilingRules`.
 */
export async function listApplicableFilingRules(): Promise<FilingRule[]> {
  return withDb((db) =>
    db.transaction('r', [db.filingRules, db.banks, db.folders, db.tags], async () => {
      const rules = (await readRules(db)).filter((r) => r.deletedAt === null && r.enabled);
      const broken = new Set(
        (await problemsOf(db, rules))
          .filter((p) => p.field !== 'match.tagIds')
          .map((p) => p.ruleId),
      );
      return rules.filter((r) => !broken.has(r.id));
    }),
  );
}
