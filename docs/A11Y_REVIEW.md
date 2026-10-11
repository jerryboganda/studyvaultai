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
>
> **Status, 2026-10-12 (CI evidence for the finish wave and the PDF links; the findings are unchanged).**
> The axe checks of the surfaces added since this review ran and passed in Actions run 38173629818
> (<https://github.com/jerryboganda/studyvaultai/actions/runs/38173629818>, commit
> `79d8cbc38111bfcde0e621f37d4795fd3f38e736`, branch `feat/finish-all`) on Ubuntu and Windows (546 e2e
> tests per OS passed, none failed or retried; 6 `test.fixme` tests skipped, none of them an
> accessibility test), with the same `wcag2a`, `wcag2aa`, `wcag21aa` and `wcag22aa` tags against the e2e
> build in Playwright's bundled Chromium, in light and dark where the spec says so: `rules.spec.ts` (the
> manager and its dialog), `syllabus.spec.ts` (the import dialog, the editor, the coverage section and its
> empty state), `graph.spec.ts` (the links section and the graph view), `exam.spec.ts` (setup, a recall
> and a multiple-choice question, marking, results, history), `ai-extras.spec.ts` (the provider list, the
> chat view and its consent dialog), `math.spec.ts` (rendered and previewed math), `backup-folder.spec.ts`
> (each state of the folder panel and the reminder), `import-formats.spec.ts` (at rest, a dry run, a
> refusal), `related.spec.ts`, `reminders.spec.ts` (the settings section with the permission held and
> missing, the popup and side-panel notice), `polish.spec.ts` (the JSON export) and `pdf-links.spec.ts`
> (the page with its links, the Links list and the confirmation dialog). The keyboard-only steps of those
> specs (Alt+Arrow reordering, the graph walk, links by Tab and Enter, S and Enter in the reader) ran in
> the same run. The two addenda of 2026-10-12 below were written before it and are not rewritten: where
> they say "written and not yet run in CI", read run 38173629818. Passing axe is not a conformance claim.
> **Manual items remain, all of them:** no screen reader, forced-colours, 400% zoom, OS reduced-motion,
> caret-browsing or touch pass has been made (`docs/MANUAL_TEST_CHECKLIST.md` MT-17, MT-18, MT-42 to
> MT-44 as extended, MT-53, MT-55, MT-57, MT-58 and MT-62 to MT-65).

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

## Addendum, 2026-10-12: what changed since this review (finish wave)

Method: the code, the ADRs (011 to 020) and the titles of the unit and e2e tests were read; no
Playwright, axe, screen reader or real-browser run was made for this addendum. **None of the changes
below has a green Actions run** (no run of branch `feat/finish-all` has concluded `success`; the axe
runs in the status paragraph at the top predate them). "Fixed" again means "changed and unit-tested";
the matching e2e specs were written and not yet run in CI at that time; run 38173629818 has since executed them (status paragraph at the top, 2026-10-12).

### Findings above that moved

| # | Was | Now | Evidence | Status |
| --- | --- | --- | --- | --- |
| N1 | The PDF reader's save bar could be reached by keyboard only after a selection existed, and the page did not say how to make one | `S`, or `Enter` on a selection, opens the save bar with focus in it, `Escape` returns focus, and with nothing selected the page says how to select | `entrypoints/pdf-reader/Viewer.tsx`, `selectionGate.ts` (`flush`); `selectionGate.test.ts` "flush (a keyboard command asks for the selection now)"; `tests/e2e/polish.spec.ts` "S or Enter on a selection opens the save bar with focus in it, Escape gives focus back, and nothing selected says how to select" | **Partly fixed.** Making a selection with the keyboard alone still needs caret browsing (F7): MT-53 |
| N2 | Result rows had a fixed height with clipped lines, so a text-spacing override clipped them (1.4.12) | Rows grow to the tallest content, never shrink back, keep the first visible row when the height changes, and watch each row | `packages/ui/src/vault/VirtualList.tsx`; `VirtualList.test.tsx` suite "VirtualList row height under text-spacing overrides (WCAG 1.4.12)"; `polish.spec.ts` "rows grow under a text-spacing override instead of clipping their text (WCAG 1.4.12)" | **Fixed in code**, unit-tested; a real user stylesheet is MT-53 |
| N5 | Toasts closed after 5 s (10 s with an action); hovering or focusing paused them; no way to keep them | Pointer and focus pause independently; `Escape` closes the toast under the pointer or holding focus; Settings > Appearance has "Keep notifications on screen until I close them" (`sv.toasts.keep`, per viewer, removed by Delete all data); errors always stay. The in-page overlay's toasts pause on pointer and focus and close on `Escape` but have no keep setting (the content script cannot read the extension page's `localStorage`) | `packages/ui/src/Toast.tsx`; `packages/ui/src/feedback.test.tsx` suite "Toast: time limits (WCAG 2.2.1)"; `entrypoints/highlighter.content/ui/Toasts.tsx`; `polish.spec.ts` "notifications close on their own, wait under the pointer, and stay when asked to" | **Fixed on extension pages**; the overlay has no keep setting |

Counts of the original 27: fixed 20 (the 18 above, N2, N5), partly fixed 1 (N1), not changed 6 (N3,
N4, N6, N7, N8, N9: unchanged and not re-examined).

### New or changed surfaces and what they do for accessibility (design, from ADR-011 to ADR-020)

None of these was part of the original review; each has axe checks in its own spec (run in CI 38173629818: see the status paragraph at the top)
and a manual row.

| Surface | What the code does | Needs a real browser |
| --- | --- | --- |
| Auto-filing rules manager and dialog | Reorder by Move up and Move down buttons and `Alt+Up` / `Alt+Down` (focus stays on the control); "On" switch with `expectedVersion`; chip fields validated with the reason; Delete with Undo; problems written in each row; toasts for suggestions have File and Not now and pause under the pointer or focus | NVDA on the chip fields and the toasts; MT-56 |
| Syllabus editor and coverage | The shared ARIA `Tree`: arrows, `Alt+Up/Down` reorder, `Alt+Right/Left` indent, `F2`, `Delete`, Menu key; every action is also a button, and one that cannot act is `aria-disabled` with the reason (no drag-only action); coverage table is the primary view with sortable column buttons and `aria-sort`; the chart is a picture of it with a text summary; state is glyph and word, never colour alone | 320 px reflow is in the spec; screen reader and forced colours: MT-42, MT-43, MT-44 |
| Knowledge graph | The "Connections" table is always in the DOM and carries every item and link in words; the diagram is one tab stop (roving `tabindex`), each node a named `role="button"`; shapes and letters say the kind, dash patterns and weight say the link type, with a legend; keys reach every connected item without geometry (arrows follow links, so they are not spatial: revisit if users expect up and down to be spatial); zoom is a scrolling region; nothing animates; forced-colour rules use `CanvasText`, `Canvas` and `Highlight` | NVDA, JAWS, VoiceOver (MT-58); forced colours (MT-42) |
| Exam | The visible clock is `role="timer"` with `aria-live="off"`; milestones at 50 %, 10 %, one minute and the end go through ONE polite region that outlives each screen, so "time is up" is heard when the screen is replaced; no single-key shortcut (2.1.4); a picked option has a heavier border and a checked radio (not colour alone); recall answers appear only in marking | The announcements with NVDA and VoiceOver (MT-57) |
| Reminders | The notice is a live region with a Dismiss button in the popup and the side panel; the toolbar badge text is not read by assistive technology, so the tooltip carries the same sentence; the badge colours were computed at 4.5:1 against the white text | The tooltip and badge as the operating system draws them (MT-55) |
| Provider list, consent dialog with several addresses, chat view | `AsyncSwitch` is `aria-busy` while a write is pending; the dialog lists every address and each passage and earlier turn with a checkbox above the exact text; "Send" is disabled with its reason when nothing is ticked; axe in light and dark in `ai-extras.spec.ts` | The dialog with a screen reader (MT-44 extended; MT-60) |
| Backup folder, import panel, math in notes | The panels use the existing native `<dialog>` and notice primitives; math is a `<code>` element read as TeX source (no `role="math"`: the element is not math markup, ADR-015) | Screen reader on the folder panel and a formula (MT-44 extended) |

### Not changed

- The toolbar badge and the tooltip, the graph, the exam timer and every other finish-wave surface
  are unverified with assistive technology; the rows are MT-42 to MT-44 (extended to the new
  surfaces), MT-53, MT-55, MT-57 and MT-58.
- The `Alt+Up` / `Alt+Down` and `F2` shortcuts of the new trees and lists are modified keys, so
  2.1.4 does not apply; the exam has none by design.

## Addendum, 2026-10-12: links in the PDF reader (ADR-006 amendment 3)

Method: the code, the ADR and the titles of the unit and e2e tests were read; no Playwright, axe, screen
reader or real-browser run was made for this addendum. **None of it has a green Actions run**: the unit
files (`packages/pdf/src/links.test.ts`, `linkLayer.test.ts`, `entrypoints/pdf-reader/links.test.tsx`)
were written with the code, and `tests/e2e/pdf-links.spec.ts` (14 tests, one of them axe over the page,
the Links list and the dialog) was written and not yet run in CI when this addendum was made; it passed in run 38173629818 (status paragraph at the top). Before this change a link inside a PDF
did nothing, for the keyboard and for assistive technology as well.

| Surface | What the code does | Needs a real browser |
| --- | --- | --- |
| Link anchors on a page | One transparent `<a role="link">` per link, placed over the link's own rectangle in percent of the page (so zoom and rotation need no recomputation), with an accessible name: "Link to page N", "External link to {host}" or "Link that StudyVault will not open". There is no `href`. The focus ring is a `:focus-visible` outline plus a tint (the e2e asserts an outline of at least 2 px) and `Highlight` in forced colours | A screen reader's rendering of a `role="link"` with no `href` (MT-62); the ring under Windows contrast themes (MT-65) |
| **Tab order rule** | A page with **at most 40** links puts every link in the tab order, in reading order. A page with **more than 40** has **one tab stop** (the first link) and the arrow keys, Home and End move between the rest (roving `tabindex`); the layer is a `role="group"` whose label says so, and the **Links** list is the way through the page. Enter follows the focused link. Anchors exist only for drawn pages, so the lazy window bounds them: at most about 160 tab stops (40 on each of four drawn pages), never the 3,779 links of the CDC guideline | The roving group with NVDA, JAWS and VoiceOver (MT-62) |
| Links list | The navigation pane's "Links (N)" tab lists "Links on this page" for the page in view: each link by its accessible name, the address as text, "will not be opened" for a refused one, and "Page N has no links." when empty. It follows a link through the same code as a click | The same pass |
| After a link is followed | The page element takes keyboard focus (`tabindex="-1"`, not a tab stop; the viewer's own keys keep working there); the polite status region says "Went to page N."; **Back** is a toolbar button (`aria-disabled` with the title "No link has been followed yet." until one is) and **Alt+Left**, which is always handled in the reader and says "Nothing to go back to: no link has been followed yet." with an empty stack, so the browser's own Alt+Left never leaves the page and the open document | Back and Alt+Left with a screen reader's virtual cursor (MT-62) |
| Confirmation dialog | `ConfirmDialog`: focus trapped, Cancel focused, Escape cancels; the whole address and the site are text in a list; "Always allow this site ({host}) in this reader session" is an unchecked checkbox; the status line says "Opening {host} in a new tab." | Whether Chrome's pop-up blocker lets the tab open: the reader cannot tell and says it is opening either way (MT-63) |
| A link that is refused | An `InlineNotice` (`role="status"`, "Link not opened") with the reason and a Dismiss button; nothing opens | The announcement once, not doubled |
| Pointer | The anchors take no pointer events, so a drag that starts on a link selects text and a click never follows a link during or after a selection; the cursor is a pointer over a link | Touch (not exercised) |

Also fixed on the way: the toolbar's page box committed on blur even when nothing had been typed, so the
view could jump back to the top of the page between a press and a release (`Toolbar.tsx`; unit-tested in
`links.test.tsx`).

Not changed, and why: the reading order is geometric, not column-aware, so on a two-column page the tab
order can interleave the columns; a link wrapped over lines has one tab stop and one focus ring around
the union of its lines; a link whose action pdf.js does not turn into a destination has no anchor, so
nothing tells the person it exists; no target-size (WCAG 2.5.8) assessment was made, the boxes being the
links' own rectangles. Manual rows: MT-62, MT-63 and MT-65.
