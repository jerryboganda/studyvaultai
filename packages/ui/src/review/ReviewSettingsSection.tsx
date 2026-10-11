import { useId, useMemo, useState } from 'react';
import { isValidTimeZone, studyDayKey, studyDayNumber, studyDayStartMs } from '@study';
import { listDecks } from '@storage';
import { Button } from '../Button';
import { InlineNotice } from '../Notice';
import { useObserved } from '../hooks';
import { errorMessage } from '../text';
import './review.css';
import { DeckSettingsForm } from './DeckSettingsForm';
import { useStudySettings } from './hooks';
import { formatWhen } from './model';
import { deviceTimeZone, toBoundary, type StudySettings } from './settings';
import { TID, deckSettingsId } from './testids';

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const hourLabel = (h: number) => `${String(h).padStart(2, '0')}:00`;

function zoneList(): string[] {
  try {
    const fn = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] })
      .supportedValuesOf;
    return fn ? fn('timeZone') : [];
  } catch {
    return [];
  }
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
  if (!form || !settings) return <p className="sv-muted">Loading study settings…</p>;

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
    preview = `With these settings it is study day ${studyDayKey(day)} now; the next one starts ${formatWhen(
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
      className="sv-stack"
      data-testid={TID.studyDay}
      aria-label="Study day and queue order"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="rv-grid">
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
            aria-describedby={`${id('tz')}-hint`}
            onChange={(e) => edit({ timeZone: e.target.value })}
          />
          <datalist id={id('zones')}>{zoneOptions}</datalist>
          <p id={`${id('tz')}-hint`} className="sv-small sv-muted">
            The IANA time zone your study day is measured in. This device reports {deviceTimeZone()}
            .{' '}
            <button
              type="button"
              className="rv-linkbtn"
              onClick={() => edit({ timeZone: deviceTimeZone() })}
            >
              Use the device time zone
            </button>
          </p>
          {zoneOk ? null : (
            <p className="sv-small rv-error">
              <span aria-hidden="true">✕ </span>
              That is not a time zone name Chrome knows.
            </p>
          )}
        </div>
        <div className="sv-field">
          <label className="sv-label" htmlFor={id('rollover')}>
            Study day starts at
          </label>
          <select
            id={id('rollover')}
            className="sv-control"
            data-testid={TID.rollover}
            value={form.rolloverHour}
            aria-describedby={`${id('rollover')}-hint`}
            onChange={(e) => edit({ rolloverHour: Number(e.target.value) })}
          >
            {HOURS.map((h) => (
              <option key={h} value={h}>
                {hourLabel(h)}
              </option>
            ))}
          </select>
          <p id={`${id('rollover')}-hint`} className="sv-small sv-muted">
            Reviewing after midnight but before this hour counts for the previous day, and daily
            limits reset at this hour. Cards already scheduled keep their due dates.
          </p>
        </div>
        <div className="sv-field">
          <label className="sv-label" htmlFor={id('interleave')}>
            Mix decks
          </label>
          <select
            id={id('interleave')}
            className="sv-control"
            value={form.interleave}
            aria-describedby={`${id('interleave')}-hint`}
            onChange={(e) => edit({ interleave: e.target.value as StudySettings['interleave'] })}
          >
            <option value="deck">Spread evenly across decks</option>
            <option value="bank">Spread evenly across banks</option>
            <option value="none">Keep one list</option>
          </select>
          <p id={`${id('interleave')}-hint`} className="sv-small sv-muted">
            How cards from several decks are interleaved when you study more than one.
          </p>
        </div>
        <div className="sv-field">
          <label className="sv-label" htmlFor={id('order')}>
            Review order
          </label>
          <select
            id={id('order')}
            className="sv-control"
            value={form.order}
            aria-describedby={`${id('order')}-hint`}
            onChange={(e) => edit({ order: e.target.value as StudySettings['order'] })}
          >
            <option value="retrievability">Most forgotten first</option>
            <option value="due">Oldest due first</option>
          </select>
          <p id={`${id('order')}-hint`} className="sv-small sv-muted">
            Most forgotten uses the memory model&rsquo;s recall estimate; it is an estimate, not a
            measurement.
          </p>
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
          <label className="sv-label" htmlFor={id('ahead')}>
            Learn ahead (minutes)
          </label>
          <input
            id={id('ahead')}
            className="sv-control"
            inputMode="numeric"
            value={form.learnAheadMinutes}
            aria-describedby={`${id('ahead')}-hint`}
            onChange={(e) => {
              const n = Number(e.target.value.replace(/\D/g, ''));
              edit({ learnAheadMinutes: Math.min(120, Number.isFinite(n) ? n : 0) });
            }}
          />
          <p id={`${id('ahead')}-hint`} className="sv-small sv-muted">
            When nothing else is left, a learning step due within this many minutes is shown now
            instead of waiting. 0 to 120.
          </p>
        </div>
      </div>
      {preview ? <p className="sv-small">{preview}</p> : null}
      {state.error ? (
        <InlineNotice tone="error" title="Not saved">
          {state.error}
        </InlineNotice>
      ) : null}
      {state.saved ? (
        <InlineNotice tone="success" live>
          Saved. Open review windows pick the new settings up on their next refresh.
        </InlineNotice>
      ) : null}
      <div className="sv-row">
        <Button
          variant="primary"
          type="submit"
          busy={state.busy}
          data-testid={TID.studyDaySave}
          disabledReason={disabledReason}
        >
          Save study day settings
        </Button>
        {disabledReason ? <span className="sv-small sv-muted">{disabledReason}</span> : null}
      </div>
    </form>
  );
}

/** One expandable settings form per deck. */
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
  if (decks.loading) return <p className="sv-muted">Loading decks…</p>;
  const list = decks.data ?? [];
  if (list.length === 0) {
    return (
      <p className="sv-muted">
        There are no decks yet. A deck is created automatically the first time you make a card from
        a highlight; each deck can then have its own rules here.
      </p>
    );
  }
  return (
    <ul className="sv-stack sv-stack--tight">
      {list.map((deck) => (
        <li key={deck.id}>
          <details className="rv-details" data-testid={deckSettingsId(`${deck.id}-details`)}>
            <summary>
              <span className="rv-details__name">{deck.name}</span>{' '}
              <span className="sv-muted sv-small">
                {Math.round(deck.settings.targetRetention * 100)}% target, {deck.settings.newPerDay}{' '}
                new and {deck.settings.reviewsPerDay} reviews per day
              </span>
            </summary>
            <div className="rv-details__body">
              <DeckSettingsForm key={`${deck.id}-${deck.updatedAt}`} deck={deck} />
            </div>
          </details>
        </li>
      ))}
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
      className="sv-stack"
      aria-labelledby="rv-settings-heading"
      data-testid={TID.settingsSection}
    >
      <h2 id="rv-settings-heading">Review and study day</h2>
      <p className="sv-muted">
        These settings stay on this device. Nothing here needs an account or an internet connection.
      </p>
      <StudyDaySettings />
      <h3>Deck rules</h3>
      <DeckOptions />
    </section>
  );
}
