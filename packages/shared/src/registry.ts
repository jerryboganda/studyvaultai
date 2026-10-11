import type { z } from 'zod';

/**
 * Describes every persisted table so storage-agnostic code (backup/export/import, sync, integrity
 * checks) can walk the data model without importing Dexie. The vault task implements the registry in
 * @storage; each feature registers its own Zod schema.
 */
export interface TableSpec {
  /** Dexie table name, e.g. "highlights". */
  name: string;
  /** Primary key field(s): a field name, or several for a compound key. */
  primaryKey: string | readonly string[];
  /** Validates one row. Rows that fail are reported by integrity checks, never silently dropped. */
  schema: z.ZodType;
  /** true when rows carry `deletedAt` (soft delete) and `updatedAt` (merge ordering). */
  softDelete: boolean;
  /**
   * Foreign keys: `field` of this table must reference an existing row of `table`.
   * Used by import/restore integrity checks and orphan cleanup.
   */
  references?: readonly { field: string; table: string; nullable?: boolean }[];
  /** Fields recomputed by the app (resolve status, derived indexes): excluded from checksums. */
  derivedFields?: readonly string[];
  /** Tables that must never leave the device (e.g. cached PDF bytes unless the user opts in). */
  localOnly?: boolean;
}

export interface TableRegistry {
  /** Bumped together with the Dexie schema version. */
  schemaVersion: number;
  tables: readonly TableSpec[];
}
