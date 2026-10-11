import { useId, useRef, type ReactNode } from 'react';
import { HIGHLIGHT_KINDS, KIND_LABELS, type HighlightKind, type ResolveStatus } from '@shared';
import { Button, describeResolveState } from '@ui';
import type { TagWithCount } from '@storage';
import {
  BROWSE_SORTS,
  EMPTY_FILTERS,
  SEARCH_SORTS,
  SORT_LABELS,
  filterCount,
  type DateField,
  type Filters,
  type SortKey,
} from './filters';
import { useDismissibleDetails } from './hooks';

const STATUSES: ResolveStatus[] = ['unchecked', 'resolved', 'changed', 'ambiguous', 'orphaned'];

function toggled<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

function Group({
  label,
  active,
  testId,
  children,
}: {
  label: string;
  active: number;
  testId: string;
  children: ReactNode;
}) {
  return (
    <details className="dash-filter" data-testid={testId}>
      <summary>
        {label}
        {active > 0 ? <span className="dash-filter__n"> ({active})</span> : null}
      </summary>
      <div className="dash-filter__body">{children}</div>
    </details>
  );
}

export function FilterBar({
  filters,
  onChange,
  tags,
  sort,
  onSort,
  searching,
  total,
}: {
  filters: Filters;
  onChange(next: Filters): void;
  tags: readonly TagWithCount[];
  sort: SortKey;
  onSort(next: SortKey): void;
  searching: boolean;
  total: number | null;
}) {
  const id = useId();
  const root = useRef<HTMLElement>(null);
  useDismissibleDetails(root);
  const set = (patch: Partial<Filters>) => onChange({ ...filters, ...patch });
  const sorts = searching ? SEARCH_SORTS : BROWSE_SORTS;
  const active = filterCount(filters);
  const tagName = (tagId: string) =>
    tags.find((t) => t.tag.id === tagId)?.tag.name ?? 'Unknown tag';

  return (
    <section ref={root} className="dash-filters" aria-label="Filters and sorting">
      <div className="sv-row">
        <Group label="Kind" active={filters.kinds.length} testId="filter-kind">
          <fieldset className="opt-fieldset">
            <legend className="sv-sr">Kinds</legend>
            {HIGHLIGHT_KINDS.map((kind) => (
              <label key={kind} className="sv-check">
                <input
                  type="checkbox"
                  checked={filters.kinds.includes(kind)}
                  onChange={() => set({ kinds: toggled<HighlightKind>(filters.kinds, kind) })}
                />
                <span>
                  <span aria-hidden="true">{KIND_LABELS[kind].glyph}</span>{' '}
                  {KIND_LABELS[kind].label}
                </span>
              </label>
            ))}
          </fieldset>
        </Group>

        <Group label="Priority" active={filters.priorities.length} testId="filter-priority">
          <fieldset className="opt-fieldset">
            <legend className="sv-sr">Priorities</legend>
            {[5, 4, 3, 2, 1].map((p) => (
              <label key={p} className="sv-check">
                <input
                  type="checkbox"
                  checked={filters.priorities.includes(p)}
                  onChange={() => set({ priorities: toggled(filters.priorities, p) })}
                />
                <span>
                  Priority {p}
                  {p === 5 ? ' (highest)' : p === 1 ? ' (lowest)' : ''}
                </span>
              </label>
            ))}
          </fieldset>
        </Group>

        <Group label="Status" active={filters.statuses.length} testId="filter-status">
          <fieldset className="opt-fieldset">
            <legend className="sv-sr">Restore status</legend>
            {STATUSES.map((s) => (
              <label key={s} className="sv-check">
                <input
                  type="checkbox"
                  checked={filters.statuses.includes(s)}
                  onChange={() => set({ statuses: toggled(filters.statuses, s) })}
                />
                <span>
                  <span aria-hidden="true">{describeResolveState(s).glyph}</span>{' '}
                  {describeResolveState(s).label}
                </span>
              </label>
            ))}
          </fieldset>
        </Group>

        <Group label="Tags" active={filters.tagIds.length} testId="filter-tags">
          {tags.length === 0 ? (
            <p className="sv-small sv-muted">No tags yet. Add tags in the preview pane.</p>
          ) : (
            <>
              <div className="sv-field">
                <label className="sv-label" htmlFor={`${id}-tagmode`}>
                  Match
                </label>
                <select
                  id={`${id}-tagmode`}
                  className="sv-control"
                  value={filters.tagMode}
                  onChange={(e) => set({ tagMode: e.target.value as 'any' | 'all' })}
                >
                  <option value="any">any of the chosen tags</option>
                  <option value="all">all of the chosen tags</option>
                </select>
              </div>
              <fieldset className="opt-fieldset dash-filter__scroll">
                <legend className="sv-sr">Tags</legend>
                {tags.map(({ tag, count }) => (
                  <label key={tag.id} className="sv-check">
                    <input
                      type="checkbox"
                      checked={filters.tagIds.includes(tag.id)}
                      onChange={() => set({ tagIds: toggled(filters.tagIds, tag.id) })}
                    />
                    <span dir="auto">
                      {tag.name} <span className="sv-muted">({count})</span>
                    </span>
                  </label>
                ))}
              </fieldset>
            </>
          )}
        </Group>

        <Group label="Note" active={filters.hasNote === null ? 0 : 1} testId="filter-note">
          <div className="sv-field">
            <label className="sv-label" htmlFor={`${id}-note`}>
              Your note
            </label>
            <select
              id={`${id}-note`}
              className="sv-control"
              value={filters.hasNote === null ? 'any' : filters.hasNote ? 'yes' : 'no'}
              onChange={(e) =>
                set({ hasNote: e.target.value === 'any' ? null : e.target.value === 'yes' })
              }
            >
              <option value="any">Either</option>
              <option value="yes">Has a note</option>
              <option value="no">Has no note</option>
            </select>
          </div>
        </Group>

        <Group
          label="Date"
          active={filters.dateFrom !== '' || filters.dateTo !== '' ? 1 : 0}
          testId="filter-date"
        >
          <div className="sv-field">
            <label className="sv-label" htmlFor={`${id}-datefield`}>
              Date to filter by
            </label>
            <select
              id={`${id}-datefield`}
              className="sv-control"
              value={filters.dateField}
              onChange={(e) => set({ dateField: e.target.value as DateField })}
            >
              <option value="capturedAt">Captured</option>
              <option value="updatedAt">Last updated</option>
            </select>
          </div>
          <div className="sv-field">
            <label className="sv-label" htmlFor={`${id}-from`}>
              From (your local date)
            </label>
            <input
              id={`${id}-from`}
              type="date"
              className="sv-control"
              value={filters.dateFrom}
              max={filters.dateTo || undefined}
              onChange={(e) => set({ dateFrom: e.target.value })}
            />
          </div>
          <div className="sv-field">
            <label className="sv-label" htmlFor={`${id}-to`}>
              Up to and including
            </label>
            <input
              id={`${id}-to`}
              type="date"
              className="sv-control"
              value={filters.dateTo}
              min={filters.dateFrom || undefined}
              onChange={(e) => set({ dateTo: e.target.value })}
            />
          </div>
        </Group>

        <div className="sv-field dash-sort">
          <label className="sv-label" htmlFor={`${id}-sort`}>
            Sort by
          </label>
          <select
            id={`${id}-sort`}
            className="sv-control"
            value={sort}
            data-testid="sort-select"
            onChange={(e) => onSort(e.target.value as SortKey)}
          >
            {sorts.map((s) => (
              <option key={s} value={s}>
                {SORT_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {active > 0 ? (
        <ul className="sv-row dash-active-filters" aria-label="Active filters">
          {filters.kinds.length > 0 ? (
            <Chip
              label={`Kind: ${filters.kinds.map((k) => KIND_LABELS[k].label).join(', ')}`}
              onRemove={() => set({ kinds: [] })}
            />
          ) : null}
          {filters.priorities.length > 0 ? (
            <Chip
              label={`Priority: ${[...filters.priorities].sort().join(', ')}`}
              onRemove={() => set({ priorities: [] })}
            />
          ) : null}
          {filters.statuses.length > 0 ? (
            <Chip
              label={`Status: ${filters.statuses.map((s) => describeResolveState(s).label).join(', ')}`}
              onRemove={() => set({ statuses: [] })}
            />
          ) : null}
          {filters.tagIds.length > 0 ? (
            <Chip
              label={`Tags (${filters.tagMode}): ${filters.tagIds.map(tagName).join(', ')}`}
              onRemove={() => set({ tagIds: [] })}
            />
          ) : null}
          {filters.hasNote !== null ? (
            <Chip
              label={filters.hasNote ? 'Has a note' : 'Has no note'}
              onRemove={() => set({ hasNote: null })}
            />
          ) : null}
          {filters.dateFrom !== '' || filters.dateTo !== '' ? (
            <Chip
              label={`${filters.dateField === 'capturedAt' ? 'Captured' : 'Updated'}: ${
                filters.dateFrom || '…'
              } to ${filters.dateTo || '…'}`}
              onRemove={() => set({ dateFrom: '', dateTo: '' })}
            />
          ) : null}
          {filters.source ? (
            <Chip
              label={`Source: ${filters.source.label}`}
              onRemove={() => set({ source: null })}
            />
          ) : null}
          <li>
            <Button
              variant="ghost"
              onClick={() => onChange(EMPTY_FILTERS)}
              data-testid="clear-filters"
            >
              Clear all filters
            </Button>
          </li>
        </ul>
      ) : null}
      {total === 0 && active > 0 && !searching ? (
        <p className="sv-small sv-muted">No highlight matches these filters.</p>
      ) : null}
    </section>
  );
}

function Chip({ label, onRemove }: { label: string; onRemove(): void }) {
  return (
    <li className="dash-chip dash-chip--active">
      <span dir="auto">{label}</span>
      <button
        type="button"
        className="dash-chip__x"
        onClick={onRemove}
        aria-label={`Remove filter ${label}`}
      >
        <span aria-hidden="true">✕</span>
      </button>
    </li>
  );
}
