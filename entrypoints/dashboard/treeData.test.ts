import { describe, expect, it } from 'vitest';
import { INBOX_BANK_ID, MAX_FOLDER_DEPTH } from '@shared';
import type { BankInfo, FolderNode } from '@storage';
import {
  buildTree,
  describeDelete,
  describeMerge,
  flattenFolders,
  folderNodeId,
  planMove,
  subtreeFolderIds,
  type NodeMeta,
  type TreeData,
} from './treeData';

const bank = (id: string, name: string, over: Partial<BankInfo> = {}): BankInfo => ({
  id,
  name,
  color: 'blue',
  isInbox: id === INBOX_BANK_ID,
  icon: null,
  position: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const node = (
  id: string,
  bankId: string,
  name: string,
  count: number,
  depth: number,
  children: FolderNode[] = [],
  direct = count,
): FolderNode => ({
  folder: {
    id,
    bankId,
    parentFolderId: null,
    name,
    position: 1,
    schemaVersion: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
  },
  depth,
  count: direct,
  totalCount: count,
  children,
});

// Inbox, Biology { Cells { Membrane }, Genetics, Evolution }, Chemistry
const data: TreeData = {
  banks: [
    bank(INBOX_BANK_ID, 'Inbox'),
    bank('bio-bank', 'Biology'),
    bank('chem-bank', 'Chemistry'),
  ],
  folders: {
    [INBOX_BANK_ID]: [],
    'bio-bank': [
      node('cells', 'bio-bank', 'Cells', 7, 1, [node('membrane', 'bio-bank', 'Membrane', 3, 2)], 4),
      node('genetics', 'bio-bank', 'Genetics', 5, 1),
      node('evolution', 'bio-bank', 'Evolution', 2, 1),
    ],
    'chem-bank': [],
  },
  counts: {
    total: 20,
    banks: { [INBOX_BANK_ID]: 4, 'bio-bank': 14, 'chem-bank': 2 },
    folders: {},
    tags: {},
    kinds: {},
    priorities: {},
    resolveStatuses: {},
  },
  tags: [],
};

const built = buildTree(data);
const meta = (id: string): NodeMeta => built.meta.get(id)!;

describe('buildTree', () => {
  it('builds banks and nested folders with counts and sibling positions', () => {
    expect(built.items.map((i) => i.label)).toEqual(['Inbox', 'Biology', 'Chemistry']);
    const bio = built.items[1]!;
    expect(bio.children.map((c) => c.label)).toEqual(['Cells', 'Genetics', 'Evolution']);
    expect(bio.children[0]!.children.map((c) => c.label)).toEqual(['Membrane']);

    expect(meta('bank:bio-bank')).toMatchObject({
      kind: 'bank',
      count: 14,
      childFolders: 3,
      index: 1,
      siblings: 3,
      height: 3,
    });
    expect(meta(folderNodeId('cells'))).toMatchObject({
      kind: 'folder',
      bankId: 'bio-bank',
      parentFolderId: null,
      count: 7,
      directCount: 4,
      childFolders: 1,
      depth: 1,
      height: 2,
    });
    expect(meta(folderNodeId('membrane'))).toMatchObject({ parentFolderId: 'cells', depth: 2 });
    expect(meta('bank:' + INBOX_BANK_ID).isInbox).toBe(true);
  });

  it('flattens folders in order with depth, and finds a subtree', () => {
    const forest = data.folders['bio-bank']!;
    expect(flattenFolders(forest).map((f) => `${f.depth}:${f.name}`)).toEqual([
      '1:Cells',
      '2:Membrane',
      '1:Genetics',
      '1:Evolution',
    ]);
    expect([...subtreeFolderIds(forest, 'cells')].sort()).toEqual(['cells', 'membrane']);
    expect([...subtreeFolderIds(forest, 'genetics')]).toEqual(['genetics']);
  });
});

describe('planMove (keyboard alternative to drag and drop)', () => {
  it('reorders a folder among its siblings', () => {
    expect(planMove(data, meta(folderNodeId('genetics')), 'up')).toEqual({
      ok: true,
      op: {
        type: 'reorderFolders',
        bankId: 'bio-bank',
        parentFolderId: null,
        orderedIds: ['genetics', 'cells', 'evolution'],
      },
    });
    expect(planMove(data, meta(folderNodeId('genetics')), 'down')).toMatchObject({
      ok: true,
      op: { orderedIds: ['cells', 'evolution', 'genetics'] },
    });
  });

  it('refuses to move past either end, with the reason', () => {
    expect(planMove(data, meta(folderNodeId('cells')), 'up')).toEqual({
      ok: false,
      reason: 'Already first.',
    });
    expect(planMove(data, meta(folderNodeId('evolution')), 'down')).toEqual({
      ok: false,
      reason: 'Already last.',
    });
  });

  it('indents under the folder above and outdents next to the parent', () => {
    expect(planMove(data, meta(folderNodeId('genetics')), 'indent')).toEqual({
      ok: true,
      op: { type: 'moveFolder', id: 'genetics', parentFolderId: 'cells', bankId: 'bio-bank' },
    });
    expect(planMove(data, meta(folderNodeId('membrane')), 'outdent')).toEqual({
      ok: true,
      op: {
        type: 'moveFolder',
        id: 'membrane',
        parentFolderId: null,
        bankId: 'bio-bank',
        index: 1,
      },
    });
  });

  it('explains why indent and outdent are impossible', () => {
    expect(planMove(data, meta(folderNodeId('cells')), 'indent')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('no folder above'),
    });
    expect(planMove(data, meta(folderNodeId('cells')), 'outdent')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('top level'),
    });
  });

  it('refuses an indent that would pass the depth limit', () => {
    const top = MAX_FOLDER_DEPTH;
    let deep: FolderNode = node(`d${top}`, 'bio-bank', `Level ${top}`, 0, top);
    for (let depth = top - 1; depth >= 1; depth--) {
      deep = node(`d${depth}`, 'bio-bank', `Level ${depth}`, 0, depth, [deep]);
    }
    const tall: TreeData = {
      ...data,
      folders: { ...data.folders, 'bio-bank': [node('x', 'bio-bank', 'Sibling', 0, 1), deep] },
    };
    const built2 = buildTree(tall);
    // "d1" (height = the limit) sits below "x"; indenting it under x would pass the limit by one.
    expect(planMove(tall, built2.meta.get(folderNodeId('d1'))!, 'indent')).toMatchObject({
      ok: false,
      reason: expect.stringContaining(`${MAX_FOLDER_DEPTH} levels`),
    });
  });

  it('reorders banks but keeps the Inbox first and fixed', () => {
    expect(planMove(data, meta('bank:bio-bank'), 'down')).toEqual({
      ok: true,
      op: { type: 'reorderBanks', orderedIds: [INBOX_BANK_ID, 'chem-bank', 'bio-bank'] },
    });
    expect(planMove(data, meta('bank:bio-bank'), 'up')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('Inbox always stays first'),
    });
    expect(planMove(data, meta('bank:' + INBOX_BANK_ID), 'down')).toMatchObject({ ok: false });
    expect(planMove(data, meta('bank:bio-bank'), 'indent')).toMatchObject({ ok: false });
  });
});

describe('explanations', () => {
  it('says what deleting a folder re-homes before it happens', () => {
    const lines = describeDelete(data, meta(folderNodeId('cells')));
    expect(lines[0]).toContain('4 highlights');
    expect(lines[0]).toContain('Biology');
    expect(lines[1]).toContain('1 subfolder');
    expect(lines.join(' ')).toContain('Trash');
  });

  it('says what deleting a bank does to its highlights and folders', () => {
    const lines = describeDelete(data, meta('bank:bio-bank'));
    expect(lines[0]).toContain('14 highlights');
    expect(lines[0]).toContain('Inbox');
    expect(lines[1]).toContain('3 top-level folders');
  });

  it('describes a merge from both sides', () => {
    expect(describeMerge(meta(folderNodeId('cells')), 'Genetics')[0]).toContain(
      '4 highlights and 1 subfolder',
    );
    expect(describeMerge(meta('bank:bio-bank'), 'Chemistry')[0]).toContain('14 highlights');
  });
});
