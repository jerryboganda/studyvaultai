import { Layers } from 'lucide-react';
import type { Settings } from '@shared';
import { BuddyEmptyState } from '@ui';
import { ReviewSettingsSection } from '@ui/review';
import { useWriter, type Update } from './Preferences';
import { SettingRow } from './ui';

/**
 * The review section: the on/off switch for flashcard review (`features.review`), and while it is
 * on, the study day and per-deck rules. While it is off nothing in the review settings is queried.
 */
export function ReviewSection({ settings, update }: { settings: Settings; update: Update }) {
  const { write, error } = useWriter(update);
  const on = settings.features.review;
  return (
    <div className="opt-stack">
      <div className="opt-card opt-card--single">
        <SettingRow
          icon={Layers}
          label="Show review"
          hint="Due counts and Start review."
          info="Review brings each card back just before you would forget it, all on this device. Off hides due counts and Start review; your cards and history are kept."
          checked={on}
          onChange={(review) => write((s) => ({ ...s, features: { ...s.features, review } }))}
        />
        {error}
      </div>
      {on ? (
        <ReviewSettingsSection />
      ) : (
        <BuddyEmptyState
          pose="sleep"
          mascotSize={96}
          heading="h2"
          title="Review is off"
          text={
            settings.reminders.on
              ? 'Turn it on for study day settings. Reminders are paused.'
              : 'Turn it on above for study day and deck settings.'
          }
        />
      )}
    </div>
  );
}
