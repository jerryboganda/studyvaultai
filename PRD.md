# Product Requirements Document

## Vision and personas
StudyVault AI is an advanced personal study companion for browser-based learning, especially high-stakes examinations. Primary persona: independent learner who studies online articles, educational portals and PDFs and needs reliable recall days or weeks later. Secondary: professional preparing evidence-based clinical/scientific notes. No product-specific clinical advice is permitted without verified evidence.

## Problem
Reading and highlighting alone do not create a searchable, durable, useful memory base. Readers lose citations, mix unreliable AI paraphrases with quotes, and fail to revisit material. Existing PDFs and web pages need one unified capture-to-revision pipeline.

## Success criteria (measured by tests, not fabricated telemetry)
1. Capture selected text in supported pages, save to a bank, and restore correct in-page highlight after reload.
2. Capture from a PDF in the product's own reader with page-specific anchors and reopen precisely at the highlighted passage.
3. Save and search offline, including page-title, tags, subject tree, priority, content and source metadata.
4. Create/review flashcards with deterministic persisted FSRS scheduling.
5. Export/import without content loss; corrupted imports do not damage existing data.
6. Report explicit unsupported states for restricted pages and inaccessible PDFs.
7. AI suggestions never overwrite quotes and are visibly distinguished from human notes and verified references.

## Primary study workflow
A. Browse a permitted webpage, select text, see a nonintrusive floating action bar near selection.
B. Choose Highlight, Save, Note, Explain, Exam Pearl, Flashcard, or MCQ.
C. Quick-save immediately in a default bank or open an advanced modal with Bank > Folder > Topic > Subtopic; multiple tags; custom fields; color; priority; confidence; optional exam-syllabus mapping.
D. Auto-save source URL, canonical URL if trustworthy, title, host, heading, captured timestamp, quoted text and exact anchor selector, article snapshot metadata (not full content by default).
E. See a reversible toast and inline annotation marker, with side panel showing related highlights and due revisions.
F. Revisit page and show highlights with reliable anchoring and an understandable 'source changed / anchor uncertain' state if necessary.
G. Review each evening via due queue, active recall and progress overview. Return to original source at exact passage when reachable.

## Feature inventory by priority

### P0 - indispensable core
- Onboarding: privacy choices, local-only by default, permission explanations, personal bank presets, theme.
- Popup: capture action, open side panel, last-used bank, recent saves, limited status and helpful errors.
- Side panel: current page context, quick-save inbox, recent highlights, active bank, search, today's due count.
- Floating toolbar on text selection with keyboard/selection-safe behavior and site style isolation.
- Persistent HTML text highlights: rehydrate after refresh and SPA navigation, custom highlight colors and styles, edit/delete/undo, source navigation, scroll-to-highlight.
- Bank manager: unlimited bank/folder/topic/subtopic tree, move/reorder/merge, saved filters, multi-select bulk actions, multi-bank tagging without duplicating notes, smart rules.
- Data management: CRUD notes/highlights, custom metadata fields, full-text search, filter facets, deduplication prompts, trash/restore, manual secure backup and import/export.
- Integrated PDF.js reader (packaged script) for uploaded and permitted online PDFs, page-linked text highlighting and notes, reader search, selectable text layer.
- Source-linked notes with original immutable quote and user's own editing separate from original.
- Offline-first storage, transactional updates, search indexing, and schema migrations.
- Keyboard shortcuts for open companion, quick-save selection, next/previous highlight, focus search.
- Responsive extension surfaces, dark/light mode, zoom, high contrast, screen reader and keyboard access.

### P1 - study intelligence
- Card generation: basic Q/A, cloze, definition, compare/differentiate, image occlusion (requires image assets).
- FSRS scheduler, explicit Again/Hard/Good/Easy ratings, editable target retention, per-deck rules, review-log history, due forecast, missed review recovery.
- One-liner/exam pearl generator with literal source quote and user-editable short explanation.
- AI-generated concise summary, facts, differentials, mnemonics, MCQs, short-viva questions, topic comparison tables and study outline.
- Source-scoped question answering over selected highlights and approved notes with citations and uncertainty states.
- AI fact-check workflow: explicit 'not checked / source-supported / conflicting / externally verified' labels; independent evidence retrieval only when web search integration is enabled; no automatic claims of 100% correctness.
- OCR for imported scanned PDFs/images, user-correctable text and coordinate mapping; asynchronous chunking/cancel/progress.
- Review analytics: backlog, counts by bank, coverage vs custom syllabus, retention estimates and daily study logs.
- Local full-text and fuzzy search; optional semantic search, duplicate clusters and related concepts.
- Rich editor supporting simple Markdown, LaTeX math, scientific symbols, code, tables and source links.
- Anki interchange with explicit mapping; Markdown / JSON / CSV export, Obsidian-compatible Markdown output.

### P2 - ambitious extensions
- Authenticated cross-device sync, user-controlled encrypted backups and optional end-to-end encrypted sync.
- Collaborative shared banks with invite-based access, versioning, provenance and admin audit logs.
- Knowledge graph and linked concept relationships with pruning and duplicate resolution.
- Configurable AI provider/model router, granular budgets, rate limiting, fallback, usage ledger.
- Article readability mode (with citations and original page link), user-initiated article import.
- YouTube captions where authorized, with timestamp-based highlights and source links.
- Import DOCX, PPTX, EPUB and HTML via dedicated parsers; no promise that protected sources can be accessed.
- User-created templates, rules and preset bank taxonomies; dashboard view available outside side panel.
- Reminders, calendar integration, optional sync to cloud storage with user consent.
- Exam simulation and adaptive targeted review using actual review data.

## Customization
- Highlight colors by semantic kind: essential fact, formula, exception, differential, weak area, verified correction, question.
- Custom fields: modality, system, age, study/source type, syllabus mapping, priority, reliability, exam frequency, review state and source date.
- Dynamic lists, saved searches, tag aliases, favorite and pinning, manual sorting and smart auto-filing that requires confirmation.
- User-configurable capture template: "one liner + exam pearl + why" vs "full excerpt + own notes".
- Theme presets, density, floating bar placement, and per-domain activation rules.

## Example exam preset (optional)
Diagnostic Radiology > Physics / Ultrasound / CT / MRI / Nuclear Medicine / Neuroradiology / MSK / Chest / Abdomen / Breast / Pediatrics / Interventional. Optional labels: imaging finding, diagnosis, key differential, sign, physics mechanism, protocol, pitfall, modality, exam pearl, MCQ error correction. Never assert clinical correctness solely from an LLM.

## Out of scope / constraints
No guaranteed injection on chrome:// pages, Chrome Web Store, other extensions, internal PDF viewer UI, DRM-protected readers, inaccessible cross-origin iframe text, or all password-protected documents. The product does not automatically scrape every visited site, silently send browsing activity to servers, bypass publisher restrictions, or replace professional clinical judgment.

## Rollout strategy
Build P0 first in usable vertical slices, then P1 and P2 behind explicit feature flags. Keep core functions independent of AI, cloud access and provider availability.

## Delivery status (2026-10-12)

This section is the blueprint's status line by line. It does not change the requirements above.
"Delivered" means the code exists and is reachable from the shipped UI, with the evidence named in
`docs/PRIVACY_CLAIMS.md` (the row id is given) and, for what the finish wave (`docs/plans/FINISH_BRIEF.md`,
ADR-011 to ADR-020) added, **unit-only: the unit files were written with the code, the loaded-extension
specs are written, and no Actions run of the branch has concluded `success` yet**. Nothing in this
section is a claim that a feature has been verified in branded Chrome or Edge. The product principles
in `README.md` (local first, immutable provenance, AI separate and unverified, no silent
transmission) hold for every delivered line; a line that is met only in part says how.

### P0

| Item | Status | Where, and what limits it |
| --- | --- | --- |
| Onboarding, presets, theme | Delivered | Welcome tour with bank presets (`entrypoints/onboarding`) |
| Popup; side panel | Delivered | `entrypoints/popup`, `entrypoints/sidepanel` |
| Floating toolbar, Shadow DOM isolation | Delivered | Now on Preact (209 KB, was 405 KB): ADR-012, P41 |
| Persistent highlights, SPA, `ambiguous` and `orphaned` states | Delivered | ADR-004 |
| Bank manager: tree, move, merge, saved filters, bulk actions, multi-bank membership | Delivered, with a limit | Nesting depth is 32 (it was 8): "unlimited" in the text above is not literal |
| Bank manager: smart rules | **Delivered in the finish wave** | Auto-filing rules that suggest and ask first by default (ADR-017, P33); new highlights only, no "apply to existing" |
| Data management, trash, search, backup, import and export | Delivered | Markdown and CSV import joined by Word, PowerPoint, EPUB, HTML and Anki text (ADR-014, P26j); a single JSON file is a readable export, not a backup (P42) |
| Integrated PDF.js reader, page-linked highlights, OCR of scans | Delivered | ADR-006 (amendments 3 and 4 added link following and the turned reading of sideways scans: P45, P46). Eleven real public-domain PDFs (20.7 MB) are the test corpus, which meets the Phase 3 gate's "minimum 10 representative PDF fixtures" for matrix items 1 to 5, 9 and 10; items 6 (password) and 7 (remote PDF, redirect) are synthetic only (P47, TEST_PLAN). Links: web addresses only, after a confirmation; PDF actions beyond links and four named actions are not supported. Specs written, not yet run in CI |
| Source-linked notes with immutable quote | Delivered | ADR-005 |
| Offline-first storage, migrations | Delivered | Schema is at version 4 (ADR-011, P40) |
| Keyboard shortcuts: open companion, quick-save, next and previous highlight, focus search | Delivered | Six commands; `previous-highlight` and `focus-search` have no suggested key because Chrome allows four (ADR-003, P43) |
| Responsive surfaces, dark and light, high contrast, keyboard and screen reader | Delivered in part | axe and keyboard checks only; screen readers, forced colours and 400% zoom are manual (MT-17, MT-42 to MT-44, MT-57, MT-58) |

### P1

| Item | Status | Where, and what limits it |
| --- | --- | --- |
| Card generation: basic, cloze, definition, compare, multiple choice | Delivered | `packages/study/src/cards.ts` |
| Card generation: image occlusion | **Not delivered** | The PRD itself says it needs image assets; the vault stores none (`cards.ts` header). Deferred, not planned |
| FSRS, ratings, target retention, per-deck rules, review log, due forecast, missed-review recovery | Delivered | `ts-fsrs`, ADR-010; S12 |
| One-liner and exam pearl with literal quote | Delivered | Knowledge points and the `exam_pearl` AI task, unverified until accepted |
| AI summary, facts, mnemonics, MCQs, short-viva, topic comparison, study outline | **Delivered in the finish wave** | Task kinds `mnemonic`, `short_viva` and `study_outline` joined the nine existing ones (P20c). There is no dedicated "differentials" task; `compare_topics` is the nearest |
| Source-scoped question answering with citations and uncertainty | Delivered | `explain` and, new, chat with your notes (P20b) |
| AI fact-check labels | Delivered | Checked only against the selected sources; "externally verified" is never produced and web retrieval is not built |
| OCR for scanned PDFs and images | Delivered in part | Scanned PDFs, on the device, with correction and cancel; a scan stored sideways or upside down is turned to be read (one orientation per page, no deskew, English only; P46). A standalone image file cannot be opened (the reader accepts PDFs), and a page recognised earlier cannot be re-run |
| Review analytics: backlog, counts by bank, retention, daily logs | Delivered | Review page, Analytics tab |
| Review analytics: coverage against a custom syllabus | **Delivered in the finish wave** | Syllabus editor and coverage table (ADR-020 part 2, P37); an exam scope from a topic is not built |
| Local full-text and fuzzy search, duplicate clusters | Delivered | MiniSearch index; Duplicates view |
| Related concepts | **Delivered in the finish wave, lexically** | Shared-word suggestions only (P38) |
| Optional semantic search | **Not delivered** | It needs a model download of tens of MB; lexical related highlights are provided instead (FINISH_BRIEF "Out of scope") |
| Rich editor: Markdown, tables, code, source links | Delivered | Note editor with a sanitised preview |
| Rich editor: LaTeX math | **Delivered in part** | `$..$` and `$$..$$` are kept and shown as styled TeX source, not typeset: the smallest MIT renderer measured 164 KB against a 120 KB ceiling (ADR-015, P39) |
| Anki interchange; Markdown, CSV and JSON export; Obsidian dialect | Delivered | Anki text export and, new, Anki "Notes in Plain Text" import; `.apkg` is refused (ADR-014). JSON is for scripts and is not read back |

### P2

| Item | Status | Where, and what limits it |
| --- | --- | --- |
| Cross-device sync, encrypted backups, optional E2EE | Delivered, against a server you operate | There is no hosted service (ADR-009, ADR-010); `server/` is a reference implementation |
| Collaborative shared banks | **Not delivered** | Needs a hosted service or third-party accounts; the product claims none (FINISH_BRIEF "Out of scope") |
| Knowledge graph and linked concepts | **Delivered in the finish wave** | Links between highlights, notes and knowledge points, a graph with a table equivalent, pruning of dangling links and folding of duplicate links (ADR-018, P34). There is no screen for merging two concepts |
| Configurable AI provider router, budgets, rate limiting, fallback, ledger | **Delivered in the finish wave** | Up to three fallbacks, per-task routes, per-provider prices, a daily budget, a usage ledger (ADR-013, P20a). A fallback happens only after a network failure, a 5xx or a timeout |
| Article readability mode | **Not delivered** | Anchors must point at the original page: a derived reading view would break immutable provenance (FINISH_BRIEF "Out of scope") |
| YouTube captions | **Not delivered** | Needs a network fetch of third-party pages and a host permission, which would be a fourth network path (FINISH_BRIEF "Out of scope") |
| Import DOCX, PPTX, EPUB, HTML | **Delivered in the finish wave** | Local, inert, size-limited; no protected files and no `.doc`, `.ppt` (ADR-014, P26j) |
| User-created rules, preset taxonomies, dashboard view | Delivered | Filing rules (P33), onboarding presets, the dashboard. User-created capture or card templates are not built |
| Reminders | **Delivered in the finish wave** | A toolbar count and an in-extension daily notice; no system notification (ADR-019, P35) |
| Calendar integration; sync to cloud storage | **Not delivered** | Needs a third-party account and network service (FINISH_BRIEF "Out of scope"). A folder that a cloud-drive program syncs works as a backup destination (P26h) |
| Exam simulation | **Delivered in the finish wave** | Timed, no feedback until the end, self-marked recall, optional count as review (ADR-020 part 1, P36) |
| Adaptive targeted review from exam results | **Not delivered** | The missed-question list exists; building a deck or session from it is a follow-up that owns the exam code (ADR-020) |

### Customization and constraints

Delivered: colours by semantic kind, custom fields, saved searches, tag aliases, per-site activation
and a deny list, density and theme. Not built: a user-configurable capture template ("one liner +
exam pearl + why" against "full excerpt + own notes") and a user-set position of the floating bar
(placement is automatic). This pass did not re-check "favorite and pinning" and "manual sorting" line
by line. Edge automation is not part of the product: Edge ignores `--load-extension` like branded
Chrome 137 and later, so Edge stays a manual checklist item (`docs/MANUAL_TEST_CHECKLIST.md`).
