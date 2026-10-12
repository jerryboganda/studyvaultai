import { browser } from 'wxt/browser';

/**
 * How other surfaces open the dashboard (popup, side panel, PDF reader, options):
 *
 *   import { openDashboard } from '@ui/vault';
 *   await openDashboard({ highlight: id });      // preview that highlight
 *   await openDashboard({ bank: bankId });       // scoped to a bank
 *   await openDashboard({ q: 'tag:neuro' });     // with a search
 *   await openDashboard({ bank: id, view: 'chat' }); // chat with the notes of a bank (AI, opt-in)
 *
 * The page is `dashboard.html` (an unlisted extension page: no manifest entry, no extra permission).
 */

export const DASHBOARD_PAGE = 'dashboard.html';

export interface DashboardTarget {
  highlight?: string | null;
  bank?: string | null;
  q?: string | null;
  /** A view other than the highlight list. */
  view?: 'chat' | 'graph' | 'syllabus' | 'rules' | null;
  /** With `view: 'syllabus'`: open on this syllabus. */
  syllabus?: string | null;
}

/** Extension-relative path (`dashboard.html?highlight=...`). Pass it to `runtime.getURL`. */
export function dashboardPath(target: DashboardTarget = {}): string {
  const params = new URLSearchParams();
  if (target.highlight) params.set('highlight', target.highlight);
  if (target.bank) params.set('bank', target.bank);
  if (target.q) params.set('q', target.q);
  if (
    target.view === 'chat' ||
    target.view === 'graph' ||
    target.view === 'syllabus' ||
    target.view === 'rules'
  ) {
    params.set('view', target.view);
    if (target.view === 'syllabus' && target.syllabus) params.set('syllabus', target.syllabus);
  }
  const query = params.toString();
  return query ? `${DASHBOARD_PAGE}?${query}` : DASHBOARD_PAGE;
}

/** Absolute `chrome-extension://…/dashboard.html?…` address. */
export function dashboardUrl(target: DashboardTarget = {}): string {
  return browser.runtime.getURL(`/${dashboardPath(target)}` as never);
}

/**
 * Open the dashboard in a tab: an already open dashboard tab is reused (and pointed at `target`),
 * otherwise a new tab is created. Needs no permission beyond what the calling page has.
 */
export async function openDashboard(target: DashboardTarget = {}): Promise<void> {
  const url = dashboardUrl(target);
  try {
    const [existing] = await browser.tabs.query({ url: `${dashboardUrl()}*` });
    if (existing?.id !== undefined) {
      await browser.tabs.update(existing.id, { url, active: true });
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
