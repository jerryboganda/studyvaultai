# Execution brief: Phases 2-7

Read AGENTS.md and CLAUDE.md first. This file is the shared contract for every parallel agent.
Phase 1 (capture -> save -> restore) is implemented and CI-verified (docs/adr/001-005).

## Working rules (all agents)
- Edit ONLY your owned paths (given in your task). Other agents run concurrently. Shared contracts
  (`packages/shared`, `wxt.config.ts`, `package.json`, `eslint.config.js`, CI workflows) change only
  where your task says so, and only additively.
- Dependencies are ALREADY installed and pinned: `dexie`, `dexie-react-hooks`, `zod`, `uuidv7`, `react`,
  `pdfjs-dist`, `ts-fsrs`, `minisearch`, `fflate`, `marked`, `dompurify`, `tesseract.js`. Do not edit
  `package.json`. Do not add a dependency; if you truly need one, say so in NEEDS OTHERS.
- Local checks are SCOPED (AGENTS.md Rule 1): `pnpm exec vitest run <your dirs>`, eslint/prettier on your
  files. One e2e repro at a time with `SV_OUT_DIR=.output-<role>`. CI runs everything; do not commit/push.
- Pure packages (`@search @study @ai @sync @backup @shared @highlights`) must not import `wxt`, `react`,
  `dexie` or `@storage` (ESLint enforces it). They take dependencies by injection (ports) so they are
  unit-testable in Node. `@pdf` and `@ocr` may use DOM/Worker APIs but not React, Chrome APIs or Dexie.
- Treat pages, PDFs, filenames, imported data, OCR and AI output as untrusted. Validate with Zod at every
  boundary. Render text as text nodes. No `eval`, no remote code, no network except where the task says
  (AI provider call, optional sync server), always behind explicit user consent.
- Quotes (`exactQuote`) and source provenance are immutable. AI output is stored separately, labelled
  `unverified`, linked to evidence, and never overwrites a quote or a human note.
- Every control works or is disabled with an explanation. No placeholders, no fake metrics, no stub
  functions presented as features. Unfinished things must be absent or honestly disabled.
- Report only what you executed. Final report format: STATUS; CHANGES (files); PUBLIC API; VERIFICATION
  (exact commands + counts); LIMITATIONS; NEEDS OTHERS.

## Module map (aliases already wired in wxt.config.ts / eslint.config.js)
| Alias | Path | Kind | Owner task |
| --- | --- | --- | --- |
| `@search` | packages/search/src | pure | search |
| `@study` | packages/study/src | pure | study |
| `@ai` | packages/ai/src | pure (fetch injected) | ai |
| `@pdf` | packages/pdf/src | DOM + pdfjs | pdf |
| `@ocr` | packages/ocr/src | Worker + tesseract.js | ocr |
| `@sync` | packages/sync/src | pure (+WebCrypto) | sync |
| `@backup` | packages/backup/src | pure (+fflate) | backup |
| `@storage` | packages/storage/src | Dexie | vault |
| reference server | server/ | node:http, tests in server/**/*.test.ts | sync |

## Database plan (Dexie schema version 2, implemented by the `vault` task)
Existing v1 tables stay: `banks, sources, highlights, highlightBanks`. v2 ADDS (indexes in `[]`):
- `folders` [id, bankId, parentFolderId, [bankId+parentFolderId], position, updatedAt, deletedAt]
  (Bank > Folder > Topic > Subtopic is ONE nested table, max depth 8, validated)
- `tags` [id, nameKey(unique-ish), updatedAt, deletedAt]  and  `highlightTags` [[highlightId+tagId], highlightId, tagId]
- `notes` [id, highlightId, sourceId, pinned, updatedAt, deletedAt]  (user-authored Markdown)
- `knowledgePoints` [id, highlightId, updatedAt, deletedAt]
- `decks` [id, bankId, updatedAt, deletedAt]
- `cards` [id, deckId, knowledgePointId, highlightId, dueAt, state, suspended, [deckId+dueAt], updatedAt, deletedAt]
- `reviewLogs` [id, cardId, reviewedAt, [cardId+reviewedAt], sessionId]   (append-only)
- `aiResults` [id, inputFingerprint, highlightId, kind, createdAt, acceptedAt]
- `documents` [id (= content fingerprint), title, pageCount, textStatus, createdAt, updatedAt, deletedAt]  (PDFs)
- `attachments` [id, documentId, sha256, createdAt]  (optional cached PDF bytes as Blob; user-approved)
- `ocrPages` [[documentId+pageNumber], documentId]   (OCR text + word boxes, user-correctable)
- `syncOps` [id, entityType, entityId, [entityType+entityId], clientId, createdAt, sentAt]
- `meta` [key]  (schema/migration markers, search index version, sync cursor)
Source gets `type: 'web' | 'pdf'` and optional `documentId`. Highlight gains optional `customFields`
(record of string -> string|number|boolean, max 32 keys) and `capturedUrl/capturedTitle` already exist.
`HighlightBank.folderId` (reserved in v1) becomes meaningful.
Every table is soft-deletable unless stated; purge is an explicit user action.
Schemas live next to their owner: vault entities in `packages/shared/src/vault.ts`, study entities in
`packages/study/src/schema.ts`, AI in `packages/ai/src/schema.ts`, sync in `packages/sync/src/schema.ts`.
`packages/shared/src/registry.ts` defines the `TableRegistry` contract that backup/sync consume.

## Anchors
`AnchorSet` is `HtmlAnchorSet | PdfAnchorSet` (packages/shared/src/schema.ts, ADR-004 + ADR-006).
The HTML engine orphans a PDF anchor by construction; PDF anchors are resolved by `@pdf`.

## Feature flags
`Settings.features = { review, pdfReader, ai, sync }` (booleans). `ai` and `sync` default OFF and must be
switched on by the user with an explanation; nothing in those modules may run, fetch or schedule work
while its flag is off.

## Evidence standard (CLAUDE.md)
A feature is COMPLETE only when unit tests pass, an E2E or integration test exercises it in a loaded
extension where the platform allows, and CI is green. Otherwise report PARTIAL with the exact gap.
