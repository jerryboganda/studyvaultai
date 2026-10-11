import { z } from 'zod';
import { DEFAULT_DENY_HOSTS, DEFAULT_PALETTE, HIGHLIGHT_KINDS } from './constants';
import { ColorId, HighlightKind, Id } from './schema';

export const Settings = z.object({
  schemaVersion: z.literal(1),
  theme: z.enum(['system', 'light', 'dark']),
  density: z.enum(['comfortable', 'compact']),
  toolbarEnabled: z.boolean(),
  defaultKind: HighlightKind,
  palette: z.record(HighlightKind, ColorId),
  /** Last bank the user saved into; quick-save target. Null until the first save. */
  lastBankId: Id.nullable(),
  /** Hosts (and their subdomains) where capture is off. Seeded from DEFAULT_DENY_HOSTS, user-editable. */
  denyList: z.array(z.string().trim().toLowerCase().min(1).max(253)).max(500),
  /** Origin match patterns the user enabled persistently (per-site mode). */
  persistentOrigins: z.array(z.string().max(300)).max(500),
  /**
   * Paint saved highlights on pages. Off = "quiet mode": captures still save and the side panel still
   * lists them, but nothing is published to the page's CSS.highlights registry (SECURITY_PRIVACY).
   */
  paintHighlights: z.boolean(),
  /** 'strong' adds a thicker underline per kind and a heavier fill for low-contrast displays. */
  highlightStyle: z.enum(['normal', 'strong']),
  /** Save from private (incognito) windows. Off by default: the database is shared with normal windows. */
  allowIncognitoCapture: z.boolean(),
});
export type Settings = z.infer<typeof Settings>;

export function defaultSettings(): Settings {
  return {
    schemaVersion: 1,
    theme: 'system',
    density: 'comfortable',
    toolbarEnabled: true,
    defaultKind: 'essential',
    palette: { ...DEFAULT_PALETTE },
    lastBankId: null,
    denyList: [...DEFAULT_DENY_HOSTS],
    persistentOrigins: [],
    paintHighlights: true,
    highlightStyle: 'normal',
    allowIncognitoCapture: false,
  };
}

/** Parse stored settings; any invalid or missing field falls back to its default instead of failing. */
export function parseSettings(raw: unknown): Settings {
  const defaults = defaultSettings();
  if (typeof raw !== 'object' || raw === null) return defaults;
  const r = raw as Record<string, unknown>;
  const pick = <K extends keyof Settings>(key: K): Settings[K] => {
    const parsed = Settings.shape[key].safeParse(r[key]);
    return parsed.success ? (parsed.data as Settings[K]) : defaults[key];
  };
  const palette = { ...defaults.palette };
  const storedPalette = Settings.shape.palette.safeParse(r.palette);
  if (storedPalette.success) {
    for (const kind of HIGHLIGHT_KINDS) palette[kind] = storedPalette.data[kind] ?? palette[kind];
  }
  return {
    schemaVersion: 1,
    theme: pick('theme'),
    density: pick('density'),
    toolbarEnabled: pick('toolbarEnabled'),
    defaultKind: pick('defaultKind'),
    palette,
    lastBankId: pick('lastBankId'),
    denyList: pick('denyList'),
    persistentOrigins: pick('persistentOrigins'),
    paintHighlights: pick('paintHighlights'),
    highlightStyle: pick('highlightStyle'),
    allowIncognitoCapture: pick('allowIncognitoCapture'),
  };
}
