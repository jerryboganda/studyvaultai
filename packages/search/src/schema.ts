import { z } from 'zod';

// Parsers are interpreted, never compiled: Zod's `new Function` probe is a CSP violation in
// extension pages (same switch as @shared/zodConfig; set again here so this pure package stands alone).
z.config({ jitless: true });

/**
 * A note attached to no highlight has no kind, priority or status: the vault sends null and the
 * index holds '' and 0. They match no `kind:` or `status:` filter and are not counted in those
 * facets; priority 0 sorts last under `sort: 'priority'` and satisfies only `priority:<n` filters.
 */
const kindOrEmpty = z
  .string()
  .nullable()
  .transform((v) => v ?? '');
const priorityOrZero = z
  .number()
  .nullable()
  .transform((v) => v ?? 0);

/**
 * One searchable unit. The vault (`listSearchDocuments` in @storage) produces these; this package only
 * consumes them. A `highlight` document carries the immutable quote plus the user's inline comment; a
 * `note` document is a user-authored note attached to `highlightId` (or free-standing when null).
 */
export const SearchDocumentSchema = z.object({
  id: z.string().min(1),
  docType: z.enum(['highlight', 'note']),
  highlightId: z.string().nullable(),
  title: z.string(),
  url: z.string().nullable(),
  host: z.string().nullable(),
  quote: z.string(),
  comment: z.string(),
  headingContext: z.string().nullable(),
  tags: z.array(z.string()),
  banks: z.array(z.string()),
  folderPath: z.array(z.string()),
  kind: kindOrEmpty,
  priority: priorityOrZero,
  resolveStatus: kindOrEmpty,
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
});
export type SearchDocument = z.infer<typeof SearchDocumentSchema>;

/** Indexed fields in MiniSearch field-id order. Changing this list changes the persisted format. */
export const SEARCH_FIELDS = [
  'quote',
  'comment',
  'tags',
  'title',
  'headingContext',
  'banks',
  'folderPath',
  'host',
] as const;
export type SearchField = (typeof SEARCH_FIELDS)[number];

/** Relative field weights (BM25 contribution multiplier). Exact > prefix > fuzzy is applied on top. */
export const FIELD_WEIGHTS: Readonly<Record<SearchField, number>> = {
  quote: 3,
  comment: 2,
  tags: 2,
  title: 1.5,
  headingContext: 1,
  banks: 1,
  folderPath: 1,
  host: 0.5,
};
