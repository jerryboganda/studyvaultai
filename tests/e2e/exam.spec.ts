import type { Page } from '@playwright/test';
import { test } from './helpers.pages';
import { downloadOf } from './helpers.backup';
import { recordRequests, stopWorker } from './helpers.lifecycle';
import {
  MINUTE,
  T0,
  UTC_DAY,
  captureHighlights,
  countedLogs,
  createBasicCards,
  expect,
  expectAccessible,
  hasPersistentAccess,
  openHighlightInAuthor,
  openReview,
  openTypedCard,
  pageErrors,
  readStudyDb,
  saveEditor,
  setClock,
  type Captured,
  type Ctx,
} from './helpers.review';
import {
  XID,
  expectNoFeedback,
  finishExam,
  heading,
  jumpId,
  markQuestion,
  missedId,
  openExamTab,
  readExamMeta,
  scheduleOf,
  startExam,
  walkExam,
} from './helpers.exam';

test.describe.configure({ timeout: 300_000 });

/**
 * Exam simulation (ADR-020) in a real loaded extension: real Chromium, the real built extension,
 * real input. Time runs under Playwright's clock (see helpers.review.ts), IndexedDB is READ to
 * assert what was persisted, and everything else goes through the review page's own UI.
 */

const Q1 = 'Exam Q1: what is the normal adult resting heart rate?';
const A1 = 'E-A1: sixty to one hundred beats per minute';
const QM = 'Exam QM: which node paces the heart?';
const EXPL = 'E-EXPL: the SA node fires fastest.';
const Q3 = 'Exam Q3: define preload.';
const A3 = 'E-A3: ventricular stretch at the end of diastole';
const QUOTE_CO = 'Cardiac output equals heart rate multiplied by stroke volume.';

const noErrors = (page: Page) => expect(pageErrors(page), 'no page or console errors').toEqual([]);

/** Three typed cards in creation order: recall, multiple choice, recall (tagged). */
async function seedMixed(page: Page): Promise<void> {
  await createBasicCards(page, [[Q1, A1]]);
  await saveEditor(
    page,
    {
      t: 'mcq',
      stem: QM,
      choices: ['SA node', 'AV node', 'Purkinje fibres'],
      correct: 0,
      explanation: EXPL,
    },
    1,
  );
  await saveEditor(page, { t: 'basic', question: Q3, answer: A3, tags: 'pearl' }, 1);
}

/** The persisted exam reached `check` (answers are written after every change). */
async function persisted(
  page: Page,
  check: (s: NonNullable<Awaited<ReturnType<typeof readExamMeta>>['session']>) => boolean,
  message: string,
) {
  await expect
    .poll(
      async () => {
        const { session } = await readExamMeta(page);
        return session !== null && check(session);
      },
      { message },
    )
    .toBe(true);
}

test.describe('an exam from start to results', () => {
  test('gives no feedback before the end, marks recall by the person, scores, exports Markdown, leaves the schedule alone and works offline', async ({
    env,
  }) => {
    const ctx: Ctx = env;
    await setClock(ctx, T0);
    const page = await openReview(ctx, { settings: UTC_DAY });
    await seedMixed(page);
    const scheduleBefore = await scheduleOf(page);
    expect(Object.keys(scheduleBefore)).toHaveLength(3);

    await ctx.context.setOffline(true);
    const requests = recordRequests(ctx.context);
    try {
      await openExamTab(page);
      const setup = page.getByTestId(XID.setup);
      await expect(setup.getByTestId(XID.scope)).toContainText('All cards (3 cards)');
      // The count is capped by the cards available; an impossible one is explained, not guessed.
      await setup.getByTestId(XID.questions).fill('50');
      await expect(setup).toContainText(
        'Only 3 cards can be asked in this scope, so the exam has 3 questions.',
      );
      await setup.getByTestId(XID.questions).fill('0');
      await expect(setup.getByTestId(XID.start)).toHaveAttribute('aria-disabled', 'true');
      await expect(setup).toContainText('Ask for a whole number of questions from 1 to 200.');
      await expect(setup).toContainText('No exam has been finished yet.');

      await startExam(page, { questions: 50 });
      await expect(heading(page)).toHaveText('Question 1 of 3');
      await expect(page.getByTestId(XID.timer)).toHaveCount(0); // no time limit was set
      // There is no pause; the only way out is a confirmed "Leave exam".
      await expect(page.getByRole('button', { name: /pause/i })).toHaveCount(0);

      const shown = await walkExam(page, [
        { match: Q1, text: 'about seventy' },
        { match: QM, option: 'SA node' },
      ]);
      expect(shown.map((s) => [Q1, QM, Q3].findIndex((q) => s.includes(q)))).toEqual([0, 1, 2]);
      await expectNoFeedback(page, [A1, A3, EXPL]);
      await persisted(
        page,
        (s) => s.questions[0]?.text === 'about seventy' && s.questions[1]?.choiceId !== null,
        'answers were written to the device',
      );

      await finishExam(page);
      const marking = page.getByTestId(XID.marking);
      await expect(marking).toBeVisible();
      await expect(marking).toContainText(A1);
      await expect(marking).toContainText(A3);
      await expect(marking).not.toContainText(EXPL); // the multiple choice is scored, not shown again
      await expect(marking).toContainText('about seventy'); // what the person typed
      await expect(page.getByTestId(XID.showResults)).toHaveAttribute('aria-disabled', 'true');
      await markQuestion(page, 1, 'know');
      await markQuestion(page, 3, 'dont');
      await page.getByTestId(XID.showResults).click();

      const results = page.getByTestId(XID.results);
      await expect(results).toBeVisible();
      await expect(results.getByTestId(XID.score)).toContainText('67%');
      await expect(results.getByTestId(XID.score)).toContainText('2 of 3 correct');
      await expect(results.getByTestId(XID.missed)).toContainText(Q3);
      await expect(results.getByTestId(XID.missed)).toContainText(`Correct answer: ${A3}`);
      await expect(results.getByTestId(XID.banks)).toContainText('No bank');
      await expect(results.getByTestId(XID.tags)).toContainText('pearl');

      // What was kept: outcomes, one history row, and not a single review.
      const meta = await readExamMeta(page);
      expect(meta.session).toMatchObject({
        phase: 'finished',
        outcomes: ['correct', 'correct', 'wrong'],
        endReason: 'submitted',
        review: null,
      });
      expect(meta.history).toHaveLength(1);
      expect(meta.history[0]).toMatchObject({
        total: 3,
        correct: 2,
        wrong: 1,
        unanswered: 0,
        countedAsReview: false,
      });
      expect(await scheduleOf(page)).toEqual(scheduleBefore);
      expect(countedLogs(await readStudyDb(page))).toEqual([]);

      // Export is a real Markdown file of these results.
      const file = await downloadOf(page, () => page.getByTestId(XID.export).click());
      expect(file.name).toBe('studyvault-exam-2026-03-10.md');
      const md = file.bytes.toString('utf8');
      expect(md).toContain('# Exam results: All cards');
      expect(md).toContain('- Score: 67% (2 of 3 correct, 1 wrong, 0 unanswered)');
      expect(md).toContain(`### 3. ${Q3}`);
      expect(md).toContain(`- Correct answer: ${A3}`);

      await page.getByTestId(XID.close).click();
      await expect(page.getByTestId(XID.history)).toContainText('67% (2 of 3)');
      await expect(page.getByTestId(XID.history)).toContainText('stored on this device only');
      await expect.poll(async () => (await readExamMeta(page)).session).toBeNull();
      noErrors(page);
    } finally {
      requests.stop();
      await ctx.context.setOffline(false);
    }
    const outside = requests.urls.filter(
      (u) =>
        !u.startsWith('chrome-extension://') && !u.startsWith('data:') && !u.startsWith('blob:'),
    );
    expect(outside, 'no request left the extension').toEqual([]);
  });

  test('"Leave exam" asks first and keeps the exam, which can be continued or discarded', async ({
    env,
  }) => {
    const ctx: Ctx = env;
    await setClock(ctx, T0);
    const page = await openReview(ctx, { settings: UTC_DAY });
    await createBasicCards(page, [
      [Q1, A1],
      [Q3, A3],
    ]);
    await openExamTab(page);
    await startExam(page, { questions: 2, minutes: 10 });
    await page.getByTestId(XID.text).fill('typed before leaving');

    await page.getByTestId(XID.leave).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('timer does not stop');
    await dialog.getByRole('button', { name: 'Stay in the exam' }).click();
    await expect(page.getByTestId(XID.run)).toBeVisible();
    await expect(page.getByTestId(XID.text)).toHaveValue('typed before leaving');

    await page.getByTestId(XID.leave).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Leave exam' }).click();
    const setup = page.getByTestId(XID.setup);
    await expect(setup).toContainText('An exam is in progress');
    await expect(setup.getByTestId(XID.start)).toHaveAttribute('aria-disabled', 'true');
    expect((await readExamMeta(page)).session?.phase).toBe('answering');

    await setup.getByTestId(XID.continue).click();
    await expect(page.getByTestId(XID.text)).toHaveValue('typed before leaving');

    await page.getByTestId(XID.leave).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Leave exam' }).click();
    await page.getByTestId(XID.discard).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Discard exam' }).click();
    await expect(page.getByTestId(XID.start)).not.toHaveAttribute('aria-disabled', 'true');
    await expect.poll(async () => (await readExamMeta(page)).session).toBeNull();
    // Discarding is not finishing: no history, no review, nothing changed.
    expect((await readExamMeta(page)).history).toEqual([]);
    expect(countedLogs(await readStudyDb(page))).toEqual([]);
    noErrors(page);
  });
});

test.describe('the clock', () => {
  test('time running out moves to marking at the deadline, keeps the answers, and is announced once', async ({
    env,
  }) => {
    const ctx: Ctx = env;
    await setClock(ctx, T0);
    const page = await openReview(ctx, { settings: UTC_DAY });
    await seedMixed(page);
    await openExamTab(page);
    await startExam(page, { questions: 3, minutes: 2 });

    const timer = page.getByTestId(XID.timer);
    await expect(timer).toHaveText('02:00');
    // A timer, not a live region: a screen reader is never interrupted once a second.
    await expect(timer).toHaveAttribute('role', 'timer');
    await expect(timer).toHaveAttribute('aria-live', 'off');
    expect(
      await page
        .getByTestId(XID.run)
        .locator('[role="status"], [role="alert"], [aria-live]:not([aria-live="off"])')
        .count(),
    ).toBe(0);

    await page.getByTestId(XID.next).click();
    await page.getByRole('radio', { name: 'AV node', exact: true }).check();
    await persisted(page, (s) => s.questions[1]?.choiceId !== null, 'the pick was written');

    // One minute in: half of the two minutes is gone.
    await setClock(ctx, T0 + MINUTE);
    await expect(page.getByTestId(XID.announce)).toHaveText(
      'Half of the time has passed. About 60 seconds left.',
    );
    await expect(timer).toHaveText('01:00');

    // Past the deadline: the next tick moves to marking, with the answer kept.
    await setClock(ctx, T0 + 2 * MINUTE + 5_000);
    await expect(page.getByTestId(XID.marking)).toBeVisible();
    await expect(page.getByTestId(XID.announce)).toHaveText('Time is up. Your answers are saved.');
    await expect(page.getByTestId(XID.marking)).toContainText('Time is up.');
    const { session } = await readExamMeta(page);
    expect(session).toMatchObject({
      phase: 'marking',
      endReason: 'timeup',
      endedAt: new Date(T0 + 2 * MINUTE).toISOString(),
    });
    expect(session?.questions[1]?.choiceId).not.toBeNull();

    // Marking is not timed; leaving the recall questions unmarked is an explicit choice.
    await expect(page.getByTestId(XID.showResults)).toHaveAttribute('aria-disabled', 'true');
    await page.getByTestId(XID.markRest).click();
    await page.getByTestId(XID.showResults).click();
    const results = page.getByTestId(XID.results);
    await expect(results.getByTestId(XID.score)).toContainText('0%');
    await expect(results.getByTestId(XID.score)).toContainText('time ran out (limit 2 min)');
    expect((await readExamMeta(page)).history[0]).toMatchObject({ timedOut: true, minutes: 2 });

    // The finished results survive a reload (24 hours), and are still the same.
    await page.reload();
    await expect(page.getByTestId(XID.results)).toBeVisible();
    await expect(page.getByTestId(XID.results).getByTestId(XID.score)).toContainText('0%');
    noErrors(page);
  });

  test('a reload mid-exam resumes with the answers and the remaining time, also after the worker was stopped; one after the deadline lands in marking', async ({
    env,
  }) => {
    const ctx: Ctx = env;
    await setClock(ctx, T0);
    const page = await openReview(ctx, { settings: UTC_DAY });
    await seedMixed(page);
    await openExamTab(page);
    await startExam(page, { questions: 3, minutes: 10 });
    await page.getByTestId(XID.text).fill('about seventy');
    await page.getByTestId(XID.next).click();
    await page.getByRole('radio', { name: 'SA node', exact: true }).check();
    await persisted(
      page,
      (s) => s.questions[0]?.text === 'about seventy' && s.questions[1]?.choiceId !== null,
      'answers were written',
    );

    // The service worker is suspended (as Chrome does) and four minutes pass.
    await stopWorker(ctx.context, ctx.extensionId, page);
    await setClock(ctx, T0 + 4 * MINUTE);
    await page.reload();
    await expect(page.getByTestId(XID.run)).toBeVisible();
    await expect(page.getByTestId(XID.timer)).toHaveText('06:00');
    await expect(heading(page)).toHaveText('Question 2 of 3');
    await expect(page.getByRole('radio', { name: 'SA node', exact: true })).toBeChecked();
    await page.getByTestId(XID.prev).click();
    await expect(page.getByTestId(XID.text)).toHaveValue('about seventy');

    // Still the same exam in the database (nothing was restarted or duplicated).
    const { session } = await readExamMeta(page);
    expect(session?.phase).toBe('answering');
    expect(session?.startedAt).toBe(new Date(T0).toISOString());

    // Back after the deadline: marking, the answers kept, and the reason on screen.
    await setClock(ctx, T0 + 30 * MINUTE);
    await page.reload();
    await expect(page.getByTestId(XID.marking)).toBeVisible();
    await expect(page.getByText(/The time limit ran out while this page was closed/)).toBeVisible();
    await expect(page.getByTestId(XID.marking)).toContainText('about seventy');
    expect((await readExamMeta(page)).session).toMatchObject({
      phase: 'marking',
      endReason: 'timeup',
      endedAt: new Date(T0 + 10 * MINUTE).toISOString(),
    });
    noErrors(page);
  });

  test('an exam left for more than 24 hours is dropped, and the page says so', async ({ env }) => {
    const ctx: Ctx = env;
    await setClock(ctx, T0);
    const page = await openReview(ctx, { settings: UTC_DAY });
    await createBasicCards(page, [[Q1, A1]]);
    await openExamTab(page);
    await startExam(page, { questions: 1 });
    await persisted(page, (s) => s.phase === 'answering', 'the exam was written');

    await setClock(ctx, T0 + 25 * 60 * MINUTE);
    await page.reload();
    await expect(page.getByTestId(XID.setup)).toBeVisible();
    await expect(page.getByText(/expired after 24 hours and was removed/)).toBeVisible();
    await expect(page.getByTestId(XID.continue)).toHaveCount(0);
    await expect.poll(async () => (await readExamMeta(page)).session).toBeNull();
    noErrors(page);
  });
});

test.describe('count this exam as review', () => {
  test('rates each answered card once (Good for correct, Again for wrong), can be undone, and shows in the history', async ({
    env,
  }) => {
    const ctx: Ctx = env;
    await setClock(ctx, T0);
    const page = await openReview(ctx, { settings: UTC_DAY });
    await createBasicCards(page, [
      [Q1, A1],
      [Q3, A3],
    ]);
    const before = await scheduleOf(page);
    await openExamTab(page);
    await startExam(page, { questions: 2 });
    await walkExam(page, []);
    await finishExam(page);
    await markQuestion(page, 1, 'know');
    await markQuestion(page, 2, 'dont');
    await page.getByTestId(XID.showResults).click();
    await expect(page.getByTestId(XID.results)).toBeVisible();
    expect(await scheduleOf(page)).toEqual(before);

    const tick = page.getByRole('checkbox', { name: 'Count this exam as review' });
    await expect(tick).not.toBeChecked();
    await tick.check();
    await expect(page.getByTestId(XID.countStatus)).toHaveText('Counted 2 cards as review.');
    await expect(tick).toBeEnabled();
    const db = await readStudyDb(page);
    const logs = countedLogs(db);
    expect(logs).toHaveLength(2);
    const byCard = new Map(db.cards.map((c) => [c.id, c.front] as const));
    expect(logs.map((l) => [byCard.get(l.cardId), l.rating] as const).sort()).toEqual([
      [Q1, 3],
      [Q3, 1],
    ]);
    const exam = (await readExamMeta(page)).session;
    expect(exam?.review?.logs).toHaveLength(2);
    expect(logs.every((l) => l.sessionId === exam?.id)).toBe(true);
    expect(exam?.review?.logs.map((l) => l.logId).sort()).toEqual(logs.map((l) => l.id).sort());
    // The cards really moved.
    expect(await scheduleOf(page)).not.toEqual(before);

    // Undo (untick): every card is back where it was, and the exam cannot be counted again.
    await tick.uncheck();
    await expect(page.getByTestId(XID.countStatus)).toContainText('Undid 2 reviews.');
    expect(await scheduleOf(page)).toEqual(before);
    expect(countedLogs(await readStudyDb(page))).toEqual([]);
    await expect(tick).toBeDisabled();
    await expect(page.getByTestId(XID.results)).toContainText('counted once and then undone');

    // The history says what is true now, and survives a reload.
    await page.getByTestId(XID.close).click();
    await expect(page.getByTestId(XID.history).getByRole('row')).toHaveCount(2);
    await expect(
      page.getByTestId(XID.history).getByRole('row').nth(1).getByRole('cell').last(),
    ).toHaveText('No');
    await page.reload();
    await expect(page.getByTestId(XID.history).getByRole('row')).toHaveCount(2);

    // The list can be cleared (summaries only; cards are not touched).
    await page.getByTestId(XID.historyClear).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Clear the list' }).click();
    await expect(page.getByTestId(XID.history)).toContainText('No exam has been finished yet.');
    expect((await readExamMeta(page)).history).toEqual([]);
    expect(await scheduleOf(page)).toEqual(before);
    noErrors(page);
  });
});

test.describe('missed questions and their source', () => {
  test('a wrong answer lists the saved quote and "Jump to source" opens the source page', async ({
    env,
  }) => {
    const ctx: Ctx = env;
    const [hl] = (await captureHighlights(ctx, '/review-physiology.html', ['#rv-co'])) as [
      Captured,
    ];
    await setClock(ctx, T0);
    const page = await openReview(ctx, { settings: UTC_DAY });
    await openHighlightInAuthor(page, hl.id);
    await saveEditor(
      page,
      {
        t: 'mcq',
        stem: 'How is cardiac output calculated?',
        choices: [
          'Heart rate times stroke volume',
          'Stroke volume divided by rate',
          'Preload minus afterload',
        ],
        correct: 0,
      },
      1,
    );
    await openTypedCard(page);
    await saveEditor(page, { t: 'basic', question: 'Typed card without a source', answer: 'x' }, 1);

    await openExamTab(page);
    await startExam(page, { questions: 2 });
    await walkExam(page, [
      { match: 'How is cardiac output calculated?', option: 'Preload minus afterload' },
    ]);
    await finishExam(page);
    await markQuestion(page, 2, 'know');
    await page.getByTestId(XID.showResults).click();

    const missed = page.getByTestId(XID.missed);
    const item = missed.getByTestId(missedId(0));
    await expect(item).toContainText('Question 1');
    await expect(item).toContainText('Your answer: Preload minus afterload');
    await expect(item).toContainText('Correct answer: Heart rate times stroke volume');
    await expect(item.locator('blockquote')).toContainText(QUOTE_CO);
    await expect(missed.getByTestId(missedId(1))).toHaveCount(0); // the typed card was marked "knew it"

    const opened = ctx.context.waitForEvent('page');
    await item.getByTestId(jumpId(0)).click();
    const source = await opened;
    await source.waitForLoadState('domcontentloaded');
    expect(source.url()).toBe(`${ctx.origin}/review-physiology.html`);
    if (hasPersistentAccess(ctx)) {
      await expect(page.getByText('Opened the source and showed the passage.')).toBeVisible();
    } else {
      await expect(
        page.getByText(/Opened the source page\. StudyVault could not show the passage there/),
      ).toBeVisible({ timeout: 60_000 });
    }
    await source.close();
    noErrors(page);
  });
});

test.describe('accessibility', () => {
  test('axe WCAG 2.2 AA: setup, a recall question, a multiple-choice question, marking, results and the history', async ({
    env,
  }) => {
    const ctx: Ctx = env;
    await setClock(ctx, T0);
    const page = await openReview(ctx, { settings: UTC_DAY });
    await seedMixed(page);
    await openExamTab(page);
    await expectAccessible(page, 'exam setup');

    await startExam(page, { questions: 3, minutes: 20 });
    await expectAccessible(page, 'exam: recall question');
    await page.getByTestId(XID.text).fill('about seventy');
    await page.getByTestId(XID.next).click();
    await expectAccessible(page, 'exam: multiple-choice question');
    await page.getByRole('radio', { name: 'AV node', exact: true }).check();
    await expectAccessible(page, 'exam: multiple-choice question with an option picked');
    await page.getByTestId(XID.finish).click();
    await expectAccessible(page, 'exam: finish confirmation');
    await page.getByRole('dialog').getByRole('button', { name: 'Finish exam' }).click();

    await expect(page.getByTestId(XID.marking)).toBeVisible();
    await expectAccessible(page, 'exam: marking');
    await markQuestion(page, 1, 'know');
    await markQuestion(page, 3, 'dont');
    await page.getByTestId(XID.showResults).click();
    await expect(page.getByTestId(XID.results)).toBeVisible();
    await expect(page.getByTestId(XID.missed)).toContainText('Question 2');
    await expectAccessible(page, 'exam: results with a missed question');
    await page.getByText('Time per question').click();
    await expectAccessible(page, 'exam: results with the time table open');

    await page.getByTestId(XID.close).click();
    await expect(page.getByTestId(XID.history)).toContainText('33%');
    await expectAccessible(page, 'exam setup with a history');
    noErrors(page);
  });
});
