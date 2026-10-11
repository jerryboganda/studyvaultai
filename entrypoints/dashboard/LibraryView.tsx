import { useId, useState, type KeyboardEvent, type Ref } from 'react';
import { Button, EmptyState, InlineNotice } from '@ui';
import { countLabel as plural } from './format';
import { VirtualList } from '@ui/vault';
import type { TagWithCount } from '@storage';
import { BulkBar } from './BulkBar';
import { ExplainDialog, FormDialog, PlacePicker, type Place } from './dialogs';
import { FilterBar } from './FilterBar';
import { filterCount, type Filters, type Scope, type SortKey } from './filters';
import { rowId, type Library } from './library';
import { ResultRowView } from './ResultRow';
import { useBump } from './hooks';
import { useApi } from './api';
import { useTreeData } from './treeData';

/** Rows above this many ask before moving to the trash (the trash is recoverable, so it is generous). */
export const CONFIRM_DELETE_ABOVE = 25;
export const ROW_HEIGHT = { comfortable: 132, compact: 100 } as const;

export function LibraryView({
  lib,
  filters,
  onFilters,
  sort,
  onSort,
  scope,
  density,
  listRef,
  onOpenPreview,
  queryText,
  onClearQuery,
}: {
  lib: Library;
  filters: Filters;
  onFilters(next: Filters): void;
  sort: SortKey;
  onSort(next: SortKey): void;
  scope: Scope;
  density: 'comfortable' | 'compact';
  listRef: Ref<HTMLDivElement>;
  /** Enter on a row: move keyboard focus to the preview. */
  onOpenPreview(): void;
  queryText: string;
  onClearQuery(): void;
}) {
  const data = useTreeData();
  const bump = useBump();
  const descId = useId();
  const searching = lib.mode === 'search';
  const total = lib.total;

  const requestDelete = () => {
    if (lib.selectedCount === 0) return;
    if (lib.selection.allFiltered || lib.selectedCount > CONFIRM_DELETE_ABOVE) {
      lib.openDialog({ type: 'confirm-delete', count: lib.selectedCount });
    } else void lib.bulk.remove();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      lib.selectAllLoaded();
    } else if (e.key === 'Delete' && !mod && !e.altKey) {
      e.preventDefault();
      requestDelete();
    } else if (e.key === 'Escape' && lib.selectedCount > 0) {
      e.preventDefault();
      lib.clearSelection();
    }
  };

  const body = () => {
    if (lib.waitingForIndex) {
      return (
        <EmptyState title="The search index is not ready yet">
          Search needs the index. Clear the search box to keep browsing while it finishes.
        </EmptyState>
      );
    }
    if (lib.error && lib.rows.length === 0) {
      return (
        <InlineNotice
          tone="error"
          title="Could not load your highlights"
          action={<Button onClick={bump}>Try again</Button>}
        >
          {lib.error}
        </InlineNotice>
      );
    }
    if (lib.loading) {
      return (
        <p className="sv-muted dash-loading" role="status" data-testid="list-loading">
          Loading highlights…
        </p>
      );
    }
    if (lib.rows.length === 0) {
      const narrowed = filterCount(filters) > 0 || scope.bankId !== null;
      if (searching) {
        return (
          <EmptyState
            title={`No results for “${queryText.trim()}”`}
            action={<Button onClick={onClearQuery}>Clear the search</Button>}
          >
            Check the spelling, remove a filter such as <code>bank:</code> or <code>tag:</code>, or
            open “Syntax help” for what the search understands.
          </EmptyState>
        );
      }
      return narrowed ? (
        <EmptyState title="No highlights match these filters">
          Try another bank or folder, or clear the filters.
        </EmptyState>
      ) : (
        <EmptyState title="Your vault is empty">
          Select text on any page and save it with the selection toolbar, or open a PDF in the
          reader. Saved highlights appear here.
        </EmptyState>
      );
    }
    return (
      <VirtualList
        ref={listRef}
        label={searching ? 'Search results' : 'Highlights'}
        count={lib.rows.length}
        setSize={total ?? undefined}
        rowHeight={ROW_HEIGHT[density]}
        rowKey={(i) => rowId(lib.rows[i]!)}
        activeIndex={lib.activeIndex}
        isSelected={(i) => {
          const row = lib.rows[i];
          if (!row) return false;
          const id = rowId(row);
          return lib.selection.allFiltered
            ? row.highlightId !== null && !lib.selection.ids.has(id)
            : lib.selection.ids.has(id);
        }}
        renderRow={(i) => <ResultRowView row={lib.rows[i]!} />}
        onNavigate={lib.navigate}
        onToggle={lib.toggleRow}
        onActivate={(i) => {
          const row = lib.rows[i];
          if (row) lib.setActiveKey(rowId(row));
          onOpenPreview();
        }}
        onRowClick={(i, e) => {
          const onCheck = (e.target as HTMLElement).closest('[data-check]') !== null;
          lib.clickRow(i, {
            shift: e.shiftKey,
            toggle: e.ctrlKey || e.metaKey || onCheck,
          });
        }}
        onKeyDown={onKeyDown}
        onNearEnd={lib.loadMore}
        aria-describedby={descId}
      />
    );
  };

  return (
    <div className="dash-library">
      <FilterBar
        filters={filters}
        onChange={onFilters}
        tags={data.tags as TagWithCount[]}
        sort={sort}
        onSort={onSort}
        searching={searching}
        total={total}
      />

      <p id={descId} className="sv-small sv-muted dash-summary" data-testid="result-summary">
        {lib.loading || lib.waitingForIndex
          ? ' '
          : total !== null
            ? `${plural(total, searching ? 'result' : 'highlight')}${
                lib.rows.length < total ? `, ${lib.rows.length.toLocaleString()} loaded` : ''
              }`
            : `${lib.rows.length.toLocaleString()} loaded`}
        {lib.loadingMore ? ' · loading more…' : ''}
        {' · Space selects, Ctrl+A selects all loaded rows'}
      </p>

      <BulkBar
        count={lib.selectedCount}
        totalMatching={total}
        allFiltered={lib.selection.allFiltered}
        busy={lib.busy}
        onSelectAllFiltered={lib.selectAllFiltered}
        onClear={lib.clearSelection}
        onMove={() => lib.openDialog({ type: 'move', ids: 'selection' })}
        onTags={() => lib.openDialog({ type: 'tags' })}
        onSetKind={(k) => void lib.bulk.setKind(k)}
        onSetColor={(c) => void lib.bulk.setColor(c)}
        onSetPriority={(p) => void lib.bulk.setPriority(p)}
        onDelete={requestDelete}
      />

      <div className="dash-list">{body()}</div>

      {lib.dialog?.type === 'move' ? (
        <MoveSelectionDialog lib={lib} scopeBankId={scope.bankId} />
      ) : null}
      {lib.dialog?.type === 'tags' ? <TagSelectionDialog lib={lib} /> : null}
      {lib.dialog?.type === 'confirm-delete' ? (
        <ExplainDialog
          title={`Move ${plural(lib.dialog.count, 'highlight')} to the trash?`}
          lines={[
            `${plural(lib.dialog.count, 'highlight')} leave their banks and go to the Trash.`,
            'Your quotes and notes are kept there; restore them any time from the Trash view.',
          ]}
          confirmLabel="Move to trash"
          danger
          onCancel={() => lib.openDialog(null)}
          onConfirm={async () => {
            const ok = await lib.bulk.remove();
            if (ok) lib.openDialog(null);
          }}
        />
      ) : null}
    </div>
  );
}

function MoveSelectionDialog({ lib, scopeBankId }: { lib: Library; scopeBankId: string | null }) {
  const data = useTreeData();
  const first = data.banks.find((b) => b.id !== scopeBankId) ?? data.banks[0];
  const [place, setPlace] = useState<Place>({ bankId: first?.id ?? '', folderId: null });
  const [mode, setMode] = useState<'from-here' | 'only-here'>(
    scopeBankId ? 'from-here' : 'only-here',
  );
  const target = data.banks.find((b) => b.id === place.bankId);
  return (
    <FormDialog
      title={`Move ${plural(lib.selectedCount, 'highlight')}`}
      confirmLabel="Move"
      disabledReason={target ? undefined : 'There is no bank to move to.'}
      onCancel={() => lib.openDialog(null)}
      onSubmit={async () => {
        const ok = await lib.bulk.move({
          bankId: place.bankId,
          folderId: place.folderId,
          ...(mode === 'from-here' && scopeBankId ? { fromBankId: scopeBankId } : {}),
        });
        if (ok) lib.openDialog(null);
      }}
      testId="move-dialog"
    >
      <PlacePicker
        value={place}
        onChange={setPlace}
        bankLabel="Move to bank"
        folderLabel="Folder"
      />
      <fieldset className="opt-fieldset">
        <legend className="sv-label">How</legend>
        {scopeBankId ? (
          <label className="sv-check">
            <input
              type="radio"
              name="move-mode"
              checked={mode === 'from-here'}
              onChange={() => setMode('from-here')}
            />
            <span>
              Take them out of the bank you are viewing (they keep any other banks they are in)
            </span>
          </label>
        ) : null}
        <label className="sv-check">
          <input
            type="radio"
            name="move-mode"
            checked={mode === 'only-here'}
            onChange={() => setMode('only-here')}
          />
          <span>File them only in the new place (removed from every other bank)</span>
        </label>
      </fieldset>
    </FormDialog>
  );
}

function TagSelectionDialog({ lib }: { lib: Library }) {
  const api = useApi();
  const data = useTreeData();
  const [add, setAdd] = useState<Set<string>>(new Set());
  const [remove, setRemove] = useState<Set<string>>(new Set());
  const [newName, setNewName] = useState('');
  const flip = (set: Set<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };
  const nothing = add.size === 0 && remove.size === 0 && newName.trim() === '';
  return (
    <FormDialog
      title={`Tags for ${plural(lib.selectedCount, 'highlight')}`}
      confirmLabel="Apply"
      wide
      disabledReason={nothing ? 'Choose tags to add or remove first.' : undefined}
      onCancel={() => lib.openDialog(null)}
      onSubmit={async () => {
        const addIds = [...add];
        const name = newName.trim();
        if (name) addIds.push((await api.createTag(name)).tag.id);
        const ok = await lib.bulk.tag({
          addTagIds: addIds,
          removeTagIds: [...remove].filter((id) => !addIds.includes(id)),
        });
        if (ok) lib.openDialog(null);
      }}
      testId="tags-dialog"
    >
      <div className="sv-field">
        <label className="sv-label" htmlFor="bulk-new-tag">
          New tag to add
        </label>
        <input
          id="bulk-new-tag"
          className="sv-control"
          data-autofocus=""
          value={newName}
          maxLength={50}
          onChange={(e) => setNewName(e.target.value)}
          data-testid="bulk-new-tag"
        />
      </div>
      <div className="dash-two-col">
        <fieldset className="opt-fieldset dash-filter__scroll">
          <legend className="sv-label">Add these tags</legend>
          {data.tags.length === 0 ? <p className="sv-small sv-muted">No tags yet.</p> : null}
          {data.tags.map(({ tag }) => (
            <label key={tag.id} className="sv-check">
              <input
                type="checkbox"
                checked={add.has(tag.id)}
                onChange={() => setAdd((s) => flip(s, tag.id))}
                data-testid="bulk-add-tag"
              />
              <span dir="auto">{tag.name}</span>
            </label>
          ))}
        </fieldset>
        <fieldset className="opt-fieldset dash-filter__scroll">
          <legend className="sv-label">Remove these tags</legend>
          {data.tags.map(({ tag }) => (
            <label key={tag.id} className="sv-check">
              <input
                type="checkbox"
                checked={remove.has(tag.id)}
                onChange={() => setRemove((s) => flip(s, tag.id))}
                data-testid="bulk-remove-tag"
              />
              <span dir="auto">{tag.name}</span>
            </label>
          ))}
        </fieldset>
      </div>
    </FormDialog>
  );
}
