import {
  COLOR_IDS,
  HIGHLIGHT_KINDS,
  MAX_FOLDER_DEPTH,
  SCHEMA_VERSION,
  type Folder,
  type Highlight,
  type HighlightBank,
  type HighlightTag,
  type Note,
  type BankRecord,
  type Source,
  type Tag,
} from '@shared';
import type { StudyVaultDb } from './db';

/**
 * Deterministic workload generator for tests and the performance suite (never imported by
 * production code). Rows are written straight into IndexedDB in bulk: it measures the read paths,
 * not the capture path. The same options always produce the same database.
 */

export interface SeedOptions {
  highlights: number;
  /** Banks besides the Inbox. Default 12. */
  banks?: number;
  /** Folders per bank, nested up to `folderDepth`. Default 20 / 4. */
  foldersPerBank?: number;
  folderDepth?: number;
  tags?: number;
  sources?: number;
  /** Every n-th highlight gets a note. Default 10. */
  noteEvery?: number;
  /** Every n-th highlight is soft-deleted. Default 50. */
  trashEvery?: number;
  seed?: number;
}

export interface SeedSummary {
  highlightIds: string[];
  bankIds: string[];
  folderIds: string[];
  tagIds: string[];
  sourceIds: string[];
  liveHighlights: number;
}

/** mulberry32: tiny seeded PRNG. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (n: number, width: number) => String(n).padStart(width, '0');
/** Sortable, unique ids that satisfy the Id schema. */
export const seedId = (prefix: string, n: number) => `${prefix}-${pad(n, 8)}`;
/** 64 hex characters, unique per `n` (stands in for the SHA-256 of the quote). */
const fakeHash = (n: number) => pad(n, 64).replace(/0/g, 'a');

const BASE_TIME = Date.parse('2026-01-01T00:00:00.000Z');
const iso = (offsetMinutes: number) => new Date(BASE_TIME + offsetMinutes * 60_000).toISOString();

async function putAll<T>(
  table: { bulkPut(rows: T[]): Promise<unknown> },
  rows: T[],
): Promise<void> {
  for (let i = 0; i < rows.length; i += 2000) await table.bulkPut(rows.slice(i, i + 2000));
}

export async function seedVault(db: StudyVaultDb, options: SeedOptions): Promise<SeedSummary> {
  const random = rng(options.seed ?? 20261011);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
  const bankCount = options.banks ?? 12;
  const perBank = options.foldersPerBank ?? 20;
  const depth = Math.max(1, Math.min(options.folderDepth ?? 4, MAX_FOLDER_DEPTH));
  const tagCount = options.tags ?? 40;
  const sourceCount = options.sources ?? Math.max(1, Math.ceil(options.highlights / 50));
  const noteEvery = options.noteEvery ?? 10;
  const trashEvery = options.trashEvery ?? 50;

  const created = iso(0);
  const banks: BankRecord[] = [
    {
      id: 'inbox-default',
      schemaVersion: SCHEMA_VERSION,
      createdAt: created,
      updatedAt: created,
      deletedAt: null,
      name: 'Inbox',
      color: 'blue',
      position: 0,
      isInbox: true,
    },
  ];
  for (let b = 1; b <= bankCount; b++) {
    banks.push({
      id: seedId('bank', b),
      schemaVersion: SCHEMA_VERSION,
      createdAt: created,
      updatedAt: created,
      deletedAt: null,
      name: `Bank ${b}`,
      color: COLOR_IDS[b % COLOR_IDS.length]!,
      position: b,
      isInbox: false,
    });
  }

  // Folders: each bank gets `perBank` folders, every folder under an earlier one of the same bank
  // (or the root) so depth never exceeds `depth`.
  const folders: Folder[] = [];
  const folderDepthOf = new Map<string, number>();
  const foldersOfBank = new Map<string, Folder[]>();
  let folderSeq = 0;
  for (const bank of banks.slice(1)) {
    const own: Folder[] = [];
    for (let f = 0; f < perBank; f++) {
      folderSeq++;
      const candidates = own.filter((p) => (folderDepthOf.get(p.id) ?? 1) < depth);
      const parent = candidates.length > 0 && random() < 0.7 ? pick(candidates) : null;
      const folder: Folder = {
        id: seedId('folder', folderSeq),
        schemaVersion: SCHEMA_VERSION,
        createdAt: created,
        updatedAt: created,
        deletedAt: null,
        bankId: bank.id,
        parentFolderId: parent?.id ?? null,
        name: `Topic ${folderSeq}`,
        position: f + 1,
      };
      folderDepthOf.set(folder.id, parent ? (folderDepthOf.get(parent.id) ?? 1) + 1 : 1);
      own.push(folder);
      folders.push(folder);
    }
    foldersOfBank.set(bank.id, own);
  }

  const tags: Tag[] = [];
  for (let t = 1; t <= tagCount; t++) {
    tags.push({
      id: seedId('tag', t),
      schemaVersion: SCHEMA_VERSION,
      createdAt: created,
      updatedAt: created,
      deletedAt: null,
      name: `tag${t}`,
      nameKey: `tag${t}`,
      color: null,
      aliases: [],
    });
  }

  const sources: Source[] = [];
  for (let s = 1; s <= sourceCount; s++) {
    const url = `https://example.org/article/${s}`;
    sources.push({
      id: seedId('src', s),
      schemaVersion: SCHEMA_VERSION,
      createdAt: created,
      updatedAt: created,
      deletedAt: null,
      type: 'web',
      urlKey: url,
      visitedKey: url,
      originalUrl: url,
      canonicalUrl: null,
      host: 'example.org',
      title: `Article ${s}`,
    });
  }

  const highlights: Highlight[] = [];
  const memberships: HighlightBank[] = [];
  const links: HighlightTag[] = [];
  const notes: Note[] = [];
  const priorities = [1, 2, 3, 4, 5] as const;
  const statuses = ['unchecked', 'resolved', 'changed', 'ambiguous', 'orphaned'] as const;
  let live = 0;
  for (let i = 1; i <= options.highlights; i++) {
    const source = sources[(i - 1) % sources.length]!;
    const capturedAt = iso(i);
    const quote = `Seeded fact number ${i} about topic ${i % 97}.`;
    const trashed = trashEvery > 0 && i % trashEvery === 0;
    if (!trashed) live++;
    highlights.push({
      id: seedId('hl', i),
      schemaVersion: SCHEMA_VERSION,
      createdAt: capturedAt,
      updatedAt: capturedAt,
      deletedAt: trashed ? iso(i + 5) : null,
      sourceId: source.id,
      exactQuote: quote,
      normalizedQuote: quote.toLowerCase(),
      quoteHash: fakeHash(i),
      anchorSet: {
        type: 'html',
        textAlgorithm: 'sv-text-v1',
        textQuote: { exact: quote, prefix: 'before ', suffix: ' after' },
        textPosition: { start: i * 10, end: i * 10 + quote.length },
        structuralPath: null,
        contentSignature: 'seed',
        documentTextLength: options.highlights * 10 + 100,
      },
      kind: pick(HIGHLIGHT_KINDS),
      color: pick(COLOR_IDS),
      priority: pick(priorities),
      userComment: i % 7 === 0 ? `Comment ${i}` : '',
      headingContext: i % 5 === 0 ? `Heading ${i % 11}` : null,
      captureMethod: 'toolbar',
      capturedAt,
      resolveStatus: pick(statuses),
      resolveConfidence: null,
      lastResolvedAt: null,
      capturedUrl: source.originalUrl,
      capturedTitle: source.title,
    });
    // Memberships: one primary bank (a folder of it two times in three), a second bank now and then.
    const first = banks[1 + (i % bankCount)] ?? banks[0]!;
    const ownFolders = foldersOfBank.get(first.id) ?? [];
    memberships.push({
      highlightId: seedId('hl', i),
      bankId: first.id,
      folderId: ownFolders.length > 0 && random() < 0.66 ? pick(ownFolders).id : null,
      addedAt: capturedAt,
    });
    if (i % 9 === 0) {
      const second = banks[(i % (bankCount + 1)) % banks.length]!;
      if (second.id !== first.id) {
        memberships.push({
          highlightId: seedId('hl', i),
          bankId: second.id,
          folderId: null,
          addedAt: capturedAt,
        });
      }
    }
    const tagTotal = tagCount === 0 ? 0 : Math.floor(random() * 3);
    const used = new Set<string>();
    for (let k = 0; k < tagTotal; k++) {
      const tag = pick(tags);
      if (used.has(tag.id)) continue;
      used.add(tag.id);
      links.push({ highlightId: seedId('hl', i), tagId: tag.id, addedAt: capturedAt });
    }
    if (noteEvery > 0 && i % noteEvery === 0) {
      notes.push({
        id: seedId('note', i),
        schemaVersion: SCHEMA_VERSION,
        createdAt: capturedAt,
        updatedAt: capturedAt,
        deletedAt: null,
        highlightId: seedId('hl', i),
        sourceId: source.id,
        title: '',
        body: `My note on fact ${i}`,
        pinned: false,
      });
    }
  }

  await putAll(db.banks, banks);
  await putAll(db.folders, folders);
  await putAll(db.tags, tags);
  await putAll(db.sources, sources);
  await putAll(db.highlights, highlights);
  await putAll(db.highlightBanks, memberships);
  await putAll(db.highlightTags, links);
  await putAll(db.notes, notes);

  return {
    highlightIds: highlights.map((h) => h.id),
    bankIds: banks.map((b) => b.id),
    folderIds: folders.map((f) => f.id),
    tagIds: tags.map((t) => t.id),
    sourceIds: sources.map((s) => s.id),
    liveHighlights: live,
  };
}
