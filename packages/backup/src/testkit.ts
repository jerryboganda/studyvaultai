// Test helpers only: not exported from index.ts and never imported by production code.
import { createHash, webcrypto } from 'node:crypto';
import { z } from 'zod';
import {
  Bank,
  Highlight,
  HighlightBank,
  Source,
  type TableRegistry,
  type TableSpec,
} from '@shared';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { canonicalJson, keyString, omitFields, rowKey } from './canonical';
import { BackupError } from './errors';
import type {
  CitationGuard,
  CommitPlan,
  ImmutableFields,
  ReadOptions,
  RestoreTarget,
  Row,
  RowKey,
  StagingDb,
  StagingInit,
  TableRead,
} from './types';

export const subtle = webcrypto.subtle as unknown as SubtleCrypto;
export const NOW = new Date('2026-10-11T08:30:00.000Z');
export const fastKdf = { kdfIterations: 1000 } as const;
/** Deterministic "random" for reproducible fixtures. */
export const fixedRandom = (n: number): Uint8Array =>
  Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xff);

// ---------------------------------------------------------------------------------------------
// A model that mixes the real v1 schemas with a few local ones
// ---------------------------------------------------------------------------------------------

const iso = z.iso.datetime();
const BlobLike = z.custom<Blob>((v) => typeof Blob !== 'undefined' && v instanceof Blob);

export const NoteRow = z.object({
  id: z.string().min(8),
  schemaVersion: z.literal(1),
  createdAt: iso,
  updatedAt: iso,
  deletedAt: iso.nullable(),
  highlightId: z.string().nullable(),
  title: z.string(),
  body: z.string(),
  pinned: z.boolean(),
  /** derived: recomputed by the app after every edit */
  wordCount: z.number().int().optional(),
});

export const FolderRow = z.object({
  id: z.string().min(8),
  schemaVersion: z.literal(1),
  createdAt: iso,
  updatedAt: iso,
  deletedAt: iso.nullable(),
  bankId: z.string(),
  parentFolderId: z.string().nullable(),
  name: z.string().min(1),
  position: z.number(),
});

export const AttachmentRow = z.object({
  id: z.string().min(8),
  schemaVersion: z.literal(1),
  createdAt: iso,
  documentId: z.string(),
  mimeType: z.string(),
  blob: BlobLike,
});

export function spec(
  name: string,
  primaryKey: string | readonly string[],
  schema: z.ZodType,
  extra: Partial<TableSpec> = {},
): TableSpec {
  return { name, primaryKey, schema, softDelete: false, ...extra };
}

export const TEST_REGISTRY: TableRegistry = {
  schemaVersion: 2,
  tables: [
    spec('banks', 'id', Bank, { softDelete: true }),
    spec('sources', 'id', Source, { softDelete: true }),
    spec('folders', 'id', FolderRow, {
      softDelete: true,
      references: [
        { field: 'bankId', table: 'banks' },
        { field: 'parentFolderId', table: 'folders', nullable: true },
      ],
    }),
    spec('highlights', 'id', Highlight, {
      softDelete: true,
      references: [{ field: 'sourceId', table: 'sources' }],
      derivedFields: ['resolveStatus', 'resolveConfidence', 'lastResolvedAt'],
    }),
    spec('highlightBanks', ['highlightId', 'bankId'], HighlightBank, {
      references: [
        { field: 'highlightId', table: 'highlights' },
        { field: 'bankId', table: 'banks' },
        { field: 'folderId', table: 'folders', nullable: true },
      ],
    }),
    spec('notes', 'id', NoteRow, {
      softDelete: true,
      references: [{ field: 'highlightId', table: 'highlights', nullable: true }],
      derivedFields: ['wordCount'],
    }),
    spec('attachments', 'id', AttachmentRow, { localOnly: true }),
  ],
};

// ---------------------------------------------------------------------------------------------
// Seeded data
// ---------------------------------------------------------------------------------------------

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pad = (n: number, w = 8): string => String(n).padStart(w, '0');
export const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const KINDS = [
  'essential',
  'formula',
  'exception',
  'differential',
  'weak_area',
  'correction',
  'question',
] as const;
const COLORS = ['amber', 'blue', 'red', 'purple', 'orange', 'green', 'teal'] as const;
const STATUS = ['unchecked', 'resolved', 'changed', 'ambiguous', 'orphaned'] as const;
const WORDS = [
  'aspirin',
  'inhibits',
  'cyclooxygenase',
  'Ünïcödé',
  '日本語',
  'heart',
  '\u{1F9EC}',
  'beta-blocker',
  'QT',
  'ECG',
];

export interface Seed {
  banks: Row[];
  sources: Row[];
  folders: Row[];
  highlights: Row[];
  highlightBanks: Row[];
  notes: Row[];
  attachments: Row[];
}

export function seedData(nHighlights: number, seed = 1): Seed {
  const r = rng(seed);
  const at = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString();
  const banks: Row[] = [];
  for (let i = 0; i < 12; i++) {
    banks.push({
      id: i === 0 ? 'inbox-default' : `bank-${pad(i)}`,
      schemaVersion: 1,
      createdAt: at(i),
      updatedAt: at(i),
      deletedAt: null,
      name: i === 0 ? 'Inbox' : `Bank ${i}`,
      color: COLORS[i % COLORS.length],
      position: i,
      isInbox: i === 0,
    });
  }
  const folders: Row[] = [];
  for (let i = 0; i < 40; i++) {
    folders.push({
      id: `folder-${pad(i)}`,
      schemaVersion: 1,
      createdAt: at(i),
      updatedAt: at(i),
      deletedAt: null,
      bankId: `bank-${pad(1 + (i % 11))}`,
      parentFolderId: i >= 11 ? `folder-${pad(i - 11)}` : null,
      name: `Topic ${i}`,
      position: i,
    });
  }
  const nSources = Math.max(1, Math.ceil(nHighlights / 20));
  const sources: Row[] = [];
  for (let i = 0; i < nSources; i++) {
    sources.push({
      id: `src-${pad(i)}`,
      schemaVersion: 1,
      createdAt: at(i),
      updatedAt: at(i),
      deletedAt: null,
      type: 'web',
      urlKey: `https://example.com/p/${i}`,
      visitedKey: `https://example.com/p/${i}`,
      originalUrl: `https://example.com/p/${i}?utm=1`,
      canonicalUrl: null,
      host: 'example.com',
      title: `Page ${i} — notes`,
    });
  }
  const highlights: Row[] = [];
  const highlightBanks: Row[] = [];
  const notes: Row[] = [];
  for (let i = 0; i < nHighlights; i++) {
    const words = Array.from(
      { length: 6 + Math.floor(r() * 30) },
      () => WORDS[Math.floor(r() * WORDS.length)],
    );
    const exact = `${words.join(' ')} #${i}`;
    const start = Math.floor(r() * 100_000);
    const row: Row = {
      id: `hl-${pad(i)}`,
      schemaVersion: 1,
      createdAt: at(i),
      updatedAt: at(i + 1),
      deletedAt: i % 97 === 0 ? at(i + 2) : null,
      sourceId: `src-${pad(i % nSources)}`,
      exactQuote: exact,
      normalizedQuote: exact.normalize('NFKC').toLowerCase(),
      quoteHash: sha(exact),
      anchorSet: {
        type: 'html',
        textAlgorithm: 'sv-text-v1',
        textQuote: { exact, prefix: 'lead ', suffix: ' tail' },
        textPosition: { start, end: start + exact.length },
        structuralPath: i % 3 === 0 ? 'main article p:nth-of-type(3)' : null,
        contentSignature: 'abc123',
        documentTextLength: 120_000,
      },
      kind: KINDS[i % KINDS.length],
      color: COLORS[i % COLORS.length],
      priority: 1 + (i % 5),
      userComment: i % 4 === 0 ? `comment ${i} with "quotes", commas and\nnewlines` : '',
      headingContext: i % 2 === 0 ? `Heading ${i % 17}` : null,
      captureMethod: 'toolbar',
      capturedAt: at(i),
      resolveStatus: STATUS[i % STATUS.length],
      resolveConfidence: i % 5 === 0 ? null : 0.5 + (i % 50) / 100,
      lastResolvedAt: i % 5 === 0 ? null : at(i + 3),
      capturedUrl: `https://example.com/p/${i % nSources}`,
      capturedTitle: `Page ${i % nSources}`,
    };
    highlights.push(row);
    highlightBanks.push({
      highlightId: row.id,
      bankId: banks[i % banks.length]?.id,
      folderId: i % 7 === 0 ? `folder-${pad(i % 40)}` : null,
      addedAt: at(i),
    });
    if (i % 10 === 0) {
      notes.push({
        id: `note-${pad(i)}`,
        schemaVersion: 1,
        createdAt: at(i),
        updatedAt: at(i + 5),
        deletedAt: null,
        highlightId: row.id,
        title: `Note ${i}`,
        body: `Body of note ${i}.`,
        pinned: i % 20 === 0,
        wordCount: 5,
      });
    }
  }
  return { banks, sources, folders, highlights, highlightBanks, notes, attachments: [] };
}

// ---------------------------------------------------------------------------------------------
// In-memory vault (BackupSource + RestoreTarget) that records every live mutation
// ---------------------------------------------------------------------------------------------

export function compareKeys(a: RowKey, b: RowKey): number {
  const aa = Array.isArray(a) ? a : [a];
  const bb = Array.isArray(b) ? b : [b];
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    const x = aa[i] as string | number;
    const y = bb[i] as string | number;
    if (x === y) continue;
    return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * What a storage layer derives from the sync policy for TEST_REGISTRY (packages/sync/src/policy.ts
 * names the same fields). The restore engine itself has no list: the target says.
 */
export const TEST_IMMUTABLE_FIELDS: ImmutableFields = {
  folders: ['bankId'],
  sources: ['type', 'urlKey', 'visitedKey', 'originalUrl', 'canonicalUrl', 'host'],
  highlights: [
    'sourceId',
    'exactQuote',
    'normalizedQuote',
    'quoteHash',
    'anchorSet',
    'headingContext',
    'captureMethod',
    'capturedAt',
    'capturedUrl',
    'capturedTitle',
  ],
};

export interface VaultOptions {
  registry?: TableRegistry;
  /** Provenance fields a merge may not change. Default TEST_IMMUTABLE_FIELDS. */
  immutableFields?: ImmutableFields;
  citationGuard?: CitationGuard;
  /** Serve pages as an AsyncIterable instead of one Promise per page. */
  streaming?: boolean;
  failStagingOn?: 'putRows' | 'validate' | 'commit' | 'create';
  /** commit applies half of the plan and then throws (simulates a non-atomic target). */
  commitHalfThenFail?: boolean;
  /** Fail after N staging puts. */
  failAfterPuts?: number;
  readPageLog?: number[];
}

export class MemoryVault implements RestoreTarget {
  readonly registry: TableRegistry;
  readonly data = new Map<string, Map<string, Row>>();
  /** Number of times live data was changed (commit applied, or a rollback restored it). */
  liveWrites = 0;
  stagingCreated = 0;
  readonly events: string[] = [];
  lastStaging: MemoryStaging | null = null;

  constructor(
    seed: Partial<Record<string, readonly Row[]>> = {},
    readonly options: VaultOptions = {},
  ) {
    this.registry = options.registry ?? TEST_REGISTRY;
    for (const t of this.registry.tables) this.data.set(t.name, new Map());
    for (const [name, rows] of Object.entries(seed)) this.load(name, rows ?? []);
  }

  spec(name: string): TableSpec {
    const s = this.registry.tables.find((t) => t.name === name);
    if (!s) throw new Error(`no table ${name}`);
    return s;
  }

  load(name: string, rows: readonly Row[]): void {
    const spec = this.spec(name);
    const table = this.data.get(name) as Map<string, Row>;
    for (const row of rows) table.set(keyString(rowKey(spec, row)), structuredClone(row));
  }

  rows(name: string): Row[] {
    const spec = this.spec(name);
    return [...(this.data.get(name) as Map<string, Row>).values()].sort((a, b) =>
      compareKeys(rowKey(spec, a), rowKey(spec, b)),
    );
  }

  /** Canonical snapshot for equality checks (binary fields by size). */
  snapshot(): string {
    const out: Record<string, string[]> = {};
    for (const t of this.registry.tables) {
      out[t.name] = this.rows(t.name).map((r) =>
        canonicalJson(
          Object.fromEntries(
            Object.entries(r).map(([k, v]) => [
              k,
              v instanceof Blob ? { $blob: v.size, type: v.type } : v,
            ]),
          ),
        ),
      );
    }
    return JSON.stringify(out);
  }

  counts(): Promise<Record<string, number>> {
    return Promise.resolve(Object.fromEntries([...this.data].map(([name, m]) => [name, m.size])));
  }

  readTable(name: string, opts: ReadOptions): TableRead {
    const spec = this.spec(name);
    const all = this.rows(name);
    let page = all;
    if (opts.afterKey !== undefined) {
      const after = opts.afterKey;
      page = all.filter((r) => compareKeys(rowKey(spec, r), after) > 0);
    }
    page = page.slice(0, opts.limit);
    this.options.readPageLog?.push(page.length);
    if (this.options.streaming) {
      return (async function* () {
        for (let i = 0; i < all.length; i += opts.limit) yield all.slice(i, i + opts.limit);
      })();
    }
    return Promise.resolve(page);
  }

  createStaging(init: StagingInit): Promise<StagingDb> {
    this.stagingCreated++;
    this.events.push(`createStaging:${init.tables.join(',')}`);
    if (this.options.failStagingOn === 'create') return Promise.reject(new Error('disk full'));
    const s = new MemoryStaging(this);
    this.lastStaging = s;
    return Promise.resolve(s);
  }

  immutableFields(): ImmutableFields {
    return this.options.immutableFields ?? TEST_IMMUTABLE_FIELDS;
  }

  get citationGuard(): CitationGuard | undefined {
    return this.options.citationGuard;
  }

  private busy = false;
  /** Same contract as the Dexie target's lock: a second restore is refused while one runs. */
  async exclusive<T>(run: () => Promise<T>): Promise<T> {
    if (this.busy) {
      throw new BackupError('restore_in_progress', 'Another restore is already running.');
    }
    this.busy = true;
    try {
      return await run();
    } finally {
      this.busy = false;
    }
  }
}

export class MemoryStaging implements StagingDb {
  readonly staged = new Map<string, Map<string, Row>>();
  puts = 0;
  rolledBack = 0;
  discarded = 0;
  commits: CommitPlan[] = [];

  constructor(private readonly vault: MemoryVault) {}

  putRows(table: string, rows: readonly Row[]): Promise<void> {
    this.puts++;
    const o = this.vault.options;
    if (o.failStagingOn === 'putRows') return Promise.reject(new Error('quota exceeded'));
    if (o.failAfterPuts !== undefined && this.puts > o.failAfterPuts) {
      return Promise.reject(new Error('quota exceeded'));
    }
    const spec = this.vault.spec(table);
    let m = this.staged.get(table);
    if (!m) this.staged.set(table, (m = new Map()));
    for (const r of rows) m.set(keyString(rowKey(spec, r)), r);
    return Promise.resolve();
  }

  validate(): Promise<readonly string[]> {
    return Promise.resolve(
      this.vault.options.failStagingOn === 'validate' ? ['unique index violated'] : [],
    );
  }

  commit(plan: CommitPlan): Promise<void> {
    this.commits.push(plan);
    if (this.vault.options.failStagingOn === 'commit') {
      if (this.vault.options.commitHalfThenFail) {
        // a non-atomic target: damage is done, rollback() must repair it
        const first = this.vault.registry.tables[0];
        if (first) {
          this.backup = new Map(this.vault.data.get(first.name));
          this.vault.data.get(first.name)?.clear();
          this.vault.liveWrites++;
        }
      }
      return Promise.reject(new Error('transaction aborted'));
    }
    // all-or-nothing: build the next state aside, then swap
    const next = new Map<string, Map<string, Row>>();
    for (const [n, m] of this.vault.data) next.set(n, new Map(m));
    if (plan.mode === 'replace') {
      for (const t of plan.tables) {
        const dst = new Map<string, Row>();
        for (const [k, r] of this.staged.get(t) ?? []) dst.set(k, r);
        next.set(t, dst);
      }
    } else {
      for (const [t, keys] of Object.entries(plan.upsert)) {
        const dst = next.get(t) as Map<string, Row>;
        for (const key of keys) {
          const k = keyString(key);
          const row = this.staged.get(t)?.get(k);
          if (!row) throw new Error(`plan references unstaged row ${t}:${k}`);
          dst.set(k, row);
        }
      }
    }
    for (const [n, m] of next) this.vault.data.set(n, m);
    this.vault.liveWrites++;
    return Promise.resolve();
  }

  private backup: Map<string, Row> | null = null;

  rollback(): Promise<void> {
    this.rolledBack++;
    if (this.backup) {
      const first = this.vault.registry.tables[0];
      if (first) this.vault.data.set(first.name, this.backup);
      this.backup = null;
    }
    this.staged.clear();
    return Promise.resolve();
  }

  discard(): Promise<void> {
    this.discarded++;
    this.staged.clear();
    return Promise.resolve();
  }
}

export function seedVault(n: number, options?: VaultOptions, seed = 1): MemoryVault {
  const s = seedData(n, seed);
  return new MemoryVault(s as unknown as Record<string, Row[]>, options);
}

// ---------------------------------------------------------------------------------------------
// Archive surgery for corruption tests
// ---------------------------------------------------------------------------------------------

export const unpack = (bytes: Uint8Array): Record<string, Uint8Array> => unzipSync(bytes);
export const pack = (files: Record<string, Uint8Array>): Uint8Array => zipSync(files);

/** Canonical checksum of NDJSON text exactly as the exporter defines it. */
export function tableSha(ndjson: string, derived: readonly string[] = []): string {
  let stream = '';
  for (const line of ndjson.split('\n')) {
    if (line.trim() === '') continue;
    let canon: string;
    try {
      canon = canonicalJson(omitFields(JSON.parse(line) as Row, derived));
    } catch {
      canon = line; // forged garbage: any hash will do, the importer rejects the row first
    }
    stream += `${canon}\n`;
  }
  return sha(stream);
}

type Manifest = Record<string, unknown> & {
  tables: { name: string; rowCount: number; sha256: string; derivedFields?: string[] }[];
};

/** Rewrite manifest fields (and recompute its checksum) and re-zip. */
export function reseal(
  files: Record<string, Uint8Array>,
  mutate?: (manifest: Manifest) => void,
): Uint8Array {
  const m = JSON.parse(strFromU8(files['manifest.json'] as Uint8Array)) as Manifest;
  mutate?.(m);
  delete m.checksum;
  m.checksum = sha(canonicalJson(m));
  return pack({ ...files, 'manifest.json': strToU8(JSON.stringify(m)) });
}

/** Replace a table's file; with `fixManifest` the row count and sha are made to match (a "clean" forgery). */
export function withTable(
  files: Record<string, Uint8Array>,
  table: string,
  ndjson: string,
  fixManifest: boolean,
): Uint8Array {
  const next = { ...files, [`tables/${table}.ndjson`]: strToU8(ndjson) };
  if (!fixManifest) return pack(next);
  return reseal(next, (m) => {
    const t = m.tables.find((x) => x.name === table);
    if (!t) throw new Error('no such table');
    t.rowCount = ndjson.split('\n').filter((l) => l.trim() !== '').length;
    t.sha256 = tableSha(ndjson, t.derivedFields ?? []);
  });
}

export const text = (u: Uint8Array): string => strFromU8(u);

/** Assert-friendly: nothing was staged or written. */
export function untouched(v: MemoryVault, snapshot: string): boolean {
  return v.liveWrites === 0 && v.stagingCreated === 0 && v.snapshot() === snapshot;
}
