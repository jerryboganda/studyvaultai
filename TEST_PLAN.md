# Verification Plan

## Testing philosophy
Test behaviors in actual MV3 contexts. jsdom alone cannot validate extension permission lifecycle, content script isolation, native browser UI limitations, PDF viewer correctness or service worker termination. Prefer deterministic fixtures and real Chromium-based extension harness.

## Automated tests
- Unit: text normalization; W3C-style selectors; match scores; bank hierarchy validation; reference integrity; dedup; migrations; FSRS preview and transition rules; schema validation; export/import; date/timezones; URL sanitization.
- Component: toolbar placement, keyboard capture, accessible bank picker, selection preservation, optimistic save rollback, popover focus, long title truncation.
- Integration: messaging between content script/background/side panel; atomic Dexie transactions; source to highlight to note to card; unload/reload; permission grant/revocation; service worker suspend/resume.
- Browser/E2E: use actual Chrome extension-loaded profile, not mocked extension APIs. Ensure tests work under GitHub Actions.
- Contract: AI output schema and provenance, sync idempotency/conflicts, import schema and content hashing.
- Security: injected malicious HTML, prompt injection, risky URLs, cross-frame spoofing, CSRF in optional backend, CSP, sensitive-site exclusions, storage token leaks.
- Accessibility: axe (WCAG 2.2 AA tags) inside the loaded-extension specs below, keyboard-only flows, reflow at 320 px and 200% zoom, and the code-and-unit-test review in `docs/A11Y_REVIEW.md`; screen readers, forced colours and 400% zoom are manual (`docs/MANUAL_TEST_CHECKLIST.md` MT-17, MT-18, MT-42 to MT-44).

## HTML compatibility matrix
1. Simple article, repeated text in same page.
2. Nested formatting links/strong/inline math.
3. Dynamic SPA navigation, virtualized/lazy-loaded article sections.
4. ContentEditable editors and input fields (must not show toolbar by default).
5. Third-party components, Shadow DOM and iframes with permitted vs unpermitted origin.
6. Large academic article; multi-column layout and footnotes.
7. Extremely restrictive CSS and z-index stacks, page zoom 125%-200%, dark theme.
8. Restricted Chrome internal URL, Chrome Web Store, incognito by default, file:// permission disabled.
9. Duplicate quotation occurrences where the prefix/suffix is necessary.
10. Source mutated after save, ambiguous anchor, orphaned anchor; never silently link to wrong text.

## PDF compatibility matrix
1. Plain selectable text PDF, 10 pages.
2. Multi-column scientific PDF, tables, equations and superscripts.
3. Rotated pages, zoom scales, landscape.
4. Long PDF (100+ pages) and memory pressure; lazy render.
5. Scanned image-only PDF with no extractable text.
6. Password-protected PDF with proper user-supplied password.
7. Remote public PDF and redirected URL with content-type application/pdf without .pdf extension.
8. Authenticated content inaccessible to extension (clear manual upload fallback).
9. Local imported file; close/reopen document with stable fingerprint.
10. Annotation selection across line wraps and multiple text-layer spans, duplicate text occurrences.

## Review and AI matrix
- Deterministic known FSRS fixtures with Again/Hard/Good/Easy.
- UTC/DST/timezone changes, user clock drift and backlog behavior.
- Optional AI disabled; provider key missing; provider timeout; rate limit; quota exhausted; cancellation; two simultaneous requests; retry idempotency.
- Page text containing an instruction to reveal API keys; verify it is treated only as untrusted study content.
- Incorrect MCQ key and contradictory sources: display unverified/correction labels, don't overwrite original.
- Document with personal/sensitive text: consent preview and redaction controls are effective.

## Performance targets (engineering budgets, refine after measurement)
- Aim for <150ms added p95 input responsiveness for common highlight interactions on representative articles, excluding rendering or backend latency.
- Aim for <300ms p95 local lookup for typical filtered searches of a seeded 10k-highlight corpus on target hardware.
- Avoid unconditional full-document extraction or constant DOM polling; debounce and scope mutation processing.
- Lazy load PDF pages and OCR work; virtualize large highlight lists; bound queues and memory use.
- Track extension bundle size, page script footprint, median/p95 CPU/memory under representative tests. These are goals, not verified measurements.
- Measured so far (Node, jsdom and fake IndexedDB on a shared 4-CPU Windows machine, plus one e2e-variant bundle build) and the ranked findings are in `docs/PERF_REVIEW.md`; none is a Chrome number. The `stress` CI job (`scripts/run-perf.mjs`, `SV_PERF=1`) and `dashboard.spec.ts` "perf: 10,000 highlights" are the regression guards.

## Test areas added by the hardening changes (2026-10-11)
Written together with the code fixes S1 to S7 (docs/adr/010-module-seams.md amendments 1 and 2,
THREAT_MODEL.md section 7). Each file below is an ordinary Vitest suite picked up by `vitest.config.ts`
(`packages/**`, `entrypoints/**`), so the CI job `unit` runs it when `pnpm test` runs. **Status of all
of them: written and read, not run by the documentation pass, and no CI run has executed them**
(docs/PRIVACY_CLAIMS.md "Evidence caveat"). Locally, only the touched file may be run:
`pnpm exec vitest run <file>` (AGENTS.md rule 1).

| Area | Files (suite titles) | Level | What is not covered |
| --- | --- | --- | --- |
| Backup and import hardening | `packages/backup/src/hardening.test.ts` ("hostile ZIP directories are refused in milliseconds", "forbidden member names", "only the row that passed every check is staged", "a forged merge-mode archive cannot rewrite capture provenance", "citation guard", "exclusive restore"); `packages/backup/src/importExternal.test.ts` ("Markdown import is linear on hostile lines"); `packages/storage/src/backupHardening.test.ts` ("the provenance a merge may not change is the sync policy's list", "AI results are re-grounded on restore", "merging an archive that lacks entity tables", "one restore at a time, each in its own staging database", "imported highlights never join a Source that a capture made"); `packages/ui/src/backup/backup.test.tsx` ("what a backup says it holds") | unit and integration (fake IndexedDB); the import timing bounds can flake on a loaded runner | restore started from two real extension pages (the Web Lock path is exercised with a stubbed `navigator.locks`); a real 1 GiB archive; no e2e restore of a forged file |
| Private-window PDF reader | `entrypoints/pdf-reader/privacy.test.ts`; `packages/storage/src/pdf.private.test.ts`; `entrypoints/pdf-reader/Reader.test.tsx` ("Reader: what is saved depends on the window"); `packages/pdf/src/source.test.ts` ("reader address: private opener"); `tests/e2e/pdf.spec.ts` ("private windows") | unit, integration, component, and one e2e spec driven by `?incognito=1` | a real incognito window (not drivable by Playwright; the `test.fixme` marks it); MT-21 with a PDF |
| Web PDF grant lifecycle and redirects | `packages/pdf/src/grant.test.ts`; `packages/pdf/src/source.test.ts` ("fetchPdf: where a redirect may end"); `entrypoints/pdf-reader/Reader.test.tsx` ("Reader: site access for one fetch is handed back"); `tests/e2e/pdf.spec.ts` ("a redirect to another origin that is allowed opens; nothing is sent to it but the request") | unit, component, one e2e spec | Chrome's real permission prompt and `permissions.remove`; MT-39 |
| Redaction | `packages/shared/src/urls.test.ts` ("credentials never become part of an address", property tests on arbitrary input) | unit | stored rows are not rewritten (no migration test) |
| Purge and derived data | `packages/storage/src/bulk-trash.test.ts` ("trash" > "derived text"); `packages/storage/src/sync.test.ts` ("purge and the sync bookkeeping") | integration | the server's copy; attempted-but-unacknowledged uploads (covered only as a documented limit) |
| Search index | `packages/storage/src/search.test.ts`; `packages/ui/src/vault/searchHost.test.ts`; `packages/ui/src/vault/searchHost.vault.test.ts` | unit and integration | two real pages racing a restore |
| Database lifecycle | `packages/storage/src/lifecycle.test.ts` ("pre-update copy" suites, "Delete all data while another window holds the database"); `packages/storage/src/identity.test.ts` ("wipeAllData"); `packages/storage/src/study.test.ts` ("undoes the answer the card is in, even when two logs share a review time (clock set back)", "a deck deleted while cards are being moved never ends up holding live cards"); `entrypoints/background/index.test.ts` | integration | a real second window holding the database; a vault near the 64 MB bound |
| Trusted settings and private configuration | `packages/storage/src/syncPrivate.test.ts`; `entrypoints/background/index.test.ts` ("refuses a private-window capture at the worker until the user allows it", "keeps a denied site denied when a content script empties the stored deny list"); `entrypoints/background/sync.test.ts` ("where the configuration comes from", "tokens belong to one configuration") | unit and integration | planting through a real content script |
| E2EE: first upload gate, key custody, re-keying, downgrade | `entrypoints/background/sync.test.ts` ("the first upload", "the unlocked key", "a server that stops showing the encryption key", "an interrupted encryption set-up"); `entrypoints/background/sync.integration.test.ts` (reference server: "the first upload waits for an explicit choice", "re-keying never blesses what the server planted", "the key and the worker", "downgrade protection"); `packages/sync/src/crypto.test.ts`; `packages/sync/src/rekey.test.ts` | unit and integration against the in-process reference server | Chrome's `storage.session` across worker suspension, browser exit and extension reload; alarms with `when`; a real OIDC provider (MT-41) |
| Consent and encryption-card text | `packages/ui/src/sync/consent.test.ts` ("the consent list is generated from the sync policy"); `packages/ui/src/sync/sync.test.tsx` ("the encryption decision", "what the card says about the lock and about AI") | component | the text in a shipped build |

## Loaded-extension e2e specs added after the first plan (2026-10-11)
Playwright 1.64 against the built e2e extension in Playwright's bundled Chromium (`pnpm build:e2e`;
the manifest also holds `http://127.0.0.1/*` and `http://localhost/*` as required host permissions,
so Chromium never shows a native permission prompt). Every control is driven through the shipped
page; the only message the build adds is `e2e.settings.patch` (extension pages only, absent from the
production build, `scripts/check-build.mjs`; ADR-010 amendment 3), and it skips the install-time
welcome tab. **Status: each file below was reported as passing in
an agent-run local run on Windows (private build folder, one worker). No completed Actions run has executed
the current versions.** The last run, <https://github.com/jerryboganda/studyvaultai/actions/runs/38130710828>
(commit `ff0377f`), failed seven of eight `e2e` shards, including earlier versions of `ai.spec.ts`
"accessibility", `pdf.spec.ts` "private windows", `dashboard.spec.ts` "perf: 10,000 highlights" and
"bulk ... move", and eight `sync.spec.ts` tests; these were changed afterwards.
`docs/PRIVACY_CLAIMS.md` records each row as `e2e-local`, never `verified`, until a green run URL
exists. Counts are test call sites; loops over a colour scheme or a scenario run some of them twice.

| File | Level and harness | What it covers | What it cannot drive |
| --- | --- | --- | --- |
| `tests/e2e/ai.spec.ts` (14) | e2e; a local fake OpenAI-compatible provider (`aiServer.ts`), no key, no internet | AI off by default and sending nothing; the key kept in IndexedDB `meta` only (not in the page, `storage.*`, a backup or the console) and sent once as `Authorization`; the consent preview with an e-mail address and a card number masked, editable, nothing sent before Send; the sent body equals the preview, no cookie, no `Referer`, a repeat served from the device; an unverified draft citing the immutable quote; accept makes an AI-made card that needs checking; a fabricated quote is flagged and cannot be accepted; failures (429 quota and rate limit, malformed answer, unreadable response, cancelled hang, rejected key, unreachable provider, the 20 s "Test connection" deadline); offline gating; Remove key, Delete all AI data, Delete all data; axe and the dialog's focus trap | Chrome's host-permission prompt for a provider origin; an https provider; a provider that redirects; a model that never answers a consent request (60 s per attempt) |
| `tests/e2e/backup.spec.ts` (11) | e2e; the Options page's own controls, downloads as Playwright download events, restore files through the wizard's file input, a second browser launch for the restart | export, Delete all data, replace-restore with the highlights painting again; an encrypted backup and a wrong passphrase; merge keeping local edits and capture provenance against a forged archive; damaged, truncated, ZIP64-forged, newer-format and foreign files refused with the vault untouched; a data-version-1 archive upgraded; the foreign data model reported item by item; the pre-update copy reviewed, restored, deleted and removed by Delete all data; Markdown and CSV import into sources of their own; Markdown, CSV and Anki exports and no AI key in any backup; restore offline and after a browser restart; axe on the section, every wizard step and the delete confirmation | the single-file JSON export (no UI offers it: known unwired); a copy made by a real schema upgrade (it is planted with `seedPreUpdateCopy`); a real incognito window; a second window holding the database while a restore commits; an archive of more than a few hundred rows |
| `tests/e2e/sync.spec.ts` (13 and 4 `test.fixme`) | e2e; the repository's reference server (`server/src`, JSON-file store) over a socket, a stand-in OpenID Connect provider issuing ES256 tokens (`syncServer.ts`), real `chrome.identity.launchWebAuthFlow`, `chrome.alarms` and `chrome.storage.session`, a second browser profile, worker suspension by CDP `ServiceWorker.stopWorker` | off by default and a consent that equals the policy list; `identity` and `alarms` granted at "Turn on sync" and nobody contacted until sign-in; nothing uploaded until the person chooses; a passphrase gives ciphertext only and locking pauses everything; the plaintext path needs its acknowledgement and a later passphrase re-encrypts it; a second profile needs the passphrase and offline edits on both converge with the conflict shown and resolved; sign-out, "Delete my data from the server", Delete all data; a provider that ends the session; downgrade refusal when the server stops presenting the key; worker suspension, key expiry and the lock alarm; browser restart; an alarm waking a worker that has started once since the grant | the native permission prompt and declining it (`test.fixme`); an origin Chrome has not granted and the "Allow access to ..." flow (`test.fixme`); a hosted https provider (`test.fixme`); an alarm waking the worker that handled the grant (`test.fixme`; platform limit, ADR-010 amendment 3) |
| `tests/e2e/settings-trust.spec.ts` (3) | e2e; writes into `chrome.storage.local` from an extension page | the worker ignores a deny list emptied directly in `storage.local`, ignores a sync flag written there, and enforces the starter list on a fresh profile with nothing stored | a write from a real content script; the private-window flag |
| `tests/e2e/surfaces.spec.ts` (27) | e2e | Options: section list (deep links, one tab stop, arrow keys), consent text before any request for AI and sync, review switch, density and PDF-reader persistence, delete-all placement, Storage counts and removing a kept PDF copy, axe in light and dark, 320 px and 200% reflow; the popup study bar (count, live update, Start review, Open dashboard) and the PDF offer on Chrome's built-in viewer; the welcome tour (first look stores nothing, safe defaults, presets created once and never duplicated, skip, resume, axe and reflow) | the install-time open of the tour (the e2e build skips it); native prompts |
| `tests/e2e/dashboard.spec.ts` (59) | e2e; seeds a vault through the extension-origin writer | open states and deep links; tree (create, rename, reorder, merge, delete, nesting limit, Inbox protection); list scope, filters, sort, counts; 10,000 highlights (first paint, windowed scrolling, filter, search, bulk change); search grammar, facets, saved searches, offline, index restore, catch-up, rebuild and purge; preview (provenance, tags, fields, notes, Markdown that never runs script, duplicates); bulk actions; Trash (restore, purge, empty, no orphans); palette, single-key shortcuts, tab order, focus return; axe in light and dark; reload, worker suspension and browser restart | a restore or wipe while two search pages are open (MT-52); touch input |
| `tests/e2e/review.spec.ts` (22) | e2e; real review page, controlled clock for the study day | authoring of every card type with source links; an AI-made card flagged until checked; a session with keys, previews matching stored due dates, undo, suspend, bury and summary; Jump to source (page and PDF); reload, worker stop, browser restart and double click mid-session; daily caps, deck settings validation, study-day rollover and DST-exact boundaries; backlog recovery plan; analytics equal the known sequence; axe, keyboard only, reduced motion, offline | the OS-level reduced-motion setting (MT-53) |
| `tests/e2e/pdf.spec.ts` (28 and 1 `test.fixme`) | e2e; local fixture PDFs and a loopback PDF server (`tests/fixtures/pdf`) | open and render with a window of canvases; damaged, non-PDF and password files; highlights across wrapped lines, columns and rotation, surviving a reload; the save bar waiting for the button; search, outline, thumbnails, properties and kept copies; scanned pages and local OCR (serial, long timeouts) with cancel and resume after a reload; web open (no cookies, no referrer, every failure, offline, refused addresses, an allowed redirect, the menu's address); private windows through `?incognito=1`; axe | a real incognito window (`test.fixme`; MT-45); Chrome's prompt and the hand-back of the grant; clicking the native context menu |
| `tests/e2e/pages.spec.ts` (43) | e2e | the popup state matrix, side panel (page list, editing, needs-attention groups, tabs, narrow widths, search, tags and notes, banks, review tab), Options (theme, deny list, toolbar toggle, painting, private-window setting, shortcuts as Chrome reports them, Delete all data), and the extension-pages CSP: every page loads without a violation and the policy is enforced | the real shortcut layer; branded Chrome |

### Gaps the plan still owes
- A green Actions run of every row above (Linux and Windows Chromium), and a branded Chrome and Edge
  pass by hand.
- A real private window, a real second window blocking "Delete all data", two restores started from
  two extension pages, and a content script that writes `chrome.storage.local`: no automated spec
  can; they are manual rows MT-45, MT-50 and MT-51 (and MT-41a for `storage.session`).
- The native permission prompt, a hosted https provider and the first-lifetime alarm wake: the four
  `sync.spec.ts` `test.fixme` entries; manual rows MT-46 to MT-49.
- Forced colours, 400% zoom and screen readers on the newer surfaces: MT-42 to MT-44
  (`docs/A11Y_REVIEW.md`).
- Chrome numbers for the performance budgets: `docs/PERF_REVIEW.md` is Node and jsdom on a shared
  Windows box, not Chrome; the CI `stress` job is the regression guard.

## Exit reports
Every phase handoff must provide: completed workflows; test commands actually executed + pass/fail counts; screenshots; browser/OS tested; permissions tested; 5 most serious unresolved defects; rollback strategy; exact next task. Never mark skipped tests as passed.
