import type { Page } from '@playwright/test';

/**
 * Let every running CSS transition and animation finish before axe samples colours: switching the
 * colour scheme or opening a panel starts transitions, and a contrast check taken mid-transition
 * reads a blend that is neither the old nor the new theme (a flaky "serious" violation).
 */
export async function settleAnimations(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
  });
}
