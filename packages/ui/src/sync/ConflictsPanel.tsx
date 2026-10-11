import { useId, useState } from 'react';
import type { ConflictRecord } from '@sync';
import { Badge } from '../Badge';
import { Button } from '../Button';
import { EmptyState, InlineNotice } from '../Notice';
import { useAction, useAsync } from '../hooks';
import { useSyncApi } from './api';
import type { ConflictDecision } from './protocol';
import { entityLabel, fieldLabel } from './labels';

/** A value as the text the user compares. Always rendered as a text node, never as markup. */
export function valueText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function Version({
  title,
  value,
  note,
  testId,
}: {
  title: string;
  value: unknown;
  note?: string;
  testId: string;
}) {
  const text = valueText(value);
  return (
    <section className="sv-sync-version" aria-label={title}>
      <h4>{title}</h4>
      {note ? <p className="sv-muted sv-small">{note}</p> : null}
      <pre className="sv-sync-text" tabIndex={0} data-testid={testId}>
        {text === '' ? '(empty)' : text}
      </pre>
    </section>
  );
}

/** Which side the item currently shows, from the clocks of the two versions (later wins). */
function winner(c: ConflictRecord): 'local' | 'remote' | null {
  const a = c.local.hlc;
  const b = c.remote.hlc;
  if (a === null || b === null || a === b) return null;
  return a > b ? 'local' : 'remote';
}

function ConflictCard({
  conflict,
  onResolved,
}: {
  conflict: ConflictRecord;
  onResolved(message: string): void;
}) {
  const api = useSyncApi();
  const titleId = useId();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(valueText(conflict.local.value));
  const resolve = useAction(async (decision: ConflictDecision, message: string) => {
    await api.resolveConflict(conflict.id, decision);
    onResolved(message);
  });

  const what = `${entityLabel(conflict.entityType)}: ${fieldLabel(conflict.field)}`;
  const shown = winner(conflict);
  const isText = conflict.kind === 'text_edit';
  const bothStrings =
    typeof conflict.local.value === 'string' && typeof conflict.remote.value === 'string';

  return (
    <li
      className="sv-sync-conflict sv-stack sv-stack--tight"
      aria-labelledby={titleId}
      data-testid={`conflict-${conflict.id}`}
    >
      <div className="sv-row">
        <h3 id={titleId}>{what}</h3>
        <Badge tone="warning">Needs your decision</Badge>
      </div>

      {isText ? (
        <>
          <p>
            This was changed on this device and on another one before either saw the other. Both
            versions are kept here until you decide; nothing has been thrown away.
            {shown === 'remote'
              ? " The item currently shows the other device's version."
              : shown === 'local'
                ? " The item currently shows this device's version."
                : ''}
          </p>
          <div className="sv-sync-versions">
            <Version
              title="This device"
              value={conflict.local.value}
              testId="conflict-local-text"
            />
            <Version
              title="The other device"
              value={conflict.remote.value}
              testId="conflict-remote-text"
            />
            <Version
              title="Before either change"
              value={conflict.base}
              note={conflict.base === null ? 'The original was not recorded.' : undefined}
              testId="conflict-base-text"
            />
          </div>

          {editing ? (
            <div className="sv-field">
              <label className="sv-label" htmlFor={`${titleId}-merge`}>
                Merged text
              </label>
              <textarea
                id={`${titleId}-merge`}
                className="sv-control"
                rows={6}
                value={draft}
                data-testid="conflict-merge-text"
                onChange={(e) => setDraft(e.target.value)}
              />
              <div className="sv-row">
                <Button
                  variant="primary"
                  busy={resolve.busy}
                  data-testid="conflict-save-merge"
                  onClick={() =>
                    void resolve.run(
                      { choice: 'custom', value: draft },
                      'Saved your merged text. It will reach your other devices.',
                    )
                  }
                >
                  Save merged text
                </Button>
                <Button onClick={() => setEditing(false)}>Cancel</Button>
              </div>
            </div>
          ) : (
            <div className="sv-row">
              <Button
                busy={resolve.busy}
                data-testid="conflict-keep-local"
                onClick={() =>
                  void resolve.run(
                    { choice: 'local' },
                    "Kept this device's version. It will reach your other devices.",
                  )
                }
              >
                Keep this device&apos;s version
              </Button>
              <Button
                busy={resolve.busy}
                data-testid="conflict-keep-remote"
                onClick={() =>
                  void resolve.run(
                    { choice: 'remote' },
                    "Kept the other device's version. It will reach your other devices.",
                  )
                }
              >
                Use the other device&apos;s version
              </Button>
              <Button
                data-testid="conflict-edit"
                disabledReason={
                  bothStrings ? undefined : 'Only text can be merged by hand; choose a version.'
                }
                onClick={() => setEditing(true)}
              >
                Edit and merge&hellip;
              </Button>
            </div>
          )}
        </>
      ) : conflict.kind === 'deleted_remotely' ? (
        <>
          <p>
            This item was deleted on another device, but you had changed it here. It was removed
            from this device; your version is kept below.
          </p>
          <Version title="Your version" value={conflict.local.value} testId="conflict-local-text" />
          <div className="sv-row">
            <Button
              variant="primary"
              busy={resolve.busy}
              data-testid="conflict-restore"
              onClick={() =>
                void resolve.run(
                  { choice: 'restore' },
                  'Restored. It will reach your other devices.',
                )
              }
            >
              Restore it
            </Button>
            <Button
              busy={resolve.busy}
              data-testid="conflict-keep-deleted"
              onClick={() => void resolve.run({ choice: 'keep_deleted' }, 'Left it deleted.')}
            >
              Let it stay deleted
            </Button>
          </div>
        </>
      ) : (
        <>
          <p>
            Another device changed this item after it was deleted here. The item stays deleted; the
            text of that change is kept below so you can copy what you need.
          </p>
          <Version
            title="Text from the other device"
            value={conflict.remote.value}
            testId="conflict-remote-text"
          />
          <div className="sv-row">
            <Button
              busy={resolve.busy}
              data-testid="conflict-dismiss"
              onClick={() => void resolve.run({ choice: 'discard' }, 'Dismissed.')}
            >
              Dismiss
            </Button>
          </div>
        </>
      )}

      {resolve.error ? (
        <InlineNotice
          tone="error"
          title="Could not apply that choice"
          action={
            resolve.retryable ? (
              <Button busy={resolve.busy} onClick={resolve.retry}>
                Retry
              </Button>
            ) : undefined
          }
        >
          {resolve.error}
        </InlineNotice>
      ) : null}
    </li>
  );
}

/**
 * Edits that were made on two devices without either seeing the other. Both texts are shown as
 * text, side by side, and stay until the user picks one or writes a merged version.
 * `refreshKey` changes when a sync run may have added conflicts.
 */
export function ConflictsPanel({ refreshKey = 0 }: { refreshKey?: number | string }) {
  const api = useSyncApi();
  const headingId = useId();
  const [said, setSaid] = useState('');
  const list = useAsync(() => api.listConflicts(), [], [refreshKey]);
  const items = list.data ?? [];

  return (
    <section
      className="sv-stack sv-stack--tight"
      aria-labelledby={headingId}
      data-testid="conflicts-panel"
    >
      <h3 id={headingId}>Conflicts{items.length > 0 ? ` (${items.length})` : ''}</h3>
      <p className="sv-muted sv-small">
        When the same text is edited on two devices at once, StudyVault keeps both versions here
        instead of silently choosing.
      </p>
      <p role="status" className="sv-sr">
        {said}
      </p>
      {list.error ? (
        <InlineNotice
          tone="error"
          title="Could not read the conflicts"
          action={<Button onClick={list.reload}>Retry</Button>}
        >
          {list.error}
        </InlineNotice>
      ) : list.loading ? (
        <p className="sv-muted">Loading&hellip;</p>
      ) : items.length === 0 ? (
        <EmptyState title="No conflicts">Nothing needs a decision.</EmptyState>
      ) : (
        <ul className="sv-stack">
          {items.map((c) => (
            <ConflictCard
              key={c.id}
              conflict={c}
              onResolved={(message) => {
                setSaid(message);
                list.refresh();
              }}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
