/**
 * Extension page addresses that contexts other than the page itself need (the service worker opens
 * the welcome tour on first install; the popup and options page link to each other's sections).
 * Import-free on purpose: `import { onboardingPath } from '@ui/shell/paths'` drags no UI into a worker.
 *
 * Like `dashboardPath` and `pdfReaderPath`, the values are extension-relative and have no leading
 * slash: `browser.runtime.getURL(`/${onboardingPath}`)` or `tabs.create({ url: ... })`.
 */

/** The first-run welcome tour (entrypoints/onboarding). Skippable, resumable, re-openable. */
export const onboardingPath = 'onboarding.html';

/** The settings page (opens in a tab). */
export const optionsPath = 'options.html';

/**
 * Sections of the settings page, in page order. The ids are the `#hash` deep links, so they are a
 * public contract: the welcome tour, the popup and documentation link to them.
 */
export const SETTINGS_SECTIONS = [
  { id: 'site-access', label: 'Site access' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'capture', label: 'Capture' },
  { id: 'review', label: 'Review' },
  { id: 'ai', label: 'AI assistance' },
  { id: 'sync', label: 'Sync' },
  { id: 'backup', label: 'Backup and restore' },
  { id: 'storage', label: 'Storage' },
  { id: 'shortcuts', label: 'Keyboard shortcuts' },
  { id: 'privacy', label: 'Privacy' },
  { id: 'data', label: 'Your data' },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id'];

/** `options.html#ai`. An unknown section yields the page without a hash. */
export function settingsPath(section?: SettingsSectionId): string {
  return section && SETTINGS_SECTIONS.some((s) => s.id === section)
    ? `${optionsPath}#${section}`
    : optionsPath;
}
