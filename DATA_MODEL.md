# Data Model and Provenance Contract

All records have UUIDv7/ULID-style sortable IDs or an equivalent validated identifier, schemaVersion, createdAt, updatedAt, and soft-deletion metadata where appropriate. Do not assume `id` is a globally unique numeric database key. Use normalized storage and typed DTOs.

## Core entities
- `Profile`: local identity, security mode, locale, timezone, preferences; account optional.
- `Workspace`: optional grouping of all data, e.g. personal vs team.
- `Bank`: name, icon/color, user-defined ordered nested hierarchy, privacy policy, presets and permissions.
- `Folder`: bankId, parentFolderId, position, depth check, alias and smart-filter metadata.
- `Tag`: name, aliases, color; many-to-many through tag relations.
- `Source`: type (web/pdf/image/video/manual), canonicalUrl, originalUrl, title, authors, publisher, contentType, documentFingerprint, contentHash, publishedAt, capturedAt, retrievalStatus, license/copyright metadata when supplied, access notes.
- `Highlight`: sourceId, exactQuote, normalizedQuote, quoteHash, anchorSet, color, kind, priority, userComment, sourceStatus, captureMethod, capturedAt, lastResolvedAt, resolveConfidence.
- `HighlightBank`: highlightId, bankId, folderId; many-to-many membership so a highlight can be filed in multiple banks without duplication.
- `Note`: optional sourceId/highlightId, userAuthoredBody, richText/Markdown, title, pinned and review state.
- `KnowledgePoint`: compact user-approved derived concept, primaryQuoteId, topic relationship, shortOneLiner, examPearl, misconception, verificationStatus, claims/evidence.
- `Card`: note/knowledgePoint relation, deck/bank, cardType, front, back, cloze/image refs, dueAt and FSRS state.
- `ReviewLog`: cardId, reviewedAt, rating, previous/new scheduling state, sessionId, duration, algorithmVersion, optional userCorrection.
- `Relationship`: directed connection (prerequisite, differential, contradicts, supports, same-as), createdBy, confidence. **Implemented as `Relation` (schema v4, below)** with a smaller set of types (`related`, `supports`, `contradicts`, `cause`, `example`, `prerequisite`), an optional note and no `createdBy` or `confidence`: every link is the person's own and is not graded.
- `FilingRule`: **implemented (schema v4, below).** An auto-filing rule: conditions on a new highlight (sites, address prefixes, title and quote words, kinds, sources, tags) and a target (bank, folder, tags to add), with an order and a flag that makes it ask first. It is not in the original blueprint; PRD "smart auto-filing that requires confirmation".
- `Attachment`: binary/blobRef, mime, length, sha256, source, localOnly/syncAllowed flags.
- `AIResult`: inputSourceIds, inputFingerprint, provider, model, templateVersion, output, token/estimate metadata, citations, verification state, createdAt, acceptedByUserAt, explicit consent reference.
- `SyllabusNode`: user-created path, expected topics, related knowledge points, exam mode. **Implemented as `Syllabus` with a nested `SyllabusNode` tree (schema v4, below):** a topic points at banks and tags and carries an optional weight; there is no per-topic "exam mode" (an exam is configured on the review page, ADR-020) and no stored link to knowledge points.
- `ActivityEvent`: feature name, timestamp, private/local metrics only unless user opts in.
- `SyncOperation`: entityType, entityId, opType, clientId, revision, idempotencyKey, payloadEncrypted flag, tombstone, createdAt.

## Example saved highlight (conceptual schema)
```json
{
  "id": "01H_EXAMPLE_UNIQUE_ID",
  "sourceId": "source-123",
  "exactQuote": "Representative exact source wording.",
  "anchorSet": {
    "type": "html",
    "textQuote": {"exact": "Representative exact source wording.", "prefix": "Before ", "suffix": " After"},
    "textPosition": {"start": 4210, "end": 4247},
    "structuralPath": "main article p:nth-of-type(3)"
  },
  "kind": "exam_pearl",
  "color": "amber",
  "priority": 4,
  "verificationStatus": "not_checked",
  "createdAt": "2026-10-10T10:00:00.000Z"
}
```
`TextPosition` offsets above are illustrative. Actual offsets must be computed using a documented text normalization algorithm, not invented from a CSS selector. DOM structural paths are hints, not absolute truth.

## Evidence and fact integrity rules
- `exactQuote` is an immutable captured source record. User edits to an interpretation go in a separate note or a correctedQuote field with an audit trail.
- Never represent an AI summary as the original quotation.
- Claims can have multiple evidence pointers, contradictory evidence, and explicit reliability grades.
- Document/page anchors must include source fingerprint/version; note if a reopened remote source no longer matches.
- Preserve timestamps with UTC storage, user display in selected timezone.
- Export includes schema version, linked entity IDs, checksum, and provenance so round trips are lossless.

## Search indexes
- Exact lookup by source identity and capture fingerprint; bank/folder/tag; last saved; priority; review due; note type; verification state.
- Full-text on title, quote, user notes, AI-derived texts in separately labeled index fields; fuzzy matching may be later.
- Optional vector embeddings are derived/cachable data; never authoritative and must be regenerable.

## Migration and backup
- Every migration is tested against at least three earlier schema fixtures.
- Export a validated pre-migration backup; migrations transactional where supported.
- Restore into a staging database, integrity-check relationships and checksums, then offer replace/merge, with dry-run and rollback.
- Maintain stable source and annotation IDs across exports.

## As implemented: schema v4 and the later `meta` rows (2026-10-12)

The sections above are the original blueprint. This section is what the code stores today for the
data the finish wave added (ADR-011, ADR-016, ADR-020, ADR-013). The record envelope is the usual one
(`id`, `schemaVersion` 1, `createdAt`, `updatedAt`, `deletedAt`); `schemaVersion` is the record
version, not the Dexie version, which is **4**.

### Tables added in Dexie version 4

| Table | Record | Key and indexes | Limits | In a backup | Sync (`STUDYVAULT_SYNC_POLICY`) |
| --- | --- | --- | --- | --- | --- |
| `filingRules` | `FilingRule`: `name`, `enabled`, `order`, `match` (`hosts`, `urlPrefixes`, `titleContains`, `quoteContains`, `tagIds`, `kinds`, `sourceTypes`; all optional, up to 20 values each, fields ANDed, values ORed, no condition never matches), `action` (`bankId`, `folderId` nullable, `addTagIds`), `requireConfirm` (default `true`) | `id, order, updatedAt, deletedAt` | at most 200 live rules; name 1 to 80 characters | yes | text: `name`, `match`, `action`; scalar (last writer wins): `enabled`, `order`, `requireConfirm` |
| `syllabi` | `Syllabus`: `name`, `nodes` (the whole tree is one row; `SyllabusNode`: `id`, `title`, `children`, `bankIds`, `tagIds`, optional `weight`) | `id, updatedAt, deletedAt` | at most 100 live syllabi; depth 6; 500 topics in all; unique topic ids; 50 banks and 50 tags a topic; weight greater than 0 and at most 1000 | yes | text: `name`, `nodes` |
| `relations` | `Relation`: `fromKind`, `fromId`, `toKind`, `toId`, `type`, optional `note` (500 characters); kinds `highlight`, `knowledgePoint`, `note`; types `related`, `supports`, `contradicts`, `cause`, `example`, `prerequisite` | `id, [fromKind+fromId], [toKind+toId], fromId, toId, updatedAt, deletedAt` | a link to itself is refused; unique by (from, to, type), and `related` has no direction | yes | immutable: the five identity fields; text: `note` |

Rules that hold for all three: soft delete with restore and purge by id (a purge refuses a live id);
optimistic concurrency on the row's `updatedAt` (`{ expectedVersion }` returns `stale` instead of
overwriting); references (a rule's bank, folder and tags, a topic's banks and tags, a link's two ends)
are checked when they are written and only when they are new, and dangling ones are reported by
`checkFilingRules`, `checkSyllabi` and `checkIntegrity`, never rewritten; a link is hidden (derived)
while either end, or the highlight a note or knowledge point belongs to, is in the Trash, and a purge
removes every link touching the purged item in the same transaction. A rule only ever acts on a new
highlight and never changes provenance. The upgrade from version 3 only advances `meta['schema']`
(`dbVersion: 4`, `v4MigratedAt`) and touches no row.

### `meta` rows added by the finish wave

`meta` is a local-only key-value table: it is excluded from every backup (`BACKUP_EXCLUDED_TABLES`),
has no sync policy, and is removed with the database by "Delete all data". None of these rows needed a
Dexie version.

| Key | Holds | Written by | Notes |
| --- | --- | --- | --- |
| `aiProfileKeys` | `{ [profileId]: { apiKey, origin } }`: the API key of each fallback provider, bound to the origin it was saved for | `packages/storage/src/ai.ts` | a secret: read only through `getAiProfileApiKey`, never in a result, backup, export or sync row; listed in `AI_SECRET_META_KEYS` with `aiKey`; removed with its provider in the same transaction. The provider list itself (at most three fallbacks and the per-task routes) is inside the `aiSettings` row |
| `examSession` | the exam in progress or its unread results: `version` 2, scope (a bank, folder, tag or all, or a syllabus with an optional topic and a weighted flag), seed, card ids, the person's answers and marks, times and `expiresAt` (24 h after the start, or after the finish); for a syllabus exam also the outline's topic titles as they were, what was left out, and the topic of each question; no card text | `packages/storage/src/exam.ts` (`upgradeExamSession`) | validated on every read; a version 1 row from before the update is carried over (no syllabus, no topic on any question); an expired row is removed and a row that cannot be read is removed and reported |
| `examHistory` | summaries of the last 20 finished exams (scope label, optional `syllabusId`, counts, limit, time used, whether counted as review); no question text (the scope label of a syllabus exam names the syllabus and the topic, at most 300 characters) | `packages/storage/src/exam.ts` | "Clear this list" removes it; not portable by design |
| `syllabusThresholds` | `{ minHighlights, minCards }`, whole numbers 0 to 999 (defaults 3 and 1) | `packages/storage/src/syllabusCoverage.ts` | damaged values fall back to the defaults |
| `backupFolder.handle` | the `FileSystemDirectoryHandle` of the folder the person picked (a structured-cloned reference; Chrome keeps the grant) | `packages/storage/src/backupFolder.ts` | unusable on another device, so it is in no backup |
| `backupFolder.state` | `folderName`, `chosenAt`, `keepLast` (1 to 100, default 5), `remindAfterDays` (0 to 365, default 7) and `last` (`at`, `fileName`, `bytes`, `sha256`, `encrypted`, `pruned`) or null | `packages/storage/src/backupFolder.ts` | a damaged row reads as "no folder" |

Not in the database at all (by design): the auto-filing suggestion and undo records
(`chrome.storage.session`, `sv.filing.suggest.<id>`, `sv.filing.undo.<id>`, 24 h, at most 100 each),
the reminder notice (`chrome.storage.session`, `reminderDue`), and `Settings.reminders`
(`{ on, dailyAt }`) and `Settings.useFilingRules` (`chrome.storage.local` with the trusted copy).
Imported Word, PowerPoint, EPUB, HTML and Anki files add no new table: each file becomes Sources of its
own (`urlKey` `imported:<batchId>:<n>`) and highlights with `captureMethod: 'import'`,
`customFields.importedFrom` (`anki`, `html`, `epub`, `docx`, `pptx`), `needsReview`, `importedFile`
and `importedLocator`.

## As implemented: schema v5, the game layer (ADR-022, 2026-10-14)

Dexie version **5** adds two append-only ledger tables and changes no existing table or index. The
upgrade from version 4 only advances `meta['schema']` (`migratedFrom: 4`, `dbVersion: 5`,
`v5MigratedAt`) and reads or writes no vault row; the ledger of an existing vault is filled afterwards
by a resumable backfill (below). XP, level, streak, freezes, badges and celebrations are never stored:
they are a replay of both tables with the device's study-day boundary (`getGameState`).

### Tables added in Dexie version 5

Both hold the same row, `GameRow` (`packages/study/src/game.ts`): `id`, `schemaVersion` 1, `kind`,
`at` (ISO instant), `ref` (the source or session id, or null) and `value` (an integer or null). Rows
are only ever added; nothing updates or deletes them except a replace restore and "Delete all data".

| Table | Rows | Key and indexes | In a backup | Sync |
| --- | --- | --- | --- | --- |
| `gameEvents` | one per XP-earning source row, a pure function of it: `rv_<logId>` (review, at `reviewedAt`), `hs_<highlightId>` (save, at `createdAt`; none for `captureMethod: 'import'`), `cd_<cardId>` (card, at `createdAt`) | `id, at, schemaVersion` | yes | **never**: every device derives the same rows from the source rows it holds (live writes, the sync applier, its own backfill) |
| `gameFacts` | what cannot be re-derived: `ru_<logId>` (review undone, at the review's `reviewedAt`), `hu_<highlightId>` (save deleted within 10 minutes, at its `createdAt`), `cu_<cardId>` (a card a merge restore added, at its `createdAt`), `sb_<sessionId>` (review session finished with at least one answer), `gs_<uuid>` (daily goal, `value` 10, 30, 50 or 100), `gm_<uuid>` (Game mode, `value` 1 or 0), `gx_<uuid>` (game start on this vault, the epoch), and a copy of any `gameEvents` row whose source a purge removed (same id and content) | `id, at, [kind+at], schemaVersion` | yes | append-only (`STUDYVAULT_SYNC_POLICY.gameFacts`), only when sync is on |

XP per kind is a rule, not data (`XP` under `GAME_RULES_VERSION` 1): review 1, save 2, card 3,
session 5; `ru_`, `hu_` and `cu_` cancel their event. A level needs `25·L·(L−1)` XP in all. A day without a
chosen goal is judged against 30; a goal change applies from the current study day. A new goal or
Game mode fact is dated after the latest one of its kind, so one stamped by a clock that ran ahead
never outranks a later choice. Rows whose ids
collide are identical by construction, so a retry, the backfill, the applier, a merge restore and a
sync pull add each row at most once (`addMissing`).

Writes happen in the same transaction as the action that earned them: `reviewCard`,
`undoLastReview`, the four card creators and `acceptAiItem`, `saveCapture` and `savePdfHighlight`
(status `created` only), `softDeleteHighlight` and `bulkDelete` (the 10-minute undo),
`completeStudySession` (called by the review page when a session is done; it also clears the stored
session), the sync applier (on a remote delete too, before the row goes), and `purgeInTx` (it first
derives the purged rows' ledger rows, so a purge before the backfill keeps their XP, then copies
them). Imports, duplicates, Trash restores, `restoreCards` and merge restores earn nothing: a merge
writes the canceller (`ru_`, `hu_`, `cu_`) of every source row it adds whose event the vault does
not hold, so the backfill, another device's applier and a later re-derivation all net 0.

### `meta` rows added by the game layer

Device-local like every `meta` row: never backed up, never synchronised.

| Key | Holds | Notes |
| --- | --- | --- |
| `game.backfill` | `{ v: 1, runId, rulesVersion, status: 'running' \| 'done' \| 'failed', table, after, added, done, total, startedAt, heartbeatAt, error? }` | missing means not started. Each page of at most 1,000 source rows writes its ledger rows and this checkpoint in one transaction, and stops when `runId` changed. Started by the worker on install, update and browser start, and by any page whose state is not ready; a Web Lock keeps two contexts from doing the work twice. A newer `GAME_RULES_VERSION` runs it again |
| `game.seen` | `{ v: 1, baselineAt, keys }` | written when the backfill finishes. Celebrations are claimed here once per device in one read-write transaction; nothing dated before `baselineAt` is celebrated. Dated keys older than three days are pruned |
| `game.cache` | `{ v: 1, key, timeZone, rolloverHour, cutDay, count, days }` | per-day totals of closed days; used only while its key (rules version, study-day boundary, last restore) and its row count below the cut still match. Disposable |

A replace restore deletes all three rows in its commit, so the backfill derives the ledger again from
the restored rows (a v1 to v4 archive gets a new start fact; its goals, session bonuses and undos are
not invented). `BACKUP_MIGRATIONS` has `{ from: 4 }`; a version 4 archive restores unchanged.
