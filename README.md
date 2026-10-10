# StudyVault AI - Claude Code Development Blueprint

Version: 1.0 | Prepared: 2026-10-10

## Product in one sentence
A local-first Manifest V3 Chrome study companion that captures cited highlights and PDF annotations, organizes them into customizable knowledge banks, and turns them into trustworthy, reviewable exam knowledge with optional AI and synchronization.

## How to use this blueprint
1. Create a new Git repository named `studyvault-ai`.
2. Copy all files in this bundle to the root of that repository.
3. Open the repository in Claude Code; the root `CLAUDE.md` is the persistent implementation contract.
4. Paste `prompts/MASTER_IMPLEMENTATION_PROMPT.md` into Claude Code.
5. Request phase-by-phase implementation with actual browser tests and evidence before advancing.
6. Do not describe any phase as complete until its acceptance gate is verified.

## Blueprint index
- `PRD.md` - user workflows, scope, features, product principles, non-goals.
- `ARCHITECTURE.md` - browser extension, storage, anchoring, PDF, sync and AI architecture.
- `DATA_MODEL.md` - entities, immutable source provenance, SQLite/Postgres-friendly schemas.
- `UX_DESIGN.md` - surfaces, interactions, design tokens, accessibility.
- `ROADMAP.md` - phased delivery, dependencies, and go/no-go acceptance gates.
- `TEST_PLAN.md` - automated and manual compatibility matrix.
- `SECURITY_PRIVACY.md` - Chrome Web Store, least privilege, user data, AI isolation, prompt injection.
- `CLAUDE.md` - compact engineering rules for Claude Code.
- `prompts/MASTER_IMPLEMENTATION_PROMPT.md` - master coding agent prompt.
- `prompts/PHASE_PROMPTS.md` - independent phase prompts and handoff format.
- `REFERENCES.md` - authoritative sources and important platform caveats.

## Product principles
- Core highlight, annotate, search, organize, review, export and backup functions must work with no account, API key, internet, or backend.
- Do not promise unrestricted access to Chrome's internal PDF viewer, Chrome internal pages, site-controlled cross-origin frames, DRM-protected pages, or inaccessible documents.
- User quotations are immutable provenance; AI output is separately stored, attributed, confidence-marked and editable.
- Respect user choice, minimal permissions and explicit consent to process documents with AI or send them to cloud services.
- Preserve data across restart/update, with recoverable versioned backups.
- Functionality must be demonstrably complete, not just visually presented.

## Recommended stack
WXT + Chrome Manifest V3 + React + TypeScript + Vite + Tailwind + accessible component primitives; content-script Shadow DOM; IndexedDB with Dexie; chrome.storage for settings; PDF.js packaged locally; `ts-fsrs` for review scheduling; Zod at boundaries; Vitest + Playwright + extension test harness; optional Postgres + object storage + API for sync.

## Quick instruction
Start with Phase 0 in the master prompt and continue in verified vertical slices. The principal risk is persistent text/PDF anchoring, not the visual UI.
