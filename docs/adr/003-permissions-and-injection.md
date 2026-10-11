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

## Amendments after review (2026-10-11)
- **Same-site rule.** A page may read, paint and mutate only highlights of its own *site*: same scheme,
  same port, same host with a leading `www.` folded. A page-declared canonical URL is trusted for source
  identity only when it passes that rule **and** equals the visited URL after normalisation; otherwise
  the visited URL is the identity (a `<link rel=canonical href="/">` on every route must not merge pages).
- **Credentials never persist.** `redactUrl` removes userinfo, credential-like query parameters
  (`token`, `access_token`, `sig`, `X-Amz-*`, ...) and non-route fragments before a URL is stored or
  used as a key, so a rotating presigned/magic-link token neither leaks into backups nor forks a source.
- **Content-script RPC policy** now includes `sidepanel.open` (opens the side panel for the sender's own
  tab and hands a highlight id over through `chrome.storage.session`; foreign ids are ignored).
- **Deny list.** Hosts are normalised (case, trailing dot) once in `@shared`; the default list is a
  *starter* list and is documented as such. Capture is refused in the worker as well as in the page.
- **Private windows.** Capture from incognito tabs is refused unless the user turns on
  `allowIncognitoCapture`, because the database is shared with normal windows.
- **Shortcuts.** Manifest commands: `open-side-panel` (Alt+Shift+S), `quick-save` (Alt+Shift+H),
  `focus-toolbar` (Alt+Shift+Y), `next-highlight` (Alt+Shift+Period), `previous-highlight` (unassigned;
  Chrome allows four suggested keys). `[`/`]` are not valid manifest keys, so Alt+Shift+] / [ remain as
  additional in-page keys. In-page Alt+Shift+T was removed: it collided with Chrome's own accelerator.
