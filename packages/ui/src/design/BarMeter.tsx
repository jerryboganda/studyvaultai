export type BarMeterProps = {
  value: number;
  max: number;
  /** Accessible name, e.g. "Level 7" or "Cardiology mastered". */
  label: string;
  /** Spoken value when the numbers alone are unclear, e.g. "340 of 500 XP". */
  valueText?: string;
  tone?: 'sun' | 'primary' | 'success' | 'violet';
  size?: 'sm' | 'md' | 'lg';
  className?: string;
};

/** Level bar / bank progress. Zero is drawn empty: no stub that would read as progress. */
export function BarMeter({
  value,
  max,
  label,
  valueText,
  tone = 'primary',
  size = 'md',
  className,
}: BarMeterProps) {
  const clamped = Math.min(Math.max(value, 0), Math.max(max, 0));
  const pct = max > 0 ? Math.round((clamped / max) * 100) : 0;
  return (
    <div
      className={`sv-meter sv-meter--${tone} sv-meter--${size}${className ? ` ${className}` : ''}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={clamped}
      aria-valuetext={valueText}
      data-empty={pct === 0 ? '' : undefined}
    >
      <div className="sv-meter__fill" style={{ width: `${pct}%` }} />
    </div>
  );
}
