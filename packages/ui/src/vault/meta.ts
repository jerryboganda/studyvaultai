/** Key/value rows a surface keeps in the `meta` table next to the vault (derived data, per-user lists). */
export interface MetaPort {
  get(key: string): Promise<unknown | undefined>;
  put(key: string, value: unknown): Promise<void>;
  /** All entries in one transaction: a cache and its bookkeeping must never be half written. */
  putMany?(entries: Array<{ key: string; value: unknown }>): Promise<void>;
  /** Remove a row. Without it a caller overwrites the value with null, which readers treat as absent. */
  delete?(key: string): Promise<void>;
}
