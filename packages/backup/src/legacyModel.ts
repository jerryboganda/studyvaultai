// Test-only: a small data model that evolves over three schema versions, used to produce and read
// the frozen archive fixtures and to exercise migrations independent of the real app schema.
import { z } from 'zod';
import type { TableRegistry, TableSpec } from '@shared';
import type { MigrationStep, Row } from './types';

const iso = z.iso.datetime();
const meta = { id: z.string().min(4), createdAt: iso, updatedAt: iso, deletedAt: iso.nullable() };

const bankV1 = z.object({ ...meta, name: z.string().min(1) });
const bankV3 = bankV1.extend({ color: z.enum(['blue', 'red']) });

const highlightV1 = z.object({
  ...meta,
  bankId: z.string(),
  quote: z.string().min(1),
  comment: z.string(),
});
const highlightV2 = z.object({
  ...meta,
  bankId: z.string(),
  quote: z.string().min(1),
  userComment: z.string(),
});
const highlightV3 = highlightV2.extend({ priority: z.number().int().min(1).max(5) });

const noteV2 = z.object({
  ...meta,
  highlightId: z.string(),
  body: z.string(),
  wordCount: z.number().int(),
});
const noteV3 = noteV2.extend({ pinned: z.boolean() });

const t = (name: string, schema: z.ZodType, extra: Partial<TableSpec> = {}): TableSpec => ({
  name,
  primaryKey: 'id',
  schema,
  softDelete: true,
  ...extra,
});

export function legacyRegistry(version: 1 | 2 | 3): TableRegistry {
  const banks = t('banks', version === 3 ? bankV3 : bankV1);
  const highlights = t(
    'highlights',
    version === 1 ? highlightV1 : version === 2 ? highlightV2 : highlightV3,
    {
      references: [{ field: 'bankId', table: 'banks' }],
    },
  );
  const notes = t('notes', version === 3 ? noteV3 : noteV2, {
    references: [{ field: 'highlightId', table: 'highlights' }],
    derivedFields: ['wordCount'],
  });
  return {
    schemaVersion: version,
    tables: version === 1 ? [banks, highlights] : [banks, highlights, notes],
  };
}

export const LEGACY_MIGRATIONS: MigrationStep[] = [
  {
    from: 1,
    tables: {
      highlights: (row: Row) => {
        const { comment, ...rest } = row;
        return { ...rest, userComment: comment };
      },
    },
  },
  {
    from: 2,
    tables: {
      banks: (row) => ({ ...row, color: 'blue' }),
      highlights: (row) => ({ ...row, priority: 3 }),
      notes: (row) => ({ ...row, pinned: false }),
    },
  },
];

const at = (n: number) => new Date(Date.UTC(2026, 8, 1, 12, n)).toISOString();

/** The same logical data in the shape of each schema version. */
export function legacyData(version: 1 | 2 | 3): Record<string, Row[]> {
  const bank = (id: string, name: string, n: number): Row => ({
    id,
    createdAt: at(n),
    updatedAt: at(n),
    deletedAt: null,
    name,
    ...(version === 3 ? { color: n % 2 ? 'blue' : 'red' } : {}),
  });
  const hl = (id: string, bankId: string, quote: string, comment: string, n: number): Row => ({
    id,
    createdAt: at(n),
    updatedAt: at(n + 1),
    deletedAt: id === 'hl-0003' ? at(n + 2) : null,
    bankId,
    quote,
    ...(version === 1 ? { comment } : { userComment: comment }),
    ...(version === 3 ? { priority: 1 + (n % 5) } : {}),
  });
  const out: Record<string, Row[]> = {
    banks: [bank('bank-001', 'Cardiology', 1), bank('bank-002', 'Pharmacology \u{1F48A}', 2)],
    highlights: [
      hl('hl-0001', 'bank-001', 'Aspirin irreversibly inhibits cyclooxygenase.', '', 10),
      hl(
        'hl-0002',
        'bank-002',
        'Quote with "quotes", a comma, and a\nnewline — üñîçødé',
        'my note',
        11,
      ),
      hl('hl-0003', 'bank-001', '日本語の引用', 'deleted one', 12),
    ],
  };
  if (version >= 2) {
    out.notes = [
      {
        id: 'note-001',
        createdAt: at(20),
        updatedAt: at(21),
        deletedAt: null,
        highlightId: 'hl-0001',
        body: 'Remember the mechanism.',
        wordCount: 3,
        ...(version === 3 ? { pinned: true } : {}),
      },
    ];
  }
  return out;
}
