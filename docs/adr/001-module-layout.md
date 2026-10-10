# ADR-001: Single pnpm project with aliased `packages/*` modules

**Status:** accepted · **Date:** 2026-10-11

## Context
ARCHITECTURE.md names `packages/{core,storage,highlights,study,ai,sync,shared}`. A real pnpm
workspace adds per-package build/test/tsconfig overhead that WXT does not need: WXT bundles from
source and only the extension is a deliverable.

## Decision
One pnpm project. Logical packages are directories under `packages/*/src`, imported through aliases
(`@shared`, `@runtime`, `@storage`, `@highlights`, `@ui`) declared once in `wxt.config.ts` (WXT writes
them into `.wxt/tsconfig.json`; Vitest picks them up through `WxtVitest()`).

Layering is enforced by ESLint `no-restricted-imports`, not by package boundaries:

| Module | May import | Must not import |
| --- | --- | --- |
| `@shared`, `@highlights` | zod, DOM APIs | `wxt`, `react`, `dexie`, `@storage` |
| `@runtime` | `wxt/browser`, `@shared` | `dexie`, `@storage` |
| `@storage` | `dexie`, `@shared`, `@runtime` | `react` |
| content script | `@shared`, `@runtime`, `@highlights` | `dexie`, `@storage` (use the message protocol) |

`packages/core` from ARCHITECTURE.md is represented by `@shared` until domain services outgrow it.

## Consequences
Promoting a module to a real workspace package later is mechanical (add `package.json`, keep alias).
