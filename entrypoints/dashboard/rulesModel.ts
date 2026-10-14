import {
  HIGHLIGHT_KINDS,
  KIND_LABELS,
  MAX_FILING_MATCH_VALUES,
  MAX_FILING_RULE_NAME_CHARS,
  MAX_FILING_TAG_IDS,
  MAX_FILING_TEXT_CHARS,
  SCHEMA_VERSION,
  decideFiling,
  filingMatchApplies,
  normalizeFilingHost,
  parseHttpUrl,
  type FilingCandidate,
  type FilingDecision,
  type FilingRule,
  type FilingRuleIssue,
  type HighlightKind,
} from '@shared';
import type { FilingRuleInput } from '@storage';

/**
 * The filing-rules form and the "Test a rule" panel as plain functions (docs/adr/017): what a field
 * accepts and says when it refuses, what a rule reads as in words, and how a test is run. The matcher
 * itself is `decideFiling` in @shared, the same one the worker uses at capture.
 */

export type Parsed = { ok: true; values: string[] } | { ok: false; message: string };

/** Entries a person may paste in one go: separated by commas, spaces or new lines. */
const entries = (raw: string): string[] => raw.split(/[\s,;]+/).filter((part) => part !== '');

export function parseHosts(raw: string): Parsed {
  const out: string[] = [];
  for (const entry of entries(raw)) {
    const host = normalizeFilingHost(entry);
    if (host === null) {
      return {
        ok: false,
        message: `"${entry}" is not a site name. Use a name such as example.com (a page address is fine too).`,
      };
    }
    out.push(host);
  }
  return out.length > 0 ? { ok: true, values: out } : { ok: false, message: 'Type a site name.' };
}

export function parsePrefixes(raw: string): Parsed {
  const out: string[] = [];
  for (const entry of entries(raw)) {
    const url = parseHttpUrl(entry);
    if (url === null || url.username !== '' || url.password !== '') {
      return {
        ok: false,
        message: `"${entry}" is not usable. Use an address that starts with http:// or https://, without a user name or password.`,
      };
    }
    out.push(entry);
  }
  return out.length > 0 ? { ok: true, values: out } : { ok: false, message: 'Type an address.' };
}

/** One phrase, kept as typed (inner spaces collapsed). */
export function parsePhrase(raw: string): Parsed {
  const phrase = raw.replace(/\s+/g, ' ').trim();
  if (phrase === '') return { ok: false, message: 'Type a word or phrase.' };
  if (phrase.length > MAX_FILING_TEXT_CHARS) {
    return {
      ok: false,
      message: `Use at most ${MAX_FILING_TEXT_CHARS} characters (this is ${phrase.length}).`,
    };
  }
  return { ok: true, values: [phrase] };
}

// ---------------------------------------------------------------------------------------------
// the form
// ---------------------------------------------------------------------------------------------

export type SourceType = 'web' | 'pdf';
export const SOURCE_TYPES: readonly SourceType[] = ['web', 'pdf'];
export const SOURCE_LABELS: Record<SourceType, string> = { web: 'Web page', pdf: 'PDF document' };

export interface RuleForm {
  name: string;
  enabled: boolean;
  hosts: string[];
  urlPrefixes: string[];
  titleContains: string[];
  quoteContains: string[];
  tagIds: string[];
  kinds: HighlightKind[];
  sourceTypes: SourceType[];
  bankId: string;
  folderId: string | null;
  addTagIds: string[];
  requireConfirm: boolean;
}

/** A new rule asks first: that is the default of the data model and of this form. */
export const emptyForm = (bankId: string): RuleForm => ({
  name: '',
  enabled: true,
  hosts: [],
  urlPrefixes: [],
  titleContains: [],
  quoteContains: [],
  tagIds: [],
  kinds: [],
  sourceTypes: [],
  bankId,
  folderId: null,
  addTagIds: [],
  requireConfirm: true,
});

export function formFromRule(rule: FilingRule): RuleForm {
  return {
    name: rule.name,
    enabled: rule.enabled,
    hosts: [...(rule.match.hosts ?? [])],
    urlPrefixes: [...(rule.match.urlPrefixes ?? [])],
    titleContains: [...(rule.match.titleContains ?? [])],
    quoteContains: [...(rule.match.quoteContains ?? [])],
    tagIds: [...(rule.match.tagIds ?? [])],
    kinds: [...(rule.match.kinds ?? [])],
    sourceTypes: [...(rule.match.sourceTypes ?? [])],
    bankId: rule.action.bankId,
    folderId: rule.action.folderId ?? null,
    addTagIds: [...(rule.action.addTagIds ?? [])],
    requireConfirm: rule.requireConfirm,
  };
}

export function formToInput(form: RuleForm): FilingRuleInput {
  return {
    name: form.name.trim(),
    enabled: form.enabled,
    match: {
      hosts: form.hosts,
      urlPrefixes: form.urlPrefixes,
      titleContains: form.titleContains,
      quoteContains: form.quoteContains,
      tagIds: form.tagIds,
      kinds: form.kinds,
      sourceTypes: form.sourceTypes,
    },
    action: { bankId: form.bankId, folderId: form.folderId, addTagIds: form.addTagIds },
    requireConfirm: form.requireConfirm,
  };
}

/** The condition fields of a rule, in the order the wizard offers them. */
export type ConditionKey =
  'hosts' | 'urlPrefixes' | 'titleContains' | 'quoteContains' | 'kinds' | 'sourceTypes' | 'tagIds';
export const CONDITION_KEYS: readonly ConditionKey[] = [
  'hosts',
  'urlPrefixes',
  'titleContains',
  'quoteContains',
  'kinds',
  'sourceTypes',
  'tagIds',
];

/** The condition fields that hold at least one value (what an edited rule starts with). */
export const usedConditions = (form: RuleForm): ConditionKey[] =>
  CONDITION_KEYS.filter((k) => form[k].length > 0);

/** The form with the values of the fields that were not picked left out (Back keeps them). */
export function keepConditions(form: RuleForm, keys: readonly ConditionKey[]): RuleForm {
  const out = { ...form };
  for (const k of CONDITION_KEYS) if (!keys.includes(k)) out[k] = [];
  return out;
}

/** The first picked field that has no value yet, so the wizard can ask for it. */
export const firstEmptyCondition = (
  form: RuleForm,
  keys: readonly ConditionKey[],
): ConditionKey | null => keys.find((k) => form[k].length === 0) ?? null;

/** A name to offer when the person leaves it empty: the first condition, then the bank. */
export function suggestName(form: RuleForm, bankName: string | null): string {
  const first =
    form.hosts[0] ??
    form.urlPrefixes[0]?.replace(/^https?:\/\//, '') ??
    form.titleContains[0] ??
    form.quoteContains[0] ??
    (form.kinds[0] ? KIND_LABELS[form.kinds[0]].label : undefined) ??
    (form.sourceTypes[0] ? SOURCE_LABELS[form.sourceTypes[0]] : undefined);
  const name = [first, bankName].filter(Boolean).join(' to ');
  return name.slice(0, MAX_FILING_RULE_NAME_CHARS).trim();
}

/**
 * The form as a stored rule, so "Try it" can run the real decision over the list with this rule in
 * it: an edited rule keeps its id and place, a new one goes last (where creating puts it).
 */
export function draftRule(form: RuleForm, base: FilingRule | undefined, order: number): FilingRule {
  const at = base?.updatedAt ?? new Date(0).toISOString();
  return {
    id: base?.id ?? 'rule-draft',
    schemaVersion: SCHEMA_VERSION,
    createdAt: base?.createdAt ?? at,
    updatedAt: at,
    deletedAt: null,
    order: base?.order ?? order,
    name: form.name.trim() || 'This rule',
    enabled: true,
    match: formToInput(form).match,
    action: { bankId: form.bankId, folderId: form.folderId, addTagIds: form.addTagIds },
    requireConfirm: form.requireConfirm,
  };
}

export const hasConditions = (form: RuleForm): boolean =>
  form.hosts.length +
    form.urlPrefixes.length +
    form.titleContains.length +
    form.quoteContains.length +
    form.tagIds.length +
    form.kinds.length +
    form.sourceTypes.length >
  0;

export interface FormProblems {
  name: string | null;
  conditions: string | null;
  bank: string | null;
  /** The first thing that blocks saving, for the disabled button's reason. */
  first: string | null;
  /** Things worth knowing that do not block saving. */
  warnings: string[];
}

export function formProblems(form: RuleForm, bankIds: ReadonlySet<string>): FormProblems {
  const name =
    form.name.trim() === ''
      ? 'Give the rule a name.'
      : form.name.trim().length > MAX_FILING_RULE_NAME_CHARS
        ? `Use at most ${MAX_FILING_RULE_NAME_CHARS} characters for the name.`
        : null;
  const conditions = hasConditions(form)
    ? null
    : 'Add at least one condition: a site, an address, a word, a tag, a kind or a source type.';
  const bank = bankIds.has(form.bankId) ? null : 'Choose the bank this rule files into.';
  const warnings: string[] = [];
  const onlyTags =
    form.tagIds.length > 0 &&
    form.hosts.length +
      form.urlPrefixes.length +
      form.titleContains.length +
      form.quoteContains.length +
      form.kinds.length +
      form.sourceTypes.length ===
      0;
  if (onlyTags) {
    warnings.push(
      'A new highlight has no tags yet, so a rule that only looks at tags will not match it when it is saved. Add another condition, such as a site.',
    );
  }
  if (!form.requireConfirm) {
    warnings.push(
      'This rule files a highlight at once when it matches. You can undo it from the notice that appears.',
    );
  }
  return { name, conditions, bank, first: name ?? conditions ?? bank, warnings };
}

// ---------------------------------------------------------------------------------------------
// reading a rule in words
// ---------------------------------------------------------------------------------------------

export interface Names {
  bank(id: string): string;
  folder(id: string): string;
  tag(id: string): string;
}

const orList = (items: readonly string[]): string => items.join(' or ');
const quoted = (items: readonly string[]): string => orList(items.map((s) => `“${s}”`));

/** The conditions of a rule, one phrase per field; fields are ANDed. */
export function describeConditions(rule: Pick<FilingRule, 'match'>, names: Names): string[] {
  const m = rule.match;
  const out: string[] = [];
  if (m.hosts?.length) out.push(`the site is ${orList(m.hosts)}`);
  if (m.urlPrefixes?.length) out.push(`the address starts with ${orList(m.urlPrefixes)}`);
  if (m.titleContains?.length) out.push(`the page title contains ${quoted(m.titleContains)}`);
  if (m.quoteContains?.length) out.push(`the highlighted text contains ${quoted(m.quoteContains)}`);
  if (m.tagIds?.length) out.push(`it is tagged ${orList(m.tagIds.map(names.tag))}`);
  if (m.kinds?.length) out.push(`the kind is ${orList(m.kinds.map((k) => KIND_LABELS[k].label))}`);
  if (m.sourceTypes?.length) {
    out.push(`the source is a ${orList(m.sourceTypes.map((s) => SOURCE_LABELS[s].toLowerCase()))}`);
  }
  return out;
}

/** The same conditions as short values per field, for the chips of a rule card. */
export function conditionParts(
  rule: Pick<FilingRule, 'match'>,
  names: Names,
): Array<{ key: ConditionKey; values: string[] }> {
  const m = rule.match;
  const q = (items: readonly string[] | undefined) => (items ?? []).map((s) => `“${s}”`);
  const parts: Array<{ key: ConditionKey; values: string[] }> = [
    { key: 'hosts', values: [...(m.hosts ?? [])] },
    { key: 'urlPrefixes', values: [...(m.urlPrefixes ?? [])] },
    { key: 'titleContains', values: q(m.titleContains) },
    { key: 'quoteContains', values: q(m.quoteContains) },
    { key: 'kinds', values: (m.kinds ?? []).map((k) => KIND_LABELS[k].label) },
    { key: 'sourceTypes', values: (m.sourceTypes ?? []).map((s) => SOURCE_LABELS[s]) },
    { key: 'tagIds', values: (m.tagIds ?? []).map(names.tag) },
  ];
  return parts.filter((p) => p.values.length > 0);
}

export function describePlace(
  rule: Pick<FilingRule, 'action'>,
  names: Names,
): { where: string; tags: string[] } {
  const folder = rule.action.folderId ?? null;
  const bank = names.bank(rule.action.bankId);
  return {
    where: folder === null ? bank : `${bank} / ${names.folder(folder)}`,
    tags: (rule.action.addTagIds ?? []).map(names.tag),
  };
}

/** What a broken reference means for the person, and what they can do. */
export function describeIssue(issue: FilingRuleIssue): string {
  switch (issue.field) {
    case 'action.bankId':
      return 'Its bank was deleted, so this rule is skipped. Choose another bank, or restore the bank from the trash.';
    case 'action.folderId':
      return issue.problem === 'wrong_bank'
        ? 'Its folder is not in the bank it files into, so this rule is skipped. Choose a folder again.'
        : 'Its folder was deleted, so this rule is skipped. Choose another folder, or restore it from the trash.';
    case 'action.addTagIds':
      return 'A tag it adds was deleted, so this rule is skipped. Remove the tag from the rule, or restore it from the trash.';
    case 'match.tagIds':
      return 'A tag it looks for was deleted, so that tag can never match.';
  }
}

// ---------------------------------------------------------------------------------------------
// "Test a rule"
// ---------------------------------------------------------------------------------------------

export interface TestInput {
  url: string;
  title: string;
  quote: string;
  kind: HighlightKind;
  sourceType: SourceType;
  tagIds: string[];
}

export const emptyTest = (): TestInput => ({
  url: '',
  title: '',
  quote: '',
  kind: HIGHLIGHT_KINDS[0]!,
  sourceType: 'web',
  tagIds: [],
});

/**
 * A first sample for "Try it", made of the rule being written: its first site (or address), title
 * word, quote word, kind, source and tag. The wizard's test then shows a result straight away; the
 * person can change any field to see what else would happen.
 */
export function sampleFor(form: RuleForm): Partial<TestInput> {
  const host = form.hosts[0];
  const url = host ? `https://${host}/` : (form.urlPrefixes[0] ?? '');
  const out: Partial<TestInput> = {
    url,
    title: form.titleContains[0] ?? '',
    quote: form.quoteContains[0] ?? '',
    tagIds: form.tagIds.slice(0, 1),
    sourceType: form.sourceTypes.length > 0 && !form.sourceTypes.includes('web') ? 'pdf' : 'web',
  };
  if (form.kinds[0]) out.kind = form.kinds[0];
  return out;
}

export function testCandidate(input: TestInput): {
  candidate: FilingCandidate;
  addressProblem: string | null;
} {
  const raw = input.url.trim();
  let url: string | null = null;
  let addressProblem: string | null = null;
  if (raw !== '') {
    if (parseHttpUrl(raw) === null) {
      addressProblem = 'Enter a full address that starts with http:// or https://.';
    } else {
      url = raw;
    }
  }
  return {
    addressProblem,
    candidate: {
      url,
      title: input.title,
      quote: input.quote,
      kind: input.kind,
      tagIds: input.tagIds,
      sourceType: input.sourceType,
    },
  };
}

export type TestStatus = 'decides' | 'adds' | 'blocked' | 'broken' | 'off' | 'not-offered' | 'idle';

export interface TestRow {
  rule: FilingRule;
  status: TestStatus;
}

export interface TestRun {
  decision: FilingDecision<FilingRule>;
  /** The rules whose conditions hold, in rank order, with what each does. */
  rows: TestRow[];
}

/**
 * Runs every stored rule against `candidate` the way the worker does after a capture, and explains
 * each rule whose conditions hold (including turned-off ones, which is why a test is useful).
 */
export function runRuleTest(
  rules: readonly FilingRule[],
  issues: readonly FilingRuleIssue[],
  candidate: FilingCandidate,
): TestRun {
  const live = rules.filter((r) => r.deletedAt === null);
  const decision = decideFiling(live, issues, candidate);
  const broken = new Set(issues.filter((i) => i.field !== 'match.tagIds').map((i) => i.ruleId));
  const inPlan = decision.kind === 'plan' ? new Set(decision.plan.ruleIds) : new Set<string>();
  const rows: TestRow[] = [];
  for (const rule of [...live].sort((a, b) => a.order - b.order)) {
    if (!filingMatchApplies(rule.match, candidate)) continue;
    let status: TestStatus;
    if (!rule.enabled) status = 'off';
    else if (candidate.sourceType === 'pdf' && rule.match.sourceTypes?.includes('pdf') !== true) {
      status = 'not-offered';
    } else if (decision.kind === 'plan' && decision.rule.id === rule.id) status = 'decides';
    else if (decision.kind === 'blocked' && decision.rule.id === rule.id) status = 'blocked';
    else if (broken.has(rule.id)) status = 'broken';
    else if (inPlan.has(rule.id)) status = 'adds';
    else status = 'idle';
    rows.push({ rule, status });
  }
  return { decision, rows };
}

export const LIMITS = {
  values: MAX_FILING_MATCH_VALUES,
  tags: MAX_FILING_TAG_IDS,
  name: MAX_FILING_RULE_NAME_CHARS,
  text: MAX_FILING_TEXT_CHARS,
} as const;
