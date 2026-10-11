import { BackupError } from './errors';
import type { MigrationStep, Row } from './types';

/**
 * The steps that take an archive written at `fromVersion` to `toVersion` (the registry's current
 * version), in order. A gap is an error: a restore never guesses how to upgrade rows.
 */
export function buildMigrationChain(
  fromVersion: number,
  toVersion: number,
  steps: readonly MigrationStep[],
): MigrationStep[] {
  const byFrom = new Map<number, MigrationStep>();
  for (const s of steps) {
    if (!Number.isInteger(s.from) || s.from < 1 || byFrom.has(s.from)) {
      throw new BackupError(
        'invalid_options',
        `Invalid or duplicate migration step from ${s.from}.`,
      );
    }
    byFrom.set(s.from, s);
  }
  const chain: MigrationStep[] = [];
  for (let v = fromVersion; v < toVersion; v++) {
    const step = byFrom.get(v);
    if (!step) {
      throw new BackupError(
        'migration_missing',
        `This backup was made by schema version ${fromVersion} and there is no migration from version ${v} to ${v + 1}.`,
        { fromVersion, toVersion, missingFrom: v },
      );
    }
    chain.push(step);
  }
  return chain;
}

/** Run one row through the chain. null = dropped by a step. Steps that throw surface as the error. */
export function migrateRow(table: string, row: Row, chain: readonly MigrationStep[]): Row | null {
  let current: Row = row;
  for (const step of chain) {
    const fn = step.tables?.[table];
    if (!fn) continue;
    const next = fn(current);
    if (next === null) return null;
    if (typeof next !== 'object' || Array.isArray(next)) {
      throw new TypeError(`migration from ${step.from} returned a non-object for "${table}"`);
    }
    current = next;
  }
  return current;
}
