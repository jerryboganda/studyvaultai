import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Table } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/**
 * Plain SVG bar chart with a real data table behind it. The chart is a picture of the table: the
 * table is always one click away (a disclosure), and the SVG carries a text summary, so nothing is
 * conveyed by the graphic alone. No library, no animation.
 */

export interface Bar {
  /** Category label (a date, a rating). */
  label: string;
  /** Shorter label under the bar; defaults to `label`. */
  tick?: string;
  value: number;
  /** Second, stacked series (drawn above `value`). */
  extra?: number;
}

export interface BarChartProps {
  title: string;
  /** One or two sentences: what the chart shows and what stands out. */
  summary: string;
  bars: readonly Bar[];
  valueLabel: string;
  extraLabel?: string;
  /** Header of the first table column (the category of a bar). Default "Day". */
  categoryLabel?: string;
  /** Extra table columns, one array of cells per bar. */
  columns?: { header: string; cells: readonly ReactNode[] };
  testId?: string;
  tableTestId?: string;
  /** Tick labels land on every n-th bar (more apart when the chart is narrow). */
  tickEvery?: number;
  /** Count the ticks from the last bar (a log ending today) instead of the first. */
  tickFromEnd?: boolean;
}

const H = 176;
const PAD = { top: 14, right: 8, bottom: 30, left: 36 };
/** Room for one tick label, in px. */
const TICK_GAP = 56;

/**
 * The chart's own width in px, so the viewBox is drawn 1:1: labels stay 12 px at any width
 * instead of shrinking with the picture (no text under 12 px, 1.4.4).
 */
function useWidth(fallback: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.round(entry?.contentRect.width ?? 0);
      if (w > 0) setWidth(Math.max(200, w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

export function BarChart({
  title,
  summary,
  bars,
  valueLabel,
  extraLabel,
  categoryLabel = 'Day',
  columns,
  testId,
  tableTestId,
  tickEvery = 1,
  tickFromEnd = false,
}: BarChartProps) {
  const uid = useId();
  const [box, W] = useWidth(640);
  const max = Math.max(1, ...bars.map((b) => b.value + (b.extra ?? 0)));
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const slot = bars.length > 0 ? innerW / bars.length : innerW;
  const bw = Math.max(3, slot * 0.66);
  const r = Math.min(5, bw / 3);
  const y = (v: number) => PAD.top + innerH - (v / max) * innerH;
  // Every n-th bar, n a multiple of tickEvery that leaves TICK_GAP px per label.
  const step = tickEvery * Math.max(1, Math.ceil(TICK_GAP / (slot * tickEvery)));
  const last = bars.length - 1;
  const titleId = `${uid}-t`;
  const descId = `${uid}-d`;

  return (
    <figure className="rvm-chart" data-testid={testId}>
      <figcaption className="sv-vh">{title}</figcaption>
      <div ref={box} className="rvm-chart__box">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-labelledby={`${titleId} ${descId}`}
          className="rvm-chart__svg"
          width={W}
          height={H}
        >
          <title id={titleId}>{title}</title>
          <desc id={descId}>{summary}</desc>
          <line
            className="rvm-chart__grid"
            x1={PAD.left}
            x2={W - PAD.right}
            y1={y(max)}
            y2={y(max)}
          />
          <text className="rvm-chart__label" x={PAD.left - 8} y={y(max) + 4} textAnchor="end">
            {max}
          </text>
          <text className="rvm-chart__label" x={PAD.left - 8} y={y(0) + 4} textAnchor="end">
            0
          </text>
          {bars.map((b, i) => {
            const x = PAD.left + i * slot + (slot - bw) / 2;
            const top = y(b.value + (b.extra ?? 0));
            const base = y(b.value);
            return (
              <g key={`${b.label}-${i}`}>
                {b.value > 0 ? (
                  <rect
                    className="rvm-chart__bar"
                    x={x}
                    y={base}
                    width={bw}
                    height={y(0) - base}
                    rx={b.extra ? 0 : r}
                  />
                ) : null}
                {b.extra && b.extra > 0 ? (
                  <rect
                    className="rvm-chart__bar rvm-chart__bar--extra"
                    x={x}
                    y={top}
                    width={bw}
                    height={base - top}
                    rx={r}
                  />
                ) : null}
                {(tickFromEnd ? last - i : i) % step === 0 ? (
                  // The first and last labels hug the edges so they are never cut off.
                  <text
                    className="rvm-chart__label"
                    x={i === 0 ? x : i === last ? x + bw : x + bw / 2}
                    y={H - 8}
                    textAnchor={i === 0 ? 'start' : i === last ? 'end' : 'middle'}
                  >
                    {b.tick ?? b.label}
                  </text>
                ) : null}
              </g>
            );
          })}
          <line className="rvm-chart__axis" x1={PAD.left} x2={W - PAD.right} y1={y(0)} y2={y(0)} />
        </svg>
      </div>
      <div className="rvm-chart__foot">
        <span className="rvm-legend">
          <span className="rvm-swatch" aria-hidden="true" /> {valueLabel}
        </span>
        {extraLabel ? (
          <span className="rvm-legend">
            <span className="rvm-swatch rvm-swatch--extra" aria-hidden="true" /> {extraLabel}
          </span>
        ) : null}
      </div>
      <TableToggle>
        <div className="rv-tablewrap" tabIndex={0} role="region" aria-label={`${title}: table`}>
          <table className="rv-table" data-testid={tableTestId}>
            <caption className="sv-sr">{title}</caption>
            <thead>
              <tr>
                <th scope="col">{categoryLabel}</th>
                <th scope="col">{valueLabel}</th>
                {extraLabel ? <th scope="col">{extraLabel}</th> : null}
                {columns ? <th scope="col">{columns.header}</th> : null}
              </tr>
            </thead>
            <tbody>
              {bars.map((b, i) => (
                <tr key={`${b.label}-${i}`}>
                  <th scope="row">{b.label}</th>
                  <td>{b.value}</td>
                  {extraLabel ? <td>{b.extra ?? 0}</td> : null}
                  {columns ? <td>{columns.cells[i]}</td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </TableToggle>
    </figure>
  );
}

/** The table view of a chart, one click away. */
export function TableToggle({ children }: { children: ReactNode }) {
  return (
    <details className="rvm-table-toggle">
      <summary>
        <Table aria-hidden="true" strokeWidth={2.4} />
        Show as table
      </summary>
      {children}
    </details>
  );
}

export type ShareTone = 'danger' | 'warning' | 'success' | 'violet';

/** A labelled horizontal share bar (one row per category) with the numbers in text. */
export function ShareBars({
  title,
  rows,
  testId,
}: {
  title: string;
  rows: readonly {
    label: string;
    count: number;
    share: number | null;
    icon?: LucideIcon;
    tone?: ShareTone;
  }[];
  testId?: string;
}) {
  return (
    <figure className="rvm-chart" data-testid={testId}>
      <figcaption className="rvm-line">{title}</figcaption>
      <ul className="rv-shares">
        {rows.map(({ label, count, share, icon: Icon, tone }) => (
          <li key={label} className={`rv-share${tone ? ` rvm-tone--${tone}` : ''}`}>
            <span className="rv-share__label">
              {Icon ? <Icon aria-hidden="true" strokeWidth={2.6} /> : null}
              {label}
            </span>
            <span className="rv-share__track" aria-hidden="true">
              <span className="rv-share__fill" style={{ width: `${(share ?? 0) * 100}%` }} />
            </span>
            <span className="rv-share__value">
              {share === null ? 'n/a' : `${Math.round(share * 100)}%`} ({count})
            </span>
          </li>
        ))}
      </ul>
    </figure>
  );
}
