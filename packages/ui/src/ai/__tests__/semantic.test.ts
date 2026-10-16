// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createStaticEmbedder } from '@search';
import type { AiSourceRef } from '@storage';
import { semanticPassages, type SemanticDoc } from '../semantic';

// A toy model: three directions. "sugar" and "diabetes" share one, "heart" and "cardiac" another.
const vocab = ['[PAD]', 'sugar', 'diabetes', 'heart', 'cardiac', 'bread'];
const dir: Record<number, number[]> = {
  1: [10, 0, 0],
  2: [9, 1, 0],
  3: [0, 10, 0],
  4: [0, 9, 1],
  5: [0, 0, 10],
};
const model = {
  rows: vocab.length,
  dims: 3,
  scales: new Float32Array(vocab.length).fill(1),
  data: new Int8Array(vocab.length * 3).map((_, i) => dir[Math.floor(i / 3)]?.[i % 3] ?? 0),
};
const embedder = createStaticEmbedder(model, vocab);

const doc = (over: Partial<SemanticDoc> & { id: string }): SemanticDoc => ({
  docType: 'highlight',
  quote: '',
  comment: '',
  banks: ['Pharm'],
  folderPath: [],
  tags: [],
  deletedAt: null,
  ...over,
});
const ref = (id: string, text: string, kind: AiSourceRef['kind'] = 'highlight'): AiSourceRef => ({
  id,
  kind,
  text,
  sourceId: null,
  sourceTitle: 'Pharmacology',
  host: null,
  deleted: false,
});

const docs = [
  doc({ id: 'h-diabetes', quote: 'diabetes' }),
  doc({ id: 'h-heart', quote: 'cardiac', banks: ['Cardio'] }),
  doc({ id: 'n-ai', docType: 'note', comment: 'AI chat: sugar\ndiabetes' }),
];
const base = {
  question: 'sugar',
  bankName: null,
  folderName: null,
  tagName: null,
  inScope: null,
} as const;
const deps = {
  embedder: async () => embedder,
  documents: async () => docs,
  studyItems: async () => [],
  resolve: async (ids: readonly string[]) =>
    new Map(ids.map((id) => [id, ref(id, docs.find((d) => d.id === id)?.quote ?? '')])),
};

describe('semanticPassages', () => {
  it('offers what means the same as the question, with vault text', async () => {
    const out = await semanticPassages(base, deps);
    expect(out.map((p) => p.id)).toEqual(['h-diabetes']);
    expect(out[0]).toMatchObject({ kind: 'highlight', text: 'diabetes' });
  });

  it('never offers a conversation saved as a note, and respects the bank', async () => {
    expect((await semanticPassages(base, deps)).map((p) => p.id)).not.toContain('n-ai');
    const cardio = await semanticPassages({ ...base, question: 'heart', bankName: 'Cardio' }, deps);
    expect(cardio.map((p) => p.id)).toEqual(['h-heart']);
    const wrong = await semanticPassages({ ...base, question: 'heart', bankName: 'Pharm' }, deps);
    expect(wrong).toEqual([]);
  });

  it('skips ids already offered and says nothing when the model is missing or nothing is near', async () => {
    const none = await semanticPassages({ ...base, exclude: new Set(['h-diabetes']) }, deps);
    expect(none).toEqual([]);
    expect(await semanticPassages(base, { ...deps, embedder: async () => null })).toEqual([]);
    expect(await semanticPassages({ ...base, question: 'bread' }, deps)).toEqual([]);
  });

  it('offers flashcards and knowledge points by meaning, inside the scope', async () => {
    const study = [
      { id: 'c1', kind: 'card' as const, text: 'diabetes', highlightId: 'h-in' },
      { id: 'c2', kind: 'card' as const, text: 'sugar', highlightId: 'h-out' },
    ];
    const out = await semanticPassages(
      { ...base, inScope: new Set(['h-in']) },
      { ...deps, documents: async () => [], studyItems: async () => study },
    );
    expect(out.map((p) => p.id)).toEqual(['c1']);
    expect(out[0]?.label).toBe('flashcard');
  });
});
