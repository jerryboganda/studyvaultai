import { useId, useState } from 'react';
import {
  COLOR_IDS,
  COLOR_SWATCH,
  HIGHLIGHT_KINDS,
  KIND_LABELS,
  type ColorId,
  type HighlightKind,
  type Settings,
} from '@shared';
import { KIND_DECORATION } from '@highlights';
import { AsyncSwitch, Button, InlineNotice, readKeepToasts, useAction, writeKeepToasts } from '@ui';
import { openDashboard } from '@ui/vault/dashboardLink';

/** Persists one settings change (`useSettings().update`); rejects with the real reason. */
export type Update = (mutate: (s: Settings) => Settings) => Promise<unknown>;

const THEMES = [
  { id: 'system', label: 'Match my system', hint: 'Follows your operating system setting.' },
  { id: 'light', label: 'Light', hint: 'Always light.' },
  { id: 'dark', label: 'Dark', hint: 'Always dark.' },
] as const;

const DENSITIES = [
  { id: 'comfortable', label: 'Comfortable', hint: 'More space around rows and buttons.' },
  { id: 'compact', label: 'Compact', hint: 'Fits more on screen.' },
] as const;

const STYLES = [
  {
    id: 'auto',
    label: 'Automatic',
    hint: 'Normal, and strong while your system asks for more contrast.',
  },
  { id: 'normal', label: 'Normal', hint: 'A light fill and a thin underline.' },
  { id: 'strong', label: 'Strong', hint: 'A heavier fill and a thicker underline.' },
] as const;

const COLOR_NAMES: Record<ColorId, string> = {
  amber: 'Amber',
  blue: 'Blue',
  red: 'Red',
  purple: 'Purple',
  orange: 'Orange',
  green: 'Green',
  teal: 'Teal',
};

/**
 * One settings write with its own error, shown in the section that owns the control: an error far
 * from the control that caused it is easy to miss and impossible to connect to it.
 */
export function useWriter(update: Update) {
  const save = useAction(async (mutate: (s: Settings) => Settings) => {
    await update(mutate);
  });
  const error = save.error ? (
    <InlineNotice
      tone="error"
      title="Your change was not saved"
      action={
        save.retryable ? (
          <Button busy={save.busy} onClick={save.retry}>
            Retry
          </Button>
        ) : undefined
      }
    >
      {save.error}
    </InlineNotice>
  ) : null;
  /** Resolves when the write settled (it never rejects: a failure is `error`). */
  return { write: (mutate: (s: Settings) => Settings) => save.run(mutate), error };
}

/**
 * Checkbox whose explanation is its accessible description, not part of its name. A returned
 * promise makes it a pending switch (`AsyncSwitch`): shown as chosen, busy and "Saving…" until the
 * write settles, rolled back by the stored value if it failed.
 */
export function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange(next: boolean): Promise<unknown> | void;
}) {
  return <AsyncSwitch label={label} hint={hint} checked={checked} onChange={onChange} />;
}

export function Appearance({ settings, update }: { settings: Settings; update: Update }) {
  const uid = useId();
  const { write, error } = useWriter(update);
  const strong = settings.highlightStyle === 'strong';
  const painted = settings.paintHighlights;
  // Per viewer, in this browser profile: not a StudyVault setting, so it is not written through `update`.
  const [keepToasts, setKeepToasts] = useState(readKeepToasts);
  return (
    <section className="sv-stack" aria-labelledby={`${uid}-h`}>
      <h2 id={`${uid}-h`}>Appearance</h2>

      <fieldset className="opt-fieldset">
        <legend>Theme</legend>
        <div className="sv-stack sv-stack--tight">
          {THEMES.map((t) => (
            <label key={t.id} className="sv-check">
              <input
                type="radio"
                name={`${uid}-theme`}
                value={t.id}
                checked={settings.theme === t.id}
                onChange={() => write((s) => ({ ...s, theme: t.id }))}
              />
              <span>
                {t.label} <span className="sv-muted sv-small">{t.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="opt-fieldset">
        <legend>Density</legend>
        <div className="sv-stack sv-stack--tight">
          {DENSITIES.map((d) => (
            <label key={d.id} className="sv-check">
              <input
                type="radio"
                name={`${uid}-density`}
                value={d.id}
                checked={settings.density === d.id}
                onChange={() => write((s) => ({ ...s, density: d.id }))}
              />
              <span>
                {d.label} <span className="sv-muted sv-small">{d.hint}</span>
              </span>
            </label>
          ))}
        </div>
        <p className="sv-muted sv-small">Applies to the dashboard and to the toolbar on pages.</p>
      </fieldset>

      <div className="sv-field opt-narrow">
        <label className="sv-label" htmlFor={`${uid}-kind`}>
          Default highlight kind
        </label>
        <select
          id={`${uid}-kind`}
          className="sv-control"
          value={settings.defaultKind}
          onChange={(e) => {
            const defaultKind = e.target.value as HighlightKind;
            write((s) => ({ ...s, defaultKind }));
          }}
        >
          {HIGHLIGHT_KINDS.map((k) => (
            <option key={k} value={k}>
              {`${KIND_LABELS[k].glyph} ${KIND_LABELS[k].label}`}
            </option>
          ))}
        </select>
        <p className="sv-muted sv-small">
          Used when you save with one click or the keyboard shortcut.
        </p>
      </div>

      <fieldset className="opt-fieldset">
        <legend>Highlight colours</legend>
        <p className="sv-muted sv-small">
          Each kind of highlight has its own colour. The kind is always written out next to the
          colour, and on the page each kind has its own underline, so nothing depends on colour
          alone.
        </p>
        <ul className="opt-list">
          {HIGHLIGHT_KINDS.map((kind) => {
            const color = settings.palette[kind];
            const id = `${uid}-${kind}`;
            return (
              <li key={kind} className="opt-item opt-palette">
                <label htmlFor={id} className="opt-palette__kind">
                  <span aria-hidden="true">{KIND_LABELS[kind].glyph}</span>{' '}
                  {KIND_LABELS[kind].label}
                </label>
                <select
                  id={id}
                  className="sv-control opt-palette__select"
                  value={color}
                  onChange={(e) => {
                    const next = e.target.value as ColorId;
                    write((s) => ({ ...s, palette: { ...s.palette, [kind]: next } }));
                  }}
                >
                  {COLOR_IDS.map((c) => (
                    <option key={c} value={c}>
                      {COLOR_NAMES[c]}
                    </option>
                  ))}
                </select>
                <mark
                  className="opt-sample"
                  style={{ background: COLOR_SWATCH[color].bg, color: 'inherit' }}
                >
                  Sample text
                </mark>
              </li>
            );
          })}
        </ul>
      </fieldset>

      <div className="sv-stack">
        <h3>Highlights on web pages</h3>
        <Toggle
          label="Show highlights on pages"
          hint="Turn this off to keep saving and reviewing highlights without marking them on web pages. Painted highlights live in the page's shared highlight list, so scripts that a site itself runs can read which passages you marked, and their colour and kind. On sites you do not trust, keep this off or add them to the deny list."
          checked={painted}
          onChange={(paintHighlights) => write((s) => ({ ...s, paintHighlights }))}
        />
        <fieldset className="opt-fieldset" disabled={!painted}>
          <legend>Highlight style</legend>
          <div className="sv-stack sv-stack--tight">
            {STYLES.map((o) => (
              <label key={o.id} className="sv-check">
                <input
                  type="radio"
                  name={`${uid}-style`}
                  value={o.id}
                  checked={settings.highlightStyle === o.id}
                  onChange={() => write((s) => ({ ...s, highlightStyle: o.id }))}
                />
                <span>
                  {o.label} <span className="sv-muted sv-small">{o.hint}</span>
                </span>
              </label>
            ))}
          </div>
          {painted ? null : (
            <p className="sv-muted sv-small">
              Highlight style has no effect while highlights are not shown on pages.
            </p>
          )}
        </fieldset>

        <div className="sv-stack sv-stack--tight">
          <h4>What each kind looks like on a page</h4>
          <ul className="opt-list" aria-label="Underline for each highlight kind">
            {HIGHLIGHT_KINDS.map((kind) => {
              const deco = KIND_DECORATION[kind];
              const px = deco.thickness + (strong ? 1 : 0);
              return (
                <li key={kind} className="opt-item opt-legend">
                  <span className="opt-legend__kind">
                    <span aria-hidden="true">{KIND_LABELS[kind].glyph}</span>{' '}
                    {KIND_LABELS[kind].label}
                  </span>
                  <span
                    className="opt-underline"
                    style={{
                      background: COLOR_SWATCH[settings.palette[kind]].bg,
                      textDecorationLine: 'underline',
                      textDecorationStyle: deco.style,
                      textDecorationThickness: `${px}px`,
                    }}
                  >
                    Sample text
                  </span>
                  <span className="sv-muted sv-small">{deco.label}</span>
                </li>
              );
            })}
          </ul>
          <p className="sv-muted sv-small">
            Samples show the strong thickness when Strong is chosen; Automatic is drawn as Normal.
            On pages with a forced-colours theme the browser's own colours replace these.
          </p>
        </div>
      </div>

      <div className="sv-stack">
        <h3>Notifications</h3>
        <Toggle
          label="Keep notifications on screen until I close them"
          hint="Messages such as “Highlight deleted” with an Undo close by themselves after a few seconds, and wait while the pointer is over them or focus is inside them. Turn this on to keep every one until you press Dismiss, or Escape while it has focus or the pointer. Error messages always stay until you close them. Saved in this browser only."
          checked={keepToasts}
          onChange={(next) => {
            writeKeepToasts(next);
            setKeepToasts(next);
          }}
        />
      </div>
      {error}
    </section>
  );
}

export function Capture({ settings, update }: { settings: Settings; update: Update }) {
  const uid = useId();
  const { write, error } = useWriter(update);
  const openRules = useAction(() => openDashboard({ view: 'rules' }));
  return (
    <section className="sv-stack" aria-labelledby={`${uid}-h`}>
      <h2 id={`${uid}-h`}>Capture</h2>
      <Toggle
        label="Show the floating toolbar when I select text"
        hint="Turn this off if you prefer the keyboard shortcut or the right-click menu. Those keep working either way."
        checked={settings.toolbarEnabled}
        onChange={(toolbarEnabled) => write((s) => ({ ...s, toolbarEnabled }))}
      />
      <Toggle
        label="Save from private windows"
        hint="Off by default. When on, you can save highlights from private (incognito) windows. They are stored in your normal Chrome profile and stay after you close the window, so the private window leaves a trace. Chrome also only runs StudyVault in private windows if you allow it there on the extension's details page."
        checked={settings.allowIncognitoCapture}
        onChange={(allowIncognitoCapture) => write((s) => ({ ...s, allowIncognitoCapture }))}
      />
      <Toggle
        label="Use the StudyVault PDF reader"
        hint="Chrome's built-in PDF viewer cannot be marked up by any extension, so StudyVault has its own reader for PDFs (choose Open in StudyVault reader in the popup, or right-click a PDF link). Turn this off and the reader will not open a PDF and the popup does not offer it. PDFs you already highlighted keep their highlights."
        checked={settings.features.pdfReader}
        onChange={(pdfReader) => write((s) => ({ ...s, features: { ...s.features, pdfReader } }))}
      />
      <Toggle
        label="Use filing rules"
        hint="When a new highlight matches one of your filing rules, StudyVault suggests filing it in the bank the rule names, or files it for you if the rule says so, with Undo. Turn this off to keep your rules without applying them. A bank you pick yourself in the toolbar is never overridden, and imports and restores are never filed."
        checked={settings.useFilingRules}
        onChange={(useFilingRules) => write((s) => ({ ...s, useFilingRules }))}
      />
      <div className="sv-row">
        <Button busy={openRules.busy} onClick={() => void openRules.run()}>
          Manage filing rules
        </Button>
        <span className="sv-muted sv-small">
          Opens the dashboard on the rules and a test panel.
        </span>
      </div>
      {openRules.error ? (
        <InlineNotice tone="error" title="Could not open the dashboard">
          {openRules.error}
        </InlineNotice>
      ) : null}
      {error}
    </section>
  );
}
