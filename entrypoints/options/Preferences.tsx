import { useId } from 'react';
import {
  COLOR_IDS,
  COLOR_SWATCH,
  HIGHLIGHT_KINDS,
  KIND_LABELS,
  type ColorId,
  type HighlightKind,
  type Settings,
} from '@shared';

type Write = (mutate: (s: Settings) => Settings) => void;

const THEMES = [
  { id: 'system', label: 'Match my system', hint: 'Follows your operating system setting.' },
  { id: 'light', label: 'Light', hint: 'Always light.' },
  { id: 'dark', label: 'Dark', hint: 'Always dark.' },
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

export function Appearance({ settings, write }: { settings: Settings; write: Write }) {
  const uid = useId();
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
          colour, so nothing depends on colour alone.
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
    </section>
  );
}

export function Capture({ settings, write }: { settings: Settings; write: Write }) {
  const uid = useId();
  return (
    <section className="sv-stack" aria-labelledby={`${uid}-h`}>
      <h2 id={`${uid}-h`}>Capture</h2>
      <label className="sv-check">
        <input
          type="checkbox"
          checked={settings.toolbarEnabled}
          onChange={(e) => {
            const toolbarEnabled = e.target.checked;
            write((s) => ({ ...s, toolbarEnabled }));
          }}
        />
        <span>
          Show the floating toolbar when I select text
          <span className="sv-muted sv-small opt-block">
            Turn this off if you prefer the keyboard shortcut or the right-click menu. Those keep
            working either way.
          </span>
        </span>
      </label>
    </section>
  );
}
