import type {
  Bank,
  CaptureInput,
  CaptureResult,
  HighlightPatch,
  HighlightView,
  ResolveStatus,
  BankLite,
  Source,
} from '@shared';

/**
 * Public contract of @storage (DATA_MODEL.md). Everything is an exported async function from the
 * package index that satisfies `RepoApi`. IDs are UUIDv7 generated here, never by callers.
 *
 * Rules every function must keep:
 *  - Multi-row writes run in ONE Dexie transaction; a failure leaves no partial rows.
 *  - Reads exclude soft-deleted rows unless stated.
 *  - After a successful data mutation (create/update/delete/restore/bank), `bumpDataEpoch()` (from
 *    @runtime) is called (errors swallowed). Persisting resolver outcomes bumps only
 *    `bumpResolutionEpoch()`.
 *  - Writes are refused with `storage_unavailable` while any stored row has a schemaVersion newer
 *    than this build knows; reads accept every schemaVersion >= 1. A row that fails validation is
 *    skipped on reads and never overwritten by a write.
 *  - Failures surface as `StudyVaultError` with a precise code, never silent no-ops.
 */

/** A saved highlight joined with what list UIs need. */
export interface HighlightListItem {
  highlight: HighlightView;
  source: Pick<Source, 'id' | 'title' | 'host' | 'originalUrl' | 'canonicalUrl' | 'urlKey'>;
  banks: BankLite[];
}

export interface BankWithCount {
  bank: BankLite;
  /** Non-deleted highlights filed in this bank. */
  count: number;
}

export interface RepoApi {
  /**
   * Upsert the Source (by urlKey, then visitedKey; a page-declared canonical is only the urlKey
   * when it is the page itself, see `trustedCanonical`), then:
   *  - same source + same quoteHash + the same place (overlapping positions when the document
   *    text is the same version, otherwise equal text just before or after) already live
   *    -> status 'duplicate': add bank membership if missing (addedToBank), change nothing else;
   *  - such a highlight exists but is soft-deleted -> 'restored' (undelete, add membership);
   *  - otherwise create (status 'created').
   * `input.bankId === null` or an unknown/deleted bank id falls back to the Inbox (created on demand).
   * Computes normalizedQuote + quoteHash (SHA-256 hex of normalizedQuote) and records the
   * redacted visited address and title on the highlight (`capturedUrl`, `capturedTitle`).
   */
  saveCapture(input: CaptureInput): Promise<CaptureResult>;

  /** Live highlights for a page, looked up by normalised urlKey OR visitedKey. */
  getPageHighlights(
    url: string,
    canonicalUrl: string | null,
  ): Promise<{ sourceId: string | null; highlights: HighlightView[] }>;

  /** Throws not_found for missing or deleted ids. exactQuote/anchorSet are never patchable. */
  updateHighlight(id: string, patch: HighlightPatch): Promise<HighlightView>;
  /** Soft delete (sets deletedAt). Idempotent. */
  softDeleteHighlight(id: string): Promise<void>;
  /** Clears deletedAt. Throws not_found for unknown ids. */
  restoreHighlight(id: string): Promise<HighlightView>;
  /** Persist resolver outcomes; unknown ids are skipped. Returns the number of rows updated. */
  reportResolutions(
    items: Array<{ id: string; status: ResolveStatus; confidence: number | null }>,
  ): Promise<number>;

  /**
   * Which page identity a highlight belongs to, for sender validation. null if unknown, or deleted
   * unless `includeDeleted` (a soft-deleted highlight still belongs to its page: Undo needs that).
   */
  getHighlightSource(
    id: string,
    options?: { includeDeleted?: boolean },
  ): Promise<{ sourceId: string; urlKey: string; visitedKey: string } | null>;

  /** Ensures the Inbox exists (fixed id INBOX_BANK_ID). Ordered by position then createdAt. */
  listBanks(): Promise<BankLite[]>;
  createBank(name: string): Promise<BankLite>;

  /** Newest first by capturedAt. */
  listRecentHighlights(limit: number): Promise<HighlightListItem[]>;
  /** All live highlights of a page (joined), for the side panel. Same lookup as getPageHighlights. */
  listPageHighlights(url: string, canonicalUrl: string | null): Promise<HighlightListItem[]>;
  listBanksWithCounts(): Promise<BankWithCount[]>;

  /**
   * "Delete all StudyVault data": deletes the database (recreated empty on next use), clears
   * chrome.storage.local (settings, change epochs) and chrome.storage.session (pending focus), and
   * revokes the optional host permissions, then notifies other contexts. The caller re-syncs the
   * persistent content script afterwards (`site.sync`). Not refused by data from a newer build:
   * this is the way out of it. Rejects with storage_unavailable when another window keeps the
   * database open.
   */
  wipeAllData(): Promise<void>;
}

export type { Bank };
