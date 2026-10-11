# ADR-018: Links between items and the knowledge graph

**Status:** accepted · **Date:** 2026-10-11 · Builds on ADR-011 (the `relations` table and its API),
ADR-005 (free text stays in the extension origin), ADR-010 (module seams) and ADR-012 (what the content
script carries). Related: the lexical "Related" section (PRD, `packages/search/src/related.ts`).

## Context
ADR-011 stored links (`related`, `supports`, `contradicts`, `cause`, `example`, `prerequisite`) between
highlights, notes and knowledge points but gave the person no way to make, read or see them. This ADR is
the user-facing half: a Links section on every highlight, a graph view, and the rules that keep both
honest. No schema or backup change: every write goes through the ADR-011 API.

## Decisions

### 1. Where links appear
- **Dashboard preview:** a "Links" section after Notes/Duplicates, before "Related". **Side-panel card:**
  the same component under "Show on page / Make flashcard / Open in dashboard". Both are collapsed
  behind a toggle. The preview reads the links when it opens (to print the count on the toggle,
  "Show links (3)", for one highlight); a card reads nothing until it is opened (a list of 50 cards must not
  cost 50 reads).
- One component (`packages/ui/src/vault/Links.tsx`, `LinksSection`) serves both. It takes a `LinksPort`
  (`storageLinks` is the real one) and a `LinkSearchPort`, so the surface owns the search index and the
  tests can inject either.
- Each link shows: the direction-aware phrase ("Supports", "Supported by", "Is an example of", "Has the
  prerequisite", "Related to"), the kind of the other end, its text (quote, note, or one-liner), its
  source title and host, and the link's own note. Actions: Open (the highlight the end belongs to; a
  note that belongs to nothing says why it cannot open), change type, add/edit note, remove.
- **Remove** and **change type** are undoable from the toast (`focusAction`: the removed row took the
  focused button with it, so Undo gets the keyboard focus).

### 2. Making links
- "Add link" opens an inline picker (not a dialog: the side panel is narrow and a modal inside a scrolling
  card is worse). It searches the **existing** search host (`SearchHost.search`, the same index the Search tab
  and Related use; the side panel asks for it through `request()`, so nothing is built before it is
  needed) for highlights and notes, and `findKnowledgePoints()` for knowledge points (they are not
  indexed). Type, direction (for the five directed types) and an optional note (500 characters).
- **Self links** are listed but cannot be chosen, with the reason in the text; **repeats** are caught
  before the write ("Already linked as Supports. Choose another type or another item.", from the
  links already read) and again by the store (`createRelation` returns `existing`, shown as the same
  message), so two windows racing still end in one link.
- **Changing the type** is `create the new link, then delete the old one`, not an update: the five
  identity fields of a relation never change (ADR-011), so a different type is a different link, and
  sync treats them as such. If the new type already exists between the two items the old link is kept
  and the message says so. Undo deletes the new link and restores the old one. The two steps are two
  transactions; a crash between them leaves both links, never none.
- A **Related suggestion** gets a "Link as Related" button (`RelatedSection`'s optional `onLink`): one
  click, no picker, with Undo.
- An **AI-reported contradiction** gets "Link as Contradicts" (`packages/ui/src/ai/LinkContradiction.tsx`)
  when the model's two quotes were matched to the passages they cite and both passages still exist. The
  link's note reads "Reported by an AI contradiction check; not verified." and **the model's explanation
  is not copied into the vault**: it stays in the AI result, and the link is the person's own act.
  Nothing is created without the click; the AI result itself is unchanged.

### 3. What "hidden" means, and one fix to ADR-011
ADR-011: "an end in the trash hides the relation". It checked the end's own `deletedAt`. A note or a
knowledge point of a highlight in the trash is not stamped when the highlight goes to the trash, yet
nothing of it can be opened, so its links stayed visible and led nowhere. `liveEnds()` in
`relations.ts` now also requires the highlight a note or knowledge point belongs to to be live (one more
`bulkGet`, only for those two kinds). It is derived, like the rest: restoring the highlight shows the
links again, and nothing is written. `describeEnds()` applies the same rule when it describes an end.
Purge cascades are unchanged (ADR-011 §3) and are verified end to end in the e2e spec.

### 4. Reading: `packages/storage/src/graph.ts`
Read-only helpers, exported from the barrel: `describeEnds(refs)` (quote/note/one-liner as one line,
source title, host, and the highlight that shows the item), `listLinks(ref)` (visible links of one
item with the other end described; an unreachable end is not listed), `loadGraph()` (every visible link,
at most 20,000, and whether it was cut short), `findKnowledgePoints(query)`. Live updates need no new
mechanism: the section reads through `useObserved` (Dexie live query plus the data epoch), so a trash,
restore, purge or link made in another window updates it without a reload.

### 5. The graph: pure code, lazily loaded
- `packages/shared/src/graph.ts`, imported by subpath `@shared/graph` (it is **not** in the shared
  barrel, so the worker and the content script never carry it): `neighbourhood`, `radialLayout`,
  `clusters`, `mostConnected`, `step`.
- **Neighbourhood:** breadth-first over links in both directions, depth 1 or 2, **cap 60 items**
  (`GRAPH_NODE_CAP`). When the cap bites the more connected items are kept; `hidden` is exact (what the
  uncapped traversal would have reached); "Show N more" raises the cap by 60. Neighbours are ordered
  by (connections desc, key), so nothing depends on the order links were read in.
- **Layout:** radial tree, deterministic, no physics and no random start. Each item hangs under the
  earliest nearer item it is linked to and takes an arc of its parent's sector in proportion to its
  subtree; each ring is widened until its closest pair is `spacing` apart (computed from the angles, so
  a ring of single items between two big arms still holds). Coordinates are rounded to a tenth. Same links,
  same picture; tested for permuted input and for spacing.
- **Whole vault:** no picture. "Most connected items" (top 10) and "Groups of linked items" (connected
  components by size, largest first, three members each) with "Show graph around this".
- The view (`entrypoints/dashboard/GraphView.tsx` + `graph.css`) is `React.lazy`'d: the dashboard's
  start-up does not carry it.

### 6. Accessibility of the picture
- **The table is the equivalent, not an afterthought.** "Connections" lists every shown item once, with
  its distance from the centre, every link it has in words ("Supported by …", "Contradicts …") and its
  Open / Centre-here buttons. It is in the DOM at all times, after the diagram, with its own heading.
- **Diagram:** `role="group"` with the key help as its description; the SVG itself is presentational
  and each node is a `<g role="button" tabindex>` with a full name ("Highlight: …. 3 links. 1 link from
  the centre."). One tab stop (roving `tabindex`). Shapes (circle / square / diamond) and a letter say
  the kind; colour is never the only cue.
- **Keys** (on a node): Right = go to a linked item, Left = back, Up/Down = cycle the siblings, Enter /
  Space = open, C = draw the graph around it, Escape = return to the list, + / - / 0 = zoom / fit.
  `step()` makes every item of a connected graph reachable without any geometry. A dead end is
  announced ("No further link in that direction.").
- **Link types differ by dash pattern, weight and text** (legend lists each with its words: "Supports
  thick solid line, arrow", "Contradicts dashed line, arrow", ...); only the focused item's links are
  labelled on the picture (labels on every link overlap each other and the items; the legend and the
  table name the rest).
- Zoom changes the SVG's pixel size inside a scrolling region (keyboard focus scrolls to the node);
  "Fit" is the natural size or the width of the region, whichever is smaller. Nothing animates, so
  reduced motion needs no override. Forced colours: `CanvasText`/`Canvas`/`Highlight` rules, with the
  dash patterns and shapes carrying the meaning.

### 7. Ways in
A "Knowledge graph" view button, the palette command "Show the knowledge graph", "Show in graph" in
a highlight's Links, and `dashboard.html?view=graph&highlight=<id>` (`DashboardTarget.view: 'graph'`,
used by the side panel's "Show in graph"). The link is untrusted input like the others: ids must look
like ids, anything else is the list.

## Consequences
- The only schema-adjacent change is a stricter read-side visibility rule (§3); no migration, no new
  table, nothing to back up differently. The note on an AI-derived link is ordinary link data and is
  synced and backed up as such.
- A link is the person's statement. Nothing links items on its own: lexical relatedness stays a
  suggestion with a button, and a model's contradiction stays an unverified report with a button.
- The 60-item cap and the 20,000-link read cap are honest limits: both are said on the screen.
- Because the picture is computed from all visible links, a vault with tens of thousands of links
  pays that read when the view opens (never at start-up); the overview does not draw anything.

## Limits and not verified
- Not run on a real screen reader (NVDA/JAWS/VoiceOver); the semantics are asserted in tests and axe
  is clean on the view in Chromium. Touch drag/pan is the browser's own scrolling.
- The keyboard walk is an interpretation of "arrow keys move between neighbours": spatial arrows
  would leave some neighbours unreachable. Revisit if users expect up/down to be spatial.
- Links to a highlight that is only in the trash are hidden, not offered for repair: restoring the
  highlight is the way back.
- A page layout of several thousand nodes was not attempted (the cap is the design).

## Tests
`packages/shared/src/graph.test.ts` (traversal, caps, determinism, layout spacing, clusters, stepping),
`packages/storage/src/graph.test.ts` (descriptions, directions, trash/restore/purge, the note-of-a-
trashed-highlight rule), `packages/ui/src/vault/Links.test.tsx` (collapsed, listing, picker, duplicates,
self, knowledge points, retype/note/remove with undo, live trash, one-click Related),
`entrypoints/dashboard/GraphView.test.tsx` (overview, neighbourhood, table, depth, cap and "show more",
keyboard, zoom, live trash, unavailable centre, note without highlight),
`entrypoints/dashboard/DashboardGraph.test.tsx` and `entrypoints/sidepanel/SidePanel.links.test.tsx`
(the wiring against the real vault), `packages/ui/src/ai/__tests__/link-contradiction.test.tsx`, and
`tests/e2e/graph.spec.ts` (links made through the UI, backlink on the other item, graph, keyboard, axe,
offline, a second window, trash/restore/purge, Delete all data).

## Size
See the report of the change: lazy chunk about 18.9 KB (6.7 KB gzip) plus 3.1 KB of CSS; the always-loaded
part (Links, storage reads, wiring) is carried by the dashboard and the side panel only, not by the
service worker or the content script.
