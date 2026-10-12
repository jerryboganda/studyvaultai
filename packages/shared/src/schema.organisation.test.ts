// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  FilingRule,
  MAX_SYLLABUS_DEPTH,
  MAX_SYLLABUS_NODES,
  Relation,
  Syllabus,
  flattenSyllabus,
  measureSyllabus,
  type SyllabusNode,
} from './schema';

const TS = '2026-10-11T08:00:00.000Z';
const envelope = { schemaVersion: 1, createdAt: TS, updatedAt: TS, deletedAt: null };
const node = (id: string, children: SyllabusNode[] = []): SyllabusNode => ({
  id,
  title: `Topic ${id}`,
  children,
  bankIds: [],
  tagIds: [],
});
const syllabus = (nodes: unknown) =>
  Syllabus.safeParse({ id: 'syllabus-0001', ...envelope, name: 'Exam', nodes });

/** `depth` nested single-child nodes, built without recursion. */
function chain(depth: number): SyllabusNode {
  let current = node(`n-${String(depth).padStart(7, '0')}`);
  for (let level = depth - 1; level >= 1; level--) {
    current = node(`n-${String(level).padStart(7, '0')}`, [current]);
  }
  return current;
}

describe('Syllabus', () => {
  it('accepts a tree up to the depth and size limits', () => {
    expect(syllabus([chain(MAX_SYLLABUS_DEPTH)]).success).toBe(true);
    const wide = Array.from({ length: MAX_SYLLABUS_NODES }, (_, i) =>
      node(`n-${String(i).padStart(7, '0')}`),
    );
    expect(syllabus(wide).success).toBe(true);
  });

  it('refuses a seventh level, 501 topics and repeated ids', () => {
    expect(syllabus([chain(MAX_SYLLABUS_DEPTH + 1)]).success).toBe(false);
    const wide = Array.from({ length: MAX_SYLLABUS_NODES + 1 }, (_, i) =>
      node(`n-${String(i).padStart(7, '0')}`),
    );
    expect(syllabus(wide).success).toBe(false);
    // 501 in total across levels
    const grouped = Array.from({ length: 5 }, (_, g) =>
      node(
        `g-${String(g).padStart(7, '0')}`,
        Array.from({ length: 100 }, (_, i) => node(`c-${g}-${String(i).padStart(6, '0')}`)),
      ),
    );
    const parsed = syllabus(grouped);
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain('at most 500 topics');
    const dupes = syllabus([node('same-0000001'), node('same-0000001')]);
    expect(dupes.success).toBe(false);
    expect(JSON.stringify(dupes.error?.issues)).toContain('unique');
  });

  it('answers a hostile, enormously deep tree with a validation failure, not a stack overflow', () => {
    let root: Record<string, unknown> = { ...node('deep-0000000') };
    const top = root;
    for (let i = 1; i < 50_000; i++) {
      const next: Record<string, unknown> = { ...node(`deep-${String(i).padStart(7, '0')}`) };
      root.children = [next];
      root = next;
    }
    expect(() => syllabus([top])).not.toThrow();
    expect(syllabus([top]).success).toBe(false);
  });

  it('weights are positive and bounded; titles are not empty', () => {
    const base = node('topic-00001');
    expect(syllabus([{ ...base, weight: 0.5 }]).success).toBe(true);
    for (const weight of [0, -2, 1001, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(syllabus([{ ...base, weight }]).success, String(weight)).toBe(false);
    }
    expect(syllabus([{ ...base, title: '  ' }]).success).toBe(false);
  });

  it('flattenSyllabus walks pre-order with depth and parent, and measureSyllabus counts', () => {
    const tree = [
      node('a-0000001', [node('a1-000001', [node('a11-00001')]), node('a2-000001')]),
      node('b-0000001'),
    ];
    expect(flattenSyllabus(tree).map((x) => [x.node.id, x.depth, x.parentId])).toEqual([
      ['a-0000001', 1, null],
      ['a1-000001', 2, 'a-0000001'],
      ['a11-00001', 3, 'a1-000001'],
      ['a2-000001', 2, 'a-0000001'],
      ['b-0000001', 1, null],
    ]);
    expect(measureSyllabus(tree)).toEqual({ count: 5, depth: 3, duplicateIds: [] });
    expect(measureSyllabus([node('x-0000001'), node('x-0000001')]).duplicateIds).toEqual([
      'x-0000001',
    ]);
    expect(measureSyllabus([])).toEqual({ count: 0, depth: 0, duplicateIds: [] });
  });
});

describe('Relation', () => {
  const link = {
    id: 'relation-0001',
    ...envelope,
    fromKind: 'highlight',
    fromId: 'highlight-0001',
    toKind: 'knowledgePoint',
    toId: 'kp-0000000001',
    type: 'supports',
  };

  it('accepts the three kinds and six types, with an optional note up to 500 characters', () => {
    expect(Relation.safeParse(link).success).toBe(true);
    expect(Relation.safeParse({ ...link, note: 'n'.repeat(500) }).success).toBe(true);
    expect(Relation.safeParse({ ...link, note: 'n'.repeat(501) }).success).toBe(false);
    for (const type of ['related', 'supports', 'contradicts', 'cause', 'example', 'prerequisite']) {
      expect(Relation.safeParse({ ...link, type }).success, type).toBe(true);
    }
    expect(Relation.safeParse({ ...link, type: 'likes' }).success).toBe(false);
    expect(Relation.safeParse({ ...link, toKind: 'bank' }).success).toBe(false);
  });

  it('refuses a link from an item to itself, but not to another kind with the same id', () => {
    expect(Relation.safeParse({ ...link, toKind: 'highlight', toId: link.fromId }).success).toBe(
      false,
    );
    expect(Relation.safeParse({ ...link, toKind: 'note', toId: link.fromId }).success).toBe(true);
  });
});

describe('FilingRule', () => {
  const rule = {
    id: 'rule-00000001',
    ...envelope,
    name: 'Cardio',
    enabled: true,
    order: 0,
    match: { hosts: ['example.com'] },
    action: { bankId: 'bank-00000001' },
  };

  it('defaults requireConfirm to true, so an absent flag asks', () => {
    expect(FilingRule.parse(rule).requireConfirm).toBe(true);
    expect(FilingRule.parse({ ...rule, requireConfirm: false }).requireConfirm).toBe(false);
  });

  it('holds hosts as lower-case names, caps every list and the name', () => {
    expect(FilingRule.safeParse({ ...rule, match: { hosts: ['Example.com'] } }).success).toBe(
      false,
    );
    expect(
      FilingRule.safeParse({ ...rule, match: { hosts: ['https://example.com'] } }).success,
    ).toBe(false);
    const twentyOne = Array.from({ length: 21 }, (_, i) => `h${i}.example.com`);
    expect(FilingRule.safeParse({ ...rule, match: { hosts: twentyOne } }).success).toBe(false);
    expect(
      FilingRule.safeParse({ ...rule, match: { quoteContains: ['x'.repeat(201)] } }).success,
    ).toBe(false);
    expect(FilingRule.safeParse({ ...rule, name: 'n'.repeat(81) }).success).toBe(false);
    expect(FilingRule.safeParse({ ...rule, order: -1 }).success).toBe(false);
    expect(FilingRule.safeParse({ ...rule, order: 1.5 }).success).toBe(false);
  });

  it('keeps an empty match storable (it simply never matches)', () => {
    expect(FilingRule.safeParse({ ...rule, match: {} }).success).toBe(true);
  });
});
