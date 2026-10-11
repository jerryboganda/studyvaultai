import { tableLabel } from '@ui/backup/format';
import { isAllSitesPattern, normalizeDenyInput, patternHost } from '@ui/hosts';
import { SETTINGS_SECTIONS, type SettingsSectionId } from '@ui/shell/paths';

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

/** `scheme://host` of a match pattern or an address (no port, no path); null when it is neither. */
export function originKey(text: string): string | null {
  const m = /^(https?|\*):\/\/(\[[^\]]+\]|[^/:]+)(?::\d+)?(?:\/.*)?$/i.exec(text.trim());
  return m ? `${m[1]}://${m[2]}`.toLowerCase() : null;
}

export interface OtherGrant {
  /** The exact match pattern Chrome lists; what "Revoke" removes. */
  pattern: string;
  /** The same without the trailing `/*`, for display. */
  origin: string;
  /** What StudyVault can tell it is for ("Other" when nothing it knows of uses it). */
  purpose: string;
}

/**
 * Host access Chrome holds for StudyVault that no other card on the page lists: not a site enabled
 * one by one, not an all-sites grant (its own card), not a manifest host permission (developer
 * builds). The purpose is inferred by comparing with the configured AI endpoint and sync addresses
 * (`known`, as `originKey`s); anything else is "Other", never guessed.
 */
export function otherGrants(
  granted: readonly string[],
  listed: { persistentOrigins: readonly string[]; manifestHosts: readonly string[] },
  known: { ai: string | null; syncServer: string | null; syncIssuer: string | null },
): OtherGrant[] {
  const hidden = new Set([...listed.persistentOrigins, ...listed.manifestHosts]);
  return [...new Set(granted)]
    .filter((pattern) => !isAllSitesPattern(pattern) && !hidden.has(pattern))
    .sort((a, b) => a.localeCompare(b))
    .map((pattern) => {
      const key = originKey(pattern);
      const purposes = [
        key !== null && key === known.ai ? 'AI provider' : null,
        key !== null && key === known.syncServer ? 'Sync server' : null,
        key !== null && key === known.syncIssuer ? 'Sync sign-in provider' : null,
      ].filter((p): p is string => p !== null);
      return {
        pattern,
        origin: pattern.replace(/\/\*$/, ''),
        purpose: purposes.length > 0 ? purposes.join(' and ') : 'Other',
      };
    });
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
  identity: 'Opens the sign-in window for sync. Asked for only when you turn sync on.',
  alarms: 'Lets sync run on a timer in the background. Asked for only when you turn sync on.',
};

// ---------------------------------------------------------------------------------------------
// Section navigation
// ---------------------------------------------------------------------------------------------

/** The section a `#hash` names, or null (an unknown hash is ignored, never trusted). */
export function sectionFromHash(hash: string): SettingsSectionId | null {
  const id = hash.replace(/^#/, '');
  return SETTINGS_SECTIONS.find((s) => s.id === id)?.id ?? null;
}

/**
 * Roving focus in the section list: where an arrow key moves from `index`. Up/Down and Left/Right
 * both step (the list wraps onto several rows on a narrow page); Home and End jump. Null: not a
 * navigation key.
 */
export function moveIndex(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case 'ArrowDown':
    case 'ArrowRight':
      return (index + 1) % count;
    case 'ArrowUp':
    case 'ArrowLeft':
      return (index - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------------------------

const BOOKKEEPING_LABELS: Record<string, string> = {
  meta: 'Internal bookkeeping',
  syncOps: 'Sync: changes recorded',
  syncEntityMeta: 'Sync: bookkeeping',
  syncConflicts: 'Sync: conflicts',
  syncQuarantine: 'Sync: changes set aside',
};

export const storageLabel = (table: string): string =>
  BOOKKEEPING_LABELS[table] ?? tableLabel(table);

/** Tables that hold something, biggest first (then by label), for the "What is stored" list. */
export function storageRows(
  rows: Readonly<Record<string, number>>,
): Array<{ table: string; count: number }> {
  return Object.entries(rows)
    .filter(([, count]) => count > 0)
    .map(([table, count]) => ({ table, count }))
    .sort(
      (a, b) => b.count - a.count || storageLabel(a.table).localeCompare(storageLabel(b.table)),
    );
}
