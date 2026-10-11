import type { Page } from '@playwright/test';
import { proseDoc } from '../fixtures/pdf/docs';
import { bgData, test } from './helpers.pages';
import {
  hardKill,
  launchSession,
  markWorker,
  newUserDataDir,
  recordRequests,
  removeDir,
  stopWorker,
  wakeWorker,
  type Session,
} from './helpers.lifecycle';
import {
  DAY,
  MINUTE,
  RATING_NAMES,
  T0,
  TID,
  UTC_DAY,
  answerAll,
  answerWith,
  blankId,
  captureHighlights,
  cardByFront,
  cardCount,
  cardRow,
  choiceId,
  countedLogs,
  createBasicCards,
  createTypedClozeCards,
  dueNumbers,
  expect,
  expectAccessible,
  expectDue,
  expectDueMatchesLabel,
  fillDeckForm,
  fillEditor,
  focusedId,
  hasPersistentAccess,
  gotoTab,
  iso,
  labelToMs,
  liveCards,
  openDeckForm,
  openHighlightInAuthor,
  openReview,
  openTypedCard,
  optionIndex,
  pageErrors,
  previewLabels,
  questionText,
  ratingId,
  readStudyDb,
  reloadTo,
  saveDeckSettings,
  saveEditor,
  seedAiCard,
  setBrowserFilter,
  setClock,
  setStudyDayInUi,
  settledSession,
  startAll,
  storedStudySettings,
  studyDayStart,
  tabUntil,
  tableRows,
  whenText,
  type Captured,
  type CardRow,
  type CardSpec,
  type Ctx,
  type Rating,
  type StudyDb,
} from './helpers.review';

test.describe.configure({ timeout: 300_000 });

/**
 * Retention system (Phase 4) in a real loaded extension. Real Chromium, the real built extension,
 * real keyboard and mouse input; highlights are saved through the real toolbar, cards are made in
 * the review page's author view. Time-dependent behaviour runs under Playwright's clock (see
 * helpers.review.ts); IndexedDB is READ to assert what was persisted, and written directly in one
 * place only (seedAiCard, documented there).
 */

const QUOTE_SV =
  'Stroke volume is the volume of blood ejected by one ventricle during a single contraction.';
const QUOTE_CO = 'Cardiac output equals heart rate multiplied by stroke volume.';

const noErrors = (page: Page) => expect(pageErrors(page), 'no page or console errors').toEqual([]);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const ctxOf = (session: Session, origin: string): Ctx => ({
  context: session.context,
  extensionId: session.extensionId,
  origin,
});

/** Studied cards (not new, not suspended) bucketed against the UTC study day containing `now`. */
function dueBuckets(db: StudyDb, now: number, rolloverHour = 4) {
  const start = studyDayStart(now, rolloverHour);
  const end = start + DAY;
  const studied = liveCards(db).filter((c) => c.fsrs.state !== 'new' && !c.suspended);
  const due = (c: CardRow) => Date.parse(c.fsrs.due);
  return {
    studied,
    overdue: studied.filter((c) => due(c) < start),
    today: studied.filter((c) => due(c) >= start && due(c) < end),
    tomorrow: studied.filter((c) => due(c) >= end && due(c) < end + DAY),
    dayStart: start,
  };
}

// ===============================================================================================
// Smoke (kept from the first Phase 4 slice)
// ===============================================================================================

test('review page: create a card, study it with the keyboard, continue after a reload', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console.error: ${m.text()}`);
  });

  await page.goto(`chrome-extension://${extensionId}/review.html`);
  await expect(page.getByRole('heading', { name: 'Review', level: 1 })).toBeVisible();
  await expect(page.getByTestId('rv-deck-empty')).toBeVisible();

  await page.getByRole('tab', { name: 'Create cards' }).click();
  await page.getByRole('tab', { name: 'Typed card' }).click();
  const manual = page.getByTestId('rv-manual');
  await manual
    .getByLabel('Question', { exact: true })
    .fill('What is the normal adult resting heart rate?');
  await manual.getByLabel('Answer', { exact: true }).fill('60 to 100 beats per minute');
  await expect(page.getByTestId('rv-preview')).toContainText('1 card will be created');
  await page.getByTestId('rv-save-cards').click();
  await expect(page.getByText('Created 1 card.')).toBeVisible();

  await page.getByRole('tab', { name: 'Study' }).click();
  await expect(page.getByTestId('rv-due-total')).toHaveText('1');
  await page.getByTestId('rv-start-all').click();
  await expect(page.getByTestId('rv-question')).toContainText('resting heart rate');
  await page.keyboard.press('Space');
  for (const rating of [1, 2, 3, 4]) {
    await expect(page.getByTestId(`rv-rate-${rating}`)).toContainText(/\d+(m|h|d|mo)/);
  }
  await page.keyboard.press('3');
  await expect(page.getByTestId('rv-progress-text')).toContainText('1 answered');

  await page.reload();
  await expect(page.getByTestId('rv-deck-picker')).toBeVisible();
  await page.getByTestId('rv-continue').click();
  await expect(page.getByTestId('rv-progress-text')).toContainText('1 answered');

  expect(problems).toEqual([]);
});

// ===============================================================================================
// 1. Authoring: five templates from a highlight, edit, source link, quote snapshot, AI flag
// ===============================================================================================

test.describe('authoring', () => {
  test('basic, cloze (multi-deletion), term and definition, compare and MCQ cards from a highlight keep their source link and quote snapshot through edits', async ({
    env,
  }) => {
    test.setTimeout(600_000);
    const ctx: Ctx = env;
    const [sv, co] = (await captureHighlights(ctx, '/review-physiology.html', [
      '#rv-sv',
      '#rv-co',
    ])) as [Captured, Captured];
    expect(sv.quote).toBe(QUOTE_SV);
    expect(co.quote).toBe(QUOTE_CO);

    const page = await openReview(ctx);
    await openHighlightInAuthor(page, sv.id);
    await expect(page.getByText('Source quote (read only)')).toBeVisible();
    await expect(page.getByTestId(TID.editor).locator('blockquote')).toHaveText(QUOTE_SV);

    // basic: the quote can be used as the answer with one button (exact text, no retyping).
    const editor = await fillEditor(page, {
      t: 'basic',
      question: 'What is stroke volume?',
      answer: 'x',
    });
    await editor.getByRole('button', { name: 'Use the quote as the answer' }).click();
    await expect(editor.getByRole('textbox', { name: 'Answer', exact: true })).toHaveValue(
      QUOTE_SV,
    );
    await expect(page.getByTestId(TID.preview)).toContainText('1 card will be created');
    await saveEditor(
      page,
      {
        t: 'basic',
        question: 'What is stroke volume?',
        answer: QUOTE_SV,
        explanation: 'SV = EDV - ESV',
      },
      1,
    );

    // cloze: the "Hide selection" helper wraps the selected words, then two deletions by hand.
    await fillEditor(page, { t: 'cloze', markup: QUOTE_SV });
    const area = page.getByTestId(TID.clozeText);
    await expect(area).toHaveValue(QUOTE_SV);
    await area.evaluate((el: HTMLTextAreaElement) => {
      const at = el.value.indexOf('single');
      el.focus();
      el.setSelectionRange(at, at + 'single'.length);
    });
    await page.getByTestId(TID.clozeWrap).click();
    await expect(area).toHaveValue(QUOTE_SV.replace('single', '{{c1::single}}'));

    const clozeMarkup =
      'Stroke volume is the {{c1::volume of blood}} ejected by one {{c2::ventricle::chamber}} during a single contraction.';
    await fillEditor(page, { t: 'cloze', markup: clozeMarkup, perDeletion: true });
    await expect(page.getByTestId(TID.preview)).toContainText('2 cards will be created');
    await expect(page.getByTestId(TID.preview)).toContainText('Card 1 of 2');
    await saveEditor(page, { t: 'cloze', markup: clozeMarkup, perDeletion: true }, 2);

    // term and definition, compare, multiple choice.
    await saveEditor(
      page,
      {
        t: 'definition',
        term: 'Stroke volume',
        definition: QUOTE_SV,
        example: 'About 70 mL at rest',
      },
      1,
    );
    await saveEditor(
      page,
      {
        t: 'compare',
        left: 'Stroke volume',
        right: 'Ejection fraction',
        rows: [
          { aspect: 'Unit', left: 'millilitres', right: 'percent' },
          { aspect: 'Resting value', left: '60 to 100', right: '55 to 70' },
        ],
      },
      1,
    );
    await saveEditor(
      page,
      {
        t: 'mcq',
        stem: 'Which quantity is ejected by one ventricle in one contraction?',
        choices: ['Stroke volume', 'Cardiac output', 'Preload', 'Afterload'],
        correct: 0,
        explanation: 'Stroke volume is the volume ejected per beat.',
      },
      1,
    );

    // What was persisted: six cards, all linked to the highlight, all carrying the exact quote.
    const db = await readStudyDb(page);
    const cards = liveCards(db);
    expect(cards).toHaveLength(6);
    expect(cards.map((c) => c.cardType).sort()).toEqual([
      'basic',
      'cloze',
      'cloze',
      'compare',
      'definition',
      'mcq',
    ]);
    for (const c of cards) {
      expect(c.highlightId, `${c.cardType} card source link`).toBe(sv.id);
      expect(c.sourceQuote, `${c.cardType} card quote snapshot`).toBe(QUOTE_SV);
      expect(c.createdBy).toBe('user');
      expect(c.needsHumanVerification).toBe(false);
      expect(c.fsrs.state).toBe('new');
    }
    const clozes = cards.filter((c) => c.cardType === 'cloze');
    expect(clozes.map((c) => c.cloze?.activeIndex).sort()).toEqual([1, 2]);
    expect(db.decks.filter((d) => d.deletedAt === null).map((d) => d.name)).toEqual(['Inbox']);
    const mcq = cards.find((c) => c.cardType === 'mcq')!;
    expect(mcq.choices).toHaveLength(4);
    expect(mcq.choices?.find((c) => c.id === mcq.answerChoiceId)?.text).toBe('Stroke volume');
    expect(mcq.explanation).toBe('Stroke volume is the volume ejected per beat.');

    // Edit the basic card from the card browser: wording changes, provenance and schedule do not.
    const basic = cards.find((c) => c.cardType === 'basic')!;
    await gotoTab(page, 'Cards');
    await expect(page.locator('[data-testid^="rv-card-"]')).toHaveCount(6);
    // Addressed by id: once the editor is open the row's text is in form fields, not text.
    const row = page.getByTestId(`rv-card-${basic.id}`);
    await expect(row).toContainText('What is stroke volume?');
    await row.getByRole('button', { name: 'Edit', exact: true }).click();
    const edit = row.getByTestId(TID.editor);
    await expect(edit.getByLabel('Front')).toHaveValue('What is stroke volume?');
    // Provenance is not an editable field.
    await expect(edit.getByLabel(/source|quote|highlight/i)).toHaveCount(0);
    await edit.getByLabel('Front').fill('Define stroke volume (edited)');
    await edit.getByRole('button', { name: 'Save card' }).click();
    await expect(page.getByText('Card saved.')).toBeVisible();

    const after = await readStudyDb(page);
    const edited = liveCards(after).find((c) => c.id === basic.id)!;
    expect(edited.front).toBe('Define stroke volume (edited)');
    expect(edited.highlightId).toBe(sv.id);
    expect(edited.sourceQuote).toBe(QUOTE_SV);
    expect(edited.fsrs).toEqual(basic.fsrs);
    expect(edited.dueAt).toBe(basic.dueAt);
    expect(edited.createdAt).toBe(basic.createdAt);

    // The edit survives a reload; the card list is rebuilt from the database.
    await page.reload();
    await expect(cardRow(page, 'Define stroke volume (edited)')).toBeVisible();
    await expect(cardRow(page, 'What is stroke volume?')).toHaveCount(0);

    // A second highlight, bulk-created: one basic card per highlight, quote = answer.
    await gotoTab(page, 'Create cards');
    await page
      .getByRole('checkbox', { name: new RegExp(`^Select for bulk: ${QUOTE_CO.slice(0, 20)}`) })
      .check();
    await page.getByRole('tab', { name: /^From several/ }).click();
    const bulk = page.getByTestId(TID.bulk);
    await bulk.getByLabel('Question', { exact: true }).fill('How is cardiac output calculated?');
    await page.getByTestId(TID.bulkCreate).click();
    await expect.poll(async () => cardCount(page)).toBe(7);
    const bulked = liveCards(await readStudyDb(page)).find((c) => c.highlightId === co.id)!;
    expect(bulked.front).toBe('How is cardiac output calculated?');
    expect(bulked.back).toBe(QUOTE_CO);
    expect(bulked.sourceQuote).toBe(QUOTE_CO);

    noErrors(page);
  });

  test('an incomplete card is explained, not saved: the button is disabled with the reason', async ({
    context,
    extensionId,
  }) => {
    const page = await openReview({ context, extensionId, origin: '' });
    await openTypedCard(page);
    const save = page.getByTestId(TID.saveCards);

    // Nothing typed: disabled, and the button says why.
    await expect(save).toHaveAttribute('aria-disabled', 'true');
    await expect(save).toHaveAttribute('title', /empty|incomplete|complete/i);

    // basic: a question but no answer.
    await fillEditor(page, { t: 'basic', question: 'Only a question', answer: '' });
    await expect(save).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByTestId(TID.previewIssues)).toContainText(/back of the card is empty/i);

    // cloze with no deletion.
    await fillEditor(page, { t: 'cloze', markup: 'A sentence with no deletion.' });
    await expect(save).toHaveAttribute('aria-disabled', 'true');

    // mcq with one option.
    await fillEditor(page, {
      t: 'mcq',
      stem: 'Pick one',
      choices: ['Only option', '', '', ''],
      correct: 0,
    });
    await expect(save).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByTestId(TID.previewIssues)).toContainText(/at least 2 choices/);
    expect(await cardCount(page)).toBe(0);
    noErrors(page);
  });

  test('an AI-made card carries the needs-verification flag until the learner checks it', async ({
    context,
    extensionId,
  }) => {
    const page = await openReview({ context, extensionId, origin: '' });
    await createBasicCards(page, [['Typed question', 'Typed answer']]);
    const template = cardByFront(await readStudyDb(page), 'Typed question');
    const ai = 'AI question: which valve closes at the start of systole?';
    // See seedAiCard: one direct IndexedDB put, because the UI path needs an AI provider + network.
    const aiId = await seedAiCard(page, template, {
      front: ai,
      back: 'The mitral valve closes at the start of systole.',
    });
    await page.reload();

    // The card browser flags it.
    await gotoTab(page, 'Cards');
    await expect(page.getByTestId(`rv-card-${aiId}`)).toContainText('Needs your check');

    // The session flags it too, and says what the flag means.
    await gotoTab(page, 'Study');
    await expectDue(page, 2);
    await startAll(page);
    if ((await questionText(page)) !== ai) await answerWith(page, 4);
    await expect(page.getByTestId(TID.question)).toHaveText(ai);
    await expect(page.getByTestId(TID.unverified)).toBeVisible();
    await expect(page.getByTestId(TID.card)).toContainText('AI-made');
    await expect(page.getByTestId(TID.card)).toContainText(/have not been checked by you/);

    const flagged = (await readStudyDb(page)).cards.find((c) => c.id === aiId)!;
    expect(flagged.needsHumanVerification).toBe(true);
    expect(flagged.createdBy).toBe('ai');
    await page.getByTestId(TID.verify).click();
    await expect(page.getByTestId(TID.unverified)).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (await readStudyDb(page)).cards.find((c) => c.id === aiId)?.needsHumanVerification,
      )
      .toBe(false);
    // Only the flag changed: provenance still says "AI-made".
    const checked = (await readStudyDb(page)).cards.find((c) => c.id === aiId)!;
    expect(checked.createdBy).toBe('ai');
    expect(checked.aiResultId).not.toBeNull();
    expect(checked.aiResultId).toBe(flagged.aiResultId);
    expect(checked.front).toBe(ai);
    noErrors(page);
  });
});

// ===============================================================================================
// 2. Study session
// ===============================================================================================

test.describe('study session', () => {
  test('reveal with Space, rate 1-4 with previews that match the stored due date, undo with Z, MCQ key and explanation, per-blank cloze reveal, suspend, progress and summary', async ({
    env,
  }) => {
    const ctx: Ctx = env;
    await setClock(ctx, T0);
    const page = await openReview(ctx, { settings: UTC_DAY });

    const QP = 'Q-plain: what is a normal adult resting heart rate?';
    const QR = 'Q-mcq-right: which vessel carries oxygenated blood away from the heart?';
    const QW = 'Q-mcq-wrong: which chamber receives blood returning from the body?';
    await openTypedCard(page);
    await saveEditor(page, { t: 'basic', question: QP, answer: '60 to 100 per minute' }, 1);
    await saveEditor(
      page,
      {
        t: 'mcq',
        stem: QR,
        choices: ['Aorta', 'Vena cava', 'Pulmonary vein', 'Portal vein'],
        correct: 0,
        explanation: 'The aorta carries oxygenated blood out of the left ventricle.',
      },
      1,
    );
    await saveEditor(
      page,
      {
        t: 'mcq',
        stem: QW,
        choices: ['Right atrium', 'Left atrium', 'Right ventricle', 'Left ventricle'],
        correct: 0,
        explanation: 'The right atrium receives systemic venous return.',
      },
      1,
    );
    await saveEditor(
      page,
      {
        t: 'cloze',
        markup: 'Q-cloze: the {{c1::heart}} pumps {{c2::blood}} around the body.',
        perDeletion: false,
      },
      1,
    );

    await gotoTab(page, 'Study');
    await expectDue(page, 4);
    await startAll(page);
    await expect(page.getByTestId(TID.progressText)).toHaveText('0 answered, 4 left (0%)');

    // --- card 1: plain question -------------------------------------------------------------
    expect(await questionText(page)).toBe(QP);
    await expect(page.getByTestId(TID.ratings)).toHaveCount(0);
    await expect(page.getByTestId(TID.answer)).toHaveCount(0);
    // Controls that cannot act yet say why instead of doing nothing.
    await expect(page.getByTestId(TID.undo)).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByTestId(TID.undo)).toHaveAttribute('title', 'Nothing to undo yet.');
    await expect(page.getByTestId(TID.explain)).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByTestId(TID.explain)).toHaveAttribute(
      'title',
      'Show the answer first to see the explanation.',
    );
    await expect(page.getByTestId(TID.source)).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByTestId(TID.source)).toHaveAttribute(
      'title',
      'This card has no source: it was typed in by hand.',
    );

    const original = cardByFront(await readStudyDb(page), QP);
    await page.keyboard.press('Space');
    await expect(page.getByTestId(TID.answer)).toHaveText('60 to 100 per minute');
    const labels = await previewLabels(page);
    expect(labels[1]).toBe('1m'); // the first learning step
    expect(labels[3]).toBe('10m'); // the second one
    const order = ([1, 2, 3, 4] as const).map((r) => labelToMs(labels[r]).ms);
    expect(order, 'Again < Hard < Good < Easy').toEqual([...order].sort((a, b) => a - b));
    expect(labelToMs(labels[4]).ms, 'Easy graduates the card to days').toBeGreaterThanOrEqual(DAY);
    for (const r of [1, 2, 3, 4] as const) {
      await expect(page.getByTestId(ratingId(r))).toHaveAttribute(
        'aria-label',
        `${RATING_NAMES[r]}, next review in ${labels[r]}. Key ${r}.`,
      );
    }

    // Good: the button promised 10m and the stored due date agrees.
    await page.keyboard.press('3');
    await expect(page.getByTestId(TID.ratings)).toHaveCount(0);
    await expect(page.getByTestId(TID.progressText)).toHaveText('1 answered, 4 left (20%)');
    const afterGood = cardByFront(await readStudyDb(page), QP);
    expectDueMatchesLabel(afterGood, labels[3], T0, 'Good');
    expect(afterGood.fsrs.state).toBe('learning');

    // Undo (Z): the card is back exactly as it was, the answer is struck from the history.
    await page.keyboard.press('z');
    await expect(page.getByTestId(TID.notice)).toContainText(`Undid Good on "${QP}".`);
    await expect(page.getByTestId(TID.progressText)).toHaveText('0 answered, 4 left (0%)');
    expect(await questionText(page)).toBe(QP);
    const restoredDb = await readStudyDb(page);
    const restored = cardByFront(restoredDb, QP);
    expect(restored.fsrs).toEqual(original.fsrs);
    expect(restored.dueAt).toBe(original.dueAt);
    expect(restoredDb.logs).toHaveLength(1);
    expect(restoredDb.logs[0]?.userCorrection?.kind).toBe('undone');
    expect(countedLogs(restoredDb)).toHaveLength(0);

    // The same buttons are offered again; this time Easy, and that matches the stored due too.
    await page.keyboard.press('Space');
    expect(await previewLabels(page)).toEqual(labels);
    await page.keyboard.press('4');
    await expect(page.getByTestId(TID.ratings)).toHaveCount(0);
    await expect(page.getByTestId(TID.progressText)).toHaveText('1 answered, 3 left (25%)');
    const afterEasy = cardByFront(await readStudyDb(page), QP);
    expectDueMatchesLabel(afterEasy, labels[4], T0, 'Easy');
    expect(afterEasy.fsrs.state).toBe('review');

    // --- card 2: multiple choice, right answer picked with the key ------------------------
    expect(await questionText(page)).toBe(QR);
    await expect(page.getByTestId(TID.choices)).toBeVisible();
    await expect(page.getByTestId(TID.mcqResult)).toHaveCount(0);
    const rightAt = await optionIndex(page, 'Aorta');
    await page.keyboard.press(String(rightAt + 1));
    await expect(page.getByTestId(TID.mcqResult)).toContainText('Correct. Good is suggested.');
    await expect(page.getByTestId(TID.mcqExplanation)).toContainText(
      'The aorta carries oxygenated blood out of the left ventricle.',
    );
    await expect(page.getByTestId(choiceId(rightAt))).toContainText('Correct answer');
    await expect(page.getByTestId(ratingId(3))).toContainText('Suggested');
    const mcqLabels = await previewLabels(page);
    await page.keyboard.press('3');
    await expect(page.getByTestId(TID.ratings)).toHaveCount(0);
    expectDueMatchesLabel(cardByFront(await readStudyDb(page), QR), mcqLabels[3], T0, 'MCQ Good');

    // --- card 3: multiple choice, wrong answer, then suspend (S) --------------------------
    expect(await questionText(page)).toBe(QW);
    const wrongAt = await optionIndex(page, 'Left ventricle');
    const keyAt = await optionIndex(page, 'Right atrium');
    await page.keyboard.press(String(wrongAt + 1));
    await expect(page.getByTestId(TID.mcqResult)).toContainText('Not quite. Again is suggested.');
    await expect(page.getByTestId(choiceId(wrongAt))).toContainText('Your answer');
    await expect(page.getByTestId(choiceId(keyAt))).toContainText('Correct answer');
    await expect(page.getByTestId(ratingId(1))).toContainText('Suggested');
    await expect(page.getByTestId(TID.mcqExplanation)).toContainText(
      'The right atrium receives systemic venous return.',
    );
    await page.keyboard.press('s');
    await expect(page.getByTestId(TID.notice)).toContainText('Card suspended.');
    const suspendedDb = await readStudyDb(page);
    const suspendedCard = cardByFront(suspendedDb, QW);
    expect(suspendedCard.suspended).toBe(true);
    expect(suspendedCard.fsrs.state, 'suspending is not answering').toBe('new');
    expect(countedLogs(suspendedDb).some((l) => l.cardId === suspendedCard.id)).toBe(false);

    // --- card 4: cloze with two deletions, uncovered one blank at a time ------------------
    await expect(page.getByTestId(TID.question)).toContainText('Q-cloze: the');
    await expect(page.getByTestId(blankId(1))).toBeVisible();
    await expect(page.getByTestId(blankId(2))).toBeVisible();
    await page.getByTestId(blankId(1)).click();
    await expect(page.getByTestId(blankId(1))).toContainText('heart');
    await expect(page.getByTestId(TID.ratings), 'one blank is still hidden').toHaveCount(0);
    await expect(page.getByTestId(blankId(2))).toHaveRole('button');
    await page.getByTestId(blankId(2)).click();
    await expect(page.getByTestId(blankId(2))).toContainText('blood');
    await expect(page.getByTestId(TID.ratings)).toBeVisible();
    const clozeLabels = await previewLabels(page);
    await page.keyboard.press('2');
    await expect(page.getByTestId(TID.ratings)).toHaveCount(0);
    const clozeCard = liveCards(await readStudyDb(page)).find((c) => c.cardType === 'cloze')!;
    expectDueMatchesLabel(clozeCard, clozeLabels[2], T0, 'cloze Hard');

    // --- learning steps come back in the same session; finish with Easy -------------------
    const rest = await answerAll(page, [4, 4]);
    expect(rest).toHaveLength(2);
    expect(rest[0]!.question).toContain('Q-cloze');
    expect(rest[1]!.question).toBe(QR);

    // --- summary ----------------------------------------------------------------------------
    const summary = page.getByTestId(TID.summary);
    await expect(summary).toBeVisible();
    await expect(summary.getByRole('heading', { name: 'Session complete' })).toBeVisible();
    await expect(page.getByTestId(TID.summaryAnswered)).toHaveText(
      'You answered 5 cards in about 0 s, 100% remembered.',
    );
    expect(await summary.locator('table tbody td').allTextContents()).toEqual(['0', '1', '1', '3']);
    await expect(summary).toContainText('3 new cards seen for the first time.');
    const finalDb = await readStudyDb(page);
    expect(countedLogs(finalDb)).toHaveLength(5);
    expect(finalDb.logs).toHaveLength(6); // plus the undone one, kept as history
    const b = dueBuckets(finalDb, T0);
    await expect(page.getByTestId(TID.summaryNext)).toHaveText(
      `${plural(b.overdue.length + b.today.length, 'card')} still due today, ${b.tomorrow.length} due tomorrow.`,
    );

    // --- back to the decks: nothing due; the suspended card lives in the card browser -----
    await summary.getByRole('button', { name: 'Back to decks' }).click();
    await expect(page.getByText('Nothing is due right now.').first()).toBeVisible();
    await expectDue(page, 0);

    await gotoTab(page, 'Cards');
    await setBrowserFilter(page, 'Suspended');
    const suspended = cardRow(page, QW);
    await expect(suspended).toContainText('Suspended');
    await suspended.getByRole('button', { name: 'Unsuspend' }).click();
    await expect(page.getByText('Card unsuspended.')).toBeVisible();

    // The browser prints the same due instant that is stored (study time zone UTC).
    await setBrowserFilter(page, 'All cards');
    const stored = cardByFront(await readStudyDb(page), QP);
    const expected = await whenText(page, stored.fsrs.due, 'UTC');
    await expect(cardRow(page, QP)).toContainText(`due ${expected}`);

    await gotoTab(page, 'Study');
    await expectDue(page, 1);
    noErrors(page);
  });

  test('"Jump to source" opens the page and shows the passage; the explanation shows the saved quote; bury lasts to the next study day exactly; a deleted highlight leaves the quote snapshot', async ({
    env,
  }) => {
    test.setTimeout(600_000);
    const ctx: Ctx = env;
    const [hl] = (await captureHighlights(ctx, '/review-physiology.html', ['#rv-co'])) as [
      Captured,
    ];
    await setClock(ctx, T0);
    const page = await openReview(ctx, { settings: UTC_DAY });
    const QS = 'Q-source: how is cardiac output calculated?';
    await openHighlightInAuthor(page, hl.id);
    await saveEditor(page, { t: 'basic', question: QS, answer: QUOTE_CO }, 1);

    await gotoTab(page, 'Study');
    await startAll(page);
    expect(await questionText(page)).toBe(QS);
    await expect(page.getByTestId(TID.source)).not.toHaveAttribute('aria-disabled', 'true');

    // Explain answer: the exact quote, labelled as such.
    await page.keyboard.press('Space');
    await page.keyboard.press('x');
    await expect(page.getByTestId(TID.explainPanel)).toBeVisible();
    await expect(page.getByTestId(TID.explainQuote)).toHaveText(QUOTE_CO);
    await expect(page.getByTestId(TID.explainPanel)).toContainText('Exactly as you saved it.');

    // J: a new tab on the source page, with the passage shown by the content script.
    const opened = ctx.context.waitForEvent('page');
    await page.keyboard.press('j');
    const source = await opened;
    await source.waitForLoadState('domcontentloaded');
    expect(source.url()).toBe(`${ctx.origin}/review-physiology.html`);
    if (hasPersistentAccess(ctx)) {
      // The content script is registered for the origin: the passage is found and shown.
      await expect(page.getByText('Opened the source and showed the passage.')).toBeVisible();
      await expect
        .poll(() =>
          source.evaluate(() =>
            [...(CSS.highlights.get('sv-hl-active') ?? [])].map((r) =>
              (r as Range).toString().replace(/\s+/g, ' ').trim(),
            ),
          ),
        )
        .toContain(QUOTE_CO);
    } else {
      // The worker would not register the origin (see captureHighlights): the page opens, and the
      // product says honestly that it could not show the passage there.
      await expect(
        page.getByText(/Opened the source page\. StudyVault could not show the passage there/),
      ).toBeVisible({ timeout: 60_000 });
    }
    await source.close();
    await page.bringToFront();

    // B: buried until the next study day starts, and not a minute longer.
    await page.keyboard.press('b');
    await expect(page.getByText('Card buried until the next study day.')).toBeVisible();
    const nextDay = iso(studyDayStart(T0) + DAY);
    expect(nextDay).toBe('2026-03-11T04:00:00.000Z');
    expect(cardByFront(await readStudyDb(page), QS).buriedUntil).toBe(nextDay);

    await gotoTab(page, 'Cards');
    await setBrowserFilter(page, 'Buried');
    await expect(cardRow(page, QS)).toBeVisible();

    await setClock(ctx, Date.parse(nextDay) - MINUTE);
    await reloadTo(page, 'Study');
    await expectDue(page, 0);
    await setClock(ctx, Date.parse(nextDay));
    await reloadTo(page, 'Study');
    await expectDue(page, 1);

    // The highlight is deleted: the card keeps a copy of the quote and says so.
    const ext = await ctx.context.newPage();
    await ext.goto(`chrome-extension://${ctx.extensionId}/options.html`);
    await bgData(ext, 'highlight.delete', { id: hl.id });
    await ext.close();
    await reloadTo(page, 'Study');
    await startAll(page);
    await page.keyboard.press('Space');
    await page.keyboard.press('x');
    await expect(page.getByTestId(TID.explainQuote)).toHaveText(QUOTE_CO);
    await expect(page.getByTestId(TID.explainPanel)).toContainText(
      'The original highlight was deleted; this is the copy kept on the card.',
    );
    await page.keyboard.press('j');
    await expect(
      page.getByText(
        'This card has no linked source: it is a free-standing card, or its highlight was deleted.',
      ),
    ).toBeVisible();
    expect(cardByFront(await readStudyDb(page), QS).sourceQuote).toBe(QUOTE_CO);
    noErrors(page);
  });
});

/** Choose a file through the real file chooser behind "Choose a PDF file". */
async function chooseFile(page: Page, name: string, bytes: Buffer): Promise<void> {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByTestId('pdf-choose-file').click(),
  ]);
  await chooser.setFiles({ name, mimeType: 'application/pdf', buffer: bytes });
}

test.describe('study session from a PDF', () => {
  test('"Jump to source" on a card made from a PDF highlight opens the PDF reader on that page and, with the file chosen again, on the passage', async ({
    env,
  }) => {
    test.setTimeout(600_000);
    const ctx: Ctx = env;
    const bytes = proseDoc(3, 'Renal physiology');

    // A highlight in the extension's own PDF reader (a real drag-free selection, real Save).
    const reader = await ctx.context.newPage();
    await reader.goto(`chrome-extension://${ctx.extensionId}/pdf-reader.html`);
    await expect(reader.getByTestId('pdf-reader')).toBeVisible();
    await chooseFile(reader, 'renal.pdf', bytes);
    await expect(reader.getByTestId('pdf-viewer')).toBeVisible({ timeout: 90_000 });
    await reader.getByTestId('pdf-page-2').scrollIntoViewIfNeeded();
    const layer = reader.locator('[data-testid="pdf-page-2"] .sv-textlayer');
    await expect(layer).toBeAttached({ timeout: 60_000 });
    await expect
      .poll(async () => ((await layer.textContent()) ?? '').trim().length, { timeout: 60_000 })
      .toBeGreaterThan(0);
    await reader.evaluate(() => {
      const spans = [
        ...document.querySelectorAll('[data-testid="pdf-page-2"] .sv-textlayer span'),
      ] as HTMLElement[];
      const span = spans.find((el) => (el.textContent ?? '').includes('Page 2 line 1'));
      if (!span?.firstChild) throw new Error('text not found');
      const at = (span.textContent ?? '').indexOf('Page 2 line 1');
      document
        .getSelection()!
        .setBaseAndExtent(span.firstChild, at, span.firstChild, at + 'Page 2 line 1'.length);
    });
    await expect(reader.getByTestId('pdf-savebar')).toBeVisible();
    await reader.getByTestId('pdf-save').click();
    await expect(reader.getByTestId('pdf-savebar')).toHaveCount(0);
    await expect(reader.getByTestId('pdf-highlight-card').first()).toBeVisible();
    const highlights = await reader.evaluate(
      () =>
        new Promise<Array<{ id: string; exactQuote: string; anchorSet: { type: string } }>>(
          (resolve, reject) => {
            const open = indexedDB.open('studyvault');
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
              const db = open.result;
              const all = db
                .transaction('highlights', 'readonly')
                .objectStore('highlights')
                .getAll();
              all.onsuccess = () => {
                db.close();
                resolve(all.result);
              };
              all.onerror = () => reject(all.error);
            };
          },
        ),
    );
    const hl = highlights.find((h) => h.exactQuote.includes('Page 2 line 1'))!;
    expect(hl.anchorSet.type).toBe('pdf');
    await reader.close();

    // A card from it, in the review page; the picker names the page.
    const page = await openReview(ctx);
    await gotoTab(page, 'Create cards');
    await expect(page.getByTestId(`rv-pick-${hl.id}`)).toBeVisible();
    await openHighlightInAuthor(page, hl.id);
    await expect(page.getByText('From Renal physiology, page 2.')).toBeVisible();
    await saveEditor(
      page,
      { t: 'basic', question: 'PDF-card: which line is this?', answer: hl.exactQuote },
      1,
    );
    const card = cardByFront(await readStudyDb(page), 'PDF-card: which line is this?');
    expect(card.highlightId).toBe(hl.id);
    expect(card.sourceQuote).toBe(hl.exactQuote);

    await gotoTab(page, 'Study');
    await startAll(page);
    const opened = ctx.context.waitForEvent('page');
    await page.keyboard.press('j');
    const pdf = await opened;
    await expect(page.getByText('Opened the PDF reader on page 2.')).toBeVisible();
    const address = new URL(pdf.url());
    expect(address.pathname).toBe('/pdf-reader.html');
    expect(address.searchParams.get('page')).toBe('2');
    expect(address.searchParams.get('highlight')).toBe(hl.id);
    expect(address.searchParams.get('doc')).toBeTruthy();
    // No copy of the file was kept, and the reader says so instead of pretending.
    await expect(pdf.getByText(/does not keep a copy of that PDF/)).toBeVisible();
    // Choosing the same file again brings the saved highlight back, on page 2.
    await chooseFile(pdf, 'renal.pdf', bytes);
    await expect(pdf.getByTestId('pdf-viewer')).toBeVisible({ timeout: 90_000 });
    await expect(pdf.locator('[data-testid="pdf-page-2"] .sv-pdf-hl').first()).toBeVisible({
      timeout: 60_000,
    });
    await expect(pdf.getByTestId('pdf-highlight-card').first()).toContainText('Page 2 line 1');
    noErrors(page);
  });
});

// ===============================================================================================
// 3. Persistence: reload, service worker stop, browser restart, double input, two tabs
// ===============================================================================================

test.describe('persistence', () => {
  test('reload mid-session: Continue picks up at the next card, nothing repeats, nothing is lost; a session of an earlier study day is closed with a message', async ({
    env,
  }) => {
    const ctx: Ctx = env;
    await setClock(ctx, T0);
    const page = await openReview(ctx, { settings: UTC_DAY });
    await createBasicCards(page, [
      ['Q-one', 'a1'],
      ['Q-two', 'a2'],
      ['Q-three', 'a3'],
    ]);
    await gotoTab(page, 'Study');
    await expectDue(page, 3);
    await startAll(page);
    expect(await questionText(page)).toBe('Q-one');
    await answerWith(page, 4);
    await expect(page.getByTestId(TID.progressText)).toHaveText('1 answered, 2 left (33%)');

    await reloadTo(page, 'Study');
    await expect(page.getByTestId(TID.deckPicker)).toContainText('A session is in progress');
    await expect(page.getByTestId(TID.deckPicker)).toContainText('You answered 1 so far.');
    await expect(page.getByTestId(TID.continue)).toHaveText('Continue (2 left)');
    await page.getByTestId(TID.continue).click();
    expect(await questionText(page), 'the answered card is not shown again').toBe('Q-two');
    await expect(page.getByTestId(TID.progressText)).toHaveText('1 answered, 2 left (33%)');
    await answerWith(page, 4);

    await reloadTo(page, 'Study');
    await expect(page.getByTestId(TID.continue)).toHaveText('Continue (1 left)');
    await page.getByTestId(TID.continue).click();
    expect(await questionText(page)).toBe('Q-three');
    await answerWith(page, 4);
    await expect(page.getByTestId(TID.summaryAnswered)).toContainText('You answered 3 cards');

    const db = await readStudyDb(page);
    expect(countedLogs(db)).toHaveLength(3);
    expect(new Set(countedLogs(db).map((l) => l.cardId)).size).toBe(3);
    expect(db.session, 'a finished session leaves nothing to continue').toBeNull();

    // A session saved on an earlier study day is closed with a message, not resumed.
    await createBasicCards(page, [
      ['Q-four', 'a4'],
      ['Q-five', 'a5'],
    ]);
    await gotoTab(page, 'Study');
    await startAll(page);
    expect(await questionText(page)).toBe('Q-four');
    await answerWith(page, 4);
    await setClock(ctx, T0 + DAY);
    await reloadTo(page, 'Study');
    await expect(page.getByTestId(TID.continue)).toHaveText('Continue (1 left)');
    await page.getByTestId(TID.continue).click();
    await expect(page.getByTestId(TID.deckPicker)).toContainText(
      'That session was from an earlier study day, so it was closed. Start a new one.',
    );
    await expectDue(page, 1);
    await startAll(page);
    expect(await questionText(page)).toBe('Q-five');
    await answerWith(page, 4);
    await expect(page.getByTestId(TID.summaryAnswered)).toContainText('You answered 1 card');
    expect(countedLogs(await readStudyDb(page))).toHaveLength(5);
    noErrors(page);
  });

  test('the service worker is stopped mid-session: answering, undo and the summary keep working and nothing is lost', async ({
    env,
  }) => {
    const ctx: Ctx = env;
    await setClock(ctx, T0);
    const page = await openReview(ctx, { settings: UTC_DAY });
    await createBasicCards(page, [
      ['W-one', 'a1'],
      ['W-two', 'a2'],
      ['W-three', 'a3'],
    ]);
    await gotoTab(page, 'Study');
    await startAll(page);
    await answerWith(page, 4);

    const control = await ctx.context.newPage();
    await control.goto(`chrome-extension://${ctx.extensionId}/options.html`);
    const before = await markWorker(ctx.context, ctx.extensionId, 'rv-session-probe');
    await stopWorker(ctx.context, ctx.extensionId, page);
    await page.bringToFront();

    // Worker is down: the review page does not need it.
    await answerWith(page, 3);
    await expect(page.getByTestId(TID.progressText)).toContainText('2 answered');
    await page.keyboard.press('z');
    await expect(page.getByTestId(TID.notice)).toContainText('Undid Good on "W-two".');
    await answerWith(page, 4);
    await expect(page.getByTestId(TID.progressText)).toHaveText('2 answered, 1 left (67%)');

    const woke = await wakeWorker(control, ctx.context, ctx.extensionId);
    expect(woke.probe, 'a fresh worker instance, the planted probe is gone').toBeNull();
    expect(woke.timeOrigin).toBeGreaterThan(before.timeOrigin);

    await page.bringToFront();
    await answerWith(page, 4);
    await expect(page.getByTestId(TID.summaryAnswered)).toContainText('You answered 3 cards');
    const db = await readStudyDb(page);
    expect(countedLogs(db)).toHaveLength(3);
    expect(new Set(countedLogs(db).map((l) => l.cardId)).size).toBe(3);
    expect(db.logs.filter((l) => l.userCorrection)).toHaveLength(1);
    noErrors(page);
  });

  for (const how of ['closed normally', 'killed without a clean shutdown'] as const) {
    test(`the browser is ${how} mid-session and reopened on the same profile: due state, review logs and counts are identical`, async ({
      fixtureServer,
    }) => {
      test.setTimeout(420_000);
      const dir = newUserDataDir();
      let first: Session | null = null;
      let second: Session | null = null;
      try {
        first = await launchSession(dir);
        const ctx1 = ctxOf(first, fixtureServer.origin);
        const [hl] = (await captureHighlights(ctx1, '/review-physiology.html', ['#rv-sv'])) as [
          Captured,
        ];
        await setClock(ctx1, T0);
        const page1 = await openReview(ctx1, { settings: UTC_DAY });
        await openHighlightInAuthor(page1, hl.id);
        await saveEditor(
          page1,
          { t: 'basic', question: 'R-linked: what is stroke volume?', answer: QUOTE_SV },
          1,
        );
        await createBasicCards(page1, [
          ['R-typed-1', 'a1'],
          ['R-typed-2', 'a2'],
        ]);
        await gotoTab(page1, 'Study');
        await expectDue(page1, 3);
        await startAll(page1);
        await answerWith(page1, 4); // graduates
        await answerWith(page1, 3); // enters learning, comes back later in the session
        await expect(page1.getByTestId(TID.progressText)).toContainText('2 answered');
        const stillOnScreen = await questionText(page1); // unanswered when the browser goes away

        const before = await readStudyDb(page1);
        expect(countedLogs(before)).toHaveLength(2);
        expect(before.session?.answered).toBe(2);

        if (how === 'closed normally') await first.context.close();
        else await hardKill(first);
        first = null;

        second = await launchSession(dir);
        const ctx2 = ctxOf(second, fixtureServer.origin);
        await setClock(ctx2, T0);
        const page2 = await openReview(ctx2, { settings: UTC_DAY });
        await expect(page2.getByTestId(TID.deckPicker)).toBeVisible();

        // Identical data: every card row, every log, every deck, the session.
        const after = await readStudyDb(page2);
        const byId = <T extends { id: string }>(rows: T[]) =>
          [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));
        expect(byId(after.cards)).toEqual(byId(before.cards));
        expect(byId(after.logs)).toEqual(byId(before.logs));
        expect(byId(after.decks)).toEqual(byId(before.decks));
        expect(after.session).toEqual(before.session);

        // The same counts on screen: the unanswered card plus the learning step.
        const queue = dueBuckets(after, T0);
        expect(queue.studied).toHaveLength(2);
        const due = await dueNumbers(page2);
        expect(due.total).toBe(2);
        expect(due.new).toBe(1);
        expect(due.learning).toBe(1);
        await expect(page2.getByTestId(TID.continue)).toHaveText('Continue (2 left)');
        await expect(page2.getByTestId(TID.deckPicker)).toContainText('You answered 2 so far.');

        // Continue: the unanswered card first, then the learning step; no card twice, none lost.
        await page2.getByTestId(TID.continue).click();
        expect(await questionText(page2)).toBe(stillOnScreen);
        const rest = await answerAll(page2, [4, 4]);
        expect(rest).toHaveLength(2);
        await expect(page2.getByTestId(TID.summaryAnswered)).toContainText('You answered 4 cards');

        const done = await readStudyDb(page2);
        const logs = countedLogs(done);
        expect(logs).toHaveLength(4);
        const perCard = new Map<string, number>();
        for (const l of logs) perCard.set(l.cardId, (perCard.get(l.cardId) ?? 0) + 1);
        expect([...perCard.values()].sort()).toEqual([1, 1, 2]);
        expect(liveCards(done).every((c) => c.fsrs.state === 'review')).toBe(true);
        // The linked card still knows its source after the restart.
        const linked = liveCards(done).find((c) => c.front.startsWith('R-linked'))!;
        expect(linked.highlightId).toBe(hl.id);
        expect(linked.sourceQuote).toBe(QUOTE_SV);
        expect(done.session).toBeNull();
        noErrors(page2);
      } finally {
        if (first) await first.context.close().catch(() => undefined);
        if (second) await second.context.close().catch(() => undefined);
        try {
          removeDir(dir);
        } catch {
          // Windows can keep a handle on the profile for a moment after the browser process exits;
          // the temp folder is not part of what is under test.
        }
      }
    });
  }

  test('a double click on a rating answers once: one log, one card advanced, none skipped', async ({
    env,
  }) => {
    const ctx: Ctx = env;
    await setClock(ctx, T0);
    const page = await openReview(ctx, { settings: UTC_DAY });
    await createBasicCards(page, [
      ['D-one', 'a1'],
      ['D-two', 'a2'],
      ['D-three', 'a3'],
    ]);
    await gotoTab(page, 'Study');
    await startAll(page);

    // A real double click (two clicks, 0 ms apart).
    expect(await questionText(page)).toBe('D-one');
    await page.keyboard.press('Space');
    await page.getByTestId(ratingId(4)).dblclick();
    await expect(page.getByTestId(TID.ratings)).toHaveCount(0);
    await expect(page.getByTestId(TID.progressText)).toHaveText('1 answered, 2 left (33%)');
    expect(await questionText(page), 'the card after it, not the one after that').toBe('D-two');
    expect(countedLogs(await readStudyDb(page))).toHaveLength(1);

    // Two activations in the same tick (a stuck key, a script): still one answer.
    await page.keyboard.press('Space');
    await page.getByTestId(ratingId(4)).evaluate((button: HTMLElement) => {
      button.click();
      button.click();
    });
    await expect(page.getByTestId(TID.ratings)).toHaveCount(0);
    await expect(page.getByTestId(TID.progressText)).toHaveText('2 answered, 1 left (67%)');
    expect(await questionText(page)).toBe('D-three');

    // The same for the keyboard: two key presses without waiting.
    await page.keyboard.press('Space');
    await Promise.all([page.keyboard.press('4'), page.keyboard.press('4')]);
    await expect(page.getByTestId(TID.summary)).toBeVisible();
    const db = await readStudyDb(page);
    const logs = countedLogs(db);
    expect(logs).toHaveLength(3);
    expect(new Set(logs.map((l) => l.cardId)).size).toBe(3);
    expect(logs.every((l) => l.rating === 4)).toBe(true);
    await expect(page.getByTestId(TID.summaryAnswered)).toContainText('You answered 3 cards');
    noErrors(page);
  });

  test('two review tabs on the same card: the second answer gets the "changed in another window" handling, never a second review', async ({
    env,
  }) => {
    const ctx: Ctx = env;
    await setClock(ctx, T0);
    const a = await openReview(ctx, { settings: UTC_DAY });
    await createBasicCards(a, [
      ['T-x', 'ax'],
      ['T-y', 'ay'],
      ['T-z', 'az'],
    ]);
    await gotoTab(a, 'Study');
    await startAll(a);
    expect(await questionText(a)).toBe('T-x');

    // Tab B continues the same stored session and shows the same first card.
    const b = await openReview(ctx);
    await expect(b.getByTestId(TID.continue)).toBeVisible();
    await b.getByTestId(TID.continue).click();
    expect(await questionText(b)).toBe('T-x');

    // B answers first (Easy).
    await b.bringToFront();
    await answerWith(b, 4);
    await expect(b.getByTestId(TID.progressText)).toHaveText('1 answered, 2 left (33%)');

    // A, still on T-x, answers Good: refused as stale, A moves on with the card's current state.
    await a.bringToFront();
    await a.keyboard.press('Space');
    await a.keyboard.press('3');
    await expect(a.getByTestId(TID.notice)).toContainText(
      'This card was changed in another window, so its current state is used.',
    );
    expect(await questionText(a), 'A moved on to the next card').toBe('T-y');
    let db = await readStudyDb(a);
    const x = cardByFront(db, 'T-x');
    const xLogs = countedLogs(db).filter((l) => l.cardId === x.id);
    expect(xLogs, 'T-x was reviewed once').toHaveLength(1);
    expect(xLogs[0]?.rating, 'by B, with B’s answer').toBe(4);
    expect(x.fsrs.state).toBe('review');

    // A answers T-y; B (still showing T-y) is stale in turn.
    await answerWith(a, 4);
    await b.bringToFront();
    await b.keyboard.press('Space');
    await b.keyboard.press('3');
    await expect(b.getByTestId(TID.notice)).toContainText(
      'This card was changed in another window, so its current state is used.',
    );
    expect(await questionText(b)).toBe('T-z');
    await answerWith(b, 4);
    await expect(b.getByTestId(TID.summary)).toBeVisible();

    // A still shows T-z: stale as well, then the session is simply over for it.
    await a.bringToFront();
    await a.keyboard.press('Space');
    await a.keyboard.press('3');
    await expect(a.getByTestId(TID.summary)).toBeVisible();

    db = await readStudyDb(a);
    const logs = countedLogs(db);
    expect(logs).toHaveLength(3);
    expect(new Set(logs.map((l) => l.cardId)).size, 'each card answered exactly once').toBe(3);
    expect(logs.map((l) => l.rating)).toEqual([4, 4, 4]);
    noErrors(a);
    noErrors(b);
  });
});

// ===============================================================================================
// 4. Daily caps, deck settings validation, study-day rollover and time zone
// ===============================================================================================

test.describe('daily caps and the study day', () => {
  test('new and review caps are honoured, deferred cards stay due and are reported, an undone answer does not use the cap, the next study day resets it', async ({
    env,
  }) => {
    const ctx: Ctx = env;
    await setClock(ctx, T0);
    const page = await openReview(ctx, { settings: UTC_DAY });
    await createTypedClozeCards(page, 6);
    await saveDeckSettings(page, 'General', { newPerDay: '4', fuzz: false });

    // New cap: 6 new cards, 4 allowed today; the rest are reported, not dropped.
    await gotoTab(page, 'Study');
    await expectDue(page, 4);
    expect((await dueNumbers(page)).new).toBe(4);
    await expect(page.getByTestId(TID.deferredNote)).toContainText(
      /2 more cards \(0 reviews, 2 new\) are due but beyond today.s daily limits\. They stay due and are not skipped/,
    );
    await startAll(page);
    await answerAll(page, [4, 4, 4, 4]);
    await expect(page.getByTestId(TID.summaryAnswered)).toContainText('You answered 4 cards');
    await page.getByRole('button', { name: 'Back to decks' }).click();
    await expectDue(page, 0);
    await expect(page.getByTestId(TID.deferredNote)).toContainText(
      '2 more cards (0 reviews, 2 new)',
    );
    const day0 = await readStudyDb(page);
    expect(liveCards(day0).filter((c) => c.fsrs.state === 'new')).toHaveLength(2);

    // Review cap: the four graduated cards come back 16 days later; allow 2 reviews and 1 new.
    await setClock(ctx, T0 + 17 * DAY);
    await saveDeckSettings(page, 'General', { newPerDay: '1', reviewsPerDay: '2' });
    await reloadTo(page, 'Study');
    await expectDue(page, 3);
    const due = await dueNumbers(page);
    expect([due.new, due.review, due.learning]).toEqual([1, 2, 0]);
    await expect(page.getByTestId(TID.deferredNote)).toContainText(
      '3 more cards (2 reviews, 1 new)',
    );

    // An answer that is undone does not use up the cap.
    await startAll(page);
    await page.keyboard.press('Space');
    await page.keyboard.press('4');
    await expect(page.getByTestId(TID.ratings)).toHaveCount(0);
    await page.keyboard.press('z');
    await expect(page.getByTestId(TID.notice)).toContainText('Undid Easy');
    await page.getByTestId(TID.leave).click();
    await expectDue(page, 3);

    // Answer everything that is offered.
    await page.getByTestId(TID.continue).click();
    const done = await answerAll(page, [4, 4, 4]);
    expect(done).toHaveLength(3);
    await expect(page.getByTestId(TID.summaryAnswered)).toContainText('You answered 3 cards');
    await page.getByRole('button', { name: 'Back to decks' }).click();
    await expectDue(page, 0);
    await expect(page.getByTestId(TID.deferredNote)).toContainText(
      '3 more cards (2 reviews, 1 new)',
    );
    // Nothing was skipped or rescheduled: the deferred cards are exactly where they were.
    const afterCaps = await readStudyDb(page);
    const still = liveCards(afterCaps).filter(
      (c) => c.fsrs.state === 'review' && Date.parse(c.fsrs.due) <= T0 + 17 * DAY,
    );
    expect(still).toHaveLength(2);
    expect(liveCards(afterCaps).filter((c) => c.fsrs.state === 'new')).toHaveLength(1);
    expect(liveCards(afterCaps).every((c) => !c.suspended && c.buriedUntil === null)).toBe(true);

    // The next study day starts with fresh caps: the 2 reviews and 1 new card are offered.
    await setClock(ctx, T0 + 18 * DAY);
    await reloadTo(page, 'Study');
    await expectDue(page, 3);
    await expect(page.getByTestId(TID.deferredNote)).toHaveCount(0);
    noErrors(page);
  });

  test('deck settings are validated before saving, say what is wrong, and apply from the next answer; study-day settings are validated too', async ({
    env,
  }) => {
    const ctx: Ctx = env;
    // The real clock on purpose: with a pinned clock every update gets the same timestamp and the
    // settings form is never re-created, which hides how the form behaves in real use.
    const page = await openReview(ctx, { settings: UTC_DAY });
    await createBasicCards(page, [['Q-settings', 'A']]);
    const before = cardByFront(await readStudyDb(page), 'Q-settings');

    const form = await openDeckForm(page, 'General');
    const save = form.getByTestId(TID.deckSettingsSave);
    await expect(save).toHaveAttribute('aria-disabled', 'true');
    await expect(save).toHaveAttribute('title', 'There are no changes to save.');

    const defaults = {
      targetRetentionPct: '90',
      newPerDay: '20',
      reviewsPerDay: '200',
      maxIntervalDays: '36500',
      learningSteps: '1m 10m',
      relearnSteps: '10m',
      leechThreshold: '8',
    } as const;
    const label = {
      targetRetentionPct: 'Target retention (%)',
      newPerDay: 'New cards per day',
      reviewsPerDay: 'Reviews per day',
      maxIntervalDays: 'Maximum interval (days)',
      learningSteps: 'Learning steps',
      relearnSteps: 'Relearning steps',
      leechThreshold: 'Leech threshold',
    } as const;
    const bad: Array<[keyof typeof defaults, string, string]> = [
      ['targetRetentionPct', 'abc', 'Enter a percentage between 70 and 99.'],
      ['targetRetentionPct', '50', 'Target retention must be between 70% and 99%.'],
      ['targetRetentionPct', '100', 'Target retention must be between 70% and 99%.'],
      ['newPerDay', '-1', 'New cards per day must be a whole number.'],
      ['newPerDay', '10000', 'New cards per day must be between 0 and 9999.'],
      ['reviewsPerDay', '1.5', 'Reviews per day must be a whole number.'],
      ['maxIntervalDays', '0', 'Maximum interval must be between 1 and 36500.'],
      ['leechThreshold', '0', 'Leech threshold must be between 1 and 99.'],
      [
        'learningSteps',
        '1x 10m',
        '"1x" is not a step. Write whole numbers with m, h or d: 1m 10m 1h 1d.',
      ],
      ['learningSteps', '1m 2m 3m 4m 5m 6m 7m 8m 9m', 'Learning steps: use at most 8 steps.'],
      [
        'relearnSteps',
        '0m',
        '"0m" is not a step. Write whole numbers with m, h or d: 1m 10m 1h 1d.',
      ],
    ];
    for (const [field, value, message] of bad) {
      const input = form.getByLabel(label[field], { exact: true });
      await input.fill(value);
      await expect(form.getByText(message)).toBeVisible();
      await expect(input).toHaveAttribute('aria-invalid', 'true');
      await expect(save).toHaveAttribute('aria-disabled', 'true');
      await expect(save).toHaveAttribute('title', 'Fix the fields marked with a cross first.');
      await input.fill(defaults[field]);
      await expect(form.getByText(message)).toHaveCount(0);
    }

    // Valid: saved, stored, and cards already scheduled are not rewritten.
    await fillDeckForm(form, {
      targetRetentionPct: '85',
      newPerDay: '5',
      reviewsPerDay: '50',
      maxIntervalDays: '365',
      learningSteps: '2m 20m',
      relearnSteps: '5m',
      leechThreshold: '4',
      fuzz: false,
    });
    await save.click();
    const savedNotice = form.getByText(/^Saved\. The new rules apply from the next answer/);
    await expect(savedNotice).toBeVisible();
    // The confirmation stays on screen; it is not a flash that the next render takes away.
    await page.waitForTimeout(1_500);
    await expect(savedNotice).toBeVisible();
    const stored = (await readStudyDb(page)).decks.find((d) => d.name === 'General')!;
    expect(stored.settings).toEqual({
      newPerDay: 5,
      reviewsPerDay: 50,
      targetRetention: 0.85,
      learningSteps: ['2m', '20m'],
      relearnSteps: ['5m'],
      maxIntervalDays: 365,
      enableFuzz: false,
      leechThreshold: 4,
    });
    const unchanged = cardByFront(await readStudyDb(page), 'Q-settings');
    expect(unchanged.fsrs).toEqual(before.fsrs);
    expect(unchanged.updatedAt).toBe(before.updatedAt);

    // "Use the defaults" only fills the form; nothing changes until it is saved.
    await form.getByTestId(TID.deckSettingsReset).click();
    await expect(form.getByLabel('Learning steps', { exact: true })).toHaveValue('1m 10m');
    await expect(save).not.toHaveAttribute('aria-disabled', 'true');
    await reloadTo(page, 'Settings');
    const again = await openDeckForm(page, 'General');
    await expect(again.getByLabel('Learning steps', { exact: true })).toHaveValue('2m 20m');
    await expect(again.getByLabel('New cards per day', { exact: true })).toHaveValue('5');

    // The new steps are what the buttons offer for the next answer.
    await gotoTab(page, 'Study');
    await startAll(page);
    await page.keyboard.press('Space');
    const labels = await previewLabels(page);
    expect([labels[1], labels[3]]).toEqual(['2m', '20m']);
    await page.getByTestId(TID.leave).click();

    // Study-day settings: a name Chrome does not know is refused with the reason.
    await gotoTab(page, 'Settings');
    const day = page.getByTestId(TID.studyDay);
    const daySave = day.getByTestId(TID.studyDaySave);
    await day.getByTestId(TID.timeZone).fill('Mars/Phobos');
    await expect(day.getByText('That is not a time zone name Chrome knows.')).toBeVisible();
    await expect(daySave).toHaveAttribute('aria-disabled', 'true');
    await expect(daySave).toHaveAttribute('title', /Enter a time zone name such as Europe\/Berlin/);
    await setStudyDayInUi(page, { timeZone: 'Europe/Berlin', rolloverHour: 6 });
    expect(await storedStudySettings(page)).toMatchObject({
      timeZone: 'Europe/Berlin',
      rolloverHour: 6,
    });
    await expect(day).toContainText(/it is study day \d{4}-\d{2}-\d{2} now/);
    await reloadTo(page, 'Settings');
    await expect(page.getByTestId(TID.timeZone)).toHaveValue('Europe/Berlin');
    await expect(page.getByTestId(TID.rollover)).toHaveValue('6');
    noErrors(page);
  });

  test('the rollover hour and the time zone change what is due today', async ({ env }) => {
    const ctx: Ctx = env;
    // 23:00 UTC on 10 March: UTC study day 10 March (rollover 04:00).
    const lateEvening = Date.UTC(2026, 2, 10, 23, 0, 0);
    await setClock(ctx, lateEvening);
    const page = await openReview(ctx, { settings: UTC_DAY });
    await createTypedClozeCards(page, 3);
    await saveDeckSettings(page, 'General', { newPerDay: '1', fuzz: false });
    await gotoTab(page, 'Study');
    await expectDue(page, 1);
    await startAll(page);
    await answerAll(page, [4]);
    await page.getByRole('button', { name: 'Back to decks' }).click();
    await expectDue(page, 0);
    await expect(page.getByTestId(TID.deferredNote)).toContainText(
      '2 more cards (0 reviews, 2 new)',
    );

    // 02:00 UTC next morning. The same instants, seen through different study-day settings.
    await setClock(ctx, Date.UTC(2026, 2, 11, 2, 0, 0));
    await reloadTo(page, 'Study');
    await expectDue(page, 0); // UTC, rollover 04:00: still 10 March, the daily cap is used up

    const check = async (
      zone: string,
      hour: number,
      studyDayKey: string,
      due: number,
      why: string,
    ) => {
      await setStudyDayInUi(page, { timeZone: zone, rolloverHour: hour });
      await expect(page.getByTestId(TID.studyDay)).toContainText(
        `it is study day ${studyDayKey} now`,
      );
      await gotoTab(page, 'Study');
      await expect(page.getByTestId(TID.dueTotal), why).toHaveText(String(due));
    };
    await check('UTC', 0, '2026-03-11', 1, 'rollover at midnight: 02:00 is a new study day');
    await check('Europe/Moscow', 4, '2026-03-11', 1, 'Moscow: day changed at 01:00 UTC');
    await check('America/Los_Angeles', 4, '2026-03-10', 0, 'Los Angeles: still the 10th, 19:00');
    // Karachi (UTC+5, no DST): the day changes at exactly 23:00 UTC, the instant of the answer, so
    // the answer belongs to the new day and the cap is still used.
    await check('Asia/Karachi', 4, '2026-03-11', 0, 'a day boundary is inclusive of its start');
    noErrors(page);
  });

  // The device clock and time zone cannot be changed from a test, but the study-day arithmetic
  // runs on the browser's own Intl/ICU: pinning the page clock and choosing the zone in the
  // settings exercises the real DST tables in Chromium.
  for (const scenario of [
    {
      name: 'spring forward: a 23-hour day (New York, 8 March 2026)',
      at: Date.UTC(2026, 2, 7, 20, 0, 0), // 15:00 EST on the 7th
      // 02:00 EST jumps to 03:00 EDT, so 04:00 on the 8th is EDT: 08:00 UTC, not 09:00.
      until: '2026-03-08T08:00:00.000Z',
    },
    {
      name: 'fall back: a 25-hour day (New York, 1 November 2026)',
      at: Date.UTC(2026, 9, 31, 20, 0, 0), // 16:00 EDT on the 31st
      // 02:00 EDT returns to 01:00 EST, so 04:00 on the 1st is EST: 09:00 UTC, not 08:00.
      until: '2026-11-01T09:00:00.000Z',
    },
  ]) {
    test(`study-day boundary is DST-exact in a real browser, ${scenario.name}`, async ({ env }) => {
      const ctx: Ctx = env;
      await setClock(ctx, scenario.at);
      const page = await openReview(ctx, {
        settings: { timeZone: 'America/New_York', rolloverHour: 4 },
      });
      await createBasicCards(page, [['DST card', 'a']]);
      await gotoTab(page, 'Study');
      await startAll(page);
      await page.keyboard.press('b');
      await expect(page.getByText('Card buried until the next study day.')).toBeVisible();
      expect(cardByFront(await readStudyDb(page), 'DST card').buriedUntil).toBe(scenario.until);

      const until = Date.parse(scenario.until);
      await setClock(ctx, until - MINUTE);
      await reloadTo(page, 'Study');
      await expectDue(page, 0);
      await setClock(ctx, until);
      await reloadTo(page, 'Study');
      await expectDue(page, 1);
      noErrors(page);
    });
  }
});

// ===============================================================================================
// 5. Backlog recovery
// ===============================================================================================

test.describe('backlog recovery', () => {
  test('the plan is shown before anything changes; applying spreads overdue cards by due date only; what does not fit is reported, never skipped silently', async ({
    env,
  }) => {
    const ctx: Ctx = env;
    await setClock(ctx, T0);
    const page = await openReview(ctx, { settings: UTC_DAY });
    await createTypedClozeCards(page, 24);
    await saveDeckSettings(page, 'General', { newPerDay: '30', fuzz: false });
    await gotoTab(page, 'Study');
    await startAll(page);
    expect(await answerAll(page, Array<Rating>(24).fill(4))).toHaveLength(24);
    await expect(page.getByTestId(TID.summaryAnswered)).toContainText('You answered 24 cards');
    const seeded = await readStudyDb(page);
    expect(liveCards(seeded).every((c) => c.fsrs.state === 'review')).toBe(true);

    // 40 days later every card is overdue.
    const now = T0 + 40 * DAY;
    await setClock(ctx, now);
    await reloadTo(page, 'Study');
    await expectDue(page, 24);
    const summary = page.getByText('24 overdue reviews: recover from the backlog');
    await expect(summary).toBeVisible();
    const backlog = page.getByTestId(TID.backlog);
    await expect(backlog).toBeVisible(); // open by itself from 20 overdue cards up

    // Plan: 10 reviews per day over 3 days.
    await backlog.getByLabel('Reviews per day, per deck').fill('10');
    await backlog.getByTestId(TID.backlogDays).selectOption('3');
    const plan = page.getByTestId(TID.backlogPlan);
    await expect(plan).toContainText('10 overdue cards stay due today');
    await expect(plan).toContainText('14 cards move to later days:');
    const rows = await tableRows(plan.locator('table'));
    expect(rows.map((r) => r[1])).toEqual(['10', '4']);

    // Showing the plan changed nothing.
    const planned = await readStudyDb(page);
    expect(planned.cards).toEqual(seeded.cards);
    expect(planned.logs).toEqual(seeded.logs);

    // Apply (a confirmation first).
    await plan.getByTestId(TID.backlogApply).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Move 14 cards?');
    await dialog.getByRole('button', { name: 'Move the cards' }).click();
    await expect(page.getByTestId(TID.backlogResult)).toContainText('Moved 14 cards.');

    const applied = await readStudyDb(page);
    expect(applied.logs, 'rescheduling writes no review log').toEqual(seeded.logs);
    const day = studyDayStart(now);
    const was = new Map(seeded.cards.map((c) => [c.id, c]));
    const moved = applied.cards.filter((c) => Date.parse(c.fsrs.due) >= day + DAY);
    const stayed = applied.cards.filter((c) => Date.parse(c.fsrs.due) < day);
    expect(moved).toHaveLength(14);
    expect(stayed).toHaveLength(10);
    expect(moved.filter((c) => Date.parse(c.fsrs.due) === day + DAY)).toHaveLength(10);
    expect(moved.filter((c) => Date.parse(c.fsrs.due) === day + 2 * DAY)).toHaveLength(4);
    for (const c of moved) {
      const old = was.get(c.id)!;
      // Only the due date moved; what the learner remembers is untouched.
      expect(c.fsrs.stability).toBe(old.fsrs.stability);
      expect(c.fsrs.difficulty).toBe(old.fsrs.difficulty);
      expect(c.fsrs.state).toBe(old.fsrs.state);
      expect(c.fsrs.reps).toBe(old.fsrs.reps);
      expect(c.fsrs.lapses).toBe(old.fsrs.lapses);
      expect(c.fsrs.lastReview).toBe(old.fsrs.lastReview);
      expect(c.dueAt).toBe(c.fsrs.due);
    }
    for (const c of stayed) expect(c).toEqual(was.get(c.id));
    expect(applied.cards).toHaveLength(24);

    // Today the learner faces the 10 that were kept; the moved ones left today's queue.
    await reloadTo(page, 'Study');
    await expectDue(page, 10);

    // A budget that cannot hold the rest: reported with the number, apply is disabled.
    // (Fewer than 20 overdue cards: the recovery section is collapsed until it is opened.)
    await page.getByText('10 overdue reviews: recover from the backlog').click();
    const again = page.getByTestId(TID.backlog);
    await again.getByLabel('Reviews per day, per deck').fill('2');
    await again.getByTestId(TID.backlogDays).selectOption('2');
    const tight = page.getByTestId(TID.backlogPlan);
    await expect(tight).toContainText('2 overdue cards stay due today');
    await expect(tight).toContainText('0 cards move to later days.');
    await expect(tight).toContainText('Some cards do not fit');
    await expect(tight).toContainText(
      '8 cards would not fit into 2 days at this budget and stay overdue.',
    );
    await expect(tight.getByTestId(TID.backlogApply)).toHaveAttribute('aria-disabled', 'true');
    await expect(tight.getByTestId(TID.backlogApply)).toHaveAttribute(
      'title',
      'The plan does not move any card.',
    );
    // Everything is accounted for: kept 2 + moved 0 + not fitting 8 = the 10 overdue cards.
    expect(2 + 0 + 8).toBe(stayed.length);
    const finalDb = await readStudyDb(page);
    expect(dueBuckets(finalDb, now).overdue).toHaveLength(10);
    noErrors(page);
  });
});

// ===============================================================================================
// 6. Analytics
// ===============================================================================================

test.describe('analytics', () => {
  test('with no data it says so and shows no number; with cards but no reviews it says "not enough data"', async ({
    env,
  }) => {
    const ctx: Ctx = env;
    await setClock(ctx, T0);
    const page = await openReview(ctx, { settings: UTC_DAY });
    await gotoTab(page, 'Analytics');
    await expect(page.getByTestId(TID.analyticsEmpty)).toContainText(
      'Charts appear here once you have cards and have answered some. Nothing is estimated or filled in before then.',
    );
    for (const id of [TID.streak, TID.forecast, TID.retention, TID.studyLog, TID.counts]) {
      await expect(page.getByTestId(id)).toHaveCount(0);
    }

    await createBasicCards(page, [
      ['An-one', 'a'],
      ['An-two', 'b'],
      ['An-three', 'c'],
    ]);
    await gotoTab(page, 'Analytics');
    const retention = page.getByTestId(TID.retention);
    await expect(page.getByTestId(TID.retentionInsufficient)).toHaveText(
      'True retention needs at least 20 reviews of learned cards; you have 0. It is not estimated before then.',
    );
    await expect(retention).not.toContainText('%');
    await expect(retention).toContainText(
      'The memory model has no learned cards to estimate from yet.',
    );
    await expect(retention.locator('.rv-share')).toHaveCount(0);
    const streak = page.getByTestId(TID.streak);
    await expect(streak.locator('.rv-count')).toHaveText('0');
    await expect(streak.locator('.sv-small')).toHaveText('day streak; best 0');
    await expect(page.getByTestId(TID.studyLog)).toContainText(
      'No reviews were recorded in the last 30 days.',
    );
    // 3 new cards, none studied: the forecast table is all zeros and says 0 are coming.
    const forecast = await tableRows(page.getByTestId(TID.forecastTable));
    expect(forecast).toHaveLength(30);
    expect(forecast.every((r) => r[1] === '0' && r[2] === '0')).toBe(true);
    await expect(page.getByTestId(TID.forecast)).toContainText(
      '0 cards come due in the next 30 days; 0 are already overdue and 0 are scheduled later.',
    );
    await expect(page.locator('.rv-stat').nth(3)).toContainText('3');
    noErrors(page);
  });

  test('forecast, retention by rating, streak and counts equal what the known review sequence produces', async ({
    env,
  }) => {
    test.setTimeout(600_000);
    const ctx: Ctx = env;
    await setClock(ctx, T0);
    const page = await openReview(ctx, { settings: UTC_DAY });

    // Day 0: 20 new cards, all answered Easy (they graduate to review).
    await createTypedClozeCards(page, 20);
    await saveDeckSettings(page, 'General', { fuzz: false });
    await gotoTab(page, 'Study');
    await startAll(page);
    expect(await answerAll(page, Array<Rating>(20).fill(4))).toHaveLength(20);
    // Days 1 and 2: one new card each (a 3-day streak with day 0), answered Easy.
    for (const [i, name] of ['Streak-one', 'Streak-two'].entries()) {
      await setClock(ctx, T0 + (i + 1) * DAY);
      await reloadTo(page, 'Study');
      await createBasicCards(page, [[name, 'a']]);
      await gotoTab(page, 'Study');
      await expectDue(page, 1);
      await startAll(page);
      expect(await answerAll(page, [4])).toHaveLength(1);
    }

    // Day 20: all 22 graduated cards are overdue. 22 reviews of learned cards:
    // 2 Again, 3 Hard, 14 Good, 3 Easy; the two forgotten cards are relearned (Good) afterwards.
    const day20 = T0 + 20 * DAY;
    await setClock(ctx, day20);
    await reloadTo(page, 'Study');
    await expectDue(page, 22);
    const sequence: Rating[] = [1, 1, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 4, 4, 4];
    expect(sequence).toHaveLength(22);
    await startAll(page);
    expect(await answerAll(page, sequence, { max: 19 })).toHaveLength(19);

    // 19 learned-card reviews are not enough: retention says so and shows no percentage.
    await page.getByTestId(TID.leave).click();
    await gotoTab(page, 'Analytics');
    await expect(page.getByTestId(TID.retentionInsufficient)).toHaveText(
      'True retention needs at least 20 reviews of learned cards; you have 19. It is not estimated before then.',
    );
    await expect(page.getByTestId(TID.retention).locator('.rv-count')).toHaveCount(0);

    await gotoTab(page, 'Study');
    await page.getByTestId(TID.continue).click();
    const rest = await answerAll(page, [...sequence.slice(19), 3, 3]);
    expect(rest).toHaveLength(5); // 3 more learned cards + 2 relearning steps
    await expect(page.getByTestId(TID.summaryAnswered)).toContainText('You answered 24 cards');

    // ---- the numbers, computed from the sequence above ------------------------------------
    await gotoTab(page, 'Analytics');
    const db = await readStudyDb(page);
    expect(countedLogs(db)).toHaveLength(46); // 20 + 1 + 1 + 24
    const retention = page.getByTestId(TID.retention);
    // 22 learned-card reviews, 2 forgotten: 20/22.
    await expect(retention.locator('.rv-count')).toHaveText('90.9%');
    await expect(retention).toContainText('of 22 reviews of learned cards were remembered');
    const shares = await retention
      .locator('.rv-share')
      .evaluateAll((els) =>
        els.map(
          (el) =>
            `${el.querySelector('.rv-share__label')?.textContent} ${el.querySelector('.rv-share__value')?.textContent}`,
        ),
      );
    expect(shares).toEqual(['Again 9% (2)', 'Hard 14% (3)', 'Good 64% (14)', 'Easy 14% (3)']);

    // Streak: days 0, 1, 2 and 20 were studied, today is day 20.
    const streak = page.getByTestId(TID.streak);
    await expect(streak.locator('.rv-count')).toHaveText('1');
    await expect(streak.locator('.sv-small')).toHaveText('day streak; best 3');

    // Reviews recorded and the headline numbers.
    const stats = page.locator('.rv-stat');
    const b = dueBuckets(db, day20);
    expect(b.overdue).toHaveLength(0);
    await expect(stats.nth(0)).toContainText(
      `${b.overdue.length + b.today.length}due today (including ${b.overdue.length} overdue)`,
    );
    await expect(stats.nth(2)).toContainText('46reviews recorded');
    await expect(stats.nth(3)).toContainText('0new cards waiting');

    // Forecast table: every studied card is in exactly one day of the next 30 (or beyond).
    const forecast = await tableRows(page.getByTestId(TID.forecastTable));
    expect(forecast).toHaveLength(30);
    const expectedDays = Array.from({ length: 30 }, () => ({ review: 0, learning: 0 }));
    let beyond = 0;
    for (const c of b.studied) {
      const k = Math.floor((Date.parse(c.fsrs.due) - b.dayStart) / DAY);
      if (k >= 30) beyond += 1;
      else if (c.fsrs.state === 'review') expectedDays[k]!.review += 1;
      else expectedDays[k]!.learning += 1;
    }
    expect(forecast.map((r) => [Number(r[1]), Number(r[2])])).toEqual(
      expectedDays.map((d) => [d.review, d.learning]),
    );
    const inWindow = expectedDays.reduce((n, d) => n + d.review + d.learning, 0);
    expect(inWindow + beyond).toBe(22);
    await expect(page.getByTestId(TID.forecast)).toContainText(
      `${inWindow} cards come due in the next 30 days; 0 are already overdue and ${beyond} are scheduled later.`,
    );

    // Study log (last 30 days): day 0, 1, 2 and today are the only days with reviews.
    const logTable = page.getByTestId(TID.studyLog).locator('table');
    const log = await tableRows(logTable);
    expect(log).toHaveLength(30);
    const at = (daysAgo: number) => log[29 - daysAgo]!;
    expect([at(20)[1], at(20)[2]]).toEqual(['20', '20 new, 20 passed (100%), 0 s']);
    expect([at(19)[1], at(19)[2]]).toEqual(['1', '1 new, 1 passed (100%), 0 s']);
    expect([at(18)[1], at(18)[2]]).toEqual(['1', '1 new, 1 passed (100%), 0 s']);
    expect([at(0)[1], at(0)[2]]).toEqual(['24', '0 new, 22 passed (92%), 0 s']);
    expect(log.filter((r) => r[1] !== '0')).toHaveLength(4);

    // Counts by bank and deck.
    const counts = await tableRows(page.getByTestId(TID.counts).locator('table'));
    const reviewCards = liveCards(db).filter((c) => c.fsrs.state === 'review');
    const dueToday = reviewCards.filter((c) => Date.parse(c.fsrs.due) < b.dayStart + DAY).length;
    const expectedRow = (name: string) => [
      name,
      '22',
      '0',
      '0',
      String(reviewCards.length),
      '0',
      String(dueToday),
      '0',
    ];
    expect(counts).toEqual([expectedRow('No bank'), expectedRow('General')]);
    expect(reviewCards).toHaveLength(22);
    noErrors(page);
  });
});

// ===============================================================================================
// 7. Accessibility, keyboard, reduced motion, offline
// ===============================================================================================

test.describe('accessibility', () => {
  test('axe WCAG 2.2 AA: deck picker, session question and answer, author, cards, analytics, settings', async ({
    env,
  }) => {
    test.setTimeout(600_000);
    const ctx: Ctx = env;
    await setClock(ctx, T0);
    const page = await openReview(ctx, { settings: UTC_DAY });

    await expectAccessible(page, 'deck picker, no cards yet');

    // Author view: every card template, with the editor open.
    await openTypedCard(page);
    await expectAccessible(page, 'author: typed card, question and answer');
    const specs: CardSpec[] = [
      { t: 'cloze', markup: 'The {{c1::heart}} has {{c2::four}} chambers.' },
      { t: 'definition', term: 'Preload', definition: 'Ventricular stretch at end diastole.' },
      {
        t: 'compare',
        left: 'Preload',
        right: 'Afterload',
        rows: [{ aspect: 'Meaning', left: 'stretch', right: 'resistance' }],
      },
      {
        t: 'mcq',
        stem: 'Which is the pacemaker?',
        choices: ['SA node', 'AV node', 'Purkinje fibres', ''],
        correct: 0,
      },
    ];
    for (const spec of specs) {
      await fillEditor(page, spec);
      await expectAccessible(page, `author: ${spec.t}`);
    }
    // The author view with a validation problem on screen.
    await fillEditor(page, { t: 'basic', question: 'Only a question', answer: '' });
    await expectAccessible(page, 'author: incomplete card with explanation');

    // Cards to study.
    await saveEditor(
      page,
      { t: 'basic', question: 'A-basic: resting heart rate?', answer: '60 to 100' },
      1,
    );
    await saveEditor(
      page,
      {
        t: 'mcq',
        stem: 'A-mcq: which node is the pacemaker?',
        choices: ['SA node', 'AV node', 'Purkinje fibres'],
        correct: 0,
        explanation: 'The SA node fires fastest.',
      },
      1,
    );
    await saveEditor(
      page,
      { t: 'cloze', markup: 'A-cloze: the {{c1::aorta}} leaves the {{c2::left}} ventricle.' },
      2,
    );
    await gotoTab(page, 'Study');
    await expectAccessible(page, 'deck picker with decks');

    await startAll(page);
    await expectAccessible(page, 'session: question');
    await page.keyboard.press('Space');
    await expectAccessible(page, 'session: answer with rating buttons');
    await page.keyboard.press('e');
    await expect(page.getByTestId(TID.editor)).toBeVisible();
    await expectAccessible(page, 'session: card editor open');
    await page.getByRole('button', { name: 'Cancel' }).click();

    // A multiple-choice card, before and after choosing.
    await page.keyboard.press('4');
    while (
      (await settledSession(page)) === 'card' &&
      !(await page.getByTestId(TID.choices).count())
    ) {
      await answerWith(page, 4);
    }
    if (await page.getByTestId(TID.choices).count()) {
      await expectAccessible(page, 'session: multiple choice question');
      await page.keyboard.press('1');
      await expect(page.getByTestId(TID.mcqResult)).toBeVisible();
      await expectAccessible(page, 'session: multiple choice answer with explanation');
      await page.keyboard.press('x');
      await expectAccessible(page, 'session: explanation panel');
      await page.keyboard.press('3');
    }
    await answerAll(page, [3, 3, 3, 3]);
    await expect(page.getByTestId(TID.summary)).toBeVisible();
    await expectAccessible(page, 'session summary');
    await page.getByRole('button', { name: 'Back to decks' }).click();

    await gotoTab(page, 'Cards');
    await expectAccessible(page, 'card browser');
    await page
      .locator('[data-testid^="rv-card-"]')
      .first()
      .getByRole('button', { name: 'Edit', exact: true })
      .click();
    await expectAccessible(page, 'card browser: edit form');

    await gotoTab(page, 'Analytics');
    await expect(page.getByTestId(TID.analytics)).toBeVisible();
    await expectAccessible(page, 'analytics with data');
    await page.getByText('Show the data as a table').first().click();
    await expectAccessible(page, 'analytics with the data table open');

    await gotoTab(page, 'Settings');
    await expectAccessible(page, 'settings');
    const deck = await openDeckForm(page, 'General');
    await expectAccessible(page, 'settings: deck rules open');
    await deck.getByLabel('Target retention (%)', { exact: true }).fill('5');
    await page.getByTestId(TID.timeZone).fill('Nowhere/Land');
    await expectAccessible(page, 'settings: validation messages shown');
    noErrors(page);
  });

  test('the whole session works with the keyboard alone, focus follows the card, focus is visible', async ({
    env,
  }) => {
    const ctx: Ctx = env;
    await setClock(ctx, T0);
    const page = await openReview(ctx, { settings: UTC_DAY });
    await createBasicCards(page, [
      ['K-one', 'a1'],
      ['K-two', 'a2'],
    ]);
    // No pointer from here on: open the study view by its address, focus starts at the top.
    await page.goto(`chrome-extension://${ctx.extensionId}/review.html?view=study`);
    await expect(page.getByTestId(TID.deckPicker)).toBeVisible();

    await tabUntil(page, (id) => id === TID.startAll);
    const outline = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      const s = getComputedStyle(el);
      return { outline: s.outlineStyle, width: s.outlineWidth, shadow: s.boxShadow };
    });
    expect(
      outline.outline !== 'none' || outline.shadow !== 'none',
      `focus indicator on the start button: ${JSON.stringify(outline)}`,
    ).toBe(true);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId(TID.session)).toBeVisible();
    await expect.poll(() => focusedId(page)).toBe(TID.card); // focus moved to the card

    // Card 1: reveal, rate. Focus is back on the new card afterwards.
    await page.keyboard.press('Space');
    await expect(page.getByTestId(TID.ratings)).toBeVisible();
    await page.keyboard.press('3');
    await expect(page.getByTestId(TID.ratings)).toHaveCount(0);
    expect(await questionText(page)).toBe('K-two');
    await expect.poll(() => focusedId(page)).toBe(TID.card);

    // Card 2: open the editor with E, reach "Cancel" with Tab, close it with Enter, then answer.
    await page.keyboard.press('e');
    await expect(page.getByTestId(TID.editor)).toBeVisible();
    await tabUntil(page, (id) => id === 'Cancel');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId(TID.editor)).toHaveCount(0);
    await page.keyboard.press('Space');
    await page.keyboard.press('z'); // undoes the LAST answer (K-one, Good), not this card
    await expect(page.getByTestId(TID.notice)).toContainText('Undid Good on "K-one".');
    expect(await questionText(page), 'the undone card is first again').toBe('K-one');
    await page.keyboard.press('Space');
    await page.keyboard.press('4');
    await expect(page.getByTestId(TID.ratings)).toHaveCount(0);
    expect(await questionText(page)).toBe('K-two');
    await page.keyboard.press('Space');
    await page.keyboard.press('4');

    // The summary is reachable and operable by keyboard.
    await expect(page.getByTestId(TID.summary)).toBeVisible();
    await tabUntil(page, (id) => id === 'Back to decks');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId(TID.deckPicker)).toBeVisible();
    await expectDue(page, 0);
    noErrors(page);
  });

  test('reduced motion: transitions are off and nothing animates through a session', async ({
    env,
  }) => {
    const ctx: Ctx = env;
    await setClock(ctx, T0);
    const page = await openReview(ctx, { settings: UTC_DAY });
    await createBasicCards(page, [
      ['M-one', 'a1'],
      ['M-two', 'a2'],
    ]);
    await gotoTab(page, 'Study');

    const motion = () =>
      page.evaluate(() => ({
        // The custom property reads back as written ("120ms") or normalised (".12s"): compare ms.
        tokenMs: (() => {
          const raw = getComputedStyle(document.documentElement)
            .getPropertyValue('--sv-motion')
            .trim();
          return raw.endsWith('ms') ? parseFloat(raw) : parseFloat(raw) * 1000;
        })(),
        // One duration per transitioned property ("0.12s, 0.12s"): collapse to the distinct values.
        transition: [
          ...new Set(
            getComputedStyle(document.querySelector('.sv-btn') as Element)
              .transitionDuration.split(',')
              .map((d) => d.trim()),
          ),
        ].join(','),
        scroll: getComputedStyle(document.documentElement).scrollBehavior,
        running: document.getAnimations().length,
      }));

    await page.emulateMedia({ reducedMotion: 'no-preference' });
    expect(await motion()).toMatchObject({ tokenMs: 120, transition: '0.12s' });

    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await motion()).toMatchObject({ tokenMs: 0, transition: '0s', scroll: 'auto' });
    await startAll(page);
    for (let i = 0; i < 2; i++) {
      await page.keyboard.press('Space');
      expect((await motion()).running, 'no running animation on the answer side').toBe(0);
      await page.keyboard.press('3');
      await expect(page.getByTestId(TID.ratings)).toHaveCount(0);
      expect((await motion()).running).toBe(0);
    }
    noErrors(page);
  });

  test('offline: creating, studying, undoing and reading analytics work with no network at all', async ({
    env,
  }) => {
    const ctx: Ctx = env;
    await setClock(ctx, T0);
    await ctx.context.setOffline(true);
    const requests = recordRequests(ctx.context);
    try {
      const page = await openReview(ctx, { settings: UTC_DAY });
      expect(await page.evaluate(() => navigator.onLine)).toBe(false);
      await createBasicCards(page, [
        ['O-one', 'a1'],
        ['O-two', 'a2'],
      ]);
      await gotoTab(page, 'Study');
      await expectDue(page, 2);
      await startAll(page);
      await answerWith(page, 3);
      await page.keyboard.press('z');
      await expect(page.getByTestId(TID.notice)).toContainText('Undid Good on "O-one".');
      const done = await answerAll(page, [4, 4]);
      expect(done).toHaveLength(2);
      await expect(page.getByTestId(TID.summaryAnswered)).toContainText('You answered 2 cards');
      await gotoTab(page, 'Analytics');
      await expect(page.getByTestId(TID.retention)).toBeVisible();
      await expect(page.getByTestId(TID.streak).locator('.rv-count')).toHaveText('1');
      await reloadTo(page, 'Cards');
      await expect(page.locator('[data-testid^="rv-card-"]')).toHaveCount(2);
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
});
