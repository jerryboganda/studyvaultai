# Security, Privacy and Store Compliance

## Permissions principles
- Install-time permissions: `storage`, `sidePanel`, `contextMenus`, `activeTab`, `scripting`, plus the `commands` shortcuts. Nothing else is granted at install, and `host_permissions` is empty.
- Optional permissions, each requested from the click that needs it and never at install: `identity` (the sync sign-in window) and `alarms` (the sync timer) only when sync is switched on; per-origin host access for the AI endpoint, the sync server and issuer, and the origin of a PDF opened in the reader (handed back by the reader when the download ends, unless the person already had access to that site); site access for highlights (ADR-003). A per-origin grant for a feature is never read as site access: it does not inject the highlighter. `downloads` and `notifications` are not used.
- Access to arbitrary websites must be user-initiated per-site or optional all-sites access; do not require `host_permissions: <all_urls>` for functionality that works via activeTab and optional hosts.
- Permission explanations before requesting an elevated scope; revoke/deny must have useful fallback and no nagging.
- `file://` access and incognito need distinct user opt-ins and are disabled by default. Never auto-upload incognito content.
- The PDF reader applies the same rule as web capture: in a private window, or one it cannot identify (treated as private), it stores nothing (document row, highlights, recognised text, kept copy) unless private-window capture is allowed. The rule is enforced at the storage write path, not only on the reader's screens, and the setting is read at the moment of each write (docs/adr/006 amendment 2).
- Preserve a site-based deny list and ship a STARTER list of well-known sign-in, mail, payment, bank and health-portal hosts (never described as complete: banks differ by country and the user adds their own); no hidden passive scraping.

## Protected browser contexts
- Chrome built-in PDF viewer is a protected internal extension/document context: ordinary third-party content scripts cannot edit its internal PDF UI.
- Other internal pages (chrome:// and extension pages), some cross-origin iframe documents, DRM-protected content and browser-owned interfaces may be inaccessible. Respect these boundaries.
- Chrome introduced its own PDF annotations in February 2026, but does not thereby provide public third-party APIs for extracting/rehydrating those internal markup actions.

## Data policy
- Local-only by default with no account needed; explicit opt-in for AI transmission, cloud sync, telemetry, collaboration and backup provider.
- A request can leave the device by exactly three user-initiated paths: the reader downloading a web PDF (the host sees the IP address and the PDF address; credentials and referrer omitted), optional AI help (previewed text, consent-bound) and optional sync (a server the user supplies, plus its OIDC sign-in provider). The extension-pages CSP allows `connect-src https:` (docs/adr/009), so the CSP does not by itself enforce this: the feature switches, the consent token, the sign-in, the per-origin grant and the user's action do.
- Minimize capture: selected quote/source metadata by default; never silently read/upload entire articles or full browsing history.
- Retain source provenance, don't disguise a summary as quote, don't claim AI verification that did not occur.
- Sensitive sites and inputs never monitored; mask secrets and personally identifiable information on AI preview when feasible.
- User can export, wipe, inspect data, see storage consumption, exclude domains and configure retention.
- "Delete all data" removes the database (which also holds the worker's authoritative settings copy, the sync configuration and encryption decision, and the search index), the automatic pre-update copy and every restore staging database (full copies of the vault), `chrome.storage.local` and `chrome.storage.session` (settings, tokens, an unlocked sync key) and revokes the optional host grants. The database delete is requested first and is never abandoned: if another StudyVault window holds the database it waits and finishes by itself, and the other stores are cleared only after it has completed (docs/adr/010 amendment 2). It does not remove a sync server's copy (a separate control), exported files, the dashboard's two `localStorage` display preferences or the optional `identity` and `alarms` permissions (no fix is in the working tree; docs/PRIVACY_CLAIMS.md P15).
- Secrets live in the extension-origin database or in `chrome.storage.session`, never in `chrome.storage.local`, which content scripts can read and write: the AI key in IndexedDB `meta`; sync tokens (bound to the server, issuer and client id they were issued for) and the unlocked E2EE key (absolute 15-minute expiry) in `chrome.storage.session`, closed to content scripts explicitly. Anything that decides where tokens or the vault go, or what the worker lets through (the sync configuration and encryption decision, and the authoritative copy of the settings: deny list, private-window capture, feature flags), is read from IndexedDB, not from `chrome.storage.local` (docs/adr/010 amendment 1). Backups, the pre-update copy and sync never include the secrets (`meta` and `syncOps` are excluded). Where each setting lives: docs/adr/010-module-seams.md.
- Sources without an address (PDFs opened from a file, imported highlights) use a stand-in `studyvault.invalid` URL that is never shown, linked or indexed.
- Backup, restore and import treat every file as untrusted input: a ZIP's central directory is checked (no ZIP64, entry and size caps) before anything is decompressed; member names such as `__proto__` are refused on the parsed object graph; a merge never changes the provenance fields of a row the vault has (the sync policy's immutable list); restored AI results are re-grounded and only ever demoted; an import creates Sources of its own and never joins a captured one; one restore runs at a time, in a staging database of its own. A backup is not signed, so its checksums detect damage, not forgery (docs/PRIVACY_CLAIMS.md P26b to P26g; THREAT_MODEL R18).
- Purging an item removes what was derived from it in the same transaction (AI results that used it as any input, knowledge-point evidence, orphan sources, sync conflict, quarantine and never-delivered outbox copies). What a purge cannot reach is listed in THREAT_MODEL R14 and docs/PRIVACY_CLAIMS.md P16.
- Stored addresses are redacted by a name heuristic (credential words, whole-word names, a trailing `code`, the `x-amz-` and `x-goog-` families, in the query, in `;name=value` path parameters and in route fragments). It runs when an address is saved and is not retroactive (THREAT_MODEL R22).
- Cloud service privacy policy, precise data categories and disclosures are mandatory before public publishing.

## Browser extension security
- Strict Manifest V3 CSP; bundle all executable JavaScript, PDF.js workers, styles and model-processing code locally. No eval, dynamically loaded executable code or remote CDN scripts.
- Treat page HTML, filenames, URLs, imported Markdown, OCR, AI output and sync payloads as untrusted. Use escaped text nodes and vetted sanitizers for permitted rich text. Validate URLs and reject javascript:/data: schemes where unsafe.
- Typed, schema-validated extension messaging. Verify message sender origin/tab/frame, reject cross-site injected commands, implement least-authority RPC APIs.
- Never store commercial AI provider secret API keys in source, extension bundles or git. Prefer backend token exchange for public SaaS. User BYOK modes need explicit security warning, encryption limitations, and no logging.
- Auth: PKCE, state/nonces, short-lived tokens, safe refresh/session storage; secure cookie patterns for web dashboard if present.
- Optional sync: TLS, per-user authz, row-level tenant enforcement, signed object accesses, rate limits, audit, encrypted backups and durable deletion.
- E2EE: don't call server-accessible encryption 'end-to-end'; warn that AI processing of decrypted user-selected content requires separate consent (the encryption card says so; docs/PRIVACY_CLAIMS.md P25g). Nothing is uploaded until the person chooses a passphrase or explicitly chooses to upload without end-to-end encryption (the first-upload gate, P25a). Setting up or changing the passphrase re-sends this device's own state and never re-encrypts server-supplied plaintext as authentic (P25d; residual THREAT_MODEL R16), and a server that stops presenting the key profile cannot downgrade a device (P25c). The unlocked key survives worker suspension for at most 15 minutes in memory-only session storage and is dropped by lock, sign-out, disable, a restore that replaced the sync identity and Delete all (P25b); how real Chrome treats session storage there is not yet verified.
- No unauthorized scraping/copyright bypassing, content injection into privileged Chrome pages, abusive automated browsing, or privilege escalation.

## Exposures to page scripts (known, accepted, disclosed)
A web page is untrusted code running in the same document the extension annotates. Verified by review
and E2E (see docs/adr/004 and 005). What a page script on a site where StudyVault is active can learn:
- **Which passages are highlighted, where, and their kind/colour.** Highlights are painted through the
  document-level CSS Custom Highlight registry (`CSS.highlights`, names `sv-hl-<colour>-<kind>`, so the semantic kind such as weak_area or question is visible too), which is shared
  with the page's main world. A script can enumerate it and read each range's text. Mitigations: sites on
  the deny list (a starter list of common sign-in, mail, payment and bank sites, user-editable) are never painted; the registry holds
  only ranges of text that the page itself contains. Not mitigated: third-party scripts on a non-denied
  site can see the user's marks. Users should add sensitive sites to the deny list.
- **That StudyVault is installed**: the `<studyvault-overlay>` host element and an adopted stylesheet exist
  in the document while the content script runs.
- **Nothing the user types**: free text is entered only in extension-origin surfaces (ADR-005).
- A page can remove the overlay host or forge the content-script start event to switch StudyVault off
  *for that page*. It cannot trigger captures, read stored data, or reach the service worker's privileged
  RPCs; that is covered by `tests/e2e/permissions.spec.ts`.

## AI / prompt injection
- Treat captured webpage/PDF text strictly as untrusted data; refuse instructions embedded in sources that try to redirect the assistant, expose secrets, call tools, or change task policy.
- Give LLM only selected user-approved chunks and allowed tools. Keep citation retrieval deterministic and label unsupported output.
- Apply output JSON schema, field length limits, markdown sanitizer, URL allowlist, provider timeouts and user-controlled budgets.
- Medical/clinical study content: show 'study aid, verify against authoritative references'; store original quote and corrections; never silently assert clinical correctness.

## Publication readiness
- Verify latest Chrome Web Store policies and actual generated manifest permissions.
- Publish privacy policy and data use disclosures; request minimal scope for the declared single purpose.
- Do not use remote executable code, obfuscation, undocumented internal APIs or 'just inject everywhere' approach.
- Package icons/screenshots, listing description and clear PDF limitations; audit dependencies and licenses.

## Reviewed findings and accepted limitations (2026-10-11, second pass)
Detail, tests and residual risks: THREAT_MODEL.md section 7 (ids SR-1 and on) and the risks R14 to R23.
Every status below is "mitigated in the working tree, unit or integration tested, no CI run, not
exercised in a loaded Chrome"; none is a claim of verification.

| Finding | Mitigation | Residual risk, accepted |
| --- | --- | --- |
| SR-1 provenance overwrite via merge restore | merge keeps the sync policy's immutable fields of an existing row (`packages/storage/src/restoreGuards.ts`, `packages/backup/src/merge.ts`) | R18: replace and new rows are taken as given; backups are unsigned |
| SR-2 ZIP64 / entry-count archive bomb | central directory checked before anything is read (`packages/backup/src/format.ts`) | none known beyond the limits |
| SR-3 privileged configuration in content-script-writable storage | IndexedDB `meta` and `getTrustedSettings` (ADR-010 amendment 1) | R17: display copy and two extension-side gates |
| SR-4 E2EE laundering at setup and rotation | audit, re-send own state, replace the unauthenticated (`packages/sync/src/engine.ts`) | R16: a policy-valid edit in a plaintext log |
| SR-5 plaintext first upload | pull-only until an explicit choice | the disclosed plaintext choice |
| SR-6 key lifetime (worker suspension) | session-storage key vault with absolute expiry | R23; Chrome behaviour unverified |
| SR-7 server downgrade | key-profile marker and refusal | recovery needs server deletion |
| SR-8 consent text and AI-after-decryption note | generated from the policy; note on the card | none |
| lows (SR-L1 to SR-L12) | member-name guard, own-Source imports, exclusive restore, AI re-grounding, linear parsers, private-window reader, grant hand-back, purge scope, wipe lifecycle, redaction, pre-update copy, integrity fixes | R14, R15, R19 to R22 |

Accepted limitations, by change: PDF reader privacy (R19, a real private window is not automated, an
unidentifiable window saves nothing); redaction and purge (R14, R22); search index (R15, one opaque
token row after a wipe); database lifecycle (R20, R21); sync (R16, R17, R23, a re-key is a one-time
moment of trust in the plaintext history, no key recovery).
