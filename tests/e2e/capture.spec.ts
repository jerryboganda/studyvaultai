import { activateTab, paintedTexts } from './helpers';
import { expect, test } from './fixtures';

test.describe('Phase 1 vertical slice: select -> save -> reload -> restore', () => {
  test('toolbar appears, saves a quote, and the highlight is restored after reload', async ({
    context,
    extensionId,
    fixtureServer,
  }) => {
    const page = await context.newPage();
    await page.goto(`${fixtureServer.origin}/article.html`);
    await activateTab(context, extensionId, page);

    // Select a whole paragraph with a real triple-click.
    await page.locator('#p-multiline').click({ clickCount: 3 });
    const toolbar = page.getByRole('toolbar', { name: /StudyVault/ });
    await expect(toolbar).toBeVisible();

    await page.getByRole('button', { name: 'Save selection' }).click();
    await expect(page.getByText(/Saved to Inbox/)).toBeVisible();

    // The saved quote is painted immediately...
    await expect
      .poll(() => paintedTexts(page))
      .toEqual([expect.stringContaining('atrioventricular node')]);

    // ...and recovered on a fresh load of the same URL.
    await page.reload();
    await activateTab(context, extensionId, page);
    await expect
      .poll(() => paintedTexts(page), { timeout: 15_000 })
      .toEqual([expect.stringContaining('maximises stroke volume')]);
  });
});
