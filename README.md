# StudyVault AI - Claude Code Development Blueprint

## Current status and documents (2026-10-11)

**Pre-release, version 0.1.0, not published.** The repository (<https://github.com/jerryboganda/studyvaultai>)
holds a Manifest V3 extension. Code exists for each phase of `ROADMAP.md` (Phase 6 covers optional
sync against a server you operate only: there is no account system and no hosted service), but
verification is partial. On 2026-10-11 the first fully green GitHub Actions run of `ci.yml` completed
(https://github.com/jerryboganda/studyvaultai/actions/runs/38139836238, branch `ci/wave-c`, commit `d641515b1154aa46597e7ebb069d2341014c125c`): lint, typecheck,
format, the unit suite, the production and e2e builds with the release gate, the advisory audit and
the seeded stress suites all concluded `success`, and the Playwright suite passed on Ubuntu and Windows
(443 tests per OS; 6 `test.fixme` tests were skipped and are not evidence; none failed or needed its
retry). That run drove Playwright's bundled Chromium against the e2e build of the extension. It does
not prove behaviour in branded Chrome or Edge, in a real incognito window, with Chrome's native
permission prompt, with a hosted OpenID Connect provider, with a screen reader or in the Chrome Web
Store review. The release workflows (`release.yml`, `reproducible-build.yml`, `stress.yml`) have never
run and the manual checklist has not been run. Read `docs/PRIVACY_CLAIMS.md` for what each privacy
and store statement is actually backed by, and treat `PRIVACY_POLICY.md` and `STORE_LISTING.md` as
drafts.

**Stack in use** (exact pins in `package.json`, rationale in ADR-002): WXT 0.21.4, Vite 8.3.4, React
19.3.0, TypeScript 6.0.3, Dexie 4.4.6 on IndexedDB, Zod 4.6.5, `pdfjs-dist` 6.4.299 (legacy build,
bundled), `tesseract.js` 7.0.0 with bundled language data, `ts-fsrs` 5.4.2, MiniSearch 7.2.0,
`marked` with DOMPurify, Vitest 5.0.3 and Playwright 1.64.0 on pnpm. Styling is plain CSS with custom
properties inside a Shadow DOM for the page overlay; **Tailwind was not adopted** (ADR-002).

**Layout.** `entrypoints/` holds the extension surfaces (`background`, `highlighter.content`,
`popup`, `sidepanel`, `options`, `dashboard`, `review`, `onboarding`, `pdf-reader`); `packages/*/src`
holds the aliased modules (`@shared`, `@runtime`, `@storage`, `@highlights`, `@search`, `@study`,
`@ai`, `@pdf`, `@ocr`, `@sync`, `@backup`, `@ui`; ADR-001); `server/` is a reference sync server,
deliberately not production-complete (there is no hosted StudyVault service); `scripts/` holds the
build, release-document, SBOM and licence gates; `tests/e2e/` holds the Playwright suite.

**How to build and test.** Heavy compute runs on GitHub Actions, not on a developer machine
(`AGENTS.md` Rule 1). Push a branch and read the run: `.github/workflows/ci.yml` runs lint,
typecheck, format, unit tests, production and e2e builds, the release gates and Playwright on Linux
and Windows. Locally you may run only scoped checks on files you touched
(`pnpm exec vitest run <file>`, `pnpm exec eslint <files>`, `pnpm exec prettier --write <files>`) and
a single failing Playwright spec with one worker; do not run the full `pnpm test`, `pnpm test:e2e` or
`pnpm build` loop locally. Cite a run URL as evidence, never "it should pass".

**Documents.**

| Group | Files |
| --- | --- |
| Engineering contract | `CLAUDE.md`, `AGENTS.md` |
| Product and design | `PRD.md`, `ARCHITECTURE.md`, `DATA_MODEL.md`, `UX_DESIGN.md`, `ROADMAP.md`, `TEST_PLAN.md`, `REFERENCES.md` |
| Security and privacy | `SECURITY_PRIVACY.md` (rules), `THREAT_MODEL.md`, `SECURITY.md` (reporting), `PRIVACY_POLICY.md` (draft), `docs/PRIVACY_CLAIMS.md` (evidence ledger) |
| Release | `RELEASE.md`, `STORE_LISTING.md` (draft), `CHANGELOG.md`, `docs/MANUAL_TEST_CHECKLIST.md` |
| Reviews | `docs/A11Y_REVIEW.md` (accessibility: findings fixed in code and unit-tested, what needs a real browser), `docs/PERF_REVIEW.md` (measured in Node and jsdom, not Chrome; ranked findings) |
| Plans | `docs/plans/EXECUTION_BRIEF.md`, `prompts/` |
| Decisions | `docs/adr/001` module layout; `002` toolchain pins and styling; `003` least-privilege site access and injection; `004` text anchoring and highlight rendering; `005` free text only in extension-origin surfaces; `006` PDF reader; `007` release pipeline and store-document gates; `008` `'wasm-unsafe-eval'`; `009` network egress for AI and sync; `010` module seams |

The blueprint below is the original product description of 2026-10-10 and is kept as written. Where
it differs from this section (creating a new repository, Tailwind), this section is current.

---

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
WXT + Chrome Manifest V3 + React + TypeScript + Vite + Tailwind (not adopted: ADR-002) + accessible component primitives; content-script Shadow DOM; IndexedDB with Dexie; chrome.storage for settings; PDF.js packaged locally; `ts-fsrs` for review scheduling; Zod at boundaries; Vitest + Playwright + extension test harness; optional Postgres + object storage + API for sync.

## Quick instruction
Start with Phase 0 in the master prompt and continue in verified vertical slices. The principal risk is persistent text/PDF anchoring, not the visual UI.
