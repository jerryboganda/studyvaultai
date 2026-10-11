# ADR-010: Module seams (integration wave)

**Status:** accepted · **Date:** 2026-10-11 · Refines ADR-003, ADR-005 and ADR-009. Amendment 1 and
amendment 2 (below) revise sections 1, 2 and 6 and the `meta` and "Where a setting lives" tables;
those places say so.

## Context
Storage, search, backup, sync, AI and the PDF reader were built by independent agents against ports.
Each module was tested alone; the defects below only exist between modules. Every decision names the
test that proves it, at the lowest level that can express it.

## Decisions

### 1. "Delete all data" reaches every copy of the vault
Two more databases hold a full copy of the vault: `studyvault-premigration` (the automatic pre-update
archive) and the restore staging databases (`studyvault-restore-staging-<id>`, one per restore, plus
the fixed name older builds used; a restore that crashed leaves its database behind).
**Revised by amendment 2.** `wipeAllData` deletes the main database FIRST and without a deadline: an
IndexedDB delete cannot be withdrawn once requested, so abandoning it would leave it queued to run
later, after the copies, the settings and the site access had been cleared. Its states are
`deleting`, `blocked` (another StudyVault window holds the database: the request waits and finishes
by itself when that window closes) and `cleaning`; every database call in the calling context fails
at once with `WipePendingError` while the delete is pending, and a caller that stops waiting gets
that error while the wipe still completes. Only after the database is gone are the pre-update copy,
every restore staging database (found by prefix: `clearRestoreStaging`), `chrome.storage.local`,
`chrome.storage.session` and the optional host grants removed. Last, the recreated empty database
receives one `searchIndexStale` row with a random token (section 6). `repo.ts` imports the copy
helpers statically from `backupTarget.ts`: that module imports no repository, so there is no cycle.
Tests: `backupTarget.test.ts` "Delete all data also removes the pre-update copy ...";
`lifecycle.test.ts` "Delete all data while another window holds the database" (4 tests);
`backupHardening.test.ts` "the sweep removes the fixed-name database of older builds and any
leftover, nothing else".

### 2. Service worker start
**Revised by amendment 2.** The pre-update copy hook is installed by `@storage` itself, at import of
`backupTarget.ts`, in every context that loads the storage layer (`installPreMigrationSnapshot()`
with its defaults; the manifest version is read lazily from `browser.runtime.getManifest()`), because
whichever context opens the database first after an update performs the upgrade: the worker, a
page opened right after, or the sync runtime. The worker no longer installs it, and calling it again
with options replaces the default. The worker opens the database itself on `onInstalled` with
`reason === 'update'` (`withDb(async () => {})`), so the upgrade and the copy normally happen there.
On `onInstalled` with `reason === 'install'` it opens `onboardingPath` (`@ui/shell/paths`); never
for `update`, `browser_update` or a reload. Every listener is still registered synchronously at top
level.
Tests: `entrypoints/background/index.test.ts` (first install opens one tab; update does not; "keeps a
restorable copy of the old data when the worker meets a schema upgrade"; "upgrades the database, with
its copy, as soon as the worker hears about an update"); `lifecycle.test.ts` "pre-update copy:
whichever context upgrades the database" (4 tests).

### 3. Backup restore versus sync
A replace-mode restore used to be captured as the user's own edits: sync's fingerprints still described
the replaced rows, so reconcile turned every row the backup lacked into a tombstone and pushed it, and
the client id was never regenerated. Decision:

- **Replace**: in the same transaction as the restore, if the database has a sync identity
  (`meta['sync.clientId']` exists), `resetSyncIdentityIfUsed` (in `syncIdentity.ts`, split from
  `sync.ts`, whose import registers the connection gate) runs `resetSyncIdentity`: new client id,
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
**Revised by amendment 2.** `meta['searchIndexStale']` is the GENERATION of the vault: an opaque
token that a restore (a timestamp) or "Delete all data" (a random id) replaces, because both
replace or remove rows without moving any `updatedAt` the incremental catch-up looks at. It is never
removed. Each `SearchHost` remembers the value it indexed (and persists it in
`searchIndexState.generation`) and compares it, on open and before every catch-up and again before
it writes the cache; a different value means rebuild, and a write made for another generation is
dropped. An absent value and `null` both mean "never replaced" (a port without `delete` writes
`null`). A purge is detected through `getLastPurgeAt()`. Rows the feed cannot read are passed over,
counted as rejected and never truncate the index, and writers stamp `updatedAt` after their first
read inside the write transaction so a catch-up cannot miss them. Limit: the persisted cache keeps
the text of purged items until a host rebuilds and writes it. Tests: `searchHost.test.ts` ("SearchHost:
after a backup restore", "two hosts over one vault", "unreadable rows"), `searchHost.vault.test.ts`
(real vault, real restore, real purge, real wipe), `packages/storage/src/search.test.ts`.

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
| `searchIndex`, `searchIndexState` | `SearchHost` (dashboard, side panel) | serialised index cache and its bookkeeping, including the generation it was built for (derived) |
| `searchIndexStale` | restore commit, `wipeAllData` | the vault's GENERATION token (a timestamp or a random id): hosts compare it and rebuild when it differs; **never deleted**; a wipe leaves one such row in the new, empty database (section 6, amendment 2) |
| `savedSearches` | dashboard | the person's saved searches (**not in backups**: known gap) |
| `aiSettings` | `@storage/ai` | provider, endpoint, limits |
| `aiKey` | `@storage/ai` | the provider key and the origin it was saved for (secret) |
| `aiBudget` | `@storage/ai` | usage ledger |
| `sync.clientId`, `sync.state`, `sync.dirty` | `@storage/sync` | identity, engine state, "reconcile before pulling" |
| `lastRestore` | restore commit | `{ at, mode, rows }` of the last restore |
| `lastPurgeAt` | `@storage/trash` | when anything was last purged (search rebuild trigger) |
| `studySession` | `@storage/study` | the review session in progress |
| `sync.config`, `sync.encryption`, `settings.trusted` | worker, `updateSettings` | the sync server, issuer and client id, the person's encryption decision, and the authoritative copy of the settings (amendment 1) |

Also excluded from backup: `syncOps` (this device's outbox). `attachments` (cached PDF bytes) are
local-only and included only on request.

### Where a setting lives
- **`chrome.storage.local`**: `settings` (flags, deny list, appearance: the page-side copy, which is
  display data, the worker enforces `settings.trusted`), `studySettings`, `onboarding`, `syncConfig`
  (legacy: moved once to IndexedDB `sync.config` by amendment 1, then removed),
  `dataEpoch`/`resolutionEpoch`.
  Content scripts can read this area (no `setAccessLevel`), so it holds only what they legitimately
  need and nothing private.
- **`chrome.storage.session`**: `syncTokens`, `syncBinding`, `syncOidc`, `syncKey` (the unlocked E2EE
  key, absolute 15-minute expiry), `syncStatus`, `sv.pendingFocus`. Gone when
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
click that turns sync on. A PDF's origin is handed back by the reader once the fetch is over, unless
the person already had access to it (ADR-006 amendment 2). "Delete all data" revokes every optional
host grant (not the optional `identity` and `alarms` permissions).

## Consequences
- A restore with sync on never shrinks the account; making other devices match a backup is a
  separate, explicit action (not offered).
- `savedSearches` is user data outside the backup format; adding it needs a format decision.

## Amendment 1 (2026-10-11): privileged configuration, the first upload, the E2EE key

**Status:** accepted · Supersedes "Where a setting lives" above for the rows named here. Append-only:
the sections above are left as they were written.

### Context
A security review and a claims audit of the sync feature found that (1) a compromised content script
(next to untrusted page script, with write access to `chrome.storage.local`) could redirect real
OIDC tokens and vault operations by writing `syncConfig`, and could loosen the deny list,
private-window capture and feature flags the worker re-checks; (2) end-to-end encryption setup and
passphrase rotation re-encrypted whatever plaintext a server returned, making server-injected
operations authentic; (3) the first upload after sign-in was not encrypted unless the server already
had a key profile; (4) the E2EE key lived only in the worker's closure, so "unlocked for about 15
minutes" was false once the worker was suspended; (5) a server that stopped presenting the key
profile could downgrade a device to plaintext; (6) the consent text did not list what the policy
uploads; (7) the AI-after-decryption warning of SECURITY_PRIVACY.md was missing from the card.

### Decisions

**1. Where privileged configuration lives.** Nothing that decides where tokens or the vault go, or
what the worker lets through, is read from `chrome.storage.local` any more. New `meta` rows
(IndexedDB, extension origin; never exported, restored or synchronised; removed with the database by
"Delete all data"):

| Key | Writer | Content |
| --- | --- | --- |
| `sync.config` | worker | server URL, issuer, client id, and the key profile (kid, version) this device has seen |
| `sync.encryption` | worker | the person's decision (`plaintext` or `e2ee`), the key profile enabled or unlocked here (downgrade marker), the last re-keying's "set aside" count, and a stored warning |
| `settings.trusted` | `updateSettings` | the authoritative copy of `Settings` that the worker enforces |

`@storage` (`syncPrivate.ts`) reads and writes them; it also registers the authoritative settings
store with `@runtime` at import (guarded by `typeof indexedDB`, so a content script or a
database-less sandbox keeps the single-copy behaviour). `syncConfig` moves once: it is read from
`storage.local` only when `sync.config` is absent, and only if Chrome already holds the person's
grant for both origins; it is removed either way and never read again.

**2. Tokens are bound.** The session store records the (server, issuer, client id) the tokens were
issued for (`syncBinding`). A token set that does not match the configuration in use is forgotten
and never sent (`tokensFor`); a status read reports "signed out" without destroying them.

**3. Authoritative settings.** `getTrustedSettings()` (`@runtime`) returns the copy in `meta`; its
first read after an upgrade adopts what `storage.local` held, after which a direct write to
`storage.local` is ignored by it. `updateSettings` reads and writes that copy (and mirrors it to
`storage.local`), so a planted value is corrected by the next legitimate write instead of adopted.
The worker uses it for: the capture handler (deny list, private-window capture), the quick-save
command (private-window capture), site-access sync (deny list, persistent-origin hint) and the sync
service (the feature flag; storage events re-read it rather than trust their payload).
`setAccessLevel('TRUSTED_CONTEXTS')` on `storage.local` was rejected: the content script reads
`settings` (painting) and `dataEpoch` from it. `storage.session` is set to `TRUSTED_CONTEXTS`
explicitly at worker start (it is the default; stated so a later change cannot expose tokens or the key).

What a content script can still influence, all of it display or local-only: the stored `settings`
copy (what the page-side painter, the popup and the side panel show), `dataEpoch`, and
`studySettings`/`onboarding`. Not covered by this change, and why it is harmless: the per-connection
capture gate in `@storage/sync.ts` and the PDF reader's write restriction (`pdf.ts`) still read the
`storage.local` copy. A planted `features.sync` can only make extension contexts record local writes
in the outbox (nothing is sent: the worker's service enforces the authoritative flag); a planted
`allowIncognitoCapture` can only change what the extension's own reader page persists, and a
content script cannot trigger that. `features.ai` is read by extension pages for display; every AI
request still needs a `ConsentToken` bound to the previewed payload, the key and a granted origin.

**4. The first upload waits for an explicit decision.** No record in `sync.encryption` and no key
profile known = nothing is pushed (`engine.sync({ push: false })`), from the sign-in run, the timer
and "Sync now" alike (every one goes through `runSync`); pulling is allowed. The status is
`awaiting_encryption_choice`. The decision is a passphrase (`sync.e2ee.setup`) or the explicit
`sync.uploadPlain` ("Upload without end-to-end encryption", with the acknowledgement that the
server operator can read everything). Changing the server, provider or client id forgets it.

**5. Re-keying never blesses what the server planted.** `buildRotation` re-encrypts an operation only
if it authenticates under the old key. Anything else gets a replacement the server requires (it
insists on full coverage) that no key opens, so every device refuses it as `decrypt_failed`, and the
device that re-keyed lists it under "Refused changes" and reports the count. Setup (a plaintext
log, nothing authenticates) first applies the log like any pull (`auditHistory`, which validates
every operation), keeps only operations of OTHER devices it validated and merged, replaces this
device's own history with an authenticated void (`{ v: 1, void: true }`, skipped silently by
receivers) and re-sends this device's rows and deletions from its own state under the new key. Known
cost: re-sent snapshots carry fresh clocks, so a concurrent unsent scalar edit on another device can
lose to them (the same limitation as "send this device's data again"); the card says to sync the
other devices first.

**6. The key survives worker suspension, until an absolute expiry.** After the passphrase is accepted
the data key (derived extractable) is exported as a JWK into `chrome.storage.session` key `syncKey`
with `{ kid, expiresAt }`, 15 minutes from the unlock, never extended by use. The session store is
authoritative: every run (`ensureKey`) re-imports it as a non-extractable key, or drops it when
expired, for another key version, or missing. Locked by: the expiry (an in-worker timer and the
`sv-sync-lock` alarm), "Lock now", sign-out, turning sync off, a different server/provider, deleting
server data, a restore that replaced the sync identity (noticed by `isCurrent`) and "Delete all data"
(`storage.session.clear()`). Locked means: no key on this device, nothing is pulled, applied or
pushed, and nothing is ever sent unencrypted meanwhile.

**7. Downgrade protection.** When this device enabled or unlocked E2EE, `sync.encryption.profile`
remembers the key profile. A run that finds the server presenting none, an older version, or another
kid at the same version stores a warning and refuses to pull or push; a newer version (another
device rotated) is accepted and the device waits as locked. Turning encryption on again from here is
refused while that marker exists. Only "Delete my data from the server" (explicit) clears it.

**8. Consent text.** The list of what is uploaded is generated from `STUDYVAULT_SYNC_POLICY`
(`packages/ui/src/sync/consent.ts`), through a typed table-to-label map; `consent.test.ts` fails
when a synchronised table has no label. It states what the server still sees under E2EE, what never
leaves the device, that the sign-in provider learns sync is used, and (card) that AI processing of
decrypted text needs a separate consent.

### Tests
`entrypoints/background/sync.test.ts` (gate, configuration source, token binding, key persistence and
expiry, downgrade), `entrypoints/background/sync.integration.test.ts` (reference server: first upload,
forged operation at setup, forged operation at rotation, suspended worker, tokens, downgrade),
`entrypoints/background/index.test.ts` (worker ignores a planted deny list and incognito flag),
`packages/storage/src/syncPrivate.test.ts`, `packages/sync/src/crypto.test.ts`,
`packages/sync/src/rekey.test.ts`, `packages/ui/src/sync/consent.test.ts` and `sync.test.tsx`.

### Not verified here
Real Chrome behaviour of `storage.session` (memory-only, cleared at browser exit and extension
reload), of `chrome.alarms` with `when`, and of a worker that is suspended and woken by an alarm;
real OIDC provider sign-in. These need the loaded-extension E2E suite and a provider.

## Amendment 2 (2026-10-11): restore and import guards, deletion lifecycle, search generation

**Status:** accepted · Revises sections 1, 2 and 6, the `meta` table rows for the search index and
"Where a setting lives", which were corrected in place on the same day because they described
behaviour that no longer exists. Amendment 1 is unchanged.

### Context
The security review and the claims audit of the working tree found, besides the sync findings of
amendment 1: (1) a merge-mode restore took its list of unchangeable fields from the engine, so a
forged archive could rewrite capture provenance of a row the vault has; (2) a ~130-byte forged ZIP64
record made the generic ZIP reader walk billions of entries; (3) restored JSON was not checked for
prototype-polluting member names; (4) restored AI results kept `source_supported` and citations the
vault could not back; (5) imports could join a Source that a capture made; (6) restores could run
twice at once and shared one fixed-name staging database; (7) "Delete all data" could give up on a
queued delete, clearing settings and copies first, while open search indexes could write the deleted
text back; (8) a purge left text in derived AI results, sync conflict, quarantine and outbox rows;
(9) the pre-update copy depended on which context upgraded the database and was sized only after
reading everything.

### Decisions
**1. The unchangeable fields come from the target.** `RestoreTarget.immutableFields` returns, per
registry table, the sync policy's `immutable` members and `*` (every field) for an append-only table
(`immutableFieldsOf` in `packages/storage/src/restoreGuards.ts`). A merge keeps the live row whole and
reports `immutable_field_changed` when an archive row differs there. The engine has no list of its
own. A replace, and rows new to the vault, are taken as the archive has them: a backup is not signed
(its checksums detect damage), which `PRIVACY_POLICY.md` says.

**2. The ZIP central directory is read by StudyVault's own reader** (`listZip`, `readZipEntry` in
`packages/backup/src/format.ts`), never by fflate on untrusted bytes: ZIP64 markers are refused
(`corrupt_archive`), the entry count (50,000) and the sum of declared sizes (2 GiB) are capped
(`limit_exceeded`) before any entry is walked, names are bounded (1,024 bytes), duplicates are
refused and a DEFLATE entry declaring more than about 1100:1 is refused before allocation. The
Markdown import readers (headings, links, tags, block ids) are hand-written and linear.

**3. Member names are checked on the parsed object graph** (not on the text, which a JSON escape
can spell around): `__proto__` anywhere, `constructor.prototype` and a `prototype` object make the
row invalid (`forbidden_key`). A field merely named `constructor` is data. Only a row that passed
every check is staged.

**4. Restored AI results are re-grounded and only ever demoted** (`aiCitationGuard` in
`restoreGuards.ts`, the pipeline's `groundClaims` rule against the passages the vault will hold).

**5. Imports always create their own Source** (`urlKey` `imported:<batch>:<n>`, which no page can
match; the file's address is a claim shown in `originalUrl`, or a `studyvault.invalid` stand-in) with
`captureMethod: 'import'`.

**6. One restore at a time.** `RestoreTarget.exclusive` is `withRestoreLock`: a Web Lock named
`studyvault-restore` (`ifAvailable`) across extension pages plus an in-memory flag, rejecting with
`restore_in_progress`. Each restore stages into its own `studyvault-restore-staging-<uuidv7>`
database, released on success and on failure; `createStaging`, `clearRestoreStaging` and "Delete all
data" sweep every database with that prefix (and the fixed name older builds used).

**7. Backups hold study data only.** `BACKUP_EXCLUDED_TABLES = ['meta', 'syncOps']`: no settings, AI
provider settings, key or usage, sync configuration, account or queue, saved searches or session in
progress. The wording shown to the person is generated in one place
(`packages/ui/src/backup/scope.ts`).

**8. "Delete all data" is database-first and never abandons a queued delete** (section 1 as
revised): `WipeState` `deleting` / `blocked` / `cleaning`, `WipePendingError`, `AbortSignal` to stop
waiting, and a search generation token written into the recreated database.

**9. The search index follows a generation token** (section 6 as revised).

**10. A purge removes what was derived from the purged rows** (`packages/storage/src/trash.ts`):
AI results that list ANY purged highlight or note among their inputs; evidence references in
knowledge points that survive (`primaryQuoteId` re-homed, `source_supported` back to `not_checked`);
orphan sources; for sync, conflict and quarantine rows of the removed entities, acknowledged outbox
copies and the unsent copies of an entity that was never delivered (a content-free tombstone
remains). Accepted limits: an already-delivered entity's unsent edit is sent once before its
tombstone (its causal context refers to it); an attempted-but-unacknowledged outbox row is not
rewritten; `syncEntityMeta` (clocks, truncated field hashes, tag alias members) stays until a sync
run prunes it 90 days after the tombstone.

**11. The pre-update copy** (section 2 as revised) estimates its size from row counts and a 25-row
sample per table before reading anything, keeps nothing above 64 MB (`too_large`, with a reason that
tells the person to save a backup), never reads cached PDF bytes, and is removed by "Delete all data".

**12. Table references come from the module that owns the schema.** The registry's references for
`knowledgePoints`, `decks`, `cards` and `reviewLogs` are read from `@study/schema`
(`STUDY_TABLE_SPECS`), so a field a module adds (`primaryQuoteId`) is integrity-checked on restore
without a second edit. `mergeBanks` re-points the merged bank's decks, so a later purge orphans
nothing. These are integrity fixes, not privacy claims.

**13. The URL redaction rule** lives in one place (`isCredentialName` in
`packages/shared/src/urls.ts`): credential stems and whole words judged on the name alone, a trailing
`code`, the `x-amz-` and `x-goog-` families, applied to query parameters, `;name=value` path
parameters and route fragments. It is applied when an address is saved, not retroactively, and not
again by restore or sync.

### Tests
`packages/backup/src/hardening.test.ts`, `packages/backup/src/importExternal.test.ts` ("Markdown import
is linear on hostile lines"), `packages/storage/src/backupHardening.test.ts`,
`packages/storage/src/lifecycle.test.ts`, `packages/storage/src/search.test.ts`,
`packages/storage/src/bulk-trash.test.ts` ("derived text"), `packages/storage/src/sync.test.ts`
("purge and the sync bookkeeping"), `packages/ui/src/vault/searchHost.test.ts` and
`searchHost.vault.test.ts`, `packages/shared/src/urls.test.ts`. All are unit or integration tests
(fake IndexedDB, `fakeBrowser`); none has been run by CI.

### Not verified here
Real Chrome behaviour of Web Locks across extension pages, of a queued IndexedDB delete with a frozen
window, and of the restore staging databases after a browser crash; the timing bounds of the import
reader on a loaded runner; anything in a real private window.
