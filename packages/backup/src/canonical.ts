import type { TableSpec } from '@shared';
import { BackupError } from './errors';
import type { Row, RowKey } from './types';

const MAX_DEPTH = 64;

function isBinaryValue(v: object): boolean {
  return (
    ArrayBuffer.isView(v) ||
    v instanceof ArrayBuffer ||
    (typeof Blob !== 'undefined' && v instanceof Blob)
  );
}

function canon(v: unknown, depth: number): string | undefined {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'string':
      return JSON.stringify(v);
    case 'number':
      return Number.isFinite(v) ? JSON.stringify(v) : 'null';
    case 'boolean':
      return v ? 'true' : 'false';
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined;
    case 'bigint':
      throw new TypeError('bigint values cannot be stored in a backup');
    default:
  }
  const obj = v as Record<string, unknown>;
  if (depth > MAX_DEPTH) throw new TypeError('value is nested too deeply');
  if (isBinaryValue(obj)) throw new TypeError('binary value reached the JSON encoder');
  if (typeof obj.toJSON === 'function') return canon((obj.toJSON as () => unknown)(), depth + 1);
  if (Array.isArray(obj)) {
    return `[${obj.map((x) => canon(x, depth + 1) ?? 'null').join(',')}]`;
  }
  const parts: string[] = [];
  for (const k of Object.keys(obj).sort()) {
    const s = canon(obj[k], depth + 1);
    if (s !== undefined) parts.push(`${JSON.stringify(k)}:${s}`);
  }
  return `{${parts.join(',')}}`;
}

/**
 * JSON.stringify with object keys sorted (UTF-16 order), so equal data always yields equal text.
 * `undefined` members are omitted exactly like JSON.stringify. Throws TypeError on bigint, binary
 * values (extract them first) and structures deeper than 64 levels.
 */
export function canonicalJson(value: unknown): string {
  return canon(value, 0) ?? 'null';
}

/** Shallow copy without the named top-level fields. Returns the same object when nothing to strip. */
export function omitFields(row: Row, fields: readonly string[] | undefined): Row {
  if (!fields || fields.length === 0) return row;
  let out: Row | null = null;
  for (const f of fields) {
    if (f in row) {
      out ??= { ...row };
      delete out[f];
    }
  }
  return out ?? row;
}

/** Primary key of a row, per TableSpec (single field or compound array). */
export function rowKey(spec: Pick<TableSpec, 'name' | 'primaryKey'>, row: Row): RowKey {
  const pk = spec.primaryKey;
  const part = (field: string): string | number => {
    const v = row[field];
    if (typeof v === 'string' || typeof v === 'number') return v;
    throw new BackupError('source_error', `${spec.name}: row has no usable "${field}" key`, {
      table: spec.name,
    });
  };
  return typeof pk === 'string' ? part(pk) : pk.map(part);
}

/** Stable string form of a key, for Set/Map membership. Type-preserving ("1" and 1 differ). */
export function keyString(key: RowKey): string {
  return JSON.stringify(key);
}

/** cyrb53: fast 53-bit non-cryptographic hash, used only for in-memory row-equality checks. */
export function fingerprint(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let lastYield = 0;
/** Lets timers and abort handlers run during long loops; yields at most every 40 ms. */
export async function yieldIfDue(): Promise<void> {
  const now = Date.now();
  if (now - lastYield < 40) return;
  await new Promise<void>((r) => setTimeout(r, 0));
  lastYield = Date.now();
}
