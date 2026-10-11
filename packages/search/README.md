# @search

Offline full-text and fuzzy search over the user's highlights and notes (MiniSearch 7.2.0, no network,
no model). `createSearchIndex()` builds the index, `deserializeSearchIndex()` restores a cached one.
Query grammar: `src/query.ts`. How a query runs: the header of `src/searchIndex.ts`.

## Related highlights

`index.related(id, options?)` lists the other highlights of the vault that share the most telling
words with a highlight or a note; `index.relatedToText(text, options?)` does the same for free text
(a knowledge point). Both are pure reads of the lexical index: no embeddings, nothing leaves the device.

How it works (`src/related.ts`, run in `src/searchIndex.ts`):

1. The document's own words: quote, your comment, tags and heading (not the page title, site, banks or
   folders, which describe where it lives, not what it says). Function words, single characters and
   bare numbers are dropped.
2. Each distinct term is weighted by field weight x (1 + ln tf), then ranked by that weight x inverse
   document frequency in the vault. Document frequency is counted over the _other_ documents: the
   source's own highlight and its notes repeat its quote, so counting them would make its rarest words
   look shared. Terms held by more than 10 % of the vault (at least 8 documents) are dropped.
3. The best 16 terms (option `maxTerms`, at most 32) run as one weighted OR query over the four content
   fields (MiniSearch BM25, the source's term weights as term boosts, exact terms only).
4. Hits are folded to one per highlight (a highlight and its notes: the best-scoring document leads),
   ordered by score, then newer `updatedAt`, then id, so the order is stable.

Never returned: the document's own highlight and its notes, trashed highlights (unless
`includeDeleted`), notes attached to nothing, notes whose highlight is gone. `excludeSameSource` also
drops highlights from the same source (same site and title). Each hit carries `sharedTerms` (as the
source wrote them, most telling first) and a one-line `explanation`: `shares: warfarin, INR, vitamin`.

Limits: words must match exactly (no stemming: "valve" does not find "valves"); it finds shared
vocabulary, not shared meaning; relatedness is only as good as the words captured.

Measured (Node, 10,000 documents, shared 4-CPU Windows dev machine, `related.perf.test.ts`, 200
sources x 3 runs; the "busy" rows were taken while other suites were running):

| request                            | p50     | p95     | max    |
| ---------------------------------- | ------- | ------- | ------ |
| default (10 hits, 16 terms), quiet | 3.0 ms  | 9.3 ms  | 38 ms  |
| default, busy machine              | 5.5 ms  | 20.2 ms | 50 ms  |
| widest (50 hits, 32 terms), quiet  | 7.7 ms  | 20.6 ms | 39 ms  |
| widest, busy machine               | 14.3 ms | 49.8 ms | 134 ms |

Budget: p95 under 50 ms for what the interface asks (default, same source excluded); under 100 ms
for the widest request the API allows. The index memory cost is one `Map<highlightId, Set<noteId>>`.

```
pnpm exec vitest run packages/search/src/related.test.ts
SV_PERF=1 pnpm exec vitest run packages/search/src/related.perf.test.ts --environment node
```
