import { useId } from 'react';
import type { Settings } from '@shared';
import { ReviewSettingsSection } from '@ui/review';
import { Toggle, useWriter, type Update } from './Preferences';

/**
 * The review section: the on/off switch for flashcard review (`features.review`), and while it is
 * on, the study day and per-deck rules. While it is off nothing in the review settings is queried.
 */
export function ReviewSection({ settings, update }: { settings: Settings; update: Update }) {
  const uid = useId();
  const { write, error } = useWriter(update);
  const on = settings.features.review;
  return (
    <div className="sv-stack">
      <section className="sv-stack" aria-labelledby={`${uid}-h`}>
        <h2 id={`${uid}-h`}>Review</h2>
        <p>
          Review turns saved highlights into flashcards and brings each one back just before you
          would forget it. It all happens on this device: no account and no internet connection.
        </p>
        <Toggle
          label="Show review in StudyVault"
          hint="Turn this off if you do not use flashcards: the popup and this page then stop showing due counts and the Start review button. Your cards and review history are kept and come back when you turn it on."
          checked={on}
          onChange={(review) => write((s) => ({ ...s, features: { ...s.features, review } }))}
        />
        {error}
      </section>
      {on ? (
        <ReviewSettingsSection />
      ) : (
        <p className="sv-muted">
          Review is off. Turn it on above to set the study day and deck rules.
        </p>
      )}
    </div>
  );
}
