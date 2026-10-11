import { STUDYVAULT_SYNC_POLICY } from '@sync';
import { NEVER_UPLOADED, PROVIDER_LEARNS, SERVER_STILL_SEES, syncedGroups } from '@ui/sync/consent';
import { STATUS_TEXT } from '@ui/sync/labels';
import { stopWorker, workerState } from './helpers.lifecycle';
import {
  OTHER_PASSPHRASE,
  PASSPHRASE,
  WAITING,
  alarmNames,
  encryptionModeOf,
  expect,
  expectAccessible,
  highlightRows,
  launchProfile,
  metaValue,
  openSyncSettings,
  saveQuote,
  serverText,
  sessionStore,
  setComment,
  signIn,
  syncConfigOf,
  syncFlag,
  syncNow,
  syncSection,
  syncStatusOf,
  test,
  turnOnEncryption,
  turnOnSync,
} from './helpers.sync';

/**
 * Optional sync, end to end: the real extension in real Chromium, the repository's reference server
 * (`server/src`) over a JSON-file store, and a stand-in OpenID Connect provider that issues real
 * ES256 access tokens the server verifies against its JWKS (tests/e2e/syncServer.ts).
 *
 * What is REAL here: the settings page and its controls, `chrome.permissions.request` (Chromium grants
 * the optional `identity` and `alarms` permissions without a prompt, and the e2e manifest holds the
 * loopback hosts), `chrome.identity.launchWebAuthFlow` (a real, headless auth window that follows the
 * provider's 302 to `https://<id>.chromiumapp.org/sync`), `chrome.alarms`, `chrome.storage.session`,
 * the service worker with its suspension, and a second browser profile with its own user data dir.
 * No e2e hook, no stubbed Chrome API and no production code path is changed for these tests.
 *
 * What is NOT driven (and why) is listed at the end as `test.fixme`: the native permission prompt, a
 * host origin Chrome has not granted, and a hosted identity provider over https.
 */

const QUOTE = 'Digoxin toxicity is worsened by hypokalaemia and by loop diuretics.';
const TITLE = 'Cardiology revision, private page title';
const PAGE = 'http://127.0.0.1:9/e2e/private-cardiology-page';

// =============================================================================================
// 1. Off by default; what turning it on means
// =============================================================================================

test.describe('off by default', () => {
  test('nothing reaches the server or the provider before sync is turned on; the consent lists what the policy uploads and what the server still sees; the acknowledgement is required', async ({
    env,
    idp,
    sync,
  }) => {
    const options = await openSyncSettings(env);
    const s = syncSection(options);
    await expect(s.getByTestId('sync-setup')).toBeVisible();
    expect(await syncFlag(options)).toBeFalsy();

    // The list is generated from STUDYVAULT_SYNC_POLICY: every synchronised table is in exactly
    // one entry, and the page shows exactly the entries the generator returns.
    const { groups, unlabelled } = syncedGroups();
    expect(unlabelled, 'every synchronised table has a plain-language label').toEqual([]);
    expect(groups.flatMap((g) => g.tables).sort()).toEqual(
      Object.keys(STUDYVAULT_SYNC_POLICY).sort(),
    );
    await expect(s.getByTestId('sync-data-list').locator('li')).toHaveCount(groups.length);
    for (const g of groups) {
      await expect(s.getByTestId(`sync-data-${g.id}`)).toHaveText(`${g.label}: ${g.detail}`);
    }
    await expect(s.getByTestId('sync-never-sent')).toContainText(NEVER_UPLOADED);
    await expect(s.getByTestId('sync-server-sees')).toHaveText(SERVER_STILL_SEES);
    await expect(s.getByTestId('sync-provider-learns')).toHaveText(PROVIDER_LEARNS);
    await expect(s.getByTestId('sync-redirect-url')).toHaveText(
      `https://${env.extensionId}.chromiumapp.org/sync`,
    );

    // The acknowledgement is required: without it the button says why and does nothing.
    await s.getByTestId('sync-server-url').fill(sync.base);
    await s.getByTestId('sync-issuer').fill(idp.issuer);
    await s.getByTestId('sync-client-id').fill(idp.clientId);
    const enable = s.getByTestId('sync-enable');
    await expect(enable).toHaveAttribute('aria-disabled', 'true');
    await expect(enable).toHaveAttribute('title', /understand where your data will go/);
    await enable.click();
    await expect(s.getByTestId('sync-setup')).toBeVisible();
    await expect(s.getByTestId('sync-connected')).toHaveCount(0);
    expect(await syncFlag(options)).toBeFalsy();
    await s.getByTestId('sync-ack').check();
    await expect(enable).not.toHaveAttribute('aria-disabled', 'true');

    await expectAccessible(options, 'setup form');

    // Nobody was contacted: not the sync server, not the sign-in provider.
    expect(sync.events).toEqual([]);
    expect(idp.requests).toEqual([]);
  });
});

// =============================================================================================
// 2. Permissions, sign-in, the first-upload gate, end-to-end encryption
// =============================================================================================

test.describe('turning it on and the first upload', () => {
  test('Chrome grants identity and alarms, nobody is contacted until sign-in, and after sign-in nothing is uploaded until the person chooses', async ({
    env,
    idp,
    sync,
  }) => {
    const options = await openSyncSettings(env);
    await saveQuote(options, { url: PAGE, title: TITLE, quote: QUOTE });
    expect(
      await options.evaluate(() =>
        chrome.permissions.contains({ permissions: ['identity', 'alarms'] }),
      ),
      'optional permissions are not granted before the person turns sync on',
    ).toBe(false);

    await turnOnSync(options, syncConfigOf(sync, idp));
    expect(await syncFlag(options)).toBe(true);
    expect(
      await options.evaluate(() =>
        chrome.permissions.contains({ permissions: ['identity', 'alarms'] }),
      ),
      'the click requested the two optional permissions and Chrome granted them',
    ).toBe(true);
    const s = syncSection(options);
    await expect(syncStatusOf(options)).toHaveText(STATUS_TEXT.auth_required);
    await expect(s.getByTestId('sync-account')).toContainText('Not signed in.');
    await expect(s.getByTestId('sync-scheduling-note')).toHaveCount(0);
    expect(await alarmNames(options)).toContain('sv-sync-periodic');
    expect(sync.events, 'turning sync on contacts no sync server').toEqual([]);
    await expectAccessible(options, 'on, signed out');

    // Real chrome.identity.launchWebAuthFlow against the stand-in provider.
    await signIn(options, idp.subject);
    expect(idp.signIns()).toBe(1);
    await expect(syncStatusOf(options)).toHaveText(STATUS_TEXT.awaiting_encryption_choice);
    await expect(s.getByTestId('sync-awaiting-choice')).toBeVisible();
    await expect(s.getByTestId('e2ee-choice-note')).toBeVisible();
    await expect(s.getByTestId('e2ee-mode')).toContainText('nothing has been uploaded');
    const now = s.getByTestId('sync-now');
    await expect(now).toHaveAttribute('aria-disabled', 'true');
    await expect(now).toHaveAttribute('title', /Choose how your data is protected first/);
    await expect(s.getByTestId('sync-pending')).toHaveText(WAITING);
    expect(sync.count('POST /v1/ops'), 'no operation was pushed').toBe(0);
    expect(await sync.stored()).toEqual([]);
    expect(await sync.hasProfile()).toBe(false);
    await expectAccessible(options, 'signed in, awaiting the encryption choice');
  });

  test('a passphrase makes the first upload ciphertext only; locking pauses everything; the right passphrase resumes it', async ({
    env,
    idp,
    sync,
  }) => {
    const options = await openSyncSettings(env);
    const id = await saveQuote(options, { url: PAGE, title: TITLE, quote: QUOTE });
    await turnOnSync(options, syncConfigOf(sync, idp));
    await signIn(options, idp.subject);
    const s = syncSection(options);
    await expect(syncStatusOf(options)).toHaveText(STATUS_TEXT.awaiting_encryption_choice);

    // A weak passphrase is refused with its reason, and nothing is sent.
    await s.getByTestId('e2ee-passphrase').fill('short');
    await expect(s.getByTestId('e2ee-setup')).toHaveAttribute('aria-disabled', 'true');
    await expect(s.getByTestId('e2ee-setup')).toHaveAttribute('title', /stronger passphrase/);

    await turnOnEncryption(options, PASSPHRASE);
    await expect(syncStatusOf(options)).toHaveText(STATUS_TEXT.idle);
    await expect(s.getByTestId('sync-pending')).toHaveText('nothing waiting to upload');
    await expect(encryptionModeOf(options)).toContainText('unlocked on this device');
    await expectAccessible(options, 'encryption on, unlocked');

    // The server holds ciphertext only, and a key profile that existed before the first operation.
    const ops = await sync.stored();
    expect(ops.length).toBeGreaterThan(0);
    expect(ops.every((o) => o.op.payloadEncrypted)).toBe(true);
    const text = await serverText(sync);
    for (const secret of [QUOTE, TITLE, PAGE, '127.0.0.1:9']) {
      expect(text, `the server never sees ${secret}`).not.toContain(secret);
    }
    // What it still sees is what the consent text says: kinds of items, ids, operation kinds.
    const known = Object.keys(STUDYVAULT_SYNC_POLICY);
    for (const { op } of ops) expect(known).toContain(op.entityType);
    expect(await sync.hasProfile()).toBe(true);
    const routes = sync.events.filter((e) => e.event === 'request').map((e) => e.route);
    expect(routes.indexOf('POST /v1/e2ee/rotate')).toBeGreaterThanOrEqual(0);
    expect(routes.indexOf('POST /v1/ops')).toBeGreaterThan(routes.indexOf('POST /v1/e2ee/rotate'));
    // The session store holds the unwrapped key and an expiry; the lock alarm exists for it.
    const session = await sessionStore(options);
    expect(session.syncKey).toMatchObject({ expiresAt: expect.any(Number) });
    expect(await alarmNames(options)).toEqual(
      expect.arrayContaining(['sv-sync-lock', 'sv-sync-periodic']),
    );

    // Lock now: syncing is paused and says so; a change made meanwhile stays on the device.
    await s.getByTestId('e2ee-lock').click();
    await expect(syncStatusOf(options)).toHaveText(STATUS_TEXT.locked);
    await expect(encryptionModeOf(options)).toContainText('Set up, and locked on this device');
    const now = s.getByTestId('sync-now');
    await expect(now).toHaveAttribute('aria-disabled', 'true');
    await expect(now).toHaveAttribute('title', 'Unlock encryption first.');
    expect((await sessionStore(options)).syncKey).toBeUndefined();
    await expectAccessible(options, 'encryption on, locked');
    const pushes = sync.count('POST /v1/ops');
    const requests = sync.events.length;
    await setComment(options, id, 'a thought written while locked');
    await expect(s.getByTestId('sync-pending')).toHaveText(WAITING);
    expect(sync.count('POST /v1/ops')).toBe(pushes);
    expect(sync.events.length, 'a locked device does not even ask the server').toBe(requests);

    // Wrong passphrase: refused, still locked. Right one: unlocked, the waiting change goes out.
    await s.getByTestId('e2ee-unlock-passphrase').fill(OTHER_PASSPHRASE);
    await s.getByTestId('e2ee-unlock').click();
    await expect(s.getByTestId('e2ee-message')).toContainText('does not match');
    await expect(syncStatusOf(options)).toHaveText(STATUS_TEXT.locked);
    await s.getByTestId('e2ee-unlock-passphrase').fill(PASSPHRASE);
    await s.getByTestId('e2ee-unlock').click();
    await expect(encryptionModeOf(options)).toContainText('unlocked on this device');
    await expect(s.getByTestId('sync-pending')).toHaveText('nothing waiting to upload');
    expect(sync.count('POST /v1/ops')).toBeGreaterThan(pushes);
    expect(await serverText(sync)).not.toContain('written while locked');
    expect((await sync.stored()).every((o) => o.op.payloadEncrypted)).toBe(true);
  });

  test('"Upload without end-to-end encryption" needs its acknowledgement; afterwards the server holds readable text, and a passphrase later re-encrypts it', async ({
    env,
    idp,
    sync,
  }) => {
    const options = await openSyncSettings(env);
    await saveQuote(options, { url: PAGE, title: TITLE, quote: QUOTE });
    await turnOnSync(options, syncConfigOf(sync, idp));
    await signIn(options, idp.subject);
    const s = syncSection(options);
    await expect(syncStatusOf(options)).toHaveText(STATUS_TEXT.awaiting_encryption_choice);

    const plain = s.getByTestId('e2ee-upload-plain');
    await expect(plain).toHaveAttribute('aria-disabled', 'true');
    await expect(plain).toHaveAttribute('title', /operator of the server can read/);
    await plain.click();
    await expect(s.getByTestId('e2ee-plain-choice')).toBeVisible();
    expect(sync.count('POST /v1/ops'), 'the button did nothing without its acknowledgement').toBe(
      0,
    );

    await s.getByTestId('e2ee-plain-ack').check();
    await expect(plain).not.toHaveAttribute('aria-disabled', 'true');
    await plain.click();
    await expect(syncStatusOf(options)).toHaveText(STATUS_TEXT.idle);
    await expect(s.getByTestId('sync-pending')).toHaveText('nothing waiting to upload');
    await expect(encryptionModeOf(options)).toContainText(
      'You chose to upload without end-to-end encryption',
    );
    await expectAccessible(options, 'uploading without end-to-end encryption');

    const text = await serverText(sync);
    expect(text).toContain(QUOTE);
    expect(text).toContain(TITLE);
    expect((await sync.stored()).some((o) => !o.op.payloadEncrypted)).toBe(true);

    // Turning encryption on afterwards replaces what the server stores.
    await turnOnEncryption(options, PASSPHRASE);
    await expect(syncStatusOf(options)).toHaveText(STATUS_TEXT.idle);
    expect(await serverText(sync)).not.toContain(QUOTE);
    expect((await sync.stored()).every((o) => o.op.payloadEncrypted)).toBe(true);
  });
});

// =============================================================================================
// 3. A second profile, offline edits on both sides, conflicts
// =============================================================================================

test.describe('two devices', () => {
  test('a second profile signs in, needs the passphrase, receives the highlight; edits made offline on both converge and the conflict is shown and resolved', async ({
    env,
    idp,
    sync,
  }) => {
    test.setTimeout(240_000);
    const config = syncConfigOf(sync, idp);
    const a = await openSyncSettings(env);
    const id = await saveQuote(a, { url: PAGE, title: TITLE, quote: QUOTE });
    await turnOnSync(a, config);
    await signIn(a, idp.subject);
    await turnOnEncryption(a, PASSPHRASE);
    await expect(syncStatusOf(a)).toHaveText(STATUS_TEXT.idle);

    const profile = await launchProfile(env);
    try {
      const b = await openSyncSettings(profile.env);
      await turnOnSync(b, config);
      await signIn(b, idp.subject);
      // The account is encrypted: this device learns that and waits for the passphrase.
      await expect(syncStatusOf(b)).toHaveText(STATUS_TEXT.locked);
      expect(await highlightRows(b)).toEqual([]);
      await expectAccessible(b, 'second device, locked');
      const sb = syncSection(b);
      await sb.getByTestId('e2ee-unlock-passphrase').fill(OTHER_PASSPHRASE);
      await sb.getByTestId('e2ee-unlock').click();
      await expect(sb.getByTestId('e2ee-message')).toContainText('does not match');
      expect(await highlightRows(b)).toEqual([]);
      await sb.getByTestId('e2ee-unlock-passphrase').fill(PASSPHRASE);
      await sb.getByTestId('e2ee-unlock').click();
      await expect(syncStatusOf(b)).toHaveText(STATUS_TEXT.idle);
      await expect
        .poll(async () => (await highlightRows(b)).map((h) => h.exactQuote))
        .toEqual([QUOTE]);

      // Both go offline and edit the same comment, A first, B later.
      await sync.setOnline(false);
      await setComment(a, id, 'comment typed on profile A');
      await expect(syncStatusOf(a)).toHaveText(STATUS_TEXT.offline);
      await setComment(b, id, 'comment typed on profile B');
      await expect(syncStatusOf(b)).toHaveText(STATUS_TEXT.offline);
      await expect(syncSection(a).getByTestId('sync-pending')).toHaveText(WAITING);
      await expect(sb.getByTestId('sync-pending')).toHaveText(WAITING);
      await expectAccessible(a, 'offline with changes waiting');
      // Nothing was lost while offline: both devices still show what they were told.
      expect((await highlightRows(a))[0]?.userComment).toBe('comment typed on profile A');
      expect((await highlightRows(b))[0]?.userComment).toBe('comment typed on profile B');

      // Back online, in turn.
      await sync.setOnline(true);
      for (const page of [a, b, a, b]) {
        await syncNow(page);
        await expect(syncStatusOf(page)).toHaveText(STATUS_TEXT.idle);
        await expect(syncSection(page).getByTestId('sync-pending')).toHaveText(
          'nothing waiting to upload',
        );
      }
      // Converged on one value (the later edit wins the shared field), neither device lost a version.
      const finalA = (await highlightRows(a))[0]?.userComment;
      const finalB = (await highlightRows(b))[0]?.userComment;
      expect(finalA).toBe(finalB);
      expect(finalA).toBe('comment typed on profile B');

      // The conflict is in the UI with both texts; picking one reaches the other device.
      const sa = syncSection(a);
      await a.reload();
      await expect(sa.getByTestId('conflicts-panel')).toContainText('Your comment');
      await expect(sa.getByTestId('conflict-local-text').first()).toHaveText(
        'comment typed on profile A',
      );
      await expect(sa.getByTestId('conflict-remote-text').first()).toHaveText(
        'comment typed on profile B',
      );
      await expectAccessible(a, 'a text conflict');
      await sa.getByTestId('conflict-keep-local').first().click();
      await expect(sa.getByTestId('conflicts-panel')).toContainText('No conflicts');
      await syncNow(a);
      await expect(syncStatusOf(a)).toHaveText(STATUS_TEXT.idle);
      await syncNow(b);
      await expect(syncStatusOf(b)).toHaveText(STATUS_TEXT.idle);
      await expect
        .poll(async () => (await highlightRows(b))[0]?.userComment)
        .toBe('comment typed on profile A');
      expect((await highlightRows(a))[0]?.userComment).toBe('comment typed on profile A');
      expect(await serverText(sync)).not.toContain('comment typed on profile');
    } finally {
      await profile.dispose();
    }
  });
});

// =============================================================================================
// 4. Sign-out, deleting the server copy, deleting everything
// =============================================================================================

test.describe('leaving', () => {
  test('sign-out clears the tokens and keeps the data; signing in again resumes; "Delete my data from the server" empties the server and keeps the device', async ({
    env,
    idp,
    sync,
  }) => {
    const options = await openSyncSettings(env);
    const id = await saveQuote(options, { url: PAGE, title: TITLE, quote: QUOTE });
    await turnOnSync(options, syncConfigOf(sync, idp));
    await signIn(options, idp.subject);
    const s = syncSection(options);
    await s.getByTestId('e2ee-plain-ack').check();
    await s.getByTestId('e2ee-upload-plain').click();
    await expect(syncStatusOf(options)).toHaveText(STATUS_TEXT.idle);
    expect(await serverText(sync)).toContain(QUOTE);
    expect((await sessionStore(options)).syncTokens).toBeDefined();

    // Sign out (keep the data on this device, ask the provider to end the session).
    await s.getByTestId('sync-sign-out').click();
    const dialog = options.getByRole('dialog', { name: 'Sign out of sync?' });
    await expect(dialog.getByTestId('sync-signout-keep')).toBeChecked();
    await dialog.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(s.getByTestId('sync-account')).toContainText('Not signed in.');
    await expect(s.getByTestId('sync-note')).toContainText('Your data stays on this device');
    await expect(syncStatusOf(options)).toHaveText(STATUS_TEXT.auth_required);
    const session = await sessionStore(options);
    expect(session.syncTokens, 'the tokens are gone from session storage').toBeUndefined();
    expect(session.syncBinding).toBeUndefined();
    expect(idp.revoked.sort()).toEqual(['access_token', 'refresh_token']);
    expect((await highlightRows(options)).map((h) => h.exactQuote)).toEqual([QUOTE]);
    await expectAccessible(options, 'signed out again');

    // Work done while signed out is kept and never sent.
    const requests = sync.events.length;
    await setComment(options, id, 'edited while signed out');
    await expect(s.getByTestId('sync-pending')).toHaveText(WAITING);
    expect(sync.events.length).toBe(requests);
    expect(await serverText(sync)).not.toContain('edited while signed out');

    // Signing in again resumes where it stopped (the choice made before was kept).
    await signIn(options, idp.subject);
    expect(idp.signIns()).toBe(2);
    await expect(syncStatusOf(options)).toHaveText(STATUS_TEXT.idle);
    await expect(s.getByTestId('sync-pending')).toHaveText('nothing waiting to upload');
    expect(await serverText(sync)).toContain('edited while signed out');

    // Delete my data from the server: typed confirmation, the server is empty, the device is not.
    await s.getByTestId('sync-delete-server-data').click();
    const confirm = options.getByRole('dialog', { name: 'Delete my data from the server?' });
    await confirm.getByRole('button', { name: 'Delete from the server' }).click();
    await expect(confirm.getByRole('alert')).toContainText('Type the word delete');
    await confirm.getByTestId('sync-delete-confirm-input').fill('delete');
    await confirm.getByRole('button', { name: 'Delete from the server' }).click();
    await expect(s.getByTestId('sync-note')).toContainText('Your data on the server was deleted');
    expect(await sync.stored()).toEqual([]);
    expect(await sync.hasProfile()).toBe(false);
    expect((await highlightRows(options)).map((h) => h.exactQuote)).toEqual([QUOTE]);
    // Starting over is the person's act: nothing is sent again until they choose.
    await expect(syncStatusOf(options)).toHaveText(STATUS_TEXT.awaiting_encryption_choice);
    expect(await sync.stored()).toEqual([]);
  });

  test('"Delete all StudyVault data" removes the sync configuration, the sign-in and the key from this device, turns sync off, and leaves the server alone', async ({
    env,
    idp,
    sync,
  }) => {
    const options = await openSyncSettings(env);
    await saveQuote(options, { url: PAGE, title: TITLE, quote: QUOTE });
    await turnOnSync(options, syncConfigOf(sync, idp));
    await signIn(options, idp.subject);
    await turnOnEncryption(options, PASSPHRASE);
    await expect(syncStatusOf(options)).toHaveText(STATUS_TEXT.idle);
    expect(await metaValue(options, 'sync.config')).toMatchObject({ serverUrl: sync.base });
    expect(await metaValue(options, 'sync.encryption')).toMatchObject({ mode: 'e2ee' });
    const before = await sessionStore(options);
    expect(before.syncTokens).toBeDefined();
    expect(before.syncKey).toBeDefined();
    const stored = (await sync.stored()).length;
    const requests = sync.events.length;

    await options.getByRole('button', { name: /^Delete all StudyVault data/ }).click();
    await options
      .getByRole('dialog', { name: 'Delete all StudyVault data?' })
      .getByRole('button', { name: 'Delete everything' })
      .click();
    await expect(
      options.getByText(/All StudyVault data was deleted from this device/),
    ).toContainText('The copy on your sync server was not touched');

    expect(await highlightRows(options)).toEqual([]);
    for (const key of ['sync.config', 'sync.encryption', 'sync.clientId', 'sync.state']) {
      expect(await metaValue(options, key), `${key} is gone`).toBeUndefined();
    }
    const after = await sessionStore(options);
    for (const key of ['syncTokens', 'syncKey', 'syncBinding', 'syncOidc', 'syncStatus']) {
      expect(after[key], `${key} is gone from session storage`).toBeUndefined();
    }
    expect(await syncFlag(options)).toBeFalsy();
    await expect.poll(() => alarmNames(options)).toEqual([]);
    expect(sync.events.length, 'wiping the device sends nothing').toBe(requests);
    expect((await sync.stored()).length, 'the server copy is separate').toBe(stored);

    await options.reload();
    await expect(syncSection(options).getByTestId('sync-setup')).toBeVisible();
    await expect(syncSection(options).getByTestId('sync-server-url')).toHaveValue('');
  });
});

// =============================================================================================
// 5. A server that stops presenting the key
// =============================================================================================

test.describe('downgrade protection', () => {
  test('a restarted server without the key profile is refused with a warning; nothing is uploaded; the right key brings sync back', async ({
    env,
    idp,
    sync,
  }) => {
    const options = await openSyncSettings(env);
    const id = await saveQuote(options, { url: PAGE, title: TITLE, quote: QUOTE });
    await turnOnSync(options, syncConfigOf(sync, idp));
    await signIn(options, idp.subject);
    await turnOnEncryption(options, PASSPHRASE);
    await expect(syncStatusOf(options)).toHaveText(STATUS_TEXT.idle);
    const s = syncSection(options);

    // The server is restarted over the same data with the key profile removed.
    await sync.restart({ profile: 'removed' });
    expect(await sync.hasProfile()).toBe(false);
    const pushes = sync.count('POST /v1/ops');
    await setComment(options, id, 'written while the key was hidden');
    await syncNow(options);
    await expect(syncStatusOf(options)).toHaveText(STATUS_TEXT.error);
    await expect(s.getByTestId('e2ee-warning')).toContainText('no encryption key');
    await expectAccessible(options, 'downgrade warning');
    expect(sync.count('POST /v1/ops'), 'nothing was pushed to a server without the key').toBe(
      pushes,
    );
    expect(await serverText(sync)).not.toContain('written while the key was hidden');

    // Locking and unlocking does not get around it.
    await s.getByTestId('e2ee-lock').click();
    await s.getByTestId('e2ee-unlock-passphrase').fill(PASSPHRASE);
    await s.getByTestId('e2ee-unlock').click();
    await expect(s.getByTestId('e2ee-message')).toContainText('no encryption key');
    await expect(s.getByTestId('e2ee-warning')).toBeVisible();
    expect(sync.count('POST /v1/ops')).toBe(pushes);

    // The right profile is back: the warning clears and the waiting change goes out, encrypted.
    await sync.restart({ profile: 'present' });
    await s.getByTestId('e2ee-unlock').click();
    await expect(syncStatusOf(options)).toHaveText(STATUS_TEXT.idle);
    await expect(s.getByTestId('e2ee-warning')).toHaveCount(0);
    await expect(s.getByTestId('sync-pending')).toHaveText('nothing waiting to upload');
    expect(sync.count('POST /v1/ops')).toBeGreaterThan(pushes);
    expect(await serverText(sync)).not.toContain('written while the key was hidden');
  });
});

// =============================================================================================
// 6. The service worker, the key and the browser session
// =============================================================================================

test.describe('worker and session', () => {
  test('a suspended worker comes back with the key and keeps syncing; an expired key and the lock alarm lock it without the passphrase leaving the device', async ({
    env,
    idp,
    sync,
  }) => {
    const options = await openSyncSettings(env);
    const id = await saveQuote(options, { url: PAGE, title: TITLE, quote: QUOTE });
    await turnOnSync(options, syncConfigOf(sync, idp));
    await signIn(options, idp.subject);
    await turnOnEncryption(options, PASSPHRASE);
    await expect(syncStatusOf(options)).toHaveText(STATUS_TEXT.idle);
    const s = syncSection(options);

    // Chrome stops the worker (what it does when idle). Its memory is gone; the session store is not.
    await stopWorker(env.context, env.extensionId, options);
    expect((await sessionStore(options)).syncKey).toBeDefined();
    const pushes = sync.count('POST /v1/ops');
    await setComment(options, id, 'edited after the worker was suspended');
    await expect(s.getByTestId('sync-pending')).toHaveText('nothing waiting to upload');
    expect(sync.count('POST /v1/ops')).toBeGreaterThan(pushes);
    expect(await serverText(sync)).not.toContain('edited after the worker');
    await expect(encryptionModeOf(options)).toContainText('unlocked on this device');

    // The key's absolute expiry passes while nobody is looking: the next run finds no key.
    await options.evaluate(async () => {
      const { syncKey } = await chrome.storage.session.get('syncKey');
      await chrome.storage.session.set({
        syncKey: { ...(syncKey as object), expiresAt: Date.now() - 1 },
      });
    });
    const requests = sync.events.length;
    await syncNow(options);
    await expect(syncStatusOf(options)).toHaveText(STATUS_TEXT.locked);
    expect((await sessionStore(options)).syncKey).toBeUndefined();
    expect(sync.events.length, 'an expired key sends nothing').toBe(requests);

    // Unlock again, then let the worker's own lock alarm fire while the worker is stopped.
    await s.getByTestId('e2ee-unlock-passphrase').fill(PASSPHRASE);
    await s.getByTestId('e2ee-unlock').click();
    await expect(encryptionModeOf(options)).toContainText('unlocked on this device');
    await stopWorker(env.context, env.extensionId, options);
    await options.evaluate(() => chrome.alarms.create('sv-sync-lock', { when: Date.now() + 1000 }));
    await expect(syncStatusOf(options)).toHaveText(STATUS_TEXT.locked, { timeout: 30_000 });
    expect((await sessionStore(options)).syncKey).toBeUndefined();
  });

  test('a browser restart drops the sign-in and the key, and keeps the configuration and the data', async ({
    env,
    idp,
    sync,
  }) => {
    test.setTimeout(180_000);
    const profile = await launchProfile(env);
    let restarted: Awaited<ReturnType<typeof launchProfile>> | null = null;
    try {
      const options = await openSyncSettings(profile.env);
      await saveQuote(options, { url: PAGE, title: TITLE, quote: QUOTE });
      await turnOnSync(options, syncConfigOf(sync, idp));
      await signIn(options, idp.subject);
      await turnOnEncryption(options, PASSPHRASE);
      await expect(syncStatusOf(options)).toHaveText(STATUS_TEXT.idle);
      await options.close();
      await profile.closeBrowser();
      const requests = sync.events.length;

      restarted = await launchProfile(env, profile.userDataDir);
      const again = await openSyncSettings(restarted.env);
      // The configuration and the data are on disk; the tokens and the key lived in memory only.
      expect(await syncFlag(again)).toBe(true);
      expect((await highlightRows(again)).map((h) => h.exactQuote)).toEqual([QUOTE]);
      expect(await metaValue(again, 'sync.config')).toMatchObject({ serverUrl: sync.base });
      const session = await sessionStore(again);
      expect(session.syncTokens).toBeUndefined();
      expect(session.syncKey).toBeUndefined();
      await expect(syncStatusOf(again)).toHaveText(STATUS_TEXT.auth_required);
      await expect(syncSection(again).getByTestId('sync-sign-in')).toBeVisible();
      expect(sync.events.length, 'a restarted browser signed out sends nothing').toBe(requests);

      // Signing in brings it back, locked until the passphrase is entered.
      await signIn(again, idp.subject);
      await expect(syncStatusOf(again)).toHaveText(STATUS_TEXT.locked);
      await syncSection(again).getByTestId('e2ee-unlock-passphrase').fill(PASSPHRASE);
      await syncSection(again).getByTestId('e2ee-unlock').click();
      await expect(syncStatusOf(again)).toHaveText(STATUS_TEXT.idle);
    } finally {
      if (restarted) await restarted.dispose();
      else await profile.dispose();
    }
  });

  test('a periodic sync alarm wakes a stopped worker, also in the first worker lifetime after the permission was granted', async ({
    env,
    idp,
    sync,
  }) => {
    const options = await openSyncSettings(env);
    await saveQuote(options, { url: PAGE, title: TITLE, quote: QUOTE });
    await turnOnSync(options, syncConfigOf(sync, idp));
    await signIn(options, idp.subject);
    const s = syncSection(options);
    await s.getByTestId('e2ee-plain-ack').check();
    await s.getByTestId('e2ee-upload-plain').click();
    await expect(syncStatusOf(options)).toHaveText(STATUS_TEXT.idle);

    // The worker that handled the grant is stopped. Nothing wakes it but the alarm.
    await stopWorker(env.context, env.extensionId, options);
    expect(await workerState(env.context, env.extensionId)).toBeNull();
    const requests = sync.events.length;
    await options.evaluate(() => chrome.alarms.create('sv-sync-soon', { when: Date.now() + 1500 }));
    await expect
      .poll(() => workerState(env.context, env.extensionId), {
        message: 'the alarm should start the worker again',
        timeout: 30_000,
      })
      .not.toBeNull();
    await expect.poll(() => sync.events.length, { timeout: 30_000 }).toBeGreaterThan(requests);
  });
});

// =============================================================================================
// Not driven by this harness (each was investigated; the reason is the platform's, not the product's)
// =============================================================================================

test.describe('not drivable here', () => {
  // The e2e manifest holds http://127.0.0.1/* and http://localhost/* as required host permissions
  // (a native permission prompt cannot be clicked in headless Chromium), so Chrome never asks about
  // the loopback origins this suite uses, and there is no prompt to decline.
  test.fixme("declining Chrome's permission prompt for the server address leaves sync off and says so", async () => {});

  // Same reason: every origin the harness can reach is already granted, so "Allow access to ..." is
  // never offered. Covered at component level in packages/ui/src/sync/sync.test.tsx and
  // entrypoints/background/sync.test.ts (`needsOrigins`).
  test.fixme('a server or provider origin Chrome has not granted shows "Allow access to..." and signs in after it', async () => {});

  // A hosted provider needs https, a real certificate, consent screens, MFA and refresh-token
  // rotation. The stand-in implements authorisation code + PKCE, refresh and revocation only.
  test.fixme('a hosted OpenID Connect provider over https', async () => {});
});
