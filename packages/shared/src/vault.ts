import './zodConfig';
import { z } from 'zod';
import {
  MAX_COMMENT_CHARS,
  MAX_HEADING_CHARS,
  MAX_QUOTE_CHARS,
  MAX_TITLE_CHARS,
  SCHEMA_VERSION,
} from './constants';
import {
  Bank,
  CaptureMethod,
  ColorId,
  HighlightKind,
  HttpUrl,
  Id,
  IsoDate,
  PdfAnchorSet,
  PdfRect,
  Priority,
  ResolveStatus,
} from './schema';

/**
 * Entities of the Phase 2 vault (knowledge manager + PDF store). The Dexie layout lives in
 * packages/storage; these are only the validated shapes. Same record envelope as schema.ts.
 */

/** Most levels of nested folders in one bank (the tree view caps its visual indent separately). */
export const MAX_FOLDER_DEPTH = 32;
export const MAX_FOLDER_NAME_CHARS = 80;
export const MAX_TAG_NAME_CHARS = 50;
export const MAX_TAG_ALIASES = 20;
export const MAX_NOTE_TITLE_CHARS = 200;
export const MAX_NOTE_BODY_CHARS = 100_000;
export const MAX_BANK_ICON_CHARS = 32;
export const MAX_OCR_WORDS = 20_000;
export const MAX_OCR_TEXT_CHARS = 200_000;

const recordMeta = {
  schemaVersion: z.literal(SCHEMA_VERSION),
  createdAt: IsoDate,
  updatedAt: IsoDate,
  deletedAt: IsoDate.nullable(),
};

/**
 * Bank row as stored by the vault: the v1 bank plus an optional icon. The icon is stored on the same
 * row (optional, so v1 readers simply ignore it).
 */
export const BankIcon = z.string().trim().min(1).max(MAX_BANK_ICON_CHARS);
export const BankRecord = Bank.extend({ icon: BankIcon.nullable().optional() });
export type BankRecord = z.infer<typeof BankRecord>;

/** One node of the Bank > Folder > Topic > Subtopic tree (ONE nested table, depth <= MAX_FOLDER_DEPTH). */
export const Folder = z.object({
  id: Id,
  ...recordMeta,
  bankId: Id,
  parentFolderId: Id.nullable(),
  name: z.string().trim().min(1).max(MAX_FOLDER_NAME_CHARS),
  position: z.number(),
});
export type Folder = z.infer<typeof Folder>;

/** Lower-cased, NFKC, whitespace-collapsed form used to compare tag names and aliases. */
export function tagNameKey(name: string): string {
  return name.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

const TagText = z.string().trim().min(1).max(MAX_TAG_NAME_CHARS);

export const Tag = z.object({
  id: Id,
  ...recordMeta,
  name: TagText,
  /**
   * `tagNameKey(name)`; unique among live tags (checked inside the writing transaction). NFKC can
   * expand one character into many (up to 18), so a 50-character name needs this much room.
   */
  nameKey: z
    .string()
    .min(1)
    .max(MAX_TAG_NAME_CHARS * 20),
  color: ColorId.nullable(),
  aliases: z.array(TagText).max(MAX_TAG_ALIASES),
});
export type Tag = z.infer<typeof Tag>;

/** Many-to-many link, keyed by [highlightId+tagId]. */
export const HighlightTag = z.object({
  highlightId: Id,
  tagId: Id,
  addedAt: IsoDate,
});
export type HighlightTag = z.infer<typeof HighlightTag>;

/**
 * User-authored note. `body` is Markdown source typed by the user; it is stored and searched as text
 * and must be rendered through a sanitising renderer. It never replaces a quote: the highlight's
 * exactQuote stays immutable and a note only points at it.
 */
export const Note = z.object({
  id: Id,
  ...recordMeta,
  highlightId: Id.nullable(),
  sourceId: Id.nullable(),
  title: z.string().max(MAX_NOTE_TITLE_CHARS),
  body: z.string().max(MAX_NOTE_BODY_CHARS),
  pinned: z.boolean(),
});
export type Note = z.infer<typeof Note>;

export const PDF_TEXT_STATUSES = ['text', 'scanned', 'partial', 'unknown'] as const;
export const PdfTextStatus = z.enum(PDF_TEXT_STATUSES);
export type PdfTextStatus = z.infer<typeof PdfTextStatus>;

/** An imported or opened PDF. `id` is the content fingerprint, so re-importing finds the same row. */
export const PdfDocument = z.object({
  id: Id,
  ...recordMeta,
  title: z.string().max(MAX_TITLE_CHARS),
  pageCount: z.number().int().min(0),
  byteLength: z.number().int().min(0),
  /** Address the file was fetched from (credentials removed); null for a local import. */
  originalUrl: HttpUrl.nullable(),
  textStatus: PdfTextStatus,
});
export type PdfDocument = z.infer<typeof PdfDocument>;

/** Structural check instead of `instanceof`: a Blob read back from IndexedDB may come from another realm. */
const BlobLike = z.custom<Blob>(
  (v) =>
    typeof v === 'object' &&
    v !== null &&
    typeof (v as Blob).size === 'number' &&
    typeof (v as Blob).type === 'string' &&
    typeof (v as Blob).arrayBuffer === 'function',
  'expected a Blob',
);

/** User-approved cached copy of a document's bytes. Local only: never exported unless the user asks. */
export const Attachment = z.object({
  id: Id,
  schemaVersion: z.literal(SCHEMA_VERSION),
  createdAt: IsoDate,
  documentId: Id,
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  mimeType: z.string().max(100),
  byteLength: z.number().int().min(0),
  blob: BlobLike,
});
export type Attachment = z.infer<typeof Attachment>;

export const OcrWord = PdfRect.extend({
  text: z.string().max(200),
  confidence: z.number().min(0).max(1),
});
export type OcrWord = z.infer<typeof OcrWord>;

/**
 * Extra clockwise turn, in degrees, the recogniser applied to a scanned page that is stored sideways
 * or upside down. Informational: the words' boxes are already in the page's own frame.
 */
export const OcrOrientation = z.union([
  z.literal(0),
  z.literal(90),
  z.literal(180),
  z.literal(270),
]);
export type OcrOrientation = z.infer<typeof OcrOrientation>;

/** Recognised text of one page, keyed by [documentId+pageNumber]. `correctedText` is the user's fix. */
export const OcrPage = z.object({
  documentId: Id,
  pageNumber: z.number().int().min(1),
  schemaVersion: z.literal(SCHEMA_VERSION),
  createdAt: IsoDate,
  updatedAt: IsoDate,
  text: z.string().max(MAX_OCR_TEXT_CHARS),
  correctedText: z.string().max(MAX_OCR_TEXT_CHARS).nullable(),
  words: z.array(OcrWord).max(MAX_OCR_WORDS),
  language: z.string().max(32),
  engine: z.string().max(64),
  confidence: z.number().min(0).max(1).nullable(),
  /** Absent on pages recognised before orientation checks: read as 0 (the page as it is shown). */
  orientation: OcrOrientation.optional(),
});
export type OcrPage = z.infer<typeof OcrPage>;

/**
 * What the search package indexes: one plain object per highlight and per note. Derived data, never
 * authoritative (rebuilt from the tables). `deletedAt` non-null means "remove from the index".
 *  - highlight docs: quote = exactQuote, comment = userComment
 *  - note docs: quote = the linked highlight's quote ('' when standalone), comment = title + body
 *  - tags: names and aliases of live tags; banks: names of live banks;
 *    folderPath: names of every folder on every membership path (deduplicated)
 *  - kind / priority / resolveStatus are the linked highlight's; null for a standalone note
 */
export const SearchDocument = z.object({
  id: Id,
  docType: z.enum(['highlight', 'note']),
  highlightId: Id.nullable(),
  title: z.string(),
  url: z.string(),
  host: z.string(),
  quote: z.string(),
  comment: z.string(),
  headingContext: z.string().nullable(),
  tags: z.array(z.string()),
  banks: z.array(z.string()),
  folderPath: z.array(z.string()),
  kind: HighlightKind.nullable(),
  priority: Priority.nullable(),
  resolveStatus: ResolveStatus.nullable(),
  updatedAt: IsoDate,
  deletedAt: IsoDate.nullable(),
});
export type SearchDocument = z.infer<typeof SearchDocument>;

/** Input of `upsertDocument` (the PDF reader's side of the contract). */
export const UpsertDocumentInput = z.object({
  id: Id,
  title: z.string().max(MAX_TITLE_CHARS),
  pageCount: z.number().int().min(0),
  byteLength: z.number().int().min(0),
  originalUrl: z.string().max(2048).nullable(),
  textStatus: PdfTextStatus,
});
export type UpsertDocumentInput = z.infer<typeof UpsertDocumentInput>;

/** Input of `savePdfHighlight`. */
export const PdfHighlightInput = z.object({
  documentId: Id,
  anchorSet: PdfAnchorSet,
  exactQuote: z.string().min(1).max(MAX_QUOTE_CHARS),
  kind: HighlightKind,
  color: ColorId,
  /** Null means the Inbox. */
  bankId: Id.nullable(),
  folderId: Id.nullable().optional(),
  userComment: z.string().max(MAX_COMMENT_CHARS),
  priority: Priority,
  headingContext: z.string().max(MAX_HEADING_CHARS).nullable().optional(),
  captureMethod: CaptureMethod,
});
export type PdfHighlightInput = z.infer<typeof PdfHighlightInput>;
