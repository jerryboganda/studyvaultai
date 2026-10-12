import { useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';
import {
  COLOR_IDS,
  COLOR_SWATCH,
  MAX_BANK_ICON_CHARS,
  MAX_FOLDER_DEPTH,
  type ColorId,
} from '@shared';
import { Button, LOCAL_PREF_KEYS, errorMessage, plural, useToast } from '@ui';
import { PopupMenu, Tree, type MenuItem, type TreeHandle, type TreeKeyResult } from '@ui/vault';
import type { DashboardApi } from './api';
import {
  ExplainDialog,
  FormDialog,
  NAME_LIMITS,
  NameDialog,
  PlacePicker,
  type Place,
} from './dialogs';
import { ALL_SCOPE, type Scope } from './filters';
import { useBump, useLocalSet } from './hooks';
import {
  bankNodeId,
  buildTree,
  describeDelete,
  describeMerge,
  flattenFolders,
  folderNodeId,
  planMove,
  subtreeFolderIds,
  useTreeData,
  type MoveDirection,
  type MovePlan,
  type NodeMeta,
} from './treeData';

type Dialog =
  | { type: 'new-bank' }
  | { type: 'new-folder'; parent: NodeMeta }
  | { type: 'rename'; node: NodeMeta }
  | { type: 'delete'; node: NodeMeta }
  | { type: 'merge'; node: NodeMeta }
  | { type: 'move'; node: NodeMeta }
  | { type: 'style'; node: NodeMeta };

const colorLabel = (c: ColorId) => c.charAt(0).toUpperCase() + c.slice(1);

export function scopeOf(node: NodeMeta): Scope {
  return node.kind === 'bank'
    ? { bankId: node.id, folderId: null }
    : { bankId: node.bankId, folderId: node.id };
}

export interface BankPaneHandle {
  focusTree(): void;
  newBank(): void;
  /** Inside the bank or folder that is currently shown; false when none is. */
  newFolder(): boolean;
  renameCurrent(): boolean;
  deleteCurrent(): boolean;
}

export function BankPane({
  api,
  scope,
  onScope,
  ref,
}: {
  api: DashboardApi;
  scope: Scope;
  onScope(scope: Scope): void;
  ref?: Ref<BankPaneHandle>;
}) {
  const treeRef = useRef<TreeHandle>(null);
  const data = useTreeData();
  const bump = useBump();
  const toast = useToast();
  const built = useMemo(() => buildTree(data), [data]);
  const [collapsed, setCollapsed] = useLocalSet(LOCAL_PREF_KEYS.dashboardCollapsed);
  const [menu, setMenu] = useState<{ id: string; at: { x: number; y: number } } | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);

  const withChildren = useMemo(() => {
    const ids: string[] = [];
    const walk = (items: typeof built.items) => {
      for (const item of items) {
        if (item.children.length > 0) ids.push(item.id);
        walk(item.children);
      }
    };
    walk(built.items);
    return ids;
  }, [built]);
  const expanded = useMemo(
    () => new Set(withChildren.filter((id) => !collapsed.has(id))),
    [withChildren, collapsed],
  );

  const selectedId = scope.folderId
    ? folderNodeId(scope.folderId)
    : scope.bankId
      ? bankNodeId(scope.bankId)
      : null;

  const metaOf = (id: string) => built.meta.get(id);

  useImperativeHandle(ref, () => {
    const current = () => (selectedId ? built.meta.get(selectedId) : undefined);
    return {
      focusTree: () => treeRef.current?.focus(),
      newBank: () => setDialog({ type: 'new-bank' }),
      newFolder: () => {
        const node = current();
        if (!node) return false;
        setDialog({ type: 'new-folder', parent: node });
        return true;
      },
      renameCurrent: () => {
        const node = current();
        if (!node || node.isInbox) return false;
        setDialog({ type: 'rename', node });
        return true;
      },
      deleteCurrent: () => {
        const node = current();
        if (!node || node.isInbox) return false;
        setDialog({ type: 'delete', node });
        return true;
      },
    };
  });

  /** Run a vault write; report the outcome in words; refresh every view. */
  const perform = async (work: () => Promise<string>) => {
    try {
      const message = await work();
      bump();
      toast.push({ message });
    } catch (err) {
      toast.push({ tone: 'error', message: errorMessage(err, 'That change was not saved.') });
    }
  };

  const executeMove = (node: NodeMeta, plan: MovePlan) => {
    if (!plan.ok) {
      toast.push({ message: plan.reason });
      return;
    }
    const op = plan.op;
    void perform(async () => {
      if (op.type === 'reorderBanks') await api.reorderBanks(op.orderedIds);
      else if (op.type === 'reorderFolders') {
        await api.reorderFolders({
          bankId: op.bankId,
          parentFolderId: op.parentFolderId,
          orderedIds: op.orderedIds,
        });
      } else {
        await api.moveFolder({
          id: op.id,
          parentFolderId: op.parentFolderId,
          bankId: op.bankId,
          ...(op.index !== undefined ? { index: op.index } : {}),
        });
      }
      return `Moved “${node.name}”.`;
    });
  };

  const onCommand = (command: Extract<TreeKeyResult, { type: 'rename' | 'delete' | 'move' }>) => {
    const node = metaOf(command.id);
    if (!node) return;
    if (command.type === 'rename') {
      if (node.isInbox) toast.push({ message: 'The Inbox cannot be renamed.' });
      else setDialog({ type: 'rename', node });
    } else if (command.type === 'delete') {
      if (node.isInbox) toast.push({ message: 'The Inbox cannot be deleted.' });
      else setDialog({ type: 'delete', node });
    } else {
      executeMove(node, planMove(data, node, command.direction));
    }
  };

  const moveItem = (
    node: NodeMeta,
    direction: MoveDirection,
    label: string,
    hint?: string,
  ): MenuItem => {
    const plan = planMove(data, node, direction);
    return {
      id: `move-${direction}`,
      label,
      hint,
      disabledReason: plan.ok ? undefined : plan.reason,
      onSelect: () => executeMove(node, plan),
    };
  };

  const menuItems = (node: NodeMeta): MenuItem[] => {
    const show: MenuItem = {
      id: 'show',
      label: 'Show highlights',
      onSelect: () => onScope(scopeOf(node)),
    };
    const newFolder: MenuItem = {
      id: 'new-folder',
      label: node.kind === 'bank' ? 'New folder here…' : 'New subfolder…',
      disabledReason:
        node.kind === 'folder' && node.depth >= MAX_FOLDER_DEPTH
          ? `Folders can be nested at most ${MAX_FOLDER_DEPTH} levels deep.`
          : undefined,
      onSelect: () => setDialog({ type: 'new-folder', parent: node }),
    };
    const rename: MenuItem = {
      id: 'rename',
      label: 'Rename…',
      hint: 'F2',
      disabledReason: node.isInbox ? 'The Inbox cannot be renamed.' : undefined,
      onSelect: () => setDialog({ type: 'rename', node }),
    };
    const del: MenuItem = {
      id: 'delete',
      label: node.kind === 'bank' ? 'Delete bank…' : 'Delete folder…',
      hint: 'Del',
      danger: true,
      separatorBefore: true,
      disabledReason: node.isInbox ? 'The Inbox cannot be deleted.' : undefined,
      onSelect: () => setDialog({ type: 'delete', node }),
    };
    const mergeTargets =
      node.kind === 'bank'
        ? data.banks.filter((b) => b.id !== node.id)
        : flattenFolders(data.folders[node.bankId] ?? []).filter(
            (f) => !subtreeFolderIds(data.folders[node.bankId] ?? [], node.id).has(f.id),
          );
    const merge: MenuItem = {
      id: 'merge',
      label: node.kind === 'bank' ? 'Merge into another bank…' : 'Merge into another folder…',
      disabledReason: node.isInbox
        ? 'The Inbox cannot be merged into another bank.'
        : mergeTargets.length === 0
          ? 'There is nothing to merge into.'
          : undefined,
      onSelect: () => setDialog({ type: 'merge', node }),
    };
    if (node.kind === 'bank') {
      return [
        show,
        newFolder,
        rename,
        {
          id: 'style',
          label: 'Colour and icon…',
          onSelect: () => setDialog({ type: 'style', node }),
        },
        moveItem(node, 'up', 'Move up', 'Alt+↑'),
        moveItem(node, 'down', 'Move down', 'Alt+↓'),
        merge,
        del,
      ];
    }
    return [
      show,
      newFolder,
      rename,
      { id: 'move', label: 'Move to…', onSelect: () => setDialog({ type: 'move', node }) },
      moveItem(node, 'up', 'Move up', 'Alt+↑'),
      moveItem(node, 'down', 'Move down', 'Alt+↓'),
      moveItem(node, 'indent', 'Indent (into the folder above)', 'Alt+→'),
      moveItem(node, 'outdent', 'Outdent (out of its parent)', 'Alt+←'),
      merge,
      del,
    ];
  };

  const menuNode = menu ? metaOf(menu.id) : undefined;

  return (
    <section className="dash-bankpane" aria-label="Banks">
      <div className="sv-row dash-bankpane__head">
        <h2 className="sv-grow">Banks</h2>
        <Button onClick={() => setDialog({ type: 'new-bank' })} data-testid="new-bank">
          New bank
        </Button>
      </div>
      {built.items.length === 0 ? (
        <p className="sv-muted sv-small" data-testid="tree-empty">
          No banks yet. Save a highlight, or create a bank here.
        </p>
      ) : (
        <Tree
          ref={treeRef}
          label="Banks and folders"
          items={built.items}
          expanded={expanded}
          onExpandedChange={(next) =>
            setCollapsed(new Set(withChildren.filter((id) => !next.has(id))))
          }
          selectedId={selectedId}
          onActivate={(id) => {
            const node = metaOf(id);
            if (node) onScope(scopeOf(node));
          }}
          onCommand={onCommand}
          onContextMenu={(id, at) => setMenu({ id, at })}
          renderItem={(visible) => {
            const node = metaOf(visible.item.id);
            if (!node) return null;
            return (
              <>
                {node.kind === 'bank' && node.color ? (
                  <span
                    className="dash-swatch"
                    aria-hidden="true"
                    style={{ background: COLOR_SWATCH[node.color].solid }}
                  />
                ) : null}
                {node.icon ? <span aria-hidden="true">{node.icon}</span> : null}
                <span className="dash-tree__name" dir="auto">
                  {node.name}
                </span>{' '}
                {node.isInbox ? <span className="sv-sr">(protected) </span> : null}
                <span className="dash-tree__count sv-muted sv-small">
                  {node.count.toLocaleString()}{' '}
                  <span className="sv-sr">{node.count === 1 ? 'highlight' : 'highlights'}</span>
                </span>
              </>
            );
          }}
        />
      )}

      {menu && menuNode ? (
        <PopupMenu
          label={`Actions for ${menuNode.name}`}
          items={menuItems(menuNode)}
          at={menu.at}
          onClose={() => setMenu(null)}
        />
      ) : null}

      {dialog?.type === 'new-bank' ? (
        <NameDialog
          title="New bank"
          label="Bank name"
          confirmLabel="Create bank"
          maxLength={NAME_LIMITS.bank}
          onCancel={() => setDialog(null)}
          onSubmit={async (name) => {
            await api.createBank(name);
            bump();
            toast.push({ message: `Created bank ${name}.` });
            setDialog(null);
          }}
        />
      ) : null}

      {dialog?.type === 'new-folder' ? (
        <NameDialog
          title={
            dialog.parent.kind === 'bank'
              ? `New folder in ${dialog.parent.name}`
              : `New subfolder in ${dialog.parent.name}`
          }
          label="Folder name"
          confirmLabel="Create folder"
          maxLength={NAME_LIMITS.folder}
          hint={`Folders can hold topics and subtopics: nest them up to ${MAX_FOLDER_DEPTH} levels.`}
          onCancel={() => setDialog(null)}
          onSubmit={async (name) => {
            const parent = dialog.parent;
            await api.createFolder({
              bankId: parent.bankId,
              name,
              parentFolderId: parent.kind === 'folder' ? parent.id : null,
            });
            bump();
            toast.push({ message: `Created folder ${name}.` });
            setDialog(null);
          }}
        />
      ) : null}

      {dialog?.type === 'rename' ? (
        <NameDialog
          title={`Rename ${dialog.node.kind}`}
          label="New name"
          initial={dialog.node.name}
          confirmLabel="Rename"
          maxLength={dialog.node.kind === 'bank' ? NAME_LIMITS.bank : NAME_LIMITS.folder}
          onCancel={() => setDialog(null)}
          onSubmit={async (name) => {
            const node = dialog.node;
            if (node.kind === 'bank') await api.renameBank(node.id, name);
            else await api.renameFolder(node.id, name);
            bump();
            toast.push({ message: `Renamed to ${name}.` });
            setDialog(null);
          }}
        />
      ) : null}

      {dialog?.type === 'delete' ? (
        <ExplainDialog
          title={`Delete ${dialog.node.kind} “${dialog.node.name}”?`}
          lines={describeDelete(data, dialog.node)}
          confirmLabel={dialog.node.kind === 'bank' ? 'Delete bank' : 'Delete folder'}
          danger
          onCancel={() => setDialog(null)}
          onConfirm={async () => {
            const node = dialog.node;
            if (node.kind === 'bank') await api.deleteBank(node.id);
            else await api.deleteFolder(node.id);
            if (
              scope.bankId === node.bankId &&
              (node.kind === 'bank' || scope.folderId === node.id)
            ) {
              onScope(
                node.kind === 'folder' && node.parentFolderId === null
                  ? { bankId: node.bankId, folderId: null }
                  : node.kind === 'folder'
                    ? { bankId: node.bankId, folderId: node.parentFolderId }
                    : ALL_SCOPE,
              );
            }
            bump();
            toast.push({ message: `Deleted ${node.name}. It is in the Trash.` });
            setDialog(null);
          }}
        />
      ) : null}

      {dialog?.type === 'merge' ? (
        <MergeDialog
          node={dialog.node}
          api={api}
          onCancel={() => setDialog(null)}
          onDone={(message) => {
            bump();
            toast.push({ message });
            setDialog(null);
          }}
        />
      ) : null}

      {dialog?.type === 'move' ? (
        <MoveFolderDialog
          node={dialog.node}
          api={api}
          onCancel={() => setDialog(null)}
          onDone={(message) => {
            bump();
            toast.push({ message });
            setDialog(null);
          }}
        />
      ) : null}

      {dialog?.type === 'style' ? (
        <StyleDialog
          node={dialog.node}
          api={api}
          onCancel={() => setDialog(null)}
          onDone={() => {
            bump();
            toast.push({ message: 'Bank appearance saved.' });
            setDialog(null);
          }}
        />
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------

function MergeDialog({
  node,
  api,
  onCancel,
  onDone,
}: {
  node: NodeMeta;
  api: DashboardApi;
  onCancel(): void;
  onDone(message: string): void;
}) {
  const data = useTreeData();
  const banks = data.banks.filter((b) => b.id !== node.id);
  const exclude = subtreeFolderIds(data.folders[node.bankId] ?? [], node.id);
  const folders = flattenFolders(data.folders[node.bankId] ?? []).filter((f) => !exclude.has(f.id));
  const options =
    node.kind === 'bank'
      ? banks.map((b) => ({ id: b.id, name: b.name }))
      : folders.map((f) => ({ id: f.id, name: `${'  '.repeat(f.depth - 1)}${f.name}` }));
  const [target, setTarget] = useState(options[0]?.id ?? '');
  const targetName = options.find((o) => o.id === target)?.name.trim() ?? '';
  return (
    <FormDialog
      title={`Merge ${node.kind} “${node.name}”`}
      confirmLabel="Merge"
      danger
      disabledReason={target === '' ? 'Choose where to merge it.' : undefined}
      onCancel={onCancel}
      onSubmit={async () => {
        const result =
          node.kind === 'bank'
            ? await api.mergeBanks({ sourceId: node.id, targetId: target })
            : await api.mergeFolders({ sourceId: node.id, targetId: target });
        onDone(
          `Merged “${node.name}” into “${targetName}”: ${plural(result.movedHighlights, 'highlight')} and ${plural(result.movedFolders, 'folder')} moved.`,
        );
      }}
    >
      <div className="sv-field">
        <label className="sv-label" htmlFor="merge-target">
          Merge into
        </label>
        <select
          id="merge-target"
          className="sv-control"
          value={target}
          data-autofocus=""
          data-testid="merge-target"
          onChange={(e) => setTarget(e.target.value)}
        >
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      </div>
      {targetName ? (
        <ul className="sv-stack sv-stack--tight" data-testid="merge-explain">
          {describeMerge(node, targetName).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
    </FormDialog>
  );
}

function MoveFolderDialog({
  node,
  api,
  onCancel,
  onDone,
}: {
  node: NodeMeta;
  api: DashboardApi;
  onCancel(): void;
  onDone(message: string): void;
}) {
  const data = useTreeData();
  const exclude = subtreeFolderIds(data.folders[node.bankId] ?? [], node.id);
  const [place, setPlace] = useState<Place>({ bankId: node.bankId, folderId: node.parentFolderId });
  return (
    <FormDialog
      title={`Move folder “${node.name}”`}
      confirmLabel="Move"
      onCancel={onCancel}
      onSubmit={async () => {
        await api.moveFolder({
          id: node.id,
          parentFolderId: place.folderId,
          bankId: place.bankId,
        });
        onDone(`Moved “${node.name}”.`);
      }}
    >
      <PlacePicker
        value={place}
        onChange={setPlace}
        excludeFolderIds={place.bankId === node.bankId ? exclude : undefined}
        bankLabel="Move to bank"
        folderLabel="Inside folder"
      />
      <p className="sv-small sv-muted">
        Highlights filed in this folder (and its subfolders) move with it.
      </p>
    </FormDialog>
  );
}

function StyleDialog({
  node,
  api,
  onCancel,
  onDone,
}: {
  node: NodeMeta;
  api: DashboardApi;
  onCancel(): void;
  onDone(): void;
}) {
  const [color, setColor] = useState<ColorId>(node.color ?? 'blue');
  const [icon, setIcon] = useState(node.icon ?? '');
  return (
    <FormDialog
      title={`Colour and icon for “${node.name}”`}
      confirmLabel="Save"
      onCancel={onCancel}
      onSubmit={async () => {
        if (color !== node.color) await api.setBankColor(node.id, color);
        const nextIcon = icon.trim() === '' ? null : icon.trim();
        if (nextIcon !== node.icon) await api.setBankIcon(node.id, nextIcon);
        onDone();
      }}
    >
      <div className="sv-field">
        <label className="sv-label" htmlFor="bank-color">
          Colour
        </label>
        <select
          id="bank-color"
          className="sv-control"
          value={color}
          data-autofocus=""
          data-testid="bank-color"
          onChange={(e) => setColor(e.target.value as ColorId)}
        >
          {COLOR_IDS.map((c) => (
            <option key={c} value={c}>
              {colorLabel(c)}
            </option>
          ))}
        </select>
      </div>
      <div className="sv-field">
        <label className="sv-label" htmlFor="bank-icon">
          Icon (a letter, symbol or emoji; optional)
        </label>
        <input
          id="bank-icon"
          className="sv-control"
          value={icon}
          maxLength={MAX_BANK_ICON_CHARS}
          data-testid="bank-icon"
          onChange={(e) => setIcon(e.target.value)}
        />
      </div>
      <p className="sv-small">
        Preview: <span className="dash-swatch" style={{ background: COLOR_SWATCH[color].solid }} />{' '}
        <span aria-hidden="true">{icon.trim()}</span> {node.name} ({colorLabel(color)})
      </p>
    </FormDialog>
  );
}
