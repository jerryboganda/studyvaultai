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
import {
  ArrowLeft,
  Crosshair,
  ExternalLink,
  Library,
  Link as LinkIcon,
  Maximize,
  Network,
  Shapes,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  BarMeter,
  BuddyEmptyState,
  ChunkyButton,
  InfoTip,
  InlineNotice,
  plural,
  truncate,
  useToast,
} from '@ui';
import { KIND_NAME, TYPE_NAME, phrase } from '@ui/vault';
import { useVaultQuery } from './hooks';
import { Action, Chip, IconAction, Loading, Segments, ViewHead } from './moreKit';
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
const KEYS_HELP =
  'Move onto an item with Tab, then: Right arrow goes to a linked item, Left goes back, Up and Down cycle through the items linked from the same place. Enter opens the item, C draws the graph around it, Escape returns to the list. + and − zoom, 0 fits the window.';

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
    if (graph.loading) return <Loading>Reading your links…</Loading>;
    if (graph.error) {
      return (
        <InlineNotice
          tone="error"
          title="Could not read your links"
          action={
            <ChunkyButton size="sm" onClick={graph.refresh}>
              Try again
            </ChunkyButton>
          }
        >
          {graph.error}
        </InlineNotice>
      );
    }
    if (edges.length === 0 && centreKey === null) {
      return (
        <BuddyEmptyState
          pose="sleep"
          title="No links yet"
          text="Open a highlight, then Links › Add link."
          action={{ label: 'Open banks', icon: Library, onClick: onBack }}
        />
      );
    }
    if (hood && centreKey !== null) {
      const here = described.data?.get(centreKey);
      if (described.data && !here) {
        return (
          <InlineNotice
            tone="warning"
            title="This item is no longer available"
            action={
              <ChunkyButton size="sm" onClick={() => onCentre(null)}>
                Show the overview
              </ChunkyButton>
            }
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
      className="dash-panel dash-graph mv-view"
      aria-labelledby={`${uid}-title`}
      data-testid="graph-view"
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        if ((e.target as Element).closest('input, textarea, select')) return;
        e.preventDefault();
        onBack();
      }}
    >
      <ViewHead
        icon={Network}
        tone="violet"
        title="Knowledge graph"
        titleId={`${uid}-title`}
        info="The links you made between highlights, notes and knowledge points. Pick an item to see what surrounds it; the Connections table holds the same links as text."
      />
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
      <div className="graph-around">
        <Chip icon={Crosshair} tone="violet">
          Around
        </Chip>
        <strong className="mv-wrap" dir="auto">
          {truncate(centreText, 120)}
        </strong>
      </div>
      <div className="graph-bar">
        <ChunkyButton size="sm" icon={ArrowLeft} onClick={onBack} data-testid="graph-back">
          Back
        </ChunkyButton>
        <ChunkyButton size="sm" icon={Network} onClick={onOverview} data-testid="graph-overview">
          Overview
        </ChunkyButton>
        <span className="graph-bar__group">
          <span className="mv-label" aria-hidden="true">
            How far
          </span>
          <Segments<1 | 2>
            legend="How far"
            options={[
              { value: 1, label: '1 link', testId: 'graph-depth-1' },
              { value: 2, label: '2 links', testId: 'graph-depth-2' },
            ]}
            value={depth}
            onChange={onDepth}
          />
        </span>
      </div>

      <p className="graph-stats" role="status" data-testid="graph-summary">
        <Chip icon={Shapes} tone="primary">
          {plural(hood.nodes.length, 'item')}
        </Chip>{' '}
        and{' '}
        <Chip icon={LinkIcon} tone="violet">
          {plural(hood.edges.length, 'link')}
        </Chip>
        {hood.hidden > 0 ? (
          `; ${hood.hidden} more within reach are not shown.`
        ) : (
          <span className="sv-vh">.</span>
        )}
      </p>
      {hood.hidden > 0 ? (
        <div>
          <ChunkyButton size="sm" onClick={onMore} data-testid="graph-more">
            Show {Math.min(GRAPH_NODE_CAP, hood.hidden)} more ({total} within reach)
          </ChunkyButton>
        </div>
      ) : null}
      {hood.nodes.length === 1 ? (
        <InlineNotice tone="info" title="This item has no links yet">
          Open it and use Links, then Add link, to connect it to something.
        </InlineNotice>
      ) : null}

      <section className="mv-card graph-diagram" aria-labelledby={`${uid}-diagram`}>
        <div className="graph-diagram__head">
          <h3 id={`${uid}-diagram`} className="mv-card__title">
            Diagram
            <InfoTip label="Keyboard keys for the diagram">{KEYS_HELP}</InfoTip>
          </h3>
          <span className="graph-zoom">
            <IconAction
              icon={ZoomOut}
              label="Zoom out"
              onClick={() => zoomBy(1 / ZOOM_STEP)}
              data-testid="graph-zoom-out"
            />
            <span className="mv-chip" data-testid="graph-zoom">
              {Math.round(zoom * 100)}%
            </span>
            <IconAction
              icon={ZoomIn}
              label="Zoom in"
              onClick={() => zoomBy(ZOOM_STEP)}
              data-testid="graph-zoom-in"
            />
            <IconAction icon={Maximize} label="Fit" onClick={fit} data-testid="graph-fit" />
          </span>
        </div>
        <p className="sv-vh" id={`${uid}-keys`}>
          {KEYS_HELP}
        </p>
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
        <ul className="graph-legend" aria-label="Types of link" data-testid="graph-legend">
          {RELATION_TYPES.map((t) => (
            <li key={t} className="graph-legend__item">
              <svg width="36" height="12" aria-hidden="true" focusable="false">
                <line
                  x1="2"
                  y1="6"
                  x2="34"
                  y2="6"
                  className={`dash-graph__edge dash-graph__edge--${t}`}
                  strokeWidth={EDGE_STYLE[t].width}
                  strokeDasharray={EDGE_STYLE[t].dash || undefined}
                />
              </svg>
              <strong>{TYPE_NAME[t]}</strong>
              <span className="sv-vh"> {EDGE_STYLE[t].words}</span>
            </li>
          ))}
        </ul>
        <ul className="graph-legend" aria-label="Kinds of item">
          {(
            [
              ['highlight', 'Highlight'],
              ['note', 'Note'],
              ['knowledgePoint', 'Knowledge point'],
              ['centre', 'Centre (star)'],
            ] as const
          ).map(([shape, name]) => (
            <li key={shape} className="graph-legend__item">
              <svg width="18" height="18" viewBox="-10 -10 20 20" aria-hidden="true">
                {shape === 'note' ? (
                  <rect
                    className="graph-legend__shape graph-legend__shape--note"
                    x={-7}
                    y={-7}
                    width={14}
                    height={14}
                    rx={2}
                  />
                ) : shape === 'knowledgePoint' ? (
                  <polygon
                    className="graph-legend__shape graph-legend__shape--kp"
                    points="0,-9 9,0 0,9 -9,0"
                  />
                ) : (
                  <circle
                    className={`graph-legend__shape${shape === 'centre' ? ' graph-legend__shape--centre' : ''}`}
                    r={7}
                  />
                )}
              </svg>
              <span>{name}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="mv-card" aria-labelledby={`${uid}-connections`}>
        <h3 id={`${uid}-connections`} className="mv-card__title">
          <Shapes className="graph-h-icon" aria-hidden="true" />
          Connections
          <InfoTip label="About the connections table">
            The same graph as a table: one row per item, with what it is linked to.
          </InfoTip>
        </h3>
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
                      <Chip tone={dist === 0 ? 'violet' : 'neutral'}>
                        {KIND_NAME[end?.kind ?? 'highlight']}
                      </Chip>{' '}
                      <span className="mv-wrap" dir="auto">
                        {truncate(textOf(described, key), 160)}
                      </span>
                      {end && (end.sourceTitle || end.host) ? (
                        <span className="mv-meta mv-wrap" dir="auto">
                          {' '}
                          · {[end.sourceTitle, end.host].filter(Boolean).join(' · ')}
                        </span>
                      ) : null}
                    </th>
                    <td>
                      <span className="graph-dist">{dist === 0 ? 'Centre' : dist}</span>
                    </td>
                    <td>
                      {incident.length === 0 ? (
                        <span className="mv-meta">No links in view</span>
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
                      <div className="mv-row">
                        <Action
                          size="sm"
                          icon={ExternalLink}
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
                        </Action>
                        {dist === 0 ? null : (
                          <ChunkyButton
                            size="sm"
                            icon={Crosshair}
                            aria-label={`Centre here: ${short}`}
                            data-testid="connection-centre"
                            onClick={() => onCentre(key)}
                          >
                            Centre here
                          </ChunkyButton>
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
  const largest = Math.max(1, ...groups.slice(0, 8).map((g) => g.keys.length));
  return (
    <>
      <p className="graph-stats" role="status" data-testid="graph-summary">
        <Chip icon={LinkIcon} tone="violet">
          {plural(edges.length, 'link')}
        </Chip>{' '}
        between{' '}
        <Chip icon={Shapes} tone="primary">
          {plural(items, 'item')}
        </Chip>
        , in{' '}
        <Chip icon={Network} tone="success">
          {plural(groups.length, 'group')}
        </Chip>
        <span className="sv-vh">. Choose an item to see what surrounds it.</span>
      </p>
      <section className="mv-card" aria-labelledby="graph-top">
        <h3 id="graph-top" className="mv-card__title">
          Most connected
        </h3>
        <ol className="graph-cards" data-testid="graph-top">
          {top.map(({ key, connections }, i) => (
            <li key={key} className="graph-item" data-testid="graph-top-item" data-node={key}>
              <span className="graph-item__rank" aria-hidden="true">
                {i + 1}
              </span>
              <span className="graph-item__body">
                <span className="mv-row">
                  <Chip>{KIND_NAME[described?.get(key)?.kind ?? 'highlight']}</Chip>
                  <Chip icon={LinkIcon} tone="violet">
                    {plural(connections, 'connection')}
                  </Chip>
                </span>
                <span className="mv-wrap graph-item__text" dir="auto">
                  {short(key)}
                </span>
              </span>
              <ChunkyButton
                size="sm"
                icon={Network}
                aria-label={`Show graph: ${short(key)}`}
                data-testid="graph-centre"
                onClick={() => onCentre(key)}
              >
                Show graph
              </ChunkyButton>
            </li>
          ))}
        </ol>
      </section>
      <section className="mv-card" aria-labelledby="graph-groups">
        <h3 id="graph-groups" className="mv-card__title">
          Groups
          <InfoTip label="About groups">
            Items that are linked to each other, directly or through others. The largest come first.
          </InfoTip>
        </h3>
        <ol className="graph-cards" data-testid="graph-groups">
          {groups.slice(0, 8).map((g) => (
            <li key={g.keys[0]} className="graph-item graph-item--group" data-testid="graph-group">
              <span className="graph-item__body">
                <span className="mv-row">
                  <strong>{plural(g.keys.length, 'item')}</strong>
                  <Chip icon={LinkIcon}>{plural(g.links, 'link')}</Chip>
                </span>
                <BarMeter
                  value={g.keys.length}
                  max={largest}
                  label="Group size"
                  valueText={plural(g.keys.length, 'item')}
                  tone="violet"
                  size="sm"
                />
                <ul className="graph-item__keys">
                  {g.keys.slice(0, 3).map((key) => (
                    <li key={key} className="mv-wrap" dir="auto">
                      {short(key)}
                    </li>
                  ))}
                  {g.keys.length > 3 ? (
                    <li className="mv-meta">and {g.keys.length - 3} more</li>
                  ) : null}
                </ul>
              </span>
              <ChunkyButton
                size="sm"
                icon={Network}
                aria-label={`Show graph: ${short(g.keys[0]!)}`}
                data-testid="graph-group-centre"
                onClick={() => onCentre(g.keys[0]!)}
              >
                Show graph
              </ChunkyButton>
            </li>
          ))}
        </ol>
        {groups.length > 8 ? (
          <p className="mv-line">Showing the 8 largest of {groups.length} groups.</p>
        ) : null}
      </section>
    </>
  );
}
