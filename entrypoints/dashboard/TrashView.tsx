import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  FileText,
  Folder,
  Highlighter,
  Library,
  NotebookPen,
  Tag,
  Trash,
  Trash2,
  Undo2,
  type LucideIcon,
} from 'lucide-react';
import type { PurgeResult, TrashItem, TrashKind, TrashRef } from '@storage';
import {
  BuddyEmptyState,
  ChunkyButton,
  InlineNotice,
  errorMessage,
  plural,
  truncate,
  useToast,
  type ArtTone,
} from '@ui';
import { useApi } from './api';
import { ExplainDialog } from './dialogs';
import { formatDate } from './format';
import { useBump, useVaultQuery } from './hooks';
import { Action, IconAction, Loading, ViewHead } from './moreKit';

const KIND_LABELS: Record<TrashKind, { one: string; many: string }> = {
  highlight: { one: 'highlight', many: 'highlights' },
  note: { one: 'note', many: 'notes' },
  folder: { one: 'folder', many: 'folders' },
  bank: { one: 'bank', many: 'banks' },
  tag: { one: 'tag', many: 'tags' },
  document: { one: 'PDF document', many: 'PDF documents' },
};
const KIND_ART: Record<TrashKind, { icon: LucideIcon; tone: ArtTone; pill: string }> = {
  highlight: { icon: Highlighter, tone: 'sun', pill: 'Highlights' },
  note: { icon: NotebookPen, tone: 'violet', pill: 'Notes' },
  folder: { icon: Folder, tone: 'primary', pill: 'Folders' },
  bank: { icon: Library, tone: 'primary', pill: 'Banks' },
  tag: { icon: Tag, tone: 'success', pill: 'Tags' },
  document: { icon: FileText, tone: 'danger', pill: 'PDFs' },
};
const KINDS = Object.keys(KIND_LABELS) as TrashKind[];
const LIMIT = 1000;

const refKey = (r: TrashRef) => `${r.kind}:${r.id}`;

export function summarizePurge(result: PurgeResult): string {
  const parts = KINDS.flatMap((k) => {
    const n = result.purged[k];
    return n > 0
      ? [`${n.toLocaleString()} ${n === 1 ? KIND_LABELS[k].one : KIND_LABELS[k].many}`]
      : [];
  });
  const related = Object.entries(result.related)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n.toLocaleString()} ${k}`);
  const head =
    parts.length > 0 ? `Permanently deleted ${parts.join(', ')}.` : 'Nothing was deleted.';
  return related.length > 0 ? `${head} Also removed linked rows: ${related.join(', ')}.` : head;
}

type Confirm =
  { type: 'purge-selected' } | { type: 'purge-one'; item: TrashItem } | { type: 'empty' };

/** What a permanent delete will remove, one line per kind, for the confirmation. */
function purgeLines(items: readonly TrashItem[]): string[] {
  return [
    ...KINDS.filter((k) => items.some((c) => c.kind === k)).map(
      (k) =>
        `${plural(items.filter((c) => c.kind === k).length, KIND_LABELS[k].one, KIND_LABELS[k].many)} will be removed for good.`,
    ),
    'This cannot be undone. Notes and tags attached to deleted highlights are removed with them.',
  ];
}

export function TrashView() {
  const api = useApi();
  const bump = useBump();
  const toast = useToast();
  const [filter, setFilter] = useState<TrashKind | 'all'>('all');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const trash = useVaultQuery(() => api.listTrash({ limit: LIMIT }), []);
  const items: TrashItem[] = useMemo(() => trash.data ?? [], [trash.data]);
  const counts = useMemo(() => {
    const out = new Map<TrashKind, number>();
    for (const i of items) out.set(i.kind, (out.get(i.kind) ?? 0) + 1);
    return out;
  }, [items]);
  // A kind whose last item was restored or deleted has no pill any more: show everything again.
  const kind = filter !== 'all' && !counts.has(filter) ? 'all' : filter;
  const shown = kind === 'all' ? items : items.filter((i) => i.kind === kind);

  // An item's own Restore or Delete forever removes the button that had the focus: once the item
  // has left the list, the focus moves to the same button of the item that took its place (or the
  // last one), else to the view's title. Done while the list is committed, before the page's
  // general focus rescue would send it to the whole view.
  const list = useRef<HTMLUListElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const refocus = useRef<{ key: string; at: number; testId: string } | null>(null);
  useLayoutEffect(() => {
    const want = refocus.current;
    if (!want || shown.some((i) => refKey(i) === want.key)) return;
    refocus.current = null;
    // Focus that is still somewhere on the page was put there on purpose: leave it.
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    const rows = list.current?.querySelectorAll<HTMLElement>('[data-at]') ?? [];
    const next = rows.length > 0 ? rows[Math.min(want.at, rows.length - 1)] : undefined;
    (next?.querySelector<HTMLElement>(`[data-testid="${want.testId}"]`) ?? title.current)?.focus();
  }, [shown]);
  const keepFocus = (item: TrashItem, testId: string) => {
    refocus.current = { key: refKey(item), at: shown.indexOf(item), testId };
  };

  const chosen = shown.filter((i) => picked.has(refKey(i)));
  const capped = [...counts.values()].some((n) => n >= LIMIT);
  const busyReason = busy ? 'Wait for the last change to finish.' : undefined;

  const flip = (item: TrashItem) =>
    setPicked((s) => {
      const next = new Set(s);
      const key = refKey(item);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const act = async (work: () => Promise<string>) => {
    setBusy(true);
    try {
      const message = await work();
      setOutcome(message);
      setPicked(new Set());
      bump();
      trash.refresh();
    } catch (err) {
      toast.push({ tone: 'error', message: errorMessage(err, 'That did not work.') });
    } finally {
      setBusy(false);
    }
  };

  const restore = (list: readonly TrashItem[]) =>
    act(async () => {
      const r = await api.restore(list.map((i) => ({ kind: i.kind, id: i.id })));
      return `Restored ${plural(r.restored, 'item')}.`;
    });

  const purge = (list: readonly TrashItem[]) =>
    act(async () => summarizePurge(await api.purge(list.map((i) => ({ kind: i.kind, id: i.id })))));

  const head = (actions?: ReactNode) => (
    <ViewHead
      icon={Trash}
      tone="danger"
      title="Trash"
      titleId="trash-title"
      titleRef={title}
      info="Restore puts an item back where it was. Delete forever removes it, its links and (for highlights) its notes for good."
      {...(items.length > 0
        ? {
            count: `${items.length.toLocaleString()}${capped ? '+' : ''} ${items.length === 1 ? 'item' : 'items'}`,
          }
        : {})}
    >
      {actions}
    </ViewHead>
  );

  // The title stays put while the list loads or fails, so the page does not jump.
  if (trash.loading || trash.error) {
    return (
      <section className="dash-panel mv-view" aria-labelledby="trash-title">
        {head()}
        {trash.loading ? (
          <Loading>Loading the trash…</Loading>
        ) : (
          <InlineNotice
            tone="error"
            title="Could not read the trash"
            action={
              <ChunkyButton size="sm" onClick={trash.refresh}>
                Try again
              </ChunkyButton>
            }
          >
            {trash.error}
          </InlineNotice>
        )}
      </section>
    );
  }

  return (
    <section className="dash-panel mv-view" aria-labelledby="trash-title" data-testid="trash-view">
      {head(
        items.length > 0 ? (
          <Action
            variant="danger"
            icon={Trash2}
            data-testid="trash-empty"
            disabledReason={busyReason}
            onClick={() => setConfirm({ type: 'empty' })}
          >
            Empty trash
          </Action>
        ) : null,
      )}

      {outcome ? (
        <InlineNotice tone="success" live>
          <span data-testid="trash-outcome">{outcome}</span>
        </InlineNotice>
      ) : null}

      {items.length === 0 ? (
        <BuddyEmptyState pose="sleep" title="Trash is empty" text="Nothing has been deleted." />
      ) : (
        <>
          <fieldset className="mv-seg trash-filter" data-testid="trash-kind">
            <legend className="sv-vh">Show</legend>
            {(['all', ...KINDS.filter((k) => counts.has(k))] as const).map((k) => (
              <label key={k} className="mv-seg__opt">
                <input
                  type="radio"
                  className="sv-vh"
                  name="trash-kind"
                  value={k}
                  checked={kind === k}
                  onChange={() => setFilter(k)}
                />
                <span>
                  {k === 'all' ? 'All' : KIND_ART[k].pill}{' '}
                  <span className="trash-filter__n">
                    {(k === 'all' ? items.length : (counts.get(k) ?? 0)).toLocaleString()}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>

          <div className="mv-row trash-bulk" role="group" aria-label="Trash actions">
            <label className="sv-check trash-bulk__all">
              <input
                type="checkbox"
                data-testid="trash-select-all"
                checked={shown.length > 0 && chosen.length === shown.length}
                ref={(el) => {
                  if (el) el.indeterminate = chosen.length > 0 && chosen.length < shown.length;
                }}
                onChange={() =>
                  setPicked(chosen.length === shown.length ? new Set() : new Set(shown.map(refKey)))
                }
              />
              <span>{chosen.length > 0 ? `${chosen.length} selected` : 'Select all'}</span>
            </label>
            <span className="mv-grow" />
            <Action
              size="sm"
              variant="primary"
              icon={Undo2}
              disabledReason={
                busyReason ?? (chosen.length === 0 ? 'Select items to restore first.' : undefined)
              }
              onClick={() => void restore(chosen)}
              data-testid="trash-restore"
            >
              {chosen.length > 0 ? `Restore ${plural(chosen.length, 'item')}` : 'Restore'}
            </Action>
            <Action
              size="sm"
              variant="danger"
              icon={Trash2}
              disabledReason={
                busyReason ?? (chosen.length === 0 ? 'Select items to delete first.' : undefined)
              }
              onClick={() => setConfirm({ type: 'purge-selected' })}
              data-testid="trash-purge"
            >
              Delete forever
            </Action>
          </div>

          {capped ? (
            <p className="mv-line">
              Showing the newest {LIMIT.toLocaleString()} of a kind. Empty trash removes everything.
            </p>
          ) : null}

          <ul className="mv-list trash-list" data-testid="trash-list" ref={list}>
            {shown.map((item, at) => {
              const art = KIND_ART[item.kind];
              const Icon = art.icon;
              const on = picked.has(refKey(item));
              return (
                <li
                  key={refKey(item)}
                  className="trash-item"
                  data-at={at}
                  data-on={on ? '' : undefined}
                >
                  <label className="trash-item__pick">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => flip(item)}
                      data-testid="trash-item-check"
                      aria-label={`Select ${KIND_LABELS[item.kind].one}: ${truncate(item.label, 80)}`}
                    />
                  </label>
                  <span className={`trash-item__art sv-art--${art.tone}`} aria-hidden="true">
                    <Icon strokeWidth={2.4} />
                  </span>
                  <span className="trash-item__text">
                    <span className="trash-item__label mv-wrap" dir="auto">
                      {item.label}
                    </span>
                    <span className="mv-meta">
                      {KIND_LABELS[item.kind].one}
                      {item.context ? ` · ${item.context}` : ''} · deleted{' '}
                      {formatDate(item.deletedAt)}
                    </span>
                  </span>
                  <span className="trash-item__actions">
                    <IconAction
                      icon={Undo2}
                      label={`Restore: ${truncate(item.label, 60)}`}
                      data-testid="trash-item-restore"
                      disabledReason={busyReason}
                      onClick={() => {
                        keepFocus(item, 'trash-item-restore');
                        void restore([item]);
                      }}
                    />
                    <IconAction
                      icon={Trash2}
                      className="mv-ibtn--danger"
                      label={`Delete forever: ${truncate(item.label, 60)}`}
                      tipSide="left"
                      data-testid="trash-item-purge"
                      disabledReason={busyReason}
                      onClick={() => {
                        keepFocus(item, 'trash-item-purge');
                        setConfirm({ type: 'purge-one', item });
                      }}
                    />
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {confirm?.type === 'purge-selected' || confirm?.type === 'purge-one'
        ? (() => {
            const list = confirm.type === 'purge-one' ? [confirm.item] : chosen;
            return (
              <ExplainDialog
                title={`Permanently delete ${plural(list.length, 'item')}?`}
                lines={purgeLines(list)}
                confirmLabel="Delete permanently"
                danger
                onCancel={() => {
                  refocus.current = null;
                  setConfirm(null);
                }}
                onConfirm={async () => {
                  setConfirm(null);
                  await purge(list);
                }}
              />
            );
          })()
        : null}

      {confirm?.type === 'empty' ? (
        <ExplainDialog
          title="Empty the trash?"
          lines={[
            ...KINDS.filter((k) => counts.has(k)).map((k) => {
              const n = counts.get(k) ?? 0;
              const noun = n === 1 ? KIND_LABELS[k].one : KIND_LABELS[k].many;
              return `${n.toLocaleString()}${capped && n >= LIMIT ? '+' : ''} ${noun} will be removed for good.`;
            }),
            'This cannot be undone.',
          ]}
          confirmLabel="Empty the trash"
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            setConfirm(null);
            await act(async () => summarizePurge(await api.emptyTrash()));
          }}
        />
      ) : null}
    </section>
  );
}
