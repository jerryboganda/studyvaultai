import { useId, useState } from 'react';
import { Button } from '../Button';
import { InlineNotice } from '../Notice';
import { useAction } from '../hooks';
import { useSyncApi } from './api';
import { MIN_PASSPHRASE_CHARS, assessPassphrase } from './passphrase';
import type { SyncStatusView } from './protocol';

function Strength({ value }: { value: string }) {
  const s = assessPassphrase(value);
  return (
    <div className="sv-stack sv-stack--tight" data-testid="e2ee-strength">
      <meter min={0} max={4} value={s.score} aria-label="Passphrase strength estimate" />
      <p>
        <strong>{value === '' ? 'Not entered yet' : s.label}</strong>
        {value !== '' && s.score > 0 ? ` (an estimate: about ${s.bits} bits)` : ''}
      </p>
      {s.tips.length > 0 && value !== '' ? (
        <ul className="sv-muted sv-small">
          {s.tips.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function PassphraseField({
  label,
  value,
  onChange,
  testId,
  autoComplete = 'off',
}: {
  label: string;
  value: string;
  onChange(v: string): void;
  testId: string;
  autoComplete?: string;
}) {
  const id = useId();
  return (
    <div className="sv-field">
      <label className="sv-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="sv-control"
        type="password"
        value={value}
        autoComplete={autoComplete}
        spellCheck={false}
        data-testid={testId}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

const REASON_TEXT = {
  wrong_passphrase: 'That passphrase does not match this account’s key. Nothing was changed.',
  no_key: 'This account has no encryption key on the server yet.',
} as const;

/** What choosing "without end-to-end encryption" means, in the words the person confirms. */
export const PLAIN_UPLOAD_CONSEQUENCE =
  'The operator of the sync server, and anyone who gets into it, can read everything that is uploaded: highlights, notes, flashcards, review history, page addresses and titles, and scanned-page text. The connection is encrypted (TLS), but that is not end-to-end encryption.';

/** SECURITY_PRIVACY.md: end-to-end encryption does not extend to AI processing. */
export const AI_AFTER_DECRYPTION_NOTE =
  'If you use the optional AI features, the text you select is decrypted on this device and sent to your AI provider only after you give a separate consent for that request. End-to-end encryption does not cover what you choose to send to an AI provider.';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * How synced content is protected: the choice that gates the first upload, end-to-end encryption,
 * its lock, and changing the passphrase. The passphrase is sent only to the service worker of this
 * extension, which derives the key; the key is kept in memory-only session storage for a limited
 * time (it is not written to disk) and the passphrase is never stored.
 */
export function EncryptionCard({
  status,
  onChanged,
}: {
  status: SyncStatusView;
  onChanged(next?: SyncStatusView): void;
}) {
  const api = useSyncApi();
  const headingId = useId();
  const [pass, setPass] = useState('');
  const [again, setAgain] = useState('');
  const [lostAck, setLostAck] = useState(false);
  const [plainAck, setPlainAck] = useState(false);
  const [unlockPass, setUnlockPass] = useState('');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [nextAgain, setNextAgain] = useState('');
  const [rotateAck, setRotateAck] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const strength = assessPassphrase(pass);
  const nextStrength = assessPassphrase(next);
  const undecided = status.encryptionChoice === 'undecided' && status.e2ee.mode === 'none';
  const plain = status.encryptionChoice === 'plaintext' && status.e2ee.mode === 'none';
  const setAsideNote = (n: number) =>
    n > 0
      ? ` ${plural(n, 'stored item')} on the server could not be proven to come from your devices, so ${n === 1 ? 'it was' : 'they were'} not carried over. ${n === 1 ? 'It is' : 'They are'} listed under “Refused changes”.`
      : '';

  const setup = useAction(async () => {
    setMessage(null);
    const view = await api.e2eeSetup(pass);
    onChanged(view);
    setPass('');
    setAgain('');
    setLostAck(false);
    setMessage(
      `End-to-end encryption is on. Keep your passphrase safe.${setAsideNote(view.e2ee.setAside ?? 0)}`,
    );
  });
  const uploadPlain = useAction(async () => {
    setMessage(null);
    onChanged(await api.uploadPlain());
    setPlainAck(false);
  });
  const unlock = useAction(async () => {
    setMessage(null);
    const r = await api.e2eeUnlock(unlockPass);
    if (!r.ok) {
      setMessage(r.reason ? REASON_TEXT[r.reason] : 'Could not unlock.');
      return;
    }
    setUnlockPass('');
    onChanged();
  });
  const lock = useAction(async () => {
    onChanged(await api.e2eeLock());
  });
  const rotate = useAction(async () => {
    setMessage(null);
    const r = await api.e2eeRotate(current, next);
    if (!r.ok) {
      setMessage(r.reason ? REASON_TEXT[r.reason] : 'Could not change the passphrase.');
      return;
    }
    setCurrent('');
    setNext('');
    setNextAgain('');
    setRotateAck(false);
    setMessage(
      `The passphrase was changed and your synced data was re-encrypted.${setAsideNote(r.setAside ?? 0)}`,
    );
    onChanged();
  });

  const signedIn = status.signedIn;
  const setupReason = !signedIn
    ? 'Sign in first.'
    : !strength.acceptable
      ? `Choose a stronger passphrase (at least ${MIN_PASSPHRASE_CHARS} characters, rated Fair or better).`
      : pass !== again
        ? 'The two passphrases are not the same.'
        : !lostAck
          ? 'Confirm that you understand a lost passphrase cannot be recovered.'
          : undefined;
  const plainReason = !signedIn
    ? 'Sign in first.'
    : !plainAck
      ? 'Confirm that you understand the operator of the server can read what is uploaded.'
      : undefined;
  const rotateReason =
    current === ''
      ? 'Enter your current passphrase.'
      : !nextStrength.acceptable
        ? `Choose a stronger new passphrase (at least ${MIN_PASSPHRASE_CHARS} characters, Fair or better).`
        : next !== nextAgain
          ? 'The two new passphrases are not the same.'
          : !rotateAck
            ? 'Confirm that you understand a lost passphrase cannot be recovered.'
            : undefined;

  const minutes =
    status.e2ee.lockInSeconds === null
      ? null
      : Math.max(1, Math.round(status.e2ee.lockInSeconds / 60));

  return (
    <section
      className="sv-stack sv-stack--tight"
      aria-labelledby={headingId}
      data-testid="e2ee-section"
    >
      <h3 id={headingId}>End-to-end encryption</h3>

      {status.e2ee.warning ? (
        <InlineNotice tone="error" title="Uploads are paused: the encryption key looks wrong" live>
          <span data-testid="e2ee-warning">{status.e2ee.warning}</span>{' '}
          <span>
            Do not enter your passphrase for a server you do not trust. If you know the server was
            reset, delete what it holds (below) to start again.
          </span>
        </InlineNotice>
      ) : null}

      {undecided ? (
        <InlineNotice
          tone="warning"
          title="Nothing has been uploaded yet: choose how it is protected"
        >
          <span data-testid="e2ee-choice-note">
            StudyVault does not send anything until you choose. Either set a passphrase below, so
            your content is encrypted on this device before it leaves, or upload without end-to-end
            encryption. {PLAIN_UPLOAD_CONSEQUENCE}
          </span>
        </InlineNotice>
      ) : null}

      <p data-testid="e2ee-mode">
        {status.e2ee.mode === 'none'
          ? plain
            ? `Not set up. You chose to upload without end-to-end encryption. ${PLAIN_UPLOAD_CONSEQUENCE}`
            : 'Not set up, and nothing has been uploaded. Without a passphrase, whoever runs the sync server could read what you upload. The connection is encrypted (TLS), but that is not end-to-end encryption.'
          : status.e2ee.mode === 'locked'
            ? 'Set up, and locked on this device. Locked means the key is not held here right now: syncing is paused, and nothing is uploaded unencrypted, until you enter the passphrase.'
            : minutes !== null
              ? `On, and unlocked on this device for about ${minutes} minute(s). Then the key is dropped, background syncing pauses and the status says locked until you enter the passphrase again. The key is held only in memory, and is also dropped when the browser or the extension restarts.`
              : 'On, and unlocked on this device.'}
      </p>

      <InlineNotice tone="warning" title="A lost passphrase means lost synced data">
        The passphrase never leaves this device. StudyVault and the server operator cannot reset it
        or recover your synced data without it. Your data on this device is not affected.
      </InlineNotice>
      <p className="sv-muted sv-small">
        With encryption on, the server cannot read your content. It can still see which kinds of
        items you have, their ids, whether each was created, changed or deleted, when, and how big
        it is.
      </p>
      <p className="sv-muted sv-small" data-testid="e2ee-ai-note">
        {AI_AFTER_DECRYPTION_NOTE}
      </p>

      {(status.e2ee.setAside ?? 0) > 0 ? (
        <InlineNotice tone="warning" title="Some stored items could not be verified">
          <span data-testid="e2ee-set-aside">
            When encryption was last set up or changed,
            {setAsideNote(status.e2ee.setAside ?? 0)}
          </span>
        </InlineNotice>
      ) : null}

      {status.e2ee.mode === 'none' ? (
        <div className="sv-stack sv-stack--tight">
          <PassphraseField
            label="New passphrase"
            value={pass}
            onChange={setPass}
            testId="e2ee-passphrase"
            autoComplete="new-password"
          />
          <Strength value={pass} />
          <PassphraseField
            label="Repeat the passphrase"
            value={again}
            onChange={setAgain}
            testId="e2ee-confirm"
            autoComplete="new-password"
          />
          <label className="sv-check">
            <input
              type="checkbox"
              checked={lostAck}
              data-testid="e2ee-lost-ack"
              onChange={(e) => setLostAck(e.target.checked)}
            />
            <span>
              I understand that if I lose this passphrase my synced data cannot be recovered.
            </span>
          </label>
          <p className="sv-muted sv-small">
            Turning encryption on re-sends what this device holds under the new key and replaces
            what the server stores. Let your other devices sync first, so nothing they have not
            uploaded yet is overwritten.
          </p>
          <div className="sv-row">
            <Button
              variant="primary"
              busy={setup.busy}
              disabledReason={setupReason}
              data-testid="e2ee-setup"
              onClick={() => void setup.run()}
            >
              Turn on encryption
            </Button>
          </div>
          {setup.error ? (
            <InlineNotice tone="error" title="Could not set up encryption">
              {setup.error}
            </InlineNotice>
          ) : null}

          {undecided ? (
            <div className="sv-stack sv-stack--tight" data-testid="e2ee-plain-choice">
              <h4>Or upload without end-to-end encryption</h4>
              <label className="sv-check">
                <input
                  type="checkbox"
                  checked={plainAck}
                  data-testid="e2ee-plain-ack"
                  onChange={(e) => setPlainAck(e.target.checked)}
                />
                <span>
                  I understand that the operator of the sync server can read everything that is
                  uploaded.
                </span>
              </label>
              <div className="sv-row">
                <Button
                  busy={uploadPlain.busy}
                  disabledReason={plainReason}
                  data-testid="e2ee-upload-plain"
                  onClick={() => void uploadPlain.run()}
                >
                  Upload without end-to-end encryption
                </Button>
              </div>
              {uploadPlain.error ? (
                <InlineNotice tone="error" title="Could not start uploading">
                  {uploadPlain.error}
                </InlineNotice>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : status.e2ee.mode === 'locked' ? (
        <div className="sv-stack sv-stack--tight">
          <PassphraseField
            label="Sync passphrase"
            value={unlockPass}
            onChange={setUnlockPass}
            testId="e2ee-unlock-passphrase"
            autoComplete="current-password"
          />
          <div className="sv-row">
            <Button
              variant="primary"
              busy={unlock.busy}
              disabledReason={
                !signedIn
                  ? 'Sign in first.'
                  : unlockPass === ''
                    ? 'Enter the passphrase.'
                    : undefined
              }
              data-testid="e2ee-unlock"
              onClick={() => void unlock.run()}
            >
              Unlock
            </Button>
          </div>
          {unlock.error ? (
            <InlineNotice tone="error" title="Could not unlock">
              {unlock.error}
            </InlineNotice>
          ) : null}
        </div>
      ) : (
        <div className="sv-stack sv-stack--tight">
          <div className="sv-row">
            <Button busy={lock.busy} data-testid="e2ee-lock" onClick={() => void lock.run()}>
              Lock now
            </Button>
          </div>
          <details className="sv-stack sv-stack--tight">
            <summary>Change the passphrase</summary>
            <PassphraseField
              label="Current passphrase"
              value={current}
              onChange={setCurrent}
              testId="e2ee-rotate-current"
              autoComplete="current-password"
            />
            <PassphraseField
              label="New passphrase"
              value={next}
              onChange={setNext}
              testId="e2ee-rotate-next"
              autoComplete="new-password"
            />
            <Strength value={next} />
            <PassphraseField
              label="Repeat the new passphrase"
              value={nextAgain}
              onChange={setNextAgain}
              testId="e2ee-rotate-confirm"
              autoComplete="new-password"
            />
            <label className="sv-check">
              <input
                type="checkbox"
                checked={rotateAck}
                data-testid="e2ee-rotate-ack"
                onChange={(e) => setRotateAck(e.target.checked)}
              />
              <span>
                I understand that my other devices need the new passphrase, and that a lost
                passphrase cannot be recovered.
              </span>
            </label>
            <div className="sv-row">
              <Button
                variant="primary"
                busy={rotate.busy}
                disabledReason={rotateReason}
                data-testid="e2ee-rotate"
                onClick={() => void rotate.run()}
              >
                Change passphrase
              </Button>
            </div>
            {rotate.error ? (
              <InlineNotice tone="error" title="Could not change the passphrase">
                {rotate.error}
              </InlineNotice>
            ) : null}
          </details>
        </div>
      )}
      {message ? (
        <p role="status" data-testid="e2ee-message">
          {message}
        </p>
      ) : null}
    </section>
  );
}
