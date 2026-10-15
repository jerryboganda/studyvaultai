import { useEffect, useId, useRef, useState } from 'react';
import { MAX_NOTE_BODY_CHARS, type Note } from '@shared';
import { Button, truncate, useAction, useToast } from '@ui';
import { Markdown } from '@ui/vault';
import { validateNoteBody } from './model';
import { useCardMemory } from './useCardMemory';

/** The Markdown notes of one highlight (the `notes` table), rendered safely and edited in place. */

type Editing = { noteId: string | null } | null;

export function CardNotes({
  highlightId,
  sourceId,
  notes,
  onSave,
}: {
  highlightId: string;
  sourceId: string;
  /** undefined while loading; null when the details could not be read. */
  notes: readonly Note[] | null | undefined;
  onSave(input: {
    highlightId: string;
    sourceId: string;
    noteId: string | null;
    body: string;
  }): Promise<void>;
}) {
  const uid = useId();
  const { announce } = useToast();
  const [editing, setEditing] = useCardMemory<Editing>(`${highlightId}:note`, null);
  const [draft, setDraft] = useCardMemory(`${highlightId}:noteDraft`, '');
  const [problem, setProblem] = useState<string | null>(null);
  const addWrap = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(false);

  // The editor's textarea is gone: keep the keyboard on this card instead of dropping it on <body>.
  useEffect(() => {
    if (editing !== null || !restoreFocus.current) return;
    restoreFocus.current = false;
    addWrap.current?.querySelector('button')?.focus();
  }, [editing]);

  const save = useAction(async (noteId: string | null, body: string) => {
    await onSave({ highlightId, sourceId, noteId, body });
    restoreFocus.current = true;
    setEditing(null);
    setDraft('');
    announce('Note saved.');
  });

  const open = (next: Editing, body: string) => {
    setEditing(next);
    setDraft(body);
    setProblem(null);
    save.clear();
  };
  const close = () => {
    restoreFocus.current = true;
    setEditing(null);
    setDraft('');
    setProblem(null);
    save.clear();
  };
  const submit = () => {
    if (save.busy || editing === null) return;
    const invalid = validateNoteBody(draft);
    setProblem(invalid);
    if (invalid === null) void save.run(editing.noteId, draft);
  };

  return (
    <div className="sv-field" data-testid="card-notes">
      <span className="sv-label">Study notes</span>
      {notes === undefined ? (
        <span className="sv-small sv-muted">Loading notes…</span>
      ) : notes === null ? (
        <span className="sv-small sv-muted">Notes could not be read for this highlight.</span>
      ) : notes.length === 0 && editing === null ? (
        <span className="sv-small sv-muted">No notes yet.</span>
      ) : null}
      {(notes ?? []).map((n) =>
        editing !== null && editing.noteId === n.id ? null : (
          <div key={n.id} className="sp-note" data-testid="card-note">
            <Markdown source={n.body} />
            <div>
              <Button
                variant="ghost"
                aria-label={`Edit this note: ${truncate(n.body.replace(/\s+/g, ' '), 40)}`}
                onClick={() => open({ noteId: n.id }, n.body)}
              >
                Edit
              </Button>
            </div>
          </div>
        ),
      )}
      {editing !== null ? (
        <div className="sv-stack sv-stack--tight">
          <label className="sv-label" htmlFor={`${uid}-body`}>
            {editing.noteId === null ? 'New study note (Markdown)' : 'Study note (Markdown)'}
          </label>
          <textarea
            id={`${uid}-body`}
            className="sv-control"
            data-testid="note-editor"
            autoFocus
            rows={4}
            maxLength={MAX_NOTE_BODY_CHARS}
            dir="auto"
            value={draft}
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? `${uid}-problem` : undefined}
            onChange={(e) => {
              setDraft(e.target.value);
              setProblem(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                close();
              } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <div className="sv-row">
            <Button variant="primary" busy={save.busy} data-testid="note-save" onClick={submit}>
              Save note
            </Button>
            <Button onClick={close}>Cancel</Button>
          </div>
          {problem ? (
            <p id={`${uid}-problem`} role="alert" className="panel__error sv-small">
              Error: {problem}
            </p>
          ) : null}
          {save.error ? (
            <p role="alert" className="panel__error sv-small">
              Not saved: {save.error}{' '}
              {save.retryable ? (
                <Button variant="ghost" onClick={save.retry}>
                  Retry
                </Button>
              ) : null}
            </p>
          ) : null}
        </div>
      ) : (
        <div ref={addWrap}>
          <Button data-testid="note-add" onClick={() => open({ noteId: null }, '')}>
            Add a note
          </Button>
        </div>
      )}
    </div>
  );
}
