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
