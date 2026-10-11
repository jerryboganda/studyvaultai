/** Version of the persisted domain schema (IndexedDB records). Bump with a Dexie migration. */
export const SCHEMA_VERSION = 1 as const;

/** Version of the text-stream algorithm used for anchors; stored on every anchor. */
export const TEXT_ALGORITHM = 'sv-text-v1' as const;
/** Page text-stream algorithm of the PDF reader (page text items, whitespace-collapsed). */
export const PDF_TEXT_ALGORITHM = 'sv-pdf-text-v1' as const;

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
  correction: { label: 'Correction (checked by you)', glyph: '✓' },
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

/** Why a capture from a private window is refused while settings.allowIncognitoCapture is off. */
export const INCOGNITO_CAPTURE_REFUSAL =
  'StudyVault does not save from private (incognito) windows. Turn on "Save from private windows" in StudyVault settings to allow it.';

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
 * What the default deny list is, in words the UI can show next to it. It is a starter list of
 * well-known hosts, not a guarantee: banks, health portals and employers' sign-in pages differ by
 * country and organisation, and the user is expected to add their own.
 */
export const DENY_LIST_SCOPE_NOTE =
  'A starter list of common sign-in, mail, payment, bank and health-portal sites; banks vary by country - add yours.';

/**
 * STARTER deny list (SECURITY_PRIVACY): hosts where capture is off until the user removes them.
 * Entries match the host and every subdomain. Well-known sign-in, mail, payment, bank and
 * health-portal sites only; it is deliberately not presented as complete (DENY_LIST_SCOPE_NOTE).
 * Every entry must satisfy DENY_HOST (lowercase hostname) so it can become an excludeMatches pattern.
 */
export const DEFAULT_DENY_HOSTS: readonly string[] = [
  // Sign-in / identity providers and government sign-in
  'accounts.google.com',
  'login.microsoftonline.com',
  'login.live.com',
  'appleid.apple.com',
  'account.microsoft.com',
  'login.yahoo.com',
  'signin.aws.amazon.com',
  'id.atlassian.com',
  'auth0.com',
  'okta.com',
  'login.gov',
  'id.me',
  'account.gov.uk',
  'my.gov.au',
  // Web mail
  'mail.google.com',
  'outlook.live.com',
  'outlook.office.com',
  'outlook.office365.com',
  'outlook.com',
  'mail.yahoo.com',
  'mail.aol.com',
  'mail.proton.me',
  'account.proton.me',
  'protonmail.com',
  'mail.zoho.com',
  'icloud.com',
  'fastmail.com',
  // Payments and wallets
  'paypal.com',
  'venmo.com',
  'cash.app',
  'wise.com',
  'dashboard.stripe.com',
  'checkout.stripe.com',
  'pay.google.com',
  'payments.google.com',
  'squareup.com',
  // Banks and brokerages: United States
  'chase.com',
  'bankofamerica.com',
  'wellsfargo.com',
  'citi.com',
  'usbank.com',
  'capitalone.com',
  'americanexpress.com',
  'schwab.com',
  'fidelity.com',
  'usaa.com',
  // United Kingdom
  'barclays.co.uk',
  'hsbc.co.uk',
  'lloydsbank.com',
  'natwest.com',
  'santander.co.uk',
  'nationwide.co.uk',
  'monzo.com',
  // Europe
  'ing.com',
  'n26.com',
  'deutsche-bank.de',
  'commerzbank.de',
  'bnpparibas.com',
  'rabobank.nl',
  // India
  'hdfcbank.com',
  'icicibank.com',
  'axisbank.com',
  'onlinesbi.sbi',
  'kotak.com',
  // Australia
  'commbank.com.au',
  'westpac.com.au',
  'anz.com.au',
  'nab.com.au',
  // Canada
  'rbc.com',
  'rbcroyalbank.com',
  'td.com',
  'scotiabank.com',
  'bmo.com',
  'cibc.com',
  // Health-record and insurance member portals
  'mychart.com',
  'followmyhealth.com',
  'kp.org',
  'myhealth.va.gov',
  'login.nhs.uk',
  'patientaccess.com',
  // Browser store pages (extensions cannot run there anyway)
  'chromewebstore.google.com',
  'chrome.google.com',
];
