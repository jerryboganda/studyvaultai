import type { FilingOutcome } from './protocol';
import type { FilingRule, FilingRuleMatch, HighlightKind } from './schema';
import { DENY_HOST, normalizeHost, parseHttpUrl, visibleSourceUrl } from './urls';

/**
 * Auto-filing rules, pure. The storage layer persists them (`FilingRule`); this file is the only
 * place that decides whether one matches and what a set of matches means, so the worker, the side
 * panel and the dashboard cannot disagree.
 *
 * Semantics (also in docs/adr/011-schema-v4.md):
 *  - a rule is considered only when it is enabled and not deleted;
 *  - inside one field the values are ORed (any host, any keyword ...); across fields they are ANDed;
 *  - a field that is absent or an empty list is not a condition; a match with no condition at all
 *    NEVER matches (an empty rule must not file everything);
 *  - `hosts`: the address's host equals the value or is a subdomain of it, compared on whole
 *    labels ("example.com" matches "www.example.com", never "evilexample.com"). A candidate without
 *    a usable address (a local PDF, a stand-in address) has no host and fails this field;
 *  - `urlPrefixes`: the candidate's address, as the URL parser spells it (lower-case scheme and
 *    host, default port dropped, credentials and fragment removed), starts with the prefix spelled
 *    the same way. It is a string prefix: "https://example.com/course" also matches
 *    "https://example.com/courses/1"; end it with "/" to mean a folder;
 *  - `titleContains` / `quoteContains`: case-insensitive substring of the page title / quote, after
 *    Unicode NFKC normalisation and whitespace collapsing;
 *  - `tagIds`: the candidate carries at least one of them; `kinds`, `sourceTypes`: it is one of them.
 */

/** What a rule is asked about: a highlight that is about to be (or was) saved. */
export interface FilingCandidate {
  /** Address of the page or document; null or '' when it has none. A stand-in address counts as none. */
  url: string | null;
  title: string;
  /** The exact quote. */
  quote: string;
  kind: HighlightKind;
  /** Ids of the tags the highlight already carries. */
  tagIds: readonly string[];
  sourceType: 'web' | 'pdf';
}

/** The part of a stored rule the matcher reads; a stored `FilingRule` satisfies it. */
export interface FilingRuleLike {
  id: string;
  enabled: boolean;
  order: number;
  match: FilingRuleMatch;
  action: FilingRule['action'];
  requireConfirm?: boolean;
  createdAt?: string;
  deletedAt?: string | null;
}

const nonEmpty = <T>(list: readonly T[] | undefined): list is readonly T[] =>
  list !== undefined && list.length > 0;

/** True when at least one field holds a value: a rule without one never matches. */
export function hasFilingCriteria(match: FilingRuleMatch): boolean {
  return (
    nonEmpty(match.hosts) ||
    nonEmpty(match.urlPrefixes) ||
    nonEmpty(match.titleContains) ||
    nonEmpty(match.quoteContains) ||
    nonEmpty(match.tagIds) ||
    nonEmpty(match.kinds) ||
    nonEmpty(match.sourceTypes)
  );
}

/**
 * A host as the rules store it: lower-case, no trailing dot, no scheme, port, path or leading
 * "*." / ".". Accepts what a person pastes ("https://www.Example.com/a?b", "*.example.com").
 * Null when nothing host-like is left.
 */
export function normalizeFilingHost(input: string): string | null {
  const text = input.trim().replace(/^(\*\.|\.)+/, '');
  if (text === '') return null;
  // Through the URL parser: it lower-cases, drops the port and path and turns "bücher.de" into its
  // ASCII form, which is what an address's hostname is compared with.
  const url = parseHttpUrl(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  if (!url || url.username !== '' || url.password !== '') return null;
  const host = normalizeHost(url.hostname).replace(/^(\*\.)+/, '');
  return DENY_HOST.test(host) && host.length <= 253 ? host : null;
}

/** Case-insensitive, NFKC, single spaces: the form `*Contains` conditions are compared in. */
const fold = (text: string): string =>
  text.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

/** The address as compared by `urlPrefixes`; null when it is not an http(s) address. */
function addressOf(value: string): string | null {
  const url = parseHttpUrl(value.trim());
  if (!url) return null;
  url.username = '';
  url.password = '';
  url.hash = '';
  return url.href;
}

/** Whether every condition of `match` holds for `candidate` (and there is at least one). */
export function filingMatchApplies(match: FilingRuleMatch, candidate: FilingCandidate): boolean {
  if (!hasFilingCriteria(match)) return false;
  const visible = visibleSourceUrl(candidate.url);
  const parsed = visible === '' ? null : parseHttpUrl(visible);

  if (nonEmpty(match.hosts)) {
    if (!parsed) return false;
    const host = normalizeHost(parsed.hostname);
    const hit = match.hosts.some((entry) => {
      const wanted = normalizeHost(entry);
      return wanted !== '' && (host === wanted || host.endsWith(`.${wanted}`));
    });
    if (!hit) return false;
  }
  if (nonEmpty(match.urlPrefixes)) {
    const address = parsed ? addressOf(visible) : null;
    if (address === null) return false;
    const hit = match.urlPrefixes.some((prefix) => {
      const wanted = addressOf(prefix);
      return wanted !== null && address.startsWith(wanted);
    });
    if (!hit) return false;
  }
  if (nonEmpty(match.titleContains)) {
    const title = fold(candidate.title);
    if (!match.titleContains.some((word) => fold(word) !== '' && title.includes(fold(word)))) {
      return false;
    }
  }
  if (nonEmpty(match.quoteContains)) {
    const quote = fold(candidate.quote);
    if (!match.quoteContains.some((word) => fold(word) !== '' && quote.includes(fold(word)))) {
      return false;
    }
  }
  if (nonEmpty(match.tagIds)) {
    const have = new Set(candidate.tagIds);
    if (!match.tagIds.some((id) => have.has(id))) return false;
  }
  if (nonEmpty(match.kinds) && !match.kinds.includes(candidate.kind)) return false;
  if (nonEmpty(match.sourceTypes) && !match.sourceTypes.includes(candidate.sourceType))
    return false;
  return true;
}

/** Rank order: `order` ascending, then oldest first, then id (a total order, so it is stable). */
export function compareFilingRules(a: FilingRuleLike, b: FilingRuleLike): number {
  if (a.order !== b.order) return a.order - b.order;
  const x = a.createdAt ?? '';
  const y = b.createdAt ?? '';
  if (x !== y) return x < y ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The enabled, undeleted rules that match `candidate`, in rank order (the first one wins the
 * placement, see `planFiling`). Does not look at whether the rule's bank, folder or tags still exist:
 * the storage layer's `listApplicableFilingRules` does that before it hands rules over.
 */
export function matchFilingRules<T extends FilingRuleLike>(
  rules: readonly T[],
  candidate: FilingCandidate,
): T[] {
  return rules
    .filter(
      (rule) =>
        rule.enabled &&
        (rule.deletedAt ?? null) === null &&
        filingMatchApplies(rule.match, candidate),
    )
    .sort(compareFilingRules);
}

/** A reference of a rule that no longer holds: the shape `checkFilingRules` (storage) reports. */
export interface FilingRuleIssue {
  ruleId: string;
  field: 'action.bankId' | 'action.folderId' | 'action.addTagIds' | 'match.tagIds';
  id: string;
  problem: 'missing' | 'deleted' | 'wrong_bank';
}

export interface FilingPlan {
  /** Where the highlight goes: the bank and folder of the first matching rule. */
  bankId: string;
  folderId: string | null;
  /** Tags to add: the union over every matching rule, in first-seen order. */
  addTagIds: string[];
  /** The rule that chose the placement. */
  placementRuleId: string;
  /** Every matching rule, in rank order. */
  ruleIds: string[];
  /** True when any matching rule asks to be confirmed: nothing is applied without the person. */
  requireConfirm: boolean;
}

/**
 * What a list of matches (the result of `matchFilingRules`) means. First match wins per field: the
 * placement (bank + folder, which belong together) comes from the first rule, the tags are the union
 * of all of them. Confirmation is required when ANY matching rule requires it, so a quiet rule can
 * never carry a rule that asked to be confirmed through unconfirmed. Null when nothing matched.
 */
export function planFiling(matches: readonly FilingRuleLike[]): FilingPlan | null {
  const first = matches[0];
  if (!first) return null;
  const tags = new Set<string>();
  for (const rule of matches) for (const id of rule.action.addTagIds ?? []) tags.add(id);
  return {
    bankId: first.action.bankId,
    folderId: first.action.folderId ?? null,
    addTagIds: [...tags],
    placementRuleId: first.id,
    ruleIds: matches.map((rule) => rule.id),
    requireConfirm: matches.some((rule) => rule.requireConfirm !== false),
  };
}

/** What happens to a candidate: nothing, a plan, or a rule that won but cannot be applied. */
export type FilingDecision<T extends FilingRuleLike = FilingRuleLike> =
  | { kind: 'none' }
  | { kind: 'plan'; plan: FilingPlan; rule: T }
  | { kind: 'blocked'; rule: T; issues: FilingRuleIssue[] };

/**
 * The one decision the worker (at capture) and the "Test a rule" panel share, so they cannot
 * disagree. `rules` are the stored rules (disabled and broken ones included), `issues` what
 * `checkFilingRules` reported.
 *
 *  - a PDF candidate is only ever offered to rules that name `pdf` in `sourceTypes` (a rule with no
 *    source condition is written with web pages in mind and must not file a reader highlight);
 *  - the first matching rule decides the placement. When it points at a bank, folder or tag that is
 *    gone the result is `blocked`: nothing is filed and the person is told, instead of a lower rule
 *    silently taking over. A broken rule further down is skipped.
 */
export function decideFiling<T extends FilingRuleLike>(
  rules: readonly T[],
  issues: readonly FilingRuleIssue[],
  candidate: FilingCandidate,
): FilingDecision<T> {
  const pool =
    candidate.sourceType === 'pdf'
      ? rules.filter((rule) => rule.match.sourceTypes?.includes('pdf') === true)
      : rules;
  const matches = matchFilingRules(pool, candidate);
  const first = matches[0];
  if (!first) return { kind: 'none' };
  const broken = issues.filter((i) => i.field !== 'match.tagIds');
  const own = broken.filter((i) => i.ruleId === first.id);
  if (own.length > 0) return { kind: 'blocked', rule: first, issues: own };
  const brokenIds = new Set(broken.map((i) => i.ruleId));
  const plan = planFiling(matches.filter((rule) => !brokenIds.has(rule.id)));
  // `first` is not broken, so the filtered list starts with it and a plan always exists.
  return plan ? { kind: 'plan', plan, rule: first } : { kind: 'none' };
}

/**
 * Did the person leave the bank to the default? A capture that names the bank a one-click save
 * would have used (the last-used bank while it exists, else the Inbox) made no choice, so rules may
 * act. A capture that names any other bank is an explicit choice, and a rule never overrides it.
 */
export function isDefaultBankChoice(
  requestedBankId: string | null,
  lastBankId: string | null,
  liveBankIds: readonly string[],
  inboxId: string,
): boolean {
  if (requestedBankId === null) return true;
  const fallback = lastBankId !== null && liveBankIds.includes(lastBankId) ? lastBankId : inboxId;
  return requestedBankId === fallback;
}

const placeOf = (bank: string, folder: string | null): string =>
  folder === null ? bank : `${bank} / ${folder}`;

/**
 * The sentence for what a rule did or offers, the same wherever it is shown (page toast, side panel,
 * PDF reader). Rule and bank names are the person's own text; callers render them as text.
 */
export function filingMessage(outcome: FilingOutcome): string {
  switch (outcome.status) {
    case 'filed':
      return `Filed in ${placeOf(outcome.bank.name, outcome.folderName)} by rule '${outcome.ruleName}'`;
    case 'suggested':
      return `File in ${placeOf(outcome.bank.name, outcome.folderName)}? Rule '${outcome.ruleName}'`;
    case 'unavailable':
      return outcome.ruleName === ''
        ? outcome.reason
        : `Rule '${outcome.ruleName}' could not file this highlight. ${outcome.reason}`;
  }
}
