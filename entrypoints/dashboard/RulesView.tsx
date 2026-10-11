import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import type { FilingRule } from '@shared';
import type { FilingRuleProblem } from '@storage';
import {
  AsyncSwitch,
  Badge,
  Button,
  EmptyState,
  InlineNotice,
  plural,
  useAction,
  useSettings,
  useToast,
} from '@ui';
import { useBump, useVaultQuery } from './hooks';
import { RuleDialog } from './RuleDialog';
import { RuleTester } from './RuleTester';
import { describeConditions, describeIssue, describePlace, type Names } from './rulesModel';
import { useRulesApi } from './rulesApi';
import { flattenFolders, useTreeData } from './treeData';

const EMPTY_ASKED: ReadonlyMap<string, boolean> = new Map();

/**
 * The filing-rules manager (docs/adr/017-filing-rules.md): the rules in the order they are tried, a
 * switch for the whole feature, a create/edit dialog, and a panel that tests what a rule would do.
 * Rules never act on imports, restores or sync; at capture the worker decides with the same pure
 * function the test panel uses.
 */
export function RulesView() {
  const api = useRulesApi();
  const tree = useTreeData();
  const toast = useToast();
  const bump = useBump();
  const { settings, update } = useSettings();
  const [editing, setEditing] = useState<FilingRule | 'new' | null>(null);

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

  return (
    <section className="dash-panel" aria-labelledby="rules-title" data-testid="rules-view">
      <h2 id="rules-title">Filing rules</h2>
      <p className="sv-small sv-muted">
        A rule suggests where a new highlight goes, or files it for you, when its page, title, text,
        tags, kind or source match. The first matching rule in the list decides the bank and folder.
        Rules look only at highlights you have just saved: never at imports or restored data, and
        never at a bank you picked yourself in the toolbar.
      </p>

      <div className="sv-row rule-top">
        <div className="sv-grow">
          <AsyncSwitch
            testId="rules-switch"
            label="Use filing rules"
            hint={
              rules.length === 0
                ? 'On by default. With no rule there is nothing to apply. Turn it off to keep rules without applying them.'
                : 'Turn this off to keep your rules without applying any of them to new highlights. Private windows follow “Save from private windows” in Settings.'
            }
            checked={rulesOn}
            onChange={(next) => toggleAll.run(next)}
          />
        </div>
        <Button
          variant="primary"
          data-testid="rule-new"
          disabledReason={state.data === undefined ? 'The rules are still loading.' : undefined}
          onClick={() => setEditing('new')}
        >
          New rule
        </Button>
      </div>
      {toggleAll.error ? (
        <InlineNotice tone="error" title="Your change was not saved">
          {toggleAll.error}
        </InlineNotice>
      ) : null}
      {!rulesOn && rules.length > 0 ? (
        <InlineNotice tone="warning" title="Filing rules are off">
          Your rules are kept, but none is applied to a new highlight until you turn “Use filing
          rules” back on.
        </InlineNotice>
      ) : null}
      {act.error ? (
        <InlineNotice
          tone="error"
          title="That did not work"
          action={<Button onClick={act.clear}>Dismiss</Button>}
        >
          {act.error}
        </InlineNotice>
      ) : null}

      {state.loading ? (
        <p className="sv-muted dash-loading" role="status">
          Loading the rules…
        </p>
      ) : state.error ? (
        <InlineNotice
          tone="error"
          title="Could not read the rules"
          action={<Button onClick={state.refresh}>Try again</Button>}
        >
          {state.error}
        </InlineNotice>
      ) : rules.length === 0 ? (
        <EmptyState
          title="No filing rules yet"
          action={
            <Button variant="primary" onClick={() => setEditing('new')}>
              Create the first rule
            </Button>
          }
        >
          For example: everything saved from your course site goes to one bank, tagged for the
          course.
        </EmptyState>
      ) : (
        <>
          <p className="sv-small sv-muted">
            {plural(rules.length, 'rule')}, tried from the top. Alt+Up and Alt+Down move the rule
            you are on.
          </p>
          <ol className="rule-list" aria-label="Filing rules, in the order they are tried">
            {rules.map((rule, index) => {
              const conditions = describeConditions(rule, names);
              const place = describePlace(rule, names);
              const issues = issuesOf.get(rule.id) ?? [];
              return (
                <li
                  key={rule.id}
                  className="rule-row"
                  data-testid="rule-row"
                  data-rule-id={rule.id}
                  data-enabled={rule.enabled ? 'true' : 'false'}
                  onKeyDown={(e) => onRowKey(rule, e)}
                >
                  <div className="sv-row rule-row__head">
                    <span className="rule-row__rank" aria-hidden="true">
                      {index + 1}
                    </span>
                    <strong className="sv-wrap" dir="auto" data-testid="rule-name-text">
                      {rule.name}
                    </strong>
                    <Badge tone={rule.requireConfirm ? 'info' : 'warning'}>
                      {rule.requireConfirm ? 'Asks first' : 'Files at once'}
                    </Badge>
                    {rule.enabled ? null : <Badge>Off</Badge>}
                  </div>
                  <p className="sv-small sv-wrap" dir="auto">
                    <span className="sv-muted">When </span>
                    {conditions.length > 0 ? conditions.join(' and ') : 'it has no condition'}
                  </p>
                  <p className="sv-small sv-wrap" dir="auto">
                    <span className="sv-muted">Then file in </span>
                    {place.where}
                    {place.tags.length > 0 ? (
                      <>
                        <span className="sv-muted">, and add </span>
                        {place.tags.join(', ')}
                      </>
                    ) : null}
                  </p>
                  {issues.map((issue) => (
                    <InlineNotice key={`${issue.field}:${issue.id}`} tone="warning">
                      {describeIssue(issue)}
                    </InlineNotice>
                  ))}
                  <div className="sv-row" role="group" aria-label={`Actions for rule ${rule.name}`}>
                    <label className="sv-check rule-row__switch">
                      <input
                        type="checkbox"
                        data-testid="rule-enabled-switch"
                        aria-label={`On for rule ${rule.name}`}
                        checked={asked.get(rule.id) ?? rule.enabled}
                        aria-disabled={act.busy || undefined}
                        onChange={(e) => {
                          if (!act.busy) void setEnabled(rule, e.target.checked);
                        }}
                      />
                      <span>On</span>
                    </label>
                    <Button
                      data-testid="rule-up"
                      aria-label={`Move up: ${rule.name}`}
                      disabledReason={index === 0 ? 'This rule is already first.' : undefined}
                      onClick={() => move(rule, -1)}
                    >
                      Move up
                    </Button>
                    <Button
                      data-testid="rule-down"
                      aria-label={`Move down: ${rule.name}`}
                      disabledReason={
                        index === rules.length - 1 ? 'This rule is already last.' : undefined
                      }
                      onClick={() => move(rule, 1)}
                    >
                      Move down
                    </Button>
                    <Button
                      data-testid="rule-edit"
                      aria-label={`Edit: ${rule.name}`}
                      onClick={() => setEditing(rule)}
                    >
                      Edit
                    </Button>
                    <Button
                      data-testid="rule-duplicate"
                      aria-label={`Duplicate: ${rule.name}`}
                      busy={act.busy}
                      onClick={() => duplicate(rule)}
                    >
                      Duplicate
                    </Button>
                    <Button
                      variant="danger"
                      data-testid="rule-delete"
                      aria-label={`Delete: ${rule.name}`}
                      busy={act.busy}
                      onClick={() => remove(rule)}
                    >
                      Delete
                    </Button>
                  </div>
                </li>
              );
            })}
          </ol>
        </>
      )}

      <RuleTester rules={rules} problems={problems} names={names} rulesOn={rulesOn} />

      {editing !== null ? (
        <RuleDialog
          api={api}
          rule={editing === 'new' ? undefined : editing}
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
