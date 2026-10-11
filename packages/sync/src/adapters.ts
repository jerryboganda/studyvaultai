import type { TableRegistry, TableSpec } from '@shared';
import type { LocalChange } from './engine.ts';
import type { Row } from './merge.ts';
import type { EntityPolicy, SyncPolicy } from './policy.ts';
import { isJsonValue } from './json.ts';

/**
 * Pure adapters between the table registry contract (packages/shared/src/registry.ts) and the sync
 * engine. They import no storage: a host passes rows in and gets rows out.
 */

const escapePart = (p: string) => p.replaceAll('\\', '\\\\').replaceAll('|', '\\|');

/** Entity id of a row: the primary key, with compound keys joined by an escaped `|`. */
export function encodeEntityId(
  primaryKey: string | readonly string[],
  row: Record<string, unknown>,
): string {
  const keys = typeof primaryKey === 'string' ? [primaryKey] : primaryKey;
  return keys
    .map((k) => {
      const v = row[k];
      if (typeof v !== 'string' && typeof v !== 'number') {
        throw new Error(`Primary key field ${k} is missing or not a string/number`);
      }
      return escapePart(String(v));
    })
    .join('|');
}

/** Inverse of encodeEntityId: the key fields as strings, or null when the shape does not fit. */
export function decodeEntityId(
  primaryKey: string | readonly string[],
  entityId: string,
): Record<string, string> | null {
  const keys = typeof primaryKey === 'string' ? [primaryKey] : primaryKey;
  const parts: string[] = [];
  let current = '';
  for (let i = 0; i < entityId.length; i++) {
    const c = entityId[i]!;
    if (c === '\\') {
      current += entityId[++i] ?? '';
    } else if (c === '|') {
      parts.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  parts.push(current);
  if (parts.length !== keys.length) return null;
  return Object.fromEntries(keys.map((k, i) => [k, parts[i]!]));
}

function shapeOf(spec: TableSpec): string[] | null {
  const shape = (spec.schema as unknown as { shape?: Record<string, unknown> }).shape;
  return shape && typeof shape === 'object' ? Object.keys(shape) : null;
}

/** Tables that take part in sync: registered, not local-only, and with a conflict policy. */
export function syncableTables(registry: TableRegistry, policy: SyncPolicy): TableSpec[] {
  return registry.tables.filter((t) => !t.localOnly && Object.hasOwn(policy, t.name));
}

/**
 * Specialise a base policy to the registry: derived fields become device-local, and the table's own
 * schema becomes the field allow-list, so a newer build's extra fields are quarantined, not guessed.
 */
export function policyFromRegistry(registry: TableRegistry, base: SyncPolicy): SyncPolicy {
  const out: Record<string, EntityPolicy> = {};
  for (const spec of syncableTables(registry, base)) {
    const p = base[spec.name]!;
    out[spec.name] = {
      ...p,
      local: [...new Set([...(p.local ?? []), ...(spec.derivedFields ?? [])])],
      fields: shapeOf(spec) ?? p.fields,
    };
  }
  return out;
}

/** Problems that make a policy unsafe for a registry (a text field that does not exist loses edits). */
export function checkPolicy(registry: TableRegistry, policy: SyncPolicy): string[] {
  const issues: string[] = [];
  for (const [table, p] of Object.entries(policy)) {
    const spec = registry.tables.find((t) => t.name === table);
    if (!spec) {
      issues.push(`policy names unknown table ${table}`);
      continue;
    }
    if (spec.localOnly) issues.push(`${table} is local-only but has a sync policy`);
    const known = shapeOf(spec);
    if (!known) continue;
    for (const [kind, names] of [
      ['immutable', p.immutable],
      ['text', p.text],
      ['sets', p.sets],
      ['local', p.local],
    ] as const) {
      for (const f of names ?? []) {
        if (!known.includes(f))
          issues.push(`${table}.${f} (${kind}) is not a field of the table schema`);
      }
    }
  }
  return issues;
}

export interface SerializedRow {
  entityType: string;
  entityId: string;
  fields: Row;
}

/** JSON snapshot of a row for an upload or a conflict record. Throws on non-JSON data (Blobs). */
export function serializeRow(spec: TableSpec, row: Record<string, unknown>): SerializedRow {
  const fields: Row = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === undefined || (spec.derivedFields ?? []).includes(k)) continue;
    if (!isJsonValue(v)) throw new Error(`${spec.name}.${k} is not plain JSON`);
    fields[k] = v;
  }
  return { entityType: spec.name, entityId: encodeEntityId(spec.primaryKey, row), fields };
}

/** Validate a received snapshot with the table's own schema. `defaults` supplies device-local fields. */
export function deserializeSnapshot(
  spec: TableSpec,
  fields: Row,
  defaults: Record<string, unknown> = {},
): { ok: true; row: Record<string, unknown> } | { ok: false; error: string } {
  const parsed = spec.schema.safeParse({ ...defaults, ...fields });
  if (parsed.success) return { ok: true, row: parsed.data as Record<string, unknown> };
  return {
    ok: false,
    error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
  };
}

/** Initial upload / re-upload: one create per row of a syncable table. */
export function backfillChanges(
  registry: TableRegistry,
  policy: SyncPolicy,
  tableName: string,
  rows: Iterable<Record<string, unknown>>,
): LocalChange[] {
  const spec = syncableTables(registry, policy).find((t) => t.name === tableName);
  if (!spec) return [];
  const out: LocalChange[] = [];
  for (const row of rows) {
    out.push({
      kind: 'upsert',
      entityType: spec.name,
      entityId: encodeEntityId(spec.primaryKey, row),
      before: null,
      after: row,
    });
  }
  return out;
}
