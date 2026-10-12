import { useState, type MouseEvent } from 'react';
import { COLOR_IDS, HIGHLIGHT_KINDS, KIND_LABELS, type ColorId, type HighlightKind } from '@shared';
import { Button } from '@ui';
import { PopupMenu, type MenuItem } from '@ui/vault';

export interface BulkBarProps {
  /** Selected rows. */
  count: number;
  /** Rows the current query matches (null until known). */
  totalMatching: number | null;
  /** Everything matching is selected (not only the rows on screen). */
  allFiltered: boolean;
  busy: boolean;
  onSelectAllFiltered(): void;
  onClear(): void;
  onMove(): void;
  onTags(): void;
  onSetKind(kind: HighlightKind): void;
  onSetColor(color: ColorId): void;
  onSetPriority(priority: 1 | 2 | 3 | 4 | 5): void;
  onDelete(): void;
}

type OpenMenu = { which: 'kind' | 'color' | 'priority'; at: { x: number; y: number } } | null;

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Actions for the selected rows. Presentational: the owner decides what each one does (and asks
 * for confirmation where the effect is large). Appears only while something is selected.
 */
export function BulkBar(props: BulkBarProps) {
  const { count, totalMatching, allFiltered, busy } = props;
  const [menu, setMenu] = useState<OpenMenu>(null);
  if (count === 0) return null;

  const open = (which: 'kind' | 'color' | 'priority') => (e: MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setMenu({ which, at: { x: r.left, y: r.bottom + 4 } });
  };

  const items = (): MenuItem[] => {
    if (menu?.which === 'kind') {
      return HIGHLIGHT_KINDS.map((k) => ({
        id: k,
        label: `${KIND_LABELS[k].glyph} ${KIND_LABELS[k].label}`,
        onSelect: () => props.onSetKind(k),
      }));
    }
    if (menu?.which === 'color') {
      return COLOR_IDS.map((c) => ({
        id: c,
        label: cap(c),
        onSelect: () => props.onSetColor(c),
      }));
    }
    return ([5, 4, 3, 2, 1] as const).map((p) => ({
      id: String(p),
      label: `Priority ${p}${p === 5 ? ' (highest)' : p === 1 ? ' (lowest)' : ''}`,
      onSelect: () => props.onSetPriority(p),
    }));
  };

  const canSelectAll = !allFiltered && totalMatching !== null && totalMatching > count;

  return (
    // A named group, not role="toolbar": a toolbar promises one Tab stop and arrow keys between its
    // buttons, and this bar is ordinary buttons in the Tab order.
    <div
      className="dash-bulk"
      role="group"
      aria-label="Actions for the selected highlights"
      data-testid="bulk-bar"
    >
      <p className="dash-bulk__count" role="status" data-testid="bulk-count">
        <strong>{count.toLocaleString()}</strong> selected
        {allFiltered ? ' (everything that matches)' : ''}
      </p>
      {canSelectAll ? (
        <Button onClick={props.onSelectAllFiltered} data-testid="select-all-filtered">
          Select all {totalMatching!.toLocaleString()} matching
        </Button>
      ) : null}
      <Button busy={busy} onClick={props.onMove} data-testid="bulk-move">
        Move to…
      </Button>
      <Button busy={busy} onClick={props.onTags} data-testid="bulk-tags">
        Tags…
      </Button>
      <Button
        busy={busy}
        aria-haspopup="menu"
        aria-expanded={menu?.which === 'kind'}
        onClick={open('kind')}
        data-testid="bulk-kind"
      >
        Kind ▾
      </Button>
      <Button
        busy={busy}
        aria-haspopup="menu"
        aria-expanded={menu?.which === 'color'}
        onClick={open('color')}
        data-testid="bulk-color"
      >
        Colour ▾
      </Button>
      <Button
        busy={busy}
        aria-haspopup="menu"
        aria-expanded={menu?.which === 'priority'}
        onClick={open('priority')}
        data-testid="bulk-priority"
      >
        Priority ▾
      </Button>
      <Button variant="danger" busy={busy} onClick={props.onDelete} data-testid="bulk-delete">
        Move to trash
      </Button>
      <Button variant="ghost" onClick={props.onClear} data-testid="bulk-clear">
        Clear selection
      </Button>
      {menu ? (
        <PopupMenu
          label={
            menu.which === 'kind'
              ? 'Set kind'
              : menu.which === 'color'
                ? 'Set colour'
                : 'Set priority'
          }
          items={items()}
          at={menu.at}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  );
}
