# ADR-006: Extension-owned PDF reader (`@pdf`, `entrypoints/pdf-reader`)

**Status:** accepted · **Date:** 2026-10-11 · Anchors: ADR-004 (text anchoring), ADR-005 (free text only in
extension origin). Schema: `PdfAnchorSet` in `packages/shared/src/schema.ts`.

## What this is, and what it is not
StudyVault annotates PDFs **only in its own reader page** (`pdf-reader.html`, an unlisted WXT page). It
does **not** inject into, extend or read Chrome's built-in PDF viewer: that is a protected internal
extension context (SECURITY_PRIVACY.md, "Protected browser contexts") and Chrome exposes no API for its
own annotations. Users get PDFs into the reader explicitly:

| Entry | How | Needs |
| --- | --- | --- |
| File picker, drag and drop | read locally in chunks (`file.stream()`), never uploaded | nothing |
| `?src=<https url>` | fetched **by the extension page**, no cookies (`credentials:'omit'`), no referrer | the single origin, requested with `permissions.request` from a click after an explanation |
| `?doc=<fingerprint>[&page=N][&highlight=ID]` | bytes from the user-approved stored copy (`getDocumentBytes`) | a stored copy |

`pdfReaderPath({src,doc,page,highlight})` in `@pdf/readerUrl` builds these addresses; it has no imports so
other surfaces (popup, side panel, dashboard) can use it without bundling pdf.js.

## pdf.js: legacy build, bundled locally
- **`pdfjs-dist/legacy/build/pdf.mjs` + `pdf.worker.min.mjs`, not the modern build.** The 6.x modern build
  calls `Promise.try`, `Map.prototype.getOrInsertComputed` and `Math.sumPrecise` natively (all newer than
  Chrome 120; the legacy build guards each with a core-js polyfill, the modern one does not). The extension
  minimum is Chrome 120. `Promise.withResolvers` (Chrome 119) is used raw and is inside the floor. The modern
  build would silently break on 120-127.
- **Worker:** `import workerSrc from '...pdf.worker.min.mjs?url&no-inline'` (Vite copies the file, hashed,
  into `assets/`; `GlobalWorkerOptions.workerSrc` points at it). `script-src 'self'` covers `worker-src`.
  `?no-inline` is required: Vite otherwise inlines files under 4 KB as `data:` URLs, which
  `connect-src 'self'` would then block (134 small files were inlined in the first build).
- **cMaps, standard fonts, wasm decoders** are served to the worker through a custom `BinaryDataFactory`
  (`useWorkerFetch:false`) that maps pdf.js file names to the hashed assets (`import.meta.glob`, `eager`).
  Nothing is fetched from a CDN. Verified in Chromium: a non-embedded Japanese CID font decodes through the
  bundled `UniJIS-UCS2-H` + `Adobe-Japan1-UCS2` cMaps, and the worker runs from the extension origin.
- **No eval.** The `isEvalSupported` option does not exist in 6.4.299; `grep` finds no `eval(` and no
  `new Function` in the legacy build or worker. The only dynamic code is `WebAssembly` (below).
- **Sizes** (built output, minified): reader page chunk 92 KB; pdf.js main-thread library 488 KB (loaded
  lazily when a document is opened); worker 1.32 MB; cMaps 1.5 MB in 169 files (168 emitted after content de-duplication) and standard fonts 0.8 MB in
  14 files (both fetched on demand); wasm decoders 0.35 MB (JBIG2, OpenJPEG). `assets/` total 3.9 MB.
  The `quickjs-eval` sandbox (form scripting, 469 KB) and `qcms` (ICC colour, 97 KB) are deliberately not
  shipped: `enableScripting` is never on, and `useWorkerFetch:false` already disables qcms.

## CSP and permissions (required changes, owned by `wxt.config.ts`)
Verified against the shipped manifest in Chromium:
1. `connect-src 'self'` **blocks** the `?src=` fetch ("violates ... connect-src 'self'"), whatever host
   permission exists. Needed: `connect-src 'self' https:`. Cannot be narrower: the origin is the user's.
   (The AI and sync tasks will add their own endpoints to the same directive.)
2. `script-src` has no `'wasm-unsafe-eval'`. JBIG2 and JPEG2000 images use WebAssembly; without the token
   `WebAssembly.instantiate` is refused, pdf.js tries its `*_nowasm_fallback.js` through `import()` of an
   un-hashed URL that is not bundled, and those images are expected to be skipped while the rest of the page renders
   (inferred from the pdf.js source; not exercised, there is no JBIG2/JPEG2000 fixture). Needed for scanned documents that use those codecs: `script-src 'self' 'wasm-unsafe-eval'`.
   That token is permitted for MV3 and is not remote code.
3. `optional_host_permissions: https://*/*` (already present) is what `permissions.request` uses. No
   install-time host access is added.

## Document identity
`id = sha-256(file bytes)` (hex, 64). `crypto.subtle.digest` has no incremental mode and the bytes are in
memory for pdf.js anyway, so the hash is one native call after a chunked read (progress, abort, size cap
300 MB). Above 512 MB the pdf.js fingerprint is used instead with a visible note (the reader cap makes this
unreachable today). The id is also `PdfAnchorSet.documentFingerprint` and the store's document id, so
re-opening the same file, from anywhere, re-attaches its highlights.

## Page text stream `sv-pdf-text-v1`
The anchor space is a derived string of **one page**; never `Selection.toString()`, never raw pdf.js item
order. Built from `getTextContent()` items and their transforms by `buildPageText`:

1. **Geometry.** Each non-empty item gets a quad (baseline origin lowered by 0.22 em, advance and up
   vectors) in the *raw page frame* (below). Items with a non-finite transform are dropped.
2. **Columns.** Boxes are shrunk by 0.25 em per side; an x-interval whose coverage is at most 20% of the
   page's text **rows**, that is at least 0.6 median font heights wide and has at least 15% of the boxes
   entirely on each side, is a gutter (the widest three are kept). Rows, not items, are counted so a page
   of word-level items behaves like one of line-level items. A box that contains a gutter midpoint is
   *full width* (title, caption, page number).
3. **Order.** Full-width lines split the page into bands; inside a band each column is read top to bottom;
   so the order is title, band 1 left, band 1 right, caption, band 2 left, ... Lines are clustered by
   vertical overlap (tolerance 0.6 of the smaller font height, so superscripts stay on their line) and read
   left to right (right to left when most items of the line report `dir:'rtl'`). The page is read as it is
   displayed by default (`/Rotate` applied), so a rotated scan reads top-to-bottom.
4. **Joining.** One space between items on a line when the gap exceeds 0.12 em (and neither side already
   has whitespace); one space between lines; a hyphen (`-`, U+00AD, U+2010) that ends a line after a letter
   and is followed by a lowercase letter on the next line is dropped and the halves are joined without a
   space ("docu-" / "ment" -> "document"). A genuinely hyphenated compound split exactly there is joined
   too: a heuristic, applied identically at capture and restore.
5. **Whitespace** is collapsed exactly as ADR-004 (`[\t\n\v\f\r NBSP]+` -> one space, leading dropped, no
   other normalisation). The stream's `contentSignature` is the cyrb53 hex of the text.

Every stream character maps back to `(item index, raw offset)` through `segments`, so selections convert
both ways. After pdf.js builds the text layer the reader **re-orders its spans into stream order**, so a
browser selection is contiguous in the stream and a drag in one column no longer runs into the other (pdf.js
leaves spans in content-stream order). `exactQuote` is the stream slice (trimmed), i.e. what the document
says, with hyphen joins applied.

## Anchor model
`PdfAnchorSet` (type `'pdf'`): `pageNumber`, `rotation` (display rotation when captured, informational),
`rects`, `textQuote{exact,prefix,suffix}` (32 characters of context each side), `textPosition` and
`documentTextLength` within the page stream, `contentSignature`, `textAlgorithm:'sv-pdf-text-v1'`,
`documentFingerprint`.

**Rect frame.** `rects` are 0..1 of the *raw page box* (`page.view`, viewport rotation 0), origin top-left,
one rect per visual line. That frame depends on the document alone, so a highlight is independent of zoom,
of the reader's rotation and of the page's own `/Rotate`. Display converts with `rotateRect(rect,
viewportRotation)`; capture converts browser client rects back with `unrotateRect`. At capture the
browser's own client rects of the selected text are used (exact to the glyph); geometry-derived rects
(`rectsForRange`, interpolated by character count) are the fallback and are used when an anchor resolves
somewhere other than where it was captured.

**Multi-page selections are explicitly restricted.** A highlight belongs to one page. A selection that
crosses pages is split at page boundaries; the save bar says so ("pages 4-5") and offers to save one
highlight per page. Nothing is merged or lost.

## Resolution on reopen (`resolvePdfAnchor`, never paints a wrong place)
1. Same `contentSignature` and the quote is at the stored offset -> `resolved`, method `position`
   (authoritative: this is what separates byte-identical repeated passages).
2. Otherwise find every exact occurrence of the quote (cap 200) and score each: context agreement
   (common suffix of prefix + common prefix of suffix over the stored context) x 0.8 plus proximity to the
   stored offset x 0.2.
   - one occurrence -> `resolved` (`quote`); a quote under 24 characters whose context both disagrees and
     whose position differs is `ambiguous` ("Figure 1" elsewhere);
   - several -> winner needs a score lead >= 0.15 and a context lead >= 0.1, or perfect context against a
     non-perfect runner-up (`context`); otherwise `ambiguous`.
3. No occurrence -> **rect proximity**: the items whose boxes overlap a stored rect by >= 30% give a
   slice of the stream; the quote inside it -> `changed` (`rects`, 0.9); a slice >= 0.9 similar -> `changed`;
   otherwise `orphaned`.

`ambiguous` and `orphaned` carry **no rects** and are never painted; the companion lists them with the
reason. A quote that changed is marked "Source changed", never silently re-bound.

## Rendering
- **Virtualisation.** One placeholder `<li>` per page (sized from page 1 until a page is drawn). An
  `IntersectionObserver` feeds `LazyPages`: visible pages plus one neighbour each side hold a canvas and a
  text layer; everything else is released (`canvas.width = 0`, `page.cleanup()`). A 150-page document keeps
  at most four canvases (checked in the browser).
- **Canvas** at `devicePixelRatio`, capped at 16.7 Mpx. **Text layer**: pdf.js `TextLayer` with a scoped
  copy of its CSS; it is laid out in the raw frame and rotated as a block by `data-main-rotation`; its size
  is set in plain px because pdf.js's `round()` sizing needs Chrome 125.
- **Overlay** per page: absolutely positioned percent rects (no recompute on zoom), `pointer-events:none`
  fill, an underline strip as the hit area, per-kind underline from `KIND_DECORATION` (solid, double,
  dashed, dotted, wavy x thickness) so colour is never the only cue; `forced-colors` and
  `prefers-contrast: more` have rules; selection and search matches have their own layers.
- **Search** runs over the same page streams (case-insensitive, whitespace-tolerant, 2,000 match cap),
  incrementally and cancellably, with a live count.

## Scanned and partial documents, OCR
`textStatus` (`text` | `scanned` | `partial`): up to 16 evenly spread pages are checked when a document is
opened (a page with fewer than 10 non-space characters has no text) and the verdict is refined, and
persisted, as other pages are viewed. The banner says what it means; pages without text carry a note.
`OcrPort {recognizePage, cancel}` is the seam to `@ocr`. Recognised words (stored through the vault's
`saveOcrPage`) stand in for the text of a page that has none: they are turned into pdf.js-shaped text items,
so selection, anchors and resolution run unchanged on OCR text, which is labelled "OCR text" wherever it
appears. **"OCR this document" is disabled, with the reason, until a recogniser is wired** in
`entrypoints/pdf-reader/ocr.ts`. The reader has no UI to correct OCR text yet.

## Failure handling
Password protected: a modal asks, retries on a wrong password, never stores it. Damaged or truncated:
`%PDF-` check, then pdf.js's `InvalidPDFException` -> a specific message. Web fetch: 401/403 (sign-in),
404/410, other HTTP errors, a redirect to HTML (named host), HTML or non-PDF content type, a cross-origin
redirect the extension has no access to (detected by a second `redirect:'manual'` request), CORS/CSP/offline,
size limit, abort. Each shows what happened and the **manual-upload fallback**; a sign-in wall never offers
"retry" and the reader never sends cookies or tokens.

## Persistence
`PdfStore` (`packages/pdf/src/store.ts`) is the port: `upsertDocument`, `getDocument`, `savePdfHighlight`,
`listPdfHighlights`, `updateHighlight`, `deleteHighlight` (+ optional `restoreHighlight`,
`cacheDocumentBytes`/`getDocumentBytes`/`removeDocumentBytes`, `saveOcrPage`/`getOcrPages`),
`listBanks`, `createBank`. `entrypoints/pdf-reader/store.ts` adapts `@storage`; tests use
`@pdf/testing/memoryStore`. PDF highlights are ordinary highlights whose source is the document; nothing
about them depends on the cached bytes.

## Known limitations
- No injection into, or reading of, Chrome's built-in viewer or its own annotations.
- Reading order is geometric: tables and slide layouts with aligned gaps are read column by column;
  vertical (`ttb`) text and mixed-direction lines are ordered by position only.
- Hyphen joining is a heuristic (see above). Ligatures are expanded by pdf.js's own normalisation.
- JBIG2/JPEG2000 images need the CSP change above; XFA forms, form scripting, optional-content toggles and
  annotation layers (links, widgets) are not rendered.
- Not verified here: Chrome 120-127 (only a current Chromium was available), Edge, `file://` PDFs, real
  screen readers, cMaps for every CJK encoding (one Japanese path was exercised).
