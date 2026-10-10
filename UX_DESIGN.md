# UX and Design Contract

## Product expression
Precise, fast, editorial study tool; not an attention-grabbing productivity dashboard. Default light theme with a high-quality dark mode, minimal chrome, dense information layout, neutral surfaces and a single confident blue accent. User-settable semantic highlight palette distinct from navigation color. Highly readable typography, restrained motion, no decorative charts.

## Interface surfaces
1. Floating selection toolbar: text selection > small action cluster (Save, Highlight, Note, Flashcard, Explain, More), anchored to selection bounds, flips for viewport edges, never traps/collapses selection, does not cover selected text.
2. Capture dialog: quick save into last-used bank; optional advanced fields with hierarchical bank picker, tags, note, priority, color, source, multiple bank assignment, confirmation; undo available.
3. Side panel: tabbed Current Page, Inbox, Banks, Review and Search. Compact, useful at widths around 320 px; show current URL/title and saved count.
4. Full-page dashboard: left bank tree, top universal search, main knowledge list, right preview with provenance + relationships; bulk actions; filters; keyboard palette.
5. PDF Reader: PDF on left with page navigation and anchors, companion on right, stable page-linked annotations; upload and explicit web-PDF open action; scanned PDF state.
6. Review mode: distraction-free card prompt; reveal; Again/Hard/Good/Easy; source jump; next due; analytics contextual, not intrusive.
7. Settings: permissions/domains, storage capacity, local backups, sync/offline state, AI providers and consent, appearance, hotkeys, data export/delete, accessibility.

## Design system
- Fonts: system UI with optional user-selected accessible font; highly legible academic display typography.
- Spacing scale: 4, 8, 12, 16, 24, 32 px; low-density/high-density toggle.
- Corner radius: 8/12 px; consistent accessible focus ring.
- Components: commands, drawers, popovers, tabs, comboboxes, multiselect bank tree, toast, menus, rich text editor, date picker, filter chips.
- Theme: light, dark, system; reduced motion; robust high-contrast support.
- Semantics: meaningful distinction for color-coded highlights must have text label/icon and keyboard-accessible accessible lists.
- Responsive: extension is primarily desktop; side panel should work at narrower widths and 125-200% browser zoom.
- Mount in Shadow DOM and apply local rem normalization where needed to prevent host website CSS collisions.

## Empty, error and optimistic states
- No highlights on page, no current bank, no due review, PDF access denied, unsupported page, AI unavailable, offline, sync conflict, reanchor ambiguous, imported data needs review, storage unavailable, corrupted backup.
- Optimistic UI is allowed only with rollback/retry and accurate status; never lose a quote because a save promise failed.
- Make disabled actions explain why unavailable.

## Accessibility contract
WCAG 2.2 AA intent; focus management in Shadow DOM, keyboard command list, no hover-only functionality, non-color cues for labels, accessible notices, escape to close and restore focus, respect reduced motion, tested screen readers where feasible.
