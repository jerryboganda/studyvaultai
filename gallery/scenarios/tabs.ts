import { addTab } from '../shim/chrome';

/**
 * The fake active tab the popup and side panel look at (`?tab=<preset>` or a raw address).
 * `contentScript`: the highlighter runs there (registered for the site, or activated earlier).
 */
export const TAB_PRESETS: Record<
  string,
  { url?: string; title: string; contentScript: boolean } | null
> = {
  /** A highlighted article on a site with "always on" access (student). */
  article: {
    url: 'https://en.wikipedia.org/wiki/Beta_blocker',
    title: 'Beta blocker - Wikipedia',
    contentScript: true,
  },
  /** A page with many highlights (heavy). */
  reference: {
    url: 'https://reference.example.org/textbook/chapter-1/section-0?edition=2026',
    title:
      'Clinical Pharmacology and Therapeutics: an extremely detailed review article with a very long title, chapter 1 of the online reference textbook',
    contentScript: true,
  },
  /** An ordinary page on a site StudyVault has no access to yet. */
  inactive: {
    url: 'https://www.merckmanuals.com/professional/cardiovascular-disorders/arrhythmias-and-conduction-disorders/atrial-fibrillation',
    title: 'Atrial Fibrillation - Cardiovascular Disorders - Merck Manual Professional Edition',
    contentScript: false,
  },
  /** A browser page extensions cannot run on. */
  chrome: { url: 'chrome://extensions/', title: 'Extensions', contentScript: false },
  /** A site on the default deny list. */
  denied: {
    url: 'https://mail.google.com/mail/u/0/#inbox',
    title: 'Inbox (3) - student@example.edu - Mail',
    contentScript: false,
  },
  /** A PDF open in Chrome's own viewer. */
  pdf: {
    url: 'https://www.cdc.gov/vaccines/hcp/imz-schedules/downloads/child/0-18yrs-child-combined-schedule.pdf',
    title: '0-18yrs-child-combined-schedule.pdf',
    contentScript: false,
  },
  /** Chrome did not share the address. */
  newtab: { title: 'New Tab', contentScript: false },
  /** No active tab at all. */
  none: null,
};

/** Open the scenario's active tab: a preset name, or any address (`tab=https://…`). */
export function openActiveTab(preset: string): void {
  const spec =
    preset in TAB_PRESETS
      ? TAB_PRESETS[preset]
      : { url: preset, title: preset, contentScript: false };
  if (!spec) return;
  addTab({ id: 7, active: true, ...spec });
}
