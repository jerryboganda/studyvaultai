import { useId, useState } from 'react';
import {
  BellRing,
  BookOpen,
  Check,
  Contrast,
  EyeOff,
  Highlighter,
  Minus,
  Monitor,
  Moon,
  Paintbrush,
  Rows2,
  Rows4,
  Sun,
  Underline,
  Workflow,
} from 'lucide-react';
import {
  COLOR_IDS,
  COLOR_SWATCH,
  HIGHLIGHT_KINDS,
  KIND_LABELS,
  type ColorId,
  type Settings,
} from '@shared';
import { KIND_DECORATION } from '@highlights';
import { Button, ChoiceCards, InlineNotice, readKeepToasts, useAction, writeKeepToasts } from '@ui';
import { openDashboard } from '@ui/vault/dashboardLink';
import { Act, Card, More, SettingRow } from './ui';

/** Persists one settings change (`useSettings().update`); rejects with the real reason. */
export type Update = (mutate: (s: Settings) => Settings) => Promise<unknown>;

const THEMES = [
  {
    value: 'system' as const,
    label: 'System',
    hint: 'Match device',
    icon: Monitor,
    tone: 'neutral' as const,
  },
  {
    value: 'light' as const,
    label: 'Light',
    hint: 'Always light',
    icon: Sun,
    tone: 'sun' as const,
  },
  {
    value: 'dark' as const,
    label: 'Dark',
    hint: 'Always dark',
    icon: Moon,
    tone: 'violet' as const,
  },
];

const DENSITIES = [
  {
    value: 'comfortable' as const,
    label: 'Comfortable',
    hint: 'More space',
    icon: Rows2,
    tone: 'primary' as const,
  },
  {
    value: 'compact' as const,
    label: 'Compact',
    hint: 'Fits more',
    icon: Rows4,
    tone: 'primary' as const,
  },
];

const STYLES = [
  {
    value: 'auto' as const,
    label: 'Automatic',
    hint: 'Follows contrast',
    icon: Contrast,
    tone: 'neutral' as const,
  },
  {
    value: 'normal' as const,
    label: 'Normal',
    hint: 'Light fill',
    icon: Minus,
    tone: 'primary' as const,
  },
  {
    value: 'strong' as const,
    label: 'Strong',
    hint: 'Heavier line',
    icon: Underline,
    tone: 'violet' as const,
  },
];

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
 * One settings write with its own error, shown in the card that owns the control: an error far
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

/** The default kind as a row of radio chips: glyph, name and the kind's colour (never colour alone). */
function KindPicker({
  settings,
  write,
}: {
  settings: Settings;
  write: ReturnType<typeof useWriter>['write'];
}) {
  const uid = useId();
  return (
    <fieldset className="opt-fieldset">
      <legend className="opt-legend">Default kind</legend>
      <div className="opt-kinds">
        {HIGHLIGHT_KINDS.map((k) => (
          <label key={k} className="opt-kind">
            <input
              type="radio"
              className="sv-vh"
              name={`${uid}-kind`}
              value={k}
              checked={settings.defaultKind === k}
              onChange={() => write((s) => ({ ...s, defaultKind: k }))}
            />
            <span
              className="opt-kind__dot"
              aria-hidden="true"
              style={{ background: COLOR_SWATCH[settings.palette[k]].solid }}
            >
              {KIND_LABELS[k].glyph}
            </span>
            <span className="opt-kind__label">{KIND_LABELS[k].label}</span>
            <Check aria-hidden="true" strokeWidth={3} className="opt-kind__check" />
          </label>
        ))}
      </div>
      <p className="sv-muted sv-small">Used for one-click and shortcut saves.</p>
    </fieldset>
  );
}

/**
 * Each kind's colour as swatches, with a sample drawn the way pages draw it: the colour fill and
 * the kind's own underline (so nothing depends on colour alone).
 */
function KindLooks({
  settings,
  write,
}: {
  settings: Settings;
  write: ReturnType<typeof useWriter>['write'];
}) {
  const uid = useId();
  const strong = settings.highlightStyle === 'strong';
  return (
    <ul className="opt-looks" aria-label="Underline for each highlight kind">
      {HIGHLIGHT_KINDS.map((kind) => {
        const color = settings.palette[kind];
        const deco = KIND_DECORATION[kind];
        const px = deco.thickness + (strong ? 1 : 0);
        return (
          <li key={kind} className="opt-look">
            <fieldset className="opt-fieldset opt-look__set">
              <legend className="opt-look__kind">
                <span aria-hidden="true">{KIND_LABELS[kind].glyph}</span> {KIND_LABELS[kind].label}
              </legend>
              <div className="opt-swatches">
                {COLOR_IDS.map((c) => (
                  <label key={c} className="opt-swatch" title={COLOR_NAMES[c]}>
                    <input
                      type="radio"
                      className="sv-vh"
                      name={`${uid}-${kind}`}
                      value={c}
                      checked={color === c}
                      onChange={() =>
                        write((s) => ({ ...s, palette: { ...s.palette, [kind]: c } }))
                      }
                    />
                    <span
                      className="opt-swatch__dot"
                      aria-hidden="true"
                      style={{ background: COLOR_SWATCH[c].solid }}
                    >
                      <Check strokeWidth={3.5} />
                    </span>
                    <span className="sv-vh">{COLOR_NAMES[c]}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <span
              className="opt-underline"
              style={{
                background: COLOR_SWATCH[color].bg,
                textDecorationLine: 'underline',
                textDecorationStyle: deco.style,
                textDecorationThickness: `${px}px`,
              }}
            >
              Sample text
            </span>
            <span className="sv-muted sv-small opt-look__deco">{deco.label}</span>
          </li>
        );
      })}
    </ul>
  );
}

export function Appearance({ settings, update }: { settings: Settings; update: Update }) {
  const theme = useWriter(update);
  const density = useWriter(update);
  const marks = useWriter(update);
  const painted = settings.paintHighlights;
  const styleId = useId();
  // Per viewer, in this browser profile: not a StudyVault setting, so it is not written through `update`.
  const [keepToasts, setKeepToasts] = useState(readKeepToasts);
  return (
    <div className="opt-stack">
      <Card title="Theme" icon={Sun} tone="sun">
        <ChoiceCards
          label="Theme"
          options={THEMES}
          value={settings.theme}
          columns={3}
          onChange={(t) => void theme.write((s) => ({ ...s, theme: t }))}
        />
        {theme.error}
      </Card>

      <Card
        title="Density"
        icon={Rows2}
        info="Applies to the dashboard and to the toolbar on pages."
      >
        <ChoiceCards
          label="Density"
          options={DENSITIES}
          value={settings.density}
          columns={2}
          onChange={(d) => void density.write((s) => ({ ...s, density: d }))}
        />
        {density.error}
      </Card>

      <Card title="Highlights" icon={Highlighter} tone="warning">
        <KindPicker settings={settings} write={marks.write} />
        <SettingRow
          icon={Paintbrush}
          tone="warning"
          label="Show on pages"
          hint="Sites can see which passages are painted."
          info="Painted highlights live in the page's shared highlight list, so scripts that a site itself runs can read which passages you marked, and their colour and kind. On sites you do not trust, keep this off or add them to the deny list."
          checked={painted}
          onChange={(paintHighlights) => marks.write((s) => ({ ...s, paintHighlights }))}
        />
        {/* One group name, not two: the cards are named by this line, the fieldset only disables. */}
        <fieldset className="opt-fieldset" disabled={!painted}>
          <p id={`${styleId}-h`} className="opt-legend">
            Highlight style
          </p>
          <ChoiceCards
            labelledBy={`${styleId}-h`}
            options={STYLES}
            value={settings.highlightStyle}
            columns={3}
            onChange={(o) => void marks.write((s) => ({ ...s, highlightStyle: o }))}
          />
          {painted ? null : (
            <p className="sv-muted sv-small">No effect while highlights are not shown on pages.</p>
          )}
        </fieldset>
        <More label="Colours and underlines">
          <KindLooks settings={settings} write={marks.write} />
          <p className="sv-muted sv-small">
            Strong draws a thicker line. Forced-colour themes use the browser&apos;s colours.
          </p>
        </More>
        {marks.error}
      </Card>

      <div className="opt-card opt-card--single">
        <SettingRow
          icon={BellRing}
          label="Keep notifications"
          hint="Stay on screen until you close them."
          info="Messages on StudyVault pages, such as “Highlight deleted”, close by themselves after a few seconds; this keeps each one until you press Dismiss. Errors always stay. Saved in this browser only, and not used by the toolbar on web pages."
          checked={keepToasts}
          onChange={(next) => {
            writeKeepToasts(next);
            setKeepToasts(next);
          }}
        />
      </div>
    </div>
  );
}

export function Capture({ settings, update }: { settings: Settings; update: Update }) {
  const { write, error } = useWriter(update);
  const openRules = useAction(() => openDashboard({ view: 'rules' }));
  return (
    <div className="opt-stack">
      <div className="opt-card">
        <div className="opt-settings">
          <SettingRow
            icon={Highlighter}
            tone="warning"
            label="Floating toolbar"
            hint="Shows when you select text."
            info="Turn this off if you prefer the keyboard shortcut or the right-click menu. Those keep working either way."
            checked={settings.toolbarEnabled}
            onChange={(toolbarEnabled) => write((s) => ({ ...s, toolbarEnabled }))}
          />
          <SettingRow
            icon={EyeOff}
            tone="neutral"
            label="Private windows"
            hint="Saves stay in your normal profile."
            info="Off by default. Highlights saved from private (incognito) windows are stored in your normal Chrome profile and stay after the window closes. Chrome also has to allow StudyVault in private windows on the extension's details page."
            checked={settings.allowIncognitoCapture}
            onChange={(allowIncognitoCapture) => write((s) => ({ ...s, allowIncognitoCapture }))}
          />
          <SettingRow
            icon={BookOpen}
            tone="primary"
            label="PDF reader"
            hint="Open PDFs in StudyVault to mark them."
            info="Chrome's own PDF viewer cannot be marked up by any extension, so StudyVault has its own reader. Off: the reader does not open PDFs and the popup does not offer it. Highlights you already made stay."
            checked={settings.features.pdfReader}
            onChange={(pdfReader) =>
              write((s) => ({ ...s, features: { ...s.features, pdfReader } }))
            }
          />
          <SettingRow
            icon={Workflow}
            tone="violet"
            label="Filing rules"
            hint="Suggest a bank for new saves."
            info="A new highlight that matches a rule is suggested for, or filed into, the rule's bank, with Undo. A bank you pick yourself is never overridden; imports and restores are never filed."
            checked={settings.useFilingRules}
            onChange={(useFilingRules) => write((s) => ({ ...s, useFilingRules }))}
          >
            <Act
              size="sm"
              icon={Workflow}
              busy={openRules.busy}
              className="opt-setting__extra"
              onClick={() => void openRules.run()}
            >
              Manage rules
            </Act>
          </SettingRow>
        </div>
        {openRules.error ? (
          <InlineNotice tone="error" title="Could not open the dashboard">
            {openRules.error}
          </InlineNotice>
        ) : null}
        {error}
      </div>
    </div>
  );
}
