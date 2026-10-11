// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { MAX_QUERY_LENGTH, MAX_QUERY_TERMS, parseQuery } from '@search';
import type { SyllabusNode } from '@shared';
import {
  TOPIC_QUERY_MAX_LENGTH,
  TOPIC_QUERY_MAX_TERMS,
  subtreeMappings,
  topicLibraryTarget,
} from './topicLink';

describe('the copied search box limits', () => {
  it('are the same numbers as the search module has', () => {
    expect(TOPIC_QUERY_MAX_LENGTH).toBe(MAX_QUERY_LENGTH);
    expect(TOPIC_QUERY_MAX_TERMS).toBe(MAX_QUERY_TERMS);
  });
});

const node = (
  id: string,
  children: SyllabusNode[] = [],
  bankIds: string[] = [],
  tagIds: string[] = [],
): SyllabusNode => ({ id, title: id, children, bankIds, tagIds });

const names = (...pairs: [string, string][]) => new Map(pairs);

describe('subtreeMappings', () => {
  it('gives every topic the banks and tags of itself and all its subtopics, once', () => {
    const tree = [
      node(
        'a',
        [node('a1', [node('a11', [], ['b3'], ['t2'])], ['b2']), node('a2', [], ['b2'])],
        ['b1'],
      ),
      node('c', [], [], ['t1']),
    ];
    const m = subtreeMappings(tree);
    expect(m.get('a')).toEqual({ bankIds: ['b1', 'b2', 'b3'], tagIds: ['t2'] });
    expect(m.get('a1')).toEqual({ bankIds: ['b2', 'b3'], tagIds: ['t2'] });
    expect(m.get('a11')).toEqual({ bankIds: ['b3'], tagIds: ['t2'] });
    expect(m.get('a2')).toEqual({ bankIds: ['b2'], tagIds: [] });
    expect(m.get('c')).toEqual({ bankIds: [], tagIds: ['t1'] });
  });
});

describe('topicLibraryTarget', () => {
  const banks = names(['b1', 'Cardiology'], ['b2', 'Renal "AKI"'], ['b3', 'Pharm']);
  const tags = names(['t1', 'High Yield'], ['t2', 'osce']);

  it('scopes to the bank when the topic points at exactly one bank and no tag', () => {
    expect(topicLibraryTarget({ bankIds: ['b1'], tagIds: [] }, banks, tags)).toEqual({
      kind: 'bank',
      bankId: 'b1',
    });
  });

  it('builds a search that matches any of the banks and tags, quoting names', () => {
    const t = topicLibraryTarget({ bankIds: ['b1', 'b2'], tagIds: ['t1'] }, banks, tags);
    expect(t).toEqual({
      kind: 'search',
      q: '(bank:"Cardiology" OR bank:"Renal \\"AKI\\"" OR tag:"High Yield")',
      used: 3,
      total: 3,
    });
    expect(topicLibraryTarget({ bankIds: [], tagIds: ['t2'] }, banks, tags)).toMatchObject({
      kind: 'search',
      q: 'tag:"osce"',
    });
    // One bank and one tag: any, not both (a highlight in the bank OR carrying the tag).
    expect(topicLibraryTarget({ bankIds: ['b1'], tagIds: ['t1'] }, banks, tags)).toMatchObject({
      kind: 'search',
      q: '(bank:"Cardiology" OR tag:"High Yield")',
    });
  });

  it('is a query the search grammar reads without warnings', () => {
    const t = topicLibraryTarget({ bankIds: ['b1', 'b2'], tagIds: ['t1', 't2'] }, banks, tags);
    expect(t.kind).toBe('search');
    if (t.kind !== 'search') return;
    const parsed = parseQuery(t.q);
    expect(parsed.warnings).toEqual([]);
  });

  it('leaves out what is deleted and explains an empty topic', () => {
    expect(topicLibraryTarget({ bankIds: ['b1', 'gone'], tagIds: [] }, banks, tags)).toEqual({
      kind: 'bank',
      bankId: 'b1',
    });
    expect(topicLibraryTarget({ bankIds: [], tagIds: [] }, banks, tags)).toEqual({
      kind: 'none',
      reason: 'Map a bank or a tag to this topic first.',
    });
    expect(topicLibraryTarget({ bankIds: ['gone'], tagIds: ['gone2'] }, banks, tags)).toEqual({
      kind: 'none',
      reason: 'The banks and tags this topic points at are deleted or in the trash.',
    });
  });

  it('stays inside the search box limits and says how many were used', () => {
    const many = new Map(
      Array.from({ length: 60 }, (_, i) => [`t${i}`, `Tag number ${i}`] as const),
    );
    const t = topicLibraryTarget({ bankIds: [], tagIds: [...many.keys()] }, banks, many);
    expect(t.kind).toBe('search');
    if (t.kind !== 'search') return;
    expect(t.total).toBe(60);
    expect(t.used).toBeLessThanOrEqual(MAX_QUERY_TERMS);
    expect(t.used).toBeGreaterThan(5);
    expect(t.q.length).toBeLessThanOrEqual(MAX_QUERY_LENGTH);
    expect(parseQuery(t.q).warnings).toEqual([]);
  });
});
