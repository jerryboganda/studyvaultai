import { browser } from 'wxt/browser';
import { reviewPageUrl } from '@ui/review';
import { openDashboard } from '@ui/vault';

/** Where the panel's buttons go. Extension pages only: nothing here leaves the extension. */

/** Absolute address of an extension page (`path` is extension-relative, no leading slash needed). */
export function extensionPageUrl(path: string): string {
  return browser.runtime.getURL(`/${path.replace(/^\//, '')}` as never);
}

/** Options page, optionally at a section (`#ai`). */
export const optionsUrl = (section?: string): string =>
  extensionPageUrl(`options.html${section ? `#${section}` : ''}`);

export async function openInTab(url: string): Promise<void> {
  await browser.tabs.create({ url });
}

/** The review page's card author, opened on this highlight. */
export const openFlashcardAuthor = (highlightId: string): Promise<void> =>
  openInTab(reviewPageUrl({ view: 'create', highlightId }));

export const openHighlightInDashboard = (highlightId: string): Promise<void> =>
  openDashboard({ highlight: highlightId });
