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

  // Keyboard commands are the only way in for users who cannot or do not use the pointer: they must
  // be present, described (chrome://extensions/shortcuts shows the description) and few enough that
  // Chrome keeps every suggested key (it silently drops suggestions beyond four).
  test('manifest declares the keyboard commands, with at most four suggested keys', async ({
    serviceWorker,
  }) => {
    const manifest = await serviceWorker.evaluate(() => chrome.runtime.getManifest());
    const commands = (manifest.commands ?? {}) as Record<
      string,
      { description?: string; suggested_key?: { default?: string } }
    >;
    expect(Object.keys(commands)).toEqual(
      expect.arrayContaining([
        'open-side-panel',
        'quick-save',
        'focus-toolbar',
        'next-highlight',
        'previous-highlight',
      ]),
    );
    for (const [name, command] of Object.entries(commands)) {
      expect(command.description, `${name} has a description`).toBeTruthy();
    }
    const suggested = Object.entries(commands).filter(([, c]) => c.suggested_key?.default);
    expect(suggested.length, 'Chrome honours at most four suggested keys').toBeLessThanOrEqual(4);
    // Alt+Shift+T is Chrome's own "focus toolbar" accelerator: never suggest it for ours.
    expect(suggested.map(([, c]) => c.suggested_key?.default)).not.toContain('Alt+Shift+T');
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
