// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { exportBackup } from './export';
import { decide, metaOf, type RowMeta } from './merge';
import { prepareRestore, restoreBackup } from './restore';
import { MemoryVault, NOW, subtle, seedData, type Seed } from './testkit';
import type { Row } from './types';

const T = (n: number) => new Date(Date.UTC(2026, 5, 1, 0, n)).toISOString();

const bank = (id: string, name: string, updated: number, deleted: number | null = null): Row => ({
  id,
  schemaVersion: 1,
  createdAt: T(0),
  updatedAt: T(updated),
  deletedAt: deleted === null ? null : T(deleted),
  name,
  color: 'blue',
  position: 0,
  isInbox: false,
});

const meta = (row: Row, immutable?: string[]): RowMeta => metaOf(row, undefined, immutable);

describe('decide (merge rule for one key)', () => {
  const cases: [string, Row | undefined, Row, string][] = [
    ['archive-only row is added', undefined, bank('b-aaaaaaaa', 'A', 1), 'add'],
    [
      'identical rows are skipped',
      bank('b-aaaaaaaa', 'A', 1),
      bank('b-aaaaaaaa', 'A', 1),
      'identical',
    ],
    [
      'archive newer edit updates',
      bank('b-aaaaaaaa', 'old', 1),
      bank('b-aaaaaaaa', 'new', 5),
      'update',
    ],
    [
      'live newer edit is kept',
      bank('b-aaaaaaaa', 'live', 9),
      bank('b-aaaaaaaa', 'arch', 5),
      'live_newer',
    ],
    [
      'live tombstone newer than archive edit stays deleted',
      bank('b-aaaaaaaa', 'x', 8, 8),
      bank('b-aaaaaaaa', 'edited', 5),
      'live_newer',
    ],
    [
      'archive edit after the live tombstone resurrects',
      bank('b-aaaaaaaa', 'x', 3, 3),
      bank('b-aaaaaaaa', 'edited', 6),
      'update',
    ],
    [
      'archive tombstone newer than live edit deletes (soft)',
      bank('b-aaaaaaaa', 'x', 3),
      bank('b-aaaaaaaa', 'x', 7, 7),
      'update',
    ],
    [
      'live edit after the archive tombstone is kept',
      bank('b-aaaaaaaa', 'x', 9),
      bank('b-aaaaaaaa', 'x', 4, 4),
      'live_newer',
    ],
    [
      'same instant, different content is a conflict (live kept)',
      bank('b-aaaaaaaa', 'one', 5),
      bank('b-aaaaaaaa', 'two', 5),
      'conflict',
    ],
    [
      'same instant, archive tombstone wins the tie',
      bank('b-aaaaaaaa', 'x', 5),
      bank('b-aaaaaaaa', 'x', 5, 5),
      'update',
    ],
    [
      'same instant, live tombstone wins the tie',
      bank('b-aaaaaaaa', 'x', 5, 5),
      bank('b-aaaaaaaa', 'x', 5),
      'live_newer',
    ],
  ];
  it.each(cases)('%s', (_name, live, archive, kind) => {
    expect(decide(meta(archive), live ? meta(live) : undefined).kind).toBe(kind);
  });

  it('a row without timestamps that differs is a conflict, never a silent overwrite', () => {
    const a = { highlightId: 'h', bankId: 'b', folderId: null, addedAt: T(1) };
    const b = { ...a, addedAt: T(2) };
    expect(decide(meta(a), meta(b))).toEqual({
      kind: 'conflict',
      reason: 'no_timestamp_different_content',
    });
  });

  it('different immutable fields are a conflict even when the archive is newer', () => {
    const live = { id: 'h-aaaaaaaa', exactQuote: 'original', updatedAt: T(1) };
    const arch = { id: 'h-aaaaaaaa', exactQuote: 'rewritten', updatedAt: T(9) };
    expect(decide(meta(arch, ['exactQuote']), meta(live, ['exactQuote']))).toEqual({
      kind: 'conflict',
      reason: 'immutable_field_changed',
    });
  });

  it('derived-field-only differences are identical', () => {
    const a = { id: 'x', updatedAt: T(1), resolveStatus: 'resolved' };
    const b = { id: 'x', updatedAt: T(1), resolveStatus: 'orphaned' };
    expect(
      decide(metaOf(a, ['resolveStatus'], undefined), metaOf(b, ['resolveStatus'], undefined)).kind,
    ).toBe('identical');
  });
});

describe('merge restore', () => {
  async function scenario() {
    // Archive side
    const a = seedData(12, 1);
    const b = seedData(12, 1);
    const archiveVault = new MemoryVault(a as unknown as Record<string, Row[]>);
    const hl = (s: Seed, i: number) => s.highlights[i] as Row;

    // live starts as a copy; then diverges
    const live = new MemoryVault(b as unknown as Record<string, Row[]>);
    const liveHl = (i: number) =>
      live.data.get('highlights')!.get(JSON.stringify(hl(b, i).id)) as Row;
    const archHl = (i: number) =>
      archiveVault.data.get('highlights')!.get(JSON.stringify(hl(a, i).id)) as Row;

    // 1: archive edited later -> update
    archHl(1).userComment = 'archive wins';
    archHl(1).updatedAt = T(500);
    // 2: live edited later -> kept
    liveHl(2).userComment = 'live wins';
    liveHl(2).updatedAt = T(500);
    archHl(2).userComment = 'older archive edit';
    archHl(2).updatedAt = T(100);
    // 3: deleted locally, archive has an older edit -> stays deleted
    liveHl(3).deletedAt = T(400);
    liveHl(3).updatedAt = T(400);
    archHl(3).userComment = 'edited before the delete';
    archHl(3).updatedAt = T(300);
    // 4: deleted in the archive later than the live edit -> tombstone applies
    archHl(4).deletedAt = T(600);
    archHl(4).updatedAt = T(600);
    // 5: same id, different quote (provenance) even though archive is newer -> conflict
    archHl(5).exactQuote = 'Someone rewrote the quote';
    archHl(5).updatedAt = T(900);
    // 6: same instant, different comment -> conflict
    archHl(6).userComment = 'A';
    liveHl(6).userComment = 'B';
    archHl(6).updatedAt = T(50);
    liveHl(6).updatedAt = T(50);
    // 7: derived field only
    archHl(7).resolveStatus = 'orphaned';
    // live-only row, archive-only row
    live.load('banks', [bank('bank-liveonly', 'Local only', 10)]);
    archiveVault.load('banks', [bank('bank-archonly', 'Archive only', 10)]);
    const out = await exportBackup(archiveVault, { subtle, now: () => NOW });
    return { live, out, ids: (i: number) => hl(a, i).id as string };
  }

  it('applies the rules, never deletes, lists conflicts, keeps ids stable', async () => {
    const { live, out, ids } = await scenario();
    const beforeIds = new Set(live.rows('highlights').map((r) => r.id));
    const { report, result } = await restoreBackup(out.bytes, {
      target: live,
      subtle,
      mode: 'merge',
    });
    const get = (i: number) => live.rows('highlights').find((r) => r.id === ids(i)) as Row;

    expect(get(1).userComment).toBe('archive wins');
    expect(get(2).userComment).toBe('live wins');
    expect(get(3).deletedAt).toBe(T(400));
    expect(get(3).userComment).not.toBe('edited before the delete');
    expect(get(4).deletedAt).toBe(T(600));
    expect(get(5).exactQuote).not.toBe('Someone rewrote the quote');
    expect(get(6).userComment).toBe('B');
    expect(get(7).resolveStatus).not.toBe('orphaned');

    // nothing local was removed; the archive-only bank arrived; the live-only bank stayed
    expect(new Set(live.rows('highlights').map((r) => r.id))).toEqual(beforeIds);
    expect(live.rows('banks').map((r) => r.id)).toEqual(
      expect.arrayContaining(['bank-liveonly', 'bank-archonly']),
    );

    const h = report.tables.highlights!;
    expect(h).toMatchObject({ update: 2, skipLiveNewer: 2, conflict: 2, skipIdentical: 6, add: 0 });
    expect(report.tables.banks).toMatchObject({ add: 1, liveOnly: 1 });
    expect(report.conflicts.items.map((c) => [c.key, c.reason]).sort()).toEqual(
      [
        [JSON.stringify(ids(5)), 'immutable_field_changed'],
        [JSON.stringify(ids(6)), 'same_timestamp_different_content'],
      ].sort(),
    );
    expect(report.overwritten.items.map((o) => o.direction)).toEqual(
      expect.arrayContaining(['archive_newer']),
    );
    expect(result!.written.highlights).toBe(2);
    expect(live.liveWrites).toBe(1);
  });

  it('dry run numbers equal what the commit then does', async () => {
    const { live, out } = await scenario();
    const dry = await prepareRestore(out.bytes, { target: live, subtle, mode: 'merge' });
    const before = live.snapshot();
    expect(live.snapshot()).toBe(before);
    const result = await dry.commit();
    expect(result.report.tables).toEqual(dry.report.tables);
  });

  it('decides again at commit time: an edit made after the dry run is not overwritten', async () => {
    const { live, out, ids } = await scenario();
    const prepared = await prepareRestore(out.bytes, { target: live, subtle, mode: 'merge' });
    expect(prepared.report.tables.highlights?.update).toBe(2);
    // the user keeps working while the dry run is on screen
    const row = live.rows('highlights').find((r) => r.id === ids(1)) as Row;
    row.userComment = 'edited meanwhile';
    row.updatedAt = T(9999);
    const result = await prepared.commit();
    expect(live.rows('highlights').find((r) => r.id === ids(1))!.userComment).toBe(
      'edited meanwhile',
    );
    expect(result.report.tables.highlights?.update).toBe(1);
  });

  it('replace mode reports what it would overwrite and remove', async () => {
    const { live, out } = await scenario();
    const { report } = await restoreBackup(out.bytes, {
      target: live,
      subtle,
      mode: 'replace',
      dryRun: true,
    });
    expect(report.replaceImpact.overwrittenNewerLiveRows).toBe(
      report.tables.highlights!.skipLiveNewer +
        report.tables.highlights!.conflict +
        report.tables.banks!.skipLiveNewer +
        report.tables.banks!.conflict +
        (report.tables.sources?.conflict ?? 0),
    );
    expect(report.replaceImpact.removedLiveOnlyRows).toBe(1);
    expect(report.replaceImpact.tablesCleared).toContain('highlightBanks');
    expect(report.replaceImpact.tablesCleared).not.toContain('attachments');
  });
});
