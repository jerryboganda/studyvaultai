# Changelog

All notable changes to StudyVault AI are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/) (`RELEASE.md`, "Versioning"). The per-release template in
`RELEASE.md` ("Changelog template") adds Permissions, Data and schema, and Verification sections;
copy it when a version is tagged.

## [Unreleased]

### Added
- Chat is a conversation: works with no study material, saved conversations that resume after a
  reload, a rolling summary as memory, and automatic retrieval from your highlights and notes with
  verbatim citations (ADR-024). Replaces the find-tick-send flow for chat.
- AI providers: UBAG gateway (OpenAI-compatible facade, HTTP Basic), NVIDIA NIM, OpenCode Go,
  OpenRouter and an unofficial ChatGPT (Codex) subscription login, each with a model dropdown (live
  list with curated fallback) and a reasoning-effort dropdown; ChatGPT quota and OpenRouter spend can
  be checked in the AI settings (ADR-023).

Nothing has been released or submitted to a store. `package.json` is at 0.1.0. The entries below say
what exists in the repository, not what has been proven. The latest fully green `ci.yml` run is
<https://github.com/jerryboganda/studyvaultai/actions/runs/38186957997> (2026-10-12, branch
`feat/finish-all`, commit `dadafe3af4576d8be90b8df467cfb91f9d412fc2`): lint, typecheck, format, unit
(275 files and 5,268 tests passed, 13 skipped), build with the release gate (content script 215 KB,
6,903 KB without the OCR assets), audit, stress (39 tests) and the e2e suite on Ubuntu and Windows
(564 passed, 6 `test.fixme` skipped, 0 failed and 0 flaky per OS) all succeeded. The run before it,
<https://github.com/jerryboganda/studyvaultai/actions/runs/38173629818> (commit
`79d8cbc38111bfcde0e621f37d4795fd3f38e736`; 546 passed per OS), and the first green run,
<https://github.com/jerryboganda/studyvaultai/actions/runs/38139836238> (commit
`d641515b1154aa46597e7ebb069d2341014c125c`; 443 passed per OS), are history; the 13 completed runs
before the first all failed. None exercised branded Chrome or Edge, a real incognito window, Chrome's
permission prompt or folder picker, a hosted sign-in provider, a live AI provider (the AI specs run
against local stand-ins) or a screen reader, and the manual checklist has not been run. The evidence for each privacy and store statement is tracked in
`docs/PRIVACY_CLAIMS.md`.

Entries marked **(finish wave)** were made on branch `feat/finish-all` after the first green run
(`docs/plans/FINISH_BRIEF.md`, ADR-011 to ADR-020). Run 38186957997 executed their unit files and
loaded-extension specs and all of them passed (the 6 skipped e2e tests are `test.fixme` entries of
earlier work, none of them a finish-wave test): ledger rows P20a to P20d, P26h to P26j, P33 to P39
(P36a included), P41 to P43 and P45 to P48 are `verified (CI 38186957997)` for what their specs assert
and still name unit-only or manual parts; P40 (schema v4) and P44 (selection at start-up) have no
loaded-extension spec and stay `unit-only`. Run 38173629818 had passed the same specs except the
four `math.spec.ts` titles that were rewritten for typeset math.

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
- **(finish wave)** Schema v4: auto-filing rules, syllabi and links between highlights, notes and
  knowledge points, in one additive Dexie bump with backup, sync classification, integrity checks and
  purge cascade (ADR-011).
- **(finish wave)** Auto-filing rules: a manager with order, switches, duplicate and undo, a "Test a
  rule" panel, and suggestion or filing after a capture in the page, the side panel and the PDF reader.
  A rule asks first by default and never overrides a bank the capture named (ADR-017).
- **(finish wave)** Links and a knowledge graph: a Links section on every highlight, "Link as Related"
  and "Link as Contradicts", a graph limited to 60 items with a Connections table and keyboard walk
  (ADR-018).
- **(finish wave)** Syllabus editor and coverage table (ADR-020 part 2); exam simulation with seeded
  draw, a timer, self-marked recall, results by bank and tag, optional "count as review" with undo, a
  history of the last 20 exams (ADR-020 part 1).
- **(finish wave)** An exam can be drawn from a syllabus topic or a whole syllabus, optionally
  weighted by topic share (largest remainder, never more than a topic's cards, what was left out is
  listed); a card in several topics counts under one; results gain a "By topic" table with "Study
  this topic", the coverage table an "Exam on this topic" button, and `?view=exam&syllabus=&topic=`
  opens the setup on a topic. The exam row is version 2 and a stored version 1 row is carried over
  (ADR-020 part 2 addendum).
- **(finish wave)** Opt-in study reminders: the number of cards due on the toolbar icon and a daily
  in-extension notice; no system notifications (ADR-019).
- **(finish wave)** Backups into a folder you choose (File System Access): dated files, read back and
  checked, the newest N kept and nothing else deleted, an optional passphrase and an in-app reminder;
  no background backup (ADR-016).
- **(finish wave)** Import of Word (.docx), PowerPoint (.pptx), EPUB, HTML and Anki "Notes in Plain
  Text" files, parsed locally and inertly with fixed limits, with a dry run and undo to the Trash
  (ADR-014).
- **(finish wave)** AI: up to three fallback providers with consent over every recipient origin and
  failover only after a network failure, a 5xx or a timeout; task kinds `mnemonic`, `short_viva` and
  `study_outline`; chat with your notes with local retrieval and ticked passages (ADR-013).
- **(finish wave)** Related highlights (lexical, on the device), a "JSON (for scripts)" readable
  export, and the `focus-search` command.
- **(finish wave)** Typeset math in notes: `$..$` and `$$..$$` become native MathML through temml
  0.13.5, a lazily loaded 207 KB chunk (61 KB gzip) fetched only when a note holds a formula; the TeX
  stays the stored text and the fallback for any formula the typesetter refuses (colour, links,
  images, macro definitions, over the caps of 60 formulas, 1,000 characters each and 3,000 a note),
  while the chunk loads and when it cannot be fetched (ADR-015 amendment 1).
- **(finish wave)** "Re-recognise this page" and "Re-recognise all pages" in the reader's Page text
  tab, with an estimate and a confirmation; a page is replaced only after its new reading succeeded,
  corrections follow their line by position (one with no counterpart is dropped and listed),
  highlights are never touched, and "Restore the previous reading" gives one step back, kept on the
  device only and outside backups and sync (ADR-006 amendment 5).
- **(finish wave)** Loaded-extension specs for the Anthropic provider (`ai-anthropic.spec.ts`, against
  a local stand-in that speaks the Messages API) and for backups and AI keys (`backup-secrets.spec.ts`:
  no key, fallback key or AI setting in a plain or an encrypted backup, which is opened and
  searched).
- **(finish wave)** Eleven real public-domain PDFs (United States government works, 20.7 MB, licence
  basis in `tests/fixtures/pdf/real/SOURCES.md`) as a test corpus with open, search, highlight, OCR,
  link and memory specs (`pdf-real.spec.ts`, `pdf-links.spec.ts`, `pdf-real-memory.spec.ts`) and an
  always-on integration test. They hold no script, attachment, XFA or encryption: they are not a
  hostile-PDF test.
- **(finish wave)** Links in the PDF reader (ADR-006 amendment 3): a link to a place in the document
  goes there and Back (button and Alt+Left) returns; a web address opens only after a dialog that shows
  the whole address and the site, in a new tab with no opener and no referrer; every other scheme and
  every script, file or form action is refused with a notice. Keyboard route (one tab stop and arrow
  keys on a page with more than 40 links) and a Links list in the navigation pane.
- **(finish wave)** Scans stored sideways or upside down are read by turning the page on the device
  (ADR-006 amendment 4): a 30 ms ink check orders at most four full-size readings, a turned reading
  must beat the upright one by 1.5 times the confidently read characters, and the outcome says the
  page was turned. Optional `orientation` on the recognised page; no new bundled data.
- **(finish wave)** Decisions ADR-011 to ADR-020 and `LICENSE` (proprietary, all rights reserved).

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
- **(finish wave)** The content script runs on Preact through `preact/compat` (215 KB in the release
  gate of run 38186957997, 209 KB in the private build ADR-012 measured; was 405 KB); extension pages
  stay on React. Release-gate budgets: content script 230 KB (was 450), background 450 KB (was 420),
  non-OCR total 7,000 KB (was 6,500, then 6,800 before the typesetter chunk; measured 6,903 KB)
  (ADR-012, ADR-015, `scripts/check-build.mjs`). Earlier entries of this file said 220 KB for the
  content script; the file has held 230 KB.
- **(finish wave)** The optional `alarms` permission is also requested by the click that saves a daily
  reminder time, not only by "Turn on sync". The manifest did not change; PRIVACY_POLICY.md,
  STORE_LISTING.md and SECURITY_PRIVACY.md say so (ADR-019).
- **(finish wave)** Folders can nest 32 deep (it was 8). Markdown that is too expensive to format is
  shown as plain text with a note; the stored body is not changed (ADR-015). A page's PDF link
  refusal notice floats over the pages instead of resizing the viewer, and link anchors are painted
  with their page rather than after it (ADR-006 amendment 3).
- **(finish wave)** The seeded perf suites of `packages/storage` and `packages/study` assert their
  budgets on the wall-clock p95 and print CPU time beside it: process CPU time counts V8's helper
  threads, and one collection among 15 samples made a 62 ms wall p95 read as 146 ms.
- **(finish wave)** A backup holds auto-filing rules, syllabi and links; the exam in progress, exam
  history, syllabus thresholds, the backup-folder reference and reminder settings are not in it.
- **(finish wave)** Interface: switches backed by an async write show their choice at once and are busy
  until stored; toasts wait under the pointer or focus and can be kept until closed on extension
  pages; result rows grow under text-spacing overrides; the PDF reader opens its save bar from the
  keyboard.

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
- **(finish wave)** Text that was already selected when the content script started now shows the
  toolbar (the controller evaluates the selection once the overlay has mounted).
- **(finish wave)** Links of a note or knowledge point whose highlight is in the Trash are hidden
  instead of leading nowhere (ADR-018 section 3).
- **(finish wave)** PDF hyperlinks were not clickable: the reader drew no annotation layer (found by
  the real-document corpus run; ledger U-22, ADR-006 amendment 3). Unit-tested; `pdf-links.spec.ts` (14
  tests) passed in run 38173629818.
- **(finish wave)** A scan stored sideways (the real NASA MSFC file, page 1) was recognised as shown
  and saved 793 characters of noise under a green "Recognised 1 page"; it is now turned to be read and
  the outcome says so (ADR-006 amendment 4). Pages recognised before this change keep their text.
- **(finish wave)** A selection made on a PDF page whose text layer was still being put in order was
  cut loose and no save bar followed; the spans are now selectable only once the layer is complete
  (`.endOfContent` placed; ADR-006 amendment 4).
- **(finish wave)** The reader's page box committed on blur even when nothing had been typed, so the
  view could jump to the top of the page between a press and a release.

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
- Open items remain in `THREAT_MODEL.md` section 6 and the residual risks R14 to R30.
- **(finish wave)** A render budget keeps a hostile, synced or imported note from freezing a page
  (marked took tens of seconds on some 100,000-character inputs). A formula is typeset only after that
  budget, within its caps and with no macro definition; temml runs with `trust: false` and
  `strict: true`, and its MathML passes a second DOMPurify instance and an independent walk against a
  closed list of elements, attributes, classes and style declarations (no links, ids, annotations,
  colour or `url()`), or the formula stays source text. The Markdown sanitiser allows `class` only on
  `<code>` as `math` or `math math-display` (ADR-015, THREAT_MODEL C3.3 and C3.7).
- **(finish wave)** Document parsers: central-directory listing before any read, size, entry and ratio
  limits, exact-length inflate, unsafe names refused, DOCTYPE and ENTITY refused before XML parsing,
  HTML parsed inert and never attached (ADR-014, C5.11).
- **(finish wave)** A page cannot choose where a highlight is filed: it sends only a highlight id and
  the worker reads the placement from its own session record (ADR-017, C2.10). AI fallback recipients
  are part of the consent hash (ADR-013, C7.7).
- **(finish wave)** A link inside a PDF is never opened by the click itself: only an absolute `http:`
  or `https:` address of at most 2,048 characters, without credentials, is offered, after a
  confirmation that shows the address, and it opens with `noopener,noreferrer`; `javascript:`,
  `data:`, `file:`, `blob:`, `chrome-extension:`, `mailto:` and every other scheme are refused
  (THREAT_MODEL C6.6, R31).

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
  amendment 3, MT-49); no Settings control exports the restorable single-file JSON backup (the engine
  and its unit tests exist; `tests/e2e/backup.spec.ts` header). The "JSON (for scripts)" readable
  export added by the finish wave is a different file: highlights only, not read back.
- The licence is proprietary, all rights reserved (`LICENSE`, owner decision of 2026-10-11); the
  copyright holder's name in it, the privacy policy, the security contact and the store account
  details are owner-supplied `[USER-REQUIRED]` markers. `scripts/check-release-docs.mjs` does not scan
  `LICENSE` for its marker.
- **(finish wave)** Not verified: run 38186957997 passed the wave's unit files and specs (ledger rows
  P20a to P20d, P26h to P26j, P33 to P48; `THREAT_MODEL.md` O15 to O18), but nothing drives: the folder
  prompt on a real disk, reminders across a browser restart, a real private window for filing rules,
  real Word, PowerPoint and EPUB files, real AI providers (the OpenAI-compatible and Anthropic specs
  run against local stand-ins) with Chrome's prompt for the second origin, a typeset formula, the exam
  and the graph with a screen reader, the Preact overlay in branded Chrome
  (`docs/MANUAL_TEST_CHECKLIST.md` MT-54 to MT-61 and MT-66 to MT-68; the PDF reader's rows are MT-62 to MT-65).
- **(finish wave)** Limits that are decisions: typeset math covers the TeX temml accepts under a
  closed allow-list (no colour, links, images, macro definitions or equation numbers), a copied
  formula is flattened text and flashcard faces show TeX as typed; reminders need the browser running
  and are not system notifications; backups into a folder start from a click; the knowledge graph
  shows at most 60 items; related highlights match whole words (no stemming, no embeddings); a card
  that belongs to several topics counts under one in a syllabus exam, which has no adaptive "weakest
  first" draw; a page read again keeps one step back only; the Delete-all and backup-scope lists do
  not yet name the new kinds of data (ledger U-17).
- **(finish wave)** PDF reader limits: only link annotations and four named actions (next, previous,
  first and last page) are followed, and no JavaScript, form or layer action; scans are turned as a
  whole (one orientation per page, no deskew, English only) and a blank page can cost four readings;
  a page recognised before the turn was added keeps its text until it is read again with
  "Re-recognise" (one step back, no control that removes recognised text); the privacy policy and the store listing now say what a click on a PDF link does (ledger
  U-23; the in-product Privacy section does not yet). Not verified: a real screen reader on links, the pop-up blocker on the new tab, a
  physically sideways scan, forced colours (`docs/MANUAL_TEST_CHECKLIST.md` MT-62 to MT-65).

[Unreleased]: https://github.com/jerryboganda/studyvaultai/commits/main
