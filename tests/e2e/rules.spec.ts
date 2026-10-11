import { createBankRpc, dialogOf, expectAxeClean, treeItem } from './helpers.dashboard';
import { stopWorker } from './helpers.lifecycle';
import { deleteAllData } from './helpers.backup';
import {
  expect,
  highlightsOf,
  openExt,
  openFixture,
  saveBlockToBank,
  storedSettings,
  test,
  tripleClickBlock,
  viewing,
} from './helpers.pages';
import {
  INBOX_BANK_ID,
  createRule,
  openRules,
  overlayToast,
  ruleOrder,
  ruleRow,
  ruleRows,
  storedRules,
} from './helpers.rules';

/**
 * Auto-filing rules in a real loaded extension (docs/adr/017-filing-rules.md): the manager of the
 * dashboard, the worker's step after a capture, the toasts on the page, the suggestion that waits in
 * the side panel, undo, order, and what "Delete all data" removes. Real pointer and keyboard input;
 * nothing is mocked.
 */

const FIXTURE = '/article.html';
const SAVE = 'Save selection';

/** Select a paragraph and press Save in the page toolbar; resolves with the new highlight's row. */
async function saveParagraph(
  ctrl: Awaited<ReturnType<typeof openExt>>,
  page: Awaited<ReturnType<typeof openFixture>>,
  selector: string,
) {
  const known = new Set((await highlightsOf(ctrl, page.url())).map((h) => h.id));
  await page.bringToFront();
  await tripleClickBlock(page, selector);
  await page.getByRole('button', { name: SAVE, exact: true }).click();
  await expect
    .poll(async () => (await highlightsOf(ctrl, page.url())).filter((h) => !known.has(h.id)).length)
    .toBe(1);
  return (await highlightsOf(ctrl, page.url())).find((h) => !known.has(h.id))!;
}

const banksOf = async (ctrl: Awaited<ReturnType<typeof openExt>>, url: string, quote: RegExp) => {
  const row = (await highlightsOf(ctrl, url)).find((h) => quote.test(h.exactQuote));
  return row?.bankIds ?? null;
};

test.describe('filing rules', () => {
  test('a rule made in the manager suggests after a capture, files on File and undoes', async ({
    env,
  }) => {
    const ctrl = await openExt(env, 'options');
    const cardio = await createBankRpc(ctrl, 'Cardiology');
    const rules = await openRules(env);
    await expect(rules.getByText('No filing rules yet')).toBeVisible();

    await createRule(rules, { name: 'Fixture site', hosts: ['127.0.0.1'], bank: 'Cardiology' });
    const row = ruleRow(rules, 'Fixture site');
    await expect(row).toContainText('the site is 127.0.0.1');
    await expect(row).toContainText('Cardiology');
    await expect(row).toContainText('Asks first');
    expect((await storedRules(ctrl)).map((r) => r.name)).toEqual(['Fixture site']);

    const page = await openFixture(env, FIXTURE);
    await saveParagraph(ctrl, page, '#p-intro');
    await expect(overlayToast(page, 'Saved to Inbox')).toBeVisible();
    const suggestion = overlayToast(page, "File in Cardiology? Rule 'Fixture site'");
    await expect(suggestion).toBeVisible();
    // A suggestion changes nothing by itself.
    expect(await banksOf(ctrl, page.url(), /sinoatrial node is the primary pacemaker/)).toEqual([
      INBOX_BANK_ID,
    ]);

    await suggestion.getByRole('button', { name: 'File', exact: true }).click();
    const filed = overlayToast(page, "Filed in Cardiology by rule 'Fixture site'");
    await expect(filed).toBeVisible();
    await expect
      .poll(() => banksOf(ctrl, page.url(), /sinoatrial node is the primary pacemaker/))
      .toEqual([cardio]);

    await filed.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(overlayToast(page, /Filing undone/)).toBeVisible();
    await expect
      .poll(() => banksOf(ctrl, page.url(), /sinoatrial node is the primary pacemaker/))
      .toEqual([INBOX_BANK_ID]);
    // The highlight itself was never deleted by any of it.
    expect((await highlightsOf(ctrl, page.url())).length).toBe(1);
  });

  test('a rule that does not ask files at once, with Undo', async ({ env }) => {
    const ctrl = await openExt(env, 'options');
    const cardio = await createBankRpc(ctrl, 'Cardiology');
    const rules = await openRules(env);
    await createRule(rules, {
      name: 'Quiet rule',
      hosts: ['127.0.0.1'],
      bank: 'Cardiology',
      asks: false,
    });
    await expect(ruleRow(rules, 'Quiet rule')).toContainText('Files at once');

    const page = await openFixture(env, FIXTURE);
    await saveParagraph(ctrl, page, '#p-multiline');
    const filed = overlayToast(page, "Filed in Cardiology by rule 'Quiet rule'");
    await expect(filed).toBeVisible();
    // The "Saved to Inbox" toast would name a bank it is no longer in.
    await expect(overlayToast(page, /Saved to/)).toHaveCount(0);
    await expect.poll(() => banksOf(ctrl, page.url(), /bundle of His/)).toEqual([cardio]);

    await filed.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(() => banksOf(ctrl, page.url(), /bundle of His/)).toEqual([INBOX_BANK_ID]);
  });

  test('the first rule in the list decides, Move down changes it, and the order survives a reload', async ({
    env,
  }) => {
    const ctrl = await openExt(env, 'options');
    await createBankRpc(ctrl, 'Cardiology');
    await createBankRpc(ctrl, 'Renal');
    const rules = await openRules(env);
    await createRule(rules, { name: 'A first', hosts: ['127.0.0.1'], bank: 'Cardiology' });
    await createRule(rules, { name: 'B second', hosts: ['127.0.0.1'], bank: 'Renal' });
    expect(await ruleOrder(rules)).toEqual(['A first', 'B second']);

    // The first (and last) rule cannot move past the ends, and says why.
    const first = ruleRow(rules, 'A first');
    await expect(first.getByTestId('rule-up')).toHaveAttribute('aria-disabled', 'true');

    const page = await openFixture(env, FIXTURE);
    await saveParagraph(ctrl, page, '#p-intro');
    await expect(overlayToast(page, "File in Cardiology? Rule 'A first'")).toBeVisible();
    await page.getByRole('button', { name: 'Not now', exact: true }).click();
    await expect(overlayToast(page, /File in Cardiology/)).toHaveCount(0);

    await first.getByTestId('rule-down').click();
    await expect.poll(() => ruleOrder(rules)).toEqual(['B second', 'A first']);
    await rules.reload();
    await expect(ruleRows(rules)).toHaveCount(2);
    expect(await ruleOrder(rules)).toEqual(['B second', 'A first']);

    await saveParagraph(ctrl, page, '#p-nested');
    await expect(overlayToast(page, "File in Renal? Rule 'B second'")).toBeVisible();

    // Keyboard: Alt+Arrow moves the rule the focus is on.
    await ruleRow(rules, 'A first').getByTestId('rule-edit').focus();
    await rules.keyboard.press('Alt+ArrowUp');
    await expect.poll(() => ruleOrder(rules)).toEqual(['A first', 'B second']);
    await expect(ruleRow(rules, 'A first').getByTestId('rule-edit')).toBeFocused();
  });

  test('a suggestion waits in the side panel, survives a suspended worker, and files from there', async ({
    env,
  }) => {
    const ctrl = await openExt(env, 'options');
    const cardio = await createBankRpc(ctrl, 'Cardiology');
    const rules = await openRules(env);
    await createRule(rules, { name: 'Fixture site', hosts: ['127.0.0.1'], bank: 'Cardiology' });

    const page = await openFixture(env, FIXTURE);
    const first = await saveParagraph(ctrl, page, '#p-intro');
    await expect(overlayToast(page, "File in Cardiology? Rule 'Fixture site'")).toBeVisible();
    const second = await saveParagraph(ctrl, page, '#p-multiline');

    // Chrome suspends an idle worker: the pending suggestions are not in its memory.
    await stopWorker(env.context, env.extensionId, ctrl);

    const side = await viewing(env, 'sidepanel', page);
    const card = side.locator(`article[data-highlight-id="${first.id}"]`);
    const chip = card.getByTestId('card-suggestion');
    await expect(chip).toBeVisible();
    await expect(chip).toContainText('Rule “Fixture site” suggests filing this in');
    await expect(chip).toContainText('Cardiology');

    await chip.getByTestId('suggestion-file').click();
    await expect(side.getByText("Filed in Cardiology by rule 'Fixture site'.")).toBeVisible();
    await expect(chip).toHaveCount(0);
    await expect
      .poll(
        async () => (await highlightsOf(ctrl, page.url())).find((h) => h.id === first.id)?.bankIds,
      )
      .toEqual([cardio]);

    // "Not now" leaves the other highlight where it is, and the chip goes.
    const other = side.locator(`article[data-highlight-id="${second.id}"]`);
    await other.getByTestId('suggestion-dismiss').click();
    await expect(other.getByTestId('card-suggestion')).toHaveCount(0);
    expect((await highlightsOf(ctrl, page.url())).find((h) => h.id === second.id)?.bankIds).toEqual(
      [INBOX_BANK_ID],
    );
  });

  test('never overrides a bank picked in More options, and does nothing while a rule or the switch is off', async ({
    env,
  }) => {
    const ctrl = await openExt(env, 'options');
    await createBankRpc(ctrl, 'Cardiology');
    const renal = await createBankRpc(ctrl, 'Renal');
    const rules = await openRules(env);
    await createRule(rules, { name: 'Fixture site', hosts: ['127.0.0.1'], bank: 'Cardiology' });

    const page = await openFixture(env, FIXTURE);
    await saveBlockToBank(ctrl, page, '#p-intro', 'Renal');
    await expect(overlayToast(page, 'Saved to Renal')).toBeVisible();
    await expect(overlayToast(page, /^File in /)).toHaveCount(0);
    expect(await banksOf(ctrl, page.url(), /sinoatrial node is the primary pacemaker/)).toEqual([
      renal,
    ]);

    // Turn the rule off with its own switch.
    await ruleRow(rules, 'Fixture site')
      .getByRole('checkbox', { name: /On for rule/ })
      .uncheck();
    await expect(ruleRow(rules, 'Fixture site')).toContainText('Off');
    // The last-used bank is Renal now; the rule would file into Cardiology.
    await saveParagraph(ctrl, page, '#p-multiline');
    await expect(overlayToast(page, /Saved to Renal/)).toBeVisible();
    await expect(overlayToast(page, /^File in /)).toHaveCount(0);

    // Turn it on again, then switch the whole feature off.
    await ruleRow(rules, 'Fixture site')
      .getByRole('checkbox', { name: /On for rule/ })
      .check();
    await expect(ruleRow(rules, 'Fixture site')).not.toContainText('Off');
    await rules.getByTestId('rules-switch').uncheck();
    await expect(rules.getByText('Filing rules are off', { exact: true })).toBeVisible();
    await expect.poll(async () => (await storedSettings(ctrl))?.useFilingRules).toBe(false);
    await saveParagraph(ctrl, page, '#p-nested');
    await expect(overlayToast(page, /Saved to Renal/)).toBeVisible();
    await expect(overlayToast(page, /^File in /)).toHaveCount(0);

    // And on again: the next capture is offered.
    await rules.getByTestId('rules-switch').check();
    await expect.poll(async () => (await storedSettings(ctrl))?.useFilingRules).toBe(true);
    await saveParagraph(ctrl, page, '#p-repeat-1');
    await expect(overlayToast(page, "File in Cardiology? Rule 'Fixture site'")).toBeVisible();
  });

  test('the Test a rule panel shows what a capture would do, and a rule with a deleted bank says so and files nothing', async ({
    env,
  }) => {
    const ctrl = await openExt(env, 'options');
    await createBankRpc(ctrl, 'Cardiology');
    await createBankRpc(ctrl, 'Temp');
    const rules = await openRules(env);
    await createRule(rules, { name: 'Fixture site', hosts: ['127.0.0.1'], bank: 'Cardiology' });
    await createRule(rules, {
      name: 'Temp rule',
      titleContains: ['primer'],
      bank: 'Temp',
      asks: false,
    });

    const tester = rules.getByTestId('rule-tester');
    await tester.getByTestId('test-url').fill('http://127.0.0.1:4444/anything');
    await expect(tester.getByTestId('test-verdict')).toContainText(
      'Ask first, then file in Cardiology',
    );
    await expect(tester.getByTestId('test-verdict')).toContainText(
      'Decided by rule “Fixture site”',
    );
    await tester.getByTestId('test-url').fill('not an address');
    await expect(tester.getByRole('alert')).toContainText('starts with http');
    await tester.getByTestId('test-url').fill('https://elsewhere.example/x');
    await expect(tester.getByTestId('test-verdict')).toContainText('No rule matches');

    // A rule whose bank is deleted is reported in the list and does not file anything.
    await treeItem(rules, 'Temp').press('Delete');
    const del = dialogOf(rules, 'Delete bank “Temp”?');
    await del.getByTestId('dialog-confirm').click();
    await expect(del).toHaveCount(0);
    await expect(ruleRow(rules, 'Temp rule')).toContainText('Its bank was deleted');

    // "Primer" is in the fixture's title; the broken rule is the first match once the site rule
    // is moved out of the way, so a capture is told and nothing is filed.
    await ruleRow(rules, 'Fixture site').getByTestId('rule-down').click();
    await expect.poll(() => ruleOrder(rules)).toEqual(['Temp rule', 'Fixture site']);
    const page = await openFixture(env, FIXTURE);
    await saveParagraph(ctrl, page, '#p-intro');
    await expect(
      overlayToast(page, /Rule 'Temp rule' could not file this highlight/),
    ).toBeVisible();
    expect(await banksOf(ctrl, page.url(), /sinoatrial node is the primary pacemaker/)).toEqual([
      INBOX_BANK_ID,
    ]);
  });

  test('the rules manager passes axe, with its dialog open too', async ({ env }) => {
    const ctrl = await openExt(env, 'options');
    await createBankRpc(ctrl, 'Cardiology');
    const rules = await openRules(env);
    await createRule(rules, { name: 'Fixture site', hosts: ['127.0.0.1'], bank: 'Cardiology' });
    await createRule(rules, {
      name: 'Heart words',
      titleContains: ['heart'],
      bank: 'Cardiology',
      asks: false,
    });
    await rules.getByTestId('test-url').fill('http://127.0.0.1/x');
    await expect(rules.getByTestId('test-verdict')).toBeVisible();
    await expectAxeClean(rules);

    await ruleRow(rules, 'Fixture site').getByTestId('rule-edit').click();
    await expect(rules.getByRole('dialog', { name: /Edit rule/ })).toBeVisible();
    await expectAxeClean(rules, '[role="dialog"], dialog');
  });

  test('"Delete all data" removes the rules', async ({ env }) => {
    const ctrl = await openExt(env, 'options');
    await createBankRpc(ctrl, 'Cardiology');
    const rules = await openRules(env);
    await createRule(rules, { name: 'Fixture site', hosts: ['127.0.0.1'], bank: 'Cardiology' });
    expect(await storedRules(ctrl)).toHaveLength(1);

    const options = await env.context.newPage();
    await options.goto(`chrome-extension://${env.extensionId}/options.html`);
    await deleteAllData(options);

    expect(await storedRules(ctrl)).toEqual([]);
    await rules.reload();
    await expect(rules.getByText('No filing rules yet')).toBeVisible();
  });
});
