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
   Sync additionally needs the optional permissions `identity` (sign-in window) and `alarms` (sync
   timer), requested from the click that turns sync on.
4. `http:` is accepted only for loopback; the AI and sync clients reject other `http:` URLs themselves.
5. Secrets are never logged and never in cache keys (tested in `@ai`). Where they live: the AI API key
   is the IndexedDB `meta` row `aiKey` (left out of every export, backup and snapshot); the sync
   configuration is in IndexedDB `meta`; the sync key is held as a JWK in `chrome.storage.session`
   (memory only) and locks after 15 minutes (`KEY_LOCK_MS`, `entrypoints/background/sync.ts`).

## Consequences
- The "CSP forbids all egress" claim is gone; privacy documents say "egress happens only when you turn
  AI or sync on, only to the endpoint you set, and only after consent".
- `scripts/check-build.mjs` pins the token set exactly and rejects `http(s):` in every other directive.
- An XSS in an extension page would need script execution first, which `script-src 'self'` blocks.

## Amendment (2026-10-11): the full extension-pages policy, and the three egress paths

**Correction.** The Context above says core features, PDF/OCR included, "make no network request". One
path does: opening a PDF **from a web address** (`?src=` in the reader, or "Open in StudyVault reader"
from the menu) is fetched by the reader's extension page (`packages/pdf/src/source.ts`: `credentials:
'omit'`, `referrerPolicy: 'no-referrer'`, https or http on loopback only, a redirect may end only on the
asked-for or an already-granted origin), after the user grants that origin as an optional host
permission. Capture, banks, search, review, backup, opening a file from disk and local OCR make no
request (tesseract starts with `workerBlobURL: false` and reads only `/ocr/*` extension files).

The user-initiated egress paths are therefore exactly three. Each starts from a user action and needs a
per-origin optional host permission; the first two also need their feature switch (default off).

| Path | Runs in | Sends | Extra gate |
| --- | --- | --- | --- |
| Optional AI call (`@ai`, `@ui/ai/runtime`) | an extension page | the previewed, redacted text to the endpoint the user set | `features.ai`, a `ConsentToken` bound to the exact payload |
| Optional sync (`@sync`, `entrypoints/background/sync.ts`) | the service worker | the user's data to the sync host; sign-in, token and revocation calls to the OIDC provider | `features.sync`, sign-in, optional `identity` and `alarms` |
| PDF from a web address (`packages/pdf/src/source.ts`) | the reader page | nothing but the GET: no cookies, no referrer, no study data; the host sees the IP and the address | the click that opens it |

**Final policy** (`wxt.config.ts`; pinned directive by directive by `scripts/check-build.mjs` and
`tests/e2e/permissions.spec.ts`):

```
default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:;
font-src 'self'; connect-src 'self' https: http://localhost:* http://127.0.0.1:*; worker-src 'self';
media-src 'none'; manifest-src 'none'; object-src 'none'; base-uri 'self'; frame-src 'none';
form-action 'none'
```

- `connect-src` is the only directive wider than `'self'`, for the three paths above. `http:` is loopback
  only (local models, dev servers, the e2e fixtures).
- `style-src 'self'` has **no** `'unsafe-inline'`. React and pdf.js style elements through the CSSOM
  (`element.style`), which CSP allows; only `<style>` elements and `style="..."` markup are refused. The
  built HTML has neither (the gate checks), and every extension page loaded with zero violations.
- `img-src` allows `data:` for one thing: the PDF reader's wavy-underline mask, an inline SVG in
  `entrypoints/pdf-reader/reader.css`. Without it the mask image is refused and the "exception" kind's
  wavy underline is not drawn as designed. No `blob:` image is created anywhere (page canvases and
  thumbnails are `<canvas>`).
- `worker-src 'self'`: the pdf.js worker and the tesseract worker are extension files. `font-src`,
  `media-src` and `manifest-src` follow from there being no web fonts, audio or manifest links.
- `object-src` is `'none'` (was `'self'`): no `<object>`/`<embed>` is used. `default-src 'self'` makes
  every fetch directive not listed above fall back to the extension itself.
- Dev server only: `wxt.config.ts` drops `default-src`, `style-src`, `img-src`, `font-src` and
  `worker-src` when the command is `serve`, because Vite injects `<style>` tags and serves workers and
  assets from `http://localhost:PORT`. This cannot reach a build, whose policy is pinned.

**Known limitation.** Chromium accepts `new Worker(blobUrl)` under `worker-src 'self'` (observed in the
Chromium bundled with Playwright 1.64, the one ADR-008 measured: a blob worker created from an
extension page runs). Loading *script* from `blob:` (`import()`, `<script src>`) and `eval` /
`new Function` are refused. A blob worker is a way to run a string as code, but only for code that
already executes in the extension origin, which is what `script-src 'self'` exists to prevent. `'self'`
is the narrowest source that still admits the pdf.js and tesseract workers, so the manifest cannot close
this. The code avoids blob workers by choice (`workerBlobURL: false`). Read "extension pages cannot
evaluate strings" as true of `eval` and `Function`, not of workers.

**Enforcement is tested, not assumed.** A CSP that fails Chrome's validation is silently replaced by
the default policy, so `tests/e2e/pages.spec.ts` ("extension pages: content security policy") asserts on
a real extension page that an inline `<style>`, a `style` attribute, a remote image, audio and frame,
`http:` to a non-loopback host, `eval` and a blob script are each refused with the expected directive,
and that CSSOM styles, a `data:` image and `WebAssembly.compile` still work; and that all seven
extension pages load with no `securitypolicyviolation`.
