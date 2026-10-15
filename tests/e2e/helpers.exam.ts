import type { Locator, Page } from '@playwright/test';
import { expect, pick, readStudyDb, type CardRow } from './helpers.review';

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
  minutes: 'rv-exam-minutes',
  shuffle: 'rv-exam-shuffle',
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
  // exam over a syllabus
  source: 'rv-exam-source',
  syllabus: 'rv-exam-syllabus',
  topic: 'rv-exam-topic',
  weighted: 'rv-exam-weighted',
  plan: 'rv-exam-plan',
  syllabusNote: 'rv-exam-syllabus-note',
  leftOut: 'rv-exam-left-out',
  topics: 'rv-exam-topics',
} as const;

export const missedId = (index: number) => `rv-exam-missed-${index}`;
export const jumpId = (index: number) => `rv-exam-jump-${index}`;
/** "Study this topic" in the results, and "Exam on this topic" in the coverage table. */
export const studyTopicId = (topicId: string) => `rv-exam-study-${topicId}`;
export const examOnTopicId = (topicId: string) => `rv-syllabus-exam-${topicId}`;

/** The exam as stored in the device-local meta table. */
export interface StoredExam {
  version: number;
  id: string;
  phase: 'answering' | 'marking' | 'finished';
  scopeLabel: string;
  scope: { kind: string; syllabusId?: string; topicId?: string | null; weighted?: boolean };
  syllabus: {
    topics: Array<{ id: string; title: string }>;
    skipped: Array<{ id: string; title: string; reason: string }>;
    undrawn: number;
  } | null;
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
    topicId: string | null;
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
  syllabusId?: string;
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

/** The "New exam" setup wizard (hidden while an exam is in progress). */
export const examWizard = (page: Page): Locator =>
  page.getByTestId(XID.setup).getByRole('region', { name: 'New exam', exact: true });

/** The title of the setup step on screen ("Ask from", "What to ask", "How many?", ...). */
export const examStep = (page: Page): Locator =>
  examWizard(page).getByRole('heading', { level: 2 });

/** Press the wizard's Next and wait for another step (or the step `to`). */
export async function examNext(page: Page, to?: string): Promise<void> {
  const step = examStep(page);
  const from = ((await step.textContent()) ?? '').trim();
  await examWizard(page).getByRole('button', { name: 'Next', exact: true }).click();
  if (to !== undefined) await expect(step).toHaveText(to);
  else await expect(step).not.toHaveText(from);
}

/** Press Next (changing nothing) until the setup shows the step `title`. */
export async function toExamStep(page: Page, title: string): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await expect(examStep(page)).toBeVisible();
    if (((await examStep(page).textContent()) ?? '').trim() === title) return;
    await examNext(page);
  }
  throw new Error(`the exam setup never reached "${title}"`);
}

/** "How many?" step: "Custom" and a typed number of questions. */
export async function typeQuestionCount(page: Page, count: number | string): Promise<void> {
  const wizard = examWizard(page);
  const custom = wizard.getByRole('radio', { name: /^Custom/ });
  if (!(await custom.isChecked())) await pick(custom);
  await wizard.getByTestId(XID.questions).fill(String(count));
}

export interface StartOptions {
  /** The scope as its old label, e.g. "Bank: Cardiology" or "Tag: pearl". Default: all cards. */
  scope?: string;
  questions?: number;
  /** A time limit in minutes; omitted for none. */
  minutes?: number;
  /** Default false here so the order is the creation order (a test can then rely on it). */
  shuffle?: boolean;
}

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Walk the setup wizard from the step it is on and press "Start exam"; waits for the first question.
 * Each step applies only what `opts` says (a source, topic or count chosen before is kept), except
 * that the order is set to `shuffle` (default off) and the time limit to `minutes` (default none).
 */
export async function startExam(page: Page, opts: StartOptions = {}): Promise<void> {
  const wizard = examWizard(page);
  await expect(wizard).toBeVisible();
  const scope = opts.scope === undefined ? null : /^(Bank|Folder|Tag): (.+)$/.exec(opts.scope);
  if (opts.scope !== undefined && !scope) throw new Error(`unknown scope ${opts.scope}`);
  for (let i = 0; i < 10; i++) {
    const step = ((await examStep(page).textContent()) ?? '').trim();
    if (step === 'What to ask' && scope) {
      await pick(wizard.getByRole('radio', { name: new RegExp(`^A ${scope[1]!.toLowerCase()}`) }));
    } else if (/^Which (bank|folder|tag)\?$/.test(step) && scope) {
      const item = wizard.getByRole('radio', { name: new RegExp(`^${escapeRe(scope[2]!)}`) });
      await pick(item);
    } else if (step === 'How many?') {
      if (opts.questions !== undefined) await typeQuestionCount(page, opts.questions);
      const shuffle = wizard.getByTestId(XID.shuffle);
      if (opts.shuffle === true) await shuffle.check();
      else await shuffle.uncheck();
    } else if (step === 'Time limit') {
      if (opts.minutes !== undefined) {
        await pick(wizard.getByRole('radio', { name: /^Custom/ }));
        await wizard.getByTestId(XID.minutes).fill(String(opts.minutes));
      } else {
        await pick(wizard.getByRole('radio', { name: /^No limit/ }));
      }
    } else if (step === 'Looks good?') {
      await wizard.getByRole('button', { name: 'Start exam', exact: true }).click();
      await expect(page.getByTestId(XID.run)).toBeVisible();
      return;
    }
    await examNext(page);
  }
  throw new Error('the exam setup never reached "Looks good?"');
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
      await pick(page.getByRole('radio', { name: rule.option, exact: true }));
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

/** "I knew it" or "Didn't know it" for question number `n` (1-based, as shown). */
export async function markQuestion(page: Page, n: number, mark: 'know' | 'dont'): Promise<void> {
  const name = mark === 'know' ? `I knew it (question ${n})` : `Didn't know it (question ${n})`;
  await pick(page.getByRole('radio', { name, exact: true }));
}

/** The text of every option of the topic picker, indentation and spacing removed. */
export async function topicOptions(page: Page): Promise<string[]> {
  return page
    .getByTestId(XID.topic)
    .evaluate((el) =>
      Array.from((el as HTMLSelectElement).options).map((o) =>
        (o.textContent ?? '').replace(/\s+/g, ' ').trim(),
      ),
    );
}

/**
 * On the setup's first step ("Ask from"), choose "A syllabus" and go on to "Which topic?"; waits
 * until the cards were read (counts are shown).
 */
export async function chooseSyllabusSource(page: Page): Promise<void> {
  const setup = page.getByTestId(XID.setup);
  await expect(examStep(page)).toHaveText('Ask from');
  const syllabus = setup.getByTestId(XID.source).getByRole('radio', { name: /^A syllabus/ });
  await pick(syllabus);
  await examNext(page, 'Which topic?');
  await expect(setup.getByTestId(XID.topic)).toBeVisible();
  await expect
    .poll(async () => (await topicOptions(page))[0], { message: 'the topic counts were read' })
    .toMatch(/^The whole syllabus \(\d+ cards?\)$/);
}
