// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { exportBackup, exportJson } from './export';
import { prepareRestore, restoreBackup, inspectBackup } from './restore';
import {
  MemoryVault,
  NOW,
  TEST_REGISTRY,
  fastKdf,
  seedVault,
  subtle,
  fixedRandom,
} from './testkit';

const common = { subtle, now: () => NOW, appVersion: '0.2.0' } as const;

describe('lossless round trip', () => {
  it('10k highlights export -> restore (replace) into an empty vault is identical', async () => {
    const src = seedVault(10_000);
    const before = src.snapshot();
    const out = await exportBackup(src, common);
    expect(out.manifest.format).toBe('studyvault-backup');
    expect(out.manifest.tables.find((t) => t.name === 'highlights')?.rowCount).toBe(10_000);
    expect(out.stats.rows).toBe(
      src.rows('banks').length +
        10_000 +
        src.rows('sources').length +
        src.rows('folders').length +
        10_000 +
        src.rows('notes').length,
    );

    const dst = new MemoryVault();
    const { report, result } = await restoreBackup(out.bytes, {
      target: dst,
      mode: 'replace',
      subtle,
    });
    expect(result).not.toBeNull();
    expect(report.totals.invalid).toBe(0);
    expect(dst.snapshot()).toBe(before);
    expect(dst.liveWrites).toBe(1); // ONE atomic commit
    expect(src.snapshot()).toBe(before); // the source was only read
  }, 60_000);

  it('provenance fields survive byte for byte', async () => {
    const src = seedVault(200);
    const out = await exportBackup(src, common);
    const dst = new MemoryVault();
    await restoreBackup(out.bytes, { target: dst, mode: 'replace', subtle });
    const a = src.rows('highlights');
    const b = dst.rows('highlights');
    expect(b).toHaveLength(a.length);
    for (let i = 0; i < a.length; i++) {
      const x = a[i]!;
      const y = b[i]!;
      expect(y.exactQuote).toBe(x.exactQuote);
      expect(JSON.stringify(y.anchorSet)).toBe(JSON.stringify(x.anchorSet));
      expect(y.id).toBe(x.id);
      expect(y.createdAt).toBe(x.createdAt);
      expect(y.capturedAt).toBe(x.capturedAt);
      expect(y.quoteHash).toBe(x.quoteHash);
    }
  });

  it('re-exporting a restored vault gives identical table checksums (derived fields excluded)', async () => {
    const src = seedVault(300);
    const first = await exportBackup(src, common);
    const dst = new MemoryVault();
    await restoreBackup(first.bytes, { target: dst, mode: 'replace', subtle });
    // the app recomputes derived fields after a restore
    for (const row of dst.rows('highlights')) {
      row.resolveStatus = 'unchecked';
      row.resolveConfidence = null;
      row.lastResolvedAt = null;
    }
    for (const row of dst.rows('notes')) row.wordCount = 999;
    const second = await exportBackup(dst, common);
    const sums = (m: typeof first.manifest) => m.tables.map((t) => [t.name, t.rowCount, t.sha256]);
    expect(sums(second.manifest)).toEqual(sums(first.manifest));
    expect(second.manifest.tables.find((t) => t.name === 'highlights')?.derivedFields).toEqual([
      'resolveStatus',
      'resolveConfidence',
      'lastResolvedAt',
    ]);
  });

  it('writes the documented archive layout', async () => {
    const out = await exportBackup(seedVault(20), common);
    const files = unzipSync(out.bytes);
    expect(Object.keys(files).sort()).toEqual(
      [
        'manifest.json',
        'tables/banks.ndjson',
        'tables/folders.ndjson',
        'tables/highlightBanks.ndjson',
        'tables/highlights.ndjson',
        'tables/notes.ndjson',
        'tables/sources.ndjson',
      ].sort(),
    );
    expect(Object.keys(files)).not.toContain('tables/attachments.ndjson');
    const m = JSON.parse(new TextDecoder().decode(files['manifest.json']));
    expect(m).toMatchObject({
      format: 'studyvault-backup',
      formatVersion: 1,
      appSchemaVersion: 2,
      createdAt: NOW.toISOString(),
      createdBy: { app: 'StudyVault AI', version: '0.2.0' },
      options: { includesAttachments: false, encrypted: false },
    });
    expect(m.checksum).toMatch(/^[0-9a-f]{64}$/);
    const hl = new TextDecoder().decode(files['tables/highlights.ndjson']);
    const lines = hl.split('\n');
    expect(lines.at(-1)).toBe('');
    expect(lines).toHaveLength(21);
    expect(() => JSON.parse(lines[0]!)).not.toThrow();
  });

  it('is deterministic for the same data and clock', async () => {
    const a = await exportBackup(seedVault(50), common);
    const b = await exportBackup(seedVault(50), common);
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
  });

  it('supports AsyncIterable sources and small pages', async () => {
    const src = seedVault(120, { streaming: true });
    const out = await exportBackup(src, { ...common, batchSize: 7 });
    const dst = new MemoryVault();
    await restoreBackup(out.bytes, { target: dst, mode: 'replace', subtle, batchSize: 7 });
    expect(dst.snapshot()).toBe(src.snapshot());
  });

  it('page-mode sources are read with afterKey in several pages', async () => {
    const log: number[] = [];
    const src = seedVault(95, { readPageLog: log });
    await exportBackup(src, { ...common, batchSize: 10 });
    expect(Math.max(...log)).toBeLessThanOrEqual(10);
    expect(log.length).toBeGreaterThan(10);
  });
});

describe('single-file JSON', () => {
  it('round trips through the same pipeline', async () => {
    const src = seedVault(400);
    const out = await exportJson(src, common);
    expect(out.manifest.format).toBe('studyvault-backup-json');
    expect(out.suggestedFilename.endsWith('.json')).toBe(true);
    const dst = new MemoryVault();
    await restoreBackup(out.bytes, { target: dst, mode: 'replace', subtle });
    expect(dst.snapshot()).toBe(src.snapshot());
  });

  it('refuses big vaults and binary tables', async () => {
    await expect(exportJson(seedVault(100), { ...common, maxRows: 50 })).rejects.toMatchObject({
      code: 'limit_exceeded',
    });
    const v = seedVault(5);
    v.load('attachments', [
      {
        id: 'att-00000001',
        schemaVersion: 1,
        createdAt: NOW.toISOString(),
        documentId: 'doc-00000001',
        mimeType: 'application/pdf',
        blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'application/pdf' }),
      },
    ]);
    await expect(
      exportJson(v, { ...common, includeLocalOnlyTables: ['attachments'] }),
    ).rejects.toMatchObject({ code: 'invalid_options' });
  });
});

describe('localOnly tables and attachments', () => {
  const att = (n: number, bytes: number[], type = 'application/pdf') => ({
    id: `att-${String(n).padStart(8, '0')}`,
    schemaVersion: 1,
    createdAt: NOW.toISOString(),
    documentId: `doc-${String(n).padStart(8, '0')}`,
    mimeType: type,
    blob: new Blob([new Uint8Array(bytes)], { type }),
  });

  it('are excluded by default and included only on opt-in, with bytes intact', async () => {
    const src = seedVault(10);
    src.load('attachments', [att(1, [1, 2, 3, 4]), att(2, [9, 9, 9]), att(3, [1, 2, 3, 4])]);
    const plain = await exportBackup(src, common);
    expect(plain.manifest.tables.map((t) => t.name)).not.toContain('attachments');
    expect(plain.manifest.options.includesAttachments).toBe(false);

    const withAtt = await exportBackup(src, { ...common, includeLocalOnlyTables: ['attachments'] });
    expect(withAtt.manifest.options.includesAttachments).toBe(true);
    // identical bytes are stored once
    expect(withAtt.stats.blobs).toBe(2);
    const dst = new MemoryVault();
    await restoreBackup(withAtt.bytes, { target: dst, mode: 'replace', subtle });
    const restored = dst.rows('attachments');
    expect(restored).toHaveLength(3);
    const first = restored[0]!.blob as Blob;
    expect(first).toBeInstanceOf(Blob);
    expect(first.type).toBe('application/pdf');
    expect(Array.from(new Uint8Array(await first.arrayBuffer()))).toEqual([1, 2, 3, 4]);
  });

  it('replace restore leaves localOnly tables alone when the archive has none', async () => {
    const src = seedVault(10);
    const out = await exportBackup(src, common);
    const dst = seedVault(3, undefined, 9);
    dst.load('attachments', [att(7, [5, 5])]);
    await restoreBackup(out.bytes, { target: dst, mode: 'replace', subtle });
    expect(dst.rows('attachments')).toHaveLength(1);
    expect(dst.rows('highlights')).toHaveLength(10);
  });
});

describe('encryption', () => {
  it('round trips with the right passphrase and reports it without one', async () => {
    const src = seedVault(100);
    const out = await exportBackup(src, {
      ...common,
      passphrase: 'correct horse battery staple',
      ...fastKdf,
      randomBytes: fixedRandom,
    });
    expect(out.encrypted).toBe(true);
    expect(out.suggestedFilename.endsWith('.svbackup')).toBe(true);
    expect(new TextDecoder().decode(out.bytes.subarray(0, 8))).toBe('SVBKENC1');
    // nothing readable leaks
    expect(Buffer.from(out.bytes).includes('Heading')).toBe(false);

    expect(await inspectBackup(out.bytes, { subtle })).toEqual({ encrypted: true, manifest: null });
    const info = await inspectBackup(out.bytes, {
      subtle,
      passphrase: 'correct horse battery staple',
    });
    expect(info.manifest?.options.encrypted).toBe(true);

    const dst = new MemoryVault();
    await restoreBackup(out.bytes, {
      target: dst,
      mode: 'replace',
      subtle,
      passphrase: 'correct horse battery staple',
    });
    expect(dst.snapshot()).toBe(src.snapshot());
  });

  it('JSON single-file can be encrypted too', async () => {
    const src = seedVault(30);
    const out = await exportJson(src, { ...common, passphrase: 'pw', ...fastKdf });
    const dst = new MemoryVault();
    await restoreBackup(out.bytes, { target: dst, mode: 'replace', subtle, passphrase: 'pw' });
    expect(dst.snapshot()).toBe(src.snapshot());
  });
});

describe('dry run', () => {
  it('reports without staging anything or touching live data', async () => {
    const src = seedVault(60);
    const out = await exportBackup(src, common);
    const dst = seedVault(10, undefined, 5);
    const before = dst.snapshot();
    const { report, result } = await restoreBackup(out.bytes, {
      target: dst,
      mode: 'merge',
      subtle,
      dryRun: true,
    });
    expect(result).toBeNull();
    expect(dst.snapshot()).toBe(before);
    expect(dst.stagingCreated).toBe(0);
    expect(dst.liveWrites).toBe(0);
    expect(report.currentSchemaVersion).toBe(TEST_REGISTRY.schemaVersion);
    expect(report.totals.add).toBeGreaterThan(0);
    expect(report.tables.highlights?.archiveRows).toBe(60);
  });

  it('prepareRestore.commit is one-shot and discard refuses a later commit', async () => {
    const out = await exportBackup(seedVault(5), common);
    const dst = new MemoryVault();
    const p = await prepareRestore(out.bytes, { target: dst, subtle });
    await p.commit();
    await expect(p.commit()).rejects.toMatchObject({ code: 'invalid_options' });
    const q = await prepareRestore(out.bytes, { target: new MemoryVault(), subtle });
    q.discard();
    await expect(q.commit()).rejects.toMatchObject({ code: 'invalid_options' });
  });
});

describe('edge cases', () => {
  it('an empty vault round trips; replacing with it empties the target', async () => {
    const out = await exportBackup(new MemoryVault(), common);
    expect(out.stats.rows).toBe(0);
    const target = seedVault(5);
    const { report } = await restoreBackup(out.bytes, { target, mode: 'replace', subtle });
    expect(target.rows('highlights')).toHaveLength(0);
    expect(report.replaceImpact.removedLiveOnlyRows).toBeGreaterThan(0);
  });

  it('discard() releases the archive: a later commit is refused', async () => {
    const out = await exportBackup(seedVault(5), common);
    const prepared = await prepareRestore(out.bytes, { target: new MemoryVault(), subtle });
    prepared.discard();
    await expect(prepared.commit()).rejects.toMatchObject({ code: 'invalid_options' });
  });
});
