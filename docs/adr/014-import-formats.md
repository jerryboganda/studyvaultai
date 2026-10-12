# ADR-014: Import formats (Anki text, HTML, EPUB, DOCX, PPTX)

**Status:** accepted · **Date:** 2026-10-11 · Extends the Markdown/CSV importer (`importExternal.ts`);
relies on ADR-009 (no new network path) and on the "Source provenance is immutable" rule.

## Context
The importer read Markdown and CSV only. The PRD (P2) asks for DOCX, PPTX, EPUB and HTML import "via
dedicated parsers", and the Anki interchange the app already exports should come back in. Every one of
these files is untrusted: an Office or EPUB file is a ZIP of XML, and both a ZIP and XML have classic
attacks (zip bomb, entity expansion, path traversal, lying headers). The import must stay local (no
network, no account, no AI), must show a dry run before it writes, and must not claim more than the
format gives.

## Decision

### 1. What is read, and what one highlight is
| Input | One highlight is | Locator (`customFields.importedLocator`) | Source title |
| --- | --- | --- | --- |
| Anki "Notes in Plain Text" (`.txt`, `.csv` with `#separator` header lines) | one note | `Note 7` | file name |
| HTML (`.html`, `.htm`, `.xhtml`) | one text block (paragraph, list item, heading, table cell, `<pre>`) | `Paragraph 14` | `<title>`, else file name |
| EPUB | one text block of a chapter, chapters in spine order | `Chapter 3, paragraph 14` | `dc:title`, else file name |
| DOCX | one non-empty `w:p` (table cells and text boxes are paragraphs) | `Paragraph 14` | file name |
| PPTX | one slide: its paragraphs joined with newlines, slide-number/footer/date placeholders left out | `Slide 5` | file name |

`customFields` of every row: `importedFrom` (`anki`/`html`/`epub`/`docx`/`pptx`), `needsReview: true`,
`importedFile` (the file name), `importedLocator`. `captureMethod` is `'import'`, as before.

**Anki mapping** (decided here): a Cloze note becomes its sentence with every deletion filled in
(`clozeToText`, the same linear parser the exporter uses), comment = the extra field. Any other note
becomes **quote = Back, comment = `Front: <front>`**; a note without a Back uses the Front as the
quote. Tags are kept as written (`#tags column`, `#tags:`), the deck (`A::B::C`) is a bank/folder hint
(`importedBank`, `importedFolder`). Fields are HTML when `#html:true`: they are read through the
same inert parser as HTML files; `[sound:...]` is dropped. Scheduling is not in these files and is not
invented. Consequence: two notes with the same Back and different Fronts are the same quote to the
duplicate detector and the second is reported as a repeat (counted and listed in the dry run, never
silently lost). Third and later fields of a note type with more than two fields are not imported.

### 2. Not supported, and said so in the UI (help text of the import panel and the refusal itself)
- Anki `.apkg` / `.colpkg`: a SQLite database inside a ZIP. No SQLite is bundled for this. The refusal
  tells the person to export "Notes in Plain Text" from Anki.
- Legacy `.doc` / `.ppt`, and password-protected Office files (OLE compound files with a `.docx` /
  `.pptx` name): refused with "save an unprotected .docx/.pptx copy".
- Encrypted or DRM-protected EPUB (`META-INF/rights.xml`, `sinf.xml`, or an `encryption.xml` naming
  any algorithm other than the IDPF/Adobe font-obfuscation ones): refused. StudyVault does not try to
  open protected files.
- Not imported, and listed in the dry run when present: images and media, footnotes/endnotes/comments
  (DOCX), speaker notes (PPTX), blocks with no letter or digit.

### 3. Trust boundary and hardening
Parsing runs in an extension page (the Options/Dashboard import panel), never the service worker or a
content script. The document readers are one lazily imported module (`@backup/importDocs`); the
pre-existing Markdown/CSV path is unchanged.

| Guard | Value | Where |
| --- | --- | --- |
| file size | 64 MiB (`MAX_DOCUMENT_BYTES`), checked on `file.size` before reading | UI + `importDocument` |
| ZIP entries | 5,000 | `listZip` (central directory only; fflate's own walk is never run on these files) |
| declared uncompressed total | 256 MiB, and at most `max(8 MiB, 100 x file size)` (archive-wide zip-bomb ratio) | `listZip`, `openArchive` |
| one entry | 32 MiB, and the existing per-entry "impossible expansion" check (1100:1) | `readZipEntry` |
| entry stream length | must equal the declared size; inflated in 8 KiB slices and abandoned at the first slice past it (a header that lies costs no memory and almost no time) | `readZipEntry(..., exact)`, `inflateExactly` |
| total bytes decompressed in one import | 256 MiB budget | `openArchive` |
| entry names | refused outright: `..` segment, absolute or drive path, `\`, control characters | `openArchive` |
| markup handed to a parser | 16 MiB per part (XML, HTML, XHTML) | `parseMarkup` |
| XML | any `<!DOCTYPE` or `<!ENTITY` refuses the file before the parser sees it; then `DOMParser('application/xml')`; a `parsererror` refuses the file | `parseMarkup` |
| HTML / XHTML | `DOMParser('text/html')`: inert (no scripts run, nothing fetched, no frames); `script`, `style`, `iframe`, `object`, `embed`, `svg`, `template`, form controls, `head` removed before the text is read; never attached to a live document | `htmlBlocks` |
| text taken | 8 Mi characters per file; 10,000 blocks per file (above it the file is refused, as for Markdown/CSV); one block over 10,000 characters is rejected as too long, never imported cut | `makeSink`, `finalize` |
| Anki | a field over 100,000 characters or an unterminated quote refuses the file; 10,000 notes | `parseCsv` |

Every refusal is a typed `BackupError` (`import_invalid` with a sentence for the person, or
`limit_exceeded`) and happens before anything is written. Nothing is persisted by parsing.

### 4. Dry run, commit, undo
- The panel parses first and shows: how the file was read, counts (records, importable, duplicates,
  rejected), warnings (what the format could not carry), the first 200 candidates with checkboxes
  (all are imported unless unticked; "Show all" renders the rest), duplicate and rejected lists with
  locators.
- Commit is `importExternalHighlights` (one IndexedDB transaction; each row re-validated with Zod;
  quote hash recomputed; duplicates of the vault and of the batch skipped). Each file makes Sources
  of its own, keyed `imported:<batchId>:<n>`, which no page can match; documents carry no address, so
  they use the `studyvault.invalid` stand-in and the file name or document title as the title.
- **Undo**: the result carries `batchId`; `undoExternalImport(batchId)` soft-deletes (Trash, so
  "Restore" works) the live highlights whose Source key starts with `imported:<batchId>:`. It cannot
  touch a capture. The Sources and any tags the import created remain (a Source without a live
  highlight is not shown; tags are the person's to prune).

## Alternatives rejected
- **mammoth / JSZip / epub.js / SheetJS-style libraries.** New dependency weight and a second ZIP and
  XML surface to audit, for features (styles, images, layout) the import does not use. The small
  central-directory reader already exists, is tested against hostile archives, and is reused.
- **Regular-expression scraping of the XML.** Fast, but wrong on namespaces, CDATA, nested text boxes
  and entities, and an easy ReDoS target. `DOMParser` after the DOCTYPE refusal is simpler to defend.
- **Parsing in a Worker.** Workers from `blob:` URLs are blocked by the extension CSP and a bundled
  worker adds a message protocol for no change in trust: the work is bounded by the caps above. The
  cost is that a hostile file within the caps can keep the page busy for seconds, never forever.
- **One highlight per PPTX paragraph/bullet.** A slide's bullets are fragments ("Aspirin"); the slide
  is the unit a student recalls and cites ("Slide 12").

## Consequences
- Files in these formats become `needsReview` highlights with a file name and a locator but **no**
  position in a page: the anchor is the placeholder `imported` signature, so they never paint on a
  page and "go to source" has nothing to open (unchanged for Markdown/CSV).
- The dashboard's capture-method text for `'import'` still reads "a Markdown or CSV import"
  (`entrypoints/dashboard/format.ts`); `customFields.importedFrom` has the exact format.
- Size: one lazy chunk of about 12.6 KB (minified), plus about 7 KB in the Options chunk and the shared
  chunk (import panel, `Inflate`, importer additions). The background bundle is not affected.
- A 10,000-block limit refuses a whole textbook EPUB; the message says to import it in parts.
- Out of reach by design: embedded fonts, math (OMML/MathML text is dropped in DOCX and kept as
  characters in HTML), tracked deletions (excluded), hidden slides (imported like any slide).

## Verification
- Unit, `packages/backup/src/importDocs.test.ts`: every format; zip bomb with an honest header,
  per-entry cap, a header that understates and one that overstates the stream, 5,001 entries, five
  unsafe entry names, billion laughs and an external entity (the parser is never called), a
  2,000,000-character paragraph, the markup, text and block caps, damaged archives, protected EPUB,
  `.apkg`, `.doc`, a password-protected `.docx`.
- Storage, `packages/storage/src/importDocuments.test.ts`: provenance fields, one Source per file,
  forged format refused, undo by batch.
- UI, `packages/ui/src/backup/externalImport.test.tsx`: dry run, commit, undo, refusal text, Anki
  `.txt`, the capped list.
- E2E, `tests/e2e/import-formats.spec.ts`: the same in a loaded extension with Chromium's own parser;
  asserts that no script ran and no request left the page, search finds the rows, Delete all data
  removes them.
