import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { CalendarDays, Snowflake, Table } from 'lucide-react';
import { IconButton } from './Buttons';

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const STEP: Record<string, number> = { ArrowRight: 7, ArrowLeft: -7, ArrowDown: 1, ArrowUp: -1 };

/** 0 = no activity, 1 < half the goal, 2 < goal, 3 < 1.5x goal, 4 = well past it. */
export const heatLevel = (xp: number, goal: number) =>
  xp <= 0 ? 0 : xp < goal / 2 ? 1 : xp < goal ? 2 : xp < goal * 1.5 ? 3 : 4;

export type HeatmapProps = {
  /** XP per day, oldest first; the last entry is `end` (today). */
  days: number[];
  goal: number;
  title: string;
  /** Indexes into `days` of the days a streak freeze saved (shown with a snowflake). */
  frozen?: number[];
  end?: Date;
  locale?: string;
};

type Tip = { i: number; x: number; y: number; end: boolean };

/**
 * Streak calendar: weeks as columns, Monday-first rows. A keyboard grid (arrows move by day and
 * week, Home/End) whose cells name their date and XP; focus or hover shows a tooltip that Escape
 * dismisses (WCAG 1.4.13). The table button swaps in the same numbers as a data table.
 *
 * Cells shrink to 14px in a narrow card, under the 24px of WCAG 2.5.8; that is covered by its
 * "equivalent" exception: the table view (a 32px button) gives the same information.
 */
export function Heatmap({
  days,
  goal,
  title,
  frozen = [],
  end = new Date(),
  locale,
}: HeatmapProps) {
  const [asTable, setAsTable] = useState(false);
  const [focusAt, setFocus] = useState(days.length - 1);
  const [tip, setTip] = useState<Tip | null>(null);
  const cells = useRef(new Map<number, HTMLElement>());
  const body = useRef<HTMLDivElement>(null);
  const captionId = useId();

  // Escape hides the tip wherever focus is (it may be shown by hover alone), and stops there.
  useEffect(() => {
    if (!tip) return undefined;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setTip(null);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [tip]);

  const n = days.length;
  const focus = Math.min(focusAt, n - 1);
  const isFrozen = (i: number) => frozen.includes(i);
  const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - (n - 1));
  const offset = (start.getDay() + 6) % 7; // Monday = 0
  const weeks = Math.ceil((offset + n) / 7);
  const dateOf = (i: number) =>
    new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
  const fmt = new Intl.DateTimeFormat(locale, { weekday: 'short', month: 'short', day: 'numeric' });
  const short = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' });
  const describe = (i: number) =>
    `${fmt.format(dateOf(i))}: ${days[i]} XP${days[i]! >= goal ? ', goal met' : ''}${isFrozen(i) ? ', freeze used' : ''}${i === n - 1 ? ', today' : ''}`;
  const active = days.filter((d) => d > 0).length;
  const met = days.filter((d) => d >= goal).length;
  const summary = `${title}: active ${active} of ${n} days, goal met on ${met}.`;

  const show = (i: number) => {
    const el = cells.current.get(i);
    if (!el || !body.current) return;
    // Rects, not offsets: they already account for the calendar's horizontal scroll.
    const cell = el.getBoundingClientRect();
    const box = body.current.getBoundingClientRect();
    const x = cell.left - box.left + cell.width / 2;
    // Anchor the tip on the side with room so it never leaves the card.
    setTip({ i, x, y: cell.top - box.top, end: x > box.width / 2 });
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const next =
      e.key in STEP ? focus + STEP[e.key]! : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
    if (!(e.key in STEP) && next < 0) return;
    e.preventDefault();
    if (next < 0 || next >= n) return;
    setFocus(next);
    cells.current.get(next)?.focus();
  };

  return (
    <div className="sv-heat">
      <div className="sv-heat__head">
        <span className="sv-heat__sum">
          <strong>{active}</strong> active days
        </span>
        <IconButton
          icon={asTable ? CalendarDays : Table}
          label={asTable ? 'Show calendar' : 'Show as table'}
          size="sm"
          tipSide="left"
          aria-pressed={asTable}
          onClick={() => setAsTable(!asTable)}
        />
      </div>
      {asTable ? (
        <div className="sv-heat__tableWrap" tabIndex={0} role="region" aria-labelledby={captionId}>
          <table className="sv-heat__table">
            <caption id={captionId}>{summary} XP per day.</caption>
            <thead>
              <tr>
                <th scope="col">Week of</th>
                {WEEKDAYS.map((d) => (
                  <th key={d} scope="col">
                    <abbr title={d}>{d.slice(0, 3)}</abbr>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: weeks }, (_, w) => (
                <tr key={w}>
                  <th scope="row">{short.format(dateOf(w * 7 - offset))}</th>
                  {WEEKDAYS.map((d, r) => {
                    const i = w * 7 + r - offset;
                    if (i < 0 || i >= n) return <td key={d} />;
                    return (
                      <td key={d}>
                        {days[i]}
                        {isFrozen(i) && (
                          <>
                            <Snowflake aria-hidden="true" className="sv-heat__ice" />
                            <span className="sv-vh">, freeze used</span>
                          </>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="sv-heat__body" ref={body} onPointerLeave={() => setTip(null)}>
          <div className="sv-heat__scroll">
            <div role="grid" aria-label={summary} className="sv-heat__grid" onKeyDown={onKeyDown}>
              {WEEKDAYS.map((day, r) => (
                <div role="row" key={day} className="sv-heat__row">
                  <span role="rowheader" className="sv-heat__day">
                    <span aria-hidden="true">{r % 2 === 0 ? day[0] : ''}</span>
                    <span className="sv-vh">{day}</span>
                  </span>
                  {Array.from({ length: weeks }, (_, w) => {
                    const i = w * 7 + r - offset;
                    if (i < 0 || i >= n) {
                      return <span role="gridcell" key={w} className="sv-heat__cell is-blank" />;
                    }
                    const xp = days[i]!;
                    const cls = `sv-heat__cell sv-heat--${heatLevel(xp, goal)}${xp >= goal ? ' is-met' : ''}${i === n - 1 ? ' is-today' : ''}`;
                    return (
                      <span
                        role="gridcell"
                        key={w}
                        ref={(el) => {
                          if (el) cells.current.set(i, el);
                          else cells.current.delete(i);
                        }}
                        className={cls}
                        tabIndex={i === focus ? 0 : -1}
                        aria-label={describe(i)}
                        onFocus={() => {
                          setFocus(i);
                          show(i);
                        }}
                        onBlur={() => setTip((t) => (t?.i === i ? null : t))}
                        onPointerEnter={() => show(i)}
                      >
                        {isFrozen(i) && <Snowflake aria-hidden="true" className="sv-heat__ice" />}
                      </span>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
          {tip && (
            // Visual copy of the focused cell's name; hoverable, inside the pointer area.
            <span
              className={`sv-heat__tip${tip.end ? ' is-end' : ''}`}
              aria-hidden="true"
              style={{ left: tip.x, top: tip.y }}
            >
              {describe(tip.i)}
            </span>
          )}
        </div>
      )}
      <div className="sv-heat__legend" aria-hidden="true">
        <span>Less</span>
        {[0, 1, 2, 3, 4].map((l) => (
          <span key={l} className={`sv-heat__key sv-heat--${l}`} />
        ))}
        <span>More</span>
      </div>
    </div>
  );
}
