import { expect, openDashboard, openPreview, test } from './helpers.dashboard';
import { putRelations, seedGraph } from './helpers.graph';

test.describe.configure({ timeout: 120_000 });

test('screenshots of the graph view', async ({ env }) => {
  const { ctrl, id } = await seedGraph(env);
  await putRelations(ctrl, [
    { from: id.a, to: id.b, type: 'supports', note: 'x' },
    { from: id.a, to: id.c, type: 'contradicts' },
    { from: id.b, to: id.c, type: 'cause' },
    { from: id.c, to: id.v, type: 'prerequisite' },
    { from: id.v, to: id.a, type: 'example' },
    { from: id.b, to: id.v, type: 'related' },
  ]);
  const page = await openDashboard(env);
  await openPreview(page, id.a);
  await page.getByTestId('view-graph').click();
  await expect(page.getByTestId('graph-svg')).toBeVisible();
  await page.getByTestId('graph-depth-2').check();
  await page.getByTestId('graph-svg').locator('[data-centre="true"]').focus();
  await page.waitForTimeout(500);
  await page.screenshot({ path: process.env.SHOT_DIR + '/graph-light.png', fullPage: false });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(300);
  await page.screenshot({ path: process.env.SHOT_DIR + '/graph-dark.png', fullPage: false });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 400, height: 900 });
  await page.getByTestId('close-preview').click().catch(() => undefined);
  await page.waitForTimeout(300);
  await page.screenshot({ path: process.env.SHOT_DIR + '/graph-narrow.png', fullPage: true });
});
