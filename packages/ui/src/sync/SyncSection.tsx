import { useCallback, useEffect, useId, useState } from 'react';
import { assertSecureEndpoint, normaliseBaseUrl } from '@sync';
import { Badge } from '../Badge';
import { Button } from '../Button';
import { ConfirmDialog } from '../ConfirmDialog';
import { InlineNotice } from '../Notice';
import { useAction } from '../hooks';
import { errorMessage } from '../text';
import { useSyncApi } from './api';
import { ConflictsPanel } from './ConflictsPanel';
import { NEVER_UPLOADED, PROVIDER_LEARNS, SERVER_STILL_SEES, syncedGroups } from './consent';
import { EncryptionCard } from './EncryptionCard';
import { STATUS_TEXT } from './labels';
import type { SyncConfigInput, SyncStatusView } from './protocol';
import { QuarantinePanel } from './QuarantinePanel';

/** The status of sync, kept fresh from the worker's published snapshots. */
export function useSyncStatus() {
  const api = useSyncApi();
  const [status, setStatus] = useState<SyncStatusView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.status());
      setError(null);
    } catch (err) {
      setError(errorMessage(err, 'Could not read the sync status.'));
    }
  }, [api]);

  useEffect(() => {
    let live = true;
    api.status().then(
      (next) => {
        if (live) setStatus((current) => current ?? next);
      },
      (err: unknown) => {
        if (live) setError(errorMessage(err, 'Could not read the sync status.'));
      },
    );
    const stop = api.onStatusChanged((next) => {
      if (live) setStatus(next);
    });
    return () => {
      live = false;
      stop();
    };
  }, [api]);

  return { status, error, refresh, setStatus };
}

// ---------------------------------------------------------------------------------------------
// Validation (synchronous: it runs before Chrome's permission prompt, which needs the click)
// ---------------------------------------------------------------------------------------------

type Validated =
  | { ok: true; input: SyncConfigInput; origins: string[] }
  | { ok: false; errors: Partial<Record<'serverUrl' | 'issuer' | 'clientId', string>> };

export function validateSyncInput(raw: SyncConfigInput): Validated {
  const errors: Partial<Record<'serverUrl' | 'issuer' | 'clientId', string>> = {};
  const origins: string[] = [];
  const input: SyncConfigInput = {
    serverUrl: raw.serverUrl.trim(),
    issuer: raw.issuer.trim(),
    clientId: raw.clientId.trim(),
  };
  try {
    origins.push(`${new URL(normaliseBaseUrl(input.serverUrl)).origin}/*`);
  } catch (e) {
    errors.serverUrl = e instanceof Error ? e.message : 'Enter the address of your sync server.';
  }
  try {
    origins.push(`${assertSecureEndpoint(input.issuer, 'The sign-in provider address').origin}/*`);
  } catch (e) {
    errors.issuer = e instanceof Error ? e.message : 'Enter the address of your sign-in provider.';
  }
  if (input.clientId === '') errors.clientId = 'Enter the client id registered with your provider.';
  return Object.keys(errors).length > 0
    ? { ok: false, errors }
    : { ok: true, input, origins: [...new Set(origins)] };
}

// ---------------------------------------------------------------------------------------------

function TextField({
  label,
  value,
  onChange,
  testId,
  error,
  hint,
  placeholder,
}: {
  label: string;
  value: string;
  onChange(v: string): void;
  testId: string;
  error?: string | undefined;
  hint?: string;
  placeholder?: string;
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
        type="text"
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        data-testid={testId}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? `${id}-note` : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {error || hint ? (
        <p
          id={`${id}-note`}
          className={error ? 'sv-small' : 'sv-muted sv-small'}
          role={error ? 'alert' : undefined}
        >
          {error ?? hint}
        </p>
      ) : null}
    </div>
  );
}

function formatTime(ms: number | null): string {
  return ms === null ? 'never' : new Date(ms).toLocaleString();
}

function Explanation() {
  const { groups } = syncedGroups();
  return (
    <div className="sv-stack sv-stack--tight" data-testid="sync-explanation">
      <p>
        Sync keeps your study data the same on every device you sign in on. It is off by default and
        StudyVault works fully without it. If you turn it on, this is what is uploaded:
      </p>
      <ul className="sv-sync-bullets" data-testid="sync-data-list">
        {groups.map((g) => (
          <li key={g.id} data-testid={`sync-data-${g.id}`}>
            <strong>{g.label}:</strong> {g.detail}
          </li>
        ))}
      </ul>
      <ul className="sv-sync-bullets">
        <li data-testid="sync-never-sent">
          <strong>What is never sent.</strong> {NEVER_UPLOADED}
        </li>
        <li>
          <strong>There is no StudyVault server.</strong> You enter the address of a sync server
          that you or someone you trust runs. Your study data is sent only there, and only after you
          turn sync on, sign in and choose how it is protected: nothing is uploaded before that.
        </li>
        <li>
          <strong>Who can read it.</strong> Without a passphrase the operator of that server can
          read everything you sync. The connection is encrypted (TLS), but that is not end-to-end
          encryption. With a passphrase your content is encrypted on this device before it is sent.{' '}
          <span data-testid="sync-server-sees">{SERVER_STILL_SEES}</span>
        </li>
        <li>
          <strong>The sign-in provider.</strong>{' '}
          <span data-testid="sync-provider-learns">{PROVIDER_LEARNS}</span>
        </li>
        <li>
          <strong>Permissions.</strong> Chrome will be asked to let StudyVault contact your sync
          server and sign-in provider, open the sign-in window, and wake up on a timer to sync in
          the background.
        </li>
        <li>
          <strong>Turning it off</strong> stops all of this. Your data stays on this device, and you
          can also delete what is on the server.
        </li>
      </ul>
    </div>
  );
}

function SetupForm({
  status,
  onStatus,
}: {
  status: SyncStatusView;
  onStatus(next: SyncStatusView): void;
}) {
  const api = useSyncApi();
  const [serverUrl, setServerUrl] = useState(status.config?.serverUrl ?? '');
  const [issuer, setIssuer] = useState(status.config?.issuer ?? '');
  const [clientId, setClientId] = useState(status.config?.clientId ?? '');
  const [ack, setAck] = useState(false);
  const [errors, setErrors] = useState<
    Partial<Record<'serverUrl' | 'issuer' | 'clientId', string>>
  >({});
  const [declined, setDeclined] = useState(false);

  const turnOn = useAction(async () => {
    setDeclined(false);
    const checked = validateSyncInput({ serverUrl, issuer, clientId });
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    // First await in the click handler: Chrome's permission prompt needs the user gesture.
    const granted = await api.requestPermissions({
      permissions: ['identity', 'alarms'],
      origins: checked.origins,
    });
    if (!granted) {
      setDeclined(true);
      return;
    }
    await api.configure(checked.input);
    onStatus(await api.enable());
  });

  return (
    <div className="sv-stack" data-testid="sync-setup">
      <Explanation />
      <div className="sv-stack sv-stack--tight">
        <TextField
          label="Sync server address"
          value={serverUrl}
          onChange={setServerUrl}
          testId="sync-server-url"
          error={errors.serverUrl}
          placeholder="https://sync.example.org"
          hint="https only. Plain http is accepted for localhost (development) only."
        />
        <TextField
          label="Sign-in provider (OpenID Connect issuer)"
          value={issuer}
          onChange={setIssuer}
          testId="sync-issuer"
          error={errors.issuer}
          placeholder="https://id.example.org"
        />
        <TextField
          label="Client id"
          value={clientId}
          onChange={setClientId}
          testId="sync-client-id"
          error={errors.clientId}
          hint="A public client (no secret) registered with your provider for the authorization-code flow with PKCE."
        />
        <p className="sv-small">
          Register this redirect address with your provider:{' '}
          <code data-testid="sync-redirect-url">{status.redirectUrl}</code>
        </p>
      </div>

      <label className="sv-check">
        <input
          type="checkbox"
          checked={ack}
          data-testid="sync-ack"
          onChange={(e) => setAck(e.target.checked)}
        />
        <span>
          I understand that my study data will be sent to the server above once I choose how it is
          protected, and that its operator can read it unless I set a sync passphrase.
        </span>
      </label>

      <div className="sv-row">
        <Button
          variant="primary"
          busy={turnOn.busy}
          disabledReason={ack ? undefined : 'Confirm that you understand where your data will go.'}
          data-testid="sync-enable"
          onClick={() => void turnOn.run()}
        >
          Turn on sync&hellip;
        </Button>
        {turnOn.busy ? (
          <span className="sv-small sv-muted" role="status" data-testid="sync-enable-status">
            Turning on sync… Chrome may ask you to allow access to the server and the sign-in
            provider first.
          </span>
        ) : null}
      </div>
      {declined ? (
        <InlineNotice tone="warning" title="Chrome did not grant the permissions">
          Nothing was changed and sync is still off.
        </InlineNotice>
      ) : null}
      {turnOn.error ? (
        <InlineNotice tone="error" title="Sync was not turned on">
          {turnOn.error}
        </InlineNotice>
      ) : null}
    </div>
  );
}

function SignOutDialog({
  busy,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  onCancel(): void;
  onConfirm(o: { wipeLocalData: boolean; revokeAtProvider: boolean }): void;
}) {
  const [wipe, setWipe] = useState(false);
  const [typed, setTyped] = useState('');
  const [revoke, setRevoke] = useState(true);
  const [needTyped, setNeedTyped] = useState(false);
  return (
    <ConfirmDialog
      title="Sign out of sync?"
      confirmLabel={wipe ? 'Sign out and remove data' : 'Sign out'}
      danger={wipe}
      onCancel={onCancel}
      onConfirm={() => {
        if (wipe && typed.trim().toLowerCase() !== 'delete') {
          setNeedTyped(true);
          return;
        }
        onConfirm({ wipeLocalData: wipe, revokeAtProvider: revoke });
      }}
    >
      <p>
        Signing out removes the sign-in from this browser, stops syncing and locks encryption. What
        happens to the data on this device is your choice:
      </p>
      <label className="sv-check">
        <input
          type="radio"
          name="sync-signout-data"
          checked={!wipe}
          data-testid="sync-signout-keep"
          onChange={() => setWipe(false)}
        />
        <span>Keep my data on this device (recommended).</span>
      </label>
      <label className="sv-check">
        <input
          type="radio"
          name="sync-signout-data"
          checked={wipe}
          data-testid="sync-signout-wipe"
          onChange={() => setWipe(true)}
        />
        <span>
          Remove all StudyVault data from this device too. It stays on the server and your other
          devices; this cannot be undone here.
        </span>
      </label>
      {wipe ? (
        <div className="sv-field">
          <label className="sv-label" htmlFor="sync-signout-typed">
            Type delete to confirm
          </label>
          <input
            id="sync-signout-typed"
            className="sv-control"
            value={typed}
            data-testid="sync-signout-typed"
            onChange={(e) => setTyped(e.target.value)}
          />
          {needTyped ? <p role="alert">Type the word delete to remove the data.</p> : null}
        </div>
      ) : null}
      <label className="sv-check">
        <input
          type="checkbox"
          checked={revoke}
          disabled={busy}
          onChange={(e) => setRevoke(e.target.checked)}
        />
        <span>Also ask the sign-in provider to end this session.</span>
      </label>
    </ConfirmDialog>
  );
}

function DeleteServerDialog({ onCancel, onConfirm }: { onCancel(): void; onConfirm(): void }) {
  const [typed, setTyped] = useState('');
  const [wrong, setWrong] = useState(false);
  return (
    <ConfirmDialog
      title="Delete my data from the server?"
      confirmLabel="Delete from the server"
      danger
      onCancel={onCancel}
      onConfirm={() => {
        if (typed.trim().toLowerCase() !== 'delete') {
          setWrong(true);
          return;
        }
        onConfirm();
      }}
    >
      <p>
        This erases everything the server holds for your account: all synced items and your
        encryption key. Other devices will notice and ask what to do. Data on this device is not
        touched, and you can send it again later.
      </p>
      <p>
        <strong>This cannot be undone.</strong> The server operator&apos;s own backups are governed
        by their policy, not by this button.
      </p>
      <div className="sv-field">
        <label className="sv-label" htmlFor="sync-delete-typed">
          Type delete to confirm
        </label>
        <input
          id="sync-delete-typed"
          className="sv-control"
          value={typed}
          data-testid="sync-delete-confirm-input"
          onChange={(e) => setTyped(e.target.value)}
        />
        {wrong ? <p role="alert">Type the word delete to continue.</p> : null}
      </div>
    </ConfirmDialog>
  );
}

function Connected({
  status,
  onStatus,
  refresh,
}: {
  status: SyncStatusView;
  onStatus(next: SyncStatusView): void;
  refresh(): Promise<void>;
}) {
  const api = useSyncApi();
  const [needsOrigins, setNeedsOrigins] = useState<string[]>([]);
  const [signingOut, setSigningOut] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmRebind, setConfirmRebind] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const signIn = useAction(async () => {
    setNote(null);
    const result = await api.signIn();
    onStatus(result.status);
    setNeedsOrigins(result.needsOrigins);
  });
  const allow = useAction(async () => {
    // First await: the permission prompt needs this click.
    const granted = await api.requestPermissions({ origins: needsOrigins });
    if (!granted) {
      setNote('Chrome did not grant access, so sign-in cannot continue.');
      return;
    }
    setNeedsOrigins([]);
    await signIn.run();
  });
  const signOut = useAction(async (o: { wipeLocalData: boolean; revokeAtProvider: boolean }) => {
    setSigningOut(false);
    onStatus(await api.signOut(o));
    setNote(
      o.wipeLocalData
        ? 'Signed out. The data on this device was removed.'
        : 'Signed out. Your data stays on this device.',
    );
  });
  const syncNow = useAction(async () => {
    setNote(null);
    onStatus(await api.syncNow());
  });
  const turnOff = useAction(async () => {
    onStatus(await api.disable());
  });
  const deleteData = useAction(async () => {
    setDeleting(false);
    onStatus(await api.deleteServerData());
    setNote(
      'Your data on the server was deleted. This device still has everything; use "Send this device’s data again" to put it back.',
    );
  });
  const reupload = useAction(async () => {
    onStatus(await api.reupload());
    setNote('This device’s data is being sent again.');
  });
  const rebind = useAction(async () => {
    setConfirmRebind(false);
    onStatus(await api.rebind());
  });

  const awaitingChoice = status.status === 'awaiting_encryption_choice';
  const canSync = status.signedIn && status.status !== 'locked' && !awaitingChoice;
  const attentionKey = `${status.attention.conflicts}:${status.attention.quarantined}:${status.lastSyncAt ?? 0}`;
  const outsideEnabledNeeds = status.permissions.missingOrigins;

  return (
    <div className="sv-stack" data-testid="sync-connected">
      <div className="sv-stack sv-stack--tight" aria-live="polite">
        <div className="sv-row">
          <Badge
            tone={
              status.status === 'idle'
                ? 'success'
                : status.status === 'error' ||
                    status.status === 'resync_required' ||
                    status.status === 'account_mismatch'
                  ? 'danger'
                  : 'warning'
            }
          >
            <span data-testid="sync-status">
              {status.running ? 'Syncing…' : STATUS_TEXT[status.status]}
            </span>
          </Badge>
        </div>
        <p>
          Last synced: <span data-testid="sync-last-sync">{formatTime(status.lastSyncAt)}</span>
          {' · '}
          <span data-testid="sync-pending">
            {status.pending === 0
              ? 'nothing waiting to upload'
              : `${status.pending} change${status.pending === 1 ? '' : 's'} waiting to upload`}
          </span>
        </p>
        {status.lastError && status.status !== 'idle' ? (
          <p className="sv-muted sv-small" data-testid="sync-error">
            {status.lastError.message}
          </p>
        ) : null}
      </div>

      {status.problem ? (
        <InlineNotice tone="error" title="Sync cannot start">
          {status.problem}
        </InlineNotice>
      ) : null}

      {awaitingChoice ? (
        <InlineNotice tone="warning" title="Nothing is uploaded until you choose" live>
          <span data-testid="sync-awaiting-choice">
            You are signed in, but StudyVault has not sent anything yet. Set a passphrase, or choose
            to upload without end-to-end encryption, in the encryption section below.
          </span>
        </InlineNotice>
      ) : null}

      {status.scheduling === 'while-awake' ? (
        <InlineNotice tone="info" title="No background timer" live>
          <span data-testid="sync-scheduling-note">
            Chrome has not given StudyVault the timer permission, so sync runs when you change
            something, when the browser starts, and when you press Sync now.
          </span>
        </InlineNotice>
      ) : null}

      <div className="sv-stack sv-stack--tight">
        <h3>Account</h3>
        <p data-testid="sync-account">
          {status.signedIn
            ? `Signed in${status.account ? ` as ${status.account}` : ''}.`
            : 'Not signed in.'}
          {status.config ? ` Server: ${status.config.serverUrl}` : ''}
        </p>
        <div className="sv-row">
          {status.signedIn ? (
            <>
              <Button
                variant="primary"
                busy={syncNow.busy || status.running}
                disabledReason={
                  canSync
                    ? undefined
                    : !status.signedIn
                      ? 'Sign in first.'
                      : awaitingChoice
                        ? 'Choose how your data is protected first (below).'
                        : 'Unlock encryption first.'
                }
                data-testid="sync-now"
                onClick={() => void syncNow.run()}
              >
                Sync now
              </Button>
              <Button data-testid="sync-sign-out" onClick={() => setSigningOut(true)}>
                Sign out&hellip;
              </Button>
            </>
          ) : needsOrigins.length > 0 || outsideEnabledNeeds.length > 0 ? (
            <Button
              variant="primary"
              busy={allow.busy}
              data-testid="sync-allow-origins"
              onClick={() => void allow.run()}
            >
              Allow access to{' '}
              {(needsOrigins.length > 0 ? needsOrigins : outsideEnabledNeeds).join(', ')}
            </Button>
          ) : (
            <Button
              variant="primary"
              busy={signIn.busy}
              disabledReason={
                status.permissions.identity
                  ? undefined
                  : 'Chrome has not allowed the sign-in window.'
              }
              data-testid="sync-sign-in"
              onClick={() => void signIn.run()}
            >
              Sign in
            </Button>
          )}
        </div>
        {signIn.error ? (
          <InlineNotice tone="error" title="Sign-in did not complete">
            {signIn.error}
          </InlineNotice>
        ) : null}
        {allow.error || syncNow.error ? (
          <InlineNotice tone="error" title="That did not work">
            {allow.error ?? syncNow.error}
          </InlineNotice>
        ) : null}
        {note ? (
          <p role="status" data-testid="sync-note">
            {note}
          </p>
        ) : null}
      </div>

      {status.status === 'resync_required' ? (
        <InlineNotice
          tone="warning"
          title="The server's data changed underneath this device"
          action={
            <Button
              busy={reupload.busy}
              data-testid="sync-reupload"
              onClick={() => void reupload.run()}
            >
              Send this device&apos;s data again
            </Button>
          }
        >
          The server&apos;s data was erased, restored or replaced. Nothing was changed on this
          device. Sending your data again puts it back on the server; items changed on another
          device in the meantime may be overwritten by what this device holds.
        </InlineNotice>
      ) : null}

      {status.status === 'account_mismatch' ? (
        <InlineNotice
          tone="warning"
          title="This device holds data from another account"
          action={
            <Button data-testid="sync-rebind" onClick={() => setConfirmRebind(true)}>
              Attach this data to the signed-in account&hellip;
            </Button>
          }
        >
          Nothing was uploaded or merged. You can sign out and sign in with the original account, or
          attach this device&apos;s data to the account you are signed in with now.
        </InlineNotice>
      ) : null}

      <EncryptionCard
        status={status}
        onChanged={(next) => {
          if (next) onStatus(next);
          else void refresh();
        }}
      />

      {status.notSynced.length > 0 ? (
        <p className="sv-muted sv-small" data-testid="sync-not-synced">
          Not synchronised yet: {status.notSynced.join(', ')}. These stay on this device only.
        </p>
      ) : null}

      <ConflictsPanel refreshKey={attentionKey} />
      <QuarantinePanel refreshKey={attentionKey} />

      <div className="sv-stack sv-stack--tight">
        <h3>Turn off or delete</h3>
        <div className="sv-row">
          <Button busy={turnOff.busy} data-testid="sync-disable" onClick={() => void turnOff.run()}>
            Turn sync off
          </Button>
          <Button
            variant="danger"
            disabledReason={
              status.signedIn ? undefined : 'Sign in to delete what the server holds.'
            }
            data-testid="sync-delete-server-data"
            onClick={() => setDeleting(true)}
          >
            Delete my data from the server&hellip;
          </Button>
          {turnOff.busy ? (
            <span className="sv-small sv-muted" role="status" data-testid="sync-disable-status">
              Turning sync off…
            </span>
          ) : null}
        </div>
        <p className="sv-muted sv-small">
          Turning sync off keeps everything on this device and removes the sign-in from this
          browser.
        </p>
        {turnOff.error || deleteData.error || reupload.error || rebind.error ? (
          <InlineNotice tone="error" title="That did not work">
            {turnOff.error ?? deleteData.error ?? reupload.error ?? rebind.error}
          </InlineNotice>
        ) : null}
      </div>

      {signingOut ? (
        <SignOutDialog
          busy={signOut.busy}
          onCancel={() => setSigningOut(false)}
          onConfirm={(o) => void signOut.run(o)}
        />
      ) : null}
      {deleting ? (
        <DeleteServerDialog
          onCancel={() => setDeleting(false)}
          onConfirm={() => void deleteData.run()}
        />
      ) : null}
      {confirmRebind ? (
        <ConfirmDialog
          title="Attach this data to the signed-in account?"
          confirmLabel="Attach"
          onCancel={() => setConfirmRebind(false)}
          onConfirm={() => void rebind.run()}
        >
          <p>
            Everything on this device will be uploaded to the account you are signed in with. Make
            sure that is the account you want this data to belong to.
          </p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

/**
 * Settings section for optional sync: the explanation and consent, server and provider setup,
 * sign-in and sign-out, status and "sync now", end-to-end encryption, conflicts, refused changes,
 * and deleting what the server holds. Every control either works or is disabled with its reason.
 */
export function SyncSection() {
  const headingId = useId();
  const { status, error, refresh, setStatus } = useSyncStatus();

  return (
    <section className="sv-stack" aria-labelledby={headingId} data-testid="sync-section">
      <h2 id={headingId}>Sync between devices (optional)</h2>
      {error ? (
        <InlineNotice
          tone="error"
          title="Could not read the sync status"
          action={<Button onClick={() => void refresh()}>Retry</Button>}
        >
          {error}
        </InlineNotice>
      ) : status === null ? (
        <p className="sv-muted">Loading&hellip;</p>
      ) : status.enabled ? (
        <Connected status={status} onStatus={setStatus} refresh={refresh} />
      ) : (
        <SetupForm status={status} onStatus={setStatus} />
      )}
    </section>
  );
}
