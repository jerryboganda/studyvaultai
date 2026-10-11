import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { exportBackup, restoreBackup } from '@backup';
import {
  BACKUP_MIGRATIONS,
  createBackupTarget,
  createNote,
  createSnapshotSource,
  emptyTrash,
  getDb,
  getLastPurgeAt,
  listSearchDocuments,
  listSearchDocumentsChangedSince,
  resetDbForTests,
  saveCapture,
  softDeleteHighlight,
} from '@storage';
import type { CaptureInput } from '@shared';
import { INDEX_STALE_KEY, SearchHost, type SearchHostPorts } from './searchHost';

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

  it('rebuilds after a backup restore wrote its marker, then removes the marker', async () => {
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
    // the restore itself wrote the marker the host reads
    expect((await getDb().meta.get(INDEX_STALE_KEY))?.value).toEqual(expect.any(String));

    const after = await open();
    expect(after.reasons[0]).toBe('restore');
    expect(after.host.search('ribosomes').total).toBe(0);
    expect(after.host.search('mitochondria').total).toBe(1);
    expect(await getDb().meta.get(INDEX_STALE_KEY)).toBeUndefined();
  });
});
