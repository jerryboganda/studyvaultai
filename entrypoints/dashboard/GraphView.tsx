import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { RELATION_TYPES, type RelationType } from '@shared';
import {
  GRAPH_NODE_CAP,
  adjacency,
  clusters,
  mostConnected,
  neighbourhood,
  nodeKey,
  parseNodeKey,
  radialLayout,
  step,
  toEdges,
  type GraphEdge,
  type Walk,
  type WalkMove,
} from '@shared/graph';
import { describeEnds, loadGraph, type LinkEnd, type RelationRef } from '@storage';
import { Button, EmptyState, InlineNotice, plural, truncate, useToast } from '@ui';
import { KIND_NAME, TYPE_NAME, phrase } from '@ui/vault';
import { useVaultQuery } from './hooks';
import './graph.css';

/**
 * The knowledge graph (ADR-018): the links the person made, drawn around one item or summarised for
 * the whole vault. The picture is a deterministic radial layout in SVG (no physics, nothing moves);
 * the "Connections" table next to it holds exactly the same information in reading order and is the
 * accessible equivalent. Loaded on demand: the dashboard does not carry this code until the view is
 * opened.
 */

export interface GraphViewProps {
  /** The item the graph is drawn around; null shows the overview of the whole vault. */
  centre: RelationRef | null;
  onCentre(next: RelationRef | null): void;
  /** Show a highlight in the list and preview (this view closes). */
  onShow(highlightId: string): void;
  /** Escape, or the back button: return to the list. */
  onBack(): void;
}

const NODE_R = 20;
const ZOOM_STEP = 1.25;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 3;
const LABEL_CHARS = 18;
const CONNECTION_CHARS = 60;

interface EdgeStyle {
  dash: string;
  width: number;
  arrow: boolean;
  colour: string;
  /** In words, for the legend: colour is never the only cue. */
  words: string;
}

/** Lines differ by pattern and weight as well as colour. */
const EDGE_STYLE: Record<RelationType, EdgeStyle> = {
  related: {
    dash: '',
    width: 1.5,
    arrow: false,
    colour: 'var(--sv-text-muted)',
    words: 'thin solid line, no arrow',
  },
  supports: {
    dash: '',
    width: 3,
    arrow: true,
    colour: 'var(--sv-success)',
    words: 'thick solid line, arrow',
  },
  contradicts: {
    dash: '9 5',
    width: 3,
    arrow: true,
    colour: 'var(--sv-danger)',
    words: 'dashed line, arrow',
  },
  cause: {
    dash: '1 6',
    width: 3,
    arrow: true,
    colour: 'var(--sv-accent)',
    words: 'dotted line, arrow',
  },
  example: {
    dash: '10 4 2 4',
    width: 2.5,
    arrow: true,
    colour: 'var(--sv-text)',
    words: 'dash-dot line, arrow',
  },
  prerequisite: {
    dash: '18 6',
    width: 2,
    arrow: true,
    colour: 'var(--sv-text-muted)',
    words: 'long-dash line, arrow',
  },
};

const GLYPH = { highlight: 'H', note: 'N', knowledgePoint: 'K' } as const;
const SHAPE_WORDS = 'circle = highlight, square = note, diamond = knowledge point';

type Described = Map<string, LinkEnd>;

const textOf = (described: Described | undefined, key: string): string =>
  described?.get(key)?.text || '…';

/** A stand-in for an item the read has not described yet (`text: '…'`) or could not find. */
function stand(key: string, text: string): LinkEnd {
  const ref = parseNodeKey(key);
  return {
    kind: ref?.kind ?? 'highlight',
    id: ref?.id ?? key,
    text,
    sourceTitle: '',
    host: '',
    highlightId: null,
  };
}

export default function GraphView({ centre, onCentre, onShow, onBack }: GraphViewProps) {
  const toast = useToast();
  const uid = useId();
  const graph = useVaultQuery(() => loadGraph(), []);
  const edges = useMemo(() => toEdges(graph.data?.relations ?? []), [graph.data]);
  const [depth, setDepth] = useState<1 | 2>(1);
  const [cap, setCap] = useState(GRAPH_NODE_CAP);
  const centreKey = centre ? nodeKey(centre.kind, centre.id) : null;

  const hood = useMemo(
    () => (centreKey === null ? null : neighbourhood(edges, centreKey, { depth, cap })),
    [edges, centreKey, depth, cap],
  );
  const overview = useMemo(
    () => (centreKey === null ? { top: mostConnected(edges, 10), groups: clusters(edges) } : null),
    [edges, centreKey],
  );

  // Every item named on the screen, described in one read.
  const wanted = useMemo(() => {
    if (hood) return hood.nodes.map((n) => n.key);
    if (!overview) return [];
    return [
      ...new Set([
        ...overview.top.map((t) => t.key),
        ...overview.groups.slice(0, 8).flatMap((g) => g.keys.slice(0, 3)),
      ]),
    ];
  }, [hood, overview]);
  // Not before the links are read: until then `wanted` is only the centre.
  const settled = graph.data !== undefined;
  const described = useVaultQuery(
    () =>
      settled
        ? describeEnds(
            wanted.flatMap((key) => {
              const ref = parseNodeKey(key);
              return ref ? [ref] : [];
            }),
          )
        : Promise.resolve(null),
    [wanted.join('\n'), settled],
  );

  // Names are kept while the next read is in flight, so a change of depth or centre does not blank
  // the items that were already on the screen.
  const [known, setKnown] = useState<Described>(() => new Map());
  const [seenRead, setSeenRead] = useState<Described | null | undefined>(null);
  if (described.data && described.data !== seenRead) {
    const read = described.data;
    setSeenRead(read);
    setKnown((before) => new Map([...before, ...read]));
  }
  const names = useMemo<Described>(() => {
    const out = new Map(known);
    for (const key of wanted) {
      const end = described.data?.get(key);
      if (end) out.set(key, end);
      else if (described.data) out.set(key, stand(key, 'An item that is no longer available'));
      else if (!out.has(key)) out.set(key, stand(key, '…'));
    }
    return out;
  }, [known, described.data, wanted]);

  const goTo = useCallback(
    (key: string) => {
      const ref = parseNodeKey(key);
      if (!ref) return;
      setCap(GRAPH_NODE_CAP);
      onCentre(ref);
    },
    [onCentre],
  );

  const open = useCallback(
    (key: string) => {
      const end = names.get(key);
      if (end?.highlightId) onShow(end.highlightId);
      else toast.announce('This note is not attached to a highlight, so there is nothing to show.');
    },
    [names, onShow, toast],
  );

  const body = (): ReactNode => {
    if (graph.loading) {
      return (
        <p className="sv-muted dash-loading" role="status">
          Reading your links…
        </p>
      );
    }
    if (graph.error) {
      return (
        <InlineNotice
          tone="error"
          title="Could not read your links"
          action={<Button onClick={graph.refresh}>Try again</Button>}
        >
          {graph.error}
        </InlineNotice>
      );
    }
    if (edges.length === 0 && centreKey === null) {
      return (
        <EmptyState title="No links yet">
          Open a highlight, choose Links, then Add link to connect it to another highlight, a note
          or a knowledge point. The graph appears here.
        </EmptyState>
      );
    }
    if (hood && centreKey !== null) {
      const here = described.data?.get(centreKey);
      if (described.data && !here) {
        return (
          <InlineNotice
            tone="warning"
            title="This item is no longer available"
            action={<Button onClick={() => onCentre(null)}>Show the overview</Button>}
          >
            It may be in the trash, or its highlight may be. Restore it from the Trash view to see
            its links again.
          </InlineNotice>
        );
      }
      return (
        <Neighbourhood
          hood={hood}
          described={names}
          depth={depth}
          onDepth={(d) => {
            setDepth(d);
            setCap(GRAPH_NODE_CAP);
          }}
          onMore={() => setCap((c) => c + GRAPH_NODE_CAP)}
          onCentre={goTo}
          onOpen={open}
          onBack={onBack}
          onOverview={() => onCentre(null)}
          uid={uid}
        />
      );
    }
    return overview ? (
      <Overview
        top={overview.top}
        groups={overview.groups}
        edges={edges}
        described={names}
        onCentre={goTo}
      />
    ) : null;
  };

  return (
    <section
      className="dash-panel dash-graph"
      aria-labelledby={`${uid}-title`}
      data-testid="graph-view"
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        if ((e.target as Element).closest('input, textarea, select')) return;
        e.preventDefault();
        onBack();
      }}
    >
      <h2 id={`${uid}-title`}>Knowledge graph</h2>
      {graph.data?.truncated ? (
        <InlineNotice tone="warning">
          You have more links than the graph can read at once; it shows the oldest 20,000.
        </InlineNotice>
      ) : null}
      {body()}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Around one item
// ---------------------------------------------------------------------------------------------

function Neighbourhood({
  hood,
  described,
  depth,
  onDepth,
  onMore,
  onCentre,
  onOpen,
  onBack,
  onOverview,
  uid,
}: {
  hood: ReturnType<typeof neighbourhood>;
  described: Described | undefined;
  depth: 1 | 2;
  onDepth(depth: 1 | 2): void;
  onMore(): void;
  onCentre(key: string): void;
  onOpen(key: string): void;
  onBack(): void;
  onOverview(): void;
  uid: string;
}) {
  const toast = useToast();
  const layout = useMemo(() => radialLayout(hood), [hood]);
  const adj = useMemo(() => adjacency(hood.edges), [hood.edges]);
  const degree = (key: string) => adj.get(key)?.length ?? 0;
  const centreKey = hood.centre;
  // Where the keyboard is: the item with focus and the items walked through to reach it.
  const [walk, setWalk] = useState<Walk>({ at: centreKey, trail: [] });
  const focusKey = walk.at;
  const scroller = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const [zoom, setZoom] = useState(1);

  // A new centre starts a new walk.
  const [seenCentre, setSeenCentre] = useState(centreKey);
  if (seenCentre !== centreKey) {
    setSeenCentre(centreKey);
    setWalk({ at: centreKey, trail: [] });
  }

  const fit = useCallback(() => {
    const room = scroller.current?.clientWidth ?? 0;
    setZoom(
      room > 0 && layout.width > 0 ? Math.min(1, Math.max(ZOOM_MIN, room / layout.width)) : 1,
    );
  }, [layout.width]);
  useEffect(() => {
    fit();
  }, [fit]);

  const zoomBy = (factor: number) =>
    setZoom((z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * factor * 100) / 100)));

  const focusNode = (key: string) => {
    for (const el of svg.current?.querySelectorAll<SVGGElement>('[data-node]') ?? []) {
      if (el.getAttribute('data-node') === key) el.focus();
    }
  };

  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const key = (e.target as Element).closest('[data-node]')?.getAttribute('data-node');
    if (!key) return;
    const moves: Record<string, WalkMove> = {
      ArrowRight: 'in',
      ArrowLeft: 'out',
      ArrowDown: 'next',
      ArrowUp: 'previous',
    };
    const move = moves[e.key];
    if (move) {
      const next = step(adj, { at: key, trail: walk.at === key ? walk.trail : [] }, move);
      if (next.at === key) toast.announce('No further link in that direction.');
      else {
        // Queued before the focus event it causes, whose update then finds it already there.
        setWalk(next);
        focusNode(next.at);
      }
    } else if (e.key === 'Enter' || e.key === ' ') onOpen(key);
    else if (e.key === 'c' || e.key === 'C') onCentre(key);
    else if (e.key === '+' || e.key === '=') zoomBy(ZOOM_STEP);
    else if (e.key === '-' || e.key === '_') zoomBy(1 / ZOOM_STEP);
    else if (e.key === '0') fit();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const at = useMemo(() => new Map(layout.nodes.map((n) => [n.key, n])), [layout]);

  // Several links between the same two items are drawn as parallel curves.
  const curves = useMemo(() => {
    const groups = new Map<string, GraphEdge[]>();
    for (const e of hood.edges) {
      const id = e.from < e.to ? `${e.from}|${e.to}` : `${e.to}|${e.from}`;
      groups.set(id, [...(groups.get(id) ?? []), e]);
    }
    const out: Array<{ edge: GraphEdge; d: string; mx: number; my: number }> = [];
    for (const list of groups.values()) {
      list.forEach((edge, i) => {
        const a = at.get(edge.from);
        const b = at.get(edge.to);
        if (!a || !b) return;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const bend = (i - (list.length - 1) / 2) * 36;
        const cx = (a.x + b.x) / 2 + (-dy / len) * bend;
        const cy = (a.y + b.y) / 2 + (dx / len) * bend;
        const pull = (px: number, py: number, qx: number, qy: number) => {
          const l = Math.hypot(qx - px, qy - py) || 1;
          return [
            px + ((qx - px) / l) * (NODE_R + 5),
            py + ((qy - py) / l) * (NODE_R + 5),
          ] as const;
        };
        const [sx, sy] = pull(a.x, a.y, cx, cy);
        const [ex, ey] = pull(b.x, b.y, cx, cy);
        out.push({
          edge,
          d: `M ${sx} ${sy} Q ${cx} ${cy} ${ex} ${ey}`,
          mx: 0.25 * sx + 0.5 * cx + 0.25 * ex,
          my: 0.25 * sy + 0.5 * cy + 0.25 * ey,
        });
      });
    }
    return out;
  }, [hood.edges, at]);

  const total = hood.nodes.length + hood.hidden;
  const centreText = textOf(described, centreKey);

  return (
    <>
      <p className="sv-muted">
        Around: <strong dir="auto">{truncate(centreText, 120)}</strong>
      </p>
      <div className="sv-row dash-graph__bar">
        <Button onClick={onBack} data-testid="graph-back">
          Back to the list
        </Button>
        <Button onClick={onOverview} data-testid="graph-overview">
          Overview of the whole vault
        </Button>
        <fieldset className="dash-graph__depth">
          <legend className="sv-label">How far</legend>
          {([1, 2] as const).map((d) => (
            <label key={d} className="sv-check">
              <input
                type="radio"
                name={`${uid}-depth`}
                checked={depth === d}
                data-testid={`graph-depth-${d}`}
                onChange={() => onDepth(d)}
              />
              <span>{d === 1 ? '1 link' : '2 links'}</span>
            </label>
          ))}
        </fieldset>
      </div>

      <p className="sv-small" role="status" data-testid="graph-summary">
        {plural(hood.nodes.length, 'item')} and {plural(hood.edges.length, 'link')}
        {hood.hidden > 0 ? `; ${hood.hidden} more within reach are not shown.` : '.'}
      </p>
      {hood.hidden > 0 ? (
        <div>
          <Button onClick={onMore} data-testid="graph-more">
            Show {Math.min(GRAPH_NODE_CAP, hood.hidden)} more ({total} within reach)
          </Button>
        </div>
      ) : null}
      {hood.nodes.length === 1 ? (
        <InlineNotice tone="info" title="This item has no links yet">
          Open it and use Links, then Add link, to connect it to something.
        </InlineNotice>
      ) : null}

      <section className="sv-stack sv-stack--tight" aria-labelledby={`${uid}-diagram`}>
        <h3 id={`${uid}-diagram`}>Diagram</h3>
        <p className="sv-small sv-muted" id={`${uid}-keys`}>
          Move onto an item with Tab, then: Right arrow goes to a linked item, Left goes back, Up
          and Down cycle through the items linked from the same place. Enter opens the item, C draws
          the graph around it, Escape returns to the list. + and − zoom, 0 fits the window.
        </p>
        <div className="sv-row">
          <Button onClick={() => zoomBy(1 / ZOOM_STEP)} data-testid="graph-zoom-out">
            Zoom out
          </Button>
          <Button onClick={() => zoomBy(ZOOM_STEP)} data-testid="graph-zoom-in">
            Zoom in
          </Button>
          <Button onClick={fit} data-testid="graph-fit">
            Fit
          </Button>
          <span className="sv-small sv-muted" data-testid="graph-zoom">
            {Math.round(zoom * 100)}%
          </span>
        </div>
        <div
          role="group"
          aria-label="Diagram of the links"
          aria-describedby={`${uid}-keys`}
          className="dash-graph__scroll"
          ref={scroller}
        >
          <svg
            ref={svg}
            role="presentation"
            className="dash-graph__svg"
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            width={Math.round(layout.width * zoom)}
            height={Math.round(layout.height * zoom)}
            data-testid="graph-svg"
            onKeyDown={onKey}
            onFocus={(e) => {
              const key = (e.target as Element).closest('[data-node]')?.getAttribute('data-node');
              if (!key) return;
              setWalk((w) => (w.at === key ? w : { at: key, trail: [] }));
            }}
          >
            <defs>
              {RELATION_TYPES.filter((t) => EDGE_STYLE[t].arrow).map((t) => (
                <marker
                  key={t}
                  id={`${uid}-arrow-${t}`}
                  className={`dash-graph__arrow dash-graph__arrow--${t}`}
                  viewBox="0 0 10 10"
                  markerUnits="userSpaceOnUse"
                  refX="9"
                  refY="5"
                  markerWidth="13"
                  markerHeight="13"
                  orient="auto"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" />
                </marker>
              ))}
            </defs>
            {curves.map(({ edge, d, mx, my }) => {
              const style = EDGE_STYLE[edge.type];
              const hot = edge.from === focusKey || edge.to === focusKey;
              return (
                <g key={edge.id} data-testid="graph-edge" data-type={edge.type}>
                  <path
                    d={d}
                    fill="none"
                    className={`dash-graph__edge dash-graph__edge--${edge.type}`}
                    strokeWidth={hot ? style.width + 1.5 : style.width}
                    strokeDasharray={style.dash || undefined}
                    markerEnd={style.arrow ? `url(#${uid}-arrow-${edge.type})` : undefined}
                  />
                  {hot ? (
                    <text x={mx} y={my} className="dash-graph__edgelabel" textAnchor="middle">
                      {TYPE_NAME[edge.type]}
                    </text>
                  ) : null}
                </g>
              );
            })}
            {hood.nodes.map(({ key, depth: dist }) => {
              const place = at.get(key);
              const end = described?.get(key);
              if (!place) return null;
              const kind = end?.kind ?? parseNodeKey(key)?.kind ?? 'highlight';
              const text = textOf(described, key);
              const n = degree(key);
              const label = `${KIND_NAME[kind]}: ${truncate(text, 80)}. ${plural(n, 'link')}${
                dist === 0
                  ? '. The centre of the graph'
                  : `. ${plural(dist, 'link')} from the centre`
              }.`;
              return (
                <g
                  key={key}
                  transform={`translate(${place.x} ${place.y})`}
                  tabIndex={key === focusKey ? 0 : -1}
                  role="button"
                  aria-label={label}
                  data-node={key}
                  data-testid="graph-node"
                  data-kind={kind}
                  data-centre={dist === 0 ? 'true' : undefined}
                  className="dash-graph__node"
                  onDoubleClick={() => onOpen(key)}
                >
                  {kind === 'note' ? (
                    <rect
                      className="dash-graph__shape"
                      x={-NODE_R}
                      y={-NODE_R}
                      width={NODE_R * 2}
                      height={NODE_R * 2}
                      rx={4}
                    />
                  ) : kind === 'knowledgePoint' ? (
                    <polygon
                      className="dash-graph__shape"
                      points={`0,${-NODE_R - 4} ${NODE_R + 4},0 0,${NODE_R + 4} ${-NODE_R - 4},0`}
                    />
                  ) : (
                    <circle className="dash-graph__shape" r={NODE_R} />
                  )}
                  <text className="dash-graph__glyph" textAnchor="middle" dy="0.35em">
                    {dist === 0 ? `${GLYPH[kind]}*` : GLYPH[kind]}
                  </text>
                  <text className="dash-graph__label" textAnchor="middle" y={NODE_R + 18}>
                    {truncate(text, LABEL_CHARS)}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
        <ul className="dash-graph__legend" aria-label="Types of link" data-testid="graph-legend">
          {RELATION_TYPES.map((t) => (
            <li key={t}>
              <svg width="56" height="12" aria-hidden="true" focusable="false">
                <line
                  x1="2"
                  y1="6"
                  x2="54"
                  y2="6"
                  className={`dash-graph__edge dash-graph__edge--${t}`}
                  strokeWidth={EDGE_STYLE[t].width}
                  strokeDasharray={EDGE_STYLE[t].dash || undefined}
                />
              </svg>
              <span>
                <strong>{TYPE_NAME[t]}</strong>
                <span className="sv-small sv-muted"> {EDGE_STYLE[t].words}</span>
              </span>
            </li>
          ))}
          <li className="sv-small sv-muted">Shapes: {SHAPE_WORDS}. A star marks the centre.</li>
        </ul>
      </section>

      <section className="sv-stack sv-stack--tight" aria-labelledby={`${uid}-connections`}>
        <h3 id={`${uid}-connections`}>Connections</h3>
        <p className="sv-small sv-muted">
          The same graph as a table, one row per item with what it is linked to.
        </p>
        <div className="dash-graph__tablewrap">
          <table className="dash-graph__table" data-testid="graph-connections">
            <caption className="sv-sr">Connections around {truncate(centreText, 80)}</caption>
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col">Links away</th>
                <th scope="col">Linked to</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {hood.nodes.map(({ key, depth: dist }) => {
                const end = described?.get(key);
                const incident = hood.edges.filter((e) => e.from === key || e.to === key);
                const short = truncate(textOf(described, key), 60);
                return (
                  <tr key={key} data-testid="connection-row" data-node={key} data-depth={dist}>
                    <th scope="row">
                      <span className="sv-badge">{KIND_NAME[end?.kind ?? 'highlight']}</span>{' '}
                      <span className="sv-wrap" dir="auto">
                        {truncate(textOf(described, key), 160)}
                      </span>
                      {end && (end.sourceTitle || end.host) ? (
                        <span className="sv-small sv-muted sv-wrap" dir="auto">
                          {' '}
                          · {[end.sourceTitle, end.host].filter(Boolean).join(' · ')}
                        </span>
                      ) : null}
                    </th>
                    <td>{dist === 0 ? 'Centre' : dist}</td>
                    <td>
                      {incident.length === 0 ? (
                        <span className="sv-muted">No links in view</span>
                      ) : (
                        <ul className="dash-graph__links">
                          {incident.map((e) => {
                            const out = e.from === key;
                            const other = out ? e.to : e.from;
                            return (
                              <li key={e.id} data-testid="connection-link" data-type={e.type}>
                                <strong>{phrase(e.type, out ? 'out' : 'in')}</strong>{' '}
                                <span dir="auto">
                                  {truncate(textOf(described, other), CONNECTION_CHARS)}
                                </span>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </td>
                    <td>
                      <div className="sv-row">
                        <Button
                          aria-label={`Open: ${short}`}
                          data-testid="connection-open"
                          disabledReason={
                            end && end.highlightId === null
                              ? 'This note is not attached to a highlight, so there is nothing to show.'
                              : undefined
                          }
                          onClick={() => onOpen(key)}
                        >
                          Open
                        </Button>
                        {dist === 0 ? null : (
                          <Button
                            aria-label={`Draw the graph around: ${short}`}
                            data-testid="connection-centre"
                            onClick={() => onCentre(key)}
                          >
                            Centre here
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// The whole vault
// ---------------------------------------------------------------------------------------------

function Overview({
  top,
  groups,
  edges,
  described,
  onCentre,
}: {
  top: Array<{ key: string; connections: number }>;
  groups: ReturnType<typeof clusters>;
  edges: GraphEdge[];
  described: Described | undefined;
  onCentre(key: string): void;
}) {
  const items = new Set(edges.flatMap((e) => [e.from, e.to])).size;
  const short = (key: string) => truncate(textOf(described, key), 100);
  return (
    <>
      <p className="sv-small" role="status" data-testid="graph-summary">
        {plural(edges.length, 'link')} between {plural(items, 'item')}, in{' '}
        {plural(groups.length, 'group')}. A graph of everything would be unreadable, so choose an
        item to see what surrounds it.
      </p>
      <section className="sv-stack sv-stack--tight" aria-labelledby="graph-top">
        <h3 id="graph-top">Most connected items</h3>
        <ol className="dash-graph__list" data-testid="graph-top">
          {top.map(({ key, connections }) => (
            <li key={key} className="sv-related__item" data-testid="graph-top-item" data-node={key}>
              <p className="sv-wrap" dir="auto">
                <span className="sv-badge">
                  {KIND_NAME[described?.get(key)?.kind ?? 'highlight']}
                </span>{' '}
                {short(key)}
              </p>
              <p className="sv-small sv-muted">{plural(connections, 'connection')}</p>
              <div>
                <Button
                  aria-label={`Draw the graph around: ${short(key)}`}
                  data-testid="graph-centre"
                  onClick={() => onCentre(key)}
                >
                  Show graph around this
                </Button>
              </div>
            </li>
          ))}
        </ol>
      </section>
      <section className="sv-stack sv-stack--tight" aria-labelledby="graph-groups">
        <h3 id="graph-groups">Groups of linked items</h3>
        <ol className="dash-graph__list" data-testid="graph-groups">
          {groups.slice(0, 8).map((g) => (
            <li key={g.keys[0]} className="sv-related__item" data-testid="graph-group">
              <p>
                <strong>{plural(g.keys.length, 'item')}</strong>, {plural(g.links, 'link')}
              </p>
              <ul className="dash-graph__links">
                {g.keys.slice(0, 3).map((key) => (
                  <li key={key} className="sv-wrap" dir="auto">
                    {short(key)}
                  </li>
                ))}
                {g.keys.length > 3 ? (
                  <li className="sv-muted">and {g.keys.length - 3} more</li>
                ) : null}
              </ul>
              <div>
                <Button
                  aria-label={`Draw the graph around: ${short(g.keys[0]!)}`}
                  data-testid="graph-group-centre"
                  onClick={() => onCentre(g.keys[0]!)}
                >
                  Show graph around the most connected
                </Button>
              </div>
            </li>
          ))}
        </ol>
        {groups.length > 8 ? (
          <p className="sv-small sv-muted">Showing the 8 largest of {groups.length} groups.</p>
        ) : null}
      </section>
    </>
  );
}
