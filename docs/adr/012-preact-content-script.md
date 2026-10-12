# ADR-012: Preact for the content script

**Status:** accepted · **Date:** 2026-10-11 · Refines ADR-002 (dependency pins) · Closes PERF_REVIEW P1-06.

## Context
The content script is injected into every page the user enables and evaluated there before the reader
has done anything. PERF_REVIEW measured it at 405 KB, 53% React + react-dom and 21% Zod. The overlay it
renders is small (a toolbar, a "More options" panel, a highlight popover, toasts, one live region) and
uses only hooks, context, one class error boundary and `useSyncExternalStore`.

## Decision
- **Dependency:** `preact` **10.29.8**, exact-pinned in `dependencies` (not `devDependencies`: it ships
  in the bundle, and the SBOM and licence report scope "production" by that field). 10.29.8 is the
  newest 10.x and was published 2026-08-01. 11.0.0 (2026-09-30) and 11.0.1 (2026-10-08) are younger
  than the two-week age the pins respect, so 11 is a later bump, not part of this change.
- **Alias, content script only:** `react` and `react-dom` resolve to `preact/compat`. A string alias also
  maps the subpaths, so `react/jsx-runtime`, `react/jsx-dev-runtime` and `react-dom/client` become
  `preact/compat/...`. It is applied in `modules/content-script-preact.ts`, a WXT module that uses the
  `vite:build:extendConfig` hook: it receives the entrypoints of the build in progress, and WXT builds
  the content script on its own (an IIFE), apart from the HTML pages. The `vite()` callback in
  `wxt.config.ts` gets no entrypoint, so it could only alias every page. The pdf.js reader, dashboard,
  review, popup, side panel, options and onboarding pages keep React.
- **Types:** unchanged. The overlay is written against React's API and type-checked with `@types/react`;
  the alias is a bundling decision. No tsconfig `paths` entry was needed because nothing in the overlay
  uses a Preact-only API. Add one only if that changes.
- **Tests run on the runtime that ships.** `vitest.config.ts` has a small plugin that redirects the
  `react*` imports made from `entrypoints/highlighter.content/**` to the same alias table; every other
  suite keeps React. The overlay tests no longer use React Testing Library (its `act` is React's):
  `ui/testHarness.ts` exports Preact's `act` (an async callback also waits for the promise chain it
  started, as React's does) and routes `@testing-library/dom` and user-event dispatches through it.
- **Budget:** `scripts/check-build.mjs` content script 450 KB -> 230 KB (measured + about 7%; this ADR
  first said 220 KB, which is not what the file holds). The production gate printed "content script
  214 KB" in run 38173629818 and "content script 215 KB" in run 38186957997, against 230 KB. A build
  where the alias silently stopped applying would be about 400 KB and fail it.

## Compatibility review of the overlay
Checked in source and by the overlay tests (jsdom, Preact runtime); real-Chromium behaviour is
covered by the overlay, capture, a11y and compat e2e specs. What the overlay uses, and how it maps:
`useId` (ids look like `P0-0-...`; only used for `htmlFor` / `aria-*` pairs), `useSyncExternalStore`
(store subscription), `createContext`, the `Boundary` class (`getDerivedStateFromError`,
`componentDidCatch`, `componentDidUpdate`), `setState` during render (the popover's "follow the
highlight prop" pattern; Preact re-runs the render), `createRoot().render` / `unmount` (cleanups and
timers run on unmount), controlled `<select value>`, `onFocus` / `onBlur` (compat maps them to
`focusin` / `focusout`, so the toast's pause-on-focus still sees focus on its buttons),
`onMouseEnter` / `onMouseLeave`, keyed replacement of the announcer node. Not used, so nothing to
port: portals, `flushSync`, `startTransition`, Suspense, React 19 `use`, refs as props, form actions.
Shadow DOM isolation is untouched (`createShadowRootUi`, the `:host` stylesheet, `isolateEvents`, the
closed root in production); nothing renders outside the shadow root.

Known behavioural differences, none of which the overlay relies on: Preact attaches listeners to each
element instead of delegating at the root, and passive effects run after the next frame instead of at
the end of a discrete event.

## Measured (e2e variant build, `SV_OUT_DIR=.output-pa*`, minified, uncompressed)
| | Before | After | Change |
| --- | ---: | ---: | ---: |
| `content-scripts/highlighter.js` | 414 404 B (404.7 KB) | 214 393 B (209.4 KB) | -200 011 B (-48.3%) |
| same, gzip | 127 826 B | 68 246 B | -59 580 B |

The extension pages were checked in the same two builds: every `chunks/*.js` has the same size apart
from edits other agents made to shared source between the builds (largest +98 B); the shared
`src-*.js` chunk still holds react-dom, its scheduler and `react.transitional.element`; and the marker
of Preact's compat layer (the `onfocusin` event-name mapping) is in the content script and in no other
file of the output.

## Zod (evaluated, left alone)
After this change Zod is about 86 KB (PERF_REVIEW) of a 209 KB content script. It is on the path
through `@shared` (every schema module is evaluated through the barrel, and a `z.object(...)` call
is not tree-shakeable), `@runtime` message validation (`messaging.ts`) and settings normalisation
(`settings.ts`). A throw-away bundle of an equivalent small schema set measured 91.6 KB with `zod` and
26.4 KB with `zod/mini` (about -65 KB), but mini has no method chaining: using it means rewriting the
`@shared` schemas, which are the trust-boundary guard for storage reads, backups and messages and are
shared with every page. Hand-written validators for the content-script subset would duplicate the
schemas and drift. Neither is a safe change inside this task; the follow-up is its own ADR (migrate
`@shared` to `zod/mini` or split a content-script schema surface), with a before/after size and the
existing schema tests as the gate.

## Consequences
- Two renderers ship: React in the pages, Preact in the content script. Code in
  `entrypoints/highlighter.content/ui` must not import from `@ui` (React-only components); a new overlay
  feature that wants a React-only API (a portal, `flushSync`, Suspense) must replace it or revisit this ADR.
- Overlay tests exercise Preact only. React is no longer exercised for the overlay, by design.
- Revert: delete `modules/content-script-preact.ts`, the plugin in `vitest.config.ts`, the `preact`
  dependency and restore the harness imports; the source needs no change.
- Revisit after Preact 11 has aged, and for the Zod follow-up above.
