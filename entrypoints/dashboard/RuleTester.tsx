import { useId, useMemo, useState } from 'react';
import { HIGHLIGHT_KINDS, KIND_LABELS, type FilingRule, type HighlightKind } from '@shared';
import type { FilingRuleProblem } from '@storage';
import { InlineNotice } from '@ui';
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

const STATUS_TEXT: Record<TestStatus, string> = {
  decides: 'Decides where the highlight goes',
  adds: 'Adds its tags',
  blocked: 'Matches first but cannot be applied',
  broken: 'Matches but is skipped: something it needs was deleted',
  off: 'Matches but is turned off',
  'not-offered': 'Matches, but a PDF is only offered to rules that list PDF document as a source',
  idle: 'Matches but is not used',
};

/**
 * "Test a rule": paste an address, a title and a quote and see which rules match and what the
 * result would be. It runs the same pure decision the worker runs after a capture, over the rules as
 * they are stored, so what it shows is what a real capture would do (docs/adr/017-filing-rules.md).
 */
export function RuleTester({
  rules,
  problems,
  names,
  rulesOn,
}: {
  rules: readonly FilingRule[];
  problems: readonly FilingRuleProblem[];
  names: Names;
  /** Settings.useFilingRules: with it off no rule is applied at capture, and the panel says so. */
  rulesOn: boolean;
}) {
  const uid = useId();
  const tree = useTreeData();
  const [input, setInput] = useState<TestInput>(emptyTest);
  const set = <K extends keyof TestInput>(key: K, value: TestInput[K]) =>
    setInput((i) => ({ ...i, [key]: value }));

  const { candidate, addressProblem } = useMemo(() => testCandidate(input), [input]);
  const run = useMemo(() => runRuleTest(rules, problems, candidate), [rules, problems, candidate]);
  const touched = input.url.trim() !== '' || input.title.trim() !== '' || input.quote.trim() !== '';
  const decision = run.decision;

  return (
    <section className="rule-tester" aria-labelledby={`${uid}-h`} data-testid="rule-tester">
      <h3 id={`${uid}-h`}>Test a rule</h3>
      <p className="sv-small sv-muted">
        Paste what a highlight would look like. Nothing is saved or filed; this only shows which
        rules match.
      </p>
      <div className="dash-two-col">
        <div className="sv-field">
          <label className="sv-label" htmlFor={`${uid}-url`}>
            Page address
          </label>
          <input
            id={`${uid}-url`}
            className="sv-control"
            data-testid="test-url"
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://example.com/cardiology/week-1"
            value={input.url}
            aria-invalid={addressProblem ? true : undefined}
            onChange={(e) => set('url', e.target.value)}
          />
          {addressProblem ? (
            <p role="alert" className="rule-problem sv-small">
              Error: {addressProblem}
            </p>
          ) : null}
        </div>
        <div className="sv-field">
          <label className="sv-label" htmlFor={`${uid}-title`}>
            Page title
          </label>
          <input
            id={`${uid}-title`}
            className="sv-control"
            data-testid="test-title"
            type="text"
            dir="auto"
            autoComplete="off"
            value={input.title}
            onChange={(e) => set('title', e.target.value)}
          />
        </div>
      </div>
      <div className="sv-field">
        <label className="sv-label" htmlFor={`${uid}-quote`}>
          Highlighted text
        </label>
        <textarea
          id={`${uid}-quote`}
          className="sv-control"
          data-testid="test-quote"
          rows={2}
          dir="auto"
          value={input.quote}
          onChange={(e) => set('quote', e.target.value)}
        />
      </div>
      <div className="dash-two-col">
        <div className="sv-field">
          <label className="sv-label" htmlFor={`${uid}-kind`}>
            Kind
          </label>
          <select
            id={`${uid}-kind`}
            className="sv-control"
            data-testid="test-kind"
            value={input.kind}
            onChange={(e) => set('kind', e.target.value as HighlightKind)}
          >
            {HIGHLIGHT_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k].label}
              </option>
            ))}
          </select>
        </div>
        <div className="sv-field">
          <label className="sv-label" htmlFor={`${uid}-source`}>
            Source
          </label>
          <select
            id={`${uid}-source`}
            className="sv-control"
            data-testid="test-source"
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
        testId="test-tags"
        label="Tags it already has"
        values={input.tagIds}
        onChange={(tagIds) => set('tagIds', tagIds)}
        options={tree.tags.map((t) => ({ value: t.tag.id, text: t.tag.name }))}
        nameOf={(id) => tree.tags.find((t) => t.tag.id === id)?.tag.name ?? 'Deleted tag'}
        max={LIMITS.tags}
        addLabel="Add tag"
        emptyText="There are no tags yet."
      />

      <div
        className="sv-stack sv-stack--tight"
        role="status"
        aria-live="polite"
        data-testid="test-result"
      >
        {rules.filter((r) => r.deletedAt === null).length === 0 ? (
          <p>There are no rules to test yet.</p>
        ) : !touched && input.tagIds.length === 0 ? (
          <p className="sv-muted">Fill in the fields above to see the result.</p>
        ) : (
          <>
            <p data-testid="test-verdict">
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
            </p>
            {run.rows.length > 0 ? (
              <ol className="rule-test-rows" aria-label="Rules that match, in order">
                {run.rows.map(({ rule, status }) => (
                  <li key={rule.id} data-testid="test-row" data-status={status}>
                    <strong dir="auto">{rule.name}</strong>
                    <span className="sv-small sv-muted"> · {STATUS_TEXT[status]}</span>
                  </li>
                ))}
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
            <p className="sv-small sv-muted">
              A rule never moves a highlight when you pick a bank yourself in the toolbar's More
              options. Only newly saved highlights are looked at.
            </p>
          </>
        )}
      </div>
    </section>
  );
}
