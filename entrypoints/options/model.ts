import { denyEntriesFor, isRegistrablePattern, originPattern, parseHttpUrl } from '@shared';
import { tableLabel } from '@ui/backup/format';
import { isAllSitesPattern, normalizeDenyInput, patternHost } from '@ui/hosts';

/** Pure helpers for the options page. */

// ---------------------------------------------------------------------------------------------
// Sections (each one is its own view: `options.html#<id>`; no hash is the settings home)
// ---------------------------------------------------------------------------------------------

/**
 * Every section, in nav and home-tile order. The ids are `#hash` deep links: the ones in
 * `SETTINGS_SECTIONS` (`@ui/shell/paths`) are a public contract and all stay here; `game`,
 * `reminders` and `about` are new and only this page knows them so far.
 */
export const OPTION_SECTIONS = [
  { id: 'game', label: 'Game', group: 'Everyday', line: 'Daily goal, XP and streak.' },
  { id: 'site-access', label: 'Site access', group: 'Everyday', line: 'Where StudyVault may run.' },
  { id: 'capture', label: 'Capture', group: 'Everyday', line: 'How you save from pages.' },
  { id: 'appearance', label: 'Appearance', group: 'Everyday', line: 'Theme, density and colours.' },
  { id: 'shortcuts', label: 'Shortcuts', group: 'Everyday', line: 'Keys that work in any tab.' },
  { id: 'review', label: 'Review', group: 'Study', line: 'Flashcards and your study day.' },
  { id: 'reminders', label: 'Reminders', group: 'Study', line: 'A nudge when cards are due.' },
  { id: 'backup', label: 'Backup', group: 'Your data', line: 'Copies of your vault.' },
  { id: 'storage', label: 'Storage', group: 'Your data', line: 'What takes space here.' },
  { id: 'privacy', label: 'Privacy', group: 'Your data', line: 'What stays here, what can leave.' },
  {
    id: 'data',
    label: 'Your data',
    group: 'Your data',
    line: 'Where it lives, and a fresh start.',
  },
  { id: 'ai', label: 'AI', group: 'Extras', line: 'Optional. Off until you set it up.' },
  { id: 'sync', label: 'Sync', group: 'Extras', line: 'Optional. Uses your own server.' },
  { id: 'about', label: 'About', group: 'Extras', line: 'Version and the welcome tour.' },
] as const;

export type OptionSectionId = (typeof OPTION_SECTIONS)[number]['id'];
export type OptionSection = (typeof OPTION_SECTIONS)[number];

export const sectionById = (id: OptionSectionId): OptionSection =>
  OPTION_SECTIONS.find((s) => s.id === id)!;

/** The sections grouped for the home tiles, groups in first-seen order. */
export function sectionGroups(): Array<{ group: string; sections: OptionSection[] }> {
  const out: Array<{ group: string; sections: OptionSection[] }> = [];
  for (const s of OPTION_SECTIONS) {
    const last = out.at(-1);
    if (last?.group === s.group) last.sections.push(s);
    else out.push({ group: s.group, sections: [s] });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Site access
// ---------------------------------------------------------------------------------------------

export type SitePick = { ok: true; pattern: string; host: string } | { ok: false; error: string };

/**
 * What someone typed to switch StudyVault on for one site ("example.com", "https://Example.com/a")
 * as the origin pattern the popup would store for it. A bare name means https; an address keeps
 * its own scheme and port. Refused: anything that is not one site, a site on the deny list (it
 * would stay off anyway) and a site already on.
 */
export function sitePatternFromInput(
  input: string,
  o: { denyList: readonly string[]; taken: readonly string[] },
): SitePick {
  const text = input.trim();
  if (text === '') return { ok: false, error: 'Type a site, such as example.com.' };
  let pattern: string | null;
  if (text.includes('://')) {
    const url = parseHttpUrl(text);
    pattern = url ? originPattern(url.href) : null;
    if (!pattern)
      return { ok: false, error: 'Use an address that starts with http:// or https://.' };
  } else {
    const parsed = normalizeDenyInput(text);
    if ('error' in parsed) return { ok: false, error: parsed.error };
    pattern = `https://${parsed.host}/*`;
  }
  const host = patternHost(pattern) ?? pattern;
  if (!isRegistrablePattern(pattern)) {
    return { ok: false, error: `${host} cannot be kept on. Use the popup on that page instead.` };
  }
  const [denied] = denyEntriesFor(host.replace(/:\d+$/, ''), o.denyList);
  if (denied) return { ok: false, error: `${host} is on your deny list (${denied}).` };
  if (o.taken.includes(pattern)) return { ok: false, error: `${host} is already on.` };
  return { ok: true, pattern, host };
}

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
  // `ai` is every address an AI request can go to: the provider and its fallbacks.
  known: {
    ai: string | readonly string[] | null;
    syncServer: string | null;
    syncIssuer: string | null;
  },
): OtherGrant[] {
  const hidden = new Set([...listed.persistentOrigins, ...listed.manifestHosts]);
  return [...new Set(granted)]
    .filter((pattern) => !isAllSitesPattern(pattern) && !hidden.has(pattern))
    .sort((a, b) => a.localeCompare(b))
    .map((pattern) => {
      const key = originKey(pattern);
      const purposes = [
        key !== null && (typeof known.ai === 'string' ? key === known.ai : known.ai?.includes(key))
          ? 'AI provider'
          : null,
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
  alarms:
    'Lets sync run on a timer, and lets a daily study reminder come at its time. Asked for only when you turn sync on or save a daily reminder time.',
};

// ---------------------------------------------------------------------------------------------
// Section navigation
// ---------------------------------------------------------------------------------------------

/** The section a `#hash` names, or null: the home (an unknown hash is ignored, never trusted). */
export function sectionFromHash(hash: string): OptionSectionId | null {
  const id = hash.replace(/^#/, '');
  return OPTION_SECTIONS.find((s) => s.id === id)?.id ?? null;
}

// ---------------------------------------------------------------------------------------------
// Small display helpers
// ---------------------------------------------------------------------------------------------

/** "Alt+Shift+]" -> ["Alt", "Shift", "]"]; a key that is itself "+" survives ("Ctrl++"). */
export const keyParts = (shortcut: string): string[] => shortcut.split(/\+(?!$)/);

/** The daily goals with their names (UX_DESIGN 11: Casual, Regular, Serious, Intense). */
export const GOAL_NAMES = { 10: 'Casual', 30: 'Regular', 50: 'Serious', 100: 'Intense' } as const;

/** The word that confirms "Delete all data" (any case, spaces around it ignored). */
export const DELETE_WORD = 'delete';
export const isDeleteWord = (text: string): boolean => text.trim().toLowerCase() === DELETE_WORD;

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
  gameEvents: 'Game: XP records',
  gameFacts: 'Game: goal and mode history',
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
