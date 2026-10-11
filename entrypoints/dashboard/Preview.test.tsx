import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { INBOX_BANK_ID } from '@shared';
import { Preview, type PreviewProps } from './Preview';
import { clearNoteDrafts, hasUnsavedNotes } from './PreviewNotes';
import { Harness } from './testHarness';
import { FakeVault, type FakeHighlight } from './testing';
import { loadTreeData, type TreeData } from './treeData';

beforeEach(() => {
  fakeBrowser.reset();
  clearNoteDrafts();
});
afterEach(cleanup);

const QUOTE = 'The cell membrane is a phospholipid bilayer.';

async function open(
  highlights: FakeHighlight[] = [{ id: 'hl-00000001', quote: QUOTE }],
  setup?: (v: FakeVault) => void,
  props: Partial<PreviewProps> = {},
) {
  const vault = new FakeVault(highlights);
  setup?.(vault);
  const api = vault.api();
  const tree: TreeData = await loadTreeData(api);
  const handlers = {
    onFilterSource: vi.fn(),
    onShow: vi.fn(),
    onReviewDuplicates: vi.fn(),
    onGone: vi.fn(),
  };
  render(
    <Harness api={api} tree={tree}>
      <Preview id={highlights[0]!.id} {...handlers} {...props} />
    </Harness>,
  );
  await screen.findByTestId('preview');
  return { vault, handlers };
}

describe('Preview: provenance', () => {
  it('labels the exact quote as immutable and shows where it came from', async () => {
    await open([
      {
        id: 'hl-00000001',
        quote: QUOTE,
        title: 'Cell biology notes',
        host: 'example.com',
        url: 'https://example.com/cells',
        capturedAt: '2026-10-11T14:05:00.000Z',
        resolveStatus: 'changed',
      },
    ]);
    expect(screen.getByTestId('preview-quote').textContent).toBe(QUOTE);
    expect(screen.getByText(/cannot be edited/)).toBeTruthy();

    const provenance = screen.getByTestId('preview-provenance');
    expect(within(provenance).getByText('Cell biology notes', { exact: false })).toBeTruthy();
    const address = within(provenance).getByRole('link', { name: 'https://example.com/cells' });
    expect(address.getAttribute('href')).toBe('https://example.com/cells');
    expect(address.getAttribute('rel')).toBe('noopener noreferrer');
    expect(address.getAttribute('target')).toBe('_blank');
    // The capture time is shown in the viewer's own zone, which is named.
    expect(provenance.textContent).toMatch(/\(.+\)/);
    expect(provenance.textContent).toContain('2026');
    expect(provenance.textContent).toContain('the selection toolbar');
    expect(provenance.textContent).toContain('Source changed');
  });

  it('opens the original at the passage through a text fragment', async () => {
    await open();
    const link = screen.getByTestId('open-source');
    expect(link.getAttribute('href')).toBe(
      'https://example.com/cells#:~:text=The%20cell%20membrane%20is%20a%20phospholipid%20bilayer.',
    );
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('opens a PDF source in the extension reader at its page', async () => {
    await open([
      {
        id: 'hl-00000001',
        quote: QUOTE,
        pdfPage: 12,
        documentId: 'doc-00000001',
        url: 'https://studyvault.invalid/pdf/doc-00000001',
      },
    ]);
    const link = screen.getByTestId('open-source');
    const href = link.getAttribute('href')!;
    expect(href).toContain('pdf-reader.html');
    expect(href).toContain('doc=doc-00000001');
    expect(href).toContain('page=12');
    expect(href).toContain('highlight=hl-00000001');
    expect(link.textContent).toContain('page 12');
  });

  it('says so when the original has no reachable address', async () => {
    await open([{ id: 'hl-00000001', quote: QUOTE, url: 'https://studyvault.invalid/pdf/abc' }]);
    expect(screen.queryByTestId('open-source')).toBeNull();
    expect(screen.getByTestId('source-unavailable').textContent).toContain('no reachable address');
  });

  it('never makes a clickable link out of a hostile stored address', async () => {
    await open([{ id: 'hl-00000001', quote: QUOTE, url: 'javascript:alert(1)' }]);
    expect(screen.queryByTestId('open-source')).toBeNull();
    expect(screen.queryByRole('link', { name: /javascript/ })).toBeNull();
  });

  it('renders stored text as text, never as markup', async () => {
    await open([
      { id: 'hl-00000001', quote: 'x <img src=x onerror=alert(1)> <script>alert(1)</script>' },
    ]);
    const quote = screen.getByTestId('preview-quote');
    expect(quote.querySelector('img, script')).toBeNull();
    expect(quote.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('lists every bank and folder it is filed in', async () => {
    await open(
      [
        {
          id: 'hl-00000001',
          quote: QUOTE,
          bankIds: [INBOX_BANK_ID, 'bank-bio'],
          folderId: 'f-cells',
        },
      ],
      (v) => {
        v.addBank('bank-bio', 'Biology');
        v.folders.push({ id: 'f-top', bankId: 'bank-bio', parentId: null, name: 'Cells' });
        v.folders.push({ id: 'f-cells', bankId: 'bank-bio', parentId: 'f-top', name: 'Membranes' });
        v.rows[0]!.bankIds = ['bank-bio', INBOX_BANK_ID];
      },
    );
    const places = screen.getAllByTestId('location').map((l) => l.textContent);
    expect(places[0]).toContain('Biology › Cells › Membranes');
    expect(places[1]).toContain('Inbox');
  });

  it('shows a clear message for a highlight that is gone', async () => {
    const vault = new FakeVault();
    const api = vault.api();
    render(
      <Harness api={api} tree={await loadTreeData(api)}>
        <Preview
          id="hl-missing"
          onFilterSource={() => undefined}
          onShow={() => undefined}
          onReviewDuplicates={() => undefined}
        />
      </Harness>,
    );
    const box = await screen.findByTestId('preview-error');
    expect(box.textContent).toContain('no longer here');
  });
});

describe('Preview: editing', () => {
  it('changes kind (and the colour that goes with it) and priority', async () => {
    const { vault } = await open();
    fireEvent.change(screen.getByTestId('preview-kind'), { target: { value: 'formula' } });
    await waitFor(() => expect(vault.called('updateHighlight')).toHaveLength(1));
    expect(vault.called('updateHighlight')[0]!.args).toEqual([
      'hl-00000001',
      { kind: 'formula', color: 'blue' },
    ]);
    fireEvent.change(screen.getByTestId('preview-priority'), { target: { value: '5' } });
    await waitFor(() => expect(vault.called('updateHighlight')).toHaveLength(2));
    expect(vault.called('updateHighlight')[1]!.args[1]).toEqual({ priority: 5 });
  });

  it('autosaves the comment when the field loses focus and never touches the quote', async () => {
    const { vault } = await open();
    const box = screen.getByTestId('preview-comment') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'Remember: lipids, not proteins' } });
    fireEvent.blur(box);
    await waitFor(() => expect(vault.called('updateHighlight')).toHaveLength(1));
    expect(vault.called('updateHighlight')[0]!.args).toEqual([
      'hl-00000001',
      { userComment: 'Remember: lipids, not proteins' },
    ]);
    expect(vault.rows[0]!.quote).toBe(QUOTE);
    await waitFor(() => expect(screen.getByText('Saved')).toBeTruthy());
  });

  it('reports a failed save instead of pretending', async () => {
    const { vault } = await open();
    vault.fail.updateHighlight = new Error('Disk is full');
    const box = screen.getByTestId('preview-comment');
    fireEvent.change(box, { target: { value: 'will fail' } });
    fireEvent.blur(box);
    await waitFor(() => expect(screen.getByText(/Not saved: Disk is full/)).toBeTruthy());
  });

  it('moves the highlight to the trash with an undo', async () => {
    const { vault, handlers } = await open();
    fireEvent.click(screen.getByTestId('preview-trash'));
    await waitFor(() => expect(vault.called('softDeleteHighlight')).toHaveLength(1));
    expect(handlers.onGone).toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(vault.called('restoreHighlight')).toHaveLength(1));
    expect(vault.rows[0]!.deletedAt).toBeNull();
  });
});

describe('Preview: tags', () => {
  it('adds an existing tag by name (any case) without creating a duplicate', async () => {
    const { vault } = await open(undefined, (v) =>
      v.tags.push({ id: 'tag-existing', name: 'Exam pearl' }),
    );
    fireEvent.change(screen.getByTestId('tag-input'), { target: { value: 'exam PEARL' } });
    fireEvent.click(screen.getByTestId('tag-add'));
    await waitFor(() => expect(vault.called('attachTags')).toHaveLength(1));
    expect(vault.called('createTag')).toHaveLength(0);
    expect(vault.called('attachTags')[0]!.args).toEqual([['hl-00000001'], ['tag-existing']]);
  });

  it('creates a new tag and attaches it', async () => {
    const { vault } = await open();
    fireEvent.change(screen.getByTestId('tag-input'), { target: { value: 'high yield' } });
    fireEvent.click(screen.getByTestId('tag-add'));
    await waitFor(() => expect(vault.called('attachTags')).toHaveLength(1));
    expect(vault.called('createTag')[0]!.args).toEqual(['high yield']);
  });

  it('removes a tag from this highlight only', async () => {
    const { vault } = await open([{ id: 'hl-00000001', quote: QUOTE, tagIds: ['tag-a'] }], (v) =>
      v.tags.push({ id: 'tag-a', name: 'neuro' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove tag neuro' }));
    await waitFor(() => expect(vault.called('detachTags')).toHaveLength(1));
    expect(vault.called('detachTags')[0]!.args).toEqual([['hl-00000001'], ['tag-a']]);
  });

  it('will not submit an empty tag', async () => {
    const { vault } = await open();
    const add = screen.getByTestId('tag-add');
    expect(add.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(add);
    expect(vault.called('attachTags')).toHaveLength(0);
  });
});

describe('Preview: custom fields', () => {
  it('adds text, number and yes/no fields next to the existing ones', async () => {
    const { vault } = await open([
      { id: 'hl-00000001', quote: QUOTE, customFields: { chapter: '4' } },
    ]);
    expect(screen.getAllByTestId('custom-field')).toHaveLength(1);

    fireEvent.change(screen.getByTestId('field-key'), { target: { value: 'exam frequency' } });
    fireEvent.change(screen.getByTestId('field-type'), { target: { value: 'number' } });
    fireEvent.change(screen.getByTestId('field-value'), { target: { value: '2.5' } });
    fireEvent.click(screen.getByTestId('field-save'));
    await waitFor(() => expect(vault.called('setCustomFields')).toHaveLength(1));
    expect(vault.called('setCustomFields')[0]!.args).toEqual([
      'hl-00000001',
      { chapter: '4', 'exam frequency': 2.5 },
    ]);
  });

  it('rejects a number that is not one, and a missing name, with a message', async () => {
    const { vault } = await open();
    fireEvent.change(screen.getByTestId('field-key'), { target: { value: 'score' } });
    fireEvent.change(screen.getByTestId('field-type'), { target: { value: 'number' } });
    fireEvent.change(screen.getByTestId('field-value'), { target: { value: 'many' } });
    fireEvent.click(screen.getByTestId('field-save'));
    await waitFor(() => expect(screen.getByText(/Enter a number/)).toBeTruthy());
    expect(vault.called('setCustomFields')).toHaveLength(0);
  });

  it('removes a field', async () => {
    const { vault } = await open([
      { id: 'hl-00000001', quote: QUOTE, customFields: { chapter: '4', reviewed: true } },
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove field chapter' }));
    await waitFor(() => expect(vault.called('setCustomFields')).toHaveLength(1));
    expect(vault.called('setCustomFields')[0]!.args[1]).toEqual({ reviewed: true });
  });
});

describe('Preview: notes', () => {
  it('creates a Markdown note and renders it sanitised', async () => {
    const { vault } = await open();
    fireEvent.click(screen.getByTestId('note-add'));
    fireEvent.change(screen.getByTestId('note-title'), { target: { value: 'Mnemonic' } });
    fireEvent.change(screen.getByTestId('note-body'), {
      target: {
        value: '**Lipids** first. [guide](https://example.com/g) <img src=x onerror=alert(1)>',
      },
    });
    fireEvent.click(screen.getByTestId('note-save'));
    await waitFor(() => expect(vault.called('createNote')).toHaveLength(1));
    expect(vault.called('createNote')[0]!.args[0]).toMatchObject({
      highlightId: 'hl-00000001',
      title: 'Mnemonic',
    });

    const note = await screen.findByTestId('note');
    expect(note.querySelector('strong')?.textContent).toBe('Lipids');
    expect(note.querySelector('img')).toBeNull();
    const link = note.querySelector('a')!;
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.getAttribute('href')).toBe('https://example.com/g');
    expect(note.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('never turns a stored hostile note into script or a live javascript: link', async () => {
    await open(undefined, (v) => {
      void v.api().createNote({
        highlightId: 'hl-00000001',
        body: '[click](javascript:alert(1)) <script>alert(2)</script> ![p](https://tracker.example/p.png)',
      });
    });
    const note = await screen.findByTestId('note');
    expect(note.querySelector('script, img, iframe')).toBeNull();
    for (const a of note.querySelectorAll('a')) {
      expect(a.getAttribute('href') ?? '').not.toMatch(/^javascript:/i);
    }
  });

  it('previews while writing', async () => {
    await open();
    fireEvent.click(screen.getByTestId('note-add'));
    fireEvent.change(screen.getByTestId('note-body'), { target: { value: '# Heading\n\n- one' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    const preview = screen.getByTestId('note-preview');
    expect(preview.querySelector('h1')?.textContent).toBe('Heading');
    expect(preview.querySelectorAll('li')).toHaveLength(1);
  });

  it('edits and deletes a note, with an undo for the delete', async () => {
    const { vault } = await open(undefined, (v) => {
      void v.api().createNote({ highlightId: 'hl-00000001', body: 'first draft' });
    });
    await screen.findByTestId('note');
    fireEvent.click(screen.getByTestId('note-edit'));
    fireEvent.change(screen.getByTestId('note-body'), { target: { value: 'second draft' } });
    fireEvent.click(screen.getByTestId('note-save'));
    await waitFor(() => expect(vault.called('updateNote')).toHaveLength(1));
    expect(vault.called('updateNote')[0]!.args[1]).toEqual({ title: '', body: 'second draft' });

    await waitFor(() => expect(screen.getByTestId('note').textContent).toContain('second draft'));
    fireEvent.click(screen.getByTestId('note-delete'));
    await waitFor(() => expect(vault.called('deleteNote')).toHaveLength(1));
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(vault.called('restore')).toHaveLength(1));
    expect(vault.called('restore')[0]!.args[0]).toEqual([{ kind: 'note', id: expect.any(String) }]);
  });

  it('keeps an unsaved note while another highlight is shown, and offers it back', async () => {
    const vault = new FakeVault([
      { id: 'hl-00000001', quote: QUOTE },
      { id: 'hl-00000002', quote: 'Another passage entirely.' },
    ]);
    const api = vault.api();
    const tree = await loadTreeData(api);
    const noop = {
      onFilterSource: () => undefined,
      onShow: () => undefined,
      onReviewDuplicates: () => undefined,
    };
    const view = (id: string) => (
      <Harness api={api} tree={tree}>
        <Preview id={id} {...noop} />
      </Harness>
    );
    const { rerender } = render(view('hl-00000001'));
    await screen.findByTestId('preview');
    fireEvent.click(screen.getByTestId('note-add'));
    fireEvent.change(screen.getByTestId('note-body'), { target: { value: 'half a thought' } });
    expect(hasUnsavedNotes()).toBe(true);

    rerender(view('hl-00000002'));
    await waitFor(() =>
      expect(screen.getByTestId('preview-quote').textContent).toBe('Another passage entirely.'),
    );
    expect(screen.queryByTestId('note-body')).toBeNull();

    rerender(view('hl-00000001'));
    const body = (await screen.findByTestId('note-body')) as HTMLTextAreaElement;
    expect(body.value).toBe('half a thought');
    expect(screen.getByTestId('note-draft-restored')).toBeTruthy();

    // Cancel discards it for good.
    fireEvent.click(screen.getByTestId('note-cancel'));
    expect(hasUnsavedNotes()).toBe(false);
  });

  it('keeps what you typed when a save fails', async () => {
    const { vault } = await open();
    vault.fail.createNote = new Error('Quota exceeded');
    fireEvent.click(screen.getByTestId('note-add'));
    fireEvent.change(screen.getByTestId('note-body'), { target: { value: 'precious thought' } });
    fireEvent.click(screen.getByTestId('note-save'));
    await waitFor(() => expect(screen.getByText('Quota exceeded')).toBeTruthy());
    expect((screen.getByTestId('note-body') as HTMLTextAreaElement).value).toBe('precious thought');
  });
});

describe('Preview: filing and duplicates', () => {
  it('files the highlight in another bank without copying it', async () => {
    const { vault } = await open(undefined, (v) => v.addBank('bank-bio', 'Biology'));
    fireEvent.click(screen.getByTestId('file-in-another'));
    const dialog = await screen.findByRole('dialog', { hidden: true });
    expect((within(dialog).getByTestId('place-bank') as HTMLSelectElement).value).toBe('bank-bio');
    fireEvent.click(within(dialog).getByTestId('dialog-confirm'));
    await waitFor(() => expect(vault.called('addToBank')).toHaveLength(1));
    expect(vault.called('addToBank')[0]!.args[0]).toEqual({
      highlightId: 'hl-00000001',
      bankId: 'bank-bio',
      folderId: null,
    });
  });

  it('removes it from one bank and tells you when that sends it to the Inbox', async () => {
    const { vault } = await open(
      [{ id: 'hl-00000001', quote: QUOTE, bankIds: ['bank-bio'] }],
      (v) => v.addBank('bank-bio', 'Biology'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove from Biology' }));
    await waitFor(() => expect(vault.called('removeFromBank')).toHaveLength(1));
    expect(await screen.findByText(/it is now filed in the Inbox/)).toBeTruthy();
  });

  it('lists other copies of the quote and never merges them', async () => {
    const { vault, handlers } = await open([
      { id: 'hl-00000001', quote: QUOTE },
      { id: 'hl-00000002', quote: QUOTE, title: 'Another page', url: 'https://example.org/b' },
    ]);
    const members = screen.getAllByTestId('duplicate-member');
    expect(members).toHaveLength(1);
    expect(members[0]!.textContent).toContain('Another page');
    fireEvent.click(within(members[0]!).getByRole('button', { name: 'Show' }));
    expect(handlers.onShow).toHaveBeenCalledWith('hl-00000002');
    fireEvent.click(screen.getByTestId('review-duplicates'));
    expect(handlers.onReviewDuplicates).toHaveBeenCalledWith('hl-00000001');
    expect(vault.called('bulkDelete')).toHaveLength(0);
    expect(vault.called('softDeleteHighlight')).toHaveLength(0);
  });

  it('narrows the list to this source', async () => {
    const { handlers } = await open();
    fireEvent.click(screen.getByTestId('filter-source'));
    expect(handlers.onFilterSource).toHaveBeenCalledWith({
      id: 'source-0001',
      label: 'Cell biology notes',
    });
  });
});
