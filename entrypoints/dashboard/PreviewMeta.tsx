import { useId, useState } from 'react';
import {
  MAX_CUSTOM_FIELDS,
  MAX_CUSTOM_FIELD_KEY_CHARS,
  MAX_CUSTOM_FIELD_VALUE_CHARS,
  type CustomFields,
} from '@shared';
import type { HighlightDetail } from '@storage';
import { Button, errorMessage, plural, useAction, useToast } from '@ui';
import { useApi } from './api';
import { DialogError, FormDialog, PlacePicker, type Place } from './dialogs';
import { formatDate } from './format';
import { useBump } from './hooks';
import { useTreeData } from './treeData';

// ---------------------------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------------------------

export function PreviewTags({ detail }: { detail: HighlightDetail }) {
  const api = useApi();
  const bump = useBump();
  const toast = useToast();
  const data = useTreeData();
  const listId = useId();
  const [name, setName] = useState('');
  const add = useAction(async () => {
    const wanted = name.trim();
    if (wanted === '') return;
    const key = wanted.normalize('NFKC').replace(/\s+/g, ' ').toLowerCase();
    const existing = data.tags.find(
      (t) =>
        t.tag.nameKey === key ||
        t.tag.aliases.some((a) => a.normalize('NFKC').replace(/\s+/g, ' ').toLowerCase() === key),
    );
    const tagId = existing ? existing.tag.id : (await api.createTag(wanted)).tag.id;
    await api.attachTags({ highlightIds: [detail.highlight.id], tagIds: [tagId] });
    setName('');
    bump();
  });

  const detach = async (tagId: string, tagName: string) => {
    try {
      await api.detachTags({ highlightIds: [detail.highlight.id], tagIds: [tagId] });
      bump();
      toast.push({ message: `Removed the tag ${tagName}.` });
    } catch (err) {
      toast.push({ tone: 'error', message: errorMessage(err, 'Could not remove the tag.') });
    }
  };

  const attached = new Set(detail.tags.map((t) => t.id));
  return (
    <section className="dash-section" aria-labelledby="pv-tags" data-testid="preview-tags">
      <h3 id="pv-tags">Tags</h3>
      {detail.tags.length === 0 ? (
        <p className="sv-small sv-muted">No tags.</p>
      ) : (
        <ul className="sv-row">
          {detail.tags.map((t) => (
            <li key={t.id} className="dash-chip dash-chip--active" data-testid="tag-chip">
              <span dir="auto">{t.name}</span>
              <button
                type="button"
                className="dash-chip__x"
                aria-label={`Remove tag ${t.name}`}
                onClick={() => void detach(t.id, t.name)}
              >
                <span aria-hidden="true">✕</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="sv-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (!add.busy) void add.run();
        }}
      >
        <label className="sv-sr" htmlFor={`${listId}-input`}>
          Add a tag
        </label>
        <input
          id={`${listId}-input`}
          className="sv-control dash-inline-input"
          list={listId}
          value={name}
          maxLength={50}
          placeholder="Add a tag"
          autoComplete="off"
          onChange={(e) => setName(e.target.value)}
          data-testid="tag-input"
        />
        <datalist id={listId}>
          {data.tags
            .filter((t) => !attached.has(t.tag.id))
            .map((t) => (
              <option key={t.tag.id} value={t.tag.name} />
            ))}
        </datalist>
        <Button
          type="submit"
          busy={add.busy}
          disabledReason={name.trim() === '' ? 'Type a tag name first.' : undefined}
          data-testid="tag-add"
        >
          Add tag
        </Button>
      </form>
      {add.error ? <DialogError message={add.error} /> : null}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Custom fields
// ---------------------------------------------------------------------------------------------

type FieldType = 'text' | 'number' | 'boolean';

const typeOf = (value: string | number | boolean): FieldType =>
  typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'text';

export function PreviewFields({ detail }: { detail: HighlightDetail }) {
  const api = useApi();
  const bump = useBump();
  const toast = useToast();
  const id = useId();
  const fields: CustomFields = detail.customFields;
  const entries = Object.entries(fields);
  const [key, setKey] = useState('');
  const [type, setType] = useState<FieldType>('text');
  const [value, setValue] = useState('');
  const [truth, setTruth] = useState(true);

  const parsed = (): string | number | boolean | { error: string } => {
    if (type === 'boolean') return truth;
    if (type === 'number') {
      const n = Number(value);
      return value.trim() === '' || !Number.isFinite(n)
        ? { error: 'Enter a number, such as 3 or 0.5.' }
        : n;
    }
    return value;
  };

  const save = useAction(async () => {
    const name = key.trim();
    if (name === '') throw new Error('Give the field a name.');
    const next = parsed();
    if (typeof next === 'object') throw new Error(next.error);
    await api.setCustomFields(detail.highlight.id, { ...fields, [name]: next });
    setKey('');
    setValue('');
    bump();
  });

  const clear = async (name: string) => {
    try {
      await api.setCustomFields(
        detail.highlight.id,
        Object.fromEntries(entries.filter(([k]) => k !== name)),
      );
      bump();
    } catch (err) {
      toast.push({ tone: 'error', message: errorMessage(err, 'Could not remove the field.') });
    }
  };

  const exists = Object.hasOwn(fields, key.trim());
  const full = entries.length >= MAX_CUSTOM_FIELDS && !exists;

  return (
    <section className="dash-section" aria-labelledby="pv-fields" data-testid="preview-fields">
      <h3 id="pv-fields">Custom fields</h3>
      {entries.length === 0 ? (
        <p className="sv-small sv-muted">
          No fields. Use them for your own metadata, such as “exam” or “chapter”.
        </p>
      ) : (
        <dl className="dash-fields">
          {entries.map(([k, v]) => (
            <div key={k} className="sv-row" data-testid="custom-field">
              <dt className="sv-label">{k}</dt>
              <dd className="sv-grow" dir="auto">
                {typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v)}
              </dd>
              <Button
                variant="ghost"
                aria-label={`Edit field ${k}`}
                onClick={() => {
                  setKey(k);
                  setType(typeOf(v));
                  setValue(typeof v === 'boolean' ? '' : String(v));
                  setTruth(v === true);
                }}
              >
                Edit
              </Button>
              <Button
                variant="ghost"
                aria-label={`Remove field ${k}`}
                onClick={() => void clear(k)}
              >
                Remove
              </Button>
            </div>
          ))}
        </dl>
      )}
      <form
        className="sv-stack sv-stack--tight"
        onSubmit={(e) => {
          e.preventDefault();
          if (!save.busy && !full) void save.run();
        }}
      >
        <div className="sv-row">
          <div className="sv-field dash-grow">
            <label className="sv-label" htmlFor={`${id}-key`}>
              Field name
            </label>
            <input
              id={`${id}-key`}
              className="sv-control"
              value={key}
              maxLength={MAX_CUSTOM_FIELD_KEY_CHARS}
              onChange={(e) => setKey(e.target.value)}
              data-testid="field-key"
            />
          </div>
          <div className="sv-field">
            <label className="sv-label" htmlFor={`${id}-type`}>
              Type
            </label>
            <select
              id={`${id}-type`}
              className="sv-control"
              value={type}
              onChange={(e) => setType(e.target.value as FieldType)}
              data-testid="field-type"
            >
              <option value="text">Text</option>
              <option value="number">Number</option>
              <option value="boolean">Yes / no</option>
            </select>
          </div>
          <div className="sv-field dash-grow">
            <label className="sv-label" htmlFor={`${id}-value`}>
              Value
            </label>
            {type === 'boolean' ? (
              <select
                id={`${id}-value`}
                className="sv-control"
                value={truth ? 'yes' : 'no'}
                onChange={(e) => setTruth(e.target.value === 'yes')}
              >
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
            ) : (
              <input
                id={`${id}-value`}
                className="sv-control"
                value={value}
                inputMode={type === 'number' ? 'decimal' : undefined}
                maxLength={MAX_CUSTOM_FIELD_VALUE_CHARS}
                onChange={(e) => setValue(e.target.value)}
                data-testid="field-value"
              />
            )}
          </div>
        </div>
        <div className="sv-row">
          <Button
            type="submit"
            busy={save.busy}
            disabledReason={
              full
                ? `At most ${MAX_CUSTOM_FIELDS} fields. Remove one first.`
                : key.trim() === ''
                  ? 'Give the field a name first.'
                  : undefined
            }
            data-testid="field-save"
          >
            {exists ? 'Update field' : 'Add field'}
          </Button>
        </div>
      </form>
      {save.error ? <DialogError message={save.error} /> : null}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Where it is filed
// ---------------------------------------------------------------------------------------------

type PlaceDialog = { type: 'move'; fromBankId: string; label: string } | { type: 'add' };

export function PreviewLocations({ detail }: { detail: HighlightDetail }) {
  const api = useApi();
  const bump = useBump();
  const toast = useToast();
  const data = useTreeData();
  const [dialog, setDialog] = useState<PlaceDialog | null>(null);
  const [place, setPlace] = useState<Place>({ bankId: '', folderId: null });
  const highlightId = detail.highlight.id;

  const open = (next: PlaceDialog, start?: Place) => {
    const fallback = data.banks.find((b) => !detail.locations.some((l) => l.bank.id === b.id));
    setPlace(start ?? { bankId: (fallback ?? data.banks[0])?.id ?? '', folderId: null });
    setDialog(next);
  };

  const remove = async (bankId: string, bankName: string) => {
    try {
      const r = await api.removeFromBank({ highlightId, bankId });
      bump();
      toast.push({
        message: r.rehomedToInbox
          ? `Removed from ${bankName}; it is now filed in the Inbox.`
          : `Removed from ${bankName}.`,
      });
    } catch (err) {
      toast.push({
        tone: 'error',
        message: errorMessage(err, 'Could not remove it from the bank.'),
      });
    }
  };

  return (
    <section className="dash-section" aria-labelledby="pv-where" data-testid="preview-locations">
      <h3 id="pv-where">Filed in</h3>
      <ul className="sv-stack sv-stack--tight">
        {detail.locations.map((loc) => {
          const path = [loc.bank.name, ...loc.folderPath.map((f) => f.name)].join(' › ');
          return (
            <li key={loc.bank.id} className="sv-row" data-testid="location">
              <span className="sv-grow sv-wrap" dir="auto">
                {path}
              </span>
              <Button
                variant="ghost"
                aria-label={`Move out of ${path}`}
                onClick={() =>
                  open(
                    { type: 'move', fromBankId: loc.bank.id, label: path },
                    {
                      bankId: loc.bank.id,
                      folderId: loc.folderPath.at(-1)?.id ?? null,
                    },
                  )
                }
              >
                Move…
              </Button>
              <Button
                variant="ghost"
                aria-label={`Remove from ${loc.bank.name}`}
                onClick={() => void remove(loc.bank.id, loc.bank.name)}
              >
                Remove
              </Button>
            </li>
          );
        })}
      </ul>
      <div className="sv-row">
        <Button onClick={() => open({ type: 'add' })} data-testid="file-in-another">
          File in another bank…
        </Button>
      </div>
      <p className="sv-small sv-muted">
        A highlight can live in several banks without being copied; notes and tags are shared.
      </p>

      {dialog ? (
        <FormDialog
          title={dialog.type === 'add' ? 'File in another bank' : `Move from ${dialog.label}`}
          confirmLabel={dialog.type === 'add' ? 'File here' : 'Move'}
          disabledReason={place.bankId === '' ? 'There is no bank to choose.' : undefined}
          onCancel={() => setDialog(null)}
          onSubmit={async () => {
            if (dialog.type === 'add') {
              await api.addToBank({ highlightId, bankId: place.bankId, folderId: place.folderId });
            } else {
              await api.moveHighlight({
                highlightId,
                fromBankId: dialog.fromBankId,
                toBankId: place.bankId,
                folderId: place.folderId,
              });
            }
            bump();
            setDialog(null);
          }}
        >
          <PlacePicker value={place} onChange={setPlace} />
        </FormDialog>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Duplicates
// ---------------------------------------------------------------------------------------------

export function PreviewDuplicates({
  detail,
  onOpen,
  onReview,
}: {
  detail: HighlightDetail;
  onOpen(highlightId: string): void;
  onReview(): void;
}) {
  if (detail.duplicates.length === 0) return null;
  return (
    <section className="dash-section" aria-labelledby="pv-dups" data-testid="preview-duplicates">
      <h3 id="pv-dups">Same quote elsewhere</h3>
      <p className="sv-small">
        This exact quote is saved {plural(detail.duplicates.length, 'other time')}. Nothing is
        merged automatically; you decide what to keep.
      </p>
      <ul className="sv-stack sv-stack--tight">
        {detail.duplicates.map((d) => (
          <li key={d.highlightId} className="sv-row" data-testid="duplicate-member">
            <span className="sv-grow sv-wrap sv-small" dir="auto">
              {d.sourceTitle || d.host}
              {d.pageNumber ? ` · page ${d.pageNumber}` : ''} · {formatDate(d.capturedAt)}
            </span>
            <Button variant="ghost" onClick={() => onOpen(d.highlightId)}>
              Show
            </Button>
          </li>
        ))}
      </ul>
      <Button onClick={onReview} data-testid="review-duplicates">
        Review duplicates
      </Button>
    </section>
  );
}
