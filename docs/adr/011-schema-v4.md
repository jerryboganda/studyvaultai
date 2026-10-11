# ADR-011: Schema v4 - auto-filing rules, syllabi and relations

**Status:** accepted · **Date:** 2026-10-11 · Extends ADR-001 (module layout), ADR-005 (free text stays
in the extension origin) and ADR-010 (module seams). Consumers: ADR-017 (filing rules), ADR-018
(relations and graph), ADR-020 (exam simulation and syllabus coverage).

## Context
Three features need data that has no table yet: rules that propose where a new highlight goes, a
user-made outline of an exam (for coverage), and links between highlights, knowledge points and
notes. They are user data like decks: they must survive restart, update, backup and restore, take
part in optional sync, be removed by "Delete all data", and be checked by the integrity audit. They
are introduced in ONE Dexie version bump so that the feature work can build on a stable persistence
API.

## Decisions

### 1. Three additive tables, one version bump (Dexie 3 -> 4)
`SCHEMA_V4` (`packages/storage/src/db.ts`) = `SCHEMA_V3` plus:

| Table | Key and indexes | Why |
| --- | --- | --- |
| `filingRules` | `id, order, updatedAt, deletedAt` | rules by rank. `enabled` is a boolean and not an IndexedDB key, so "enabled rules by order" is the `order` index with `enabled` filtered in code (at most 200 rows), the way `cards.suspended` is |
| `syllabi` | `id, updatedAt, deletedAt` | list by recency/name; the whole tree is one row |
| `relations` | `id, [fromKind+fromId], [toKind+toId], fromId, toId, updatedAt, deletedAt` | links of one item in either direction; `fromId`/`toId` alone because ids are unique across tables, so a purge finds every relation that touches a removed row with one lookup per id |

No existing table changes. `DB_VERSION` is 4. The record envelope is the usual one
(`schemaVersion` 1, `createdAt`, `updatedAt`, `deletedAt`); `schemaVersion` is the RECORD version, not
the Dexie version, and no record-level migration step was needed (`rows.ts` `UPGRADES` unchanged).

`upgradeV3ToV4` only advances the `meta['schema']` marker (`dbVersion: 4`, `v4MigratedAt`), keeping
every earlier field. It reads and writes no vault row, runs inside Dexie's versionchange transaction
(a throw rolls the upgrade back and the database stays at v3) and gives the same marker when run
again. The automatic pre-update copy is taken exactly as before (the new tables did not exist at the
old version, so they are not in it). `assertNoNewerRows` also scans the three tables: a row written
by a newer build refuses writes here, like every other record table.

### 2. Zod schemas in `@shared` (`schema.ts`), registered with the table registry
`FilingRule`, `Syllabus` (+ `SyllabusNode`), `Relation` and their limits. The schemas live in
`@shared`, so the registry carries them directly (`SPECS` in `registry.ts`): `unregisteredTables()` is
unchanged and nothing has to be imported for them to be validated. All three are `softDelete: true`.

- `FilingRule`: `name` (1-80), `enabled`, `order` (int 0..1e6), `match`, `action`, `requireConfirm`
  (default **true**: an absent flag asks). `match` fields (all optional, 20 values each): `hosts`
  (lower-case host names, DENY_HOST shape), `urlPrefixes` (http(s), no credentials), `titleContains`,
  `quoteContains` (1-200 chars), `tagIds` (<= 20), `kinds`, `sourceTypes`. `action`: `bankId`,
  `folderId` (nullable), `addTagIds` (<= 20). At most **200** live rules.
- `Syllabus`: `name` (1-120), `nodes` tree: depth <= **6**, <= **500** topics in all, unique topic ids;
  node = `{ id, title (1-200), children, bankIds (<= 50), tagIds (<= 50), weight? (> 0, <= 1000) }`.
  At most 100 live syllabi. The node schema is built level by level instead of with a lazy
  self-reference, so a hostile archive nested a million deep fails with a validation error at level 7
  and never overflows the parser's stack (`schema.organisation.test.ts`).
- `Relation`: `fromKind`/`toKind` in `highlight | knowledgePoint | note`, `fromId`, `toId`, `type` in
  `related | supports | contradicts | cause | example | prerequisite`, `note?` (<= 500). The schema
  refuses a link from an item to itself.

### 3. Semantics that are decisions, not accidents
- **Optimistic concurrency.** The version token of a row is its `updatedAt`; every write makes it
  strictly later than the previous (`nextStamp`), so two writes in one millisecond still differ.
  `update*` and `updateRelationNote` take `{ expectedVersion }`: a row that changed since is NOT
  written and comes back as `{ status: 'stale', row }` (the shape of `reviewCard`'s `stale`). Without
  `expectedVersion` the write is unconditional. A patch that changes nothing writes nothing and
  signals nothing.
- **Soft delete + restore + purge.** All three tables soft-delete (undo toast, "recently deleted"),
  with `restore*` and `purge*(ids?)`; purge refuses a live id, so a stale screen cannot destroy live
  data. They are NOT added to `TrashKind`: that enum is exhaustive in UI code (`TrashView`), and
  rules and syllabi are managed in their own screens. A restored rule goes last in the order.
- **Hard references are checked when they are written, and only when they are new.** A rule's bank,
  folder (must belong to that bank) and tags, and a syllabus topic's banks and tags, must exist and be
  live when first set; a reference that was already there and has gone bad since does not block
  renaming or switching the rule off.
- **Dangling references are kept and reported, never rewritten.** `checkFilingRules()` and
  `checkSyllabi()` list them; `listApplicableFilingRules()` leaves broken rules out; a bank, folder or
  tag that is restored from the trash brings its rules back with no write.
- **Relations.** Unique by (fromKind, fromId, toKind, toId, type); **"related" has no direction**
  (A->B and B->A are one link). `createRelation` is idempotent: it returns `existing` (the note of the
  call is not applied: use `updateRelationNote`) or revives a deleted row (`restored`). Ends must exist
  and not be in the trash at creation. **An end in the trash hides the relation** (it is derived, not
  stored: restoring the end shows it again and there is no stamp to match). Two rows of one link can
  still appear when two synced devices create it at once: reads fold them to the older one and the
  integrity check reports `duplicate_relation`.
- **Purge cascades in the same transaction.** `purgeInTx` (trash.ts) deletes every relation that
  starts or ends at a purged highlight, note or knowledge point (including those removed with a
  highlight), records them in `gone`, so sync receives a tombstone each and conflict/quarantine rows
  are scrubbed like for any other purged row. `pruneDanglingRelations()` removes what only a restore,
  an import or a sync of inconsistent data can leave.

### 4. Backup and restore
No code in `@backup` changed. The three tables are in `backupTableRegistry` (everything except
`BACKUP_EXCLUDED_TABLES`), so export/import, per-table SHA-256 checksums and the merge rules (newest
`updatedAt`/`deletedAt` wins, never deletes, immutable fields conflict) apply as they do to decks.
`BACKUP_MIGRATIONS` gained the empty step `{ from: 3 }`. No field is derived (checksums cover all).
Restoring an archive written before v4: a merge leaves the three tables alone, a replace empties them
(it empties every table the archive has no data for) and the dry run lists them under
`clearedWithoutArchiveData`. `references` cannot express a nested, list or kind+id pair, so the
restore does not treat these as orphans: a row that points at something the archive lacks is
restored and then reported by the integrity check. In-product wording: `BACKUP_HOLDS`
(`packages/ui/src/backup/scope.ts`) names the three kinds of data.

### 5. Sync policy (`STUDYVAULT_SYNC_POLICY`)
| Table | immutable | text (both versions kept on a concurrent edit) | scalar (last writer wins) |
| --- | --- | --- | --- |
| `filingRules` | - | `name`, `match`, `action` | `enabled`, `order`, `requireConfirm` |
| `syllabi` | - | `name`, `nodes` | - |
| `relations` | `fromKind`, `fromId`, `toKind`, `toId`, `type` | `note` | - |

`schemaVersion` is local. The ordinary `sync.policy.test.ts` fails on any unclassified field. Consent
text and labels (`packages/ui/src/sync/consent.ts`, `labels.ts`) list them under "Banks, folders and
tags".

### 6. Integrity audit (`checkIntegrity`)
`NESTED_REFERENCES` (registry.ts) lists, per table, the ids inside a row's own structure: a rule's
`action.bankId`, `action.folderId`, `action.addTagIds`, `match.tagIds`; a syllabus topic's `bankIds`
and `tagIds`; a relation's two ends (the table follows the kind). A reference to a row that does not
exist at all is `orphan_reference`; a row in the trash is intact; the Inbox always exists. Deleted
rows are not audited. A repeated link is `duplicate_relation`.

### 7. "Delete all data"
Nothing to do: the database is deleted whole, and the recreated one is empty. A test asserts the
three tables are empty afterwards and writable.

## Public API (for the feature modules)
Everything is exported from `@storage` (plain functions, like the other repositories; no RPC), every
write signals `dataEpoch`, every function validates its input at the boundary and throws
`StudyVaultError` (`invalid_request`, `not_found`, `storage_unavailable`). Pure helpers are in
`@shared`.

```ts
// @shared (packages/shared/src/schema.ts, filing.ts)
FilingRule, FilingRuleMatch, FilingRuleAction, Syllabus, SyllabusNode, Relation,
RelationEntityKind, RelationType, RELATION_ENTITY_KINDS, RELATION_TYPES, MAX_FILING_RULES, ...limits
flattenSyllabus(nodes): { node, depth, parentId }[]        // pre-order, iterative
measureSyllabus(nodes): { count, depth, duplicateIds }
matchFilingRules<T extends FilingRuleLike>(rules: readonly T[], c: FilingCandidate): T[]   // ranked
planFiling(matches): FilingPlan | null    // placement of the first, tags of all, confirm if any asks
filingMatchApplies(match, candidate): boolean ; hasFilingCriteria(match): boolean
normalizeFilingHost(input): string | null ; compareFilingRules(a, b): number

// @storage
type SaveOutcome<T> = { status: 'saved'; row: T } | { status: 'stale'; row: T }
// rules
createFilingRule(input: FilingRuleInput): Promise<FilingRule>
getFilingRule(id): Promise<FilingRule | null>
listFilingRules(o?: { includeDeleted?; enabledOnly? }): Promise<FilingRule[]>
updateFilingRule(id, patch: FilingRulePatch, o?: { expectedVersion? }): Promise<SaveOutcome<FilingRule>>
reorderFilingRules(orderedIds: readonly string[]): Promise<FilingRule[]>
deleteFilingRule(id): Promise<void> ; restoreFilingRule(id): Promise<FilingRule>
purgeFilingRules(ids?: readonly string[]): Promise<number>
checkFilingRules(): Promise<FilingRuleProblem[]>
listApplicableFilingRules(): Promise<FilingRule[]>     // enabled, live, targets exist
// syllabi
createSyllabus({ name, nodes?: SyllabusNodeInput[] }): Promise<Syllabus>
getSyllabus(id) ; listSyllabi(o?: { includeDeleted? }) ; deleteSyllabus(id) ; restoreSyllabus(id)
updateSyllabus(id, { name?, nodes? }, o?: { expectedVersion? }): Promise<SaveOutcome<Syllabus>>
purgeSyllabi(ids?): Promise<number> ; checkSyllabi(): Promise<SyllabusProblem[]>
// relations
createRelation(input: RelationInput): Promise<{ relation; status: 'created' | 'existing' | 'restored' }>
getRelation(id) ; deleteRelation(id) ; restoreRelation(id) ; purgeRelations(ids?)
listRelationsFor(ref: { kind, id }, o?: { direction?: 'from'|'to'|'both'; types? }): Promise<Relation[]>
listAllRelations(o?: { types?; limit? }): Promise<Relation[]>      // what a graph draws
updateRelationNote(id, note, o?: { expectedVersion? }): Promise<SaveOutcome<Relation>>
pruneDanglingRelations(): Promise<number>
relationKey(row): string                    // the identity of a link ("related" without direction)
```

## Consequences
- A consumer applies rules like this: `listApplicableFilingRules()` -> `matchFilingRules(rules,
  candidate)` -> `planFiling(matches)` -> when `requireConfirm`, ask; then file with the existing
  membership functions (which re-check the folder belongs to the bank). Storage never files anything.
- Rules, syllabi and relations are user data on the sync server when sync is on; the consent text says
  so (generated from the policy).
- Deleting (purging) a bank, folder or tag does not edit rules or syllabi: they are reported until
  the person fixes them. Restoring from the trash repairs them.
- Restoring an older backup in replace mode removes rules, syllabi and relations (it does for every
  table the archive has no data for); the dry run says so.

## Tests
`packages/shared/src/filing.test.ts` (matcher: whole-label host matching, `evilexample.com`, empty
match, ranking, plan), `schema.organisation.test.ts` (limits, hostile depth), `packages/storage/src/`
`rules.test.ts`, `syllabi.test.ts`, `relations.test.ts` (CRUD, limits, optimistic concurrency, undo,
purge, dangling), `organisation.vault.test.ts` (backup round trip, merge semantics, older archive,
"Delete all data", sync outbox and tombstones), `migration.test.ts` "upgrading a version-3 database to
version 4" (a v3 database built from the real v1-v3 store strings, every row left untouched,
re-open, idempotent step, failing step rolls back, pre-update hook), `registry.test.ts`,
`sync.policy.test.ts`. All are unit or integration tests on fake IndexedDB; none has been run by CI
yet.

## Size
The three schemas, `flattenSyllabus` and `measureSyllabus` add about 2.9 KB minified (1.2 KB gzip) to
any bundle that keeps `schema.ts` whole (measured by bundling `schema.ts` with and without the
block: 99,543 -> 102,451 bytes, Zod included). The content script of the measured build does keep
`schema.ts` whole, so it carries that much unused schema; moving the block to its own module and
importing it by subpath (`@shared/organisation`) would take it out. The storage repositories
(`rules.ts`, `syllabi.ts`, `relations.ts`) are not in the worker or content bundle: only
`registry.ts` (the table specs and nested references), the upgrade step and the purge cascade are.

## Not verified here
A real Chrome upgrade of an existing profile from v3 (the loaded-extension suite has no v3 fixture
profile); multi-window races between two real contexts (the same-version race is covered with two
calls in one context); the effect on the production bundle totals (only the private e2e build was
measured, and other work was in it).
