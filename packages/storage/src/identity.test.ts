// @vitest-environment node
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { CaptureInput } from '@shared';
import { getDb, resetDbForTests } from './db';
import {
  createBank,
  getPageHighlights,
  listBanks,
  listRecentHighlights,
  saveCapture,
  wipeAllData,
} from './repo';
import { anchor, cap } from './test-fixtures';

async function counts() {
  const db = getDb();
  return {
    banks: await db.banks.count(),
    sources: await db.sources.count(),
    highlights: await db.highlights.count(),
    memberships: await db.highlightBanks.count(),
  };
}

beforeEach(async () => {
  await resetDbForTests();
  fakeBrowser.reset();
});

describe('page identity: a canonical must be the page itself', () => {
  const spaPage = (path: string, canonicalUrl: string | null = 'https://spa.example/') => ({
    url: `https://spa.example${path}`,
    canonicalUrl,
    title: `Route ${path}`,
  });

  it('keeps two routes that both declare the home page as canonical in two sources', async () => {
    await saveCapture(cap('Content of the first route', 10, { page: spaPage('/courses/1') }));
    await saveCapture(cap('Content of the second route', 10, { page: spaPage('/courses/2') }));
    expect((await counts()).sources).toBe(2);
    expect((await getDb().sources.toArray()).map((s) => s.canonicalUrl)).toEqual([null, null]);

    const first = await getPageHighlights('https://spa.example/courses/1', 'https://spa.example/');
    expect(first.highlights.map((h) => h.exactQuote)).toEqual(['Content of the first route']);
    const second = await getPageHighlights('https://spa.example/courses/2', 'https://spa.example/');
    expect(second.highlights.map((h) => h.exactQuote)).toEqual(['Content of the second route']);
    // The home page itself shares nothing with either route.
    expect(await getPageHighlights('https://spa.example/', 'https://spa.example/')).toEqual({
      sourceId: null,
      highlights: [],
    });
  });

  it('keeps paginated pages that declare page 1 apart from it and from each other', async () => {
    const listing = (query: string) => ({
      url: `https://shop.example/articles${query}`,
      canonicalUrl: 'https://shop.example/articles',
      title: 'Articles',
    });
    await saveCapture(cap('Item on page two', 10, { page: listing('?page=2') }));
    await saveCapture(cap('Item on page three', 10, { page: listing('?page=3') }));
    expect((await counts()).sources).toBe(2);
    expect(await getPageHighlights('https://shop.example/articles', null)).toEqual({
      sourceId: null,
      highlights: [],
    });
    const two = await getPageHighlights('https://shop.example/articles?page=2', null);
    expect(two.highlights.map((h) => h.exactQuote)).toEqual(['Item on page two']);
  });

  it('still joins the www. and bare spellings of one page that declare each other', async () => {
    await saveCapture(
      cap('Spelling quote text', 10, {
        page: {
          url: 'https://www.example.com/p',
          canonicalUrl: 'https://example.com/p',
          title: 'P',
        },
      }),
    );
    const bare = await getPageHighlights('https://example.com/p', null);
    expect(bare.highlights).toHaveLength(1);
    const again = await saveCapture(
      cap('Spelling quote text', 10, {
        page: { url: 'https://example.com/p', canonicalUrl: null, title: 'P' },
      }),
    );
    expect(again.status).toBe('duplicate');
    expect((await counts()).sources).toBe(1);
  });

  it('records the redacted address and title on the highlight and never rewrites them', async () => {
    const quote = 'Provenance quote text for the capture';
    const first = await saveCapture(
      cap(quote, 100, {
        page: {
          url: 'https://example.com/doc?id=5&token=SECRETTOKEN#frag',
          canonicalUrl: null,
          title: 'First title',
        },
      }),
    );
    const db = getDb();
    const row = (await db.highlights.get(first.highlight.id))!;
    expect(row.capturedUrl).toBe('https://example.com/doc?id=5');
    expect(row.capturedTitle).toBe('First title');
    expect(JSON.stringify(row)).not.toContain('SECRETTOKEN');

    const again = await saveCapture(
      cap(quote, 100, {
        page: {
          url: 'https://example.com/doc?id=5&utm_source=x',
          canonicalUrl: null,
          title: 'Second title',
        },
      }),
    );
    expect(again.status).toBe('duplicate');
    expect(await db.highlights.get(first.highlight.id)).toEqual(row);
  });
});

describe('duplicate detection across versions of a page', () => {
  const quote = 'Take with food to reduce gastric irritation.';
  const original = (over: Partial<CaptureInput> = {}) =>
    cap(quote, 500, { anchorSet: anchor(quote, 500, 'Aspirin: ', ' Avoid alcohol.'), ...over });
  /** The page was edited after the first capture: other signature and length. */
  const edited = (start: number, prefix: string, suffix: string) =>
    cap(quote, start, {
      anchorSet: {
        ...anchor(quote, start, prefix, suffix),
        contentSignature: 'edited-version',
        documentTextLength: 6400,
      },
    });

  it('does not let an overlapping offset in an edited page swallow a different occurrence', async () => {
    const first = await saveCapture(original());
    // Same sentence under another drug now sits at the old offsets.
    const second = await saveCapture(edited(500, 'Warfarin: ', ' Check the INR.'));
    expect(second.status).toBe('created');
    expect(second.highlight.id).not.toBe(first.highlight.id);
    expect((await counts()).highlights).toBe(2);
  });

  it('still recognises the same place in an edited page by matching context on one side', async () => {
    const first = await saveCapture(original());
    const moved = await saveCapture(edited(900, 'Aspirin: ', ' Added a new warning.'));
    expect(moved.status).toBe('duplicate');
    expect(moved.highlight.id).toBe(first.highlight.id);
    const otherSide = await saveCapture(edited(1300, 'Reworded lead: ', ' Avoid alcohol.'));
    expect(otherSide.status).toBe('duplicate');
    expect((await counts()).highlights).toBe(1);
  });

  it('keeps offset overlap as a duplicate within one version of the page', async () => {
    const first = await saveCapture(original());
    const again = await saveCapture(
      cap(quote, 510, { anchorSet: anchor(quote, 510, 'Different: ', ' other.') }),
    );
    expect(again.status).toBe('duplicate');
    expect(again.highlight.id).toBe(first.highlight.id);
  });

  it('does not link same-version occurrences that only share one side of the context', async () => {
    await saveCapture(original());
    const other = await saveCapture(
      cap(quote, 4000, { anchorSet: anchor(quote, 4000, 'Aspirin: ', ' Take care.') }),
    );
    expect(other.status).toBe('created');
  });
});

describe('createBank with a corrupt row present', () => {
  it('does not write a bank that fails validation when a row has a non-numeric position', async () => {
    await getDb().banks.put({ id: 'broken-bank-1', name: 'x', position: 'zzz' } as never);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bank = await createBank('Fresh');
    expect((await getDb().banks.get(bank.id))!.position).toBe(1);
    expect((await listBanks()).map((b) => b.id)).toContain(bank.id);
  });
});

describe('wipeAllData', () => {
  beforeEach(() => {
    // fakeBrowser has no permissions API: revoking is attempted, fails and is logged.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('deletes the database, clears local and session storage, and a later capture works', async () => {
    const before = await saveCapture(cap());
    await createBank('Cardiology');
    await fakeBrowser.storage.local.set({ settings: { theme: 'dark' } });
    await fakeBrowser.storage.session.set({ 'sv.pendingFocus': { highlightId: 'x', at: 1 } });
    const seen: unknown[] = [];
    fakeBrowser.storage.onChanged.addListener((changes) => {
      // clear() itself reports the removed token; only a real bump carries a new value.
      if (changes.dataEpoch?.newValue) seen.push(changes.dataEpoch.newValue);
    });

    await wipeAllData();

    expect(await fakeBrowser.storage.local.get('settings')).toEqual({});
    expect(await fakeBrowser.storage.session.get('sv.pendingFocus')).toEqual({});
    expect(seen).toHaveLength(1); // viewers are told to drop what they show
    expect(await listRecentHighlights(10)).toEqual([]);
    expect((await listBanks()).map((b) => b.name)).toEqual(['Inbox']);
    expect(await counts()).toEqual({ banks: 0, sources: 0, highlights: 0, memberships: 0 });

    const after = await saveCapture(cap());
    expect(after.status).toBe('created');
    expect(after.highlight.id).not.toBe(before.highlight.id);
    expect(await counts()).toEqual({ banks: 1, sources: 1, highlights: 1, memberships: 1 });
  });

  it('is repeatable on an empty database', async () => {
    await wipeAllData();
    await wipeAllData();
    expect((await saveCapture(cap())).status).toBe('created');
  });

  it('revokes the optional host permissions so the worker cannot re-register from them', async () => {
    const remove = vi.fn(async (_p: { origins?: string[] }) => true);
    Object.assign(browser, {
      permissions: {
        getAll: vi.fn(async () => ({ origins: ['https://a.example/*', 'https://*/*'] })),
        remove,
      },
    });
    try {
      await wipeAllData();
      expect(remove).toHaveBeenCalledWith({ origins: ['https://a.example/*', 'https://*/*'] });
    } finally {
      delete (browser as { permissions?: unknown }).permissions;
    }
  });

  it('still wipes when revoking permissions fails, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    Object.assign(browser, {
      permissions: {
        getAll: vi.fn(async () => ({ origins: ['https://a.example/*'] })),
        remove: vi.fn(async () => {
          throw new Error('policy');
        }),
      },
    });
    try {
      await saveCapture(cap());
      await wipeAllData();
      expect(await counts()).toEqual({ banks: 0, sources: 0, highlights: 0, memberships: 0 });
      expect(warn).toHaveBeenCalled();
    } finally {
      delete (browser as { permissions?: unknown }).permissions;
    }
  });
});
