/**
 * Saved searches ("saved filters"): a name plus a query string in the grammar of `parseQuery`, optionally
 * with a sort mode. They are plain data, so the vault can store them in any table; these helpers only
 * validate and (de)serialise. Loading is tolerant: invalid entries are reported and skipped, never fatal.
 */
import { z } from 'zod';
import { MAX_QUERY_LENGTH, parseQuery } from './query';
import type { QueryWarning } from './query';
import './schema'; // applies the jitless Zod config before any schema below is built

export const SavedSearchSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(120),
  query: z.string().max(MAX_QUERY_LENGTH),
  sort: z.enum(['relevance', 'updated', 'priority']).optional(),
  createdAt: z.string().min(1),
});
export type SavedSearch = z.infer<typeof SavedSearchSchema>;

const FORMAT = 'studyvault-saved-searches';

export type SavedSearchResult =
  { ok: true; search: SavedSearch; warnings: QueryWarning[] } | { ok: false; error: string };

export interface NewSavedSearch {
  name: string;
  query: string;
  sort?: SavedSearch['sort'];
  /** Supply for deterministic ids/tests; defaults to `crypto.randomUUID()`. */
  id?: string;
  now?: Date;
}

/** Validate and normalise (trim name) a new saved search. Query warnings are returned, not fatal. */
export function createSavedSearch(input: NewSavedSearch): SavedSearchResult {
  const id = input.id ?? globalThis.crypto?.randomUUID?.();
  if (!id) return { ok: false, error: 'No id available: pass `id` in this environment.' };
  const parsed = SavedSearchSchema.safeParse({
    id,
    name: input.name,
    query: input.query,
    ...(input.sort ? { sort: input.sort } : {}),
    createdAt: (input.now ?? new Date()).toISOString(),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid saved search.' };
  }
  const query = parseQuery(parsed.data.query);
  if (query.root === null) return { ok: false, error: 'The query is empty.' };
  return { ok: true, search: parsed.data, warnings: query.warnings };
}

/** Validate an untrusted value (e.g. from storage or an import). */
export function parseSavedSearch(value: unknown): SavedSearchResult {
  const parsed = SavedSearchSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid saved search.' };
  }
  return { ok: true, search: parsed.data, warnings: parseQuery(parsed.data.query).warnings };
}

export function serializeSavedSearches(items: readonly SavedSearch[]): string {
  return JSON.stringify({ format: FORMAT, version: 1, items });
}

export interface LoadedSavedSearches {
  items: SavedSearch[];
  /** Entries that failed validation or repeated an id (first one wins). */
  rejected: number;
  /** Set when the whole payload was unusable. */
  error?: string;
}

export function deserializeSavedSearches(input: unknown): LoadedSavedSearches {
  let data: unknown = input;
  try {
    if (typeof input === 'string') data = JSON.parse(input);
  } catch {
    return { items: [], rejected: 0, error: 'Not valid JSON.' };
  }
  const env = z
    .object({ format: z.literal(FORMAT), version: z.literal(1), items: z.array(z.unknown()) })
    .safeParse(data);
  if (!env.success) return { items: [], rejected: 0, error: 'Not a saved-searches file.' };
  const items: SavedSearch[] = [];
  const ids = new Set<string>();
  let rejected = 0;
  for (const raw of env.data.items) {
    const r = SavedSearchSchema.safeParse(raw);
    if (!r.success || ids.has(r.data.id)) {
      rejected++;
      continue;
    }
    ids.add(r.data.id);
    items.push(r.data);
  }
  return { items, rejected };
}
