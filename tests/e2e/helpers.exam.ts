import type { Locator, Page } from '@playwright/test';
import { expect, readStudyDb, type CardRow } from './helpers.review';

/**
 * Helpers for exam.spec.ts (exam simulation, ADR-020). Real Chromium, the real built extension,
 * real input. Nothing is mocked; the database is only READ, to assert what was persisted.
 *
 * Test ids are copied from packages/ui/src/review/testids.ts on purpose (nothing is imported from
 * the product, so a renamed id fails the spec instead of silently following it).
 */

export const XID = {
  setup: 'rv-exam-setup',
  scope: 'rv-exam-scope',
  questions: 'rv-exam-questions',
  timed: 'rv-exam-timed',
  minutes: 'rv-exam-minutes',
  shuffle: 'rv-exam-shuffle',
  start: 'rv-exam-start',
  continue: 'rv-exam-continue',
  discard: 'rv-exam-discard',
  run: 'rv-exam-run',
  timer: 'rv-exam-timer',
  announce: 'rv-exam-announce',
  progress: 'rv-exam-progress',
  question: 'rv-exam-question',
  choices: 'rv-exam-choices',
  text: 'rv-exam-text',
  prev: 'rv-exam-prev',
  next: 'rv-exam-next',
  finish: 'rv-exam-finish',
  leave: 'rv-exam-leave',
  marking: 'rv-exam-marking',
  markRest: 'rv-exam-mark-rest',
  showResults: 'rv-exam-show-results',
  results: 'rv-exam-results',
  score: 'rv-exam-score',
  banks: 'rv-exam-banks',
  tags: 'rv-exam-tags',
  times: 'rv-exam-times',
  missed: 'rv-exam-missed',
  export: 'rv-exam-export',
  count: 'rv-exam-count',
  countStatus: 'rv-exam-count-status',
  close: 'rv-exam-close',
  history: 'rv-exam-history',
  historyClear: 'rv-exam-history-clear',
} as const;

export const missedId = (index: number) => `rv-exam-missed-${index}`;
export const jumpId = (index: number) => `rv-exam-jump-${index}`;

/** The exam as stored in the device-local meta table. */
export interface StoredExam {
  version: number;
  id: string;
  phase: 'answering' | 'marking' | 'finished';
  scopeLabel: string;
  minutes: number | null;
  startedAt: string;
  deadlineAt: string | null;
  endedAt: string | null;
  endReason: 'submitted' | 'timeup' | null;
  finishedAt: string | null;
  expiresAt: string;
  current: number;
  questions: Array<{
    cardId: string;
    kind: 'mcq' | 'recall';
    choiceId: string | null;
    text: string;
    mark: 'know' | 'dont' | null;
    spentMs: number;
  }>;
  outcomes: Array<'correct' | 'wrong' | 'unanswered' | 'void'> | null;
  review: {
    at: string;
    logs: Array<{ cardId: string; logId: string; rating: number }>;
    skipped: number;
    undoneAt: string | null;
  } | null;
}

export interface StoredHistory {
  id: string;
  scopeLabel: string;
  total: number;
  correct: number;
  wrong: number;
  unanswered: number;
  void: number;
  minutes: number | null;
  timedOut: boolean;
  countedAsReview: boolean;
}

/** Raw read of the exam rows of the `meta` table (never upgrades, never writes). */
export async function readExamMeta(
  page: Page,
): Promise<{ session: StoredExam | null; history: StoredHistory[] }> {
  return page.evaluate(async () => {
    const known = await indexedDB.databases();
    if (!known.some((d) => d.name === 'studyvault')) return { session: null, history: [] };
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('studyvault');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      const rows = await new Promise<Array<{ key: string; value: unknown }>>((resolve, reject) => {
        const req = db.transaction('meta', 'readonly').objectStore('meta').getAll();
        req.onsuccess = () => resolve(req.result as Array<{ key: string; value: unknown }>);
        req.onerror = () => reject(req.error);
      });
      return {
        session: (rows.find((r) => r.key === 'examSession')?.value ?? null) as never,
        history: (rows.find((r) => r.key === 'examHistory')?.value ?? []) as never,
      };
    } finally {
      db.close();
    }
  });
}

/** The studied state of every live card, to prove an exam left the schedule alone. */
export async function scheduleOf(page: Page): Promise<Record<string, CardRow['fsrs']>> {
  const db = await readStudyDb(page);
  return Object.fromEntries(
    db.cards.filter((c) => c.deletedAt === null).map((c) => [c.id, c.fsrs] as const),
  );
}

export async function openExamTab(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Exam', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Exam', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByTestId(XID.setup)).toBeVisible();
}

export interface StartOptions {
  /** Start of the scope's option text, e.g. "Bank: Cardiology". Default: all cards. */
  scope?: string;
  questions?: number;
  /** A time limit in minutes; omitted for none. */
  minutes?: number;
  /** Default false here so the order is the creation order (a test can then rely on it). */
  shuffle?: boolean;
}

/** Fill the setup form and press "Start exam". Waits for the first question. */
export async function startExam(page: Page, opts: StartOptions = {}): Promise<void> {
  const setup = page.getByTestId(XID.setup);
  await expect(setup).toBeVisible();
  if (opts.scope !== undefined) {
    const select = setup.getByTestId(XID.scope);
    const value = await select.evaluate(
      (el, prefix) =>
        [...(el as HTMLSelectElement).options].find((o) => o.textContent?.startsWith(prefix))
          ?.value ?? '',
      opts.scope,
    );
    expect(value, `scope option "${opts.scope}"`).not.toBe('');
    await select.selectOption(value);
  }
  if (opts.questions !== undefined) {
    await setup.getByTestId(XID.questions).fill(String(opts.questions));
  }
  const shuffle = setup.getByTestId(XID.shuffle);
  if (opts.shuffle === true) await shuffle.check();
  else await shuffle.uncheck();
  const timed = setup.getByTestId(XID.timed);
  if (opts.minutes !== undefined) {
    await timed.check();
    await setup.getByTestId(XID.minutes).fill(String(opts.minutes));
  } else {
    await timed.uncheck();
  }
  await setup.getByTestId(XID.start).click();
  await expect(page.getByTestId(XID.run)).toBeVisible();
}

export const heading = (page: Page): Locator =>
  page.getByRole('heading', { level: 2, name: /^Question \d+ of \d+$/ });

export interface Rule {
  /** Text that identifies the question on screen. */
  match: string;
  /** Pick this option (multiple choice). */
  option?: string;
  /** Type this (recall). */
  text?: string;
}

/**
 * Walk the questions from the current one to the last, applying the first rule whose `match` is in
 * the question text. Returns the question texts in the order they were shown.
 */
export async function walkExam(page: Page, rules: readonly Rule[]): Promise<string[]> {
  const shown: string[] = [];
  const first = (await heading(page).textContent()) ?? '';
  const [at, total] = (/Question (\d+) of (\d+)/.exec(first) ?? []).slice(1).map(Number) as [
    number,
    number,
  ];
  for (let n = at; n <= total; n++) {
    await expect(heading(page)).toHaveText(`Question ${n} of ${total}`);
    const body = (await page.getByTestId(XID.question).textContent()) ?? '';
    shown.push(body);
    const rule = rules.find((r) => body.includes(r.match));
    if (rule?.option !== undefined) {
      await page.getByRole('radio', { name: rule.option, exact: true }).check();
    }
    if (rule?.text !== undefined) await page.getByTestId(XID.text).fill(rule.text);
    if (n < total) await page.getByTestId(XID.next).click();
  }
  return shown;
}

/** "Finish exam" and its confirmation. */
export async function finishExam(page: Page): Promise<void> {
  await page.getByTestId(XID.finish).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Finish exam', exact: true }).click();
}

export async function expectNoFeedback(page: Page, hidden: readonly string[]): Promise<void> {
  const run = page.getByTestId(XID.run);
  for (const text of hidden) await expect(run).not.toContainText(text);
  await expect(run).not.toContainText(/correct answer|Correct\b|Wrong\b|Your answer was/i);
}

/** "I knew it" or "I did not know it" for question number `n` (1-based, as shown). */
export async function markQuestion(page: Page, n: number, mark: 'know' | 'dont'): Promise<void> {
  const name = mark === 'know' ? `I knew it (question ${n})` : `I did not know it (question ${n})`;
  await page.getByRole('radio', { name, exact: true }).check();
}
