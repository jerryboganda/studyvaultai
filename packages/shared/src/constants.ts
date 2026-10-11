/** Version of the persisted domain schema (IndexedDB records). Bump with a Dexie migration. */
export const SCHEMA_VERSION = 1 as const;

/** Version of the text-stream algorithm used for anchors; stored on every anchor. */
export const TEXT_ALGORITHM = 'sv-text-v1' as const;

export const MAX_QUOTE_CHARS = 10_000;
export const MAX_CONTEXT_CHARS = 64;
export const MAX_COMMENT_CHARS = 20_000;
export const MAX_TITLE_CHARS = 500;
export const MAX_URL_CHARS = 2048;
export const MAX_HEADING_CHARS = 300;
export const MAX_BANK_NAME_CHARS = 80;

/** Semantic highlight kinds (PRD "Customization"). Each has a label + glyph so colour is never the only cue. */
export const HIGHLIGHT_KINDS = [
  'essential',
  'formula',
  'exception',
  'differential',
  'weak_area',
  'correction',
  'question',
] as const;

export const COLOR_IDS = ['amber', 'blue', 'red', 'purple', 'orange', 'green', 'teal'] as const;

export const KIND_LABELS: Record<
  (typeof HIGHLIGHT_KINDS)[number],
  { label: string; glyph: string }
> = {
  essential: { label: 'Essential fact', glyph: '★' },
  formula: { label: 'Formula', glyph: 'ƒ' },
  exception: { label: 'Exception', glyph: '!' },
  differential: { label: 'Differential', glyph: '≠' },
  weak_area: { label: 'Weak area', glyph: '▽' },
  correction: { label: 'Verified correction', glyph: '✓' },
  question: { label: 'Question', glyph: '?' },
};

export const DEFAULT_PALETTE: Record<(typeof HIGHLIGHT_KINDS)[number], (typeof COLOR_IDS)[number]> =
  {
    essential: 'amber',
    formula: 'blue',
    exception: 'red',
    differential: 'purple',
    weak_area: 'orange',
    correction: 'green',
    question: 'teal',
  };

/** chrome.storage.session key: {highlightId, at} handed from the service worker to the side panel. */
export const PENDING_FOCUS_KEY = 'sv.pendingFocus';

/** Name of the always-present default bank that quick-save falls back to. */
export const INBOX_BANK_NAME = 'Inbox';
/** Fixed id so concurrent first-run creation, restores and imports can never produce two Inboxes. */
export const INBOX_BANK_ID = 'inbox-default';

/** Highlight paint per colour: `bg` is the translucent in-page fill, `solid` is for swatches/chips. */
export const COLOR_SWATCH: Record<(typeof COLOR_IDS)[number], { bg: string; solid: string }> = {
  amber: { bg: 'rgba(251, 191, 36, 0.45)', solid: '#f59e0b' },
  blue: { bg: 'rgba(96, 165, 250, 0.40)', solid: '#3b82f6' },
  red: { bg: 'rgba(248, 113, 113, 0.40)', solid: '#ef4444' },
  purple: { bg: 'rgba(167, 139, 250, 0.40)', solid: '#8b5cf6' },
  orange: { bg: 'rgba(251, 146, 60, 0.42)', solid: '#f97316' },
  green: { bg: 'rgba(74, 222, 128, 0.40)', solid: '#22c55e' },
  teal: { bg: 'rgba(45, 212, 191, 0.40)', solid: '#14b8a6' },
};

/**
 * Hosts where capture is off unless the user explicitly removes them from the deny list
 * (SECURITY_PRIVACY: banks, payment, mail, health records, auth providers). Subdomains included.
 */
export const DEFAULT_DENY_HOSTS: readonly string[] = [
  'accounts.google.com',
  'login.microsoftonline.com',
  'login.live.com',
  'appleid.apple.com',
  'mail.google.com',
  'outlook.live.com',
  'outlook.office.com',
  'outlook.office365.com',
  'paypal.com',
  'chromewebstore.google.com',
  'chrome.google.com',
];
