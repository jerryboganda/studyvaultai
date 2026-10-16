import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { DuplicatesView } from './DuplicatesView';
import { StoragePanel } from './StoragePanel';
import { TrashView, summarizePurge } from './TrashView';
import { Harness } from './testHarness';
import { FakeVault } from './testing';
import { loadTreeData } from './treeData';

beforeEach(() => fakeBrowser.reset());
afterEach(cleanup);

async function mount(vault: FakeVault, ui: (api: ReturnType<FakeVault['api']>) => React.ReactNode) {
  const api = vault.api();
  const tree = await loadTreeData(api);
  render(
    <Harness api={api} tree={tree}>
      {ui(api)}
    </Harness>,
  );
}

const dialog = () => screen.getByRole('dialog', { hidden: true });
const NOW = '2026-10-10T10:00:00.000Z';
// Several agents share the CPU: a slow re-render is not a failure.
const SLOW = { timeout: 8000 };

describe('TrashView', () => {
  const trashed = () =>
    new FakeVault([
      { id: 'hl-00000001', quote: 'First deleted quote', deletedAt: '2026-10-10T10:00:00.000Z' },
      { id: 'hl-00000002', quote: 'Second deleted quote', deletedAt: '2026-10-10T11:00:00.000Z' },
      { id: 'hl-00000003', quote: 'Still alive' },
    ]);

  it('lists what was deleted, with where it came from', async () => {
    await mount(trashed(), () => <TrashView />);
    const items = await screen.findAllByTestId('trash-item-check');
    expect(items).toHaveLength(2);
    expect(screen.getByTestId('trash-list').textContent).toContain('First deleted quote');
    expect(screen.getByTestId('trash-list').textContent).toContain('Cell biology notes');
    expect(screen.queryByText('Still alive')).toBeNull();
    // A named group of buttons in the Tab order, not a toolbar that promises arrow keys.
    expect(screen.getByRole('group', { name: 'Trash actions' })).toBeTruthy();
    expect(screen.queryByRole('toolbar')).toBeNull();
  });

  it('restores the selected items and says how many', async () => {
    const vault = trashed();
    await mount(vault, () => <TrashView />);
    const [first] = await screen.findAllByTestId('trash-item-check');
    const restore = screen.getByTestId('trash-restore');
    expect(restore.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(first!);
    // The same button, now available (it is never re-created under the keyboard).
    expect(screen.getByTestId('trash-restore')).toBe(restore);
    fireEvent.click(restore);
    await waitFor(() => expect(vault.called('restore')).toHaveLength(1));
    expect(vault.called('restore')[0]!.args[0]).toEqual([
      { kind: 'highlight', id: expect.any(String) },
    ]);
    expect((await screen.findByTestId('trash-outcome')).textContent).toBe('Restored 1 item.');
  });

  it('asks with counts before deleting selected items for good', async () => {
    const vault = trashed();
    await mount(vault, () => <TrashView />);
    await screen.findAllByTestId('trash-item-check');
    fireEvent.click(screen.getByTestId('trash-select-all'));
    fireEvent.click(screen.getByTestId('trash-purge'));
    expect(within(dialog()).getByTestId('explain-lines').textContent).toContain('2 highlights');
    expect(vault.called('purge')).toHaveLength(0);

    fireEvent.click(within(dialog()).getByTestId('dialog-cancel'));
    expect(vault.called('purge')).toHaveLength(0);

    fireEvent.click(screen.getByTestId('trash-purge'));
    fireEvent.click(within(dialog()).getByTestId('dialog-confirm'));
    await waitFor(() => expect(vault.called('purge')).toHaveLength(1));
    expect((await screen.findByTestId('trash-outcome')).textContent).toContain(
      'Permanently deleted 2 highlights.',
    );
  });

  it('empties the trash only after a confirmation that names the counts', async () => {
    const vault = trashed();
    await mount(vault, () => <TrashView />);
    await screen.findAllByTestId('trash-item-check');
    fireEvent.click(screen.getByTestId('trash-empty'));
    expect(within(dialog()).getByTestId('explain-lines').textContent).toContain('2 highlights');
    expect(vault.called('emptyTrash')).toHaveLength(0);
    fireEvent.click(within(dialog()).getByTestId('dialog-confirm'));
    await waitFor(() => expect(vault.called('emptyTrash')).toHaveLength(1));
    await waitFor(() => expect(screen.getByText('Trash is empty')).toBeTruthy());
  });

  it('words the empty-trash counts in the singular for a single item', async () => {
    const vault = new FakeVault([
      { id: 'hl-00000001', quote: 'Only deleted quote', deletedAt: '2026-10-10T10:00:00.000Z' },
    ]);
    await mount(vault, () => <TrashView />);
    await screen.findAllByTestId('trash-item-check');
    fireEvent.click(screen.getByTestId('trash-empty'));
    const lines = within(dialog()).getByTestId('explain-lines').textContent ?? '';
    expect(lines).toContain('1 highlight will be removed for good.');
    expect(lines).not.toContain('1 highlights');
  });

  it('shows the empty state', async () => {
    await mount(new FakeVault([{ id: 'hl-00000001', quote: 'x' }]), () => <TrashView />);
    expect(await screen.findByText('Trash is empty')).toBeTruthy();
  });

  it('restores one item from its own card, without selecting it first', async () => {
    const vault = trashed();
    await mount(vault, () => <TrashView />);
    const [first] = await screen.findAllByTestId('trash-item-restore');
    fireEvent.click(first!);
    await waitFor(() => expect(vault.called('restore')).toHaveLength(1));
    expect(vault.called('restore')[0]!.args[0]).toHaveLength(1);
    expect((await screen.findByTestId('trash-outcome')).textContent).toBe('Restored 1 item.');
  });

  it('deletes one item forever only after confirming it', async () => {
    const vault = trashed();
    await mount(vault, () => <TrashView />);
    const [, second] = await screen.findAllByTestId('trash-item-purge');
    fireEvent.click(second!);
    expect(within(dialog()).getByTestId('explain-lines').textContent).toContain(
      '1 highlight will be removed for good.',
    );
    expect(vault.called('purge')).toHaveLength(0);
    fireEvent.click(within(dialog()).getByTestId('dialog-confirm'));
    await waitFor(() => expect(vault.called('purge')).toHaveLength(1));
    expect(vault.called('purge')[0]!.args[0]).toHaveLength(1);
  });

  it('filters by kind with the chips', async () => {
    await mount(trashed(), () => <TrashView />);
    await screen.findAllByTestId('trash-item-check');
    const kinds = within(screen.getByTestId('trash-kind'));
    expect((kinds.getByRole('radio', { name: /All/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(kinds.getByRole('radio', { name: /Highlights/ }));
    expect(screen.getAllByTestId('trash-item-check')).toHaveLength(2);
  });

  it('names each item in its own buttons, and keeps the keyboard in the list after one goes', async () => {
    const vault = trashed();
    await mount(vault, () => <TrashView />);
    const buttons = await screen.findAllByTestId('trash-item-restore');
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(
      expect.arrayContaining(['Restore: First deleted quote', 'Restore: Second deleted quote']),
    );
    buttons[0]!.focus();
    fireEvent.click(buttons[0]!);
    await waitFor(() => expect(screen.getAllByTestId('trash-item-restore')).toHaveLength(1), SLOW);
    // The restored item's button is gone: focus is on the same button of the item left.
    await waitFor(
      () => expect(document.activeElement).toBe(screen.getAllByTestId('trash-item-restore')[0]),
      SLOW,
    );
  });

  it('shows everything again when the last item of the shown kind leaves the trash', async () => {
    const vault = trashed();
    const api = vault.api();
    let items: Array<{ kind: 'highlight' | 'note'; id: string; label: string; deletedAt: string }> =
      [
        { kind: 'highlight', id: 'hl-00000001', label: 'A deleted quote', deletedAt: NOW },
        { kind: 'note', id: 'note-0000001', label: 'A deleted note', deletedAt: NOW },
      ];
    api.listTrash = async () => items.map((i) => ({ ...i, context: '' }));
    api.restore = async (refs) => {
      const ids = new Set(refs.map((r) => (typeof r === 'string' ? r : r.id)));
      items = items.filter((i) => !ids.has(i.id));
      return { restored: ids.size };
    };
    const tree = await loadTreeData(api);
    render(
      <Harness api={api} tree={tree}>
        <TrashView />
      </Harness>,
    );
    await screen.findAllByTestId('trash-item-check', undefined, SLOW);
    fireEvent.click(within(screen.getByTestId('trash-kind')).getByRole('radio', { name: /Notes/ }));
    expect(screen.getAllByTestId('trash-item-check')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('trash-item-restore'));
    await waitFor(
      () =>
        expect(
          within(screen.getByTestId('trash-kind')).queryByRole('radio', { name: /Notes/ }),
        ).toBeNull(),
      SLOW,
    );
    const all = within(screen.getByTestId('trash-kind')).getByRole('radio', { name: /All/ });
    expect((all as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId('trash-list').textContent).toContain('A deleted quote');
  });

  it('summarises a purge in words', () => {
    const text = summarizePurge({
      purged: { highlight: 2, note: 1, folder: 0, bank: 0, tag: 0, document: 0 },
      related: {
        memberships: 3,
        tagLinks: 0,
        notes: 0,
        sources: 1,
        folders: 0,
        knowledgePoints: 0,
        cards: 0,
        reviewLogs: 0,
        aiResults: 0,
        attachments: 0,
        ocrPages: 0,
      },
    });
    expect(text).toBe(
      'Permanently deleted 2 highlights, 1 note. Also removed linked rows: 3 memberships, 1 sources.',
    );
  });
});

describe('DuplicatesView', () => {
  const dupes = () => {
    const vault = new FakeVault([
      { id: 'hl-00000001', quote: 'Same words', title: 'Page A', url: 'https://a.example/x' },
      { id: 'hl-00000002', quote: 'Same words', title: 'Page B', url: 'https://b.example/y' },
    ]);
    vault.duplicates = [
      {
        quoteHash: 'h'.repeat(64),
        quote: 'Same words',
        sourceCount: 2,
        members: ['hl-00000001', 'hl-00000002'].map((id, i) => ({
          highlightId: id,
          sourceId: `s-${i}`,
          sourceTitle: i === 0 ? 'Page A' : 'Page B',
          host: i === 0 ? 'a.example' : 'b.example',
          originalUrl: i === 0 ? 'https://a.example/x' : 'https://b.example/y',
          sourceType: 'web' as const,
          bankIds: ['inbox-default'],
          capturedAt: '2026-10-10T10:00:00.000Z',
          pageNumber: null,
        })),
      },
    ];
    return vault;
  };

  it('shows each cluster with its copies and never merges on its own', async () => {
    const vault = dupes();
    const onShow = vi.fn();
    await mount(vault, () => <DuplicatesView focusHighlightId={null} onShow={onShow} />);
    const cluster = await screen.findByTestId('duplicate-cluster');
    expect(cluster.textContent).toContain('Same words');
    expect(cluster.textContent).toContain('2 copies');
    expect(cluster.textContent).toContain('2 sources');
    const members = within(cluster).getAllByTestId('duplicate-member');
    expect(members).toHaveLength(2);
    expect(members[0]!.textContent).toContain('Page A');
    expect(members[0]!.textContent).toContain('Inbox');
    fireEvent.click(within(members[1]!).getByRole('button', { name: 'Show in library' }));
    expect(onShow).toHaveBeenCalledWith('hl-00000002');
    expect(vault.called('bulkDelete')).toHaveLength(0);
    expect(vault.called('softDeleteHighlight')).toHaveLength(0);
  });

  it('moves one copy to the trash on request, with an undo', async () => {
    const vault = dupes();
    await mount(vault, () => (
      <DuplicatesView focusHighlightId="hl-00000002" onShow={() => undefined} />
    ));
    const members = await screen.findAllByTestId('duplicate-member');
    fireEvent.click(within(members[1]!).getByTestId('duplicate-trash'));
    await waitFor(() => expect(vault.called('softDeleteHighlight')).toHaveLength(1));
    expect(vault.called('softDeleteHighlight')[0]!.args).toEqual(['hl-00000002']);
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(vault.called('restoreHighlight')).toHaveLength(1));
  });

  it('keeps one copy and moves the others to the trash, with one Undo for all', async () => {
    const vault = dupes();
    await mount(vault, () => <DuplicatesView focusHighlightId={null} onShow={() => undefined} />);
    const members = await screen.findAllByTestId('duplicate-member');
    fireEvent.click(within(members[0]!).getByTestId('duplicate-keep'));
    await waitFor(() => expect(vault.called('softDeleteHighlight')).toHaveLength(1));
    expect(vault.called('softDeleteHighlight')[0]!.args).toEqual(['hl-00000002']);
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(vault.called('restoreHighlight')).toHaveLength(1));
    expect(vault.called('restoreHighlight')[0]!.args).toEqual(['hl-00000002']);
  });

  it('opens a source link safely', async () => {
    await mount(dupes(), () => <DuplicatesView focusHighlightId={null} onShow={() => undefined} />);
    const link = (await screen.findAllByRole('link', { name: 'Open source' }))[0]!;
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.getAttribute('href')).toContain('https://a.example/x#:~:text=Same%20words');
  });

  it('says so when there are none', async () => {
    await mount(new FakeVault(), () => (
      <DuplicatesView focusHighlightId={null} onShow={() => undefined} />
    ));
    expect(await screen.findByText('No duplicates found')).toBeTruthy();
  });
});

describe('StoragePanel', () => {
  const stocked = () => {
    const vault = new FakeVault([
      { id: 'hl-00000001', quote: 'a' },
      { id: 'hl-00000002', quote: 'b' },
    ]);
    vault.cachedPdfs = [
      { id: 'doc-00000001', title: 'Anatomy.pdf', bytes: 3 * 1024 * 1024 },
      { id: 'doc-00000002', title: 'Physiology.pdf', bytes: 1024 * 1024 },
    ];
    return vault;
  };

  it('shows real numbers from the vault', async () => {
    await mount(stocked(), () => (
      <StoragePanel
        hostState={{ phase: 'ready', documents: 2, rejected: 0 }}
        onRebuildIndex={() => undefined}
      />
    ));
    expect((await screen.findByTestId('storage-total-rows')).textContent).toBe('5');
    expect(screen.getByTestId('storage-usage').textContent).toBe('5.0 MB');
    expect(screen.getByTestId('storage-pdf-bytes').textContent).toBe('4.0 MB');
    const table = screen.getByTestId('storage-table');
    expect(within(table).getByText('Highlights').closest('tr')!.textContent).toContain('2');
    expect(screen.getByTestId('index-summary').textContent).toBe('2 documents indexed.');
  });

  it('clears one cached PDF', async () => {
    const vault = stocked();
    await mount(vault, () => (
      <StoragePanel
        hostState={{ phase: 'ready', documents: 2, rejected: 0 }}
        onRebuildIndex={() => undefined}
      />
    ));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Clear the cached copy of Anatomy.pdf' }),
    );
    await waitFor(() => expect(vault.called('removeDocumentBytes')).toHaveLength(1));
    expect(vault.called('removeDocumentBytes')[0]!.args).toEqual(['doc-00000001']);
    await waitFor(() =>
      expect(
        within(screen.getByTestId('cached-pdfs')).queryByText('Anatomy.pdf', { exact: false }),
      ).toBeNull(),
    );
  });

  it('clears every cached PDF only after confirming the size', async () => {
    const vault = stocked();
    await mount(vault, () => (
      <StoragePanel
        hostState={{ phase: 'ready', documents: 2, rejected: 0 }}
        onRebuildIndex={() => undefined}
      />
    ));
    fireEvent.click(await screen.findByTestId('clear-all-cache'));
    expect(within(dialog()).getByTestId('explain-lines').textContent).toContain('4.0 MB');
    expect(vault.called('removeDocumentBytes')).toHaveLength(0);
    fireEvent.click(within(dialog()).getByTestId('dialog-confirm'));
    await waitFor(() => expect(vault.called('removeDocumentBytes')).toHaveLength(2));
    expect(await screen.findByTestId('no-cached-pdfs')).toBeTruthy();
  });

  it('rebuilds the index on request and shows build progress', async () => {
    const onRebuild = vi.fn();
    await mount(new FakeVault(), () => (
      <StoragePanel
        hostState={{ phase: 'building', reason: 'requested', done: 1500, total: 4000 }}
        onRebuildIndex={onRebuild}
      />
    ));
    expect((await screen.findByTestId('index-summary')).textContent).toContain('1,500 of 4,000');
    const button = screen.getByTestId('rebuild-index');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(button);
    expect(onRebuild).not.toHaveBeenCalled();
  });
});
