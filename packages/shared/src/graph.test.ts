// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  GRAPH_NODE_CAP,
  adjacency,
  clusters,
  mostConnected,
  neighbourhood,
  nodeKey,
  radialLayout,
  step,
  toEdges,
  type GraphEdge,
  type Walk,
} from './graph';

const k = (id: string) => nodeKey('highlight', id);
const edge = (
  id: string,
  a: string,
  b: string,
  type: GraphEdge['type'] = 'related',
): GraphEdge => ({
  id,
  from: k(a),
  to: k(b),
  type,
});

/** a - b - c - d, plus a - e */
const CHAIN = [
  edge('1', 'a', 'b'),
  edge('2', 'b', 'c', 'supports'),
  edge('3', 'c', 'd'),
  edge('4', 'a', 'e', 'contradicts'),
];

const shuffled = <T>(list: readonly T[]): T[] => [...list].reverse();

describe('neighbourhood', () => {
  it('follows links in both directions, one step or two', () => {
    const one = neighbourhood(CHAIN, k('b'), { depth: 1 });
    expect(one.nodes.map((n) => n.key).sort()).toEqual([k('a'), k('b'), k('c')]);
    expect(one.nodes[0]).toEqual({ key: k('b'), depth: 0 });

    const two = neighbourhood(CHAIN, k('b'), { depth: 2 });
    expect(two.nodes.map((n) => [n.key, n.depth]).sort()).toEqual([
      [k('a'), 1],
      [k('b'), 0],
      [k('c'), 1],
      [k('d'), 2],
      [k('e'), 2],
    ]);
    expect(two.hidden).toBe(0);
  });

  it('keeps only links whose two ends are shown', () => {
    const hood = neighbourhood(CHAIN, k('b'), { depth: 1 });
    expect(hood.edges.map((e) => e.id).sort()).toEqual(['1', '2']);
  });

  it('an item with no links is a neighbourhood of one', () => {
    const hood = neighbourhood(CHAIN, k('zzz'), { depth: 2 });
    expect(hood.nodes).toEqual([{ key: k('zzz'), depth: 0 }]);
    expect(hood.edges).toEqual([]);
    expect(hood.hidden).toBe(0);
  });

  it('is capped, counts exactly what was left out, and keeps the most connected', () => {
    const star: GraphEdge[] = [];
    for (let i = 0; i < 100; i++)
      star.push(edge(`s${i}`, 'hub', `leaf${String(i).padStart(3, '0')}`));
    // leaf050 also links to two other leaves: it is the most connected of its neighbours
    star.push(edge('x1', 'leaf050', 'leaf051'), edge('x2', 'leaf050', 'leaf052'));

    const hood = neighbourhood(star, k('hub'), { depth: 1, cap: 10 });
    expect(hood.nodes).toHaveLength(10);
    expect(hood.hidden).toBe(101 - 10);
    expect(hood.nodes.map((n) => n.key)).toContain(k('leaf050'));
    // Every kept link has both ends kept.
    const kept = new Set(hood.nodes.map((n) => n.key));
    for (const e of hood.edges) expect(kept.has(e.from) && kept.has(e.to)).toBe(true);

    // Asking for more shows a superset (what "show more" does).
    const more = neighbourhood(star, k('hub'), { depth: 1, cap: 20 });
    for (const key of kept) expect(more.nodes.map((n) => n.key)).toContain(key);
    expect(more.hidden).toBe(101 - 20);

    expect(neighbourhood(star, k('hub')).nodes).toHaveLength(GRAPH_NODE_CAP);
  });

  it('does not depend on the order the links were read in', () => {
    const a = neighbourhood(CHAIN, k('b'), { depth: 2, cap: 4 });
    const b = neighbourhood(shuffled(CHAIN), k('b'), { depth: 2, cap: 4 });
    expect(b.nodes).toEqual(a.nodes);
  });

  it('clamps depth to 1..2 and treats a self-loop as nothing', () => {
    expect(neighbourhood(CHAIN, k('a'), { depth: 9 }).nodes.map((n) => n.depth)).toEqual(
      expect.not.arrayContaining([3]),
    );
    const loop = [edge('l', 'a', 'a')];
    expect(neighbourhood(loop, k('a')).edges).toEqual([]);
  });
});

describe('radialLayout', () => {
  const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.hypot(a.x - b.x, a.y - b.y);

  it('puts the centre in the middle and every step on a wider ring', () => {
    const hood = neighbourhood(CHAIN, k('b'), { depth: 2 });
    const layout = radialLayout(hood, { padding: 10 });
    const at = new Map(layout.nodes.map((n) => [n.key, n]));
    const centre = at.get(k('b'))!;
    const ring = (key: string) => dist(at.get(key)!, centre);
    expect(ring(k('a'))).toBeGreaterThan(0);
    expect(ring(k('a'))).toBeCloseTo(ring(k('c')), 0);
    expect(ring(k('d'))).toBeGreaterThan(ring(k('c')));
    expect(layout.nodes).toHaveLength(5);
    for (const n of layout.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(10);
      expect(n.y).toBeGreaterThanOrEqual(10);
      expect(n.x).toBeLessThanOrEqual(layout.width - 10);
      expect(n.y).toBeLessThanOrEqual(layout.height - 10);
    }
  });

  it('is the same picture for the same links, however they were ordered', () => {
    const a = radialLayout(neighbourhood(CHAIN, k('b'), { depth: 2 }));
    const b = radialLayout(neighbourhood(shuffled(CHAIN), k('b'), { depth: 2 }));
    const sort = (l: typeof a) => [...l.nodes].sort((x, y) => (x.key < y.key ? -1 : 1));
    expect(sort(b)).toEqual(sort(a));
    expect([b.width, b.height]).toEqual([a.width, a.height]);
  });

  it('keeps items apart, also when the arms are of very different sizes', () => {
    const edges: GraphEdge[] = [];
    for (let i = 0; i < 12; i++)
      edges.push(edge(`h${i}`, 'hub', `arm${String(i).padStart(2, '0')}`));
    // two arms are large, ten are single items
    for (let i = 0; i < 20; i++)
      edges.push(edge(`x${i}`, 'arm00', `deep0-${String(i).padStart(2, '0')}`));
    for (let i = 0; i < 20; i++)
      edges.push(edge(`y${i}`, 'arm01', `deep1-${String(i).padStart(2, '0')}`));
    const hood = neighbourhood(edges, k('hub'), { depth: 2, cap: 60 });
    expect(hood.nodes).toHaveLength(53);
    const layout = radialLayout(hood, { spacing: 100 });
    let least = Infinity;
    for (let i = 0; i < layout.nodes.length; i++) {
      for (let j = i + 1; j < layout.nodes.length; j++) {
        least = Math.min(least, dist(layout.nodes[i]!, layout.nodes[j]!));
      }
    }
    // Rounding to a tenth can take a fraction of a unit off the target.
    expect(least).toBeGreaterThanOrEqual(99);
  });

  it('lays out a single item and an empty list', () => {
    const one = radialLayout({ nodes: [{ key: k('a'), depth: 0 }], edges: [] });
    expect(one.nodes).toEqual([{ key: k('a'), depth: 0, x: 80, y: 80 }]);
    expect(radialLayout({ nodes: [], edges: [] })).toEqual({ nodes: [], width: 0, height: 0 });
  });
});

describe('clusters and most connected', () => {
  const edges = [
    ...CHAIN, // a b c d e: 5 items
    edge('5', 'p', 'q'), // 2 items
    edge('6', 'x', 'y'),
    edge('7', 'y', 'z'),
    edge('8', 'x', 'z'), // 3 items, 3 links
  ];

  it('lists connected groups, the largest first, never a lone item', () => {
    const groups = clusters(edges);
    expect(groups.map((g) => g.keys.length)).toEqual([5, 3, 2]);
    expect(groups[1]!.links).toBe(3);
    expect(groups[0]!.keys).toHaveLength(5);
    // Within a group the most connected item leads.
    expect([k('a'), k('b'), k('c')]).toContain(groups[0]!.keys[0]);
  });

  it('orders items by how many others they are linked to', () => {
    const top = mostConnected(edges, 3);
    expect(top.map((t) => t.connections)).toEqual([2, 2, 2]);
    expect(mostConnected(edges, 0)).toEqual([]);
    expect(mostConnected([edge('1', 'a', 'b'), edge('2', 'a', 'b', 'supports')], 5)[0]).toEqual({
      key: k('a'),
      connections: 1, // two links to the same item are one connection
    });
  });

  it('turns relations into edges by kind and id', () => {
    expect(
      toEdges([
        {
          id: 'r',
          fromKind: 'note',
          fromId: 'n1',
          toKind: 'knowledgePoint',
          toId: 'k1',
          type: 'cause',
        },
      ]),
    ).toEqual([{ id: 'r', from: 'note:n1', to: 'knowledgePoint:k1', type: 'cause' }]);
  });
});

describe('step (arrow keys along the links)', () => {
  const adj = adjacency(CHAIN);
  const start: Walk = { at: k('a'), trail: [] };

  it('goes in, and back out', () => {
    const into = step(adj, start, 'in');
    expect(into.trail).toEqual([k('a')]);
    expect([k('b'), k('e')]).toContain(into.at);
    expect(step(adj, into, 'out')).toEqual(start);
    expect(step(adj, start, 'out')).toBe(start);
  });

  it('cycles through the siblings of the item it came from', () => {
    const first = step(adj, start, 'next');
    const second = step(adj, first, 'next');
    expect(new Set([first.at, second.at])).toEqual(new Set([k('b'), k('e')]));
    expect(step(adj, second, 'next').at).toBe(first.at);
    expect(step(adj, first, 'previous').at).toBe(second.at);
    expect(second.trail).toEqual([k('a')]);
  });

  it('reaches every item of a connected graph', () => {
    const seen = new Set<string>([start.at]);
    let frontier: Walk[] = [start];
    for (let round = 0; round < 12 && frontier.length > 0; round++) {
      const next: Walk[] = [];
      for (const w of frontier) {
        for (const move of ['in', 'next', 'previous'] as const) {
          const to = step(adj, w, move);
          if (!seen.has(to.at)) {
            seen.add(to.at);
            next.push(to);
          }
        }
      }
      frontier = next;
    }
    expect([...seen].sort()).toEqual(['a', 'b', 'c', 'd', 'e'].map(k));
  });

  it('stays where it is on an item with no links', () => {
    const lone: Walk = { at: k('zzz'), trail: [] };
    for (const move of ['in', 'out', 'next', 'previous'] as const) {
      expect(step(adj, lone, move)).toBe(lone);
    }
  });
});
