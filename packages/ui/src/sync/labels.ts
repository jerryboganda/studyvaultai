import type { RejectReason, SyncStatus } from '@sync';

/** Plain-language names. Unknown values fall back to the raw identifier so nothing is hidden. */

const ENTITY: Record<string, string> = {
  highlights: 'Highlight',
  sources: 'Page',
  banks: 'Bank',
  folders: 'Folder',
  tags: 'Tag',
  notes: 'Note',
  highlightBanks: 'Bank membership',
  highlightTags: 'Tag on a highlight',
  filingRules: 'Auto-filing rule',
  syllabi: 'Syllabus',
  relations: 'Link between items',
  knowledgePoints: 'Knowledge point',
  decks: 'Deck',
  cards: 'Flashcard',
  reviewLogs: 'Review record',
  documents: 'PDF',
  ocrPages: 'Scanned page text',
  gameFacts: 'Goal, streak and XP record',
};

const FIELD: Record<string, string> = {
  userComment: 'Your comment',
  customFields: 'Custom fields',
  body: 'Text',
  title: 'Title',
  name: 'Name',
  front: 'Front',
  back: 'Back',
  explanation: 'Explanation',
  shortOneLiner: 'One-liner',
  examPearl: 'Exam pearl',
  misconception: 'Common misconception',
  claims: 'Claims',
  correctedText: 'Corrected text',
  description: 'Description',
  settings: 'Settings',
};

export const entityLabel = (type: string | null) =>
  type ? (ENTITY[type] ?? type) : 'Unknown item';
export const fieldLabel = (field: string | null) =>
  field ? (FIELD[field] ?? field) : 'Whole item';

export const REASON_TEXT: Record<RejectReason, string> = {
  invalid_op: 'It does not follow the sync format, so it was not used.',
  immutable_field:
    'It tried to change protected source text (a saved quote or where it came from). Source text is never rewritten.',
  unknown_entity_type:
    'It is a kind of item this version does not synchronise (for example from a newer version of StudyVault).',
  unknown_field:
    'It contains information this version does not understand yet. Updating StudyVault may allow it.',
  schema_invalid: 'It did not pass the data checks of this version.',
  decrypt_failed:
    'It could not be authenticated with your key, so it was not trusted. It may have been altered.',
  locked: 'It is encrypted. Enter your sync passphrase to read it.',
  plaintext_in_e2ee:
    'It arrived unencrypted although this account uses end-to-end encryption, so it was refused.',
  clock_skew: 'It is stamped far in the future. Check the date and time of every device.',
  awaiting_create: 'It is waiting for the item it belongs to, which has not arrived yet.',
};

export const STATUS_TEXT: Record<SyncStatus, string> = {
  disabled: 'Sync is off.',
  idle: 'Up to date.',
  syncing: 'Syncing…',
  offline:
    'The server cannot be reached. Changes stay on this device and are sent when it is reachable.',
  backoff: 'The server asked StudyVault to slow down. It will try again shortly.',
  auth_required: 'Sign in to sync.',
  locked: 'Locked. Enter your sync passphrase to continue.',
  awaiting_encryption_choice:
    'Signed in. Nothing has been uploaded yet: choose how your data is protected first.',
  resync_required:
    "The server's data was erased, restored or replaced. Nothing was changed on this device.",
  account_mismatch: 'This device holds data that belongs to a different account.',
  error: 'Sync ran into a problem.',
};
