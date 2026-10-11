import { uuidv7 } from 'uuidv7';
import {
  ColorId,
  MAX_TAG_ALIASES,
  SCHEMA_VERSION,
  StudyVaultError,
  Tag,
  tagNameKey,
  type HighlightTag,
} from '@shared';
import {
  cmp,
  keysWhereIn,
  liveHighlight,
  notNull,
  now,
  parseInput,
  parseRow,
  requireId,
  signalChange,
  touchHighlights,
  unique,
} from './core';
import { withDb, withWritableDb, type StudyVaultDb } from './db';
import type { TagWithCount } from './types';

/**
 * Tags are user vocabulary: a name, optional aliases (other spellings that resolve to the same
 * tag) and a colour. Names and aliases are compared by `tagNameKey` and are unique among live tags.
 */

const MAX_IDS = 20_000;

const TagName = Tag.shape.name;

/** Spacing inside a name is not meaningful: runs of whitespace collapse to one space. */
const tagText = (raw: string, what: string) =>
  parseInput(TagName, typeof raw === 'string' ? raw.replace(/\s+/g, ' ') : raw, what);

async function allTags(db: StudyVaultDb): Promise<Tag[]> {
  return (await db.tags.toArray()).map((r) => parseRow(Tag, r, 'tag')).filter(notNull);
}

/** The live tag (other than `exceptId`) that already answers to `key` as a name or an alias. */
function ownerOfKey(tags: readonly Tag[], key: string, exceptId?: string): Tag | undefined {
  return tags.find(
    (t) =>
      t.deletedAt === null &&
      t.id !== exceptId &&
      (t.nameKey === key || t.aliases.some((a) => tagNameKey(a) === key)),
  );
}

function nameInUse(owner: Tag, name: string): StudyVaultError {
  return new StudyVaultError(
    'invalid_request',
    `A tag called "${owner.name}" already uses the name "${name}". Merge the tags instead.`,
  );
}

async function liveTag(db: StudyVaultDb, id: string): Promise<Tag> {
  const row = await db.tags.get(id);
  const tag = row ? parseRow(Tag, row, 'tag') : null;
  if (!tag || tag.deletedAt !== null) throw new StudyVaultError('not_found', 'Tag not found');
  return tag;
}

export async function createTag(
  name: string,
  options: { color?: ColorId | null } = {},
): Promise<{ tag: Tag; created: boolean }> {
  const clean = tagText(name, 'tag name');
  const key = tagNameKey(clean);
  const color =
    options.color === undefined ? null : parseInput(ColorId.nullable(), options.color, 'tag color');
  const result = await withWritableDb((db) =>
    db.transaction('rw', db.tags, async () => {
      const tags = await allTags(db);
      const owner = ownerOfKey(tags, key);
      if (owner) return { tag: owner, created: false };
      const ts = now();
      const trashed = tags.find((t) => t.deletedAt !== null && t.nameKey === key);
      if (trashed) {
        const revived: Tag = {
          ...trashed,
          name: clean,
          color: color ?? trashed.color,
          deletedAt: null,
          updatedAt: ts,
        };
        await db.tags.put(revived);
        return { tag: revived, created: true };
      }
      const row: Tag = {
        id: uuidv7(),
        schemaVersion: SCHEMA_VERSION,
        createdAt: ts,
        updatedAt: ts,
        deletedAt: null,
        name: clean,
        nameKey: key,
        color,
        aliases: [],
      };
      await db.tags.put(row);
      return { tag: row, created: true };
    }),
  );
  if (result.created) await signalChange();
  return result;
}

async function editTag(
  id: string,
  edit: (tag: Tag, all: Tag[]) => Partial<Tag> | null,
): Promise<Tag> {
  requireId(id);
  const { tag, changed } = await withWritableDb((db) =>
    db.transaction('rw', db.tags, async () => {
      const current = await liveTag(db, id);
      const change = edit(current, await allTags(db));
      if (change === null) return { tag: current, changed: false };
      const next: Tag = { ...current, ...change, updatedAt: now() };
      await db.tags.put(next);
      return { tag: next, changed: true };
    }),
  );
  if (changed) await signalChange();
  return tag;
}

export const renameTag = async (id: string, name: string) => {
  const clean = tagText(name, 'tag name');
  const key = tagNameKey(clean);
  return editTag(id, (tag, all) => {
    const owner = ownerOfKey(all, key, tag.id);
    if (owner) throw nameInUse(owner, clean);
    if (tag.name === clean) return null;
    // A spelling that is now the name no longer needs to be an alias.
    return {
      name: clean,
      nameKey: key,
      aliases: tag.aliases.filter((a) => tagNameKey(a) !== key),
    };
  });
};

export const setTagColor = async (id: string, color: ColorId | null) => {
  const next = parseInput(ColorId.nullable(), color, 'tag color');
  return editTag(id, (tag) => (tag.color === next ? null : { color: next }));
};

export const addAlias = async (id: string, alias: string) => {
  const clean = tagText(alias, 'tag alias');
  const key = tagNameKey(clean);
  return editTag(id, (tag, all) => {
    if (key === tag.nameKey) {
      throw new StudyVaultError('invalid_request', 'That is already the name of this tag.');
    }
    if (tag.aliases.some((a) => tagNameKey(a) === key)) return null;
    const owner = ownerOfKey(all, key, tag.id);
    if (owner) throw nameInUse(owner, clean);
    if (tag.aliases.length >= MAX_TAG_ALIASES) {
      throw new StudyVaultError(
        'invalid_request',
        `A tag can have at most ${MAX_TAG_ALIASES} aliases.`,
      );
    }
    return { aliases: [...tag.aliases, clean] };
  });
};

export const removeAlias = async (id: string, alias: string) => {
  const key = tagNameKey(tagText(alias, 'tag alias'));
  return editTag(id, (tag) => {
    const aliases = tag.aliases.filter((a) => tagNameKey(a) !== key);
    return aliases.length === tag.aliases.length ? null : { aliases };
  });
};

export async function mergeTags(input: {
  sourceId: string;
  targetId: string;
}): Promise<{ relinked: number }> {
  requireId(input.sourceId);
  requireId(input.targetId);
  if (input.sourceId === input.targetId) {
    throw new StudyVaultError('invalid_request', 'Choose two different tags to merge.');
  }
  const result = await withWritableDb((db) =>
    db.transaction('rw', [db.tags, db.highlightTags, db.highlights], async () => {
      const ts = now();
      const source = await liveTag(db, input.sourceId);
      const target = await liveTag(db, input.targetId);
      const links = await db.highlightTags.where('tagId').equals(source.id).toArray();
      let relinked = 0;
      for (const link of links) {
        if (!(await db.highlightTags.get([link.highlightId, target.id]))) {
          await db.highlightTags.put({
            highlightId: link.highlightId,
            tagId: target.id,
            addedAt: link.addedAt,
          });
          relinked++;
        }
        await db.highlightTags.delete([link.highlightId, source.id]);
      }
      await touchHighlights(
        db,
        links.map((l) => l.highlightId),
        ts,
      );
      // The old name and aliases keep resolving to the surviving tag.
      const aliases = [...target.aliases];
      for (const spelling of [source.name, ...source.aliases]) {
        const key = tagNameKey(spelling);
        if (
          aliases.length < MAX_TAG_ALIASES &&
          key !== target.nameKey &&
          !aliases.some((a) => tagNameKey(a) === key)
        ) {
          aliases.push(spelling);
        }
      }
      await db.tags.put({ ...target, aliases, updatedAt: ts });
      await db.tags.put({ ...source, deletedAt: ts, updatedAt: ts });
      return { relinked };
    }),
  );
  await signalChange();
  return result;
}

export async function deleteTag(id: string): Promise<void> {
  requireId(id);
  await withWritableDb((db) =>
    db.transaction('rw', db.tags, async () => {
      const tag = await liveTag(db, id);
      const ts = now();
      // Links stay (restoring the tag restores them); readers only follow links to live tags.
      await db.tags.put({ ...tag, deletedAt: ts, updatedAt: ts });
    }),
  );
  await signalChange();
}

// ---------------------------------------------------------------------------------------------
// links
// ---------------------------------------------------------------------------------------------

/** Inside a rw transaction over tags, highlightTags, highlights. */
export async function linkTags(
  db: StudyVaultDb,
  highlightIds: readonly string[],
  tagIds: readonly string[],
  ts: string,
): Promise<{ linked: number; touched: string[] }> {
  let linked = 0;
  const touched: string[] = [];
  for (const highlightId of highlightIds) {
    let any = false;
    for (const tagId of tagIds) {
      if (await db.highlightTags.get([highlightId, tagId])) continue;
      const link: HighlightTag = { highlightId, tagId, addedAt: ts };
      await db.highlightTags.put(link);
      linked++;
      any = true;
    }
    if (any) touched.push(highlightId);
  }
  await touchHighlights(db, touched, ts);
  return { linked, touched };
}

export async function unlinkTags(
  db: StudyVaultDb,
  highlightIds: readonly string[],
  tagIds: readonly string[],
  ts: string,
): Promise<{ unlinked: number; touched: string[] }> {
  let unlinked = 0;
  const touched: string[] = [];
  for (const highlightId of highlightIds) {
    let any = false;
    for (const tagId of tagIds) {
      if (!(await db.highlightTags.get([highlightId, tagId]))) continue;
      await db.highlightTags.delete([highlightId, tagId]);
      unlinked++;
      any = true;
    }
    if (any) touched.push(highlightId);
  }
  await touchHighlights(db, touched, ts);
  return { unlinked, touched };
}

/** Every id must be a live tag, or the call fails before anything is written. */
export async function assertLiveTags(db: StudyVaultDb, tagIds: readonly string[]): Promise<void> {
  for (const id of tagIds) await liveTag(db, id);
}

function idList(ids: string[], what: string): string[] {
  const out = unique(ids.map(requireId));
  if (out.length > MAX_IDS) {
    throw new StudyVaultError('invalid_request', `At most ${MAX_IDS} ${what} per call.`);
  }
  return out;
}

export async function attachTags(input: {
  highlightIds: string[];
  tagIds: string[];
}): Promise<{ linked: number }> {
  const highlightIds = idList(input.highlightIds, 'highlights');
  const tagIds = idList(input.tagIds, 'tags');
  if (highlightIds.length === 0 || tagIds.length === 0) return { linked: 0 };
  const result = await withWritableDb((db) =>
    db.transaction('rw', [db.tags, db.highlightTags, db.highlights], async () => {
      await assertLiveTags(db, tagIds);
      for (const id of highlightIds) await liveHighlight(db, id);
      return linkTags(db, highlightIds, tagIds, now());
    }),
  );
  if (result.linked > 0) await signalChange();
  return { linked: result.linked };
}

export async function detachTags(input: {
  highlightIds: string[];
  tagIds: string[];
}): Promise<{ unlinked: number }> {
  const highlightIds = idList(input.highlightIds, 'highlights');
  const tagIds = idList(input.tagIds, 'tags');
  if (highlightIds.length === 0 || tagIds.length === 0) return { unlinked: 0 };
  const result = await withWritableDb((db) =>
    db.transaction('rw', [db.highlightTags, db.highlights], async () => {
      return unlinkTags(db, highlightIds, tagIds, now());
    }),
  );
  if (result.unlinked > 0) await signalChange();
  return { unlinked: result.unlinked };
}

export async function listTags(): Promise<TagWithCount[]> {
  return withDb((db) =>
    db.transaction('r', [db.tags, db.highlightTags, db.highlights], async () => {
      const tags = (await allTags(db)).filter((t) => t.deletedAt === null);
      if (tags.length === 0) return [];
      // Index counts include links of trashed highlights; those are looked up and subtracted.
      const trashed = (await db.highlights.where('deletedAt').above('').primaryKeys()) as string[];
      // Keys only: a link's primary key is [highlightId, tagId].
      const trashedLinks = (await keysWhereIn(db.highlightTags, 'highlightId', trashed)) as Array<
        [string, string]
      >;
      // Counted once per tag, not by filtering every trashed link for every tag.
      const trashedWith = new Map<string, number>();
      for (const [, tagId] of trashedLinks)
        trashedWith.set(tagId, (trashedWith.get(tagId) ?? 0) + 1);
      const out: TagWithCount[] = [];
      for (const tag of tags) {
        const all = await db.highlightTags.where('tagId').equals(tag.id).count();
        out.push({ tag, count: Math.max(0, all - (trashedWith.get(tag.id) ?? 0)) });
      }
      return out.sort((a, b) => cmp(a.tag.nameKey, b.tag.nameKey) || cmp(a.tag.id, b.tag.id));
    }),
  );
}
