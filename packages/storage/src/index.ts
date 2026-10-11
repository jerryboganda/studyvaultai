export {
  saveCapture,
  getPageHighlights,
  updateHighlight,
  softDeleteHighlight,
  restoreHighlight,
  reportResolutions,
  getHighlightSource,
  listBanks,
  createBank,
  listRecentHighlights,
  listPageHighlights,
  listBanksWithCounts,
  wipeAllData,
  repo,
} from './repo';
export { observe, type Observable } from './observe';
export { normalizeQuote, quoteHash } from './normalize';
export { closeDb, resetDbForTests } from './db';
export type { Bank, BankWithCount, HighlightListItem, RepoApi } from './types';
