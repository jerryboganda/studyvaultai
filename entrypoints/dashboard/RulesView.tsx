import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  Copy,
  FlaskConical,
  Library,
  MessageCircleQuestion,
  Pencil,
  Plus,
  Power,
  Tag,
  Trash,
  Workflow,
  Zap,
} from 'lucide-react';

import type { FilingRule } from '@shared';
import type { FilingRuleProblem } from '@storage';
import {
  AsyncSwitch,
  ChunkyButton,
  InfoTip,
  InlineNotice,
  plural,
  useAction,
  useSettings,
  useToast,
} from '@ui';
import { useBump, useVaultQuery } from './hooks';
import { Action, Chip, Empty, IconAction, Loading, ViewHead } from './moreKit';
import { CONDITION_META, RuleDialog } from './RuleDialog';
import { RuleTester } from './RuleTester';
import { conditionParts, describeIssue, describePlace, type Names } from './rulesModel';
import { useRulesApi } from './rulesApi';
import { flattenFolders, useTreeData } from './treeData';
import './rules.css';

const EMPTY_ASKED: ReadonlyMap<string, boolean> = new Map();

/**
 * The filing-rules manager (docs/adr/017-filing-rules.md): the rules as cards in the order they are
 * tried, a switch for the whole feature, the create/edit wizard, and a panel that tests what the
 * rules would do. Rules never act on imports, restores or sync; at capture the worker decides with
 * the same pure function the test panel uses.
 */
export function RulesView() {
  const api = useRulesApi();
  const tree = useTreeData();
  const toast = useToast();
  const bump = useBump();
  const { settings, update } = useSettings();
  const [editing, setEditing] = useState<FilingRule | 'new' | null>(null);
  const [testing, setTesting] = useState(false);

  const state = useVaultQuery(async () => {
    const [rules, problems] = await Promise.all([api.listFilingRules(), api.checkFilingRules()]);
    return { rules, problems };
  }, []);
  const rules = useMemo(() => state.data?.rules ?? [], [state.data]);
  const problems = useMemo(() => state.data?.problems ?? [], [state.data]);
  const issuesOf = useMemo(() => {
    const map = new Map<string, FilingRuleProblem[]>();
    for (const p of problems) map.set(p.ruleId, [...(map.get(p.ruleId) ?? []), p]);
    return map;
  }, [problems]);

  const names: Names = useMemo(() => {
    const folders = new Map<string, string>();
    for (const forest of Object.values(tree.folders)) {
      for (const f of flattenFolders(forest)) folders.set(f.id, f.name);
    }
    return {
      bank: (id) => tree.banks.find((b) => b.id === id)?.name ?? 'a deleted bank',
      folder: (id) => folders.get(id) ?? 'a deleted folder',
      tag: (id) => tree.tags.find((t) => t.tag.id === id)?.tag.name ?? 'a deleted tag',
    };
  }, [tree]);

  const rulesOn = settings?.useFilingRules ?? true;

  const toggleAll = useAction(async (next: boolean) => {
    await update((s) => ({ ...s, useFilingRules: next }));
    toast.announce(next ? 'Filing rules are on.' : 'Filing rules are off.');
  });

  const act = useAction(async (work: () => Promise<void>) => {
    await work();
    bump();
  });

  // A rule that moved keeps the keyboard where it was: re-inserting its row would drop the focus.
  const refocus = useRef<{ id: string; testId: string; order: string } | null>(null);
  useEffect(() => {
    const want = refocus.current;
    // Only once the list shows the order that was asked for (an earlier refresh is not that).
    if (!want || rules.map((r) => r.id).join() !== want.order) return;
    refocus.current = null;
    document
      .querySelector<HTMLElement>(`[data-rule-id="${want.id}"] [data-testid="${want.testId}"]`)
      ?.focus();
  }, [rules]);

  const move = (rule: FilingRule, by: -1 | 1): void => {
    const ids = rules.map((r) => r.id);
    const from = ids.indexOf(rule.id);
    const to = from + by;
    if (from < 0 || to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to]!, ids[from]!];
    const held = document.activeElement as HTMLElement | null;
    refocus.current = {
      id: rule.id,
      testId: held?.dataset.testid ?? 'rule-edit',
      order: ids.join(),
    };
    void act.run(async () => {
      await api.reorderFilingRules(ids);
      toast.announce(`Rule “${rule.name}” is now number ${to + 1} of ${ids.length}.`);
    });
  };

  // The switch shows the asked-for state while its write is in flight (and until the list has been
  // read again), so it never snaps back under the pointer. The answers belong to the list they were
  // asked against: a newer list from storage is the truth and they are ignored.
  const [askedState, setAsked] = useState<{ list: unknown; on: ReadonlyMap<string, boolean> }>({
    list: null,
    on: new Map(),
  });
  const asked = askedState.list === rules ? askedState.on : EMPTY_ASKED;

  const setEnabled = (rule: FilingRule, enabled: boolean): Promise<void> => {
    const change = (apply: (m: Map<string, boolean>) => void) =>
      setAsked((a) => {
        const next = new Map(a.list === rules ? a.on : []);
        apply(next);
        return { list: rules, on: next };
      });
    change((m) => m.set(rule.id, enabled));
    const forget = () => change((m) => m.delete(rule.id));
    return act.run(async () => {
      try {
        const out = await api.updateFilingRule(
          rule.id,
          { enabled },
          { expectedVersion: rule.updatedAt },
        );
        if (out.status === 'stale') {
          forget();
          toast.push({
            tone: 'error',
            message: `Rule “${rule.name}” was changed in another window. The list shows its current state.`,
          });
          return;
        }
        toast.announce(`Rule “${rule.name}” is ${enabled ? 'on' : 'off'}.`);
      } catch (err) {
        forget();
        throw err;
      }
    });
  };

  const remove = (rule: FilingRule): void => {
    const before = rules.map((r) => r.id);
    void act.run(async () => {
      await api.deleteFilingRule(rule.id);
      toast.push({
        message: `Rule “${rule.name}” deleted.`,
        focusAction: true,
        action: {
          label: 'Undo',
          onClick: () => {
            void (async () => {
              try {
                await api.restoreFilingRule(rule.id);
                // A restored rule goes last: put it back where it was among the rules still there.
                const live = new Set((await api.listFilingRules()).map((r) => r.id));
                await api.reorderFilingRules(before.filter((id) => live.has(id)));
                bump();
                toast.announce(`Rule “${rule.name}” restored.`);
              } catch (err) {
                toast.push({
                  tone: 'error',
                  message: err instanceof Error ? err.message : 'Could not restore the rule.',
                });
              }
            })();
          },
        },
      });
    });
  };

  const duplicate = (rule: FilingRule): void => {
    void act.run(async () => {
      const copy = await api.createFilingRule({
        name: `${rule.name} (copy)`.slice(0, 80),
        // A copy starts off: it is a draft until the person has changed what makes it different.
        enabled: false,
        match: rule.match,
        action: {
          bankId: rule.action.bankId,
          folderId: rule.action.folderId ?? null,
          addTagIds: rule.action.addTagIds ?? [],
        },
        requireConfirm: rule.requireConfirm,
      });
      const ids = rules.map((r) => r.id);
      ids.splice(ids.indexOf(rule.id) + 1, 0, copy.id);
      await api.reorderFilingRules(ids);
      toast.announce(`A copy of rule “${rule.name}” was made and is turned off.`);
      setEditing(copy);
    });
  };

  const onRowKey = (rule: FilingRule, e: KeyboardEvent): void => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    move(rule, e.key === 'ArrowUp' ? -1 : 1);
  };

  const busyReason = act.busy ? 'Wait for the last change to finish.' : undefined;

  return (
    <section
      className="dash-panel mv-view rules"
      aria-labelledby="rules-title"
      data-testid="rules-view"
    >
      <ViewHead
        icon={Workflow}
        title="Filing rules"
        titleId="rules-title"
        info={
          <>
            A rule suggests where a new highlight goes, or files it for you. The first matching rule
            decides the bank. Rules skip imports, restored data and a bank you picked yourself.
          </>
        }
        {...(rules.length > 0 ? { count: plural(rules.length, 'rule') } : {})}
      >
        {/* While the list is empty its empty state holds this button instead. */}
        {state.data !== undefined && rules.length === 0 ? null : (
          <Action
            variant="primary"
            icon={Plus}
            data-testid="rule-new"
            disabledReason={
              state.error
                ? 'The rules could not be read. Try again first.'
                : state.data === undefined
                  ? 'The rules are still loading.'
                  : undefined
            }
            onClick={() => setEditing('new')}
          >
            New rule
          </Action>
        )}
      </ViewHead>

      <div className="rule-master">
        <span className="rule-master__icon sv-art--primary" aria-hidden="true">
          <Power strokeWidth={2.4} />
        </span>
        <AsyncSwitch
          testId="rules-switch"
          label="Use filing rules"
          checked={rulesOn}
          onChange={(next) => toggleAll.run(next)}
        />
        <InfoTip label="About the rules switch" align="end">
          Off keeps your rules but applies none to new highlights. Private windows follow “Save from
          private windows” in Settings.
        </InfoTip>
      </div>
      {toggleAll.error ? (
        <InlineNotice tone="error" title="Your change was not saved">
          {toggleAll.error}
        </InlineNotice>
      ) : null}
      {!rulesOn && rules.length > 0 ? (
        <InlineNotice tone="warning" title="Filing rules are off">
          Your rules are kept, but none is applied until you turn them back on.
        </InlineNotice>
      ) : null}
      {act.error ? (
        <InlineNotice
          tone="error"
          title="That did not work"
          action={
            <ChunkyButton size="sm" onClick={act.clear}>
              Dismiss
            </ChunkyButton>
          }
        >
          {act.error}
        </InlineNotice>
      ) : null}

      {state.loading ? (
        <Loading>Loading the rules…</Loading>
      ) : state.error ? (
        <InlineNotice
          tone="error"
          title="Could not read the rules"
          action={
            <ChunkyButton size="sm" onClick={state.refresh}>
              Try again
            </ChunkyButton>
          }
        >
          {state.error}
        </InlineNotice>
      ) : rules.length === 0 ? (
        <Empty
          title="No rules yet"
          text="Send pages from one site to one bank."
          action={{
            label: 'New rule',
            icon: Plus,
            onClick: () => setEditing('new'),
            testId: 'rule-new',
          }}
        />
      ) : (
        <>
          <p className="mv-line rule-line">
            Tried from the top.
            <InfoTip label="Reordering rules">
              The first rule that matches decides the bank. Alt+Up and Alt+Down move the rule you
              are on.
            </InfoTip>
          </p>
          <ol className="rule-list" aria-label="Filing rules, in the order they are tried">
            {rules.map((rule, index) => {
              const parts = conditionParts(rule, names);
              const place = describePlace(rule, names);
              const issues = issuesOf.get(rule.id) ?? [];
              const on = asked.get(rule.id) ?? rule.enabled;
              return (
                <li
                  key={rule.id}
                  className="rule-row"
                  data-testid="rule-row"
                  data-rule-id={rule.id}
                  data-enabled={rule.enabled ? 'true' : 'false'}
                  onKeyDown={(e) => onRowKey(rule, e)}
                >
                  <div className="rule-row__head">
                    <span className="rule-row__rank" aria-hidden="true">
                      {index + 1}
                    </span>
                    <strong className="rule-row__name" dir="auto" data-testid="rule-name-text">
                      {rule.name}
                    </strong>
                    <label className="sv-check rule-row__switch">
                      <input
                        type="checkbox"
                        className="sv-switch"
                        data-testid="rule-enabled-switch"
                        aria-label={`On for rule ${rule.name}`}
                        checked={on}
                        aria-disabled={act.busy || undefined}
                        onChange={(e) => {
                          if (!act.busy) void setEnabled(rule, e.target.checked);
                        }}
                      />
                      <span aria-hidden="true">{on ? 'On' : 'Off'}</span>
                    </label>
                  </div>
                  <p className="rule-row__summary" dir="auto">
                    <span className="sv-vh">When </span>
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
                    <ArrowRight className="rule-row__arrow" aria-hidden="true" />
                    <span className="sv-vh">, then file in </span>
                    <Chip icon={Library} tone="primary">
                      {place.where}
                    </Chip>
                    {place.tags.map((t) => (
                      <Chip key={t} icon={Tag} prefix="Add tag">
                        {t}
                      </Chip>
                    ))}
                    <Chip
                      icon={rule.requireConfirm ? MessageCircleQuestion : Zap}
                      tone={rule.requireConfirm ? 'violet' : 'sun'}
                    >
                      {rule.requireConfirm ? 'Asks first' : 'Files at once'}
                    </Chip>
                  </p>
                  {issues.map((issue) => (
                    <InlineNotice key={`${issue.field}:${issue.id}`} tone="warning">
                      {describeIssue(issue)}
                    </InlineNotice>
                  ))}
                  <div
                    className="rule-row__actions"
                    role="group"
                    aria-label={`Actions for rule ${rule.name}`}
                  >
                    <ChunkyButton
                      size="sm"
                      icon={Pencil}
                      data-testid="rule-edit"
                      aria-label={`Edit: ${rule.name}`}
                      onClick={() => setEditing(rule)}
                    >
                      Edit
                    </ChunkyButton>
                    <IconAction
                      icon={ArrowUp}
                      data-testid="rule-up"
                      label={`Move up: ${rule.name}`}
                      disabledReason={index === 0 ? 'This rule is already first.' : busyReason}
                      onClick={() => move(rule, -1)}
                    />
                    <IconAction
                      icon={ArrowDown}
                      data-testid="rule-down"
                      label={`Move down: ${rule.name}`}
                      disabledReason={
                        index === rules.length - 1 ? 'This rule is already last.' : busyReason
                      }
                      onClick={() => move(rule, 1)}
                    />
                    <IconAction
                      icon={Copy}
                      data-testid="rule-duplicate"
                      label={`Duplicate: ${rule.name}`}
                      disabledReason={busyReason}
                      onClick={() => duplicate(rule)}
                    />
                    <IconAction
                      icon={Trash}
                      className="mv-ibtn--danger"
                      data-testid="rule-delete"
                      label={`Delete: ${rule.name}`}
                      disabledReason={busyReason}
                      onClick={() => remove(rule)}
                    />
                  </div>
                </li>
              );
            })}
          </ol>

          <section className="mv-card rule-test-card" aria-labelledby="rule-test-title">
            <h3 id="rule-test-title" className="mv-card__title">
              <button
                type="button"
                className="rule-disclosure"
                aria-expanded={testing}
                aria-controls="rule-test-panel"
                data-testid="rule-tester-toggle"
                onClick={() => setTesting((t) => !t)}
              >
                <FlaskConical aria-hidden="true" strokeWidth={2.4} />
                Test a rule
                <ChevronDown className="rule-disclosure__chev" aria-hidden="true" />
              </button>
              <InfoTip label="About the test">
                Paste what a highlight would look like and see which rules match. A rule never moves
                a highlight when you pick a bank yourself, and only new highlights count.
              </InfoTip>
            </h3>
            <div id="rule-test-panel" hidden={!testing}>
              <RuleTester rules={rules} problems={problems} names={names} rulesOn={rulesOn} />
            </div>
          </section>
        </>
      )}

      {editing !== null ? (
        <RuleDialog
          api={api}
          rule={editing === 'new' ? undefined : editing}
          rules={rules}
          problems={problems}
          names={names}
          rulesOn={rulesOn}
          onCancel={() => setEditing(null)}
          onDone={(saved) => {
            setEditing(null);
            bump();
            toast.announce(`Rule “${saved.name}” saved.`);
          }}
        />
      ) : null}
    </section>
  );
}
