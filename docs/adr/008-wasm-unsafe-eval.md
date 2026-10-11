# ADR-008: `'wasm-unsafe-eval'` in the extension-pages CSP

**Status:** accepted · **Date:** 2026-10-11 · Supersedes the "no relaxation" note in ADR-003 for this one token.

## Context
Local OCR (`tesseract.js` core) and PDF.js decoders ship WebAssembly. Compiling a module needs
`'wasm-unsafe-eval'` in an MV3 extension page. Measured in real Chromium 156: under the previous CSP,
`createWorker` never settles; with the token it recognises text in ~110-170 ms warm.

## Decision
`extension_pages` CSP is `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; base-uri 'self';
connect-src 'self'; frame-src 'none'; form-action 'none'`.

- The token allows WebAssembly compilation only. `eval()`, `new Function()` and inline script remain
  blocked (`unsafe-eval` / `unsafe-inline` are rejected by `scripts/check-build.mjs`).
- It applies to extension pages, not to content scripts (which run under the page's own policy).
- The WebAssembly modules are first-party files copied from pinned, hash-verified packages
  (`scripts/copy-ocr-assets.mjs`, `packages/ocr/assets.manifest.json`); nothing is fetched at runtime.
- `connect-src 'self'` still forbids any network egress from extension pages.

## Consequences
The Web Store review sees the token; STORE_LISTING.md and THREAT_MODEL.md state why. If the OCR and PDF
features are removed, remove the token. The release gate regex was changed to allow exactly this token.
