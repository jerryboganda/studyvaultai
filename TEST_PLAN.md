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

### Gaps the plan still owes
- A loaded-extension run (Linux and Windows Chromium in CI, branded Chrome by hand) of every row above.
- A real private window, a real second window blocking "Delete all data", two restores started from
  two extension pages, and a content script that writes `chrome.storage.local`.
- Manual rows for those (docs/PRIVACY_CLAIMS.md U-15).

## Exit reports
Every phase handoff must provide: completed workflows; test commands actually executed + pass/fail counts; screenshots; browser/OS tested; permissions tested; 5 most serious unresolved defects; rollback strategy; exact next task. Never mark skipped tests as passed.
