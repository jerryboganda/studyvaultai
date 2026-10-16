import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { getSettings } from '@runtime';
import { FilingRule, StudyVaultError } from '@shared';
import type { FilingRuleInput, FilingRuleProblem } from '@storage';
import { RulesView } from './RulesView';
import { RulesApiProvider, type RulesApi } from './rulesApi';
import { Harness } from './testHarness';
import { FakeVault } from './testing';
import { loadTreeData } from './treeData';

const BANK_CARDIO = 'bank-cardio01';
const BANK_RENAL = 'bank-renal001';
const FOLDER_WEEK1 = 'folder-week01';
const TAG_HY = 'tag-highyield1';

/** In-memory stand-in for the rules repository: same shapes, enough of the semantics. */
class FakeRules implements RulesApi {
  rows: FilingRule[] = [];
  problems: FilingRuleProblem[] = [];
  calls: Array<{ fn: string; args: unknown[] }> = [];
  fail: Partial<Record<string, Error>> = {};
  private seq = 0;
  private clock = Date.UTC(2026, 9, 1);

  private tick(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }
  private note(fn: string, ...args: unknown[]) {
    this.calls.push({ fn, args });
    const err = this.fail[fn];
    if (err) throw err;
  }
  called(fn: string) {
    return this.calls.filter((c) => c.fn === fn);
  }

  seed(input: Partial<FilingRuleInput> & { name: string }, enabled = true): FilingRule {
    this.seq += 1;
    const at = this.tick();
    const row: FilingRule = FilingRule.parse({
      id: `rule-seed-${String(this.seq).padStart(4, '0')}`,
      schemaVersion: 1,
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
      name: input.name,
      enabled,
      order: this.live().length,
      match: input.match ?? { hosts: ['example.com'] },
      action: input.action ?? { bankId: BANK_CARDIO },
      requireConfirm: input.requireConfirm ?? true,
    });
    this.rows.push(row);
    return row;
  }
  live(): FilingRule[] {
    return this.rows.filter((r) => r.deletedAt === null).sort((a, b) => a.order - b.order);
  }
  order(): string[] {
    return this.live().map((r) => r.name);
  }

  async listFilingRules() {
    this.note('listFilingRules');
    return this.live().map((r) => ({ ...r }));
  }
  async checkFilingRules() {
    this.note('checkFilingRules');
    return this.problems.map((p) => ({ ...p }));
  }
  async createFilingRule(input: FilingRuleInput) {
    this.note('createFilingRule', input);
    return this.seed({ ...input, name: input.name }, input.enabled ?? true);
  }
  async updateFilingRule(
    id: string,
    patch: Partial<FilingRuleInput>,
    options: { expectedVersion?: string } = {},
  ) {
    this.note('updateFilingRule', id, patch, options);
    const i = this.rows.findIndex((r) => r.id === id);
    if (i < 0) throw new StudyVaultError('not_found', 'Rule not found');
    const current = this.rows[i]!;
    if (options.expectedVersion && options.expectedVersion !== current.updatedAt) {
      return { status: 'stale' as const, row: current };
    }
    const next = FilingRule.parse({
      ...current,
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
      ...(patch.match === undefined ? {} : { match: patch.match }),
      ...(patch.action === undefined ? {} : { action: patch.action }),
      ...(patch.requireConfirm === undefined ? {} : { requireConfirm: patch.requireConfirm }),
      updatedAt: this.tick(),
    });
    this.rows[i] = next;
    return { status: 'saved' as const, row: next };
  }
  async reorderFilingRules(ids: readonly string[]) {
    this.note('reorderFilingRules', [...ids]);
    const live = this.live();
    const seq = [
      ...ids.map((id) => live.find((r) => r.id === id)!),
      ...live.filter((r) => !ids.includes(r.id)),
    ];
    seq.forEach((r, order) => {
      const at = this.rows.findIndex((x) => x.id === r.id);
      this.rows[at] = { ...r, order };
    });
    return this.live();
  }
  async deleteFilingRule(id: string) {
    this.note('deleteFilingRule', id);
    const i = this.rows.findIndex((r) => r.id === id);
    this.rows[i] = { ...this.rows[i]!, deletedAt: this.tick() };
  }
  async restoreFilingRule(id: string) {
    this.note('restoreFilingRule', id);
    const i = this.rows.findIndex((r) => r.id === id);
    this.rows[i] = { ...this.rows[i]!, deletedAt: null, order: this.live().length };
    return this.rows[i]!;
  }
}

function vault(): FakeVault {
  const v = new FakeVault();
  v.addBank(BANK_CARDIO, 'Cardiology');
  v.addBank(BANK_RENAL, 'Renal');
  v.folders.push({ id: FOLDER_WEEK1, bankId: BANK_CARDIO, parentId: null, name: 'Week 1' });
  v.tags.push({ id: TAG_HY, name: 'High yield' });
  return v;
}

async function mount(rules: FakeRules, v: FakeVault = vault()) {
  const api = v.api();
  const tree = await loadTreeData(api);
  render(
    <Harness api={api} tree={tree}>
      <RulesApiProvider value={rules}>
        <RulesView />
      </RulesApiProvider>
    </Harness>,
  );
  return { api, vault: v };
}

const rows = () => screen.getAllByTestId('rule-row');
const rowNamed = (name: string) =>
  rows().find((r) => within(r).getByTestId('rule-name-text').textContent === name)!;
const dialog = () => screen.getByRole('dialog', { hidden: true });
const inDialog = () => within(dialog());
/** The wizard's Next button, and the way to its last step (Back keeps every answer). */
const next = () => fireEvent.click(inDialog().getByRole('button', { name: 'Next' }));
const toLastStep = () => {
  for (let i = 0; i < 8 && inDialog().queryByRole('button', { name: 'Next' }); i += 1) next();
};
const stepTitle = () => dialog().querySelector('h2')?.textContent;
/** With no rule yet, the empty state holds "New rule" once the list has been read. */
const openNewRule = async () => {
  await screen.findByText('No rules yet');
  fireEvent.click(screen.getByTestId('rule-new'));
};

beforeEach(() => fakeBrowser.reset());
afterEach(cleanup);

describe('the list', () => {
  it('shows the rules in the order they are tried, each in words', async () => {
    const rules = new FakeRules();
    rules.seed({
      name: 'Cardiology course',
      match: { hosts: ['example.com'], titleContains: ['heart'] },
      action: { bankId: BANK_CARDIO, folderId: FOLDER_WEEK1, addTagIds: [TAG_HY] },
    });
    rules.seed({
      name: 'Kidney notes',
      match: { kinds: ['essential'] },
      action: { bankId: BANK_RENAL },
      requireConfirm: false,
    });
    await mount(rules);

    await screen.findAllByTestId('rule-row');
    const [first, second] = rows();
    expect(first!.textContent).toContain('Cardiology course');
    expect(first!.textContent).toContain('example.com');
    expect(first!.textContent).toContain('“heart”');
    expect(first!.textContent).toContain('Cardiology / Week 1');
    expect(first!.textContent).toContain('High yield');
    expect(first!.textContent).toContain('Asks first');
    expect(second!.textContent).toContain('Kidney notes');
    expect(second!.textContent).toContain('Files at once');
    expect(screen.getByRole('list', { name: /in the order they are tried/ })).toBeTruthy();
  });

  it('explains an empty list and offers to create the first rule', async () => {
    await mount(new FakeRules());
    expect(await screen.findByText('No rules yet')).toBeTruthy();
    fireEvent.click(screen.getByTestId('rule-new'));
    expect(dialog()).toBeTruthy();
    expect(stepTitle()).toBe('When');
  });

  it('says what is wrong with a rule whose target was deleted', async () => {
    const rules = new FakeRules();
    const rule = rules.seed({ name: 'Orphan', action: { bankId: 'bank-deleted01' } });
    rules.problems = [
      { ruleId: rule.id, field: 'action.bankId', id: 'bank-deleted01', problem: 'deleted' },
    ];
    await mount(rules);
    const row = (await screen.findAllByTestId('rule-row'))[0]!;
    expect(row.textContent).toContain('a deleted bank');
    expect(row.textContent).toContain('Its bank was deleted, so this rule is skipped');
  });
});

describe('ordering', () => {
  async function three() {
    const rules = new FakeRules();
    rules.seed({ name: 'A' });
    rules.seed({ name: 'B' });
    rules.seed({ name: 'C' });
    await mount(rules);
    await screen.findAllByTestId('rule-row');
    return rules;
  }

  it('moves a rule with the buttons, and the first and last cannot move past the ends', async () => {
    const rules = await three();
    const up = within(rowNamed('A')).getByTestId('rule-up');
    expect(up.getAttribute('aria-disabled')).toBe('true');
    expect(up.getAttribute('aria-label')).toContain('This rule is already first.');
    const last = within(rowNamed('C')).getByTestId('rule-down');
    expect(last.getAttribute('aria-disabled')).toBe('true');

    fireEvent.click(within(rowNamed('A')).getByTestId('rule-down'));
    await waitFor(() => expect(rules.order()).toEqual(['B', 'A', 'C']));
    await waitFor(() =>
      expect(rows().map((r) => within(r).getByTestId('rule-name-text').textContent)).toEqual([
        'B',
        'A',
        'C',
      ]),
    );
    fireEvent.click(within(rowNamed('C')).getByTestId('rule-up'));
    await waitFor(() => expect(rules.order()).toEqual(['B', 'C', 'A']));
  });

  it('Alt+Arrow moves the rule the focus is on', async () => {
    const rules = await three();
    const edit = within(rowNamed('B')).getByTestId('rule-edit');
    edit.focus();
    fireEvent.keyDown(edit, { key: 'ArrowUp', altKey: true });
    await waitFor(() => expect(rules.order()).toEqual(['B', 'A', 'C']));
    // Plain arrows do nothing here.
    fireEvent.keyDown(edit, { key: 'ArrowDown' });
    expect(rules.called('reorderFilingRules')).toHaveLength(1);
    // The keyboard stays on the control it was on, after the row moved.
    await waitFor(() => expect(rows()[0]!.getAttribute('data-rule-id')).toBe(rules.live()[0]!.id));
    await waitFor(() =>
      expect(document.activeElement).toBe(within(rowNamed('B')).getByTestId('rule-edit')),
    );
  });
});

describe('turning a rule on and off', () => {
  it('writes the switch with the version it read', async () => {
    const rules = new FakeRules();
    const rule = rules.seed({ name: 'A' });
    await mount(rules);
    await screen.findAllByTestId('rule-row');
    const box = within(rowNamed('A')).getByRole('checkbox', { name: /On for rule A/ });
    expect((box as HTMLInputElement).checked).toBe(true);
    fireEvent.click(box);
    await waitFor(() => expect(rules.called('updateFilingRule')).toHaveLength(1));
    expect(rules.called('updateFilingRule')[0]!.args).toEqual([
      rule.id,
      { enabled: false },
      { expectedVersion: rule.updatedAt },
    ]);
    await waitFor(() => expect(rowNamed('A').getAttribute('data-enabled')).toBe('false'));
    expect(rowNamed('A').textContent).toContain('Off');
  });

  it('tells the person when the rule changed elsewhere instead of overwriting it', async () => {
    const rules = new FakeRules();
    const rule = rules.seed({ name: 'A' });
    await mount(rules);
    await screen.findAllByTestId('rule-row');
    // Another window edits it first.
    await rules.updateFilingRule(rule.id, { name: 'A renamed' });
    fireEvent.click(within(rowNamed('A')).getByRole('checkbox', { name: /On for rule A/ }));
    expect(await screen.findByText(/was changed in another window/)).toBeTruthy();
    expect(rules.live()[0]!.enabled).toBe(true);
  });
});

describe('creating a rule', () => {
  it('walks the wizard: validates each step and chip, and creates a rule that asks first', async () => {
    const rules = new FakeRules();
    await mount(rules);
    await openNewRule();

    // When: nothing picked yet, so Next stays on the step and says why.
    next();
    expect(stepTitle()).toBe('When');
    expect(inDialog().getByRole('alert').textContent).toMatch(/Pick at least one/);
    fireEvent.click(inDialog().getByRole('checkbox', { name: /^Site/ }));
    next();
    expect(stepTitle()).toBe('What matches');

    // A picked field needs a value before Next.
    next();
    expect(stepTitle()).toBe('What matches');

    // A bad site name is refused with the reason, and nothing is added.
    const hosts = within(inDialog().getByTestId('rule-hosts'));
    fireEvent.change(hosts.getByRole('textbox'), { target: { value: 'bad_host!' } });
    fireEvent.click(hosts.getByRole('button', { name: 'Add site' }));
    expect(hosts.getByRole('alert').textContent).toMatch(/"bad_host!" is not a site name/);

    // A good one is normalised; Enter adds it.
    fireEvent.change(hosts.getByRole('textbox'), {
      target: { value: 'HTTPS://www.Example.com/a' },
    });
    fireEvent.keyDown(hosts.getByRole('textbox'), { key: 'Enter' });
    expect(hosts.getByText('www.example.com')).toBeTruthy();
    expect(hosts.queryByRole('alert')).toBeNull();

    // The same site again is refused.
    fireEvent.change(hosts.getByRole('textbox'), { target: { value: 'www.example.com' } });
    fireEvent.click(hosts.getByRole('button', { name: 'Add site' }));
    expect(hosts.getByRole('alert').textContent).toMatch(/already in the list/);
    next();

    // File into: the bank as a picture card, then a folder and a tag to add.
    expect(stepTitle()).toBe('File into');
    fireEvent.click(inDialog().getByRole('radio', { name: /Cardiology/ }));
    fireEvent.change(inDialog().getByTestId('rule-folder'), { target: { value: FOLDER_WEEK1 } });
    const addTags = within(inDialog().getByTestId('rule-add-tags'));
    fireEvent.change(addTags.getByRole('combobox'), { target: { value: TAG_HY } });
    fireEvent.click(addTags.getByRole('button', { name: 'Add tag' }));
    next();

    // "Ask first" is chosen unless the person picks "File at once".
    expect(stepTitle()).toBe('Ask first?');
    expect((inDialog().getByRole('radio', { name: /Ask first/ }) as HTMLInputElement).checked).toBe(
      true,
    );
    next();

    // Try it: the real decision, with this rule in the list, from a sample made of the rule.
    expect(stepTitle()).toBe('Try it');
    expect((inDialog().getByTestId('wiz-test-url') as HTMLInputElement).value).toBe(
      'https://www.example.com/',
    );
    expect(inDialog().getByTestId('wiz-test-row').textContent).toContain('This rule');
    fireEvent.change(inDialog().getByTestId('wiz-test-url'), {
      target: { value: 'https://www.example.com/cardio' },
    });
    expect(inDialog().getByTestId('wiz-test-verdict').textContent).toContain(
      'Ask first, then file in Cardiology / Week 1',
    );
    expect(inDialog().getByTestId('wiz-test-row').textContent).toContain('This rule');
    next();

    // Looks good?: the rule in one card, then its name.
    expect(stepTitle()).toBe('Looks good?');
    const summary = inDialog().getByTestId('rule-summary').textContent;
    expect(summary).toContain('www.example.com');
    expect(summary).toContain('Cardiology / Week 1');
    expect(summary).toContain('Asks first');
    expect(rules.called('createFilingRule')).toHaveLength(0);
    fireEvent.change(inDialog().getByTestId('rule-name'), { target: { value: 'Course site' } });
    fireEvent.click(inDialog().getByRole('button', { name: 'Create rule' }));
    await waitFor(() => expect(rules.called('createFilingRule')).toHaveLength(1));
    expect(rules.called('createFilingRule')[0]!.args[0]).toMatchObject({
      name: 'Course site',
      enabled: true,
      requireConfirm: true,
      match: { hosts: ['www.example.com'] },
      action: { bankId: BANK_CARDIO, folderId: FOLDER_WEEK1, addTagIds: [TAG_HY] },
    });
    await waitFor(() => expect(screen.queryByRole('dialog', { hidden: true })).toBeNull());
    expect((await screen.findAllByTestId('rule-row'))[0]!.textContent).toContain('Course site');
  });

  it('offers a name when the field is left empty, and drops fields that were unticked', async () => {
    const rules = new FakeRules();
    await mount(rules);
    await openNewRule();
    fireEvent.click(inDialog().getByRole('checkbox', { name: /^Site/ }));
    fireEvent.click(inDialog().getByRole('checkbox', { name: /^Page title/ }));
    next();
    const title = within(inDialog().getByTestId('rule-title'));
    fireEvent.change(title.getByRole('textbox'), { target: { value: 'heart' } });
    fireEvent.keyDown(title.getByRole('textbox'), { key: 'Enter' });
    const hosts = within(inDialog().getByTestId('rule-hosts'));
    fireEvent.change(hosts.getByRole('textbox'), { target: { value: 'example.com' } });
    fireEvent.keyDown(hosts.getByRole('textbox'), { key: 'Enter' });
    // Back to When: untick the title; its word is kept in the form but not saved.
    fireEvent.click(inDialog().getByRole('button', { name: 'Back' }));
    fireEvent.click(inDialog().getByRole('checkbox', { name: /^Page title/ }));
    toLastStep();
    expect(inDialog().getByText(/Empty uses “example.com to Inbox”/)).toBeTruthy();
    fireEvent.click(inDialog().getByRole('button', { name: 'Create rule' }));
    await waitFor(() => expect(rules.called('createFilingRule')).toHaveLength(1));
    expect(rules.called('createFilingRule')[0]!.args[0]).toMatchObject({
      name: 'example.com to Inbox',
      match: { hosts: ['example.com'], titleContains: [] },
    });
  });

  it('warns that a tags-only rule cannot match a new highlight, and about filing at once', async () => {
    await mount(new FakeRules());
    await openNewRule();
    fireEvent.click(inDialog().getByRole('checkbox', { name: /^Tags/ }));
    next();
    const tags = within(inDialog().getByTestId('rule-tags'));
    fireEvent.change(tags.getByRole('combobox'), { target: { value: TAG_HY } });
    fireEvent.click(tags.getByRole('button', { name: 'Add tag' }));
    expect(inDialog().getByText(/will not match it when it is saved/)).toBeTruthy();

    next();
    next();
    fireEvent.click(inDialog().getByRole('radio', { name: /File at once/ }));
    toLastStep();
    expect(inDialog().getByText(/files a highlight at once/)).toBeTruthy();
  });

  it('removing a chip puts the focus back in its field', async () => {
    await mount(new FakeRules());
    await openNewRule();
    fireEvent.click(inDialog().getByRole('checkbox', { name: /^Page title/ }));
    next();
    const title = within(inDialog().getByTestId('rule-title'));
    const input = title.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'heart failure' } });
    fireEvent.click(title.getByRole('button', { name: 'Add word' }));
    fireEvent.click(title.getByRole('button', { name: 'Remove heart failure' }));
    expect(title.queryByText('heart failure')).toBeNull();
    expect(document.activeElement).toBe(input);
  });

  it('shows the failure and stays open when the rule cannot be saved', async () => {
    const rules = new FakeRules();
    rules.fail.createFilingRule = new StudyVaultError('not_found', 'Bank not found');
    await mount(rules);
    await openNewRule();
    fireEvent.click(inDialog().getByRole('checkbox', { name: /^Site/ }));
    next();
    const hosts = within(inDialog().getByTestId('rule-hosts'));
    fireEvent.change(hosts.getByRole('textbox'), { target: { value: 'example.com' } });
    fireEvent.click(hosts.getByRole('button', { name: 'Add site' }));
    toLastStep();
    fireEvent.change(inDialog().getByTestId('rule-name'), { target: { value: 'X' } });
    fireEvent.click(inDialog().getByRole('button', { name: 'Create rule' }));
    expect(await inDialog().findByText('Bank not found')).toBeTruthy();
    expect(dialog()).toBeTruthy();
  });
});

describe('editing, duplicating and deleting', () => {
  it('edits a rule with the version it was opened at', async () => {
    const rules = new FakeRules();
    const rule = rules.seed({ name: 'Old name' });
    await mount(rules);
    await screen.findAllByTestId('rule-row');
    fireEvent.click(within(rowNamed('Old name')).getByTestId('rule-edit'));
    // Editing opens on the review, with a way back to each part.
    expect(stepTitle()).toBe('Looks good?');
    fireEvent.click(inDialog().getByRole('button', { name: 'Change what it matches' }));
    expect(stepTitle()).toBe('When');
    // The rule's own fields start picked.
    expect((inDialog().getByRole('checkbox', { name: /^Site/ }) as HTMLInputElement).checked).toBe(
      true,
    );
    // "Review" walks back over the steps in between and lands on the review again.
    expect(inDialog().queryByRole('button', { name: 'Next' })).toBeNull();
    fireEvent.click(inDialog().getByRole('button', { name: 'Review' }));
    expect(stepTitle()).toBe('Looks good?');
    const name = inDialog().getByTestId('rule-name') as HTMLInputElement;
    expect(name.value).toBe('Old name');
    fireEvent.change(name, { target: { value: 'New name' } });
    fireEvent.click(inDialog().getByRole('button', { name: 'Save rule' }));
    await waitFor(() => expect(rules.called('updateFilingRule')).toHaveLength(1));
    expect(rules.called('updateFilingRule')[0]!.args[2]).toEqual({
      expectedVersion: rule.updatedAt,
    });
    await waitFor(() => expect(rowNamed('New name')).toBeTruthy());
  });

  it('after a jump back, Review stops on the first step that needs a fix', async () => {
    const rules = new FakeRules();
    rules.seed({ name: 'A' });
    await mount(rules);
    await screen.findAllByTestId('rule-row');
    fireEvent.click(within(rowNamed('A')).getByTestId('rule-edit'));
    fireEvent.click(inDialog().getByRole('button', { name: 'Change what it matches' }));
    // A new field without a value: Review cannot pass "What matches".
    fireEvent.click(inDialog().getByRole('checkbox', { name: /^Page title/ }));
    fireEvent.click(inDialog().getByRole('button', { name: 'Review' }));
    expect(stepTitle()).toBe('What matches');
    expect(inDialog().getByRole('alert').textContent).toMatch(/Add a word/);
    const title = within(inDialog().getByTestId('rule-title'));
    fireEvent.change(title.getByRole('textbox'), { target: { value: 'heart' } });
    fireEvent.keyDown(title.getByRole('textbox'), { key: 'Enter' });
    fireEvent.click(inDialog().getByRole('button', { name: 'Review' }));
    expect(stepTitle()).toBe('Looks good?');
    expect(inDialog().getByTestId('rule-summary').textContent).toContain('“heart”');
    fireEvent.click(inDialog().getByRole('button', { name: 'Save rule' }));
    await waitFor(() => expect(rules.called('updateFilingRule')).toHaveLength(1));
    expect(rules.called('updateFilingRule')[0]!.args[1]).toMatchObject({
      match: { hosts: ['example.com'], titleContains: ['heart'] },
    });
  });

  it('a rule whose bank was deleted cannot be saved from the review: it shows where to fix it', async () => {
    const rules = new FakeRules();
    const rule = rules.seed({ name: 'Orphan', action: { bankId: 'bank-deleted01' } });
    rules.problems = [
      { ruleId: rule.id, field: 'action.bankId', id: 'bank-deleted01', problem: 'deleted' },
    ];
    await mount(rules);
    await screen.findAllByTestId('rule-row');
    fireEvent.click(within(rowNamed('Orphan')).getByTestId('rule-edit'));
    expect(inDialog().getByTestId('rule-summary').textContent).toContain('a deleted bank');
    fireEvent.click(inDialog().getByRole('button', { name: 'Save rule' }));
    expect(stepTitle()).toBe('File into');
    expect(inDialog().getByRole('alert').textContent).toMatch(/Choose the bank/);
    expect(rules.called('updateFilingRule')).toHaveLength(0);
    fireEvent.click(inDialog().getByRole('radio', { name: /Renal/ }));
    fireEvent.click(inDialog().getByRole('button', { name: 'Review' }));
    expect(stepTitle()).toBe('Looks good?');
    fireEvent.click(inDialog().getByRole('button', { name: 'Save rule' }));
    await waitFor(() => expect(rules.called('updateFilingRule')).toHaveLength(1));
    expect(rules.called('updateFilingRule')[0]!.args[1]).toMatchObject({
      action: { bankId: BANK_RENAL },
    });
  });

  it('refuses to overwrite a rule that was changed while the dialog was open', async () => {
    const rules = new FakeRules();
    const rule = rules.seed({ name: 'A' });
    await mount(rules);
    await screen.findAllByTestId('rule-row');
    fireEvent.click(within(rowNamed('A')).getByTestId('rule-edit'));
    await rules.updateFilingRule(rule.id, { name: 'Changed elsewhere' });
    toLastStep();
    fireEvent.change(inDialog().getByTestId('rule-name'), { target: { value: 'Mine' } });
    fireEvent.click(inDialog().getByRole('button', { name: 'Save rule' }));
    expect(await inDialog().findByText(/changed in another window/)).toBeTruthy();
    expect(rules.live()[0]!.name).toBe('Changed elsewhere');
  });

  it('duplicates into a copy that is off, right after the original, and opens it', async () => {
    const rules = new FakeRules();
    rules.seed({ name: 'A', match: { hosts: ['a.org'] }, requireConfirm: false });
    rules.seed({ name: 'B' });
    await mount(rules);
    await screen.findAllByTestId('rule-row');
    fireEvent.click(within(rowNamed('A')).getByTestId('rule-duplicate'));
    await waitFor(() => expect(rules.order()).toEqual(['A', 'A (copy)', 'B']));
    const copy = rules.live()[1]!;
    expect(copy).toMatchObject({
      enabled: false,
      requireConfirm: false,
      match: { hosts: ['a.org'] },
    });
    await waitFor(() => expect(dialog()).toBeTruthy());
    toLastStep();
    expect(inDialog().getByTestId('rule-name') as HTMLInputElement).toHaveProperty(
      'value',
      'A (copy)',
    );
  });

  it('deletes without a prompt and Undo puts the rule back where it was', async () => {
    const rules = new FakeRules();
    rules.seed({ name: 'A' });
    rules.seed({ name: 'B' });
    rules.seed({ name: 'C' });
    await mount(rules);
    await screen.findAllByTestId('rule-row');

    fireEvent.click(within(rowNamed('B')).getByTestId('rule-delete'));
    await waitFor(() => expect(rules.order()).toEqual(['A', 'C']));
    expect(screen.queryByRole('dialog', { hidden: true })).toBeNull();
    const undo = await screen.findByRole('button', { name: 'Undo' });
    fireEvent.click(undo);
    await waitFor(() => expect(rules.order()).toEqual(['A', 'B', 'C']));
  });
});

describe('the master switch', () => {
  it('is on by default and writes Settings.useFilingRules', async () => {
    const rules = new FakeRules();
    rules.seed({ name: 'A' });
    await mount(rules);
    await screen.findAllByTestId('rule-row');
    const box = (await screen.findByTestId('rules-switch')) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    await waitFor(async () => expect((await getSettings()).useFilingRules).toBe(false));
    expect(await screen.findByText('Filing rules are off')).toBeTruthy();
  });
});

describe('Test a rule', () => {
  async function tester(setup: (rules: FakeRules) => void) {
    const rules = new FakeRules();
    setup(rules);
    await mount(rules);
    // The test panel is folded away until asked for.
    fireEvent.click(await screen.findByTestId('rule-tester-toggle'));
    expect(screen.getByTestId('rule-tester-toggle').getAttribute('aria-expanded')).toBe('true');
    const t = within(screen.getByTestId('rule-tester'));
    const type = (id: string, value: string) =>
      fireEvent.change(screen.getByTestId(id), { target: { value } });
    return { rules, t, type };
  }

  it('shows the matching rules in order and the resulting plan', async () => {
    const { t, type } = await tester((rules) => {
      rules.seed({
        name: 'Course site',
        match: { hosts: ['example.com'] },
        action: { bankId: BANK_CARDIO, folderId: FOLDER_WEEK1, addTagIds: [TAG_HY] },
      });
      rules.seed({
        name: 'Heart words',
        match: { titleContains: ['heart'] },
        action: { bankId: BANK_RENAL },
        requireConfirm: false,
      });
      rules.seed({ name: 'Other site', match: { hosts: ['other.org'] } });
    });
    expect(t.getByTestId('test-result').textContent).toMatch(/Type an address/);

    type('test-url', 'https://www.example.com/cardio/week-1');
    type('test-title', 'Heart failure basics');
    const verdict = t.getByTestId('test-verdict').textContent!;
    expect(verdict).toContain('Ask first, then file in Cardiology / Week 1');
    expect(verdict).toContain('add the tag High yield');
    expect(verdict).toContain('Decided by rule “Course site”');
    const matching = t.getAllByTestId('test-row');
    expect(matching.map((r) => r.querySelector('strong')!.textContent)).toEqual([
      'Course site',
      'Heart words',
    ]);
    expect(matching[0]!.getAttribute('data-status')).toBe('decides');
    expect(matching[1]!.getAttribute('data-status')).toBe('adds');
  });

  it('says so when nothing matches', async () => {
    const { t, type } = await tester((rules) => rules.seed({ name: 'A' }));
    type('test-url', 'https://nowhere.example/page');
    expect(t.getByTestId('test-verdict').textContent).toContain('No rule matches');
  });

  it('flags a bad address and treats it as none', async () => {
    const { t, type } = await tester((rules) => rules.seed({ name: 'A' }));
    type('test-url', 'example.com/no-scheme');
    expect(t.getByRole('alert').textContent).toMatch(/starts with http/);
  });

  it('lists a rule that is turned off as matching but unused', async () => {
    const { t, type } = await tester((rules) => rules.seed({ name: 'Quiet' }, false));
    type('test-url', 'https://example.com/a');
    const row = t.getByTestId('test-row');
    expect(row.getAttribute('data-status')).toBe('off');
    expect(t.getByTestId('test-verdict').textContent).toContain('No rule matches');
  });

  it('a PDF is only offered to a rule that lists PDF as a source', async () => {
    const { t, type } = await tester((rules) => {
      rules.seed({ name: 'Any source', match: { kinds: ['essential'] } });
    });
    type('test-source', 'pdf');
    type('test-quote', 'some text');
    expect(t.getByTestId('test-verdict').textContent).toContain('No rule matches');
    expect(t.getByTestId('test-row').getAttribute('data-status')).toBe('not-offered');
  });

  it('reports a winning rule that cannot be applied instead of falling through', async () => {
    const { t, type } = await tester((rules) => {
      const broken = rules.seed({ name: 'Broken', action: { bankId: 'bank-deleted01' } });
      rules.seed({ name: 'Lower', action: { bankId: BANK_RENAL } });
      rules.problems = [
        { ruleId: broken.id, field: 'action.bankId', id: 'bank-deleted01', problem: 'deleted' },
      ];
    });
    type('test-url', 'https://example.com/a');
    expect(t.getByTestId('test-verdict').textContent).toMatch(
      /Rule “Broken” matches first but cannot be applied/,
    );
    expect(t.getAllByTestId('test-row')[0]!.getAttribute('data-status')).toBe('blocked');
  });

  it('reminds that nothing is applied while the master switch is off', async () => {
    const { t, type } = await tester((rules) => rules.seed({ name: 'A' }));
    fireEvent.click(await screen.findByTestId('rules-switch'));
    type('test-url', 'https://example.com/a');
    await waitFor(() => expect(t.getByText(/“Use filing rules” is off/)).toBeTruthy());
  });
});

describe('a failing list', () => {
  it('says so with a retry', async () => {
    const rules = new FakeRules();
    rules.fail.listFilingRules = new Error('storage is unavailable');
    await mount(rules);
    expect(await screen.findByText('Could not read the rules')).toBeTruthy();
    // The failure is not a dead end: reading again works once the store is back.
    delete rules.fail.listFilingRules;
    rules.seed({ name: 'A' });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect((await screen.findAllByTestId('rule-row'))[0]!.textContent).toContain('A');
  });
});
