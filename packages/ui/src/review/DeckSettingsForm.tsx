import { useId, useState, type ReactNode } from 'react';
import { ChevronRight, CircleAlert, Coffee, Rocket, SlidersHorizontal, Sprout } from 'lucide-react';
import { DEFAULT_DECK_SETTINGS, type Deck } from '@study';
import { updateDeckSettings } from '@storage';
import { Button } from '../Button';
import { ChoiceCards, InfoTip, type Choice } from '../design';
import { InlineNotice } from '../Notice';
import { errorMessage } from '../text';
import './manage.css';
import {
  parseDraft,
  sameDeckSettings,
  toDraft,
  type DeckSettingsDraft,
  type DeckSettingsErrors,
} from './model';
import { TID, deckSettingsId } from './testids';

export type DeckPreset = 'light' | 'standard' | 'intense' | 'custom';
type PresetValues = Pick<DeckSettingsDraft, 'targetRetentionPct' | 'newPerDay' | 'reviewsPerDay'>;

const standard = toDraft(DEFAULT_DECK_SETTINGS);
/**
 * Presets set only the three numbers people think in (how much to remember, how many new cards,
 * how many reviews); steps, the interval cap, leeches and fuzz stay as they are. Standard is the
 * documented default.
 */
export const DECK_PRESETS: Record<Exclude<DeckPreset, 'custom'>, PresetValues> = {
  light: { targetRetentionPct: '85', newPerDay: '10', reviewsPerDay: '100' },
  standard: {
    targetRetentionPct: standard.targetRetentionPct,
    newPerDay: standard.newPerDay,
    reviewsPerDay: standard.reviewsPerDay,
  },
  intense: { targetRetentionPct: '95', newPerDay: '40', reviewsPerDay: '400' },
};

/** The preset the draft matches, or 'custom'. */
export function presetOf(d: DeckSettingsDraft): DeckPreset {
  const same = (p: PresetValues) =>
    Number(d.targetRetentionPct.trim()) === Number(p.targetRetentionPct) &&
    d.newPerDay.trim() === p.newPerDay &&
    d.reviewsPerDay.trim() === p.reviewsPerDay;
  const hit = (Object.keys(DECK_PRESETS) as (keyof typeof DECK_PRESETS)[]).find((k) =>
    same(DECK_PRESETS[k]),
  );
  return hit ?? 'custom';
}

export const PRESET_CHOICES: Choice<DeckPreset>[] = [
  { value: 'light', label: 'Light', hint: '10 new a day', icon: Coffee, tone: 'success' },
  { value: 'standard', label: 'Standard', hint: '20 new a day', icon: Sprout, tone: 'primary' },
  { value: 'intense', label: 'Intense', hint: '40 new a day', icon: Rocket, tone: 'violet' },
  {
    value: 'custom',
    label: 'Custom',
    hint: 'Your numbers',
    icon: SlidersHorizontal,
    tone: 'neutral',
  },
];

function Field({
  id,
  label,
  tip,
  unit,
  error,
  children,
}: {
  id: string;
  label: string;
  tip: string;
  unit?: string;
  error: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="sv-field">
      <span className="rvm-label">
        <label className="sv-label" htmlFor={id}>
          {label}
        </label>
        <InfoTip label={`About ${label.toLowerCase()}`}>{tip}</InfoTip>
      </span>
      {unit ? (
        <span className="rvm-unit">
          {children}
          <span aria-hidden="true">{unit}</span>
        </span>
      ) : (
        children
      )}
      {error ? (
        <p id={`${id}-error`} className="rvm-fielderr">
          <CircleAlert aria-hidden="true" strokeWidth={2.6} />
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Scheduling rules of one deck: a preset as picture cards, the raw numbers under "Advanced". Every
 * field validates before saving; the new rules apply from the next answer on (stored cards and due
 * dates are not rewritten).
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
  const preset = presetOf(draft);
  const [advanced, setAdvanced] = useState(() => presetOf(toDraft(deck.settings)) === 'custom');
  const changed = parsed.ok ? !sameDeckSettings(parsed.value, deck.settings) : true;
  const set = <K extends keyof DeckSettingsDraft>(key: K, value: DeckSettingsDraft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setState((s) => ({ ...s, saved: false }));
  };
  const id = (name: string) => `${uid}-${name}`;

  const disabledReason = !parsed.ok
    ? 'Fix the fields marked in red first.'
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

  const input = (name: keyof Omit<DeckSettingsDraft, 'enableFuzz'>, decimal = false) => (
    <input
      id={id(name)}
      className="sv-control"
      inputMode={decimal ? 'decimal' : 'numeric'}
      value={draft[name]}
      aria-invalid={errors[name] ? true : undefined}
      aria-describedby={errors[name] ? `${id(name)}-error` : undefined}
      onChange={(e) => set(name, e.target.value)}
    />
  );

  return (
    <form
      className="rvm-fields"
      data-testid={deckSettingsId(deck.id)}
      aria-label={`Settings of deck ${deck.name}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (!disabledReason) void save();
      }}
    >
      {/* A click on Custom opens Advanced even when Custom is already the checked card. */}
      <div
        onClick={(e) => {
          if ((e.target as HTMLInputElement).value === 'custom') setAdvanced(true);
        }}
      >
        <ChoiceCards
          label="Pace"
          options={PRESET_CHOICES}
          value={preset}
          columns={4}
          onChange={(next) => {
            if (next === 'custom') {
              setAdvanced(true);
              return;
            }
            setDraft((d) => ({ ...d, ...DECK_PRESETS[next] }));
            setState((s) => ({ ...s, saved: false }));
          }}
        />
      </div>
      <details
        className="rvm-disclosure"
        open={advanced}
        onToggle={(e) => setAdvanced(e.currentTarget.open)}
      >
        <summary>
          <ChevronRight className="rvm-chev" aria-hidden="true" strokeWidth={2.6} />
          <SlidersHorizontal aria-hidden="true" width={18} height={18} />
          Advanced
        </summary>
        <div className="rvm-disclosure__body">
          <div className="rvm-advgrid">
            <Field
              id={id('targetRetentionPct')}
              label="Target retention"
              unit="%"
              tip="How many cards you still remember when they come due. Higher means more reviews. 90 is the usual balance; 70 to 99 is allowed."
              error={errors.targetRetentionPct}
            >
              {input('targetRetentionPct', true)}
            </Field>
            <Field
              id={id('newPerDay')}
              label="New per day"
              tip="The most unseen cards introduced in one study day. 0 stops new cards."
              error={errors.newPerDay}
            >
              {input('newPerDay')}
            </Field>
            <Field
              id={id('reviewsPerDay')}
              label="Reviews per day"
              tip="The most reviews of learned cards in one study day. Cards over the cap stay due and are reported, never dropped."
              error={errors.reviewsPerDay}
            >
              {input('reviewsPerDay')}
            </Field>
            <Field
              id={id('maxIntervalDays')}
              label="Max interval"
              unit="days"
              tip="The longest wait between two reviews. 36500 is effectively no limit."
              error={errors.maxIntervalDays}
            >
              {input('maxIntervalDays')}
            </Field>
            <Field
              id={id('learningSteps')}
              label="Learning steps"
              tip="Delays a new card goes through before it graduates, for example 1m 10m. Use m, h or d."
              error={errors.learningSteps}
            >
              {input('learningSteps')}
            </Field>
            <Field
              id={id('relearnSteps')}
              label="Relearning steps"
              tip="Delays after you forget a learned card. Empty sends it straight back to review."
              error={errors.relearnSteps}
            >
              {input('relearnSteps')}
            </Field>
            <Field
              id={id('leechThreshold')}
              label="Leech threshold"
              tip="A card forgotten this many times is suspended and tagged leech so you can rewrite it. It repeats every half that many lapses after."
              error={errors.leechThreshold}
            >
              {input('leechThreshold')}
            </Field>
          </div>
          <span className="rvm-label">
            <label className="sv-check">
              <input
                type="checkbox"
                className="sv-switch"
                checked={draft.enableFuzz}
                onChange={(e) => set('enableFuzz', e.target.checked)}
              />
              <span className="sv-label">Spread due dates</span>
            </label>
            <InfoTip label="About spreading due dates">
              Moves long intervals by a few percent so cards made together do not all return on the
              same day. Off means exact intervals.
            </InfoTip>
          </span>
        </div>
      </details>
      {state.error ? (
        <InlineNotice tone="error" title="Not saved">
          {state.error}
        </InlineNotice>
      ) : null}
      {state.saved ? (
        <InlineNotice tone="success" live>
          Saved. The new rules apply from the next answer.
        </InlineNotice>
      ) : null}
      <div className="rvm-row">
        <Button
          variant="primary"
          type="submit"
          busy={state.busy}
          data-testid={TID.deckSettingsSave}
          disabledReason={disabledReason}
        >
          Save deck
        </Button>
        <Button
          data-testid={TID.deckSettingsReset}
          onClick={() => {
            setDraft(toDraft(DEFAULT_DECK_SETTINGS));
            setState((s) => ({ ...s, saved: false }));
          }}
        >
          Use defaults
        </Button>
        {/* "No changes" is what the dimmed button says; only a problem to fix gets a line. */}
        {!parsed.ok ? <span className="rvm-fielderr">{disabledReason}</span> : null}
      </div>
    </form>
  );
}
