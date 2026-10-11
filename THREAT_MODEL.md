# Threat model - StudyVault AI

Method: STRIDE over the real architecture (ARCHITECTURE.md), written for release review
(ROADMAP.md Phase 7). References are to files and tests that exist in the repository; where a module
was still being integrated when this was written it is marked **in progress** and its mitigations
are the ones the module's code establishes, not yet an end-to-end verified behaviour. The open items
at the end are the work that remains.

Status words: **verified** = an automated test exercises it in the loaded extension or in a unit
suite; **by design** = enforced by construction (manifest, CSP, types) and asserted by the build gate;
**in progress** = implemented in a library, not yet reached through the shipped UI; **accepted** =
a known exposure, disclosed to users (SECURITY_PRIVACY.md, PRIVACY_POLICY.md); **unit-only** = a
unit suite covers it and an end-to-end test is not possible or does not exist.

Revision of 2026-10-11 (drift review): statuses below were re-read against the code. "verified"
means a test exists and is wired into `ci.yml`; it does not mean a green run has executed it: on
that date every completed `ci.yml` run had concluded `failure` (see `docs/PRIVACY_CLAIMS.md`,
"Evidence caveat"). Release review should require a recorded green run for each row it relies on.

Revision of 2026-10-11 (second pass): the hardening changes that followed the security review
(backup and import, PDF reader privacy, redaction and purge, search index, database lifecycle and
sync; ADR-010 amendments 1 and 2) are recorded in rows C2.7, C4.1, C4.2, C4.6 to C4.10, C5.1 to
C5.9, C6.3, C6.5, C8.1, C8.3 and C8.6 to C8.10, in the residual risks R14 to R23 and in section 7.
Every row that depends on them is **unit-only**: the tests were written with the changes, were read
(not run) by this pass, and no CI run has executed them. Findings that remain open are in section 6
and in `docs/PRIVACY_CLAIMS.md` "Open items".

## 1. System and trust boundaries

```text
   +-------------------------- web page (untrusted) ---------------------------+
   | page scripts (main world)          CSS.highlights registry (shared)      |
   |        |                                     ^                           |
   |  TB1   |  DOM events, selection              | ranges painted            |
   |        v                                     |                           |
   |  <studyvault-overlay> (closed shadow root)   |                           |
   |  content script (isolated world) ------------+                           |
   +----------|--------------------------------------------------------------+
              | TB2  chrome.runtime.sendMessage  (typed, versioned, validated)
              v
   +-------------------- service worker (privileged, stateless) -------------+
   |  sender policy -> repo (Dexie/IndexedDB) -> chrome.storage                |
   |  site access: scripting.register/executeScript, permissions               |
   +----------^----------------------^------------------------^---------------+
              | TB3                  | TB6                    | TB4 (opt-in)
   +----------|----------+   +-------|--------+     +---------v---------------+
   | popup / side panel /|   | browser profile|     | AI provider (HTTPS)     |
   | options / PDF reader|   | on this device |     | sync server (HTTPS)     |
   +----------^----------+   +----------------+     +-------------------------+
              | TB5  files the user chooses: backups, imports, PDFs
```

| Boundary | Between | Why it is a boundary |
| --- | --- | --- |
| TB1 | page scripts and the content script / overlay | Same document. The page can observe DOM, events and the highlight registry and can forge events. |
| TB2 | content script and service worker | A content script holds page-influenced data. The worker holds all stored data and every privileged API. |
| TB3 | extension pages and the worker | Same origin and fully privileged, but they render untrusted stored text. |
| TB4 | the device and the network (AI provider, sync server and its sign-in provider; also the host of a PDF opened by address, which receives no study data) | The only places a request can leave; each starts from a user action and the first two are opt-in. The extension-pages CSP allows `connect-src https:`, so the CSP alone does not enforce this boundary (ADR-009). |
| TB5 | files and documents and the extension | Backups, imported Markdown, PDFs, OCR output and AI output are attacker-influenced input. |
| TB6 | the extension and the rest of the profile / OS | Other extensions, other OS users, malware with profile access. |

## 2. Assets

| ID | Asset | Property that matters |
| --- | --- | --- |
| A1 | Saved passages, notes, banks, tags, review history | Confidentiality, integrity, availability (no loss) |
| A2 | Source provenance (`exactQuote`, anchors, address, title, capture time) | Integrity: immutable once captured |
| A3 | What the user studies and where (sites, passages, deny list) | Confidentiality |
| A4 | User-supplied AI provider key | Confidentiality |
| A5 | Sync credentials, encryption passphrase and keys | Confidentiality, availability |
| A6 | Backup files | Confidentiality, integrity |
| A7 | Page integrity and usability while StudyVault runs | No breakage of selection, copy, navigation, forms |
| A8 | The extension package and the publisher account | Integrity (supply chain) |

## 3. Actors

| Actor | Capability assumed |
| --- | --- |
| Malicious or compromised website, and its third-party scripts | Runs JS in the main world of any page where StudyVault is active; controls text, DOM, CSS, iframes, URLs |
| Malicious content (text inside a page, PDF or import) | Crafted to manipulate parsers, anchors, Markdown rendering or an LLM |
| Other extension | Can message extensions, observe the shared DOM, read the same page |
| Network attacker | Can intercept traffic to the AI provider and sync server unless TLS holds |
| Malicious or breached sync server / AI provider | Reads or alters what it receives |
| Person or malware with access to the OS user profile | Reads or edits browser storage on disk |
| Supply-chain attacker | Compromises a dependency, a CI action or the store account |

Out of scope: a compromised browser or OS; a user who installs a malicious build of the extension.

## 4. STRIDE by component

### C1 - Page vs content script and overlay (TB1)

| ID | STRIDE | Threat | Mitigation | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| C1.1 | S | Page forges DOM events or `postMessage` to make StudyVault save, change or send data | Capture starts only from trusted user input handled in the isolated world; no `window.postMessage` is sent to or accepted from the page; worker re-checks every request | `tests/e2e/permissions.spec.ts` "forged DOM events and messages cannot capture, change data or open UI"; `tests/e2e/overlay.spec.ts` "no window message carrying the extension id is posted to the page" | verified |
| C1.2 | D | Page forges the "content script started" event, or removes the overlay host, to switch StudyVault off on that page | Only that page is affected; no data access; a reload restores it | `tests/e2e/permissions.spec.ts` "a forged \"content script started\" event cannot capture, reach the worker or read data, and a reload restores StudyVault" | verified, accepted |
| C1.3 | I | Page keylogs notes or bank names typed in the overlay (capture-phase listeners receive keys before any shadow root) | The overlay has no free-text control at all; typing happens in the side panel (ADR-005) | `tests/e2e/overlay.spec.ts` "overlay exposes no free-text surface to the page", "capture-phase page listeners see no text input from the overlay" | verified |
| C1.4 | I | Page enumerates the highlight registry and learns which passages are saved, with colour and kind | Deny-listed sites are never painted; "Show highlights on pages" off publishes nothing; the registry holds only ranges of text the page already contains | `tests/e2e/resilience.spec.ts` "a denied host gets no toolbar, no painting and a refused capture.save"; `tests/e2e/overlay.spec.ts` "\"Show highlights\" off publishes nothing but still saves" | accepted (R1) |
| C1.5 | I | Page detects that StudyVault is installed or running (host element, adopted stylesheet) | None possible at reasonable cost; no `web_accessible_resources`, so the extension id cannot be probed by URL | `scripts/check-build.mjs` (no `web_accessible_resources`, no `externally_connectable`) | by design, accepted (R2) |
| C1.6 | T | Page changes its text (or serves different text per visit) so a highlight binds to the wrong passage | Resolution is exact-then-context-then-fuzzy with explicit `ambiguous` / `orphaned` states that are never painted; fuzzy results may not bind to text another saved highlight matches | ADR-004; `packages/highlights/src/adversarial.test.ts`, `property.test.ts`, `resolve.test.ts`; `tests/e2e/lifecycle.spec.ts` "source mutated after save" | verified |
| C1.7 | T | Hostile CSS or z-index stacks hide, restyle or overlay the toolbar to trick a click | Shadow DOM isolation (`all: initial` on the host); position clamped into the viewport; the toolbar only saves, it never deletes without a visible Undo | `tests/e2e/compat.spec.ts` "hostile page CSS (matrix 7)" | verified |
| C1.8 | D | Huge or churning DOM makes the content script slow or loop | Streams are built only when a page has saved highlights or a selection; debounced single `MutationObserver`; bounded retries (1, 2, 4, 8, 16 s); worker calls time out at 12 s | ADR-004 "Dynamic pages"; `entrypoints/highlighter.content/retryBudget.ts`; `tests/e2e/lifecycle.spec.ts` "performance evidence" | verified |
| C1.9 | T/E | StudyVault corrupts a form, editor or the page's own handlers | No DOM is added to the page except the overlay host; fields and editors are never captured; selection, focus and scroll are left untouched | `tests/e2e/compat.spec.ts` "editable surfaces (matrix 4)", "non-interference" | verified |
| C1.10 | I | Selection text is readable by the page | It is the page's own text; the saved quote and notes are not exposed | ADR-005 | accepted (R4) |

### C2 - Messaging and the service worker (TB2)

| ID | STRIDE | Threat | Mitigation | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| C2.1 | S | Another extension or an unknown sender calls StudyVault's RPC | `serveRpc` answers `forbidden` unless `sender.id` is this extension; `externally_connectable` is absent | `packages/runtime/src/messaging.ts`; `packages/runtime/src/messaging.test.ts`; `scripts/check-build.mjs` | verified, by design |
| C2.2 | E | A content-script sender (page-influenced) calls extension-only RPC (`site.*`, `tab.activate`) or the full highlight API | Caller classification by `sender.tab` and `sender.url`; `extensionOnly()`; page callers limited to a short allow-list | `entrypoints/background/handlers.ts`; `entrypoints/background/handlers.test.ts`; `tests/e2e/permissions.spec.ts` "the worker enforces the sender policy against a content-script sender" | verified |
| C2.3 | T | A page reads or changes another site's highlights by naming a URL or a highlight id | Payload URLs must share the sender's origin; highlight ids are authorised by same-site ownership of their Source; unknown ids are `not_found` | `handlers.ts` (`ownLocation`, `ownsSource`, `authorize`); `tests/e2e/permissions.spec.ts` "Undo is authorised by same-site ownership" | verified |
| C2.4 | T | A page claims another canonical URL to merge its highlights into a trusted source | `trustedCanonical` accepts a canonical only when it names the page itself | `packages/shared/src/urls.ts`; `packages/shared/src/urls.test.ts`; `tests/e2e/gate10.spec.ts` "identity" | verified |
| C2.5 | T | Malformed, mis-versioned or oversized messages | `WireMessage` (v1) and per-type Zod payload schemas with length bounds; handlers return typed errors | `packages/shared/src/protocol.ts`; `tests/e2e/permissions.spec.ts` "malformed, mis-versioned and unknown messages are rejected or ignored without side effects" | verified |
| C2.6 | D | A handler or a call never answers; the worker is suspended mid-operation | 15 s handler budget and 20 s caller budget produce error replies; writes are single IndexedDB transactions; no state is held in memory between events | `packages/runtime/src/messaging.ts`; `tests/e2e/resilience.spec.ts` "service worker suspension", "stopping the worker at the instant of the Save click never loses or duplicates a save" | verified |
| C2.7 | E | Capture on a deny-listed site, or from a private window the user did not allow | Refused in the page, in the worker and, for persistent sites, by `excludeMatches` at registration. The worker decides from its own authoritative copy of the settings (`getTrustedSettings`, C8.6), so a value a content script planted in `chrome.storage.local` is ignored | `handlers.ts` (`capture.save`); `entrypoints/background/platform.ts`; `entrypoints/background/siteAccess.ts`; deny list: `tests/e2e/resilience.spec.ts` "a registered script on a denied host is excluded at registration"; private windows: `entrypoints/background/handlers.test.ts` "capture.save from private windows", `entrypoints/background/commands.test.ts` "private windows", `entrypoints/background/index.test.ts` "refuses a private-window capture at the worker until the user allows it" and "keeps a denied site denied when a content script empties the stored deny list" (the e2e test in `tests/e2e/overlay.spec.ts` "private windows" is `test.fixme`) | deny list: verified; private windows and planted settings: unit-only; e2e not drivable (Playwright cannot automate incognito extension contexts) |
| C2.8 | R | No record of which context made a change | Not provided: local data has no audit trail by design. Sync operations carry a client id and revision (see C9) | `packages/sync/src/schema.ts` | accepted |
| C2.9 | E | Over-broad site access at install | No `host_permissions`; optional `https://*/*` and `http://*/*` requested per site from a user gesture; built manifest asserted on every build | `wxt.config.ts`; `scripts/check-build.mjs`; `tests/e2e/permissions.spec.ts` "ships exactly the documented least-privilege manifest" | verified, by design |

### C3 - Extension pages: popup, side panel, options, reader (TB3)

| ID | STRIDE | Threat | Mitigation | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| C3.1 | T/E | Stored page text (quote, title, heading, note, bank name) is rendered as markup in a privileged page | React renders text nodes and a review of the shipped code found no `innerHTML`, `dangerouslySetInnerHTML` or `document.write` in it; the overlay's sources are scanned for them by a unit test; the extension-pages CSP is (working tree, 2026-10-11; the committed one had only `script-src`, `object-src 'self'`, `base-uri`, `connect-src`, `frame-src` and `form-action`) `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' https: http://localhost:* http://127.0.0.1:*; worker-src 'self'; media-src 'none'; manifest-src 'none'; object-src 'none'; base-uri 'self'; frame-src 'none'; form-action 'none'`, so injected inline script would not run | `wxt.config.ts`; `scripts/check-build.mjs`; `entrypoints/highlighter.content/ui/security.test.ts` (overlay only) | by design; nothing enforces it for extension pages yet (O1) |
| C3.2 | T | `javascript:` / `data:` URLs reach a link or a navigation | Stored addresses must be http(s) (`HttpUrl`); the reader accepts only https `?src=` addresses without credentials (plain http only for `localhost` and `127.0.0.1`) | `packages/shared/src/schema.ts`; `packages/pdf/src/readerUrl.ts`; `packages/pdf/src/source.test.ts` "reader address", "loopback http and PDF-looking addresses"; `tests/e2e/pdf.spec.ts` "addresses the reader refuses are explained and never fetched" | verified (unit); e2e spec exists, unproven in CI |
| C3.3 | I | Rendered Markdown (notes, imports) carries active content | `marked` output goes through DOMPurify with a tag and attribute allow-list and is attached as a node tree (no `innerHTML`); raw HTML is shown as text, images are not loaded, only http(s) links survive and open with `rel="noopener noreferrer"` | `packages/ui/src/vault/markdownRender.ts`, `Markdown.tsx`; `packages/ui/src/vault/markdownRender.test.ts` (37 hostile sources: script, `onerror`, SVG, iframe, `javascript:`, entity-encoded and tab-split schemes, `data:`, nested HTML in tables and headings, plus pathological input) | verified (unit, jsdom; O2 closed) |
| C3.4 | E | A web page loads an extension page or resource | No `web_accessible_resources`, so a web page cannot load, frame or navigate to an extension page or script | `scripts/check-build.mjs` | by design |
| C3.5 | T | Accidental destructive action | "Delete all StudyVault data" asks first, focus starts on Cancel; deletes are soft with Undo | `tests/e2e/pages.spec.ts` "options: delete all data" | verified |
| C3.6 | D | Surface crashes on a bad row | `ErrorBoundary` renders a recoverable message; rows are validated before use | `packages/ui/src/ErrorBoundary.tsx`; `packages/storage/src/rows.ts` | verified |

### C4 - Local storage (TB6)

| ID | STRIDE | Threat | Mitigation | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| C4.1 | T | Credentials or one-time tokens in page URLs persist in the database, backups or the side panel | `redactUrl` removes userinfo, query parameters and `;name=value` path parameters whose name matches `isCredentialName` (a heuristic on the name only: stems such as token, secret, session, signature, jwt; whole words such as key, sig, sid, auth, otp; a trailing `code`; the `x-amz-` and `x-goog-` families), credential parameters inside a `#/route`, a route that is really a credential blob, anything after a second `#` and every other non-route fragment, before storage and in source keys. A secret in a parameter with an unremarkable name is kept. The rule runs when an address is saved: stored rows are not rewritten, and restore and sync carry addresses as the device that made them stored them (R22) | `packages/shared/src/urls.ts`; `packages/shared/src/urls.test.ts` suite "credentials never become part of an address" (property tests included); `tests/e2e/lifecycle.spec.ts` "capture provenance" | unit-only for the rule as widened on 2026-10-11 (the e2e spec exists, unproven in CI); heuristic, accepted (R22) |
| C4.2 | T | Provenance is edited after capture | The update API accepts only `kind`, `color`, `userComment`, `priority` (`.strict()`); remote sync operations may not change immutable fields (`packages/sync/src/policy.ts`); a merge-mode restore may not change them either, from the same list (C5.5); an import never joins a captured Source (C5.9) | `packages/shared/src/protocol.ts` (`HighlightPatch`); `packages/sync/src/policy.ts`; `packages/storage/src/restoreGuards.ts`; `entrypoints/background/sync.integration.test.ts` "provenance is never overwritten: neither by a local rewrite nor by a forged remote operation" | verified (API); unit-only (sync, restore) |
| C4.3 | T | An older build rewrites data written by a newer one | Writes are refused while any row carries an unknown `schemaVersion`; reads still work | `packages/storage/src/db.ts` (`assertNoNewerRows`); `packages/storage/src/versions.test.ts` | verified |
| C4.4 | D | Quota exhausted or database unavailable | Mapped to `quota_exceeded` / `storage_unavailable` and shown with a retry | `packages/storage/src/db.ts` (`toStorageError`) | verified |
| C4.5 | D | Data loss on crash or restart | Atomic transactions; hard-kill and restart tests | `tests/e2e/resilience.spec.ts` "a hard-killed browser loses nothing that was already confirmed to the user", "a full browser restart on the same profile keeps data" | verified |
| C4.6 | I | Data remains after the user asks to delete it | `wipeAllData` deletes the `studyvault` database first and without a deadline (C4.10), then the pre-update copy `studyvault-premigration` and every restore staging database (`studyvault-restore-staging*`), `storage.local`, `storage.session` (tokens, an unlocked sync key) and every optional host grant, and leaves one random search-generation row in the new database (C4.8). Not removed: the sync server's copy, exported files, the extension page's `localStorage` display preferences, and the optional `identity` and `alarms` permissions (no fix in the tree; PRIVACY_CLAIMS P15) | `packages/storage/src/repo.ts`; `packages/storage/src/identity.test.ts` "wipeAllData"; `packages/storage/src/backupTarget.test.ts` "Delete all data also removes the pre-update copy and a crashed restore staging database"; `packages/storage/src/backupHardening.test.ts` "the sweep removes the fixed-name database of older builds and any leftover, nothing else"; `packages/storage/src/lifecycle.test.ts` suite "Delete all data while another window holds the database"; `tests/e2e/pages.spec.ts` "options: delete all data" | unit-only for database, storage, host grants and copies; gaps listed (open) |
| C4.7 | I | Another OS user, malware or backup software reads the profile directory | None at the extension level: IndexedDB and extension storage are not encrypted at rest by the extension | - | accepted (R7) |
| C4.8 | I | The search index resurrects deleted text (after a purge, a restore or Delete all data) | `meta.searchIndexStale` is a generation token that every host compares and nobody deletes (a restore writes a timestamp, Delete all a random id); a host rebuilds on a different generation, on a newer purge or on a failed checksum and drops a cache write whose generation is stale; unreadable rows are counted as rejected and never truncate the index | `packages/ui/src/vault/searchHost.ts`; `packages/storage/src/search.ts`; `packages/ui/src/vault/searchHost.test.ts`, `searchHost.vault.test.ts`; `packages/storage/src/search.test.ts` | unit-only; the persisted cache keeps purged text until a host rewrites it (R15) |
| C4.9 | D/I | A schema upgrade loses data, or the copy taken before it exhausts memory or is itself a leak | The pre-update copy hook is installed at import of `@storage` in every context and the worker opens the database on `update`; size is estimated from row counts and a 25-row sample per table before anything is read, cached PDF bytes are never read, a vault over 64 MB gets a "save a backup yourself" notice instead of a copy; the upgrade itself stays one transaction; the copy is removed by Delete all data | `packages/storage/src/backupTarget.ts`, `packages/storage/src/db.ts`; `packages/storage/src/lifecycle.test.ts` (two "pre-update copy" suites); `entrypoints/background/index.test.ts` | unit-only; the copy is an unencrypted full copy of the study data until deleted (R21) |
| C4.10 | D | "Delete all data" hangs, is abandoned half way, or leaves settings behind a deleted vault | The database delete is requested first and never abandoned (an IndexedDB delete cannot be withdrawn); `deleting` / `blocked` / `cleaning` are reported; database calls in the calling context fail at once with `WipePendingError`; the other stores are cleared only after the delete completed; a second call joins the first | `packages/storage/src/repo.ts`, `packages/storage/src/db.ts`; `packages/storage/src/lifecycle.test.ts` | unit-only; the Settings page shows the states with "Stop waiting" (`DeleteData.tsx`, `Options.test.tsx`; PRIVACY_CLAIMS P15b) and no e2e holds the database from a second window (MT-50); a frozen window delays the delete without bound (R20) |

### C5 - Backup, import and restore (TB5)

| ID | STRIDE | Threat | Mitigation | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| C5.1 | T | Malicious or corrupt backup damages existing data | Manifest and per-table checksums, Zod validation of every row, restore into a staging database of its own with a dry-run report, one atomic commit, merges that refuse to overwrite provenance (C5.5), a member-name guard on the parsed graph (C5.6), AI results re-grounded (C5.8), one restore at a time (C5.7) | `packages/backup/src/restore.ts`, `format.ts`, `merge.ts`; `packages/backup/src/roundtrip.test.ts`, `hardening.test.ts`; `packages/storage/src/backupHardening.test.ts` | verified (unit); checksums detect damage, not forgery (R18) |
| C5.2 | D | Archive bomb or huge import | The central directory is read by StudyVault's own reader before anything is decompressed: ZIP64 markers refused, entries capped at 50,000, the sum of declared sizes at 2 GiB, names at 1,024 bytes, duplicate names refused, a DEFLATE ratio above about 1100:1 refused; then archive 1 GiB, row 8 MiB, 5,000,000 rows, abort support. A forged ~130-byte ZIP64 record used to keep the generic reader walking billions of entries. Markdown import readers are linear on hostile lines | `packages/backup/src/format.ts` (`listZip`, `readZipEntry`, `DEFAULT_RESTORE_LIMITS`), `packages/backup/src/importExternal.ts`; `packages/backup/src/hardening.test.ts` "hostile ZIP directories are refused in milliseconds"; `packages/backup/src/importExternal.test.ts` "Markdown import is linear on hostile lines" | unit-only (timing bounds can flake on a loaded runner) |
| C5.3 | I | A backup file is read by someone else | Optional passphrase encryption (AES-256-GCM, PBKDF2-SHA-256); an unencrypted backup is documented as readable by anyone holding it | `packages/backup/src/crypto.ts`; PRIVACY_POLICY.md | verified (unit) |
| C5.4 | I | Secrets (provider key, sync tokens) end up in a backup | Backups walk the registered database tables only, minus `BACKUP_EXCLUDED_TABLES` (`meta`, which holds the AI key, and `syncOps`); a forged archive cannot restore into `meta`. Sync tokens are in `chrome.storage.session`, outside any table. A planted-key test greps the produced archives (zip and JSON) | `packages/storage/src/backupTarget.ts`; `packages/storage/src/ai.test.ts` "never contains the key, keeps AI drafts and their review state, and restores cleanly"; `packages/storage/src/backupTarget.test.ts` "keeps secrets out of the archive and out of reach of a forged one", "never exposes meta or syncOps to a backup"; `packages/storage/src/sync.policy.test.ts` (`meta` is not synced) | verified (unit; O4 closed for the AI key; no test greps for sync tokens, which are in no table) |
| C5.5 | T/E | A forged archive restored in merge mode rewrites the provenance of a row the vault has (capturedUrl, source address, quote, capture time ...) | The fields a merge may not change are the sync policy's `immutable` list per table plus every field of an append-only table, supplied by the storage target; on a difference the live row is kept whole and a conflict is reported | `packages/storage/src/restoreGuards.ts` (`immutableFieldsOf`), `packages/backup/src/merge.ts`; `packages/storage/src/backupHardening.test.ts`; `packages/backup/src/hardening.test.ts` | unit-only; a replace, and rows new to the vault, take the archive as given (R18) |
| C5.6 | T | A member such as `__proto__` or `constructor.prototype` in restored JSON pollutes prototypes or smuggles state past validation | The parsed graph is walked for forbidden member names however a JSON escape spelled them; the row is invalid (`forbidden_key`) and only a row that passed every check is staged; a field merely named `constructor` is data | `packages/backup/src/restore.ts`; `packages/backup/src/hardening.test.ts` suite "forbidden member names" | unit-only |
| C5.7 | T/D | Two restores interleave their staging and commits, or a crashed restore leaves a full copy of the vault behind | A Web Lock across extension pages plus an in-memory flag (`restore_in_progress`); each restore stages into `studyvault-restore-staging-<uuid>`, released on success and on failure; the next restore and Delete all sweep the prefix | `packages/storage/src/backupTarget.ts`; `packages/storage/src/backupHardening.test.ts` | unit-only |
| C5.8 | T | A restored AI result carries `source_supported` or citations for text the vault does not hold | Each result is re-checked with the pipeline's grounding rule against the passages the vault will hold; labels are only ever demoted; the report counts them | `packages/storage/src/restoreGuards.ts` (`aiCitationGuard`); `packages/storage/src/backupHardening.test.ts` "AI results are re-grounded on restore"; `packages/backup/src/hardening.test.ts` "citation guard" | unit-only |
| C5.9 | T | An imported Markdown or CSV file attaches its text to a page the user really captured, so it reads as captured there | Every import creates Sources of its own (`urlKey` `imported:<batch>:<n>`), the file's address is shown as a claim, `captureMethod: 'import'`, needs review | `packages/storage/src/backupTarget.ts` (`importExternalHighlights`); `packages/storage/src/backupHardening.test.ts` "imported highlights never join a Source that a capture made" | unit-only |

### C6 - PDF reader and OCR (TB5)

| ID | STRIDE | Threat | Mitigation | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| C6.1 | T/E | A crafted PDF exploits the parser or runs script | pdf.js runs in its bundled worker; the legacy build is used; no remote worker or data; the file is size-capped (300 MiB) | `packages/pdf/src/engine.ts`, `source.ts`, `assets.ts`; docs/adr/006 (`enableXfa: false`, scripting never enabled, no `eval(` or `new Function` in the legacy build and worker by grep) | in progress (O7: no hostile-PDF test yet) |
| C6.2 | I | Fetching a web PDF leaks the user's cookies or bypasses a sign-in | Fetch from the extension page with `credentials: 'omit'`; a sign-in wall is reported, never bypassed | `packages/pdf/src/source.ts`; `packages/pdf/src/source.test.ts` "sends no cookies and no referrer", "a redirect to an HTML page is called out as a probable sign-in page"; `tests/e2e/pdf.spec.ts` "opens a PDF from an address: no cookies, no referrer, no CSP error; the content type decides" | verified (unit); e2e spec exists, unproven in CI |
| C6.3 | S | A crafted reader link makes the extension fetch an attacker's URL, or fetch from a site the user did not allow | Only https addresses without credentials are accepted (plain http only for `localhost` and `127.0.0.1`); no cookies and no referrer are sent; the attacker learns the user's IP address and that the address was opened. The tab is opened by the user (context menu, popup, side panel), because a web page cannot navigate to an extension page. A redirect is followed by the browser (hops are not observable from `fetch`), so the address the transfer ended at is held to the same rules and its body is read only for the origin asked for or one the user allowed (`redirect-needs-access`); the access the click requested is handed back when the transfer ends unless the user already had it (`packages/pdf/src/grant.ts`) | `packages/pdf/src/readerUrl.ts`; `packages/pdf/src/source.ts`; `entrypoints/pdf-reader/Reader.tsx`; `packages/pdf/src/source.test.ts` suite "fetchPdf: where a redirect may end"; `packages/pdf/src/grant.test.ts`; `entrypoints/pdf-reader/Reader.test.tsx` "Reader: site access for one fetch is handed back" | unit-only; accepted: the other site may have received the request (R19) |
| C6.4 | I | OCR sends page images to a service | OCR is local WebAssembly (tesseract.js with bundled language data); no network | `packages/ocr`; `tests/e2e/pdf.spec.ts` "OCR recognises a scanned page on this device; the text is selectable, anchored, correctable and persists"; ADR-006, ADR-008 | verified (unit); e2e spec exists, unproven in CI |
| C6.5 | I | A PDF opened in a private window is stored in the profile's shared database (document row, highlights, OCR text, kept copy) | The reader asks the window (`tabs`/`windows.getCurrent`, plus `?incognito=1` from the menu) and treats "unknown" as private; `setPdfWriteRestriction` makes the storage write path refuse every PDF write unless `allowIncognitoCapture`, read at the moment of the write; a failing check refuses; reading, deleting and editing what exists stays possible | `entrypoints/pdf-reader/privacy.ts`, `main.tsx`; `packages/storage/src/pdf.ts` (`assertPdfWriteAllowed`); `entrypoints/pdf-reader/privacy.test.ts`; `packages/storage/src/pdf.private.test.ts`; `entrypoints/pdf-reader/Reader.test.tsx`; `tests/e2e/pdf.spec.ts` "private windows" | unit-only; a real private window is not drivable (e2e uses the hint); the extension must be allowed in Incognito for any of this to run |

### C7 - AI provider channel (TB4, opt-in)

| ID | STRIDE | Threat | Mitigation | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| C7.1 | I | More leaves the device than the user approved | One `prepare()` builds both the preview and the request; consent is bound to a hash of the outbound text; limits on chunks and tokens; feature flag off by default | `packages/ai/src/prepare.ts`, `pipeline.ts`, `constants.ts`; `packages/ai/src/pipeline.test.ts`; UI: `packages/ui/src/ai/ConsentPreviewDialog.tsx`, `AiSettingsSection.tsx` with `packages/ui/src/ai/__tests__/ai-ui.test.tsx`; `tests/e2e/surfaces.spec.ts` "AI and sync show their consent explanation first and make no request until enabled" | verified (unit); UI exists; e2e spec exists, unproven in CI |
| C7.2 | I | Personal data or secrets are sent | Deterministic redaction of emails, numbers and secret-shaped strings with a user-editable preview; heuristic, so disclosed | `packages/ai/src/redact.ts`, `secrets.ts`; `packages/ai/src/redact.test.ts` | verified (unit), accepted (R11) |
| C7.3 | T | Prompt injection in saved text redirects the model, asks for keys or tools | Captured text appears only inside delimited data blocks in the user message, never in the system message; no tools; strict JSON output validated by Zod; citations must exist verbatim in the cited source; results are stored separately as `unverified` and need user acceptance | `packages/ai/src/prompt.ts`, `grounding.ts`, `schema.ts`; `packages/ai/src/tasks.test.ts` | verified (unit) |
| C7.4 | I | The API key leaks through logs, errors, redirects or referrers | Key lives only in the request closure; errors and logs are scrubbed; HTTPS only (loopback excepted); redirects are errors; `credentials: 'omit'`; `referrerPolicy: 'no-referrer'` | `packages/ai/src/providers.ts`, `secrets.ts`; `packages/ai/src/providers.test.ts`, `packages/ai/src/security.test.ts` "secrets never travel anywhere but the provider call" | verified (unit) |
| C7.5 | T | Provider output is trusted as fact | Labelled unverified, with a clinical notice where relevant; "externally verified" is never produced | `packages/ai/src/constants.ts` | verified (unit) |
| C7.6 | D | Runaway spend or hanging requests | Timeouts, retry caps, per-task output caps, estimated-token refusal | `packages/ai/src/budget.ts`, `constants.ts` | verified (unit) |

### C8 - Sync channel and server (TB4, opt-in)

| ID | STRIDE | Threat | Mitigation | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| C8.1 | S | Stolen session or token, or a token sent to a server it was not issued for | Short-lived tokens, sign-out clears credentials, PKCE for sign-in; tokens are bound to the (server, issuer, client id) they were issued for and a mismatching set is forgotten and never sent; configuration is read from IndexedDB, not from content-script-writable storage (C8.6) | `packages/sync/src/auth.ts`; `entrypoints/background/sync.ts` (tokens in `chrome.storage.session`, `tokensFor`, cleared on sign-out and when sync is turned off); `entrypoints/background/sync.test.ts` "asks for the missing origins first, then completes the PKCE flow and keeps tokens in the session store only", "sign-out clears the tokens, asks the provider to revoke, and keeps local data by default", "tokens belong to one configuration"; `server/src/auth.test.ts` | unit-only; real provider sign-in not verified (O5) |
| C8.2 | T | Server or network attacker alters operations | TLS; AES-256-GCM authenticated envelopes when end-to-end encryption is on; idempotency keys; per-op validation; remote operations cannot change immutable fields | `packages/sync/src/schema.ts`, `merge.ts`, `policy.ts` | in progress |
| C8.3 | I | Server reads content or learns usage | End-to-end encryption option (operator cannot read payloads); nothing is uploaded until the user chooses a passphrase or explicitly chooses to upload without encryption (C8.10); entity type, ids and timestamps remain visible and are disclosed; server-accessible encryption is never called end-to-end | `packages/sync/src/schema.ts`, `crypto.ts`; `packages/sync/src/e2ee.engine.test.ts`; `entrypoints/background/sync.integration.test.ts` "existing history is re-encrypted, the server never sees plaintext, another device needs the passphrase"; SECURITY_PRIVACY.md | unit-only (O5); metadata visible by design |
| C8.4 | T | Concurrent edits silently lose data | Hybrid-logical-clock merge; text conflicts kept as `ConflictRecord`; remove-wins sets | `packages/sync/src/merge.ts`, `hlc.ts` | in progress |
| C8.5 | I | Deleted data survives on the server | Tombstones; a "Delete my data from the server" control (`DELETE /v1/data` on the reference server); the operator's own deletion process is still the owner's to document | `packages/ui/src/sync/SyncSection.tsx`, `server/README.md`, PRIVACY_POLICY.md | in progress (O5); operator process: `[USER-REQUIRED]` in the policy |
| C8.6 | E | A compromised content script (it runs next to page script and can write `chrome.storage.local`) redirects tokens and vault operations by writing `syncConfig`, or loosens the deny list, private-window flag or feature flags the worker re-checks | Privileged configuration lives in IndexedDB `meta` (`sync.config`, `sync.encryption`, `settings.trusted`); `getTrustedSettings()` adopts the old copy once and ignores later direct writes; `updateSettings` corrects a planted value; a legacy `syncConfig` is migrated once and only when Chrome already holds the person's grant for both origins; `storage.session` is closed to content scripts explicitly | ADR-010 amendment 1 sections 1 to 3; `packages/runtime/src/settings.ts`; `packages/storage/src/syncPrivate.ts`; `packages/storage/src/syncPrivate.test.ts`; `entrypoints/background/sync.test.ts` "where the configuration comes from"; `entrypoints/background/index.test.ts` | unit-only; residual: display copy and two extension-side gates still read `storage.local` (R17) |
| C8.7 | T/I | End-to-end encryption laundering: setup or rotation re-encrypts whatever plaintext the server returned, making server-injected operations authentic | Setup audits the log under the sync policy and re-sends this device's own state; rotation re-encrypts only what authenticates under the old key and replaces the rest with an envelope no key opens; the count is shown | ADR-010 amendment 1 section 5; `packages/sync/src/engine.ts`, `crypto.ts`; `packages/sync/src/rekey.test.ts`; `entrypoints/background/sync.integration.test.ts` "re-keying never blesses what the server planted" | unit-only; residual R16 |
| C8.8 | I/D | The E2EE key is lost when the worker is suspended (a false "unlocked for N minutes"), or kept longer than promised | The key is exported as a JWK to `storage.session` with an absolute 15-minute expiry (never extended), re-imported non-extractable on every run, dropped by an in-worker timer and the `sv-sync-lock` alarm, by Lock now, sign-out, disable, a changed server/provider, server deletion, a restore that replaced the sync identity and Delete all | ADR-010 amendment 1 section 6; `entrypoints/background/sync.ts`; `entrypoints/background/sync.test.ts` "the unlocked key"; `entrypoints/background/sync.integration.test.ts` "the key and the worker" | unit-only; Chrome's `storage.session` behaviour unverified; any extension page can read the key while it is held (R23) |
| C8.9 | T | A server that stops presenting the key profile (or presents an older or other one) downgrades a device to plaintext | `sync.encryption.profile` marker; a run that sees none, an older version or another kid at the same version stores a warning and refuses to pull or push; turning encryption on again is refused until the person deletes the server's data | ADR-010 amendment 1 section 7; `entrypoints/background/sync.test.ts` "a server that stops showing the encryption key"; `entrypoints/background/sync.integration.test.ts` "downgrade protection" | unit-only |
| C8.10 | I | The first upload after sign-in is plaintext before the person has chosen | A run with no stored decision and no key profile is pull-only (`push: false`) from the sign-in run, the timer and "Sync now"; the choice is a passphrase or "Upload without end-to-end encryption" with an acknowledgement; forgotten when the server, provider or client id changes | ADR-010 amendment 1 section 4; `entrypoints/background/sync.ts`; `entrypoints/background/sync.test.ts` "the first upload"; `entrypoints/background/sync.integration.test.ts` "the first upload waits for an explicit choice" | unit-only |

### C9 - Build, dependencies and release (supply chain)

| ID | STRIDE | Threat | Mitigation | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| C9.1 | T | Malicious or vulnerable dependency | Exact pins and lockfile with `--frozen-lockfile`; install scripts denied unless listed; minimum release age; licence allow-list; production-closure SBOM; advisory `pnpm audit` | `package.json`, `pnpm-workspace.yaml`, `scripts/license-report.mjs`, `scripts/sbom.mjs`, `.github/workflows/ci.yml` (job `audit`) | by design; audit advisory (O9) |
| C9.2 | T | Remote or obfuscated code ships | CSP `script-src 'self'`, no remote tags in extension pages, no source maps, size budgets, all asserted on every build | `scripts/check-build.mjs` | by design |
| C9.3 | T | Build is not what the source says | Second build from a clean export at a different path is compared hash by hash | `.github/workflows/reproducible-build.yml`, `scripts/repro-compare.mjs` | by design |
| C9.4 | T | CI tampering or secret theft | No secrets exist in the repository or workflows; `contents: read` by default; third-party actions limited to `actions/*` and `pnpm/action-setup` pinned to major tags; only the draft-release job has `contents: write` | `.github/workflows/*.yml` | by design (O10) |
| C9.5 | S/T | Store account takeover or a counterfeit listing | Out of the repository's control: 2-step verification on the developer account, publisher verification | RELEASE.md "What you must do by hand" | user dependency |
| C9.6 | I | Docs claim more than the code does | Permission lists in the policy and listing are checked against the built manifest | `scripts/check-release-docs.mjs`, `docs/PRIVACY_CLAIMS.md` | by design |

## 5. Residual risks (accepted and disclosed)

| ID | Risk | Why it remains | User-visible mitigation |
| --- | --- | --- | --- |
| R1 | A third-party script on a site where StudyVault paints can read the highlight registry: which passages are saved, their position, colour and kind (`sv-hl-<colour>-<kind>`) | `CSS.highlights` is document-level and shared with the main world; painting through overlay rectangles would break selection, scrolling and reflow (ADR-004) | Starter deny list, user-editable; "Show highlights on pages" off; disclosed in Settings > Privacy |
| R2 | A page can tell StudyVault is running (host element, adopted stylesheet) and can forge or suppress the start signal to switch StudyVault off on that page | Any in-page UI is observable | None needed: no data is reachable (C1.2, C1.5) |
| R3 | `isolateEvents` and a closed shadow root do not hide events from page listeners | Page listeners on `window` run first; a closed root hides only the event target | Free text is never entered in the page (C1.3) |
| R4 | The page sees what the user selects and which toolbar button was clicked indirectly through the registry | Selection is page text | None |
| R5 | The starter deny list is incomplete | Banks, portals and employer sign-in pages differ by country and organisation | Stated next to the list; users add their own |
| R6 | Private-window capture, when the user enables it, lands in the shared database | One database per profile | Off by default; explained at the switch |
| R7 | Someone with access to the profile directory can read or modify local data | The extension cannot encrypt browser storage at rest | Passphrase-encrypted backups and E2EE sync protect copies, not the live profile |
| R8 | A provider key stored in the extension's IndexedDB (`meta`, not `chrome.storage`; no extra encryption) is readable by local malware | Same as R7 | Documented in Settings and the policy; use a spending-limited key |
| R9 | Heuristic redaction can miss personal data in AI previews | Detection is pattern-based | The user reviews and edits the preview before anything is sent |
| R10 | Providers and sync operators handle data under their own policies | Outside the extension | Disclosed in the policy; both features opt-in |
| R11 | Vulnerabilities in pdf.js, tesseract.js, DOMPurify or React | Third-party code | Exact pins, advisory audit, SBOM; update cadence is an open item (O9) |
| R12 | A passage may be reported `ambiguous` or `orphaned` instead of highlighted | Correctness over coverage (ADR-004) | Listed under "Needs attention" in the side panel |
| R13 | `sidePanel.open` needs a user gesture, so "Save and add a note" can fail after a slow save | Chrome's gesture window | The overlay says so and the hand-over still works when the panel is opened by hand within 30 s |
| R14 | A purge does not reach everything: the server's copy (a content-free tombstone is sent), an unsent edit of an already-delivered entity (sent once before its tombstone), an outbox row attempted but not acknowledged, `syncEntityMeta` (clocks, truncated field hashes, tag alias names) until a sync run prunes it 90 days on, and backups and the pre-update copy | Rewriting a delivered operation would break the causal context other devices need; the server is not under the extension's control | The policy lists each; "Delete my data from the server" is a separate control |
| R15 | The persisted search-index cache (`meta.searchIndex`) keeps the text of purged items until a search host has rebuilt and written it | The index is a cache owned by the page that hosts search; the purge cannot rewrite it from the worker | Rebuild starts as soon as a host sees the purge marker; Delete all removes the cache with the database; stated in the policy |
| R16 | A plaintext log authenticates nobody: when E2EE is set up after a plaintext upload, a well-formed, policy-valid edit that the server attributed to another device is kept and then encrypted (protected fields cannot be rewritten that way) | There is nothing to authenticate it against | Choosing a passphrase before the first upload (the default path now) avoids it; the card and policy say so |
| R17 | The page-side painter, popup and side panel still render from the `chrome.storage.local` copy of settings, and the capture gate in `@storage/sync.ts` and the PDF write restriction read it too | A content script legitimately needs it (painting, `dataEpoch`); `setAccessLevel` on `storage.local` would break that | A planted flag can only change what is displayed, what extension contexts queue in the local outbox (nothing is sent: the worker enforces the authoritative flag) or what the reader page persists; no content script can trigger the last |
| R18 | A backup is not signed: checksums detect damage, not forgery. A crafted archive can introduce a row with any provenance (replace, or rows new to the vault in a merge) | There is no key the extension could hold that would not also be in the file | Merge never changes existing provenance (C5.5); the policy says to restore only files you made or trust; restored AI results are demoted (C5.8) |
| R19 | A cross-origin redirect is followed by the browser, so the other site may receive the request (IP address, redirected address, no cookies, no referrer); only its answer is withheld | `fetch` does not expose redirect hops and a manual redirect is opaque | The policy says so; the reader asks before reading from the new site (the reader screen no longer says "never contacts", but it does not say that the site may already have received the request, PRIVACY_CLAIMS U-14) |
| R20 | A StudyVault window that never answers `versionchange` delays "Delete all data" without bound; reads in the calling context fail until it completes | An IndexedDB delete cannot be withdrawn once requested, and abandoning it would leave stores behind a later delete | `WipePendingError` explains and says to close the other windows; the wipe finishes by itself; the Settings page shows `deleting`, `blocked` and `cleaning` with "Stop waiting" and "Check again" (PRIVACY_CLAIMS P15b) |
| R21 | The pre-update copy is an unencrypted full copy of the study data (cached PDFs excluded) until the user deletes it or Delete all data runs; a vault over 64 MB gets no copy, and the size estimate comes from a sample | A restorable copy is the second safety net behind the transactional upgrade | Settings lists it and can delete it; the "no copy was kept" notice tells the person to save a backup |
| R22 | The URL redaction rule is a name heuristic applied when an address is saved: a secret in an unremarkably named parameter is kept, rows stored earlier are not rewritten, and a restore or an arriving sync item keeps the address as its origin stored it | Names are all there is to judge; rewriting history would change source keys | Disclosed in the policy; the user can delete the highlight and purge it |
| R23 | While the sync key is unlocked (15 minutes) it sits in `storage.session` as a JWK that every extension page and the worker can read; a script injected into an extension page could take it | Background sync across worker suspension needs the key to outlive the worker | Extension pages carry no remote script (CSP, C3.1); the expiry is absolute; Lock now and sign-out drop it |

## 6. Open items

| ID | Item | Owner | Blocks release? |
| --- | --- | --- | --- |
| O1 | Add an ESLint rule that bans `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `dangerouslySetInnerHTML` and `document.write` in product code (today only `eval` and `new Function` are banned) | shared ESLint config | no, but should land with Phase 2 |
| O2 | A test that renders hostile Markdown (script, `onerror`, `javascript:` links, SVG, nested HTML) through the notes renderer and asserts nothing active survives | notes / vault | yes, if Markdown rendering ships |
| O3 | Record every CSP or permission change the PDF, OCR, AI and sync work needs (`connect-src`, `wasm-unsafe-eval`, optional hosts, optional `identity` and `alarms`) in an ADR; `scripts/check-build.mjs` and the listing must change in the same commit. Recorded in ADR-006, 008, 009 and 010. The committed gate pinned the CSP tokens and optional hosts but not `optional_permissions`; the working tree pins `alarms,identity` and the whole CSP table, not yet run in CI | pdf / ocr / ai / sync | until a CI run passes the new pin |
| O4 | Prove the AI key and sync credentials are excluded from backups, exports, sync and logs. Done for the AI key (planted-key tests in `packages/storage/src/ai.test.ts` and `backupTarget.test.ts`, `sync.policy.test.ts`, `packages/ai/src/security.test.ts`); sync tokens and the unlocked key live in `chrome.storage.session`, in no table, with no grep test | ai / backup | closed for the AI key |
| O5 | Sync: the sign-in flow (PKCE, state, token storage and binding), tenant isolation and rate limits, the first-upload gate, key custody, re-keying and downgrade protection are implemented and unit or integration tested against the reference server. Open: no run in a loaded Chrome (storage.session across suspension, alarms, a woken worker), no real OIDC provider, the operator's deletion process, and a threat model for a production server. Key recovery is impossible by design | sync | yes, if sync ships |
| O6 | Extend the offline e2e test ("no request leaves loopback or the extension") to the new surfaces with AI and sync off: reader, review, import, export | e2e owners | yes |
| O7 | `isEvalSupported` does not exist in pdf.js 6.4.299 (ADR-006), so it cannot be set; `engine.ts` passes `enableXfa: false` and scripting is never enabled. Still open: a test with a PDF that contains JavaScript and an embedded file | pdf | no |
| O8 | Manual screen-reader pass (NVDA, VoiceOver), Edge pass and forced-colors review: `docs/MANUAL_TEST_CHECKLIST.md` | release owner | yes for the first public release |
| O9 | Automated dependency updates: `.github/dependabot.yml` added (weekly, grouped; unverified until it opens a PR). Still open: a policy for fixing `pnpm audit` findings; today the audit job is advisory | release owner | no |
| O10 | Build provenance attestation for the release zip (needs an attestation action pinned at release time) | release owner | no |
| O11 | A vulnerability disclosure channel: `SECURITY.md` exists; its contact is a `[USER-REQUIRED]` marker that the docs gate does not scan | publisher | yes for the first public release |
| O12 | A repository `LICENSE` file; the repository is public and currently grants no licence | publisher | decision needed |
| O13 | Privacy policy hosting URL, support contact and legal review | publisher | yes |
| O14 | Run the hardening changes (sections 7 and the unit-only rows above) in CI and in a loaded Chrome: the e2e specs `tests/e2e/pdf.spec.ts` "private windows" and the redirect test, the restore-twice and blocked-Delete-all manual rows (docs/MANUAL_TEST_CHECKLIST.md MT-50, MT-51) | e2e owners / release owner | yes |

## 7. Reviewed findings and accepted limitations (second pass, 2026-10-11)

Source: the security review and the claims audit that preceded the hardening changes. The review's
own finding numbers are not kept in the repository, so the findings are named here and numbered
SR-1 and on for reference (they are unrelated to the component ids C1 to C9 above). "Mitigated
(unit-only)" means the code change and its tests are in the working tree, the tests were read but
not run by this pass, and no CI run has executed them. Nothing here was exercised in a loaded
Chrome.

### 7.1 Findings of the review

| ID | Finding | Status | Mitigation (where) | Residual risk |
| --- | --- | --- | --- | --- |
| SR-1 | Provenance overwrite via merge restore: a forged archive restored in merge mode could repoint a citation (`capturedUrl`, source `urlKey` / `originalUrl` / `host`, quote, capture time) because the engine used its own, shorter field list | mitigated (unit-only) | `packages/storage/src/restoreGuards.ts` (`immutableFieldsOf`: the sync policy's immutable list, `*` for append-only tables) handed to `packages/backup/src/merge.ts` through `RestoreTarget.immutableFields`; C5.5 | R18: a replace and rows new to the vault are taken as given; a backup is unsigned |
| SR-2 | ZIP64 / entry-count archive bomb: a forged file of about 130 bytes kept the generic ZIP reader walking billions of entries | mitigated (unit-only) | `packages/backup/src/format.ts` (`listZip`, `readZipEntry`, `DEFAULT_RESTORE_LIMITS`): the central directory is checked before anything is read or allocated; C5.2 | none known beyond the limits; the timing tests can flake on a loaded runner |
| SR-3 | Privileged configuration in content-script-writable storage: server URL, issuer, client id, deny list, private-window flag and feature flags in `chrome.storage.local` | mitigated (unit-only) | ADR-010 amendment 1 sections 1 to 3; `packages/runtime/src/settings.ts` (`getTrustedSettings`), `packages/storage/src/syncPrivate.ts`; C8.6 | R17: the display copy and two extension-side gates still read `storage.local` |
| SR-4 | E2EE laundering: setup and rotation re-encrypted whatever plaintext the server returned, making server-injected operations authentic | mitigated (unit-only) | ADR-010 amendment 1 section 5; `packages/sync/src/engine.ts` (`auditHistory`, `buildRotation`), `crypto.ts`; C8.7 | R16: a policy-valid edit attributed to another device in a plaintext log is kept; re-sent snapshots can beat a concurrent unsent edit |
| SR-5 | The first upload after sign-in was plaintext unless the account already had a key profile | mitigated (unit-only) | amendment 1 section 4; `entrypoints/background/sync.ts` (`runSync` is pull-only until a decision); C8.10 | the explicit plaintext choice, which is disclosed |
| SR-6 | The E2EE key lived only in the worker's memory, so "unlocked for about 15 minutes" was false once Chrome suspended the worker | mitigated (unit-only) | amendment 1 section 6; `createSessionKeyVault`, `ALARM_LOCK`; C8.8 | R23; Chrome's `storage.session` behaviour unverified |
| SR-7 | A server that stopped presenting the key profile could downgrade a device to plaintext | mitigated (unit-only) | amendment 1 section 7; `downgradeWarning`; C8.9 | recovery needs the person to delete the server's data |
| SR-8 | The consent text did not list what the policy uploads, and the AI-after-decryption warning was missing from the encryption card | mitigated (unit-only) | `packages/ui/src/sync/consent.ts` (generated from the policy); `AI_AFTER_DECRYPTION_NOTE` | none |

### 7.2 Lower-severity findings fixed in the same pass

| ID | Finding | Mitigation (where) | Status |
| --- | --- | --- | --- |
| SR-L1 | Prototype pollution through member names in a restored JSON graph | `packages/backup/src/restore.ts` forbidden-key walk; C5.6 | mitigated (unit-only) |
| SR-L2 | An import could attach text to a Source that a capture made | `importExternalHighlights`; C5.9 | mitigated (unit-only) |
| SR-L3 | Concurrent restores interleaved; a fixed-name staging database left a full copy behind | `withRestoreLock`, per-restore staging names, prefix sweep; C5.7 | mitigated (unit-only) |
| SR-L4 | A restored AI result could carry `source_supported` or citations for text the vault does not hold | `aiCitationGuard`; C5.8 | mitigated (unit-only) |
| SR-L5 | Quadratic Markdown import readers (heading and link patterns) | linear hand-written readers in `packages/backup/src/importExternal.ts` | mitigated (unit-only, timing bounds) |
| SR-L6 | The PDF reader stored documents, highlights, OCR text and kept copies from private windows (the old guard was always false) | `entrypoints/pdf-reader/privacy.ts`, `packages/storage/src/pdf.ts`; C6.5 | mitigated (unit-only; a real incognito window is not drivable) |
| SR-L7 | A host grant requested for one fetch stayed; a cross-origin redirect was read without the person's allowance | `packages/pdf/src/grant.ts`, `packages/pdf/src/source.ts`; C6.3 | mitigated (unit-only); R19 |
| SR-L8 | A purge left text in AI results that used the item as a later input, in sync conflict, quarantine and outbox rows, and as evidence in knowledge points | `packages/storage/src/trash.ts`; PRIVACY_CLAIMS P16 | mitigated (unit-only); R14 |
| SR-L9 | "Delete all" could abandon a queued delete after clearing settings and the copies; reads hung behind it; an open search index could write deleted text into the new database | `packages/storage/src/repo.ts`, `db.ts`, `packages/ui/src/vault/searchHost.ts`; C4.8, C4.10 | mitigated (unit-only); R20 |
| SR-L10 | Credential-bearing route fragments, `;name=value` path parameters and names ending in `code` were stored | `packages/shared/src/urls.ts`; C4.1 | mitigated (unit-only); R22 |
| SR-L11 | The pre-update copy depended on which context opened the database first, and its size was not estimated before everything was read | `installPreMigrationSnapshot` at import, the worker opens the database on `update`, sampled estimate; C4.9 | mitigated (unit-only); R21 |
| SR-L12 | Integrity: `undoLastReview` could undo another answer when two logs shared a review time; `moveCards` could leave live cards in a deleted deck; `mergeBanks` left decks pointing at a deleted bank; sync reconcile decided from rows read before its transaction | `packages/storage/src/study.ts`, `hierarchy.ts`, `sync.ts`; tests "undoes the answer the card is in, even when two logs share a review time (clock set back)", "a deck deleted while cards are being moved never ends up holding live cards", "merging banks re-points the decks of the merged bank, so a later purge orphans nothing", "a live edit made while the sweep runs is recorded as it is now, not as the sweep first read it", "a row that is physically deleted while the sweep runs is not sent as a create" | mitigated (unit-only) |

### 7.3 Accepted limitations by change

- **PDF reader privacy (S2):** R19 (the other site of a redirect may receive the request); a real
  private window is not drivable by Playwright, so the e2e specs use the `?incognito=1` hint; a window
  that cannot be determined is treated as private, so a normal window whose two window APIs both fail
  saves nothing until the person turns the setting on; handing back is best effort and the grant
  stays when Chrome refuses; editing and deleting what is already stored is allowed in a private
  window by design.
- **Redaction and purge (S3):** R14 (purge limits) and R22 (the name heuristic is not retroactive and
  is not re-applied by restore or sync).
- **Search index (S5):** R15; `meta.searchIndexStale` is never deleted and a wipe leaves one opaque
  token row in an otherwise empty database; rows the feed cannot read are not searchable (they are
  counted and shown as rejected).
- **Database lifecycle (S6):** R20 (a window that never releases the database delays Delete all
  without bound) and R21 (an unencrypted pre-update copy, none above 64 MB, size estimated from a
  sample); the Settings page shows the wipe states with "Stop waiting" (`DeleteData.tsx`;
  PRIVACY_CLAIMS P15b).
- **Sync (S7):** R16, R17 and R23; the key is dropped at the 15-minute expiry whether or not sync is
  in use and key recovery is impossible by design; a re-key is a one-time moment of trust in the
  plaintext history; only the reference server is covered; no real OIDC provider and no loaded
  Chrome have been used (O5, O14).
