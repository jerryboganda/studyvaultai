import { expect, prodTest as test } from './fixtures';

// Runs against the PRODUCTION build (.output/chrome-mv3): this is the shipped manifest.
test.describe('Phase 0: production build loads in real Chromium', () => {
  test('manifest is MV3 with least-privilege permissions', async ({ serviceWorker }) => {
    const manifest = await serviceWorker.evaluate(() => chrome.runtime.getManifest());
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.host_permissions ?? []).toEqual([]);
    expect(manifest.content_scripts ?? []).toEqual([]);
    expect([...(manifest.permissions ?? [])].sort()).toEqual(
      ['activeTab', 'contextMenus', 'scripting', 'sidePanel', 'storage'].sort(),
    );
    expect(manifest.optional_host_permissions).toEqual(['https://*/*', 'http://*/*']);
  });

  test('popup document renders', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(page.getByRole('heading').first()).toBeVisible();
  });

  test('side panel document renders', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await expect(page.getByRole('heading').first()).toBeVisible();
  });

  test('side panel path is registered with the browser', async ({ serviceWorker }) => {
    const options = await serviceWorker.evaluate(() => chrome.sidePanel.getOptions({}));
    expect(options.path).toBe('sidepanel.html');
  });
});
