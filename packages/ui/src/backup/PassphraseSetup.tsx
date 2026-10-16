import { useId } from 'react';
import { KeyRound } from 'lucide-react';
import { Badge, type Tone } from '../Badge';
import { BarMeter } from '../design/BarMeter';
import { InfoTip } from '../design/InfoTip';
import { passphraseStrength } from './format';
import { StepError } from './kit';

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
const BAR_TONES = ['sun', 'sun', 'primary', 'success'] as const;

/**
 * Passphrase entry for an encrypted backup: confirmation field, a strength bar, and a warning that
 * says plainly that nobody (including the developers) can open the file without it. `bare` drops the
 * on/off checkbox, for a wizard step that already asked "Lock it?".
 */
export function PassphraseSetup({
  state,
  onChange,
  idPrefix,
  label = 'Lock with a passphrase',
  testId,
  bare = false,
  error = null,
  errorId,
}: {
  state: PassphraseState;
  onChange(next: PassphraseState): void;
  idPrefix?: string;
  label?: string;
  testId: string;
  bare?: boolean;
  /** A wizard step's error (passphraseProblem): shown under the field it names. */
  error?: string | null;
  errorId?: string;
}) {
  const generated = useId();
  const id = idPrefix ?? generated;
  const strength = passphraseStrength(state.value);
  const mismatch = state.confirm.length > 0 && state.value !== state.confirm;
  const on = bare || state.enabled;
  // The field the step error names, in passphraseProblem's order.
  const at = !error
    ? null
    : state.value.length < 8
      ? 'value'
      : state.value !== state.confirm
        ? 'confirm'
        : 'ack';
  const stepError = (field: typeof at) =>
    at === field && error && errorId ? <StepError id={errorId}>{error}</StepError> : null;
  return (
    <div className="sv-stack sv-stack--tight" data-testid={testId}>
      {bare ? null : (
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
      )}
      {on ? (
        <div className={`sv-stack${bare ? '' : ' bk-indent'}`}>
          <p className="sd-line bk-warnline">
            <KeyRound aria-hidden="true" strokeWidth={2.6} />
            Lose it, lose the backup.{' '}
            <InfoTip label="About the passphrase">
              Nobody, not even the StudyVault developers, can open the file without it. Keep it in a
              password manager.
            </InfoTip>
          </p>
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
              aria-invalid={at === 'value' || undefined}
              aria-describedby={[`${id}-strength`, at === 'value' ? errorId : '']
                .filter(Boolean)
                .join(' ')}
              data-testid={`${testId}-value`}
              onChange={(e) => onChange({ ...state, value: e.target.value })}
            />
            <div className="bk-strength">
              <BarMeter
                value={state.value.length > 0 ? strength.level + 1 : 0}
                max={4}
                size="sm"
                tone={BAR_TONES[strength.level]}
                label="Passphrase strength"
                valueText={state.value.length > 0 ? strength.label : 'Not entered yet'}
              />
              <p id={`${id}-strength`} className="sv-small" data-testid={`${testId}-strength`}>
                {state.value.length > 0 ? (
                  <>
                    <Badge tone={TONES[strength.level] ?? 'neutral'}>{strength.label}</Badge>{' '}
                  </>
                ) : null}
                <span className="sv-muted">
                  {state.value.length > 0
                    ? `${strength.hint} A rough estimate.`
                    : 'Tip: four or more unrelated words.'}
                </span>
              </p>
            </div>
            {stepError('value')}
          </div>
          <div className="sv-field">
            <label className="sv-label" htmlFor={`${id}-confirm`}>
              Type it again
            </label>
            <input
              id={`${id}-confirm`}
              className="sv-control"
              type="password"
              autoComplete="new-password"
              value={state.confirm}
              aria-invalid={mismatch || at === 'confirm' || undefined}
              aria-describedby={
                at === 'confirm' ? errorId : mismatch ? `${id}-mismatch` : undefined
              }
              data-testid={`${testId}-confirm`}
              onChange={(e) => onChange({ ...state, confirm: e.target.value })}
            />
            {/* One alert at a time: the step's, or the live mismatch while typing. */}
            {at === 'confirm' ? (
              stepError('confirm')
            ) : mismatch ? (
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
              aria-invalid={at === 'ack' || undefined}
              aria-describedby={at === 'ack' ? errorId : undefined}
              data-testid={`${testId}-ack`}
              onChange={(e) => onChange({ ...state, acknowledged: e.target.checked })}
            />
            <label htmlFor={`${id}-ack`}>I understand a lost passphrase cannot be recovered.</label>
          </div>
          {stepError('ack')}
        </div>
      ) : null}
    </div>
  );
}
