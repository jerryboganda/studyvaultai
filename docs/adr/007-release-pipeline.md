# ADR-007: Release pipeline, store-document gates and screenshot evidence

**Status:** accepted · **Date:** 2026-10-11 · Phase 7 (release hardening).

## Context
ROADMAP Phase 7 asks for a distributable, reproducible package, a threat model, store disclosures that
match the code, and screenshots of the real running UI. The Web Store submission itself needs the
owner's developer account, so it cannot be automated here. AGENTS.md Rule 1 puts all heavy compute on
GitHub Actions and Rule 3 asks for least privilege and pinned actions.

## Decision
1. **A release is a commit CI already passed.** `release.yml` does not re-run lint, unit tests and
   the e2e matrix. It asks `gh run list --workflow ci.yml --commit <sha> --status success` and fails
   without a hit. The tag is therefore only an alias for a verified commit; the release workflow adds
   what CI does not do (checksums, SBOM, licence report, reproducibility, document gate).
2. **Nothing is published to the Web Store.** The only artifact beyond workflow artifacts is a
   **draft** GitHub release (`contents: write` on that one job, tag pushes only). Pre-release
   suffixes (`-rc.N`) mark it as a pre-release.
3. **Store documents are checked against the built manifest.** `scripts/check-release-docs.mjs`
   fails the required `build` job when a manifest permission is missing from `STORE_LISTING.md` or
   `PRIVACY_POLICY.md`. `--strict` (plain `vX.Y.Z` tags) additionally fails on any `[USER-REQUIRED: ...]`
   marker, so a policy with placeholders cannot be tagged as a publishable release.
4. **Claims are traceable.** `docs/PRIVACY_CLAIMS.md` maps each store-document statement to code and
   a test with a status; "in progress" statements are not to be published.
5. **SBOM and licence report are read from `pnpm-lock.yaml`**, not from a remote tool
   (`scripts/lib/lockfile.mjs`). The SBOM is CycloneDX 1.5 over the production closure (what can end
   up in the bundle) with the lockfile's SHA-512 integrity as component hashes. The licence audit
   has an OSI allow-list, a fail-closed rule for copyleft and unknown licences, and a short
   `EXCEPTIONS` table in the script where each entry carries its reason.
6. **Reproducibility is measured, not asserted.** The same commit is built in the workspace and from
   a `git archive` export at a different path; every file, and every zip entry, is compared by hash.
   Zip bytes are not compared (timestamps and ordering).
7. **Stress suites keep their own budgets.** `scripts/run-perf.mjs` runs files named `perf*`,
   `*.perf`, `stress*` or `*roundtrip*` through Vitest and fails on failed assertions, skipped or
   missing suites (expected areas: storage, search, study, backup) and coarse wall-time ceilings. It
   deliberately does not duplicate the latency budgets that the suites assert themselves.
8. **Screenshots are a normal spec.** `tests/e2e/screenshots.spec.ts` drives the loaded extension
   through the existing helpers, saves PNGs with a `manifest.json` under `test-results/screenshots`,
   and fails on an error page or a blank image (decoded PNG, colour variety). `ci.yml` uploads the
   folder as `screenshots-<os>`.

## Consequences
- A permission change now touches four things in one commit: `wxt.config.ts`,
  `scripts/check-build.mjs`, `STORE_LISTING.md` and `PRIVACY_POLICY.md`. That is intended.
- A tag cannot be cut from a commit that never had a CI run (for example one pushed only to a fork).
- Nightly `stress.yml` fails until every expected area has a seeded suite, and says which is missing.
- Not done: build provenance attestation (needs an action pinned at release time), automatic
  dependency update PRs, Edge Add-ons publishing. They are listed in `THREAT_MODEL.md` open items.

## Alternatives rejected
- *Re-run the whole suite inside `release.yml`:* doubles the 40-minute e2e matrix for no extra
  assurance on an identical commit.
- *`npx @cyclonedx/cyclonedx-npm`:* unpinned remote code in the release path; the lockfile already
  holds everything the SBOM needs.
- *Publish to the Web Store from CI:* needs a long-lived OAuth refresh token, which this repository
  deliberately does not hold (AGENTS.md Rule 3).
