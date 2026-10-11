// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { exportBackup } from './export';
import { BackupError, type BackupErrorCode } from './errors';
import { prepareRestore, restoreBackup, type RestoreOptions } from './restore';
import {
  MemoryVault,
  NOW,
  TEST_REGISTRY,
  fastKdf,
  pack,
  reseal,
  seedVault,
  subtle,
  text,
  unpack,
  untouched,
  withTable,
} from './testkit';

const common = { subtle, now: () => NOW } as const;

async function goodArchive(n = 40) {
  const bytes = (await exportBackup(seedVault(n), common)).bytes;
  return { bytes, files: unpack(bytes) };
}

/** Restore into a populated vault and prove the failure was typed and live data never moved. */
async function expectSafeFailure(
  bytes: Uint8Array,
  code: BackupErrorCode,
  opts: Partial<RestoreOptions> = {},
): Promise<BackupError> {
  const target = seedVault(15, undefined, 77);
  const before = target.snapshot();
  const mode = opts.mode ?? 'replace';
  let caught: unknown;
  try {
    const p = await prepareRestore(bytes, { target, subtle, ...opts, mode });
    await p.commit();
  } catch (e) {
    caught = e;
  }
  expect(caught, `expected ${code}`).toBeInstanceOf(BackupError);
  expect((caught as BackupError).code).toBe(code);
  expect(untouched(target, before)).toBe(true);
  return caught as BackupError;
}

describe('corrupted archives fail safely with a specific typed error', () => {
  it('not a backup at all', async () => {
    await expectSafeFailure(
      new TextEncoder().encode('hello, this is not a backup'),
      'not_a_backup',
    );
    await expectSafeFailure(new Uint8Array(0), 'not_a_backup');
    await expectSafeFailure(crypto.getRandomValues(new Uint8Array(4096)), 'not_a_backup');
  });

  it('a JSON file of another format', async () => {
    await expectSafeFailure(
      new TextEncoder().encode('{"format":"something-else"}'),
      'not_a_backup',
    );
  });

  it('a ZIP that is not a StudyVault backup', async () => {
    await expectSafeFailure(pack({ 'readme.txt': new TextEncoder().encode('hi') }), 'not_a_backup');
  });

  it('bad / truncated zip', async () => {
    const { bytes } = await goodArchive();
    await expectSafeFailure(bytes.subarray(0, Math.floor(bytes.length / 2)), 'corrupt_archive');
    await expectSafeFailure(bytes.subarray(0, bytes.length - 10), 'corrupt_archive');
    const damaged = bytes.slice();
    damaged.fill(0, damaged.length - 40); // wipes the end-of-central-directory record
    await expectSafeFailure(damaged, 'corrupt_archive');
  });

  it('manifest not valid JSON / not matching the schema', async () => {
    const { files } = await goodArchive();
    await expectSafeFailure(
      pack({ ...files, 'manifest.json': new TextEncoder().encode('{nope') }),
      'manifest_invalid',
    );
    await expectSafeFailure(
      reseal(files, (m) => {
        delete (m as Record<string, unknown>).appSchemaVersion;
      }),
      'manifest_invalid',
    );
    await expectSafeFailure(
      reseal(files, (m) => {
        m.tables.push({ ...m.tables[0]! });
      }),
      'manifest_invalid',
    );
  });

  it('manifest modified after export (checksum mismatch)', async () => {
    const { files } = await goodArchive();
    const m = JSON.parse(text(files['manifest.json']!));
    m.createdAt = '2030-01-01T00:00:00.000Z';
    await expectSafeFailure(
      pack({ ...files, 'manifest.json': new TextEncoder().encode(JSON.stringify(m)) }),
      'manifest_checksum_mismatch',
    );
  });

  it('table content tampered (checksum mismatch), also for derived-field tables', async () => {
    const { files } = await goodArchive();
    const hl = text(files['tables/highlights.ndjson']!);
    const tampered = hl.replace('aspirin', 'asprin');
    expect(tampered).not.toBe(hl);
    const e = await expectSafeFailure(
      pack({ ...files, 'tables/highlights.ndjson': new TextEncoder().encode(tampered) }),
      'table_checksum_mismatch',
    );
    expect(e.details.table).toBe('highlights');
  });

  it('a changed derived field is NOT a checksum failure (derived fields are excluded)', async () => {
    const { files } = await goodArchive();
    const hl = text(files['tables/highlights.ndjson']!).replace(
      '"resolveStatus":"resolved"',
      '"resolveStatus":"orphaned"',
    );
    const target = new MemoryVault();
    await restoreBackup(
      pack({ ...files, 'tables/highlights.ndjson': new TextEncoder().encode(hl) }),
      { target, subtle, mode: 'replace' },
    );
    expect(target.rows('highlights').length).toBe(40);
  });

  it('truncated NDJSON: cut inside a row', async () => {
    const { files } = await goodArchive();
    const hl = text(files['tables/highlights.ndjson']!);
    const cut = hl.slice(0, Math.floor(hl.length / 2));
    expect(cut.endsWith('\n')).toBe(false);
    const e1 = await expectSafeFailure(
      withTable(files, 'highlights', cut, false),
      'table_truncated',
    );
    expect(e1.details.table).toBe('highlights');
    // even when the forger repaired the manifest: the last row is not JSON
    await expectSafeFailure(withTable(files, 'highlights', cut, true), 'table_truncated');
  });

  it('truncated NDJSON: cut at a row boundary', async () => {
    const { files } = await goodArchive();
    const lines = text(files['tables/highlights.ndjson']!).split('\n');
    const short = `${lines.slice(0, 10).join('\n')}\n`;
    await expectSafeFailure(withTable(files, 'highlights', short, false), 'table_truncated');
  });

  it('extra rows', async () => {
    const { files } = await goodArchive();
    const hl = text(files['tables/highlights.ndjson']!);
    const first = hl.split('\n')[0]!;
    await expectSafeFailure(
      withTable(files, 'highlights', `${hl}${first}\n`, false),
      'row_count_mismatch',
    );
  });

  it('garbage in the middle of a table', async () => {
    const { files } = await goodArchive();
    const lines = text(files['tables/highlights.ndjson']!).split('\n');
    lines[5] = '{"id": "broken';
    await expectSafeFailure(
      withTable(files, 'highlights', lines.join('\n'), false),
      'table_corrupt',
    );
  });

  it('missing table file', async () => {
    const { files } = await goodArchive();
    const { 'tables/notes.ndjson': _gone, ...rest } = files;
    await expectSafeFailure(pack(rest), 'corrupt_archive');
  });

  it('schema-invalid rows -> row_invalid with a capped, specific list; skip policy continues', async () => {
    const src = seedVault(30);
    src.rows('highlights')[3]!.priority = 99;
    src.rows('highlights')[4]!.kind = 'not-a-kind';
    const bytes = (await exportBackup(src, common)).bytes;
    const e = await expectSafeFailure(bytes, 'row_invalid');
    const inv = e.details.invalidRows as {
      total: number;
      items: { table: string; reason: string; message: string }[];
    };
    expect(inv.total).toBe(2);
    expect(inv.items.every((i) => i.table === 'highlights' && i.reason === 'schema')).toBe(true);
    expect(inv.items[0]!.message).toContain('priority');

    // explicit opt-in: invalid rows are listed, skipped, and the rest restored
    const target = new MemoryVault();
    const { report } = await restoreBackup(bytes, {
      target,
      subtle,
      mode: 'replace',
      invalidRows: 'skip',
      orphans: 'skip',
    });
    expect(report.invalidRows.total).toBe(2);
    expect(target.rows('highlights')).toHaveLength(28);
  });

  it('rows that are not objects or carry __proto__ are invalid, never trusted', async () => {
    const { files } = await goodArchive(5);
    const lines = text(files['tables/banks.ndjson']!).split('\n').filter(Boolean);
    const bad = [...lines, '[1,2,3]', '{"__proto__":{"polluted":true},"id":"bank-zzzzzz1"}'];
    const e = await expectSafeFailure(
      withTable(files, 'banks', `${bad.join('\n')}\n`, true),
      'row_invalid',
    );
    const reasons = (e.details.invalidRows as { items: { reason: string }[] }).items.map(
      (i) => i.reason,
    );
    expect(reasons).toEqual(expect.arrayContaining(['not_an_object', 'forbidden_key']));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('duplicate keys inside a table', async () => {
    const { files } = await goodArchive(5);
    const lines = text(files['tables/banks.ndjson']!).split('\n').filter(Boolean);
    const e = await expectSafeFailure(
      withTable(files, 'banks', `${[...lines, lines[0]].join('\n')}\n`, true),
      'row_invalid',
    );
    expect((e.details.invalidRows as { items: { reason: string }[] }).items[0]!.reason).toBe(
      'duplicate_key',
    );
  });

  it('a backup from a newer data version', async () => {
    const newer = { ...TEST_REGISTRY, schemaVersion: 3 };
    const bytes = (await exportBackup(seedVault(10, { registry: newer }), common)).bytes;
    const e = await expectSafeFailure(bytes, 'future_schema_version');
    expect(e.details).toMatchObject({ archiveVersion: 3, currentVersion: 2 });
  });

  it('a backup in a newer container format', async () => {
    const { files } = await goodArchive();
    await expectSafeFailure(
      reseal(files, (m) => void (m.formatVersion = 2)),
      'future_format_version',
    );
  });

  it('an older backup with no migration path', async () => {
    const older = { ...TEST_REGISTRY, schemaVersion: 1 };
    const bytes = (await exportBackup(seedVault(10, { registry: older }), common)).bytes;
    const e = await expectSafeFailure(bytes, 'migration_missing');
    expect(e.details.missingFrom).toBe(1);
  });

  it('orphans abort by default; skip cascades and is reported', async () => {
    const src = seedVault(30);
    src.data.get('sources')!.clear(); // every highlight now points at nothing
    const bytes = (await exportBackup(src, common)).bytes;
    const e = await expectSafeFailure(bytes, 'integrity_violation');
    expect((e.details.orphans as { total: number }).total).toBe(30);

    const target = new MemoryVault();
    const { report } = await restoreBackup(bytes, {
      target,
      subtle,
      mode: 'replace',
      orphans: 'skip',
    });
    expect(report.orphans.total).toBeGreaterThan(30); // highlights + cascaded highlightBanks/notes
    expect(report.orphans.items.some((o) => o.cascaded)).toBe(true);
    expect(target.rows('highlights')).toHaveLength(0);
    expect(target.rows('highlightBanks')).toHaveLength(0);
    expect(target.rows('banks').length).toBeGreaterThan(0);
  });
});

describe('encrypted archives', () => {
  async function encrypted() {
    return (await exportBackup(seedVault(20), { ...common, passphrase: 'pw-123', ...fastKdf }))
      .bytes;
  }

  it('missing passphrase', async () => {
    await expectSafeFailure(await encrypted(), 'passphrase_required');
  });

  it('wrong passphrase', async () => {
    await expectSafeFailure(await encrypted(), 'wrong_passphrase', { passphrase: 'nope' });
  });

  it('ciphertext tampered or truncated', async () => {
    const bytes = await encrypted();
    const flipped = bytes.slice();
    flipped[flipped.length - 20]! ^= 0xff;
    await expectSafeFailure(flipped, 'encrypted_payload_corrupt', { passphrase: 'pw-123' });
    await expectSafeFailure(bytes.subarray(0, bytes.length - 100), 'encrypted_payload_corrupt', {
      passphrase: 'pw-123',
    });
  });

  it('header tampered', async () => {
    const bytes = await encrypted();
    const header = new TextDecoder().decode(bytes.subarray(12, 12 + 200));
    const idx = header.indexOf('"iter":1000');
    expect(idx).toBeGreaterThan(0);
    const t = bytes.slice();
    t[12 + idx + '"iter":'.length + 3] = '1'.charCodeAt(0); // 1000 -> 1001
    await expectSafeFailure(t, 'wrong_passphrase', { passphrase: 'pw-123' });
    const junk = bytes.slice(0, 20);
    await expectSafeFailure(junk, 'corrupt_archive', { passphrase: 'pw-123' });
  });
});

describe('limits protect against hostile archives', () => {
  it('declared sizes above the limits are refused before decompression', async () => {
    const { bytes } = await goodArchive(100);
    await expectSafeFailure(bytes, 'limit_exceeded', { limits: { maxTableBytes: 500 } });
    await expectSafeFailure(bytes, 'limit_exceeded', { limits: { maxTotalBytes: 1000 } });
    await expectSafeFailure(bytes, 'limit_exceeded', { limits: { maxRows: 10 } });
    await expectSafeFailure(bytes, 'limit_exceeded', { limits: { maxEntries: 2 } });
    await expectSafeFailure(bytes, 'limit_exceeded', { limits: { maxArchiveBytes: 100 } });
    await expectSafeFailure(bytes, 'limit_exceeded', { limits: { maxRowBytes: 50 } });
  });
});

describe('the restore step cannot half-apply', () => {
  async function arch() {
    return (await exportBackup(seedVault(30), common)).bytes;
  }

  async function failWith(
    code: BackupErrorCode,
    vaultOptions: ConstructorParameters<typeof MemoryVault>[1],
  ) {
    const target = seedVault(8, vaultOptions, 42);
    const before = target.snapshot();
    const err = await restoreBackup(await arch(), { target, subtle, mode: 'replace' }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(BackupError);
    expect(err.code).toBe(code);
    expect(target.snapshot()).toBe(before);
    return target;
  }

  it('createStaging fails', async () => {
    const t = await failWith('staging_failed', { failStagingOn: 'create' });
    expect(t.liveWrites).toBe(0);
  });

  it('staging write fails midway: rolled back and discarded, live data untouched', async () => {
    const t = await failWith('staging_failed', { failStagingOn: 'putRows' });
    expect(t.liveWrites).toBe(0);
    expect(t.lastStaging!.rolledBack).toBe(1);
    expect(t.lastStaging!.discarded).toBe(1);
    expect(t.lastStaging!.commits).toHaveLength(0);
  });

  it('target-side validation fails: nothing committed', async () => {
    const t = await failWith('staging_failed', { failStagingOn: 'validate' });
    expect(t.lastStaging!.commits).toHaveLength(0);
    expect(t.lastStaging!.rolledBack).toBe(1);
  });

  it('commit fails: typed commit_failed, rolled back', async () => {
    const t = await failWith('commit_failed', { failStagingOn: 'commit' });
    expect(t.lastStaging!.rolledBack).toBe(1);
    expect(t.liveWrites).toBe(0);
  });

  it('a non-atomic target that half-applied is repaired by rollback()', async () => {
    const target = seedVault(8, { failStagingOn: 'commit', commitHalfThenFail: true }, 42);
    const before = target.snapshot();
    const err = await restoreBackup(await arch(), { target, subtle, mode: 'replace' }).catch(
      (e) => e,
    );
    expect(err.code).toBe('commit_failed');
    expect(target.snapshot()).toBe(before);
  });

  it('safety backup failure aborts before anything is staged', async () => {
    const target = seedVault(8, undefined, 42);
    const before = target.snapshot();
    const err = await restoreBackup(await arch(), {
      target,
      subtle,
      mode: 'replace',
      preRestoreBackup: { sink: () => Promise.reject(new Error('disk full')) },
    }).catch((e) => e);
    expect(err.code).toBe('safety_backup_failed');
    expect(untouched(target, before)).toBe(true);
  });

  it('safety backup is produced from the live data first and is itself restorable', async () => {
    const target = seedVault(8, undefined, 42);
    const before = target.snapshot();
    let saved: Uint8Array | null = null;
    await restoreBackup(await arch(), {
      target,
      subtle,
      mode: 'replace',
      preRestoreBackup: {
        sink: (b) => {
          saved = b.bytes;
          return Promise.resolve();
        },
        options: { passphrase: 'safe', ...fastKdf },
      },
    });
    expect(target.rows('highlights')).toHaveLength(30);
    const back = new MemoryVault();
    await restoreBackup(saved!, { target: back, subtle, mode: 'replace', passphrase: 'safe' });
    expect(back.snapshot()).toBe(before);
  });
});

describe('abort', () => {
  it('abort while verifying leaves live data untouched', async () => {
    const out = await exportBackup(seedVault(3000), common);
    const target = seedVault(10, undefined, 3);
    const before = target.snapshot();
    const ac = new AbortController();
    const err = await prepareRestore(out.bytes, {
      target,
      subtle,
      signal: ac.signal,
      onProgress: (p) => {
        if (p.phase === 'verifying' && p.rowsDone >= 500) ac.abort();
      },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(BackupError);
    expect(err.code).toBe('aborted');
    expect(untouched(target, before)).toBe(true);
  });

  it('abort while staging rolls back and never commits', async () => {
    const out = await exportBackup(seedVault(2000), common);
    const target = seedVault(10, undefined, 3);
    const before = target.snapshot();
    const ac = new AbortController();
    const err = await restoreBackup(out.bytes, {
      target,
      subtle,
      mode: 'replace',
      batchSize: 100,
      signal: ac.signal,
      onProgress: (p) => {
        if (p.phase === 'staging') ac.abort();
      },
    }).catch((e) => e);
    expect(err.code).toBe('aborted');
    expect(target.snapshot()).toBe(before);
    expect(target.liveWrites).toBe(0);
    expect(target.lastStaging!.commits).toHaveLength(0);
    expect(target.lastStaging!.rolledBack).toBe(1);
  });
});

describe('hostile schemas and rows', () => {
  it('a schema that throws marks the row invalid instead of crashing the restore', async () => {
    const bytes = (await exportBackup(seedVault(5), common)).bytes;
    const throwing = {
      ...TEST_REGISTRY,
      tables: TEST_REGISTRY.tables.map((t) =>
        t.name === 'banks'
          ? {
              ...t,
              schema: z.any().refine(() => {
                throw new Error('boom');
              }),
            }
          : t,
      ),
    };
    const target = new MemoryVault({}, { registry: throwing });
    const err = await restoreBackup(bytes, { target, subtle, mode: 'replace' }).catch((e) => e);
    expect(err.code).toBe('row_invalid');
    expect(err.details.invalidRows.items[0].message).toContain('boom');
    expect(target.liveWrites).toBe(0);
  });
});

/** Overwrite the uncompressed size a ZIP's central directory declares for one entry. */
function declareSize(zip: Uint8Array, entry: string, size: number): Uint8Array {
  const out = zip.slice();
  const dv = new DataView(out.buffer);
  let eocd = out.length - 22;
  while (dv.getUint32(eocd, true) !== 0x06054b50) eocd--;
  let p = dv.getUint32(eocd + 16, true);
  for (let n = dv.getUint16(eocd + 10, true); n > 0; n--) {
    const nameLen = dv.getUint16(p + 28, true);
    const name = new TextDecoder().decode(out.subarray(p + 46, p + 46 + nameLen));
    if (name === entry) {
      dv.setUint32(p + 24, size, true);
      return out;
    }
    p += 46 + nameLen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
  }
  throw new Error(`no entry ${entry}`);
}

describe('zip bombs and lying headers', () => {
  it('a header that claims an impossible expansion is refused before allocating', async () => {
    const { bytes } = await goodArchive(30);
    const bomb = declareSize(bytes, 'tables/highlights.ndjson', 400 * 1024 * 1024);
    const e = await expectSafeFailure(bomb, 'corrupt_archive');
    expect(e.message).toContain('impossible size');
    await expectSafeFailure(declareSize(bytes, 'manifest.json', 0x7fffffff), 'limit_exceeded');
  });

  it('a header that claims less than the real size cannot smuggle rows in', async () => {
    const { bytes } = await goodArchive(30);
    await expectSafeFailure(declareSize(bytes, 'tables/highlights.ndjson', 10), 'table_truncated');
  });
});
