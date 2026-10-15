import type { Page } from '@playwright/test';
import { STUDYVAULT_SYNC_POLICY } from '@sync';
import { NEVER_UPLOADED, PROVIDER_LEARNS, SERVER_STILL_SEES, syncedGroups } from '@ui/sync/consent';
import { STATUS_TEXT } from '@ui/sync/labels';
import { stopWorker, workerState } from './helpers.lifecycle';
import { startFakeOidc, startSyncHarness } from './syncServer';
import {
  OTHER_PASSPHRASE,
  PASSPHRASE,
  WAITING,
  alarmNames,
  encryptionModeOf,
  errorsOf,
  expect,
  expectAccessible,
  highlightRows,
  gotoSettings,
  launchProfile,
  metaValue,
  openDangerPanel,
  openSyncSettings,
  pickCard,
  saveQuote,
  serverText,
  sessionStore,
  setComment,
  setupNext,
  signIn,
  syncConfigOf,
  syncFlag,
  syncNow,
  syncSection,
  syncStatusOf,
  test,
  turnOnEncryption,
  turnOnSync,
  uploadPlain,
  workerErrors,
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

/** Everything that was waiting has been sent: the line says so, and the status is "up to date". */
async function expectUploaded(page: Page): Promise<void> {
  await expect(syncSection(page).getByTestId('sync-pending')).toHaveText(
    'nothing waiting to upload',
  );
  await expect(syncStatusOf(page)).toHaveText(STATUS_TEXT.idle);
}

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
    // one entry, and the page shows exactly the entries the generator returns: as tiles on the
    // wizard's first step, and in full under its "Every detail" panel.
    const { groups, unlabelled } = syncedGroups();
    expect(unlabelled, 'every synchronised table has a plain-language label').toEqual([]);
    expect(groups.flatMap((g) => g.tables).sort()).toEqual(
      Object.keys(STUDYVAULT_SYNC_POLICY).sort(),
    );
    await expect(
      s.getByRole('list', { name: 'What is uploaded' }).getByRole('listitem'),
    ).toHaveCount(groups.length);
    await s.locator('summary', { hasText: 'Every detail' }).click();
    await expect(s.getByTestId('sync-explanation')).toBeVisible();
    await expect(s.getByTestId('sync-data-list').locator('li')).toHaveCount(groups.length);
    for (const g of groups) {
      await expect(s.getByTestId(`sync-data-${g.id}`)).toHaveText(`${g.label}: ${g.detail}`);
    }
    await expect(s.getByTestId('sync-never-sent')).toContainText(NEVER_UPLOADED);
    await expect(s.getByTestId('sync-server-sees')).toHaveText(SERVER_STILL_SEES);
    await expect(s.getByTestId('sync-provider-learns')).toHaveText(PROVIDER_LEARNS);
    await expectAccessible(options, 'setup: what is shared, every detail open');

    // The server step, then the sign-in provider step, which shows the redirect address.
    await setupNext(options);
    await s.getByTestId('sync-server-url').fill(sync.base);
    await setupNext(options);
    await s.getByTestId('sync-issuer').fill(idp.issuer);
    await s.getByTestId('sync-client-id').fill(idp.clientId);
    await expect(s.getByTestId('sync-redirect-url')).toHaveText(
      `https://${env.extensionId}.chromiumapp.org/sync`,
    );
    await setupNext(options);

    // The acknowledgement is required: without it "Turn on sync" says why, under the box, and does
    // nothing (no permission asked, nothing turned on).
    const enable = s.getByTestId('sync-enable');
    const ack = s.getByTestId('sync-ack');
    await enable.click();
    await expect(s.getByRole('alert')).toHaveText(/understand where your data will go/);
    await expect(ack).toHaveAttribute('aria-invalid', 'true');
    await expect(s.getByTestId('sync-setup')).toBeVisible();
    await expect(s.getByTestId('sync-connected')).toHaveCount(0);
    expect(await syncFlag(options)).toBeFalsy();
    expect(
      await options.evaluate(() =>
        chrome.permissions.contains({ permissions: ['identity', 'alarms'] }),
      ),
      'a refused click asks Chrome for nothing',
    ).toBe(false);
    await ack.check();
    await expect(s.getByRole('alert')).toHaveCount(0);
    await expect(ack).not.toHaveAttribute('aria-invalid', 'true');

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
    const worker = workerErrors(env);
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
    await expectUploaded(options);
    await expect(s.getByTestId('sync-pending')).toHaveText('nothing waiting to upload');
    await expect(encryptionModeOf(options)).toContainText('Unlocked on this device');
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
    await expect(encryptionModeOf(options)).toContainText(
      'Locked on this device: syncing is paused',
    );
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
    await expect(encryptionModeOf(options)).toContainText('Unlocked on this device');
    await expect(s.getByTestId('sync-pending')).toHaveText('nothing waiting to upload');
    expect(sync.count('POST /v1/ops')).toBeGreaterThan(pushes);
    expect(await serverText(sync)).not.toContain('written while locked');
    expect((await sync.stored()).every((o) => o.op.payloadEncrypted)).toBe(true);
    expect(errorsOf(options), 'no page error or console.error').toEqual([]);
    expect(worker, 'no service worker console.error').toEqual([]);
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

    // The passphrase card is picked by default; the plain upload is only offered once
    // "No passphrase" is picked.
    const plain = s.getByTestId('e2ee-upload-plain');
    await expect(s.getByTestId('e2ee-choice-passphrase')).toBeChecked();
    await expect(plain).toHaveCount(0);
    await pickCard(options, 'e2ee-choice-plain');
    await expect(plain).toHaveAttribute('aria-disabled', 'true');
    await expect(plain).toHaveAttribute('title', /operator of the server can read/);
    await plain.click({ force: true });
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
    await expectUploaded(options);
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
    const workerA = workerErrors(env);
    const a = await openSyncSettings(env);
    const id = await saveQuote(a, { url: PAGE, title: TITLE, quote: QUOTE });
    await turnOnSync(a, config);
    await signIn(a, idp.subject);
    await turnOnEncryption(a, PASSPHRASE);
    await expectUploaded(a);

    const profile = await launchProfile(env);
    const workerB = workerErrors(profile.env);
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
      for (const page of [a, b]) {
        await expect
          .poll(async () => (await highlightRows(page))[0]?.userComment)
          .toBe('comment typed on profile B');
      }

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
      const pushes = sync.count('POST /v1/ops');
      await sa.getByTestId('conflict-keep-local').first().click();
      await expect(sa.getByTestId('conflicts-panel')).toContainText('No conflicts');
      await syncNow(a);
      // The choice was pushed before B pulls (the status alone may still read "up to date" from
      // before the run, which raced B's pull on a loaded machine).
      await expect.poll(() => sync.count('POST /v1/ops')).toBeGreaterThan(pushes);
      await expect(syncStatusOf(a)).toHaveText(STATUS_TEXT.idle);
      await expect(sa.getByTestId('sync-pending')).toHaveText('nothing waiting to upload');
      await syncNow(b);
      await expect(syncStatusOf(b)).toHaveText(STATUS_TEXT.idle);
      await expect
        .poll(async () => (await highlightRows(b))[0]?.userComment)
        .toBe('comment typed on profile A');
      expect((await highlightRows(a))[0]?.userComment).toBe('comment typed on profile A');
      expect(await serverText(sync)).not.toContain('comment typed on profile');
      expect([...errorsOf(a), ...errorsOf(b)], 'no page error or console.error').toEqual([]);
      expect([...workerA, ...workerB], 'no service worker console.error').toEqual([]);
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
    await uploadPlain(options);
    await expectUploaded(options);
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

    // Delete my data from the server (in the closed "Turn off or delete" panel): typed
    // confirmation, the server is empty, the device is not.
    await openDangerPanel(options);
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
    await expectUploaded(options);
    expect(await metaValue(options, 'sync.config')).toMatchObject({ serverUrl: sync.base });
    expect(await metaValue(options, 'sync.encryption')).toMatchObject({ mode: 'e2ee' });
    const before = await sessionStore(options);
    expect(before.syncTokens).toBeDefined();
    expect(before.syncKey).toBeDefined();
    const stored = (await sync.stored()).length;
    const requests = sync.events.length;

    // Settings > Your data > Start over: "Delete all data", Next, type "delete", Delete everything.
    await gotoSettings(options, env, 'data');
    await options.getByRole('button', { name: 'Delete all data', exact: true }).click();
    const wipe = options.getByRole('dialog', { name: 'Delete all StudyVault data' });
    await expect(wipe).toContainText('The copy on your sync server stays too');
    await wipe.getByRole('button', { name: 'Next', exact: true }).click();
    await wipe.getByRole('textbox', { name: 'Type “delete”' }).fill('delete');
    await wipe.getByRole('button', { name: 'Delete everything' }).click();
    await expect(wipe.getByText(/All StudyVault data was deleted from this device/)).toContainText(
      'The copy on your sync server was not touched',
    );

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
    // U-16: the optional API permissions sync asked for are given back with the data.
    expect(
      await options.evaluate(() =>
        chrome.permissions.contains({ permissions: ['identity', 'alarms'] }),
      ),
      'identity and alarms are no longer held',
    ).toBe(false);
    expect(sync.events.length, 'wiping the device sends nothing').toBe(requests);
    expect((await sync.stored()).length, 'the server copy is separate').toBe(stored);

    await gotoSettings(options, env, 'sync');
    await options.reload();
    await expect(syncSection(options).getByTestId('sync-setup')).toBeVisible();
    await setupNext(options);
    await expect(syncSection(options).getByTestId('sync-server-url')).toHaveValue('');
  });

  test('signing out with "remove all StudyVault data" empties this device and the sign-in, and leaves the server copy', async ({
    env,
    idp,
    sync,
  }) => {
    const options = await openSyncSettings(env);
    await saveQuote(options, { url: PAGE, title: TITLE, quote: QUOTE });
    await turnOnSync(options, syncConfigOf(sync, idp));
    await signIn(options, idp.subject);
    const s = syncSection(options);
    await uploadPlain(options);
    await expectUploaded(options);
    const stored = (await sync.stored()).length;
    expect(stored).toBeGreaterThan(0);

    await s.getByTestId('sync-sign-out').click();
    const dialog = options.getByRole('dialog', { name: 'Sign out of sync?' });
    await dialog.getByTestId('sync-signout-wipe').check();
    const confirmLabel = dialog.getByRole('button', { name: 'Sign out and remove data' });
    await confirmLabel.click();
    await expect(dialog.getByRole('alert')).toContainText('Type the word delete');
    await dialog.getByTestId('sync-signout-typed').fill('delete');
    await confirmLabel.click();

    await expect(s.getByTestId('sync-note').or(s.getByTestId('sync-setup'))).toBeVisible();
    await expect.poll(async () => (await highlightRows(options)).length).toBe(0);
    expect((await sessionStore(options)).syncTokens).toBeUndefined();
    expect(idp.revoked.sort()).toEqual(['access_token', 'refresh_token']);
    expect((await sync.stored()).length, 'the server copy is separate').toBe(stored);
    expect(await syncFlag(options)).toBeFalsy();
  });

  test('a provider that ends the session sends the person back to sign in without losing work; refreshed tokens keep syncing meanwhile', async ({
    env,
  }) => {
    // Tokens that are always about to expire, so every request goes through the refresh grant.
    const idp = await startFakeOidc({ accessTokenSeconds: 30 });
    const sync = await startSyncHarness({
      idp,
      extensionOrigin: `chrome-extension://${env.extensionId}`,
    });
    try {
      const options = await openSyncSettings(env);
      const id = await saveQuote(options, { url: PAGE, title: TITLE, quote: QUOTE });
      await turnOnSync(options, syncConfigOf(sync, idp));
      await signIn(options, idp.subject);
      const s = syncSection(options);
      await uploadPlain(options);
      await expectUploaded(options);
      await setComment(options, id, 'second edit, new token');
      await expect.poll(() => serverText(sync)).toContain('second edit, new token');
      const grants = idp.requests.filter((r) => r === 'POST /idp/token').length;
      expect(grants, 'the code exchange, then refreshes').toBeGreaterThan(1);

      // The provider ends the session: the refresh token no longer works.
      idp.failRefresh = true;
      await setComment(options, id, 'edit after the session ended');
      await expect(syncStatusOf(options)).toHaveText(STATUS_TEXT.auth_required);
      await expect(s.getByTestId('sync-account')).toContainText('Not signed in.');
      await expect(s.getByTestId('sync-pending')).toHaveText(WAITING);
      expect((await sessionStore(options)).syncTokens).toBeUndefined();
      expect(await serverText(sync)).not.toContain('edit after the session ended');
      expect((await highlightRows(options))[0]?.userComment).toBe('edit after the session ended');

      // Signing in again sends what waited.
      idp.failRefresh = false;
      await signIn(options, idp.subject);
      await expect(syncStatusOf(options)).toHaveText(STATUS_TEXT.idle);
      await expect.poll(() => serverText(sync)).toContain('edit after the session ended');
    } finally {
      await sync.close();
      await idp.close();
    }
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
    await expectUploaded(options);
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
    await expectUploaded(options);
    const s = syncSection(options);

    // Chrome stops the worker (what it does when idle). Its memory is gone; the session store is not.
    await stopWorker(env.context, env.extensionId, options);
    expect((await sessionStore(options)).syncKey).toBeDefined();
    const pushes = sync.count('POST /v1/ops');
    await setComment(options, id, 'edited after the worker was suspended');
    // The push itself, not the pending line: that still shows the state from before the edit.
    await expect.poll(() => sync.count('POST /v1/ops')).toBeGreaterThan(pushes);
    await expect(s.getByTestId('sync-pending')).toHaveText('nothing waiting to upload');
    expect(await serverText(sync)).not.toContain('edited after the worker');
    await expect(encryptionModeOf(options)).toContainText('Unlocked on this device');

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
    await expect(encryptionModeOf(options)).toContainText('Unlocked on this device');
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
      await expectUploaded(options);
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

  test('a sync alarm wakes a stopped worker that has started once since the permission was granted', async ({
    env,
    idp,
    sync,
  }) => {
    const options = await openSyncSettings(env);
    const id = await saveQuote(options, { url: PAGE, title: TITLE, quote: QUOTE });
    await turnOnSync(options, syncConfigOf(sync, idp));
    await signIn(options, idp.subject);
    await uploadPlain(options);
    await expectUploaded(options);

    // The worker that handled the grant is stopped and started again by a message: only a listener
    // added during a worker's initial evaluation is one Chrome remembers across stops.
    await stopWorker(env.context, env.extensionId, options);
    const pushes = sync.count('POST /v1/ops');
    await setComment(options, id, 'edited by the restarted worker');
    await expect.poll(() => sync.count('POST /v1/ops')).toBeGreaterThan(pushes);

    // Stopped again: nothing wakes it but the alarm, and it syncs.
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
  // OBSERVED (Chromium 1248 bundled with Playwright 1.64): the worker that handled
  // chrome.permissions.request({ permissions: ['alarms'] }) has no chrome.alarms.onAlarm listener,
  // because registerSync() looked for chrome.alarms during the worker's initial evaluation, before
  // the permission existed. Chrome only remembers listeners added during initial evaluation, so once
  // that worker is stopped an alarm does not start it; the first cold start for any other reason (a
  // message from a page, the side panel or a content script) registers the listener for good. The
  // control above ("has started once since the permission was granted") passes; this one, which only
  // differs by that restart, waited 30 s and saw neither a worker nor a request. Nothing the
  // extension can do restarts its own worker without reloading the extension.
  test.fixme('a sync alarm wakes the worker that handled the permission grant, once it was stopped', async ({
    env,
    idp,
    sync,
  }) => {
    const options = await openSyncSettings(env);
    await turnOnSync(options, syncConfigOf(sync, idp));
    await signIn(options, idp.subject);
    await stopWorker(env.context, env.extensionId, options);
    const requests = sync.events.length;
    await options.evaluate(() => chrome.alarms.create('sv-sync-soon', { when: Date.now() + 1500 }));
    await expect
      .poll(() => workerState(env.context, env.extensionId), { timeout: 30_000 })
      .not.toBeNull();
    await expect.poll(() => sync.events.length).toBeGreaterThan(requests);
  });

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
