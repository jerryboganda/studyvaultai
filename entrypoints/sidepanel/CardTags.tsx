import { useId, useState, type FormEvent } from 'react';
import { MAX_TAG_NAME_CHARS } from '@shared';
import type { TagLite } from '@storage';
import { Button, useAction, useToast } from '@ui';
import { parseTagInput } from './model';

/**
 * The tags of one highlight: chips with a remove button, and a field that adds a tag by name.
 * Suggestions come from the shared <datalist> (`listId`) the panel renders once from `listTags`.
 */
export function CardTags({
  highlightId,
  tags,
  listId,
  onAdd,
  onRemove,
}: {
  highlightId: string;
  /** undefined while loading; null when the details could not be read. */
  tags: readonly TagLite[] | null | undefined;
  listId: string;
  onAdd(highlightId: string, name: string): Promise<void>;
  onRemove(highlightId: string, tagId: string): Promise<void>;
}) {
  const uid = useId();
  const { announce } = useToast();
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const add = useAction(async (tag: string) => {
    await onAdd(highlightId, tag);
    setName('');
    announce(`Tag "${tag}" added.`);
  });
  const remove = useAction(async (tag: TagLite) => {
    await onRemove(highlightId, tag.id);
    announce(`Tag "${tag.name}" removed.`);
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (add.busy) return; // aria-disabled buttons still submit
    const parsed = parseTagInput(name);
    if ('error' in parsed) {
      setProblem(parsed.error);
      return;
    }
    setProblem(null);
    void add.run(parsed.name);
  };

  return (
    <div className="sv-field" data-testid="card-tags">
      <span className="sv-label" id={`${uid}-label`}>
        Tags
      </span>
      {tags === undefined ? (
        <span className="sv-small sv-muted">Loading tags…</span>
      ) : tags === null ? (
        <span className="sv-small sv-muted">Tags could not be read for this highlight.</span>
      ) : tags.length === 0 ? (
        <span className="sv-small sv-muted">No tags yet.</span>
      ) : (
        <ul className="sp-tags" aria-labelledby={`${uid}-label`}>
          {tags.map((t) => (
            <li key={t.id} className="sv-badge sp-tag">
              <span dir="auto" className="sv-wrap">
                {t.name}
              </span>
              <button
                type="button"
                className="sp-tag__x"
                aria-label={`Remove tag ${t.name}`}
                aria-disabled={remove.busy || undefined}
                onClick={() => {
                  if (!remove.busy) void remove.run(t);
                }}
              >
                <span aria-hidden="true">×</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="sv-stack sv-stack--tight" onSubmit={submit} noValidate>
        <label className="sv-label" htmlFor={`${uid}-add`}>
          Add a tag
        </label>
        <div className="sv-row">
          <input
            id={`${uid}-add`}
            className="sv-control sp-grow"
            type="text"
            list={listId}
            autoComplete="off"
            spellCheck={false}
            maxLength={MAX_TAG_NAME_CHARS + 20}
            dir="auto"
            value={name}
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? `${uid}-problem` : undefined}
            onChange={(e) => {
              setName(e.target.value);
              setProblem(null);
            }}
          />
          <Button type="submit" busy={add.busy}>
            Add tag
          </Button>
        </div>
      </form>
      {problem ? (
        <p id={`${uid}-problem`} role="alert" className="panel__error sv-small">
          Error: {problem}
        </p>
      ) : null}
      {add.error || remove.error ? (
        <p role="alert" className="panel__error sv-small">
          Error: {add.error ?? remove.error}
        </p>
      ) : null}
    </div>
  );
}
