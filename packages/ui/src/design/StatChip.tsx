import type { LucideIcon } from 'lucide-react';

export type StatChipProps = {
  icon: LucideIcon;
  value: number | string;
  /** <= 3 words, e.g. "day streak", "freezes". Always read; shown unless hideLabel. */
  label: string;
  tone?: 'flame' | 'ice' | 'sun' | 'primary' | 'neutral';
  hideLabel?: boolean;
  className?: string;
};

/** Icon + number + label (streak flame, freezes, XP). Read as one phrase: "12 day streak". */
export function StatChip({
  icon: Icon,
  value,
  label,
  tone = 'neutral',
  hideLabel,
  className,
}: StatChipProps) {
  return (
    <span className={`sv-stat sv-stat--${tone}${className ? ` ${className}` : ''}`}>
      <Icon aria-hidden="true" className="sv-stat__icon" strokeWidth={2.5} />
      <strong className="sv-stat__value">{value}</strong>
      <span className={hideLabel ? 'sv-vh' : 'sv-stat__label'}> {label}</span>
    </span>
  );
}
