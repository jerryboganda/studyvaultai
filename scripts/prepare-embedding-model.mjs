#!/usr/bin/env node
// One-off, reproducible preparation of the on-device "smart matching" model (docs/adr/025).
//
//   node scripts/prepare-embedding-model.mjs
//
// Downloads minishlab/potion-base-8M (MIT licence, a Model2Vec static embedding: one 256-number
// vector per word piece, a text is the mean of its pieces), checks both files against pinned SHA-256
// digests, and writes two small files into public/models/:
//   potion-base-8m-int8.bin   the vectors quantised to int8 with one scale per row (~7.6 MB)
//   potion-base-8m-vocab.json the word-piece vocabulary by id (~0.3 MB)
// The result is committed, so builds and the extension never download anything.
/* global fetch, Buffer */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = 'https://huggingface.co/minishlab/potion-base-8M/resolve/main';
const PINNED = {
  'model.safetensors': 'f65d0f325faadc1e121c319e2faa41170d3fa07d8c89abd48ca5358d9a223de2',
  'tokenizer.json': 'e67e803f624fb4d67dea1c730d06e1067e1b14d830e2c2202569e3ef0f70bb50',
};

async function get(name) {
  const res = await fetch(`${BASE}/${name}`);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const digest = createHash('sha256').update(buf).digest('hex');
  if (digest !== PINNED[name]) throw new Error(`${name}: digest ${digest} is not the pinned one`);
  return buf;
}

const weights = await get('model.safetensors');
const tokenizer = JSON.parse((await get('tokenizer.json')).toString('utf8'));

// safetensors: u64 header length, JSON header, raw tensor bytes.
const headerLen = Number(weights.readBigUInt64LE(0));
const header = JSON.parse(weights.subarray(8, 8 + headerLen).toString('utf8'));
const t = header.embeddings;
if (!t || t.dtype !== 'F32' || t.shape.length !== 2) throw new Error('unexpected tensor layout');
const [rows, dims] = t.shape;
const base = 8 + headerLen + t.data_offsets[0];

const scales = new Float32Array(rows);
const data = new Int8Array(rows * dims);
for (let r = 0; r < rows; r++) {
  let max = 0;
  const row = new Float32Array(dims);
  for (let d = 0; d < dims; d++) {
    row[d] = weights.readFloatLE(base + (r * dims + d) * 4);
    max = Math.max(max, Math.abs(row[d]));
  }
  const scale = max === 0 ? 1 : max / 127;
  scales[r] = scale;
  for (let d = 0; d < dims; d++) data[r * dims + d] = Math.round(row[d] / scale);
}

const meta = Buffer.from(
  JSON.stringify({
    format: 'sv-static-embedding-int8/1',
    source: 'minishlab/potion-base-8M',
    licence: 'MIT',
    rows,
    dims,
    sha256: PINNED,
  }),
  'utf8',
);
const head = Buffer.alloc(4);
head.writeUInt32LE(meta.length, 0);
const out = Buffer.concat([
  head,
  meta,
  Buffer.from(scales.buffer, scales.byteOffset, scales.byteLength),
  Buffer.from(data.buffer, data.byteOffset, data.byteLength),
]);

// Vocabulary by id (the model's token ids are the tensor's row numbers).
const vocab = new Array(rows).fill('');
for (const [token, id] of Object.entries(tokenizer.model.vocab)) vocab[id] = token;

const dir = fileURLToPath(new URL('../public/models/', import.meta.url));
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}potion-base-8m-int8.bin`, out);
writeFileSync(`${dir}potion-base-8m-vocab.json`, JSON.stringify(vocab));
console.log(`wrote ${out.length} bytes of vectors (${rows} x ${dims}) and ${vocab.length} tokens`);
