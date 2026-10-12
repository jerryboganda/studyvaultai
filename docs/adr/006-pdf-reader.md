# ADR-006: Extension-owned PDF reader (`@pdf`, `entrypoints/pdf-reader`)

**Status:** accepted · **Date:** 2026-10-11 · Anchors: ADR-004 (text anchoring), ADR-005 (free text only in
extension origin). Schema: `PdfAnchorSet` in `packages/shared/src/schema.ts`.
**Amended 2026-10-11 (wiring task):** OCR engine wired with correction UI and the OCR text stream; outline,
thumbnails, document properties and stored-copy manager; context-menu entry; web-open hardening; drag
selection fix. Amendments are folded into the sections below.
**Amendment 2 (2026-10-11, privacy hardening)** is appended at the end: the private-window rule
(`?incognito=1`), the per-origin grant lifecycle, the `redirect-needs-access` failure and the
redirect rule. **Amendment 3 (2026-10-12, links)** follows it: link annotations are clickable, safely.
**Amendment 4 (2026-10-12, sideways scans and the text-layer rule)**: a scan stored sideways or upside down
is read by turning it, and a page's text is selectable only once its layer is complete. **Amendment 5
(2026-10-12, reading recognised pages again)** closes the document: "Re-recognise" for a page and for the
whole document, with the one step back. Where an amendment differs from a section above, the amendment
wins.

## What this is, and what it is not
StudyVault annotates PDFs **only in its own reader page** (`pdf-reader.html`, an unlisted WXT page). It
does **not** inject into, extend or read Chrome's built-in PDF viewer: that is a protected internal
extension context (SECURITY_PRIVACY.md, "Protected browser contexts") and Chrome exposes no API for its
own annotations. **A PDF that Chrome opens in its own viewer is therefore never instrumented**; the reader's
open screen says so and says how to get such a PDF into the reader. Users get PDFs into the reader
explicitly:

| Entry | How | Needs |
| --- | --- | --- |
| File picker, drag and drop | read locally in chunks (`file.stream()`), never uploaded | nothing |
| `?src=<https url>` (or `http://localhost`, `http://127.0.0.1`) | fetched **by the extension page**, no cookies (`credentials:'omit'`), no referrer | the single origin, requested with `permissions.request` from a click after an explanation |
| `?doc=<fingerprint>[&page=N][&highlight=ID]` | bytes from the user-approved stored copy (`getDocumentBytes`) | a stored copy |
| Context menu **Open in StudyVault reader** | on a link, page or frame whose address looks like a PDF; opens `pdf-reader.html?src=...` in a new tab | nothing (the reader asks for the origin itself) |
| Stored copies list on the open screen | opens a kept copy by its id, shows sizes, removes copies | a stored copy |

`pdfReaderPath({src,doc,page,highlight})` and `isLikelyPdfUrl(url)` in `@pdf/readerUrl` build and recognise
these addresses; the module has no imports so other surfaces (popup, side panel, dashboard, the service
worker) can use it without bundling pdf.js. `isLikelyPdfUrl` reads the address text only: http(s), a path
ending `.pdf`, an arXiv-style `/pdf/<id with a digit>`, or a query that says so (`?file=a.pdf`, `?pdf=render`,
`format=pdf`). It is a hint; the reader checks the bytes.

**The menu** (`entrypoints/background/pdf.ts`) is two items with the same title, because the menus API has
two filters: a *link* item filtered on `targetUrlPatterns` and a *page/frame* item filtered on
`documentUrlPatterns` (a document filter on a link item would hide it on every non-PDF page). The patterns
are the path-based part of `isLikelyPdfUrl` for https and loopback http only (the addresses the reader
accepts); the click handler runs `isLikelyPdfUrl` again, uses the **tab's** address for a page and the
frame's for a frame, and opens the reader in a new tab. Created on `runtime.onInstalled` (each id is removed
first, so it is idempotent); the click listener is registered at the worker's top level. Whether Chrome
shows extension items inside its own PDF viewer's context menu was not verified: the reliable route is the
link item or the reader's own open panel.

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
- **OCR is lazy.** After the wiring task the reader's initial chunk is 127 KB (92 KB before: outline,
  thumbnails, properties, correction UI). `@ocr/engine` (6 KB), `@ocr/runner` (3 KB) and the tesseract.js
  wrapper (17 KB) are separate chunks loaded by the first "OCR" click; the engine's worker, wasm core and
  language data (5.9 MB) are `ocr/` files fetched by the worker then, and are budgeted separately by
  `scripts/check-build.mjs` (7 MB). Opening a PDF that has text loads none of it.

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
- **Drag selection (fixed in the wiring task).** The empty `endOfContent` element that ends the text layer
  covers the layer while the pointer is down. With the spans at `z-index: auto` it sat ON TOP of them and a
  real mouse drag selected nothing (programmatic selections worked, which is why it went unseen). Spans now
  have `z-index: 1`, and `guardSelection` (pageView.ts) keeps the element right after the selection's moving
  end as pdf.js does. Covered by a real-mouse drag across a wrapped line in `tests/e2e/pdf.spec.ts`.
- **Navigation pane** (collapsible, toolbar "Outline and pages"). *Outline*: `PdfDocument.getOutline()`
  flattens the bookmarks (pre-order, depth <= 8, <= 2,000 entries, titles cleaned and cut at 300) and
  resolves each destination to a page and a height; the section in view is marked `aria-current`. *Pages*:
  one button per page; each thumbnail is drawn only while it is within 300 px of the pane's viewport and
  released when it leaves (a 1,000-page file costs a few small canvases).
- **Heading context.** A highlight's `headingContext` is the nearest outline entry above the selection:
  on the selection's page the entry whose destination height is nearest above the selection's top, else the
  last entry of the closest earlier page (`headingFor`, outline.ts). Cut to 300 characters; null when the
  file has no outline. It is shown on the card as "Section: ...".
- **Properties and stored copy.** A disclosure under the title lists title, pages, size, source, text status
  (with the scanned and OCR page counts), the first 12 digits of the fingerprint and the stored-copy state.
  Keeping or removing the copy shows its size; the open screen lists every kept copy (`listStoredCopies`,
  from the vault's `listDocuments`) with sizes and a total. Removing a copy never touches highlights, notes
  or recognised text.

## Scanned and partial documents, OCR
`textStatus` (`text` | `scanned` | `partial`): up to 16 evenly spread pages are checked when a document is
opened (a page with fewer than 10 non-space characters has no text) and the verdict is refined, and
persisted, as other pages are viewed. The banner says what it means; pages without text carry a note.

**Engine and job.** `@ocr` (tesseract.js in a dedicated worker; wasm and language data bundled under
`ocr/`, nothing fetched). `entrypoints/pdf-reader/ocr.ts` returns an `OcrService` that imports
`@ocr/engine` and `@ocr/runner` lazily (submodules, not the package index, so `engine.ts` is not in the
reader's initial chunk; tesseract.js itself is a third lazy chunk). `runOcrJob` does the work: one page at a
time, each saved as soon as it is recognised (`OcrJobStore` adapter over the vault's
`saveOcrPage`/`getOcrPages`), pages already stored are skipped (resume), one retry for a crash or
out-of-memory, cancellation terminates the worker. Pages are rendered at **300 dpi capped at 9 Mpx in the
orientation the page is shown in by default** (a sideways scan with `/Rotate 90` is upright for the
engine) and the engine is told that rotation, so word boxes come back in the raw page frame anchors use.

**Actions.** "OCR this document" and "OCR page N" (banner; "OCR this page" also in the *Page text* tab)
are enabled when the document is scanned or partial and the engine exists; otherwise they are disabled
with the reason. A status line and a `<progress>` show "finding pages", then per-page phases ("Preparing
page 3 (2 of 4)", "Starting the text recogniser (first page only)", "Recognising", "Saving"); **Cancel**
stops it for real. The outcome is shown until dismissed and uses the engine's error taxonomy:
`asset-missing`, `wasm-unsupported`, `out-of-memory`, `cancelled`, `failed` each have their own sentence;
a run that read some pages and failed others is "partial" and says which code and page. In a private
window without consent the recognised text is kept for the session only (nothing is written).

**The stream choice: `sv-ocr-text-v1` on OCR pages.** A page whose text comes from OCR is NOT run through
the PDF geometric reading-order algorithm. Its anchor space is the OCR stream of `@ocr`
(`buildPageTextStream`): the recogniser's words in its own reading order, **after the person's
corrections**, joined by exactly one space, no hyphen repair, no case folding. `buildOcrPageText`
(`packages/pdf/src/ocr.ts`) presents that stream as a `PageText`, so selection, search, rectangles and
resolution run unchanged; the text layer is one span per word on the word's box. `PageText.algorithm`
says which stream built a page.

**Recording that an anchor is OCR-derived.** `PdfAnchorSet.textAlgorithm` is the literal
`'sv-pdf-text-v1'` (shared schema, not changed here), so the marker is the stream's signature:
`contentSignature = 'ocr1:' + cyrb53hex(text)` (19 characters, inside the 32 allowed). `isOcrSignature`
tells; the companion and the save bar label such highlights "OCR text". Consequences, all in
`resolvePdfAnchor` unchanged: an anchor whose signature equals the page's current one is positioned by
offset; after a correction or a re-run the signature differs, so the stored offset is not trusted and the
anchor is found by quote and context, else by the rectangles it covered (`changed`, "Source changed"),
else `ambiguous`/`orphaned` and not painted. A correction **never edits `exactQuote`**; it changes the
stream used by selection, search and *future* anchors. If the schema later admits `'sv-ocr-text-v1'` as a
`textAlgorithm`, only `buildPdfAnchor` changes (one line) and old anchors keep resolving by the prefix.

**Storage of corrections.** The vault row keeps `text` (the recogniser's lines joined by a line feed, never
edited), `words` (normalised box, text, confidence 0..1) and one `correctedText`. The reader rebuilds lines
from `text` (falling back to box geometry for rows stored without line feeds) and writes the corrected text
as the same lines, one per recognised line; lines that differ are the corrections. So "revert line" and
"revert page" are exact and a re-run could be diffed. Corrections are per **line** (the unit the UI edits).

**Correction UI** (*Page text* tab): the lines of the page in view, each with its mean confidence **in words**
(high 85% and above, medium 60-84%, low below 60%), words shaded by band with a text legend and
screen-reader text after every marked word, "Edit line N" (an input; Enter saves, Escape cancels), the
recognised text shown beside an edited line, "Revert line N", "Revert all corrections on this page", and
the notice that the text is machine-recognised and may be wrong.

## Failure handling
Password protected: a modal asks, retries on a wrong password, never stores it. Damaged or truncated:
`%PDF-` check, then pdf.js's `InvalidPDFException` -> a specific message. Web fetch: 401/403 (sign-in),
404/410, other HTTP errors, a redirect to HTML (named host), an HTML response at a `.pdf` address ("a web
page (text/html)"), other non-PDF content types, a cross-origin redirect the extension has no access to
(detected by a second `redirect:'manual'` request), **offline** (`navigator.onLine === false`, reported as
offline rather than CORS), CORS/CSP, size limit (300 MB), abort. A PDF is recognised by content type
`application/pdf` or `octet-stream` plus the `%PDF-` header, not by the address, so `/download?id=7` works.
Each shows what happened, a specific next step, and the **manual-upload fallback**; failures that cannot
change (sign-in, redirect to a page, not found, not a PDF, too large) never offer "retry", and the reader
never sends cookies, tokens or a referrer (`credentials:'omit'`, `referrerPolicy:'no-referrer'`): there is
no authentication bypass. The permission is requested for the one origin, from the click, after the
explanation; `http:` is accepted only for `localhost` and `127.0.0.1` (what the CSP already allows, ADR-009).

## Persistence
`PdfStore` (`packages/pdf/src/store.ts`) is the port: `upsertDocument`, `getDocument`, `savePdfHighlight`,
`listPdfHighlights`, `updateHighlight`, `deleteHighlight` (+ optional `restoreHighlight`,
`cacheDocumentBytes`/`getDocumentBytes`/`removeDocumentBytes`, `listStoredCopies`,
`saveOcrPage` (with `correctedText`)/`getOcrPages`),
`listBanks`, `createBank`. `entrypoints/pdf-reader/store.ts` adapts `@storage`; tests use
`@pdf/testing/memoryStore`. PDF highlights are ordinary highlights whose source is the document; nothing
about them depends on the cached bytes.

## Known limitations
- No injection into, or reading of, Chrome's built-in viewer or its own annotations. The context menu is
  the only route from a Chrome-viewer tab; `file://` PDFs are not offered (the extension has no file access).
- OCR: English only (the bundled language data); one engine run at a time; corrections are per line, not per
  word; there is no "remove recognised text" action yet (the model supports it; "re-run" exists since
  Amendment 5); the text of an edited line is shown without per-word confidence shading; vertical and
  right-to-left scripts are not tuned. Scans stored sideways or upside down are turned to be read:
  Amendment 4 states what that does and does not cover.
- Highlights saved on OCR text and then affected by a correction are listed as "Source changed", not
  re-bound (by design).
- Reading order is geometric: tables and slide layouts with aligned gaps are read column by column;
  vertical (`ttb`) text and mixed-direction lines are ordered by position only.
- Hyphen joining is a heuristic (see above). Ligatures are expanded by pdf.js's own normalisation.
- JBIG2/JPEG2000 images need the CSP change above; XFA forms, form scripting, optional-content toggles and
  annotation layers other than links (widgets, stamps, free text) are not rendered. Links: Amendment 3.
- Not verified here: Chrome 120-127 (only a current Chromium was available), Edge, `file://` PDFs, real
  screen readers, cMaps for every CJK encoding (one Japanese path was exercised).

## Amendment 2 (2026-10-11): private windows, the grant lifecycle and redirects

**Status:** accepted · Refines "What this is" (the `?src=` row and the context menu), "Failure
handling" and "Persistence". Tests are unit and integration tests (written without a CI run; the `unit` job
of Actions run 38139836238 has since executed them and passed) and the e2e specs named below, which passed
in the same run, the `test.fixme` one excepted (it was skipped; docs/PRIVACY_CLAIMS.md P1a to P1d, P10a).

### Private windows (`?incognito=1`)
The database is shared with normal windows, so a reader in a private window stores nothing unless
"Save from private windows" is on (`settings.allowIncognitoCapture`, SECURITY_PRIVACY.md).

- **The window is asked, not assumed.** `detectWindowPrivacy(hint)` in
  `entrypoints/pdf-reader/privacy.ts`: `?incognito=1`, or `extension.inIncognitoContext`, answers
  `private`; otherwise `tabs.getCurrent().incognito`, then `windows.getCurrent().incognito`
  (neither needs the `tabs` permission); when nothing answers the result is `unknown`, which is
  treated exactly like `private`. Any source that says private wins. `extension.inIncognitoContext`
  is not the answer: Chrome sets it for extension pages only in split-mode extensions and this one
  spans, so it is always false. One answer per page load (`onceWindowPrivacy`).
- **`?incognito=1`** is built by `pdfReaderPath({ incognito: true })` (`@pdf/readerUrl`) from the
  context-menu handler for a private tab (`entrypoints/background/pdf.ts`, `readerPathFor`, from
  `tab.incognito`) and read by `parseReaderParams` only when it is exactly `1`. It can only make the
  reader more careful. The popup and the side panel do not add it: the reader asks for itself.
- **Enforced twice.** On the reader's screens (`writePolicy`: `openSession` receives `persist`; the
  reader says "Nothing is being saved" with the reason; saving a highlight and keeping a copy are
  disabled with it) and at the storage write path: `main.tsx` registers `setPdfWriteRestriction`
  from `@storage`, and `assertPdfWriteAllowed` runs first in `upsertDocument`, `savePdfHighlight`,
  `cacheDocumentBytes` and `saveOcrPage`. The setting is read at the moment of each write, so
  turning it on or off applies to an open reader without a reload; a restriction or settings read
  that fails refuses the write. Reading, deleting, removing a kept copy and clearing recognised text
  stay possible; the service worker, imports and tests register no restriction.
- Tests: `entrypoints/pdf-reader/privacy.test.ts`; `packages/storage/src/pdf.private.test.ts`;
  `entrypoints/pdf-reader/Reader.test.tsx` "Reader: what is saved depends on the window";
  `packages/pdf/src/source.test.ts` "reader address: private opener"; `tests/e2e/pdf.spec.ts`
  "private windows" (drives the hint; the real-incognito test is `test.fixme`: Playwright cannot
  automate an incognito extension context).

### Grant lifecycle (`packages/pdf/src/grant.ts`)
The reader asks for one origin, from a click, to fetch one file, and hands the access back when the
transfer is over.

- `requestOrigins(port, patterns)` is called synchronously from the click (both `contains` and
  `request` are issued before any await, so the gesture counts). It returns `granted` and `fresh`,
  the patterns this request made accessible; a pattern whose state cannot be read counts as already
  granted and is never handed back on a guess.
- `Reader.tsx` keeps `fresh` in `lent` and calls `handBack()` when the fetch ends, whether it worked
  or not: `withdrawOrigins` removes a pattern only when it is exactly one origin and nothing in
  `settings.persistentOrigins` or the manifest's `host_permissions` covers it (`isCoveredBy`: the same
  origin, `<all_urls>`, an all-sites pattern for its scheme, a `*.suffix` wildcard). It is best effort: a refusal is not an
  error of the fetch.
- Consequences: access the person already held starts the download without a prompt and nothing is
  removed; otherwise opening the same PDF again asks again; a grant Chrome refuses to remove stays
  and is listed on Chrome's extension page; "Delete all data" revokes every optional host grant.
- Tests: `packages/pdf/src/grant.test.ts`; `entrypoints/pdf-reader/Reader.test.tsx` "Reader: site
  access for one fetch is handed back".

### Redirects and the failure kind `redirect-needs-access`
`fetch` follows redirects and does not expose the hops (a `manual` redirect is an opaque response),
so the address the transfer **ended at** is the one place a rule can be enforced, and it is enforced
after the status and content type and before any of the body is read (`vetFinalAddress` in
`packages/pdf/src/source.ts`):

1. the final address must pass the first address's rules (`checkAddress`: https, or http on
   `localhost` / `127.0.0.1`, no user name or password; no 2,048-character bound, a signed download
   link can be long), else `redirect-blocked`;
2. the same origin as the one asked for passes;
3. another origin passes only when `FetchOptions.isOriginGranted(pattern)` says the person granted it
   (the reader passes `permissions.contains`; a check that throws counts as "not granted");
4. otherwise the body is cancelled unread and the failure `redirect-needs-access` carries
   `redirectTo: { host, pattern }`. The reader shows "Allow access to <host> and open", which asks
   for both origins in one prompt and hands both back afterwards.

**Limit.** The browser followed the redirect, so the other site may have received the request (IP
address, the address redirected to, no cookies, no referrer); only its answer is withheld. The reader
screen's advice for this failure no longer promises that StudyVault "never contacts a site you have
not allowed" (`entrypoints/pdf-reader/OpenPanel.tsx`), but it does not say that the other site may
already have received the request either (docs/PRIVACY_CLAIMS.md U-14).
Tests: `packages/pdf/src/source.test.ts` "fetchPdf: where a redirect may end";
`tests/e2e/pdf.spec.ts` "a redirect to another origin that is allowed opens; nothing is sent to it but
the request".

### Not verified here
A real private window; Chrome's own permission prompt and `permissions.remove` for a pattern the
person gave at the prompt (only mocked ports and the test harness's build-time grants were used);
whether Chrome lists a handed-back grant at all afterwards.

## Amendment 3 (2026-10-12): links

**Status:** accepted · Refines "Rendering" and "Known limitations" (which said link annotations are not
rendered). The real-document corpus run found it: "PDF hyperlinks are not clickable; no annotation layer
exists". Tests: unit (`packages/pdf/src/links.test.ts`, `linkLayer.test.ts`,
`entrypoints/pdf-reader/links.test.tsx`), real files through the loader (`real.integration.test.ts`, "links
of real documents") and browser (`tests/e2e/pdf-links.spec.ts`).

### What is read, and when
`PDFPageProxy.getAnnotations({ intent: 'display' })`, subtype `Link` only, for a page when that page is
drawn (`PdfDocument.getLinks`: cached for 24 pages, one worker round trip per distinct destination, up to
5,000 destinations remembered). At most 500 links are kept per page; the rest are counted (`omitted`) and
the Links list says so. Widgets, stamps, free text, popups and every other subtype are not read.

| What pdf.js reports | What the reader does |
| --- | --- |
| `dest` (explicit array or named destination) | resolved with the outline's resolver (`getDestination`, `getPageIndex`): a place in this document, label "Link to page N". A destination the file does not have is refused ("not in this PDF") |
| `action` NextPage / PrevPage / FirstPage / LastPage | goes to that page (relative to the link's own page) |
| any other `action` (Print, Download, Find, GoBack...) | refused, naming the action |
| `url` or `unsafeUrl` | judged by `vetExternalUrl` (below) |
| `newWindow` is a boolean | refused: pdf.js sets it only for Launch, GoToR and a script it could read an address from |
| `attachment` (GoToE), `resetForm`, `setOCGState` | refused |
| nothing it understands (a JavaScript or SubmitForm action, a bare box) | no anchor is made; nothing can be followed |

### Rectangles
A link's rectangle (`[x1 y1 x2 y2]`, user space) goes to the **same raw page frame** as highlights
(`userRectToFrame`: 0..1 of `page.view`, top-left origin, cut to the page) and is displayed with
`rotateRect(frame, rotation)`, where `rotation` is the absolute viewport rotation (the page's `/Rotate` plus
the reader's). Percent placement means zoom needs no recomputation. A link with QuadPoints (a link wrapped
over lines) keeps one rectangle per quadrilateral (at most 16); a rectangle with no area on the page is
dropped. The transform is tested against the real pdf.js viewport (`convertToViewportPoint`) for rotations
0, 90, 180 and 270 on pages with `/Rotate` 0 and 90, at three scales.
Measured on the real files: `cdc-sti-guidelines-2021` has 4,131 link annotations, of which 352 are
zero-width boxes (a link set on a line-end space), so 3,779 are clickable; `nist-cswp29-csf-2-0` has 103.

### The layer (`packages/pdf/src/linkLayer.ts`)
One layer per page element (`.sv-pdf-layer--links`), above the text layer and below the highlight underline
and the save bar (which is `position: fixed`, z-index 40). It holds one transparent `<a role="link">` per
link, placed over the union of the link's rectangles, with the accessible name above. There is **no
`href`**: nothing the browser could open by itself (middle click, drag, context menu, status bar) exists.

**Pointer.** The anchors, and the layer, have `pointer-events: none`: a real hit target above the text
would end every drag-selection that begins on a link. The click is caught on the page element
(`.sv-page`) and matched to a link's rectangles by arithmetic (`hitTest`, topmost wins). It counts only if
the pointer travelled at most 4 px between press and release, no text was selected when it was pressed and
none is selected at the click: never during or after a selection (the click that only clears a selection
does not also follow a link). A click on a highlight's underline belongs to the highlight. An assistive
technology's "activate" is a click on the anchor itself and is followed. The page element gets
`sv-over-link` (pointer cursor) while the pointer, with no button down, is over a link. A double click
on a link follows it on the first click (the second only selects the word).

**Keyboard and assistive technology.** Anchors exist only for drawn pages, so the lazy window bounds them
(a few pages, never the 3,779). A page with **at most 40** links puts each in the tab order, in reading
order (top to bottom, left to right within a line: geometric, not column-aware). A page with **more than
40** has **one** tab stop (the first link) and arrow keys, Home and End between the rest (roving
tabindex); the layer's group label says so. **Enter** follows the focused link. The side pane has a
**Links** tab: the "Links on this page" list of the page in view (every link by its accessible name, the
address as text, "will not be opened" for a refused one). It is the primary way through a dense page and
follows links through the same code. Focus ring: `:focus-visible` outline plus a tint, `Highlight` in
forced-colors.

### Following a link (`entrypoints/pdf-reader/links.tsx`)
- **A place in the document.** The view scrolls so the destination point (rotated into the displayed
  frame) sits about a tenth of the view (at least 24 px) below its top edge; the **page element takes keyboard focus** (it is
  `tabindex="-1"`, not a tab stop, and the viewer's own keys keep working with focus there); the polite
  status region says "Went to page N."; where the view was goes on the **Back stack** (50 entries; a
  position is the current page and how far the top edge of the view is into it, so Back lands exactly; the
  same place is not stacked twice). **Back** is a toolbar button ("Back to page N", disabled with the
  reason "No link has been followed yet.") and **Alt+Left**. Alt+Left is always handled in the reader,
  with an empty stack too (it says so): the browser's own Alt+Left would leave the page, and the open
  document with it.
- **An address** (`vetExternalUrl`). Parsed with `new URL`; the scheme is read from the parsed address
  (`JaVaScRiPt:`, a leading space or a hidden newline cannot slip past a text test). Only an absolute
  `http:` or `https:` address of at most 2,048 characters, without a user name or password and with a
  host, passes. `javascript:`, `data:`, `file:`, `blob:`, `chrome:`, `chrome-extension:`, `ftp:`,
  `mailto:`, `tel:`, `about:` and every other scheme are refused with a notice that names the scheme;
  relative addresses, over-long ones and ones with credentials are refused with their own sentence. A
  passing address is **never opened by the link itself**: an in-reader dialog (`ConfirmDialog`: focus
  trapped, Cancel focused, Escape cancels) shows the whole address as text and the site (the ASCII host,
  so an internationalised name shows as `xn--...`), and only "Open in a new tab" opens it, with
  `window.open(url, '_blank', 'noopener,noreferrer')` from that click (nothing is awaited before it). The
  new tab has no opener and no referrer. "Always allow this site ({host}) in this reader session" is
  **off** by default; when on, links to that origin (scheme, host and port) open without the dialog until
  the reader page is closed (a ref, never persisted); another origin, scheme or port still asks. The
  status region says "Opening {host} in a new tab." (the reader cannot know whether the browser's popup
  blocker allowed it: `noopener` makes `window.open` return null).
- **A refused link** shows an `InlineNotice` (`role="status"`, "Link not opened", Dismiss) with the
  reason, floating over the top of the pages (`.sv-linknotice`, out of flow). Nothing runs and nothing is
  requested.

### Limits, stated exactly
- pdf.js folds URI, GoToR and Launch actions into one `url`, so they cannot be told apart unless the action
  carries the optional `NewWindow` key (then it is refused as above). A Launch or GoToR without it is
  judged by its address alone: a file name or path is "not a full web address" or a non-web scheme and is
  refused; a web address is an ordinary address and goes through the dialog.
- No JavaScript, form or layer actions, no attachments, and only four named actions. A link whose action
  pdf.js does not turn into a destination has no anchor at all, so nothing tells the person it exists.
- Reading order is geometric. A link wrapped over lines has one tab stop and one focus ring around the
  union of its lines (the pointer hit area is per line).
- A sparse page is up to 40 tab stops per drawn page, so up to about 160 with the window of four pages:
  bounded, not small. Back remembers 50 positions.
- Not verified: a real screen reader, Chrome 120-127, Edge, a real forced-colors rendering (the rules
  exist), touch, and what Chrome's pop-up blocker does with the new tab (`window.open` from the dialog's
  click: the reader cannot tell). Manual rows: `docs/MANUAL_TEST_CHECKLIST.md` MT-62, MT-63 and MT-65.

### Defects found on the way
**A click lost after a refusal (CI, once).** The notice used to sit above the pages: it pushed them down
by its own height and shortened the viewer, and a viewer that changes size draws every page again, with a
link layer that existed but held no links until the canvas had been drawn. A second click straight after
the first landed in that gap and did nothing (the notice kept the first sentence). Three changes, each
enough to remove the symptom and kept together: the notice is out of flow (nothing moves, the viewer keeps
its size; `tests/e2e/pdf-links.spec.ts` asserts the viewer's box is unchanged); fit-width no longer depends
on the height of the scroll area, so a banner or notice never redraws every page (`fit-page` still does,
its zoom depends on the height); and a page's links are painted as soon as its layers exist, before the
canvas (the zoom test asserts that the link layer is never present without its links). Before the fix a
synthetic click delivered in the gap was dropped every time; after it, `--repeat-each=10` on the flaky test
passed 10 of 10.

**The page box.** The toolbar's page box committed on blur even when nothing had been typed. After "go to page", scrolling
within the page and clicking into the document, the view jumped back to the top of the page between the
press and the release, and the click landed on a different link. It now commits on blur only what was
typed (`Toolbar.tsx`; covered in `links.test.tsx`).

### Size
The new code lives in the reader page's chunks only (nothing in the content script, the background or the
other pages): `links.ts` 5.1 KB, `linkLayer.ts` 3.3 KB and `links.tsx` 4.4 KB minified (about 5.6 KB
gzipped together), plus 0.6 KB of CSS. The reader chunk of the e2e build went from 136,770 to 151,107
bytes (+14.3 KB; that figure also contains anything else that changed in the tree since the earlier
build).

## Amendment 4 (2026-10-12): scans stored sideways, and when a page's text may be selected

**Status:** accepted · Refines "Scanned and partial documents, OCR" (which rendered a page "in the
orientation the page is shown in by default" and read it once) and "Rendering" ("Drag selection"). The
real-document corpus run found the first: page 1 of `nasa-msfc-60k-combustion-testbed-2000.pdf` is a scan
stored sideways (`/Rotate 0`, its lines run from bottom to top); recognition read it as shown and saved 793
characters of noise ("s (c) [7] s (c) NS 0 8 ...") under a green "Recognised 1 page". Tests: unit
(`packages/ocr/src/orientation.test.ts`, `runner.test.ts` suite "runOcrJob: scans stored sideways or upside
down", `image.test.ts` "inkLineDirection", `engine.test.ts` "turning a page that is stored sideways or upside
down", `geometry.test.ts` "a page turned after it was rendered (sideways and upside-down scans)",
`packages/storage/src/pdf.test.ts` "records the turn a sideways scan needed, keeps it through a correction and
an omitted value", `entrypoints/pdf-reader/ocrModel.test.ts` "orientation in stored rows") and browser
(`tests/e2e/pdf-real.spec.ts` "a scan stored sideways is read without turning the view, and a highlight on it
is found again after reopening", and "recognises one scanned page on this device, and its text becomes
selectable" for both real scans). No CI run has executed them: unit-only, e2e written and not yet run.

### How a page is turned
The recogniser reads text that runs left to right, so a page whose lines run the other way comes back as
junk. Orientation is found **by trying**, with no new data and no network request:

1. **Which way the lines run (about 30 ms).** `inkLineDirection` (`packages/ocr/src/image.ts`) measures the
   mean ink of every row and column of a copy of the rendered page of at most 400 px. Lines of text make the
   row profile alternate between ink and paper; the ratio of the two profiles' edge energy says
   `horizontal` (at least 2), `vertical` (at most 0.5) or `unclear` (in between, or too little ink to
   say). The thresholds were set on 55 real pages (pages of text 2.5 to 92, tables and equations 1.5 to 4,
   photographs and charts 0.5 to 1.3).
2. **The turns tried, most likely first** (`attemptOrder`): horizontal `0, 180`; vertical `90, 270, 0`;
   unclear `0, 90, 270, 180`. Each turn at most once: **never more than four readings of a page.** Every
   try is a **full-size reading** of the same 300 dpi image: a reading at a third of the size or of a band
   of the page was measured and is not cheaper (the cost is the junk the recogniser invents from a wrong
   orientation, not the pixels), and full-size readings are comparable, so the winner needs no second pass.
3. **Early exit.** A reading with at least one word and a mean word confidence of **60 or more** is taken as
   it is and nothing else is tried (real text measured 59 to 90, a page of tables 59; junk from a wrong turn
   28 to 46). An upright page therefore costs one reading, as before.
4. **Budget.** **120 s** for all the readings of one page: a further reading is started only when the time
   already spent plus the cost of the last reading fits; the one that is running is never interrupted.
   Cancel is never swallowed. An error in the first reading is the page's error and is retried like any
   page; an error in a later one only ends the search and the best reading so far is kept.
5. **Choice** (`chooseReading`). The upright reading is kept unless a turned one holds **at least 1.5 times
   as many characters of confidently read words** (confidence 80 or more) **and at least 10 of them**, so a
   few stray marks cannot turn a page. Between turned readings the one with more such characters wins.

Measured on the real scans (tesseract.js 7, LSTM, 300 dpi, mean word confidence 0 to 100): the MSFC slides,
stored sideways, read 88 to 90 turned 90 degrees and 36 to 44 as stored, turned 270 or 180; NACA SR256, an
upright text page, read 89 as shown and 28 to 38 turned. A dense page took about 6 s read right and 14 to 16 s
read turned 90 or 270, so a page that needs a turn costs more than an upright one: one reading when the ink
check's first guess is right, two when the page is turned the other sideways way or is upside down, up to
four when the ink check cannot say.

### What is stored, and what does not change
- **`OcrPage.orientation`** (`0 | 90 | 180 | 270`, optional): the extra clockwise turn applied to the image
  before recognition. `OcrPage.rotation` is the page's displayed rotation **plus** that turn, and boxes map
  to the page frame through `rotation` alone (`composeRotation`), so word boxes are in the raw page frame
  exactly as before: the highlight overlay, the text layer and a stored anchor's rectangles need no new
  case. **Absent means 0**: a page recognised before this change, and every page read upright (the engine
  omits a zero turn).
- **The vault row** (`ocrPages.orientation`, `packages/shared/src/vault.ts`, optional) is one more field of
  an existing table: no Dexie version, no index, no migration. A saved correction keeps the stored value
  (`packages/storage/src/pdf.ts`). Sync treats it as one more last-writer-wins scalar of the row
  (`packages/storage/src/sync.policy.test.ts` lists it); a backup walks the table whole, so it carries the
  field with the row (no backup test names it).
- **The stream and the signature.** `sv-ocr-text-v1` and `contentSignature = 'ocr1:' + cyrb53hex(text)` are
  unchanged; so is resolution of an anchor. A highlight made on recognised text before this change resolves
  as it did.
- **No OSD asset.** Tesseract's own orientation-and-script detection needs its own language data; none is
  bundled and none was added, so the `ocr/` assets and their budget (`scripts/check-build.mjs`) are the same
  files. The new code (`orientation.ts`, `inkLineDirection`) is imported only by `@ocr/runner` and
  `@ocr/image`, so it loads with the first "OCR" click and not with the reader page.
- **What the person sees.** The progress line adds a phase ("Checking orientation of page N: this scan may
  be sideways or upside down (k of n)..."); the outcome says "Page N is stored sideways (its lines run from
  bottom to top); it was turned to be read." (270: "from top to bottom"; 180: "upside down"; several pages:
  "Pages 1, 2 are stored sideways or upside down; they were turned to be read."); the *Page text* tab says
  the same for the page in view (`pdf-ocr-orientation`). **The view is not turned** and `OcrJobSummary`
  lists the turned pages in `reoriented`.

### Limits, stated exactly
- **One orientation per page.** A page that mixes upright text with a sideways table or a rotated figure
  caption is read in the single orientation that scores best; the other text may come back as junk.
- **No deskew.** A page tilted by a few degrees is read as it is (a quarter turn is the only transform).
- **English only** (the bundled language data). A page in another script that never reaches a mean of 60 in
  any turn keeps the reading as shown, after up to four readings.
- **A blank page or a page of figures costs up to four readings.** With no word there is no mean, so the
  early exit never fires; a page with too little ink is `unclear` and tries all four turns (from the code,
  not measured).
- **A turn is a heuristic.** A real text page can lose against the 1.5 times margin and stay as shown; a
  page that needs the turn and never reaches 10 confident characters is also kept as shown.
- **Pages recognised earlier keep their text** until the person asks for them to be read again (a stored
  page is skipped by "OCR this document", which resumes). **Amendment 5 adds that action**
  ("Re-recognise this page" and "Re-recognise all pages"); there is still no "remove recognised text"
  action (`clearOcr` exists in `@storage` and no control calls it). A page that was read as junk before
  Amendment 4 is fixed by re-recognising it.
- Encoded images (a Blob or bytes) cannot be turned and are read as they are; the reader always passes a
  canvas.

### The text layer is selectable only when it is complete
pdf.js draws the text layer's spans before the page has finished painting; the reader then puts them into
stream order (every span is detached and attached again) and places the `.endOfContent` sentinel only
afterwards (`pageView.ts`). A selection made in between was cut loose by the re-ordering and no save bar
followed it. The rule (`reader.css`, `.sv-textlayer:not(:has(> .endOfContent)) :is(span, br)`): **until
`.endOfContent` is placed the spans are `user-select: none` with the default cursor; a page's text is
selectable, and its layer is complete, only once it is.** Nothing is hidden or lost: a drag on a page that is
still being drawn selects nothing rather than half a page. The e2e specs use the same marker for "complete"
(`.sv-textlayer:has(> .endOfContent)`), not the presence of spans.

### Not verified
A physically scanned, sideways document (the only real example is page 1 of one file of the corpus); any
language but English; a page of mixed orientation; Chrome 120 to 127 (only a current Chromium was
available); the cost of a 300-page scan of blank pages or figures. Manual row:
`docs/MANUAL_TEST_CHECKLIST.md` MT-64. The size of the new code was not measured separately.

## Amendment 5 (2026-10-12): reading recognised pages again

**Status:** accepted · Refines "Scanned and partial documents, OCR" (a stored page was skipped and there was
no way to read it again), "Known limitations" and Amendment 4 ("Pages recognised earlier keep their text").
Tests: unit (`packages/ocr/src/runner.test.ts` "force: reading stored pages again",
`packages/storage/src/pdf.test.ts` "reading a page again", `packages/storage/src/sync.policy.test.ts` "the
one-step undo of a re-recognition never leaves the device", `packages/storage/src/backupTarget.test.ts` "the
reading a re-recognition replaced stays on this device", `entrypoints/pdf-reader/ocrRerun.test.ts`,
`ocrController.rerun.test.tsx`, `OcrPanel.rerun.test.tsx`) and browser (`tests/e2e/pdf-ocr-rerun.spec.ts`,
four tests). Those files and the e2e spec were run locally on a private build (one Playwright process, one
worker): they passed, as did the five existing OCR tests of `tests/e2e/pdf.spec.ts`. No Actions run has
executed them yet.

### What the person gets
The "Page text" tab gets a region "Read the text again":

- **Re-recognise this page**, for a page that has recognised text.
- **Re-recognise all pages**, whenever the document has any recognised text (also on a page that has its own
  text).
- **Restore the previous reading**, for a page that was read again.

Both "re-recognise" actions **ask first** in a dialog (`ConfirmDialog`: modal, focus on Cancel, Escape
cancels, focus returns to the button). It states what it costs, what stays until the new reading has
succeeded, what happens to the corrections of the page (or of the document: "N lines on M pages"), that a
page that already keeps an earlier reading will have it replaced (only one step back is kept), what happens to
highlights, and, in a window that saves nothing, that the new reading lasts this session only.

**Cost.** `estimateRerun(pages, msPerPage)`: pages times the time one page took in the last run on this
device (`OcrJobSummary.durationMs` over saved plus failed pages, kept in memory by `useOcr`, never stored, so
a reload forgets it; the first run's figure includes starting the engine), else an assumed 8 s a page that
the sentence labels as an assumption. A page that is stored sideways takes longer, and the sentence says so.

**Progress and cancel** are the existing ones (status line, `<progress>`, one sentence per finished page for
a screen reader, Cancel); the notice is titled "Reading a page again" or "Reading the recognised pages
again". **The result** is the outcome notice (live region) with counts and an itemised list.

### What is guaranteed
1. **`force`.** `RunOcrJobOptions.force` reads every requested page: nothing is skipped as stored and
   `storedPageNumbers` is not consulted. The runner never deletes anything: a page's stored text is touched
   only by `saveOcrPage`, which the runner calls after that page's new reading succeeded. A page that fails
   twice, a page not reached because of a cancel or a job-level error, and a render failure all keep their
   text.
2. **Old text until the new reading is in.** The reader's `saveOcrPage` for a forced job replaces the page
   in one write (below). Until then neither the vault nor the page on screen changes.
3. **A reading with no words does not replace a page that has words.** It is a page that could not be read,
   not a better text: the earlier text stays, nothing is written, and the result says so ("No page was
   replaced" when that was every page).
4. **Corrections are carried by where the line sits.** They are stored per line (`correctedText`, one entry
   per recognised line), and a line index means nothing in another reading, but every line has a box (the
   union of its words' stored boxes, in the page's own frame). `carryCorrections` pairs each corrected line of
   the old reading with the line of the new reading whose box overlaps it by at least half of their union
   (`MIN_LINE_OVERLAP` = 0.5; best pair first; each line of the new reading is used once) and keeps **the text
   the person typed, verbatim**, on it. A correction the new reading now agrees with is carried and not stored
   (an edit equal to the recognised text is no edit). A correction with no such line is **dropped**: it is
   listed by page, line and text, and the reading it replaced still holds it (step back, below). Because the
   mapping is by box and not by index, the dialog is one confirmation that states the rule; there is no second
   confirmation. Word-level corrections do not exist as stored data (the vault keeps line text; the UI edits
   lines), so there is nothing else to map.
5. **Highlights are never touched.** Their rows, quotes, notes and memberships are unchanged. After a page is
   replaced the reader resolves every highlight of that page against the old stream and against the new one
   with `resolvePdfAnchor`, the function that paints (`checkAnchors`). The result says how many are found
   again and **lists those that cannot be placed** (`ambiguous` or `orphaned`: not painted, as in every other
   case, and still in the list with their quote and notes). The signature of a new reading differs from the
   old one, so no stored offset is trusted ("Recording that an anchor is OCR-derived" above): a highlight is
   found again by its quote and context (placed, as `resolved`), else by the rectangles it covered (shown as
   "Source changed"), else it is listed as unplaced.
6. **One step back.** The reading a replacement removes is kept on the page's row (`previousReading`, below).
   "Restore the previous reading" swaps the two inside one transaction (`swapOcrReading`): the earlier text
   comes back **with the corrections it had**, and the reading it replaces takes its place in the slot, so the
   swap can itself be swapped back and nothing recognised or corrected is lost by it. Only the last previous
   reading of a page is kept: a second re-run replaces the slot (the dialog says so), and so does nothing
   else. A correction made on the page does not use the slot up.
7. **Cancel keeps the old text for every page not yet replaced**, and the page in flight is not saved. The
   pages already replaced show the new text (and each has its step back). The result says so.
8. **Offline, no network.** The engine and its data are the bundled ones; no new request exists and the
   permission set is unchanged. The e2e test records every `http(s)`/`ws(s)`/`ftp` request of the reader page
   and runs the re-recognition with the context offline.
9. **A window that saves nothing** (private window, no consent): the new reading replaces the page in memory
   only, the previous reading lives in memory, "Restore" swaps in memory, and `replaceOcrPage`,
   `swapOcrReading` and `saveOcrPage` are never called (unit test); the stored text is unchanged.

### Storage
- **`OcrPage.previousReading`** (`packages/shared/src/vault.ts`), optional `PreviousOcrReading`: `text`,
  `correctedText`, `words`, `language`, `engine`, `confidence`, optional `orientation`, and `replacedAt`
  (when it stopped being current). The same bounds as the row (`MAX_OCR_WORDS`, `MAX_OCR_TEXT_CHARS`), so a
  row is at most about twice its former size. It is `.optional().catch(undefined)`: **a damaged slot reads
  as absent** and can never make the page's own text unreadable (nor does it fail the integrity check).
- **No new table, index or Dexie version, no migration.** Like `orientation` in Amendment 4 it is one
  optional field of an existing row: rows written before it have none. `DB_VERSION` is unchanged and the
  backup migration chain needs no step.
- **Write path** (`packages/storage/src/pdf.ts`): `saveOcrPage` keeps its meaning (an omitted
  `correctedText` keeps the stored correction) and now also carries an existing slot through. **New
  `replaceOcrPage(input)`**: in one `rw` transaction over `documents` and `ocrPages` it reads the stored row
  and writes **one** row put holding the new text, words, orientation and the carried `correctedText`
  (omitted means none: an old correction cannot be kept by omission) and `previousReading` = the row it read
  (unit test: exactly one `put`, containing both; a failing `put` leaves the stored reading as it was).
  **New `swapOcrReading(documentId, pageNumber)`**: same transaction shape; `not_found` when there is no
  slot. Both call `assertPdfWriteAllowed` first (the private-window rule, Amendment 2).
- **Port** (`@pdf` `PdfStore`): `replaceOcrPage?` and `swapOcrReading?` are optional and `StoredOcrPage`
  gains `previousReading?`. A store without `replaceOcrPage` falls back to `saveOcrPage` (no slot in the
  vault; the step back lasts the session), which is the memory store's behaviour in unit tests.
- **Device-local, in three places.** (a) Sync: registry `derivedFields: ['previousReading']` (so
  `serializeRow` and the checksums skip it) **and** the policy's `local` list for `ocrPages`
  (`packages/sync/src/policy.ts`: never serialised, never accepted); `sync.policy.test.ts` classifies the
  field. (b) Backup: `BACKUP_LOCAL_FIELDS` in `packages/storage/src/backupTarget.ts` strips it from the rows
  of the snapshot source, the live source (restore planning) and the pre-update snapshot, so it is in no
  archive; a merge of an archive into the vault that made it plans no write (the field is not part of the row
  fingerprint), and a replace writes the archive's rows without it. (c) Delete: it is a field of the row, so
  `clearOcr`, deleting a document's data and "Delete all data" remove it with the row.

### Code and size
`entrypoints/pdf-reader/ocrRerun.ts` (pure: carry, check, describe), `OcrRerunSection.tsx` (the region and its
two dialogs), `ocrController.ts` (`useOcr().rerun`, `.restore`, `.msPerPage`), `ocrModel.ts`
(`PageOcr.previous`, `readingFrom`, `swapReading`, the estimate). `ocrRerun.ts` is loaded by a dynamic
`import()` when a page is read again or restored, and `OcrRerunSection` is `React.lazy` inside `OcrPanel`
(shown only for a document that has recognised text). Production build, the same tree with and without the
change (so that the work of other tasks cancels out):

| Part | Without | With | Difference |
| --- | ---: | ---: | ---: |
| Reader, loaded with the page (`pdf-reader` + the chunks that split off it) | 151,201 B | 156,066 B | +4,865 B |
| Reader, loaded on demand (`OcrRerunSection`, `ocrRerun`) | 0 | 9,958 B | +9,958 B |
| `background.js` | 424,602 B | 425,091 B | +489 B |
| `content-scripts/highlighter.js` | 219,444 B | 219,690 B | +246 B |
| `chunks/src.js` (shared) | 890,517 B | 892,226 B | +1,709 B |
| `chunks/runner.js` | 3,360 B | 3,408 B | +48 B |
| reader CSS and HTML | 11,691 + 890 B | 11,861 + 1,125 B | +405 B |
| Every JS file | 4,869,186 B | 4,886,503 B | +17,317 B |

The JS total is larger than the all-eager variant (+15.3 KB) because the lazy chunks cost chunk-boundary
overhead; the reader's own load is 8.0 KB smaller than that variant (+4.9 KB against +12.9 KB).

### Limits, stated exactly
- **Lines are matched, not words.** A correction on a line that the new reading splits in two, or merges
  with a neighbour, overlaps by less than half and is dropped (listed; the previous reading has it).
- **One step back per page.** A second re-run overwrites the slot; the correction a first re-run dropped can
  then no longer be restored. The dialog says that a page already keeps an earlier reading.
- **A reading that has words always replaces.** The reader does not judge which of two readings is better
  (a worse reading is undone with Restore). It only refuses a reading with no words at all.
- **The estimate is an estimate.** The time per page is the mean of the last run, not stored, and the
  first run's mean includes starting the engine; a document of mixed pages (some stored sideways) differs
  from it. Nothing in the dialog is a promise.
- **Highlights on a short quote can become `ambiguous`** on a new reading that repeats the words (the rule of
  `resolvePdfAnchor`), and are then listed like any unplaced highlight.
- **No "remove recognised text" action** (`clearOcr` is still not wired to a control).
- **An open reader in another tab is not told.** A second reader tab of the same document keeps showing its
  copy until it is reopened (the vault is shared; the reader loads recognised text when a document opens).

### Not verified
Real scanned documents (the e2e fixtures are generated rasters; to make "the new reading differs from the
stored one" a fact they make a stored reading worse in IndexedDB before the reader reopens it, which is a
test device and not a product path); Chrome 120 to 127; a screen reader; a document of hundreds of pages
(the unit tests use two to six). Manual row: none added.
