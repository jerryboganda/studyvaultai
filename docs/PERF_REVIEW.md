# Performance and bundle review (agent P1)

> **Status, 2026-10-11 (CI evidence added; the findings and numbers below are unchanged).** The seeded
> stress suites ran and passed in the `stress (perf suites, SV_PERF=1)` job of Actions run 38139836238
> (<https://github.com/jerryboganda/studyvaultai/actions/runs/38139836238>, commit `d641515b1154aa46597e7ebb069d2341014c125c`) on a GitHub-hosted ubuntu-latest
> runner: `node scripts/run-perf.mjs` found six suites (`packages/storage/src/perf.test.ts` 4 tests,
> `packages/search/src/perf.test.ts` 5, `packages/highlights/src/perf.test.ts` 2 in jsdom,
> `packages/study/src/perf.test.ts` 3, `packages/backup/src/roundtrip.test.ts` 17 and
> `stress.test.ts` 7) and reported "perf run ok: 38 tests". What that run asserts: each suite's own
> p95 budgets (for example `listHighlights` under 300 ms and `listBanksWithCounts` under 100 ms on
> 10,000 seeded highlights; search under 300 ms p95 and an index build under 3,000 ms on 10,000
> documents; the study queue under 400 ms and the log analytics under 1,500 ms p95 on 10,000 cards and
> 100,000 logs), a lossless 10,000-highlight export and replace restore, bounded-chunk streaming with
> monotonic progress, and the content-script restore and orphan budgets on a 1.18 M-character jsdom
> document; that no expected suite was skipped or missing (the runner fails a suite in which no test
> ran, and an expected area with no suite); and its coarse ceilings of 120 s per test and 300 s per
> file. The job is advisory (`continue-on-error`) and no step failed. It reported, for one run on one
> shared runner, a search-index `serialize` of 15.7 MB in 394 ms and a restore in 362 ms, against
> the 1.2 to 3.2 s measured below on the shared Windows box; both are regression guards, not benchmarks,
> and neither is a Chrome number. The e2e `dashboard.spec.ts` "perf: 10,000 highlights" and
> `lifecycle.spec.ts` "performance evidence" also passed on Ubuntu and Windows in the `e2e` jobs of the
> same run, and the bundle budgets were asserted by `scripts/check-build.mjs` in the `build` job. The
> ranked findings and the recommended items below (the seconds-long search-index serialise and
> restore, the eager dashboard index, the parsing of due cards, the bundle total at 99.4% of its
> budget) are not changed by this paragraph.

Review date: 2026-10-11. Scope: content script cost on arbitrary pages, service-worker cold start,
IndexedDB access patterns, search index build / persistence, UI list and re-render behaviour, PDF
reader and OCR memory, per-entrypoint bundle composition. Budgets under review are
`TEST_PLAN.md` ("Performance targets": <150 ms added interaction p95, <300 ms p95 search on 10k,
no unconditional extraction or polling, lazy PDF/OCR, virtualised lists) and `scripts/check-build.mjs`
(content script 450 KB, background 420 KB, non-OCR total 6500 KB).

## How to read the numbers

- **Measured** means a number produced by a command listed in "Reproduce" below, on this machine:
  Windows 11, 4 CPUs, **shared with other agents running builds and test suites at the same time**,
  Node 24, `fake-indexeddb`, jsdom. Timings are relative evidence, not Chrome numbers, and several
  were taken twice because the box was noisy (both are given).
- **Not measured** means the claim comes from reading the code. It is marked as such.
- Nothing here was run in a real Chrome. No Playwright run was made (CI owns that).
- Line numbers are those of the review; files are being edited concurrently, so they drift.
- Bundle sizes come from one e2e-variant build (`scripts/build-e2e.mjs`, same production Vite build
  plus loopback hosts and the e2e hook), written to a private output folder that was deleted
  afterwards. The production build differs from it by a few KB at most (the e2e hook).

## Measured

### Bundles (e2e variant, minified, uncompressed)

| File | KB | Budget (`check-build.mjs`) | Used |
| --- | ---: | ---: | ---: |
| `content-scripts/highlighter.js` | 405 | 450 | 90% |
| `background.js` | 382 | 420 | 91% |
| non-OCR total (all files) | 6 464 | 6 500 | **99.4%** |
| `chunks/src-*.js` (shared by every page) | 785 | none | |
| `chunks/pdf-*.js` (pdf.js main thread, lazy) | 476 | none | |
| `assets/pdf.worker.min-*.mjs` | 1 290 | none | |
| PDF.js `bcmap` files (168) | 1 138 | none | |
| PDF.js fonts (`ttf` 560 + `pfb` 196) | 756 | none | |
| PDF.js wasm (openjpeg, jbig2) | 346 | none | |

Per-entrypoint JS, own code only (everything also loads `src-*.js`, 785 KB): popup 15, onboarding 25,
review 80 (+23 shared with options/sidepanel), dashboard 108 (+136 `vault`), side panel 47
(+136 `vault`, +58 `ai`), options 145 (+58 `ai`, +23 `review`, +17 `hooks`), PDF reader 130
(+476 pdf.js, +6 OCR engine, lazily).

What is inside the 785 KB shared chunk, bundled one library at a time with the production minifier:
React + react-dom/client 215 KB (66 KB gzip), Dexie 96, Zod 86, ts-fsrs 20, fflate 12, uuidv7 ~1,
leaving ~355 KB of this repository's code (the `@storage` barrel with its study, AI, sync and backup
repositories, `@runtime`, `@shared`, `@ui` shell). Third-party code is about half of it.

What is inside the 405 KB content script: React + react-dom 215 KB (53%), Zod 86 KB (21%),
`@shared` schemas ~17 KB, controller + runtime + highlights ~50 KB, overlay UI ~35 KB. Without the
overlay, controller + runtime + highlights + Zod is 155 KB.

### Search (`packages/search/src/perf.test.ts`, Node, 10 000 documents)

| What | Result |
| --- | --- |
| build index (sync `applyChanges`), best of 3 / first | 973 ms / 1 243 ms (a later run on the loaded box: 3.9 s) |
| 14 heavy filtered queries, p95 / max | 59 ms / 74 ms (budget 300 ms) |
| single document upsert p95 | 2.3 ms |
| reconcile 10 000 unchanged documents | 151 ms |
| `serialize()`, 15.7 MB | **1 234 ms** (two later runs: 1.8 s, 2.6 s under load) |
| `deserializeSearchIndex()` of that text | **1 352 ms** (later runs: 1.7 s, 3.2 s) |

Breakdown of one `serialize()` (15.6 MB): `JSON.stringify` of the documents 51-101 ms, `fnv1a` over the
text 121-396 ms; the rest (the larger share) is MiniSearch `toJSON()` plus `JSON.stringify` of its
postings. All of it is one synchronous call.

### Content script (`packages/highlights/src/perf.test.ts`, jsdom, 1.18 M characters, 27 359 segments)

`buildTextStream` 210 ms; capture of 200 anchors 1 543 ms (about 7.7 ms each, jsdom); restore (stream
+ 200 resolutions) 270 ms; 200 orphan resolutions on a rewritten page 993 ms. jsdom walks the DOM
much slower than Chrome; read these as ratios (a re-resolve pass is dominated by the stream build).

### Retention engine (new `packages/study/src/perf.test.ts`, `SV_PERF=1`, 10 000 cards, 100 000 logs)

| What | CPU p95 | Budget |
| --- | ---: | ---: |
| `buildQueue`, default order | 141 ms | 400 ms |
| `buildQueue`, interleave by bank | 125 ms | 400 ms |
| `buildQueue`, order by due | 140 ms | 400 ms |
| `buildQueue`, new cards shuffled | 156 ms | 400 ms |
| `streak` + `studyLog(90)` + `trueRetention` over 100k logs | 343 ms | 1 500 ms |
| `studyLog(365)` over 100k logs | 126 ms | 1 500 ms |
| `dueForecast` + `backlog` + `countsByDeck` + `countsByBank` + `estimatedRetention` over 10k cards | 78 ms | 400 ms |

### Zod parse of due cards (throw-away bench, Node)

`Card.safeParse` over 10 000 realistic rows: 856 ms cold, 594 ms, 339 ms warm. This is the dominant
cost of `getDueSummary` / `listDueCards` on a large backlog (`study.ts:1398`), and it is not in the
study suite above (that suite is pure functions).

### Storage (`packages/storage/src/perf.test.ts`, `SV_PERF=1`, 10 000 highlights, fake-indexeddb)

Run twice after the changes in this pass (wall p50 / p95 ms; CPU p95 in brackets; budget on CPU p95):

| Call | Run 1 | Run 2 | Budget |
| --- | --- | --- | ---: |
| `listHighlights`, filtered, 50/page | 76 / 208 (219) | 67 / 111 (125) | 300 |
| `listHighlights`, page 2 by cursor | 44 / 48 (78) | 42 / 46 (62) | 300 |
| `listBanksWithCounts` | 38 / 62 (79) | 31 / 40 (63) | 100 |
| `listTags` (with counts) | 47 / 87 (78) | 32 / 47 (78) | 100 |
| `getCounts` (all facets) | 262 / 273 (297) | 188 / 254 (251) | 400 |
| `saveCapture` | 9 / 15 (**62, failed**) | 6 / 10 (31) | 50 |
| `listSearchDocuments` (500/page, no budget) | 343 / 478 (735) | 270 / 492 (750) | none |
| `listSearchDocumentsChangedSince` (no budget) | 790 / 794 (749) | 357 / 365 (484) | none |
| `findDuplicateClusters` (no budget) | 457 / 521 (547) | 290 / 311 (391) | none |
| `checkIntegrity` | 4 044 ms | 1 255 ms | none |

The one failure (run 1, `saveCapture` CPU p95 62 ms against 50) is the measurement, not the code:
the wall-clock p95 was 15 ms, every CPU figure on this machine is a multiple of Windows' 15.6 ms
`process.cpuUsage` tick, and the box was loaded; run 2 passed (31 ms). The Linux CI runner is the
authority. There is no "before" for this suite: the changes in this pass were made without a
baseline run, so the table is a reference for the next CI run, not a comparison. The fake-indexeddb
numbers are several times slower than Chrome's engine.

## Findings

Severity: **High** = breaks a TEST_PLAN budget or wastes CPU on a common path by design;
**Medium** = measurable waste or a thin safety margin; **Low** = real but bounded or only at extremes.
"Status": FIXED (in this pass, with a test), RECOMMENDED (not changed, with the reason).

| ID | Sev | Area | Where | Evidence | Expected gain | Status |
| --- | --- | --- | --- | --- | --- | --- |
| P1-01 | High | Search | `packages/search/src/searchIndex.ts:663` (`serialize`), `:1198` (`deserializeSearchIndex`); written by `packages/ui/src/vault/searchHost.ts` `persist()` | Measured: 15.7 MB, serialize 1.2-2.6 s, restore 1.4-3.2 s at 10k documents, single synchronous call on the page's main thread. Violates the <150 ms interaction budget each time it runs. The cache is no faster than a rebuild (~1 s, chunked and with progress) | A long task every flush. FIXED part: timed writes now back off to 20x the last write's cost, so the cache can take at most ~5% of the page's time (and a typing session no longer re-serialises every 3 s). The long task itself remains: chunked/streaming `serialize`, or hosting the index in a Worker, removes it | FIXED (mitigation), RECOMMENDED (the long task) |
| P1-02 | High | Search / dashboard | `entrypoints/dashboard/Dashboard.tsx:145-148` (`host.start()` on mount) | The dashboard opens the index even in browse mode, where the list does not use it (`library.ts`: "A browse list does not depend on the search index"). At 10k documents that is a 15.7 MB read from `meta` plus a ~1.3 s synchronous restore (measured, Node) at every dashboard open. The side panel already does the right thing (`useSearchHost(enabled)`) | Removes the long task for every browse-only visit | RECOMMENDED. Not changed: `tests/e2e/dashboard.spec.ts:1786-1836` and `Dashboard.test.tsx:283` assert the eager "Building the search index" on open. Start the host when the search box is focused, on the first query, or in the storage view, and update those two tests in the same change |
| P1-03 | High | Study storage | `packages/storage/src/study.ts:1398` (`loadQueueInputs` -> `parseCards`), `:1580` (`getStudyOverview`: `db.cards.toArray()`), `:1669` (`getAnalyticsInput`) | Measured: Zod parse of 10k cards 340-860 ms (Node). The popup / side panel badge (`useDueCount`) parses every card that can be due on every data change and every minute; the review overview parses all cards and the due ones again | Orders of magnitude on a backlogged vault: read the 8 queue fields with typeof checks (or cache a parsed card by `id` + `updatedAt`) instead of the full schema. Not measured after | RECOMMENDED (correctness-sensitive: `parseRow` is the read-path guard) |
| P1-04 | Medium | Cross-context signalling | `packages/storage/src/study.ts:1279,1334` and ~25 other study writes -> `core.ts:76` `signalChange` -> `chrome.storage.local.dataEpoch` | Every card answer bumps `dataEpoch`. Every content script listens (`controller.ts:718`), so each open tab re-fetches its highlights over RPC and re-resolves all of them (`rehydrator.ts:201-243` resets every entry to pending); the dashboard re-reads its list; the worker wakes (`background/sync.ts:1654`). Study data are not shown on pages. Not measured end to end | Removes N x (tabs) re-fetch + re-resolve for a session of N answers. Needs a third channel (study) that content scripts do not watch, and the sync listener (`background/sync.ts:1654`, watches `dataEpoch` only) must watch it too or reviews stop triggering sync | RECOMMENDED (touches the sync contract) |
| P1-05 | Medium | Worker / DB open | `packages/storage/src/db.ts:496` `runMigrationHooks` | Every context registers a pre-migration hook, so every first read opened the database twice (a schema-less probe, then the real open) only to learn that the version is current. Chrome's `indexedDB.databases()`, already called there, reports the version. Not measured in Chrome | One database open per context start (service-worker wake, popup, side panel, every page load that wakes the worker) | FIXED (`openProbe.test.ts`) |
| P1-06 | Medium | Content script bundle | `entrypoints/highlighter.content/ui/mount.tsx:86` (`createRoot`), bundle | 405 KB, 53% React + react-dom, 21% Zod, evaluated on every page where the script is injected, plus a React root mounted at `document_idle` whether or not the reader ever selects text | Aliasing `react` / `react-dom` to `preact/compat` for this entrypoint only would remove ~190 KB (-47%), roughly the parse and heap cost per tab. Needs a dependency decision (new package, ADR) | RECOMMENDED |
| P1-07 | Medium | Budgets | `scripts/check-build.mjs` | Measured: non-OCR total 6 464 KB of 6 500 KB (36 KB headroom), background 382 of 420, content script 405 of 450. Half of the total is PDF.js assets (worker 1.29 MB, 168 bcmap 1.14 MB, fonts 756 KB, wasm 346 KB) | Not a speed issue: the next feature that adds ~40 KB fails the `build` job. Decide deliberately: raise the total with a recorded reason, or load rarely used bcmaps on demand | RECOMMENDED |
| P1-08 | Medium | Shared chunk | `chunks/src-*.js` (785 KB) loaded by every page | The popup (15 KB of own code) parses 785 KB. Measured what narrowing `@storage` imports would save: a popup-like entry is 543 KB through the barrel and 489 KB through direct modules (-55 KB, -10%); `repo.ts` still reaches `backupTarget`, `@ai` and `@backup`. React, Dexie and Zod are 51% of the chunk | Splitting the `@storage` barrel is not worth its risk (~10%). Larger and cheaper: lazy-load rarely used page sections (below), Zod `mini` for page-side schemas (not measured) | RECOMMENDED (do not split the barrel) |
| P1-09 | Medium | DB write path | `packages/storage/src/db.ts:678` `assertNoNewerRows` | First write per connection scans `banks`, `folders`, `tags`, `documents` in full (`filter(isNewerRow).first()` reads every row; no `schemaVersion` index on them), and a service worker is a new connection on every wake. Not measured | Four table scans per worker wake that writes. Needs a v4 schema (index on those four tables) or a persisted "verified for build X" marker in `meta` | RECOMMENDED |
| P1-10 | Medium | Search feed | `packages/storage/src/search.ts` `buildDocuments` | Read and Zod-parsed **every bank and every folder** once per page of 500 documents and once per catch-up, and filtered every membership and tag link for every highlight (O(page^2)). 10k documents = 20 pages x all folders | A full build no longer pays pages x folders parses; a catch-up reads only the folders its documents name | FIXED (`search.test.ts` "bank, folder and tag facets") |
| P1-11 | Medium | Dashboard list | `packages/storage/src/query.ts:418` (`toDashboardItems`) | Every list call read all folders of every bank on the page (a 50-row page of a bank with 5 000 folders parsed 5 000) | Reads only the referenced folders and their parents; shares `readFolderChains` with P1-10 | FIXED (existing `query.test.ts` folder-path test) |
| P1-12 | Medium | Polling | `packages/ui/src/review/hooks.ts:58` `useTick` (60 s interval), used by `useDueCount`, `StudyView.tsx:59,66`, `Analytics.tsx:28` | The interval re-ran `getDueSummary` / `getStudyOverview` (every card, see P1-03) every minute, also for a hidden page | A hidden review page, or one in a background tab, now does nothing and ticks once when shown. A visible side panel still ticks every minute: schedule one timeout to `min(dayEndsAt, nextLearningAt)` instead | FIXED (hidden), RECOMMENDED (visible) |
| P1-13 | Medium | Re-render | `packages/ui/src/hooks.ts:195,224` `useObserved` | The effect depends on `epoch`, so each data change tears down and re-creates the Dexie `liveQuery`, which also fires by itself for a change made in this context. Side panel: 5+ observed queries (page, recent, tags, due, banks), the first two with joins. Not measured | Up to half of the query runs per change; needs care (the epoch exists because cross-context liveQuery is not guaranteed) | RECOMMENDED |
| P1-14 | Medium | List rendering | `packages/ui/src/vault/VirtualList.tsx` `onScroll` | Stored the raw `scrollTop`, so every scroll event re-rendered every visible row (about 21) even inside one row | Re-renders once per row crossed instead of once per scroll event (a 64 px row is ~4-60 events) | FIXED (`VirtualList.test.tsx`) |
| P1-15 | Low | Counts | `packages/storage/src/repo.ts` `listBanksWithCounts`, `tags.ts` `listTags` | Filtered all trashed memberships / links once per bank / tag: O(banks x trashed) | Single pass; matters only with thousands of banks/tags or a large trash | FIXED (existing count tests) |
| P1-16 | Low | PDF documents | `packages/storage/src/pdf.ts` `listDocuments` | N+1: per document a source query, per source a `.each` that deserialised every highlight row only to count it; called when Options opens (`Storage.tsx:27`) and by the reader | Counts from the index (all of a source minus its trashed ones); no highlight row is read. The per-document source and attachment lookups remain | FIXED (counting), RECOMMENDED (one `sources` read) |
| P1-17 | Low | Filter | `packages/storage/src/query.ts:185-191` | `hasNote` reads the whole `notes` table (bodies included) on every list query that uses it | A keys-only plan on the `highlightId` index. Not measured | RECOMMENDED |
| P1-18 | Low | Bundles | `entrypoints/options/Options.tsx` imports | Options statically imports the AI, sync, backup, review and storage sections (145 KB own + 58 `ai` + 23 `review` + 17 `hooks`, all modulepreloaded). Sections already mount one task after the first render | `React.lazy` per section would defer ~100 KB of parse on a rarely visited page: a single-digit ms gain, and `Options.test.tsx` (1 180 lines) assumes synchronous sections | RECOMMENDED (low value) |
| P1-19 | Low | Bundles | `entrypoints/sidepanel/CardNotes.tsx:4`, `packages/ui/src/panel` | The side panel statically loads the 139 KB `vault` chunk (marked + DOMPurify 72 KB, MiniSearch 17 KB) although search starts lazily and Markdown is only for notes | `import()` of `Markdown` and of the Search tab; ~110 KB less parse on every side-panel open. Not measured | RECOMMENDED |
| P1-20 | Low | Content script | `entrypoints/highlighter.content/rehydrator.ts:326-349` `retryPass` | Entries whose text changed under them (`stale`) are re-resolved outside the `RetryBudget`, each pass rebuilding the whole stream: at most one per `MUTATION_MAX_WAIT_MS` (1 s) on a page whose highlighted text keeps changing | Bounded to ~1 stream build/s (jsdom: 210 ms per 1 MB, Chrome much less); charge stale passes to the budget | RECOMMENDED |
| P1-21 | Low | Content script | `controller.ts:756-762`, `routeWatcher.ts:54` | `routes.check()` normalises the URL once per mutation callback. Cost per call is microseconds (not measured) | Negligible; compare the raw `href` first if it ever shows up | RECOMMENDED (skip) |
| P1-22 | Low | Writes | `packages/storage/src/core.ts:450` `touchHighlights` | One awaited `update` per id inside the bulk transaction. `bulkUpdate` would be faster but goes through the sync write-capture middleware | Not measured; only bulk moves/tags of thousands | RECOMMENDED |
| P1-23 | Low | UI | `packages/ui/src/vault/Tree.tsx`, `treeModel.ts` `flattenVisible` | The tree is flat but not windowed: cost follows the number of expanded nodes (every key press re-renders them) | Only a bank with thousands of expanded folders. Not measured | RECOMMENDED |

### Checked and found sound

- **No polling in the content script**: no `setInterval`, one MutationObserver on `<html>` (`controller.ts:756`),
  debounced 400 ms with a 1 s maximum wait, ignoring its own host, `<head>`, scripts, styles and form
  controls (`mutations.ts`); it only ever invalidates the cached stream and schedules a pass.
- **The page text is read lazily**: a page with no stored highlights builds no text stream at all
  (`rehydrator.ts` `resolve`: "no highlight to resolve, no stream"); capture builds one on demand
  (`controller.ts:282`); the stream is linear, merges adjacent text into segments, hashes lazily and
  looks positions up by binary search (`textStream.ts`).
- **Unresolved highlights are rate-bounded**: `RetryBudget` spaces passes at >= 20x their own cost.
- **Selection checks are bounded**: the editor scan is skipped for selections over the quote limit
  (`eligibility.ts:186-190`); scroll/resize repositioning is one `requestAnimationFrame` and returns
  early when no toolbar is shown.
- **Denied and restricted hosts**: the registration excludes them (`siteAccess.ts`
  `excludeMatches`), and a denied host that is injected anyway unmounts (`controller.ts:836`): no
  observer, no overlay, no listeners.
- **Teardown**: every listener, observer, timer, painter registration and the overlay are removed in
  `unmount()` (`controller.ts:810-832`), also on SPA navigation (`routeChanged`) and on context
  invalidation (`alive()`).
- **Service worker**: `background/index.ts` registers listeners (plus one `storage.session`
  access-level call) and opens nothing at start: the database opens on the first handler that needs
  it, `site.sync()` runs only on install / browser start / permission change, and sync alarms exist
  only after the opt-in permission. (The wake itself is the cost: see P1-04, P1-05.)
- **PDF reader**: only visible pages +/-1 hold a canvas and a text layer (`virtualizer.ts`), render is
  aborted on scroll, `release` zeroes the canvas and calls `pdfPage.cleanup()` (`pageView.ts:204-211`),
  canvases are capped at 16.7 MP (`MAX_CANVAS_PIXELS`), page text is an LRU of 24 (`engine.ts:119`),
  pdf.js and the OCR engine are `import()`ed on first use (`engine.ts:40`, `ocr.ts:37-38`), the OCR
  worker is terminated after 60 s idle (`ocr engine.ts:14`).
- **Search queries** meet the budget with a wide margin (p95 59 ms at 10k, 5x under 300 ms).
- **Lists**: the dashboard list is a windowed listbox with fixed row height, paged 50 at a time with a
  2 000-row keep cap (`useResults.ts`); the search results are capped by page size.

## Fixed in this pass

| Change | Files | Test |
| --- | --- | --- |
| No probe open of a database that is already current (P1-05) | `packages/storage/src/db.ts` | `packages/storage/src/openProbe.test.ts` (new; counts `indexedDB.open`, still probes an older database) |
| Cache write backs off to 20x its measured cost (P1-01) | `packages/ui/src/vault/searchHost.ts` | `packages/ui/src/vault/searchHost.persist.test.ts` (new) |
| Search feed reads only referenced banks and folders; O(page) facets (P1-10) and the dashboard join (P1-11) | `packages/storage/src/core.ts` (`readFolderChains`), `search.ts`, `query.ts` | `packages/storage/src/search.test.ts` (new "facets" test); existing `query.test.ts` |
| Per-bank and per-tag trashed counts in one pass (P1-15) | `packages/storage/src/repo.ts`, `tags.ts` | existing `repo.test.ts`, `knowledge.test.ts` (trashed highlights do not count) |
| PDF document highlight counts from the index (P1-16) | `packages/storage/src/pdf.ts` | `packages/storage/src/pdf.test.ts` (new: trashed and restored) |
| Hidden page does not tick (P1-12) | `packages/ui/src/review/hooks.ts` | `packages/ui/src/review/tick.test.tsx` (new) |
| Scroll inside one row does not re-render the rows (P1-14) | `packages/ui/src/vault/VirtualList.tsx` | `packages/ui/src/vault/VirtualList.test.tsx` (new case) |
| Seeded study suite: 10k-card queue, 100k-log analytics, gated by `SV_PERF` | `packages/study/src/perf.test.ts` (new) | itself; `scripts/run-perf.mjs` finds it (`--list`) and its `KNOWN_GAPS` entry for `study` is removed; `RELEASE.md` stress row updated |

## Recommended follow-ups, by value

1. **P1-02 + P1-01**: start the dashboard's search host on demand (focus, first query, storage view),
   and make `serialize()` / restore yield (or move the index into a Worker). Together they remove the
   only seconds-long task found. Update `dashboard.spec.ts:1786-1836` and `Dashboard.test.tsx:283`.
2. **P1-03**: a slim queue-row reader for the badge and the queue (typeof checks on the eight fields
   `QueueCard` needs), keeping `parseRow` for everything that is edited or shown. Add a storage perf
   case (`getDueSummary` over 10k due cards) to `packages/storage/src/perf.test.ts`.
3. **P1-04**: a study channel next to `dataEpoch` / `resolutionEpoch` that content scripts do not
   watch; make `background/sync.ts` and `useDataEpoch` watch it. ADR needed (it is a change to the
   sync trigger contract).
4. **P1-06**: Preact for the content script only (alias in `wxt.config.ts`), -190 KB per injected page.
5. **P1-09**: `schemaVersion` index on `banks`, `folders`, `tags`, `documents` (schema v4) or a
   persisted verification marker, so a service-worker wake that writes does not scan four tables.
6. **P1-07**: decide the size policy before the next feature (see the table): raise the total with a
   recorded reason, or ship bcmaps on demand.
7. **P1-12 (visible)**: one timer to the next rollover / learning step instead of a 60 s interval.
8. **P1-19, P1-18**: lazy `Markdown` and Search tab in the side panel; lazy options sections last.

## Not measured

- Anything in a real Chrome: service-worker cold start (and what P1-05 saves), content-script injection
  cost per page, IndexedDB request latency, `liveQuery` double runs (P1-13), long-task attribution.
- Memory: heap per tab for the content script, two open `SearchHost`s (dashboard + side panel hold two
  copies of documents + postings), canvas memory at high zoom.
- `getDueSummary` / `getStudyOverview` end to end on 10k due cards in IndexedDB (only the Zod parse was
  measured, in isolation).
- Effect of the fixes on a full 10k build in IndexedDB (the storage perf suite reports
  `listSearchDocuments (500/page)` without a budget; compare its number between CI runs).
- The cost of a re-resolve pass in Chrome (`isStale` over all painted highlights per
  `retryPass`, `rehydrator.ts:521`).

## Reproduce

```bash
# bundle sizes (one build, private folder, delete it afterwards)
cmd /c "set SV_OUT_DIR=.output-p1&& node scripts/build-e2e.mjs"
# search: build, query, serialize, restore at 10k
node node_modules/vitest/vitest.mjs run packages/search/src/perf.test.ts --environment node --reporter=verbose
# highlights, 1 MB page
node node_modules/vitest/vitest.mjs run packages/highlights/src/perf.test.ts --reporter=verbose
# new study suite (also run by scripts/run-perf.mjs in the `stress` job)
SV_PERF=1 node node_modules/vitest/vitest.mjs run packages/study/src/perf.test.ts --reporter=verbose
# storage 10k vault (heavy; CI `stress` job owns it)
SV_PERF=1 node node_modules/vitest/vitest.mjs run packages/storage/src/perf.test.ts --reporter=verbose
```

Library sizes were measured by minifying one entry per package with rolldown (the bundler Vite 8
uses) and summing, with React built for production; they are a decomposition, not a second build.

## Addendum, 2026-10-12: what changed since this review (finish wave)

Method: the ADRs (011 to 020) and the code were read; the figures below are the ones each ADR's
author recorded from a private e2e-variant build (`scripts/build-e2e.mjs`, the same Vite build and
minifier as production plus loopback hosts and the e2e hook) or from the header of the module they
describe. **They are not one baseline-to-head comparison**: each was measured against a copy of the
tree with that change taken out, while other work was in the tree. Nothing here was measured in Chrome
by this addendum and no run of branch `feat/finish-all` has passed the `build` or `stress` job with
these changes, so the budgets in `scripts/check-build.mjs` have not yet asserted them.

### Findings above that moved

| ID | Was | Now | Evidence | Status |
| --- | --- | --- | --- | --- |
| P1-06 | Content script 405 KB, 53% React and react-dom | `react` and `react-dom` resolve to `preact/compat` for the content-script entrypoint only: 414,404 B to 214,393 B (-200,011 B, -48.3%), gzip 127,826 B to 68,246 B; the pages keep React | ADR-012; `modules/content-script-preact.ts`; budget 220 KB | **FIXED** (private build; the gate has not run on the branch's production build) |
| P1-07 | Total 6,464 KB of 6,500 (99.4%) | The wave added about 44 KB for the AI router and chat alone (ADR-013: 6,486.9 to 6,530.9 KB) and the whole wave measured 6,643 KB in a CI `build` job before the rules UI landed (comment in `scripts/check-build.mjs`); budgets are now content script 220 KB, background 450 KB, non-OCR total 6,800 KB (about 2% headroom) | `scripts/check-build.mjs` | **Budget raised with a recorded reason**, not fixed: the margin is thin again, and the follow-up named in P1-07 (load bcmaps on demand) was not done |
| P1-02 | The dashboard opens the search index on mount although browse mode does not use it | Unchanged (`Dashboard.tsx` still calls `host.start()` on mount). The same index now also serves "Related", the link picker and chat retrieval, so the eager start is less of a pure cost | `entrypoints/dashboard/Dashboard.tsx` | RECOMMENDED, unchanged |
| P1-09 | `assertNoNewerRows` scans four tables in full on the first write per connection | Not taken in schema v4 (ADR-011: "No existing table changes"), and the scan now also covers `filingRules`, `syllabi` and `relations` (small tables) | ADR-011 section 1 | RECOMMENDED, slightly larger |
| P1-03 | Zod parse of every card that can be due, on a backlogged vault, in the popup and review page | Also on a worker path now: with reminders on, the worker calls `getDueSummary` at start and on each `dataEpoch`, `studySettings` and `settings` change, through one single-flight pass with a re-run flag; it reads only cards that can be due today (an index range). Nothing is read at start while the feature is off beyond one `storage.local` key | ADR-019; `entrypoints/background/reminders.ts` | RECOMMENDED, more reachable: a slim queue-row reader would help the worker too |
| P1-04 | Every card answer bumps `dataEpoch` and wakes every tab | Unchanged; the reminders service is one more listener in the worker, active only when the feature is on | ADR-019 | RECOMMENDED |
| P1-01 | Seconds-long search-index serialise and restore | Unchanged | | RECOMMENDED (mitigation only) |

### New items

| ID | Sev | Where | Figures and evidence | Status |
| --- | --- | --- | --- | --- |
| P1-24 | Medium | Content script: Zod | After Preact, Zod is about 86 KB of the 209 KB content script, on the path through `@shared` and message validation. A throw-away bundle of an equivalent small schema set measured 91.6 KB with `zod` and 26.4 KB with `zod/mini` (about -65 KB), but `zod/mini` has no method chaining, so it means rewriting the `@shared` schemas, which guard storage reads, backups and messages. Three more schema blocks (rules, syllabi, relations) add about 2.9 KB minified (1.2 KB gzip) to any bundle that keeps `schema.ts` whole, and the content script does (ADR-011) | RECOMMENDED: its own ADR (migrate `@shared` to `zod/mini`, or split a content-script schema surface; moving the new block to a subpath such as `@shared/organisation` would take the 2.9 KB out) |
| P1-25 | Medium | Worker bundle | Filing code +12,352 B (412,550 to 424,902 B; gzip +3,683, ADR-017); reminders +11,762 B (`getDueSummary` brings the queue builder, ADR-019); router +3.7 KB (ADR-013). Measured about 425 KB against a 450 KB budget (comment in `scripts/check-build.mjs`) | Budget raised. ADR-011 says only the table specs, the upgrade step and the purge cascade of the three new repositories are in the worker; the comment above the budget in `scripts/check-build.mjs` says the worker bundles the repositories because they register schemas at import time. A search of the private e2e-variant worker of ADR-017 (424,902 B, the size ADR-017 records) for the message strings of `rules.ts` ("Rule not found", "is not a site name", "Choose the bank to file into") and `syllabi.ts` ("Syllabus not found") found none, which agrees with ADR-011 and not with the comment (open item U-21 in `docs/PRIVACY_CLAIMS.md`) |
| P1-26 | Low | New lazy chunks | Exam 45,315 B (gzip 13,852), opened with the Exam tab; `SyllabusView` 24,683 B (8,689) and `SyllabusCoverage` 14,895 B (5,246); `RulesView` 28,018 B; graph about 18.9 KB (6.7 gzip) plus 3.1 KB CSS; import readers 12.6 KB; `AiRoutingSection` +13.1 KB and `ChatView` +5.2 KB; the reminders section is its own lazy chunk (+7,868 B in the pages and +11,762 B in the worker in total). The side panel now fetches the AI engine (about 68 KB) when "AI drafts" is opened instead of at panel start (ADR-013) | Fixed by construction (nothing loads until the feature is opened); the options page still loads the `ai` chunk with the page |
| P1-27 | Low | Graph and coverage reads | The graph reads every visible link (at most 20,000) when the view opens and draws at most 60 items; the syllabus coverage reads every highlight id, link row and card once per refresh and refreshes on data changes, not on a timer; neither runs at start-up. Not measured on a large vault | RECOMMENDED: a measurement at 10,000 highlights and 20,000 links |
| P1-28 | High (as a freeze), now guarded | Markdown rendering | marked 18.1.0 took 20 s to more than 25 s on some 100,000-character inputs and overflowed the stack at about 3,000 nested quotes. A budget of about a quarter second of estimated work (the model is fitted to measurements and set at or above them), nesting at most 24 and 100,000 characters, is checked before the block pass and before the inline pass; hostile inputs are refused in 0 to 30 ms and shown as plain text. The module header records, for Chrome 152, a realistic 20,000-character note at 24 ms and a 100,000-character note at 87 ms (an estimate of 100 ms). Those figures were recorded by the author of the module; no CI run has asserted them (jsdom's DOM is about 12 times slower, so the unit tests carry bounds, not Chrome numbers) | **FIXED** in code with unit tests (`markdownBudget.test.ts`, `markdownRender.budget.test.ts`); CI pending |
| P1-29 | Low | Document import | Parsing runs on the importing page's thread (no Worker, ADR-014): bounded by 64 MiB, 5,000 entries, 256 MiB declared, 8 Mi characters and 10,000 blocks, so a hostile file inside the caps can keep the page busy for seconds, never forever. A header that lies about a stream's size is abandoned at the first 8 KiB slice past it | Accepted (THREAT_MODEL R26) |
| P1-30 | Low | Related highlights | `packages/search/src/related.perf.test.ts` asserts `related()` p95 under 50 ms (the widest request under 100 ms) over a seeded 10,000-document vault; `scripts/run-perf.mjs` picks it up as a seventh suite through its `.perf.test.ts` name. Measured numbers: none recorded here | Guard written; CI pending |
| P1-31 | Info | PDF reader, long real documents | `tests/e2e/pdf-real-memory.spec.ts` brings every page of the real documents of 50 pages or more on screen and bounds the canvases held at once (4), the main-thread heap growth over the first page (24 MB and a factor of 2.5) and live DOM growth (+2,500 nodes). The measurements the bounds came from, and what they do and do not show, are in the next addendum ("long real documents in real Chromium", below); they are agent-run local numbers on Windows, not a CI result, and pdf.js's worker heap and GPU or bitmap memory are not measured | Guard written; CI pending |

### Not measured here

- Anything in a real Chrome, including the Preact content script's parse and heap cost per tab (the
  size is measured, the per-tab effect is not) and the worker's cold start with the added modules.
- The size of the production build with the wave: only private e2e-variant builds were read.
- The cost of the exam, graph and coverage views on a vault of tens of thousands of rows.

## Addendum 2026-10-12: long real documents in real Chromium (windowing and heap)

Added by the real-PDF fixtures work. Measured, not estimated: `tests/e2e/pdf-real-memory.spec.ts` on
the three real documents of 50 or more pages in `tests/fixtures/pdf/real/` (listed, with their licence
basis, in `tests/fixtures/pdf/real/SOURCES.md`). Machine: Windows 11, 4 CPUs shared with other
agents, Node 24, Playwright 1.64 with its bundled Chromium 1248 (new headless, extension loaded
unpacked, `--enable-precise-memory-info`), e2e build of this tree. The Linux and Windows CI runs will
produce their own numbers in the `e2e` job logs (`[real-pdf-memory]` lines) and as attached
`memory-*.json`; they are not in this table until a run is cited here.

What the spec does: opens the file through the real file chooser, reads the heap after page 1 is drawn,
then brings every page on screen one after the other (setting the viewer's scroll position, waiting for
the page's text layer to be complete), reads the heap after each quarter, goes back to page 1 and
reads again. Every heap reading is taken after two forced collections (CDP
`HeapProfiler.collectGarbage`, then `Performance.getMetrics` `JSHeapUsedSize`; `performance.memory.
usedJSHeapSize` is read in the page right after and is about 2 MB higher, as expected for the same
isolate). A `MutationObserver` records the most canvases and text layers that existed at once, so
transient states are seen, not only settled ones.

| Document | Pages | Canvases at once (max) | Text layers at once (max) | Heap after page 1 | Heap after all pages | Growth | Per page | DOM nodes gained |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `cdc-sti-guidelines-2021` (text, tables, links) | 192 | 4 | 4 | 13.6 MB | 20.4 MB | +6.8 MB (x1.50) | 36 KB | -783 |
| `nist-sp800-63-3-digital-identity` (text, links, outline) | 76 | 4 | 4 | 9.5 MB | 10.3 MB | +0.9 MB (x1.09) | 12 KB | +306 |
| `naca-tr1135-compressible-flow-1953` (scan, 2544 x 3300 per page, OCR text layer) | 70 | 4 | 4 | 13.8 MB | 10.3 MB | -3.5 MB (x0.74) | n/a | -4 494 |

Four runs of the spec agreed to within 0.1 MB on the heap growth, exactly on canvases and text layers,
and to within 150 on DOM nodes. Time to bring every page on screen and settle it: 30 to 37 s for the
192-page file (158 to 195 ms a page), 4 to 5 s for the 76-page file, 24 to 28 s for the 70 scans (340
to 400 ms a page; the 8-megapixel image decode is the likely cost, not attributed). On the 192-page file the heap read after each quarter was
13.6, 14.5, 20.1, 20.4 MB (pages 48, 96, 144, 192): a stepped rise that levels off, not a line.

What it shows, and what it does not:

- **The lazy window holds.** Never more than 4 canvases and 4 text layers in the DOM, whatever the
  page count (two pages in view plus one neighbour each side). The live DOM node count after the
  traversal is within 306 nodes of the first-page reading, or lower. This is the bound the spec
  asserts (`<= 4`), and the existing `pdf.spec.ts` check (120 synthetic pages, jump to page 100) now
  has a real 192-page counterpart.
- **The heap is bounded in growth, not flat.** After a full traversal it is 1.5 times the first-page
  reading on the largest file, with 36 KB per page visited. The growth is most likely the per-page
  proxy objects pdf.js keeps for the life of the document (`engine.ts` also keeps its own
  `pages` map and never evicts it; `PDFPageProxy.cleanup()` frees a page's operator list and images
  but not the proxy) and fonts first used late in the document. Not attributed with a heap snapshot.
  Extrapolated, a 2 000-page document would hold on the order of 70 MB more than after page 1: modest,
  and the spec's bound (growth under 24 MB, factor under 2.5, 3.5 times the largest final growth
  measured) catches a leak that keeps a text layer or a decoded image per page, which would be tens
  of MB on these files.
- **Page text is cached by page count, not by bytes.** The heap of the 70-page scan read 33 MB at page
  35 and 10 MB at page 70. The 24-page text cache (`CACHE_PAGES` in `engine.ts`) holding the densest
  OCR layers (roughly 1 MB a page) is the likely reason; not confirmed with a snapshot. Bounded, but a
  run of text-dense pages can make that cache several times the size it has for ordinary pages. A byte
  budget would make it uniform; not done (nothing failed, and `engine.test.ts` assumes the
  page-count bound).
- **Not measured**: the pdf.js worker's own heap (a separate isolate, outside the page's JS heap),
  GPU and bitmap memory of canvases (bounded by the 4-canvas window and `MAX_CANVAS_PIXELS`, 16.7 MP
  each), and anything in Chrome on Linux or macOS. Memory of the whole browser process is not read.

Reproduce (one spec, a private build, the Playwright lock of `docs/plans/FINISH_BRIEF.md`):

```bash
SV_OUT_DIR=.output-pp node scripts/build-e2e.mjs
SV_OUT_DIR=.output-pp node node_modules/@playwright/test/cli.js test tests/e2e/pdf-real-memory.spec.ts \
  --workers=1 --output=.output-pp/test-results
```
