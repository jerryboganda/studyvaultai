import { useId, useMemo, useState } from 'react';
import {
  Ban,
  CircleCheck,
  CircleSlash,
  SlidersHorizontal,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { HIGHLIGHT_KINDS, KIND_LABELS, type FilingRule, type HighlightKind } from '@shared';
import type { FilingRuleProblem } from '@storage';
import { ChunkyButton, InlineNotice } from '@ui';
import { ChipPicker } from './Chips';
import {
  LIMITS,
  SOURCE_LABELS,
  SOURCE_TYPES,
  describePlace,
  describeIssue,
  emptyTest,
  runRuleTest,
  testCandidate,
  type Names,
  type SourceType,
  type TestInput,
  type TestStatus,
} from './rulesModel';
import { useTreeData } from './treeData';
import './rules.css';

/** Short words on the row, the full reason for screen readers right after them. */
const STATUS: Record<TestStatus, { short: string; long: string; icon: LucideIcon; tone: string }> =
  {
    decides: {
      short: 'Decides',
      long: 'Decides where the highlight goes',
      icon: CircleCheck,
      tone: 'success',
    },
    adds: { short: 'Adds tags', long: 'Adds its tags', icon: CircleCheck, tone: 'primary' },
    blocked: {
      short: 'Cannot apply',
      long: 'Matches first but cannot be applied',
      icon: TriangleAlert,
      tone: 'warning',
    },
    broken: {
      short: 'Skipped',
      long: 'Matches but is skipped: something it needs was deleted',
      icon: TriangleAlert,
      tone: 'warning',
    },
    off: { short: 'Turned off', long: 'Matches but is turned off', icon: Ban, tone: 'neutral' },
    'not-offered': {
      short: 'Not for PDFs',
      long: 'Matches, but a PDF is only offered to rules that list PDF document as a source',
      icon: Ban,
      tone: 'neutral',
    },
    idle: { short: 'Not used', long: 'Matches but is not used', icon: Ban, tone: 'neutral' },
  };

/**
 * "Test a rule": paste an address, a title and a quote and see which rules match and what the
 * result would be. It runs the same pure decision the worker runs after a capture, over the rules as
 * they are stored (or, in the wizard, with the draft in them), so what it shows is what a real
 * capture would do (docs/adr/017-filing-rules.md).
 */
export function RuleTester({
  rules,
  problems,
  names,
  rulesOn,
  focusId,
  tidPrefix = '',
  sample,
}: {
  rules: readonly FilingRule[];
  problems: readonly FilingRuleProblem[];
  names: Names;
  /** Settings.useFilingRules: with it off no rule is applied at capture, and the panel says so. */
  rulesOn: boolean;
  /** The rule being written in the wizard: its row says "This rule". */
  focusId?: string;
  /** Test ids get this prefix, so the wizard's tester and the page's never share one. */
  tidPrefix?: string;
  /** Fields to start from (the wizard passes a sample made of the rule being written). */
  sample?: Partial<TestInput>;
}) {
  const uid = useId();
  const tree = useTreeData();
  const tid = (id: string) => `${tidPrefix}${id}`;
  const [input, setInput] = useState<TestInput>(() => ({ ...emptyTest(), ...sample }));
  // Kind, source or tags from the sample are shown, not hidden behind "More fields".
  const [more, setMore] = useState(
    () =>
      sample?.kind !== undefined ||
      (sample?.tagIds?.length ?? 0) > 0 ||
      sample?.sourceType === 'pdf',
  );
  const set = <K extends keyof TestInput>(key: K, value: TestInput[K]) =>
    setInput((i) => ({ ...i, [key]: value }));

  const { candidate, addressProblem } = useMemo(() => testCandidate(input), [input]);
  const run = useMemo(() => runRuleTest(rules, problems, candidate), [rules, problems, candidate]);
  const touched = input.url.trim() !== '' || input.title.trim() !== '' || input.quote.trim() !== '';
  const decision = run.decision;
  const tone =
    decision.kind === 'plan' ? 'success' : decision.kind === 'blocked' ? 'warning' : 'neutral';
  const VerdictIcon =
    decision.kind === 'plan'
      ? CircleCheck
      : decision.kind === 'blocked'
        ? TriangleAlert
        : CircleSlash;

  return (
    <div className="rule-tester" data-testid={tid('rule-tester')}>
      <p className="mv-line">
        {sample
          ? 'A sample from your rule. Nothing is saved.'
          : 'Paste a sample. Nothing is saved.'}
      </p>
      <div className="mv-field">
        <label htmlFor={`${uid}-url`}>Page address</label>
        <input
          id={`${uid}-url`}
          className="sv-control"
          data-testid={tid('test-url')}
          type="text"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="https://example.com/cardiology/week-1"
          value={input.url}
          aria-invalid={addressProblem ? true : undefined}
          aria-describedby={addressProblem ? `${uid}-url-err` : undefined}
          onChange={(e) => set('url', e.target.value)}
        />
        {addressProblem ? (
          <p id={`${uid}-url-err`} role="alert" className="rule-problem sv-small">
            Error: {addressProblem}
          </p>
        ) : null}
      </div>
      <div className="rule-tester__pair">
        <div className="mv-field">
          <label htmlFor={`${uid}-title`}>Page title</label>
          <input
            id={`${uid}-title`}
            className="sv-control"
            data-testid={tid('test-title')}
            type="text"
            dir="auto"
            autoComplete="off"
            value={input.title}
            onChange={(e) => set('title', e.target.value)}
          />
        </div>
        <div className="mv-field">
          <label htmlFor={`${uid}-quote`}>Quote</label>
          <input
            id={`${uid}-quote`}
            className="sv-control"
            data-testid={tid('test-quote')}
            type="text"
            dir="auto"
            autoComplete="off"
            value={input.quote}
            onChange={(e) => set('quote', e.target.value)}
          />
        </div>
      </div>
      <div>
        <ChunkyButton
          size="sm"
          variant="ghost"
          icon={SlidersHorizontal}
          aria-expanded={more}
          aria-controls={`${uid}-more`}
          onClick={() => setMore((m) => !m)}
        >
          More fields
        </ChunkyButton>
      </div>
      <div id={`${uid}-more`} className="rule-tester__more" hidden={!more}>
        <div className="rule-tester__pair">
          <div className="mv-field">
            <label htmlFor={`${uid}-kind`}>Kind</label>
            <select
              id={`${uid}-kind`}
              className="sv-control"
              data-testid={tid('test-kind')}
              value={input.kind}
              onChange={(e) => set('kind', e.target.value as HighlightKind)}
            >
              {HIGHLIGHT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABELS[k].glyph} {KIND_LABELS[k].label}
                </option>
              ))}
            </select>
          </div>
          <div className="mv-field">
            <label htmlFor={`${uid}-source`}>Source</label>
            <select
              id={`${uid}-source`}
              className="sv-control"
              data-testid={tid('test-source')}
              value={input.sourceType}
              onChange={(e) => set('sourceType', e.target.value as SourceType)}
            >
              {SOURCE_TYPES.map((s) => (
                <option key={s} value={s}>
                  {SOURCE_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
        </div>
        <ChipPicker
          testId={tid('test-tags')}
          label="Tags it has"
          values={input.tagIds}
          onChange={(tagIds) => set('tagIds', tagIds)}
          options={tree.tags.map((t) => ({ value: t.tag.id, text: t.tag.name }))}
          nameOf={(id) => tree.tags.find((t) => t.tag.id === id)?.tag.name ?? 'Deleted tag'}
          max={LIMITS.tags}
          addLabel="Add tag"
          emptyText="There are no tags yet."
        />
      </div>

      <div
        className="rule-result"
        role="status"
        aria-live="polite"
        data-testid={tid('test-result')}
      >
        {rules.filter((r) => r.deletedAt === null).length === 0 ? (
          <p className="mv-line">There are no rules to test yet.</p>
        ) : !touched && input.tagIds.length === 0 ? (
          <p className="mv-line">Type an address, a title or a quote.</p>
        ) : (
          <>
            <p className={`rule-verdict rule-verdict--${tone}`} data-testid={tid('test-verdict')}>
              <VerdictIcon className="rule-verdict__icon" aria-hidden="true" strokeWidth={2.4} />
              <span>
                <strong>Result: </strong>
                {decision.kind === 'none'
                  ? 'No rule matches. The highlight stays in the bank it is saved to.'
                  : decision.kind === 'blocked'
                    ? `Rule “${decision.rule.name}” matches first but cannot be applied, so nothing is filed.`
                    : (() => {
                        const place = describePlace(decision.rule, names);
                        const tags = decision.plan.addTagIds.map(names.tag);
                        return `${decision.plan.requireConfirm ? 'Ask first, then file' : 'File at once'} in ${place.where}${tags.length > 0 ? `, and add ${tags.length === 1 ? 'the tag' : 'the tags'} ${tags.join(', ')}` : ''}. Decided by rule “${decision.rule.name}”.`;
                      })()}
              </span>
            </p>
            {run.rows.length > 0 ? (
              <ol className="rule-test-rows" aria-label="Rules that match, in order">
                {run.rows.map(({ rule, status }) => {
                  const s = STATUS[status];
                  const Icon = s.icon;
                  return (
                    <li key={rule.id} data-testid={tid('test-row')} data-status={status}>
                      <strong dir="auto">{rule.id === focusId ? 'This rule' : rule.name}</strong>
                      <span className={`mv-chip mv-chip--${s.tone}`}>
                        <Icon aria-hidden="true" strokeWidth={2.4} />
                        {s.short}
                        <span className="sv-vh">: {s.long}</span>
                      </span>
                    </li>
                  );
                })}
              </ol>
            ) : null}
            {decision.kind === 'blocked'
              ? decision.issues.map((issue) => (
                  <InlineNotice key={`${issue.field}${issue.id}`} tone="warning">
                    {describeIssue(issue)}
                  </InlineNotice>
                ))
              : null}
            {!rulesOn && decision.kind !== 'none' ? (
              <InlineNotice tone="warning">
                “Use filing rules” is off, so this would not be applied to a new highlight.
              </InlineNotice>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
