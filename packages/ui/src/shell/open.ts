import { browser } from 'wxt/browser';
import { onboardingPath } from './paths';

/** Absolute `chrome-extension://…/onboarding.html` address. */
export function onboardingUrl(): string {
  return browser.runtime.getURL(`/${onboardingPath}` as never);
}

/**
 * Open the welcome tour in a tab: an open tour tab is brought to the front instead of a second one
 * being created. Needs no permission beyond what the calling page has.
 */
export async function openOnboarding(): Promise<void> {
  const url = onboardingUrl();
  try {
    const [existing] = await browser.tabs.query({ url: `${url}*` });
    if (existing?.id !== undefined) {
      await browser.tabs.update(existing.id, { active: true });
      if (existing.windowId !== undefined) {
        await browser.windows.update(existing.windowId, { focused: true });
      }
      return;
    }
  } catch {
    // Fall through: a new tab always works.
  }
  await browser.tabs.create({ url });
}
