import { useId, type ReactNode } from 'react';

/**
 * Plain SVG bar chart with a real data table behind it. The chart is a picture of the table: the
 * table is always available (a disclosure), and the SVG carries a text summary, so nothing is
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
  /** Extra table columns, one array of cells per bar. */
  columns?: { header: string; cells: readonly ReactNode[] };
  testId?: string;
  tableTestId?: string;
  /** Show a tick label every n bars. */
  tickEvery?: number;
}

const W = 640;
const H = 168;
const PAD = { top: 12, right: 8, bottom: 28, left: 36 };

export function BarChart({
  title,
  summary,
  bars,
  valueLabel,
  extraLabel,
  columns,
  testId,
  tableTestId,
  tickEvery = 1,
}: BarChartProps) {
  const uid = useId();
  const max = Math.max(1, ...bars.map((b) => b.value + (b.extra ?? 0)));
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const slot = bars.length > 0 ? innerW / bars.length : innerW;
  const bw = Math.max(2, slot * 0.7);
  const y = (v: number) => PAD.top + innerH - (v / max) * innerH;
  const titleId = `${uid}-t`;
  const descId = `${uid}-d`;

  return (
    <figure className="rv-chart" data-testid={testId}>
      <figcaption className="rv-chart__title">{title}</figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-labelledby={`${titleId} ${descId}`}
        className="rv-chart__svg"
        preserveAspectRatio="xMidYMid meet"
      >
        <title id={titleId}>{title}</title>
        <desc id={descId}>{summary}</desc>
        <line className="rv-chart__axis" x1={PAD.left} x2={W - PAD.right} y1={y(0)} y2={y(0)} />
        <line className="rv-chart__grid" x1={PAD.left} x2={W - PAD.right} y1={y(max)} y2={y(max)} />
        <text className="rv-chart__label" x={PAD.left - 6} y={y(max) + 4} textAnchor="end">
          {max}
        </text>
        <text className="rv-chart__label" x={PAD.left - 6} y={y(0) + 4} textAnchor="end">
          0
        </text>
        {bars.map((b, i) => {
          const x = PAD.left + i * slot + (slot - bw) / 2;
          const base = y(b.value);
          return (
            <g key={`${b.label}-${i}`}>
              {b.value > 0 ? (
                <rect className="rv-chart__bar" x={x} y={base} width={bw} height={y(0) - base} />
              ) : null}
              {b.extra && b.extra > 0 ? (
                <rect
                  className="rv-chart__bar rv-chart__bar--extra"
                  x={x}
                  y={y(b.value + b.extra)}
                  width={bw}
                  height={base - y(b.value + b.extra)}
                />
              ) : null}
              {i % tickEvery === 0 ? (
                <text className="rv-chart__label" x={x + bw / 2} y={H - 8} textAnchor="middle">
                  {b.tick ?? b.label}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <p className="sv-small sv-muted rv-chart__legend">
        <span className="rv-swatch" aria-hidden="true" /> {valueLabel}
        {extraLabel ? (
          <>
            {' '}
            <span className="rv-swatch rv-swatch--extra" aria-hidden="true" /> {extraLabel}
          </>
        ) : null}
      </p>
      <details className="rv-details rv-chart__table">
        <summary>Show the data as a table</summary>
        <div className="rv-tablewrap">
          <table className="rv-table" data-testid={tableTestId}>
            <caption className="sv-sr">{title}</caption>
            <thead>
              <tr>
                <th scope="col">Day</th>
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
      </details>
    </figure>
  );
}

/** A labelled horizontal share bar (one row per category) with the numbers in text. */
export function ShareBars({
  title,
  rows,
  testId,
}: {
  title: string;
  rows: readonly { label: string; count: number; share: number | null }[];
  testId?: string;
}) {
  return (
    <figure className="rv-chart" data-testid={testId}>
      <figcaption className="rv-chart__title">{title}</figcaption>
      <ul className="rv-shares">
        {rows.map((r) => (
          <li key={r.label} className="rv-share">
            <span className="rv-share__label">{r.label}</span>
            <span className="rv-share__track" aria-hidden="true">
              <span className="rv-share__fill" style={{ width: `${(r.share ?? 0) * 100}%` }} />
            </span>
            <span className="rv-share__value">
              {r.share === null ? 'n/a' : `${Math.round(r.share * 100)}%`} ({r.count})
            </span>
          </li>
        ))}
      </ul>
    </figure>
  );
}
