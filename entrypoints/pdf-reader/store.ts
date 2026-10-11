import { getTrustedSettings } from '@runtime';
import {
  acceptFiling,
  assertPdfWriteAllowed,
  cacheDocumentBytes,
  createBank,
  dismissFiling,
  filingAfterCapture,
  getDocument,
  getDocumentBytes,
  getOcrPages,
  listBanks,
  listDocuments,
  listPdfHighlights,
  removeDocumentBytes,
  restoreHighlight,
  saveOcrPage,
  savePdfHighlight,
  softDeleteHighlight,
  undoFiling,
  updateHighlight,
  upsertDocument,
} from '@storage';
import type { PdfStore } from '@pdf';

/**
 * The reader's PdfStore on the real vault (`@storage`, Dexie). The port names follow the vault task's
 * PDF contract; deletion is the vault's soft delete, so Undo is `restoreHighlight`.
 */
export function createStorageStore(): PdfStore {
  return {
    upsertDocument: (input) => upsertDocument(input),
    getDocument: (id) => getDocument(id),
    savePdfHighlight: async (input) => {
      const result = await savePdfHighlight(input);
      if (result.status !== 'created') return result;
      // Rules look at a new reader highlight only when they name "PDF document" as a source
      // (decideFiling). Nothing here may fail the save that already succeeded.
      try {
        const settings = await getTrustedSettings();
        if (!settings.useFilingRules) return result;
        const doc = await getDocument(input.documentId);
        const filing = await filingAfterCapture({
          highlightId: result.highlight.id,
          placed: { bankId: result.bank.id, folderId: input.folderId ?? null },
          requestedBankId: input.bankId,
          lastBankId: settings.lastBankId,
          candidate: {
            url: doc?.originalUrl ?? null,
            title: doc?.title ?? '',
            quote: result.highlight.exactQuote,
            kind: result.highlight.kind,
            tagIds: [],
            sourceType: 'pdf',
          },
        });
        return filing ? { ...result, filing } : result;
      } catch (err) {
        console.warn('[StudyVault] filing rules were not applied', err);
        return result;
      }
    },
    listPdfHighlights: (documentId) => listPdfHighlights(documentId),
    updateHighlight: (id, patch) => updateHighlight(id, patch),
    deleteHighlight: (id) => softDeleteHighlight(id),
    restoreHighlight: (id) => restoreHighlight(id),
    cacheDocumentBytes: async (documentId, blob) => {
      const info = await cacheDocumentBytes(documentId, blob);
      return { byteLength: info.byteLength };
    },
    getDocumentBytes: (documentId) => getDocumentBytes(documentId),
    removeDocumentBytes: (documentId) => removeDocumentBytes(documentId),
    saveOcrPage: (input) => saveOcrPage(input),
    getOcrPages: (documentId) => getOcrPages(documentId),
    listStoredCopies: async () =>
      (await listDocuments())
        .filter((d) => d.cachedBytes !== null)
        .map((d) => ({
          documentId: d.document.id,
          title: d.document.title,
          pageCount: d.document.pageCount,
          byteLength: d.cachedBytes ?? 0,
          originalUrl: d.document.originalUrl,
        })),
    filing: {
      accept: (id) => acceptFiling(id),
      dismiss: (id) => dismissFiling(id),
      undo: (id) => undoFiling(id),
    },
    listBanks: () => listBanks(),
    // createBank lives in the repo, outside the PDF write path: the same restriction applies.
    createBank: async (name) => {
      await assertPdfWriteAllowed();
      return createBank(name);
    },
  };
}
