import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '@shared';
import { isNewerRow, normaliseRow } from './rows';

describe('normaliseRow', () => {
  const v1 = { id: 'bank-0001', schemaVersion: 1, name: 'Inbox' };

  it('passes a current row through unchanged', () => {
    expect(normaliseRow(v1)).toEqual(v1);
    expect(isNewerRow(v1)).toBe(false);
  });

  it('reads a row from a newer build as the current shape', () => {
    const row = { ...v1, schemaVersion: SCHEMA_VERSION + 1, extra: true };
    expect(normaliseRow(row)).toEqual({ ...row, schemaVersion: SCHEMA_VERSION });
    expect(isNewerRow(row)).toBe(true);
    // The stored row is not modified.
    expect(row.schemaVersion).toBe(SCHEMA_VERSION + 1);
  });

  it('leaves rows without a usable version for validation to reject', () => {
    for (const row of [
      { id: 'x' },
      { schemaVersion: 0 },
      { schemaVersion: -1 },
      { schemaVersion: 1.5 },
      { schemaVersion: '1' },
      null,
      'text',
      [],
    ]) {
      expect(normaliseRow(row)).toBe(row);
      expect(isNewerRow(row)).toBe(false);
    }
  });
});
