import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PageLink, PageLinks } from '@pdf';
import { LinkList, openInNewTab, useLinks, type LinkController } from './links';
import { Toolbar } from './Toolbar';
import type { ViewerHandle } from './Viewer';

afterEach(cleanup);

const external = (url: string): PageLink => {
  const u = new URL(url);
  return {
    rects: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.03 }],
    target: { kind: 'external', url: u.href, host: u.host, origin: u.origin },
    label: `External link to ${u.host}`,
  };
};
const page = (pageNumber: number, top: number | null = 400): PageLink => ({
  rects: [{ x: 0.1, y: 0.3, w: 0.2, h: 0.03 }],
  target: { kind: 'page', pageNumber, left: 72, top },
  label: `Link to page ${pageNumber}`,
});
const refused = (reason: string): PageLink => ({
  rects: [{ x: 0.1, y: 0.5, w: 0.2, h: 0.03 }],
  target: { kind: 'refused', reason },
  label: 'Link that StudyVault will not open',
});

function setup() {
  const handle: ViewerHandle = {
    jumpToPage: vi.fn(),
    reveal: vi.fn(),
    focus: vi.fn(),
    flushSelection: vi.fn(() => false),
    redraw: vi.fn(),
    position: vi.fn(() => ({ page: 2, frac: 0.4 })),
    restore: vi.fn(),
    goToDestination: vi.fn(),
  };
  const viewer = { current: handle };
  const doc = { getPage: vi.fn(async () => ({ view: [0, 0, 300, 500] })) };
  const onPage = vi.fn();
  const announce = vi.fn();
  const open = vi.fn();
  let controller!: LinkController;
  function Harness() {
    controller = useLinks({ doc: doc as never, viewer, onPage, announce, open });
    return (
      <>
        {controller.notice}
        {controller.dialog}
        <p data-testid="back-to">{String(controller.backTo)}</p>
      </>
    );
  }
  render(<Harness />);
  const follow = (link: PageLink) => act(() => controller.follow(link));
  return { handle, doc, onPage, announce, open, follow, ctrl: () => controller };
}

describe('following an address', () => {
  it('opens nothing until the person confirms, then opens it once, in a new tab', async () => {
    const s = setup();
    s.follow(external('https://example.org/path?q=1#top'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('pdf-link-address').textContent).toBe(
      'https://example.org/path?q=1#top',
    );
    expect(within(dialog).getByTestId('pdf-link-host').textContent).toBe('example.org');
    expect(s.open).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Open in a new tab' }));
    expect(s.open).toHaveBeenCalledTimes(1);
    expect(s.open).toHaveBeenCalledWith('https://example.org/path?q=1#top');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(s.announce).toHaveBeenCalledWith('Opening example.org in a new tab.');
  });

  it('Cancel opens nothing, and the safe choice has focus', async () => {
    const s = setup();
    s.follow(external('https://example.org/'));
    const dialog = await screen.findByRole('dialog');
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(s.open).not.toHaveBeenCalled();
  });

  it('"always allow this site" is off by default and lasts for this reader only', async () => {
    const s = setup();
    s.follow(external('https://example.org/a'));
    let dialog = await screen.findByRole('dialog');
    const always = within(dialog).getByRole<HTMLInputElement>('checkbox');
    expect(always.checked).toBe(false);
    expect(always.closest('label')?.textContent).toContain('example.org');
    await userEvent.click(always);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Open in a new tab' }));
    expect(s.open).toHaveBeenCalledTimes(1);

    // The same site is now followed without a question (the click is the person's act)...
    s.follow(external('https://example.org/b'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(s.open).toHaveBeenLastCalledWith('https://example.org/b');
    // ...another site, another scheme or another port still asks.
    for (const url of [
      'https://other.example/',
      'http://example.org/',
      'https://example.org:8443/',
    ]) {
      s.follow(external(url));
      dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByTestId('pdf-link-address').textContent).toBe(url);
      await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    }
    expect(s.open).toHaveBeenCalledTimes(2);
  });

  it('a long address is shown whole, as text', async () => {
    const s = setup();
    const long = `https://example.org/${'segment/'.repeat(100)}?q=<b>x</b>`;
    s.follow(external(long));
    const shown = (await screen.findByTestId('pdf-link-address')).textContent;
    expect(shown).toBe(new URL(long).href);
    expect(document.querySelector('dialog b')).toBeNull();
  });

  it('openInNewTab gives the new tab no opener and no referrer', () => {
    const spy = vi.spyOn(window, 'open').mockReturnValue(null);
    openInNewTab('https://example.org/');
    expect(spy).toHaveBeenCalledWith('https://example.org/', '_blank', 'noopener,noreferrer');
  });
});

describe('a link that is refused', () => {
  it('says why, opens nothing, and goes away on Dismiss', async () => {
    const s = setup();
    s.follow(
      refused('This link points to a "javascript:" address. StudyVault opens only web addresses.'),
    );
    const notice = await screen.findByRole('status');
    expect(within(notice).getByTestId('pdf-link-notice').textContent).toContain('"javascript:"');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(s.open).not.toHaveBeenCalled();
    await userEvent.click(within(notice).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('pdf-link-notice')).toBeNull();
  });

  it('a later link replaces the notice', async () => {
    const s = setup();
    s.follow(refused('first reason'));
    await screen.findByText('first reason');
    s.follow(page(7));
    await vi.waitFor(() => expect(s.handle.goToDestination).toHaveBeenCalled());
    expect(screen.queryByText('first reason')).toBeNull();
  });
});

describe('a place in the document, and Back', () => {
  it('goes there, moves focus, says so, and remembers where it came from', async () => {
    const s = setup();
    s.follow(page(7, 400));
    await vi.waitFor(() => expect(s.handle.goToDestination).toHaveBeenCalled());
    // top 400 on a 500-high page, left 72 on a 300-wide one, as fractions of the raw frame
    const [n, point] = (s.handle.goToDestination as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(n).toBe(7);
    expect(point.x).toBeCloseTo(72 / 300, 9);
    expect(point.y).toBeCloseTo(100 / 500, 9);
    expect(s.onPage).toHaveBeenCalledWith(7);
    expect(s.announce).toHaveBeenCalledWith('Went to page 7.');
    expect(screen.getByTestId('back-to').textContent).toBe('2');
  });

  it('Back returns to the exact place, one step at a time', async () => {
    const s = setup();
    (s.handle.position as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce({ page: 2, frac: 0.4 })
      .mockReturnValueOnce({ page: 7, frac: 0.1 });
    s.follow(page(7));
    await vi.waitFor(() => expect(s.announce).toHaveBeenCalledWith('Went to page 7.'));
    s.follow(page(11));
    await vi.waitFor(() => expect(s.announce).toHaveBeenCalledWith('Went to page 11.'));
    expect(screen.getByTestId('back-to').textContent).toBe('7');

    act(() => s.ctrl().back());
    expect(s.handle.restore).toHaveBeenLastCalledWith({ page: 7, frac: 0.1 });
    expect(s.announce).toHaveBeenLastCalledWith('Back on page 7.');
    expect(screen.getByTestId('back-to').textContent).toBe('2');

    act(() => s.ctrl().back());
    expect(s.handle.restore).toHaveBeenLastCalledWith({ page: 2, frac: 0.4 });
    expect(screen.getByTestId('back-to').textContent).toBe('null');
  });

  it('Alt+Left is Back, and with nothing to go back to it says so instead of leaving the reader', async () => {
    const s = setup();
    const empty = new KeyboardEvent('keydown', {
      key: 'ArrowLeft',
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      document.dispatchEvent(empty);
    });
    expect(empty.defaultPrevented).toBe(true);
    expect(s.announce).toHaveBeenLastCalledWith(
      'Nothing to go back to: no link has been followed yet.',
    );
    expect(s.handle.restore).not.toHaveBeenCalled();

    s.follow(page(5));
    await vi.waitFor(() => expect(s.handle.goToDestination).toHaveBeenCalled());
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, bubbles: true }),
      );
    });
    expect(s.handle.restore).toHaveBeenCalledWith({ page: 2, frac: 0.4 });

    // Plain Left (text caret, page scrolling) and Alt+Shift+Left are not Back.
    const plain = new KeyboardEvent('keydown', {
      key: 'ArrowLeft',
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      document.dispatchEvent(plain);
    });
    expect(plain.defaultPrevented).toBe(false);
  });

  it('a destination page that cannot be read is a notice, not a jump', async () => {
    const s = setup();
    s.doc.getPage.mockRejectedValueOnce(new Error('gone'));
    s.follow(page(99));
    await screen.findByTestId('pdf-link-notice');
    expect(s.handle.goToDestination).not.toHaveBeenCalled();
    expect(screen.getByTestId('back-to').textContent).toBe('null');
  });
});

describe('the Links list of the navigation pane', () => {
  const links = (n: number): PageLinks => ({
    links: [
      page(12),
      external('https://example.org/some/long/path'),
      refused('no'),
      ...Array.from({ length: n }, (_, i) => page(20 + i)),
    ],
    omitted: 0,
  });

  it('lists every link by its accessible name, and follows the one that is chosen', async () => {
    const onFollow = vi.fn();
    const data = links(2);
    render(<LinkList links={data} pageNumber={4} onFollow={onFollow} />);
    const list = screen.getByRole('list', { name: 'Links on this page' });
    const items = within(list).getAllByRole('button');
    expect(items).toHaveLength(5);
    expect(items[0]!.textContent).toBe('Link to page 12');
    expect(items[1]!.textContent).toContain('External link to example.org');
    expect(items[1]!.textContent).toContain('https://example.org/some/long/path');
    // Two lines for the eye, one sentence for the ear: "name · address".
    expect(items[1]!.textContent).toBe(
      'External link to example.org · https://example.org/some/long/path',
    );
    expect(items[2]!.textContent).toContain('will not be opened');
    await userEvent.click(items[1]!);
    expect(onFollow).toHaveBeenCalledWith(data.links[1]);
  });

  it('says so while reading, when the page has none, and when links were left out', () => {
    const { rerender } = render(<LinkList links={null} pageNumber={4} onFollow={vi.fn()} />);
    expect(screen.getByRole('status').textContent).toContain('Reading the links');
    rerender(<LinkList links={{ links: [], omitted: 0 }} pageNumber={4} onFollow={vi.fn()} />);
    expect(screen.getByTestId('pdf-links-empty').textContent).toBe('Page 4 has no links.');
    rerender(
      <LinkList links={{ links: [page(3)], omitted: 7 }} pageNumber={4} onFollow={vi.fn()} />,
    );
    expect(screen.getByText(/7 more links on this page are not listed/)).toBeTruthy();
  });
});

describe('the toolbar: Back, and the page box', () => {
  const mount = (over: Partial<Parameters<typeof Toolbar>[0]> = {}) => {
    const p = {
      page: 4,
      pageCount: 10,
      zoom: { kind: 'fit-width' as const },
      effectiveZoom: 1,
      search: {
        query: '',
        status: 'idle' as const,
        total: 0,
        current: -1,
        pagesDone: 0,
        pageCount: 10,
        truncated: false,
      },
      companionOpen: false,
      sidePaneOpen: false,
      highlightCount: 0,
      pageInput: createRef<HTMLInputElement>(),
      searchInput: createRef<HTMLInputElement>(),
      onGoToPage: vi.fn(),
      onZoom: vi.fn(),
      onRotate: vi.fn(),
      onQuery: vi.fn(),
      onFind: vi.fn(),
      onToggleCompanion: vi.fn(),
      onToggleSidePane: vi.fn(),
      ...over,
    };
    render(<Toolbar {...p} />);
    return p;
  };

  it('Back is unavailable, with its reason, until a link has been followed; then it names the page', async () => {
    const onBack = vi.fn();
    mount({ backTo: null, onBack });
    const idle = screen.getByTestId('pdf-back');
    expect(idle.getAttribute('aria-disabled')).toBe('true');
    expect(idle.getAttribute('title')).toBe('No link has been followed yet.');
    await userEvent.click(idle);
    expect(onBack).not.toHaveBeenCalled();

    cleanup();
    mount({ backTo: 7, onBack });
    const ready = screen.getByRole('button', { name: 'Back to page 7' });
    expect(ready.getAttribute('aria-disabled')).toBeNull();
    expect(ready.getAttribute('title')).toContain('Alt+Left');
    await userEvent.click(ready);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('has no Back button when nothing handles it', () => {
    mount();
    expect(screen.queryByTestId('pdf-back')).toBeNull();
  });

  it('leaving the page box untouched does not jump to the top of the page; leaving it after typing goes there', async () => {
    const p = mount();
    const box = screen.getByTestId('pdf-page-input');
    // Click into the document after scrolling within page 4: the box loses focus having been left alone.
    await userEvent.click(box);
    await userEvent.tab();
    expect(p.onGoToPage).not.toHaveBeenCalled();

    await userEvent.clear(box);
    await userEvent.type(box, '7');
    await userEvent.tab();
    expect(p.onGoToPage).toHaveBeenCalledTimes(1);
    expect(p.onGoToPage).toHaveBeenCalledWith(7);
  });
});
