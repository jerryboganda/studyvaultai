import { createContext, useContext } from 'react';
import {
  createBank,
  getAnalyticsInput,
  restoreHighlight,
  softDeleteHighlight,
  updateHighlight,
  vault,
  withDb,
  withWritableDb,
  type VaultApi,
} from '@storage';
import type { BankLite, HighlightPatch, HighlightView } from '@shared';
import type { DayBoundary } from '@study';
import { storageLinks, type LinksPort } from '@ui/vault/Links';
import type { MetaPort } from '@ui/vault/meta';
import { bankStudyFrom, type BankStudy } from './homeModel';

/**
 * Everything the dashboard asks of the vault, as one injectable object: the real @storage in the
 * extension, an in-memory fake in tests. Only members that are actually used are listed.
 */
export interface DashboardApi extends Pick<
  VaultApi,
  | 'listBankInfos'
  | 'listFolderTree'
  | 'createFolder'
  | 'renameFolder'
  | 'moveFolder'
  | 'reorderFolders'
  | 'deleteFolder'
  | 'mergeFolders'
  | 'renameBank'
  | 'reorderBanks'
  | 'mergeBanks'
  | 'deleteBank'
  | 'setBankColor'
  | 'setBankIcon'
  | 'addToBank'
  | 'removeFromBank'
  | 'moveHighlight'
  | 'createTag'
  | 'attachTags'
  | 'detachTags'
  | 'listTags'
  | 'createNote'
  | 'updateNote'
  | 'deleteNote'
  | 'setCustomFields'
  | 'clearCustomField'
  | 'bulkMove'
  | 'bulkTag'
  | 'bulkDelete'
  | 'bulkRestore'
  | 'bulkSetKind'
  | 'bulkSetColor'
  | 'bulkSetPriority'
  | 'listTrash'
  | 'restore'
  | 'purge'
  | 'emptyTrash'
  | 'findDuplicateClusters'
  | 'listHighlights'
  | 'countHighlights'
  | 'getCounts'
  | 'getHighlightDetail'
  | 'listSearchDocuments'
  | 'listSearchDocumentsChangedSince'
  | 'getLastPurgeAt'
  | 'listDocuments'
  | 'removeDocumentBytes'
  | 'getStorageUsage'
> {
  createBank(name: string): Promise<BankLite>;
  updateHighlight(id: string, patch: HighlightPatch): Promise<HighlightView>;
  softDeleteHighlight(id: string): Promise<void>;
  restoreHighlight(id: string): Promise<HighlightView>;
  meta: MetaPort;
  /** Cards and measured retention per bank id over the last year (the Home bank cards). */
  bankStudy(o: { boundary: DayBoundary }): Promise<Record<string, BankStudy>>;
  /** Links between items (ADR-018). Without it the preview has no Links section. */
  links?: LinksPort;
}

const meta: MetaPort = {
  async get(key) {
    return withDb(async (db) => (await db.meta.get(key))?.value);
  },
  async put(key, value) {
    await withWritableDb(async (db) => {
      await db.meta.put({ key, value, updatedAt: new Date().toISOString() });
    });
  },
  async putMany(entries) {
    await withWritableDb((db) =>
      db.transaction('rw', db.meta, async () => {
        const updatedAt = new Date().toISOString();
        for (const e of entries) await db.meta.put({ key: e.key, value: e.value, updatedAt });
      }),
    );
  },
};

/** The production wiring. */
export const realApi: DashboardApi = {
  ...vault,
  createBank,
  updateHighlight,
  softDeleteHighlight,
  restoreHighlight,
  meta,
  bankStudy: async ({ boundary }) =>
    bankStudyFrom(await getAnalyticsInput({ boundary, sinceDays: 365 })),
  links: storageLinks,
};

export type { MetaPort };

const ApiContext = createContext<DashboardApi>(realApi);
export const ApiProvider = ApiContext.Provider;
export const useApi = (): DashboardApi => useContext(ApiContext);
