import { useEffect, useId, useRef, useState } from 'react';
import type { Note } from '@shared';
import { MAX_NOTE_BODY_CHARS, MAX_NOTE_TITLE_CHARS } from '@shared';
import { Button, InfoTip, errorMessage, useAction, useToast } from '@ui';
import { Markdown } from '@ui/vault';
import { useApi } from './api';
import { DialogError } from './dialogs';
import { useBump } from './hooks';
import { formatDateTime } from './format';

/**
 * Text typed into a note that has not been saved yet, kept (in memory only) while the preview shows
 * another highlight, so moving on never silently drops a note. Cleared on save and on Cancel.
 */
const drafts = new Map<string, { title: string; body: string }>();
export const hasUnsavedNotes = () => drafts.size > 0;
/** Test hook. */
export const clearNoteDrafts = () => drafts.clear();

/**
 * The user's own Markdown notes on one highlight. They are separate records from the quote (which
 * is immutable); the body is rendered through the sanitiser in @ui/vault, never as raw HTML.
 */
export function PreviewNotes({ highlightId, notes }: { highlightId: string; notes: Note[] }) {
  const api = useApi();
  const bump = useBump();
  const toast = useToast();
  const [editing, setEditing] = useState<string | 'new' | null>(() => {
    if (drafts.has(`${highlightId}:new`)) return 'new';
    return notes.find((n) => drafts.has(`${highlightId}:${n.id}`))?.id ?? null;
  });
  // The button that opened the editor is replaced by it: focus goes into the editor, and back to
  // that button when the editor closes (a draft restored on mount takes no focus).
  const section = useRef<HTMLElement>(null);
  const [userOpened, setUserOpened] = useState(false);
  const openedFrom = useRef<string | null>(null);
  const open = (which: string | 'new') => {
    setUserOpened(true);
    openedFrom.current = which;
    setEditing(which);
  };
  const close = () => setEditing(null);
  useEffect(() => {
    const from = openedFrom.current;
    if (editing !== null || from === null) return;
    openedFrom.current = null;
    const opener = Array.from(
      section.current?.querySelectorAll<HTMLElement>('[data-opener]') ?? [],
    );
    opener.find((el) => el.dataset.opener === from)?.focus();
  }, [editing]);

  const remove = async (note: Note) => {
    try {
      await api.deleteNote(note.id);
      bump();
      toast.push({
        message: 'Note moved to the trash.',
        action: {
          label: 'Undo',
          onClick: () => {
            void api.restore([{ kind: 'note', id: note.id }]).then(
              () => bump(),
              (err: unknown) =>
                toast.push({ tone: 'error', message: errorMessage(err, 'Could not restore.') }),
            );
          },
        },
      });
    } catch (err) {
      toast.push({ tone: 'error', message: errorMessage(err, 'Could not delete the note.') });
    }
  };

  const togglePin = async (note: Note) => {
    try {
      await api.updateNote(note.id, { pinned: !note.pinned });
      bump();
    } catch (err) {
      toast.push({ tone: 'error', message: errorMessage(err, 'Could not change the note.') });
    }
  };

  return (
    <section
      ref={section}
      className="dash-section"
      aria-labelledby="pv-notes"
      data-testid="preview-notes"
    >
      <div className="sv-row">
        <h3 id="pv-notes" className="sv-grow">
          Your notes
        </h3>
        {editing === null ? (
          <Button onClick={() => open('new')} data-opener="new" data-testid="note-add">
            Add a note
          </Button>
        ) : null}
      </div>

      {editing === 'new' ? (
        <NoteEditor
          draftKey={`${highlightId}:new`}
          initial={{ title: '', body: '' }}
          saveLabel="Save note"
          focusOnMount={userOpened}
          onCancel={close}
          onSave={async (title, body) => {
            await api.createNote({ highlightId, title, body });
            bump();
            close();
          }}
        />
      ) : null}

      {notes.length === 0 && editing !== 'new' ? (
        <p className="sv-small sv-muted">No notes yet. Notes support Markdown.</p>
      ) : null}

      <ul className="sv-stack">
        {notes.map((note) => (
          <li key={note.id} className="dash-note" data-testid="note">
            {editing === note.id ? (
              <NoteEditor
                draftKey={`${highlightId}:${note.id}`}
                initial={{ title: note.title, body: note.body }}
                saveLabel="Save changes"
                focusOnMount={userOpened}
                onCancel={close}
                onSave={async (title, body) => {
                  await api.updateNote(note.id, { title, body });
                  bump();
                  close();
                }}
              />
            ) : (
              <>
                <div className="sv-row">
                  <p className="sv-grow sv-small sv-muted">
                    {note.pinned ? '📌 Pinned · ' : ''}Edited {formatDateTime(note.updatedAt)}
                  </p>
                </div>
                {note.title ? (
                  <h4 className="dash-note__title" dir="auto">
                    {note.title}
                  </h4>
                ) : null}
                <Markdown source={note.body} />
                <div className="sv-row">
                  <Button
                    onClick={() => open(note.id)}
                    data-opener={note.id}
                    data-testid="note-edit"
                  >
                    Edit
                  </Button>
                  <Button onClick={() => void togglePin(note)} aria-pressed={note.pinned}>
                    {note.pinned ? 'Unpin' : 'Pin'}
                  </Button>
                  <Button
                    variant="danger"
                    onClick={() => void remove(note)}
                    data-testid="note-delete"
                  >
                    Delete
                  </Button>
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function NoteEditor({
  draftKey,
  initial,
  saveLabel,
  focusOnMount,
  onSave,
  onCancel,
}: {
  draftKey: string;
  initial: { title: string; body: string };
  saveLabel: string;
  /** The person just asked for this editor: put the cursor in the note. */
  focusOnMount: boolean;
  onSave(title: string, body: string): Promise<void>;
  onCancel(): void;
}) {
  const id = useId();
  const bodyField = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (focusOnMount) bodyField.current?.focus();
    // Once, when the editor appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [restored] = useState(() => drafts.get(draftKey) ?? null);
  const [title, setTitle] = useState(restored?.title ?? initial.title);
  const [body, setBody] = useState(restored?.body ?? initial.body);
  const [preview, setPreview] = useState(false);
  const save = useAction(async () => {
    await onSave(title.trim(), body);
    drafts.delete(draftKey);
  });
  const empty = body.trim() === '' && title.trim() === '';
  const dirty = title !== initial.title || body !== initial.body;
  // Cancel discards the draft for good: an effect that was still pending must not write it back.
  const discarded = useRef(false);

  useEffect(() => {
    if (discarded.current) return;
    if (dirty) drafts.set(draftKey, { title, body });
    else drafts.delete(draftKey);
  }, [dirty, draftKey, title, body]);

  // Closing the tab with an unsaved note asks first.
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  return (
    <form
      className="sv-stack sv-stack--tight"
      onSubmit={(e) => {
        e.preventDefault();
        if (!empty && !save.busy) void save.run();
      }}
    >
      {restored ? (
        <p className="sv-small sv-muted" role="status" data-testid="note-draft-restored">
          Restored your unsaved text from earlier.
        </p>
      ) : null}
      <div className="sv-field">
        <label className="sv-label" htmlFor={`${id}-title`}>
          Title (optional)
        </label>
        <input
          id={`${id}-title`}
          className="sv-control"
          value={title}
          maxLength={MAX_NOTE_TITLE_CHARS}
          dir="auto"
          onChange={(e) => setTitle(e.target.value)}
          data-testid="note-title"
        />
      </div>
      <div className="sv-row">
        <label className="sv-label sv-grow" htmlFor={`${id}-body`}>
          Note (Markdown)
        </label>
        <Button variant="ghost" aria-pressed={preview} onClick={() => setPreview((v) => !v)}>
          {preview ? 'Back to editing' : 'Preview'}
        </Button>
      </div>
      {preview ? (
        <div className="dash-note__preview" data-testid="note-preview">
          {body.trim() === '' ? (
            <p className="sv-muted sv-small">Nothing to preview yet.</p>
          ) : (
            <Markdown source={body} />
          )}
        </div>
      ) : (
        <textarea
          id={`${id}-body`}
          ref={bodyField}
          className="sv-control"
          rows={6}
          maxLength={MAX_NOTE_BODY_CHARS}
          value={body}
          dir="auto"
          placeholder="Write in Markdown: **bold**, lists, > quotes, [links](https://example.com)"
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !empty && !save.busy) {
              e.preventDefault();
              void save.run();
            }
          }}
          data-testid="note-body"
        />
      )}
      <p className="sv-small sv-muted">
        Markdown works.{' '}
        <InfoTip label="About safe Markdown" side="top" align="start">
          Raw HTML is shown as text, images are not loaded, and only http(s) links are active.
        </InfoTip>
      </p>
      {save.error ? (
        <DialogError message={save.error} retry={save.retryable ? save.retry : undefined} />
      ) : null}
      <div className="sv-row">
        <Button
          type="submit"
          variant="primary"
          busy={save.busy}
          disabledReason={empty ? 'Write something first.' : undefined}
          data-testid="note-save"
        >
          {saveLabel}
        </Button>
        <Button
          onClick={() => {
            discarded.current = true;
            drafts.delete(draftKey);
            onCancel();
          }}
          data-testid="note-cancel"
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
