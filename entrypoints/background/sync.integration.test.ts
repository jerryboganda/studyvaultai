// @vitest-environment node
import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { getSettings, updateSettings } from '@runtime';
import {
  closeDb,
  countSyncAttention,
  createNote,
  createSyncRuntime,
  getDb,
  listSyncConflicts,
  listSyncQuarantine,
  resetDbForTests,
  saveCapture,
  softDeleteHighlight,
  updateHighlight,
  updateNote,
} from '@storage';
import { StudyVaultDb } from '../../packages/storage/src/db';
import { cap } from '../../packages/storage/src/test-fixtures';
import { TOKEN_A, api, start, type Running } from '../../server/src/testing';
import { createSyncService, type SyncService, type SyncServiceDeps } from './sync';
import { fakeProvider, memoryDeps, type FakeProvider } from './sync.testkit';

vi.setConfig({ testTimeout: 120_000 });

const ISSUER = 'http://localhost:4545/idp';
const CLIENT_ID = 'studyvault-extension';
const REDIRECT = 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/sync';
const PASSPHRASE = 'correct horse battery staple';

let server: Running;

interface Device {
  name: string;
  db: StudyVaultDb;
  service: SyncService;
  provider: FakeProvider;
  net: { online: boolean };
  mem: ReturnType<typeof memoryDeps>;
  /** Number of requests that reached the sync server from this device. */
  requests(): number;
}
let devices: Device[] = [];

async function makeDevice(name: 'A' | 'B', o: { expiresInSeconds?: number } = {}): Promise<Device> {
  const net = { online: true };
  let sent = 0;
  const passthrough: typeof fetch = async (input, init) => {
    if (!net.online) throw new TypeError('Failed to fetch');
    sent++;
    return fetch(input, init);
  };
  const provider = fakeProvider({
    issuer: ISSUER,
    clientId: CLIENT_ID,
    accessToken: TOKEN_A,
    subject: 'user-a',
    redirectUrl: REDIRECT,
    now: () => Date.now(),
    passthrough,
    ...(o.expiresInSeconds === undefined ? {} : { expiresInSeconds: o.expiresInSeconds }),
  });
  const mem = memoryDeps({ issuer: ISSUER, provider, redirectUrl: REDIRECT, alarms: null });
  const db = name === 'A' ? getDb() : new StudyVaultDb('studyvault-device-b');
  const deps: SyncServiceDeps = {
    ...mem.base,
    // Device A is the real extension profile: its flag lives in (fake) chrome.storage, so the
    // per-connection gate of its repositories follows it. B keeps the flag in memory.
    ...(name === 'A'
      ? {
          getSettings,
          setFlag: async (enabled: boolean) => {
            await updateSettings((s) => ({ ...s, features: { ...s.features, sync: enabled } }));
          },
        }
      : {}),
    fetch: provider.fetch,
    crypto: webcrypto as unknown as Crypto,
    notifyDataChanged: async () => undefined,
    createRuntime: (o) => createSyncRuntime({ ...o, db }),
    attention: async () =>
      name === 'A'
        ? countSyncAttention()
        : {
            conflicts: (await db.syncConflicts.toArray()).filter(
              (c) => (c as unknown as { resolution: unknown }).resolution === null,
            ).length,
            quarantined: await db.syncQuarantine.count(),
          },
  };
  const device: Device = {
    name,
    db,
    service: createSyncService(deps),
    provider,
    net,
    mem,
    requests: () => sent,
  };
  devices.push(device);
  return device;
}

/** Configure, grant, enable and sign in: what the settings page does, step by step. */
async function connect(d: Device, over: { grant?: boolean } = {}) {
  await d.service.configure({ serverUrl: server.base, issuer: ISSUER, clientId: CLIENT_ID });
  if (over.grant !== false) {
    d.mem.granted.origins.add(`${new URL(server.base).origin}/*`);
    d.mem.granted.origins.add(`${new URL(ISSUER).origin}/*`);
  }
  await d.service.enable();
  const result = await d.service.signIn();
  expect(result.needsOrigins).toEqual([]);
  await d.service.settled();
}

const sync = async (d: Device) => {
  const view = await d.service.runSync('test', { force: true });
  await d.service.settled();
  return view;
};

beforeEach(async () => {
  await resetDbForTests();
  fakeBrowser.reset();
  server = await start({}, {});
  server.clock.t = Date.now();
  devices = [];
});

afterEach(async () => {
  for (const d of devices) if (d.name === 'B') d.db.close();
  await Dexie.delete('studyvault-device-b');
  closeDb();
  await server.close();
});

/** The synchronised state of a device, comparable across devices. */
async function snapshot(db: StudyVaultDb) {
  const rows = async (table: 'banks' | 'sources' | 'highlights' | 'notes' | 'highlightBanks') =>
    (await db.table(table).toArray()) as Array<Record<string, unknown>>;
  const strip = (r: Record<string, unknown>) => {
    const { resolveStatus, resolveConfidence, lastResolvedAt, ...rest } = r;
    void resolveStatus;
    void resolveConfidence;
    void lastResolvedAt;
    return rest;
  };
  const key = (r: Record<string, unknown>) => String(r.id ?? `${r.highlightId}|${r.bankId}`);
  const out: Record<string, unknown[]> = {};
  for (const t of ['banks', 'sources', 'highlights', 'notes', 'highlightBanks'] as const) {
    out[t] = (await rows(t)).map(strip).sort((a, b) => key(a).localeCompare(key(b)));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------

describe('two devices, one account, the reference server', () => {
  it('converge after concurrent offline edits, including a text conflict, losing nothing', async () => {
    // Device A has been used for a while before sync existed.
    const first = await saveCapture(cap('Aspirin irreversibly inhibits cyclooxygenase.', 100));
    const second = await saveCapture(cap('Warfarin inhibits vitamin K epoxide reductase.', 400));
    const note = await createNote({ highlightId: first.highlight.id, body: 'Original note text' });

    const a = await makeDevice('A');
    const b = await makeDevice('B');
    await connect(a);
    expect((await sync(a)).status).toBe('idle');
    await connect(b);
    expect((await sync(b)).status).toBe('idle');

    // B received A's data through the server.
    expect((await b.db.highlights.toArray()).map((h) => h.id).sort()).toEqual(
      [first.highlight.id, second.highlight.id].sort(),
    );
    expect((await b.db.notes.get(note.id))?.body).toBe('Original note text');
    expect(await snapshot(b.db)).toEqual(await snapshot(a.db));

    // Both go offline and edit the same things.
    a.net.online = false;
    b.net.online = false;

    await updateNote(note.id, { body: 'Edited on device A' });
    await updateHighlight(first.highlight.id, { userComment: 'comment from A', priority: 1 });
    const third = await saveCapture(cap('Heparin potentiates antithrombin III.', 800));

    await new Promise((r) => setTimeout(r, 15)); // B's edits are the later ones
    await b.db.notes.update(note.id, {
      body: 'Edited on device B',
      updatedAt: new Date().toISOString(),
    });
    await b.db.highlights.update(first.highlight.id, {
      userComment: 'comment from B',
      updatedAt: new Date().toISOString(),
    });
    await b.db.highlights.update(second.highlight.id, {
      deletedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Offline: nothing leaves either device, nothing is lost, work is queued.
    const reqA = a.requests();
    expect((await sync(a)).status).toBe('offline');
    expect((await sync(b)).status).toBe('offline');
    expect(a.requests()).toBe(reqA);
    expect((await a.service.status()).pending).toBeGreaterThan(0);
    expect((await b.service.status()).pending).toBeGreaterThan(0);

    // Back online, in whatever order.
    a.net.online = true;
    b.net.online = true;
    expect((await sync(a)).status).toBe('idle');
    expect((await sync(b)).status).toBe('idle');
    expect((await sync(a)).status).toBe('idle');
    expect((await sync(b)).status).toBe('idle');

    // Converged: identical synchronised state on both devices.
    expect(await snapshot(a.db)).toEqual(await snapshot(b.db));
    expect((await b.db.highlights.get(third.highlight.id))?.exactQuote).toBe(
      'Heparin potentiates antithrombin III.',
    );
    expect((await a.db.highlights.get(second.highlight.id))?.deletedAt).not.toBeNull();
    // Different fields of one highlight merged field by field.
    const merged = (await a.db.highlights.get(first.highlight.id))!;
    expect(merged.priority).toBe(1);
    expect(merged.userComment).toBe('comment from B'); // later edit wins the shared field

    // The text conflict lost nothing: both versions exist and the user can pick.
    const bodyNow = (await a.db.notes.get(note.id))!.body;
    expect(bodyNow).toBe('Edited on device B');
    const conflicts = await listSyncConflicts({ unresolvedOnly: true });
    const noteConflict = conflicts.find((c) => c.entityType === 'notes' && c.field === 'body');
    expect(noteConflict).toBeDefined();
    expect(noteConflict!.local.value).toBe('Edited on device A');
    expect(noteConflict!.remote.value).toBe('Edited on device B');
    expect(noteConflict!.base).toBe('Original note text');
    const commentConflict = conflicts.find((c) => c.field === 'userComment');
    expect(commentConflict?.local.value).toBe('comment from A');

    // Resolving as "keep mine" propagates to the other device as an ordinary edit.
    await a.service.resolveConflict(noteConflict!.id, { choice: 'local' });
    await a.service.settled();
    expect((await a.db.notes.get(note.id))?.body).toBe('Edited on device A');
    await sync(a);
    await sync(b);
    expect((await b.db.notes.get(note.id))?.body).toBe('Edited on device A');
    expect(
      (await listSyncConflicts({ unresolvedOnly: true })).some((c) => c.id === noteConflict!.id),
    ).toBe(false);
  });

  it('a device that was off for a while sends what it changed and keeps what others changed', async () => {
    const h = await saveCapture(cap('Metformin lowers hepatic glucose output.', 100));
    const a = await makeDevice('A');
    const b = await makeDevice('B');
    await connect(a);
    await sync(a);
    await connect(b);
    await sync(b);

    // Sync is switched off on A; the user keeps working; B edits meanwhile.
    await a.service.disable();
    expect(getDb().syncInterceptor).toBeNull();
    await updateHighlight(h.highlight.id, { userComment: 'written while sync was off' });
    await b.db.highlights.update(h.highlight.id, {
      priority: 5,
      updatedAt: new Date().toISOString(),
    });
    await sync(b);

    // Switched on again: what was written while off is found, then merged with B's change.
    await a.service.enable();
    await a.service.signIn();
    await a.service.settled();
    await sync(a);
    await sync(b);
    const onA = (await a.db.highlights.get(h.highlight.id))!;
    const onB = (await b.db.highlights.get(h.highlight.id))!;
    expect(onA.userComment).toBe('written while sync was off');
    expect(onA.priority).toBe(5);
    expect(onB.userComment).toBe('written while sync was off');
    expect(onB.priority).toBe(5);
  });

  it('provenance is never overwritten: neither by a local rewrite nor by a forged remote operation', async () => {
    const h = await saveCapture(cap('The original, immutable quote.', 100));
    const a = await makeDevice('A');
    const b = await makeDevice('B');
    await connect(a);
    await sync(a);
    await connect(b);
    await sync(b);
    expect((await b.db.highlights.get(h.highlight.id))?.exactQuote).toBe(
      'The original, immutable quote.',
    );

    // B rewrites the quote locally (a bug, or a tampered database): the write happens, nothing is sent.
    const row = (await b.db.highlights.get(h.highlight.id))!;
    await b.db.highlights.put({ ...row, exactQuote: 'a rewritten quote' });
    await sync(b);
    await sync(a);
    expect((await a.db.highlights.get(h.highlight.id))?.exactQuote).toBe(
      'The original, immutable quote.',
    );
    const note = (await b.db.syncQuarantine.toArray()).find(
      (q) => (q as unknown as { reason: string }).reason === 'immutable_field',
    );
    expect(note).toBeDefined();

    // A forged operation appears on the server (a compromised server or client).
    const forged = {
      id: 'forged-op-000001',
      clientId: 'client-forger-01',
      entityType: 'highlights',
      entityId: h.highlight.id,
      opType: 'upsert',
      revision: 50,
      hlc: `${(Date.now() + 5_000).toString(36).padStart(9, '0')}.0000.client-forger-01`,
      baseRevision: 49,
      payload: {
        v: 1,
        full: false,
        set: { exactQuote: 'FORGED QUOTE' },
        prev: {},
        base: {},
        sets: {},
        observed: null,
      },
      payloadEncrypted: false,
      tombstone: false,
      idempotencyKey: 'client-forger-01:forged-op-000001',
      createdAt: new Date().toISOString(),
    };
    const pushed = await api(server.base, 'POST', '/v1/ops', {
      token: TOKEN_A,
      body: { v: 1, clientId: 'client-forger-01', ops: [forged] },
    });
    expect(pushed.json.results[0].status).toBe('accepted');

    await sync(a);
    await sync(b);
    expect((await a.db.highlights.get(h.highlight.id))?.exactQuote).toBe(
      'The original, immutable quote.',
    );
    const refused = (await listSyncQuarantine()).find((q) => q.id === 'forged-op-000001');
    expect(refused).toMatchObject({ reason: 'immutable_field', entityType: 'highlights' });
  });

  it('sign-out clears the tokens and stops all traffic; local data stays unless asked', async () => {
    const h = await saveCapture(cap('Local data that must survive sign-out.', 100));
    const a = await makeDevice('A');
    await connect(a);
    await sync(a);
    expect((await a.mem.tokens.load())?.accessToken).toBe(TOKEN_A);
    expect((await a.service.status()).signedIn).toBe(true);

    const view = await a.service.signOut({ wipeLocalData: false, revokeAtProvider: true });
    expect(view.signedIn).toBe(false);
    expect(await a.mem.tokens.load()).toBeNull();
    expect(a.provider.requests).toContain('POST /revoke');
    expect(await getDb().highlights.get(h.highlight.id)).toBeDefined(); // retained

    // More local work while signed out: queued, and no request reaches the server.
    await updateHighlight(h.highlight.id, { userComment: 'after sign-out' });
    const before = a.requests();
    const events = server.events.length;
    const after = await sync(a);
    expect(after.status).toBe('auth_required');
    expect(a.requests()).toBe(before);
    expect(server.events.length).toBe(events);
    expect(after.pending).toBeGreaterThan(0); // nothing was dropped

    // Signing in again resumes where it stopped.
    await a.service.signIn();
    await a.service.settled();
    expect((await sync(a)).pending).toBe(0);

    // The user can also choose to remove this device's data on the way out.
    await a.service.signOut({ wipeLocalData: true, revokeAtProvider: false });
    expect(a.mem.wipes).toBe(1);
    expect(await a.mem.tokens.load()).toBeNull();
  });

  it('an expiring token is refreshed; a provider that ends the session sends the user to sign in again without losing work', async () => {
    const h = await saveCapture(cap('Work that must survive a dead session.', 100));
    // Tokens that are always about to expire, so every request goes through the refresh path.
    const a = await makeDevice('A', { expiresInSeconds: 30 });
    await connect(a);
    expect((await sync(a)).status).toBe('idle');
    await updateHighlight(h.highlight.id, { userComment: 'second edit' });
    expect((await sync(a)).status).toBe('idle');
    const grants = a.provider.requests.filter((r) => r === 'POST /token');
    expect(grants.length).toBeGreaterThan(1); // the code exchange, then refreshes

    // The provider revokes the session: the refresh token no longer works.
    a.provider.refreshFails = true;
    await updateHighlight(h.highlight.id, { userComment: 'edit after the session ended' });
    const view = await sync(a);
    expect(view.status).toBe('auth_required');
    expect(view.signedIn).toBe(false);
    expect(await a.mem.tokens.load()).toBeNull();
    expect(view.pending).toBeGreaterThan(0); // queued, not dropped

    a.provider.refreshFails = false;
    await a.service.signIn();
    await a.service.settled();
    expect((await sync(a)).pending).toBe(0);
  });

  it('a wiped server is reported instead of silently diverging; re-upload restores it from the device', async () => {
    const h = await saveCapture(cap('Kept on the device when the server is wiped.', 100));
    const a = await makeDevice('A');
    await connect(a);
    await sync(a);
    await sync(a); // pins the server generation

    const gone = await api(server.base, 'DELETE', '/v1/data', {
      token: TOKEN_A,
      body: { confirm: 'delete-all-my-data' },
    });
    expect(gone.status).toBeLessThan(300);
    const stopped = await sync(a);
    expect(stopped.status).toBe('resync_required');
    expect(await getDb().highlights.get(h.highlight.id)).toBeDefined();

    await a.service.reupload();
    await a.service.settled();
    expect((await sync(a)).status).toBe('idle');
    const b = await makeDevice('B');
    await connect(b);
    await sync(b);
    expect((await b.db.highlights.get(h.highlight.id))?.exactQuote).toBe(
      'Kept on the device when the server is wiped.',
    );
  });

  it('"delete my data from the server" erases the account on the server and keeps the device', async () => {
    const h = await saveCapture(cap('Stays here, leaves the server.', 100));
    const a = await makeDevice('A');
    await connect(a);
    await sync(a);
    const before = await api(server.base, 'GET', '/v1/ops', { token: TOKEN_A });
    expect(before.json.ops.length).toBeGreaterThan(0);

    await a.service.deleteServerData();
    const after = await api(server.base, 'GET', '/v1/ops', { token: TOKEN_A });
    expect(after.json.ops).toEqual([]);
    expect(await getDb().highlights.get(h.highlight.id)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------------------------

describe('end-to-end encryption through the service', () => {
  it('existing history is re-encrypted, the server never sees plaintext, another device needs the passphrase', async () => {
    const SECRET = 'confidential board exam material';
    const h = await saveCapture(cap(SECRET, 100));
    const a = await makeDevice('A');
    await connect(a);
    await sync(a);
    const plain = await api(server.base, 'GET', '/v1/ops', { token: TOKEN_A });
    expect(JSON.stringify(plain.json)).toContain(SECRET); // not E2EE yet, and honest about it

    await a.service.e2eeSetup(PASSPHRASE);
    await a.service.settled();
    const cipher = await api(server.base, 'GET', '/v1/ops', { token: TOKEN_A });
    expect(JSON.stringify(cipher.json)).not.toContain(SECRET);
    expect(
      cipher.json.ops.every((o: { op: { payloadEncrypted: boolean } }) => o.op.payloadEncrypted),
    ).toBe(true);

    // New edits are encrypted too.
    await updateHighlight(h.highlight.id, { userComment: 'private thought about warfarin' });
    expect((await sync(a)).status).toBe('idle');
    const later = await api(server.base, 'GET', '/v1/ops', { token: TOKEN_A });
    expect(JSON.stringify(later.json)).not.toContain('private thought');

    // Device B finds out the account is encrypted and waits for the passphrase.
    const b = await makeDevice('B');
    await connect(b);
    const locked = await sync(b);
    expect(locked.status).toBe('locked');
    expect(locked.e2ee.mode).toBe('locked');
    expect(await b.db.highlights.count()).toBe(0);

    expect(await b.service.e2eeUnlock('not the passphrase')).toEqual({
      ok: false,
      reason: 'wrong_passphrase',
    });
    expect(await b.service.e2eeUnlock(PASSPHRASE)).toEqual({ ok: true, reason: null });
    await b.service.settled();
    await sync(b);
    const received = (await b.db.highlights.get(h.highlight.id))!;
    expect(received.exactQuote).toBe(SECRET);
    expect(received.userComment).toBe('private thought about warfarin');

    // Locking drops the key from memory: nothing more is exchanged until it is entered again.
    await b.service.e2eeLock();
    const count = b.requests();
    expect((await sync(b)).status).toBe('locked');
    expect(b.requests()).toBe(count);
  });

  it('rotating the passphrase re-encrypts the log; a device with the old key can no longer read', async () => {
    const h = await saveCapture(cap('Rotated secret text', 100));
    const a = await makeDevice('A');
    await connect(a);
    await a.service.e2eeSetup(PASSPHRASE);
    await a.service.settled();
    await sync(a);

    expect(
      await a.service.e2eeRotate('wrong passphrase value', 'a brand new long passphrase'),
    ).toEqual({
      ok: false,
      reason: 'wrong_passphrase',
    });
    expect(await a.service.e2eeRotate(PASSPHRASE, 'a brand new long passphrase')).toEqual({
      ok: true,
      reason: null,
    });
    await a.service.settled();
    expect((await a.service.status()).e2ee.version).toBe(2);

    const b = await makeDevice('B');
    await connect(b);
    await sync(b);
    expect(await b.service.e2eeUnlock(PASSPHRASE)).toEqual({
      ok: false,
      reason: 'wrong_passphrase',
    });
    expect(await b.service.e2eeUnlock('a brand new long passphrase')).toEqual({
      ok: true,
      reason: null,
    });
    await b.service.settled();
    await sync(b);
    expect((await b.db.highlights.get(h.highlight.id))?.exactQuote).toBe('Rotated secret text');
    void softDeleteHighlight;
  });
});
