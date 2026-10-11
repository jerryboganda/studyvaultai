import { browser } from 'wxt/browser';
import { safeHref } from '@ui';
import { pdfReaderPath } from '@pdf/readerUrl';
import { dashboardUrl, type DashboardTarget } from '@ui/vault/dashboardLink';

/** Where "open the source" goes for a highlight (pure helpers + extension URLs). */

/** Stand-in address of a PDF that was opened from a file: it never resolves (see @storage). */
const SYNTHETIC_PDF_PREFIX = 'https://studyvault.invalid/pdf/';

const MAX_FRAGMENT_QUOTE = 200;

const encode = (text: string) => encodeURIComponent(text).replace(/-/g, '%2D');

/**
 * Chrome's text-fragment directive (`#:~:text=`), which scrolls to and marks the passage. A long
 * quote is addressed by its first and last words. The browser, not StudyVault, does the matching.
 */
export function textFragment(quote: string): string {
  const words = quote.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (words.length === 0) return '';
  const whole = words.join(' ');
  if (whole.length <= MAX_FRAGMENT_QUOTE || words.length <= 10) {
    return `text=${encode(whole.slice(0, MAX_FRAGMENT_QUOTE * 2))}`;
  }
  return `text=${encode(words.slice(0, 5).join(' '))},${encode(words.slice(-5).join(' '))}`;
}

/** The address to open the original page at the passage; undefined when it cannot be reached. */
export function webSourceHref(
  originalUrl: string | null | undefined,
  quote: string,
): string | undefined {
  if (!originalUrl || originalUrl.startsWith(SYNTHETIC_PDF_PREFIX)) return undefined;
  const href = safeHref(originalUrl);
  if (!href) return undefined;
  const url = new URL(href);
  const fragment = textFragment(quote);
  if (!fragment) return href;
  // The directive follows the page's own fragment, if it has one.
  url.hash = url.hash && url.hash !== '#' ? `${url.hash}:~:${fragment}` : `:~:${fragment}`;
  return url.href;
}

export function extensionUrl(path: string): string {
  try {
    return browser.runtime.getURL(`/${path}` as never);
  } catch {
    return `/${path}`;
  }
}

export function readerHref(documentId: string, page: number | null, highlightId: string): string {
  return extensionUrl(pdfReaderPath({ doc: documentId, page, highlight: highlightId }));
}

export function dashboardHref(target: DashboardTarget): string {
  return dashboardUrl(target);
}

export type SourceTarget =
  | { kind: 'web'; href: string; label: string }
  | { kind: 'pdf'; href: string; label: string }
  | { kind: 'none'; reason: string };

export function sourceTarget(input: {
  highlightId: string;
  quote: string;
  source: { type?: 'web' | 'pdf'; documentId?: string; originalUrl: string };
  pageNumber: number | null;
}): SourceTarget {
  const { source } = input;
  if (source.type === 'pdf') {
    if (!source.documentId) return { kind: 'none', reason: 'This PDF has no stored document id.' };
    return {
      kind: 'pdf',
      href: readerHref(source.documentId, input.pageNumber, input.highlightId),
      label: input.pageNumber
        ? `Open in the PDF reader at page ${input.pageNumber}`
        : 'Open in the PDF reader',
    };
  }
  const href = webSourceHref(source.originalUrl, input.quote);
  if (!href) return { kind: 'none', reason: 'The original page has no reachable address.' };
  return { kind: 'web', href, label: 'Open the original page at this passage' };
}
