# ADR-009: Network egress for the optional AI and sync features

**Status:** accepted · **Date:** 2026-10-11 · Refines ADR-003 and ADR-008.

## Context
Core features (capture, banks, search, review, backup, PDF/OCR) make **no network request**. Two optional
features must: AI tasks call a model endpoint, and sync talks to a server. Both endpoints are chosen by
the user (their own provider, a local Ollama, their own sync host), so they cannot be listed in a static
manifest CSP. The service worker and every extension page are governed by `extension_pages` CSP, and
`connect-src 'self'` made those calls impossible.

## Decision
`connect-src 'self' https: http://localhost:* http://127.0.0.1:*`. Everything else in the policy stays
strict (`script-src 'self' 'wasm-unsafe-eval'`, `object-src 'self'`, `frame-src 'none'`,
`form-action 'none'`; no inline script, no `unsafe-eval`).

Egress is gated in code, not by the CSP alone:
1. `Settings.features.ai` / `features.sync` default OFF; nothing runs, schedules or fetches while off.
2. AI: no request without a `ConsentToken` bound to the exact previewed payload (`@ai`); redaction first.
3. A per-origin **optional host permission** is requested from a user gesture for the configured endpoint.
4. `http:` is accepted only for loopback; the AI and sync clients reject other `http:` URLs themselves.
5. Keys are held in extension storage, never logged, never in cache keys (tested in `@ai`).

## Consequences
- The "CSP forbids all egress" claim is gone; privacy documents say "egress happens only when you turn
  AI or sync on, only to the endpoint you set, and only after consent".
- `scripts/check-build.mjs` pins the token set exactly and rejects `http(s):` in every other directive.
- An XSS in an extension page would need script execution first, which `script-src 'self'` blocks.
