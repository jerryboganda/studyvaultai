import { useCallback, useMemo, useState } from 'react';
import type { ColorId, HighlightKind, Priority } from '@shared';
import { errorMessage, useToast } from '@ui';
import { countLabel as plural } from './format';
import {
  EMPTY_SELECTION,
  resolveIds as resolveSelectionIds,
  selectAllFiltered as selectionAllFiltered,
  selectAllLoaded as selectionAllLoaded,
  selectedCount,
  selectionClick,
  selectionExtendTo,
  selectionPrune,
  selectionToggle,
  type ClickModifiers,
  type Selection,
} from '@ui/vault';
import type { DashboardApi } from './api';
import {
  needsIdSet,
  normalizeSort,
  toSearchQuery,
  type Filters,
  type Scope,
  type SearchNames,
  type SortKey,
} from './filters';
import { useBump } from './hooks';
import {
  collectBrowseIds,
  collectSearchIds,
  ID_RESOLVE_CAP,
  type ResultRow,
  type SearchLike,
} from './results';
import { useResults, type ResultsView } from './useResults';

/** Highlight id of a row (a note hit stands for the highlight it belongs to). */
export const rowId = (row: ResultRow): string => row.highlightId ?? row.key;

export type LibraryDialog =
  | { type: 'move'; ids: string[] | 'selection' }
  | { type: 'tags' }
  | { type: 'confirm-delete'; count: number };

export interface LibraryArgs {
  api: DashboardApi;
  scope: Scope;
  filters: Filters;
  sort: SortKey;
  /** The text of the search box (already debounced). */
  text: string;
  names: SearchNames;
  index: SearchLike | null;
  /** Changes when the index finished catching up: re-read search results. */
  indexVersion: number;
  /** Changes when the vault changed: re-read, keeping what is loaded. */
  dataVersion: number;
}

export interface Library extends ResultsView {
  mode: 'browse' | 'search';
  sort: SortKey;
  query: string;
  selection: Selection;
  selectedCount: number;
  activeKey: string | null;
  activeIndex: number;
  setActiveKey(key: string | null): void;
  clickRow(index: number, mods: ClickModifiers): void;
  navigate(index: number, extend: boolean): void;
  toggleRow(index: number): void;
  selectAllLoaded(): void;
  selectAllFiltered(): void;
  clearSelection(): void;
  dialog: LibraryDialog | null;
  openDialog(dialog: LibraryDialog | null): void;
  /** True while a bulk action runs. */
  busy: boolean;
  bulk: {
    /** Each resolves true when the change was saved (failures are reported in a toast). */
    setKind(kind: HighlightKind): Promise<boolean>;
    setColor(color: ColorId): Promise<boolean>;
    setPriority(priority: Priority): Promise<boolean>;
    remove(): Promise<boolean>;
    move(input: { bankId: string; folderId: string | null; fromBankId?: string }): Promise<boolean>;
    tag(input: { addTagIds: string[]; removeTagIds: string[] }): Promise<boolean>;
  };
  /** Ids of the whole filtered result (for select-all-filtered consumers and tests). */
  resolveAllIds(): Promise<string[]>;
}

export function useLibrary(args: LibraryArgs): Library {
  const { api, scope, filters, text, names, index, indexVersion, dataVersion } = args;
  const toast = useToast();
  const bump = useBump();
  const searching = text.trim() !== '';
  const mode = searching ? 'search' : 'browse';
  const sort = normalizeSort(args.sort, searching);
  const query = useMemo(
    () => (searching ? toSearchQuery(text, scope, filters, names) : ''),
    [searching, text, scope, filters, names],
  );

  const results = useResults({
    api,
    mode,
    scope,
    filters,
    sort,
    query,
    index,
    // A browse list does not depend on the search index, so its revisions do not re-read it.
    refreshOn: searching ? [dataVersion, indexVersion] : [dataVersion],
  });

  const identity = JSON.stringify([mode, scope, filters, query]);
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const [selectionIdentity, setSelectionIdentity] = useState(identity);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [dialog, openDialog] = useState<LibraryDialog | null>(null);
  const [busy, setBusy] = useState(false);

  // A different query is a different set of rows: a selection never survives it.
  let current = selection;
  if (identity !== selectionIdentity) {
    setSelectionIdentity(identity);
    setSelection(EMPTY_SELECTION);
    current = EMPTY_SELECTION;
  }

  const rows = results.rows;
  const order = useMemo(() => rows.map(rowId), [rows]);
  const loaded = results.loading ? null : order;
  // Rows that vanished (deleted elsewhere) leave the selection.
  const pruned = useMemo(
    () => (loaded ? selectionPrune(current, new Set(loaded)) : current),
    [current, loaded],
  );
  const activeIndex = activeKey === null ? -1 : order.indexOf(activeKey);

  const total = results.total ?? rows.length;
  const count = selectedCount(pruned, total);

  const clickRow = useCallback(
    (i: number, mods: ClickModifiers) => {
      const row = rows[i];
      if (!row) return;
      const id = rowId(row);
      setActiveKey(id);
      // A note that is attached to nothing can be read but not acted on.
      if (row.highlightId === null) return;
      setSelection((s) => selectionClick(s, order, id, mods));
    },
    [rows, order],
  );
  const navigate = useCallback(
    (i: number, extend: boolean) => {
      const row = rows[i];
      if (!row) return;
      const id = rowId(row);
      setActiveKey(id);
      if (extend && row.highlightId !== null) {
        // Shift+Arrow grows the range from where the keyboard was before this step.
        setSelection((s) => selectionExtendTo(s, order, id, activeKey));
      } else if (!extend) {
        // A plain step moves the anchor with the cursor and keeps what is selected.
        setSelection((s) => ({ ...s, anchor: id }));
      }
    },
    [rows, order, activeKey],
  );
  const toggleRow = useCallback(
    (i: number) => {
      const row = rows[i];
      if (!row || row.highlightId === null) return;
      setSelection((s) => selectionToggle(s, rowId(row)));
    },
    [rows],
  );

  const resolveAllIds = useCallback(async (): Promise<string[]> => {
    if (mode === 'browse') {
      const r = await collectBrowseIds(api, scope, filters, sort);
      return r.ids;
    }
    if (!index) throw new Error('The search index is not ready.');
    let idSet: Set<string> | null = null;
    if (needsIdSet(filters)) idSet = new Set((await collectBrowseIds(api, scope, filters)).ids);
    return collectSearchIds(index, query, idSet).ids;
  }, [api, scope, filters, sort, mode, index, query]);

  const selectedIds = useCallback(async (): Promise<string[]> => {
    if (!pruned.allFiltered) return resolveSelectionIds(pruned, null);
    return resolveSelectionIds(pruned, await resolveAllIds());
  }, [pruned, resolveAllIds]);

  const run = useCallback(
    async (work: (ids: string[]) => Promise<string>): Promise<boolean> => {
      setBusy(true);
      try {
        const ids = await selectedIds();
        if (ids.length === 0) {
          toast.push({ message: 'Nothing is selected.' });
          return false;
        }
        if (ids.length >= ID_RESOLVE_CAP) {
          toast.push({
            message: `Only the first ${ID_RESOLVE_CAP.toLocaleString()} matching highlights can be changed at once; repeat for the rest.`,
          });
        }
        const message = await work(ids);
        bump();
        if (message) toast.push({ message });
        return true;
      } catch (err) {
        toast.push({ tone: 'error', message: errorMessage(err, 'That change was not saved.') });
        return false;
      } finally {
        setBusy(false);
      }
    },
    [selectedIds, toast, bump],
  );

  const bulk: Library['bulk'] = useMemo(
    () => ({
      setKind: (kind) =>
        run(async (ids) => {
          const r = await api.bulkSetKind(ids, kind);
          return `Kind changed on ${plural(r.changed, 'highlight')}.`;
        }),
      setColor: (color) =>
        run(async (ids) => {
          const r = await api.bulkSetColor(ids, color);
          return `Colour changed on ${plural(r.changed, 'highlight')}.`;
        }),
      setPriority: (priority) =>
        run(async (ids) => {
          const r = await api.bulkSetPriority(ids, priority);
          return `Priority changed on ${plural(r.changed, 'highlight')}.`;
        }),
      remove: () =>
        run(async (ids) => {
          const r = await api.bulkDelete(ids);
          setSelection(EMPTY_SELECTION);
          toast.push({
            message: `Moved ${plural(r.changed, 'highlight')} to the trash.`,
            action: {
              label: 'Undo',
              onClick: () => {
                void api.bulkRestore(ids).then(
                  (back) => {
                    bump();
                    toast.push({ message: `Restored ${plural(back.changed, 'highlight')}.` });
                  },
                  (err: unknown) =>
                    toast.push({ tone: 'error', message: errorMessage(err, 'Could not restore.') }),
                );
              },
            },
            focusAction: false,
          });
          return '';
        }),
      move: (input) =>
        run(async (ids) => {
          const r = await api.bulkMove({
            highlightIds: ids,
            toBankId: input.bankId,
            folderId: input.folderId,
            ...(input.fromBankId ? { fromBankId: input.fromBankId } : {}),
          });
          return `Moved ${plural(r.changed, 'highlight')}.`;
        }),
      tag: (input) =>
        run(async (ids) => {
          const r = await api.bulkTag({
            highlightIds: ids,
            addTagIds: input.addTagIds,
            removeTagIds: input.removeTagIds,
          });
          return `Tags changed on ${plural(r.changed, 'highlight')}.`;
        }),
    }),
    [api, run, toast, bump],
  );

  return {
    ...results,
    mode,
    sort,
    query,
    selection: pruned,
    selectedCount: count,
    activeKey,
    activeIndex,
    setActiveKey,
    clickRow,
    navigate,
    toggleRow,
    selectAllLoaded: () => setSelection(selectionAllLoaded(order)),
    selectAllFiltered: () => setSelection(selectionAllFiltered(activeKey)),
    clearSelection: () => setSelection(EMPTY_SELECTION),
    dialog,
    openDialog,
    busy,
    bulk,
    resolveAllIds,
  };
}
