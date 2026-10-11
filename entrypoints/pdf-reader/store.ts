import {
  cacheDocumentBytes,
  createBank,
  getDocument,
  getDocumentBytes,
  getOcrPages,
  listBanks,
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
    listBanks: () => listBanks(),
    createBank: (name) => createBank(name),
  };
}
