import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { BankPane } from './BankPane';
import { Harness } from './testHarness';
import { FakeVault } from './testing';
import { loadTreeData } from './treeData';
import type { Scope } from './filters';

beforeEach(() => {
  fakeBrowser.reset();
  window.localStorage.clear();
});
afterEach(cleanup);

async function open(scope: Scope = { bankId: null, folderId: null }, nested = false) {
  const vault = new FakeVault([
    { id: 'hl-00000001', quote: 'A', bankIds: ['bank-bio'], folderId: 'f-cells' },
    { id: 'hl-00000002', quote: 'B', bankIds: ['bank-bio'], folderId: 'f-cells' },
    { id: 'hl-00000003', quote: 'C', bankIds: ['bank-bio'], folderId: 'f-gen' },
    { id: 'hl-00000004', quote: 'D' },
  ]);
  vault.addBank('bank-bio', 'Biology');
  vault.addBank('bank-chem', 'Chemistry');
  vault.folders.push(
    { id: 'f-cells', bankId: 'bank-bio', parentId: null, name: 'Cells' },
    { id: 'f-gen', bankId: 'bank-bio', parentId: null, name: 'Genetics' },
    { id: 'f-evo', bankId: 'bank-bio', parentId: null, name: 'Evolution' },
  );
  if (nested) {
    vault.folders.push({ id: 'f-mem', bankId: 'bank-bio', parentId: 'f-cells', name: 'Membranes' });
  }
  const api = vault.api();
  const onScope = vi.fn();
  const tree = await loadTreeData(api);
  render(
    <Harness api={api} tree={tree}>
      <BankPane api={api} scope={scope} onScope={onScope} />
    </Harness>,
  );
  await screen.findByRole('tree');
  return { vault, onScope };
}

const item = (name: string) => screen.getByRole('treeitem', { name: new RegExp(`^${name}\\b`) });
const focus = (name: string) => act(() => item(name).focus());
const dialog = () => screen.getByRole('dialog', { hidden: true });

describe('BankPane tree', () => {
  it('shows banks, folders and live counts, with the Inbox marked protected', async () => {
    await open();
    const names = screen.getAllByRole('treeitem').map((i) => i.getAttribute('aria-level'));
    expect(names).toEqual(['1', '1', '2', '2', '2', '1']);
    expect(item('Biology').textContent).toContain('3');
    expect(item('Cells').textContent).toContain('2');
    expect(item('Inbox').textContent).toContain('protected');
  });

  it('opens a bank or folder as the list scope', async () => {
    const { onScope } = await open();
    fireEvent.click(item('Cells'));
    expect(onScope).toHaveBeenLastCalledWith({ bankId: 'bank-bio', folderId: 'f-cells' });
    focus('Biology');
    fireEvent.keyDown(item('Biology'), { key: 'Enter' });
    expect(onScope).toHaveBeenLastCalledWith({ bankId: 'bank-bio', folderId: null });
  });

  it('reorders a folder with Alt+Arrow (the keyboard way to drag)', async () => {
    const { vault } = await open();
    focus('Genetics');
    fireEvent.keyDown(item('Genetics'), { key: 'ArrowUp', altKey: true });
    await waitFor(() => expect(vault.called('reorderFolders')).toHaveLength(1));
    expect(vault.called('reorderFolders')[0]!.args[0]).toEqual({
      bankId: 'bank-bio',
      parentFolderId: null,
      orderedIds: ['f-gen', 'f-cells', 'f-evo'],
    });
  });

  it('nests a folder under the one above with Alt+Right', async () => {
    const { vault } = await open();
    focus('Genetics');
    fireEvent.keyDown(item('Genetics'), { key: 'ArrowRight', altKey: true });
    await waitFor(() => expect(vault.called('moveFolder')).toHaveLength(1));
    expect(vault.called('moveFolder')[0]!.args[0]).toEqual({
      id: 'f-gen',
      parentFolderId: 'f-cells',
      bankId: 'bank-bio',
    });
  });

  it('moves a nested folder out next to its parent with Alt+Left', async () => {
    const { vault } = await open({ bankId: null, folderId: null }, true);
    expect(item('Membranes').getAttribute('aria-level')).toBe('3');
    focus('Membranes');
    fireEvent.keyDown(item('Membranes'), { key: 'ArrowLeft', altKey: true });
    await waitFor(() => expect(vault.called('moveFolder')).toHaveLength(1));
    expect(vault.called('moveFolder')[0]!.args[0]).toEqual({
      id: 'f-mem',
      parentFolderId: null,
      bankId: 'bank-bio',
      index: 1,
    });
  });

  it('explains instead of failing when a move is impossible', async () => {
    const { vault } = await open();
    focus('Cells');
    fireEvent.keyDown(item('Cells'), { key: 'ArrowUp', altKey: true });
    expect(await screen.findByText('Already first.')).toBeTruthy();
    expect(vault.called('reorderFolders')).toHaveLength(0);
  });

  it('keeps the Inbox first and unrenamable', async () => {
    const { vault } = await open();
    focus('Inbox');
    fireEvent.keyDown(item('Inbox'), { key: 'F2' });
    expect(await screen.findByText('The Inbox cannot be renamed.')).toBeTruthy();
    fireEvent.keyDown(item('Inbox'), { key: 'Delete' });
    expect(await screen.findByText('The Inbox cannot be deleted.')).toBeTruthy();
    expect(screen.queryByRole('dialog', { hidden: true })).toBeNull();
    expect(vault.called('deleteBank')).toHaveLength(0);
  });
});

describe('BankPane operations', () => {
  it('creates a bank from the toolbar', async () => {
    const { vault } = await open();
    fireEvent.click(screen.getByTestId('new-bank'));
    fireEvent.change(within(dialog()).getByTestId('name-input'), { target: { value: 'Physics' } });
    fireEvent.click(within(dialog()).getByTestId('dialog-confirm'));
    await waitFor(() => expect(vault.called('createBank')).toHaveLength(1));
    expect(vault.called('createBank')[0]!.args).toEqual(['Physics']);
    await waitFor(() => expect(screen.queryByRole('dialog', { hidden: true })).toBeNull());
  });

  it('refuses an empty name and keeps the dialog open with the failure when saving fails', async () => {
    const { vault } = await open();
    fireEvent.click(screen.getByTestId('new-bank'));
    const confirm = within(dialog()).getByTestId('dialog-confirm');
    expect(confirm.getAttribute('aria-disabled')).toBe('true');
    fireEvent.submit(within(dialog()).getByTestId('name-input').closest('form')!);
    expect(vault.called('createBank')).toHaveLength(0);

    vault.fail.createBank = new Error('Storage is unavailable');
    fireEvent.change(within(dialog()).getByTestId('name-input'), { target: { value: 'Physics' } });
    fireEvent.click(confirm);
    expect(await within(dialog()).findByText('Storage is unavailable')).toBeTruthy();
    expect(screen.getByRole('dialog', { hidden: true })).toBeTruthy();
  });

  it('renames a folder with F2', async () => {
    const { vault } = await open();
    focus('Genetics');
    fireEvent.keyDown(item('Genetics'), { key: 'F2' });
    const input = within(dialog()).getByTestId('name-input') as HTMLInputElement;
    expect(input.value).toBe('Genetics');
    fireEvent.change(input, { target: { value: 'Heredity' } });
    fireEvent.click(within(dialog()).getByTestId('dialog-confirm'));
    await waitFor(() => expect(vault.called('renameFolder')).toHaveLength(1));
    expect(vault.called('renameFolder')[0]!.args).toEqual(['f-gen', 'Heredity']);
  });

  it('shows what deleting will re-home before anything is deleted', async () => {
    const { vault } = await open();
    focus('Cells');
    fireEvent.keyDown(item('Cells'), { key: 'Delete' });
    const lines = within(dialog()).getByTestId('explain-lines').textContent!;
    expect(lines).toContain('2 highlights');
    expect(lines).toContain('Biology');
    expect(lines).toContain('Trash');
    expect(vault.called('deleteFolder')).toHaveLength(0);

    fireEvent.click(within(dialog()).getByTestId('dialog-cancel'));
    expect(vault.called('deleteFolder')).toHaveLength(0);

    fireEvent.keyDown(item('Cells'), { key: 'Delete' });
    fireEvent.click(within(dialog()).getByTestId('dialog-confirm'));
    await waitFor(() => expect(vault.called('deleteFolder')).toHaveLength(1));
    expect(vault.called('deleteFolder')[0]!.args).toEqual(['f-cells']);
  });

  it('merges one folder into another after explaining it', async () => {
    const { vault } = await open();
    focus('Genetics');
    fireEvent.contextMenu(item('Genetics'), { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByRole('menuitem', { name: /Merge into another folder/ }));
    const select = within(dialog()).getByTestId('merge-target') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'f-evo' } });
    expect(within(dialog()).getByTestId('merge-explain').textContent).toContain('“Evolution”');
    fireEvent.click(within(dialog()).getByTestId('dialog-confirm'));
    await waitFor(() => expect(vault.called('mergeFolders')).toHaveLength(1));
    expect(vault.called('mergeFolders')[0]!.args[0]).toEqual({
      sourceId: 'f-gen',
      targetId: 'f-evo',
    });
  });

  it('moves a folder to another bank through a dialog', async () => {
    const { vault } = await open();
    focus('Evolution');
    fireEvent.contextMenu(item('Evolution'), { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to…' }));
    fireEvent.change(within(dialog()).getByTestId('place-bank'), {
      target: { value: 'bank-chem' },
    });
    fireEvent.click(within(dialog()).getByTestId('dialog-confirm'));
    await waitFor(() => expect(vault.called('moveFolder')).toHaveLength(1));
    expect(vault.called('moveFolder')[0]!.args[0]).toEqual({
      id: 'f-evo',
      parentFolderId: null,
      bankId: 'bank-chem',
    });
  });

  it('creates a folder inside a bank from its context menu', async () => {
    const { vault } = await open();
    focus('Chemistry');
    fireEvent.contextMenu(item('Chemistry'), { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'New folder here…' }));
    fireEvent.change(within(dialog()).getByTestId('name-input'), { target: { value: 'Organic' } });
    fireEvent.click(within(dialog()).getByTestId('dialog-confirm'));
    await waitFor(() => expect(vault.called('createFolder')).toHaveLength(1));
    expect(vault.called('createFolder')[0]!.args[0]).toEqual({
      bankId: 'bank-chem',
      name: 'Organic',
      parentFolderId: null,
    });
  });

  it('sets a bank colour and icon', async () => {
    const { vault } = await open();
    focus('Chemistry');
    fireEvent.contextMenu(item('Chemistry'), { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Colour and icon…' }));
    fireEvent.change(within(dialog()).getByTestId('bank-color'), { target: { value: 'purple' } });
    fireEvent.change(within(dialog()).getByTestId('bank-icon'), { target: { value: '⚗' } });
    fireEvent.click(within(dialog()).getByTestId('dialog-confirm'));
    await waitFor(() => expect(vault.called('setBankIcon')).toHaveLength(1));
    expect(vault.called('setBankColor')[0]!.args).toEqual(['bank-chem', 'purple']);
    expect(vault.called('setBankIcon')[0]!.args).toEqual(['bank-chem', '⚗']);
  });

  it('shows why the Inbox cannot be deleted or merged in its menu', async () => {
    await open();
    focus('Inbox');
    fireEvent.contextMenu(item('Inbox'), { clientX: 10, clientY: 10 });
    const menu = screen.getByRole('menu');
    const del = within(menu).getByRole('menuitem', { name: /Delete bank/ });
    expect(del.getAttribute('aria-disabled')).toBe('true');
    expect(del.textContent).toContain('The Inbox cannot be deleted.');
    const merge = within(menu).getByRole('menuitem', { name: /Merge into another bank/ });
    expect(merge.getAttribute('aria-disabled')).toBe('true');
  });
});
