import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { getDb, resetDbForTests } from '@storage';
import { ExternalImport } from './ExternalImport';
import { createBackupDeps, type BackupDeps } from './deps';

// jsdom has no crypto.subtle; Node's is what a browser would provide.
Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

vi.setConfig({ testTimeout: 60_000 });
const TIMEOUT = { timeout: 30_000 };

beforeEach(async () => {
  await resetDbForTests();
  fakeBrowser.reset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(cleanup);

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const para = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
function docx(...paragraphs: string[]): File {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W}"><w:body>${paragraphs
    .map(para)
    .join('')}</w:body></w:document>`;
  const bytes = zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    'word/document.xml': strToU8(xml),
    'word/media/image1.png': new Uint8Array([1, 2, 3]),
  });
  return new File([bytes as Uint8Array<ArrayBuffer>], 'renal physiology.docx', {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
}

const deps = (): BackupDeps => createBackupDeps('0.0.0-test');

describe('ExternalImport: documents', () => {
  it('dry run first, then one transaction, then an undo that moves it to the Trash', async () => {
    render(<ExternalImport deps={deps()} />);
    const user = userEvent.setup();
    await user.upload(
      screen.getByTestId('backup-external-file'),
      docx('The nephron filters plasma.', 'Aldosterone raises sodium reabsorption.', '* * *'),
    );
    const review = await screen.findByTestId('backup-external-review', {}, TIMEOUT);
    expect(screen.getByTestId('backup-external-stats').textContent).toMatch(
      /renal physiology\.docx read as a Word document: 2 paragraphs, 2 can be imported, 0 duplicates skipped, 0 rejected/,
    );
    const warnings = screen.getByTestId('backup-external-warnings').textContent ?? '';
    expect(warnings).toContain('1 image skipped');
    expect(warnings).toContain('1 block with no letters or digits');
    expect(within(review).getByText('The nephron filters plasma.')).toBeTruthy();
    expect(within(review).getAllByText(/Paragraph 1 · renal physiology\.docx/)).toHaveLength(1);
    expect(await getDb().highlights.count()).toBe(0); // nothing written yet

    await user.click(screen.getByTestId('backup-external-commit'));
    expect((await screen.findByTestId('backup-external-result', {}, TIMEOUT)).textContent).toMatch(
      /2 highlights added/,
    );
    const rows = await getDb().highlights.toArray();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      captureMethod: 'import',
      customFields: {
        importedFrom: 'docx',
        needsReview: true,
        importedFile: 'renal physiology.docx',
      },
    });
    expect(rows.map((r) => r.customFields?.importedLocator).sort()).toEqual([
      'Paragraph 1',
      'Paragraph 2',
    ]);
    const list = await screen.findByTestId('backup-needs-review', {}, TIMEOUT);
    expect(
      within(list).getAllByText(/from a Word document \(renal physiology\.docx, Paragraph/),
    ).toHaveLength(2);
    // focus moved to the result, not left on a button that is gone
    await waitFor(() =>
      expect(screen.getByTestId('backup-external-outcome')).toBe(document.activeElement),
    );

    await user.click(screen.getByTestId('backup-external-undo'));
    expect((await screen.findByTestId('backup-external-undone', {}, TIMEOUT)).textContent).toMatch(
      /2 highlights moved to the Trash/,
    );
    const after = await getDb().highlights.toArray();
    expect(after.every((h) => h.deletedAt !== null)).toBe(true);
    expect(screen.queryByTestId('backup-external-undo')).toBeNull();

    // the same file again: the quotes are in the Trash, not in the vault, so they come back
    await user.upload(
      screen.getByTestId('backup-external-file'),
      docx('The nephron filters plasma.'),
    );
    await screen.findByTestId('backup-external-review', {}, TIMEOUT);
    expect(screen.getByTestId('backup-external-stats').textContent).toMatch(/1 can be imported/);
  });

  it('says why a file cannot be read, and what to do instead', async () => {
    render(<ExternalImport deps={deps()} />);
    const user = userEvent.setup();
    await user.upload(
      screen.getByTestId('backup-external-file'),
      new File([new Uint8Array([0x50, 0x4b, 3, 4])], 'deck.apkg'),
    );
    const detail = await screen.findByTestId('backup-external-error-detail', {}, TIMEOUT);
    expect(detail.textContent).toMatch(/Notes in Plain Text/);
    expect(screen.getByText('This file cannot be imported')).toBeTruthy();
    expect(screen.getByTestId('backup-external-help').textContent).toMatch(
      /Not supported: Anki \.apkg packages/,
    );
  });

  it('reads an Anki text export dropped as .txt, and shows notes, not lines', async () => {
    render(<ExternalImport deps={deps()} />);
    const user = userEvent.setup();
    const text = [
      '#separator:tab',
      '#html:true',
      '#tags column:3',
      'Which drug blocks COX-1?\tAspirin<br>(irreversibly)\tpharm cardio',
      '',
    ].join('\n');
    await user.upload(
      screen.getByTestId('backup-external-file'),
      new File([text], 'deck.txt', { type: 'text/plain' }),
    );
    await screen.findByTestId('backup-external-review', {}, TIMEOUT);
    expect(screen.getByTestId('backup-external-stats').textContent).toMatch(
      /deck\.txt read as an Anki text export: 1 note, 1 can be imported/,
    );
    const rows = screen.getByTestId('backup-external-rows');
    expect(rows.textContent).toContain('Aspirin');
    expect(rows.textContent).toContain('Note 1');
    expect(rows.textContent).toContain('#pharm #cardio');
  });

  it('shows the first rows and the rest on request, all imported either way', async () => {
    render(<ExternalImport deps={deps()} />);
    const user = userEvent.setup();
    const paragraphs = Array.from(
      { length: 230 },
      (_, i) => `Distinct fact number ${i} of the file.`,
    );
    await user.upload(screen.getByTestId('backup-external-file'), docx(...paragraphs));
    await screen.findByTestId('backup-external-review', {}, TIMEOUT);
    expect(screen.getByTestId('backup-external-rows').children).toHaveLength(200);
    expect(screen.getByTestId('backup-external-capped').textContent).toMatch(
      /first 200 of 230.*imported too/,
    );
    expect(screen.getByTestId('backup-external-commit').textContent).toMatch(/Add 230 highlights/);
    await user.click(screen.getByTestId('backup-external-show-all'));
    expect(screen.getByTestId('backup-external-rows').children).toHaveLength(230);
    expect(screen.queryByTestId('backup-external-capped')).toBeNull();
  });
});
