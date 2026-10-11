# Changelog

All notable changes to StudyVault AI are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/) (`RELEASE.md`, "Versioning"). The per-release template in
`RELEASE.md` ("Changelog template") adds Permissions, Data and schema, and Verification sections;
copy it when a version is tagged.

## [Unreleased]

Nothing has been released or submitted to a store. `package.json` is at 0.1.0. The entries below say
what exists in the repository, not what has been proven. The first fully green `ci.yml` run is
<https://github.com/jerryboganda/studyvaultai/actions/runs/38139836238> (2026-10-11, commit
`d641515b1154aa46597e7ebb069d2341014c125c`): lint, typecheck, format, unit, build with the release gate,
audit, stress and the e2e suite on Ubuntu and Windows (443 passed, 6 `test.fixme` skipped, 0 failed and
0 flaky per OS) all succeeded; the 13 completed runs before it failed. It did not exercise branded
Chrome or Edge, a real incognito window, Chrome's permission prompt, a hosted sign-in provider or a
screen reader, and the manual checklist has not been run. The evidence for each privacy and store
statement is tracked in `docs/PRIVACY_CLAIMS.md`.

### Added

- Capture and recall of highlights on web pages: selection toolbar in a Shadow DOM overlay, saving
  with kind, colour and priority, recoverable text anchors with `ambiguous` and `orphaned` states
  that are never painted wrongly, painting through the CSS Custom Highlight API, notes typed only in
  the side panel (ADR-003, ADR-004, ADR-005).
- Least-privilege site access: `activeTab` on demand, per-site and all-sites optional host grants,
  persistent script registration, a starter deny list, refusal of private windows unless allowed.
- Popup, side panel, settings page (eleven sections), dashboard (banks, folders, topics, tags,
  trash, search, saved searches), welcome tour, keyboard commands and context menu.
- Local storage on IndexedDB (Dexie) with versioned migrations, an automatic pre-update copy,
  backup and restore (zip, optional AES-256-GCM passphrase, dry-run report, atomic commit; a
  single-file JSON variant exists in the engine but no control exports it) and readable exports.
- Retention: knowledge points, decks and flashcards, FSRS scheduling through `ts-fsrs`, review
  sessions and study-day settings.
- Extension-owned PDF reader on a bundled `pdfjs-dist` (ADR-006): local files and web addresses,
  anchored PDF highlights, optional kept copies, and on-device OCR with `tesseract.js` and bundled
  language data.
- Optional AI help, off by default: bring-your-own key, consent-bound preview of exactly what is
  sent, heuristic redaction, grounded and unverified-labelled results stored separately from quotes.
- Optional sync, off by default, against a server you operate: OIDC sign-in with PKCE, hybrid
  logical clock merge with conflict records, optional passphrase encryption of payloads; a
  reference server in `server/` that is deliberately not production-complete (ADR-009, ADR-010).
- Release engineering: build gates (`scripts/check-build.mjs`, `scripts/check-release-docs.mjs`),
  SBOM and licence report, reproducible-build comparison, `release.yml`, `reproducible-build.yml`
  and `stress.yml` (none of the last three has run yet), Dependabot configuration.
- Documents: privacy policy and store listing drafts, claims ledger, threat model, security
  policy, manual checklist and ADRs 001 to 010.
- Loaded-extension e2e coverage in `tests/e2e` (real Chromium, the built e2e extension, no mocked
  Chrome API): optional AI against a fake provider (15 tests), backup, restore and import (11),
  sync against the reference server and a stand-in OpenID Connect provider with a second profile and
  worker suspension (13, plus 4 `test.fixme` for the native permission prompt, an ungranted origin,
  a hosted https provider and the first-lifetime alarm wake), trusted settings (3), the settings,
  popup and welcome-tour surfaces, the dashboard, the review session and the PDF reader (OCR resume,
  web open, private windows through `?incognito=1`), and the extension-pages CSP. All of them
  passed on Ubuntu and Windows in Actions run 38139836238 (the 6 `test.fixme` tests were skipped); an
  earlier version of several had failed in run 38130710828 (`docs/PRIVACY_CLAIMS.md` "Evidence
  (F-01)"). Not driven: Chrome's native permission prompt, a real incognito window, a hosted
  provider, screen readers; those are `docs/MANUAL_TEST_CHECKLIST.md` section 12 (MT-41a, MT-42 to
  MT-53).
- `docs/A11Y_REVIEW.md` (27 findings, 18 fixed in code and CSS) and `docs/PERF_REVIEW.md` (23
  findings; 8 have a fix with a test, 3 of those only in part; the rest are recommended with their
  reasons).

### Changed

- The URL redaction rule for stored addresses was widened from a fixed list of parameter names to a
  name heuristic; it now also strips `;name=value` path parameters, credential parameters inside a
  `#/route` fragment and credential blobs in route clothing (`packages/shared/src/urls.ts`). It is
  applied when an address is saved and is not retroactive. Unit-tested (the `unit` job of run
  38139836238 passed); one capture is also asserted in a loaded extension
  (`tests/e2e/lifecycle.spec.ts`, same run).
- A backup holds study data only: settings, the AI provider settings, key and usage, the sync
  configuration, account and queue, saved searches and a review session in progress are not in it,
  and the screens say so from one place (`packages/ui/src/backup/scope.ts`).
- Sync uploads nothing until the person chooses a passphrase or explicitly chooses "Upload without
  end-to-end encryption"; until then every run only downloads. The sync server, issuer, client id and
  encryption decision, and the worker's authoritative copy of the settings, moved from
  `chrome.storage.local` (which content scripts can write) to IndexedDB `meta`; the unlocked
  encryption key is held in `chrome.storage.session` for at most 15 minutes and survives worker
  suspension within that time (ADR-010 amendment 1).
- The PDF reader hands back the host access it requested for one fetch when the fetch ends, unless
  the person already had it; re-opening a web PDF therefore asks again (ADR-006 amendment 2).
- "Delete all data" deletes the database first, never abandons a queued delete when another
  StudyVault window holds the database, and clears the copies, settings and site grants only after
  the delete completed (ADR-010 amendment 2).
- The extension-pages CSP allows `connect-src https:` and loopback http for the user-chosen AI and
  sync endpoints and web PDFs (ADR-009), and `'wasm-unsafe-eval'` for bundled decoders (ADR-008).
- Accessibility (`docs/A11Y_REVIEW.md`): the review session's and the dashboard's single-key
  shortcuts can be turned off (WCAG 2.1.4); focus no longer falls to the page body when the control
  that had it is removed (`useFocusRescue`) and the note editor, narrow dashboard panels and PDF
  save bar move focus on purpose; view, scope and "Delete all data" wait states are announced; the
  tree twist is 24 px; selected states survive forced colours; the toast's focus ring meets 3:1.
  Changed in code and CSS and unit-tested in jsdom; no screen reader, forced-colours or 400% zoom
  pass has been made (MT-42 to MT-44).
- Performance (`docs/PERF_REVIEW.md`): no second database open when the version is current; the
  search feed reads only the banks and folders it names; per-bank and per-tag counts in one pass;
  PDF document counts from an index; a hidden review page no longer polls; the search-cache write
  backs off to 20 times its cost; scrolling inside a row no longer re-renders the rows. Measured in
  Node, jsdom and fake IndexedDB, not in Chrome. Still recommended there: the seconds-long
  search-index serialise and restore, the eager dashboard index, parsing of due cards, and a bundle
  total at 99.4% of its budget.
- The per-deck settings form is no longer remounted when it is saved, so its confirmation stays
  (ADR-010 amendment 3).

### Fixed

- The PDF reader no longer stores documents, highlights, recognised text or kept copies from a
  private window, or from one it cannot identify, unless "Save from private windows" is on; before
  this the guard it relied on was always false for this extension (`entrypoints/pdf-reader/privacy.ts`).
- The PDF reader's save bar is evaluated when the mouse button is released, so a drag no longer runs
  on into the bar and saves a quote the person did not choose (`entrypoints/pdf-reader/selectionGate.ts`,
  commit `c9334b1`; "the save bar waits for the button to be released, so a drag never runs on into it"
  passed on Ubuntu and Windows in run 38139836238).
- Sync sign-in no longer depends on the worker having restarted after the `identity` permission was
  granted (ADR-010 amendment 3). Known limit: the first worker lifetime after `alarms` is granted
  does not register the sync alarm listener, so a stopped worker is not woken by it until something
  else has started the worker once.
- A redirect to a site the person did not allow is no longer read; the reader asks first.
- A purge now also removes AI results that used the item as a later input, evidence references in
  surviving knowledge points, and the sync conflict, quarantine and never-delivered outbox copies of
  the removed items.
- Search indexes follow a vault generation token, so a restore or "Delete all data" cannot be undone
  by an open page writing its old index back; unreadable rows no longer truncate the index.
- The pre-update copy is taken by whichever context upgrades the database, and its size is estimated
  before anything is read.
- Integrity: `undoLastReview` undoes the answer the card is in when two logs share a review time;
  `moveCards` never leaves live cards in a deleted deck; `mergeBanks` re-points the merged bank's
  decks; the sync reconcile sweep decides from rows read inside its transaction.
- "Delete all data" now also gives back the optional `identity` and `alarms` permissions and removes
  the per-viewer `localStorage` display preferences once the database delete is over, and its dialog
  says what stays (U-16). The permission removal is asserted in `tests/e2e/sync.spec.ts` (run
  38139836238); the preferences are unit-tested only.
- The Backup section's introduction follows the sync setting (U-2); the reader's redirect advice says
  the other site may already have received the request (U-14); Settings lists the origins granted to
  AI, sync and other features under "Other access" and can revoke each one (U-9, list and revoke).

### Security

- Merge-mode restore keeps the provenance fields of a row the vault has (the sync policy's immutable
  list); a forged ZIP64 or entry-count archive is refused from its central directory before anything
  is decompressed; restored JSON member names such as `__proto__` are refused; restored AI results
  are re-grounded and only demoted; imports create Sources of their own; one restore runs at a time
  in its own staging database. Unit and integration tests passed in the `unit` job of run 38139836238,
  and the loaded-extension specs for the merge, damaged-file and ZIP64 cases and for imports passed in
  the same run (`THREAT_MODEL.md` section 7, SR-1, SR-2, SR-L1 to SR-L5).
- Privileged sync configuration and the deny list, private-window flag and feature flags the worker
  enforces are no longer read from content-script-writable storage; setting up or rotating E2EE no
  longer re-encrypts server-supplied plaintext as authentic; a server that stops presenting the key
  profile cannot downgrade a device (SR-3, SR-4, SR-7).
- Open items remain in `THREAT_MODEL.md` section 6 and the residual risks R14 to R23.

### Known issues

- The hardening changes listed under Changed, Fixed and Security were made after the 2026-10-11
  reviews. Their unit and integration tests and their e2e specs passed in run 38139836238. None has
  been exercised in branded Chrome or Edge, and four things no automated spec can drive remain
  manual: a real incognito window, a second window blocking "Delete all data", a restore started
  twice, and a real sign-in provider (`docs/MANUAL_TEST_CHECKLIST.md` MT-45, MT-46, MT-50, MT-51).
- A purge cannot reach the sync server's copy, an unsent edit of an already-delivered item, an upload
  attempted but not acknowledged, sync merge bookkeeping (up to 90 days), the cached search index
  until a search page rebuilds it, or backups (R14, R15).
- Turning sync off or signing out leaves the sync server, issuer and token origins granted: Settings,
  Site access, "Other access" lists them and can revoke each one, but nothing removes them for the
  person (`docs/PRIVACY_CLAIMS.md` "Open items", U-9 remainder).
- The sync alarm is not registered in the worker lifetime in which `alarms` was granted (ADR-010
  amendment 3, MT-49); no Settings control exports the single-file JSON backup (the engine and its
  unit tests exist; `tests/e2e/backup.spec.ts` header).
- No licence file exists (owner decision); the privacy policy, security contact and store account
  details are owner-supplied `[USER-REQUIRED]` markers.

[Unreleased]: https://github.com/jerryboganda/studyvaultai/commits/main
