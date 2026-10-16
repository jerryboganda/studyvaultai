import { describe, expect, it } from 'vitest';
import { defaultSettings } from '@shared';
import { siteStatus } from '@ui/testing/fakes';
import type { GameState } from '@ui/game';
import { derivePopupState, pdfName, studyView, todayView, type DueInput } from './model';

const base = { denyList: defaultSettings().denyList };

describe('derivePopupState', () => {
  it('has no address: unsupported, without needing a status', () => {
    expect(derivePopupState({ ...base, url: undefined, status: null })).toEqual({
      kind: 'unsupported',
      reason: 'no-address',
      scheme: null,
    });
  });

  it('non-http schemes are unsupported and name the scheme', () => {
    const state = derivePopupState({ ...base, url: 'file:///C:/notes.html', status: null });
    expect(state).toEqual({ kind: 'unsupported', reason: 'scheme', scheme: 'file:' });
  });

  it('waits for the worker answer for ordinary pages', () => {
    expect(derivePopupState({ ...base, url: 'https://example.com/a', status: null })).toEqual({
      kind: 'loading',
    });
  });

  it('flags the built-in PDF viewer', () => {
    const state = derivePopupState({
      ...base,
      url: 'https://example.com/papers/cell.PDF',
      status: siteStatus(),
    });
    expect(state).toMatchObject({ kind: 'unsupported', reason: 'pdf' });
  });

  it('denied: reports which deny entries cover the host', () => {
    const state = derivePopupState({
      ...base,
      url: 'https://www.paypal.com/signin',
      status: siteStatus({ denied: true }),
    });
    expect(state).toEqual({ kind: 'denied', host: 'www.paypal.com', entries: ['paypal.com'] });
  });

  it('inactive vs active follows the content script, persistent follows access', () => {
    const url = 'https://example.com/a';
    expect(derivePopupState({ ...base, url, status: siteStatus() })).toEqual({
      kind: 'inactive',
      host: 'example.com',
      pattern: 'https://example.com/*',
      allSites: false,
    });
    expect(
      derivePopupState({
        ...base,
        url,
        status: siteStatus({ active: true, access: 'persistent' }),
      }),
    ).toMatchObject({ kind: 'active', persistent: true });
    expect(derivePopupState({ ...base, url, status: siteStatus({ active: true }) })).toMatchObject({
      kind: 'active',
      persistent: false,
    });
  });

  it('takes all-sites access from the worker, which asked Chrome, not from a stored list', () => {
    const url = 'https://example.com/a';
    expect(
      derivePopupState({ ...base, url, status: siteStatus({ allSites: true }) }),
    ).toMatchObject({ kind: 'inactive', allSites: true });
    expect(
      derivePopupState({ ...base, url, status: siteStatus({ allSites: true, active: true }) }),
    ).toMatchObject({ kind: 'active', allSites: true });
    // Chrome revoked the grant: the worker says false even if Settings still lists the patterns.
    expect(
      derivePopupState({ ...base, url, status: siteStatus({ allSites: false, active: true }) }),
    ).toMatchObject({ kind: 'active', allSites: false });
  });
});

describe('derivePopupState: PDFs', () => {
  it('a web PDF gets the reader with its address (fragment dropped), before any worker answer', () => {
    expect(
      derivePopupState({ ...base, url: 'https://example.com/a/cell.pdf#page=2', status: null }),
    ).toEqual({
      kind: 'unsupported',
      reason: 'pdf',
      scheme: null,
      reader: { src: 'https://example.com/a/cell.pdf', problem: null },
    });
  });

  it('a loopback http PDF is accepted, any other plain http is explained', () => {
    expect(
      derivePopupState({ ...base, url: 'http://127.0.0.1:8080/a.pdf', status: null }),
    ).toMatchObject({ reader: { src: 'http://127.0.0.1:8080/a.pdf', problem: null } });
    const state = derivePopupState({ ...base, url: 'http://example.com/a.pdf', status: null });
    expect(state).toMatchObject({ kind: 'unsupported', reason: 'pdf', reader: { src: null } });
    expect(JSON.stringify(state)).toMatch(/Only https addresses/);
  });

  it('a local file PDF is a pdf state without a source; a local html file is not', () => {
    expect(
      derivePopupState({ ...base, url: 'file:///C:/study/cell.pdf', status: null }),
    ).toMatchObject({
      kind: 'unsupported',
      reason: 'pdf',
      scheme: 'file:',
      reader: { src: null, problem: expect.stringMatching(/not on the web/) },
    });
    expect(derivePopupState({ ...base, url: 'file:///C:/notes.html', status: null })).toEqual({
      kind: 'unsupported',
      reason: 'scheme',
      scheme: 'file:',
    });
  });

  it('a PDF on a denied host is denied, not a reader offer', () => {
    expect(
      derivePopupState({
        ...base,
        url: 'https://paypal.com/statement.pdf',
        status: siteStatus({ denied: true }),
      }),
    ).toMatchObject({ kind: 'denied', host: 'paypal.com' });
  });
});

describe('studyView', () => {
  const total = (o: Partial<{ new: number; learning: number; review: number }> = {}) => {
    const t = { new: 0, learning: 0, review: 0, ...o };
    return { ...t, total: t.new + t.learning + t.review };
  };
  const due = (over: Partial<DueInput> & { count: number }): DueInput => ({
    summary: {
      total: total({ new: over.count }),
      deferred: { review: 0, new: 0 },
      nextLearningAt: null,
    },
    resumable: null,
    ...over,
  });

  it('is unknown (null) until the database has answered', () => {
    expect(studyView({ count: null, summary: null, resumable: null })).toBeNull();
  });

  it('due cards: the count, the mix, and a primary Start review', () => {
    const view = studyView({
      count: 12,
      summary: {
        total: total({ new: 3, learning: 2, review: 7 }),
        deferred: { review: 0, new: 0 },
        nextLearningAt: null,
      },
      resumable: null,
    })!;
    expect(view.badge).toBe('12 cards due');
    expect(view.count).toBe(12);
    expect(view.detail).toBe('3 new · 2 learning · 7 review');
    expect(view.action).toEqual({
      label: 'Start review',
      primary: true,
      link: { view: 'study', start: true },
    });
    expect(studyView(due({ count: 1 }))!.badge).toBe('1 card due');
  });

  it('a saved session is continued, with what is left', () => {
    const view = studyView(due({ count: 0, resumable: { remaining: 5, answered: 2 } }))!;
    expect(view.action.label).toBe('Continue review');
    expect(view.detail).toMatch(/^5 left/);
    expect(view.badge).toBe('Session in progress');
    expect(view.count).toBeNull();
    const withDue = studyView(due({ count: 4, resumable: { remaining: 5, answered: 2 } }))!;
    expect(withDue).toMatchObject({ badge: '4 cards due', count: 4 });
  });

  it('nothing due: says so and no longer promises to start something', () => {
    const none = studyView({
      count: 0,
      summary: { total: total(), deferred: { review: 0, new: 0 }, nextLearningAt: null },
      resumable: null,
    })!;
    expect(none.badge).toBe('No flashcards yet');
    expect(none.count).toBeNull(); // never a zero
    expect(none.detail).toMatch(/Make a card from a saved highlight/);
    expect(none.action).toMatchObject({ label: 'Open review', primary: false });

    const beyond = studyView({
      count: 0,
      summary: { total: total(), deferred: { review: 4, new: 1 }, nextLearningAt: null },
      resumable: null,
    })!;
    expect(beyond.badge).toBe('Nothing due now');
    expect(beyond.detail).toMatch(/5 more cards due beyond today's limits/);

    const later = studyView({
      count: 0,
      summary: {
        total: total(),
        deferred: { review: 0, new: 0 },
        nextLearningAt: '2026-10-11T12:00:00.000Z',
      },
      resumable: null,
    })!;
    expect(later.badge).toBe('Nothing due now');
    expect(later.detail).toMatch(/learning step comes back later today/);
  });
});

describe('pdfName', () => {
  it('is the file name, decoded; else the host; else "PDF"', () => {
    expect(pdfName('https://example.com/papers/cell%20bio.pdf#page=2')).toBe('cell bio.pdf');
    expect(pdfName('https://example.com/')).toBe('example.com');
    expect(pdfName('https://example.com/a/%E0%A4%A.pdf')).toBe('%E0%A4%A.pdf'); // bad escape kept
    expect(pdfName('file:///C:/study/notes.pdf')).toBe('notes.pdf');
    expect(pdfName(undefined)).toBe('PDF');
  });
});

describe('todayView', () => {
  const backfill = { status: 'done' as const, done: 10, total: 10, error: null };
  const ready = (over: { mode?: boolean; xp?: number; met?: boolean } = {}) =>
    ({
      ready: true,
      mode: over.mode ?? true,
      backfill,
      goal: { value: 30, chosen: true },
      today: {
        dayKey: '2026-10-14',
        xp: over.xp ?? 18,
        met: over.met ?? false,
        reviews: 8,
        saves: 3,
        cards: 0,
        sessions: 1,
      },
      totalXp: 400,
      level: { level: 3, floorXp: 150, nextXp: 300 },
      streak: { current: 12, longest: 20, todayCounts: false, freezes: 1 },
      badges: [],
      days: [],
      pending: [],
    }) as unknown as GameState;

  it('is loading without an answer, and shows only real progress while counting', () => {
    expect(todayView(undefined)).toEqual({ kind: 'loading' });
    expect(
      todayView({
        ready: false,
        mode: true,
        backfill: { ...backfill, status: 'running', done: 4 },
      }),
    ).toEqual({ kind: 'counting', done: 4, total: 10 });
    expect(
      todayView({
        ready: false,
        mode: true,
        backfill: { ...backfill, status: 'failed', error: 'Disk full' },
      }),
    ).toEqual({ kind: 'count-failed', message: 'Disk full' });
  });

  it('Game mode on: XP to goal, streak and level; past the goal it says met', () => {
    expect(todayView(ready())).toEqual({
      kind: 'game',
      xp: 18,
      goal: 30,
      toGo: 12,
      met: false,
      streak: 12,
      level: 3,
    });
    expect(todayView(ready({ xp: 41, met: true }))).toMatchObject({ toGo: 0, met: true });
  });

  it('Game mode off: plain counts, no XP', () => {
    expect(todayView(ready({ mode: false }))).toEqual({ kind: 'plain', reviews: 8, saves: 3 });
  });
});
