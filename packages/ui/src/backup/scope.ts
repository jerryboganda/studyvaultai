/**
 * What a backup file holds and what it leaves out, in one place so the export panel, the restore
 * wizard and the readable-export hint say the same thing.
 *
 * Source of truth: a backup is the database tables of the vault minus `BACKUP_EXCLUDED_TABLES`
 * (`meta`, `syncOps`). Settings live in `chrome.storage.local` and in the `meta` table, and neither
 * is exported or restored (ADR-010, "Where a setting lives").
 */

/** Title of the full-backup panel (the restore panel and the readable exports refer to it). */
export const BACKUP_TITLE = 'Back up your study data';

/** What is in the file. */
export const BACKUP_HOLDS =
  'your banks, folders, tags, highlights (each quote with its source and location, exactly as saved), notes, decks and flashcards with their review history, auto-filing rules, syllabi, links between items, text read from PDFs by OCR, saved AI drafts, and XP, daily goal and game history';

/** What is not in the file, and therefore not touched by a restore. */
export const BACKUP_LEAVES_OUT =
  'your settings (blocked sites, appearance, the study-day time zone and queue order, the study reminder), the AI provider, address, key and usage (fallback providers and their keys included), the sync account and its queue, saved searches, the coverage thresholds of your syllabi, an exam in progress and your exam history, the backup folder you chose and its last-backup status, auto-filing suggestions that are waiting, a review session that is in progress, and which celebrations this device has already shown';
