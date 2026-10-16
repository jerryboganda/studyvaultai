// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { FilingRule, type FilingRuleIssue } from '@shared';
import { parseViewLink } from './deepLink';
import { dashboardPath } from '@ui/vault/dashboardLink';
import {
  conditionParts,
  describeConditions,
  describeIssue,
  draftRule,
  firstEmptyCondition,
  keepConditions,
  suggestName,
  usedConditions,
  describePlace,
  emptyForm,
  formFromRule,
  formProblems,
  formToInput,
  hasConditions,
  parseHosts,
  parsePhrase,
  parsePrefixes,
  runRuleTest,
  sampleFor,
  testCandidate,
  emptyTest,
  type Names,
} from './rulesModel';

const names: Names = {
  bank: (id) => (id === 'bank-cardio01' ? 'Cardiology' : 'a deleted bank'),
  folder: (id) => (id === 'folder-week01' ? 'Week 1' : 'a deleted folder'),
  tag: (id) => (id === 'tag-hy000001' ? 'High yield' : 'a deleted tag'),
};

function rule(over: Record<string, unknown> & { id: string }): FilingRule {
  return FilingRule.parse({
    schemaVersion: 1,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    deletedAt: null,
    name: over.id,
    enabled: true,
    order: 0,
    match: { hosts: ['example.com'] },
    action: { bankId: 'bank-cardio01' },
    requireConfirm: true,
    ...over,
  });
}

describe('chip parsers', () => {
  it('hosts: normalises what a person pastes and names the entry it refuses', () => {
    expect(parseHosts('HTTPS://www.Example.com/a, *.khan.org  bücher.de')).toEqual({
      ok: true,
      values: ['www.example.com', 'khan.org', 'xn--bcher-kva.de'],
    });
    expect(parseHosts('example.com bad_host!')).toMatchObject({
      ok: false,
      message: expect.stringContaining('"bad_host!" is not a site name'),
    });
    expect(parseHosts('  ')).toMatchObject({ ok: false });
  });

  it('prefixes: http(s) only, no credentials', () => {
    expect(parsePrefixes('https://example.com/course/')).toEqual({
      ok: true,
      values: ['https://example.com/course/'],
    });
    expect(parsePrefixes('ftp://example.com/')).toMatchObject({ ok: false });
    expect(parsePrefixes('https://user:pw@example.com/')).toMatchObject({ ok: false });
    expect(parsePrefixes('example.com/no-scheme')).toMatchObject({ ok: false });
  });

  it('phrases: one phrase, spaces collapsed, bounded', () => {
    expect(parsePhrase('  heart   failure ')).toEqual({ ok: true, values: ['heart failure'] });
    expect(parsePhrase('   ')).toMatchObject({ ok: false });
    expect(parsePhrase('x'.repeat(201))).toMatchObject({
      ok: false,
      message: expect.stringContaining('at most 200'),
    });
  });
});

describe('the form', () => {
  const banks = new Set(['bank-cardio01']);

  it('starts empty, on, and asking first', () => {
    const form = emptyForm('bank-cardio01');
    expect(form).toMatchObject({ enabled: true, requireConfirm: true, folderId: null });
    expect(hasConditions(form)).toBe(false);
  });

  it('says what blocks saving, in order, and what is only worth knowing', () => {
    const form = emptyForm('bank-cardio01');
    expect(formProblems(form, banks).first).toBe('Give the rule a name.');
    form.name = 'R';
    expect(formProblems(form, banks).first).toMatch(/Add at least one condition/);
    form.tagIds = ['tag-hy000001'];
    const tagsOnly = formProblems(form, banks);
    expect(tagsOnly.first).toBeNull();
    expect(tagsOnly.warnings.join(' ')).toMatch(/has no tags yet/);
    form.hosts = ['example.com'];
    expect(formProblems(form, banks).warnings).toEqual([]);
    form.bankId = 'bank-gone0001';
    expect(formProblems(form, banks).first).toMatch(/Choose the bank/);
    form.bankId = 'bank-cardio01';
    form.requireConfirm = false;
    expect(formProblems(form, banks).warnings.join(' ')).toMatch(/files a highlight at once/);
  });

  it('round-trips a stored rule', () => {
    const stored = rule({
      id: 'rule-0000001',
      match: { hosts: ['example.com'], kinds: ['formula'], sourceTypes: ['pdf'] },
      action: { bankId: 'bank-cardio01', folderId: null, addTagIds: ['tag-hy000001'] },
      requireConfirm: false,
    });
    const form = formFromRule(stored);
    expect(formToInput(form)).toMatchObject({
      name: 'rule-0000001',
      enabled: true,
      requireConfirm: false,
      match: { hosts: ['example.com'], kinds: ['formula'], sourceTypes: ['pdf'] },
      action: { bankId: 'bank-cardio01', folderId: null, addTagIds: ['tag-hy000001'] },
    });
  });
});

describe('reading a rule in words', () => {
  it('names every condition and the place', () => {
    const r = rule({
      id: 'rule-0000001',
      match: {
        hosts: ['a.org', 'b.org'],
        titleContains: ['heart'],
        kinds: ['formula'],
        tagIds: ['tag-hy000001'],
        sourceTypes: ['pdf'],
      },
      action: { bankId: 'bank-cardio01', folderId: 'folder-week01', addTagIds: ['tag-hy000001'] },
    });
    expect(describeConditions(r, names)).toEqual([
      'the site is a.org or b.org',
      'the page title contains “heart”',
      'it is tagged High yield',
      'the kind is Formula',
      'the source is a pdf document',
    ]);
    expect(describePlace(r, names)).toEqual({
      where: 'Cardiology / Week 1',
      tags: ['High yield'],
    });
  });

  it('explains each broken reference', () => {
    const issue = (
      field: FilingRuleIssue['field'],
      problem: FilingRuleIssue['problem'],
    ): FilingRuleIssue => ({ ruleId: 'r', field, id: 'x', problem });
    expect(describeIssue(issue('action.bankId', 'deleted'))).toMatch(/bank was deleted/);
    expect(describeIssue(issue('action.folderId', 'missing'))).toMatch(/folder was deleted/);
    expect(describeIssue(issue('action.folderId', 'wrong_bank'))).toMatch(/not in the bank/);
    expect(describeIssue(issue('action.addTagIds', 'deleted'))).toMatch(/tag it adds/);
    expect(describeIssue(issue('match.tagIds', 'deleted'))).toMatch(/can never match/);
  });
});

describe('running a test', () => {
  const candidateFor = (over: Partial<ReturnType<typeof emptyTest>>) =>
    testCandidate({ ...emptyTest(), ...over });

  it('turns an address into a candidate, or says it is not usable', () => {
    expect(candidateFor({ url: ' https://example.com/a ' }).candidate.url).toBe(
      'https://example.com/a',
    );
    const bad = candidateFor({ url: 'example.com' });
    expect(bad.candidate.url).toBeNull();
    expect(bad.addressProblem).toMatch(/starts with http/);
    expect(candidateFor({ url: '' }).addressProblem).toBeNull();
  });

  it('marks who decides, who adds tags, who is off, who is skipped and who is not offered', () => {
    const decides = rule({ id: 'rule-decides', order: 0 });
    const adds = rule({
      id: 'rule-adds00',
      order: 1,
      action: { bankId: 'bank-cardio01', addTagIds: ['tag-hy000001'] },
    });
    const off = rule({ id: 'rule-off0000', order: 2, enabled: false });
    const run = runRuleTest(
      [decides, adds, off],
      [],
      candidateFor({ url: 'https://example.com/x' }).candidate,
    );
    expect(run.decision.kind).toBe('plan');
    expect(run.rows.map((r) => [r.rule.id, r.status])).toEqual([
      ['rule-decides', 'decides'],
      ['rule-adds00', 'adds'],
      ['rule-off0000', 'off'],
    ]);

    const blocked = runRuleTest(
      [decides, adds],
      [{ ruleId: 'rule-decides', field: 'action.bankId', id: 'b', problem: 'deleted' }],
      candidateFor({ url: 'https://example.com/x' }).candidate,
    );
    expect(blocked.decision.kind).toBe('blocked');
    expect(blocked.rows.map((r) => r.status)).toEqual(['blocked', 'idle']);

    const pdf = runRuleTest(
      [decides],
      [],
      candidateFor({ url: 'https://example.com/x', sourceType: 'pdf' }).candidate,
    );
    expect(pdf.decision.kind).toBe('none');
    expect(pdf.rows.map((r) => r.status)).toEqual(['not-offered']);
  });

  it('a rule deleted from the list is not a rule', () => {
    const gone = rule({ id: 'rule-gone000', deletedAt: '2026-10-02T00:00:00.000Z' });
    const run = runRuleTest([gone], [], candidateFor({ url: 'https://example.com/x' }).candidate);
    expect(run.decision.kind).toBe('none');
    expect(run.rows).toEqual([]);
  });
});

describe('the wizard', () => {
  const form = { ...emptyForm('bank-cardio01'), hosts: ['example.com'], titleContains: ['heart'] };

  it('starts an edited rule on the fields it uses, and drops unticked ones only when saving', () => {
    expect(usedConditions(form)).toEqual(['hosts', 'titleContains']);
    const kept = keepConditions(form, ['hosts']);
    expect(kept.hosts).toEqual(['example.com']);
    expect(kept.titleContains).toEqual([]);
    expect(form.titleContains).toEqual(['heart']); // Back keeps the answer
    expect(formToInput(kept).match).toMatchObject({ hosts: ['example.com'], titleContains: [] });
  });

  it('asks for the first picked field that has no value', () => {
    expect(firstEmptyCondition(form, ['hosts', 'kinds', 'tagIds'])).toBe('kinds');
    expect(firstEmptyCondition(form, ['hosts', 'titleContains'])).toBeNull();
  });

  it('suggests a name from the first condition and the bank, within the limit', () => {
    expect(suggestName(form, 'Cardiology')).toBe('example.com to Cardiology');
    expect(suggestName({ ...emptyForm('b'), urlPrefixes: ['https://a.org/x/'] }, null)).toBe(
      'a.org/x/',
    );
    expect(suggestName({ ...emptyForm('b'), kinds: ['formula'] }, 'Renal')).toBe(
      'Formula to Renal',
    );
    expect(suggestName({ ...emptyForm('b'), hosts: ['x'.repeat(200)] }, 'B').length).toBe(80);
  });

  it('lists the conditions as short values for the card chips', () => {
    expect(
      conditionParts(
        { match: { hosts: ['a.org'], quoteContains: ['mg/dL'], tagIds: ['tag-hy000001'] } },
        names,
      ),
    ).toEqual([
      { key: 'hosts', values: ['a.org'] },
      { key: 'quoteContains', values: ['“mg/dL”'] },
      { key: 'tagIds', values: ['High yield'] },
    ]);
  });

  it('turns the form into a stored rule for "Try it": an edited one keeps its id and place', () => {
    const base = rule({ id: 'rule-0000001', order: 3 });
    const edited = draftRule({ ...form, name: '' }, base, 9);
    expect(FilingRule.safeParse(edited).success).toBe(true);
    expect(edited).toMatchObject({
      id: 'rule-0000001',
      order: 3,
      name: 'This rule',
      enabled: true,
    });
    const fresh = draftRule({ ...form, name: 'New' }, undefined, 9);
    expect(fresh).toMatchObject({ order: 9, name: 'New', deletedAt: null });
    // The draft decides like the stored rule would.
    const run = runRuleTest(
      [fresh],
      [],
      testCandidate({ ...emptyTest(), url: 'https://example.com/heart', title: 'heart' }).candidate,
    );
    expect(run.decision.kind).toBe('plan');
  });

  it('builds the first "Try it" sample from the rule, and the rule decides it', () => {
    const sample = sampleFor({ ...form, quoteContains: ['mg/dL'], kinds: ['formula'] });
    expect(sample).toEqual({
      url: 'https://example.com/',
      title: 'heart',
      quote: 'mg/dL',
      tagIds: [],
      sourceType: 'web',
      kind: 'formula',
    });
    const draft = draftRule({ ...form, name: 'X' }, undefined, 0);
    const run = runRuleTest([draft], [], testCandidate({ ...emptyTest(), ...sample }).candidate);
    expect(run.decision.kind).toBe('plan');
    // An address prefix stands in for a missing site; a PDF-only rule gets a PDF sample.
    expect(
      sampleFor({ ...emptyForm('b'), urlPrefixes: ['https://a.org/x/'], sourceTypes: ['pdf'] }),
    ).toMatchObject({ url: 'https://a.org/x/', sourceType: 'pdf' });
    expect(sampleFor(emptyForm('b'))).toMatchObject({ url: '', title: '', quote: '' });
  });
});

describe('the view link', () => {
  it('opens the rules manager for ?view=rules', () => {
    expect(parseViewLink('?view=rules')).toBe('rules');
    expect(parseViewLink('?view=<script>')).toBeNull();
    expect(dashboardPath({ view: 'rules' })).toBe('dashboard.html?view=rules');
  });
});
