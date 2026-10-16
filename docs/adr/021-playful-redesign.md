# ADR-021: Sunny Vault, a playful redesign with a game layer

**Status:** accepted · **Date:** 2026-10-14 · Supersedes the visual contract of Phases 0-7
(`UX_DESIGN.md` before this date). Refines ADR-002 (dependency pins; plain CSS tokens stay) and
ADR-012 (the content script's size budget stays).

## Context
The owner's verdict on the shipped UI: too verbose, bad looking, difficult. The "precise, dense,
editorial" contract produced long labels, paragraphs in panels, many tabs of equal weight and
multi-field forms for step-by-step tasks. The owner asked for a playful, graphical style everywhere
(original, Duolingo-like in spirit only), a mascot, a game layer, wizard-led flows and a short core
navigation, without giving up the engineering contract: local first, no remote code or fonts,
CSP `style-src 'self'`, Shadow DOM overlay, WCAG 2.2 AA, 320 px and 200 % zoom.

Three directions were built as clickable mockups in `gallery/mockups/`. The owner picked "Sunny
Vault" on 2026-10-14; its review pass reported 0 axe violations in 15 states per theme (mockup
only, Playwright's Chromium, no loaded extension).

## Decision
- **Visual direction: Sunny Vault** (`gallery/mockups/sunny/`): brand blue `#2A62E5` and sunshine
  yellow `#FFC83D` on a soft blue-grey canvas, chunky buttons with a 3-5 px pressable bottom edge,
  20 px card corners, light and dark themes with a manual override. `UX_DESIGN.md` is the contract
  (tokens with contrast ratios, components, layouts, copy, navigation, wizards, game UX,
  accessibility, forbidden patterns); the mockup is a reference, and the contract lists where it
  deliberately differs.
- **Mascot:** "Vault buddy", an original SVG safe character with four poses (wave, cheer, think,
  sleep). Decorative, never on web pages.
- **Game layer, on by default with a "Game mode" switch:** daily XP goal (10/30/50/100),
  rating-neutral XP (review 1, save 2, card 3, session +5), levels, a goal-based streak, automatic
  freezes (one per 7 streak days, at most 2), badges, reduced-motion-aware celebrations, no sounds.
  Its storage (a ledger in the vault, in backups, backfilled from history) is decided in its own
  ADR; this one fixes the UX only.
- **Information architecture:** four core destinations (Highlight & save, Banks, Review, Search)
  everywhere, everything else under "More". Nothing is removed; existing deep links keep working.
- **Wizards** for every multi-decision flow (onboarding, new bank, rules, import, exam, syllabus,
  backup, restore, site access, AI, sync, reminders, delete all data): one decision per screen,
  picture cards, progress, Back/Next. Quick actions stay one click.
- **Copy:** labels of at most 3 words, at most one helper line, details behind (i).
- **Dependencies** (already exact-pinned in `dependencies`, both older than the two-week rule of
  ADR-002, checked against the npm registry on 2026-10-14):
  - `@fontsource-variable/nunito` **5.3.0** (OFL-1.1, published 2026-07-19), extension pages only,
    normal style, bundled; the in-page toolbar uses the system rounded font stack instead.
  - `lucide-react` **1.48.0** (ISC, published 2026-09-24), named imports only.
- **Styling stays ADR-002:** plain CSS with `--sv-*` custom properties, no Tailwind or CSS-in-JS, no
  `<style>` elements or `style=""` markup. Charts are in-house SVG from real data with table views.

## Consequences
- **Tests change with the screens.** Text and structure assertions in the unit and e2e suites are
  updated deliberately as each surface is restyled; `data-testid` values stay stable so specs move
  with little churn. `packages/ui/src/contrast.test.ts` grows to assert the new token pairs in
  light, dark and high contrast. A failing test is never edited to hide a defect (AGENTS.md).
- **Token migration:** every legacy `--sv-*` name stays as an alias mapped to its Sunny value, so
  the token file can be swapped without breaking a page (`--sv-danger` and friends stay text-safe;
  fills get new `-fill` names). Old surfaces still change where a value changes: `--sv-surface`
  (grey to white), radii (8/12 to 10/16 px), text sizes (13/15/17 to 14/16/20 px) and
  `--sv-motion` (120 to 140 ms). Aliases go only when nothing references them.
- **Bundle size:** the five normal Nunito subsets are 137,516 B of woff2 in the package (the browser
  fetches only the subsets a page needs). Icons are tree-shaken. The content script keeps its
  230 KB budget (`scripts/check-build.mjs`); it gets system fonts and a few icons, not Nunito.
  Measured sizes of the built pages are recorded when the surfaces land, not estimated here.
- **Font licence:** OFL-1.1 is on the licence allow-list (`scripts/license-report.mjs`); the
  licence text must ship inside the extension package with the font files and appear in the About
  section. Not yet done on this branch.
- **Release gate:** the redesign merges to `main` as one pull request only when the `ci.yml` jobs
  pass on Actions (lint, typecheck, unit, build with budgets, e2e with axe in light and dark on
  Linux and Windows), the OFL text ships, and the manual rows for the new surfaces (screen reader,
  forced colours, 400 % zoom, reduced motion) are listed in `docs/MANUAL_TEST_CHECKLIST.md`.
  Existing product pages keep working at every intermediate commit.
- Existing users do not see the onboarding again (it opens on install only); they get a one-time
  daily-goal card instead.

## Alternatives rejected
- **Candy Garden** (pastel candy palette) and **Night Arcade** (dark neon arcade): built and
  reviewed as mockups; not chosen by the owner. Their folders were deleted.
- **A calm or dense professional style** (the previous contract, or a refined version of it): it is
  what the owner rejected as verbose and difficult.
- **Tailwind or a component library** for speed: rejected by ADR-002 for the Shadow DOM overlay and
  CSP; the components are few enough to own.
- **A chart library**: the charts needed (ring, bars, heatmap) are small SVGs; a library would add
  size and styling outside the token system.
