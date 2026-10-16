import { useId, type ReactNode } from 'react';
import { Check } from 'lucide-react';

export type ProgressRingProps = {
  value: number;
  max: number;
  /** What is measured, e.g. "Daily goal"; the accessible name adds "18 of 30 XP". */
  label: string;
  unit?: string;
  size?: number;
  stroke?: number;
  tone?: 'sun' | 'primary' | 'success';
  /** Optional longer explanation, read as the description (visually hidden). */
  description?: string;
  /** Centre content (visual only; the accessible name already carries the numbers). */
  children?: ReactNode;
  className?: string;
};

/**
 * Goal ring. The yellow arc sits on a darker --sv-sun-line arc so its boundary keeps 3:1 against
 * the track and the card (WCAG 1.4.11); zero draws no arc at all (a round cap would leave a dot).
 * At or past the goal the ring stays full and gains a check badge; the number keeps counting.
 */
export function ProgressRing({
  value,
  max,
  label,
  unit = '',
  size = 64,
  stroke = 8,
  tone = 'sun',
  description,
  children,
  className,
}: ProgressRingProps) {
  const descId = useId();
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const centre = size / 2;
  const done = max > 0 && value >= max;
  const name = `${label}: ${value} of ${max}${unit ? ` ${unit}` : ''}${done ? ', done' : ''}`;
  const arcs = tone === 'sun' ? (['edge', 'value'] as const) : (['value'] as const);
  return (
    <div
      className={`sv-ring sv-ring--${tone}${className ? ` ${className}` : ''}`}
      role="img"
      aria-label={name}
      aria-describedby={description ? descId : undefined}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle className="sv-ring__track" cx={centre} cy={centre} r={r} strokeWidth={stroke} />
        {pct > 0 &&
          arcs.map((part) => (
            <circle
              key={part}
              className={`sv-ring__${part}`}
              cx={centre}
              cy={centre}
              r={r}
              strokeWidth={part === 'value' && tone === 'sun' ? stroke - 3 : stroke}
              strokeDasharray={`${c * pct} ${c}`}
              transform={`rotate(-90 ${centre} ${centre})`}
            />
          ))}
      </svg>
      {done && (
        <span className="sv-ring__done" aria-hidden="true">
          <Check strokeWidth={3.5} />
        </span>
      )}
      {children !== undefined && (
        <div className="sv-ring__center" aria-hidden="true">
          {children}
        </div>
      )}
      {description && (
        <span id={descId} className="sv-vh">
          {description}
        </span>
      )}
    </div>
  );
}
