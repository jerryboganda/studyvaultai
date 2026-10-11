import { BackupError } from './errors';
import { sha256Hex, type Subtle } from './crypto';

/**
 * Binary values (Blob, ArrayBuffer, Uint8Array) cannot live in NDJSON. Export lifts each one into a
 * `blobs/<sha256>.bin` zip entry and leaves this marker in the row; restore verifies the digest and
 * puts back a value of the original kind. Identical bytes share one entry.
 */
export interface BinaryMarker {
  $sv: 'bytes';
  sha256: string;
  size: number;
  kind: 'blob' | 'u8' | 'ab';
  mime?: string;
}

const MAX_DEPTH = 64;

export function isBinary(v: unknown): v is Blob | ArrayBuffer | Uint8Array {
  return (
    v instanceof Uint8Array ||
    v instanceof ArrayBuffer ||
    (typeof Blob !== 'undefined' && v instanceof Blob)
  );
}

export function isMarker(v: unknown): v is BinaryMarker {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Partial<BinaryMarker>;
  return (
    m.$sv === 'bytes' &&
    typeof m.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(m.sha256) &&
    typeof m.size === 'number' &&
    Number.isInteger(m.size) &&
    m.size >= 0 &&
    (m.kind === 'blob' || m.kind === 'u8' || m.kind === 'ab') &&
    (m.mime === undefined || (typeof m.mime === 'string' && m.mime.length <= 255))
  );
}

function walkFind(v: unknown, test: (x: unknown) => boolean, depth: number): boolean {
  if (typeof v !== 'object' || v === null) return false;
  if (test(v)) return true;
  if (depth > MAX_DEPTH) return false;
  if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return false;
  const children = Array.isArray(v) ? v : Object.values(v);
  return children.some((c) => walkFind(c, test, depth + 1));
}

export const containsBinary = (row: unknown): boolean => walkFind(row, isBinary, 0);
export const containsMarker = (row: unknown): boolean => walkFind(row, isMarker, 0);

async function bytesOf(v: Blob | ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return new Uint8Array(await v.arrayBuffer());
}

/**
 * Deep copy of `value` with every binary replaced by a marker; `onBytes` receives each distinct
 * payload (sha256 + bytes). Values that are not plain JSON data or one of the three binary kinds
 * are left for the JSON encoder to reject.
 */
export async function extractBinaries(
  value: unknown,
  subtle: Subtle,
  onBytes: (sha256: string, bytes: Uint8Array) => Promise<void> | void,
  depth = 0,
): Promise<unknown> {
  if (typeof value !== 'object' || value === null) return value;
  if (isBinary(value)) {
    const bytes = await bytesOf(value);
    const sha256 = await sha256Hex(subtle, bytes);
    await onBytes(sha256, bytes);
    const kind = value instanceof Uint8Array ? 'u8' : value instanceof ArrayBuffer ? 'ab' : 'blob';
    const marker: BinaryMarker = { $sv: 'bytes', sha256, size: bytes.length, kind };
    if (kind === 'blob' && (value as Blob).type) marker.mime = (value as Blob).type.slice(0, 255);
    return marker;
  }
  if (ArrayBuffer.isView(value)) {
    throw new BackupError(
      'source_error',
      'Only Uint8Array, ArrayBuffer and Blob values can be backed up.',
    );
  }
  if (depth > MAX_DEPTH) throw new TypeError('value is nested too deeply');
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) out.push(await extractBinaries(item, subtle, onBytes, depth + 1));
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = await extractBinaries(v, subtle, onBytes, depth + 1);
  }
  return out;
}

/** Inverse of extractBinaries. `load` returns verified bytes for a digest (and may throw). */
export async function rehydrateBinaries(
  value: unknown,
  load: (marker: BinaryMarker) => Promise<Uint8Array>,
  depth = 0,
): Promise<unknown> {
  if (typeof value !== 'object' || value === null) return value;
  if (isMarker(value)) {
    const bytes = await load(value);
    if (value.kind === 'u8') return bytes;
    if (value.kind === 'ab' || typeof Blob === 'undefined') {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
    return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: value.mime ?? '' });
  }
  if (depth > MAX_DEPTH) throw new TypeError('value is nested too deeply');
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) out.push(await rehydrateBinaries(item, load, depth + 1));
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = await rehydrateBinaries(v, load, depth + 1);
  return out;
}

/** Every marker in a value (document order). */
export function collectMarkers(
  value: unknown,
  out: BinaryMarker[] = [],
  depth = 0,
): BinaryMarker[] {
  if (typeof value !== 'object' || value === null || depth > MAX_DEPTH) return out;
  if (isMarker(value)) {
    out.push(value);
    return out;
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    collectMarkers(child, out, depth + 1);
  }
  return out;
}
