# ADR-006: Extension-owned PDF reader (`@pdf`, `entrypoints/pdf-reader`)

**Status:** accepted · **Date:** 2026-10-11 · Anchors: ADR-004 (text anchoring), ADR-005 (free text only in
extension origin). Schema: `PdfAnchorSet` in `packages/shared/src/schema.ts`.
**Amended 2026-10-11 (wiring task):** OCR engine wired with correction UI and the OCR text stream; outline,
thumbnails, document properties and stored-copy manager; context-menu entry; web-open hardening; drag
selection fix. Amendments are folded into the sections below.
**Amendment 2 (2026-10-11, privacy hardening)** is appended at the end: the private-window rule
(`?incognito=1`), the per-origin grant lifecycle, the `redirect-needs-access` failure and the
redirect rule. Where it differs from a section above, the amendment wins.

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
  word; there is no "re-run" or "remove recognised text" action yet (the model supports both); the text of an
  edited line is shown without per-word confidence shading; vertical and right-to-left scripts are not tuned.
- Highlights saved on OCR text and then affected by a correction are listed as "Source changed", not
  re-bound (by design).
- Reading order is geometric: tables and slide layouts with aligned gaps are read column by column;
  vertical (`ttb`) text and mixed-direction lines are ordered by position only.
- Hyphen joining is a heuristic (see above). Ligatures are expanded by pdf.js's own normalisation.
- JBIG2/JPEG2000 images need the CSP change above; XFA forms, form scripting, optional-content toggles and
  annotation layers (links, widgets) are not rendered.
- Not verified here: Chrome 120-127 (only a current Chromium was available), Edge, `file://` PDFs, real
  screen readers, cMaps for every CJK encoding (one Japanese path was exercised).

## Amendment 2 (2026-10-11): private windows, the grant lifecycle and redirects

**Status:** accepted · Refines "What this is" (the `?src=` row and the context menu), "Failure
handling" and "Persistence". Tests are unit and integration tests; none has been run by CI.

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
screen's advice for this failure currently says StudyVault "never contacts a site you have not
allowed" (`entrypoints/pdf-reader/OpenPanel.tsx`; docs/PRIVACY_CLAIMS.md U-14).
Tests: `packages/pdf/src/source.test.ts` "fetchPdf: where a redirect may end";
`tests/e2e/pdf.spec.ts` "a redirect to another origin that is allowed opens; nothing is sent to it but
the request".

### Not verified here
A real private window; Chrome's own permission prompt and `permissions.remove` for a pattern the
person gave at the prompt (only mocked ports and the test harness's build-time grants were used);
whether Chrome lists a handed-back grant at all afterwards.
