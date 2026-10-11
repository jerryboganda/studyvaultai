// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportBackup } from './export';
import { BackupError } from './errors';
import { prepareRestore, restoreBackup } from './restore';
import {
  MemoryVault,
  NOW,
  TEST_REGISTRY,
  pad,
  seedVault,
  subtle,
  unpack,
  withTable,
  text,
} from './testkit';
import type { ExportProgress, RestoreProgress, Row } from './types';

const common = { subtle, now: () => NOW } as const;

function bigNotes(n: number): Row[] {
  const at = new Date(Date.UTC(2026, 0, 1)).toISOString();
  return Array.from({ length: n }, (_, i) => ({
    id: `note-${pad(i)}`,
    schemaVersion: 1,
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
    highlightId: null,
    title: `Note ${i}`,
    body: `Body ${i} `.repeat(5),
    pinned: false,
  }));
}

describe('huge tables: progress and abort', () => {
  it('reports monotonic progress through reading, compressing and done', async () => {
    const v = new MemoryVault({ notes: bigNotes(20_000) });
    const events: ExportProgress[] = [];
    const out = await exportBackup(v, {
      ...common,
      batchSize: 1000,
      onProgress: (p) => events.push({ ...p }),
    });
    expect(out.stats.rows).toBe(20_000);
    const reading = events.filter((e) => e.phase === 'reading' && e.table === 'notes');
    expect(reading.length).toBeGreaterThanOrEqual(20);
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.rowsDone).toBeGreaterThanOrEqual(events[i - 1]!.rowsDone);
    }
    expect(events.at(-1)).toMatchObject({ phase: 'done', rowsDone: 20_000, rowsTotal: 20_000 });
    expect(events.some((e) => e.phase === 'compressing')).toBe(true);
  }, 60_000);

  it('abort during a huge export stops early and returns no archive', async () => {
    const pageLog: number[] = [];
    const v = new MemoryVault({ notes: bigNotes(20_000) }, { readPageLog: pageLog });
    const ac = new AbortController();
    const err = await exportBackup(v, {
      ...common,
      batchSize: 500,
      signal: ac.signal,
      onProgress: (p) => {
        if (p.rowsDone >= 5000) ac.abort();
      },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(BackupError);
    expect(err.code).toBe('aborted');
    expect(pageLog.reduce((a, b) => a + b, 0)).toBeLessThan(20_000);
  }, 60_000);

  it('an already aborted signal fails fast for export and restore', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      exportBackup(seedVault(5), { ...common, signal: ac.signal }),
    ).rejects.toMatchObject({
      code: 'aborted',
    });
    const out = await exportBackup(seedVault(5), common);
    await expect(
      prepareRestore(out.bytes, { target: new MemoryVault(), subtle, signal: ac.signal }),
    ).rejects.toMatchObject({ code: 'aborted' });
  });

  it('restore of a huge table reports staging progress and commits once', async () => {
    const src = new MemoryVault({ notes: bigNotes(15_000) });
    const out = await exportBackup(src, { ...common, batchSize: 1000 });
    const dst = new MemoryVault();
    const events: RestoreProgress[] = [];
    const { result } = await restoreBackup(out.bytes, {
      target: dst,
      mode: 'replace',
      subtle,
      batchSize: 1000,
      onProgress: (p) => events.push({ ...p }),
    });
    expect(result!.written.notes).toBe(15_000);
    expect(dst.rows('notes')).toHaveLength(15_000);
    expect(dst.liveWrites).toBe(1);
    expect(events.filter((e) => e.phase === 'staging').length).toBeGreaterThanOrEqual(15);
    expect(events.at(-1)!.phase).toBe('done');
    // staging puts are batches, never one giant write
    expect(dst.lastStaging!.puts).toBeGreaterThanOrEqual(15);
  }, 60_000);
});

describe('streaming: no table-sized string is ever built', () => {
  const encodes: number[] = [];
  const decodes: number[] = [];
  const parses: number[] = [];

  afterEach(() => vi.restoreAllMocks());

  function spy() {
    encodes.length = 0;
    decodes.length = 0;
    parses.length = 0;
    const enc = TextEncoder.prototype.encode;
    vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(function (
      this: TextEncoder,
      s?: string,
    ) {
      encodes.push(s?.length ?? 0);
      return enc.call(this, s);
    });
    const dec = TextDecoder.prototype.decode;
    vi.spyOn(TextDecoder.prototype, 'decode').mockImplementation(function (
      this: TextDecoder,
      b?: AllowSharedBufferSource,
    ) {
      decodes.push(b ? (b as Uint8Array).byteLength : 0);
      return dec.call(this, b);
    });
    const parse = JSON.parse;
    vi.spyOn(JSON, 'parse').mockImplementation(
      (s: string, r?: (k: string, v: unknown) => unknown) => {
        parses.push(s.length);
        return parse(s, r);
      },
    );
  }

  it('10k highlights: export encodes in bounded chunks, restore parses one row at a time', async () => {
    const src = seedVault(10_000);
    spy();
    const out = await exportBackup(src, common);
    const tableBytes = unpack(out.bytes)['tables/highlights.ndjson']!.length;
    expect(tableBytes).toBeGreaterThan(5_000_000); // the table really is big
    const maxEncode = Math.max(...encodes);
    expect(maxEncode).toBeLessThan(600_000);
    expect(maxEncode).toBeLessThan(tableBytes / 8);

    encodes.length = 0;
    decodes.length = 0;
    parses.length = 0;
    const dst = new MemoryVault();
    await restoreBackup(out.bytes, { target: dst, mode: 'replace', subtle });
    expect(Math.max(...decodes)).toBeLessThan(20_000); // one row per decode
    // the largest parse is the manifest or one row, never a table
    expect(Math.max(...parses)).toBeLessThan(20_000);
    expect(Math.max(...encodes)).toBeLessThan(600_000);
  }, 60_000);
});

describe('hostile rows do not crash the pipeline', () => {
  it('absurdly deep nesting is refused as unverifiable, not crashed on', async () => {
    const out = await exportBackup(seedVault(3), common);
    const files = unpack(out.bytes);
    const lines = text(files['tables/notes.ndjson']!).split('\n').filter(Boolean);
    const deep = `${'['.repeat(200)}${']'.repeat(200)}`;
    const bad = JSON.parse(lines[0] ?? '{}') as Row;
    bad.id = 'note-deep-0001';
    const line = JSON.stringify(bad).replace(/}$/, `,"x":${deep}}`);
    const archive = withTable(files, 'notes', `${[...lines, line].join('\n')}\n`, true);
    const err = await restoreBackup(archive, {
      target: new MemoryVault(),
      mode: 'replace',
      subtle,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(BackupError);
    expect(err.code).toBe('table_corrupt');
  });

  it('a table the app does not know is ignored and listed, not fatal', async () => {
    const richer = { ...TEST_REGISTRY, tables: [...TEST_REGISTRY.tables] };
    const extra = {
      name: 'futureTable',
      primaryKey: 'id',
      schema: TEST_REGISTRY.tables[0]!.schema,
      softDelete: false,
    };
    richer.tables.push(extra);
    const src = new MemoryVault({}, { registry: richer });
    src.load('futureTable', [{ id: 'x-12345678' }]);
    const out = await exportBackup(src, common);
    const dst = new MemoryVault();
    const { report } = await restoreBackup(out.bytes, { target: dst, mode: 'replace', subtle });
    expect(report.skippedTables).toEqual(['futureTable']);
    expect(report.warnings[0]).toContain('futureTable');
  });
});
