import type {
  Bank,
  BankLite,
  CaptureInput,
  CaptureMethod,
  CaptureResult,
  ColorId,
  CustomFields,
  Folder,
  HighlightKind,
  HighlightPatch,
  HighlightView,
  Note,
  OcrPage,
  OcrWord,
  PdfDocument,
  PdfHighlightInput,
  Priority,
  ResolveStatus,
  SearchDocument,
  Source,
  Tag,
  UpsertDocumentInput,
} from '@shared';

/**
 * Public contract of @storage (DATA_MODEL.md). Everything is an exported async function from the
 * package index that satisfies `RepoApi` (Phase 1) or `VaultApi` (Phase 2). IDs are UUIDv7
 * generated here, never by callers.
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
  source: Pick<Source, 'id' | 'title' | 'host' | 'originalUrl' | 'canonicalUrl' | 'urlKey'> & {
    /** Absent on rows built by older callers; 'pdf' sources are opened in the PDF reader. */
    type?: Source['type'];
    documentId?: string;
  };
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

// ---------------------------------------------------------------------------------------------
// Phase 2 value types
// ---------------------------------------------------------------------------------------------

export type TagLite = Pick<Tag, 'id' | 'name' | 'color'>;
export interface TagWithCount {
  tag: Tag;
  /** Live highlights carrying the tag. */
  count: number;
}

export interface FolderRef {
  id: string;
  name: string;
}
/** Where a highlight is filed: a bank and the folder path inside it (outermost first). */
export interface Location {
  bank: BankLite;
  folderPath: FolderRef[];
}

/** A bank as the bank manager shows it. */
export interface BankInfo extends BankLite {
  icon: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface FolderNode {
  folder: Folder;
  /** 1 for a top-level folder of a bank. */
  depth: number;
  /** Live highlights filed directly in this folder. */
  count: number;
  /** `count` plus every descendant's (exact: a highlight has one folder per bank). */
  totalCount: number;
  children: FolderNode[];
}

/** A highlight with everything a dashboard row needs. */
export interface DashboardItem extends HighlightListItem {
  tags: TagLite[];
  locations: Location[];
  noteCount: number;
  customFields: CustomFields;
  createdAt: string;
  updatedAt: string;
}

export type HighlightSortField = 'capturedAt' | 'updatedAt' | 'priority';

export interface HighlightQuery {
  bankId?: string;
  /**
   * A folder id lists its whole subtree. `null` lists what sits directly in the bank root (needs
   * `bankId`). A folder id implies its bank.
   */
  folderId?: string | null;
  tagIds?: string[];
  /** 'any' (default): at least one of tagIds. 'all': every one of them. */
  tagMode?: 'any' | 'all';
  kinds?: HighlightKind[];
  priorities?: number[];
  resolveStatuses?: ResolveStatus[];
  sourceId?: string;
  /** true: has a live note; false: has none. */
  hasNote?: boolean;
  dateRange?: { field?: 'capturedAt' | 'updatedAt'; from?: string; to?: string };
  /** Default newest capture first. */
  sort?: { by: HighlightSortField; dir?: 'asc' | 'desc' };
  /** Opaque: pass back `nextCursor` of the previous page. */
  cursor?: string | null;
  /** 1..500, default 50. */
  limit?: number;
}

export interface HighlightPage {
  items: DashboardItem[];
  nextCursor: string | null;
}

export interface VaultCounts {
  total: number;
  /** Live highlights per live bank id. */
  banks: Record<string, number>;
  /** Live highlights filed directly in a folder (add children for a subtree: see FolderNode). */
  folders: Record<string, number>;
  tags: Record<string, number>;
  kinds: Record<string, number>;
  priorities: Record<string, number>;
  resolveStatuses: Record<string, number>;
}

export interface DuplicateMember {
  highlightId: string;
  sourceId: string;
  sourceTitle: string;
  host: string;
  originalUrl: string;
  sourceType: Source['type'];
  bankIds: string[];
  capturedAt: string;
  /** PDF page, when the member is a PDF highlight. */
  pageNumber: number | null;
  /** The `documents` row of a PDF member (open it in the reader at `pageNumber`); absent for web. */
  documentId?: string;
}
export interface DuplicateCluster {
  quoteHash: string;
  quote: string;
  members: DuplicateMember[];
  /** Distinct sources among the members. */
  sourceCount: number;
}

export interface HighlightDetail extends DashboardItem {
  notes: Note[];
  /** Other live highlights with the same quote (never merged automatically). */
  duplicates: DuplicateMember[];
  deletedAt: string | null;
  capturedUrl: string | null;
  capturedTitle: string | null;
  captureMethod: CaptureMethod;
}

export interface BulkResult {
  requested: number;
  /** Highlights whose stored state actually changed. */
  changed: number;
}

export type TrashKind = 'highlight' | 'note' | 'folder' | 'bank' | 'tag' | 'document';
export interface TrashRef {
  kind: TrashKind;
  id: string;
}
export interface TrashItem extends TrashRef {
  /** Short human text: quote, name or title. */
  label: string;
  /** Where it was: source title, bank name, ... */
  context: string;
  deletedAt: string;
}
export interface PurgeResult {
  purged: Record<TrashKind, number>;
  /** Rows removed together with them. */
  related: {
    memberships: number;
    tagLinks: number;
    notes: number;
    sources: number;
    folders: number;
    knowledgePoints: number;
    cards: number;
    reviewLogs: number;
    aiResults: number;
    attachments: number;
    ocrPages: number;
  };
}

export interface DocumentListItem {
  document: PdfDocument;
  highlightCount: number;
  /** Bytes of the user-approved cached copy; null when none is cached. */
  cachedBytes: number | null;
}

export interface CachedDocumentInfo {
  attachmentId: string;
  documentId: string;
  byteLength: number;
  sha256: string;
  /** True when the document id equals the sha-256 of the bytes (id is a content hash). */
  matchesDocumentId: boolean;
}

export interface SaveOcrPageInput {
  documentId: string;
  pageNumber: number;
  text: string;
  words?: OcrWord[];
  language: string;
  engine: string;
  confidence?: number | null;
  /** The user's correction. Omitted: an existing correction is kept; null: cleared. */
  correctedText?: string | null;
}

export interface StorageUsage {
  /** Row count of every table. */
  rows: Record<string, number>;
  totalRows: number;
  cachedPdfBytes: number;
  cachedPdfCount: number;
  /** navigator.storage.estimate() when the platform has it. */
  estimate: { usage: number | null; quota: number | null } | null;
}

export interface VaultApi {
  // hierarchy
  createFolder(input: {
    bankId: string;
    name: string;
    parentFolderId?: string | null;
  }): Promise<Folder>;
  renameFolder(id: string, name: string): Promise<Folder>;
  moveFolder(input: {
    id: string;
    parentFolderId: string | null;
    bankId?: string;
    index?: number;
  }): Promise<Folder>;
  reorderFolders(input: {
    bankId: string;
    parentFolderId: string | null;
    orderedIds: string[];
  }): Promise<Folder[]>;
  deleteFolder(id: string): Promise<{ rehomedFolders: number; rehomedHighlights: number }>;
  mergeFolders(input: {
    sourceId: string;
    targetId: string;
  }): Promise<{ movedFolders: number; movedHighlights: number }>;
  listFolderTree(bankId: string): Promise<FolderNode[]>;
  listBankInfos(): Promise<BankInfo[]>;
  renameBank(id: string, name: string): Promise<BankInfo>;
  reorderBanks(orderedIds: string[]): Promise<BankInfo[]>;
  mergeBanks(input: {
    sourceId: string;
    targetId: string;
  }): Promise<{ movedFolders: number; movedHighlights: number }>;
  deleteBank(id: string): Promise<{ rehomedHighlights: number }>;
  setBankColor(id: string, color: ColorId): Promise<BankInfo>;
  setBankIcon(id: string, icon: string | null): Promise<BankInfo>;

  // membership
  addToBank(input: {
    highlightId: string;
    bankId: string;
    folderId?: string | null;
  }): Promise<{ added: boolean; changed: boolean }>;
  removeFromBank(input: {
    highlightId: string;
    bankId: string;
  }): Promise<{ removed: boolean; rehomedToInbox: boolean }>;
  moveHighlight(input: {
    highlightId: string;
    fromBankId: string;
    toBankId: string;
    folderId?: string | null;
  }): Promise<{ changed: boolean }>;

  // tags
  createTag(
    name: string,
    options?: { color?: ColorId | null },
  ): Promise<{ tag: Tag; created: boolean }>;
  renameTag(id: string, name: string): Promise<Tag>;
  setTagColor(id: string, color: ColorId | null): Promise<Tag>;
  addAlias(id: string, alias: string): Promise<Tag>;
  removeAlias(id: string, alias: string): Promise<Tag>;
  mergeTags(input: { sourceId: string; targetId: string }): Promise<{ relinked: number }>;
  deleteTag(id: string): Promise<void>;
  attachTags(input: { highlightIds: string[]; tagIds: string[] }): Promise<{ linked: number }>;
  detachTags(input: { highlightIds: string[]; tagIds: string[] }): Promise<{ unlinked: number }>;
  listTags(): Promise<TagWithCount[]>;

  // notes
  createNote(input: {
    highlightId?: string | null;
    sourceId?: string | null;
    title?: string;
    body: string;
    pinned?: boolean;
  }): Promise<Note>;
  updateNote(id: string, patch: { title?: string; body?: string; pinned?: boolean }): Promise<Note>;
  deleteNote(id: string): Promise<void>;
  listNotes(query?: {
    highlightId?: string;
    sourceId?: string;
    pinned?: boolean;
    limit?: number;
  }): Promise<Note[]>;

  // custom fields
  setCustomFields(highlightId: string, fields: CustomFields): Promise<CustomFields>;
  clearCustomField(highlightId: string, key: string): Promise<CustomFields>;

  // bulk
  bulkMove(input: {
    highlightIds: string[];
    toBankId: string;
    folderId?: string | null;
    fromBankId?: string;
  }): Promise<BulkResult>;
  bulkTag(input: {
    highlightIds: string[];
    addTagIds?: string[];
    removeTagIds?: string[];
  }): Promise<BulkResult>;
  bulkDelete(highlightIds: string[]): Promise<BulkResult>;
  bulkRestore(highlightIds: string[]): Promise<BulkResult>;
  bulkSetKind(highlightIds: string[], kind: HighlightKind): Promise<BulkResult>;
  bulkSetColor(highlightIds: string[], color: ColorId): Promise<BulkResult>;
  bulkSetPriority(highlightIds: string[], priority: Priority): Promise<BulkResult>;

  // trash
  listTrash(options?: { kinds?: TrashKind[]; limit?: number }): Promise<TrashItem[]>;
  restore(refs: Array<string | TrashRef>): Promise<{ restored: number }>;
  purge(refs: Array<string | TrashRef>): Promise<PurgeResult>;
  emptyTrash(kinds?: TrashKind[]): Promise<PurgeResult>;
  purgeOlderThan(days: number, options?: { kinds?: TrashKind[]; now?: Date }): Promise<PurgeResult>;

  // duplicates, queries
  findDuplicateClusters(options?: { limit?: number }): Promise<DuplicateCluster[]>;
  listHighlights(query?: HighlightQuery): Promise<HighlightPage>;
  countHighlights(query?: Omit<HighlightQuery, 'cursor' | 'limit' | 'sort'>): Promise<number>;
  getCounts(): Promise<VaultCounts>;
  getHighlightDetail(id: string, options?: { includeDeleted?: boolean }): Promise<HighlightDetail>;

  // search feed
  listSearchDocuments(options?: { afterId?: string; limit?: number }): Promise<SearchDocument[]>;
  listSearchDocumentsChangedSince(options: {
    since: string;
    afterId?: string;
    limit?: number;
  }): Promise<SearchDocument[]>;
  getLastPurgeAt(): Promise<string | null>;

  // PDF store
  upsertDocument(input: UpsertDocumentInput): Promise<PdfDocument>;
  getDocument(id: string): Promise<PdfDocument | null>;
  listDocuments(): Promise<DocumentListItem[]>;
  deleteDocument(id: string): Promise<void>;
  savePdfHighlight(input: PdfHighlightInput): Promise<CaptureResult>;
  listPdfHighlights(documentId: string): Promise<HighlightView[]>;
  cacheDocumentBytes(documentId: string, blob: Blob): Promise<CachedDocumentInfo>;
  getDocumentBytes(documentId: string): Promise<Blob | null>;
  removeDocumentBytes(documentId: string): Promise<boolean>;
  saveOcrPage(input: SaveOcrPageInput): Promise<OcrPage>;
  getOcrPages(documentId: string): Promise<OcrPage[]>;
  clearOcr(documentId: string, pageNumbers?: number[]): Promise<number>;

  // data management
  getStorageUsage(): Promise<StorageUsage>;
}
