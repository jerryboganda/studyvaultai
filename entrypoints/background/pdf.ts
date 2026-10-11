import { browser } from 'wxt/browser';
import { isLikelyPdfUrl, parseSrc, pdfReaderPath } from '@pdf/readerUrl';

/**
 * "Open in StudyVault reader" (ADR-006). Chrome's built-in PDF viewer is a protected context that
 * extensions cannot instrument, so StudyVault offers its own reader instead: a context-menu item on
 * links, pages and frames whose address looks like a PDF. It opens the reader in a new tab with
 * `?src=<address>`; the reader explains and asks for the single origin's permission itself (a user
 * gesture is needed there), so nothing is fetched from this worker.
 *
 * Imports only `@pdf/readerUrl` (no imports of its own), so pdf.js is not bundled into the worker.
 */

export const OPEN_LINK_MENU_ID = 'sv-open-pdf-link';
export const OPEN_PAGE_MENU_ID = 'sv-open-pdf-page';
export const OPEN_PDF_MENU_TITLE = 'Open in StudyVault reader';

/**
 * The menus API can only filter by match pattern, so these are the path-based part of
 * `isLikelyPdfUrl`; the same function makes the final decision when the item is clicked. Only https
 * and loopback http are offered: those are the addresses the reader accepts.
 */
const HOSTS = ['https://*', 'http://localhost', 'http://127.0.0.1'] as const;
const PATHS = ['/*.pdf', '/*.PDF', '/*.pdf?*', '/*.PDF?*', '/pdf/*'] as const;
export const PDF_URL_PATTERNS: readonly string[] = HOSTS.flatMap((h) => PATHS.map((p) => h + p));

export interface PdfMenuItem {
  id: string;
  title: string;
  contexts: ['link'] | ['page', 'frame'];
  /** Filters the link address (link context). */
  targetUrlPatterns?: string[];
  /** Filters the address of the document or frame (page and frame contexts). */
  documentUrlPatterns?: string[];
}

/** One item per filter kind: a document filter on a link item would hide it on every non-PDF page. */
export function pdfMenuItems(): PdfMenuItem[] {
  return [
    {
      id: OPEN_LINK_MENU_ID,
      title: OPEN_PDF_MENU_TITLE,
      contexts: ['link'],
      targetUrlPatterns: [...PDF_URL_PATTERNS],
    },
    {
      id: OPEN_PAGE_MENU_ID,
      title: OPEN_PDF_MENU_TITLE,
      contexts: ['page', 'frame'],
      documentUrlPatterns: [...PDF_URL_PATTERNS],
    },
  ];
}

export interface PdfMenuClick {
  menuItemId: string | number;
  linkUrl?: string;
  pageUrl?: string;
  frameUrl?: string;
}

/**
 * Extension-relative reader path for a click, or null when the click is not ours or its address does
 * not look like a PDF (menus can be created with patterns the page then does not match exactly, e.g.
 * a redirect). A page uses the TAB's address; a frame uses the frame's.
 */
export function readerPathFor(
  click: PdfMenuClick,
  tabUrl: string | undefined,
  /** The tab that was clicked is private: the reader is told, and treats its own window likewise. */
  incognito = false,
): string | null {
  let target: string | undefined;
  if (click.menuItemId === OPEN_LINK_MENU_ID) target = click.linkUrl;
  else if (click.menuItemId === OPEN_PAGE_MENU_ID) {
    target = isLikelyPdfUrl(click.frameUrl) ? click.frameUrl : (tabUrl ?? click.pageUrl);
  }
  if (!target || !isLikelyPdfUrl(target)) return null;
  const checked = parseSrc(target);
  // A refused address (plain http on another host) is still handed over: the reader says why.
  return pdfReaderPath({ src: checked?.ok ? checked.url : target, incognito });
}

export interface PdfMenuPort {
  remove(id: string): Promise<void>;
  create(item: PdfMenuItem): Promise<void>;
}

/** Idempotent: each id is removed first, so a re-install or update never meets a duplicate id. */
export async function installPdfMenus(port: PdfMenuPort): Promise<void> {
  for (const item of pdfMenuItems()) {
    await port.remove(item.id).catch(() => undefined);
    await port.create(item);
  }
}

function browserPort(): PdfMenuPort {
  return {
    remove: async (id) => {
      await browser.contextMenus.remove(id);
    },
    create: (item) =>
      new Promise((resolve, reject) => {
        browser.contextMenus.create(item, () => {
          const error = browser.runtime.lastError;
          if (error) reject(new Error(error.message));
          else resolve();
        });
      }),
  };
}

/**
 * Registers the menu and its click handler. Call it from the worker's top level, synchronously: the
 * click handler must exist when the worker is woken by a click.
 */
export function registerPdfReaderMenu(report: (err: unknown) => void = console.error): void {
  // Listeners run in registration order and the menus API keeps call order, so this create lands
  // after the save-selection menu's removeAll() that the same event triggers (commands.ts).
  browser.runtime.onInstalled.addListener(() => {
    installPdfMenus(browserPort()).catch(report);
  });
  browser.contextMenus.onClicked.addListener((info, tab) => {
    const path = readerPathFor(info, tab?.url, tab?.incognito === true);
    if (path === null) return;
    browser.tabs
      .create({
        // Not typed as a PublicPath: the query string is part of the address.
        url: browser.runtime.getURL(`/${path}` as never),
        windowId: tab?.windowId,
        index: tab?.index === undefined ? undefined : tab.index + 1,
      })
      .catch(report);
  });
}
