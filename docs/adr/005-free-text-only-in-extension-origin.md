# ADR-005: Free-text entry happens only in extension-origin surfaces

**Status:** accepted · **Date:** 2026-10-11 · Source: adversarial security review of the Phase 1 slice.

## Context
The first overlay had a note textarea, a new-bank name input and a comment editor inside the page
document (Shadow DOM, closed root in production, `isolateEvents`). Review showed that this does not
protect what the user types: a page script registers capture-phase `keydown` / `beforeinput` / `input`
listeners on `window` and receives every keystroke before the shadow root is reached. `isolateEvents`
only stops *bubbling* of a few key events; `input`/`beforeinput` carry `event.data` and are not
isolated at all. A closed shadow root only hides the event *target*.

## Decision
The in-page overlay contains **no free-text inputs**. It offers one-click actions and non-text
controls only (Save, Save-as-kind, bank `<select>`, kind, priority, Delete/Undo).

Anything that needs typing opens the side panel, which is an extension document and cannot be observed
by the page:

- **Note**: quick-saves the selection, then asks the service worker to `sidePanel.open` for the tab
  (`sidepanel.open` RPC, called synchronously from the click so the user-gesture requirement holds) and
  hands the highlight id over through `chrome.storage.session` (`PENDING_FOCUS_KEY`). The panel scrolls to
  the card and focuses its note field.
- **Edit note** on an existing highlight, and **New bank**: same hand-off, or typed directly in the panel.

## Consequences
- One extra context switch for notes. Accepted: private thoughts must not be readable by third-party
  scripts on arbitrary sites.
- The overlay gets simpler (no textarea reflow, IME or focus-trap problems at 200-400% zoom).
- Selection *text* is still visible to the page (it is the page's own text). The saved quote is not.
- The one-click quote/kind/colour choice made on the overlay is observable through the highlight
  registry; see SECURITY_PRIVACY.md "Exposures to page scripts".
