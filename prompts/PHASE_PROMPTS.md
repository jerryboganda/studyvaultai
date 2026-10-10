# Phase-by-phase Claude Code follow-up prompts

## Phase 1: Real capture and rehydration
Read the project contract. Implement and verify the entire path: user grants least-privilege site access, selects multiline text, floating toolbar appears without selection collapse, one click saves the exact quote with source and anchor into Dexie under selected bank, toast Undo works, content rehydrates on reload and revisit, side panel displays it. Add tests for duplicate source text, SPA changes, missing anchors, storage failures, keyboard selection, unsupported sites. Provide actual browser evidence. No AI yet.

## Phase 2: Vault and backup
Implement and verify unlimited hierarchical banks, topics, tags, custom fields, full-text search, batch operations, source-backed notes, duplicate hints, trash/restore, versioned schema migrations and atomic export/import with corruption handling. Test 10k seeded items, restart, backup recovery and move/merge relationships. Do not proceed until no data-loss defects remain.

## Phase 3: PDF reader
Implement locally packaged PDF.js reader and import flow; support local PDFs, authorized remote PDF URLs, zoom/search/rotate, selectable text layer, page-linked anchored highlights, persistent annotations, source fingerprinting, inaccessible PDF fallback. Test multi-column science PDF, encrypted PDF, large/rotated PDF, scanned PDF detection, and lost session/file permission. Do not attempt internal Chrome PDF viewer injection.

## Phase 4: Review engine
Implement flashcards, cloze, due queue, persisted FSRS schedule and review log, deck settings, manual edits, sources linked to answers, overdue recovery, timezone and deterministic testing. Test no network, service worker restarts, and schedule transitions.

## Phase 5: Opt-in AI
Add explicit-selection AI with consent preview, provider abstraction, budget and cancellation, sourced one-liners/exam pearls, summaries, MCQs/flashcards, structured JSON validation, trust labels, external fact verification as an explicitly separate optional workflow. Protect against prompt injection and unsupported medical facts; test timeout, provider failure, retries and no key leaks.

## Phase 6: Optional cloud/integrations
Add cloud only without regressing local mode. Auth, encryption model, sync protocol, two-device conflict tests, Anki and Markdown exports, access revoke/delete semantics. Test slow/intermittent network and concurrent edits, then security review.

## Release QA
Run full real-browser Chrome and Edge suite, privacy permission audit, 100% functional control checks, Web Store MV3 and remote code compliance, keyboard/screen-reader smoke checks, offline backup restore, dependency audits and GitHub Actions CI. Report exact pass/fail, not assumptions.
