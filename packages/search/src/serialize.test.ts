import { describe, expect, it } from 'vitest';
import { createSearchIndex, deserializeSearchIndex, integrityChecksum } from './searchIndex';
import { doc, generateCorpus } from './testUtils';

function sample(): string {
  const index = createSearchIndex();
  index.applyChanges([
    doc({ id: 'a', quote: 'aortic stenosis is common', tags: ['valves'], banks: ['Cardiology'] }),
    doc({ id: 'b', quote: 'mitral regurgitation', comment: 'my note' }),
    doc({ id: 'n', docType: 'note', highlightId: 'a', quote: '', comment: 'note on a' }),
    doc({ id: 'd', quote: 'deleted valve', deletedAt: '2026-01-02T00:00:00Z' }),
  ]);
  return index.serialize();
}

// Tampering helper: the point is to reach into arbitrary JSON shapes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

/** Parse, edit, re-serialise; `resign` recomputes the checksum so structural checks are what reject it. */
function edit(text: string, fn: (o: Json) => void, resign = true): string {
  const o = JSON.parse(text) as Json;
  fn(o);
  if (resign) o.checksum = integrityChecksum(o.docs, o.index);
  return JSON.stringify(o);
}

describe('serialise / deserialise', () => {
  it('is versioned and round-trips documents and answers', () => {
    const text = sample();
    const env = JSON.parse(text) as { format: string; version: number; docs: unknown[] };
    expect(env.format).toBe('studyvault-search-index');
    expect(env.version).toBe(1);
    expect(env.docs).toHaveLength(4);

    const r = deserializeSearchIndex(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.index.size).toBe(4);
    expect(r.index.search('aortic').hits.map((h) => h.id)).toEqual(['a']);
    expect(r.index.search('valve', { includeDeleted: true }).hits.map((h) => h.id)).toContain('d');
    expect(r.index.search('valve').hits.map((h) => h.id)).not.toContain('d');
    expect(new Set(r.index.search('has:note').hits.map((h) => h.id))).toEqual(
      new Set(['a', 'b', 'n']),
    );
    // the restored index serialises to something that restores again (term order may differ)
    const again = deserializeSearchIndex(r.index.serialize());
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.index.stats()).toEqual(r.index.stats());
  });

  it('accepts an already-parsed object (structured-clone storage)', () => {
    const r = deserializeSearchIndex(JSON.parse(sample()));
    expect(r.ok).toBe(true);
  });

  it('round-trips a large index', () => {
    const index = createSearchIndex();
    index.applyChanges(generateCorpus(800, 3));
    const r = deserializeSearchIndex(index.serialize());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.index.stats()).toEqual(index.stats());
  });
});

describe('corruption is a rebuild signal, never a crash', () => {
  const text = sample();

  const cases: Array<[string, unknown, string?]> = [
    ['empty string', ''],
    ['not json', 'not json {'],
    ['truncated', text.slice(0, Math.floor(text.length / 2))],
    ['null', null],
    ['undefined', undefined],
    ['number', 42],
    ['array', []],
    ['empty object', {}],
    ['wrong format', edit(text, (o) => (o.format = 'something-else'))],
    [
      'edited document text without resigning',
      edit(text, (o) => (o.docs[0].quote = 'tampered'), false),
    ],
    [
      'edited posting without resigning',
      edit(text, (o) => (o.index.index[0][0] = 'tampered'), false),
    ],
    ['checksum removed', edit(text, (o) => delete o.checksum, false)],
    ['future version', edit(text, (o) => (o.version = 99)), 'version'],
    ['analyzer changed', edit(text, (o) => (o.analyzer = 'sv-analyzer-0:xx')), 'analyzer'],
    ['missing docs', edit(text, (o) => (o.docs = o.docs.slice(1)))],
    ['extra doc', edit(text, (o) => o.docs.push({ ...o.docs[0], id: 'ghost' }))],
    ['duplicate doc', edit(text, (o) => o.docs.push(o.docs[0]))],
    ['invalid doc', edit(text, (o) => (o.docs[0].tags = 'not-a-list'))],
    ['doc with NaN-like priority', edit(text, (o) => (o.docs[0].priority = 'x'))],
    ['index is not an object', edit(text, (o) => (o.index = 'oops'))],
    ['index missing', edit(text, (o) => delete o.index)],
    ['document count mismatch', edit(text, (o) => (o.index.documentCount = 99))],
    ['dirty index', edit(text, (o) => (o.index.dirtCount = 3))],
    ['field layout changed', edit(text, (o) => (o.index.fieldIds = { quote: 0, other: 1 }))],
    [
      'posting for unknown document',
      edit(text, (o) => {
        const [, data] = o.index.index[0];
        const field = Object.keys(data)[0]!;
        data[field]['9999'] = 1;
      }),
    ],
    ['posting for unknown field', edit(text, (o) => (o.index.index[0][1]['77'] = { '0': 1 }))],
    [
      'negative frequency',
      edit(text, (o) => {
        const [, data] = o.index.index[0];
        const field = Object.keys(data)[0]!;
        const sid = Object.keys(data[field])[0]!;
        data[field][sid] = -1;
      }),
    ],
    [
      'string frequency',
      edit(text, (o) => {
        const [, data] = o.index.index[0];
        const field = Object.keys(data)[0]!;
        const sid = Object.keys(data[field])[0]!;
        data[field][sid] = 'many';
      }),
    ],
    ['malformed term entry', edit(text, (o) => (o.index.index[0] = 'term'))],
    ['field lengths dropped', edit(text, (o) => (o.index.fieldLength = {}))],
    [
      'document id key not numeric',
      edit(text, (o) => {
        const first = Object.keys(o.index.documentIds)[0]!;
        o.index.documentIds.zzz = o.index.documentIds[first];
        delete o.index.documentIds[first];
      }),
    ],
    [
      'document ids point elsewhere',
      edit(text, (o) => {
        const first = Object.keys(o.index.documentIds)[0]!;
        o.index.documentIds[first] = 'someone-else';
      }),
    ],
  ];

  for (const [name, input, reason] of cases) {
    it(name, () => {
      let result: ReturnType<typeof deserializeSearchIndex> | undefined;
      expect(() => {
        result = deserializeSearchIndex(input);
      }).not.toThrow();
      expect(result?.ok).toBe(false);
      if (result && !result.ok) {
        expect(result.detail.length).toBeGreaterThan(0);
        expect(['corrupt', 'version', 'analyzer']).toContain(result.reason);
        if (reason) expect(result.reason).toBe(reason);
      }
    });
  }

  it('a different stop-word list is a different analyzer', () => {
    const r = deserializeSearchIndex(text, { stopWords: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('analyzer');
    const ok = deserializeSearchIndex(
      (() => {
        const i = createSearchIndex({ stopWords: false });
        i.upsert(doc({ id: 'x', quote: 'the cell' }));
        return i.serialize();
      })(),
      { stopWords: false },
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.index.search('the').hits).toHaveLength(1);
  });

  it('fuzz: random single-character damage never throws', () => {
    const base = sample();
    let seed = 12345;
    const next = (): number => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296;
    let rejected = 0;
    for (let i = 0; i < 300; i++) {
      const pos = Math.floor(next() * base.length);
      const ch = String.fromCharCode(33 + Math.floor(next() * 90));
      if (base[pos] === ch) continue;
      const damaged = base.slice(0, pos) + ch + base.slice(pos + 1);
      let ok = true;
      expect(() => {
        const r = deserializeSearchIndex(damaged);
        ok = r.ok;
        if (r.ok) r.index.search('aortic valve bank:x "a b" -c');
      }).not.toThrow();
      if (!ok) rejected++;
      // the integrity tag makes every one-character change detectable
      expect(ok).toBe(false);
    }
    expect(rejected).toBeGreaterThan(250);
  });
});
