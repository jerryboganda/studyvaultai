# Security policy

How to report a vulnerability in StudyVault AI, what is in scope, and what to expect. The threat model
and its open items are in `THREAT_MODEL.md`; the rules the code is held to are in
`SECURITY_PRIVACY.md`.

## Reporting a vulnerability

Please report privately and do not open a public issue or pull request for a vulnerability.

**Contact:** [USER-REQUIRED: a monitored security contact: an email address, or the repository's
private vulnerability reporting address if the owner enables it in the repository settings. This
file has no contact until the owner supplies one.]

Include, as far as you can:

- the version (`manifest.json` `version`, or the commit) and the browser and operating system;
- what you did, what you expected and what happened, with a minimal page, file or request that
  reproduces it;
- what an attacker could gain (read stored highlights, make the extension save or send data, run
  script in an extension page, escalate permissions, and so on);
- whether the problem is already public.

Please test only with data and accounts you own. Do not access other people's data, including data
held on someone else's sync server.

## Scope

In scope:

- the extension: the content script and overlay, the service worker, the popup, side panel, options,
  dashboard, review, onboarding and PDF reader pages, and the message protocol between them;
- bundled third-party code as shipped (PDF.js, Tesseract, DOMPurify, marked, React and the rest of
  the production dependency closure listed in the SBOM);
- how StudyVault handles untrusted input: web pages, PDFs, OCR output, imported files and backups,
  AI output and sync payloads;
- the release pipeline in `.github/workflows` and the scripts in `scripts/`;
- the reference sync server in `server/`, as a reference implementation only (it says in its own
  README that it is deliberately not production-complete).

Out of scope:

- a compromised browser, operating system or user profile, and a user who installs a modified build;
- weaknesses of a website the user visits, of the AI provider or of the sync operator the user chose,
  except where StudyVault leaks more than it documents;
- exposures that `SECURITY_PRIVACY.md` and `PRIVACY_POLICY.md` already list as accepted: a page can
  read the highlight registry on a site where StudyVault paints, and can tell that StudyVault runs
  (THREAT_MODEL R1, R2);
- findings that need physical access to an unlocked machine, social engineering, or denial of service
  by loading extremely large documents on a machine you control.

## Supported versions

There is no published release yet: the version in `package.json` is 0.1.0 and has not been
submitted to a store. Fixes are made on `main`. Once releases exist, the latest published version is
the one that is supported; older versions are not patched, because the store updates users to the
newest version and data migrations are forward-only (`RELEASE.md`, "Rollback").

## What to expect

The maintainer handles reports on a best-effort basis. No acknowledgement or fix time is promised in
this file. [USER-REQUIRED: if you want to commit to an acknowledgement time, a fix target or a
disclosure window, state it here; the repository does not invent one.]

A confirmed vulnerability is fixed on `main`, shipped through the release pipeline (`RELEASE.md`),
and described in `CHANGELOG.md` under "Security" without exploit detail. Reporters are credited if
they wish.

## Checking what you installed

Each release is built from a tagged commit by `release.yml`, which publishes `SHA256SUMS`, a
CycloneDX SBOM and a licence report next to the zip, and compares two independent builds of the same
commit (`reproducible-build.yml`). Compare the zip you hold with `SHA256SUMS`. As of 2026-10-11 these
workflows have not yet run on the default branch, and build provenance attestation is not generated
(THREAT_MODEL O10).
