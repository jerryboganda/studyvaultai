// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { TableRegistry } from '@shared';
import { canonicalJson } from './canonical';
import { exportBackup, exportJson } from './export';
import { BackupError } from './errors';
import { inspectBackup, prepareRestore, restoreBackup } from './restore';
import {
  MemoryVault,
  NOW,
  TEST_IMMUTABLE_FIELDS,
  TEST_REGISTRY,
  seedData,
  seedVault,
  sha,
  spec,
  subtle,
  tableSha,
  text,
  unpack,
  untouched,
  withTable,
  type Seed,
} from './testkit';
import type { CitationGuard, Row } from './types';

const common = { subtle, now: () => NOW } as const;
const BACKSLASH = String.fromCharCode(92);

const at = (n: number) => new Date(Date.UTC(2026, 5, 1, 0, n)).toISOString();

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof BackupError) return e.code;
    throw e;
  }
  return 'resolved';
}

// ---------------------------------------------------------------------------------------------
// Hostile ZIP structure: rejected from the central directory, before anything is walked
// ---------------------------------------------------------------------------------------------

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;

/** ~130 bytes: a ZIP64 end-of-directory record that claims 4,294,967,295 entries. */
function forgedZip64(): Uint8Array {
  const out = new Uint8Array(30 + 56 + 20 + 22);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, SIG_LOCAL, true);
  const z64 = 30;
  dv.setUint32(z64, SIG_ZIP64_EOCD, true);
  dv.setUint32(z64 + 4, 44, true);
  dv.setUint16(z64 + 12, 45, true);
  dv.setUint16(z64 + 14, 45, true);
  dv.setUint32(z64 + 24, 0xffffffff, true); // entries on this disk
  dv.setUint32(z64 + 32, 0xffffffff, true); // total entries
  const locator = z64 + 56;
  dv.setUint32(locator, SIG_ZIP64_LOCATOR, true);
  dv.setUint32(locator + 8, z64, true);
  dv.setUint32(locator + 16, 1, true);
  const eocd = locator + 20;
  dv.setUint32(eocd, SIG_EOCD, true);
  dv.setUint16(eocd + 8, 0xffff, true);
  dv.setUint16(eocd + 10, 0xffff, true);
  dv.setUint32(eocd + 12, 0xffffffff, true);
  dv.setUint32(eocd + 16, 0xffffffff, true);
  return out;
}

/** A ZIP made of nothing but a directory: `claimed` entries are announced, `entries` are present. */
function directoryZip(
  entries: { name: string; size: number; original: number }[],
  claimed = entries.length,
): Uint8Array {
  const names = entries.map((e) => new TextEncoder().encode(e.name));
  const directory = names.reduce((n, b) => n + 46 + b.length, 0);
  const out = new Uint8Array(30 + directory + 22);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, SIG_LOCAL, true);
  let pos = 30;
  entries.forEach((e, i) => {
    const name = names[i] as Uint8Array;
    dv.setUint32(pos, SIG_CENTRAL, true);
    dv.setUint32(pos + 20, e.size, true);
    dv.setUint32(pos + 24, e.original, true);
    dv.setUint16(pos + 28, name.length, true);
    out.set(name, pos + 46);
    pos += 46 + name.length;
  });
  dv.setUint32(pos, SIG_EOCD, true);
  dv.setUint16(pos + 8, claimed, true);
  dv.setUint16(pos + 10, claimed, true);
  dv.setUint32(pos + 12, directory, true);
  dv.setUint32(pos + 16, 30, true);
  return out;
}

describe('hostile ZIP directories are refused in milliseconds', () => {
  const target = () => seedVault(3, undefined, 5);

  it('a forged ZIP64 record (4 billion entries) is refused without walking it', async () => {
    const t0 = performance.now();
    const err = await prepareRestore(forgedZip64(), { target: target(), subtle }).catch((e) => e);
    expect(err).toBeInstanceOf(BackupError);
    expect(err.code).toBe('corrupt_archive');
    expect(err.details).toMatchObject({ zip64: true });
    expect(await inspectBackup(forgedZip64(), {}).catch((e) => e.code)).toBe('corrupt_archive');
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it('a ZIP64 marker in an ordinary directory is refused too', async () => {
    const bytes = directoryZip([{ name: 'manifest.json', size: 10, original: 0xffffffff }]);
    expect(await code(prepareRestore(bytes, { target: target(), subtle }))).toBe('corrupt_archive');
  });

  it('an entry-count bomb is refused before any entry is read', async () => {
    const t0 = performance.now();
    // 60,000 announced (above the default 50,000), none present
    expect(await code(prepareRestore(directoryZip([], 60_000), { target: target(), subtle }))).toBe(
      'limit_exceeded',
    );
    // below the cap but the directory is not there: damaged, found at the first record
    expect(await code(prepareRestore(directoryZip([], 40_000), { target: target(), subtle }))).toBe(
      'corrupt_archive',
    );
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it('declared sizes are summed from the directory and capped before decompression', async () => {
    const GiB = 1024 * 1024 * 1024;
    const bytes = directoryZip(['a', 'b', 'c'].map((name) => ({ name, size: GiB, original: GiB })));
    const err = await prepareRestore(bytes, { target: target(), subtle }).catch((e) => e);
    expect(err).toBeInstanceOf(BackupError);
    expect(err.code).toBe('limit_exceeded');
    expect(err.details).toMatchObject({ maxTotalBytes: 2048 * 1024 * 1024 });
  });

  it('a duplicate entry name is refused', async () => {
    const bytes = directoryZip([
      { name: 'manifest.json', size: 1, original: 1 },
      { name: 'manifest.json', size: 1, original: 1 },
    ]);
    expect(await code(prepareRestore(bytes, { target: target(), subtle }))).toBe('corrupt_archive');
  });
});

// ---------------------------------------------------------------------------------------------
// Member names: checked on the parsed object graph, whatever escapes spelled them
// ---------------------------------------------------------------------------------------------

describe('forbidden member names', () => {
  async function banksArchive(extra: string[]) {
    const files = unpack((await exportBackup(seedVault(5), common)).bytes);
    const lines = text(files['tables/banks.ndjson'] as Uint8Array)
      .split('\n')
      .filter(Boolean);
    return withTable(files, 'banks', `${[...lines, ...extra].join('\n')}\n`, true);
  }

  const bank = (extra: string) => `{"id":"bank-forged01",${extra}}`;
  const cases: [string, string][] = [
    ['a plain __proto__', bank('"__proto__":{"polluted":true}')],
    [
      'a __proto__ spelled with a JSON unicode escape',
      bank(
        `"${BACKSLASH}u005f${BACKSLASH}u005fproto${BACKSLASH}u005f${BACKSLASH}u005f":{"polluted":true}`,
      ),
    ],
    ['a half-escaped __proto__', bank(`"${BACKSLASH}u005f_proto__":{"polluted":true}`)],
    ['__proto__ deep inside a member', bank('"extra":{"a":[{"b":{"__proto__":{"polluted":1}}}]}')],
    ['constructor.prototype', bank('"constructor":{"prototype":{"polluted":true}}')],
    ['a prototype object', bank('"prototype":{"polluted":true}')],
  ];

  it.each(cases)('%s makes the row invalid and pollutes nothing', async (_name, line) => {
    const bytes = await banksArchive([line]);
    const target = seedVault(2, undefined, 9);
    const before = target.snapshot();
    const err = await restoreBackup(bytes, { target, subtle, mode: 'replace' }).catch((e) => e);
    expect(err).toBeInstanceOf(BackupError);
    expect(err.code).toBe('row_invalid');
    expect(err.details.invalidRows.items.map((i: { reason: string }) => i.reason)).toEqual([
      'forbidden_key',
    ]);
    expect(untouched(target, before)).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('with the skip policy the row is left out and the rest is restored', async () => {
    const bytes = await banksArchive([bank('"constructor":{"prototype":{"polluted":true}}')]);
    const target = new MemoryVault();
    const { report } = await restoreBackup(bytes, {
      target,
      subtle,
      mode: 'replace',
      invalidRows: 'skip',
      orphans: 'skip',
    });
    expect(report.invalidRows.total).toBe(1);
    expect(target.rows('banks').map((r) => r.id)).not.toContain('bank-forged01');
    expect(target.rows('banks')).toHaveLength(12);
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('a custom field that merely is NAMED constructor or prototype is data and restores', async () => {
    const source = seedVault(3);
    const row = source.rows('highlights')[0] as Row;
    row.customFields = { constructor: 'a value', prototype: 'another', toString: 'text' };
    const bytes = (await exportBackup(source, common)).bytes;
    const target = new MemoryVault();
    await restoreBackup(bytes, { target, subtle, mode: 'replace' });
    const got = target.rows('highlights').find((r) => r.id === row.id) as Row;
    expect(got.customFields).toEqual({
      constructor: 'a value',
      prototype: 'another',
      toString: 'text',
    });
  });

  it('every member of a single-file JSON backup is checked as well', async () => {
    const out = await exportJson(seedVault(3), common);
    const doc = JSON.parse(text(out.bytes)) as {
      checksum: string;
      data: Record<string, Row[]>;
      tables: { name: string; rowCount: number; sha256: string }[];
    };
    // a consistent forgery (counts, table checksum and manifest checksum all repaired)
    const forgedLine = `{"id":"bank-forged01","${BACKSLASH}u005f_proto__":{"polluted":true}}`;
    const banks = doc.data.banks as Row[];
    const table = doc.tables.find((t) => t.name === 'banks') as (typeof doc.tables)[number];
    table.rowCount = banks.length + 1;
    table.sha256 = tableSha([...banks.map((r) => JSON.stringify(r)), forgedLine].join('\n'));
    banks.push({ id: 'bank-forged01', PLACEHOLDER: 1 });
    const { checksum: _old, data: _rows, ...head } = doc;
    doc.checksum = sha(canonicalJson(head));
    const forged = JSON.stringify(doc).replace(
      '{"id":"bank-forged01","PLACEHOLDER":1}',
      forgedLine,
    );
    expect(forged).toContain(forgedLine);

    const err = await restoreBackup(new TextEncoder().encode(forged), {
      target: new MemoryVault(),
      subtle,
      mode: 'replace',
    }).catch((e) => e);
    expect(err).toBeInstanceOf(BackupError);
    expect(err.code).toBe('row_invalid');
    expect(err.details.invalidRows.items[0].reason).toBe('forbidden_key');
    expect(Object.prototype).not.toHaveProperty('polluted');
  });
});

describe('only the row that passed every check is staged', () => {
  it('an invalid first row with the same key does not displace the valid one', async () => {
    const files = unpack((await exportBackup(seedVault(12), common)).bytes);
    const lines = text(files['tables/highlights.ndjson'] as Uint8Array)
      .split('\n')
      .filter(Boolean);
    const valid = JSON.parse(lines[0] as string) as Row;
    const invalidFirst = { ...valid, priority: 99, userComment: 'FROM THE INVALID LINE' };
    const forged = withTable(
      files,
      'highlights',
      `${[JSON.stringify(invalidFirst), ...lines].join('\n')}\n`,
      true,
    );
    const target = new MemoryVault();
    const { report } = await restoreBackup(forged, {
      target,
      subtle,
      mode: 'replace',
      invalidRows: 'skip',
      orphans: 'skip',
    });
    expect(report.invalidRows.items.map((i) => [i.line, i.reason])).toEqual([[1, 'schema']]);
    const got = target.rows('highlights').find((r) => r.id === valid.id) as Row;
    expect(got.priority).toBe(valid.priority);
    expect(got.userComment).toBe(valid.userComment);
    expect(JSON.stringify(target.rows('highlights'))).not.toContain('FROM THE INVALID LINE');
  });
});

// ---------------------------------------------------------------------------------------------
// Provenance: what a merge may not change comes from the target, never from the engine
// ---------------------------------------------------------------------------------------------

describe('a forged merge-mode archive cannot rewrite capture provenance', () => {
  /** A different, schema-valid value for each field the target lists as immutable. */
  const FORGE: Record<string, Record<string, (row: Row) => unknown>> = {
    sources: {
      type: () => 'pdf',
      urlKey: () => 'https://evil.example/key',
      visitedKey: () => 'https://evil.example/visited',
      originalUrl: () => 'https://evil.example/page',
      canonicalUrl: () => 'https://evil.example/canonical',
      host: () => 'evil.example',
    },
    folders: { bankId: () => 'bank-00000002' },
    highlights: {
      sourceId: () => 'src-00000001',
      exactQuote: () => 'A quote nobody saved',
      normalizedQuote: () => 'a quote nobody saved',
      quoteHash: () => 'f'.repeat(64),
      anchorSet: (row) => ({
        ...(row.anchorSet as Row),
        textPosition: { start: 1, end: 7 },
      }),
      headingContext: () => 'Forged heading',
      captureMethod: () => 'shortcut',
      capturedAt: () => at(777),
      capturedUrl: () => 'https://evil.example/cited-here',
      capturedTitle: () => 'Forged title',
    },
  };

  const cases = Object.entries(TEST_IMMUTABLE_FIELDS).flatMap(([table, fields]) =>
    fields.map((field) => [table, field] as const),
  );

  it('the test covers every field the target lists', () => {
    for (const [table, field] of cases)
      expect(FORGE[table]?.[field], `${table}.${field}`).toBeDefined();
  });

  it.each(cases)(
    '%s.%s keeps the local value and is reported as a conflict',
    async (table, field) => {
      const seed = seedData(30, 3);
      const archiveSide = new MemoryVault(seed as unknown as Record<string, Row[]>);
      const liveSide = new MemoryVault(structuredClone(seed) as unknown as Record<string, Row[]>);
      // (index 2 of highlights sits on src-00000000, so the forged sourceId really differs)
      const victim = archiveSide.rows(table)[
        table === 'folders' ? 3 : table === 'highlights' ? 2 : 1
      ] as Row;
      const id = victim.id as string;
      const original = victim[field];
      const forged = (FORGE[table] as Record<string, (row: Row) => unknown>)[field] as (
        row: Row,
      ) => unknown;
      victim[field] = forged(victim);
      expect(victim[field]).not.toEqual(original);
      victim.updatedAt = at(900); // newer than everything: an ordinary edit would win
      victim.userComment = 'rides along with the forgery'; // a mutable field of the same row
      const bytes = (await exportBackup(archiveSide, common)).bytes;

      const { report, result } = await restoreBackup(bytes, {
        target: liveSide,
        subtle,
        mode: 'merge',
      });
      const kept = liveSide.rows(table).find((r) => r.id === id) as Row;
      expect(kept[field]).toEqual(original);
      expect(kept.userComment).not.toBe('rides along with the forgery');
      expect(report.conflicts.items.map((c) => [c.table, c.key, c.reason])).toEqual([
        [table, JSON.stringify(id), 'immutable_field_changed'],
      ]);
      expect(result?.written[table]).toBe(0);
    },
  );

  it('a field the live row never had (older row) cannot be added by an archive either', async () => {
    const seed = seedData(5, 4);
    const liveSide = new MemoryVault(structuredClone(seed) as unknown as Record<string, Row[]>);
    delete (liveSide.rows('highlights')[0] as Row).capturedUrl;
    const archiveSide = new MemoryVault(structuredClone(seed) as unknown as Record<string, Row[]>);
    (archiveSide.rows('highlights')[0] as Row).updatedAt = at(900);
    const bytes = (await exportBackup(archiveSide, common)).bytes;
    const { report } = await restoreBackup(bytes, { target: liveSide, subtle, mode: 'merge' });
    expect(report.conflicts.total).toBe(1);
    expect(liveSide.rows('highlights')[0]).not.toHaveProperty('capturedUrl');
  });

  it('replace on an empty vault still imports the very same archive', async () => {
    const seed = seedData(10, 6) as Seed;
    const source = new MemoryVault(seed as unknown as Record<string, Row[]>);
    const forgedRow = source.rows('highlights')[0] as Row;
    forgedRow.capturedUrl = 'https://evil.example/cited-here';
    const bytes = (await exportBackup(source, common)).bytes;
    const target = new MemoryVault();
    await restoreBackup(bytes, { target, subtle, mode: 'replace' });
    expect(target.rows('highlights')).toHaveLength(10);
    expect(target.rows('highlights')[0]?.capturedUrl).toBe('https://evil.example/cited-here');
    // ... and into an empty vault by merge: new rows are additions, not overwrites
    const merged = new MemoryVault();
    await restoreBackup(bytes, { target: merged, subtle, mode: 'merge' });
    expect(merged.snapshot()).toBe(target.snapshot());
  });

  it('the list is the target’s: with an empty list a merge updates, with "*" nothing changes', async () => {
    const seed = seedData(6, 8);
    const make = (extra: ConstructorParameters<typeof MemoryVault>[1]) =>
      new MemoryVault(structuredClone(seed) as unknown as Record<string, Row[]>, extra);
    const edited = make(undefined);
    const noteRow = (edited.rows('notes')[0] ?? ({} as Row)) as Row;
    noteRow.body = 'rewritten body';
    noteRow.updatedAt = at(900);
    const bytes = (await exportBackup(edited, common)).bytes;

    const open = make({ immutableFields: {} });
    await restoreBackup(bytes, { target: open, subtle, mode: 'merge' });
    expect(open.rows('notes')[0]?.body).toBe('rewritten body');

    const closed = make({ immutableFields: { notes: ['*'] } });
    const { report } = await restoreBackup(bytes, { target: closed, subtle, mode: 'merge' });
    expect(closed.rows('notes')[0]?.body).not.toBe('rewritten body');
    expect(report.conflicts.items[0]?.reason).toBe('immutable_field_changed');
  });
});

// ---------------------------------------------------------------------------------------------
// Rows that cite other rows' text are re-checked against the vault
// ---------------------------------------------------------------------------------------------

describe('citation guard', () => {
  const AI_REGISTRY: TableRegistry = {
    schemaVersion: TEST_REGISTRY.schemaVersion,
    tables: [
      ...TEST_REGISTRY.tables,
      spec('aiResults', 'id', z.looseObject({ id: z.string().min(8) })),
    ],
  };
  /** Stand-in for the storage layer's AI guard: demotes a claim whose quote is not in its passage. */
  const guard: CitationGuard = {
    table: 'aiResults',
    passages: { highlights: 'exactQuote', notes: 'body' },
    cited: (row) => (Array.isArray(row.cites) ? (row.cites as string[]) : []),
    regrade(row, passages) {
      if (row.label !== 'source_supported') return row;
      const held = (row.cites as string[]).every((id) =>
        passages.get(id)?.text.includes(String(row.quote)),
      );
      return held ? row : { ...row, label: 'unverified', cites: [] };
    },
  };
  const QUOTE = 'Aspirin irreversibly inhibits COX-1.';
  const ai = (id: string, quote: string, cites: string[]): Row => ({
    id,
    label: 'source_supported',
    quote,
    cites,
  });

  function vaultWith(rows: Row[], highlightText: string | null) {
    const seed = seedData(1, 2);
    const v = new MemoryVault(
      highlightText === null ? {} : (seed as unknown as Record<string, Row[]>),
      { registry: AI_REGISTRY, citationGuard: guard },
    );
    if (highlightText !== null) {
      const h = v.rows('highlights')[0] as Row;
      h.exactQuote = highlightText;
    }
    v.load('aiResults', rows);
    return v;
  }
  const highlightId = (v: MemoryVault) => (v.rows('highlights')[0] as Row).id as string;

  it('replace: holds what the archive’s own highlights support and demotes the rest', async () => {
    const source = vaultWith([], QUOTE);
    const hl = highlightId(source);
    source.load('aiResults', [
      ai('ai-supported', 'irreversibly inhibits', [hl]),
      ai('ai-forged-01', 'Aspirin cures everything', [hl]),
      ai('ai-nowhere-1', 'irreversibly inhibits', ['no-such-highlight']),
    ]);
    const bytes = (await exportBackup(source, common)).bytes;

    const target = new MemoryVault({}, { registry: AI_REGISTRY, citationGuard: guard });
    const prepared = await prepareRestore(bytes, { target, subtle, mode: 'replace' });
    expect(prepared.report.warnings.join(' ')).toMatch(/2 AI result/);
    await prepared.commit();
    const by = (id: string) => target.rows('aiResults').find((r) => r.id === id) as Row;
    expect(by('ai-supported').label).toBe('source_supported');
    expect(by('ai-forged-01')).toMatchObject({ label: 'unverified', cites: [] });
    expect(by('ai-nowhere-1')).toMatchObject({ label: 'unverified', cites: [] });
  });

  it('merge: a passage that only the live vault has still supports a citation', async () => {
    const live = vaultWith([], QUOTE);
    const hl = highlightId(live);
    // the archive carries the AI result and none of the highlights
    const archive = new MemoryVault({}, { registry: AI_REGISTRY });
    archive.load('aiResults', [ai('ai-live-0001', 'irreversibly inhibits', [hl])]);
    const bytes = (await exportBackup(archive, common)).bytes;

    await restoreBackup(bytes, { target: live, subtle, mode: 'merge' });
    expect(live.rows('aiResults')[0]?.label).toBe('source_supported');

    // replace discards the live highlight first, so the same claim is no longer backed
    const replaced = vaultWith([], QUOTE);
    await restoreBackup(bytes, { target: replaced, subtle, mode: 'replace' });
    expect(replaced.rows('aiResults')[0]).toMatchObject({ label: 'unverified', cites: [] });
  });

  it('a forged dry-run number equals what is committed', async () => {
    const source = vaultWith([], QUOTE);
    source.load('aiResults', [ai('ai-forged-01', 'not in the highlight', [highlightId(source)])]);
    const bytes = (await exportBackup(source, common)).bytes;
    const target = new MemoryVault({}, { registry: AI_REGISTRY, citationGuard: guard });
    const prepared = await prepareRestore(bytes, { target, subtle, mode: 'replace' });
    const result = await prepared.commit();
    expect(result.report.warnings).toEqual(prepared.report.warnings);
    expect(target.rows('aiResults')[0]?.label).toBe('unverified');
  });

  it('a target without a guard takes the rows as they are', async () => {
    const source = vaultWith([], QUOTE);
    source.load('aiResults', [ai('ai-forged-01', 'not in the highlight', [highlightId(source)])]);
    const bytes = (await exportBackup(source, common)).bytes;
    const target = new MemoryVault({}, { registry: AI_REGISTRY });
    await restoreBackup(bytes, { target, subtle, mode: 'replace' });
    expect(target.rows('aiResults')[0]?.label).toBe('source_supported');
  });
});

// ---------------------------------------------------------------------------------------------
// One restore at a time
// ---------------------------------------------------------------------------------------------

describe('exclusive restore', () => {
  it('a second commit while one runs is refused, and the first completes', async () => {
    const bytes = (await exportBackup(seedVault(20), common)).bytes;
    const target = seedVault(3, undefined, 5);
    const first = await prepareRestore(bytes, { target, subtle, mode: 'replace' });
    const second = await prepareRestore(bytes, { target, subtle, mode: 'replace' });
    const outcomes = await Promise.allSettled([first.commit(), second.commit()]);
    expect(outcomes[0].status).toBe('fulfilled');
    expect(outcomes[1].status).toBe('rejected');
    expect(((outcomes[1] as PromiseRejectedResult).reason as BackupError).code).toBe(
      'restore_in_progress',
    );
    expect(target.liveWrites).toBe(1);
    expect(target.rows('highlights')).toHaveLength(20);
    // released afterwards
    const third = await prepareRestore(bytes, { target, subtle, mode: 'merge' });
    await expect(third.commit()).resolves.toBeDefined();
  });
});
