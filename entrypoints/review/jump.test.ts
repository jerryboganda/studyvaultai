import { describe, expect, it, vi } from 'vitest';
import { openSource, type JumpDeps } from './jump';

const deps = (over: Partial<JumpDeps> = {}): JumpDeps => ({
  createTab: vi.fn(async () => ({ id: 7 })),
  waitForLoad: vi.fn(async () => true),
  reveal: vi.fn(async () => true),
  extensionUrl: (p) => `chrome-extension://abc/${p}`,
  sleep: vi.fn(async () => undefined),
  ...over,
});

const WEB = {
  highlightId: 'hl-00000001',
  jump: { kind: 'web' as const, url: 'https://example.com/notes#x' },
};

describe('openSource', () => {
  it('opens the PDF reader at the document, page and highlight', async () => {
    const d = deps();
    const out = await openSource(
      {
        highlightId: 'hl-00000001',
        jump: {
          kind: 'pdf',
          documentId: 'a'.repeat(64),
          pageNumber: 7,
          highlightId: 'hl-00000001',
        },
      },
      d,
    );
    expect(out).toMatchObject({ ok: true, scrolled: true });
    const url = (d.createTab as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(url).toBe(
      `chrome-extension://abc/pdf-reader.html?doc=${'a'.repeat(64)}&page=7&highlight=hl-00000001`,
    );
  });

  it('opens a web page and scrolls to the passage when the content script answers', async () => {
    const d = deps();
    const out = await openSource(WEB, d);
    expect(out).toEqual({
      ok: true,
      scrolled: true,
      message: 'Opened the source and showed the passage.',
    });
    expect(d.reveal).toHaveBeenCalledWith(7, 'hl-00000001');
  });

  it('says so when StudyVault is not active on that site, after bounded retries', async () => {
    const d = deps({ reveal: vi.fn(async () => Promise.reject(new Error('no receiver'))) });
    const out = await openSource(WEB, d);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.scrolled).toBe(false);
      expect(out.message).toMatch(/could not show the passage/);
    }
    expect(d.reveal).toHaveBeenCalledTimes(4);
  });

  it('does not wait forever for a page that never finishes loading', async () => {
    const d = deps({ waitForLoad: vi.fn(async () => false) });
    const out = await openSource(WEB, d);
    expect(out).toMatchObject({ ok: true, scrolled: false });
    expect(d.reveal).not.toHaveBeenCalled();
  });

  it('refuses an address that is not http(s), and a card with no source', async () => {
    const d = deps();
    const bad = await openSource(
      { highlightId: 'hl-00000001', jump: { kind: 'web', url: 'javascript:alert(1)' } },
      d,
    );
    expect(bad.ok).toBe(false);
    expect(d.createTab).not.toHaveBeenCalled();
    const none = await openSource({ highlightId: null, jump: null }, d);
    expect(none).toMatchObject({ ok: false });
    expect(none.message).toMatch(/no linked source/);
  });

  it('reports a tab that could not be created', async () => {
    const d = deps({ createTab: vi.fn(async () => Promise.reject(new Error('blocked'))) });
    const out = await openSource(WEB, d);
    expect(out).toMatchObject({ ok: false });
    expect(out.message).toMatch(/blocked/);
  });
});
