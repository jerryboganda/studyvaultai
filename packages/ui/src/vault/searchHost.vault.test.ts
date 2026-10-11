import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { exportBackup, restoreBackup } from '@backup';
import {
  BACKUP_MIGRATIONS,
  createBackupTarget,
  createNote,
  createSnapshotSource,
  createTag,
  emptyTrash,
  getDb,
  getLastPurgeAt,
  listSearchDocuments,
  listSearchDocumentsChangedSince,
  resetDbForTests,
  saveCapture,
  softDeleteHighlight,
  wipeAllData,
} from '@storage';
import type { CaptureInput } from '@shared';
import {
  INDEX_KEY,
  INDEX_STALE_KEY,
  INDEX_STATE_KEY,
  SearchHost,
  type SearchHostPorts,
} from './searchHost';

/**
 * The search host against the real vault (the seam between @ui and @storage): the stand-in
 * address, standalone notes, purges and backup restores as the vault actually reports them.
 */

const cap = (exact: string, start: number): CaptureInput => ({
  page: { url: 'https://example.com/notes', canonicalUrl: null, title: 'Notes' },
  exactQuote: exact,
  anchorSet: {
    type: 'html',
    textAlgorithm: 'sv-text-v1',
    textQuote: { exact, prefix: 'lead-in ', suffix: ' trailing' },
    textPosition: { start, end: start + exact.length },
    structuralPath: null,
    contentSignature: 'abc123',
    documentTextLength: 6000,
  },
  headingContext: null,
  kind: 'essential',
  color: 'amber',
  bankId: null,
  userComment: '',
  priority: 3,
  captureMethod: 'toolbar',
});

function realPorts(): SearchHostPorts {
  return {
    listAll: (o) => listSearchDocuments(o),
    listChangedSince: (o) => listSearchDocumentsChangedSince(o),
    getLastPurgeAt: () => getLastPurgeAt(),
    meta: {
      get: async (key) => (await getDb().meta.get(key))?.value,
      put: async (key, value) => {
        await getDb().meta.put({ key, value, updatedAt: new Date().toISOString() });
      },
      delete: async (key) => {
        await getDb().meta.delete(key);
      },
    },
  };
}

const hosts: SearchHost[] = [];
async function open(): Promise<{ host: SearchHost; reasons: string[] }> {
  const host = new SearchHost(realPorts());
  hosts.push(host);
  const reasons: string[] = [];
  host.subscribe(() => {
    if (host.state.phase === 'building') reasons.push(host.state.reason);
  });
  await host.start();
  return { host, reasons };
}

beforeEach(async () => {
  await resetDbForTests();
  fakeBrowser.reset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  for (const h of hosts.splice(0)) h.dispose();
});

describe('SearchHost over the real vault', () => {
  it('indexes a standalone note (null kind, priority, status) and reports nothing rejected', async () => {
    await saveCapture(cap('Mitochondria produce ATP.', 100));
    await createNote({ body: 'Free standing note about ribosomes' });

    const { host } = await open();

    expect(host.state).toMatchObject({ phase: 'ready', documents: 2, rejected: 0 });
    expect(host.search('ribosomes').total).toBe(1);
    expect(host.search('ribosomes').hits[0]!.doc).toMatchObject({ kind: '', priority: 0 });
  });

  it('rebuilds after a purge, which leaves no row to report', async () => {
    const keep = await saveCapture(cap('Mitochondria produce ATP.', 100));
    const gone = await saveCapture(cap('Ribosomes make proteins.', 400));
    const first = await open();
    await first.host.flush();
    first.host.dispose();
    expect(first.host.search('ribosomes').total).toBe(1);

    await softDeleteHighlight(gone.highlight.id);
    await emptyTrash();
    expect(await getLastPurgeAt()).not.toBeNull();

    const second = await open();
    expect(second.reasons[0]).toBe('purge');
    expect(second.host.search('ribosomes', { includeDeleted: true }).total).toBe(0);
    expect(second.host.search('mitochondria').hits.map((h) => h.id)).toEqual([keep.highlight.id]);
  });

  it('rebuilds after a backup restore wrote its generation, and records it in the cache', async () => {
    await saveCapture(cap('Mitochondria produce ATP.', 100));
    const backup = await exportBackup(await createSnapshotSource(), { appVersion: 'test' });
    await saveCapture(cap('Ribosomes make proteins.', 400));
    const before = await open();
    await before.host.flush();
    before.host.dispose();
    expect(before.host.search('ribosomes').total).toBe(1);

    await restoreBackup(backup.bytes, {
      target: createBackupTarget(),
      mode: 'replace',
      migrations: BACKUP_MIGRATIONS,
    });
    // the restore itself wrote the generation the host reads
    const generation = (await getDb().meta.get(INDEX_STALE_KEY))?.value;
    expect(generation).toEqual(expect.any(String));

    const after = await open();
    expect(after.reasons[0]).toBe('restore');
    expect(after.host.search('ribosomes').total).toBe(0);
    expect(after.host.search('mitochondria').total).toBe(1);
    await after.host.flush();
    // never consumed: any other open host compares against it
    expect((await getDb().meta.get(INDEX_STALE_KEY))?.value).toBe(generation);
    expect((await getDb().meta.get(INDEX_STATE_KEY))?.value).toMatchObject({ generation });

    const third = await open();
    expect(third.reasons).toEqual([]);
    expect(third.host.search('mitochondria').total).toBe(1);
  });

  it('a second open page converges after a restore, whichever page rebuilt first', async () => {
    await saveCapture(cap('Mitochondria produce ATP.', 100));
    const backup = await exportBackup(await createSnapshotSource(), { appVersion: 'test' });
    await saveCapture(cap('Warfarin interacts with vitamin K.', 400));
    const panel = (await open()).host;
    const dashboard = (await open()).host;
    expect(dashboard.search('warfarin').total).toBe(1);

    await restoreBackup(backup.bytes, {
      target: createBackupTarget(),
      mode: 'replace',
      migrations: BACKUP_MIGRATIONS,
    });

    panel.reconcileSoon();
    await vi.waitFor(() => expect(panel.search('warfarin').total).toBe(0));
    await panel.flush();
    dashboard.reconcileSoon();
    await vi.waitFor(() => expect(dashboard.search('warfarin').total).toBe(0));
    expect(dashboard.state).toMatchObject({ phase: 'ready', documents: 1 });
    await dashboard.flush();
    expect(dashboard.search('mitochondria').total).toBe(1);
  });
});

/** `count` readable highlights cloned from one real row (their `updatedAt` is the clone time). */
async function cloneRows(count: number, prefix: string) {
  const base = await saveCapture(cap(`Seed quote for ${prefix}.`, 100));
  const db = getDb();
  const row = (await db.highlights.get(base.highlight.id))!;
  const pad = (n: number) => String(n).padStart(5, '0');
  const updatedAt = new Date().toISOString();
  const rows = Array.from({ length: count }, (_, i) => ({
    ...row,
    id: `${prefix}-${pad(i)}`,
    exactQuote: `Warfarin fact ${pad(i)} of ${prefix}.`,
    normalizedQuote: `warfarin fact ${pad(i)} of ${prefix}.`,
    quoteHash: `${prefix}${pad(i)}`.padStart(64, 'a'),
    updatedAt,
  }));
  await db.highlights.bulkPut(rows);
  return { ids: rows.map((r) => r.id), pad };
}

describe('SearchHost over a vault with unreadable rows', () => {
  it('indexes 1101 highlights minus the 3 it cannot read, and says so', async () => {
    const { ids } = await cloneRows(1_100, 'sv'); // plus the real one: 1101
    // inside a page, at the end of the first page, and in the last page
    for (const i of [10, 499, 1_099]) await getDb().highlights.update(ids[i]!, { exactQuote: '' });

    const { host } = await open();

    expect(host.state).toMatchObject({ phase: 'ready', documents: 1_098, rejected: 3 });
    expect(host.search('warfarin').total).toBe(1_097); // the real capture says nothing of warfarin
  });

  it('catches up around unreadable rows and links left behind a purged highlight', async () => {
    await saveCapture(cap('Mitochondria produce ATP.', 100));
    const first = await open();
    await first.host.flush();
    first.host.dispose();

    const { ids } = await cloneRows(1_100, 'cu');
    for (const i of [10, 499, 1_099]) await getDb().highlights.update(ids[i]!, { exactQuote: '' });
    // tag links whose highlight no longer exists sort among the changed ids
    const tag = (await createTag('exam')).tag;
    await getDb().highlightTags.bulkPut(
      ['aaa-gone-00001', 'aaa-gone-00002', 'aaa-gone-00003'].map((highlightId) => ({
        highlightId,
        tagId: tag.id,
        addedAt: new Date().toISOString(),
      })),
    );

    const second = await open(); // restores the cache, then catches up from it

    expect(second.reasons).toEqual([]);
    expect(second.host.state).toMatchObject({
      phase: 'ready',
      documents: 1 + 1 + 1_097, // the first capture, the clone's source row, and 1100 - 3 clones
      rejected: 3,
    });
    expect(second.host.search('warfarin').total).toBe(1_097);
  });
});

describe('SearchHost after "delete all data"', () => {
  it('drops the text it holds and writes none of it into the new database', async () => {
    await saveCapture(cap('Warfarin interacts with vitamin K.', 100));
    await saveCapture(cap('Ribosomes make proteins.', 400));
    await createNote({ body: 'Warfarin dosing needs INR checks' });
    const { host } = await open();
    expect(host.state).toMatchObject({ phase: 'ready', documents: 3 });
    // its write is pending: the page is about to be hidden
    expect(host.search('warfarin').total).toBe(2);

    await wipeAllData();
    expect((await getDb().meta.get(INDEX_STALE_KEY))?.value).toEqual(expect.any(String));
    await host.flush();
    const written = (await getDb().meta.get(INDEX_KEY))?.value;
    expect(String(written ?? '')).not.toMatch(/warfarin|ribosomes/i);

    host.reconcileSoon();
    await vi.waitFor(() => expect(host.search('warfarin').total).toBe(0));
    expect(host.state).toMatchObject({ phase: 'ready', documents: 0 });
    await host.flush();
    expect(String((await getDb().meta.get(INDEX_KEY))?.value ?? '')).not.toMatch(
      /warfarin|ribosomes/i,
    );
  });
});
