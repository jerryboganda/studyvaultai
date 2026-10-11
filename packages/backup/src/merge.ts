import { canonicalJson, fingerprint, omitFields } from './canonical';
import { containsBinary, containsMarker, isBinary, isMarker } from './binary';
import type { Row } from './types';

/** What the merge decision needs to know about one row (live or archived). */
export interface RowMeta {
  /** Fingerprint of the canonical row without derivedFields (binary payloads by size and type). */
  fp: string;
  /** Fingerprint of the immutable fields; null when the table has none. */
  ifp: string | null;
  /** updatedAt in ms, null when absent or unparsable. */
  t: number | null;
  /** deletedAt in ms, null when live or absent. */
  d: number | null;
}

export type MergeDecision =
  | { kind: 'add' }
  | { kind: 'update'; reason: 'archive_newer' | 'archive_tombstone_tie' }
  | { kind: 'identical' }
  | { kind: 'live_newer'; reason: 'live_newer' | 'live_tombstone_tie' }
  | {
      kind: 'conflict';
      reason:
        | 'immutable_field_changed'
        | 'same_timestamp_different_content'
        | 'no_timestamp_different_content';
    };

function ms(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/** Binary payloads are compared by size and type only (reading live Blobs would defeat the scan). */
function shapeBinary(v: unknown, depth = 0): unknown {
  if (typeof v !== 'object' || v === null || depth > 64) return v;
  if (isBinary(v)) {
    const size =
      v instanceof Uint8Array
        ? v.length
        : v instanceof ArrayBuffer
          ? v.byteLength
          : (v as Blob).size;
    return { $bin: size, type: (v as Blob).type ?? '' };
  }
  if (isMarker(v)) return { $bin: v.size, type: v.mime ?? '' };
  if (Array.isArray(v)) return v.map((x) => shapeBinary(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = shapeBinary(x, depth + 1);
  return out;
}

/** Member of an immutable-field list that stands for every field of the row (append-only tables). */
export const ALL_FIELDS = '*';

export function metaOf(
  row: Row,
  derived: readonly string[] | undefined,
  immutable: readonly string[] | undefined,
): RowMeta {
  const shaped = containsBinary(row) || containsMarker(row) ? (shapeBinary(row) as Row) : row;
  const fp = fingerprint(canonicalJson(omitFields(shaped, derived)));
  let ifp: string | null = null;
  if (immutable && immutable.length > 0) {
    if (immutable.includes(ALL_FIELDS)) ifp = fp;
    else {
      const picked: Row = {};
      for (const f of immutable) if (f in shaped) picked[f] = shaped[f];
      ifp = fingerprint(canonicalJson(picked));
    }
  }
  return { fp, ifp, t: ms(row.updatedAt), d: ms(row.deletedAt) };
}

const eff = (m: RowMeta): number | null =>
  m.t === null ? m.d : m.d === null ? m.t : Math.max(m.t, m.d);

/**
 * Merge rule for one key present on both sides (never deletes, never touches provenance):
 *  1. identical content                         -> identical (nothing to do)
 *  2. immutable fields differ                    -> conflict, live kept (an id collision is not an edit)
 *  3. newer effective time wins, where the effective time of a row is max(updatedAt, deletedAt);
 *     so a later edit resurrects a tombstone and a later delete tombstones a live row
 *  4. equal time: a tombstone wins; otherwise conflict, live kept
 *  5. no timestamps on either side but content differs -> conflict, live kept
 */
export function decide(archive: RowMeta, live: RowMeta | undefined): MergeDecision {
  if (!live) return { kind: 'add' };
  if (archive.fp === live.fp) return { kind: 'identical' };
  if (archive.ifp !== null && live.ifp !== null && archive.ifp !== live.ifp) {
    return { kind: 'conflict', reason: 'immutable_field_changed' };
  }
  const a = eff(archive);
  const l = eff(live);
  if (a === null || l === null)
    return { kind: 'conflict', reason: 'no_timestamp_different_content' };
  if (a > l) return { kind: 'update', reason: 'archive_newer' };
  if (a < l) return { kind: 'live_newer', reason: 'live_newer' };
  const aDeleted = archive.d !== null;
  const lDeleted = live.d !== null;
  if (aDeleted && !lDeleted) return { kind: 'update', reason: 'archive_tombstone_tie' };
  if (lDeleted && !aDeleted) return { kind: 'live_newer', reason: 'live_tombstone_tie' };
  return { kind: 'conflict', reason: 'same_timestamp_different_content' };
}
