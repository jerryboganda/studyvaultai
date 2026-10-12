import type { RelationType } from './schema';

/**
 * Pure helpers for the knowledge graph (ADR-018): neighbourhoods, a deterministic radial layout,
 * clusters and keyboard stepping. No DOM, no storage, no randomness: the same links always give the
 * same picture. Import by subpath (`@shared/graph`); it is not part of the shared barrel, so the
 * content script and the worker never carry it.
 */

/** `kind:id`: the identity of one end of a link in a graph (ids are unique across tables). */
export const nodeKey = (kind: string, id: string): string => `${kind}:${id}`;

export interface GraphEdge {
  /** The relation's id. */
  id: string;
  /** Node keys. `related` has no direction; the other types read from -> to. */
  from: string;
  to: string;
  type: RelationType;
}

export interface RelationLike {
  id: string;
  fromKind: string;
  fromId: string;
  toKind: string;
  toId: string;
  type: RelationType;
}

/** The kind and id a node key was made from (null for anything else). */
export function parseNodeKey(
  key: string,
): { kind: 'highlight' | 'note' | 'knowledgePoint'; id: string } | null {
  const at = key.indexOf(':');
  const kind = key.slice(0, at);
  if (at < 1 || (kind !== 'highlight' && kind !== 'note' && kind !== 'knowledgePoint')) return null;
  return { kind, id: key.slice(at + 1) };
}

export const toEdges = (relations: readonly RelationLike[]): GraphEdge[] =>
  relations.map((r) => ({
    id: r.id,
    from: nodeKey(r.fromKind, r.fromId),
    to: nodeKey(r.toKind, r.toId),
    type: r.type,
  }));

/** Nodes shown at once (the person can ask for more). */
export const GRAPH_NODE_CAP = 60;
export const GRAPH_MAX_DEPTH = 2;

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Distinct neighbours of every node, most connected first and then by key, so every traversal and
 * every layout is independent of the order the links were read in.
 */
export function adjacency(edges: readonly GraphEdge[]): Map<string, string[]> {
  const sets = new Map<string, Set<string>>();
  const add = (a: string, b: string) => {
    let set = sets.get(a);
    if (!set) sets.set(a, (set = new Set()));
    set.add(b);
  };
  for (const e of edges) {
    if (e.from === e.to) continue;
    add(e.from, e.to);
    add(e.to, e.from);
  }
  const out = new Map<string, string[]>();
  for (const [key, set] of sets) {
    out.set(
      key,
      [...set].sort((a, b) => (sets.get(b)?.size ?? 0) - (sets.get(a)?.size ?? 0) || byText(a, b)),
    );
  }
  return out;
}

export interface Neighbourhood {
  centre: string;
  /** Breadth-first: the centre first, then nearer items before farther ones. */
  nodes: Array<{ key: string; depth: number }>;
  /** Links with both ends in `nodes`. */
  edges: GraphEdge[];
  /** Items within reach that the cap left out. */
  hidden: number;
}

/**
 * The items within `depth` links of `centre` (links are followed in both directions), at most `cap`
 * of them. When the cap bites, the more connected items are kept. `hidden` is exact: it counts what
 * the same traversal would have reached without the cap.
 */
export function neighbourhood(
  edges: readonly GraphEdge[],
  centre: string,
  options: { depth?: number; cap?: number } = {},
): Neighbourhood {
  const depth = Math.min(Math.max(Math.floor(options.depth ?? 1), 1), GRAPH_MAX_DEPTH);
  const cap = Math.max(Math.floor(options.cap ?? GRAPH_NODE_CAP), 1);
  const adj = adjacency(edges);
  const reached = new Map<string, number>([[centre, 0]]);
  const order: string[] = [centre];
  for (let head = 0; head < order.length; head++) {
    const key = order[head]!;
    const d = reached.get(key)!;
    if (d >= depth) continue;
    for (const next of adj.get(key) ?? []) {
      if (reached.has(next)) continue;
      reached.set(next, d + 1);
      order.push(next);
    }
  }
  const kept = order.slice(0, cap);
  const inside = new Set(kept);
  return {
    centre,
    nodes: kept.map((key) => ({ key, depth: reached.get(key)! })),
    edges: edges.filter((e) => inside.has(e.from) && inside.has(e.to) && e.from !== e.to),
    hidden: order.length - kept.length,
  };
}

export interface LayoutNode {
  key: string;
  depth: number;
  x: number;
  y: number;
}

export interface Layout {
  nodes: LayoutNode[];
  width: number;
  height: number;
}

export interface LayoutOptions {
  /** Least distance between two rings. */
  ringGap?: number;
  /** Least distance between two neighbours on a ring. */
  spacing?: number;
  padding?: number;
}

const round = (n: number) => Math.round(n * 10) / 10;

/**
 * Radial tree layout of a neighbourhood: the centre in the middle and one ring per step. Each item
 * hangs under the earliest nearer item it is linked to and gets an arc of its parent's sector in
 * proportion to the size of what hangs under it. Rings widen until their closest pair is `spacing`
 * apart. Deterministic: no physics, no random start.
 */
export function radialLayout(
  hood: Pick<Neighbourhood, 'nodes' | 'edges'>,
  options: LayoutOptions = {},
): Layout {
  const ringGap = options.ringGap ?? 130;
  const spacing = options.spacing ?? 140;
  const padding = options.padding ?? 80;
  const { nodes } = hood;
  if (nodes.length === 0) return { nodes: [], width: 0, height: 0 };

  const adj = adjacency(hood.edges);
  const depthOf = new Map(nodes.map((n) => [n.key, n.depth]));
  const index = new Map(nodes.map((n, i) => [n.key, i]));
  const children = new Map<string, string[]>();
  for (const n of nodes) {
    if (n.depth === 0) continue;
    const parent = (adj.get(n.key) ?? [])
      .filter((k) => depthOf.get(k) === n.depth - 1)
      .sort((a, b) => index.get(a)! - index.get(b)!)[0];
    if (parent === undefined) continue;
    const list = children.get(parent) ?? [];
    list.push(n.key);
    children.set(parent, list);
  }

  const weight = new Map<string, number>();
  for (let i = nodes.length - 1; i >= 0; i--) {
    const key = nodes[i]!.key;
    const kids = children.get(key) ?? [];
    weight.set(key, kids.length === 0 ? 1 : kids.reduce((sum, k) => sum + weight.get(k)!, 0));
  }

  // Angles first: they depend only on the weights, and the rings are sized from them.
  const angle = new Map<string, number>();
  const sector = (key: string, from: number, to: number) => {
    angle.set(key, (from + to) / 2);
    const kids = children.get(key) ?? [];
    const total = weight.get(key)!;
    let at = from;
    for (const kid of kids) {
      const span = ((to - from) * weight.get(kid)!) / total;
      sector(kid, at, at + span);
      at += span;
    }
  };
  const root = nodes[0]!;
  sector(root.key, -Math.PI / 2, (3 * Math.PI) / 2);

  const radius: number[] = [0];
  const maxDepth = Math.max(...nodes.map((n) => n.depth));
  for (let d = 1; d <= maxDepth; d++) {
    const ring = nodes
      .filter((n) => n.depth === d && angle.has(n.key))
      .map((n) => angle.get(n.key)!)
      .sort((a, b) => a - b);
    let least = 2 * Math.PI;
    for (let i = 0; i < ring.length; i++) {
      const next = i + 1 < ring.length ? ring[i + 1]! : ring[0]! + 2 * Math.PI;
      if (ring.length > 1) least = Math.min(least, next - ring[i]!);
    }
    const needed =
      ring.length > 1 ? spacing / (2 * Math.sin(Math.min(Math.max(least, 1e-3), Math.PI) / 2)) : 0;
    radius[d] = Math.max(radius[d - 1]! + ringGap, needed);
  }

  const placed = nodes.map((n) => {
    const a = angle.get(n.key) ?? 0;
    const r = radius[n.depth] ?? 0;
    return { key: n.key, depth: n.depth, x: r * Math.cos(a), y: r * Math.sin(a) };
  });
  const minX = Math.min(...placed.map((p) => p.x));
  const maxX = Math.max(...placed.map((p) => p.x));
  const minY = Math.min(...placed.map((p) => p.y));
  const maxY = Math.max(...placed.map((p) => p.y));
  return {
    nodes: placed.map((p) => ({
      ...p,
      x: round(p.x - minX + padding),
      y: round(p.y - minY + padding),
    })),
    width: round(maxX - minX + 2 * padding),
    height: round(maxY - minY + 2 * padding),
  };
}

export interface Cluster {
  /** Items in the group, most connected first. */
  keys: string[];
  links: number;
}

/** Connected groups of two or more items, the largest first. */
export function clusters(edges: readonly GraphEdge[]): Cluster[] {
  const adj = adjacency(edges);
  const seen = new Set<string>();
  const out: Cluster[] = [];
  for (const start of [...adj.keys()].sort(byText)) {
    if (seen.has(start)) continue;
    const members = [start];
    seen.add(start);
    for (let head = 0; head < members.length; head++) {
      for (const next of adj.get(members[head]!) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        members.push(next);
      }
    }
    const inside = new Set(members);
    out.push({
      keys: members.sort((a, b) => adj.get(b)!.length - adj.get(a)!.length || byText(a, b)),
      links: edges.filter((e) => inside.has(e.from) && inside.has(e.to)).length,
    });
  }
  return out.sort((a, b) => b.keys.length - a.keys.length || byText(a.keys[0]!, b.keys[0]!));
}

/** The items with the most distinct neighbours, then by key. */
export function mostConnected(
  edges: readonly GraphEdge[],
  limit: number,
): Array<{ key: string; connections: number }> {
  return [...adjacency(edges)]
    .map(([key, list]) => ({ key, connections: list.length }))
    .sort((a, b) => b.connections - a.connections || byText(a.key, b.key))
    .slice(0, Math.max(0, limit));
}

/** Where keyboard stepping is: the item and the items walked through to reach it. */
export interface Walk {
  at: string;
  trail: string[];
}

export type WalkMove = 'in' | 'out' | 'next' | 'previous';

/**
 * One arrow-key step along the links. `in` goes to a neighbour (not the one just left), `out` goes
 * back, `next`/`previous` cycle through the siblings (the neighbours of the item walked from). Every
 * item of a connected graph can be reached this way, and nothing depends on where it is drawn.
 */
export function step(
  adj: ReadonlyMap<string, readonly string[]>,
  walk: Walk,
  move: WalkMove,
): Walk {
  const { at, trail } = walk;
  const parent = trail[trail.length - 1];
  const near = adj.get(at) ?? [];
  if (move === 'out') {
    return parent === undefined ? walk : { at: parent, trail: trail.slice(0, -1) };
  }
  if (move === 'in' || parent === undefined) {
    const target =
      move === 'previous' && parent === undefined
        ? near[near.length - 1]
        : (near.find((k) => k !== parent && !trail.includes(k)) ?? near.find((k) => k !== parent));
    return target === undefined ? walk : { at: target, trail: [...trail, at] };
  }
  const siblings = adj.get(parent) ?? [];
  const i = siblings.indexOf(at);
  if (siblings.length < 2 || i < 0) return walk;
  const j = (i + (move === 'next' ? 1 : -1) + siblings.length) % siblings.length;
  return { at: siblings[j]!, trail };
}
