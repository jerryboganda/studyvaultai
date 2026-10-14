import { updateSettings } from '@runtime';
import { getDb, listRecentHighlights } from '@storage';
import type { SyncStatusView } from '@ui/sync/protocol';
import { browser, gallery } from '../shim/chrome';

/**
 * "Sync signed in" for the gallery: the real sync service has no server or sign-in here, so the
 * settings page's sync RPC is answered with canned status views (gallery.answers), and conflicts
 * are written to the real conflicts table the panel reads. Nothing is sent anywhere.
 */
type View = Partial<Omit<SyncStatusView, 'e2ee'>> & { e2ee?: Partial<SyncStatusView['e2ee']> };

export async function fakeSync(over: View = {}): Promise<SyncStatusView> {
  const base: SyncStatusView = {
    enabled: true,
    config: {
      serverUrl: 'https://sync.sample.example',
      issuer: 'https://login.sample.example',
      clientId: 'studyvault-gallery',
    },
    redirectUrl: browser.identity.getRedirectURL(),
    permissions: { identity: true, alarms: true, missingOrigins: [] },
    signedIn: true,
    account: 'student@sample.example',
    status: 'idle',
    lastSyncAt: Date.now() - 4 * 60_000,
    pending: 0,
    lastError: null,
    retryAt: null,
    running: false,
    e2ee: { mode: 'unlocked', version: 1, lockInSeconds: 540, warning: null, setAside: 0 },
    encryptionChoice: 'e2ee',
    attention: { conflicts: 0, quarantined: 0 },
    notSynced: [],
    problem: null,
    scheduling: 'alarms',
  };
  const view = { ...base, ...over, e2ee: { ...base.e2ee, ...over.e2ee } };
  await updateSettings((s) => ({ ...s, features: { ...s.features, sync: true } }));
  for (const type of ['sync.status', 'sync.now', 'sync.e2ee.lock']) {
    gallery.answers[type] = () => view;
  }
  gallery.answers['sync.e2ee.unlock'] = () => ({ ok: false, reason: 'wrong_passphrase' });
  return view;
}

/** A note edited on two devices: the conflict the panel asks about (packages/sync ConflictRecord). */
export async function seedConflict(): Promise<void> {
  const [recent] = await listRecentHighlights(1);
  if (!recent) throw new Error('This scenario has no highlight to put in conflict.');
  const at = Date.now() - 20 * 60_000;
  await getDb().syncConflicts.put({
    id: `gallery-conflict-${recent.highlight.id}`,
    entityType: 'highlights',
    entityId: recent.highlight.id,
    field: 'userComment',
    kind: 'text_edit',
    local: { value: 'Check the dose in renal failure (written on this laptop).', hlc: null },
    remote: {
      value: 'Dose adjust when eGFR < 30 (written on the library computer).',
      hlc: `${at.toString(36).padStart(9, '0')}.0001.gallery-other-device`,
    },
    base: 'Check the dose.',
    detectedAt: at,
    resolution: null,
  });
}
