import { useId, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  Check,
  FileText,
  Globe,
  Heading,
  Library,
  Link,
  MessageCircleQuestion,
  Pencil,
  Shapes,
  Tag,
  TextQuote,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import {
  HIGHLIGHT_KINDS,
  KIND_LABELS,
  StudyVaultError,
  type FilingRule,
  type HighlightKind,
} from '@shared';
import type { FilingRuleProblem } from '@storage';
import { ChoiceCards, ChunkyButton, InfoTip, InlineNotice, errorMessage, type ArtTone } from '@ui';
import { ChipInput, ChipPicker } from './Chips';
import { JumpWizard, type JumpStep } from './JumpWizard';
import { CheckCards, Chip, TogglePills } from './moreKit';
import { RuleTester } from './RuleTester';
import {
  LIMITS,
  SOURCE_LABELS,
  SOURCE_TYPES,
  conditionParts,
  draftRule,
  emptyForm,
  firstEmptyCondition,
  formFromRule,
  formProblems,
  formToInput,
  keepConditions,
  parseHosts,
  parsePhrase,
  parsePrefixes,
  sampleFor,
  suggestName,
  usedConditions,
  type ConditionKey,
  type Names,
  type RuleForm,
  type SourceType,
} from './rulesModel';
import type { RulesApi } from './rulesApi';
import { flattenFolders, useTreeData } from './treeData';
import './rules.css';

/** What each condition field looks like: picture-card icon, a short name and what to add. */
export const CONDITION_META: Record<
  ConditionKey,
  { icon: LucideIcon; label: string; hint: string; noun: string; tone: ArtTone }
> = {
  hosts: { icon: Globe, label: 'Site', hint: 'example.com', noun: 'a site', tone: 'primary' },
  urlPrefixes: {
    icon: Link,
    label: 'Address',
    hint: 'Starts with…',
    noun: 'an address',
    tone: 'primary',
  },
  titleContains: {
    icon: Heading,
    label: 'Page title',
    hint: 'Has words',
    noun: 'a word',
    tone: 'violet',
  },
  quoteContains: {
    icon: TextQuote,
    label: 'Quote',
    hint: 'Has words',
    noun: 'a word',
    tone: 'violet',
  },
  kinds: { icon: Shapes, label: 'Kind', hint: 'Formula, fact…', noun: 'a kind', tone: 'sun' },
  sourceTypes: {
    icon: FileText,
    label: 'Source',
    hint: 'Web or PDF',
    noun: 'a source',
    tone: 'danger',
  },
  tagIds: { icon: Tag, label: 'Tags', hint: 'Already tagged', noun: 'a tag', tone: 'success' },
};

const BANK_CARDS_MAX = 9;

/**
 * Create or edit one filing rule as a wizard (UX_DESIGN 10, docs/adr/017-filing-rules.md): When
 * (which fields to look at) · What matches (the values, as chips that say why an entry was
 * refused) · File into (bank, folder, extra tags) · Ask first? (on by default) · Try it (the real
 * decision over the stored rules with this one in them, starting from a sample made of the rule)
 * · Looks good? (the rule in one card, each part with a way back to its step, and its name).
 * Editing opens on that last step. Nothing is saved before Create/Save; Back keeps every answer.
 */
export function RuleDialog({
  rule,
  api,
  rules,
  problems: storedProblems,
  names,
  rulesOn,
  onDone,
  onCancel,
}: {
  /** The rule being edited; absent when creating. */
  rule?: FilingRule;
  api: RulesApi;
  /** The stored rules, for "Try it". */
  rules: readonly FilingRule[];
  problems: readonly FilingRuleProblem[];
  names: Names;
  rulesOn: boolean;
  onDone(saved: FilingRule): void;
  onCancel(): void;
}) {
  const uid = useId();
  const tree = useTreeData();
  const defaultBank = tree.banks.find((b) => b.isInbox)?.id ?? tree.banks[0]?.id ?? '';
  const [initial] = useState<RuleForm>(() => (rule ? formFromRule(rule) : emptyForm(defaultBank)));
  const [form, setForm] = useState<RuleForm>(initial);
  const [keys, setKeys] = useState<ConditionKey[]>(() => usedConditions(initial));
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const set = <K extends keyof RuleForm>(key: K, value: RuleForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const bankIds = useMemo(() => new Set(tree.banks.map((b) => b.id)), [tree.banks]);
  const effective = keepConditions(form, keys);
  const bankName = bankIds.has(form.bankId) ? names.bank(form.bankId) : null;
  const suggested = suggestName(effective, bankName);
  const final: RuleForm = { ...effective, name: form.name.trim() || suggested };
  const problems = formProblems(final, bankIds);
  const folders = flattenFolders(tree.folders[form.bankId] ?? []);
  const tagOptions = tree.tags.map((t) => ({ value: t.tag.id, text: t.tag.name }));
  const tagName = (id: string) => tree.tags.find((t) => t.tag.id === id)?.tag.name ?? 'Deleted tag';
  const folderKnown = form.folderId === null || folders.some((f) => f.id === form.folderId);
  const dirty =
    JSON.stringify(form) !== JSON.stringify(initial) ||
    keys.join() !== usedConditions(initial).join();

  const draft = draftRule(final, rule, Math.max(-1, ...rules.map((r) => r.order)) + 1);
  const testRules = [...rules.filter((r) => r.id !== draft.id), draft];
  // Stored problems of the rule being edited describe the old version, not this draft.
  const testProblems = storedProblems.filter((p) => p.ruleId !== draft.id);

  const save = async () => {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      if (rule) {
        const out = await api.updateFilingRule(rule.id, formToInput(final), {
          expectedVersion: rule.updatedAt,
        });
        if (out.status === 'stale') {
          throw new StudyVaultError(
            'invalid_request',
            'This rule was changed in another window. Close and open it again.',
          );
        }
        onDone(out.row);
      } else {
        onDone(await api.createFilingRule(formToInput(final)));
      }
    } catch (err) {
      setSaveError(errorMessage(err, 'Could not save the rule. Try again.'));
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };

  const field = (key: ConditionKey) => {
    switch (key) {
      case 'hosts':
        return (
          <ChipInput
            testId="rule-hosts"
            label="Sites"
            values={form.hosts}
            onChange={(hosts) => set('hosts', hosts)}
            parse={parseHosts}
            max={LIMITS.values}
            placeholder="example.com"
            addLabel="Add site"
          />
        );
      case 'urlPrefixes':
        return (
          <ChipInput
            testId="rule-prefixes"
            label="Address starts with"
            values={form.urlPrefixes}
            onChange={(urlPrefixes) => set('urlPrefixes', urlPrefixes)}
            parse={parsePrefixes}
            max={LIMITS.values}
            placeholder="https://example.com/cardiology/"
            addLabel="Add address"
          />
        );
      case 'titleContains':
        return (
          <ChipInput
            testId="rule-title"
            label="Title has"
            values={form.titleContains}
            onChange={(titleContains) => set('titleContains', titleContains)}
            parse={parsePhrase}
            max={LIMITS.values}
            placeholder="heart failure"
            addLabel="Add word"
          />
        );
      case 'quoteContains':
        return (
          <ChipInput
            testId="rule-quote"
            label="Quote has"
            values={form.quoteContains}
            onChange={(quoteContains) => set('quoteContains', quoteContains)}
            parse={parsePhrase}
            max={LIMITS.values}
            placeholder="mg/dL"
            addLabel="Add word"
          />
        );
      case 'tagIds':
        return (
          <ChipPicker
            testId="rule-tags"
            label="Tagged with"
            values={form.tagIds}
            onChange={(tagIds) => set('tagIds', tagIds)}
            options={tagOptions}
            nameOf={tagName}
            max={LIMITS.tags}
            addLabel="Add tag"
            emptyText="There are no tags yet."
          />
        );
      case 'kinds':
        return (
          <TogglePills<HighlightKind>
            testId="rule-kinds"
            legend="Kind (any of these)"
            options={HIGHLIGHT_KINDS.map((k) => ({
              value: k,
              label: KIND_LABELS[k].label,
              glyph: KIND_LABELS[k].glyph,
            }))}
            values={form.kinds}
            onChange={(kinds) => set('kinds', kinds)}
          />
        );
      case 'sourceTypes':
        return (
          <TogglePills<SourceType>
            testId="rule-sources"
            legend="Source (any of these)"
            options={SOURCE_TYPES.map((s) => ({ value: s, label: SOURCE_LABELS[s] }))}
            values={form.sourceTypes}
            onChange={(sourceTypes) => set('sourceTypes', sourceTypes)}
          />
        );
    }
  };
  /** One picked condition: its picture tile beside its field. */
  const builder = (key: ConditionKey) => {
    const meta = CONDITION_META[key];
    const Icon = meta.icon;
    return (
      <div key={key} className="rule-cond">
        <span className={`rule-cond__art sv-art--${meta.tone}`} aria-hidden="true">
          <Icon strokeWidth={2.4} />
        </span>
        <div className="rule-cond__field">{field(key)}</div>
      </div>
    );
  };

  const steps: JumpStep[] = [
    {
      id: 'when',
      title: 'When',
      validate: () => (keys.length === 0 ? 'Pick at least one thing to look at.' : null),
      content: ({ error, errorId }) => (
        <>
          <p className="mv-line">What should a new highlight match?</p>
          <CheckCards<ConditionKey>
            label="Look at"
            testId="rule-when"
            columns={4}
            options={(Object.keys(CONDITION_META) as ConditionKey[]).map((k) => ({
              value: k,
              label: CONDITION_META[k].label,
              hint: CONDITION_META[k].hint,
              icon: CONDITION_META[k].icon,
              tone: CONDITION_META[k].tone,
            }))}
            values={keys}
            onChange={setKeys}
            invalid={error !== null}
            {...(error ? { describedBy: errorId } : {})}
          />
        </>
      ),
    },
    {
      id: 'match',
      title: 'What matches',
      validate: () => {
        const empty = firstEmptyCondition(form, keys);
        if (empty === null) return null;
        const meta = CONDITION_META[empty];
        return `Add ${meta.noun} (press Enter), or go back and untick ${meta.label}.`;
      },
      content: () => (
        <>
          <p className="mv-line rule-line">
            Every field must match.
            <InfoTip label="How conditions combine">
              Every field you fill in has to match. Inside one field, any one value is enough. PDF
              highlights are only filed by a rule whose source includes PDF document.
            </InfoTip>
          </p>
          {keys.length === 0 ? (
            <p className="mv-line">Go back and pick what to look at.</p>
          ) : (
            keys.map(builder)
          )}
          {problems.warnings
            .filter((w) => w.startsWith('A new highlight has no tags'))
            .map((w) => (
              <InlineNotice key={w} tone="warning">
                {w}
              </InlineNotice>
            ))}
        </>
      ),
    },
    {
      id: 'then',
      title: 'File into',
      validate: () =>
        problems.bank ?? (folderKnown ? null : 'Choose a folder in the bank, or the top level.'),
      content: ({ error, errorId }) => (
        <>
          {tree.banks.length <= BANK_CARDS_MAX ? (
            <div data-testid="rule-bank">
              <ChoiceCards
                label="Bank"
                columns={3}
                options={tree.banks.map((b) => ({
                  value: b.id,
                  label: b.name,
                  icon: Library,
                  ...(b.icon ? { art: <span className="rule-emoji">{b.icon}</span> } : {}),
                }))}
                value={bankIds.has(form.bankId) ? form.bankId : null}
                onChange={(bankId) => setForm((f) => ({ ...f, bankId, folderId: null }))}
                invalid={error !== null && problems.bank !== null}
                {...(error ? { describedBy: errorId } : {})}
              />
            </div>
          ) : (
            <div className="mv-field">
              <label htmlFor={`${uid}-bank`}>Bank</label>
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
            </div>
          )}
          {folders.length > 0 ? (
            <div className="mv-field">
              <label htmlFor={`${uid}-folder`}>Folder</label>
              <select
                id={`${uid}-folder`}
                className="sv-control"
                data-testid="rule-folder"
                value={folderKnown ? (form.folderId ?? '') : ''}
                aria-invalid={folderKnown ? undefined : true}
                onChange={(e) => set('folderId', e.target.value === '' ? null : e.target.value)}
              >
                <option value="">Top of the bank</option>
                {folders.map((f) => (
                  // Leading spaces collapse in an option, so depth is drawn with a dash per level.
                  <option key={f.id} value={f.id}>
                    {`${'– '.repeat(f.depth - 1)}${f.name}`}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <ChipPicker
            testId="rule-add-tags"
            label="Also add tags"
            values={form.addTagIds}
            onChange={(addTagIds) => set('addTagIds', addTagIds)}
            options={tagOptions}
            nameOf={tagName}
            max={LIMITS.tags}
            addLabel="Add tag"
            emptyText="There are no tags yet."
          />
        </>
      ),
    },
    {
      id: 'ask',
      title: 'Ask first?',
      content: (
        <div data-testid="rule-confirm">
          <ChoiceCards<'ask' | 'auto'>
            label="When it matches"
            columns={2}
            options={[
              {
                value: 'ask',
                label: 'Ask first',
                hint: 'File or Not now',
                icon: MessageCircleQuestion,
              },
              { value: 'auto', label: 'File at once', hint: 'With Undo', icon: Zap, tone: 'sun' },
            ]}
            value={form.requireConfirm ? 'ask' : 'auto'}
            onChange={(v) => set('requireConfirm', v === 'ask')}
          />
        </div>
      ),
    },
    {
      id: 'try',
      title: 'Try it',
      content: (
        <RuleTester
          rules={testRules}
          problems={testProblems}
          names={names}
          rulesOn={rulesOn}
          focusId={draft.id}
          tidPrefix="wiz-"
          sample={sampleFor(effective)}
        />
      ),
    },
    {
      id: 'review',
      title: 'Looks good?',
      validate: () => problems.name,
      content: ({ error, errorId, goTo }) => (
        <>
          <Summary form={final} names={names} onChange={goTo} />
          <div className="mv-field">
            <label htmlFor={`${uid}-name`}>Rule name</label>
            <input
              id={`${uid}-name`}
              className="sv-control"
              data-testid="rule-name"
              value={form.name}
              maxLength={LIMITS.name + 20}
              dir="auto"
              autoComplete="off"
              placeholder={suggested || 'Cardiology course site'}
              aria-invalid={error ? true : undefined}
              aria-describedby={
                error
                  ? errorId
                  : form.name.trim() === '' && suggested
                    ? `${uid}-name-hint`
                    : undefined
              }
              onChange={(e) => set('name', e.target.value)}
            />
            {form.name.trim() === '' && suggested ? (
              <p id={`${uid}-name-hint`} className="mv-line">
                Empty uses “{suggested}”.
              </p>
            ) : null}
          </div>
          <label className="sv-check rule-wiz__on">
            <input
              type="checkbox"
              className="sv-switch"
              data-testid="rule-enabled"
              checked={form.enabled}
              onChange={(e) => set('enabled', e.target.checked)}
            />
            <span>{rule ? 'Rule is on' : 'Turn on now'}</span>
          </label>
          {problems.warnings.map((w) => (
            <InlineNotice key={w} tone="warning">
              {w}
            </InlineNotice>
          ))}
          {saving ? (
            <p className="mv-line" role="status">
              Saving…
            </p>
          ) : null}
          {saveError ? (
            <InlineNotice tone="error" title="Not saved">
              {saveError}
            </InlineNotice>
          ) : null}
        </>
      ),
    },
  ];

  return (
    <JumpWizard
      className="mv-wiz rule-wiz"
      label={rule ? 'Edit rule' : 'New filing rule'}
      steps={steps}
      start={rule ? steps.length - 1 : 0}
      finishLabel={rule ? 'Save rule' : 'Create rule'}
      finishIcon={Check}
      dirty={dirty}
      onClose={onCancel}
      onFinish={() => void save()}
    />
  );
}

/** The rule in one card, each part with a way back to its step. */
function Summary({
  form,
  names,
  onChange,
}: {
  form: RuleForm;
  names: Names;
  onChange(step: string): void;
}) {
  const parts = conditionParts({ match: formToInput(form).match }, names);
  const folder = form.folderId === null ? null : names.folder(form.folderId);
  const change = (step: string, what: string) => (
    <ChunkyButton
      size="sm"
      variant="ghost"
      icon={Pencil}
      className="rule-summary__change"
      aria-label={`Change ${what}`}
      onClick={() => onChange(step)}
    >
      Change
    </ChunkyButton>
  );
  return (
    <div className="rule-summary" data-testid="rule-summary">
      <div className="rule-summary__row">
        <span className="rule-summary__key">When</span>
        <p className="rule-summary__chips">
          {parts.length > 0 ? (
            parts.map((p) => (
              <Chip
                key={p.key}
                icon={CONDITION_META[p.key].icon}
                prefix={CONDITION_META[p.key].label}
              >
                {p.values.join(' or ')}
              </Chip>
            ))
          ) : (
            <Chip tone="warning">No condition</Chip>
          )}
        </p>
        {change('when', 'what it matches')}
      </div>
      <div className="rule-summary__row">
        <span className="rule-summary__key">Then</span>
        <p className="rule-summary__chips">
          <ArrowRight className="rule-summary__arrow" aria-hidden="true" />
          <Chip icon={Library} tone="primary" prefix="File in">
            {names.bank(form.bankId)}
            {folder ? ` / ${folder}` : ''}
          </Chip>
          {form.addTagIds.map((id) => (
            <Chip key={id} icon={Tag} prefix="Add tag">
              {names.tag(id)}
            </Chip>
          ))}
        </p>
        {change('then', 'where it files')}
      </div>
      <div className="rule-summary__row">
        <span className="rule-summary__key">Ask</span>
        <p className="rule-summary__chips">
          <Chip
            icon={form.requireConfirm ? MessageCircleQuestion : Zap}
            tone={form.requireConfirm ? 'violet' : 'sun'}
          >
            {form.requireConfirm ? 'Asks first' : 'Files at once'}
          </Chip>
        </p>
        {change('ask', 'asking first')}
      </div>
    </div>
  );
}
