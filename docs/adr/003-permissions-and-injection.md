# ADR-003: Least-privilege site access and content-script injection

**Status:** accepted · **Date:** 2026-10-11

## Context
SECURITY_PRIVACY.md forbids install-time `<all_urls>`. Highlights must still reappear on revisit,
which `activeTab` alone cannot do (it expires on navigation).

## Decision
Install-time permissions: `storage`, `sidePanel`, `contextMenus`, `activeTab`, `scripting`.
`host_permissions` is **empty**; `optional_host_permissions` is `https://*/*` + `http://*/*`.

Three escalating, user-initiated modes:
1. **This tab (activeTab)** — action click / shortcut / context menu grants the tab; the service worker
   injects `content-scripts/highlighter.js` with `chrome.scripting.executeScript`. Lasts until navigation.
2. **This site (persistent)** — the popup calls `chrome.permissions.request({origins:[origin/*]})` from a
   user gesture; the worker then registers a dynamic content script (`persistAcrossSessions`).
3. **All sites (optional)** — Options page, explicit explanation first; same registration with broad
   matches. The deny list is applied as `excludeMatches` and re-checked in the content script.

The content script is built with `registration: 'runtime'`. WXT copies its `matches` into
`host_permissions` for that mode, so a `build:manifestGenerated` hook deletes `host_permissions`.
`tests/e2e/phase0-smoke.spec.ts` asserts the shipped manifest has none.

Registration is re-synced on `runtime.onInstalled`, `onStartup` and `permissions.onRemoved`, because the
service worker cannot assume in-memory state and registrations may not survive an extension update.

Restricted contexts (`chrome://`, Web Store, `file://` without opt-in, the built-in PDF viewer) fail the
injection call; the UI maps that to an explicit "not supported on this page" state, never a silent no-op.

## Consequences
First use on a site needs one click. That is the price of not requesting broad access at install.
