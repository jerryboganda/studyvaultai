# ADR-002: Toolchain pins and styling approach

**Status:** accepted · **Date:** 2026-10-11

## Decision
Versions are exact-pinned in `package.json` and locked by `pnpm-lock.yaml`. All were checked against
the npm registry on 2026-10-11; peer ranges were read, not assumed.

- **TypeScript 6.0.3, not 7.x.** `typescript-eslint@8.71.1` declares `typescript <6.1.0`; TS 7.0.2 is the
  npm `latest` tag but would make type-aware linting unsupported. Revisit when typescript-eslint adds 7.
- **Vite 8.3.4**: required by `@vitejs/plugin-react@6` (via `@wxt-dev/module-react`); WXT 0.21.4 and
  Vitest 5.0.3 accept `^8`.
- **Chrome minimum 120** (`sidePanel.open` is 116+; `CSS.highlights` 105+; margin for MV3 fixes).
- **No Tailwind.** The content script injects UI into untrusted pages; plain CSS with custom-property
  tokens in a Shadow DOM keeps the injected footprint small and leak-proof. Extension pages share the
  same tokens (`@ui`).
- **E2E uses Playwright's Chromium**, not branded Chrome: Chrome 137+ ignores `--load-extension`.
- ts-fsrs, pdfjs-dist are intentionally *not* installed until Phases 3–4 need them.

## Consequences
Dependency upgrades are deliberate; Dependabot/Renovate are out of scope until release hardening.

## Amendments
- **2026-10-11 (Phases 3-7 landed).** The line "ts-fsrs, pdfjs-dist are intentionally *not* installed
  until Phases 3-4 need them" described the Phase 0 state and is no longer true: `ts-fsrs` 5.4.2
  (review scheduling, `packages/study`) and `pdfjs-dist` 6.4.299 (the PDF reader, legacy build,
  ADR-006) are installed and exact-pinned in `package.json`, together with `tesseract.js` 7.0.0
  and `@tesseract.js-data/eng` (OCR), `minisearch`, `dompurify`, `marked`, `fflate`, `dexie`,
  `dexie-react-hooks` and `uuidv7`. The pinning rules above still hold.
- **2026-10-11 (release hardening).** `.github/dependabot.yml` was added (npm and github-actions,
  weekly, grouped), so the "out of scope until release hardening" clause no longer applies. Updates
  arrive as pull requests and still go through `ci.yml`, the licence allow-list and the exact-pin
  rule; the TypeScript 6.0.3 pin keeps its reason above.
- **2026-10-12 (finish wave).** One production dependency was added: `preact` **10.29.8**, exact-pinned
  in `dependencies` (it ships in the bundle, and the SBOM and licence report scope "production" by that
  field) and used by the content script only through an alias to `preact/compat` (ADR-012); the pages
  keep React 19.3.0. 10.29.8 is the newest 10.x (published 2026-08-01); 11.0.0 (2026-09-30) and 11.0.1
  (2026-10-08) are younger than the two-week age these pins respect, so 11 is a later bump. Nothing
  else was added for the wave: the document import readers reuse `fflate` and the browser's own
  `DOMParser` (ADR-014) and TeX was then shown as source text, so no `temml` or similar was added
  (ADR-015, which records the 164 KB measurement against a 120 KB ceiling; superseded by the next
  amendment). Dependency pins are
  otherwise unchanged. The licence of the repository is proprietary (`LICENSE`, `package.json`
  `"license": "UNLICENSED"`, owner decision 2026-10-11); the licence report still lists third-party
  components under their own licences.
- **2026-10-12 (typeset math).** One more production dependency: `temml` **0.13.5** (MIT, no
  dependencies, published 2026-08-28), exact-pinned in `dependencies` and in `pnpm-lock.yaml`, loaded
  only through a dynamic `import()` the first time a rendered note holds a formula (ADR-015 amendment 1:
  a lazy chunk of about 207 KB; the non-OCR budget in `scripts/check-build.mjs` went from 6,800 to
  7,000 KB). The first integration pinned 0.14.0 (published four days earlier), which is younger than
  the two-week age the pins above respect; the pin was moved to 0.13.5 on 2026-10-12 so the rule holds
  without an exception, and the math unit and e2e specs were re-run on it (279 unit tests and 10 e2e
  tests passed locally; the next Actions run is the evidence of record). The package ships
  `dist/temml.mjs` (with the `\ce` extension); nothing else was added for the change.
