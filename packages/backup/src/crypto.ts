import { BackupError } from './errors';
import { concatBytes, fromBase64, toBase64, toHex } from './canonical';

/** The WebCrypto subset this package needs; inject `crypto.subtle` (or a Node webcrypto one). */
export type Subtle = Pick<
  SubtleCrypto,
  'digest' | 'importKey' | 'deriveBits' | 'encrypt' | 'decrypt'
>;

export interface CryptoDeps {
  subtle: Subtle;
  randomBytes: (n: number) => Uint8Array;
}

export function resolveCrypto(
  opts: { subtle?: Subtle; randomBytes?: (n: number) => Uint8Array } = {},
): CryptoDeps {
  const subtle = opts.subtle ?? globalThis.crypto?.subtle;
  if (!subtle) {
    throw new BackupError('crypto_unavailable', 'WebCrypto (crypto.subtle) is not available.');
  }
  const randomBytes =
    opts.randomBytes ??
    ((n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n)) as Uint8Array);
  return { subtle, randomBytes };
}

export async function sha256Hex(subtle: Subtle, data: Uint8Array): Promise<string> {
  const digest = await subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>);
  return toHex(new Uint8Array(digest));
}

// ---------------------------------------------------------------------------------------------
// Passphrase encryption of a whole archive.
//
//   "SVBKENC1" | u32be headerLength | header JSON | AES-256-GCM(ciphertext || tag)
//
// The header (magic + length + JSON) is the GCM additional authenticated data, so changing the KDF
// parameters invalidates the payload. PBKDF2-HMAC-SHA-256 derives 512 bits: the first 256 are the
// AES key, the last 256 are a key-check value stored in the header so a WRONG PASSPHRASE can be told
// apart from a CORRUPTED archive without decrypting anything.
// ---------------------------------------------------------------------------------------------

const MAGIC = new TextEncoder().encode('SVBKENC1');
export const DEFAULT_KDF_ITERATIONS = 600_000;
export const MIN_KDF_ITERATIONS = 1_000;
export const MAX_KDF_ITERATIONS = 5_000_000;
const MAX_HEADER_BYTES = 1024;

interface EncHeader {
  v: 1;
  kdf: 'PBKDF2-SHA256';
  iter: number;
  salt: string;
  iv: string;
  alg: 'AES-256-GCM';
  check: string;
  /** Plain-text label of the feature that wrote the file (see Manifest.origin); authenticated. */
  origin?: string;
}

export function isEncryptedContainer(bytes: Uint8Array): boolean {
  if (bytes.length < MAGIC.length) return false;
  return MAGIC.every((b, i) => bytes[i] === b);
}

async function deriveKey(
  subtle: Subtle,
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<{ key: CryptoKey; check: Uint8Array }> {
  const pw = new TextEncoder().encode(passphrase.normalize('NFKC'));
  const base = await subtle.importKey('raw', pw as Uint8Array<ArrayBuffer>, 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = new Uint8Array(
    await subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: salt as Uint8Array<ArrayBuffer>, iterations },
      base,
      512,
    ),
  );
  const key = await subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
  return { key, check: bits.slice(32) };
}

export async function encryptContainer(
  deps: CryptoDeps,
  plain: Uint8Array,
  passphrase: string,
  iterations: number,
  origin?: string,
): Promise<Uint8Array> {
  if (passphrase.length === 0) {
    throw new BackupError('invalid_options', 'The passphrase must not be empty.');
  }
  if (!Number.isInteger(iterations) || iterations < MIN_KDF_ITERATIONS) {
    throw new BackupError(
      'invalid_options',
      `kdfIterations must be an integer >= ${MIN_KDF_ITERATIONS}.`,
    );
  }
  const salt = deps.randomBytes(16);
  const iv = deps.randomBytes(12);
  const { key, check } = await deriveKey(deps.subtle, passphrase, salt, iterations);
  const header: EncHeader = {
    v: 1,
    kdf: 'PBKDF2-SHA256',
    iter: iterations,
    salt: toBase64(salt),
    iv: toBase64(iv),
    alg: 'AES-256-GCM',
    check: toBase64(check),
    ...(origin ? { origin } : {}),
  };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const prefix = new Uint8Array(MAGIC.length + 4 + headerBytes.length);
  prefix.set(MAGIC, 0);
  new DataView(prefix.buffer).setUint32(MAGIC.length, headerBytes.length);
  prefix.set(headerBytes, MAGIC.length + 4);
  const cipher = new Uint8Array(
    await deps.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as Uint8Array<ArrayBuffer>, additionalData: prefix },
      key,
      plain as Uint8Array<ArrayBuffer>,
    ),
  );
  return concatBytes([prefix, cipher]);
}

function parseHeader(bytes: Uint8Array): { header: EncHeader; prefixLength: number } {
  const bad = (m: string) => new BackupError('corrupt_archive', `Encrypted backup header: ${m}`);
  if (bytes.length < MAGIC.length + 4) throw bad('file is too short');
  const len = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    MAGIC.length,
  );
  if (len === 0 || len > MAX_HEADER_BYTES || MAGIC.length + 4 + len > bytes.length) {
    throw bad('invalid length');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        bytes.subarray(MAGIC.length + 4, MAGIC.length + 4 + len),
      ),
    );
  } catch {
    throw bad('not valid JSON');
  }
  const h = raw as Partial<EncHeader> | null;
  if (
    !h ||
    h.v !== 1 ||
    h.kdf !== 'PBKDF2-SHA256' ||
    h.alg !== 'AES-256-GCM' ||
    typeof h.iter !== 'number' ||
    !Number.isInteger(h.iter) ||
    h.iter < 1 ||
    h.iter > MAX_KDF_ITERATIONS ||
    typeof h.salt !== 'string' ||
    typeof h.iv !== 'string' ||
    typeof h.check !== 'string'
  ) {
    throw bad('unsupported or invalid parameters');
  }
  return { header: h as EncHeader, prefixLength: MAGIC.length + 4 + len };
}

/**
 * The plain-text `origin` label in the header of an encrypted container, or null (no label, or not a
 * container). Reads only the header, so `bytes` may be just the first ~1 KiB of the file.
 */
export function containerOrigin(bytes: Uint8Array): string | null {
  try {
    return parseHeader(bytes).header.origin ?? null;
  } catch {
    return null;
  }
}

export async function decryptContainer(
  deps: CryptoDeps,
  bytes: Uint8Array,
  passphrase: string,
): Promise<Uint8Array> {
  const { header, prefixLength } = parseHeader(bytes);
  let salt: Uint8Array, iv: Uint8Array, check: Uint8Array;
  try {
    salt = fromBase64(header.salt);
    iv = fromBase64(header.iv);
    check = fromBase64(header.check);
  } catch {
    throw new BackupError('corrupt_archive', 'Encrypted backup header: invalid base64.');
  }
  if (iv.length !== 12 || salt.length < 8 || check.length !== 32) {
    throw new BackupError('corrupt_archive', 'Encrypted backup header: invalid field lengths.');
  }
  const derived = await deriveKey(deps.subtle, passphrase, salt, header.iter);
  let diff = 0;
  for (let i = 0; i < 32; i++) diff |= (derived.check[i] ?? 0) ^ (check[i] ?? 1);
  if (diff !== 0) throw new BackupError('wrong_passphrase', 'The passphrase is incorrect.');
  try {
    return new Uint8Array(
      await deps.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: iv as Uint8Array<ArrayBuffer>,
          additionalData: bytes.subarray(0, prefixLength) as Uint8Array<ArrayBuffer>,
        },
        derived.key,
        bytes.subarray(prefixLength) as Uint8Array<ArrayBuffer>,
      ),
    );
  } catch (cause) {
    throw new BackupError(
      'encrypted_payload_corrupt',
      'The encrypted backup is damaged or has been modified.',
      {},
      cause,
    );
  }
}
