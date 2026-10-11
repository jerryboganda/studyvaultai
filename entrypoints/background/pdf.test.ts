// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { isLikelyPdfUrl } from '@pdf/readerUrl';
import {
  OPEN_LINK_MENU_ID,
  OPEN_PAGE_MENU_ID,
  OPEN_PDF_MENU_TITLE,
  PDF_URL_PATTERNS,
  installPdfMenus,
  pdfMenuItems,
  readerPathFor,
  type PdfMenuItem,
} from './pdf';

/** Chrome's match-pattern matcher for the subset used here: scheme://host/path with * wildcards. */
function matches(pattern: string, url: string): boolean {
  const m = /^(\*|https?):\/\/([^/]+)(\/.*)$/.exec(pattern);
  if (!m) return false;
  const [, scheme, host, path] = m as unknown as [string, string, string, string];
  const u = new URL(url);
  if (scheme !== '*' && `${u.protocol}` !== `${scheme}:`) return false;
  const hostRe = new RegExp(`^${host.replace(/[.]/g, '\\.').replace(/\*/g, '.*')}$`);
  if (!hostRe.test(u.hostname)) return false;
  const pathRe = new RegExp(`^${path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
  return pathRe.test(u.pathname + u.search);
}
const shown = (url: string): boolean => PDF_URL_PATTERNS.some((p) => matches(p, url));

describe('menu items', () => {
  it('has a link item and a page/frame item, each filtered on the right address', () => {
    const [link, page] = pdfMenuItems() as [PdfMenuItem, PdfMenuItem];
    expect(link).toMatchObject({ id: OPEN_LINK_MENU_ID, title: OPEN_PDF_MENU_TITLE });
    expect(link.contexts).toEqual(['link']);
    expect(link.targetUrlPatterns?.length).toBeGreaterThan(0);
    expect(link.documentUrlPatterns).toBeUndefined();
    expect(page).toMatchObject({ id: OPEN_PAGE_MENU_ID, title: OPEN_PDF_MENU_TITLE });
    expect(page.contexts).toEqual(['page', 'frame']);
    expect(page.documentUrlPatterns).toEqual(link.targetUrlPatterns);
    expect(page.targetUrlPatterns).toBeUndefined();
  });

  it('the patterns cover what the reader accepts and nothing it would refuse', () => {
    for (const url of [
      'https://example.org/a.pdf',
      'https://example.org/a.PDF',
      'https://example.org/dir/a.pdf?download=1',
      'http://127.0.0.1:4000/a.pdf',
      'http://localhost/a.pdf',
      'https://arxiv.org/pdf/2101.00001',
    ]) {
      expect(shown(url), url).toBe(true);
    }
    for (const url of [
      'https://example.org/',
      'https://example.org/a.pdf.html',
      'http://example.org/a.pdf', // plain http on the open web: the reader refuses it
      'https://example.org/page',
    ]) {
      expect(shown(url), url).toBe(false);
    }
  });

  it('every address the patterns show is also accepted by isLikelyPdfUrl', () => {
    for (const url of [
      'https://example.org/a.pdf',
      'https://example.org/a.PDF?x=1',
      'http://localhost:8080/files/b.pdf',
      'https://arxiv.org/pdf/2101.00001',
    ]) {
      expect(shown(url)).toBe(true);
      expect(isLikelyPdfUrl(url)).toBe(true);
    }
  });
});

describe('install', () => {
  it('removes each id before creating it, so repeating it never meets a duplicate id', async () => {
    const calls: string[] = [];
    const port = {
      remove: vi.fn(async (id: string) => void calls.push(`remove ${id}`)),
      create: vi.fn(async (item: PdfMenuItem) => void calls.push(`create ${item.id}`)),
    };
    await installPdfMenus(port);
    await installPdfMenus(port);
    expect(calls).toEqual([
      `remove ${OPEN_LINK_MENU_ID}`,
      `create ${OPEN_LINK_MENU_ID}`,
      `remove ${OPEN_PAGE_MENU_ID}`,
      `create ${OPEN_PAGE_MENU_ID}`,
      `remove ${OPEN_LINK_MENU_ID}`,
      `create ${OPEN_LINK_MENU_ID}`,
      `remove ${OPEN_PAGE_MENU_ID}`,
      `create ${OPEN_PAGE_MENU_ID}`,
    ]);
  });

  it('a failing remove (the id did not exist yet) does not stop the create', async () => {
    const created: string[] = [];
    await installPdfMenus({
      remove: async () => {
        throw new Error('Cannot find menu item');
      },
      create: async (item) => void created.push(item.id),
    });
    expect(created).toEqual([OPEN_LINK_MENU_ID, OPEN_PAGE_MENU_ID]);
  });
});

describe('click -> reader address', () => {
  const src = (path: string | null): string | null =>
    path === null ? null : new URLSearchParams(path.slice(path.indexOf('?'))).get('src');

  it('a link opens the reader on the link address', () => {
    const path = readerPathFor(
      {
        menuItemId: OPEN_LINK_MENU_ID,
        linkUrl: 'https://files.example.org/notes.pdf?v=2',
        pageUrl: 'https://example.org/',
      },
      'https://example.org/',
    );
    expect(path?.startsWith('pdf-reader.html?src=')).toBe(true);
    expect(src(path)).toBe('https://files.example.org/notes.pdf?v=2');
  });

  it('a page uses the TAB address; a frame uses its own address when that is the PDF', () => {
    expect(
      src(
        readerPathFor(
          { menuItemId: OPEN_PAGE_MENU_ID, pageUrl: 'https://example.org/a.pdf' },
          'https://example.org/a.pdf',
        ),
      ),
    ).toBe('https://example.org/a.pdf');
    expect(
      src(
        readerPathFor(
          {
            menuItemId: OPEN_PAGE_MENU_ID,
            pageUrl: 'https://example.org/viewer',
            frameUrl: 'https://cdn.example.org/doc.pdf',
          },
          'https://example.org/viewer',
        ),
      ),
    ).toBe('https://cdn.example.org/doc.pdf');
  });

  it('drops the fragment and ignores clicks that are not ours or not PDFs', () => {
    expect(
      src(
        readerPathFor(
          { menuItemId: OPEN_LINK_MENU_ID, linkUrl: 'https://example.org/a.pdf#page=3' },
          undefined,
        ),
      ),
    ).toBe('https://example.org/a.pdf');
    expect(
      readerPathFor({ menuItemId: 'sv-save-selection' }, 'https://example.org/a.pdf'),
    ).toBeNull();
    expect(
      readerPathFor(
        { menuItemId: OPEN_LINK_MENU_ID, linkUrl: 'https://example.org/page' },
        undefined,
      ),
    ).toBeNull();
    expect(
      readerPathFor({ menuItemId: OPEN_LINK_MENU_ID, linkUrl: 'javascript:alert(1)' }, undefined),
    ).toBeNull();
    expect(readerPathFor({ menuItemId: OPEN_PAGE_MENU_ID }, undefined)).toBeNull();
  });

  it('a plain-http address on the open web is handed over so the reader can say why it is refused', () => {
    const path = readerPathFor(
      { menuItemId: OPEN_LINK_MENU_ID, linkUrl: 'http://example.org/a.pdf' },
      undefined,
    );
    expect(src(path)).toBe('http://example.org/a.pdf');
  });
});

describe('registerPdfReaderMenu (worker wiring)', () => {
  type Listener = (info: Record<string, unknown>, tab?: Record<string, unknown>) => void;

  async function wire() {
    const { browser } = await import('wxt/browser');
    const { fakeBrowser } = await import('wxt/testing/fake-browser');
    const { registerPdfReaderMenu } = await import('./pdf');
    fakeBrowser.reset();
    const clicks: Listener[] = [];
    const created: PdfMenuItem[] = [];
    Object.assign(browser, {
      contextMenus: {
        onClicked: { addListener: (l: Listener) => clicks.push(l) },
        remove: vi.fn(async () => undefined),
        create: vi.fn((item: PdfMenuItem, cb?: () => void) => {
          created.push(item);
          cb?.();
        }),
      },
    });
    const open = vi.spyOn(browser.tabs, 'create').mockResolvedValue({} as never);
    registerPdfReaderMenu(vi.fn());
    return { browser, fakeBrowser, clicks, created, open };
  }

  it('creates both menus on install and opens the reader in the next tab on a click', async () => {
    const { fakeBrowser, clicks, created, open } = await wire();
    await fakeBrowser.runtime.onInstalled.trigger({ reason: 'install' });
    await vi.waitFor(() =>
      expect(created.map((c) => c.id)).toEqual([OPEN_LINK_MENU_ID, OPEN_PAGE_MENU_ID]),
    );

    expect(clicks).toHaveLength(1);
    clicks[0]!(
      { menuItemId: OPEN_LINK_MENU_ID, linkUrl: 'https://files.example.org/notes.pdf' },
      { id: 7, windowId: 2, index: 3, url: 'https://example.org/' },
    );
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    const arg = open.mock.calls[0]![0] as { url: string; windowId: number; index: number };
    expect(arg.url).toContain('pdf-reader.html?src=');
    expect(decodeURIComponent(arg.url)).toContain('https://files.example.org/notes.pdf');
    expect(arg).toMatchObject({ windowId: 2, index: 4 });
  });

  it('opens nothing for another menu or an address that is not a PDF', async () => {
    const { clicks, open } = await wire();
    clicks[0]!({ menuItemId: 'sv-save-selection' }, { id: 1, url: 'https://example.org/a.pdf' });
    clicks[0]!({ menuItemId: OPEN_LINK_MENU_ID, linkUrl: 'https://example.org/page' }, { id: 1 });
    await new Promise((r) => setTimeout(r, 20));
    expect(open).not.toHaveBeenCalled();
  });
});
