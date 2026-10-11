# Security, Privacy and Store Compliance

## Permissions principles
- Install-time permissions: `storage`, `sidePanel`, `contextMenus`, `activeTab`, `scripting`, plus the `commands` shortcuts. Nothing else is granted at install, and `host_permissions` is empty.
- Optional permissions, each requested from the click that needs it and never at install: `identity` (the sync sign-in window) and `alarms` (the sync timer) only when sync is switched on; per-origin host access for the AI endpoint, the sync server and issuer, and the origin of a PDF opened in the reader; site access for highlights (ADR-003). A per-origin grant for a feature is never read as site access: it does not inject the highlighter. `downloads` and `notifications` are not used.
- Access to arbitrary websites must be user-initiated per-site or optional all-sites access; do not require `host_permissions: <all_urls>` for functionality that works via activeTab and optional hosts.
- Permission explanations before requesting an elevated scope; revoke/deny must have useful fallback and no nagging.
- `file://` access and incognito need distinct user opt-ins and are disabled by default. Never auto-upload incognito content.
- Preserve a site-based deny list and ship a STARTER list of well-known sign-in, mail, payment, bank and health-portal hosts (never described as complete: banks differ by country and the user adds their own); no hidden passive scraping.

## Protected browser contexts
- Chrome built-in PDF viewer is a protected internal extension/document context: ordinary third-party content scripts cannot edit its internal PDF UI.
- Other internal pages (chrome:// and extension pages), some cross-origin iframe documents, DRM-protected content and browser-owned interfaces may be inaccessible. Respect these boundaries.
- Chrome introduced its own PDF annotations in February 2026, but does not thereby provide public third-party APIs for extracting/rehydrating those internal markup actions.

## Data policy
- Local-only by default with no account needed; explicit opt-in for AI transmission, cloud sync, telemetry, collaboration and backup provider.
- Minimize capture: selected quote/source metadata by default; never silently read/upload entire articles or full browsing history.
- Retain source provenance, don't disguise a summary as quote, don't claim AI verification that did not occur.
- Sensitive sites and inputs never monitored; mask secrets and personally identifiable information on AI preview when feasible.
- User can export, wipe, inspect data, see storage consumption, exclude domains and configure retention.
- "Delete all data" removes the database, the automatic pre-update copy and the staging area of an interrupted restore (both are full copies of the vault), settings, session state, and revokes the optional host grants.
- Secrets (the AI key) live in the extension-origin database, not in `chrome.storage.local`, which content scripts can read; sync tokens live in `chrome.storage.session`. Backups, the pre-update copy and sync never include them (`meta` and `syncOps` are excluded). Where each setting lives: docs/adr/010-module-seams.md.
- Sources without an address (PDFs opened from a file, imported highlights) use a stand-in `studyvault.invalid` URL that is never shown, linked or indexed.
- Cloud service privacy policy, precise data categories and disclosures are mandatory before public publishing.

## Browser extension security
- Strict Manifest V3 CSP; bundle all executable JavaScript, PDF.js workers, styles and model-processing code locally. No eval, dynamically loaded executable code or remote CDN scripts.
- Treat page HTML, filenames, URLs, imported Markdown, OCR, AI output and sync payloads as untrusted. Use escaped text nodes and vetted sanitizers for permitted rich text. Validate URLs and reject javascript:/data: schemes where unsafe.
- Typed, schema-validated extension messaging. Verify message sender origin/tab/frame, reject cross-site injected commands, implement least-authority RPC APIs.
- Never store commercial AI provider secret API keys in source, extension bundles or git. Prefer backend token exchange for public SaaS. User BYOK modes need explicit security warning, encryption limitations, and no logging.
- Auth: PKCE, state/nonces, short-lived tokens, safe refresh/session storage; secure cookie patterns for web dashboard if present.
- Optional sync: TLS, per-user authz, row-level tenant enforcement, signed object accesses, rate limits, audit, encrypted backups and durable deletion.
- E2EE: don't call server-accessible encryption 'end-to-end'; warn that AI processing of decrypted user-selected content requires separate consent.
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
