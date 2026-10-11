// Throw-away probe (agent PA): Escape pressed immediately after the popover / panel opens.
import { expect, openExt, openFixture, saveBlock, test, tripleClickBlock } from './helpers.pages';

const NEXT = 'Alt+Shift+BracketRight';

test('probe: Escape right after next-highlight closes the popover (12 rounds)', async ({ env }) => {
  const ext = await openExt(env, 'options');
  const page = await openFixture(env, '/article.html');
  await page.setViewportSize({ width: 900, height: 360 });
  await saveBlock(ext, page, '#p-intro');
  await saveBlock(ext, page, '#quote', 'Save as Formula');
  await saveBlock(ext, page, '#p-refs');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator('h1').click();
  const dialog = page.getByRole('dialog', { name: 'Highlight details' });

  const lost: number[] = [];
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press(NEXT);
    await page.keyboard.press('Escape'); // no wait: the next key a fast reader (or CI) sends
    if ((await dialog.count()) !== 0) {
      lost.push(i);
      // Let the focus land, then close it so the rounds stay independent.
      await expect(dialog).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
    }
  }
  console.log(`PROBE popover: Escape lost in ${lost.length}/12 rounds ${JSON.stringify(lost)}`);
  expect(lost, 'Escape was swallowed before focus reached the popover').toEqual([]);
});

test('probe: Escape right after "More options" closes the panel (12 rounds)', async ({ env }) => {
  await openExt(env, 'options');
  const page = await openFixture(env, '/article.html');
  const panel = page.getByRole('dialog', { name: 'Save with details' });
  const lost: number[] = [];
  for (let i = 0; i < 12; i++) {
    await tripleClickBlock(page, '#p-intro');
    await page.getByRole('button', { name: 'More options', exact: true }).click();
    await page.keyboard.press('Escape');
    if ((await panel.count()) !== 0) {
      lost.push(i);
      await expect(panel).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(panel).toHaveCount(0);
    }
    // Escape on the toolbar also cleared the selection; make sure it is gone for the next round.
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
  }
  console.log(`PROBE panel: Escape lost in ${lost.length}/12 rounds ${JSON.stringify(lost)}`);
  expect(lost, 'Escape was swallowed before focus reached the panel').toEqual([]);
});
