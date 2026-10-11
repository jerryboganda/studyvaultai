import { useId, useState, type ReactNode } from 'react';
import { DEFAULT_DECK_SETTINGS, type Deck } from '@study';
import { updateDeckSettings } from '@storage';
import { Button } from '../Button';
import { InlineNotice } from '../Notice';
import { errorMessage } from '../text';
import {
  parseDraft,
  sameDeckSettings,
  toDraft,
  type DeckSettingsDraft,
  type DeckSettingsErrors,
} from './model';
import { TID, deckSettingsId } from './testids';

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint: string;
  error: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="sv-field">
      <label className="sv-label" htmlFor={id}>
        {label}
      </label>
      {children}
      <p id={`${id}-hint`} className="sv-small sv-muted">
        {hint}
      </p>
      {error ? (
        <p id={`${id}-error`} className="sv-small rv-error">
          <span aria-hidden="true">✕ </span>
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Scheduling rules of one deck. Every field says what it does and validates before saving; the new
 * rules apply from the next answer on (stored cards and due dates are not rewritten).
 */
export function DeckSettingsForm({
  deck,
  onSaved,
}: {
  deck: Deck;
  onSaved?: (deck: Deck) => void;
}) {
  const uid = useId();
  const [draft, setDraft] = useState<DeckSettingsDraft>(() => toDraft(deck.settings));
  const [state, setState] = useState<{ busy: boolean; error: string | null; saved: boolean }>({
    busy: false,
    error: null,
    saved: false,
  });
  const parsed = parseDraft(draft);
  const errors: DeckSettingsErrors = parsed.ok ? {} : parsed.errors;
  const changed = parsed.ok ? !sameDeckSettings(parsed.value, deck.settings) : true;
  const set = <K extends keyof DeckSettingsDraft>(key: K, value: DeckSettingsDraft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setState((s) => ({ ...s, saved: false }));
  };
  const id = (name: string) => `${uid}-${name}`;
  const describe = (name: keyof DeckSettingsDraft) =>
    errors[name] ? `${id(name)}-hint ${id(name)}-error` : `${id(name)}-hint`;

  const disabledReason = !parsed.ok
    ? 'Fix the fields marked with a cross first.'
    : !changed
      ? 'There are no changes to save.'
      : undefined;

  const save = async () => {
    if (!parsed.ok) return;
    setState({ busy: true, error: null, saved: false });
    try {
      const next = await updateDeckSettings(deck.id, parsed.value);
      setState({ busy: false, error: null, saved: true });
      onSaved?.(next);
    } catch (err) {
      setState({
        busy: false,
        error: errorMessage(err, 'The settings could not be saved.'),
        saved: false,
      });
    }
  };

  const number = (name: 'newPerDay' | 'reviewsPerDay' | 'maxIntervalDays' | 'leechThreshold') => (
    <input
      id={id(name)}
      className="sv-control"
      inputMode="numeric"
      value={draft[name]}
      aria-invalid={errors[name] ? true : undefined}
      aria-describedby={describe(name)}
      onChange={(e) => set(name, e.target.value)}
    />
  );

  return (
    <form
      className="sv-stack"
      data-testid={deckSettingsId(deck.id)}
      aria-label={`Settings of deck ${deck.name}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (!disabledReason) void save();
      }}
    >
      <div className="rv-grid">
        <Field
          id={id('targetRetentionPct')}
          label="Target retention (%)"
          hint="How many cards you want to still remember when they come due. Higher means more reviews. 90% is the usual balance; 70 to 99 is allowed."
          error={errors.targetRetentionPct}
        >
          <input
            id={id('targetRetentionPct')}
            className="sv-control"
            inputMode="decimal"
            value={draft.targetRetentionPct}
            aria-invalid={errors.targetRetentionPct ? true : undefined}
            aria-describedby={describe('targetRetentionPct')}
            onChange={(e) => set('targetRetentionPct', e.target.value)}
          />
        </Field>
        <Field
          id={id('newPerDay')}
          label="New cards per day"
          hint="The most unseen cards introduced in one study day. 0 stops new cards."
          error={errors.newPerDay}
        >
          {number('newPerDay')}
        </Field>
        <Field
          id={id('reviewsPerDay')}
          label="Reviews per day"
          hint="The most reviews of already-learned cards shown in one study day. Cards over the cap stay due and are reported, never dropped."
          error={errors.reviewsPerDay}
        >
          {number('reviewsPerDay')}
        </Field>
        <Field
          id={id('maxIntervalDays')}
          label="Maximum interval (days)"
          hint="The longest wait between two reviews. 36500 is effectively no limit."
          error={errors.maxIntervalDays}
        >
          {number('maxIntervalDays')}
        </Field>
        <Field
          id={id('learningSteps')}
          label="Learning steps"
          hint="Delays a new card goes through before it graduates, for example 1m 10m. Whole numbers with m (minutes), h (hours) or d (days)."
          error={errors.learningSteps}
        >
          <input
            id={id('learningSteps')}
            className="sv-control"
            value={draft.learningSteps}
            aria-invalid={errors.learningSteps ? true : undefined}
            aria-describedby={describe('learningSteps')}
            onChange={(e) => set('learningSteps', e.target.value)}
          />
        </Field>
        <Field
          id={id('relearnSteps')}
          label="Relearning steps"
          hint="Delays after you forget a graduated card. Leave empty to schedule it straight back into review."
          error={errors.relearnSteps}
        >
          <input
            id={id('relearnSteps')}
            className="sv-control"
            value={draft.relearnSteps}
            aria-invalid={errors.relearnSteps ? true : undefined}
            aria-describedby={describe('relearnSteps')}
            onChange={(e) => set('relearnSteps', e.target.value)}
          />
        </Field>
        <Field
          id={id('leechThreshold')}
          label="Leech threshold"
          hint="A card forgotten this many times is suspended and tagged leech so you can rewrite it; it repeats every half-threshold lapses after that."
          error={errors.leechThreshold}
        >
          {number('leechThreshold')}
        </Field>
      </div>
      <label className="sv-check">
        <input
          type="checkbox"
          checked={draft.enableFuzz}
          aria-describedby={id('fuzz-hint')}
          onChange={(e) => set('enableFuzz', e.target.checked)}
        />
        <span>
          <span className="sv-label">Spread due dates (fuzz)</span>
          <span id={id('fuzz-hint')} className="sv-small sv-muted rv-block">
            Moves long intervals by a few percent so cards made together do not all return on the
            same day. The shift is deterministic for each card. Off means exact intervals.
          </span>
        </span>
      </label>
      {state.error ? (
        <InlineNotice tone="error" title="Not saved">
          {state.error}
        </InlineNotice>
      ) : null}
      {state.saved ? (
        <InlineNotice tone="success" live>
          Saved. The new rules apply from the next answer; cards already scheduled keep their due
          dates.
        </InlineNotice>
      ) : null}
      <div className="sv-row">
        <Button
          variant="primary"
          type="submit"
          busy={state.busy}
          data-testid={TID.deckSettingsSave}
          disabledReason={disabledReason}
        >
          Save deck settings
        </Button>
        <Button
          data-testid={TID.deckSettingsReset}
          onClick={() => {
            setDraft(toDraft(DEFAULT_DECK_SETTINGS));
            setState((s) => ({ ...s, saved: false }));
          }}
        >
          Use the defaults
        </Button>
        {disabledReason ? <span className="sv-small sv-muted">{disabledReason}</span> : null}
      </div>
    </form>
  );
}
