# Accessibility review: surfaces built since the last audit (2026-10-11)

> **Status, 2026-10-11 (CI evidence added; the findings below are unchanged).** The automated axe
> suites named under "What automated axe already covers" ran and passed in Actions run 38139836238
> (<https://github.com/jerryboganda/studyvaultai/actions/runs/38139836238>, commit `d641515b1154aa46597e7ebb069d2341014c125c`) on Ubuntu and Windows (443 e2e tests per OS
> passed, none failed or retried; 6 `test.fixme` tests skipped, none of them an accessibility test):
> `a11y.spec.ts` (47 tests), `dashboard.spec.ts` "axe WCAG 2.2 AA" in light and dark, `review.spec.ts`
> "accessibility" (axe, keyboard-only, reduced motion), `pdf.spec.ts` "accessibility" (3), `surfaces.spec.ts` (the Settings page in
> light and dark, the popup, the welcome tour in light and dark, reflow at 320 px and 200% zoom),
> `ai.spec.ts` "accessibility", `backup.spec.ts` (the section, every restore step and the delete
> confirmation) and the checks inside `sync.spec.ts`, all with the `wcag2a`, `wcag2aa`, `wcag21aa`
> and `wcag22aa` tags against the e2e build in Playwright's bundled Chromium. This review said the `e2e`
> job was the only place the new markup meets axe; that job has now run. Passing axe is not a
> conformance claim and cannot judge what the section above lists. Nothing under "Needs a real browser or assistive technology" was done: no screen
> reader, forced-colours, 400% zoom, OS reduced-motion, caret-browsing or touch pass has been made;
> those remain `docs/MANUAL_TEST_CHECKLIST.md` MT-17, MT-18 and MT-42 to MT-44, MT-53. The sections
> "Verification actually run" and "Where the e2e suites may need a look (not run)" below describe the
> original code-and-jsdom pass and are not rewritten; the specs they name did run in that CI run.

Target: WCAG 2.2 AA (UX_DESIGN.md, "Accessibility contract"). Method: reading the code and CSS of
the surfaces below, computing contrast from the real token files, and unit tests (jsdom) for every
behaviour that can be tested there. **No Playwright, axe, screen reader or real-browser run was
made for this review**; "fixed" means "changed and unit-tested", and the rows in "Needs a real
browser" below still need one. CI (`e2e` job) is the only place the new markup meets axe.

Surfaces read: `entrypoints/dashboard` (tree, list, preview, palette, trash, bulk bar, dialogs),
`entrypoints/review` (deck picker, session, author, card browser, analytics and charts),
`entrypoints/pdf-reader`, `entrypoints/onboarding`, `entrypoints/options`, `entrypoints/popup`,
`entrypoints/sidepanel`, and the `packages/ui` primitives (`ConfirmDialog`, `Toast`, `Tabs`, `Notice`,
`Kbd`, `Button`, `vault/Menu`, `vault/Tree`, `vault/VirtualList`, `vault/CommandPalette`,
`vault/Modal`). Not reviewed in depth: `packages/ui/src/ai`, `backup`, `sync` (other agents were
editing them); they use the same native `<dialog>` primitives and should get the same pass.

## What automated axe already covers (and what it does not)

`tests/e2e/a11y.spec.ts` (overlay, options, popup, side panel), `dashboard.spec.ts` ("axe WCAG 2.2
AA", light and dark), `review.spec.ts` ("accessibility"), `pdf.spec.ts` and `surfaces.spec.ts` run
axe with the `wcag2a/aa/21aa/22aa` tags on loaded pages. axe cannot judge: focus order and focus loss
after a control disappears, live-region wording and chattiness, keyboard shortcuts that fire while a
button has focus, contrast of a state (focus ring on an inverse surface), forced-colors, target size
of a mouse-only twist, reflow of overlays, or text alternatives of a chart beyond "has a name".

## Summary

| Severity | Found | Fixed in code/CSS | Left (reason) |
| --- | --- | --- | --- |
| High | 6 | 6 | 0 |
| Medium | 11 | 10 | 1 (N1, needs product work) |
| Low | 7 | 2 | 5 (N2-N6, accepted or design-bound) |
| Info | 3 | 0 | 3 (N7-N9, manual check or not applicable) |

Total 27 findings (FIXED: 18; NOT CHANGED: 9). Two of the High rows (#1, #2) are the same listener.

"High" = a keyboard or screen-reader user is blocked, or a Level A criterion fails. "Medium" = AA
criterion not met or a recurring annoyance with a workaround. "Low" = best practice or partial.

## Findings and fixes

File:line are the current lines (after the fix) unless the row says "not changed".

| # | Sev | Where | SC | Finding | Fix |
| --- | --- | --- | --- | --- | --- |
| 1 | High | `entrypoints/review/Session.tsx:127-136` | 2.1.4 (A) | One document-level `keydown` listener acts on `Space`, `Enter`, `1`-`4`, `Z`, `E`, `S`, `B`, `J`, `X` whenever no text field has focus. No way to turn off or remap. | Per-viewer switch `sv.review.keys` (localStorage, try/catch), button "Turn single-key shortcuts off/on" under the session (`TID.keysToggle`); the listener returns early when off. Tests: `Review.test.tsx` "keyboard rules". |
| 2 | High | `Session.tsx:130-137` | 2.1.1, 3.2.2 | In the question phase `Space`/`Enter` revealed the card even when a toolbar button (Edit, Suspend, Undo, Leave) had focus, and `preventDefault` cancelled that button. A keyboard user pressing Enter on "Edit" got the answer instead. | The listener ignores `Space`/`Enter` whose target is inside `button, a[href], summary, [role=button]`. Test: "Enter on a focused button presses that button instead of revealing the card". |
| 3 | High | `packages/ui/src/focus.ts` (new), applied in `Dashboard.tsx:221`, `Review.tsx`, `Reader.tsx`, `SidePanel.tsx`, `Options.tsx` | 2.4.3 | Focus fell to `<body>` whenever the focused control was removed by its own action: bulk bar after "Clear selection"/"Move to trash" (bar unmounts), "Empty the trash", removing a tag/field/filing in the preview, deleting a saved search, card browser Edit/Delete/Reschedule, cloze blank and MCQ option after answering, PDF "Cancel" OCR, side-panel tag chip. | `useFocusRescue()` returns a ref callback: remembers the focused control and the named regions around it (`section`, `article`, `main`, `aside`, `nav`, `[role=tabpanel]`, `dialog`, `[data-focus-home]`), and when that control leaves the page while focus is on `<body>` focuses the innermost region still there (tabindex `-1` added). It leaves focus alone if it moved on purpose. Dashboard passes a `pick` so the bulk bar and dialogs return to the list. Tests: `focus.test.tsx` (5), `dashboard/a11y.test.tsx`. |
| 4 | High | `entrypoints/dashboard/PreviewNotes.tsx:32-51,181-190` | 2.4.3 | "Add a note"/"Edit" were replaced by the editor with no focus move (`data-autofocus` has no consumer outside dialogs); Cancel/Save dropped focus again. | The textarea takes focus when the person opened the editor (not for a restored draft), and focus returns to the opener when it closes. Tests: `Preview.test.tsx` "focus follows the note editor" (3). |
| 5 | High | `packages/ui/src/components.css:443-449` | 1.4.11, 2.4.7 | Focus ring of the toast's Undo/Dismiss: blue on the inverse surface = 2.68:1 (light), 1.80:1 (dark). | Ring takes the page colour on the neutral toast (17.96:1 / 16.15:1); the tinted error toast keeps blue (>= 5:1). Guard: `contrast.test.ts` "token pairs". |
| 6 | High | `Dashboard.tsx:700-706,734-745,752-760,664-671`, `dashboard.css:154-163` | 2.4.11, 2.1.1, 1.3.4 | Narrow layouts (< 900 px, or 400% zoom of a 1280 px window): the Banks panel is `position: fixed; inset-block: 0`, i.e. over the header, so it covers its own toggle; no Escape; choosing Trash/Duplicates/Storage left it over the new view; opening it from the toggle left focus on the covered button. A palette "New bank..." opened a dialog inside the hidden panel (inherited `visibility: hidden`) that was invisible, modal and held focus. The preview panel opened by arrow keys could only be closed from inside it. | The toggle moves focus into the tree; Escape (narrow only) closes the panel and returns to the toggle; view buttons close it; `.dash-left dialog`/`.dash-right dialog` set `visibility: visible`; Escape in the list closes the preview when it is a panel (< 1200 px). Tests: `a11y.test.tsx` "narrow layouts" (4). The CSS rule needs the real-browser check below. |
| 7 | Medium | `Dashboard.tsx:276,628-640,508-516`, `SearchBar.tsx` not changed | 2.1.4 (A) | `/` (focus search) and `?` (shortcut list) are unmodified single characters. | Select "The / and ? keys" in View options and a palette command, persisted in `sv.dashboard.singleKeys`; the legend says so. `Ctrl+K` and `F6` are not affected. Test: "lets the / and ? keys be turned off". |
| 8 | Medium | `Dashboard.tsx:224-231`, `LibraryView.tsx:55-66` | 4.1.3 | Switching All highlights / Duplicates / Trash / Storage changed the page under a button that keeps focus with no announcement; choosing a bank or filter changed the list with no count (only search had a status). | `useToast().announce` (the surface's one polite region): the view name on change, and "N highlights" when scope or filters change (not on first load, not while searching). Tests in `a11y.test.tsx`. |
| 9 | Medium | `packages/ui/src/vault/CommandPalette.tsx:75-79` | 4.1.3 | Typing in the palette filtered the list silently; "no match" was an option that never became the active descendant. | The existing polite status now says "N commands. Arrow keys ..." as the query changes. Test: "keeps one polite status ...". |
| 10 | Medium | `entrypoints/options/DeleteData.tsx:118-124` | 4.1.3 | The wipe's "waiting for another StudyVault window" and "not finished" notices appeared long after the click, as plain notices, and were the only sign that another window was holding the deletion. | Both are spoken through the page's polite region. Existing tests extended (`Options.test.tsx`). |
| 11 | Medium | `Toolbar.tsx:236-252`, `DocumentView.tsx:814-830` | 4.1.3 (chatty) | PDF search status was a live region that changed on every page ("Searching... page 41 of 300, 2 found"); the OCR status changed at each of 3-4 phases per page. | The eye keeps the detailed text (`aria-hidden`); the live text is one steady phrase ("Searching...", "Recognising text: 3 of 40 pages done."), final count at the end. `textContent` unchanged for existing tests. |
| 12 | Medium | `packages/ui/src/vault/vault.css:83-91` | 2.5.8 | The tree's expand/collapse twist is a pointer target of 16 px. | 24 x 24 px (negative inline margin keeps the indent). |
| 13 | Medium | `dashboard.css:663-679`, `reader.css:612-618`, `review.css:605-632` | 1.4.1, 1.4.11 | Forced-colors: the current view button, the focused duplicate group and the selected PDF card were marked by a background/box-shadow/border colour only, which that mode removes; the stacked chart series became the same colour. | `Highlight`/`HighlightText`, a 3 px `Highlight` outline, hollow second series with a heavy edge, and swatches to match. `aria-current="true"` added on the selected card (`Companion.tsx:176`). Visual check needed. |
| 14 | Medium | `components.css:385-390`, `dashboard.css:147-153`, `reader.css:411-418` | 2.4.11 | Toasts are fixed to the bottom edge on every extension page, but only the side panel reserved `scroll-padding-bottom`. | `scroll-padding-bottom: 6rem` on `html` and on the panes that scroll by themselves. Partial: the virtual list positions its active row itself (see "Not changed"). |
| 15 | Medium | `Dashboard.tsx:88`, `Reader.tsx:63`, `Options.tsx:38` | 2.4.3 | Toasts there had no `returnFocus`: activating Undo from the keyboard left focus on `<body>` (side panel and review already had it). | Each passes its main pane. |
| 16 | Medium | `entrypoints/pdf-reader/SaveBar.tsx:104`, `OcrPanel.tsx:116-121,259-262` | 2.4.3 | Creating a bank removed the focused name field and Create button; saving or cancelling an OCR line correction removed the field that had focus. | Focus goes to the bank select / the line's "Edit line N" button. |
| 17 | Low | `BulkBar.tsx:88-111` | 4.1.2 | `aria-haspopup="menu"` buttons without `aria-expanded`. | Added. |
| 18 | Low | `review.css:553-558` | 1.4.11 | Adjacent stacked series (accent and brown, 1.37:1 apart) separated by colour only. | 1 px page-colour stroke between segments; the data table remains the text alternative. |

## Not changed (and why)

| # | Sev | Where | SC | Note |
| --- | --- | --- | --- | --- |
| N1 | Medium | `entrypoints/pdf-reader/Viewer.tsx:466-487` | 2.1.1 | A highlight is created from a text selection; the viewer's shortcut `H` only moves focus to the save bar once a selection exists. With the keyboard alone a selection needs Chrome's caret browsing (F7) or a mouse click first. A keyboard route that does not depend on the browser (select a search match or a "Page text" line and save it) is a feature, not a fix. Companion list, "Go to highlight", edit, delete and OCR correction are all keyboard-operable. |
| N2 | Low | `LibraryView.tsx:18`, `dashboard.css:394-420`, `VirtualList.tsx` | 1.4.12 | Result rows have a fixed height with clipped lines (`line-clamp`, `overflow: hidden`, `white-space: nowrap`), so a user stylesheet that raises line/paragraph/letter spacing clips row text. The preview pane shows the whole quote. Browser zoom is not affected. Recorded; do not use fixed-height rows for anything the preview does not repeat. |
| N3 | Low | `SearchBar.tsx:127`, `sidepanel/Search.tsx:365` | 4.1.3 | The live status reads "N matches in 4 ms". One update per query; the timing is noise for a screen reader. Not changed to keep the existing `textContent` assertions. |
| N4 | Low | `BulkBar.tsx:69`, `TrashView.tsx:161` | 4.1.2 | `role="toolbar"` without roving arrow keys: every button is its own Tab stop. Harmless, but the role promises arrows. Tests query the role; change both together. |
| N5 | Low | `packages/ui/src/Toast.tsx:138` | 2.2.1 | Toasts close after 5 s (10 s with an action); hovering or focusing pauses them. Undo of a trash action is also reachable in Trash. A setting for persistent toasts would settle it. |
| N6 | Low | `Session.tsx:475` | 4.1.2 | `aria-label` on a `<p>` is not exposed (paragraphs cannot be named). The visible text is read anyway. |
| N7 | Info | `review/Charts.tsx:34`, `review.css:564` | 1.4.4 | The SVG is a 640-unit viewBox scaled to the column: at 320 px the 11-unit tick labels are about 5 px. The data table behind "Show the data as a table" and the `<desc>` summary are the alternative. |
| N8 | Info | `dashboard.css:42-48,111-122` | 1.4.10 | "View options" is a popover positioned absolutely inside the header, which is `overflow: auto` with `max-height: 46vh`. Probably scrolls inside the header at 320 px; could not be checked without a rendering. |
| N9 | Info | all | 3.1.2, 3.2.6 | User quotes are marked `dir="auto"` but not `lang` (the language is unknown). There is no help mechanism to keep consistent. |

## Contrast (computed from `tokens.css` / `components.css`, now guarded by tests)

All text pairs used on extension pages are >= 4.5:1 in light and dark (lowest: `--sv-accent` on
`--sv-info-bg` 4.51 light; `--sv-success` on `--sv-success-bg` 4.57 light). Focus ring, control
border (`--sv-border-strong`) and accent bar are >= 3:1 on `--sv-bg`, `--sv-surface`, `--sv-info-bg`
(lowest 4.22). `--sv-border` (1.36 light, 1.65 dark) is decorative: it only outlines buttons that
carry a text label and containers whose rows have their own text, which 1.4.11 does not require to
reach 3:1.

## Needs a real browser or assistive technology (manual only)

- NVDA + Chrome, JAWS + Chrome, VoiceOver + Chrome/Safari passes of: dashboard (list, tree, preview,
  palette, bulk bar, trash), review session, PDF reader (text layer, search count, OCR progress,
  save bar), onboarding, options (wipe states). Confirm the new announcements are heard once and
  are not doubled with the toast text.
- Windows High Contrast / `forced-colors: active` visual pass: selected row, tree item, current view,
  duplicate group, selected PDF card, chart series and swatches, OCR confidence bands.
- 400% zoom (320 CSS px) of dashboard, review, PDF reader, options: Banks and Preview panels,
  "View options" popover (N8), `visibility` of dialogs opened from the tree (#6), toolbar wrap in
  the PDF reader, row clipping (N2).
- `prefers-reduced-motion` with a real session (CSS is token driven: `--sv-motion` is 0 and
  `scroll-behavior: auto`; nothing in the code uses smooth scrolling or keyframes).
- Touch target and pointer checks on a real device; Chrome caret browsing (F7) in the PDF reader (N1).
- Focus visible and not obscured with a real stack of four toasts over the virtual list (#14).
- The focus-rescue hook relies on Chrome reporting the removal of a focused node as `focusout`
  followed by a `MutationObserver` record; both are exercised in jsdom, not in Chrome.

## Verification actually run

Local, scoped (AGENTS.md rule 1); the full suite, lint, typecheck and e2e run on Actions only.

- `pnpm exec vitest run entrypoints/dashboard packages/ui/src/vault packages/ui/src/focus.test.tsx`:
  24 files, 312 tests passed.
- `pnpm exec vitest run entrypoints/pdf-reader entrypoints/review entrypoints/sidepanel
  entrypoints/options entrypoints/popup entrypoints/onboarding`: 23 files, 412 tests passed.
- `pnpm exec vitest run packages/ui/src/contrast.test.ts`: 8 tests passed.
- A final re-run of 11 touched files together (21 files, 343 tests, other agents loading the CPU):
  341 passed, 2 failed, both passed when re-run alone. `Preview.test.tsx` "keeps an unsaved note ..."
  was a real (pre-existing) race: a pending mount effect wrote the draft back after Cancel deleted
  it; `NoteEditor` now ignores the effect once Cancel was pressed (`PreviewNotes.tsx`).
  `Options.test.tsx` "applies the theme immediately" asserts `dataset.theme` right after the stored
  value changed, without waiting for the effect; it flakes under load and was not touched.
- `pnpm exec eslint` on every changed `.ts`/`.tsx`: no output. `pnpm exec prettier --write` on every
  changed file. Scoped `tsc` over the changed files (private tsconfig, deleted): no errors.
- Not run: Playwright, axe, any browser. Cite an Actions run URL before calling these surfaces
  "verified".

## Changed files

`packages/ui/src/focus.ts` (new), `focus.test.tsx` (new), `index.ts`, `components.css`,
`contrast.test.ts`, `vault/CommandPalette.tsx`, `vault/Menu.test.tsx`, `vault/vault.css`,
`review/review.css`, `review/testids.ts`; `entrypoints/dashboard/` `Dashboard.tsx`, `LibraryView.tsx`,
`BulkBar.tsx`, `PreviewNotes.tsx`, `dashboard.css`, `Preview.test.tsx`, `a11y.test.tsx` (new);
`entrypoints/pdf-reader/` `Reader.tsx`, `DocumentView.tsx`, `Toolbar.tsx`, `SaveBar.tsx`,
`OcrPanel.tsx`, `Companion.tsx`, `reader.css`; `entrypoints/review/` `Review.tsx`, `Session.tsx`,
`Review.test.tsx`; `entrypoints/sidepanel/SidePanel.tsx`; `entrypoints/options/` `Options.tsx`,
`DeleteData.tsx`, `options.css`, `Options.test.tsx`.

## Where the e2e suites may need a look (not run)

- `pdf.spec.ts`: `pdf-ocr-status` is now a `<p>` holding an `aria-hidden` span and a `role=status`
  span (still visible, still gone when the run ends); `pdf-find-count` text is unchanged.
- `dashboard.spec.ts`: the View options panel has a fourth select; the palette has one more
  "Appearance" command (`single-keys-toggle`); `toggle-tree` now moves focus into the tree.
- `review.spec.ts`: the session shows a "Turn single-key shortcuts off" button after the key hint.
- `a11y.spec.ts` (options): `main.opt__main` has `tabindex="-1"`.
