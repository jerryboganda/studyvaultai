import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { Preview } from './Preview';
import { clearNoteDrafts } from './PreviewNotes';
import { Harness } from './testHarness';
import { FakeVault } from './testing';
import { loadTreeData } from './treeData';

/**
 * A note body is user text, and a hostile one, a synced one or an imported one can make the Markdown
 * parser quadratic (markdownBudget.ts). The preview must stay responsive and say what it did.
 */

const NOTE_TEXT_PATTERN = /shown as plain text because it is too complex to format/i;
const BOMB = '*a'.repeat(50_000); // the 100,000-character note body cap; marked takes 20 s on this

beforeEach(() => {
  fakeBrowser.reset();
  clearNoteDrafts();
});
afterEach(cleanup);

async function open(setup?: (v: FakeVault) => void) {
  const vault = new FakeVault([{ id: 'hl-00000001', quote: 'The cell membrane is a bilayer.' }]);
  setup?.(vault);
  const api = vault.api();
  const tree = await loadTreeData(api);
  render(
    <Harness api={api} tree={tree}>
      <Preview
        id="hl-00000001"
        onFilterSource={vi.fn()}
        onShow={vi.fn()}
        onReviewDuplicates={vi.fn()}
        onGone={vi.fn()}
      />
    </Harness>,
  );
  await screen.findByTestId('preview');
  return vault;
}

describe('Preview: a note that is too expensive to format', () => {
  it('shows a stored note as plain text, with the reason, without waiting for the parser', async () => {
    const started = performance.now();
    await open((v) => {
      void v.api().createNote({ highlightId: 'hl-00000001', body: BOMB });
    });
    const note = await screen.findByTestId('note');
    // the whole preview, with this note, is up in far less than the 20 s marked would take
    expect(performance.now() - started).toBeLessThan(10_000);

    // a visible, readable sentence, in the note, before its text
    const sentence = within(note).getByText(NOTE_TEXT_PATTERN);
    expect(sentence.tagName).toBe('P');
    expect(sentence.textContent).toBe('Shown as plain text because it is too complex to format.');
    const text = note.querySelector('pre.md-fallback') as HTMLElement;
    expect(text.textContent).toBe(BOMB);
    expect(text.dir).toBe('auto');
    expect(sentence.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // nothing was turned into markup, and the controls around the note still work
    expect(note.querySelector('em, strong, a, img, script')).toBeNull();
    expect(within(note).getByRole('button', { name: 'Edit' })).toBeTruthy();
    expect(within(note).getByRole('button', { name: 'Pin' })).toBeTruthy();
  });

  it('formats an ordinary note next to it', async () => {
    await open((v) => {
      void v.api().createNote({ highlightId: 'hl-00000001', body: BOMB });
      void v.api().createNote({ highlightId: 'hl-00000001', body: '**Lipids** first.' });
    });
    const notes = await screen.findAllByTestId('note');
    await waitFor(() => expect(notes.length).toBeGreaterThanOrEqual(2));
    const formatted = notes.find((n) => n.querySelector('strong'))!;
    expect(formatted.querySelector('strong')?.textContent).toBe('Lipids');
    expect(within(formatted).queryByText(NOTE_TEXT_PATTERN)).toBeNull();
    expect(notes.filter((n) => n.querySelector('pre.md-fallback'))).toHaveLength(1);
  });

  it('previews the text being typed the same way, and does not lose it', async () => {
    const vault = await open();
    fireEvent.click(screen.getByTestId('note-add'));
    const typed = '**a '.repeat(25_000);
    fireEvent.change(screen.getByTestId('note-body'), { target: { value: typed } });
    const started = performance.now();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    const preview = screen.getByTestId('note-preview');
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(within(preview).getByText(NOTE_TEXT_PATTERN)).toBeTruthy();
    expect(preview.querySelector('pre.md-fallback')?.textContent).toBe(typed);

    // what is saved is the Markdown as typed, whatever the preview showed
    fireEvent.click(screen.getByRole('button', { name: 'Back to editing' }));
    fireEvent.click(screen.getByTestId('note-save'));
    await waitFor(() => expect(vault.called('createNote')).toHaveLength(1));
    expect(vault.called('createNote')[0]!.args[0]).toMatchObject({ body: typed });

    // and a shorter text of the same shape is formatted again
    fireEvent.click(await screen.findByTestId('note-edit'));
    fireEvent.change(screen.getByTestId('note-body'), { target: { value: '**a** b **c**' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    const again = screen.getByTestId('note-preview');
    expect(again.querySelectorAll('strong')).toHaveLength(2);
    expect(within(again).queryByText(NOTE_TEXT_PATTERN)).toBeNull();
  });
});
