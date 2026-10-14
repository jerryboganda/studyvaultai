import type { LucideIcon } from 'lucide-react';
import { ChunkyButton } from './Buttons';
import { VaultBuddy, type BuddyPose } from './VaultBuddy';

export type EmptyStateProps = {
  pose?: BuddyPose;
  /** <= 3 words. */
  title: string;
  /** One line. */
  text?: string;
  /** One primary action at most. */
  action?: { label: string; onClick: () => void; icon?: LucideIcon };
  heading?: 'h2' | 'h3' | 'h4';
  mascotSize?: number;
  className?: string;
};

/** Illustrated empty state: mascot pose, short title, one line, one primary action. */
export function EmptyState({
  pose = 'sleep',
  title,
  text,
  action,
  heading: Heading = 'h3',
  mascotSize = 120,
  className,
}: EmptyStateProps) {
  return (
    <div className={`sv-emptystate${className ? ` ${className}` : ''}`}>
      <VaultBuddy pose={pose} size={mascotSize} />
      <Heading className="sv-emptystate__title">{title}</Heading>
      {text && <p className="sv-emptystate__text">{text}</p>}
      {action && (
        <ChunkyButton variant="primary" icon={action.icon} onClick={action.onClick}>
          {action.label}
        </ChunkyButton>
      )}
    </div>
  );
}
