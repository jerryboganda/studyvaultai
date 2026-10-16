import { z } from 'zod';
import {
  Attachment,
  BankRecord,
  FilingRule,
  Folder,
  Highlight,
  HighlightBank,
  HighlightTag,
  INBOX_BANK_ID,
  IsoDate,
  Note,
  OcrPage,
  PdfDocument,
  Relation,
  SCHEMA_VERSION,
  Source,
  StudyVaultError,
  Syllabus,
  Tag,
  flattenSyllabus,
  type RelationEntityKind,
  type SyllabusNode,
  type TableRegistry,
  type TableSpec,
} from '@shared';
import { GameEventRow, GameFactRow } from '@study/game';
import { STUDY_TABLE_SPECS } from '@study/schema';
import { DB_VERSION, withDb, type StudyVaultDb } from './db';
import { normaliseRow } from './rows';

/**
 * Describes every persisted table for storage-agnostic code (backup, sync, integrity checks).
 * Tables whose entity belongs to another module (study, ai, sync) start with a placeholder schema
 * that only requires the key; that module attaches its real schema with `registerTableSchema`.
 */

const MetaRowSchema = z.object({
  key: z.string().min(1).max(200),
  value: z.unknown(),
  updatedAt: IsoDate,
});

/** Placeholder until the owning module registers its schema: an object with a string `id`. */
const keyedRow = z.looseObject({ id: z.string().min(1) });

type Spec = Omit<TableSpec, 'schema'> & { schema: z.ZodType };

function studyReferences(table: string): TableSpec['references'] {
  const spec = STUDY_TABLE_SPECS.find((s) => s.name === table);
  if (!spec) throw new StudyVaultError('internal', `The study module has no table ${table}`);
  return spec.references;
}

const SPECS: readonly Spec[] = [
  { name: 'banks', primaryKey: 'id', schema: BankRecord, softDelete: true },
  // No documentId -> documents reference: purging a document keeps its highlights, and with them
  // the PDF source that points at the (now gone) document id.
  { name: 'sources', primaryKey: 'id', schema: Source, softDelete: true },
  {
    name: 'highlights',
    primaryKey: 'id',
    schema: Highlight,
    softDelete: true,
    references: [{ field: 'sourceId', table: 'sources' }],
    derivedFields: ['resolveStatus', 'resolveConfidence', 'lastResolvedAt'],
  },
  {
    name: 'highlightBanks',
    primaryKey: ['highlightId', 'bankId'],
    schema: HighlightBank,
    softDelete: false,
    references: [
      { field: 'highlightId', table: 'highlights' },
      { field: 'bankId', table: 'banks' },
      { field: 'folderId', table: 'folders', nullable: true },
    ],
  },
  {
    name: 'folders',
    primaryKey: 'id',
    schema: Folder,
    softDelete: true,
    references: [
      { field: 'bankId', table: 'banks' },
      { field: 'parentFolderId', table: 'folders', nullable: true },
    ],
  },
  { name: 'tags', primaryKey: 'id', schema: Tag, softDelete: true },
  {
    name: 'highlightTags',
    primaryKey: ['highlightId', 'tagId'],
    schema: HighlightTag,
    softDelete: false,
    references: [
      { field: 'highlightId', table: 'highlights' },
      { field: 'tagId', table: 'tags' },
    ],
  },
  {
    name: 'notes',
    primaryKey: 'id',
    schema: Note,
    softDelete: true,
    references: [
      { field: 'highlightId', table: 'highlights', nullable: true },
      { field: 'sourceId', table: 'sources', nullable: true },
    ],
  },
  // The study tables' references come from the module that owns their schemas: a field it adds
  // (knowledgePoints.primaryQuoteId was once missing here) is checked without a second edit.
  {
    name: 'knowledgePoints',
    primaryKey: 'id',
    schema: keyedRow,
    softDelete: true,
    references: studyReferences('knowledgePoints'),
  },
  {
    name: 'decks',
    primaryKey: 'id',
    schema: keyedRow,
    softDelete: true,
    references: studyReferences('decks'),
  },
  {
    name: 'cards',
    primaryKey: 'id',
    schema: keyedRow,
    softDelete: true,
    references: studyReferences('cards'),
  },
  {
    // Append-only: a log entry is never edited or soft-deleted.
    name: 'reviewLogs',
    primaryKey: 'id',
    schema: keyedRow,
    softDelete: false,
    references: studyReferences('reviewLogs'),
  },
  {
    name: 'aiResults',
    primaryKey: 'id',
    schema: keyedRow,
    softDelete: false,
    references: [{ field: 'highlightId', table: 'highlights', nullable: true }],
  },
  { name: 'documents', primaryKey: 'id', schema: PdfDocument, softDelete: true },
  {
    name: 'attachments',
    primaryKey: 'id',
    schema: Attachment,
    softDelete: false,
    references: [{ field: 'documentId', table: 'documents' }],
    localOnly: true,
  },
  {
    name: 'ocrPages',
    primaryKey: ['documentId', 'pageNumber'],
    schema: OcrPage,
    softDelete: false,
    references: [{ field: 'documentId', table: 'documents' }],
    // The reading a re-run replaced (one undo step): device-local, so not synchronised, not in the
    // checksums, and left out of a backup file (`BACKUP_LOCAL_FIELDS` in backupTarget.ts).
    derivedFields: ['previousReading'],
  },
  { name: 'syncOps', primaryKey: 'id', schema: keyedRow, softDelete: false, localOnly: true },
  { name: 'meta', primaryKey: 'key', schema: MetaRowSchema, softDelete: false, localOnly: true },
  // Organisation records (schema v4, ADR-011). Their schemas live in @shared, so they are never a
  // placeholder. What they point at sits inside a nested object, a list or a kind/id pair, which
  // `references` cannot express: `NESTED_REFERENCES` below is what `checkIntegrity` reads instead.
  { name: 'filingRules', primaryKey: 'id', schema: FilingRule, softDelete: true },
  { name: 'syllabi', primaryKey: 'id', schema: Syllabus, softDelete: true },
  { name: 'relations', primaryKey: 'id', schema: Relation, softDelete: true },
  // Game ledger (schema v5, ADR-022). Append-only, never soft-deleted. No `references`: an event
  // outlives the row it was derived from (a purge keeps the XP), so it is never an orphan.
  {
    name: 'gameEvents',
    primaryKey: 'id',
    schema: GameEventRow,
    softDelete: false,
    bookkeeping: true,
  },
  {
    name: 'gameFacts',
    primaryKey: 'id',
    schema: GameFactRow,
    softDelete: false,
    bookkeeping: true,
  },
];

interface NestedReference {
  /** Where in the row, for the message. */
  path: string;
  table: string;
  id: string;
}

const RELATION_TABLE: Record<RelationEntityKind, string> = {
  highlight: 'highlights',
  knowledgePoint: 'knowledgePoints',
  note: 'notes',
};

const texts = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

/**
 * References that live inside a row's own structure. Called only for rows that passed their schema
 * and are not deleted. A reference to a row that is merely in the trash is intact: only a row that
 * does not exist at all is dangling.
 */
const NESTED_REFERENCES: Readonly<
  Record<string, (row: Record<string, unknown>) => NestedReference[]>
> = {
  filingRules: (row) => {
    const action = (row.action ?? {}) as Record<string, unknown>;
    const match = (row.match ?? {}) as Record<string, unknown>;
    const out: NestedReference[] = [];
    if (typeof action.bankId === 'string') {
      out.push({ path: 'action.bankId', table: 'banks', id: action.bankId });
    }
    if (typeof action.folderId === 'string') {
      out.push({ path: 'action.folderId', table: 'folders', id: action.folderId });
    }
    for (const id of texts(action.addTagIds)) {
      out.push({ path: 'action.addTagIds', table: 'tags', id });
    }
    for (const id of texts(match.tagIds)) out.push({ path: 'match.tagIds', table: 'tags', id });
    return out;
  },
  syllabi: (row) => {
    const out: NestedReference[] = [];
    const nodes = Array.isArray(row.nodes) ? (row.nodes as SyllabusNode[]) : [];
    for (const { node } of flattenSyllabus(nodes)) {
      for (const id of texts(node.bankIds)) {
        out.push({ path: `topic ${node.id} bankIds`, table: 'banks', id });
      }
      for (const id of texts(node.tagIds)) {
        out.push({ path: `topic ${node.id} tagIds`, table: 'tags', id });
      }
    }
    return out;
  },
  relations: (row) => {
    const out: NestedReference[] = [];
    for (const side of ['from', 'to'] as const) {
      const table = RELATION_TABLE[row[`${side}Kind`] as RelationEntityKind];
      const id = row[`${side}Id`];
      if (table !== undefined && typeof id === 'string') {
        out.push({ path: `${side}Id`, table, id });
      }
    }
    return out;
  },
};

/** The same relation spelled once: "related" has no direction, so both orders are one link. */
export function relationKey(row: {
  fromKind: string;
  fromId: string;
  toKind: string;
  toId: string;
  type: string;
}): string {
  const from = `${row.fromKind}:${row.fromId}`;
  const to = `${row.toKind}:${row.toId}`;
  const [a, b] = row.type === 'related' && to < from ? [to, from] : [from, to];
  return `${a}|${b}|${row.type}`;
}

const registered = new Map<string, z.ZodType>();

/** Tables whose schema is still the placeholder. */
export function unregisteredTables(): string[] {
  return SPECS.filter((s) => s.schema === keyedRow && !registered.has(s.name)).map((s) => s.name);
}

/**
 * Attach the entity schema of a table owned by another module (cards, decks, knowledgePoints,
 * reviewLogs, aiResults, syncOps ...). Unknown table names are refused: a typo must not silently
 * leave the real table unvalidated.
 */
export function registerTableSchema(name: string, schema: z.ZodType): void {
  if (!SPECS.some((s) => s.name === name)) {
    throw new StudyVaultError('invalid_request', `Unknown table: ${name}`);
  }
  registered.set(name, schema);
}

export function getTableRegistry(): TableRegistry {
  return {
    schemaVersion: DB_VERSION,
    tables: SPECS.map((spec) => ({ ...spec, schema: registered.get(spec.name) ?? spec.schema })),
  };
}

/** A live view of the registry: `tables` reflects schemas registered after this module loaded. */
export const tableRegistry: TableRegistry = {
  get schemaVersion() {
    return DB_VERSION;
  },
  get tables() {
    return getTableRegistry().tables;
  },
};

// ---------------------------------------------------------------------------------------------
// integrity check
// ---------------------------------------------------------------------------------------------

export type IntegrityIssueCode =
  | 'invalid_row'
  | 'newer_schema'
  | 'bad_schema_version'
  | 'orphan_reference'
  | 'duplicate_id'
  | 'duplicate_tag_name'
  | 'multiple_inbox'
  | 'duplicate_relation';

export interface IntegrityIssue {
  table: string;
  /** Primary key of the offending row, compound keys joined with "+". */
  key: string;
  code: IntegrityIssueCode;
  message: string;
}

export interface IntegrityReport {
  ok: boolean;
  checkedAt: string;
  tables: Record<string, { rows: number; invalid: number; newer: number }>;
  issues: IntegrityIssue[];
  /** True when more issues exist than are listed (the list is capped per table). */
  truncated: boolean;
}

const MAX_ISSUES_PER_TABLE = 200;
/** Tables whose ids share one namespace in exports and sync: an id may live in only one of them. */
const ENTITY_TABLES = ['banks', 'sources', 'highlights', 'folders', 'tags', 'notes', 'documents'];

const keyString = (row: Record<string, unknown>, pk: string | readonly string[]) =>
  (Array.isArray(pk) ? (pk as string[]) : [pk as string]).map((f) => String(row[f])).join('+');

/**
 * Read-only audit of the whole database: rows that fail validation, schema versions this build
 * cannot read, references to rows that do not exist, and identity collisions. Nothing is written
 * and nothing is repaired; the report is what backup/restore and the options page show.
 */
export async function checkIntegrity(db?: StudyVaultDb): Promise<IntegrityReport> {
  const run = async (handle: StudyVaultDb): Promise<IntegrityReport> =>
    handle.transaction('r', handle.tables, async () => {
      const registry = getTableRegistry();
      const issues: IntegrityIssue[] = [];
      const perTable: IntegrityReport['tables'] = {};
      let truncated = false;
      const counts = new Map<string, number>();
      const push = (issue: IntegrityIssue) => {
        const n = counts.get(issue.table) ?? 0;
        counts.set(issue.table, n + 1);
        if (n < MAX_ISSUES_PER_TABLE) issues.push(issue);
        else truncated = true;
      };

      // Pass 1: primary keys of every single-key table (targets of references), id namespace.
      const keys = new Map<string, Set<string>>();
      const ownerOfId = new Map<string, string>();
      for (const spec of registry.tables) {
        if (typeof spec.primaryKey !== 'string') continue;
        const set = new Set<string>();
        for (const k of await handle.table(spec.name).toCollection().primaryKeys()) {
          set.add(String(k));
        }
        keys.set(spec.name, set);
        if (ENTITY_TABLES.includes(spec.name)) {
          for (const id of set) {
            const other = ownerOfId.get(id);
            if (other !== undefined && other !== spec.name) {
              push({
                table: spec.name,
                key: id,
                code: 'duplicate_id',
                message: `id is also used by a row of ${other}`,
              });
            } else ownerOfId.set(id, spec.name);
          }
        }
      }

      // Pass 2: every row.
      let inboxes = 0;
      const tagKeys = new Map<string, string>();
      const relationKeys = new Map<string, string>();
      for (const spec of registry.tables) {
        const stats = { rows: 0, invalid: 0, newer: 0 };
        perTable[spec.name] = stats;
        const shape = (spec.schema as { shape?: Record<string, unknown> }).shape;
        const versioned = shape !== undefined && 'schemaVersion' in shape;
        // One getAll per table: far cheaper than a cursor walk, and the audit is a one-off.
        const rows = (await handle.table(spec.name).toArray()) as Array<Record<string, unknown>>;
        for (const raw of rows) {
          stats.rows++;
          const key = keyString(raw, spec.primaryKey);
          const version = raw.schemaVersion;
          if (versioned) {
            if (
              typeof version === 'number' &&
              Number.isInteger(version) &&
              version > SCHEMA_VERSION
            ) {
              stats.newer++;
              push({
                table: spec.name,
                key,
                code: 'newer_schema',
                message: `written by a newer build (schemaVersion ${version})`,
              });
            } else if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
              push({
                table: spec.name,
                key,
                code: 'bad_schema_version',
                message: 'schemaVersion is missing or not a positive integer',
              });
            }
          }
          const parsed = spec.schema.safeParse(normaliseRow(raw));
          if (!parsed.success) {
            stats.invalid++;
            push({
              table: spec.name,
              key,
              code: 'invalid_row',
              message: parsed.error.issues[0]?.message ?? 'does not match its schema',
            });
            continue;
          }
          for (const ref of spec.references ?? []) {
            const value = raw[ref.field];
            if (value === null || value === undefined) {
              if (ref.nullable !== true) {
                push({
                  table: spec.name,
                  key,
                  code: 'orphan_reference',
                  message: `${ref.field} is empty but must reference ${ref.table}`,
                });
              }
              continue;
            }
            if (!keys.get(ref.table)?.has(String(value))) {
              push({
                table: spec.name,
                key,
                code: 'orphan_reference',
                message: `${ref.field} references a missing ${ref.table} row`,
              });
            }
          }
          if (raw.deletedAt == null) {
            for (const ref of NESTED_REFERENCES[spec.name]?.(raw) ?? []) {
              // The Inbox exists even before its row is first written.
              if (ref.table === 'banks' && ref.id === INBOX_BANK_ID) continue;
              if (!keys.get(ref.table)?.has(ref.id)) {
                push({
                  table: spec.name,
                  key,
                  code: 'orphan_reference',
                  message: `${ref.path} references a missing ${ref.table} row`,
                });
              }
            }
          }
          if (spec.name === 'relations' && raw.deletedAt == null) {
            const same = relationKey(raw as Parameters<typeof relationKey>[0]);
            const first = relationKeys.get(same);
            if (first !== undefined) {
              push({
                table: 'relations',
                key,
                code: 'duplicate_relation',
                message: `same link as relation ${first}`,
              });
            } else relationKeys.set(same, key);
          }
          if (spec.name === 'banks' && raw.isInbox === true && raw.deletedAt == null) {
            inboxes++;
            if (raw.id !== INBOX_BANK_ID) {
              push({
                table: 'banks',
                key,
                code: 'multiple_inbox',
                message: 'a bank other than the fixed Inbox is marked as the Inbox',
              });
            }
          }
          if (spec.name === 'tags' && raw.deletedAt == null && typeof raw.nameKey === 'string') {
            const first = tagKeys.get(raw.nameKey);
            if (first !== undefined) {
              push({
                table: 'tags',
                key,
                code: 'duplicate_tag_name',
                message: `same name as tag ${first}`,
              });
            } else tagKeys.set(raw.nameKey, key);
          }
        }
      }
      if (inboxes > 1) {
        push({
          table: 'banks',
          key: INBOX_BANK_ID,
          code: 'multiple_inbox',
          message: `${inboxes} live banks are marked as the Inbox`,
        });
      }
      return {
        ok: issues.length === 0 && !truncated,
        checkedAt: new Date().toISOString(),
        tables: perTable,
        issues,
        truncated,
      };
    });
  return db ? run(db) : withDb(run);
}
