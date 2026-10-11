# ADR-004: Text anchoring (`sv-text-v1`) and highlight rendering

**Status:** accepted · **Date:** 2026-10-11 · Principal project risk: persistent text anchoring.

## Text stream
The anchor space is a derived string, never raw DOM `textContent` and never `Selection.toString()`.

- Root: `document.body` (fallback `documentElement`). Walk text nodes in document order.
- Skip subtrees: `script, style, noscript, template, textarea, select, option, iframe, object, canvas, svg`
  and the StudyVault host element (`[data-studyvault]`). Open shadow roots are **not** traversed in v1
  (documented limitation); iframes are never entered (`all_frames: false`).
- Hidden text is **included**. Visibility changes (accordions, responsive duplicates) must not shift
  offsets, so no computed-style checks are used.
- Whitespace: every run of `[\t\n\v\f\r  ]+` becomes one space; a space is dropped at the start of the
  stream and when the previous emitted character is already a space (this also collapses across nodes).
  No Unicode normalisation or case folding in the stream (lengths must stay predictable).
- No virtual block separators. The same stream builder runs at capture and at restore, so consistency
  is by construction.
- Each stream keeps a segment map `stream offset -> (Text node, node offset)` so offsets convert back
  into DOM `Range`s. Start boundaries prefer the segment that begins at the offset; end boundaries prefer
  the segment that ends there.

## Captured anchor (`HtmlAnchorSet`)
`textQuote{exact,prefix,suffix}` taken from the stream (context = up to 32 chars each side),
`textPosition{start,end}`, `structuralPath` (tag/nth-of-type chain, ≤8 levels, stops at an `id`; a hint
only), `contentSignature` (cyrb53 of the stream, hex), `documentTextLength`, `textAlgorithm:'sv-text-v1'`.
Leading/trailing stream whitespace is trimmed from the selection before offsets are taken.

`Highlight.exactQuote` is what the user saw (`Selection.toString()` trimmed); it is provenance and is
never used for matching. Hashing (`quoteHash`) happens in the service worker: `crypto.subtle` does not
exist in content scripts on `http:` pages.

## Resolution order (never silently pick wrong text)
1. Algorithm mismatch -> `orphaned` (needs a future migration).
2. Find all exact occurrences of `textQuote.exact` (cap 200).
3. **One occurrence** -> `resolved`. If the quote is < 24 chars and both context sides disagree and the
   position differs, treat as `ambiguous` (short quotes recur: "Figure 1").
4. **Several** -> score each: context agreement (common suffix of prefix + common prefix of suffix, as a
   fraction of the stored context) weighted 0.8, proximity to `textPosition.start` weighted 0.2. Winner
   must lead the runner-up by >= 0.15 or have perfect context; otherwise `ambiguous`.
5. **None** -> fuzzy: locate by context anchors / a window around the stored position, accept only when
   normalised similarity >= 0.85, status `changed` with that confidence. Anything lower -> `orphaned`.
6. Built `Range` text must equal the stream slice, else `orphaned` (mapping defect, never paint).

`ambiguous` and `orphaned` are **not painted**; they surface in the side panel for the user.

## Rendering
CSS Custom Highlight API (`CSS.highlights`) with one `Highlight` per colour and kind (`sv-hl-<color>-<kind>`; kind-less entries use `sv-hl-<color>`), styled by a
constructed stylesheet in `document.adoptedStyleSheets` (no DOM nodes are added to the page). Ranges are
not hit-testable, so clicks use `caretRangeFromPoint` + `Range.isPointInRange` against the resolved set.
Without `CSS.highlights` the product degrades visibly: capture still works, painting is off, and the UI
says so.

**Known exposure (accepted):** the registry is document-level and shared with the page's main world, so
page scripts can enumerate painted ranges (text, position, colour). See SECURITY_PRIVACY.md "Exposures to
page scripts". Painting through closed-shadow-root overlay rects would avoid it at a high cost in
scrolling/reflow/selection correctness; revisit if per-site "do not paint" is requested.

## Amendments after implementation and review (2026-10-11)
The engine is deliberately stricter than the order above; every tightening can only turn a result into
`ambiguous`, never into a wrong paint:
- A byte-identical document (same length and signature) with the quote at the stored offset resolves
  there (`position`, confidence 1).
- A multi-candidate winner must also lead the runner-up's context agreement by >= 0.1.
- A copy still sitting at the exact stored offset while another candidate wins on context is `ambiguous`.
- An unsupported unique/winning exact copy with a >= 0.85-similar location near the old position or
  context is `ambiguous` (edited original + verbatim copy elsewhere).
- A document boundary counts as full context when the stored window was cut by it.
- Occurrence search must not truncate by document order (review finding): candidates nearest the stored
  position are always scored, and context-extended needles are tried first.
- Fuzzy `changed` results may not bind to text another saved highlight resolves to exactly.

## Dynamic pages
Navigation API (`navigate`/`navigatesuccess`) with a URL-compare fallback in the observer handles SPA
route changes. A single debounced `MutationObserver` marks the stream dirty; only unresolved or
disconnected highlights are re-resolved, with bounded retries for lazy-loaded content.

## Non-colour cues (2026-10-11)
Each kind has a distinct underline (style, thickness) via `::highlight()` text-decoration, derived from the page's text colour so it stays >= 3:1 on light and dark pages; the fill alone is 1.3-1.5:1 on white and is not relied on. `setStyle('auto'|'normal'|'strong')`; `prefers-contrast: more` upgrades `auto` to strong; `forced-colors: active` drops fills and draws CanvasText underlines. Single source of truth: `KIND_DECORATION` in `@highlights`.

## Dynamic pages: load and retry behaviour (2026-10-11)
- A failed first `page.highlights` fetch (cold worker on session restore) retries with capped backoff
  (1, 2, 4, 8, 16 s; six attempts); a `visibilitychange` to visible or a bfcache `pageshow` revives it.
- Route changes forget the old page immediately but debounce the fetch+resolve (150 ms, 1 s max wait).
- Every resolve path (initial, retry pass, upsert) passes the other entries' anchors as `siblings`, so a
  deleted passage can never fuzzy-bind onto a neighbour's painted text.
- A page with zero highlights builds zero text streams.
- Worker calls time out at 12 s (below the runtime's 15 s handler budget) so the slow party is named.
