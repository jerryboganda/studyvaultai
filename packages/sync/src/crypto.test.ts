// @vitest-environment node
import { webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  KeyVersionError,
  MIN_PASSPHRASE_CHARS,
  PBKDF2_ITERATIONS,
  WeakPassphraseError,
  WrongPassphraseError,
  b64urlDecode,
  b64urlEncode,
  buildRotation,
  createKey,
  createPayloadCodec,
  exportKeyJwk,
  importKeyJwk,
  unlockKey,
} from './crypto.ts';
import { CodecLockedError } from './ports.ts';
import type { OpAad } from './ports.ts';
import { KeyProfile } from './schema.ts';

// 600,000 PBKDF2 rounds per derivation is the point; CI runs many test files at once.
vi.setConfig({ testTimeout: 60_000 });

const crypto = webcrypto as unknown as Parameters<typeof createKey>[0]['crypto'];
const PASSPHRASE = 'correct horse battery staple';
let sharedOne: ReturnType<typeof createKey> | undefined;
const keyOne = () => (sharedOne ??= createKey({ crypto, passphrase: PASSPHRASE, now: 1 }));
let sharedTwo: ReturnType<typeof createKey> | undefined;
const keyTwo = () =>
  (sharedTwo ??= createKey({
    crypto,
    passphrase: 'another very long passphrase',
    now: 2,
    version: 2,
  }));
const aad: OpAad = {
  id: 'op-A-000001',
  clientId: 'client-A',
  entityType: 'highlights',
  entityId: 'hl-000001',
  opType: 'upsert',
  revision: 3,
  hlc: '0mv3jbchc.0000.client-A',
};

describe('E2EE key and payload encryption', () => {
  it('derives a key with the documented cost and publishes no key material', async () => {
    const { profile, key } = await createKey({
      crypto,
      passphrase: PASSPHRASE,
      now: 1_800_000_000_000,
    });
    expect(PBKDF2_ITERATIONS).toBeGreaterThanOrEqual(600_000);
    expect(profile.iterations).toBe(PBKDF2_ITERATIONS);
    expect(KeyProfile.safeParse(profile).success).toBe(true);
    expect(b64urlDecode(profile.salt)).toHaveLength(16);
    expect(JSON.stringify(profile)).not.toContain(PASSPHRASE);
    // The data key never leaves the device: it cannot even be exported by this process.
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
  });

  it('unlocks with the passphrase and detects a wrong one before touching data', async () => {
    const { profile, key } = await keyOne();
    const writer = createPayloadCodec(crypto);
    writer.unlock(key, profile.kid);
    const envelope = await writer.encrypt({ secret: 'note' }, aad);

    const again = await unlockKey({ crypto, passphrase: PASSPHRASE, profile });
    const reader = createPayloadCodec(crypto);
    reader.unlock(again, profile.kid);
    expect(await reader.decrypt(envelope, aad)).toEqual({ secret: 'note' });

    await expect(
      unlockKey({ crypto, passphrase: 'a different long passphrase', profile }),
    ).rejects.toBeInstanceOf(WrongPassphraseError);
  });

  it('refuses short passphrases and a server-downgraded key cost', async () => {
    await expect(
      createKey({ crypto, passphrase: 'x'.repeat(MIN_PASSPHRASE_CHARS - 1), now: 1 }),
    ).rejects.toBeInstanceOf(WeakPassphraseError);
    const { profile } = await keyOne();
    // A hostile server hands back a profile with a trivially cheap KDF: refused, not obeyed.
    await expect(
      unlockKey({ crypto, passphrase: PASSPHRASE, profile: { ...profile, iterations: 1_000 } }),
    ).rejects.toThrow();
  });

  it('binds each ciphertext to its operation and rejects any tampering', async () => {
    const { profile, key } = await keyOne();
    const codec = createPayloadCodec(crypto);
    codec.unlock(key, profile.kid);
    const a = await codec.encrypt({ v: 1 }, aad);
    const b = await codec.encrypt({ v: 1 }, aad);
    expect(a.iv).not.toBe(b.iv); // fresh random IV per operation
    expect(a.ct).not.toBe(b.ct);

    await expect(codec.decrypt(a, { ...aad, entityId: 'hl-000002' })).rejects.toThrow();
    await expect(codec.decrypt(a, { ...aad, revision: 4 })).rejects.toThrow();
    await expect(codec.decrypt(a, { ...aad, hlc: '0mv3jbchd.0000.client-A' })).rejects.toThrow();
    const flipped = { ...a, ct: (a.ct[0] === 'A' ? 'B' : 'A') + a.ct.slice(1) };
    await expect(codec.decrypt(flipped, aad)).rejects.toThrow();
    expect(await codec.decrypt(a, aad)).toEqual({ v: 1 });
  });

  it('is locked until a key is installed, and reports a foreign key version as locked', async () => {
    const one = await keyOne();
    const two = await keyTwo();
    const a = createPayloadCodec(crypto);
    await expect(a.encrypt({}, aad)).rejects.toBeInstanceOf(CodecLockedError);
    a.unlock(one.key, one.profile.kid);
    const envelope = await a.encrypt({ n: 1 }, aad);
    const b = createPayloadCodec(crypto);
    b.unlock(two.key, two.profile.kid);
    await expect(b.decrypt(envelope, aad)).rejects.toBeInstanceOf(KeyVersionError);
    a.lock();
    expect(a.isUnlocked()).toBe(false);
  });

  it('rotates: everything is re-encrypted under the new key and the old one stops working', async () => {
    const one = await keyOne();
    const two = await keyTwo();
    const oldCodec = createPayloadCodec(crypto);
    oldCodec.unlock(one.key, one.profile.kid);
    const newCodec = createPayloadCodec(crypto);
    newCodec.unlock(two.key, two.profile.kid);

    const encrypted = await oldCodec.encrypt({ secret: 'x' }, aad);
    const setAside: string[] = [];
    const request = await buildRotation({
      ops: [
        { ...aad, payload: encrypted, payloadEncrypted: true },
        // The server is not a witness: plaintext that appears in an encrypted log is never blessed.
        { ...aad, id: 'op-A-000002', payload: { plain: true }, payloadEncrypted: false },
      ],
      oldCodec,
      newCodec,
      newProfile: two.profile,
      onSetAside: (op, reason) => setAside.push(`${op.id}:${reason}`),
    });
    expect(request.replacements).toHaveLength(2);
    expect(request.profile.version).toBe(2);
    expect(await newCodec.decrypt(request.replacements[0]!.payload, aad)).toEqual({ secret: 'x' });
    await expect(oldCodec.decrypt(request.replacements[0]!.payload, aad)).rejects.toBeInstanceOf(
      KeyVersionError,
    );
    // The plaintext operation was NOT re-encrypted as authentic: no key opens its replacement.
    expect(setAside).toEqual(['op-A-000002:unencrypted']);
    const laundered = request.replacements[1]!;
    await expect(
      newCodec.decrypt(laundered.payload, { ...aad, id: 'op-A-000002' }),
    ).rejects.toThrow();
  });

  it('rotation re-encrypts only what authenticates under the old key', async () => {
    const one = await keyOne();
    const two = await keyTwo();
    const oldCodec = createPayloadCodec(crypto);
    oldCodec.unlock(one.key, one.profile.kid);
    const newCodec = createPayloadCodec(crypto);
    newCodec.unlock(two.key, two.profile.kid);

    const good = await oldCodec.encrypt({ n: 1 }, aad);
    // Valid ciphertext, but presented as another entity (the server moved it): not authentic here.
    const moved = { ...aad, id: 'op-A-000003', entityId: 'hl-000777' };
    const asides: string[] = [];
    const request = await buildRotation({
      ops: [
        { ...aad, payload: good, payloadEncrypted: true },
        { ...moved, payload: good, payloadEncrypted: true },
      ],
      oldCodec,
      newCodec,
      newProfile: two.profile,
      onSetAside: (op, reason) => asides.push(`${op.id}:${reason}`),
    });
    expect(asides).toEqual(['op-A-000003:unauthenticated']);
    expect(await newCodec.decrypt(request.replacements[0]!.payload, aad)).toEqual({ n: 1 });
    await expect(newCodec.decrypt(request.replacements[1]!.payload, moved)).rejects.toThrow();
  });

  it('a plaintext operation can be kept (the caller validated it), or replaced by an authenticated void', async () => {
    const two = await keyTwo();
    const newCodec = createPayloadCodec(crypto);
    newCodec.unlock(two.key, two.profile.kid);
    const plain = createPayloadCodec(crypto); // never unlocked: only "old" for plaintext ops
    const request = await buildRotation({
      ops: [
        { ...aad, id: 'op-A-000010', payload: { keep: true }, payloadEncrypted: false },
        { ...aad, id: 'op-A-000011', payload: { forged: true }, payloadEncrypted: false },
      ],
      oldCodec: plain,
      newCodec,
      newProfile: two.profile,
      plaintext: (op) => (op.id === 'op-A-000010' ? 'keep' : 'void'),
    });
    expect(
      await newCodec.decrypt(request.replacements[0]!.payload, { ...aad, id: 'op-A-000010' }),
    ).toEqual({ keep: true });
    expect(
      await newCodec.decrypt(request.replacements[1]!.payload, { ...aad, id: 'op-A-000011' }),
    ).toEqual({ v: 1, void: true });
  });

  it('refuses to rotate without the old key instead of discarding everything as unverifiable', async () => {
    const two = await keyTwo();
    const locked = createPayloadCodec(crypto);
    const newCodec = createPayloadCodec(crypto);
    newCodec.unlock(two.key, two.profile.kid);
    await expect(
      buildRotation({
        ops: [{ ...aad, payload: { v: 1 }, payloadEncrypted: true }],
        oldCodec: locked,
        newCodec,
        newProfile: two.profile,
      }),
    ).rejects.toBeInstanceOf(CodecLockedError);
  });

  it('keeps the data key non-extractable unless asked, and exports it for the session store', async () => {
    const closed = await keyOne();
    await expect(exportKeyJwk(crypto, closed.key)).rejects.toThrow();

    const open = await createKey({ crypto, passphrase: PASSPHRASE, now: 3, extractable: true });
    const jwk = await exportKeyJwk(crypto, open.key);
    expect(jwk).toMatchObject({ kty: 'oct', alg: 'A256GCM' });
    const a = createPayloadCodec(crypto);
    a.unlock(open.key, open.profile.kid);
    const envelope = await a.encrypt({ n: 7 }, aad);
    // Back from the JWK (what a restarted worker does): the same key, and no longer extractable.
    const restored = await importKeyJwk(crypto, jwk);
    const b = createPayloadCodec(crypto);
    b.unlock(restored, open.profile.kid);
    expect(await b.decrypt(envelope, aad)).toEqual({ n: 7 });
    await expect(exportKeyJwk(crypto, restored)).rejects.toThrow();
    await expect(importKeyJwk(crypto, { kty: 'oct', k: 'short' })).rejects.toThrow();
  });

  it('base64url round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array(300).map((_, i) => (i * 7) % 256);
    expect(b64urlDecode(b64urlEncode(bytes))).toEqual(bytes);
    expect(() => b64urlDecode('not base64!')).toThrow();
  });
});
