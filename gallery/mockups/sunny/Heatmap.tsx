import { useState } from 'react';
import { CalendarDays, Table } from 'lucide-react';
import { IconButton } from './ui';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const level = (xp: number, goal: number) =>
  xp === 0 ? 0 : xp < goal / 2 ? 1 : xp < goal ? 2 : xp < goal * 1.5 ? 3 : 4;

/** Streak calendar: weeks as columns, days as rows. SVG with a table fallback toggle. */
export function Heatmap({ days, goal, title }: { days: number[]; goal: number; title: string }) {
  const [asTable, setAsTable] = useState(false);
  const weeks = Math.ceil(days.length / 7);
  const cell = 17;
  const gap = 4;
  const active = days.filter((d) => d > 0).length;
  const met = days.filter((d) => d >= goal).length;
  const summary = `${title}: active ${active} of ${days.length} days, goal met on ${met}.`;

  return (
    <div className="sv-heat">
      <div className="sv-row sv-heat__head">
        <span className="sv-heat__sum">
          <strong>{active}</strong> active days
        </span>
        <span className="sv-spacer" />
        <IconButton
          icon={asTable ? CalendarDays : Table}
          label={asTable ? 'Show calendar' : 'Show as table'}
          className="sv-iconbtn--sm"
          tipSide="left"
          onClick={() => setAsTable(!asTable)}
        />
      </div>
      {asTable ? (
        <div
          className="sv-heat__tableWrap"
          tabIndex={0}
          role="region"
          aria-label={`${title} table`}
        >
          <table className="sv-heat__table">
            <caption className="sv-vh">{summary} XP per day.</caption>
            <thead>
              <tr>
                <th scope="col">Week</th>
                {DAYS.map((d) => (
                  <th key={d} scope="col">
                    {d}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: weeks }, (_, w) => (
                <tr key={w}>
                  <th scope="row">{w - weeks + 1 === 0 ? 'This' : `${w - weeks + 1}`}</th>
                  {days.slice(w * 7, w * 7 + 7).map((xp, d) => (
                    <td key={d}>{xp}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <svg
          className="sv-heat__svg"
          viewBox={`0 0 ${weeks * (cell + gap) + 28} ${7 * (cell + gap)}`}
          role="img"
          aria-label={summary}
        >
          {DAYS.map((d, i) =>
            i % 2 === 0 ? (
              <text key={d} x={0} y={i * (cell + gap) + cell - 4} className="sv-heat__day">
                {d.slice(0, 1)}
              </text>
            ) : null,
          )}
          {days.map((xp, i) => {
            const w = Math.floor(i / 7);
            const d = i % 7;
            const today = i === days.length - 1;
            return (
              <rect
                key={i}
                x={28 + w * (cell + gap)}
                y={d * (cell + gap)}
                width={cell}
                height={cell}
                rx={5}
                className={`sv-heat__c sv-heat__c--${level(xp, goal)}${today ? ' is-today' : ''}`}
              />
            );
          })}
        </svg>
      )}
      <div className="sv-row sv-heat__legend" aria-hidden="true">
        <span>Less</span>
        {[0, 1, 2, 3, 4].map((l) => (
          <span key={l} className={`sv-heat__key sv-heat__c--${l}`} />
        ))}
        <span>More</span>
      </div>
    </div>
  );
}
