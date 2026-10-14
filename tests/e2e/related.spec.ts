import {
  countTables,
  expect,
  expectAxeClean,
  externalRequests,
  openPreview,
  pageErrors,
  test,
} from './helpers.dashboard';
import { openLibrary } from './helpers.graph';
import {
  TEXT,
  relatedIds,
  relatedItems,
  relatedSection,
  relatedToggle,
  seedRelated,
} from './helpers.related';

/**
 * Related highlights in the dashboard preview: the lexical index asked, on this device, which other
 * highlights share the words of this one. Real Chromium, the real built extension, the real vault.
 */
test.describe.configure({ timeout: 180_000 });

test.describe('related highlights', () => {
  test('lists what shares words, says which words, and opens one; offline and without errors', async ({
    env,
  }) => {
    const { ds } = await seedRelated(env);
    const [w1, w2, w3, w4, w5, v1] = ['w1', 'w2', 'w3', 'w4', 'w5', 'v1'].map((k) => ds.id.hl(k));

    const page = await openLibrary(env);
    await env.context.setOffline(true);
    try {
      await openPreview(page, w1!);

      // Closed and empty until asked.
      await expect(relatedSection(page).getByRole('heading', { name: 'Related' })).toBeVisible();
      await expect(relatedToggle(page)).toHaveAttribute('aria-expanded', 'false');
      await expect(relatedItems(page)).toHaveCount(0);

      // The keyboard opens it.
      await relatedToggle(page).focus();
      await page.keyboard.press('Enter');
      await expect(relatedToggle(page)).toHaveAttribute('aria-expanded', 'true');
      await expect(relatedItems(page)).toHaveCount(2, { timeout: 20_000 });

      // The strongest first; never itself, the trashed one, or the ones that share nothing.
      const listed = await relatedIds(page);
      expect(listed).toEqual([w2, w5]);
      for (const absent of [w1, w3, w4, v1]) expect(listed).not.toContain(absent);

      // Which words, as the source wrote them.
      const why = relatedItems(page).first().getByTestId('related-why');
      await expect(why).toHaveText(/^shares: /);
      for (const word of ['Warfarin', 'INR', 'vitamin']) await expect(why).toContainText(word);
      await expect(relatedItems(page).first()).toContainText(TEXT.w2);
      await expect(page.getByTestId('related-summary')).toHaveText('2 related highlights.');

      await expectAxeClean(page, '[data-testid="preview-related"]');

      // Same source: W5 is from the same page as W1.
      await page.getByTestId('related-other-sources').check();
      await expect(relatedItems(page)).toHaveCount(1);
      expect(await relatedIds(page)).toEqual([w2]);
      await page.getByTestId('related-other-sources').uncheck();
      await expect(relatedItems(page)).toHaveCount(2);

      // Open shows that highlight in the preview; its own Related section starts closed again.
      await relatedItems(page).first().getByTestId('related-open').click();
      await expect(page.getByTestId('preview')).toHaveAttribute('data-highlight-id', w2!);
      await expect(relatedToggle(page)).toHaveAttribute('aria-expanded', 'false');
    } finally {
      await env.context.setOffline(false);
    }

    expect(externalRequests(page)).toEqual([]);
    expect(pageErrors(page)).toEqual([]);
  });

  test('says honestly that a highlight with its own vocabulary has nothing related', async ({
    env,
  }) => {
    const { ctrl, ds } = await seedRelated(env);
    const before = await countTables(ctrl, ['highlights', 'notes']);
    const page = await openLibrary(env);
    await openPreview(page, ds.id.hl('v1'));
    await relatedToggle(page).click();

    await expect(page.getByTestId('related-summary')).toContainText(
      'No other highlight shares enough words with this one yet',
    );
    await expect(relatedItems(page)).toHaveCount(0);
    // The list is a derived view: it wrote nothing to the vault.
    expect(await countTables(ctrl, ['highlights', 'notes'])).toEqual(before);
    expect(pageErrors(page)).toEqual([]);
  });

  test('follows an edit: words added to a comment relate the highlight to the others', async ({
    env,
  }) => {
    const { ds } = await seedRelated(env);
    const page = await openLibrary(env);
    await openPreview(page, ds.id.hl('v1'));
    await relatedToggle(page).click();
    await expect(page.getByTestId('related-summary')).toContainText('No other highlight');

    const comment = page.getByTestId('preview-comment');
    await comment.fill('Compare with warfarin: INR and vitamin K');
    await comment.blur();
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();

    await expect
      .poll(() => relatedIds(page), {
        timeout: 30_000,
        message: 'the index catches up with the edit',
      })
      .toEqual(expect.arrayContaining([ds.id.hl('w2')]));
    // The highlight's own quote is untouched by the comment.
    await expect(page.getByTestId('preview-quote')).toHaveText(TEXT.v1);
  });
});
