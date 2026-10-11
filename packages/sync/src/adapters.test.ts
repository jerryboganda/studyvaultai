// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Bank, Highlight, HighlightBank, Source } from '@shared';
import type { TableRegistry } from '@shared';
import {
  backfillChanges,
  checkPolicy,
  decodeEntityId,
  deserializeSnapshot,
  encodeEntityId,
  policyFromRegistry,
  serializeRow,
  syncableTables,
} from './adapters.ts';
import { STUDYVAULT_SYNC_POLICY } from './policy.ts';

// Optional cross-check against the vault task's schemas, without coupling to their file layout.
const vault: Record<string, unknown> | null = await import('@shared/vault').catch(() => null);

const registry: TableRegistry = {
  schemaVersion: 2,
  tables: [
    { name: 'banks', primaryKey: 'id', schema: Bank, softDelete: true },
    { name: 'sources', primaryKey: 'id', schema: Source, softDelete: true },
    {
      name: 'highlights',
      primaryKey: 'id',
      schema: Highlight,
      softDelete: true,
      derivedFields: ['resolveStatus', 'resolveConfidence', 'lastResolvedAt'],
    },
    {
      name: 'highlightBanks',
      primaryKey: ['highlightId', 'bankId'],
      schema: HighlightBank,
      softDelete: false,
    },
    {
      name: 'attachments',
      primaryKey: 'id',
      schema: z.object({ id: z.string(), blob: z.any() }),
      softDelete: false,
      localOnly: true,
    },
  ],
};

describe('registry adapters', () => {
  it('encodes compound keys and decodes them back, including separators in values', () => {
    const id = encodeEntityId(['highlightId', 'bankId'], { highlightId: 'a|b', bankId: 'c\\d' });
    expect(id).toBe('a\\|b|c\\\\d');
    expect(decodeEntityId(['highlightId', 'bankId'], id)).toEqual({
      highlightId: 'a|b',
      bankId: 'c\\d',
    });
    expect(decodeEntityId(['highlightId', 'bankId'], 'only-one')).toBeNull();
    expect(encodeEntityId('id', { id: 'x1' })).toBe('x1');
    expect(() => encodeEntityId('id', {})).toThrow();
  });

  it('never syncs local-only tables, and tables without a policy', () => {
    const names = syncableTables(registry, STUDYVAULT_SYNC_POLICY).map((t) => t.name);
    expect(names).toEqual(['banks', 'sources', 'highlights', 'highlightBanks']);
  });

  it('the shipped policy only names fields that exist in the real schemas', () => {
    const real = Object.fromEntries(
      Object.entries(STUDYVAULT_SYNC_POLICY).filter(([t]) =>
        ['banks', 'sources', 'highlights', 'highlightBanks'].includes(t),
      ),
    );
    expect(checkPolicy(registry, real)).toEqual([]);
    // And the check is real: a misspelt free-text field would silently merge last-writer-wins.
    expect(checkPolicy(registry, { highlights: { text: ['userComent'] } })).toEqual([
      'highlights.userComent (text) is not a field of the table schema',
    ]);
  });

  it.runIf(vault !== null)(
    'the shipped policy also matches the vault entities that exist (skipped for any that moved)',
    () => {
      const v = vault as Record<string, unknown>;
      const candidates: [string, string, string | readonly string[]][] = [
        ['folders', 'Folder', 'id'],
        ['tags', 'Tag', 'id'],
        ['highlightTags', 'HighlightTag', ['highlightId', 'tagId']],
        ['notes', 'Note', 'id'],
        ['documents', 'PdfDocument', 'id'],
        ['ocrPages', 'OcrPage', ['documentId', 'pageNumber']],
      ];
      const tables = candidates
        .filter(([, exportName]) => v[exportName] !== undefined)
        .map(([name, exportName, primaryKey]) => ({
          name,
          primaryKey,
          schema: v[exportName] as z.ZodType,
          softDelete: false,
        }));
      expect(tables.length).toBeGreaterThan(0);
      const policy = Object.fromEntries(
        tables.map((t) => [t.name, STUDYVAULT_SYNC_POLICY[t.name]!]),
      );
      expect(checkPolicy({ schemaVersion: 2, tables }, policy)).toEqual([]);
    },
  );

  it('specialises a policy: derived fields become local, the schema becomes the allow-list', () => {
    const p = policyFromRegistry(registry, STUDYVAULT_SYNC_POLICY);
    expect(p['highlights']!.fields).toContain('exactQuote');
    expect(p['highlights']!.local).toEqual(
      expect.arrayContaining(['resolveStatus', 'resolveConfidence', 'lastResolvedAt']),
    );
    expect(p['attachments']).toBeUndefined();
  });

  it('serialises a row without derived fields, rejects non-JSON, and validates what comes back', () => {
    const spec = registry.tables.find((t) => t.name === 'banks')!;
    const row = {
      id: 'bank-0001',
      schemaVersion: 1,
      createdAt: '2026-10-11T00:00:00.000Z',
      updatedAt: '2026-10-11T00:00:00.000Z',
      deletedAt: null,
      name: 'Physics',
      color: 'blue',
      position: 1,
      isInbox: false,
    };
    const s = serializeRow(spec, row);
    expect(s).toMatchObject({ entityType: 'banks', entityId: 'bank-0001' });
    expect(deserializeSnapshot(spec, s.fields)).toMatchObject({ ok: true });
    const bad = deserializeSnapshot(spec, { ...s.fields, color: 'chartreuse' });
    expect(bad.ok).toBe(false);
    expect(() => serializeRow(spec, { ...row, blob: new Blob(['x']) })).toThrow(/plain JSON/);
  });

  it('turns rows into backfill creates for synced tables only', () => {
    const changes = backfillChanges(registry, STUDYVAULT_SYNC_POLICY, 'highlightBanks', [
      { highlightId: 'h1', bankId: 'b1', folderId: null, addedAt: '2026-10-11T00:00:00.000Z' },
    ]);
    expect(changes).toEqual([
      expect.objectContaining({ kind: 'upsert', entityType: 'highlightBanks', entityId: 'h1|b1' }),
    ]);
    expect(backfillChanges(registry, STUDYVAULT_SYNC_POLICY, 'attachments', [{ id: 'x' }])).toEqual(
      [],
    );
  });
});
