// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { AiSourceRef } from '@storage';
import { CHAT_MAX_CHARS, retrieveForChat } from '../chat';

const ref = (over: Partial<AiSourceRef> & { id: string }): AiSourceRef => ({
  kind: 'highlight',
  text: `Passage ${over.id} about metformin and type 2 diabetes.`,
  sourceId: 'src-1',
  sourceTitle: 'Pharmacology notes',
  host: 'example.org',
  deleted: false,
  ...over,
});

const index = (ids: { id: string; docType: 'highlight' | 'note' }[], seen: string[] = []) => ({
  search(query: string) {
    seen.push(query);
    return { total: ids.length + 40, hits: ids.map((doc) => ({ doc })) };
  },
});

const resolver = (rows: AiSourceRef[]) => async (ids: readonly string[]) =>
  new Map(rows.filter((r) => ids.includes(r.id)).map((r) => [r.id, r]));

describe('retrieveForChat', () => {
  it('searches locally with the question and the scope, and offers the vault text of what it finds', async () => {
    const seen: string[] = [];
    const rows = [ref({ id: 'h1' }), ref({ id: 'n1', kind: 'note', text: 'My note on dosing.' })];
    const r = await retrieveForChat(
      index(
        [
          { id: 'h1', docType: 'highlight' },
          { id: 'n1', docType: 'note' },
        ],
        seen,
      ),
      { question: 'Which drug is first-line for type 2 diabetes?', scope: 'bank:"Pharm"' },
      resolver(rows),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^\(.*\) bank:"Pharm"$/);
    expect(r.passages.map((p) => [p.id, p.kind])).toEqual([
      ['h1', 'highlight'],
      ['n1', 'note'],
    ]);
    // The text is the vault's, and the label says where it came from.
    expect(r.passages[0]).toMatchObject({
      text: rows[0]!.text,
      label: 'highlight from Pharmacology notes (example.org)',
    });
    expect(r.matched).toBe(42);
  });

  it('leaves out what the vault no longer has, and what was deleted since the index was built', async () => {
    const r = await retrieveForChat(
      index([
        { id: 'gone', docType: 'highlight' },
        { id: 'trash', docType: 'highlight' },
        { id: 'ok', docType: 'highlight' },
      ]),
      { question: 'metformin dosing' },
      resolver([ref({ id: 'trash', deleted: true }), ref({ id: 'ok' })]),
    );
    expect(r.passages.map((p) => p.id)).toEqual(['ok']);
  });

  it('does not search at all for a question with nothing to search for', async () => {
    const seen: string[] = [];
    const r = await retrieveForChat(index([{ id: 'h1', docType: 'highlight' }], seen), {
      question: 'what is it?',
    });
    expect(r).toEqual({ query: null, passages: [], matched: 0 });
    expect(seen).toEqual([]);
  });

  it('no match is an empty list, not an invented one', async () => {
    const r = await retrieveForChat(index([]), { question: 'zebrafish genomics' }, resolver([]));
    expect(r.passages).toEqual([]);
    expect(r.query).not.toBeNull();
  });

  it('stops before the offered text would not fit one request', async () => {
    const big = 'x'.repeat(Math.floor(CHAT_MAX_CHARS / 3) + 100);
    const rows = ['a', 'b', 'c', 'd', 'e'].map((id) => ref({ id, text: big }));
    const r = await retrieveForChat(
      index(rows.map((x) => ({ id: x.id, docType: 'highlight' as const }))),
      { question: 'metformin' },
      resolver(rows),
    );
    expect(r.passages.length).toBeGreaterThanOrEqual(1);
    expect(r.passages.length).toBeLessThan(5);
    expect(r.passages.reduce((n, p) => n + p.text.length, 0)).toBeLessThanOrEqual(CHAT_MAX_CHARS);
  });

  it('does not offer a chat saved as a note back to a chat, unless asked', async () => {
    const rows = [
      ref({ id: 'n1', kind: 'note', sourceTitle: 'AI chat: beta blockers', text: 'AI said so.' }),
      ref({ id: 'n2', kind: 'note', sourceTitle: 'My revision', text: 'My own note.' }),
    ];
    const idx = index([
      { id: 'n1', docType: 'note' },
      { id: 'n2', docType: 'note' },
    ]);
    const plain = await retrieveForChat(idx, { question: 'beta blockers' }, resolver(rows));
    expect(plain.passages.map((p) => p.id)).toEqual(['n2']);
    const all = await retrieveForChat(
      idx,
      { question: 'beta blockers', includeAiNotes: true },
      resolver(rows),
    );
    expect(all.passages.map((p) => p.id)).toEqual(['n1', 'n2']);
  });
});
