import { MAX_QUERY_LENGTH, MAX_QUERY_TERMS } from '@search';
import { flattenSyllabus, type SyllabusNode } from '@shared';

/**
 * Where a syllabus topic leads: the dashboard list of what the topic is made of. Pure helpers shared
 * by the syllabus editor (dashboard) and the coverage table (review page).
 */

export interface TopicMapping {
  bankIds: readonly string[];
  tagIds: readonly string[];
}

/** For every topic: the banks and tags of the topic and of all its subtopics, each id once. */
export function subtreeMappings(
  nodes: readonly SyllabusNode[],
): Map<string, { bankIds: string[]; tagIds: string[] }> {
  const flat = flattenSyllabus(nodes);
  const sets = new Map<string, { banks: Set<string>; tags: Set<string> }>();
  for (const { node } of flat) {
    sets.set(node.id, { banks: new Set(node.bankIds), tags: new Set(node.tagIds) });
  }
  // Pre-order lists a parent before its children, so walking backwards folds children upwards.
  for (let i = flat.length - 1; i >= 0; i -= 1) {
    const item = flat[i] as (typeof flat)[number];
    const parent = item.parentId === null ? undefined : sets.get(item.parentId);
    const own = sets.get(item.node.id);
    if (!parent || !own) continue;
    for (const id of own.banks) parent.banks.add(id);
    for (const id of own.tags) parent.tags.add(id);
  }
  return new Map(
    [...sets].map(([id, s]) => [id, { bankIds: [...s.banks], tagIds: [...s.tags] }] as const),
  );
}

export type TopicLibraryTarget =
  /** Exactly one bank and no tag: the list scoped to the bank. */
  | { kind: 'bank'; bankId: string }
  /** Anything else: a search that matches any of the banks and tags (a highlight counts once). */
  | { kind: 'search'; q: string; used: number; total: number }
  | { kind: 'none'; reason: string };

const quoted = (value: string): string => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * The list a topic's highlights are in. `banks` and `tags` map id -> name for the LIVE ones: a
 * mapping to something deleted or in the trash is left out (it holds nothing). The search box takes
 * at most MAX_QUERY_TERMS words and MAX_QUERY_LENGTH characters; when a topic points at more, the
 * first ones are used and `used`/`total` say so.
 */
export function topicLibraryTarget(
  mapping: TopicMapping,
  banks: ReadonlyMap<string, string>,
  tags: ReadonlyMap<string, string>,
): TopicLibraryTarget {
  if (mapping.bankIds.length === 0 && mapping.tagIds.length === 0) {
    return { kind: 'none', reason: 'Map a bank or a tag to this topic first.' };
  }
  const liveBanks = mapping.bankIds.filter((id) => banks.has(id));
  const liveTags = mapping.tagIds.filter((id) => tags.has(id));
  const total = liveBanks.length + liveTags.length;
  if (total === 0) {
    return {
      kind: 'none',
      reason: 'The banks and tags this topic points at are deleted or in the trash.',
    };
  }
  if (liveTags.length === 0 && liveBanks.length === 1) {
    return { kind: 'bank', bankId: liveBanks[0] as string };
  }
  const terms = [
    ...liveBanks.map((id) => `bank:${quoted(banks.get(id) as string)}`),
    ...liveTags.map((id) => `tag:${quoted(tags.get(id) as string)}`),
  ];
  const used: string[] = [];
  for (const term of terms) {
    if (used.length >= MAX_QUERY_TERMS) break;
    const next = [...used, term];
    const text = next.length === 1 ? (next[0] as string) : `(${next.join(' OR ')})`;
    if (text.length > MAX_QUERY_LENGTH) break;
    used.push(term);
  }
  const q = used.length === 1 ? (used[0] as string) : `(${used.join(' OR ')})`;
  return { kind: 'search', q, used: used.length, total };
}
