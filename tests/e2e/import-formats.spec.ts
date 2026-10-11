import type { Page } from '@playwright/test';
import { deleteAllData, openBackupPage, snapshotVault } from './helpers.backup';
import {
  axeViolations,
  captureQuote,
  ensureVault,
  expectList,
  openControl,
  openDashboard,
  readTable,
  type StoredHighlight,
} from './helpers.dashboard';
import {
  ANKI_QUOTES,
  DOCX_QUOTES,
  EPUB_QUOTES,
  HTML_QUOTES,
  PPTX_SLIDES,
  anki,
  apkg,
  billionLaughs,
  chooseImport,
  docx,
  epub,
  external,
  html,
  legacyDoc,
  passwordProtectedDocx,
  pptx,
  protectedEpub,
  unsafeName,
  zipBomb,
  type ImportFile,
} from './helpers.import';
import { highlightsOf, test } from './helpers.pages';
import { expect } from './helpers.review';

test.describe.configure({ timeout: 300_000 });

/**
 * Word, PowerPoint, EPUB, HTML and Anki text imports in the real loaded extension (docs/adr/014):
 * the real Options page, the real file input, a real Chromium DOMParser. Files are built in Node.
 *
 * What is checked that a unit test cannot: that Chromium's own parser neither runs a script nor
 * requests an image, stylesheet or frame from a file's markup (every request of the page is
 * recorded), that the rows land in the real IndexedDB with the provenance they must have, that the
 * dashboard's search finds them, and that "Delete all data" removes them.
 *
 * Not covered here: a file larger than 64 MB (Playwright refuses in-memory uploads over 50 MB; the
 * unit tests cover the cap) and the cap on 5,000 entries (unit test).
 */

const articleUrl = (origin: string) => `${origin}/article.html`;
const CARDIO_QUOTE = 'Cardiac output equals heart rate multiplied by stroke volume.';

type Row = StoredHighlight & { captureMethod: string };

const highlights = (ctrl: Page) => readTable<Row>(ctrl, 'highlights');
const sources = (ctrl: Page) =>
  readTable<{ id: string; urlKey: string; title: string; originalUrl: string }>(ctrl, 'sources');

/** Pick `file`, wait for the dry run, and return its statistics sentence. */
async function dryRun(page: Page, file: ImportFile, stats: RegExp): Promise<void> {
  await chooseImport(page, file);
  await expect(external(page).getByTestId('backup-external-stats')).toContainText(stats);
}

async function commit(page: Page, added: string): Promise<void> {
  await external(page).getByTestId('backup-external-commit').click();
  await expect(external(page).getByTestId('backup-external-result')).toContainText(added);
}

test.describe('import formats', () => {
  test('Word, PowerPoint, EPUB, HTML and Anki files import as imported highlights of their own: dry run first, no script or request from the file, searchable, never on a captured page, removed by Delete all data', async ({
    env,
  }) => {
    const ctrl = await openControl(env);
    await ensureVault(ctrl);
    const real = await captureQuote(ctrl, {
      url: articleUrl(env.origin),
      title: 'Cardiovascular physiology',
      quote: CARDIO_QUOTE,
      at: 10,
    });
    const realSourceId = (await highlights(ctrl)).find((h) => h.id === real.id)!.sourceId;

    const page = await openBackupPage(env);
    const requests: string[] = [];
    page.on('request', (r) => requests.push(r.url()));
    const ext = external(page);
    const seen = new Set((await highlights(ctrl)).map((h) => h.id));
    const newRows = async (): Promise<Row[]> => {
      const rows = (await highlights(ctrl)).filter((h) => !seen.has(h.id));
      for (const r of rows) seen.add(r.id);
      return rows;
    };

    await expect(ext.getByTestId('backup-external-help')).toContainText(
      /Not supported: Anki \.apkg packages .* old \.doc and \.ppt files .* DRM-protected files/,
    );
    expect
      .soft(await axeViolations(page, '[data-testid="backup-external"]'), 'axe: at rest')
      .toBe('');

    // ---- Word -------------------------------------------------------------------------------
    await dryRun(
      page,
      docx(),
      /renal-physiology\.docx read as a Word document: 2 paragraphs, 2 can be imported, 0 duplicates skipped, 0 rejected/,
    );
    await expect(ext.getByTestId('backup-external-warnings')).toContainText('1 image skipped');
    await expect(ext.getByTestId('backup-external-warnings')).toContainText(
      '1 block with no letters or digits',
    );
    await expect(ext.getByTestId('backup-external-rows')).toContainText(DOCX_QUOTES[0]);
    await expect(ext.getByTestId('backup-external-rows')).toContainText('Paragraph 1');
    expect((await highlights(ctrl)).length, 'a dry run writes nothing').toBe(seen.size);
    expect
      .soft(await axeViolations(page, '[data-testid="backup-external"]'), 'axe: dry run')
      .toBe('');
    await commit(page, '2 highlights added');
    const word = await newRows();
    expect(word.map((h) => h.exactQuote).sort()).toEqual([...DOCX_QUOTES].sort());
    for (const h of word) {
      expect(h.captureMethod).toBe('import');
      expect(h.customFields).toMatchObject({
        importedFrom: 'docx',
        needsReview: true,
        importedFile: 'renal-physiology.docx',
      });
      expect(h.sourceId, 'never the Source a capture made').not.toBe(realSourceId);
    }
    expect(word.map((h) => h.customFields?.importedLocator).sort()).toEqual([
      'Paragraph 1',
      'Paragraph 2',
    ]);

    // ---- PowerPoint -------------------------------------------------------------------------
    await dryRun(
      page,
      pptx(),
      /cardiac-pharmacology\.pptx read as a PowerPoint file: 2 slides, 2 can be imported, 0 duplicates skipped, 0 rejected/,
    );
    await expect(ext.getByTestId('backup-external-warnings')).toContainText(
      '1 slide without text skipped.',
    );
    await commit(page, '2 highlights added');
    const slides = await newRows();
    expect(slides.map((h) => h.exactQuote).sort()).toEqual([...PPTX_SLIDES].sort());
    expect(
      slides.map((h) => h.customFields?.importedLocator).sort(),
      'the slide number is kept',
    ).toEqual(['Slide 1', 'Slide 2']);

    // ---- EPUB -------------------------------------------------------------------------------
    await dryRun(
      page,
      epub(),
      /neuroanatomy\.epub read as an EPUB book: 3 paragraphs, 3 can be imported, 0 duplicates skipped, 0 rejected/,
    );
    await commit(page, '3 highlights added');
    const book = await newRows();
    expect(book.map((h) => h.exactQuote).sort()).toEqual([...EPUB_QUOTES].sort());
    expect(book.map((h) => h.customFields?.importedLocator).sort()).toEqual([
      'Chapter 1, paragraph 1',
      'Chapter 1, paragraph 2',
      'Chapter 2, paragraph 1',
    ]);
    const bookSource = (await sources(ctrl)).find((s) => s.id === book[0]!.sourceId)!;
    expect(bookSource.title, 'the package title').toBe('Neuroanatomy primer');

    // ---- HTML -------------------------------------------------------------------------------
    await dryRun(
      page,
      html(),
      /endocrine-notes\.html read as an HTML page: 3 paragraphs, 3 can be imported, 0 duplicates skipped, 0 rejected/,
    );
    await expect(ext.getByTestId('backup-external-warnings')).toContainText('1 image skipped');
    await commit(page, '3 highlights added');
    const htmlRows = await newRows();
    expect(htmlRows.map((h) => h.exactQuote).sort()).toEqual([...HTML_QUOTES].sort());

    // ---- Anki -------------------------------------------------------------------------------
    await dryRun(
      page,
      anki(),
      /pharmacology-deck\.txt read as an Anki text export: 2 notes, 2 can be imported, 0 duplicates skipped, 0 rejected/,
    );
    await expect(ext.getByTestId('backup-external-rows')).toContainText('#antibiotics #exam');
    await commit(page, '2 highlights added');
    const notes = await newRows();
    expect(notes.map((h) => h.exactQuote).sort()).toEqual([...ANKI_QUOTES].sort());
    const basic = notes.find((h) => h.exactQuote === ANKI_QUOTES[0])!;
    expect(basic.userComment).toBe('Front: Which class inhibits cell wall synthesis?');
    expect(basic.customFields).toMatchObject({
      importedFrom: 'anki',
      importedBank: 'Pharmacology',
      importedFolder: 'Antibiotics',
      importedLocator: 'Note 1',
    });

    // ---- what the five files did, together ----------------------------------------------------
    const all = await highlights(ctrl);
    const imported = all.filter((h) => h.id !== real.id);
    expect(imported).toHaveLength(2 + 2 + 3 + 3 + 2);
    const sourceRows = await sources(ctrl);
    const fileSources = new Set(imported.map((h) => h.sourceId));
    expect(fileSources.size, 'one Source of its own per file').toBe(5);
    for (const id of fileSources) {
      const s = sourceRows.find((x) => x.id === id)!;
      expect(s.urlKey, 'a key no page can ever match').toMatch(/^imported:/);
      expect(s.originalUrl).toMatch(/^https:\/\/studyvault\.invalid\/imported\//);
    }
    expect((await highlightsOf(ctrl, articleUrl(env.origin))).map((h) => h.id)).toEqual([real.id]);

    // nothing in the files ran or was requested: real Chromium, every request of the page
    expect(
      await page.evaluate(() => (window as unknown as { __svRan?: boolean }).__svRan),
      'a script in an imported file ran',
    ).toBeUndefined();
    expect(
      requests.filter((u) => /evil\.invalid/.test(u)),
      'the files asked for nothing from the network',
    ).toEqual([]);

    // searchable in the library
    for (const [word, quote] of [
      ['Aldosterone', DOCX_QUOTES[0]],
      ['Lisinopril', PPTX_SLIDES[1]],
      ['cerebellum', EPUB_QUOTES[2]],
      ['Calcitonin', HTML_QUOTES[2]],
      ['penicillin', ANKI_QUOTES[0]],
    ] as const) {
      const dash = await openDashboard(env, { q: word });
      await expectList(dash, [imported.find((h) => h.exactQuote === quote)!.id]);
      await dash.close();
    }

    // undo the last import: its highlights go to the Trash, the others stay
    await expect(ext.getByTestId('backup-external-undo')).toBeVisible();
    await ext.getByTestId('backup-external-undo').click();
    await expect(ext.getByTestId('backup-external-undone')).toContainText(
      '2 highlights moved to the Trash',
    );
    const after = await highlights(ctrl);
    const trashed = after.filter((h) => h.deletedAt !== null).map((h) => h.exactQuote);
    expect(trashed.sort()).toEqual([...ANKI_QUOTES].sort());
    expect(after).toHaveLength(all.length);
    await expect(ext.getByTestId('backup-external-undo')).toHaveCount(0);

    // Delete all data removes every imported row and every Source an import made
    await deleteAllData(page);
    const wiped = await snapshotVault(ctrl);
    expect(wiped.highlights ?? []).toEqual([]);
    expect(wiped.sources ?? []).toEqual([]);
    expect(wiped.highlightTags ?? []).toEqual([]);
  });

  test('files that are not what they say, protected, unsupported or hostile are refused with the reason and write nothing', async ({
    env,
  }) => {
    const ctrl = await openControl(env);
    await ensureVault(ctrl);
    const page = await openBackupPage(env);
    const requests: string[] = [];
    page.on('request', (r) => requests.push(r.url()));
    const ext = external(page);
    const before = await highlights(ctrl);

    const refusals: Array<[ImportFile, string | RegExp, string]> = [
      [
        apkg(),
        /Anki \.apkg packages are not supported: .* Notes in Plain Text/,
        'This file cannot be imported',
      ],
      [
        legacyDoc(),
        /Old binary Word and PowerPoint files \(\.doc, \.ppt\) are not supported/,
        'This file cannot be imported',
      ],
      [
        passwordProtectedDocx(),
        /old-style or password-protected Office file/,
        'This file cannot be imported',
      ],
      [
        protectedEpub(),
        /This EPUB is protected \(DRM or encryption\)/,
        'This file cannot be imported',
      ],
      [unsafeName(), /unsafe name/, 'This file cannot be imported'],
      [billionLaughs(), /declares a document type or entities/, 'This file cannot be imported'],
      [
        zipBomb(),
        /expands to far more than its size/,
        'This file is larger than StudyVault will process',
      ],
    ];
    for (const [file, reason, title] of refusals) {
      await chooseImport(page, file);
      const alert = ext.getByRole('alert');
      await expect(alert, file.name).toContainText(title);
      await expect(ext.getByTestId('backup-external-error-detail'), file.name).toContainText(
        reason,
      );
      await expect(ext.getByTestId('backup-external-review')).toHaveCount(0);
      await expect(ext.getByTestId('backup-external-reading')).toHaveCount(0);
    }
    expect
      .soft(await axeViolations(page, '[data-testid="backup-external"]'), 'axe: refusal')
      .toBe('');

    expect(await highlights(ctrl), 'nothing was written').toEqual(before);
    expect(
      requests.filter((u) => /^(https?|wss?):/i.test(u) && !u.startsWith(env.origin)),
      'no network request from the page',
    ).toEqual([]);
    // the page is still usable after every refusal: a good file imports
    await dryRun(page, docx(), /2 can be imported/);
  });
});
