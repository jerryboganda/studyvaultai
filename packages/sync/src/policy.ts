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
 * StudyVault's tables: the single source of truth for what is synchronised and how it merges. A
 * field named here that no schema has fails loudly (`checkPolicy`, SyncPolicyDriftError), and a
 * free-text field missing from `text` would merge last-writer-wins, so whoever adds a text field to
 * a schema adds it here (the storage cross-check lists every unclassified field).
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
  // Retention tables follow the schemas registered by @storage/study.ts (the cross-check in
  // packages/storage/src/sync.policy.test.ts fails when a name here stops existing there). Free text
  // and structured user data are `text` (a concurrent edit keeps both versions); `cards.tags` is a
  // set; the quote snapshot of a card is provenance.
  knowledgePoints: {
    text: ['shortOneLiner', 'examPearl', 'misconception', 'claims'],
    local: LOCAL,
  },
  decks: { text: ['name', 'settings'], local: LOCAL },
  cards: {
    immutable: ['sourceQuote'],
    text: ['front', 'back', 'explanation', 'choices', 'cloze'],
    sets: ['tags'],
    local: LOCAL,
  },
  reviewLogs: { appendOnly: true, local: LOCAL },
  documents: { text: ['title'], local: LOCAL },
  ocrPages: { immutable: ['documentId', 'pageNumber'], text: ['correctedText'], local: LOCAL },
  // Organisation records (schema v4, ADR-011). A rule's conditions and target and a syllabus tree are
  // structured user data: a concurrent edit keeps both versions. `enabled`, `order` and
  // `requireConfirm` are last-writer-wins scalars. A relation's five identity fields never change
  // (a different link is a different row), so a remote operation that would change one is refused.
  filingRules: { text: ['name', 'match', 'action'], local: LOCAL },
  syllabi: { text: ['name', 'nodes'], local: LOCAL },
  relations: {
    immutable: ['fromKind', 'fromId', 'toKind', 'toId', 'type'],
    text: ['note'],
    local: LOCAL,
  },
};
