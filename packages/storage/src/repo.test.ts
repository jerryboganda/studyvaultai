// @vitest-environment node
import 'fake-indexeddb/auto';
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { INBOX_BANK_ID, MAX_QUOTE_CHARS, type CaptureInput } from '@shared';
import { getDb, resetDbForTests } from './db';
import {
  createBank,
  getHighlightSource,
  getPageHighlights,
  listBanks,
  listBanksWithCounts,
  listPageHighlights,
  listRecentHighlights,
  reportResolutions,
  restoreHighlight,
  saveCapture,
  softDeleteHighlight,
  updateHighlight,
} from './repo';
import { anchor, cap } from './test-fixtures';

const epoch = async () =>
  ((await fakeBrowser.storage.local.get('dataEpoch')).dataEpoch as number | undefined) ?? 0;

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

describe('saveCapture', () => {
  it('creates source, highlight and Inbox membership and reads them back', async () => {
    const quote = 'Aspirin irreversibly inhibits cyclooxygenase.';
    const result = await saveCapture(cap(quote, 100));

    expect(result.status).toBe('created');
    expect(result.addedToBank).toBe(true);
    expect(result.bank).toEqual({
      id: INBOX_BANK_ID,
      name: 'Inbox',
      color: expect.any(String),
      isInbox: true,
    });
    expect(result.highlight).toMatchObject({
      exactQuote: quote,
      kind: 'essential',
      color: 'amber',
      priority: 3,
      headingContext: 'Antiplatelets',
      bankIds: [INBOX_BANK_ID],
      resolveStatus: 'unchecked',
      resolveConfidence: null,
    });
    expect(result.highlight.anchorSet.textQuote.exact).toBe(quote);

    const db = getDb();
    const row = (await db.highlights.toArray())[0]!;
    expect(row.normalizedQuote).toBe(quote.toLowerCase());
    expect(row.quoteHash).toBe(createHash('sha256').update(quote.toLowerCase()).digest('hex'));
    expect(row.schemaVersion).toBe(1);
    expect(row.deletedAt).toBeNull();
    expect(Date.parse(row.capturedAt)).not.toBeNaN();

    const source = (await db.sources.toArray())[0]!;
    expect(source).toMatchObject({
      type: 'web',
      host: 'example.com',
      title: 'Pharmacology notes',
      originalUrl: 'https://example.com/notes/pharm?utm_source=newsletter',
      urlKey: 'https://example.com/notes/pharm',
      visitedKey: 'https://example.com/notes/pharm',
      canonicalUrl: null,
    });
    expect(row.sourceId).toBe(source.id);
    expect(await counts()).toEqual({ banks: 1, sources: 1, highlights: 1, memberships: 1 });

    const page = await getPageHighlights('https://example.com/notes/pharm', null);
    expect(page.sourceId).toBe(source.id);
    expect(page.highlights).toEqual([result.highlight]);
  });

  it('files into a requested bank and falls back to the Inbox for unknown ids', async () => {
    const bank = await createBank('Cardiology');
    const filed = await saveCapture(cap('Quote one is here', 10, { bankId: bank.id }));
    expect(filed.bank.id).toBe(bank.id);
    expect(filed.highlight.bankIds).toEqual([bank.id]);

    const fallback = await saveCapture(
      cap('Quote two is here', 500, { bankId: 'no-such-bank-id' }),
    );
    expect(fallback.bank.id).toBe(INBOX_BANK_ID);
    expect(fallback.highlight.bankIds).toEqual([INBOX_BANK_ID]);
  });

  it('reports a repeat in the same bank as a duplicate and changes nothing', async () => {
    const first = await saveCapture(cap());
    const before = await counts();
    const epochBefore = await epoch();

    const again = await saveCapture(cap());
    expect(again.status).toBe('duplicate');
    expect(again.addedToBank).toBe(false);
    expect(again.highlight.id).toBe(first.highlight.id);
    expect(await counts()).toEqual(before);
    expect(await epoch()).toBe(epochBefore);
  });

  it('adds a membership exactly once when the duplicate targets another bank', async () => {
    const first = await saveCapture(cap());
    const other = await createBank('Pharmacology');

    const filed = await saveCapture(cap(undefined, undefined, { bankId: other.id }));
    expect(filed.status).toBe('duplicate');
    expect(filed.addedToBank).toBe(true);
    expect(filed.highlight.id).toBe(first.highlight.id);
    expect(filed.highlight.bankIds).toEqual([INBOX_BANK_ID, other.id]);

    const repeat = await saveCapture(cap(undefined, undefined, { bankId: other.id }));
    expect(repeat.status).toBe('duplicate');
    expect(repeat.addedToBank).toBe(false);
    expect((await counts()).memberships).toBe(2);
    expect((await counts()).highlights).toBe(1);
  });

  it('treats cosmetic differences (case, whitespace) at the same place as a duplicate', async () => {
    const first = await saveCapture(cap('Heart failure   is common', 200));
    const again = await saveCapture(cap('heart failure is common', 200));
    expect(again.status).toBe('duplicate');
    expect(again.highlight.id).toBe(first.highlight.id);
  });

  it('restores a soft-deleted duplicate instead of creating a new highlight', async () => {
    const first = await saveCapture(cap());
    await softDeleteHighlight(first.highlight.id);
    expect((await getPageHighlights('https://example.com/notes/pharm', null)).highlights).toEqual(
      [],
    );

    const again = await saveCapture(cap());
    expect(again.status).toBe('restored');
    expect(again.highlight.id).toBe(first.highlight.id);
    expect(again.addedToBank).toBe(false);
    expect((await counts()).highlights).toBe(1);
    expect(
      (await getPageHighlights('https://example.com/notes/pharm', null)).highlights,
    ).toHaveLength(1);
  });

  it('does not treat the same quote at a different place and context as a duplicate', async () => {
    const quote = 'Figure 1 shows the pathway';
    const a = await saveCapture(cap(quote, 100));
    const b = await saveCapture(
      cap(quote, 5000, { anchorSet: anchor(quote, 5000, 'other lead ', ' other tail') }),
    );
    expect(a.status).toBe('created');
    expect(b.status).toBe('created');
    expect(b.highlight.id).not.toBe(a.highlight.id);
    expect((await counts()).highlights).toBe(2);
  });

  it('treats a disjoint position with identical surrounding context as a duplicate', async () => {
    const a = await saveCapture(cap('Repeated boilerplate sentence', 100));
    const b = await saveCapture(cap('Repeated boilerplate sentence', 5000));
    expect(b.status).toBe('duplicate');
    expect(b.highlight.id).toBe(a.highlight.id);
  });

  it('treats touching but non-overlapping ranges with different context as separate', async () => {
    const a = await saveCapture(cap('abab', 100, { anchorSet: anchor('abab', 100, 'x', 'y') }));
    const b = await saveCapture(cap('abab', 104, { anchorSet: anchor('abab', 104, 'p', 'q') }));
    expect(a.highlight.id).not.toBe(b.highlight.id);
  });

  it('keeps one source for tracking-param variants and a trusted canonical', async () => {
    await saveCapture(cap('First quote text', 10));
    await saveCapture(
      cap('Second quote text', 400, {
        page: {
          url: 'https://example.com/notes/pharm/?fbclid=zzz#section',
          canonicalUrl: 'https://example.com/notes/pharm',
          title: 'Pharmacology notes',
        },
      }),
    );
    expect((await counts()).sources).toBe(1);
  });

  it('records a trusted canonical on the source and ignores a cross-host one', async () => {
    await saveCapture(
      cap('Canonical quote', 10, {
        page: {
          url: 'https://www.example.com/p?id=2',
          canonicalUrl: 'https://example.com/p?id=2',
          title: 'T',
        },
      }),
    );
    await saveCapture(
      cap('Hostile canonical quote', 10, {
        page: { url: 'https://other.test/a', canonicalUrl: 'https://victim.test/x', title: 'T' },
      }),
    );
    const sources = await getDb().sources.toArray();
    const byHost = Object.fromEntries(sources.map((s) => [s.host, s]));
    expect(byHost['www.example.com']).toMatchObject({
      urlKey: 'https://example.com/p?id=2',
      visitedKey: 'https://www.example.com/p?id=2',
      canonicalUrl: 'https://example.com/p?id=2',
    });
    expect(byHost['other.test']).toMatchObject({
      urlKey: 'https://other.test/a',
      canonicalUrl: null,
    });
  });

  it('refuses invalid input with invalid_request and writes nothing', async () => {
    const bad = { ...cap(), exactQuote: '' } as CaptureInput;
    await expect(saveCapture(bad)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(saveCapture({ ...cap(), exactQuote: '   \n\t ' })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(
      saveCapture({
        ...cap(),
        page: { url: 'ftp://example.com/a', canonicalUrl: null, title: 't' },
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(await counts()).toEqual({ banks: 0, sources: 0, highlights: 0, memberships: 0 });
  });

  it('stores quotes whose NFKC form is longer than the schema limit and still reads them back', async () => {
    // U+FB03 expands to "ffi": 4000 chars -> 12000 normalised chars.
    const quote = 'ﬃ'.repeat(4000);
    const result = await saveCapture(cap(quote, 10));
    expect(result.status).toBe('created');
    const row = (await getDb().highlights.toArray())[0]!;
    expect(row.normalizedQuote).toHaveLength(MAX_QUOTE_CHARS);
    expect(
      (await getPageHighlights('https://example.com/notes/pharm', null)).highlights,
    ).toHaveLength(1);
  });
});

describe('Inbox and concurrency', () => {
  it('creates exactly one Inbox and N distinct highlights under 20 concurrent saves', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        saveCapture(cap(`Distinct concurrent quote number ${i}`, i * 300)),
      ),
    );
    expect(results.every((r) => r.status === 'created')).toBe(true);
    expect(new Set(results.map((r) => r.highlight.id)).size).toBe(20);

    const db = getDb();
    const banks = await db.banks.toArray();
    expect(banks).toHaveLength(1);
    expect(banks[0]).toMatchObject({ id: INBOX_BANK_ID, isInbox: true });
    expect(await db.sources.count()).toBe(1);
    expect(await db.highlights.count()).toBe(20);
    expect(await db.highlightBanks.count()).toBe(20);
  });

  it('collapses 20 concurrent identical saves into one highlight', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => saveCapture(cap())));
    expect(results.filter((r) => r.status === 'created')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'duplicate')).toHaveLength(19);
    expect(await counts()).toEqual({ banks: 1, sources: 1, highlights: 1, memberships: 1 });
  });

  it('keeps a single Inbox when saves and bank creation race', async () => {
    await Promise.all([
      saveCapture(cap('Racing quote one', 0)),
      createBank('Racing bank'),
      saveCapture(cap('Racing quote two', 400)),
      listBanks(),
    ]);
    const banks = await getDb().banks.toArray();
    expect(banks.filter((b) => b.isInbox)).toHaveLength(1);
    expect(banks).toHaveLength(2);
  });
});

describe('transaction atomicity and error mapping', () => {
  it('leaves no source, membership or Inbox rows when the highlight write fails', async () => {
    const db = getDb();
    const boom = () => {
      throw new Error('injected highlight failure');
    };
    db.highlights.hook('creating', boom);
    try {
      await expect(saveCapture(cap())).rejects.toMatchObject({
        code: 'internal',
        message: expect.stringContaining('injected highlight failure'),
      });
    } finally {
      db.highlights.hook('creating').unsubscribe(boom);
    }
    expect(await counts()).toEqual({ banks: 0, sources: 0, highlights: 0, memberships: 0 });
    expect(await epoch()).toBe(0);

    // The database is still usable afterwards.
    expect((await saveCapture(cap())).status).toBe('created');
    expect(await counts()).toEqual({ banks: 1, sources: 1, highlights: 1, memberships: 1 });
  });

  it('maps a quota failure to quota_exceeded', async () => {
    const db = getDb();
    const full = () => {
      throw new DOMException('disk full', 'QuotaExceededError');
    };
    db.highlights.hook('creating', full);
    try {
      await expect(saveCapture(cap())).rejects.toMatchObject({ code: 'quota_exceeded' });
    } finally {
      db.highlights.hook('creating').unsubscribe(full);
    }
    expect((await counts()).sources).toBe(0);
  });
});

describe('page lookup by urlKey and visitedKey', () => {
  const canonical = 'https://example.com/post?a=1&b=2';

  beforeEach(async () => {
    await saveCapture(
      cap('Quote on the canonical page', 50, {
        page: {
          url: 'https://www.example.com/post/?b=2&utm_campaign=x&a=1#intro',
          canonicalUrl: canonical,
          title: 'Post',
        },
      }),
    );
  });

  it('finds it by the same visited URL with different tracking params and order', async () => {
    const found = await getPageHighlights('https://www.example.com/post?a=1&fbclid=Z&b=2', null);
    expect(found.sourceId).not.toBeNull();
    expect(found.highlights).toHaveLength(1);
  });

  it('finds it from another URL that declares the same canonical', async () => {
    const found = await getPageHighlights('https://example.com/post?a=1&b=2&ref=home', canonical);
    expect(found.highlights).toHaveLength(1);
  });

  it('finds it by visiting the canonical URL directly', async () => {
    expect((await getPageHighlights(canonical, null)).highlights).toHaveLength(1);
  });

  it('ignores a canonical on another host and unrelated pages', async () => {
    expect(
      (await getPageHighlights('https://evil.test/landing', 'https://example.com/post?a=1&b=2'))
        .highlights,
    ).toEqual([]);
    const other = await getPageHighlights('https://example.com/other', null);
    expect(other).toEqual({ sourceId: null, highlights: [] });
  });

  it('does not alias a page to a hostile cross-host canonical when saving', async () => {
    await saveCapture(
      cap('Hostile page quote', 10, {
        page: { url: 'https://a.test/p', canonicalUrl: 'https://b.test/q', title: 'Hostile' },
      }),
    );
    expect((await getPageHighlights('https://b.test/q', null)).highlights).toEqual([]);
    expect((await getPageHighlights('https://a.test/p', null)).highlights).toHaveLength(1);
  });

  it('returns an empty answer for non-http pages instead of failing', async () => {
    expect(await getPageHighlights('chrome://extensions', null)).toEqual({
      sourceId: null,
      highlights: [],
    });
    expect(await listPageHighlights('about:blank', null)).toEqual([]);
  });

  it('orders page highlights in document order and joins source and banks in list items', async () => {
    const bank = await createBank('Late');
    const page = {
      url: 'https://example.com/post?a=1&b=2',
      canonicalUrl: canonical,
      title: 'Post',
    };
    await saveCapture(cap('Late quote text', 900, { page, bankId: bank.id }));
    await saveCapture(cap('Early quote text', 5, { page }));

    const items = await listPageHighlights(canonical, null);
    expect(items.map((i) => i.highlight.exactQuote)).toEqual([
      'Early quote text',
      'Quote on the canonical page',
      'Late quote text',
    ]);
    const late = items[2]!;
    expect(late.banks.map((b) => b.name)).toEqual(['Late']);
    expect(late.source).toMatchObject({
      host: 'www.example.com',
      urlKey: canonical,
      canonicalUrl: canonical,
    });
    expect(Object.keys(late.source).sort()).toEqual(
      ['canonicalUrl', 'host', 'id', 'originalUrl', 'title', 'urlKey'].sort(),
    );
  });
});

describe('updateHighlight / delete / restore', () => {
  it('applies a patch, keeps provenance and bumps updatedAt', async () => {
    const saved = await saveCapture(cap());
    const db = getDb();
    const before = (await db.highlights.get(saved.highlight.id))!;

    const view = await updateHighlight(saved.highlight.id, {
      color: 'blue',
      kind: 'formula',
      priority: 5,
      userComment: 'remember the irreversible part',
    });
    expect(view).toMatchObject({
      color: 'blue',
      kind: 'formula',
      priority: 5,
      userComment: 'remember the irreversible part',
      exactQuote: saved.highlight.exactQuote,
    });
    const after = (await db.highlights.get(saved.highlight.id))!;
    expect(after.exactQuote).toBe(before.exactQuote);
    expect(after.anchorSet).toEqual(before.anchorSet);
    expect(after.quoteHash).toBe(before.quoteHash);
    expect(after.updatedAt >= before.updatedAt).toBe(true);
  });

  it('rejects patches that touch immutable provenance fields', async () => {
    const saved = await saveCapture(cap());
    const row = (await getDb().highlights.get(saved.highlight.id))!;
    for (const patch of [
      { exactQuote: 'tampered' },
      { anchorSet: anchor('tampered', 1) },
      { sourceId: 'another-source' },
    ]) {
      await expect(updateHighlight(saved.highlight.id, patch as never)).rejects.toMatchObject({
        code: 'invalid_request',
      });
    }
    expect(await getDb().highlights.get(saved.highlight.id)).toEqual(row);
  });

  it('treats an empty or unchanged patch as a no-op without notifying', async () => {
    const saved = await saveCapture(cap());
    const epochBefore = await epoch();
    const row = (await getDb().highlights.get(saved.highlight.id))!;
    expect(await updateHighlight(saved.highlight.id, {})).toEqual(saved.highlight);
    expect(await updateHighlight(saved.highlight.id, { color: 'amber' })).toEqual(saved.highlight);
    expect(await getDb().highlights.get(saved.highlight.id)).toEqual(row);
    expect(await epoch()).toBe(epochBefore);
  });

  it('rejects out-of-range values', async () => {
    const saved = await saveCapture(cap());
    await expect(
      updateHighlight(saved.highlight.id, { priority: 9 as never }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('throws not_found for unknown and soft-deleted ids', async () => {
    const saved = await saveCapture(cap());
    await expect(updateHighlight('unknown-id-123', { color: 'red' })).rejects.toMatchObject({
      code: 'not_found',
    });
    await softDeleteHighlight(saved.highlight.id);
    await expect(updateHighlight(saved.highlight.id, { color: 'red' })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('soft delete is idempotent and unknown ids are not_found', async () => {
    const saved = await saveCapture(cap());
    await softDeleteHighlight(saved.highlight.id);
    const row = (await getDb().highlights.get(saved.highlight.id))!;
    expect(row.deletedAt).not.toBeNull();
    const epochAfterFirst = await epoch();

    await softDeleteHighlight(saved.highlight.id);
    expect(await getDb().highlights.get(saved.highlight.id)).toEqual(row);
    expect(await epoch()).toBe(epochAfterFirst);

    await expect(softDeleteHighlight('unknown-id-123')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('restoreHighlight undeletes, is a no-op for live rows and fails for unknown ids', async () => {
    const saved = await saveCapture(cap());
    await softDeleteHighlight(saved.highlight.id);

    const restored = await restoreHighlight(saved.highlight.id);
    expect(restored).toEqual(saved.highlight);
    expect((await getDb().highlights.get(saved.highlight.id))!.deletedAt).toBeNull();

    const epochBefore = await epoch();
    expect(await restoreHighlight(saved.highlight.id)).toEqual(saved.highlight);
    expect(await epoch()).toBe(epochBefore);

    await expect(restoreHighlight('unknown-id-123')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('reportResolutions', () => {
  it('persists outcomes, skips unknown and deleted ids and reports the updated count', async () => {
    const a = await saveCapture(cap('Resolution quote A', 10));
    const b = await saveCapture(cap('Resolution quote B', 400));
    const gone = await saveCapture(cap('Resolution quote C', 800));
    await softDeleteHighlight(gone.highlight.id);

    const updated = await reportResolutions([
      { id: a.highlight.id, status: 'resolved', confidence: 1 },
      { id: b.highlight.id, status: 'changed', confidence: 0.9 },
      { id: gone.highlight.id, status: 'orphaned', confidence: null },
      { id: 'not-a-real-id', status: 'resolved', confidence: 1 },
    ]);
    expect(updated).toBe(2);

    const db = getDb();
    expect(await db.highlights.get(a.highlight.id)).toMatchObject({
      resolveStatus: 'resolved',
      resolveConfidence: 1,
      lastResolvedAt: expect.any(String),
    });
    expect(await db.highlights.get(b.highlight.id)).toMatchObject({
      resolveStatus: 'changed',
      resolveConfidence: 0.9,
    });
    expect(await db.highlights.get(gone.highlight.id)).toMatchObject({
      resolveStatus: 'unchecked',
      lastResolvedAt: null,
    });
    expect(await db.highlights.count()).toBe(3);
  });

  it('handles an empty report and rejects malformed items', async () => {
    expect(await reportResolutions([])).toBe(0);
    await expect(
      reportResolutions([{ id: 'abcdefgh', status: 'resolved', confidence: 2 }]),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('only notifies other contexts when an outcome actually changed', async () => {
    const saved = await saveCapture(cap());
    await reportResolutions([{ id: saved.highlight.id, status: 'resolved', confidence: 1 }]);
    const afterChange = await epoch();

    expect(
      await reportResolutions([{ id: saved.highlight.id, status: 'resolved', confidence: 1 }]),
    ).toBe(1);
    expect(await epoch()).toBe(afterChange);

    await reportResolutions([{ id: saved.highlight.id, status: 'ambiguous', confidence: 0.4 }]);
    expect(await epoch()).toBe(afterChange + 1);
  });
});

describe('visibility of soft-deleted rows', () => {
  it('excludes them from every read', async () => {
    const keep = await saveCapture(cap('Kept quote', 10));
    const drop = await saveCapture(cap('Dropped quote', 400));
    await softDeleteHighlight(drop.highlight.id);

    const url = 'https://example.com/notes/pharm';
    expect((await getPageHighlights(url, null)).highlights.map((h) => h.id)).toEqual([
      keep.highlight.id,
    ]);
    expect((await listPageHighlights(url, null)).map((i) => i.highlight.id)).toEqual([
      keep.highlight.id,
    ]);
    expect((await listRecentHighlights(10)).map((i) => i.highlight.id)).toEqual([
      keep.highlight.id,
    ]);
    expect(await getHighlightSource(drop.highlight.id)).toBeNull();
    expect(await getHighlightSource(keep.highlight.id)).toEqual({
      sourceId: keep.highlight.sourceId,
      urlKey: 'https://example.com/notes/pharm',
      visitedKey: 'https://example.com/notes/pharm',
    });
    expect(await getHighlightSource('unknown-id-123')).toBeNull();
    const inbox = (await listBanksWithCounts()).find((b) => b.bank.id === INBOX_BANK_ID)!;
    expect(inbox.count).toBe(1);
  });
});

describe('banks', () => {
  it('lists a virtual Inbox on an empty database without writing', async () => {
    expect(await listBanks()).toEqual([
      { id: INBOX_BANK_ID, name: 'Inbox', color: expect.any(String), isInbox: true },
    ]);
    expect(await listBanksWithCounts()).toEqual([
      { bank: expect.objectContaining({ id: INBOX_BANK_ID }), count: 0 },
    ]);
    expect(await counts()).toEqual({ banks: 0, sources: 0, highlights: 0, memberships: 0 });
    expect(await epoch()).toBe(0);
  });

  it('creates ordered banks with trimmed names, the Inbox first', async () => {
    const first = await createBank('  Cardiology  ');
    const second = await createBank('Renal');
    expect(first.name).toBe('Cardiology');
    expect(first.isInbox).toBe(false);
    expect(first.id).not.toBe(second.id);

    expect((await listBanks()).map((b) => b.name)).toEqual(['Inbox', 'Cardiology', 'Renal']);
    const rows = await getDb().banks.toArray();
    expect(rows.filter((b) => b.isInbox)).toHaveLength(1);
    expect(rows.map((b) => b.position).sort()).toEqual([0, 1, 2]);
  });

  it('rejects empty and over-long names', async () => {
    await expect(createBank('   ')).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(createBank('x'.repeat(81))).rejects.toMatchObject({ code: 'invalid_request' });
    expect((await counts()).banks).toBe(0);
  });

  it('counts live highlights per bank, counting multi-bank highlights in each', async () => {
    const cardio = await createBank('Cardiology');
    const renal = await createBank('Renal');
    await saveCapture(cap('Inbox only quote', 10));
    const both = await saveCapture(cap('Shared quote text', 400, { bankId: cardio.id }));
    await saveCapture(cap('Shared quote text', 400, { bankId: renal.id }));
    const doomed = await saveCapture(cap('Doomed quote text', 800, { bankId: renal.id }));
    await softDeleteHighlight(doomed.highlight.id);

    const result = await listBanksWithCounts();
    expect(result.map((r) => [r.bank.name, r.count])).toEqual([
      ['Inbox', 1],
      ['Cardiology', 1],
      ['Renal', 1],
    ]);
    expect(both.highlight.bankIds).toEqual([cardio.id]);
  });

  it('lists recent highlights newest first and honours the limit', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push((await saveCapture(cap(`Ordered quote ${i}`, i * 300))).highlight.id);
    }
    const recent = await listRecentHighlights(3);
    expect(recent.map((i) => i.highlight.id)).toEqual([ids[4], ids[3], ids[2]]);
    expect(recent[0]!.banks).toEqual([expect.objectContaining({ id: INBOX_BANK_ID })]);
    expect(await listRecentHighlights(0)).toEqual([]);
    await expect(listRecentHighlights(-1)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(await listRecentHighlights(100)).toHaveLength(5);
  });
});

describe('corrupt rows', () => {
  it('skips zod-invalid highlight rows with a warning instead of failing the list', async () => {
    const good = await saveCapture(cap('Healthy quote text', 10));
    const bad = await saveCapture(cap('Corrupted quote text', 400));
    const db = getDb();
    const row = (await db.highlights.get(bad.highlight.id))!;
    await db.highlights.put({ ...row, color: 'chartreuse' } as never);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const url = 'https://example.com/notes/pharm';
    expect((await getPageHighlights(url, null)).highlights.map((h) => h.id)).toEqual([
      good.highlight.id,
    ]);
    expect((await listPageHighlights(url, null)).map((i) => i.highlight.id)).toEqual([
      good.highlight.id,
    ]);
    expect((await listRecentHighlights(10)).map((i) => i.highlight.id)).toEqual([
      good.highlight.id,
    ]);
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.some((c) => String(c[0]).includes('invalid highlight row'))).toBe(true);
    await expect(updateHighlight(bad.highlight.id, { color: 'red' })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('skips invalid bank rows and keeps the virtual Inbox available', async () => {
    const db = getDb();
    await db.banks.put({ id: 'broken-bank-1', name: '', position: 'x' } as never);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await listBanks()).map((b) => b.id)).toEqual([INBOX_BANK_ID]);
    expect(warn).toHaveBeenCalled();
    // A capture still succeeds and persists a real Inbox.
    expect((await saveCapture(cap())).bank.id).toBe(INBOX_BANK_ID);
  });

  it('repairs a deleted Inbox on the next capture', async () => {
    await saveCapture(cap('First quote text', 10));
    const db = getDb();
    await db.banks.update(INBOX_BANK_ID, { deletedAt: new Date().toISOString() });
    expect((await listBanks()).find((b) => b.id === INBOX_BANK_ID)).toBeDefined();
    const result = await saveCapture(cap('Second quote text', 400));
    expect(result.bank.id).toBe(INBOX_BANK_ID);
    expect((await db.banks.get(INBOX_BANK_ID))!.deletedAt).toBeNull();
    expect(await db.banks.count()).toBe(1);
  });
});

describe('data epoch', () => {
  it('is bumped once per successful mutation and never by reads', async () => {
    expect(await epoch()).toBe(0);

    const saved = await saveCapture(cap());
    expect(await epoch()).toBe(1);

    await getPageHighlights('https://example.com/notes/pharm', null);
    await listRecentHighlights(5);
    await listBanks();
    await listBanksWithCounts();
    expect(await epoch()).toBe(1);

    await updateHighlight(saved.highlight.id, { color: 'green' });
    expect(await epoch()).toBe(2);
    await softDeleteHighlight(saved.highlight.id);
    expect(await epoch()).toBe(3);
    await restoreHighlight(saved.highlight.id);
    expect(await epoch()).toBe(4);
    await createBank('Another');
    expect(await epoch()).toBe(5);
  });

  it('yields distinct values for concurrent mutations', async () => {
    await Promise.all(
      Array.from({ length: 5 }, (_, i) => saveCapture(cap(`Epoch quote number ${i}`, i * 300))),
    );
    expect(await epoch()).toBe(5);
  });

  it('never fails a committed write when the notification fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(fakeBrowser.storage.local, 'set').mockRejectedValue(new Error('storage down'));
    const result = await saveCapture(cap());
    expect(result.status).toBe('created');
    expect(await counts()).toEqual({ banks: 1, sources: 1, highlights: 1, memberships: 1 });
  });
});
