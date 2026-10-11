import { useMemo, useState } from 'react';
import type { PurgeResult, TrashItem, TrashKind, TrashRef } from '@storage';
import { Button, EmptyState, InlineNotice, errorMessage, plural, useToast } from '@ui';
import { useApi } from './api';
import { ExplainDialog } from './dialogs';
import { formatDateTime } from './format';
import { useBump, useVaultQuery } from './hooks';

const KIND_LABELS: Record<TrashKind, { one: string; many: string }> = {
  highlight: { one: 'highlight', many: 'highlights' },
  note: { one: 'note', many: 'notes' },
  folder: { one: 'folder', many: 'folders' },
  bank: { one: 'bank', many: 'banks' },
  tag: { one: 'tag', many: 'tags' },
  document: { one: 'PDF document', many: 'PDF documents' },
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

type Confirm = { type: 'purge-selected' } | { type: 'empty' };

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
  const shown = filter === 'all' ? items : items.filter((i) => i.kind === filter);
  const counts = useMemo(() => {
    const out = new Map<TrashKind, number>();
    for (const i of items) out.set(i.kind, (out.get(i.kind) ?? 0) + 1);
    return out;
  }, [items]);

  const chosen = shown.filter((i) => picked.has(refKey(i)));
  const capped = [...counts.values()].some((n) => n >= LIMIT);

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

  const restoreChosen = () =>
    act(async () => {
      const r = await api.restore(chosen.map((i) => ({ kind: i.kind, id: i.id })));
      return `Restored ${plural(r.restored, 'item')}.`;
    });

  if (trash.loading)
    return (
      <p className="sv-muted dash-loading" role="status">
        Loading the trash…
      </p>
    );
  if (trash.error) {
    return (
      <InlineNotice
        tone="error"
        title="Could not read the trash"
        action={<Button onClick={trash.refresh}>Try again</Button>}
      >
        {trash.error}
      </InlineNotice>
    );
  }

  return (
    <section className="dash-panel" aria-labelledby="trash-title" data-testid="trash-view">
      <h2 id="trash-title">Trash</h2>
      <p className="sv-small sv-muted">
        Deleted items wait here. Restoring puts them back where they were; deleting permanently
        removes them, their links and (for highlights) their notes for good.
      </p>

      {outcome ? (
        <InlineNotice tone="success" live>
          <span data-testid="trash-outcome">{outcome}</span>
        </InlineNotice>
      ) : null}

      {items.length === 0 ? (
        <EmptyState title="The trash is empty">Nothing has been deleted.</EmptyState>
      ) : (
        <>
          <div className="sv-row">
            <div className="sv-field">
              <label className="sv-label" htmlFor="trash-kind">
                Show
              </label>
              <select
                id="trash-kind"
                className="sv-control"
                value={filter}
                data-testid="trash-kind"
                onChange={(e) => setFilter(e.target.value as TrashKind | 'all')}
              >
                <option value="all">Everything ({items.length.toLocaleString()})</option>
                {KINDS.filter((k) => counts.has(k)).map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABELS[k].many} ({counts.get(k)})
                  </option>
                ))}
              </select>
            </div>
            <Button
              onClick={() => setPicked(new Set(shown.map(refKey)))}
              data-testid="trash-select-all"
            >
              Select all shown
            </Button>
            <Button
              onClick={() => setPicked(new Set())}
              disabledReason={picked.size === 0 ? 'Nothing is selected.' : undefined}
            >
              Clear selection
            </Button>
          </div>

          <div className="sv-row dash-bulk" role="toolbar" aria-label="Trash actions">
            <Button
              variant="primary"
              busy={busy}
              disabledReason={chosen.length === 0 ? 'Select items to restore first.' : undefined}
              onClick={() => void restoreChosen()}
              data-testid="trash-restore"
            >
              Restore {chosen.length > 0 ? plural(chosen.length, 'item') : 'selected'}
            </Button>
            <Button
              variant="danger"
              busy={busy}
              disabledReason={chosen.length === 0 ? 'Select items to delete first.' : undefined}
              onClick={() => setConfirm({ type: 'purge-selected' })}
              data-testid="trash-purge"
            >
              Delete selected permanently…
            </Button>
            <Button
              variant="danger"
              busy={busy}
              onClick={() => setConfirm({ type: 'empty' })}
              data-testid="trash-empty"
            >
              Empty the trash…
            </Button>
          </div>

          {capped ? (
            <p className="sv-small sv-muted">
              Showing the newest {LIMIT.toLocaleString()} of a kind. Emptying the trash removes
              everything, including items not shown.
            </p>
          ) : null}

          <ul className="dash-trash-list" data-testid="trash-list">
            {shown.map((item) => (
              <li key={refKey(item)} className="dash-trash-item">
                <label className="sv-check">
                  <input
                    type="checkbox"
                    checked={picked.has(refKey(item))}
                    onChange={() => flip(item)}
                    data-testid="trash-item-check"
                  />
                  <span>
                    <span className="dash-trash-item__label sv-wrap" dir="auto">
                      {item.label}
                    </span>
                    <span className="sv-small sv-muted">
                      {KIND_LABELS[item.kind].one}
                      {item.context ? ` · ${item.context}` : ''} · deleted{' '}
                      {formatDateTime(item.deletedAt)}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </>
      )}

      {confirm?.type === 'purge-selected' ? (
        <ExplainDialog
          title={`Permanently delete ${plural(chosen.length, 'item')}?`}
          lines={[
            ...KINDS.filter((k) => chosen.some((c) => c.kind === k)).map(
              (k) =>
                `${plural(chosen.filter((c) => c.kind === k).length, KIND_LABELS[k].one, KIND_LABELS[k].many)} will be removed for good.`,
            ),
            'This cannot be undone. Notes and tags attached to deleted highlights are removed with them.',
          ]}
          confirmLabel="Delete permanently"
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            setConfirm(null);
            await act(async () =>
              summarizePurge(await api.purge(chosen.map((i) => ({ kind: i.kind, id: i.id })))),
            );
          }}
        />
      ) : null}

      {confirm?.type === 'empty' ? (
        <ExplainDialog
          title="Empty the trash?"
          lines={[
            ...KINDS.filter((k) => counts.has(k)).map(
              (k) =>
                `${(counts.get(k) ?? 0).toLocaleString()}${capped && (counts.get(k) ?? 0) >= LIMIT ? '+' : ''} ${KIND_LABELS[k].many} will be removed for good.`,
            ),
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
