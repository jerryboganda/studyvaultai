import { browser } from 'wxt/browser';

/**
 * Per-origin optional host permission for the configured AI endpoint (ADR-009). `request` must be
 * the FIRST await of a click handler, so Chrome still sees the user gesture; it resolves true
 * without a prompt when the access is already granted.
 */
export function requestEndpointAccess(pattern: string): Promise<boolean> {
  // No permissions API (embedded or test context): there is no prompt to show, and nothing to gate.
  if (!browser.permissions?.request) return Promise.resolve(true);
  return browser.permissions.request({ origins: [pattern] });
}

export async function hasEndpointAccess(pattern: string): Promise<boolean> {
  try {
    if (!browser.permissions?.contains) return true;
    return await browser.permissions.contains({ origins: [pattern] });
  } catch {
    return false;
  }
}

export async function revokeEndpointAccess(pattern: string): Promise<void> {
  await browser.permissions?.remove?.({ origins: [pattern] });
}
