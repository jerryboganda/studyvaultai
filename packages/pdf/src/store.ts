import type {
  BankLite,
  CaptureMethod,
  CaptureResult,
  ColorId,
  FilingOutcome,
  HighlightKind,
  HighlightPatch,
  HighlightView,
  PdfAnchorSet,
  PdfRect,
  Priority,
} from '@shared';
import type { TextStatus } from './textStatus';

/**
 * Persistence port of the PDF reader. `@pdf` has no Dexie/Chrome dependency: the entrypoint adapts
 * the `@storage` functions of the vault task (same names and shapes) and tests use an in-memory store.
 */
export interface PdfDocumentInput {
  /** Content fingerprint (see fingerprint.ts); this is also the document id. */
  id: string;
  title: string;
  pageCount: number;
  byteLength: number;
  /** The https address the file was fetched from; null for local files. */
  originalUrl: string | null;
  textStatus: TextStatus;
}

export interface PdfDocumentRecord extends Omit<PdfDocumentInput, 'textStatus'> {
  textStatus: TextStatus | 'unknown';
  createdAt?: string;
  updatedAt?: string;
}

export interface SavePdfHighlightInput {
  documentId: string;
  anchorSet: PdfAnchorSet;
  exactQuote: string;
  kind: HighlightKind;
  color: ColorId;
  bankId: string | null;
  folderId?: string | null;
  userComment: string;
  priority: Priority;
  headingContext?: string | null;
  captureMethod: CaptureMethod;
}

export interface OcrStoredWord extends PdfRect {
  text: string;
  confidence: number;
}

export interface SaveOcrPageInput {
  documentId: string;
  pageNumber: number;
  text: string;
  words: OcrStoredWord[];
  language: string;
  engine: string;
  confidence: number | null;
  /**
   * The person's line-by-line corrections of the page, one line per recognised line joined by a line feed.
   * Omitted: an existing correction is kept; null: cleared. The recognised text is never edited.
   */
  correctedText?: string | null;
}

export interface StoredOcrPage {
  pageNumber: number;
  text: string;
  correctedText: string | null;
  words: OcrStoredWord[];
}

/** A document whose bytes StudyVault keeps (user-approved), for the stored-copy manager. */
export interface StoredCopy {
  documentId: string;
  title: string;
  pageCount: number;
  /** Size of the kept copy. */
  byteLength: number;
  originalUrl: string | null;
}

/**
 * What the reader may do with a filing rule's result (docs/adr/017-filing-rules.md). The result
 * itself comes back on `savePdfHighlight`'s CaptureResult (`filing`); these act on it later.
 */
export interface PdfFilingPort {
  accept(highlightId: string): Promise<FilingOutcome>;
  dismiss(highlightId: string): Promise<void>;
  undo(highlightId: string): Promise<{ restored: boolean; reason: string | null }>;
}

export interface PdfStore {
  upsertDocument(input: PdfDocumentInput): Promise<PdfDocumentRecord>;
  getDocument(id: string): Promise<PdfDocumentRecord | null>;
  savePdfHighlight(input: SavePdfHighlightInput): Promise<CaptureResult>;
  listPdfHighlights(documentId: string): Promise<HighlightView[]>;
  updateHighlight(id: string, patch: HighlightPatch): Promise<HighlightView>;
  /** Soft delete. */
  deleteHighlight(id: string): Promise<void>;
  /** Undo of deleteHighlight. Absent -> the reader cannot offer "Undo" for deletions. */
  restoreHighlight?(id: string): Promise<HighlightView>;
  /** Optional, user-approved copy of the PDF bytes. The reader offers it only when all three exist. */
  cacheDocumentBytes?(documentId: string, blob: Blob): Promise<{ byteLength: number }>;
  getDocumentBytes?(documentId: string): Promise<Blob | null>;
  removeDocumentBytes?(documentId: string): Promise<boolean>;
  /** Every document with a kept copy, newest first. Absent: the reader shows no manager. */
  listStoredCopies?(): Promise<StoredCopy[]>;
  /** Recognised text of scanned pages (see ocr.ts). Present only when OCR results can be kept. */
  saveOcrPage?(input: SaveOcrPageInput): Promise<unknown>;
  getOcrPages?(documentId: string): Promise<StoredOcrPage[]>;
  listBanks(): Promise<BankLite[]>;
  createBank(name: string): Promise<BankLite>;
  /** Absent: the reader never mentions filing rules. */
  filing?: PdfFilingPort;
}
