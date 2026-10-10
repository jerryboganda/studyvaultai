# StudyVault AI - Engineering Contract

You are implementing a real production-quality Chrome study companion, not a UI mockup.

Read `README.md`, `PRD.md`, `ARCHITECTURE.md`, `DATA_MODEL.md`, `UX_DESIGN.md`, `SECURITY_PRIVACY.md`, `ROADMAP.md`, and `TEST_PLAN.md` before architecture changes. Read references when checking platform assumptions.

## Non-negotiable rules
- Manifest V3; WXT + React + TypeScript; official Chrome APIs; locally bundled executable code; least privilege.
- Local-first: core annotations, banks, search, notes, flashcards, review and backup work without internet, account or AI.
- Source provenance immutable; AI output separate, evidence-linked and 'unverified' unless specifically validated.
- Do not claim general access to Chrome's internal PDF viewer. Use extension-owned PDF.js reader and explicit import/Open in StudyVault flow.
- Do not silently scrape browsing history, transmit private content or require blanket all-sites permissions at install.
- No secrets in extension bundles. Treat all webpages and documents as untrusted.
- Avoid changing page markup; prefer CSS Custom Highlight API with recoverable anchors. Isolate overlay styles in Shadow DOM.
- Avoid stateful assumptions in a Manifest V3 service worker; durable jobs and explicit error handling are required.
- Every control works, reports real progress, or is intentionally disabled with an explanation. No dead controls, placeholders or fake charts.
- Preserve user data in transactions; version schemas; support backup/restore and migration testing.
- Fix correctness and security blockers before visual polish. Do not claim tests ran unless actually executed.

## Process
1. Inspect git status/repository and framework versions; use verified released dependency versions and lockfile.
2. Propose architecture decisions only where needed and record them as brief ADRs.
3. Work in `ROADMAP.md` order, one end-to-end tested vertical slice at a time.
4. For meaningful UX work, use available design and accessibility specialists; synthesize one cohesive design contract.
5. Run lint, typecheck, unit tests, browser E2E and production build appropriate to each phase **on GitHub Actions** (AGENTS.md Rule 1); local runs are scoped to the files you touched. Cite the Actions run URL as evidence.
6. Test Chrome real contexts: permissions, content script, side panel, popup, service worker suspension, PDF reader, import/backup and restricted pages.
7. Produce a report with changed files, actual verification results, exact limitations, and remaining blockers after every phase.

## Build and test commands
Scripts are defined in `package.json`: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`, `pnpm build`. They are executed by `.github/workflows/ci.yml`; do not run the full versions locally (see below).

## Project rules (AGENTS.md)
@AGENTS.md

## Implementation preferences
Dexie on IndexedDB; Zod at data boundaries; typed event message protocol; PDF.js worker bundled; `ts-fsrs` review scheduler; Vitest/Playwright. Use feature detection and accessible fallback. Chrome first; Edge second.

## Completion
COMPLETE only if user flow works in an actual loaded extension, offline behavior succeeds, data persists across restart and reload, and phase acceptance tests pass with evidence. Otherwise return PARTIAL/BLOCKED honestly.
