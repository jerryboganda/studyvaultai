import type { Page } from '@playwright/test';
import { test } from './helpers.pages';
import {
  T0,
  TID,
  expect,
  captureHighlights,
  cardRow,
  fillEditor,
  gotoTab,
  openHighlightInAuthor,
  openReview,
  openTypedCard,
  pageErrors,
  readStudyDb,
  saveEditor,
  setClock,
  liveCards,
  type Captured,
  type Ctx,
} from './helpers.review';

test.describe.configure({ timeout: 240_000 });

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
const QUOTE_EF =
  'Ejection fraction is the proportion of end diastolic volume that is ejected with each beat.';

const noErrors = (page: Page) => expect(pageErrors(page), 'no page or console errors').toEqual([]);

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
// 1. Authoring: five templates from a highlight, edit, source link and quote snapshot
// ===============================================================================================

test.describe('authoring', () => {
  test('basic, cloze (multi-deletion), definition, compare and MCQ cards from a highlight keep their source link and quote snapshot through edits', async ({
    env,
  }) => {
    test.setTimeout(180_000);
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
    await expect(editor.getByLabel('Answer', { exact: true })).toHaveValue(QUOTE_SV);
    await expect(page.getByTestId(TID.preview)).toContainText('1 card will be created');
    await saveEditor(
      page,
      { t: 'basic', question: 'What is stroke volume?', answer: QUOTE_SV, explanation: 'SV = EDV - ESV' },
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

    // definition, compare, multiple choice.
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
    const decks = db.decks.filter((d) => d.deletedAt === null);
    expect(decks.map((d) => d.name)).toEqual(['Inbox']);
    const mcq = cards.find((c) => c.cardType === 'mcq')!;
    expect(mcq.choices).toHaveLength(4);
    expect(mcq.choices?.find((c) => c.id === mcq.answerChoiceId)?.text).toBe('Stroke volume');
    expect(mcq.explanation).toBe('Stroke volume is the volume ejected per beat.');

    // Edit the basic card from the card browser: wording changes, provenance and schedule do not.
    const basic = cards.find((c) => c.cardType === 'basic')!;
    await gotoTab(page, 'Cards');
    await expect(page.locator('[data-testid^="rv-card-"]')).toHaveCount(6);
    const row = cardRow(page, 'What is stroke volume?');
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
    await gotoTab(page, 'Cards');
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
    await expect.poll(async () => liveCards(await readStudyDb(page)).length).toBe(7);
    const bulked = liveCards(await readStudyDb(page)).find((c) => c.highlightId === co.id)!;
    expect(bulked.front).toBe('How is cardiac output calculated?');
    expect(bulked.back).toBe(QUOTE_CO);
    expect(bulked.sourceQuote).toBe(QUOTE_CO);

    noErrors(page);
  });
});
