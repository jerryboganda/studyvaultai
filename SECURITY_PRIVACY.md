# Security, Privacy and Store Compliance

## Permissions principles
- Primary path: `activeTab`, `scripting` only where needed, `contextMenus`, `storage`, `sidePanel`, `commands`, and optionally `alarms`, `downloads`, `notifications` when their features exist.
- Access to arbitrary websites must be user-initiated per-site or optional all-sites access; do not require `host_permissions: <all_urls>` for functionality that works via activeTab and optional hosts.
- Permission explanations before requesting an elevated scope; revoke/deny must have useful fallback and no nagging.
- `file://` access and incognito need distinct user opt-ins and are disabled by default. Never auto-upload incognito content.
- Preserve site-based deny list for banks, payment pages, mail and health records, auth providers; no hidden passive scraping.

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
