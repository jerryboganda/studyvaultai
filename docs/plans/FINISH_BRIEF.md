# Finish brief (agents: read this first)

Branch `feat/finish-all` (cut from `ci/wave-c`, which is PR #1 and green in Actions run 38139836238).
Goal: close the remaining product gaps listed in `docs/PRIVACY_CLAIMS.md` (open items),
`docs/PERF_REVIEW.md`, `docs/A11Y_REVIEW.md`, the PRD P0/P1/P2 gaps in the coverage audit, and the
owner's decisions below. Everything is verified on GitHub Actions; locally only scoped checks.

## Owner decisions (2026-10-11, given in the chat)

- License: proprietary, all rights reserved. Copyright holder name stays a `[USER-REQUIRED]` marker.
- v0.1 listing: local-first core; AI and sync are optional "advanced" features, off by default, no
  hosted service is claimed or implied.
- Build everything that does not need an external account, hosted backend or third-party network
  service. Items that do are listed as out of scope with the reason (see "Out of scope").

## Rules (non-negotiable)

1. AGENTS.md Rule 1: no full lint/typecheck/test/build locally. Allowed: `pnpm exec vitest run <files>`,
   `pnpm exec eslint <files>`, `pnpm exec prettier --write <files>`, scoped `tsc` via a private temp
   tsconfig (`tsconfig.<role>.tmp.json`, delete it), one Playwright spec at a time on a private build
   (`SV_OUT_DIR=.output-<role> node scripts/build-e2e.mjs`, then playwright with `--workers=1
   --output=.output-<role>/test-results`).
2. Playwright is serialised across agents with a lock directory:
   `mkdir "C:/Users/Admin/AppData/Local/Temp/claude/D--Projects-StudyVault-AI/eb08ca0d-139f-4090-aa25-4e7647f05278/scratchpad/pw.lock"`
   succeeds only if free. If it exists wait 20 s and retry (max 10 minutes; if still busy, skip running
   e2e locally and say so: CI will run it). Always `rmdir` it when your run ends or fails.
3. Never commit or push. The orchestrator is the only pusher. Never use `git stash`/`reset`/`checkout`.
4. Other agents edit the same tree: targeted `Edit` calls only (never rewrite a file you do not own),
   re-read the region right before editing, stay in your owned paths. Shared contracts
   (`packages/shared/src/{schema,settings,protocol,constants}.ts`, `packages/storage/src/{db,registry,
   index}.ts`, `wxt.config.ts`, `scripts/check-build.mjs`) get minimal additive edits only.
5. Settings change only through `updateSettings` (the worker enforces a trusted copy). E2E specs change
   settings through the e2e-only `patchSettings` helper (message `e2e.settings.patch`), never by writing
   `chrome.storage.local`.
6. Every new control works, reports real progress or is disabled with a reason. New UI: accessible names,
   focus return, live regions, 24 px targets, reduced motion, forced-colors, dark/light tokens only
   (no raw colours), reflow at 320 px. Axe runs in e2e (`settleAnimations(page)` before analysing).
7. Local-first: nothing new may require network, an account or AI. Any new network path is user-initiated,
   documented in `SECURITY_PRIVACY.md`, and covered by the existing consent/permission pattern.
8. New persisted data: Zod schema, Dexie migration with test, backup registry entry (round trip), sync
   policy classification (immutable/text/sets/local), integrity check, purge/wipe cascade, ADR.
9. Bundle budget: current prod total 6486 of 6500 KB, content script 405 of 450 KB, background 382 of
   420 KB. New code must be lazy (`import()`) where it is not needed at page start, and you must report
   your measured size delta (read the private build folder). Do not edit the budgets in
   `scripts/check-build.mjs`: the orchestrator sets them from the measured totals.
10. Write the e2e spec for your feature (one new file `tests/e2e/<feature>.spec.ts`, helpers in
    `tests/e2e/helpers.<feature>.ts`), reusing existing helpers. CI uses `failOnFlakyTests`: wait on real
    conditions, no sleeps. If you cannot run it locally (lock busy), still write it carefully.
11. Do not claim tests ran unless you ran them. Final report: files, tests (titles), exact commands and
    results, size delta, defects found, limitations, and any text the docs agent must mirror.

## ADR numbers

011 schema v4 (rules, syllabi, relations) · 012 Preact in the content script · 013 AI router and new task
kinds · 014 import formats · 015 math rendering · 016 backup folder · 017 filing rules · 018 relations
and graph · 019 reminders · 020 exam simulation and syllabus coverage.

## Out of scope (with reasons; the docs agent records them)

Shared/collaborative banks and calendar/cloud-drive sync (need a hosted service or third-party accounts);
YouTube caption capture (needs a network fetch of third-party pages and host permission); semantic
(embedding) search (needs a model download of tens of MB; lexical related-highlights is provided
instead); image occlusion (PRD itself defers it: needs image assets); readability/reading view (anchors
must point at the original page, a derived view would break immutable provenance); Edge automation
(Edge ignores `--load-extension` like branded Chrome 137+, so it stays a manual checklist item).
