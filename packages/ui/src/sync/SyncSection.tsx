import { useCallback, useEffect, useId, useState } from 'react';
import './sync.css';
import {
  CircleCheck,
  CloudOff,
  CloudUpload,
  Database,
  Eye,
  FileText,
  Globe,
  Highlighter,
  History,
  KeyRound,
  Layers,
  Library,
  LogIn,
  LogOut,
  NotebookPen,
  Power,
  RefreshCw,
  ScanText,
  Server,
  ServerOff,
  ShieldCheck,
  Timer,
  TriangleAlert,
  UserRound,
  type LucideIcon,
} from 'lucide-react';
import { assertSecureEndpoint, normaliseBaseUrl, type SyncStatus } from '@sync';
import { Button } from '../Button';
import { ConfirmDialog } from '../ConfirmDialog';
import { ChunkyButton } from '../design/Buttons';
import { InfoTip } from '../design/InfoTip';
import { Stepper } from '../design/Stepper';
import { VaultBuddy } from '../design/VaultBuddy';
import { InlineNotice } from '../Notice';
import { useAction } from '../hooks';
import { errorMessage } from '../text';
import {
  Chip,
  Disclosure,
  Fact,
  Facts,
  SectionHead,
  StepError,
  StepFlow,
  type ChipTone,
  type FlowStep,
} from '../backup/kit';
import { useSyncApi } from './api';
import { ConflictsPanel } from './ConflictsPanel';
import {
  NEVER_UPLOADED,
  PROVIDER_LEARNS,
  SERVER_STILL_SEES,
  syncedGroups,
  type SyncedGroup,
} from './consent';
import { EncryptionCard } from './EncryptionCard';
import { STATUS_DETAIL, STATUS_TEXT } from './labels';
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

/** A wizard field: when invalid, the step's error (shown once, under the step) describes it. */
function TextField({
  label,
  value,
  onChange,
  testId,
  invalid = false,
  errorId,
  hint,
  placeholder,
}: {
  label: string;
  value: string;
  onChange(v: string): void;
  testId: string;
  invalid?: boolean;
  /** The step error's id, when this field is the one it names. */
  errorId?: string | undefined;
  hint?: string;
  placeholder?: string;
}) {
  const id = useId();
  const described = [hint ? `${id}-note` : '', errorId ?? ''].filter(Boolean).join(' ');
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
        aria-invalid={invalid || undefined}
        aria-describedby={described || undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint ? (
        <p id={`${id}-note`} className="sv-muted sv-small">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** The server as a short chip: its host (the full address is in the setup). */
function serverHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function formatTime(ms: number | null): string {
  return ms === null ? 'never' : new Date(ms).toLocaleString();
}

/** Tile names (<= 2 words); the consent text keeps the full names and details. */
const GROUP_SHORT: Partial<Record<SyncedGroup['id'], string>> = {
  pages: 'Page addresses',
  organisation: 'Banks and tags',
  scans: 'Scanned text',
};

const GROUP_ICON: Record<SyncedGroup['id'], LucideIcon> = {
  highlights: Highlighter,
  pages: Globe,
  organisation: Library,
  notes: NotebookPen,
  flashcards: Layers,
  history: History,
  pdfs: FileText,
  scans: ScanText,
  other: Database,
};

/** The full consent text, kept whole (the setup steps show the short version and this). */
function Explanation() {
  const { groups } = syncedGroups();
  return (
    <div className="sd-stack" data-testid="sync-explanation">
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

/** What is uploaded, as icon tiles; the details stay one click away. */
function SharedTiles() {
  const { groups } = syncedGroups();
  return (
    <ul className="sv-sync-tiles" aria-label="What is uploaded">
      {groups.map((g) => {
        const Icon = GROUP_ICON[g.id] ?? Database;
        return (
          <li key={g.id}>
            <span className="sv-sync-tile__icon sv-art--primary" aria-hidden="true">
              <Icon strokeWidth={2.4} />
            </span>
            <span>{GROUP_SHORT[g.id] ?? g.label}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** Turning sync on as a wizard: what is shared, the server, the sign-in provider, a last look. */
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
  const [index, setIndex] = useState(0);
  const [declined, setDeclined] = useState(false);

  const checked = validateSyncInput({ serverUrl, issuer, clientId });
  const errors = checked.ok ? {} : checked.errors;

  const turnOn = useAction(async () => {
    setDeclined(false);
    const valid = validateSyncInput({ serverUrl, issuer, clientId });
    if (!valid.ok) return;
    // First await in the click handler: Chrome's permission prompt needs the user gesture.
    const granted = await api.requestPermissions({
      permissions: ['identity', 'alarms'],
      origins: valid.origins,
    });
    if (!granted) {
      setDeclined(true);
      return;
    }
    await api.configure(valid.input);
    onStatus(await api.enable());
  });

  const steps: FlowStep[] = [
    {
      id: 'shared',
      title: 'What is shared',
      content: (
        <>
          <p className="sd-line">Uploaded only after you sign in and choose how it is protected.</p>
          <SharedTiles />
          <div className="sd-row">
            <Chip icon={ServerOff}>No StudyVault server</Chip>
            <Chip icon={Eye} tone="warning">
              Readable without passphrase
            </Chip>
            <Chip icon={FileText}>PDF files stay</Chip>
          </div>
          <Disclosure summary="Every detail" icon={ShieldCheck}>
            <Explanation />
          </Disclosure>
        </>
      ),
    },
    {
      id: 'server',
      title: 'Sync server',
      validate: () => errors.serverUrl ?? null,
      inlineError: true,
      content: ({ error, errorId }) => (
        <>
          <p className="sd-line">A server you or someone you trust runs.</p>
          <TextField
            label="Sync server address"
            value={serverUrl}
            onChange={setServerUrl}
            testId="sync-server-url"
            invalid={!!error}
            errorId={error ? errorId : undefined}
            placeholder="https://sync.example.org"
            hint="https only (http for localhost)."
          />
          {error ? <StepError id={errorId}>{error}</StepError> : null}
        </>
      ),
    },
    {
      id: 'signin',
      title: 'Sign-in provider',
      validate: () => errors.issuer ?? errors.clientId ?? null,
      inlineError: true,
      content: ({ error, errorId }) => (
        <>
          <p className="sd-line">
            Your OpenID Connect provider.{' '}
            <InfoTip label="About the sign-in provider">
              Register a public client (no secret) for the authorization-code flow with PKCE, and
              add the redirect address below. {PROVIDER_LEARNS}
            </InfoTip>
          </p>
          <TextField
            label="Provider address"
            value={issuer}
            onChange={setIssuer}
            testId="sync-issuer"
            invalid={!!error && !!errors.issuer}
            errorId={error && errors.issuer ? errorId : undefined}
            placeholder="https://id.example.org"
          />
          {error && errors.issuer ? <StepError id={errorId}>{error}</StepError> : null}
          <TextField
            label="Client id"
            value={clientId}
            onChange={setClientId}
            testId="sync-client-id"
            invalid={!!error && !!errors.clientId}
            errorId={error && !errors.issuer && errors.clientId ? errorId : undefined}
          />
          {error && !errors.issuer ? <StepError id={errorId}>{error}</StepError> : null}
          <p className="sd-line">
            Redirect address: <code data-testid="sync-redirect-url">{status.redirectUrl}</code>
          </p>
        </>
      ),
    },
    {
      id: 'check',
      title: 'Looks good?',
      validate: () => (ack ? null : 'Confirm that you understand where your data will go.'),
      inlineError: true,
      content: ({ error, errorId }) => (
        <>
          <Facts>
            <Fact icon={Server} label="Sync server">
              {serverUrl.trim()}
            </Fact>
            <Fact icon={LogIn} label="Sign-in provider">
              {issuer.trim()}
            </Fact>
            <Fact icon={KeyRound} label="Client id">
              {clientId.trim()}
            </Fact>
          </Facts>
          <label className="sv-check">
            <input
              type="checkbox"
              checked={ack}
              data-testid="sync-ack"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              onChange={(e) => setAck(e.target.checked)}
            />
            <span>
              I understand that my study data will be sent to the server above once I choose how it
              is protected, and that its operator can read it unless I set a sync passphrase.
            </span>
          </label>
          {error ? <StepError id={errorId}>{error}</StepError> : null}
          <p className="sd-line">
            Chrome then asks to allow these two addresses, the sign-in window and a timer.
          </p>
          {turnOn.busy ? (
            <p className="sd-progress__line" role="status" data-testid="sync-enable-status">
              Turning on sync… Chrome may ask you to allow access first.
            </p>
          ) : null}
        </>
      ),
    },
  ];

  return (
    <div className="sd-stack" data-testid="sync-setup">
      <StepFlow
        label="Sync setup"
        steps={steps}
        index={index}
        onIndex={setIndex}
        testId="sync-setup-flow"
        finish={{
          label: 'Turn on sync',
          icon: Power,
          testId: 'sync-enable',
          busy: turnOn.busy,
          onClick: () => void turnOn.run(),
        }}
      />
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

const STATUS_LOOK: Record<SyncStatus, { tone: ChipTone; icon: LucideIcon }> = {
  disabled: { tone: 'neutral', icon: Power },
  idle: { tone: 'success', icon: CircleCheck },
  syncing: { tone: 'info', icon: RefreshCw },
  offline: { tone: 'warning', icon: CloudOff },
  backoff: { tone: 'warning', icon: Timer },
  auth_required: { tone: 'warning', icon: LogIn },
  locked: { tone: 'warning', icon: KeyRound },
  awaiting_encryption_choice: { tone: 'warning', icon: ShieldCheck },
  resync_required: { tone: 'danger', icon: TriangleAlert },
  account_mismatch: { tone: 'danger', icon: UserRound },
  error: { tone: 'danger', icon: TriangleAlert },
};

/** The one status chip: the words always say what the colour says. */
function StatusChip({ status, main = false }: { status: SyncStatusView; main?: boolean }) {
  const look = status.running ? STATUS_LOOK.syncing : STATUS_LOOK[status.status];
  return (
    <Chip icon={look.icon} tone={look.tone}>
      <span data-testid={main ? 'sync-status' : undefined}>
        {status.running ? 'Syncing…' : STATUS_TEXT[status.status]}
      </span>
    </Chip>
  );
}

/** The steps after "Turn on": sign in, choose protection, first sync. */
const JOURNEY = ['Turn on', 'Sign in', 'Protect', 'Sync'];

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
  const journey = !status.signedIn ? 1 : awaitingChoice ? 2 : status.lastSyncAt === null ? 3 : 4;
  const detail = status.running ? null : STATUS_DETAIL[status.status];

  return (
    <div className="sd-stack" data-testid="sync-connected">
      {journey < 4 ? (
        <div className="sd-card sv-sync-journey" data-testid="sync-journey">
          <p className="sv-wiz__eyebrow">Almost there</p>
          <Stepper steps={JOURNEY} current={Math.min(journey, 3)} label="Sync setup" />
          <ol className="sv-sync-steps">
            {JOURNEY.map((name, i) => (
              <li key={name} data-state={i < journey ? 'done' : i === journey ? 'now' : 'next'}>
                {i < journey ? (
                  <CircleCheck aria-hidden="true" strokeWidth={2.6} />
                ) : (
                  <span aria-hidden="true">{i + 1}</span>
                )}
                {name}
                <span className="sv-vh">
                  {i < journey ? ' (done)' : i === journey ? ' (current step)' : ''}
                </span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      <div className="sd-card" data-testid="sync-status-card">
        <div className="sd-stack" aria-live="polite">
          <div className="sd-row">
            <span className="sd-tile sd-tile--sm sv-art--primary" aria-hidden="true">
              <RefreshCw strokeWidth={2.4} />
            </span>
            <StatusChip status={status} main />
            <span className="sd-line">
              Last sync: <span data-testid="sync-last-sync">{formatTime(status.lastSyncAt)}</span>
            </span>
          </div>
          {detail ? <p className="sd-line">{detail}</p> : null}
          <div className="sd-row">
            <Chip icon={CloudUpload} tone={status.pending === 0 ? 'neutral' : 'info'}>
              <span data-testid="sync-pending">
                {status.pending === 0
                  ? 'nothing waiting to upload'
                  : `${status.pending} change${status.pending === 1 ? '' : 's'} waiting to upload`}
              </span>
            </Chip>
            <Chip icon={UserRound} tone={status.signedIn ? 'neutral' : 'warning'}>
              <span data-testid="sync-account">
                {status.signedIn
                  ? `Signed in${status.account ? ` as ${status.account}` : ''}`
                  : 'Not signed in.'}
              </span>
            </Chip>
            {status.config ? (
              <Chip icon={Server}>
                <span className="sv-vh">Server: </span>
                {serverHost(status.config.serverUrl)}
              </Chip>
            ) : null}
          </div>
          {status.lastError && status.status !== 'idle' ? (
            <p className="sd-line" data-testid="sync-error">
              {status.lastError.message}
            </p>
          ) : null}
        </div>
        <div className="sd-row">
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
                <RefreshCw aria-hidden="true" className="sv-sync-btnicon" /> Sync now
              </Button>
              <ChunkyButton
                variant="ghost"
                icon={LogOut}
                data-testid="sync-sign-out"
                onClick={() => setSigningOut(true)}
              >
                Sign out…
              </ChunkyButton>
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
              <LogIn aria-hidden="true" className="sv-sync-btnicon" /> Sign in
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
          <p role="status" className="sd-line" data-testid="sync-note">
            {note}
          </p>
        ) : null}
      </div>

      {status.problem ? (
        <InlineNotice tone="error" title="Sync cannot start">
          {status.problem}
        </InlineNotice>
      ) : null}

      {awaitingChoice ? (
        <InlineNotice tone="warning" title="Nothing uploaded yet" live>
          <span data-testid="sync-awaiting-choice">
            StudyVault has not sent anything yet. Pick a protection below.
          </span>
        </InlineNotice>
      ) : null}

      {status.scheduling === 'while-awake' ? (
        <InlineNotice tone="info" title="No background timer" live>
          <span data-testid="sync-scheduling-note">
            Sync runs when you change something, when the browser starts and on Sync now.{' '}
            <InfoTip label="Why no timer">
              Chrome has not given StudyVault the timer permission, so it cannot wake up on its own
              to sync in the background.
            </InfoTip>
          </span>
        </InlineNotice>
      ) : null}

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
          It was erased, restored or replaced; nothing changed here. Sending again may overwrite
          newer edits made on another device.
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
          Nothing was uploaded or merged. Sign in with the original account, or attach this data to
          the one you use now.
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
        <p className="sd-line" data-testid="sync-not-synced">
          Not synchronised yet: {status.notSynced.join(', ')}. These stay on this device only.
        </p>
      ) : null}

      <div className="sv-sync-pair">
        <ConflictsPanel refreshKey={attentionKey} />
        <QuarantinePanel refreshKey={attentionKey} />
      </div>

      <Disclosure summary="Turn off or delete" icon={Power} testId="sync-danger">
        <div className="sd-row">
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
            <span className="sd-line" role="status" data-testid="sync-disable-status">
              Turning sync off…
            </span>
          ) : null}
        </div>
        <p className="sd-line">Turning off keeps everything here and removes the sign-in.</p>
        {turnOff.error || deleteData.error || reupload.error || rebind.error ? (
          <InlineNotice tone="error" title="That did not work">
            {turnOff.error ?? deleteData.error ?? reupload.error ?? rebind.error}
          </InlineNotice>
        ) : null}
      </Disclosure>

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
 * Settings section for optional sync: the setup wizard (what is shared, server, sign-in provider,
 * consent), then one status chip with the last sync time, sign-in, end-to-end encryption, conflicts,
 * refused changes, and turning off or deleting what the server holds. Every control either works or
 * is disabled with its reason.
 */
export function SyncSection() {
  const headingId = useId();
  const { status, error, refresh, setStatus } = useSyncStatus();

  return (
    <section className="sd-section" aria-labelledby={headingId} data-testid="sync-section">
      <SectionHead
        icon={RefreshCw}
        id={headingId}
        title="Sync between devices"
        line={
          status === null || status.enabled ? null : (
            <>
              <Chip icon={Power}>Off</Chip> Optional. StudyVault works fully without it.
            </>
          )
        }
      />
      {error ? (
        <InlineNotice
          tone="error"
          title="Could not read the sync status"
          action={<Button onClick={() => void refresh()}>Retry</Button>}
        >
          {error}
        </InlineNotice>
      ) : status === null ? (
        <div className="sd-card sv-sync-loading" role="status">
          <VaultBuddy pose="think" size={64} />
          <p className="sd-line">Loading&hellip;</p>
        </div>
      ) : status.enabled ? (
        <Connected status={status} onStatus={setStatus} refresh={refresh} />
      ) : (
        <SetupForm status={status} onStatus={setStatus} />
      )}
    </section>
  );
}
