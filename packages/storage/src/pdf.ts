import { uuidv7 } from 'uuidv7';
import { getSettings } from '@runtime';
import {
  Attachment,
  Highlight,
  MAX_QUOTE_CHARS,
  OcrPage,
  PdfDocument,
  PdfHighlightInput,
  SCHEMA_VERSION,
  Source,
  StudyVaultError,
  UpsertDocumentInput,
  redactUrl,
  type CaptureResult,
  type HighlightView,
} from '@shared';
import {
  addMembership,
  cmp,
  isDeleted,
  LOCAL_PDF_URL_PREFIX,
  notNull,
  now,
  parseInput,
  parseRow,
  requireId,
  resolveTargetBank,
  samePlace,
  signalChange,
  toLite,
  toViews,
} from './core';
import { withDb, withWritableDb, type StudyVaultDb } from './db';
import { assertFolderInBank } from './membership';
import { normalizeQuote, quoteHash } from './normalize';
import type { CachedDocumentInfo, DocumentListItem, SaveOcrPageInput } from './types';

/**
 * PDF store: the documents the reader opened, their highlights (ordinary highlights whose Source is
 * of type 'pdf'), the user-approved cached bytes, and OCR text. Annotations never depend on the
 * cached bytes: deleting the bytes (or the document) keeps every quote.
 */

/** A cached copy larger than this is refused instead of exhausting the profile's storage. */
export const MAX_CACHED_PDF_BYTES = 512 * 1024 * 1024;

const PDF_TABLES = (db: StudyVaultDb) => [
  db.banks,
  db.folders,
  db.documents,
  db.sources,
  db.highlights,
  db.highlightBanks,
];

// ---------------------------------------------------------------------------------------------
// private-window write restriction
// ---------------------------------------------------------------------------------------------

/** Why writes are restricted in the page this module runs in, or null when they are not. */
type WriteRestriction = () => string | null | Promise<string | null>;
let restriction: WriteRestriction | null = null;

/**
 * The page that knows which window it is in (the PDF reader) registers this once. The database is
 * shared with normal windows, so a page in a private window must not add to it unless the person
 * turned on "Save from private windows". Null removes it. The service worker, imports and tests
 * register nothing and are not restricted (the web capture path is checked in the worker, per tab).
 */
export function setPdfWriteRestriction(next: WriteRestriction | null): void {
  restriction = next;
}

/**
 * Throws `forbidden` (with the restriction's reason) when this page is restricted and
 * `settings.allowIncognitoCapture` is off. The setting is read at the moment of the write, so
 * turning it on or off applies without a reload. A restriction or settings read that fails refuses
 * the write: it never guesses in favour of writing.
 */
export async function assertPdfWriteAllowed(): Promise<void> {
  if (!restriction) return;
  const reason = await restriction();
  if (reason === null) return;
  if ((await getSettings()).allowIncognitoCapture) return;
  throw new StudyVaultError('forbidden', reason);
}

async function liveDocument(db: StudyVaultDb, id: string): Promise<PdfDocument> {
  const row = await db.documents.get(id);
  const doc = row ? parseRow(PdfDocument, row, 'document') : null;
  if (!doc || doc.deletedAt !== null) {
    throw new StudyVaultError('not_found', 'Document not found. Open or import it first.');
  }
  return doc;
}

// ---------------------------------------------------------------------------------------------
// documents
// ---------------------------------------------------------------------------------------------

export async function upsertDocument(input: UpsertDocumentInput): Promise<PdfDocument> {
  await assertPdfWriteAllowed();
  const parsed = parseInput(UpsertDocumentInput, input, 'document');
  // An address that is not http(s) (file:, blob:, garbage) is not provenance: store none.
  const originalUrl = parsed.originalUrl === null ? null : redactUrl(parsed.originalUrl);
  const document = await withWritableDb((db) =>
    db.transaction('rw', db.documents, async () => {
      const ts = now();
      const stored = await db.documents.get(parsed.id);
      const existing = stored ? parseRow(PdfDocument, stored, 'document') : null;
      if (stored && !existing) {
        throw new StudyVaultError(
          'storage_unavailable',
          'The stored record of this document could not be read, so it was not changed.',
        );
      }
      const next: PdfDocument = {
        id: parsed.id,
        schemaVersion: SCHEMA_VERSION,
        createdAt: existing?.createdAt ?? ts,
        updatedAt: ts,
        deletedAt: null,
        title: parsed.title || existing?.title || '',
        pageCount: parsed.pageCount,
        byteLength: parsed.byteLength,
        // A reopened local copy must not erase the address it was first fetched from.
        originalUrl: originalUrl ?? existing?.originalUrl ?? null,
        textStatus: parsed.textStatus,
      };
      await db.documents.put(next);
      return next;
    }),
  );
  await signalChange();
  return document;
}

export async function getDocument(id: string): Promise<PdfDocument | null> {
  requireId(id);
  return withDb(async (db) => {
    const row = await db.documents.get(id);
    const doc = row ? parseRow(PdfDocument, row, 'document') : null;
    return doc && doc.deletedAt === null ? doc : null;
  });
}

export async function listDocuments(): Promise<DocumentListItem[]> {
  return withDb((db) =>
    db.transaction('r', [db.documents, db.sources, db.highlights, db.attachments], async () => {
      const docs = (await db.documents.toArray())
        .map((r) => parseRow(PdfDocument, r, 'document'))
        .filter(notNull)
        .filter((d) => d.deletedAt === null);
      // Counted from the index (no highlight row is read to be counted): every highlight of a
      // source, minus its few trashed ones, which the deletedAt index lists and which carry their
      // sourceId.
      const trashedIn = new Map<string, number>();
      for (const h of await db.highlights.where('deletedAt').above('').toArray()) {
        trashedIn.set(h.sourceId, (trashedIn.get(h.sourceId) ?? 0) + 1);
      }
      const out: DocumentListItem[] = [];
      for (const document of docs) {
        const sourceIds = (await db.sources
          .where('documentId')
          .equals(document.id)
          .primaryKeys()) as string[];
        let highlightCount = 0;
        for (const sourceId of sourceIds) {
          const all = await db.highlights.where('sourceId').equals(sourceId).count();
          highlightCount += Math.max(0, all - (trashedIn.get(sourceId) ?? 0));
        }
        const cached = await db.attachments.where('documentId').equals(document.id).first();
        out.push({ document, highlightCount, cachedBytes: cached ? cached.byteLength : null });
      }
      return out.sort(
        (a, b) =>
          cmp(b.document.updatedAt, a.document.updatedAt) || cmp(a.document.id, b.document.id),
      );
    }),
  );
}

export async function deleteDocument(id: string): Promise<void> {
  requireId(id);
  await withWritableDb((db) =>
    db.transaction('rw', db.documents, async () => {
      const doc = await liveDocument(db, id);
      const ts = now();
      await db.documents.put({ ...doc, deletedAt: ts, updatedAt: ts });
    }),
  );
  await signalChange();
}

// ---------------------------------------------------------------------------------------------
// highlights
// ---------------------------------------------------------------------------------------------

/** The Source row of a document, created on first use. Provenance fields are never rewritten. */
async function pdfSource(db: StudyVaultDb, doc: PdfDocument, ts: string): Promise<Source> {
  const rows = await db.sources.where('documentId').equals(doc.id).toArray();
  const found = rows
    .map((r) => parseRow(Source, r, 'source'))
    .filter(notNull)
    .sort((a, b) => cmp(a.createdAt, b.createdAt) || cmp(a.id, b.id));
  const live = found.find((s) => s.deletedAt === null);
  if (live) {
    if (live.title === '' && doc.title !== '') {
      await db.sources.update(live.id, { title: doc.title, updatedAt: ts });
      return { ...live, title: doc.title, updatedAt: ts };
    }
    await db.sources.update(live.id, { updatedAt: ts });
    return { ...live, updatedAt: ts };
  }
  const revived = found[0];
  if (revived) {
    await db.sources.update(revived.id, { deletedAt: null, updatedAt: ts });
    return { ...revived, deletedAt: null, updatedAt: ts };
  }
  const url = doc.originalUrl ?? `${LOCAL_PDF_URL_PREFIX}${doc.id}`;
  const source: Source = {
    id: uuidv7(),
    schemaVersion: SCHEMA_VERSION,
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
    type: 'pdf',
    documentId: doc.id,
    urlKey: `pdf:${doc.id}`,
    visitedKey: `pdf:${doc.id}`,
    originalUrl: url,
    canonicalUrl: null,
    host: doc.originalUrl === null ? '' : new URL(doc.originalUrl).hostname,
    title: doc.title,
  };
  await db.sources.put(source);
  return source;
}

export async function savePdfHighlight(input: PdfHighlightInput): Promise<CaptureResult> {
  await assertPdfWriteAllowed();
  const capture = parseInput(PdfHighlightInput, input, 'PDF highlight');
  if (capture.anchorSet.documentFingerprint !== capture.documentId) {
    throw new StudyVaultError(
      'invalid_request',
      'The highlight anchor belongs to a different document than the one given',
    );
  }
  const normalized = normalizeQuote(capture.exactQuote);
  if (normalized === '') throw new StudyVaultError('invalid_request', 'Quote is empty');
  const hash = await quoteHash(normalized);
  const ts = now();

  const { result, changed } = await withWritableDb((db) =>
    db.transaction('rw', PDF_TABLES(db), async () => {
      const doc = await liveDocument(db, capture.documentId);
      const bank = await resolveTargetBank(db, capture.bankId, ts);
      let folderId: string | null = null;
      if (capture.folderId) {
        await assertFolderInBank(db, capture.folderId, bank.id);
        folderId = capture.folderId;
      }
      const source = await pdfSource(db, doc, ts);

      const same: Highlight[] = [];
      const rows = await db.highlights
        .where('[sourceId+quoteHash]')
        .equals([source.id, hash])
        .toArray();
      for (const row of rows) {
        const parsed = parseRow(Highlight, row, 'highlight');
        if (parsed && samePlace(parsed.anchorSet, capture.anchorSet)) same.push(parsed);
      }
      same.sort((a, b) => cmp(a.capturedAt, b.capturedAt) || cmp(a.id, b.id));
      const live = same.find((h) => h.deletedAt === null);
      const deleted = live
        ? undefined
        : same.sort((a, b) => cmp(b.deletedAt ?? '', a.deletedAt ?? ''))[0];

      let highlight: Highlight;
      let status: CaptureResult['status'];
      let addedToBank: boolean;
      if (live) {
        highlight = live;
        status = 'duplicate';
        addedToBank = await addMembership(db, live.id, bank.id, ts, folderId);
      } else if (deleted) {
        highlight = { ...deleted, deletedAt: null, updatedAt: ts };
        status = 'restored';
        await db.highlights.update(deleted.id, { deletedAt: null, updatedAt: ts });
        addedToBank = await addMembership(db, deleted.id, bank.id, ts, folderId);
      } else {
        highlight = {
          id: uuidv7(),
          schemaVersion: SCHEMA_VERSION,
          createdAt: ts,
          updatedAt: ts,
          deletedAt: null,
          sourceId: source.id,
          exactQuote: capture.exactQuote,
          normalizedQuote: normalized.slice(0, MAX_QUOTE_CHARS),
          quoteHash: hash,
          anchorSet: capture.anchorSet,
          kind: capture.kind,
          color: capture.color,
          priority: capture.priority,
          userComment: capture.userComment,
          headingContext: capture.headingContext ?? null,
          captureMethod: capture.captureMethod,
          capturedAt: ts,
          resolveStatus: 'unchecked',
          resolveConfidence: null,
          lastResolvedAt: null,
          ...(doc.originalUrl === null ? {} : { capturedUrl: doc.originalUrl }),
          capturedTitle: doc.title,
        };
        await db.highlights.put(highlight);
        await db.highlightBanks.put({
          highlightId: highlight.id,
          bankId: bank.id,
          folderId,
          addedAt: ts,
        });
        status = 'created';
        addedToBank = true;
      }
      const [view] = await toViews(db, [highlight]);
      return {
        result: { status, highlight: view!, bank: toLite(bank), addedToBank },
        changed: status !== 'duplicate' || addedToBank,
      };
    }),
  );
  if (changed) await signalChange();
  return result;
}

export async function listPdfHighlights(documentId: string): Promise<HighlightView[]> {
  requireId(documentId);
  return withDb((db) =>
    db.transaction('r', [db.banks, db.sources, db.highlights, db.highlightBanks], async () => {
      const sourceIds = (await db.sources
        .where('documentId')
        .equals(documentId)
        .primaryKeys()) as string[];
      const rows: Highlight[] = [];
      for (const sourceId of sourceIds) {
        for (const row of await db.highlights.where('sourceId').equals(sourceId).toArray()) {
          if (isDeleted(row)) continue;
          const parsed = parseRow(Highlight, row, 'highlight');
          if (parsed) rows.push(parsed);
        }
      }
      const page = (h: Highlight) => (h.anchorSet.type === 'pdf' ? h.anchorSet.pageNumber : 0);
      rows.sort(
        (a, b) =>
          page(a) - page(b) ||
          a.anchorSet.textPosition.start - b.anchorSet.textPosition.start ||
          cmp(a.capturedAt, b.capturedAt) ||
          cmp(a.id, b.id),
      );
      return toViews(db, rows);
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// cached bytes
// ---------------------------------------------------------------------------------------------

async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Store (replace) the user-approved copy of a document's bytes. Callers ask the user first; this
 * only refuses what cannot be stored sensibly. One copy per document.
 */
export async function cacheDocumentBytes(
  documentId: string,
  blob: Blob,
): Promise<CachedDocumentInfo> {
  await assertPdfWriteAllowed();
  requireId(documentId);
  const checked = parseInput(Attachment.shape.blob, blob, 'file');
  if (checked.size === 0) throw new StudyVaultError('invalid_request', 'The file is empty');
  if (checked.size > MAX_CACHED_PDF_BYTES) {
    throw new StudyVaultError(
      'quota_exceeded',
      `The file is larger than the ${Math.round(MAX_CACHED_PDF_BYTES / 1024 / 1024)} MB limit for a stored copy.`,
    );
  }
  // Hash before the transaction: awaiting crypto inside would let IndexedDB auto-commit it.
  const sha256 = await sha256Hex(checked);
  const info = await withWritableDb((db) =>
    db.transaction('rw', [db.documents, db.attachments], async () => {
      await liveDocument(db, documentId);
      const stale = await db.attachments.where('documentId').equals(documentId).primaryKeys();
      if (stale.length > 0) await db.attachments.bulkDelete(stale);
      const row: Attachment = {
        id: uuidv7(),
        schemaVersion: SCHEMA_VERSION,
        createdAt: now(),
        documentId,
        sha256,
        mimeType: checked.type || 'application/pdf',
        byteLength: checked.size,
        blob: checked,
      };
      await db.attachments.put(row);
      return row;
    }),
  );
  await signalChange();
  return {
    attachmentId: info.id,
    documentId,
    byteLength: info.byteLength,
    sha256,
    matchesDocumentId: sha256 === documentId,
  };
}

export async function getDocumentBytes(documentId: string): Promise<Blob | null> {
  requireId(documentId);
  return withDb(async (db) => {
    const row = await db.attachments.where('documentId').equals(documentId).first();
    const parsed = row ? parseRow(Attachment, row, 'attachment') : null;
    return parsed ? parsed.blob : null;
  });
}

export async function removeDocumentBytes(documentId: string): Promise<boolean> {
  requireId(documentId);
  const removed = await withWritableDb((db) =>
    db.transaction('rw', db.attachments, async () => {
      const keys = await db.attachments.where('documentId').equals(documentId).primaryKeys();
      if (keys.length > 0) await db.attachments.bulkDelete(keys);
      return keys.length > 0;
    }),
  );
  if (removed) await signalChange();
  return removed;
}

// ---------------------------------------------------------------------------------------------
// OCR
// ---------------------------------------------------------------------------------------------

export async function saveOcrPage(input: SaveOcrPageInput): Promise<OcrPage> {
  await assertPdfWriteAllowed();
  requireId(input.documentId);
  const base = parseInput(
    OcrPage.pick({
      documentId: true,
      pageNumber: true,
      text: true,
      words: true,
      language: true,
      engine: true,
      confidence: true,
      orientation: true,
    }),
    {
      documentId: input.documentId,
      pageNumber: input.pageNumber,
      text: input.text,
      words: input.words ?? [],
      language: input.language,
      engine: input.engine,
      confidence: input.confidence ?? null,
      orientation: input.orientation,
    },
    'OCR page',
  );
  if (input.correctedText !== undefined && input.correctedText !== null) {
    parseInput(OcrPage.shape.correctedText, input.correctedText, 'corrected text');
  }
  const page = await withWritableDb((db) =>
    db.transaction('rw', [db.documents, db.ocrPages], async () => {
      await liveDocument(db, base.documentId);
      const ts = now();
      const stored = await db.ocrPages.get([base.documentId, base.pageNumber]);
      const existing = stored ? parseRow(OcrPage, stored, 'ocrPage') : null;
      if (stored && !existing) {
        throw new StudyVaultError(
          'storage_unavailable',
          'The stored OCR text of this page could not be read, so it was not changed.',
        );
      }
      const row: OcrPage = {
        ...base,
        schemaVersion: SCHEMA_VERSION,
        createdAt: existing?.createdAt ?? ts,
        updatedAt: ts,
        // The user's correction survives a re-run of the recogniser unless they clear it.
        correctedText:
          input.correctedText === undefined
            ? (existing?.correctedText ?? null)
            : input.correctedText,
      };
      // Saving a correction does not say how the page was read: the stored orientation stays.
      const orientation = base.orientation ?? existing?.orientation;
      if (orientation !== undefined) row.orientation = orientation;
      else delete row.orientation;
      await db.ocrPages.put(row);
      return row;
    }),
  );
  await signalChange();
  return page;
}

export async function getOcrPages(documentId: string): Promise<OcrPage[]> {
  requireId(documentId);
  return withDb(async (db) => {
    const rows = await db.ocrPages.where('documentId').equals(documentId).toArray();
    return rows
      .map((r) => parseRow(OcrPage, r, 'ocrPage'))
      .filter(notNull)
      .sort((a, b) => a.pageNumber - b.pageNumber);
  });
}

/** Remove OCR text of a document (all pages, or just the listed ones). Returns pages removed. */
export async function clearOcr(documentId: string, pageNumbers?: number[]): Promise<number> {
  requireId(documentId);
  const only = pageNumbers ? new Set(pageNumbers) : null;
  const removed = await withWritableDb((db) =>
    db.transaction('rw', db.ocrPages, async () => {
      const keys = (await db.ocrPages
        .where('documentId')
        .equals(documentId)
        .primaryKeys()) as Array<[string, number]>;
      const doomed = keys.filter((k) => only === null || only.has(k[1]));
      if (doomed.length > 0) await db.ocrPages.bulkDelete(doomed);
      return doomed.length;
    }),
  );
  if (removed > 0) await signalChange();
  return removed;
}
