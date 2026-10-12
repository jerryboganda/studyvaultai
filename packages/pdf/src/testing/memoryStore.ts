import type { BankLite, CaptureResult, HighlightPatch, HighlightView } from '@shared';
import { INBOX_BANK_ID, INBOX_BANK_NAME } from '@shared/constants';
import type {
  PdfDocumentInput,
  PdfDocumentRecord,
  PdfStore,
  SaveOcrPageInput,
  SavePdfHighlightInput,
  StoredCopy,
  StoredOcrPage,
  StoredPreviousReading,
} from '../store';

type OcrRow = StoredOcrPage & { language: string; engine: string; confidence?: number | null };

const readingOf = (row: OcrRow): StoredPreviousReading => ({
  text: row.text,
  correctedText: row.correctedText,
  words: row.words,
  language: row.language,
  engine: row.engine,
  confidence: row.confidence ?? null,
  ...(row.orientation === undefined ? {} : { orientation: row.orientation }),
  replacedAt: new Date().toISOString(),
});

/** In-memory PdfStore for tests and for previewing the reader without extension storage. */
export function createMemoryPdfStore(): PdfStore & {
  highlights: Map<string, HighlightView & { documentId: string; deleted: boolean }>;
  documents: Map<string, PdfDocumentRecord>;
  /** documentId -> kept bytes (user-approved copy). */
  copies: Map<string, Blob>;
  /** documentId -> page number -> stored OCR page. */
  ocr: Map<string, Map<number, OcrRow>>;
} {
  const documents = new Map<string, PdfDocumentRecord>();
  const highlights = new Map<string, HighlightView & { documentId: string; deleted: boolean }>();
  const copies = new Map<string, Blob>();
  const ocr = new Map<string, Map<number, OcrRow>>();
  const banks: BankLite[] = [
    { id: INBOX_BANK_ID, name: INBOX_BANK_NAME, color: 'blue', isInbox: true },
  ];
  let seq = 0;
  const strip = (h: HighlightView & { documentId: string; deleted: boolean }): HighlightView => {
    const { documentId: _d, deleted: _x, ...view } = h;
    return view;
  };

  return {
    highlights,
    documents,
    copies,
    ocr,
    async cacheDocumentBytes(documentId: string, blob: Blob) {
      copies.set(documentId, blob);
      return { byteLength: blob.size };
    },
    async getDocumentBytes(documentId: string) {
      return copies.get(documentId) ?? null;
    },
    async removeDocumentBytes(documentId: string) {
      return copies.delete(documentId);
    },
    async listStoredCopies(): Promise<StoredCopy[]> {
      return [...copies].map(([documentId, blob]) => {
        const rec = documents.get(documentId);
        return {
          documentId,
          title: rec?.title ?? 'Untitled PDF',
          pageCount: rec?.pageCount ?? 0,
          byteLength: blob.size,
          originalUrl: rec?.originalUrl ?? null,
        };
      });
    },
    async saveOcrPage(input: SaveOcrPageInput) {
      const pages = ocr.get(input.documentId) ?? new Map();
      const prev = pages.get(input.pageNumber);
      const row: OcrRow = {
        pageNumber: input.pageNumber,
        text: input.text,
        words: input.words,
        language: input.language,
        engine: input.engine,
        confidence: input.confidence,
        correctedText:
          input.correctedText === undefined ? (prev?.correctedText ?? null) : input.correctedText,
        orientation: input.orientation ?? prev?.orientation,
      };
      if (prev?.previousReading) row.previousReading = prev.previousReading;
      pages.set(input.pageNumber, row);
      ocr.set(input.documentId, pages);
    },
    async replaceOcrPage(input: SaveOcrPageInput) {
      const pages = ocr.get(input.documentId) ?? new Map<number, OcrRow>();
      const prev = pages.get(input.pageNumber);
      const row: OcrRow = {
        pageNumber: input.pageNumber,
        text: input.text,
        words: input.words,
        language: input.language,
        engine: input.engine,
        confidence: input.confidence,
        correctedText: input.correctedText ?? null,
        orientation: input.orientation,
      };
      if (prev) row.previousReading = readingOf(prev);
      pages.set(input.pageNumber, row);
      ocr.set(input.documentId, pages);
      return row;
    },
    async swapOcrReading(documentId: string, pageNumber: number) {
      const row = ocr.get(documentId)?.get(pageNumber);
      const was = row?.previousReading;
      if (!row || !was) throw new Error('not_found');
      const next: OcrRow = {
        ...row,
        text: was.text,
        correctedText: was.correctedText,
        words: was.words,
        language: was.language,
        engine: was.engine,
        confidence: was.confidence,
        orientation: was.orientation,
        previousReading: readingOf(row),
      };
      ocr.get(documentId)!.set(pageNumber, next);
      return next;
    },
    async getOcrPages(documentId: string): Promise<StoredOcrPage[]> {
      return [...(ocr.get(documentId)?.values() ?? [])].sort((a, b) => a.pageNumber - b.pageNumber);
    },
    async upsertDocument(input: PdfDocumentInput) {
      const now = new Date().toISOString();
      const prev = documents.get(input.id);
      const rec: PdfDocumentRecord = {
        ...input,
        createdAt: prev?.createdAt ?? now,
        updatedAt: now,
      };
      documents.set(input.id, rec);
      return rec;
    },
    async getDocument(id) {
      return documents.get(id) ?? null;
    },
    async savePdfHighlight(input: SavePdfHighlightInput): Promise<CaptureResult> {
      const bank = banks.find((b) => b.id === input.bankId) ?? banks[0]!;
      const dup = [...highlights.values()].find(
        (h) =>
          h.documentId === input.documentId &&
          h.anchorSet.type === 'pdf' &&
          input.anchorSet.type === 'pdf' &&
          h.anchorSet.pageNumber === input.anchorSet.pageNumber &&
          h.anchorSet.textPosition.start === input.anchorSet.textPosition.start &&
          h.exactQuote === input.exactQuote,
      );
      if (dup) {
        const was = dup.deleted;
        dup.deleted = false;
        const added = !dup.bankIds.includes(bank.id);
        if (added) dup.bankIds.push(bank.id);
        return {
          status: was ? 'restored' : 'duplicate',
          highlight: strip(dup),
          bank,
          addedToBank: added,
        };
      }
      const id = `pdfhl-${String(++seq).padStart(6, '0')}`;
      const row = {
        id,
        sourceId: input.documentId.slice(0, 64),
        exactQuote: input.exactQuote,
        anchorSet: input.anchorSet,
        kind: input.kind,
        color: input.color,
        priority: input.priority,
        userComment: input.userComment,
        headingContext: input.headingContext ?? null,
        bankIds: [bank.id],
        capturedAt: new Date().toISOString(),
        resolveStatus: 'unchecked' as const,
        resolveConfidence: null,
        documentId: input.documentId,
        deleted: false,
      };
      highlights.set(id, row);
      return { status: 'created', highlight: strip(row), bank, addedToBank: true };
    },
    async listPdfHighlights(documentId) {
      return [...highlights.values()]
        .filter((h) => h.documentId === documentId && !h.deleted)
        .map(strip);
    },
    async updateHighlight(id, patch: HighlightPatch) {
      const h = highlights.get(id);
      if (!h || h.deleted) throw new Error('not_found');
      Object.assign(h, patch);
      return strip(h);
    },
    async deleteHighlight(id) {
      const h = highlights.get(id);
      if (h) h.deleted = true;
    },
    async restoreHighlight(id) {
      const h = highlights.get(id);
      if (!h) throw new Error('not_found');
      h.deleted = false;
      return strip(h);
    },
    async listBanks() {
      return banks.slice();
    },
    async createBank(name) {
      const bank: BankLite = {
        id: `bank-${String(banks.length + 1).padStart(4, '0')}`,
        name,
        color: 'teal',
        isInbox: false,
      };
      banks.push(bank);
      return bank;
    },
  };
}
