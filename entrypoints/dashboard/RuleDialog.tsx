import { useId, useMemo, useState } from 'react';
import {
  HIGHLIGHT_KINDS,
  KIND_LABELS,
  StudyVaultError,
  type FilingRule,
  type HighlightKind,
} from '@shared';
import { InlineNotice } from '@ui';
import { ChipInput, ChipPicker } from './Chips';
import { FormDialog } from './dialogs';
import {
  LIMITS,
  SOURCE_LABELS,
  SOURCE_TYPES,
  emptyForm,
  formFromRule,
  formProblems,
  formToInput,
  parseHosts,
  parsePhrase,
  parsePrefixes,
  type RuleForm,
  type SourceType,
} from './rulesModel';
import type { RulesApi } from './rulesApi';
import { flattenFolders, useTreeData } from './treeData';

/**
 * Create or edit one filing rule. The conditions are chip fields that say why an entry was refused;
 * the action is a bank (required), an optional folder and extra tags; "Ask me before filing" is on
 * unless the person turns it off for this rule (docs/adr/017-filing-rules.md).
 */
export function RuleDialog({
  rule,
  api,
  onDone,
  onCancel,
}: {
  /** The rule being edited; absent when creating. */
  rule?: FilingRule;
  api: RulesApi;
  onDone(saved: FilingRule): void;
  onCancel(): void;
}) {
  const uid = useId();
  const tree = useTreeData();
  const defaultBank = tree.banks.find((b) => b.isInbox)?.id ?? tree.banks[0]?.id ?? '';
  const [form, setForm] = useState<RuleForm>(() => {
    return rule ? formFromRule(rule) : emptyForm(defaultBank);
  });
  const set = <K extends keyof RuleForm>(key: K, value: RuleForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const bankIds = useMemo(() => new Set(tree.banks.map((b) => b.id)), [tree.banks]);
  const problems = formProblems(form, bankIds);
  const folders = flattenFolders(tree.folders[form.bankId] ?? []);
  const tagOptions = tree.tags.map((t) => ({ value: t.tag.id, text: t.tag.name }));
  const tagName = (id: string) => tree.tags.find((t) => t.tag.id === id)?.tag.name ?? 'Deleted tag';
  const folderKnown = form.folderId === null || folders.some((f) => f.id === form.folderId);

  const flip = <T,>(list: readonly T[], value: T): T[] =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  return (
    <FormDialog
      title={rule ? `Edit rule “${rule.name}”` : 'New filing rule'}
      confirmLabel={rule ? 'Save rule' : 'Create rule'}
      disabledReason={
        problems.first ??
        (folderKnown ? undefined : 'Choose a folder in the bank, or the top level.')
      }
      wide
      testId="rule-dialog"
      onCancel={onCancel}
      onSubmit={async () => {
        if (rule) {
          const out = await api.updateFilingRule(rule.id, formToInput(form), {
            expectedVersion: rule.updatedAt,
          });
          if (out.status === 'stale') {
            throw new StudyVaultError(
              'invalid_request',
              'This rule was changed in another window while you edited it. Close this dialog and open the rule again to see the current version.',
            );
          }
          onDone(out.row);
        } else {
          onDone(await api.createFilingRule(formToInput(form)));
        }
      }}
    >
      <div className="sv-field">
        <label className="sv-label" htmlFor={`${uid}-name`}>
          Name
        </label>
        <input
          id={`${uid}-name`}
          className="sv-control"
          data-autofocus=""
          data-testid="rule-name"
          value={form.name}
          maxLength={LIMITS.name + 20}
          dir="auto"
          autoComplete="off"
          placeholder="For example: Cardiology course site"
          aria-invalid={problems.name && form.name !== '' ? true : undefined}
          onChange={(e) => set('name', e.target.value)}
        />
        {problems.name && form.name !== '' ? (
          <p role="alert" className="rule-problem sv-small">
            Error: {problems.name}
          </p>
        ) : null}
      </div>

      <fieldset className="rule-fieldset">
        <legend>When a new highlight matches</legend>
        <p className="sv-small sv-muted">
          Every field you fill in has to match. Inside one field, any one value is enough.
          {problems.conditions ? ` ${problems.conditions}` : ''}
        </p>
        <ChipInput
          testId="rule-hosts"
          label="Sites"
          hint="A site and all of its subpages, such as example.com. Subdomains match too."
          values={form.hosts}
          onChange={(hosts) => set('hosts', hosts)}
          parse={parseHosts}
          max={LIMITS.values}
          placeholder="example.com"
          addLabel="Add site"
        />
        <ChipInput
          testId="rule-prefixes"
          label="Page address starts with"
          hint="Use this for one course or section of a site, such as https://example.com/cardiology/."
          values={form.urlPrefixes}
          onChange={(urlPrefixes) => set('urlPrefixes', urlPrefixes)}
          parse={parsePrefixes}
          max={LIMITS.values}
          placeholder="https://example.com/cardiology/"
          addLabel="Add address"
        />
        <ChipInput
          testId="rule-title"
          label="Page title contains"
          values={form.titleContains}
          onChange={(titleContains) => set('titleContains', titleContains)}
          parse={parsePhrase}
          max={LIMITS.values}
          placeholder="heart failure"
          addLabel="Add word"
        />
        <ChipInput
          testId="rule-quote"
          label="Highlighted text contains"
          values={form.quoteContains}
          onChange={(quoteContains) => set('quoteContains', quoteContains)}
          parse={parsePhrase}
          max={LIMITS.values}
          placeholder="mg/dL"
          addLabel="Add word"
        />
        <ChipPicker
          testId="rule-tags"
          label="Tagged with"
          hint="A new highlight has no tags yet, so use this together with another condition."
          values={form.tagIds}
          onChange={(tagIds) => set('tagIds', tagIds)}
          options={tagOptions}
          nameOf={tagName}
          max={LIMITS.tags}
          addLabel="Add tag"
          emptyText="There are no tags yet."
        />
        <fieldset className="rule-fieldset rule-fieldset--inner">
          <legend>Kind of highlight (any of these)</legend>
          <div className="rule-checks">
            {HIGHLIGHT_KINDS.map((kind: HighlightKind) => (
              <label key={kind} className="sv-check">
                <input
                  type="checkbox"
                  checked={form.kinds.includes(kind)}
                  onChange={() => set('kinds', flip(form.kinds, kind))}
                />
                <span>
                  <span aria-hidden="true">{KIND_LABELS[kind].glyph}</span>{' '}
                  {KIND_LABELS[kind].label}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="rule-fieldset rule-fieldset--inner">
          <legend>Source (any of these)</legend>
          <div className="rule-checks">
            {SOURCE_TYPES.map((type: SourceType) => (
              <label key={type} className="sv-check">
                <input
                  type="checkbox"
                  checked={form.sourceTypes.includes(type)}
                  onChange={() => set('sourceTypes', flip(form.sourceTypes, type))}
                />
                <span>{SOURCE_LABELS[type]}</span>
              </label>
            ))}
          </div>
          <p className="sv-small sv-muted">
            Highlights made in the PDF reader are only filed by a rule that lists PDF document here.
          </p>
        </fieldset>
      </fieldset>

      <fieldset className="rule-fieldset">
        <legend>Then</legend>
        <div className="sv-field">
          <label className="sv-label" htmlFor={`${uid}-bank`}>
            File in this bank
          </label>
          <select
            id={`${uid}-bank`}
            className="sv-control"
            data-testid="rule-bank"
            value={bankIds.has(form.bankId) ? form.bankId : ''}
            aria-invalid={problems.bank ? true : undefined}
            onChange={(e) => setForm((f) => ({ ...f, bankId: e.target.value, folderId: null }))}
          >
            {bankIds.has(form.bankId) ? null : <option value="">Choose a bank…</option>}
            {tree.banks.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          {problems.bank ? (
            <p className="rule-problem sv-small" role="alert">
              Error: {problems.bank}
            </p>
          ) : null}
        </div>
        <div className="sv-field">
          <label className="sv-label" htmlFor={`${uid}-folder`}>
            In this folder
          </label>
          <select
            id={`${uid}-folder`}
            className="sv-control"
            data-testid="rule-folder"
            value={folderKnown ? (form.folderId ?? '') : ''}
            disabled={!bankIds.has(form.bankId)}
            onChange={(e) => set('folderId', e.target.value === '' ? null : e.target.value)}
          >
            <option value="">Top level of the bank</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {`${'  '.repeat(f.depth - 1)}${f.name}`}
              </option>
            ))}
          </select>
        </div>
        <ChipPicker
          testId="rule-add-tags"
          label="Also add these tags"
          values={form.addTagIds}
          onChange={(addTagIds) => set('addTagIds', addTagIds)}
          options={tagOptions}
          nameOf={tagName}
          max={LIMITS.tags}
          addLabel="Add tag"
          emptyText="There are no tags yet."
        />
      </fieldset>

      <label className="sv-check">
        <input
          type="checkbox"
          data-testid="rule-confirm"
          checked={form.requireConfirm}
          onChange={(e) => set('requireConfirm', e.target.checked)}
        />
        <span>
          Ask me before filing
          <span className="sv-small sv-muted">
            {' '}
            A notice offers File and Not now. Turn this off to file at once, with Undo.
          </span>
        </span>
      </label>
      <label className="sv-check">
        <input
          type="checkbox"
          data-testid="rule-enabled"
          checked={form.enabled}
          onChange={(e) => set('enabled', e.target.checked)}
        />
        <span>This rule is on</span>
      </label>
      {problems.warnings.map((w) => (
        <InlineNotice key={w} tone="warning">
          {w}
        </InlineNotice>
      ))}
    </FormDialog>
  );
}
