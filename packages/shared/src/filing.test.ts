// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  decideFiling,
  filingMatchApplies,
  filingMessage,
  hasFilingCriteria,
  isDefaultBankChoice,
  matchFilingRules,
  normalizeFilingHost,
  planFiling,
  type FilingCandidate,
  type FilingRuleLike,
} from './filing';
import { FilingRule } from './schema';

const candidate = (over: Partial<FilingCandidate> = {}): FilingCandidate => ({
  url: 'https://www.example.com/courses/pharm/week-1?x=1#top',
  title: 'Week 1: Pharmacokinetics',
  quote: 'Aspirin irreversibly inhibits cyclooxygenase.',
  kind: 'essential',
  tagIds: ['tag-00000001'],
  sourceType: 'web',
  ...over,
});

const rule = (over: Partial<FilingRuleLike> & { id: string }): FilingRuleLike => ({
  enabled: true,
  order: 0,
  match: { hosts: ['example.com'] },
  action: { bankId: 'bank-00000001' },
  ...over,
});

const matches = (match: FilingRuleLike['match'], c: FilingCandidate = candidate()) =>
  filingMatchApplies(match, c);

describe('an empty match never matches', () => {
  it.each([
    ['no field at all', {}],
    ['empty lists', { hosts: [], urlPrefixes: [], titleContains: [], tagIds: [], kinds: [] }],
    [
      'only empty lists of every field',
      {
        hosts: [],
        urlPrefixes: [],
        titleContains: [],
        quoteContains: [],
        tagIds: [],
        kinds: [],
        sourceTypes: [],
      },
    ],
  ])('%s', (_label, match) => {
    expect(hasFilingCriteria(match)).toBe(false);
    expect(matches(match)).toBe(false);
    expect(matchFilingRules([rule({ id: 'rule-00000001', match })], candidate())).toEqual([]);
  });

  it('a blank keyword is not a condition that can be met', () => {
    expect(matches({ titleContains: ['   '] })).toBe(false);
    expect(matches({ quoteContains: [''] })).toBe(false);
  });
});

describe('host matching is on whole labels', () => {
  it.each([
    ['example.com', 'https://example.com/a', true],
    ['example.com', 'https://www.example.com/a', true],
    ['example.com', 'https://a.b.example.com/', true],
    ['example.com', 'https://EXAMPLE.com./a', true],
    ['example.com', 'https://evilexample.com/a', false],
    ['example.com', 'https://notexample.com/', false],
    ['example.com', 'https://example.com.evil.net/', false],
    ['example.com', 'https://evil.net/example.com', false],
    ['example.com', 'https://evil.net/?u=example.com', false],
    ['sub.example.com', 'https://example.com/', false],
    ['sub.example.com', 'https://x.sub.example.com/', true],
    ['example.com', 'https://example.com:8443/', true],
    ['com', 'https://example.com/', true],
    ['example.com', 'https://user:pw@example.com/', true],
  ])('rule host %s against %s -> %s', (host, url, expected) => {
    expect(matches({ hosts: [host] }, candidate({ url }))).toBe(expected);
  });

  it('any one of several hosts is enough', () => {
    const c = candidate({ url: 'https://khanacademy.org/x' });
    expect(matches({ hosts: ['example.com', 'khanacademy.org'] }, c)).toBe(true);
    expect(matches({ hosts: ['example.com', 'wikipedia.org'] }, c)).toBe(false);
  });

  it('a candidate without a usable address has no host', () => {
    for (const url of [
      null,
      '',
      'not a url',
      'https://studyvault.invalid/pdf/abc',
      'file:///x.pdf',
    ]) {
      expect(matches({ hosts: ['example.com'] }, candidate({ url }))).toBe(false);
      expect(matches({ hosts: ['studyvault.invalid'] }, candidate({ url }))).toBe(false);
      expect(matches({ urlPrefixes: ['https://example.com/'] }, candidate({ url }))).toBe(false);
    }
  });
});

describe('address prefixes', () => {
  it('are compared as the URL parser spells them', () => {
    const c = candidate({ url: 'HTTPS://Www.Example.com:443/courses/pharm/week-1?x=1#top' });
    expect(matches({ urlPrefixes: ['https://www.example.com/courses/'] }, c)).toBe(true);
    expect(matches({ urlPrefixes: ['https://www.example.com'] }, c)).toBe(true);
    expect(matches({ urlPrefixes: ['https://www.example.com/courses/pharm/week-1?x=1'] }, c)).toBe(
      true,
    );
  });

  it('do not match a longer host, another scheme or another port', () => {
    const c = candidate({ url: 'https://example.com.evil.net/courses/' });
    expect(matches({ urlPrefixes: ['https://example.com'] }, c)).toBe(false);
    const web = candidate({ url: 'https://example.com/courses/' });
    expect(matches({ urlPrefixes: ['http://example.com/'] }, web)).toBe(false);
    expect(matches({ urlPrefixes: ['https://example.com:8443/'] }, web)).toBe(false);
    expect(matches({ urlPrefixes: ['https://example.com/other/'] }, web)).toBe(false);
  });

  it('are a string prefix: only a trailing slash makes a folder', () => {
    const c = candidate({ url: 'https://example.com/courses/1' });
    expect(matches({ urlPrefixes: ['https://example.com/course'] }, c)).toBe(true);
    expect(matches({ urlPrefixes: ['https://example.com/course/'] }, c)).toBe(false);
  });

  it('ignore a prefix that is not an address', () => {
    expect(matches({ urlPrefixes: ['example.com/courses'] }, candidate())).toBe(false);
  });
});

describe('text conditions', () => {
  it('compare case-insensitively, after NFKC and with collapsed whitespace', () => {
    expect(matches({ titleContains: ['PHARMACOKINETICS'] })).toBe(true);
    expect(matches({ titleContains: ['week   1'] })).toBe(true);
    expect(matches({ quoteContains: ['ＡＳＰＩＲＩＮ'] })).toBe(true); // fullwidth
    expect(matches({ quoteContains: ['cyclo-oxygenase'] })).toBe(false);
  });

  it('look at the title for titleContains and at the quote for quoteContains, not each other', () => {
    expect(matches({ titleContains: ['aspirin'] })).toBe(false);
    expect(matches({ quoteContains: ['pharmacokinetics'] })).toBe(false);
  });
});

describe('tags, kinds and source types', () => {
  it('tagIds: the candidate carries any of them', () => {
    expect(matches({ tagIds: ['tag-00000001', 'tag-00000002'] })).toBe(true);
    expect(matches({ tagIds: ['tag-00000002'] })).toBe(false);
    expect(matches({ tagIds: ['tag-00000001'] }, candidate({ tagIds: [] }))).toBe(false);
  });

  it('kinds and sourceTypes', () => {
    expect(matches({ kinds: ['formula', 'essential'] })).toBe(true);
    expect(matches({ kinds: ['formula'] })).toBe(false);
    expect(matches({ sourceTypes: ['pdf'] })).toBe(false);
    expect(matches({ sourceTypes: ['pdf'] }, candidate({ sourceType: 'pdf', url: null }))).toBe(
      true,
    );
  });
});

describe('fields are ANDed', () => {
  it('every present field must hold', () => {
    const match = {
      hosts: ['example.com'],
      kinds: ['essential' as const],
      quoteContains: ['aspirin'],
    };
    expect(matches(match)).toBe(true);
    expect(matches({ ...match, kinds: ['formula' as const] })).toBe(false);
    expect(matches({ ...match, quoteContains: ['ibuprofen'] })).toBe(false);
    expect(matches({ ...match, hosts: ['other.org'] })).toBe(false);
  });
});

describe('matchFilingRules', () => {
  it('skips disabled and deleted rules and orders by order, then age, then id', () => {
    const rules: FilingRuleLike[] = [
      rule({ id: 'rule-0000000c', order: 2 }),
      rule({ id: 'rule-0000000b', order: 1, createdAt: '2026-02-01T00:00:00.000Z' }),
      rule({ id: 'rule-0000000a', order: 1, createdAt: '2026-01-01T00:00:00.000Z' }),
      rule({ id: 'rule-0000000d', order: 0, enabled: false }),
      rule({ id: 'rule-0000000e', order: 0, deletedAt: '2026-03-01T00:00:00.000Z' }),
      rule({ id: 'rule-0000000f', order: 0, match: { hosts: ['elsewhere.org'] } }),
      rule({ id: 'rule-00000010', order: 1, createdAt: '2026-01-01T00:00:00.000Z' }),
    ];
    const snapshot = JSON.stringify(rules);
    const out = matchFilingRules(rules, candidate());
    expect(out.map((r) => r.id)).toEqual([
      'rule-0000000a',
      'rule-00000010',
      'rule-0000000b',
      'rule-0000000c',
    ]);
    expect(JSON.stringify(rules)).toBe(snapshot); // the input is not reordered
  });

  it('returns the caller’s own objects (a stored FilingRule stays a FilingRule)', () => {
    const stored = FilingRule.parse({
      id: 'rule-00000001',
      schemaVersion: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      deletedAt: null,
      name: 'Pharm',
      enabled: true,
      order: 0,
      match: { hosts: ['example.com'] },
      action: { bankId: 'bank-00000001' },
    });
    expect(stored.requireConfirm).toBe(true); // an absent flag asks
    expect(matchFilingRules([stored], candidate())[0]).toBe(stored);
  });
});

describe('planFiling', () => {
  it('is null without a match', () => {
    expect(planFiling([])).toBeNull();
  });

  it('takes the placement from the first rule and the tags from all of them', () => {
    const plan = planFiling([
      rule({
        id: 'rule-00000001',
        action: {
          bankId: 'bank-00000001',
          folderId: 'folder-00000001',
          addTagIds: ['tag-0000000a'],
        },
        requireConfirm: false,
      }),
      rule({
        id: 'rule-00000002',
        action: {
          bankId: 'bank-00000002',
          folderId: null,
          addTagIds: ['tag-0000000b', 'tag-0000000a'],
        },
        requireConfirm: false,
      }),
    ]);
    expect(plan).toEqual({
      bankId: 'bank-00000001',
      folderId: 'folder-00000001',
      addTagIds: ['tag-0000000a', 'tag-0000000b'],
      placementRuleId: 'rule-00000001',
      ruleIds: ['rule-00000001', 'rule-00000002'],
      requireConfirm: false,
    });
  });

  it('requires confirmation when any matching rule does, and when the flag is absent', () => {
    const quiet = rule({ id: 'rule-00000001', requireConfirm: false });
    const asking = rule({ id: 'rule-00000002', requireConfirm: true });
    const unspecified = rule({ id: 'rule-00000003' });
    expect(planFiling([quiet])!.requireConfirm).toBe(false);
    expect(planFiling([quiet, asking])!.requireConfirm).toBe(true);
    expect(planFiling([unspecified])!.requireConfirm).toBe(true);
  });

  it('a rule without a folder files at the bank root', () => {
    expect(planFiling([rule({ id: 'rule-00000001' })])!.folderId).toBeNull();
  });
});

describe('normalizeFilingHost', () => {
  it.each([
    ['Example.COM', 'example.com'],
    ['  example.com.  ', 'example.com'],
    ['https://www.Example.com/a/b?c#d', 'www.example.com'],
    ['*.example.com', 'example.com'],
    ['.example.com', 'example.com'],
    ['example.com:8080/path', 'example.com'],
    ['bücher.de', 'xn--bcher-kva.de'],
    ['localhost', 'localhost'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeFilingHost(input)).toBe(expected);
  });

  it.each([
    '',
    '   ',
    'a b',
    'https://user:pw@example.com/',
    'ftp://example.com',
    '[::1]',
    '//',
    '*',
  ])('refuses %j', (input) => {
    expect(normalizeFilingHost(input)).toBeNull();
  });
});

describe('decideFiling', () => {
  const asking = (over: Partial<FilingRuleLike> & { id: string }) =>
    rule({ requireConfirm: true, ...over });

  it('is none when nothing matches', () => {
    const rules = [asking({ id: 'rule-00000001', match: { hosts: ['other.org'] } })];
    expect(decideFiling(rules, [], candidate())).toEqual({ kind: 'none' });
  });

  it('plans from the first matching rule and carries it as the deciding rule', () => {
    const first = asking({ id: 'rule-00000001', order: 0 });
    const second = asking({
      id: 'rule-00000002',
      order: 1,
      action: { bankId: 'bank-00000002', addTagIds: ['tag-00000009'] },
    });
    const out = decideFiling([second, first], [], candidate());
    expect(out.kind).toBe('plan');
    if (out.kind !== 'plan') return;
    expect(out.rule.id).toBe('rule-00000001');
    expect(out.plan).toMatchObject({
      bankId: 'bank-00000001',
      placementRuleId: 'rule-00000001',
      addTagIds: ['tag-00000009'],
      requireConfirm: true,
    });
  });

  it('does not match a disabled rule', () => {
    const rules = [asking({ id: 'rule-00000001', enabled: false })];
    expect(decideFiling(rules, [], candidate())).toEqual({ kind: 'none' });
  });

  it('is blocked, not silently handed to a lower rule, when the winning rule is broken', () => {
    const first = asking({ id: 'rule-00000001', order: 0 });
    const second = asking({ id: 'rule-00000002', order: 1 });
    const issue = {
      ruleId: 'rule-00000001',
      field: 'action.bankId',
      id: 'bank-00000001',
      problem: 'deleted',
    } as const;
    const out = decideFiling([first, second], [issue], candidate());
    expect(out).toMatchObject({ kind: 'blocked', rule: { id: 'rule-00000001' }, issues: [issue] });
  });

  it('skips a broken rule that is not the first', () => {
    const first = asking({ id: 'rule-00000001', order: 0 });
    const second = asking({
      id: 'rule-00000002',
      order: 1,
      action: { bankId: 'bank-00000002', addTagIds: ['tag-gone-0001'] },
    });
    const issue = {
      ruleId: 'rule-00000002',
      field: 'action.addTagIds',
      id: 'tag-gone-0001',
      problem: 'missing',
    } as const;
    const out = decideFiling([first, second], [issue], candidate());
    expect(out.kind).toBe('plan');
    if (out.kind === 'plan') {
      expect(out.plan.ruleIds).toEqual(['rule-00000001']);
      expect(out.plan.addTagIds).toEqual([]);
    }
  });

  it('a deleted tag in the match is not a reason to block (nothing carries it)', () => {
    const first = asking({ id: 'rule-00000001' });
    const issue = {
      ruleId: 'rule-00000001',
      field: 'match.tagIds',
      id: 'tag-gone-0001',
      problem: 'deleted',
    } as const;
    expect(decideFiling([first], [issue], candidate()).kind).toBe('plan');
  });

  describe('PDF reader highlights', () => {
    const pdf = candidate({ sourceType: 'pdf', url: null });

    it('are never offered to a rule that does not name pdf', () => {
      const anySource = asking({ id: 'rule-00000001', match: { kinds: ['essential'] } });
      expect(decideFiling([anySource], [], pdf)).toEqual({ kind: 'none' });
      const webOnly = asking({ id: 'rule-00000002', match: { sourceTypes: ['web'] } });
      expect(decideFiling([webOnly], [], pdf)).toEqual({ kind: 'none' });
    });

    it('are filed by a rule that names pdf', () => {
      const named = asking({
        id: 'rule-00000001',
        match: { sourceTypes: ['pdf'], kinds: ['essential'] },
      });
      expect(decideFiling([named], [], pdf).kind).toBe('plan');
    });

    it('a web highlight still matches a rule with no source condition', () => {
      const anySource = asking({ id: 'rule-00000001', match: { kinds: ['essential'] } });
      expect(decideFiling([anySource], [], candidate()).kind).toBe('plan');
    });
  });
});

describe('isDefaultBankChoice', () => {
  const live = ['inbox-default', 'bank-00000001', 'bank-00000002'];
  const choice = (requested: string | null, last: string | null) =>
    isDefaultBankChoice(requested, last, live, 'inbox-default');

  it('is true when no bank was named', () => {
    expect(choice(null, null)).toBe(true);
    expect(choice(null, 'bank-00000001')).toBe(true);
  });

  it('is true for the bank a one-click save would use', () => {
    expect(choice('bank-00000001', 'bank-00000001')).toBe(true);
    expect(choice('inbox-default', null)).toBe(true);
  });

  it('falls back to the Inbox when the last-used bank is gone', () => {
    expect(choice('inbox-default', 'bank-deleted-1')).toBe(true);
    expect(choice('bank-00000001', 'bank-deleted-1')).toBe(false);
  });

  it('is false for any other bank: that is a choice', () => {
    expect(choice('bank-00000002', 'bank-00000001')).toBe(false);
    expect(choice('inbox-default', 'bank-00000001')).toBe(false);
  });
});

describe('filingMessage', () => {
  const bank = { id: 'bank-bio00001', name: 'Biology', color: 'green', isInbox: false } as const;

  it('names the rule and the place, with the folder when there is one', () => {
    expect(
      filingMessage({ status: 'filed', ruleName: 'Sites', bank, folderName: null, addedTags: 0 }),
    ).toBe("Filed in Biology by rule 'Sites'");
    expect(
      filingMessage({
        status: 'suggested',
        ruleName: 'Sites',
        bank,
        folderName: 'Week 1',
        addedTags: 2,
      }),
    ).toBe("File in Biology / Week 1? Rule 'Sites'");
  });

  it('says why a rule could not be applied, or just the reason when no rule is named', () => {
    expect(
      filingMessage({ status: 'unavailable', ruleName: 'Sites', reason: 'Its bank is gone.' }),
    ).toBe("Rule 'Sites' could not file this highlight. Its bank is gone.");
    expect(filingMessage({ status: 'unavailable', ruleName: '', reason: 'Expired.' })).toBe(
      'Expired.',
    );
  });
});
