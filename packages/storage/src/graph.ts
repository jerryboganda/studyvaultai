import { Highlight, Note, RELATION_ENTITY_KINDS, Source, type Relation } from '@shared';
import type { RelationEntityKind } from '@shared';
import { KnowledgePoint } from '@study';
import { isDeleted, parseRow, requireId, unique } from './core';
import { withDb, type StudyVaultDb } from './db';
import { listAllRelations, listRelationsFor, type RelationRef } from './relations';
import { listKnowledgePoints } from './study';

/**
 * What the links screens show (ADR-018): the other end of a link as text a person can recognise,
 * and the whole set of links for the graph. Read only; nothing here writes.
 */

export interface LinkEnd {
  kind: RelationEntityKind;
  id: string;
  /** The quote, the note (title and body) or the one-liner, on one line and at most 300 characters. */
  text: string;
  sourceTitle: string;
  host: string;
  /** The highlight that shows this item: itself, or the one a note or knowledge point belongs to. */
  highlightId: string | null;
}

export interface LinkEntry {
  relation: Relation;
  /** `out`: the item the list is for is the start of the link. */
  direction: 'out' | 'in';
  other: LinkEnd;
}

const MAX_TEXT = 300;
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
const keyOf = (r: RelationRef) => `${r.kind}:${r.id}`;

/**
 * The reachable ends among `refs`, by `kind:id`. An end is left out when it does not exist, is in the
 * trash, or is a note or knowledge point of a highlight in the trash: there is nothing to open.
 */
export async function describeEnds(refs: readonly RelationRef[]): Promise<Map<string, LinkEnd>> {
  const ids: Record<RelationEntityKind, string[]> = { highlight: [], note: [], knowledgePoint: [] };
  for (const ref of refs) {
    if (!RELATION_ENTITY_KINDS.includes(ref.kind)) continue;
    ids[ref.kind].push(requireId(ref.id));
  }
  return withDb((db) =>
    db.transaction('r', [db.highlights, db.notes, db.knowledgePoints, db.sources], () =>
      describeIn(db, ids),
    ),
  );
}

async function describeIn(
  db: StudyVaultDb,
  ids: Record<RelationEntityKind, string[]>,
): Promise<Map<string, LinkEnd>> {
  const highlights = new Map<string, Highlight>();
  // Never await something that makes no request: in a transaction that lets it commit early.
  const load = async (list: readonly string[]) => {
    const wanted = unique(list).filter((id) => !highlights.has(id));
    if (wanted.length === 0) return;
    for (const row of await db.highlights.bulkGet(wanted)) {
      const parsed = row ? parseRow(Highlight, row, 'highlight') : null;
      if (parsed) highlights.set(parsed.id, parsed);
    }
  };
  const live = <T extends { deletedAt: string | null }>(row: T | null): row is T =>
    row !== null && !isDeleted(row);

  if (ids.highlight.length > 0) await load(ids.highlight);
  const notes = (await db.notes.bulkGet(unique(ids.note)))
    .map((row) => (row ? parseRow(Note, row, 'note') : null))
    .filter(live);
  const points = (await db.knowledgePoints.bulkGet(unique(ids.knowledgePoint)))
    .map((row) => (row ? parseRow(KnowledgePoint, row, 'knowledge point') : null))
    .filter(live);
  const hosts = [
    ...notes.flatMap((n) => (n.highlightId === null ? [] : [n.highlightId])),
    ...points.map((p) => p.highlightId),
  ];
  if (hosts.some((id) => !highlights.has(id))) await load(hosts);

  const sourceIds = unique([
    ...[...highlights.values()].map((h) => h.sourceId),
    ...notes.flatMap((n) => (n.sourceId === null ? [] : [n.sourceId])),
  ]);
  const sources = new Map<string, Source>();
  for (const row of await db.sources.bulkGet(sourceIds)) {
    const parsed = row ? parseRow(Source, row, 'source') : null;
    if (parsed) sources.set(parsed.id, parsed);
  }
  const place = (sourceId: string | null) => {
    const source = sourceId === null ? undefined : sources.get(sourceId);
    return { sourceTitle: source?.title ?? '', host: source?.host ?? '' };
  };
  const liveHighlight = (id: string) => {
    const h = highlights.get(id);
    return h && !isDeleted(h) ? h : null;
  };

  const out = new Map<string, LinkEnd>();
  for (const id of unique(ids.highlight)) {
    const h = liveHighlight(id);
    if (!h) continue;
    out.set(`highlight:${id}`, {
      kind: 'highlight',
      id,
      text: oneLine(h.exactQuote),
      ...place(h.sourceId),
      highlightId: id,
    });
  }
  for (const n of notes) {
    const host = n.highlightId === null ? null : liveHighlight(n.highlightId);
    if (n.highlightId !== null && !host) continue;
    const body = n.title ? `${n.title}: ${n.body}` : n.body;
    out.set(`note:${n.id}`, {
      kind: 'note',
      id: n.id,
      text: oneLine(body) || 'Empty note',
      ...place(host?.sourceId ?? n.sourceId),
      highlightId: host?.id ?? null,
    });
  }
  for (const p of points) {
    const host = liveHighlight(p.highlightId);
    if (!host) continue;
    out.set(`knowledgePoint:${p.id}`, {
      kind: 'knowledgePoint',
      id: p.id,
      text: oneLine(p.shortOneLiner),
      ...place(host.sourceId),
      highlightId: host.id,
    });
  }
  return out;
}

/**
 * Every visible link of one item with the other end described, oldest link first. A link whose other
 * end cannot be reached (see `describeEnds`) is not listed.
 */
export async function listLinks(ref: RelationRef): Promise<LinkEntry[]> {
  const relations = await listRelationsFor(ref);
  const entries = relations.map((relation) => {
    const out = relation.fromKind === ref.kind && relation.fromId === ref.id;
    const other: RelationRef = out
      ? { kind: relation.toKind, id: relation.toId }
      : { kind: relation.fromKind, id: relation.fromId };
    return { relation, direction: out ? ('out' as const) : ('in' as const), other };
  });
  const ends = await describeEnds(entries.map((e) => e.other));
  return entries.flatMap((e) => {
    const end = ends.get(keyOf(e.other));
    return end ? [{ relation: e.relation, direction: e.direction, other: end }] : [];
  });
}

/** Links the graph reads at most; the screen says so when there are more. */
export const GRAPH_MAX_RELATIONS = 20_000;

/** Every visible link (what a graph draws), and whether the list was cut short. */
export async function loadGraph(): Promise<{ relations: Relation[]; truncated: boolean }> {
  const all = await listAllRelations({ limit: GRAPH_MAX_RELATIONS + 1 });
  return {
    relations: all.slice(0, GRAPH_MAX_RELATIONS),
    truncated: all.length > GRAPH_MAX_RELATIONS,
  };
}

/** Live knowledge points whose text holds `query` (all of them for an empty query), newest first. */
export async function findKnowledgePoints(query: string, limit = 20): Promise<LinkEnd[]> {
  const wanted = query.trim().toLowerCase();
  const points = (await listKnowledgePoints())
    .reverse()
    .filter(
      (p) =>
        wanted === '' ||
        [p.shortOneLiner, p.examPearl ?? '', p.misconception ?? '', ...p.claims.map((c) => c.text)]
          .join('\n')
          .toLowerCase()
          .includes(wanted),
    );
  // A few more than asked for: points of a highlight in the trash are dropped by `describeEnds`.
  const sample = points.slice(0, limit * 3);
  const ends = await describeEnds(sample.map((p) => ({ kind: 'knowledgePoint', id: p.id })));
  return sample.flatMap((p) => ends.get(`knowledgePoint:${p.id}`) ?? []).slice(0, limit);
}
