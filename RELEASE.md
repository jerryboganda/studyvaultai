# Releasing StudyVault AI

> **DRAFT: describes intended behaviour; not for publication until every docs/PRIVACY_CLAIMS.md row it depends on is `verified`.**
>
> This file describes the release process as designed. Status on 2026-10-11, checked with
> `gh run list` and `gh run view`: the first `ci.yml` run in which every job concluded `success` is
> https://github.com/jerryboganda/studyvaultai/actions/runs/38139836238 (branch `ci/wave-c`,
> commit `d641515b1154aa46597e7ebb069d2341014c125c`); the 13 completed runs before it all concluded `failure`.
> That run exercised the static checks, the unit suite, both builds and the release gate, the audit
> and stress jobs, and the Playwright suite in Playwright's bundled Chromium on Ubuntu and Windows
> (443 tests per OS passed, 6 `test.fixme` skipped, none failed or flaky). `release.yml`,
> `reproducible-build.yml` and `stress.yml` have never executed (they are not on the default branch;
> `gh workflow list` shows only `CI`), so nothing those three do has been exercised, and the manual
> checklist has not been run. The hardening changes of the second pass (CHANGELOG.md, Unreleased) have
> unit and integration tests and e2e specs that passed in that run, and have not been seen in branded
> Chrome or Edge. Do not read "the pipeline proves X" as "X has been proven".

How a version gets from `main` to the Chrome Web Store, what the pipeline proves on the way, and
what only the account owner can do. The pipeline never publishes to the store: that needs the
owner's developer account and stays a manual step by design.

## The pipeline at a glance

| Workflow | Trigger | What it does |
| --- | --- | --- |
| `ci.yml` | every push, PR to `main`, manual | Required gate: lint, typecheck, format, unit tests, production and e2e builds, zip, `scripts/check-build.mjs`, `scripts/check-release-docs.mjs`, Playwright on Linux and Windows, and the seeded `stress` suites. Uploads traces, the screenshot set and the perf timings; writes a bundle-size table to the job summary. Advisory: `pnpm audit`, licence allow-list, `stress`. Job-by-job detail: "CI map" at the end of this file |
| `release.yml` | tag `v*`, manual (dry run) | Requires a green `ci.yml` run for the same commit, checks the tag against `package.json`, builds, runs the build gate and the licence audit, checks the store documents, zips, writes `SHA256SUMS` and a CycloneDX SBOM, runs the reproducible-build check, uploads everything as the `release` artifact and, for a tag, creates a **draft** GitHub release |
| `reproducible-build.yml` | called by `release.yml`, weekly, manual | Builds twice (workspace, and a clean `git archive` export at another path) and compares every file by hash |
| `stress.yml` | nightly, manual | The same steps as the `stress` job of `ci.yml`, for runs no push triggered: seeded 10k-row suites with `SV_PERF=1`; timings JSON and a summary table; fails on a broken budget, a skipped or missing suite |

Scripts (all plain Node, no remote code): `scripts/check-build.mjs`, `scripts/check-release-docs.mjs`,
`scripts/license-report.mjs`, `scripts/sbom.mjs`, `scripts/repro-compare.mjs`,
`scripts/run-perf.mjs`. Each is wired to a `pnpm` script of the same purpose.

## Versioning

- **SemVer** in `package.json` (`X.Y.Z`). WXT writes it to the manifest `version`; Chrome accepts one
  to four dot-separated integers and requires every upload to be higher than the last one.
- **Candidates** are tags with a suffix (`v0.3.0-rc.1`): same artifacts, the documents may still
  contain `[USER-REQUIRED: ...]` markers, and the GitHub release is marked pre-release. `package.json`
  stays `0.3.0`.
- **A publishable release** is a plain `vX.Y.Z` tag. `release.yml` runs
  `check-release-docs.mjs --strict` for it, which fails while any `[USER-REQUIRED: ...]` marker is left in
  `PRIVACY_POLICY.md` or `STORE_LISTING.md`.
- **Data versions are separate**: the IndexedDB schema (Dexie version, `docs/adr`), the backup format
  and the sync protocol each carry their own number. A release that changes one needs a migration, a
  fixture of the previous version and an entry under "Data and schema" below.
- Permission changes are a release-level event: they trigger store review and, for users, a new
  warning or a disabled extension. Keep them out of patch releases.

## Procedure

1. **Freeze.** All work for the release is on `main` and `ci.yml` is green on that commit. Read the
   open items in `THREAT_MODEL.md` and the rows in `docs/PRIVACY_CLAIMS.md` that are **in
   progress**, **unit-only**, **open**, **fix in progress** or **manual**; a statement whose row is not
   `verified` (with a green run URL recorded) must not be published, and the DRAFT banners in
   `PRIVACY_POLICY.md`, `STORE_LISTING.md`, `RELEASE.md` and `docs/PRIVACY_CLAIMS.md` come off only
   then.
2. **Version and notes.** Bump `package.json`, write the changelog entry (template below), update
   `STORE_LISTING.md` and `PRIVACY_POLICY.md` for anything that changed (the build fails if a
   manifest permission is missing from either), and update "Known limitations" below.
3. **Dry run.** `gh workflow run release.yml --ref main`, then `gh run watch`. Download the
   `release` artifact and verify: `sha256sum -c SHA256SUMS`; open the zip's `manifest.json`;
   skim `licenses.json` and the SBOM.
4. **Manual checks.** Install the zip unpacked in branded Chrome and Edge and fill in
   `docs/MANUAL_TEST_CHECKLIST.md` (the upgrade check needs the previous release). Attach the
   evidence table to the draft release. Blocker failures stop the release.
5. **Tag.** `git tag -a vX.Y.Z -m "StudyVault AI X.Y.Z" && git push origin vX.Y.Z`. `release.yml`
   builds again from the tag and creates the draft release with the zip, `SHA256SUMS`, SBOM and
   licence report.
6. **Review the draft.** Confirm the checksum of the zip you will upload equals the one in
   `SHA256SUMS`; confirm the reproducible-build job passed.
7. **Submit by hand** (section "What you must do by hand"). Choose deferred publishing so you can
   still pause after approval.
8. **After approval,** publish the GitHub release, monitor the dashboard's error and review feedback,
   and keep the previous zip available for rollback.

## Changelog template

```markdown
## X.Y.Z - YYYY-MM-DD

### Added
### Changed
### Fixed
### Security
### Removed

### Permissions
None changed. / Added `name`: why, and what the user sees.

### Data and schema
None. / IndexedDB version N -> N+1: migration, tested against fixture <file>; backup format; sync protocol.

### Known issues
- <issue>, severity, workaround.

### Verification
CI run: <url>. Manual checklist: <date>, <N> pass / <N> fail / <N> not run, blockers: none.
Zip SHA-256: <hash>.
```

## Rollback

- **The store cannot roll back.** A published version stays; the fix is a newer version number. To
  go back, revert on `main`, bump the patch version, tag it, and ship it through the same pipeline
  (the dry run and checklist can be shortened to the affected rows, never skipped). In an emergency
  unpublish the item in the dashboard, or pause a staged rollout.
- **Data does not roll back.** Migrations are forward-only; an older build that meets newer data
  refuses to write and says so (`packages/storage/src/db.ts`, `NEWER_DATA_MESSAGE`), which is what
  makes "go back one version" safe for users. A release that changes the schema must therefore keep a
  restore path: backups written by the previous version must still restore, which is what
  `packages/backup/src/migrate.ts` and its fixtures are for.
- **Pipeline artifacts.** A bad draft release is deleted by hand (`gh release delete`); a pushed tag
  is deleted with `git push --delete origin <tag>` before anyone has downloaded from it, and
  superseded by a new patch otherwise.

## What you must do by hand

The pipeline cannot do these; none of them should be skipped or delegated to an agent.

| # | What | Where it is used |
| --- | --- | --- |
| 1 | Create the Chrome Web Store developer account (one-time registration fee, 2-step verification on the Google account, verified contact email) | Upload and publish |
| 2 | Decide and enter the **trader or non-trader** status the dashboard asks for (EU consumer-law declaration) and any address it requires | Distribution tab |
| 3 | Host `PRIVACY_POLICY.md` at a public HTTPS URL and put that URL in the dashboard and in the extension's Settings. GitHub Pages on this repository is enough; enabling it is a repository setting only the owner can change | Privacy practices, listing |
| 4 | Provide a monitored **support email or issue-tracker URL**, and a vulnerability-reporting address (fill the marker in `SECURITY.md`; `check-release-docs.mjs` also scans `SECURITY.md` and `README.md` for markers, and `--strict` fails while one remains) | Listing, policy, security |
| 5 | Resolve every `[USER-REQUIRED: ...]` marker in `PRIVACY_POLICY.md` and `STORE_LISTING.md` (legal name, effective date, operator of any hosted AI or sync service, deletion process, minimum age) and have the policy reviewed by someone qualified | `check-release-docs.mjs --strict` |
| 6 | Choose and compose the store screenshots (1280 x 800, flattened PNG or JPEG) from the CI `screenshots-*` artifact, and decide whether to make promo tiles | Listing |
| 7 | Choose a `LICENSE` for the repository (none exists today, so the code is "all rights reserved" regardless of being public) | Repository |
| 8 | Run `docs/MANUAL_TEST_CHECKLIST.md` on real Chrome and Edge, and a screen reader, and sign off the evidence | Gate |
| 9 | Upload the zip, paste the permission justifications, remote-code answer and data-usage answers from `STORE_LISTING.md`, submit, and choose deferred publishing | Dashboard |
| 10 | Optional: Microsoft Partner Center account to list the same zip on Edge Add-ons | Edge |

## Known limitations

Taken from the ADRs, the code and the test plan on the date below; remove an entry only when the
code changes, and say where it came from.

Written 2026-10-11 for 0.1.x. Modules still being integrated are listed separately.

### Where it can run

- **Restricted pages.** No script runs on `chrome://`, `edge://`, the Chrome Web Store, `view-source:`,
  `devtools://`, other extensions' pages or managed pages; `file://` needs the user's "Allow access to
  file URLs" switch. The UI names the reason (ADR-003, `entrypoints/background/siteAccess.ts`).
- **Built-in PDF viewer.** Not accessible to extensions; Chrome's own PDF annotations have no public
  API (SECURITY_PRIVACY.md). The extension-owned reader is the supported route.
- **Frames and shadow DOM.** The script is injected into the top frame only (`allFrames: false`);
  text in iframes is not captured. Open shadow roots are not traversed and closed ones cannot be
  (ADR-004).
- **First use needs one click.** Without install-time site access, the first use on a site is a click
  or shortcut (`activeTab`); persistence needs a per-site or all-sites grant (ADR-003).
- **Private windows** are refused unless enabled, and then share the profile's database. The PDF
  reader follows the same rule: in a private window, or one it cannot identify, it opens and shows
  the file but stores nothing (docs/PRIVACY_CLAIMS.md P10a; a real private window is not automated).
- **Browsers.** Chromium-based only; Chrome 120 or newer (`minimum_chrome_version`). No Firefox,
  Safari or mobile.

### Capture and anchoring

- **Never silently wrong.** A passage that cannot be located with confidence is `ambiguous` or
  `orphaned`, is not painted, and appears under "Needs attention" (ADR-004). Pages that rewrite
  their text produce such passages by design.
- **Text algorithm changes** orphan existing anchors until a migration exists (`sv-text-v1`,
  ADR-004).
- **Hidden text is part of the anchor space**; text that is only drawn on a canvas cannot be
  selected.
- **Highlights are visible to scripts of the page** through the shared highlight registry
  (ADR-004, SECURITY_PRIVACY.md "Exposures to page scripts").
- **Without `CSS.highlights`** (older browsers) nothing is painted; capture still works and the UI
  says so.
- **Notes need the side panel.** Free text is never typed in the page (ADR-005). "Save and add a
  note" depends on Chrome honouring the click as a user gesture (about 5 s); a slow save reports
  failure and keeps the highlight.

### Keyboard

- Chrome allows four suggested shortcuts; "previous highlight" has none until the user assigns one.
  `Alt+Shift+]` and `Alt+Shift+[` work only while the page has focus because `[` and `]` are not
  valid manifest keys (`wxt.config.ts`).

### Data

- **Deleted highlights stay on the device** until the user empties the trash or purges items in the
  dashboard's Trash, or deletes all data; they are soft-deleted so Undo works. A purge removes the
  item's derived AI results, knowledge-point evidence, orphan sources and, for sync, conflict,
  quarantine and never-delivered outbox copies. It does not reach the sync server's copy, an unsent
  edit of an already-delivered item, an upload attempted but not acknowledged, sync merge
  bookkeeping (up to 90 days) or the cached search index until a search page rebuilds it
  (docs/PRIVACY_CLAIMS.md P16, THREAT_MODEL R14, R15).
- **Delete all data** removes the databases (including the pre-update copy and every restore
  staging database), `storage.local`, `storage.session` and every optional site grant. The database
  delete is requested first and cannot be withdrawn: another StudyVault window that holds it makes
  the deletion wait (reads fail meanwhile) until that window closes. Once it is over the Settings
  page also gives back the optional `identity` and `alarms` permissions and removes the extension
  page's `localStorage` display preferences (best effort; a refusal is named). It does not remove any
  copy on a sync server, files the user exported or anything on other devices (P15, P15b). The
  permission removal is asserted in the e2e suite (run 38139836238), the preferences by unit tests
  only.
- **Backups hold study data only and are not signed.** Settings (theme, deny list, enabled sites,
  study-day settings, welcome-tour progress, AI and sync configuration), the AI key and sync sign-in
  are not in a backup, and `savedSearches` and a review session in progress are not either
  (ADR-010); after a restore on a new profile they are set up again. Cached PDF copies are included
  only on request. Checksums detect damage, not forgery: a merge never changes the provenance of a
  row the vault has, but a replace and rows new to the vault are taken as the file has them (R18).
- **Settings do not follow the browser account**; `chrome.storage.sync` is not used.
- **Not encrypted at rest** by the extension (THREAT_MODEL R7).
- **Newer data is read-only for older builds** (`NEWER_DATA_MESSAGE`).
- **The automatic pre-update copy** is an unencrypted full copy of the study data (no cached PDFs)
  in a database of its own; a vault above about 64 MB gets no copy and a notice to save a backup.
  "Delete all data" removes it (R21).

### Network and sync

- **Three user-initiated network paths** exist: the reader downloading a web PDF, optional AI help,
  and optional sync. The extension-pages CSP allows `connect-src https:` (ADR-009), so the CSP does
  not itself enforce "nothing leaves"; the feature switches and the user's action do.
- **There is no hosted sync service.** The user supplies a server, an OpenID Connect issuer and a
  client id; `server/` is a reference implementation that is deliberately not production-complete
  (server/README.md).
- **Sync uploads nothing until the person chooses** a passphrase or "Upload without end-to-end
  encryption"; encryption is optional. The unlocked key is held in memory-only session storage for
  at most 15 minutes and is dropped by lock, sign-out, disable, a restore that replaced the sync
  identity and "Delete all data". A server that stops presenting the key profile is refused.
  Exercised in unit and integration tests against the in-process reference server and, in run
  38139836238, in a loaded Playwright Chromium against the reference server over a socket and a
  stand-in sign-in provider. A real provider over https, the native permission prompt and branded
  Chrome's session-storage behaviour are unverified (docs/PRIVACY_CLAIMS.md P25a to P25e).

### Build and verification

- **CI runs Playwright's bundled Chromium** on Linux and Windows, headless. Branded Chrome 137 and
  later ignores `--load-extension`, so branded Chrome, Edge, macOS, native permission prompts,
  keyboard-shortcut handling, screen readers and OS contrast modes are covered only by the manual
  checklist (ADR-002, `tests/e2e/fixtures.ts`). Until it has been run for a release, those are
  **unverified**.
- **The permission prompt is not driven in CI**; the e2e build is granted loopback hosts up front
  (`wxt.config.ts`, `SV_E2E`). The production manifest is asserted separately.
- **Performance budgets** are engineering goals measured on CI runners (TEST_PLAN.md), not
  guarantees on every machine.
- **Size budgets** in `scripts/check-build.mjs` (content script, worker, total) apply to the Phase 1
  bundle; the PDF reader and OCR assets add large static files and that script must be revisited with
  them.
- **Build provenance attestation** is not generated (THREAT_MODEL O10).
- **TypeScript 6.0.3**, not 7.x, until typescript-eslint supports it (ADR-002).

### Modules still being integrated (2026-10-11)

The PDF reader and OCR, review (spaced repetition), the dashboard, the welcome tour, AI help, sync
and the backup/restore UI have screens in the loaded extension, unit tests and loaded-extension e2e
specs that passed on Ubuntu and Windows in run 38139836238. None of them has been exercised in
branded Chrome or Edge or by the manual checklist, and the e2e specs cannot see Chrome's native
permission prompt, a real incognito window or a hosted sign-in provider. The statements in the store
documents therefore stay marked in `docs/PRIVACY_CLAIMS.md`, row by row. Do not describe any of them
in a store listing until its row there says `verified` for every part the statement relies on.

The second-pass hardening changes are in the same position: unit and integration tests (the `unit`
job of run 38139836238 ran them) and e2e specs that passed there, but no branded-Chrome run and no
manual checklist. docs/PRIVACY_CLAIMS.md lists each as `verified`, `unit-only` or `open` per part, and
THREAT_MODEL.md section 7 lists the findings and the accepted limitations.

## CI map

Every job, what a green result proves, and how to run it again. Rule 1 of `AGENTS.md` applies: the
heavy ones run on Actions, not on the developer machine. Status on 2026-10-11: the first `ci.yml`
run in which every job concluded `success` is <https://github.com/jerryboganda/studyvaultai/actions/runs/38139836238> (branch `ci/wave-c`, commit
`d641515b1154aa46597e7ebb069d2341014c125c`): `static` (three jobs), `unit` (201 files, 3,693 tests passed, 12 skipped), `build`
(including `scripts/check-build.mjs` and `scripts/check-release-docs.mjs`), `audit`, `stress` (38 tests
in six suites), all eight `e2e` shards (per OS 449 tests scheduled, 443 passed, 6 `test.fixme`
skipped, 0 failed, 0 flaky) and `ci-ok`. The 13 earlier completed runs all concluded `failure`;
the earlier status note recorded their failures in `unit`, `static (format)` and `e2e` test steps, not
in the workflow wiring. `stress.yml`, `release.yml` and `reproducible-build.yml` have never executed. A green `e2e` job proves the specs passed against the
e2e build in Playwright's bundled Chromium; it does not prove the production zip (that is the release
gate and the two production-build specs), branded Chrome or Edge, a real incognito window, a permission
prompt, a hosted provider or a screen reader.

### `ci.yml`

| Job | Runs on | Gate | What a green result proves | What it does not prove |
| --- | --- | --- | --- | --- |
| `static (lint)`, `static (typecheck)`, `static (format)` | push, PR, manual | required | ESLint, `tsc --noEmit` and Prettier are clean for the whole tree | behaviour |
| `unit (vitest)` | push, PR, manual | required | every `*.test.ts(x)` under `packages/`, `entrypoints/`, `server/` passes in jsdom/node with `SV_PERF` unset (the 10k-row suite in `packages/storage` skips itself) | a loaded extension, a real browser, IndexedDB outside `fake-indexeddb` |
| `build (prod + e2e + zip)` | push, PR, manual | required | production and e2e builds succeed, the zip is produced, `scripts/check-build.mjs` (manifest, permissions, CSP, remote code, size budgets, test hooks) and `scripts/check-release-docs.mjs` pass. Uploads `extension-builds`; the size table is in the job summary | that the build is reproducible (`reproducible-build.yml`) |
| `e2e (<os>, shard <n>/4)` | push, PR, manual, after `build` | required, 2 OSes x 4 shards | the Playwright suite passes against the built MV3 extension in Playwright's bundled Chromium (headless) on Ubuntu and Windows; a test that needed its retry fails the run. Uploads `e2e-report-<os>-<n>` and `screenshots-<os>-<n>` | branded Chrome or Edge, macOS, permission prompts, screen readers (manual checklist) |
| `stress (perf suites, SV_PERF=1)` | push, PR, manual | advisory (`continue-on-error`; `ci-ok` prints it and does not require it until it has a few green runs; it has one, run 38139836238) | the seeded 10k-row and round-trip suites (`scripts/run-perf.mjs`: storage, search, highlights, backup, study: 10k-card queue and 100k review-log analytics) ran, none was skipped, and their budgets held on a CI runner. Uploads `perf-results` (`timings.json`, `summary.md`) | the study suite is pure functions (no IndexedDB), so the Zod parse of due cards in `getDueSummary` is not in it; numbers on a shared runner are regression guards, not user hardware. The 10k dashboard spec is not here: it is `perf: 10,000 highlights` in `tests/e2e/dashboard.spec.ts` and runs in `e2e` |
| `audit (advisory)` | push, PR, manual | advisory | nothing is promised: `pnpm audit --prod --audit-level=high` and the licence allow-list report | `release.yml` enforces the licence allow-list |
| `ci-ok (required checks)` | always | the only check to require in branch protection | `static`, `unit`, `build`, `e2e` all concluded `success`; failed, cancelled and skipped all count as failure (`stress` is printed, not required) | |

Concurrency: a newer run for the same branch or pull request cancels the older one; `main` is never
cancelled and every `main` run has its own group, so every commit on `main` gets a full run. A pull
request from a branch of this repository triggers both a `push` and a `pull_request` run; they are
separate groups on purpose, so both complete.

### Other workflows

| Workflow / job | Trigger | What a green result proves |
| --- | --- | --- |
| `stress.yml` / `perf` | nightly 02:23 UTC (default branch only), manual | the `stress` job's steps, on the default branch, with no push needed |
| `reproducible-build.yml` / `reproducible` | `release.yml`, weekly (default branch only), manual | two builds of one commit, one in the workspace and one from `git archive` at another path, are identical file by file, and so are the zip entries |
| `release.yml` / `ci-green` | tag `v*`, manual | `ci.yml` concluded `success` for this exact commit |
| `release.yml` / `build` | tag `v*`, manual | tag equals `package.json` version, gates and licence audit pass, store documents match the manifest, zip, `SHA256SUMS` and SBOM verify |
| `release.yml` / `reproducible` | after `ci-green` | `reproducible-build.yml` passed for this ref |
| `release.yml` / `draft-release` | tag `v*` only | a **draft** GitHub release exists with the artifacts; nothing is published to the store |

### Re-running

```bash
gh workflow run ci.yml --ref <branch>             # whole pipeline, any branch
gh workflow run stress.yml --ref <branch>         # perf suites only
gh workflow run release.yml --ref main            # release dry run (no draft release)
gh run list --branch <branch> --limit 3           # find the run
gh run rerun <run-id> --failed                    # only the failed jobs
gh run view <run-id> --log-failed                 # why they failed
gh run download <run-id> -D .ci-artifacts         # reports, traces, screenshots, perf-results
```

Scoped local checks that are cheap enough to run first: `pnpm exec vitest run <file>`,
`pnpm exec eslint <files>`, `pnpm exec prettier --check <files>`, `node scripts/run-perf.mjs --self-test`.
`node scripts/run-perf.mjs --list` shows which suites the stress runner would pick up (it starts no
tests). Do not run `pnpm test`, `pnpm build` or `pnpm test:e2e` in full locally.
