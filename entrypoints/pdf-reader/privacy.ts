import { browser } from 'wxt/browser';
import { INCOGNITO_CAPTURE_REFUSAL } from '@shared';

/**
 * Which kind of window the reader is in, and what it may therefore write. The database is shared
 * with normal windows, so a private window stores nothing unless the person turned on "Save from
 * private windows" (SECURITY_PRIVACY, ADR-003). The decision is made here and enforced twice: by the
 * reader (so the page says what is happening) and by the storage write path (so nothing the page
 * does can get around it).
 *
 * `extension.inIncognitoContext` is not the answer: Chrome sets it for extension pages only in
 * split-mode extensions, and this one spans, so it is always false. The window is asked instead.
 */

export type WindowPrivacy = 'private' | 'normal' | 'unknown';

type Located = { incognito?: boolean } | null | undefined;

/** The slice of the extension API this needs; `browser` satisfies it, tests pass their own. */
export interface PrivacyApi {
  extension?: { inIncognitoContext?: boolean };
  tabs?: { getCurrent?: () => Promise<Located> };
  windows?: { getCurrent?: () => Promise<Located> };
}

export const UNKNOWN_WINDOW_REFUSAL =
  'StudyVault could not tell whether this window is private, so it does not save anything from this PDF. Turn on "Save from private windows" in StudyVault settings to save anyway.';

/**
 * `hint` is `?incognito=1` from the menu that opened the reader. It can only make the answer more
 * careful: any source saying "private" wins; "unknown" (no source could answer) is kept apart from
 * "normal" so a failure to ask never reads as permission.
 */
export async function detectWindowPrivacy(
  hint: boolean,
  api: PrivacyApi = browser,
): Promise<WindowPrivacy> {
  if (hint || api.extension?.inIncognitoContext === true) return 'private';
  const askers: Array<() => Promise<Located> | undefined> = [
    () => api.tabs?.getCurrent?.(),
    () => api.windows?.getCurrent?.(),
  ];
  for (const ask of askers) {
    try {
      const where = await ask();
      if (typeof where?.incognito === 'boolean') return where.incognito ? 'private' : 'normal';
    } catch {
      /* try the next source */
    }
  }
  return 'unknown';
}

/** One answer per page load, shared by the reader and the storage restriction. */
export function onceWindowPrivacy(hint: boolean, api?: PrivacyApi): () => Promise<WindowPrivacy> {
  let answer: Promise<WindowPrivacy> | undefined;
  return () => (answer ??= detectWindowPrivacy(hint, api));
}

/** Why writes are restricted for this answer; null when they are not. */
export function refusalFor(privacy: WindowPrivacy): string | null {
  if (privacy === 'normal') return null;
  return privacy === 'private' ? INCOGNITO_CAPTURE_REFUSAL : UNKNOWN_WINDOW_REFUSAL;
}

export interface WritePolicy {
  /** The document, its highlights, recognised text and a kept copy may be written. */
  persist: boolean;
  /** What to tell the person when `persist` is false; null while the window is still being checked. */
  reason: string | null;
}

/** `privacy` null: not known yet. Until it is, nothing is written and nothing is announced. */
export function writePolicy(
  privacy: WindowPrivacy | null,
  allowIncognitoCapture: boolean,
): WritePolicy {
  if (allowIncognitoCapture) return { persist: true, reason: null };
  if (privacy === null) return { persist: false, reason: null };
  const reason = refusalFor(privacy);
  return { persist: reason === null, reason };
}
