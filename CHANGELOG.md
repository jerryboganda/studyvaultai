# Changelog

All notable changes to StudyVault AI are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/) (`RELEASE.md`, "Versioning"). The per-release template in
`RELEASE.md` ("Changelog template") adds Permissions, Data and schema, and Verification sections;
copy it when a version is tagged.

## [Unreleased]

Nothing has been released or submitted to a store. `package.json` is at 0.1.0. The entries below say
what exists in the repository, not what has been proven: on 2026-10-11 every completed `ci.yml` run
had concluded `failure` and the manual checklist had not been run. The evidence for each privacy
and store statement is tracked in `docs/PRIVACY_CLAIMS.md`.

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
  backup and restore (zip or JSON, optional AES-256-GCM passphrase, dry-run report, atomic commit)
  and readable exports.
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

### Changed

- The URL redaction rule for stored addresses was widened from a fixed list of parameter names to a
  name heuristic; it now also strips `;name=value` path parameters, credential parameters inside a
  `#/route` fragment and credential blobs in route clothing (`packages/shared/src/urls.ts`). It is
  applied when an address is saved and is not retroactive. Unit-tested; not yet run in CI.
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

### Fixed

- The PDF reader no longer stores documents, highlights, recognised text or kept copies from a
  private window, or from one it cannot identify, unless "Save from private windows" is on; before
  this the guard it relied on was always false for this extension (`entrypoints/pdf-reader/privacy.ts`).
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

### Security

- Merge-mode restore keeps the provenance fields of a row the vault has (the sync policy's immutable
  list); a forged ZIP64 or entry-count archive is refused from its central directory before anything
  is decompressed; restored JSON member names such as `__proto__` are refused; restored AI results
  are re-grounded and only demoted; imports create Sources of their own; one restore runs at a time
  in its own staging database. Unit and integration tests; no CI run (`THREAT_MODEL.md` section 7,
  SR-1, SR-2, SR-L1 to SR-L5).
- Privileged sync configuration and the deny list, private-window flag and feature flags the worker
  enforces are no longer read from content-script-writable storage; setting up or rotating E2EE no
  longer re-encrypts server-supplied plaintext as authentic; a server that stops presenting the key
  profile cannot downgrade a device (SR-3, SR-4, SR-7).
- Open items remain in `THREAT_MODEL.md` section 6 and the residual risks R14 to R23.

### Known issues

- The hardening changes listed under Changed, Fixed and Security were made after the 2026-10-11
  reviews and have unit or integration tests only: no CI run has executed them and none has been
  exercised in a loaded Chrome (a real incognito window, `chrome.storage.session` across worker
  suspension, a second window blocking "Delete all data", a real sign-in provider).
- "Delete all data" does not remove the optional `identity` and `alarms` permissions or the
  dashboard's two `localStorage` preferences (no fix yet; `docs/PRIVACY_CLAIMS.md` P15), and the
  Settings page shows only "Deleting..." while another window blocks it (U-1).
- A purge cannot reach the sync server's copy, an unsent edit of an already-delivered item, an upload
  attempted but not acknowledged, sync merge bookkeeping (up to 90 days), the cached search index
  until a search page rebuilds it, or backups (R14, R15).
- Some in-product strings still say data stays only on the device, that deleted items stay until
  "Delete all data", or that there is no copy to get back, which is not true once sync is used or a
  purge exists; the PDF reader says it "never contacts a site you have not allowed" although a
  redirect may reach the other site (`docs/PRIVACY_CLAIMS.md` "Open items", U-1 to U-4, U-8, U-9,
  U-14).
- No licence file exists (owner decision); the privacy policy, security contact and store account
  details are owner-supplied `[USER-REQUIRED]` markers.

[Unreleased]: https://github.com/jerryboganda/studyvaultai/commits/main
