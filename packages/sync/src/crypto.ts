import { stableStringify } from './json.ts';
import type { OpAad, PayloadCodec } from './ports.ts';
import { CodecLockedError } from './ports.ts';
import type { EncryptedEnvelope, KeyProfile, RotateRequest } from './schema.ts';
import { EncryptedEnvelope as EnvelopeSchema, KeyProfile as KeyProfileSchema } from './schema.ts';

/**
 * Optional end-to-end encryption of operation payloads (WebCrypto only; `crypto` is injected).
 *
 *  - Key: PBKDF2-HMAC-SHA-256, 600,000 iterations minimum (OWASP guidance for this PRF; Argon2 is
 *    not available in WebCrypto), 128-bit random salt. The 256-bit output is never used directly:
 *    HKDF-SHA-256 derives separate keys for data (AES-256-GCM) and for the key check (HMAC), so the
 *    check value reveals nothing usable against the data key.
 *  - The data key is created non-extractable. It exists only as a CryptoKey object in this device's
 *    memory (or an IndexedDB structured clone the caller chooses to keep). It is never serialised
 *    and never sent anywhere.
 *  - Each payload: AES-256-GCM, fresh 96-bit random IV, 128-bit tag, and authenticated associated data
 *    binding the ciphertext to (id, client, entityType, entityId, opType, revision, hlc). The server
 *    can therefore neither move a payload to another entity or revision nor alter its clock.
 *  - Wrong passphrase: detected by the key-check HMAC before any data is touched.
 *
 * What the server still sees (it must, to route and order): entity type and id, operation type,
 * revision, clock, sizes and timing. It cannot read or forge content, and server-side AI cannot read
 * it; decrypted text may be sent to an AI provider only through the separate, explicit AI consent.
 * Encryption in transit and at rest on a server that holds the keys is NOT end-to-end encryption.
 */

export const PBKDF2_ITERATIONS = 600_000;
export const MIN_PASSPHRASE_CHARS = 12;

const KEY_CHECK_MESSAGE = 'studyvault-key-check-v1';
const INFO_DATA = 'studyvault/e2ee/data/v1';
const INFO_CHECK = 'studyvault/e2ee/check/v1';
const GCM_IV_BYTES = 12;

export type CryptoLike = Pick<Crypto, 'subtle' | 'getRandomValues'>;

export class WrongPassphraseError extends Error {
  constructor() {
    super('The passphrase is wrong for this sync key.');
    this.name = 'WrongPassphraseError';
  }
}

export class WeakPassphraseError extends Error {
  constructor() {
    super(`Use a passphrase of at least ${MIN_PASSPHRASE_CHARS} characters.`);
    this.name = 'WeakPassphraseError';
  }
}

/** The envelope was written with another key version: unlock with the current passphrase. */
export class KeyVersionError extends CodecLockedError {
  constructor(expected: string, actual: string) {
    super();
    this.message = `Encrypted with key ${actual}, this device holds ${expected}`;
    this.name = 'KeyVersionError';
  }
}

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function b64urlDecode(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('invalid base64url');
  const padded =
    text.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const utf8 = (s: string) => new TextEncoder().encode(s);
const toBuf = (u: Uint8Array): ArrayBuffer => u.slice().buffer as ArrayBuffer;

interface Material {
  dataKey: CryptoKey;
  checkKey: CryptoKey;
}

async function derive(
  crypto: CryptoLike,
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Material> {
  const { subtle } = crypto;
  const password = await subtle.importKey(
    'raw',
    toBuf(utf8(passphrase.normalize('NFKC'))),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: toBuf(salt), iterations },
    password,
    256,
  );
  const hkdf = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  new Uint8Array(bits).fill(0);
  const hkdfParams = (info: string) => ({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: new ArrayBuffer(32),
    info: toBuf(utf8(info)),
  });
  const dataKey = await subtle.deriveKey(
    hkdfParams(INFO_DATA),
    hkdf,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  const checkKey = await subtle.deriveKey(
    hkdfParams(INFO_CHECK),
    hkdf,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify'],
  );
  return { dataKey, checkKey };
}

function checkPassphrase(passphrase: string): void {
  if ([...passphrase].length < MIN_PASSPHRASE_CHARS) throw new WeakPassphraseError();
}

export interface CreateKeyOptions {
  crypto: CryptoLike;
  passphrase: string;
  /** Epoch ms for `createdAt`. */
  now: number;
  /** Default PBKDF2_ITERATIONS. Never below the schema minimum of 600,000. */
  iterations?: number;
  /** 1 for a new vault; previous version + 1 when rotating. */
  version?: number;
}

/** New key + its public profile (store the profile on the server; keep the key in memory). */
export async function createKey(
  o: CreateKeyOptions,
): Promise<{ profile: KeyProfile; key: CryptoKey }> {
  checkPassphrase(o.passphrase);
  const salt = o.crypto.getRandomValues(new Uint8Array(16));
  const iterations = o.iterations ?? PBKDF2_ITERATIONS;
  const version = o.version ?? 1;
  const { dataKey, checkKey } = await derive(o.crypto, o.passphrase, salt, iterations);
  const check = await o.crypto.subtle.sign('HMAC', checkKey, toBuf(utf8(KEY_CHECK_MESSAGE)));
  const profile = KeyProfileSchema.parse({
    v: 1,
    kdf: 'PBKDF2-SHA256',
    iterations,
    salt: b64urlEncode(salt),
    kid: `k${version}-${b64urlEncode(o.crypto.getRandomValues(new Uint8Array(6)))}`,
    version,
    keyCheck: b64urlEncode(new Uint8Array(check)),
    createdAt: new Date(o.now).toISOString(),
  });
  return { profile, key: dataKey };
}

/** Derive the key from a passphrase and a (server-supplied) profile. Throws WrongPassphraseError. */
export async function unlockKey(o: {
  crypto: CryptoLike;
  passphrase: string;
  profile: KeyProfile;
}): Promise<CryptoKey> {
  const profile = KeyProfileSchema.parse(o.profile); // re-validates the cost floor against a hostile server
  const { dataKey, checkKey } = await derive(
    o.crypto,
    o.passphrase,
    b64urlDecode(profile.salt),
    profile.iterations,
  );
  const ok = await o.crypto.subtle.verify(
    'HMAC',
    checkKey,
    toBuf(b64urlDecode(profile.keyCheck)),
    toBuf(utf8(KEY_CHECK_MESSAGE)),
  );
  if (!ok) throw new WrongPassphraseError();
  return dataKey;
}

/** Canonical authenticated data for an operation. */
export function aadBytes(aad: OpAad): Uint8Array {
  return utf8(
    stableStringify({
      v: 1,
      id: aad.id,
      clientId: aad.clientId,
      entityType: aad.entityType,
      entityId: aad.entityId,
      opType: aad.opType,
      revision: aad.revision,
      hlc: aad.hlc,
    }),
  );
}

export interface KeyedCodec extends PayloadCodec {
  /** Install a key (after the passphrase was accepted). */
  unlock(key: CryptoKey, kid: string): void;
  /** Forget the key (sign-out, lock timeout). */
  lock(): void;
}

/** E2EE codec. Starts locked: nothing is encrypted or decrypted until `unlock`. */
export function createPayloadCodec(crypto: CryptoLike): KeyedCodec {
  let current: { key: CryptoKey; kid: string } | null = null;
  return {
    required: true,
    isUnlocked: () => current !== null,
    unlock(key, kid) {
      current = { key, kid };
    },
    lock() {
      current = null;
    },
    async encrypt(payload, aad): Promise<EncryptedEnvelope> {
      if (!current) throw new CodecLockedError();
      const iv = crypto.getRandomValues(new Uint8Array(GCM_IV_BYTES));
      const ct = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: toBuf(iv), additionalData: toBuf(aadBytes(aad)), tagLength: 128 },
        current.key,
        toBuf(utf8(JSON.stringify(payload))),
      );
      return {
        v: 1,
        alg: 'A256GCM',
        kid: current.kid,
        iv: b64urlEncode(iv),
        ct: b64urlEncode(new Uint8Array(ct)),
      };
    },
    async decrypt(envelope, aad): Promise<unknown> {
      if (!current) throw new CodecLockedError();
      const parsed = EnvelopeSchema.parse(envelope);
      if (parsed.kid !== current.kid) throw new KeyVersionError(current.kid, parsed.kid);
      const plain = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: toBuf(b64urlDecode(parsed.iv)),
          additionalData: toBuf(aadBytes(aad)),
          tagLength: 128,
        },
        current.key,
        toBuf(b64urlDecode(parsed.ct)),
      );
      return JSON.parse(new TextDecoder().decode(plain)) as unknown;
    },
  };
}

/**
 * Key rotation (new passphrase, or periodic):
 *  1. unlock with the current passphrase; `createKey({ passphrase: new, version: current + 1 })`;
 *  2. pull the whole log (cursor null) and call `buildRotation` with the old and new codecs;
 *  3. POST the result to /v1/e2ee/rotate: the server swaps profile and every payload atomically and
 *     refuses unless the profile is exactly version + 1 and every operation is covered;
 *  4. other devices see KeyVersionError, ask for the new passphrase, `unlockKey` with the new profile.
 * The same call migrates a plaintext history to E2EE (plaintext ops are re-encrypted in place).
 * Old ciphertext in server backups stays decryptable with the old passphrase: rotate, then expire backups.
 */
export async function buildRotation(o: {
  ops: readonly {
    id: string;
    clientId: string;
    entityType: string;
    entityId: string;
    opType: string;
    revision: number;
    hlc: string;
    payload: unknown;
    payloadEncrypted: boolean;
  }[];
  oldCodec: PayloadCodec;
  newCodec: PayloadCodec;
  newProfile: KeyProfile;
}): Promise<RotateRequest> {
  const replacements: RotateRequest['replacements'] = [];
  for (const op of o.ops) {
    const aad: OpAad = {
      id: op.id,
      clientId: op.clientId,
      entityType: op.entityType,
      entityId: op.entityId,
      opType: op.opType,
      revision: op.revision,
      hlc: op.hlc,
    };
    const plain = op.payloadEncrypted
      ? await o.oldCodec.decrypt(EnvelopeSchema.parse(op.payload), aad)
      : op.payload;
    replacements.push({ id: op.id, payload: await o.newCodec.encrypt(plain, aad) });
  }
  return { profile: o.newProfile, replacements };
}
