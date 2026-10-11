/**
 * Multi-select model for the dashboard list (pure, unit-tested).
 *
 * Two modes: explicit (`ids` are the selected rows) and "all filtered" (every row that matches the
 * current query is selected and `ids` are the rows the user then un-ticked). The second mode is what
 * makes "select all 10,000 matching" possible without loading 10,000 rows into the page.
 */

export interface Selection {
  readonly ids: ReadonlySet<string>;
  /** True: everything matching the current query is selected except `ids`. */
  readonly allFiltered: boolean;
  /** Row that Shift+click / Shift+Arrow extend from. */
  readonly anchor: string | null;
}

export const EMPTY_SELECTION: Selection = { ids: new Set(), allFiltered: false, anchor: null };

export interface ClickModifiers {
  shift?: boolean;
  /** Ctrl on Windows/Linux, Cmd on macOS. */
  toggle?: boolean;
}

export function isSelected(sel: Selection, id: string): boolean {
  return sel.allFiltered ? !sel.ids.has(id) : sel.ids.has(id);
}

/** How many rows are selected; `totalFiltered` is the size of the whole filtered result. */
export function selectedCount(sel: Selection, totalFiltered: number): number {
  return sel.allFiltered ? Math.max(0, totalFiltered - sel.ids.size) : sel.ids.size;
}

export function isEmpty(sel: Selection, totalFiltered: number): boolean {
  return selectedCount(sel, totalFiltered) === 0;
}

function withIds(sel: Selection, ids: Set<string>, anchor: string | null): Selection {
  return { ids, allFiltered: sel.allFiltered, anchor };
}

/** Ctrl/Cmd+click and Space: flip one row, keep the rest. */
export function toggle(sel: Selection, id: string): Selection {
  const ids = new Set(sel.ids);
  if (ids.has(id)) ids.delete(id);
  else ids.add(id);
  return withIds(sel, ids, id);
}

/** Rows between `from` and `to` (inclusive) in display order. Unknown ids give an empty range. */
export function rangeBetween(order: readonly string[], from: string, to: string): string[] {
  const a = order.indexOf(from);
  const b = order.indexOf(to);
  if (a < 0 || b < 0) return [];
  return order.slice(Math.min(a, b), Math.max(a, b) + 1);
}

/**
 * A click on a row. Plain: only this row. Toggle: add/remove this row. Shift: the range from the
 * anchor (replacing the selection, or added to it together with Toggle).
 */
export function click(
  sel: Selection,
  order: readonly string[],
  id: string,
  mods: ClickModifiers = {},
): Selection {
  if (mods.shift && sel.anchor !== null && order.includes(sel.anchor)) {
    const range = rangeBetween(order, sel.anchor, id);
    if (sel.allFiltered) {
      // In all-filtered mode a range re-ticks its rows (removes them from the exclusions).
      const ids = new Set(sel.ids);
      for (const r of range) ids.delete(r);
      return withIds(sel, ids, sel.anchor);
    }
    const ids = mods.toggle ? new Set(sel.ids) : new Set<string>();
    for (const r of range) ids.add(r);
    return withIds(sel, ids, sel.anchor);
  }
  if (mods.toggle) return toggle(sel, id);
  return { ids: new Set([id]), allFiltered: false, anchor: id };
}

/** Shift+Arrow: grow or shrink the range between the anchor and the new active row. */
export function extendTo(
  sel: Selection,
  order: readonly string[],
  id: string,
  /** Where the range starts when the selection has no anchor yet (the row the cursor was on). */
  from: string | null = null,
): Selection {
  const anchor = sel.anchor ?? from ?? id;
  const range = rangeBetween(order, anchor, id);
  return { ids: new Set(range), allFiltered: false, anchor };
}

export function selectAllLoaded(order: readonly string[]): Selection {
  return { ids: new Set(order), allFiltered: false, anchor: order[0] ?? null };
}

export function selectAllFiltered(anchor: string | null = null): Selection {
  return { ids: new Set(), allFiltered: true, anchor };
}

/** Drop selected rows that no longer exist (after a delete or a refresh). Exclusions are kept. */
export function prune(sel: Selection, existing: ReadonlySet<string>): Selection {
  if (sel.allFiltered) return sel;
  const ids = new Set([...sel.ids].filter((id) => existing.has(id)));
  return ids.size === sel.ids.size
    ? sel
    : { ids, allFiltered: false, anchor: sel.anchor && ids.has(sel.anchor) ? sel.anchor : null };
}

/**
 * The ids an action applies to. `allFilteredIds` is only consulted in all-filtered mode (the caller
 * resolves the whole filtered result lazily, at action time); order of `allFilteredIds` is kept.
 */
export function resolveIds(sel: Selection, allFilteredIds: readonly string[] | null): string[] {
  if (!sel.allFiltered) return [...sel.ids];
  return (allFilteredIds ?? []).filter((id) => !sel.ids.has(id));
}
