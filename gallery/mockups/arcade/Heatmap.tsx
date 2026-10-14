// Streak calendar: 12 weeks x 7 days of XP, drawn in SVG, with the same numbers as a table.
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
// Mockup "today" so screenshots are stable: Wednesday 14 October 2026.
const TODAY = new Date(2026, 9, 14);

function level(xp: number): number {
  if (xp <= 0) return 0;
  if (xp < 15) return 1;
  if (xp < 30) return 2;
  if (xp < 50) return 3;
  return 4;
}

const fmt = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' });

export function Heatmap({
  data,
  cell = 16,
  gap = 4,
}: {
  data: number[];
  cell?: number;
  gap?: number;
}) {
  const start = new Date(TODAY);
  start.setDate(TODAY.getDate() - (data.length - 1));
  const startRow = (start.getDay() + 6) % 7;
  const cells = data.map((xp, i) => {
    const pos = i + startRow;
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return { xp, col: Math.floor(pos / 7), row: pos % 7, date: d, today: i === data.length - 1 };
  });
  // Columns are Monday-first weeks; the last one ends on today.
  const cols = (cells.at(-1)?.col ?? 0) + 1;
  const left = 30;
  const w = left + cols * (cell + gap);
  const h = 7 * (cell + gap);
  const rows: (number | null)[][] = Array.from({ length: cols }, () =>
    Array<number | null>(7).fill(null),
  );
  for (const c of cells) {
    const col = rows[c.col];
    if (col) col[c.row] = c.xp;
  }
  return (
    <div className="sv-heat">
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden focusable="false">
        {DAYS.map((d, i) =>
          i % 2 === 0 ? (
            <text key={d} x={0} y={i * (cell + gap) + cell * 0.8} className="sv-heat__day">
              {d}
            </text>
          ) : null,
        )}
        {cells.map((c) => (
          <rect
            key={c.date.toISOString()}
            x={left + c.col * (cell + gap)}
            y={c.row * (cell + gap)}
            width={cell}
            height={cell}
            rx={4}
            className={`sv-heat__cell l${level(c.xp)}${c.today ? ' is-today' : ''}`}
          />
        ))}
      </svg>
      <div className="sv-heat__foot">
        <div className="sv-heat__legend" aria-hidden>
          <span>Less</span>
          {[0, 1, 2, 3, 4].map((l) => (
            <span key={l} className={`sv-heat__swatch l${l}`} />
          ))}
          <span>More</span>
        </div>
        <details className="sv-heat__table">
          <summary>Show as table</summary>
          <table>
            <caption>XP per day, last 12 weeks</caption>
            <thead>
              <tr>
                <th scope="col">Week of</th>
                {DAYS.map((d) => (
                  <th key={d} scope="col">
                    {d}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((week, i) => {
                const monday = new Date(start);
                monday.setDate(start.getDate() - startRow + i * 7);
                return (
                  <tr key={i}>
                    <th scope="row">{fmt.format(monday)}</th>
                    {week.map((xp, j) => (
                      <td key={j}>{xp === null ? '–' : xp}</td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </details>
      </div>
    </div>
  );
}
