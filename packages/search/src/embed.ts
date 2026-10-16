// On-device "smart matching": a static word-piece embedding (Model2Vec / potion-base-8M, MIT). A text
// becomes the mean of its word pieces' 256-number vectors, so similar meanings land close together
// without a network call, a WASM runtime or a transformer. Pure and synchronous; the model bytes are
// handed in by the caller (the extension ships them under models/).

export interface EmbeddingModel {
  rows: number;
  dims: number;
  /** One dequantisation scale per row. */
  scales: Float32Array;
  /** rows x dims int8 values. */
  data: Int8Array;
}

/** Parses `potion-base-8m-int8.bin` (see scripts/prepare-embedding-model.mjs). */
export function parseEmbeddingModel(buffer: ArrayBuffer): EmbeddingModel {
  const view = new DataView(buffer);
  if (buffer.byteLength < 8) throw new Error('embedding model is truncated');
  const metaLen = view.getUint32(0, true);
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, metaLen))) as {
    format?: unknown;
    rows?: unknown;
    dims?: unknown;
  };
  if (meta.format !== 'sv-static-embedding-int8/1') throw new Error('unknown embedding format');
  const rows = Number(meta.rows);
  const dims = Number(meta.dims);
  if (!Number.isInteger(rows) || !Number.isInteger(dims) || rows < 1 || dims < 1) {
    throw new Error('embedding model has no shape');
  }
  const scalesAt = 4 + metaLen;
  const dataAt = scalesAt + rows * 4;
  if (buffer.byteLength !== dataAt + rows * dims)
    throw new Error('embedding model has a wrong size');
  // Copies: the typed-array views need aligned offsets and the source may be a slice.
  const scales = new Float32Array(buffer.slice(scalesAt, dataAt));
  const data = new Int8Array(buffer.slice(dataAt));
  return { rows, dims, scales, data };
}

const isPunct = (c: string): boolean => /[\p{P}\p{S}]/u.test(c);
const isCjk = (cp: number): boolean =>
  (cp >= 0x4e00 && cp <= 0x9fff) ||
  (cp >= 0x3400 && cp <= 0x4dbf) ||
  (cp >= 0x20000 && cp <= 0x2a6df) ||
  (cp >= 0xf900 && cp <= 0xfaff);

/** BERT-style words: lower-cased, accents stripped, split on whitespace, punctuation and CJK. */
export function basicWords(text: string): string[] {
  const clean = text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const words: string[] = [];
  let current = '';
  const flush = () => {
    if (current) words.push(current);
    current = '';
  };
  for (const ch of clean) {
    if (/\s/u.test(ch) || ch === '\u0000') flush();
    else if (isPunct(ch) || isCjk(ch.codePointAt(0)!)) {
      flush();
      words.push(ch);
    } else current += ch;
  }
  flush();
  return words;
}

/** Greedy longest-match word pieces, as in BERT's WordPiece (continuations start with `##`). */
export function wordPieceIds(
  text: string,
  vocab: ReadonlyMap<string, number>,
  maxWordChars = 100,
): number[] {
  const ids: number[] = [];
  for (const word of basicWords(text)) {
    if (word.length > maxWordChars) continue;
    const pieces: number[] = [];
    let start = 0;
    let ok = true;
    while (start < word.length) {
      let end = word.length;
      let found: number | undefined;
      while (start < end) {
        const piece = (start > 0 ? '##' : '') + word.slice(start, end);
        const id = vocab.get(piece);
        if (id !== undefined) {
          found = id;
          break;
        }
        end -= 1;
      }
      if (found === undefined) {
        ok = false;
        break;
      }
      pieces.push(found);
      start = end;
    }
    // An unknown word contributes nothing (the model has no vector worth using for [UNK]).
    if (ok) ids.push(...pieces);
  }
  return ids;
}

export interface StaticEmbedder {
  readonly dims: number;
  /** A unit vector, or null when the text has no known word piece. */
  embed(text: string): Float32Array | null;
}

export function createStaticEmbedder(
  model: EmbeddingModel,
  vocab: readonly string[],
): StaticEmbedder {
  const index = new Map<string, number>();
  vocab.forEach((token, id) => {
    if (token) index.set(token, id);
  });
  const { dims, scales, data, rows } = model;
  return {
    dims,
    embed(text) {
      const ids = wordPieceIds(text, index);
      if (ids.length === 0) return null;
      const sum = new Float32Array(dims);
      let n = 0;
      for (const id of ids) {
        if (id < 0 || id >= rows) continue;
        const scale = scales[id]!;
        const at = id * dims;
        for (let d = 0; d < dims; d++) sum[d]! += data[at + d]! * scale;
        n += 1;
      }
      if (n === 0) return null;
      let norm = 0;
      for (let d = 0; d < dims; d++) norm += sum[d]! * sum[d]!;
      norm = Math.sqrt(norm);
      if (norm === 0) return null;
      for (let d = 0; d < dims; d++) sum[d]! /= norm;
      return sum;
    },
  };
}

/** Cosine similarity of two unit vectors. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
}

export interface SemanticHit {
  id: string;
  score: number;
}

/**
 * The documents closest in meaning to a query, best first. Documents under `minScore`, or under
 * `relative` times the best score, are dropped, so an unrelated question returns nothing (the chat
 * then answers from general knowledge instead of dragging in a weak match).
 */
export function rankBySimilarity(
  embedder: StaticEmbedder,
  query: string,
  docs: readonly { id: string; text: string }[],
  options: {
    topK?: number;
    minScore?: number;
    relative?: number;
    cache?: Map<string, Float32Array | null>;
  } = {},
): SemanticHit[] {
  const { topK = 10, minScore = 0.25, relative = 0.75, cache = new Map() } = options;
  const q = embedder.embed(query);
  if (!q) return [];
  const scored: SemanticHit[] = [];
  for (const d of docs) {
    // Keyed by id and length: an edited passage is embedded again.
    const key = `${d.id}\u0001${d.text.length}`;
    let v = cache.get(key);
    if (v === undefined) {
      v = embedder.embed(d.text);
      cache.set(key, v);
    }
    if (!v) continue;
    const score = cosine(q, v);
    if (score >= minScore) scored.push({ id: d.id, score });
  }
  scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  const best = scored[0]?.score ?? 0;
  return scored.filter((s) => s.score >= best * relative).slice(0, topK);
}
