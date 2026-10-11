import { SCHEMA_VERSION } from '@shared';

type Row = Record<string, unknown>;

/**
 * One step per stored schemaVersion: `UPGRADES[n]` turns a version-n row into a version-(n+1) row.
 * Empty while SCHEMA_VERSION is 1. A later schema adds its step here next to its Dexie
 * `version(n).upgrade`, so a row the database upgrade has not reached yet still reads correctly.
 */
const UPGRADES: Record<number, (row: Row) => Row> = {};

/**
 * Bring a stored row to the shape the current schema validates, so that reads accept every
 * schemaVersion >= 1 instead of treating a row they merely do not know as corrupt.
 *  - older version: its upgrade steps are applied (none exist yet);
 *  - newer version (data written by a newer build, then this older build restored): read as the
 *    current shape, unknown fields dropped by validation. Such rows are only ever read: writes are
 *    refused while any exists (`withWritableDb`);
 *  - no usable version: returned untouched, so validation rejects it.
 */
export function normaliseRow(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;
  const row = raw as Row;
  const version = row.schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return raw;
  if (version > SCHEMA_VERSION) return { ...row, schemaVersion: SCHEMA_VERSION };
  let next = row;
  for (let v = version; v < SCHEMA_VERSION; v++) {
    const step = UPGRADES[v];
    if (!step) return raw;
    next = { ...step(next), schemaVersion: v + 1 };
  }
  return next;
}

/** True for a row that a newer build wrote. */
export function isNewerRow(raw: unknown): boolean {
  const version = (raw as { schemaVersion?: unknown } | null | undefined)?.schemaVersion;
  return typeof version === 'number' && Number.isInteger(version) && version > SCHEMA_VERSION;
}
