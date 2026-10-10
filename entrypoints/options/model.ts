import { isAllSitesPattern, normalizeDenyInput, patternHost } from '@ui/hosts';

/** Pure helpers for the options page. */

export interface SiteEntry {
  pattern: string;
  host: string;
}

/** Split the persistent origins into "all sites" and the individually enabled sites. */
export function splitOrigins(origins: readonly string[]): {
  allSites: boolean;
  sites: SiteEntry[];
} {
  return {
    allSites: origins.some(isAllSitesPattern),
    sites: origins
      .filter((p) => !isAllSitesPattern(p))
      .map((pattern) => ({ pattern, host: patternHost(pattern) ?? pattern })),
  };
}

export type DenyEdit = { ok: true; list: string[]; host: string } | { ok: false; error: string };

export function addDenyEntry(list: readonly string[], input: string): DenyEdit {
  const parsed = normalizeDenyInput(input);
  if ('error' in parsed) return { ok: false, error: parsed.error };
  if (list.includes(parsed.host)) {
    return { ok: false, error: `${parsed.host} is already on the deny list.` };
  }
  return { ok: true, list: [...list, parsed.host], host: parsed.host };
}

export function removeDenyEntry(list: readonly string[], host: string): string[] {
  return list.filter((e) => e !== host);
}

export function missingDefaults(list: readonly string[], defaults: readonly string[]): string[] {
  return defaults.filter((d) => !list.includes(d));
}

/** Deny entries in a stable, scannable order. */
export function sortedDeny(list: readonly string[]): string[] {
  return [...list].sort((a, b) => a.localeCompare(b));
}

export const PERMISSION_PURPOSES: Record<string, string> = {
  storage: 'Keeps your settings on this device.',
  sidePanel: 'Shows the StudyVault panel beside the page.',
  contextMenus: 'Adds the "save selection" item to the right-click menu.',
  activeTab: 'Lets StudyVault work in the current tab only when you ask it to.',
  scripting: 'Starts StudyVault on pages you enabled: this tab, this site or all sites.',
};
