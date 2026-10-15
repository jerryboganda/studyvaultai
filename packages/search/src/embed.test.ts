// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  basicWords,
  cosine,
  createStaticEmbedder,
  parseEmbeddingModel,
  rankBySimilarity,
  wordPieceIds,
} from './embed';

const modelUrl = new URL('../../../public/models/potion-base-8m-int8.bin', import.meta.url);
const vocabUrl = new URL('../../../public/models/potion-base-8m-vocab.json', import.meta.url);

/** A model of 4 tokens in 2 dimensions, to test the mechanics without the shipped weights. */
function tinyModel() {
  const vocab = ['[PAD]', 'heart', 'failure', '##s', 'drug'];
  const scales = new Float32Array([1, 1, 1, 1, 1]);
  const data = new Int8Array([0, 0, 10, 0, 8, 6, 0, 3, 0, 10]);
  return { vocab, model: { rows: 5, dims: 2, scales, data } };
}

describe('word pieces', () => {
  it('lower-cases, strips accents and splits on punctuation', () => {
    expect(basicWords('Café-au-lait, HF!')).toEqual([
      'cafe',
      '-',
      'au',
      '-',
      'lait',
      ',',
      'hf',
      '!',
    ]);
  });

  it('matches the longest piece and continues with ## pieces', () => {
    const vocab = new Map([
      ['heart', 1],
      ['failure', 2],
      ['##s', 3],
    ]);
    expect(wordPieceIds('Heart failures', vocab)).toEqual([1, 2, 3]);
    expect(wordPieceIds('zzz', vocab)).toEqual([]);
  });
});

describe('static embedder', () => {
  it('embeds to unit vectors and ranks by meaning', () => {
    const { vocab, model } = tinyModel();
    const e = createStaticEmbedder(model, vocab);
    const heart = e.embed('heart failure')!;
    expect(Math.hypot(...heart)).toBeCloseTo(1, 5);
    expect(e.embed('qqq')).toBeNull();
    const hits = rankBySimilarity(e, 'heart', [
      { id: 'a', text: 'heart failure' },
      { id: 'b', text: 'drug' },
    ]);
    expect(hits[0]?.id).toBe('a');
    expect(cosine(heart, heart)).toBeCloseTo(1, 5);
  });

  it('refuses a model of the wrong size', () => {
    const bad = new Uint8Array(12);
    new DataView(bad.buffer).setUint32(0, 2, true);
    bad.set(new TextEncoder().encode('{}'), 4);
    expect(() => parseEmbeddingModel(bad.buffer)).toThrow();
  });
});

describe('the shipped potion-base-8M model', () => {
  const buf = readFileSync(modelUrl);
  const model = parseEmbeddingModel(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
  );
  const vocab = JSON.parse(readFileSync(vocabUrl, 'utf8')) as string[];
  const e = createStaticEmbedder(model, vocab);

  it('has the pinned shape', () => {
    expect(model.rows).toBe(29528);
    expect(model.dims).toBe(256);
    expect(vocab).toHaveLength(29528);
  });

  const notes = [
    { id: 'hf', text: 'Heart failure reduces cardiac output and causes fluid retention.' },
    { id: 'dm', text: 'Metformin is the first-line drug for type 2 diabetes mellitus.' },
    { id: 'ace', text: 'ACE inhibitors block the conversion of angiotensin I to angiotensin II.' },
    { id: 'wf', text: 'Warfarin inhibits vitamin K dependent clotting factors.' },
    { id: 'fx', text: 'A scaphoid fracture is often missed on the first radiograph.' },
  ];

  it('finds paraphrases that share no words with the note', () => {
    const ask = (q: string) => rankBySimilarity(e, q, notes, { topK: 3 })[0]?.id;
    expect(ask('which medicine do we start with for high blood sugar')).toBe('dm');
    expect(ask('what lowers the pumping ability of the heart')).toBe('hf');
    expect(ask('anticoagulant that affects clotting')).toBe('wf');
    expect(ask('broken wrist bone seen on an x-ray')).toBe('fx');
  });

  it('returns nothing for a question about something else', () => {
    expect(rankBySimilarity(e, 'how to bake sourdough bread', notes)).toEqual([]);
  });
});
