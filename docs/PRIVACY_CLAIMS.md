# Claims ledger: what the store documents say and what proves it

`PRIVACY_POLICY.md` and `STORE_LISTING.md` make statements about behaviour. Each one is listed here
with the code and test that back it, so that a release reviewer can check the documents against the
product instead of trusting either. Update this file in the same change as any behaviour or document
edit. Written 2026-10-11 against the repository at that date.

Status:

- **verified**: an automated test in CI exercises it (test file and name given);
- **by design**: enforced by the manifest, CSP or types and asserted on every build by
  `scripts/check-build.mjs` or `scripts/check-release-docs.mjs`;
- **in progress**: the code exists as a library; the shipped UI and end-to-end behaviour still have
  to be checked once the module is wired in. **Do not publish a statement in this state until it
  moves to verified or manual.**
- **manual**: only the manual checklist (`docs/MANUAL_TEST_CHECKLIST.md`, row id given) can check it.

## Privacy policy

| # | Claim | Evidence | Status |
| --- | --- | --- | --- |
| P1 | In the default configuration nothing leaves the device; no network requests of its own | Phase 1 code has no `fetch`, `XMLHttpRequest`, `WebSocket` or `sendBeacon`. Later modules may use network APIs only where a feature needs them and only behind its switch: `packages/pdf/src/assets.ts` (bundled PDF.js data, extension origin), `packages/pdf/src/source.ts` (a PDF the user asked to open), `packages/ai/src/providers.ts` and `packages/sync/src/transport.ts` (injected `fetch`, feature off by default). Re-run before release: `grep -rnE "fetch\(|XMLHttpRequest|WebSocket|sendBeacon" entrypoints packages server --include=*.ts --include=*.tsx` and review each hit that is not a test. Extension-pages CSP (`wxt.config.ts`, asserted by `scripts/check-build.mjs`). `tests/e2e/resilience.spec.ts` "capture, undo, restore and rehydrate work offline; no request leaves loopback or the extension" | verified for Phase 1; re-check with the reader, AI and sync wired in (THREAT_MODEL O6, MT-22a) |
| P2 | No analytics, advertising or telemetry code | Production dependency closure in the SBOM (`scripts/sbom.mjs`) contains none; no remote script or tag in any extension page (`scripts/check-build.mjs`) | by design |
| P3 | Runs only on a tab or site the user enabled | `wxt.config.ts` (no `host_permissions`, no static `content_scripts`); ADR-003; `tests/e2e/permissions.spec.ts` "a stored per-site grant is registered, listed in settings, and auto-injects on a fresh visit"; `tests/e2e/resilience.spec.ts` "persistent registration" suite | verified |
| P4 | Passage up to 10,000 characters; note up to 20,000; title 500; heading 300; context 64 | `packages/shared/src/constants.ts` (`MAX_QUOTE_CHARS`, `MAX_COMMENT_CHARS`, `MAX_TITLE_CHARS`, `MAX_HEADING_CHARS`, `MAX_CONTEXT_CHARS`); `packages/shared/src/schema.ts` | verified (`constants.test.ts`) |
| P5 | Page text itself is not stored; only a hash and the length | `HtmlAnchorSet.contentSignature` and `documentTextLength` in `packages/shared/src/schema.ts`; `tests/e2e/lifecycle.spec.ts` "capture provenance" (database content inspected) | verified |
| P6 | User name, password, credential-like parameters and non-route fragments are removed from stored addresses; tracking parameters are kept in the stored address | `redactUrl` in `packages/shared/src/urls.ts`; `packages/shared/src/urls.test.ts`; `tests/e2e/lifecycle.spec.ts` "a highlight records the address and title it was saved on, with credentials removed, and nothing secret reaches the database" | verified |
| P7 | Form fields, editors and password fields are not captured | `tests/e2e/compat.spec.ts` "editable surfaces (matrix 4)" (drag, triple click, Ctrl+A, shortcut and menu paths) | verified |
| P8 | Does not run on browser pages, the Web Store, `file://` without opt-in, the built-in PDF viewer | `entrypoints/background/siteAccess.ts` (`mapInjectionError`); `tests/e2e/permissions.spec.ts` "restricted pages: tab.activate answers with a specific error and the UI renders it" | verified |
| P9 | Starter deny list of sign-in, mail, payment, bank and health-portal sites; user-editable; incomplete | `DEFAULT_DENY_HOSTS`, `DENY_LIST_SCOPE_NOTE` in `packages/shared/src/constants.ts`; `tests/e2e/overlay.spec.ts` "deny list defaults" | verified |
| P10 | Private windows are not saved unless the user turns it on; the database is shared | `entrypoints/background/handlers.ts` (`capture.save`); `packages/shared/src/settings.ts` (`allowIncognitoCapture: false`); `tests/e2e/overlay.spec.ts` "private windows" | verified; MT-21 to MT-21b |
| P11 | A website can see which passages are highlighted, with colour and kind, and that StudyVault runs; it cannot read notes, banks or settings or trigger saves | ADR-004, ADR-005; `tests/e2e/permissions.spec.ts` "page scripts get no extension messaging surface (main world)", "forged DOM events and messages cannot capture, change data or open UI"; `tests/e2e/overlay.spec.ts` "overlay exposes no free-text surface to the page" | verified |
| P12 | Notes are typed in the side panel, not in the page | ADR-005; `tests/e2e/overlay.spec.ts` "hand-over to the side panel (ADR-005)" | verified |
| P13 | Settings categories listed | `packages/shared/src/settings.ts` (`Settings` schema, `parseSettings`) | by design (schema) |
| P14 | Change markers hold no data; hand-over entry is session storage, ignored after 30 s | `packages/runtime/src/dataEpoch.ts`; `packages/shared/src/pendingFocus.ts`; `tests/e2e/overlay.spec.ts` "a hand-over written before the panel exists is honoured when it opens, then removed; a stale one is dropped" | verified |
| P15 | Delete all data removes the database, settings, session state and site grants | `wipeAllData` in `packages/storage/src/repo.ts`; `packages/storage/src/identity.test.ts` "wipeAllData"; `tests/e2e/pages.spec.ts` "options: delete all data" | verified |
| P16 | Deleting a highlight keeps a recoverable copy until the user deletes all data (or purges it) | `softDeleteHighlight`; side-panel toast copy; `tests/e2e/lifecycle.spec.ts` "undo, duplicate, delete and consistency between tabs". Purge / trash behaviour is the vault task's | verified for highlights; in progress for trash and purge |
| P17 | `tabs`, `history`, `bookmarks`, `cookies`, `webRequest`, `downloads` are not requested | Built manifest asserted to be exactly `activeTab, contextMenus, scripting, sidePanel, storage` (`scripts/check-build.mjs`; `tests/e2e/permissions.spec.ts` "ships exactly the documented least-privilege manifest") | by design, verified |
| P18 | The permission table equals the manifest | `scripts/check-release-docs.mjs` (CI job `build`) | by design |
| P19 | Optional features default to off | `defaultSettings().features` in `packages/shared/src/settings.ts` (`ai: false`, `sync: false`) | verified (settings) |
| P20 | AI: text sent is previewed, editable, bound to consent; only selected passages; direct to the provider over HTTPS | `packages/ai/src/prepare.ts`, `pipeline.ts`, `providers.ts` (`assertSafeEndpoint`); `packages/ai/src/pipeline.test.ts`, `providers.test.ts` | in progress (no UI yet; MT-30, MT-30a) |
| P21 | AI: redaction is heuristic and the user reviews it | `packages/ai/src/redact.ts` header; `redact.test.ts` | in progress |
| P22 | AI key stored locally, sent only to the configured endpoint, not logged, not in backups or sync | Key handling in `packages/ai/src/providers.ts`, `secrets.ts`; storage location and backup exclusion are not implemented in the library | in progress (THREAT_MODEL O4) |
| P23 | AI results stored separately, labelled unverified, never overwrite a quote or note | `packages/ai/src/schema.ts`, `constants.ts` (`UNVERIFIED_NOTICE`); `aiResults` table in the execution brief | in progress |
| P24 | Sync: off until switched on and signed in; categories uploaded; settings, PDFs and keys not synced | `packages/sync/src/policy.ts` (`STUDYVAULT_SYNC_POLICY`: `attachments`, `syncOps`, `meta` local-only) | in progress |
| P25 | Sync: content can be encrypted on the device before upload, with a passphrase-derived key | `packages/sync/src/schema.ts` (`EncryptedEnvelope`, AES-256-GCM) | in progress (THREAT_MODEL O5) |
| P26 | A backup without a passphrase is readable by anyone holding it; with one it is AES-256-GCM | `packages/backup/src/crypto.ts` | verified (unit, `roundtrip.test.ts`) |
| P27 | Removing the extension removes its stored data | Browser behaviour | manual (MT-23a) |

## Store listing

| # | Claim | Evidence | Status |
| --- | --- | --- | --- |
| S1 | Five permissions and two optional host patterns, each justified | `wxt.config.ts`; `scripts/check-build.mjs`; `scripts/check-release-docs.mjs` | by design |
| S2 | No remote code | `scripts/check-build.mjs` (CSP directives, no remote tags, no source maps, size budgets) | by design |
| S3 | Highlights return on later visits, including on single-page sites | `tests/e2e/gate10.spec.ts`; `tests/e2e/lifecycle.spec.ts` "SPA navigation", "hash-routed single-page app" | verified |
| S4 | A changed page is reported, never highlighted wrongly | ADR-004; `packages/highlights/src/adversarial.test.ts`; `tests/e2e/pages.spec.ts` "side panel: highlights that need attention"; `tests/e2e/lifecycle.spec.ts` "source mutated after save" | verified |
| S5 | Text inside iframes and shadow DOM is not highlighted | ADR-004; `tests/e2e/compat.spec.ts` "iframes (matrix 5)", "web components and Shadow DOM (matrix 5)" | verified |
| S6 | Cannot run on browser pages, the Web Store, protected pages | See P8 | verified |
| S7 | Keyboard shortcuts for saving and moving between highlights; labelled controls; light and dark; highlights do not rely on colour alone | `tests/e2e/a11y.spec.ts` (axe WCAG 2.2 AA over overlay and extension pages, keyboard-only flows); `KIND_DECORATION` in `packages/highlights`; `tests/e2e/overlay.spec.ts` "per-kind highlight decoration" | verified (automated); screen readers manual (MT-17, MT-18) |
| S8 | Built-in Chrome PDF viewer cannot be annotated by extensions; StudyVault's reader is the supported route | SECURITY_PRIVACY.md; `tests/e2e/permissions.spec.ts` "Chrome's built-in PDF viewer: the popup says what is and is not possible" | verified (message); reader in progress |
| S9 | Files up to 300 MB; web PDFs fetched without cookies; a sign-in wall is reported | `packages/pdf/src/source.ts` (`MAX_PDF_BYTES`, `credentials: 'omit'`) | in progress |
| S10 | OCR is local, slow and fallible; corrections are kept apart from recognised text | `packages/pdf/src/ocr.ts`, OCR task; `ocrPages.correctedText` in `packages/sync/src/policy.ts` | in progress |
| S11 | `file://` PDFs open through the picker without the file-URL switch | ARCHITECTURE.md; reader import path | in progress (MT-27) |
| S12 | Spaced repetition runs on the device | `packages/study/src/scheduler.ts` (ts-fsrs, pure) | in progress (UI) |
| S13 | Data-usage answers (Web history, Website content) and limited-use text | PRIVACY_POLICY.md P1 to P26 | depends on P20 to P25 |
| S14 | Screenshots show the shipped build | `tests/e2e/screenshots.spec.ts` (CI artifact `screenshots-<os>`) | verified per CI run; owner reviews (MT-34) |
