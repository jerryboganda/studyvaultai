// @vitest-environment node
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FilingRule,
  INBOX_BANK_ID,
  MAX_FILING_RULES,
  matchFilingRules,
  planFiling,
  type FilingCandidate,
} from '@shared';
import { closeDb, getDb } from './db';
import { createFolder, deleteBank, deleteFolder } from './hierarchy';
import { createBank } from './repo';
import {
  checkFilingRules,
  createFilingRule,
  deleteFilingRule,
  getFilingRule,
  listApplicableFilingRules,
  listFilingRules,
  purgeFilingRules,
  reorderFilingRules,
  restoreFilingRule,
  updateFilingRule,
} from './rules';
import { createTag, deleteTag } from './tags';
import { freshDatabase, trackEpochs } from './test-vault';
import { nextStamp } from './organisation';

beforeEach(async () => {
  await freshDatabase();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

const rule = (bankId: string, over: Record<string, unknown> = {}) => ({
  name: 'Cardiology sites',
  match: { hosts: ['example.com'] },
  action: { bankId },
  ...over,
});

describe('creating a rule', () => {
  it('stores a validated, normalised rule with the defaults that ask before filing', async () => {
    const bank = await createBank('Cardiology');
    const tag = (await createTag('High yield')).tag;
    const created = await createFilingRule({
      name: '  Cardiology  ',
      match: {
        hosts: ['HTTPS://www.Example.com/a', 'example.com', ' Khan.org. '],
        titleContains: ['  heart   failure ', 'HEART failure', ''],
        kinds: ['essential', 'essential'],
      },
      action: { bankId: bank.id, addTagIds: [tag.id, tag.id] },
    });
    expect(FilingRule.safeParse(created).success).toBe(true);
    expect(created).toMatchObject({
      name: 'Cardiology',
      enabled: true,
      requireConfirm: true,
      order: 0,
      deletedAt: null,
      schemaVersion: 1,
      match: {
        hosts: ['www.example.com', 'example.com', 'khan.org'],
        titleContains: ['heart failure'],
        kinds: ['essential'],
      },
      action: { bankId: bank.id, folderId: null, addTagIds: [tag.id] },
    });
    expect(created.match).not.toHaveProperty('urlPrefixes'); // empty fields are left out
    expect(await getFilingRule(created.id)).toEqual(created);
    const second = await createFilingRule(rule(bank.id, { name: 'Second' }));
    expect(second.order).toBe(1);
  });

  it('refuses a rule that could never match, a host that is not one, and unknown targets', async () => {
    const bank = await createBank('Cardiology');
    await expect(createFilingRule(rule(bank.id, { match: {} }))).rejects.toMatchObject({
      code: 'invalid_request',
      message: expect.stringMatching(/at least one condition/),
    });
    await expect(
      createFilingRule(rule(bank.id, { match: { hosts: [], titleContains: ['  '] } })),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      createFilingRule(rule(bank.id, { match: { hosts: ['not a host'] } })),
    ).rejects.toMatchObject({
      code: 'invalid_request',
      message: expect.stringMatching(/site name/),
    });
    await expect(createFilingRule(rule('bank-does-not-exist'))).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      createFilingRule(
        rule(bank.id, { action: { bankId: bank.id, addTagIds: ['tag-does-not-exist'] } }),
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(await listFilingRules({ includeDeleted: true })).toEqual([]);
  });

  it('answers malformed input with invalid_request, never a TypeError', async () => {
    const bank = await createBank('Cardiology');
    for (const match of [
      { hosts: 'example.com' },
      { titleContains: 5 },
      { tagIds: 'tag-0000000001' },
      { kinds: 'essential' },
      null,
    ]) {
      await expect(
        createFilingRule(rule(bank.id, { match: match as never })),
      ).rejects.toMatchObject({ code: 'invalid_request' });
    }
    await expect(
      createFilingRule(rule(bank.id, { action: { bankId: bank.id, addTagIds: 'x' } as never })),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(createFilingRule(rule(bank.id, { action: null as never }))).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });

  it('checks the folder belongs to the bank, and that bank, folder and tags are live', async () => {
    const a = await createBank('A');
    const b = await createBank('B');
    const folder = await createFolder({ bankId: a.id, name: 'Drugs' });
    await expect(
      createFilingRule(rule(b.id, { action: { bankId: b.id, folderId: folder.id } })),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    const ok = await createFilingRule(
      rule(a.id, { action: { bankId: a.id, folderId: folder.id } }),
    );
    expect(ok.action.folderId).toBe(folder.id);
    await deleteBank(b.id);
    await expect(createFilingRule(rule(b.id))).rejects.toMatchObject({ code: 'not_found' });
    const tag = (await createTag('Gone soon')).tag;
    await deleteTag(tag.id);
    await expect(
      createFilingRule(rule(a.id, { match: { tagIds: [tag.id] } })),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('the Inbox is a valid target even before its row has been written', async () => {
    const made = await createFilingRule(rule(INBOX_BANK_ID));
    expect(made.action.bankId).toBe(INBOX_BANK_ID);
    expect((await checkFilingRules()).filter((p) => p.ruleId === made.id)).toEqual([]);
  });

  it('enforces the limits of the schema', async () => {
    const bank = await createBank('Cardiology');
    const many = Array.from({ length: 21 }, (_, i) => `site${i}.example.com`);
    await expect(createFilingRule(rule(bank.id, { match: { hosts: many } }))).rejects.toMatchObject(
      {
        code: 'invalid_request',
        message: expect.stringMatching(/match\.hosts/),
      },
    );
    await expect(
      createFilingRule(rule(bank.id, { match: { quoteContains: ['x'.repeat(201)] } })),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(createFilingRule(rule(bank.id, { name: 'n'.repeat(81) }))).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(
      createFilingRule(rule(bank.id, { match: { urlPrefixes: ['https://u:p@example.com/'] } })),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it(`allows at most ${MAX_FILING_RULES} live rules; a deleted one does not count`, async () => {
    const bank = await createBank('Cardiology');
    const first = await createFilingRule(rule(bank.id, { name: 'first' }));
    const db = getDb();
    const rows = Array.from({ length: MAX_FILING_RULES - 1 }, (_, i) => ({
      ...first,
      id: `rule-bulk-${String(i).padStart(5, '0')}`,
      name: `bulk ${i}`,
      order: i + 1,
    }));
    await db.filingRules.bulkAdd(rows);
    await expect(createFilingRule(rule(bank.id, { name: 'one too many' }))).rejects.toMatchObject({
      code: 'invalid_request',
      message: expect.stringMatching(/at most 200/),
    });
    await deleteFilingRule(first.id);
    const made = await createFilingRule(rule(bank.id, { name: 'fits now' }));
    expect(made.order).toBe(MAX_FILING_RULES); // after the highest live order
    await expect(restoreFilingRule(first.id)).rejects.toMatchObject({ code: 'invalid_request' });
  });
});

describe('updating a rule', () => {
  it('changes only what the patch names, and replaces match and action as a whole', async () => {
    const bank = await createBank('Cardiology');
    const other = await createBank('Pharmacology');
    const made = await createFilingRule(
      rule(bank.id, { match: { hosts: ['example.com'], kinds: ['formula'] } }),
    );
    const out = await updateFilingRule(made.id, {
      enabled: false,
      match: { quoteContains: ['aspirin'] },
      action: { bankId: other.id },
    });
    expect(out.status).toBe('saved');
    expect(out.row).toMatchObject({
      name: 'Cardiology sites',
      enabled: false,
      requireConfirm: true,
      match: { quoteContains: ['aspirin'] },
      action: { bankId: other.id, folderId: null, addTagIds: [] },
    });
    expect(out.row.match).not.toHaveProperty('hosts');
    expect(await getFilingRule(made.id)).toEqual(out.row);
  });

  it('is optimistic: a rule that changed since it was read is returned as stale and left alone', async () => {
    const bank = await createBank('Cardiology');
    const made = await createFilingRule(rule(bank.id));
    const mine = made.updatedAt;
    const theirs = await updateFilingRule(made.id, { name: 'Renamed elsewhere' });
    expect(theirs.status).toBe('saved');
    const late = await updateFilingRule(made.id, { name: 'My edit' }, { expectedVersion: mine });
    expect(late.status).toBe('stale');
    expect(late.row.name).toBe('Renamed elsewhere');
    expect((await getFilingRule(made.id))!.name).toBe('Renamed elsewhere');
    const fresh = await updateFilingRule(
      made.id,
      { name: 'My edit' },
      { expectedVersion: late.row.updatedAt },
    );
    expect(fresh).toMatchObject({ status: 'saved', row: { name: 'My edit' } });
  });

  it('two editors holding the same version: exactly one wins', async () => {
    const bank = await createBank('Cardiology');
    const made = await createFilingRule(rule(bank.id));
    const results = await Promise.all([
      updateFilingRule(made.id, { name: 'A' }, { expectedVersion: made.updatedAt }),
      updateFilingRule(made.id, { name: 'B' }, { expectedVersion: made.updatedAt }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['saved', 'stale']);
  });

  it('a patch that changes nothing writes nothing, and every write moves updatedAt forward', async () => {
    const bank = await createBank('Cardiology');
    const made = await createFilingRule(rule(bank.id));
    const epochs = trackEpochs();
    const same = await updateFilingRule(made.id, { name: made.name, enabled: true });
    expect(same.row).toEqual(made);
    expect(epochs).toHaveLength(0);
    let previous = made.updatedAt;
    for (let i = 0; i < 5; i++) {
      const out = await updateFilingRule(made.id, { name: `Name ${i}` });
      expect(out.row.updatedAt > previous).toBe(true);
      previous = out.row.updatedAt;
    }
  });

  it('checks references that are new, and lets a rule with an old broken one be edited', async () => {
    const bank = await createBank('Cardiology');
    const tag = (await createTag('Keep')).tag;
    const made = await createFilingRule(
      rule(bank.id, { action: { bankId: bank.id, addTagIds: [tag.id] } }),
    );
    await deleteTag(tag.id);
    // untouched dangling reference: renaming and switching off still work
    const renamed = await updateFilingRule(made.id, { name: 'Renamed', enabled: false });
    expect(renamed.row.name).toBe('Renamed');
    // a new reference to something that is gone is refused
    await expect(
      updateFilingRule(made.id, { action: { bankId: 'bank-does-not-exist' } }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(updateFilingRule(made.id, { match: {} })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(updateFilingRule('rule-does-not-exist', { name: 'x' })).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('order', () => {
  it('puts the listed rules first and rewrites order as 0..n-1, all or nothing', async () => {
    const bank = await createBank('Cardiology');
    const [a, b, c, d] = [
      await createFilingRule(rule(bank.id, { name: 'a' })),
      await createFilingRule(rule(bank.id, { name: 'b' })),
      await createFilingRule(rule(bank.id, { name: 'c' })),
      await createFilingRule(rule(bank.id, { name: 'd' })),
    ];
    const out = await reorderFilingRules([c!.id, a!.id]);
    expect(out.map((r) => [r.name, r.order])).toEqual([
      ['c', 0],
      ['a', 1],
      ['b', 2],
      ['d', 3],
    ]);
    expect((await listFilingRules()).map((r) => r.name)).toEqual(['c', 'a', 'b', 'd']);
    // a bad id changes nothing
    await expect(reorderFilingRules([d!.id, 'rule-does-not-exist'])).rejects.toMatchObject({
      code: 'not_found',
    });
    expect((await listFilingRules()).map((r) => r.name)).toEqual(['c', 'a', 'b', 'd']);
    // the same order again writes nothing
    const epochs = trackEpochs();
    await reorderFilingRules([c!.id, a!.id, b!.id, d!.id]);
    expect(epochs).toHaveLength(0);
  });
});

describe('delete, restore, purge', () => {
  it('soft-deletes, hides, restores last, and purges only what is deleted', async () => {
    const bank = await createBank('Cardiology');
    const a = await createFilingRule(rule(bank.id, { name: 'a' }));
    const b = await createFilingRule(rule(bank.id, { name: 'b' }));
    await deleteFilingRule(a.id);
    await deleteFilingRule(a.id); // not an error
    expect((await listFilingRules()).map((r) => r.name)).toEqual(['b']);
    expect(await getFilingRule(a.id)).toBeNull();
    const all = await listFilingRules({ includeDeleted: true });
    expect(all.map((r) => r.name)).toEqual(['a', 'b']);
    expect(all[0]!.deletedAt).toEqual(expect.any(String));

    const back = await restoreFilingRule(a.id);
    expect(back).toMatchObject({ name: 'a', deletedAt: null, order: b.order + 1 });
    expect((await listFilingRules()).map((r) => r.name)).toEqual(['b', 'a']);

    await expect(purgeFilingRules([b.id])).rejects.toMatchObject({ code: 'invalid_request' });
    await deleteFilingRule(b.id);
    expect(await purgeFilingRules([b.id, 'rule-already-gone'])).toBe(1);
    expect(await getDb().filingRules.get(b.id)).toBeUndefined();
    await deleteFilingRule(a.id);
    expect(await purgeFilingRules()).toBe(1);
    expect(await listFilingRules({ includeDeleted: true })).toEqual([]);
  });

  it('survives a restart', async () => {
    const bank = await createBank('Cardiology');
    const made = await createFilingRule(rule(bank.id));
    closeDb();
    expect(await getFilingRule(made.id)).toEqual(made);
  });
});

describe('references that stop holding', () => {
  it('are reported, and the rule is not applicable until they hold again', async () => {
    const bank = await createBank('Cardiology');
    const folder = await createFolder({ bankId: bank.id, name: 'Drugs' });
    const tag = (await createTag('Pearl')).tag;
    const made = await createFilingRule(
      rule(bank.id, {
        action: { bankId: bank.id, folderId: folder.id, addTagIds: [tag.id] },
        match: { hosts: ['example.com'], tagIds: [tag.id] },
      }),
    );
    const fine = await createFilingRule(rule(INBOX_BANK_ID, { name: 'Inbox rule' }));
    expect(await checkFilingRules()).toEqual([]);
    expect((await listApplicableFilingRules()).map((r) => r.id)).toEqual([made.id, fine.id]);

    await deleteFolder(folder.id);
    await deleteTag(tag.id);
    const problems = await checkFilingRules();
    expect(problems).toEqual(
      expect.arrayContaining([
        { ruleId: made.id, field: 'action.folderId', id: folder.id, problem: 'deleted' },
        { ruleId: made.id, field: 'action.addTagIds', id: tag.id, problem: 'deleted' },
        { ruleId: made.id, field: 'match.tagIds', id: tag.id, problem: 'deleted' },
      ]),
    );
    expect((await listApplicableFilingRules()).map((r) => r.id)).toEqual([fine.id]);
    // the rule itself was not rewritten
    expect(await getFilingRule(made.id)).toEqual(made);

    // a purged bank is "missing"
    await deleteBank(bank.id);
    const { purge } = await import('./trash');
    await purge([{ kind: 'bank', id: bank.id }]);
    expect(await checkFilingRules()).toEqual(
      expect.arrayContaining([
        { ruleId: made.id, field: 'action.bankId', id: bank.id, problem: 'missing' },
      ]),
    );
  });

  it('a folder that is now in another bank is reported as wrong_bank', async () => {
    const a = await createBank('A');
    const b = await createBank('B');
    const folder = await createFolder({ bankId: a.id, name: 'Drugs' });
    const made = await createFilingRule(
      rule(a.id, { action: { bankId: a.id, folderId: folder.id } }),
    );
    await getDb().folders.update(folder.id, { bankId: b.id });
    expect(await checkFilingRules()).toEqual([
      { ruleId: made.id, field: 'action.folderId', id: folder.id, problem: 'wrong_bank' },
    ]);
  });
});

describe('with the matcher', () => {
  const candidate: FilingCandidate = {
    url: 'https://www.example.com/cardio/hf',
    title: 'Heart failure',
    quote: 'ACE inhibitors reduce mortality.',
    kind: 'essential',
    tagIds: [],
    sourceType: 'web',
  };

  it('the stored rules are what matchFilingRules and planFiling work on', async () => {
    const cardio = await createBank('Cardiology');
    const pharm = await createBank('Pharmacology');
    const tag = (await createTag('ACE')).tag;
    await createFilingRule({
      name: 'Pharm words',
      match: { quoteContains: ['ACE inhibitor'] },
      action: { bankId: pharm.id, addTagIds: [tag.id] },
      requireConfirm: false,
    });
    await createFilingRule({
      name: 'Cardio site',
      match: { hosts: ['example.com'] },
      action: { bankId: cardio.id },
      requireConfirm: false,
    });
    await createFilingRule({
      name: 'Evil look-alike',
      match: { hosts: ['evilexample.com'] },
      action: { bankId: cardio.id },
    });
    const rules = await listApplicableFilingRules();
    const matches = matchFilingRules(rules, candidate);
    expect(matches.map((r) => r.name)).toEqual(['Pharm words', 'Cardio site']);
    expect(planFiling(matches)).toMatchObject({
      bankId: pharm.id,
      addTagIds: [tag.id],
      requireConfirm: false,
    });
  });
});

describe('nextStamp', () => {
  it('is the clock when it moved, and one millisecond after the previous when it did not', () => {
    expect(nextStamp('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.500Z')).toBe(
      '2026-01-01T00:00:00.500Z',
    );
    expect(nextStamp('2026-01-01T00:00:00.500Z', '2026-01-01T00:00:00.500Z')).toBe(
      '2026-01-01T00:00:00.501Z',
    );
    expect(nextStamp('2026-01-01T00:00:01.000Z', '2026-01-01T00:00:00.000Z')).toBe(
      '2026-01-01T00:00:01.001Z',
    );
  });
});
