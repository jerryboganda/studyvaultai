import { createContext, useContext } from 'react';
import { INBOX_BANK_ID, MAX_FOLDER_DEPTH, type ColorId } from '@shared';
import type { BankInfo, FolderNode, TagWithCount, VaultCounts } from '@storage';
import type { TreeItem } from '@ui/vault';
import type { DashboardApi } from './api';

/** Bank and folder tree as the dashboard needs it: render model, keyboard moves, explanations. */

export interface TreeData {
  banks: BankInfo[];
  /** Folder forest per bank id. */
  folders: Record<string, FolderNode[]>;
  counts: VaultCounts | null;
  tags: TagWithCount[];
}

export const EMPTY_TREE_DATA: TreeData = { banks: [], folders: {}, counts: null, tags: [] };

/** Everything the tree, the pickers and the filters need, read together. */
export async function loadTreeData(api: DashboardApi): Promise<TreeData> {
  const [banks, counts, tags] = await Promise.all([
    api.listBankInfos(),
    api.getCounts(),
    api.listTags(),
  ]);
  const forests = await Promise.all(banks.map((b) => api.listFolderTree(b.id)));
  return {
    banks,
    counts,
    tags,
    folders: Object.fromEntries(banks.map((b, i) => [b.id, forests[i] ?? []])),
  };
}
export const TreeDataContext = createContext<TreeData>(EMPTY_TREE_DATA);
export const useTreeData = (): TreeData => useContext(TreeDataContext);

export const bankNodeId = (id: string) => `bank:${id}`;
export const folderNodeId = (id: string) => `folder:${id}`;

export interface NodeMeta {
  kind: 'bank' | 'folder';
  /** Bank or folder id (without the "bank:" / "folder:" prefix). */
  id: string;
  bankId: string;
  /** Parent folder id; null for a bank and for a top-level folder. */
  parentFolderId: string | null;
  name: string;
  /** Highlights in the node and everything below it. */
  count: number;
  /** Highlights filed directly in this node (folders only). */
  directCount: number;
  childFolders: number;
  color: ColorId | null;
  icon: string | null;
  isInbox: boolean;
  /** 1 for a bank's top-level folder, 0 for a bank. */
  depth: number;
  index: number;
  siblings: number;
  /** Levels in the subtree rooted here, itself included (a leaf folder is 1). */
  height: number;
}

export interface BuiltTree {
  items: TreeItem[];
  meta: Map<string, NodeMeta>;
}

const heightOf = (node: FolderNode): number =>
  1 + node.children.reduce((h, c) => Math.max(h, heightOf(c)), 0);

export function buildTree(data: TreeData): BuiltTree {
  const meta = new Map<string, NodeMeta>();
  const folderItems = (
    nodes: readonly FolderNode[],
    bankId: string,
    parent: string | null,
  ): TreeItem[] =>
    nodes.map((node, index) => {
      const id = folderNodeId(node.folder.id);
      meta.set(id, {
        kind: 'folder',
        id: node.folder.id,
        bankId,
        parentFolderId: parent,
        name: node.folder.name,
        count: node.totalCount,
        directCount: node.count,
        childFolders: node.children.length,
        color: null,
        icon: null,
        isInbox: false,
        depth: node.depth,
        index,
        siblings: nodes.length,
        height: heightOf(node),
      });
      return {
        id,
        label: node.folder.name,
        children: folderItems(node.children, bankId, node.folder.id),
      };
    });

  const items = data.banks.map((bank, index) => {
    const id = bankNodeId(bank.id);
    const forest = data.folders[bank.id] ?? [];
    meta.set(id, {
      kind: 'bank',
      id: bank.id,
      bankId: bank.id,
      parentFolderId: null,
      name: bank.name,
      count: data.counts?.banks[bank.id] ?? 0,
      directCount: 0,
      childFolders: forest.length,
      color: bank.color,
      icon: bank.icon,
      isInbox: bank.isInbox || bank.id === INBOX_BANK_ID,
      depth: 0,
      index,
      siblings: data.banks.length,
      height: 1 + forest.reduce((h, n) => Math.max(h, heightOf(n)), 0),
    });
    return { id, label: bank.name, children: folderItems(forest, bank.id, null) };
  });
  return { items, meta };
}

/** Folders of a bank flattened in tree order with their depth (for indented <option>s). */
export function flattenFolders(
  nodes: readonly FolderNode[],
): Array<{ id: string; name: string; depth: number }> {
  const out: Array<{ id: string; name: string; depth: number }> = [];
  const walk = (list: readonly FolderNode[]) => {
    for (const n of list) {
      out.push({ id: n.folder.id, name: n.folder.name, depth: n.depth });
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/** Ids of a folder's subtree (itself included), to keep a move target out of its own descendants. */
export function subtreeFolderIds(nodes: readonly FolderNode[], id: string): Set<string> {
  const out = new Set<string>();
  const collect = (n: FolderNode) => {
    out.add(n.folder.id);
    n.children.forEach(collect);
  };
  const find = (list: readonly FolderNode[]): boolean => {
    for (const n of list) {
      if (n.folder.id === id) {
        collect(n);
        return true;
      }
      if (find(n.children)) return true;
    }
    return false;
  };
  find(nodes);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Keyboard moves
// ---------------------------------------------------------------------------------------------

export type MoveDirection = 'up' | 'down' | 'indent' | 'outdent';

export type MoveOp =
  | { type: 'reorderBanks'; orderedIds: string[] }
  | { type: 'reorderFolders'; bankId: string; parentFolderId: string | null; orderedIds: string[] }
  | {
      type: 'moveFolder';
      id: string;
      parentFolderId: string | null;
      bankId: string;
      index?: number;
    };

export type MovePlan = { ok: true; op: MoveOp } | { ok: false; reason: string };

function siblingsOf(data: TreeData, node: NodeMeta): string[] {
  if (node.kind === 'bank') return data.banks.map((b) => b.id);
  const forest = data.folders[node.bankId] ?? [];
  if (node.parentFolderId === null) return forest.map((n) => n.folder.id);
  const find = (list: readonly FolderNode[]): FolderNode | null => {
    for (const n of list) {
      if (n.folder.id === node.parentFolderId) return n;
      const hit = find(n.children);
      if (hit) return hit;
    }
    return null;
  };
  return find(forest)?.children.map((c) => c.folder.id) ?? [];
}

/**
 * What Alt+Arrow means for a node: reorder among siblings, indent under the sibling above, or
 * outdent to follow its parent. Everything the vault would refuse is refused here first, with the
 * reason, so the menu and the keyboard can say why instead of failing.
 */
export function planMove(data: TreeData, node: NodeMeta, direction: MoveDirection): MovePlan {
  const siblings = siblingsOf(data, node);
  const at = siblings.indexOf(node.id);
  if (at < 0) return { ok: false, reason: 'This item is no longer in the tree.' };

  if (node.kind === 'bank') {
    if (node.isInbox) return { ok: false, reason: 'The Inbox always stays first.' };
    if (direction === 'indent' || direction === 'outdent') {
      return { ok: false, reason: 'Banks are top-level; only folders can be nested.' };
    }
    const target = direction === 'up' ? at - 1 : at + 1;
    if (target < 0 || target >= siblings.length) {
      return { ok: false, reason: direction === 'up' ? 'Already first.' : 'Already last.' };
    }
    if (siblings[target] === INBOX_BANK_ID) {
      return { ok: false, reason: 'The Inbox always stays first.' };
    }
    const next = [...siblings];
    [next[at], next[target]] = [next[target]!, next[at]!];
    return { ok: true, op: { type: 'reorderBanks', orderedIds: next } };
  }

  if (direction === 'up' || direction === 'down') {
    const target = direction === 'up' ? at - 1 : at + 1;
    if (target < 0 || target >= siblings.length) {
      return { ok: false, reason: direction === 'up' ? 'Already first.' : 'Already last.' };
    }
    const next = [...siblings];
    [next[at], next[target]] = [next[target]!, next[at]!];
    return {
      ok: true,
      op: {
        type: 'reorderFolders',
        bankId: node.bankId,
        parentFolderId: node.parentFolderId,
        orderedIds: next,
      },
    };
  }

  if (direction === 'indent') {
    const above = siblings[at - 1];
    if (above === undefined) {
      return { ok: false, reason: 'There is no folder above to move this one into.' };
    }
    if (node.depth + node.height > MAX_FOLDER_DEPTH) {
      return {
        ok: false,
        reason: `Folders can be nested at most ${MAX_FOLDER_DEPTH} levels deep.`,
      };
    }
    return {
      ok: true,
      op: { type: 'moveFolder', id: node.id, parentFolderId: above, bankId: node.bankId },
    };
  }

  // outdent
  if (node.parentFolderId === null) {
    return { ok: false, reason: 'Already at the top level of the bank.' };
  }
  const parent = [...flatten(data, node.bankId)].find((f) => f.id === node.parentFolderId);
  if (!parent) return { ok: false, reason: 'The parent folder was not found.' };
  return {
    ok: true,
    op: {
      type: 'moveFolder',
      id: node.id,
      parentFolderId: parent.parentFolderId,
      bankId: node.bankId,
      index: parent.index + 1,
    },
  };
}

function flatten(
  data: TreeData,
  bankId: string,
): Array<{ id: string; parentFolderId: string | null; index: number }> {
  const out: Array<{ id: string; parentFolderId: string | null; index: number }> = [];
  const walk = (list: readonly FolderNode[], parent: string | null) => {
    list.forEach((n, index) => {
      out.push({ id: n.folder.id, parentFolderId: parent, index });
      walk(n.children, n.folder.id);
    });
  };
  walk(data.folders[bankId] ?? [], null);
  return out;
}

// ---------------------------------------------------------------------------------------------
// "What will happen" texts
// ---------------------------------------------------------------------------------------------

const n = (count: number, one: string, many = `${one}s`) =>
  `${count.toLocaleString()} ${count === 1 ? one : many}`;

export function describeDelete(data: TreeData, node: NodeMeta): string[] {
  if (node.kind === 'folder') {
    const bank = data.banks.find((b) => b.id === node.bankId);
    const parent =
      node.parentFolderId === null
        ? `the top level of ${bank?.name ?? 'its bank'}`
        : 'its parent folder';
    return [
      `${n(node.directCount, 'highlight')} filed directly in “${node.name}” stay in ${bank?.name ?? 'the bank'} and move to ${parent}.`,
      `${n(node.childFolders, 'subfolder')} move up to ${parent}.`,
      'The folder itself goes to the Trash, where it can be restored.',
    ];
  }
  return [
    `${n(node.count, 'highlight')} are filed in “${node.name}”. Those that are not also in another bank are filed in the Inbox; none are deleted.`,
    `${n(node.childFolders, 'top-level folder')} (and everything below) go to the Trash with the bank and come back if you restore it.`,
  ];
}

export function describeMerge(source: NodeMeta, targetName: string): string[] {
  if (source.kind === 'folder') {
    return [
      `${n(source.directCount, 'highlight')} and ${n(source.childFolders, 'subfolder')} move from “${source.name}” into “${targetName}”.`,
      `“${source.name}” is then removed (it goes to the Trash).`,
    ];
  }
  return [
    `Every folder and ${n(source.count, 'highlight')} of “${source.name}” move into “${targetName}”.`,
    `“${source.name}” is then removed (it goes to the Trash). Highlights already in “${targetName}” are not duplicated.`,
  ];
}
