# AGENTS.md - Project rules for every coding agent

Applies to all agents and sub-agents working in this repository (Claude Code, Codex, Copilot, humans
using agents). `CLAUDE.md` imports this file so Claude Code loads it automatically.

Repository: <https://github.com/jerryboganda/studyvaultai> (public). Default branch: `main`.

## Rule 1 - GitHub Actions does the heavy compute

The local machine is small (4 CPUs). **Run every compute-intensive task on GitHub Actions, not locally.**
Workflow: `.github/workflows/ci.yml`.

### Must run on Actions (do not run these locally)

| Task | Local command you must NOT run | Actions job |
| --- | --- | --- |
| Fresh install / lockfile verification | `pnpm install --frozen-lockfile` from clean | every job |
| Lint (whole project) | `pnpm lint` | `static (lint)` |
| Typecheck (whole project) | `pnpm typecheck` | `static (typecheck)` |
| Format check (whole project) | `pnpm format` | `static (format)` |
| Full unit suite | `pnpm test` | `unit` |
| Production + e2e builds, zip | `pnpm build`, `pnpm build:e2e`, `pnpm zip` | `build` |
| Browser E2E (Playwright, loaded MV3 extension), Linux + Windows | `pnpm test:e2e`, `playwright test` (full) | `e2e` |
| Stress / performance / large-corpus suites | any | dedicated jobs (add them to `ci.yml`) |
| Dependency audit, license check, bundle-size report | `pnpm audit` etc. | `audit`, `build` |
| Anything else that takes more than ~30 s or saturates the CPU | | add a job |

If a new kind of heavy check is introduced, **add it to `ci.yml` in the same change** - do not make it a
local-only script.

### Allowed locally (cheap, scoped)

- Reading, searching and editing code.
- A scoped check on the files you touched: `pnpm exec vitest run <one file or dir>`,
  `pnpm exec eslint <files>`, `pnpm exec prettier --write <files>`.
- Debugging a CI failure: re-running **one** failing Playwright spec with one worker
  (`pnpm exec playwright test <file> --workers=1 -g "<name>"`) against an already-built `.output`.
  Prefer downloading the CI trace/screenshots instead (`gh run download`).
- Interactive, exploratory verification in a real browser that Actions cannot give you.

### The loop

```bash
git switch -c agent/<topic>            # or work on main for small, safe changes
git add -A && git commit -m "..."      # include the Co-Authored-By trailer
git push -u origin HEAD                # push triggers CI
gh run list --branch "$(git branch --show-current)" --limit 3
gh run watch <run-id> --exit-status    # blocks until done; non-zero on failure
gh run view <run-id> --log-failed      # only the failing steps
gh run download <run-id> -D .ci-artifacts   # playwright-report, traces, screenshots
```

Manual run of the whole pipeline: `gh workflow run ci.yml --ref <branch>`.

### Honesty

- Report a check as passed **only** with evidence: the Actions run URL (and conclusion) or the exact
  local command output. "It should pass" is not a result.
- If CI is red, say so and say which jobs and tests failed. Never edit a test to hide a product defect.
- Do not mark skipped or not-run jobs as passed. `ci-ok` aggregates the required jobs; a cancelled or
  skipped dependency is a failure.

## Rule 2 - Multi-agent orchestration

- Concurrency is bounded by the machine: do not fan out many agents that each run suites locally.
  Agents write code and scoped tests; the orchestrator (one pusher) triggers CI and distributes the
  failing logs.
- Only one agent pushes at a time. Sub-agents never `git push`, never force-push, and never rewrite
  history.
- Sub-agents own disjoint paths (see the task prompt). Shared contracts (`packages/shared`,
  `docs/adr`) change only through the orchestrator.

## Rule 3 - Workflow hygiene (`ci.yml`)

- Least privilege: `permissions: contents: read` unless a job proves it needs more.
- No secrets, tokens or API keys in workflows, code or artifacts. The product needs none.
- Pin third-party actions to a released major version tag at minimum; prefer official `actions/*`
  and `pnpm/action-setup`.
- Upload `.output` artifacts with `include-hidden-files: true` (dot-directories are skipped otherwise).
- Keep jobs parallel; share one build between `e2e` jobs through artifacts instead of rebuilding.
- Always upload Playwright reports/traces with `if: always()`.

## Rule 4 - Project contract

The engineering contract lives in `CLAUDE.md` (Manifest V3, local-first, least privilege, honest
verification). The phase plan is `ROADMAP.md`; decisions are `docs/adr/`.
