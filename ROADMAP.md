# Implementation Roadmap and Release Gates

Work in independently deployable vertical slices. Phases are gates, not promises of calendar duration. Do not advance with blocker failures.

## Phase 0 - Discovery and foundation
- Inspect repo, developer environment, Chrome stable and Manifest V3 requirements.
- Bootstrap WXT React TypeScript, PNPM lockfile, strict TS, formatting, lint, Vitest and Playwright test harness.
- Establish package/shared contract, app shell, global error handling, command/logging conventions, privacy baseline, theme/tokens, ADRs and core schemas.
- Create repo-local instructions, dependency hygiene, GitHub Actions workflows and sample test fixtures.
- Gate: production package loads unpacked, opens side panel and popup, passes typecheck/lint/build and smoke test in stable Chrome.

## Phase 1 - Highlight capture to bank (vertical slice)
- Implement user-initiated permission mode and optional all-sites mode, explicit per-site opt-out.
- Selection capture, floating Shadow DOM toolbar, quote+context anchor, atomic IndexedDB persistence, current page list, bank picker, toast/undo.
- Stable highlight rehydration for static article and representative SPA pages, source provenance, delete/edit, duplicate handling and degraded source state.
- Gate: capture 10 passages across varied pages, reload, revisit, and prove correct rehydration, no breakage of selection/copy/navigation; blocked site clearly states limitation.

## Phase 2 - Knowledge manager and resilient storage
- Nested bank tree, topic/subtopic hierarchy, many-to-many membership, tags, custom fields, inbox, bulk move/merge/delete and search/filter facets.
- Export/import JSON and Markdown, backup restore with checksum/schema validation, trash/recovery, schema migrations, large volume performance.
- Gate: 10k seeded highlights remain searchable with acceptable responsiveness and zero data loss after restart, update, import/export round trip; full data restore tested.

## Phase 3 - Dedicated PDF study reader
- Integrate locally packaged PDF.js, online and local import, PDF search/zoom/page navigation, selectable text layer, annotation/highlight rendering, source fingerprinting and citation page links.
- Handle multi-column text, scanned/no-text PDF detection and failed remote fetch, without unsupported claims; add incremental OCR later.
- Gate: minimum 10 representative PDF fixtures; page-linked annotations survive reload/zoom/reopen; inaccessible PDFs have clear fallback.

## Phase 4 - Retention system
- KnowledgePoint/Flashcard generation templates (manual first), deck management, review queues and local FSRS scheduler with durable review logs.
- MCQ mode, cloze, explain-answer and source navigation; user-configured daily cap, reminder opt-in and analytics.
- Gate: deterministic scheduling tests across restart, timezone and delayed reviews; no phantom duplicates or skipped due cards.

## Phase 5 - AI enhancement
- Provider abstraction, explicit consent, safe content routing, schemas, sourced outputs, concise summaries/pearls, flashcards, MCQs, topic comparisons and uncertainty labels.
- Optional OCR, dedupe suggestions, retrieval-grounded bank chat, review of contradictions and verified-correction workflow. All critical transformations require user acceptance.
- Gate: successful/failure/timeout/quota paths; no silent export of full browsing history; hallucination/contradiction suite labels unsupported answers as uncertain.

## Phase 6 - Optional cloud sync and integrations
- Account creation, auth, optional sync queue, E2EE decision, conflict handling, secure object storage, approved backup destinations.
- Exports to Anki-compatible formats and Obsidian-compatible Markdown; customizable templates.
- Gate: two-device offline concurrent edits do not silently lose data; sign-out clears appropriate tokens and can retain/revoke local data per user choice.

## Phase 7 - Release hardening
- Chrome/Edge compatibility matrix, security audit, threat model, WCAG audits, stress/performance/bundle checks, failure injection, real-browser screenshot review.
- Content policy and Chrome Web Store privacy/disclosure checks, no remotely hosted executable scripts, marketing graphics if needed, publishing checklist.
- Gate: zero release-blocking test failures; signed/distributable package, reproducible build artifacts, release notes and documented limitations.

## Definition of done for every phase
- End-to-end working user journey and executable tests (not only component snapshots).
- Typecheck/lint/unit/integration/build/E2E are run; report true commands and results.
- Browser verification: Chrome stable on Windows, actual host pages/PDF fixtures, keyboard, accessibility, zoom, light/dark, permissions.
- Data integrity and rollback are tested; known issues logged by severity.
- Screenshots of actual running UI included in CI artifacts or review notes.
- Next phase begins only after blockers addressed and user-intent features are present.

## Status by phase (2026-10-12)

Words follow `CLAUDE.md`: **COMPLETE** only when the user flow works in an actual loaded extension,
offline behaviour succeeds, data persists across restart and reload, and the phase's acceptance tests
pass with evidence; otherwise **PARTIAL** or **BLOCKED**, honestly. No phase is COMPLETE, for the
reasons in each row: the only green Actions run (38139836238, 2026-10-11) drove Playwright's bundled
Chromium and predates the finish wave (`docs/plans/FINISH_BRIEF.md`, ADR-011 to ADR-020), and branded
Chrome, Edge and the manual checklist have not been used (`docs/MANUAL_TEST_CHECKLIST.md`). "CI
pending" means written and not yet executed by an Actions run that concluded `success`; the evidence
per statement is in `docs/PRIVACY_CLAIMS.md`, the test inventory in `TEST_PLAN.md`.

| Phase | Status | Evidence that exists | What is missing |
| --- | --- | --- | --- |
| 0 Foundation | PARTIAL | WXT, React, TypeScript, Vitest, Playwright, ADRs 001 to 010; production build gated by `scripts/check-build.mjs` (run 38139836238) | The gate "in stable Chrome" (branded Chrome ignores `--load-extension`: manual, MT-01 to MT-04); the new size budgets (content script 220 KB, worker 450 KB, total 6800 KB) have not passed a `build` job yet |
| 1 Capture to bank | PARTIAL | `capture`, `compat`, `gate10`, `lifecycle`, `overlay`, `permissions`, `resilience` specs passed in Playwright's Chromium (run 38139836238). The overlay is now on Preact (ADR-012) and a selection made before activation shows the toolbar: CI pending | Real sites (MT-13a to MT-13k); the Preact overlay in real Chrome (MT-61); a real private window (MT-21) |
| 2 Knowledge manager and storage | PARTIAL | Dashboard, search, trash, backup and restore, 10,000-highlight specs (run 38139836238). Finish wave: schema v4 (ADR-011), auto-filing rules (ADR-017), syllabi (ADR-020), links, folders to depth 32, JSON export, Word, PowerPoint, EPUB, HTML and Anki import (ADR-014), backups into a folder (ADR-016): unit files written, e2e specs written, CI pending | A real Chrome upgrade of a v3 profile (O17); the folder prompt on a real disk (MT-54); real office files (MT-59) |
| 3 PDF reader | PARTIAL | Synthetic fixtures, web open, OCR, private-tab specs passed (run 38139836238). Finish wave: eleven real public-domain PDFs, open, outline, search, highlight and reopen, one OCR page, windowing and heap (`pdf-real*.spec.ts`, `real.integration.test.ts`): CI pending; reader keyboard route to the save bar: CI pending | A real incognito window (MT-45); Chrome's prompt and grant hand-back (MT-39); caret browsing (MT-53) |
| 4 Retention | PARTIAL | Review, FSRS, study day, analytics, offline specs passed (run 38139836238). Finish wave: opt-in reminders (ADR-019), exam simulation and syllabus coverage (ADR-020): CI pending | Reminders across a real browser restart and wall-clock time (MT-55); the exam with a screen reader (MT-57) |
| 5 AI enhancement | PARTIAL | Single provider, consent, failure paths, key containment passed against a local fake provider (run 38139836238). Finish wave: provider router with fallbacks, three more task kinds, chat with your notes (ADR-013): CI pending | Two real providers and Chrome's prompt for a second origin (MT-60); a real https provider (MT-47) |
| 6 Sync and integrations | PARTIAL | Sync against the reference server and a stand-in sign-in provider, two profiles, worker suspension (run 38139836238); Anki and Obsidian-compatible exports. There is no account system and no hosted service (README) | A real OIDC provider over https and the native prompts (MT-46, MT-47); production-complete server is out of scope |
| 7 Release hardening | PARTIAL | THREAT_MODEL, A11Y_REVIEW, PERF_REVIEW, release gates, privacy and store drafts, claims ledger | `release.yml`, `reproducible-build.yml` and `stress.yml` have never run; the manual checklist (MT-01 to MT-61) has not been run; the privacy policy and listing carry owner markers; screenshots are not composed |

Items of the PRD that were deliberately not built, with reasons, are in `PRD.md` "Delivery status"
(shared banks, calendar and cloud-drive sync, YouTube captions, semantic search, image occlusion, a
reading view). Edge automation is not part of any phase: Edge ignores `--load-extension`, so it stays
a manual item.
