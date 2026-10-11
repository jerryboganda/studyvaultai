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

## Amendment (2026-10-11): what the token does in the final policy

The policy string in the Decision above is superseded: `connect-src` and the other fetch directives
changed in ADR-009 and its amendment, which holds the current, pinned string. This ADR's own claims are
unchanged and were re-observed in a real extension page: `WebAssembly.compile` succeeds; `eval()` and
`new Function()` throw `EvalError` and raise a `script-src` violation; script from a `blob:` URL is
refused. `'wasm-unsafe-eval'` appears only in `script-src`. "The release gate regex was changed" is also
out of date: `scripts/check-build.mjs` now compares the parsed policy with a table, directive by
directive, and rejects `'unsafe-eval'` anywhere and `'unsafe-inline'` outside `style-src` (it is nowhere
today).
