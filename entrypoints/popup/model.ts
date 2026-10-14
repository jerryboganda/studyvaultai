import type { SiteStatus } from '@shared';
import { parseSrc } from '@pdf/readerUrl';
import type { GameState } from '@ui/game';
import { classifyAddress } from '@ui/hosts';
import type { ReviewLink } from '@ui/review/links';
import { plural } from '@ui/text';

/**
 * Popup view model: what the active tab's address and the worker's `site.status` answer mean for
 * the user. Pure so every branch is testable without Chrome.
 */

/** What the popup can offer for a PDF tab: open it in StudyVault's own reader, or say why not. */
export interface PdfReaderOffer {
  /** The address to hand to the reader (`?src=`). Null when the reader cannot fetch this one. */
  src: string | null;
  /** In plain words why `src` is null. */
  problem: string | null;
}

export type PopupState =
  /** `site.status` has not answered yet. */
  | { kind: 'loading' }
  /** Chrome did not share an address (browser page, or no access to this tab yet), or it is not http(s). */
  | { kind: 'unsupported'; reason: 'no-address' | 'scheme'; scheme: string | null }
  /** A PDF in Chrome's built-in viewer: no extension can mark it up, StudyVault's reader can. */
  | { kind: 'unsupported'; reason: 'pdf'; scheme: string | null; reader: PdfReaderOffer }
  | { kind: 'denied'; host: string; entries: string[] }
  | { kind: 'inactive'; host: string; pattern: string; allSites: boolean }
  /**
   * StudyVault is running in this tab. `persistent`: the site is enabled for every visit.
   * `allSites`: Chrome grants all-sites access right now (the worker's answer, not a stored setting).
   */
  | { kind: 'active'; host: string; pattern: string; persistent: boolean; allSites: boolean };

export function derivePopupState(input: {
  url: string | undefined;
  status: SiteStatus | null;
  denyList: readonly string[];
}): PopupState {
  const { url, status, denyList } = input;
  const address = classifyAddress(url, denyList);
  if (address.kind === 'no-address') {
    return { kind: 'unsupported', reason: 'no-address', scheme: null };
  }
  if (address.kind === 'unsupported') {
    // A PDF that is not a web address (a file on this computer): the reader cannot fetch it, but
    // the person can choose the file in the reader.
    if (url && pathEndsInPdf(url)) {
      return {
        kind: 'unsupported',
        reason: 'pdf',
        scheme: address.scheme,
        reader: {
          src: null,
          problem: `This PDF is not on the web (it is a ${address.scheme} address), so StudyVault cannot fetch it from here. Open the reader and choose the file from your computer.`,
        },
      };
    }
    return { kind: 'unsupported', reason: 'scheme', scheme: address.scheme };
  }
  // A web PDF needs no answer from the worker: Chrome's viewer is out of reach whatever it says.
  if (address.kind === 'pdf') {
    const check = url ? parseSrc(url) : null;
    return {
      kind: 'unsupported',
      reason: 'pdf',
      scheme: null,
      reader: check?.ok
        ? { src: check.url, problem: null }
        : { src: null, problem: check?.message ?? 'This address cannot be opened in the reader.' },
    };
  }
  if (status === null) return { kind: 'loading' };
  if (!status.supported) return { kind: 'unsupported', reason: 'scheme', scheme: null };

  // The worker's verdict wins: it is what injection will enforce.
  const host = address.host;
  if (status.denied) {
    return { kind: 'denied', host, entries: address.kind === 'denied' ? address.entries : [] };
  }
  const pattern = status.pattern ?? '';
  // Not settings.persistentOrigins: Chrome can revoke the grant behind the stored list's back.
  const { allSites } = status;
  if (status.active) {
    return { kind: 'active', host, pattern, persistent: status.access === 'persistent', allSites };
  }
  return { kind: 'inactive', host, pattern, allSites };
}

function pathEndsInPdf(url: string): boolean {
  try {
    return /\.pdf$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** The PDF's file name for the site card ("cell.pdf"), else its host, else "PDF". */
export function pdfName(url: string | undefined): string {
  try {
    const u = new URL(url ?? '');
    const last = u.pathname.split('/').filter(Boolean).pop();
    if (!last) return u.hostname || 'PDF';
    try {
      return decodeURIComponent(last);
    } catch {
      return last; // a malformed %-escape: show it as it is
    }
  } catch {
    return 'PDF';
  }
}

// ---------------------------------------------------------------------------------------------
// Today in the header (game layer, ADR-022)
// ---------------------------------------------------------------------------------------------

export type TodayView =
  /** No answer yet. */
  | { kind: 'loading' }
  /** The ledger is being built from history: real progress only, never a partial number. */
  | { kind: 'counting'; done: number; total: number }
  | { kind: 'count-failed'; message: string }
  /** Game mode on: today's XP against the goal, the streak and the level. */
  | {
      kind: 'game';
      xp: number;
      goal: number;
      toGo: number;
      met: boolean;
      streak: number;
      level: number;
    }
  /** Game mode off: plain counts, no XP. */
  | { kind: 'plain'; reviews: number; saves: number };

export function todayView(state: GameState | undefined): TodayView {
  if (!state) return { kind: 'loading' };
  if (!state.ready) {
    const { status, done, total, error } = state.backfill;
    return status === 'failed'
      ? { kind: 'count-failed', message: error ?? 'Could not count your XP.' }
      : { kind: 'counting', done, total };
  }
  if (!state.mode) return { kind: 'plain', reviews: state.today.reviews, saves: state.today.saves };
  const goal = state.goal.value;
  const xp = state.today.xp;
  return {
    kind: 'game',
    xp,
    goal,
    toGo: Math.max(0, goal - xp),
    met: state.today.met,
    streak: state.streak.current,
    level: state.level.level,
  };
}

// ---------------------------------------------------------------------------------------------
// Study bar
// ---------------------------------------------------------------------------------------------

export interface DueInput {
  /** Cards that can be studied now under today's limits; null until known. */
  count: number | null;
  summary: {
    total: { new: number; learning: number; review: number; total: number };
    deferred: { review: number; new: number };
    nextLearningAt: string | null;
  } | null;
  /** A saved session with cards still to show. */
  resumable: { remaining: number; answered: number } | null;
}

export interface StudyView {
  /** The badge: only ever a number the database reported, or a plain statement. */
  badge: string;
  /** Cards due when there are any: the badge shows only this number, the rest is read out. */
  count: number | null;
  /** Muted line under the badge, or null. */
  detail: string | null;
  /** The review button: what it does is what it says. */
  action: { label: string; primary: boolean; link: ReviewLink };
}

/**
 * What the study bar of the popup says. Nothing is invented: with nothing due the badge says so and
 * the button no longer promises to "start" anything, and a person with no cards at all is told how
 * to get the first one instead of being shown a zero.
 */
export function studyView(due: DueInput): StudyView | null {
  if (due.count === null || due.summary === null) return null;
  const { total, deferred, nextLearningAt } = due.summary;
  const beyond = deferred.review + deferred.new;
  if (due.resumable) {
    const left = due.resumable.remaining;
    return {
      badge: due.count > 0 ? `${plural(due.count, 'card')} due` : 'Session in progress',
      count: due.count > 0 ? due.count : null,
      detail: `${left} left in the session you started.`,
      action: { label: 'Continue review', primary: true, link: { view: 'study', start: true } },
    };
  }
  if (due.count > 0) {
    return {
      badge: `${plural(due.count, 'card')} due`,
      count: due.count,
      detail: `${total.new} new · ${total.learning} learning · ${total.review} review`,
      action: { label: 'Start review', primary: true, link: { view: 'study', start: true } },
    };
  }
  const nothingAtAll = beyond === 0 && nextLearningAt === null;
  return {
    badge: nothingAtAll ? 'No flashcards yet' : 'Nothing due now',
    count: null,
    detail: nothingAtAll
      ? 'Make a card from a saved highlight to start.'
      : beyond > 0
        ? `${plural(beyond, 'more card')} due beyond today's limits; they stay due.`
        : 'A learning step comes back later today.',
    action: { label: 'Open review', primary: false, link: { view: 'study' } },
  };
}
