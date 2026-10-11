import { describe, expect, it } from 'vitest';
import { STUDYVAULT_SYNC_POLICY } from '@sync';
import { GROUP_TEXT, TABLE_GROUP, syncedGroups } from './consent';

describe('the consent list is generated from the sync policy', () => {
  it('has a plain-language label for every synchronised table (add one when a table joins the policy)', () => {
    const { groups, unlabelled } = syncedGroups();
    expect(unlabelled).toEqual([]);
    const listed = groups.flatMap((g) => g.tables).sort();
    expect(listed).toEqual(Object.keys(STUDYVAULT_SYNC_POLICY).sort());
  });

  it('only maps tables that are in the policy to groups that have text', () => {
    for (const [table, group] of Object.entries(TABLE_GROUP)) {
      expect(Object.keys(STUDYVAULT_SYNC_POLICY), table).toContain(table);
      expect(GROUP_TEXT[group], table).toBeDefined();
    }
  });

  it('names what the old consent text left out', () => {
    const text = syncedGroups()
      .groups.map((g) => `${g.label} ${g.detail}`)
      .join(' ');
    for (const wanted of [
      /flashcards/i,
      /review history/i,
      /address/i,
      /title/i,
      /PDF/,
      /recognised text/i,
      /position of every word/i,
    ]) {
      expect(text).toMatch(wanted);
    }
  });

  it('does not hide a table that has no label yet: it is listed under its raw name and reported', () => {
    const { groups, unlabelled } = syncedGroups({
      ...STUDYVAULT_SYNC_POLICY,
      voiceNotes: { local: ['schemaVersion'] },
    });
    expect(unlabelled).toEqual(['voiceNotes']);
    const other = groups.find((g) => g.id === 'other');
    expect(other?.detail).toContain('voiceNotes');
  });
});
