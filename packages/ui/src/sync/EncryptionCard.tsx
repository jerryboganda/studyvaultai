import { useId, useState } from 'react';
import { Eye, KeyRound, Lock, LockOpen, ShieldAlert, ShieldCheck } from 'lucide-react';
import { Button } from '../Button';
import { BarMeter } from '../design/BarMeter';
import { InfoTip } from '../design/InfoTip';
import { InlineNotice } from '../Notice';
import { useAction } from '../hooks';
import { Chip, Choices, Disclosure } from '../backup/kit';
import { useSyncApi } from './api';
import { MIN_PASSPHRASE_CHARS, assessPassphrase } from './passphrase';
import type { SyncStatusView } from './protocol';

const BAR_TONES = ['sun', 'sun', 'primary', 'success', 'success'] as const;

function Strength({ value }: { value: string }) {
  const s = assessPassphrase(value);
  return (
    <div className="sd-stack" data-testid="e2ee-strength">
      <BarMeter
        value={value === '' ? 0 : s.score}
        max={4}
        size="sm"
        tone={BAR_TONES[s.score] ?? 'primary'}
        label="Passphrase strength estimate"
        valueText={value === '' ? 'Not entered yet' : s.label}
      />
      <p className="sd-line">
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
 * How synced content is protected: the choice that gates the first upload (picture cards), end-to-end
 * encryption, its lock, and changing the passphrase. The passphrase is sent only to the service
 * worker of this extension, which derives the key; the key is kept in memory-only session storage for
 * a limited time (it is not written to disk) and the passphrase is never stored.
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
  const [way, setWay] = useState<'passphrase' | 'plain'>('passphrase');

  const strength = assessPassphrase(pass);
  const nextStrength = assessPassphrase(next);
  const undecided = status.encryptionChoice === 'undecided' && status.e2ee.mode === 'none';
  const plain = status.encryptionChoice === 'plaintext' && status.e2ee.mode === 'none';
  const setAsideNote = (n: number) =>
    n > 0
      ? ` ${plural(n, 'stored item')} on the server could not be proven to come from your devices, so ${n === 1 ? 'it was' : 'they were'} not carried over. ${n === 1 ? 'It is' : 'They are'} listed under “Not exchanged”.`
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
  const mode = status.e2ee.mode;

  const setupForm = (
    <div className="sd-stack">
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
        <span>I understand that if I lose this passphrase my synced data cannot be recovered.</span>
      </label>
      <p className="sd-line">
        It re-sends this device’s data under the new key.{' '}
        <InfoTip label="Before you turn it on">
          It replaces what the server stores. Let your other devices sync first, so nothing they
          have not uploaded yet is overwritten.
        </InfoTip>
      </p>
      <div className="sd-row">
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
    </div>
  );

  return (
    <section className="sd-card" aria-labelledby={headingId} data-testid="e2ee-section">
      <div className="sd-row">
        <span
          className={`sd-tile sd-tile--sm sv-art--${mode === 'none' ? 'warning' : 'success'}`}
          aria-hidden="true"
        >
          {mode === 'unlocked' ? (
            <LockOpen strokeWidth={2.4} />
          ) : mode === 'locked' ? (
            <Lock strokeWidth={2.4} />
          ) : (
            <ShieldAlert strokeWidth={2.4} />
          )}
        </span>
        <h3 id={headingId} className="sd-card__title sd-grow">
          End-to-end encryption
        </h3>
        {mode === 'unlocked' ? (
          <Chip icon={LockOpen} tone="success">
            On, unlocked
          </Chip>
        ) : mode === 'locked' ? (
          <Chip icon={Lock} tone="warning">
            On, locked
          </Chip>
        ) : plain ? (
          <Chip icon={Eye} tone="warning">
            Off: plain upload
          </Chip>
        ) : (
          <Chip icon={ShieldAlert} tone="warning">
            Not set up
          </Chip>
        )}
      </div>

      {status.e2ee.warning ? (
        <InlineNotice tone="error" title="Uploads are paused: the encryption key looks wrong" live>
          <span data-testid="e2ee-warning">{status.e2ee.warning}</span>{' '}
          <span>
            Do not enter your passphrase for a server you do not trust. If you know the server was
            reset, delete what it holds (below) to start again.
          </span>
        </InlineNotice>
      ) : null}

      <p className="sd-line" data-testid="e2ee-mode">
        {mode === 'none' ? (
          plain ? (
            <>
              Not set up. You chose to upload without end-to-end encryption.{' '}
              <InfoTip label="What plain upload means">{PLAIN_UPLOAD_CONSEQUENCE}</InfoTip>
            </>
          ) : (
            <>
              Not set up, and nothing has been uploaded.{' '}
              <InfoTip label="Why a passphrase">
                Without a passphrase, whoever runs the sync server could read what you upload. The
                connection is encrypted (TLS), but that is not end-to-end encryption.
              </InfoTip>
            </>
          )
        ) : mode === 'locked' ? (
          <>
            Locked on this device: syncing is paused until you enter the passphrase.{' '}
            <InfoTip label="What locked means">
              Locked means the key is not held here right now, so nothing is uploaded unencrypted.
            </InfoTip>
          </>
        ) : minutes !== null ? (
          <>
            Unlocked on this device for about {plural(minutes, 'minute')}, then locked again.{' '}
            <InfoTip label="About the lock">
              The key is held only in memory. When it is dropped, background syncing pauses and the
              status says locked; it is also dropped when the browser or the extension restarts.
            </InfoTip>
          </>
        ) : (
          'On, and unlocked on this device.'
        )}
      </p>

      <div className="sd-row" hidden={mode === 'locked'}>
        <Chip icon={KeyRound} tone="warning">
          No reset if lost
        </Chip>
        <InfoTip label="About the passphrase and the server">
          The passphrase never leaves this device; nobody can reset it. Your data on this device is
          not affected. With encryption on, the server cannot read your content, but still sees
          which kinds of items you have, their ids, when they change and how big they are.{' '}
          <span data-testid="e2ee-ai-note">{AI_AFTER_DECRYPTION_NOTE}</span>
        </InfoTip>
      </div>

      {(status.e2ee.setAside ?? 0) > 0 ? (
        <InlineNotice tone="warning" title="Some stored items could not be verified">
          <span data-testid="e2ee-set-aside">
            When encryption was last set up or changed,
            {setAsideNote(status.e2ee.setAside ?? 0)}
          </span>
        </InlineNotice>
      ) : null}

      {mode === 'none' && undecided ? (
        <div className="sd-stack">
          <p className="sd-line" data-testid="e2ee-choice-note">
            Pick one to start syncing.{' '}
            <InfoTip label="What no passphrase means">
              StudyVault does not send anything until you choose. {PLAIN_UPLOAD_CONSEQUENCE}
            </InfoTip>
          </p>
          <Choices<'passphrase' | 'plain'>
            name={`${headingId}-way`}
            label="How your synced data is protected"
            columns={2}
            value={way}
            onChange={setWay}
            testId="e2ee-choice"
            options={[
              {
                value: 'passphrase',
                label: 'Passphrase',
                hint: 'Server cannot read',
                icon: ShieldCheck,
                tone: 'success',
                testId: 'e2ee-choice-passphrase',
              },
              {
                value: 'plain',
                label: 'No passphrase',
                hint: 'Server can read',
                icon: Eye,
                tone: 'warning',
                testId: 'e2ee-choice-plain',
              },
            ]}
          />
          {way === 'passphrase' ? (
            setupForm
          ) : (
            <div className="sd-stack" data-testid="e2ee-plain-choice">
              <p className="sd-line">{PLAIN_UPLOAD_CONSEQUENCE}</p>
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
              <div className="sd-row">
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
          )}
        </div>
      ) : mode === 'none' ? (
        setupForm
      ) : mode === 'locked' ? (
        <div className="sd-stack">
          <PassphraseField
            label="Sync passphrase"
            value={unlockPass}
            onChange={setUnlockPass}
            testId="e2ee-unlock-passphrase"
            autoComplete="current-password"
          />
          <div className="sd-row">
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
        <div className="sd-stack">
          <div className="sd-row">
            <Button busy={lock.busy} data-testid="e2ee-lock" onClick={() => void lock.run()}>
              <Lock aria-hidden="true" className="sv-sync-btnicon" /> Lock now
            </Button>
          </div>
          <Disclosure summary="Change the passphrase" icon={KeyRound}>
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
            <div className="sd-row">
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
          </Disclosure>
        </div>
      )}
      {message ? (
        <p role="status" className="sd-line" data-testid="e2ee-message">
          {message}
        </p>
      ) : null}
    </section>
  );
}
