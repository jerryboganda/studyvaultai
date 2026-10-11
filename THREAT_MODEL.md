# Threat model - StudyVault AI

Method: STRIDE over the real architecture (ARCHITECTURE.md), written for release review
(ROADMAP.md Phase 7). References are to files and tests that exist in the repository; where a module
was still being integrated when this was written it is marked **in progress** and its mitigations
are the ones the module's code establishes, not yet an end-to-end verified behaviour. The open items
at the end are the work that remains.

Status words: **verified** = an automated test exercises it in the loaded extension or in a unit
suite; **by design** = enforced by construction (manifest, CSP, types) and asserted by the build gate;
**in progress** = implemented in a library, not yet reached through the shipped UI; **accepted** =
a known exposure, disclosed to users (SECURITY_PRIVACY.md, PRIVACY_POLICY.md).

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
| TB4 | the device and the network (AI provider, sync server) | The only places user content can leave; both are opt-in. |
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
| C2.7 | E | Capture on a deny-listed site, or from a private window the user did not allow | Refused in the page, in the worker and, for persistent sites, by `excludeMatches` at registration | `handlers.ts` (`capture.save`); `entrypoints/background/siteAccess.ts`; `tests/e2e/resilience.spec.ts` "a registered script on a denied host is excluded at registration"; `tests/e2e/overlay.spec.ts` "private windows" | verified |
| C2.8 | R | No record of which context made a change | Not provided: local data has no audit trail by design. Sync operations carry a client id and revision (see C9) | `packages/sync/src/schema.ts` | accepted |
| C2.9 | E | Over-broad site access at install | No `host_permissions`; optional `https://*/*` and `http://*/*` requested per site from a user gesture; built manifest asserted on every build | `wxt.config.ts`; `scripts/check-build.mjs`; `tests/e2e/permissions.spec.ts` "ships exactly the documented least-privilege manifest" | verified, by design |

### C3 - Extension pages: popup, side panel, options, reader (TB3)

| ID | STRIDE | Threat | Mitigation | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| C3.1 | T/E | Stored page text (quote, title, heading, note, bank name) is rendered as markup in a privileged page | React renders text nodes and a review of the shipped code found no `innerHTML`, `dangerouslySetInnerHTML` or `document.write` in it; the overlay's sources are scanned for them by a unit test; the extension-pages CSP is `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; base-uri 'self'; connect-src 'self'; frame-src 'none'; form-action 'none'`, so injected inline script would not run | `wxt.config.ts`; `scripts/check-build.mjs`; `entrypoints/highlighter.content/ui/security.test.ts` (overlay only) | by design; nothing enforces it for extension pages yet (O1) |
| C3.2 | T | `javascript:` / `data:` URLs reach a link or a navigation | Stored addresses must be http(s) (`HttpUrl`); the reader accepts only plain https `?src=` | `packages/shared/src/schema.ts`; `packages/pdf/src/readerUrl.ts` | verified (unit), in progress (reader) |
| C3.3 | I | Rendered Markdown (notes, imports) carries active content | `marked` output must pass DOMPurify with a tag allow-list before it reaches the DOM | `packages/` vault entrypoints | in progress (O2) |
| C3.4 | E | A web page loads an extension page or resource | No `web_accessible_resources`, so a web page cannot load, frame or navigate to an extension page or script | `scripts/check-build.mjs` | by design |
| C3.5 | T | Accidental destructive action | "Delete all StudyVault data" asks first, focus starts on Cancel; deletes are soft with Undo | `tests/e2e/pages.spec.ts` "options: delete all data" | verified |
| C3.6 | D | Surface crashes on a bad row | `ErrorBoundary` renders a recoverable message; rows are validated before use | `packages/ui/src/ErrorBoundary.tsx`; `packages/storage/src/rows.ts` | verified |

### C4 - Local storage (TB6)

| ID | STRIDE | Threat | Mitigation | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| C4.1 | T | Credentials or one-time tokens in page URLs persist in the database, backups or the side panel | `redactUrl` removes userinfo, credential-like query parameters and non-route fragments before storage and in source keys | `packages/shared/src/urls.ts`; `tests/e2e/lifecycle.spec.ts` "capture provenance" | verified |
| C4.2 | T | Provenance is edited after capture | The update API accepts only `kind`, `color`, `userComment`, `priority` (`.strict()`); remote sync operations may not change immutable fields | `packages/shared/src/protocol.ts` (`HighlightPatch`); `packages/sync/src/policy.ts` | verified (API), in progress (sync) |
| C4.3 | T | An older build rewrites data written by a newer one | Writes are refused while any row carries an unknown `schemaVersion`; reads still work | `packages/storage/src/db.ts` (`assertNoNewerRows`); `packages/storage/src/versions.test.ts` | verified |
| C4.4 | D | Quota exhausted or database unavailable | Mapped to `quota_exceeded` / `storage_unavailable` and shown with a retry | `packages/storage/src/db.ts` (`toStorageError`) | verified |
| C4.5 | D | Data loss on crash or restart | Atomic transactions; hard-kill and restart tests | `tests/e2e/resilience.spec.ts` "a hard-killed browser loses nothing that was already confirmed to the user", "a full browser restart on the same profile keeps data" | verified |
| C4.6 | I | Data remains after the user asks to delete it | `wipeAllData`: database, `storage.local`, `storage.session` and site grants | `packages/storage/src/repo.ts`; `packages/storage/src/identity.test.ts`; `tests/e2e/pages.spec.ts` "options: delete all data" | verified |
| C4.7 | I | Another OS user, malware or backup software reads the profile directory | None at the extension level: IndexedDB and extension storage are not encrypted at rest by the extension | - | accepted (R7) |

### C5 - Backup, import and restore (TB5)

| ID | STRIDE | Threat | Mitigation | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| C5.1 | T | Malicious or corrupt backup damages existing data | Manifest and per-table checksums, Zod validation of every row, restore into staging with a dry-run report, one atomic commit, merges that refuse to overwrite provenance | `packages/backup/src/restore.ts`, `format.ts`, `merge.ts`; `packages/backup/src/roundtrip.test.ts` | verified (unit), in progress (UI) |
| C5.2 | D | Archive bomb or huge import | Hard limits (archive 1 GiB, 50,000 entries, row 8 MiB, 5,000,000 rows) and abort support | `packages/backup/src/format.ts` (`DEFAULT_RESTORE_LIMITS`) | verified (unit) |
| C5.3 | I | A backup file is read by someone else | Optional passphrase encryption (AES-256-GCM, PBKDF2-SHA-256); an unencrypted backup is documented as readable by anyone holding it | `packages/backup/src/crypto.ts`; PRIVACY_POLICY.md | verified (unit) |
| C5.4 | I | Secrets (provider key, sync tokens) end up in a backup | Backups walk the registered database tables only (`TableSpec`, with a `localOnly` flag); keys are meant to live in extension storage, outside any table. Nothing yet proves a planted key stays out of a backup | `packages/shared/src/registry.ts`, `packages/backup/src/export.ts` | in progress (O4) |

### C6 - PDF reader and OCR (TB5)

| ID | STRIDE | Threat | Mitigation | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| C6.1 | T/E | A crafted PDF exploits the parser or runs script | pdf.js runs in its bundled worker; the legacy build is used; no remote worker or data; the file is size-capped (300 MiB) | `packages/pdf/src/engine.ts`, `source.ts`, `assets.ts` | in progress (O7) |
| C6.2 | I | Fetching a web PDF leaks the user's cookies or bypasses a sign-in | Fetch from the extension page with `credentials: 'omit'`; a sign-in wall is reported, never bypassed | `packages/pdf/src/source.ts` | in progress |
| C6.3 | S | A crafted reader link makes the extension fetch an attacker's URL | Only plain https addresses without credentials are accepted; no cookies are sent; the attacker learns at most an IP address | `packages/pdf/src/readerUrl.ts` | in progress, accepted |
| C6.4 | I | OCR sends page images to a service | OCR is local WebAssembly (tesseract.js with bundled language data); no network | `packages/ocr` (OCR task) | in progress (O3) |

### C7 - AI provider channel (TB4, opt-in)

| ID | STRIDE | Threat | Mitigation | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| C7.1 | I | More leaves the device than the user approved | One `prepare()` builds both the preview and the request; consent is bound to a hash of the outbound text; limits on chunks and tokens; feature flag off by default | `packages/ai/src/prepare.ts`, `pipeline.ts`, `constants.ts`; `packages/ai/src/pipeline.test.ts` | verified (unit), in progress (UI) |
| C7.2 | I | Personal data or secrets are sent | Deterministic redaction of emails, numbers and secret-shaped strings with a user-editable preview; heuristic, so disclosed | `packages/ai/src/redact.ts`, `secrets.ts`; `packages/ai/src/redact.test.ts` | verified (unit), accepted (R11) |
| C7.3 | T | Prompt injection in saved text redirects the model, asks for keys or tools | Captured text appears only inside delimited data blocks in the user message, never in the system message; no tools; strict JSON output validated by Zod; citations must exist verbatim in the cited source; results are stored separately as `unverified` and need user acceptance | `packages/ai/src/prompt.ts`, `grounding.ts`, `schema.ts`; `packages/ai/src/tasks.test.ts` | verified (unit) |
| C7.4 | I | The API key leaks through logs, errors, redirects or referrers | Key lives only in the request closure; errors and logs are scrubbed; HTTPS only (loopback excepted); redirects are errors; `credentials: 'omit'`; `referrerPolicy: 'no-referrer'` | `packages/ai/src/providers.ts`, `secrets.ts`; `packages/ai/src/providers.test.ts` | verified (unit) |
| C7.5 | T | Provider output is trusted as fact | Labelled unverified, with a clinical notice where relevant; "externally verified" is never produced | `packages/ai/src/constants.ts` | verified (unit) |
| C7.6 | D | Runaway spend or hanging requests | Timeouts, retry caps, per-task output caps, estimated-token refusal | `packages/ai/src/budget.ts`, `constants.ts` | verified (unit) |

### C8 - Sync channel and server (TB4, opt-in)

| ID | STRIDE | Threat | Mitigation | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| C8.1 | S | Stolen session or token | Short-lived tokens, sign-out clears credentials, PKCE for sign-in | `packages/sync` (engine), server | in progress (O5) |
| C8.2 | T | Server or network attacker alters operations | TLS; AES-256-GCM authenticated envelopes when end-to-end encryption is on; idempotency keys; per-op validation; remote operations cannot change immutable fields | `packages/sync/src/schema.ts`, `merge.ts`, `policy.ts` | in progress |
| C8.3 | I | Server reads content or learns usage | End-to-end encryption option (operator cannot read payloads); entity type, ids and timestamps remain visible and are disclosed; server-accessible encryption is never called end-to-end | `packages/sync/src/schema.ts`; SECURITY_PRIVACY.md | in progress (O5) |
| C8.4 | T | Concurrent edits silently lose data | Hybrid-logical-clock merge; text conflicts kept as `ConflictRecord`; remove-wins sets | `packages/sync/src/merge.ts`, `hlc.ts` | in progress |
| C8.5 | I | Deleted data survives on the server | Tombstones and a documented deletion process | RELEASE.md, PRIVACY_POLICY.md | open (O5) |

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
| R8 | A provider key stored in extension storage is readable by local malware | Same as R7 | Documented; use a spending-limited key |
| R9 | Heuristic redaction can miss personal data in AI previews | Detection is pattern-based | The user reviews and edits the preview before anything is sent |
| R10 | Providers and sync operators handle data under their own policies | Outside the extension | Disclosed in the policy; both features opt-in |
| R11 | Vulnerabilities in pdf.js, tesseract.js, DOMPurify or React | Third-party code | Exact pins, advisory audit, SBOM; update cadence is an open item (O9) |
| R12 | A passage may be reported `ambiguous` or `orphaned` instead of highlighted | Correctness over coverage (ADR-004) | Listed under "Needs attention" in the side panel |
| R13 | `sidePanel.open` needs a user gesture, so "Save and add a note" can fail after a slow save | Chrome's gesture window | The overlay says so and the hand-over still works when the panel is opened by hand within 30 s |

## 6. Open items

| ID | Item | Owner | Blocks release? |
| --- | --- | --- | --- |
| O1 | Add an ESLint rule that bans `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `dangerouslySetInnerHTML` and `document.write` in product code (today only `eval` and `new Function` are banned) | shared ESLint config | no, but should land with Phase 2 |
| O2 | A test that renders hostile Markdown (script, `onerror`, `javascript:` links, SVG, nested HTML) through the notes renderer and asserts nothing active survives | notes / vault | yes, if Markdown rendering ships |
| O3 | Record every CSP or permission change the PDF, OCR, AI and sync work needs (`connect-src`, `wasm-unsafe-eval`, optional hosts) in an ADR; `scripts/check-build.mjs` and the listing must change in the same commit. Note that its `unsafe-eval` pattern also matches `wasm-unsafe-eval` | pdf / ocr / ai / sync | yes |
| O4 | Prove the AI key and sync credentials are excluded from backups, exports, sync and logs, with a test that greps a produced backup for a planted key | ai / backup | yes, if AI ships |
| O5 | Sync: sign-in flow (PKCE, state, token storage), key management and recovery, server tenant isolation, rate limits, deletion process and a server threat model | sync | yes, if sync ships |
| O6 | Extend the offline e2e test ("no request leaves loopback or the extension") to the new surfaces with AI and sync off: reader, review, import, export | e2e owners | yes |
| O7 | Set pdf.js `isEvalSupported: false` and confirm scripting stays disabled; add a test with a PDF that contains JavaScript and an embedded file | pdf | no |
| O8 | Manual screen-reader pass (NVDA, VoiceOver), Edge pass and forced-colors review: `docs/MANUAL_TEST_CHECKLIST.md` | release owner | yes for the first public release |
| O9 | Automated dependency updates (Dependabot or Renovate) and a policy for fixing `pnpm audit` findings; today the audit job is advisory | release owner | no |
| O10 | Build provenance attestation for the release zip (needs an attestation action pinned at release time) | release owner | no |
| O11 | A vulnerability disclosure channel: `SECURITY.md` and a monitored address | publisher | yes for the first public release |
| O12 | A repository `LICENSE` file; the repository is public and currently grants no licence | publisher | decision needed |
| O13 | Privacy policy hosting URL, support contact and legal review | publisher | yes |
