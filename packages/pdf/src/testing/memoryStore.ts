import type { BankLite, CaptureResult, HighlightPatch, HighlightView } from '@shared';
import { INBOX_BANK_ID, INBOX_BANK_NAME } from '@shared/constants';
import type {
  PdfDocumentInput,
  PdfDocumentRecord,
  PdfStore,
  SavePdfHighlightInput,
} from '../store';

/** In-memory PdfStore for tests and for previewing the reader without extension storage. */
export function createMemoryPdfStore(): PdfStore & {
  highlights: Map<string, HighlightView & { documentId: string; deleted: boolean }>;
  documents: Map<string, PdfDocumentRecord>;
} {
  const documents = new Map<string, PdfDocumentRecord>();
  const highlights = new Map<string, HighlightView & { documentId: string; deleted: boolean }>();
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
