import {
  assertPdfWriteAllowed,
  cacheDocumentBytes,
  createBank,
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
    savePdfHighlight: (input) => savePdfHighlight(input),
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
    listBanks: () => listBanks(),
    // createBank lives in the repo, outside the PDF write path: the same restriction applies.
    createBank: async (name) => {
      await assertPdfWriteAllowed();
      return createBank(name);
    },
  };
}
