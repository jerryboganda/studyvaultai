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
