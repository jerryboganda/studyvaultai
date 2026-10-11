import { expect, openExt, openFixture, saveBlock, test, viewing } from './helpers.pages';

test('debug: zoom timing of the side panel', async ({ env }) => {
  const ext = await openExt(env, 'options');
  const page = await openFixture(env, '/pages-b.html');
  await saveBlock(ext, page, '#p-gfr');
  const side = await viewing(env, 'sidepanel', page);
  await expect(side.getByRole('article')).toHaveCount(1);
  await side.setViewportSize({ width: 320, height: 700 });
  const t0 = Date.now();
  const zoomed = await side.evaluate(async () => {
    const tab = await chrome.tabs.getCurrent();
    await chrome.tabs.setZoom(tab?.id ?? 0, 2);
    return chrome.tabs.getZoom(tab?.id ?? 0);
  });
  console.log('zoomed', zoomed, Date.now() - t0);
  for (let i = 0; i < 20; i++) {
    const w = await side.evaluate(() => window.innerWidth);
    console.log('innerWidth', w, Date.now() - t0);
    if (w === 160) break;
    await side.waitForTimeout(1000);
  }
});
