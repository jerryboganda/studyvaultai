import { browser } from 'wxt/browser';

/**
 * Per-origin optional host permission for the configured AI endpoints (ADR-009). The grant is for
 * the exact origins that may receive the text (the provider and any fallback providers), never a
 * blanket one. `request` must be the FIRST await of a click handler, so Chrome still sees the user
 * gesture; it resolves true without a prompt when the access is already granted.
 */
export function requestEndpointAccess(pattern: string | readonly string[]): Promise<boolean> {
  // No permissions API (embedded or test context): there is no prompt to show, and nothing to gate.
  if (!browser.permissions?.request) return Promise.resolve(true);
  const origins = typeof pattern === 'string' ? [pattern] : [...new Set(pattern)];
  return browser.permissions.request({ origins });
}

export async function hasEndpointAccess(pattern: string | readonly string[]): Promise<boolean> {
  try {
    if (!browser.permissions?.contains) return true;
    const origins = typeof pattern === 'string' ? [pattern] : [...new Set(pattern)];
    return await browser.permissions.contains({ origins });
  } catch {
    return false;
  }
}

export async function revokeEndpointAccess(pattern: string): Promise<void> {
  await browser.permissions?.remove?.({ origins: [pattern] });
}
