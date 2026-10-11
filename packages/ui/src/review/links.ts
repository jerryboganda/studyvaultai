import { browser } from 'wxt/browser';

export type ReviewView = 'study' | 'exam' | 'create' | 'cards' | 'analytics' | 'settings';

export interface ReviewLink {
  view?: ReviewView;
  /** Open on this highlight in the card author (view "create"). */
  highlightId?: string;
  /** Limit the study view to one deck. */
  deckId?: string;
  /** Start (or continue) a session as soon as the page opens. */
  start?: boolean;
  /** View "exam": open the setup with this syllabus (and topic) already chosen. */
  syllabusId?: string;
  /** With `syllabusId`: the topic (and its subtopics); absent means the whole syllabus. */
  topicId?: string;
}

/** An exam setup opened on a syllabus: the whole of it (`topicId` null) or one topic and below. */
export interface ExamTarget {
  syllabusId: string;
  topicId: string | null;
}

/** Search string of a review-page address (without a leading "?"). Empty when nothing is set. */
export function reviewSearch(link: ReviewLink = {}): string {
  const q = new URLSearchParams();
  if (link.view) q.set('view', link.view);
  if (link.highlightId) q.set('highlight', link.highlightId);
  if (link.deckId) q.set('deck', link.deckId);
  if (link.start) q.set('start', '1');
  if (link.syllabusId) {
    q.set('syllabus', link.syllabusId);
    if (link.topicId) q.set('topic', link.topicId);
  }
  return q.toString();
}

/** Extension URL of the review page. Pass the result to `tabs.create`. */
export function reviewPageUrl(link: ReviewLink = {}): string {
  const q = reviewSearch(link);
  return browser.runtime.getURL(`/review.html${q ? `?${q}` : ''}` as never);
}

const VIEWS: readonly ReviewView[] = ['study', 'exam', 'create', 'cards', 'analytics', 'settings'];
const ID = /^[0-9A-Za-z_-]{8,64}$/;

/** Untrusted input from the address bar: unknown values are ignored, never trusted. */
export function parseReviewSearch(search: string): ReviewLink {
  const q = new URLSearchParams(search);
  const view = q.get('view');
  const highlight = q.get('highlight');
  const deck = q.get('deck');
  const syllabus = q.get('syllabus');
  const topic = q.get('topic');
  const syllabusId = syllabus !== null && ID.test(syllabus) ? syllabus : null;
  return {
    ...(VIEWS.includes(view as ReviewView) ? { view: view as ReviewView } : {}),
    ...(highlight !== null && ID.test(highlight) ? { highlightId: highlight } : {}),
    ...(deck !== null && ID.test(deck) ? { deckId: deck } : {}),
    ...(q.get('start') === '1' ? { start: true } : {}),
    // A topic means nothing without its syllabus.
    ...(syllabusId === null ? {} : { syllabusId }),
    ...(syllabusId !== null && topic !== null && ID.test(topic) ? { topicId: topic } : {}),
  };
}
