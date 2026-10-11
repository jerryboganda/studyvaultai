import { useId } from 'react';
import { Badge, type Tone } from '../Badge';
import { InlineNotice } from '../Notice';
import { passphraseStrength } from './format';

export interface PassphraseState {
  enabled: boolean;
  value: string;
  confirm: string;
  /** "I understand a lost passphrase means a lost backup" */
  acknowledged: boolean;
}

export const emptyPassphrase: PassphraseState = {
  enabled: false,
  value: '',
  confirm: '',
  acknowledged: false,
};

/** Why the passphrase cannot be used yet, or null when it can (or when encryption is off). */
export function passphraseProblem(state: PassphraseState): string | null {
  if (!state.enabled) return null;
  if (state.value.length < 8) return 'Enter a passphrase of at least 8 characters.';
  if (state.value !== state.confirm) return 'The two passphrases do not match.';
  if (!state.acknowledged)
    return 'Confirm that you understand a lost passphrase cannot be recovered.';
  return null;
}

const TONES: Tone[] = ['danger', 'warning', 'info', 'success'];

/**
 * Passphrase entry for an encrypted backup: confirmation field, strength hint, and a warning that
 * says plainly that nobody (including the developers) can open the file without it.
 */
export function PassphraseSetup({
  state,
  onChange,
  idPrefix,
  label = 'Protect this backup with a passphrase (encrypt it)',
  testId,
}: {
  state: PassphraseState;
  onChange(next: PassphraseState): void;
  idPrefix?: string;
  label?: string;
  testId: string;
}) {
  const generated = useId();
  const id = idPrefix ?? generated;
  const strength = passphraseStrength(state.value);
  const mismatch = state.confirm.length > 0 && state.value !== state.confirm;
  return (
    <div className="sv-stack sv-stack--tight" data-testid={testId}>
      <div className="sv-check">
        <input
          id={`${id}-enable`}
          type="checkbox"
          checked={state.enabled}
          data-testid={`${testId}-enable`}
          onChange={(e) =>
            onChange(e.target.checked ? { ...state, enabled: true } : { ...emptyPassphrase })
          }
        />
        <label htmlFor={`${id}-enable`}>{label}</label>
      </div>
      {state.enabled ? (
        <div className="sv-stack bk-indent">
          <InlineNotice tone="warning" title="If you lose this passphrase, you lose this backup">
            The passphrase is not stored anywhere and cannot be reset. Nobody, including the
            developers of StudyVault, can open the file without it. Keep it somewhere safe, for
            example in a password manager.
          </InlineNotice>
          <div className="sv-field">
            <label className="sv-label" htmlFor={`${id}-pass`}>
              Passphrase
            </label>
            <input
              id={`${id}-pass`}
              className="sv-control"
              type="password"
              autoComplete="new-password"
              value={state.value}
              aria-describedby={`${id}-strength`}
              data-testid={`${testId}-value`}
              onChange={(e) => onChange({ ...state, value: e.target.value })}
            />
            <p id={`${id}-strength`} className="sv-small" data-testid={`${testId}-strength`}>
              {state.value.length > 0 ? (
                <>
                  <Badge tone={TONES[strength.level] ?? 'neutral'}>{strength.label}</Badge>{' '}
                </>
              ) : null}
              <span className="sv-muted">
                {state.value.length > 0
                  ? `${strength.hint} This is a rough estimate.`
                  : 'Use a long phrase: four or more unrelated words work well.'}
              </span>
            </p>
          </div>
          <div className="sv-field">
            <label className="sv-label" htmlFor={`${id}-confirm`}>
              Type the passphrase again
            </label>
            <input
              id={`${id}-confirm`}
              className="sv-control"
              type="password"
              autoComplete="new-password"
              value={state.confirm}
              aria-invalid={mismatch || undefined}
              aria-describedby={mismatch ? `${id}-mismatch` : undefined}
              data-testid={`${testId}-confirm`}
              onChange={(e) => onChange({ ...state, confirm: e.target.value })}
            />
            {mismatch ? (
              <p id={`${id}-mismatch`} role="alert" className="sv-small bk-error">
                The two passphrases do not match.
              </p>
            ) : null}
          </div>
          <div className="sv-check">
            <input
              id={`${id}-ack`}
              type="checkbox"
              checked={state.acknowledged}
              data-testid={`${testId}-ack`}
              onChange={(e) => onChange({ ...state, acknowledged: e.target.checked })}
            />
            <label htmlFor={`${id}-ack`}>
              I understand that if I lose this passphrase the backup cannot be opened by anyone.
            </label>
          </div>
        </div>
      ) : null}
    </div>
  );
}
