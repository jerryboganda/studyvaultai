import { uuidv7 } from 'uuidv7';
import {
  CustomFields,
  Note,
  SCHEMA_VERSION,
  Source,
  StudyVaultError,
  type CustomFields as CustomFieldsType,
  type Highlight,
} from '@shared';
import {
  cmp,
  isDeleted,
  liveHighlight,
  notNull,
  now,
  parseInput,
  parseRow,
  requireId,
  signalChange,
  touchHighlights,
} from './core';
import { withDb, withWritableDb, type StudyVaultDb } from './db';

/**
 * Notes are the user's own words (Markdown source). They point at a highlight and/or a source and
 * never touch the quote: `exactQuote` stays exactly as captured.
 */

async function liveNote(db: StudyVaultDb, id: string): Promise<Note> {
  const row = await db.notes.get(id);
  const note = row ? parseRow(Note, row, 'note') : null;
  if (!note || note.deletedAt !== null) throw new StudyVaultError('not_found', 'Note not found');
  return note;
}

export async function createNote(input: {
  highlightId?: string | null;
  sourceId?: string | null;
  title?: string;
  body: string;
  pinned?: boolean;
}): Promise<Note> {
  const highlightId = input.highlightId ?? null;
  const sourceId = input.sourceId ?? null;
  if (highlightId !== null) requireId(highlightId);
  if (sourceId !== null) requireId(sourceId);
  const title = parseInput(Note.shape.title, input.title ?? '', 'note title');
  const body = parseInput(Note.shape.body, input.body, 'note body');
  const note = await withWritableDb((db) =>
    db.transaction('rw', [db.highlights, db.sources, db.notes], async () => {
      const ts = now();
      let linkedSource = sourceId;
      if (highlightId !== null) {
        const highlight = await liveHighlight(db, highlightId);
        if (sourceId !== null && sourceId !== highlight.sourceId) {
          throw new StudyVaultError(
            'invalid_request',
            'The note is linked to a source that is not the highlight’s source',
          );
        }
        linkedSource = highlight.sourceId;
      } else if (sourceId !== null) {
        const row = await db.sources.get(sourceId);
        const source = row ? parseRow(Source, row, 'source') : null;
        if (!source || source.deletedAt !== null) {
          throw new StudyVaultError('not_found', 'Source not found');
        }
      }
      const row: Note = {
        id: uuidv7(),
        schemaVersion: SCHEMA_VERSION,
        createdAt: ts,
        updatedAt: ts,
        deletedAt: null,
        highlightId,
        sourceId: linkedSource,
        title,
        body,
        pinned: input.pinned === true,
      };
      await db.notes.put(row);
      if (highlightId !== null) await touchHighlights(db, [highlightId], ts);
      return row;
    }),
  );
  await signalChange();
  return note;
}

export async function updateNote(
  id: string,
  patch: { title?: string; body?: string; pinned?: boolean },
): Promise<Note> {
  requireId(id);
  const changes: Partial<Pick<Note, 'title' | 'body' | 'pinned'>> = {};
  if (patch.title !== undefined)
    changes.title = parseInput(Note.shape.title, patch.title, 'note title');
  if (patch.body !== undefined) changes.body = parseInput(Note.shape.body, patch.body, 'note body');
  if (patch.pinned !== undefined)
    changes.pinned = parseInput(Note.shape.pinned, patch.pinned, 'pinned');
  const { note, changed } = await withWritableDb((db) =>
    db.transaction('rw', [db.highlights, db.notes], async () => {
      const current = await liveNote(db, id);
      const differs = (Object.keys(changes) as Array<keyof typeof changes>).some(
        (k) => current[k] !== changes[k],
      );
      if (!differs) return { note: current, changed: false };
      const ts = now();
      const next: Note = { ...current, ...changes, updatedAt: ts };
      await db.notes.put(next);
      if (current.highlightId !== null) await touchHighlights(db, [current.highlightId], ts);
      return { note: next, changed: true };
    }),
  );
  if (changed) await signalChange();
  return note;
}

export async function deleteNote(id: string): Promise<void> {
  requireId(id);
  const changed = await withWritableDb((db) =>
    db.transaction('rw', [db.highlights, db.notes], async () => {
      const row = await db.notes.get(id);
      const note = row ? parseRow(Note, row, 'note') : null;
      if (!note) throw new StudyVaultError('not_found', 'Note not found');
      if (note.deletedAt !== null) return false;
      const ts = now();
      await db.notes.put({ ...note, deletedAt: ts, updatedAt: ts });
      if (note.highlightId !== null) await touchHighlights(db, [note.highlightId], ts);
      return true;
    }),
  );
  if (changed) await signalChange();
}

export async function listNotes(
  query: { highlightId?: string; sourceId?: string; pinned?: boolean; limit?: number } = {},
): Promise<Note[]> {
  const limit = Math.min(Math.max(Math.floor(query.limit ?? 500), 1), 5000);
  if (query.highlightId !== undefined) requireId(query.highlightId);
  if (query.sourceId !== undefined) requireId(query.sourceId);
  return withDb(async (db) => {
    const rows =
      query.highlightId !== undefined
        ? await db.notes.where('highlightId').equals(query.highlightId).toArray()
        : query.sourceId !== undefined
          ? await db.notes.where('sourceId').equals(query.sourceId).toArray()
          : await db.notes.toArray();
    return rows
      .filter((r) => !isDeleted(r))
      .map((r) => parseRow(Note, r, 'note'))
      .filter(notNull)
      .filter(
        (n) =>
          (query.sourceId === undefined || n.sourceId === query.sourceId) &&
          (query.pinned === undefined || n.pinned === query.pinned),
      )
      .sort(
        (a, b) =>
          Number(b.pinned) - Number(a.pinned) || cmp(b.updatedAt, a.updatedAt) || cmp(a.id, b.id),
      )
      .slice(0, limit);
  });
}

// ---------------------------------------------------------------------------------------------
// custom fields
// ---------------------------------------------------------------------------------------------

async function writeCustomFields(
  highlightId: string,
  edit: (current: CustomFieldsType) => CustomFieldsType,
): Promise<CustomFieldsType> {
  requireId(highlightId);
  const { fields, changed } = await withWritableDb((db) =>
    db.transaction('rw', db.highlights, async () => {
      const row: Highlight = await liveHighlight(db, highlightId);
      const current = row.customFields ?? {};
      const next = parseInput(CustomFields, edit({ ...current }), 'custom fields');
      const same =
        Object.keys(next).length === Object.keys(current).length &&
        Object.entries(next).every(([k, v]) => current[k] === v);
      if (same) return { fields: current, changed: false };
      await db.highlights.update(highlightId, { customFields: next, updatedAt: now() });
      return { fields: next, changed: true };
    }),
  );
  if (changed) await signalChange();
  return fields;
}

/** Merge `fields` into the highlight's custom fields (a key given again is overwritten). */
export async function setCustomFields(
  highlightId: string,
  fields: CustomFieldsType,
): Promise<CustomFieldsType> {
  // A record parser would silently drop an own "__proto__" key; refuse it instead.
  if (typeof fields === 'object' && fields !== null && Object.keys(fields).includes('__proto__')) {
    throw new StudyVaultError(
      'invalid_request',
      'Invalid custom fields: "__proto__" is not a name',
    );
  }
  const patch = parseInput(CustomFields, fields, 'custom fields');
  return writeCustomFields(highlightId, (current) => ({ ...current, ...patch }));
}

export function clearCustomField(highlightId: string, key: string): Promise<CustomFieldsType> {
  return writeCustomFields(highlightId, (current) => {
    const { [key]: _removed, ...rest } = current;
    return rest;
  });
}
