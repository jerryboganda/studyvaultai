/**
 * Conflict policy per entity type. Everything not listed is a scalar and merges field by field,
 * last-writer-wins by hybrid logical clock.
 *
 *  - `immutable`  provenance (exactQuote, anchorSet, quoteHash...). Set once. A remote operation that
 *                 would change an existing value is rejected whole and reported; a local change that
 *                 would is a programming error and throws.
 *  - `text`       free text and structured user data (userComment, note body...). When both sides
 *                 changed it without seeing the other, the newer wins the field and the other version
 *                 is kept in a ConflictRecord for the user. Nothing is silently lost.
 *  - `sets`       array-of-string fields (tag aliases...). Union; a removal beats a concurrent add; an
 *                 add that has seen the removal wins (the causality is carried in the operation).
 *  - `local`      device-local derived state (resolve status...). Never serialised, never accepted.
 *  - `appendOnly` every field is immutable after creation (review logs).
 *  - `fields`     optional allow-list. A remote field outside it is quarantined as `unknown_field`
 *                 (written by a newer build) instead of being applied half-understood.
 */
export interface EntityPolicy {
  immutable?: readonly string[];
  text?: readonly string[];
  sets?: readonly string[];
  local?: readonly string[];
  fields?: readonly string[];
  appendOnly?: boolean;
}

/** Keyed by entityType (the Dexie table name). A table absent from the policy is never synchronised. */
export type SyncPolicy = Readonly<Record<string, EntityPolicy>>;

export interface ResolvedPolicy {
  immutable: ReadonlySet<string>;
  text: ReadonlySet<string>;
  sets: ReadonlySet<string>;
  local: ReadonlySet<string>;
  fields: ReadonlySet<string> | null;
  appendOnly: boolean;
}

export function resolvePolicy(p: EntityPolicy): ResolvedPolicy {
  return {
    immutable: new Set(p.immutable),
    text: new Set(p.text),
    sets: new Set(p.sets),
    local: new Set(p.local),
    fields: p.fields ? new Set(p.fields) : null,
    appendOnly: p.appendOnly === true,
  };
}

const LOCAL = ['schemaVersion'] as const;

/**
 * StudyVault's tables (execution brief "Database plan"). Field names that belong to tables other
 * tasks own are best-effort: unknown names are harmless, but a free-text field missing from `text`
 * would merge last-writer-wins, so each table's owner must confirm its list (see the report).
 * `attachments`, `syncOps` and `meta` are local-only and deliberately absent. `aiResults` is absent
 * until its schema (evidence links, immutable output) is final.
 */
export const STUDYVAULT_SYNC_POLICY: SyncPolicy = {
  banks: { local: LOCAL },
  folders: { immutable: ['bankId'], local: LOCAL },
  tags: { sets: ['aliases'], local: LOCAL },
  sources: {
    immutable: ['type', 'urlKey', 'visitedKey', 'originalUrl', 'canonicalUrl', 'host'],
    local: LOCAL,
  },
  highlights: {
    immutable: [
      'sourceId',
      'exactQuote',
      'normalizedQuote',
      'quoteHash',
      'anchorSet',
      'headingContext',
      'captureMethod',
      'capturedAt',
      'capturedUrl',
      'capturedTitle',
    ],
    text: ['userComment', 'customFields'],
    local: [...LOCAL, 'resolveStatus', 'resolveConfidence', 'lastResolvedAt'],
  },
  highlightBanks: { immutable: ['highlightId', 'bankId'] },
  highlightTags: { immutable: ['highlightId', 'tagId'] },
  notes: { text: ['title', 'body'], local: LOCAL },
  knowledgePoints: {
    text: [
      'title',
      'body',
      'oneLiner',
      'shortOneLiner',
      'examPearl',
      'misconception',
      'explanation',
      'customFields',
    ],
    local: LOCAL,
  },
  decks: { text: ['name', 'description'], local: LOCAL },
  cards: { text: ['front', 'back', 'explanation'], local: LOCAL },
  reviewLogs: { appendOnly: true, local: LOCAL },
  documents: { text: ['title'], local: LOCAL },
  ocrPages: { immutable: ['documentId', 'pageNumber'], text: ['correctedText'], local: LOCAL },
};
