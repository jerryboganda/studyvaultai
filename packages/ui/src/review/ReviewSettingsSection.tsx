import { useId, useMemo, useState } from 'react';
import {
  ArrowDownWideNarrow,
  Brain,
  ChevronRight,
  CircleAlert,
  Clock,
  Globe,
  Layers,
  Shuffle,
  Sunrise,
  Target,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { isValidTimeZone, studyDayKey, studyDayNumber, studyDayStartMs } from '@study';
import { listDecks } from '@storage';
import { Button } from '../Button';
import { ChoiceCards, InfoTip, VaultBuddy, type Choice, type Tone } from '../design';
import { InlineNotice } from '../Notice';
import { useObserved } from '../hooks';
import { errorMessage } from '../text';
import './review.css';
import './manage.css';
import { DeckSettingsForm, PRESET_CHOICES, presetOf } from './DeckSettingsForm';
import { useStudySettings } from './hooks';
import { formatWhen, toDraft } from './model';
import { deviceTimeZone, toBoundary, type StudySettings } from './settings';
import { TID, deckSettingsId } from './testids';

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const hourLabel = (h: number) => `${String(h).padStart(2, '0')}:00`;

const ORDER_CHOICES: Choice<StudySettings['order']>[] = [
  {
    value: 'retrievability',
    label: 'Most forgotten',
    hint: 'Weakest first',
    icon: Brain,
    tone: 'violet',
  },
  { value: 'due', label: 'Oldest due', hint: 'By due date', icon: Clock, tone: 'primary' },
];

function zoneList(): string[] {
  try {
    const fn = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] })
      .supportedValuesOf;
    return fn ? fn('timeZone') : [];
  } catch {
    return [];
  }
}

/** Card head: icon tile, title of <= 3 words, optional (i). */
function Head({
  icon: Icon,
  tone,
  title,
  id,
  tip,
}: {
  icon: LucideIcon;
  tone: Tone;
  title: string;
  id: string;
  tip?: string;
}) {
  return (
    <div className="rvm-card__head">
      <span className={`rvm-art sv-art--${tone}`} aria-hidden="true">
        <Icon strokeWidth={2.4} />
      </span>
      <h3 id={id}>{title}</h3>
      {tip ? <InfoTip label={`About ${title.toLowerCase()}`}>{tip}</InfoTip> : null}
    </div>
  );
}

/**
 * Where the study day starts and how the queue is ordered. Saved under the `studySettings` key
 * (not in the shared Settings), validated before it is written.
 */
export function StudyDaySettings({ nowMs }: { nowMs?: number }) {
  const uid = useId();
  const { settings, error, retry, update } = useStudySettings();
  const [draft, setDraft] = useState<StudySettings | null>(null);
  const [state, setState] = useState<{ busy: boolean; error: string | null; saved: boolean }>({
    busy: false,
    error: null,
    saved: false,
  });
  const zoneOptions = useMemo(() => zoneList().map((z) => <option key={z} value={z} />), []);
  const [loadedAt] = useState(() => Date.now());
  const form = draft ?? settings;

  if (error) {
    return (
      <InlineNotice
        tone="error"
        title="Study settings could not be read"
        action={<Button onClick={retry}>Retry</Button>}
      >
        {error}
      </InlineNotice>
    );
  }
  if (!form || !settings) {
    return (
      <p className="rvm-loading" role="status">
        <VaultBuddy pose="think" size={40} />
        Loading study settings…
      </p>
    );
  }

  const zoneOk = isValidTimeZone(form.timeZone.trim());
  const dirty = JSON.stringify(form) !== JSON.stringify(settings);
  const disabledReason = !zoneOk
    ? 'Enter a time zone name such as Europe/Berlin or America/New_York.'
    : !dirty
      ? 'There are no changes to save.'
      : undefined;
  const edit = (patch: Partial<StudySettings>) => {
    setDraft({ ...form, ...patch });
    setState((s) => ({ ...s, saved: false }));
  };

  let preview: string | null = null;
  if (zoneOk) {
    const boundary = toBoundary({ ...form, timeZone: form.timeZone.trim() });
    const at = nowMs ?? loadedAt;
    const day = studyDayNumber(at, boundary);
    preview = `It is study day ${studyDayKey(day)} now; the next one starts ${formatWhen(
      new Date(studyDayStartMs(day + 1, boundary)).toISOString(),
      boundary.timeZone,
    )}.`;
  }

  const save = async () => {
    if (disabledReason) return;
    setState({ busy: true, error: null, saved: false });
    try {
      await update((current) => ({
        ...current,
        ...form,
        timeZone: form.timeZone.trim(),
      }));
      setDraft(null);
      setState({ busy: false, error: null, saved: true });
    } catch (err) {
      setState({ busy: false, error: errorMessage(err), saved: false });
    }
  };

  const id = (name: string) => `${uid}-${name}`;
  return (
    <form
      className="rvm-card"
      data-testid={TID.studyDay}
      aria-label="Study day and queue order"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <Head
        icon={Sunrise}
        tone="sun"
        title="Study day"
        id={id('h')}
        tip="Reviews after midnight but before the start hour count for the day before, and daily limits reset at that hour. Cards already scheduled keep their due dates."
      />
      <div className="rvm-row">
        <div className="sv-field">
          <label className="sv-label" htmlFor={id('rollover')}>
            Day starts at
          </label>
          <select
            id={id('rollover')}
            className="sv-control"
            data-testid={TID.rollover}
            value={form.rolloverHour}
            onChange={(e) => edit({ rolloverHour: Number(e.target.value) })}
          >
            {HOURS.map((h) => (
              <option key={h} value={h}>
                {hourLabel(h)}
              </option>
            ))}
          </select>
        </div>
        <div className="sv-field">
          <label className="sv-label" htmlFor={id('tz')}>
            Time zone
          </label>
          <input
            id={id('tz')}
            className="sv-control"
            list={id('zones')}
            value={form.timeZone}
            data-testid={TID.timeZone}
            aria-invalid={zoneOk ? undefined : true}
            aria-describedby={zoneOk ? undefined : `${id('tz')}-error`}
            onChange={(e) => edit({ timeZone: e.target.value })}
          />
          <datalist id={id('zones')}>{zoneOptions}</datalist>
          {zoneOk ? null : (
            <p id={`${id('tz')}-error`} className="rvm-fielderr">
              <CircleAlert aria-hidden="true" strokeWidth={2.6} />
              That is not a time zone name Chrome knows.
            </p>
          )}
        </div>
        <Button
          onClick={() => edit({ timeZone: deviceTimeZone() })}
          disabledReason={
            form.timeZone.trim() === deviceTimeZone()
              ? 'This is already the time zone of this device.'
              : undefined
          }
        >
          <Globe aria-hidden="true" width={18} height={18} /> Use this device
        </Button>
      </div>
      {preview ? <p className="rvm-line">{preview}</p> : null}

      <Head icon={ArrowDownWideNarrow} tone="violet" title="Card order" id={id('o')} />
      <ChoiceCards
        labelledBy={id('o')}
        options={ORDER_CHOICES}
        value={form.order}
        onChange={(order) => edit({ order })}
        columns={2}
      />
      <details className="rvm-disclosure">
        <summary>
          <ChevronRight className="rvm-chev" aria-hidden="true" strokeWidth={2.6} />
          More options
        </summary>
        <div className="rvm-disclosure__body">
          <div className="rvm-advgrid">
            <div className="sv-field">
              <span className="rvm-label">
                <label className="sv-label" htmlFor={id('interleave')}>
                  Mix decks
                </label>
                <InfoTip label="About mixing decks">
                  How cards from several decks are interleaved when you study more than one.
                </InfoTip>
              </span>
              <select
                id={id('interleave')}
                className="sv-control"
                value={form.interleave}
                onChange={(e) =>
                  edit({ interleave: e.target.value as StudySettings['interleave'] })
                }
              >
                <option value="deck">Spread evenly across decks</option>
                <option value="bank">Spread evenly across banks</option>
                <option value="none">Keep one list</option>
              </select>
            </div>
            <div className="sv-field">
              <label className="sv-label" htmlFor={id('newOrder')}>
                New card order
              </label>
              <select
                id={id('newOrder')}
                className="sv-control"
                value={form.newOrder}
                onChange={(e) => edit({ newOrder: e.target.value as StudySettings['newOrder'] })}
              >
                <option value="created">Oldest first</option>
                <option value="random">Shuffled</option>
              </select>
            </div>
            <div className="sv-field">
              <span className="rvm-label">
                <label className="sv-label" htmlFor={id('ahead')}>
                  Learn ahead
                </label>
                <InfoTip label="About learning ahead">
                  When nothing else is left, a learning step due within this many minutes is shown
                  now instead of waiting. 0 to 120.
                </InfoTip>
              </span>
              <span className="rvm-unit">
                <input
                  id={id('ahead')}
                  className="sv-control"
                  inputMode="numeric"
                  value={form.learnAheadMinutes}
                  onChange={(e) => {
                    const n = Number(e.target.value.replace(/\D/g, ''));
                    edit({ learnAheadMinutes: Math.min(120, Number.isFinite(n) ? n : 0) });
                  }}
                />
                <span aria-hidden="true">min</span>
              </span>
            </div>
          </div>
          <p className="rvm-line">
            <Shuffle aria-hidden="true" width={14} height={14} /> Most forgotten uses the memory
            model&rsquo;s estimate.
          </p>
        </div>
      </details>
      {state.error ? (
        <InlineNotice tone="error" title="Not saved">
          {state.error}
        </InlineNotice>
      ) : null}
      {state.saved ? (
        <InlineNotice tone="success" live>
          Saved.
        </InlineNotice>
      ) : null}
      <div className="rvm-row">
        <Button
          variant="primary"
          type="submit"
          busy={state.busy}
          data-testid={TID.studyDaySave}
          disabledReason={disabledReason}
        >
          Save
        </Button>
      </div>
    </form>
  );
}

/** One expandable rules form per deck, with its pace as chips in the summary. */
export function DeckOptions() {
  const decks = useObserved(() => listDecks(), []);
  if (decks.error) {
    return (
      <InlineNotice
        tone="error"
        title="Decks could not be read"
        action={decks.retryable ? <Button onClick={decks.refresh}>Retry</Button> : undefined}
      >
        {decks.error}
      </InlineNotice>
    );
  }
  if (decks.loading) {
    return (
      <p className="rvm-loading" role="status">
        <VaultBuddy pose="think" size={40} />
        Loading decks…
      </p>
    );
  }
  const list = decks.data ?? [];
  if (list.length === 0) {
    return (
      <div className="sv-emptystate">
        <VaultBuddy pose="sleep" size={96} />
        <h4 className="sv-emptystate__title">No decks yet</h4>
        <p className="sv-emptystate__text">Your first card makes one.</p>
      </div>
    );
  }
  return (
    <ul className="rvm-decks">
      {list.map((deck) => {
        const pace = PRESET_CHOICES.find((p) => p.value === presetOf(toDraft(deck.settings)));
        const PaceIcon = pace?.icon;
        return (
          <li key={deck.id}>
            <details
              className="rv-details rvm-disclosure"
              data-testid={deckSettingsId(`${deck.id}-details`)}
            >
              <summary>
                <ChevronRight className="rvm-chev" aria-hidden="true" strokeWidth={2.6} />
                <span className="rv-details__name">{deck.name}</span>
                <span className="rvm-badges">
                  {pace ? (
                    <span className="rvm-badge rvm-badge--primary">
                      {PaceIcon ? <PaceIcon aria-hidden="true" strokeWidth={2.6} /> : null}
                      {pace.label}
                    </span>
                  ) : null}
                  <span className="rvm-badge">{deck.settings.newPerDay} new</span>
                  <span className="rvm-badge rvm-badge--success">
                    <Target aria-hidden="true" strokeWidth={2.6} />
                    {Math.round(deck.settings.targetRetention * 100)}% target
                  </span>
                </span>
              </summary>
              <div className="rvm-disclosure__body">
                <DeckSettingsForm key={deck.id} deck={deck} />
              </div>
            </details>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The review section of the options page: the study day, queue order and per-deck rules.
 * Self-contained: it reads and writes its own settings and decks.
 */
export function ReviewSettingsSection() {
  return (
    <section
      className="rvm"
      aria-labelledby="rv-settings-heading"
      data-testid={TID.settingsSection}
    >
      <div className="rvm-card__head">
        <h2 id="rv-settings-heading">Review settings</h2>
        <InfoTip label="About review settings">
          These settings stay on this device. Nothing here needs an account or the internet.
        </InfoTip>
      </div>
      <StudyDaySettings />
      <section className="rvm-card" aria-labelledby="rv-deck-rules">
        <Head
          icon={Layers}
          tone="primary"
          title="Deck pace"
          id="rv-deck-rules"
          tip="Each deck has its own pace. A preset sets the target, new cards and reviews per day; Advanced holds every number."
        />
        <DeckOptions />
      </section>
    </section>
  );
}
