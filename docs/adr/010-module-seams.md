# ADR-010: Module seams (integration wave)

**Status:** accepted · **Date:** 2026-10-11 · Refines ADR-003, ADR-005 and ADR-009.

## Context
Storage, search, backup, sync, AI and the PDF reader were built by independent agents against ports.
Each module was tested alone; the defects below only exist between modules. Every decision names the
test that proves it, at the lowest level that can express it.

## Decisions

### 1. "Delete all data" reaches every copy of the vault
Two more databases hold a full copy of the vault: `studyvault-premigration` (the automatic pre-update
archive) and `studyvault-restore-staging` (the staging area of a restore that crashed). `wipeAllData`
now deletes both after the main database (`deletePreMigrationSnapshot`, `clearRestoreStaging`).
`repo.ts` imports them statically from `backupTarget.ts`: that module imports no repository, so there
is no cycle.
Test: `backupTarget.test.ts` "Delete all data also removes the pre-update copy ...".

### 2. Service worker start
`entrypoints/background/index.ts` calls `installPreMigrationSnapshot({ appVersion })` once, as the
first statement of the worker body and only there (a page that also installed it would track the hook
in its own liveQuery). On `onInstalled` with `reason === 'install'` it opens `onboardingPath`
(`@ui/shell/paths`); never for `update`, `browser_update` or a reload. Every listener is still
registered synchronously at top level.
Tests: `entrypoints/background/index.test.ts` (first install opens one tab; update does not; a v1
database upgraded by the worker leaves a kept archive stamped with the manifest version).

### 3. Backup restore versus sync
A replace-mode restore used to be captured as the user's own edits: sync's fingerprints still described
the replaced rows, so reconcile turned every row the backup lacked into a tombstone and pushed it, and
the client id was never regenerated. Decision:

- **Replace**: in the same transaction as the restore, if the database has a sync identity
  (`meta['sync.clientId']` exists), `resetSyncIdentityIfUsed` runs `resetSyncIdentity`: new client id,
  outbox, entity metadata, conflicts, quarantine and `sync.state` cleared. The marker `sync.dirty` that
  the commit writes makes the next run reconcile first, so the restored rows are sent as creates.
  Nothing is deleted from the account; rows the backup lacks come back from it on the next pull (the
  restore dialog says so, `SYNC_RESTORE_NOTE`, shown only while sync is on and only for replace).
- **Merge**: no reset. Merged rows are ordinary edits found by fingerprint; merge never deletes.
- A device that never synchronised gets no identity from a restore.
- Other contexts: capture reads the stored client id inside the writing transaction, and the worker
  replaces a cached runtime when `SyncRuntime.isCurrent()` is false, so a restore in the options page
  reaches the worker and the side panel without messaging.
- Not changed: the account binding (`accountId`) is part of the reset state and is re-pinned at the
  next run; restoring a backup made on another account therefore uploads to the signed-in account.

Tests: `packages/storage/src/restoreSync.test.ts` (real engine, real Dexie runtime, `FakeServer`),
`entrypoints/background/sync.test.ts` (runtime replaced), `packages/ui/src/backup/backup.test.tsx`.
The UI reads `BackupDeps.syncActive()`.

### 4. One sync policy
`STUDYVAULT_SYNC_POLICY` in `packages/sync/src/policy.ts` is the only policy. The storage overlay and
its stale field names are gone. `sync.policy.test.ts` (ordinary unit suite) loads the study and AI
modules, checks every named field against the registered schemas, and fails when a schema field is in
none of immutable / text / sets / local / the explicit scalar list: a new free-text field cannot merge
last-writer-wins unnoticed.

### 5. Search accepts the vault's nulls
`kind`, `priority` and `resolveStatus` are `null` for a note attached to no highlight. `@search`
accepts null and holds `''`, `0`, `''` (no `kind:`/`status:` match, not counted in those facets,
priority 0 sorts last). `SearchHost` no longer converts; `toIndexDocument` remains as an identity shim
for the dashboard test that still imports it.

### 6. Search staleness
A restore writes `meta['searchIndexStale']`: it replaces or removes rows without moving any
`updatedAt` the incremental catch-up looks at. `SearchHost` rebuilds when it is present (on open and
before every catch-up), writes the new cache, and only then removes it (compare-and-clear: a second
restore that landed during the build leaves its marker). A port without `delete` writes `null`, which
counts as absent. A purge is detected through `getLastPurgeAt()`. Tests: `searchHost.test.ts`,
`searchHost.vault.test.ts` (real vault, real restore, real purge).

### 7. Stand-in source addresses
Sources without an address carry `https://studyvault.invalid/pdf/<id>` (local PDF) or
`https://studyvault.invalid/imported/<batch>/<n>` (imported highlights without a URL). `@shared`
exports `isPlaceholderSourceUrl` and `visibleSourceUrl`; the search feed, `@ui/hosts` and `safeHref`
use them, so no placeholder is indexed, shown or linked. (The feed only hid the PDF one before.)

### 8. `captureMethod: 'import'`
Imported highlights are no longer recorded as `'context-menu'`. The enum gained `'import'`; the
`customFields` marker (`importedFrom`, `needsReview`) is unchanged. Compatibility: an older build
validating a newer archive or sync operation rejects those rows (`row_invalid` / quarantine). The
schema version is not raised: this is an additive value and no release carries both builds.

### 9. Duplicate members
`DuplicateMember.documentId` (optional, only for PDF sources) lets a viewer open the reader at
`pageNumber`. Web members keep their previous shape.

### 10. How an accepted AI point is marked
`KnowledgePoint` has no `needsHumanVerification`: an AI-created point is `createdBy: 'ai'`,
`verificationStatus: 'not_checked'`, `acceptedAt: null` until the person accepts it, and accepting
never verifies it (`acceptKnowledgePoint`). Cards made from it carry `createdBy: 'ai'` and
`needsHumanVerification: true` until `markCardVerified`. No schema change was needed. Test:
`study.test.ts` "an AI-created point arrives unaccepted and unchecked, and its cards are flagged".

### 11. Worker bundle
`study.ts` (4 schemas), `ai.ts` (1) and `sync.ts` (the connection gate) act at import time. That is
required, not incidental: backup validation, the integrity check and the sync policy read the
registry, and the worker imports only the barrel (`barrel.test.ts` pins it). Unused repository code
is already tree-shaken (no study, AI or backup-restore strings are in `background.js`), so no split
was made. Measured with a private build: `background.js` 353,296 B before this wave's worker changes,
376,650 B after (+23 KB: the export path the pre-update snapshot needs), budget 430,080 B (420 KB).

## Module seams reference

### `meta` table (IndexedDB, extension origin)
Never exported or restored (`BACKUP_EXCLUDED_TABLES`), never in the pre-update snapshot, removed with
the database by "Delete all data". Not synchronised.

| Key | Writer | Content |
| --- | --- | --- |
| `schema` | storage `db.ts` | migration marker |
| `searchIndex`, `searchIndexState` | `SearchHost` (dashboard, side panel) | serialised index cache and its bookkeeping (derived) |
| `searchIndexStale` | restore commit | "rebuild the search index", removed by `SearchHost` |
| `savedSearches` | dashboard | the person's saved searches (**not in backups**: known gap) |
| `aiSettings` | `@storage/ai` | provider, endpoint, limits |
| `aiKey` | `@storage/ai` | the provider key and the origin it was saved for (secret) |
| `aiBudget` | `@storage/ai` | usage ledger |
| `sync.clientId`, `sync.state`, `sync.dirty` | `@storage/sync` | identity, engine state, "reconcile before pulling" |
| `lastRestore` | restore commit | `{ at, mode, rows }` of the last restore |
| `lastPurgeAt` | `@storage/trash` | when anything was last purged (search rebuild trigger) |
| `studySession` | `@storage/study` | the review session in progress |

Also excluded from backup: `syncOps` (this device's outbox). `attachments` (cached PDF bytes) are
local-only and included only on request.

### Where a setting lives
- **`chrome.storage.local`**: `settings` (flags, deny list, appearance), `studySettings`,
  `onboarding`, `syncConfig` (server and issuer, no secret), `dataEpoch`/`resolutionEpoch`.
  Content scripts can read this area (no `setAccessLevel`), so it holds only what they legitimately
  need and nothing private.
- **`chrome.storage.session`**: `syncTokens`, `syncOidc`, `syncStatus`, `sv.pendingFocus`. Gone when
  the browser closes; not exposed to content scripts by default.
- **IndexedDB `meta`**: everything private or large (above). The AI key is here, and not in
  `storage.local`, because a content script runs next to untrusted page script and can read
  `storage.local` but cannot open the extension origin's IndexedDB.

### Grants
Site access (ADR-003) and the per-origin grants for features are different things. The AI endpoint
(ADR-009), the sync server and issuer, and a PDF's origin are requested one origin at a time from a
user gesture, and are never read as site access: `grantedOrigins()` counts only all-sites patterns
and the origins the person enabled in StudyVault, so such a grant never injects the highlighter. The
optional permissions `identity` (sign-in window) and `alarms` (sync timer) are requested from the
click that turns sync on. "Delete all data" revokes every optional grant.

## Consequences
- A restore with sync on never shrinks the account; making other devices match a backup is a
  separate, explicit action (not offered).
- `savedSearches` is user data outside the backup format; adding it needs a format decision.
