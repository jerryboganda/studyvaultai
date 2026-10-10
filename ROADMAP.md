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
