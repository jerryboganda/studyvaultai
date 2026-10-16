# ADR-025: Smart matching (on-device static embeddings)

**Status:** accepted · **Date:** 2026-10-16 · Extends ADR-024 (chat retrieval).

## Context
Chat retrieval was lexical: a note that says "cardiac output falls" is not found by "what lowers the
pumping ability of the heart". The owner asked for meaning-based matching that runs on the device,
works offline and sends nothing.

## Decision
- **Model.** `minishlab/potion-base-8M` (MIT), a Model2Vec static embedding: one 256-number vector per
  word piece (BERT WordPiece, 29,528 pieces); a text is the mean of its pieces, normalised. No neural
  network runs, so there is no WASM, no worker and **no CSP change**; embedding a passage takes
  microseconds.
- **Shipped as data.** `scripts/prepare-embedding-model.mjs` downloads the two upstream files,
  checks them against pinned SHA-256 digests, quantises the vectors to int8 with one scale per row
  and writes `public/models/potion-base-8m-int8.bin` (7.7 MB) and `potion-base-8m-vocab.json`
  (0.3 MB). Both are committed; `scripts/check-build.mjs` requires exactly these files with their
  digests and a 9 MB budget (excluded from the general size total, like OCR assets). The extension
  never downloads a model.
- **Use.** `packages/search/src/embed.ts` (pure) and `packages/ui/src/ai/semantic.ts`. For each chat
  message, passages (highlights, notes, flashcards, knowledge points, inside the chosen scope; chats
  saved as notes excluded) are ranked by cosine similarity with the question; only those above 0.25
  and within 75 % of the best are offered, after the keyword matches. Vectors are cached in memory;
  nothing is persisted, so no schema change and nothing to back up.
- **Calibration.** On a hand-made set, the right note ranked first for every paraphrase (0.30 to 0.48)
  and unrelated questions scored at most 0.20 (`embed.test.ts` keeps this as a regression test).
- **Switch.** "Match by meaning" in the chat header; off = keyword matching only. If the files cannot
  be read the feature is simply absent.
- **Not used:** UBAG's `/v1/openai/embeddings` (hash-based, not semantic).

## Consequences
- +8 MB package size; quality is below a transformer encoder on long or subtle text, and the model
  is English-centred. The `StaticEmbedder` interface allows a larger model later.
- Licence notice for the model is shipped in `public/licenses/potion-base-8M-MIT.txt`.
