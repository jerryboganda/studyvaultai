import type { Page } from '@playwright/test';

/**
 * Let every running FINITE CSS transition and animation finish before axe samples colours: switching
 * the colour scheme or opening a panel starts transitions, and a contrast check taken mid-transition
 * reads a blend that is neither the old nor the new theme (a flaky "serious" violation).
 *
 * Infinite animations (a busy spinner) never finish, so they are skipped, and the wait is bounded.
 */
export async function settleAnimations(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const finite = document.getAnimations().filter((a) => {
      const end = a.effect?.getComputedTiming().endTime;
      return typeof end === 'number' && Number.isFinite(end);
    });
    await Promise.race([
      Promise.all(finite.map((a) => a.finished.catch(() => undefined))),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  });
}
