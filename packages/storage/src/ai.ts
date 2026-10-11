import { z } from 'zod';
import {
  AiResult,
  BudgetLimits,
  BudgetState,
  acceptResult,
  assertSafeEndpoint,
  emptyBudget,
  isLoopbackHost,
  recordSpend,
  rollover,
  type AiCache,
  type AiTaskKind,
} from '@ai';
import { Highlight, IsoDate, Note, SCHEMA_VERSION, StudyVaultError } from '@shared';
import { Card, Deck, KnowledgePoint } from '@study/schema';
import {
  cmp,
  liveHighlight,
  notNull,
  now,
  parseInput,
  parseRow,
  readSources,
  signalChange,
  touchHighlights,
  unique,
} from './core';
import { withDb, withWritableDb, type ForeignRow, type StudyVaultDb } from './db';
import { registerTableSchema } from './registry';

/**
 * Persistence for the optional AI features. `@ai` is pure; this module is its storage:
 *  - `aiResults` rows: the validated `AiResult` plus review state (which items were accepted);
 *  - the `AiCache` port over those rows;
 *  - `meta` rows `aiSettings`, `aiBudget` and `aiKey`.
 *
 * The API key lives ONLY in the IndexedDB `meta` row `aiKey`: never in chrome.storage (content
 * scripts can read storage.local), never in a result, cache row, log or error. It is bound to the
 * origin it was saved for. Backup, export and migration snapshots must skip `AI_SECRET_META_KEYS`.
 */

export const AI_PROVIDERS = ['openai_compatible', 'anthropic'] as const;
export type AiProviderId = (typeof AI_PROVIDERS)[number];

const KEY_SETTINGS = 'aiSettings';
const KEY_API_KEY = 'aiKey';
const KEY_BUDGET = 'aiBudget';

/** `meta` keys that hold secrets: every export, backup and snapshot must leave these rows out. */
export const AI_SECRET_META_KEYS: readonly string[] = [KEY_API_KEY];

// ---------------------------------------------------------------------------------------------
// Settings (meta 'aiSettings')
// ---------------------------------------------------------------------------------------------

export const AiSettingsSchema = z.strictObject({
  provider: z.enum(AI_PROVIDERS),
  /** '' = the provider's default address (Anthropic only). */
  baseUrl: z.string().trim().max(300),
  model: z.string().trim().max(120),
  /** Ask OpenAI-compatible servers for `response_format: json_object` (some servers reject it). */
  jsonMode: z.boolean(),
  maxTokensParam: z.enum(['max_tokens', 'max_completion_tokens']),
  limits: BudgetLimits,
  /** null = unknown: estimates show "unknown" and a cost cap cannot be enforced. */
  pricing: z
    .strictObject({
      inputUsdPerMTok: z.number().min(0).max(1_000_000),
      outputUsdPerMTok: z.number().min(0).max(1_000_000),
    })
    .nullable(),
  preferences: z.strictObject({
    flashcardCount: z.number().int().min(1).max(20),
    mcqChoices: z.number().int().min(3).max(6),
  }),
});
export type AiSettings = z.infer<typeof AiSettingsSchema>;

export function defaultAiSettings(): AiSettings {
  return {
    provider: 'openai_compatible',
    baseUrl: '',
    model: '',
    jsonMode: true,
    maxTokensParam: 'max_tokens',
    limits: { maxRequestsPerDay: 30, maxCostUsdPerDay: null },
    pricing: null,
    preferences: { flashcardCount: 5, mcqChoices: 4 },
  };
}

export async function getAiSettings(): Promise<AiSettings> {
  const row = await withDb((db) => db.meta.get(KEY_SETTINGS));
  const defaults = defaultAiSettings();
  const stored = row?.value;
  if (typeof stored !== 'object' || stored === null) return defaults;
  const parsed = AiSettingsSchema.safeParse({ ...defaults, ...stored });
  return parsed.success ? parsed.data : defaults;
}

export async function setAiSettings(next: AiSettings): Promise<AiSettings> {
  const value = parseInput(AiSettingsSchema, next, 'AI settings');
  await withWritableDb((db) => db.meta.put({ key: KEY_SETTINGS, value, updatedAt: now() }));
  await signalChange();
  return value;
}

// ---------------------------------------------------------------------------------------------
// Endpoint
// ---------------------------------------------------------------------------------------------

export type AiEndpointCheck =
  | {
      ok: true;
      /** Normalised base address that requests are made to. */
      url: string;
      origin: string;
      host: string;
      /** Match pattern for `permissions.request` (no port: Chrome patterns cover every port). */
      pattern: string;
      loopback: boolean;
    }
  | { ok: false; reason: string };

const DEFAULT_BASE_URL: Record<AiProviderId, string> = {
  openai_compatible: '',
  anthropic: 'https://api.anthropic.com',
};

/**
 * The address must pass `assertSafeEndpoint` AND be reachable under the extension-pages CSP
 * (`connect-src 'self' https: http://localhost:* http://127.0.0.1:*`, ADR-009): plain http is only
 * allowed for exactly `localhost` and `127.0.0.1`.
 */
export function checkAiEndpoint(provider: AiProviderId, baseUrl: string): AiEndpointCheck {
  const raw = baseUrl.trim() || DEFAULT_BASE_URL[provider];
  if (!raw) {
    return {
      ok: false,
      reason: 'Enter the provider address, for example https://api.openai.com/v1.',
    };
  }
  let url: URL;
  try {
    url = assertSafeEndpoint(raw);
  } catch {
    return {
      ok: false,
      reason:
        'The address must be a full https:// URL without a password, query or fragment. http:// is only accepted for localhost.',
    };
  }
  if (url.protocol === 'http:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    return {
      ok: false,
      reason:
        "Plain http:// works only for http://localhost and http://127.0.0.1 (the extension's security policy blocks other plain-http addresses). Use https:// or one of those.",
    };
  }
  return {
    ok: true,
    url: `${url.origin}${url.pathname.replace(/\/+$/, '')}`,
    origin: url.origin,
    host: url.host,
    pattern: `${url.protocol}//${url.hostname}/*`,
    loopback: isLoopbackHost(url.hostname),
  };
}

/** Host-permission pattern of the configured endpoint (null when none is set). For the worker. */
export async function getAiEndpointPattern(): Promise<string | null> {
  const s = await getAiSettings();
  const check = checkAiEndpoint(s.provider, s.baseUrl);
  return check.ok ? check.pattern : null;
}

// ---------------------------------------------------------------------------------------------
// API key (meta 'aiKey')
// ---------------------------------------------------------------------------------------------

const KeyRow = z.strictObject({ apiKey: z.string().min(1), origin: z.string().min(1) });

/** Printable ASCII without spaces: it becomes a header value, so no CR/LF or other controls. */
const API_KEY_SHAPE = /^[\x21-\x7e]{8,512}$/;

export interface AiKeyInfo {
  present: boolean;
  /** The origin the key was saved for. */
  origin: string | null;
  /** Last four characters, for the masked display only. */
  last4: string | null;
}

export async function getAiKeyInfo(): Promise<AiKeyInfo> {
  const row = await withDb((db) => db.meta.get(KEY_API_KEY));
  const parsed = KeyRow.safeParse(row?.value);
  if (!parsed.success) return { present: false, origin: null, last4: null };
  return { present: true, origin: parsed.data.origin, last4: parsed.data.apiKey.slice(-4) };
}

/** The only reader of the secret. null when no key is stored or it was saved for another origin. */
export async function getAiApiKey(origin: string): Promise<string | null> {
  const row = await withDb((db) => db.meta.get(KEY_API_KEY));
  const parsed = KeyRow.safeParse(row?.value);
  return parsed.success && parsed.data.origin === origin ? parsed.data.apiKey : null;
}

export async function setAiApiKey(apiKey: string, origin: string): Promise<void> {
  const key = apiKey.trim();
  if (!API_KEY_SHAPE.test(key)) {
    throw new StudyVaultError(
      'invalid_request',
      'That does not look like an API key: it must be 8-512 visible characters without spaces.',
    );
  }
  await withWritableDb((db) =>
    db.meta.put({ key: KEY_API_KEY, value: { apiKey: key, origin }, updatedAt: now() }),
  );
  await signalChange();
}

export async function clearAiApiKey(): Promise<void> {
  await withWritableDb((db) => db.meta.delete(KEY_API_KEY));
  await signalChange();
}

// ---------------------------------------------------------------------------------------------
// Budget ledger (meta 'aiBudget')
// ---------------------------------------------------------------------------------------------

export interface AiSpendDelta {
  requests: number;
  costUsd: number | null;
  inputTokens: number;
  outputTokens: number;
}

export async function getAiBudget(nowMs: number = Date.now()): Promise<BudgetState> {
  const row = await withDb((db) => db.meta.get(KEY_BUDGET));
  const parsed = BudgetState.safeParse(row?.value);
  return rollover(parsed.success ? parsed.data : emptyBudget(nowMs), nowMs);
}

/** Read-modify-write in one transaction, so two tabs finishing together both count. */
export async function addAiSpend(
  delta: AiSpendDelta,
  nowMs: number = Date.now(),
): Promise<BudgetState> {
  const next = await withWritableDb((db) =>
    db.transaction('rw', db.meta, async () => {
      const row = await db.meta.get(KEY_BUDGET);
      const parsed = BudgetState.safeParse(row?.value);
      const state = recordSpend(parsed.success ? parsed.data : emptyBudget(nowMs), nowMs, delta);
      await db.meta.put({ key: KEY_BUDGET, value: state, updatedAt: now() });
      return state;
    }),
  );
  await signalChange();
  return next;
}

// ---------------------------------------------------------------------------------------------
// Results (table aiResults)
// ---------------------------------------------------------------------------------------------

const TARGET_TABLES = ['knowledgePoints', 'cards', 'notes'] as const;
export const AiItemReview = z.strictObject({
  state: z.enum(['accepted', 'discarded']),
  at: IsoDate,
  /** The user changed the model's wording before accepting. */
  edited: z.boolean(),
  /** Objects created from this item (accepted only). */
  targets: z
    .array(z.strictObject({ table: z.enum(TARGET_TABLES), id: z.string().min(8).max(64) }))
    .max(50),
});
export type AiItemReview = z.infer<typeof AiItemReview>;

const AiReview = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  /** First input that is a stored highlight: the `highlightId` index (purging it purges the row). */
  highlightId: z.string().max(80).nullable(),
  /** Mirror of `acceptedByUserAt`, for the `acceptedAt` index. */
  acceptedAt: IsoDate.nullable(),
  /** Per item (JSON pointer; '' = the whole result): what the user decided. */
  items: z.record(z.string().max(120), AiItemReview),
  /** `explain` only: the question that was asked (the engine's result does not keep it). */
  question: z.string().max(500).optional(),
});
type AiReview = z.infer<typeof AiReview>;

export type StoredAiResult = AiResult & AiReview;

const REVIEW_KEYS: ReadonlySet<string> = new Set(Object.keys(AiReview.shape));

function split(row: Record<string, unknown>): {
  result: Record<string, unknown>;
  review: Record<string, unknown>;
} {
  const result: Record<string, unknown> = {};
  const review: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) (REVIEW_KEYS.has(k) ? review : result)[k] = v;
  return { result, review };
}

/**
 * AiResult is a strict union, so the stored row is checked in two parts and kept as written: a
 * restore that runs this schema gets back exactly the fields the indexes need.
 */
export const StoredAiResultSchema = z.custom<StoredAiResult>((value) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const { result, review } = split(value as Record<string, unknown>);
  return (
    AiResult.safeParse(result).success &&
    AiReview.safeParse(review).success &&
    review.acceptedAt === result.acceptedByUserAt
  );
}, 'not a valid stored AI result');

registerTableSchema('aiResults', StoredAiResultSchema);

const toResult = (row: StoredAiResult): AiResult => split(row).result as unknown as AiResult;

/** JSON pointers of the independently reviewable items of a result ('' = one item). */
export function aiItemPaths(result: AiResult): string[] {
  return result.kind === 'flashcards' ? result.output.cards.map((_, i) => `/cards/${i}`) : [''];
}

/** The table is typed for rows of any owner; this module owns the shape. */
const asRow = (row: StoredAiResult): ForeignRow => row as unknown as ForeignRow;

async function readResult(db: StudyVaultDb, id: string): Promise<StoredAiResult> {
  const row = await db.aiResults.get(id);
  const parsed = row ? parseRow(StoredAiResultSchema, row, 'aiResult') : null;
  if (!parsed) throw new StudyVaultError('not_found', 'AI result not found');
  return parsed;
}

/**
 * Stores a result once; an id that already exists keeps its review state (and gains the question
 * when it was stored without one: the cache port saves the result before the caller can).
 */
export async function saveAiResult(
  result: AiResult,
  extra: { question?: string } = {},
): Promise<StoredAiResult> {
  const parsed = parseInput(AiResult, result, 'AI result');
  const question = extra.question?.trim() || undefined;
  const row = await withWritableDb((db) =>
    db.transaction('rw', [db.aiResults, db.highlights], async () => {
      const existing = await db.aiResults.get(parsed.id);
      if (existing) {
        const current = await readResult(db, parsed.id);
        if (question === undefined || current.question !== undefined) return current;
        const next = { ...current, question } as StoredAiResult;
        await db.aiResults.put(asRow(next));
        return next;
      }
      let highlightId: string | null = null;
      for (const id of parsed.inputSourceIds) {
        if (await db.highlights.get(id)) {
          highlightId = id;
          break;
        }
      }
      const created = {
        ...parsed,
        schemaVersion: SCHEMA_VERSION,
        highlightId,
        acceptedAt: parsed.acceptedByUserAt,
        items: {},
        ...(question === undefined ? {} : { question }),
      } as StoredAiResult;
      await db.aiResults.put(asRow(created));
      return created;
    }),
  );
  await signalChange();
  return row;
}

export async function getAiResult(id: string): Promise<StoredAiResult | null> {
  return withDb(async (db) => {
    const row = await db.aiResults.get(id);
    return row ? parseRow(StoredAiResultSchema, row, 'aiResult') : null;
  });
}

export interface AiResultQuery {
  /** Results that used any of these highlights as input. */
  highlightIds?: readonly string[];
  kind?: AiTaskKind;
  limit?: number;
}

/** Newest first. Rows that cannot be read are skipped (and logged), never fatal. */
export async function listAiResults(query: AiResultQuery = {}): Promise<StoredAiResult[]> {
  const limit = Math.min(Math.max(Math.floor(query.limit ?? 100), 1), 1000);
  const wanted = query.highlightIds ? new Set(query.highlightIds) : null;
  return withDb(async (db) => {
    const rows = await db.aiResults.toArray();
    return rows
      .map((r) => parseRow(StoredAiResultSchema, r, 'aiResult'))
      .filter(notNull)
      .filter(
        (r) =>
          (query.kind === undefined || r.kind === query.kind) &&
          (wanted === null || r.inputSourceIds.some((id) => wanted.has(id))),
      )
      .sort((a, b) => cmp(b.createdAt, a.createdAt) || cmp(a.id, b.id))
      .slice(0, limit);
  });
}

export async function deleteAiResult(id: string): Promise<void> {
  await withWritableDb((db) => db.aiResults.delete(id));
  await signalChange();
}

/**
 * Marks items as discarded (an accepted item is never un-accepted here). A result whose every item
 * is discarded is not kept: the person said no, and the cache must not serve it again.
 */
export async function discardAiItems(
  resultId: string,
  itemPaths: readonly string[],
): Promise<StoredAiResult> {
  const row = await withWritableDb((db) =>
    db.transaction('rw', db.aiResults, async () => {
      const current = await readResult(db, resultId);
      const paths = aiItemPaths(toResult(current));
      const items = { ...current.items };
      const at = now();
      for (const p of itemPaths) {
        if (!paths.includes(p) || items[p]?.state === 'accepted') continue;
        items[p] = { state: 'discarded', at, edited: false, targets: [] };
      }
      const next = { ...current, items } as StoredAiResult;
      if (paths.every((p) => items[p]?.state === 'discarded')) await db.aiResults.delete(resultId);
      else await db.aiResults.put(asRow(next));
      return next;
    }),
  );
  await signalChange();
  return row;
}

/** Discard every item that has not been accepted. */
export async function rejectAiResult(id: string): Promise<StoredAiResult> {
  const row = await getAiResult(id);
  if (!row) throw new StudyVaultError('not_found', 'AI result not found');
  return discardAiItems(id, aiItemPaths(toResult(row)));
}

export interface AiAcceptInput {
  resultId: string;
  /** Item being accepted (see aiItemPaths). */
  itemPath: string;
  edited: boolean;
  /** Exactly one of knowledgePoint / cards / note. */
  knowledgePoint?: KnowledgePoint;
  /** Deck to create first (when the user chose "new deck"); `cards` then belong to it. */
  deck?: Deck;
  cards?: Card[];
  note?: Note;
}

export interface AiAcceptOutcome {
  result: StoredAiResult;
  /** True when this item had already been accepted: nothing was created again. */
  alreadyAccepted: boolean;
}

/**
 * Creates the user's study objects from one item and records the decision, in ONE transaction: no
 * half-accepted state. Idempotent per item (a double click creates nothing twice). The highlight
 * quote and every existing note are never touched.
 *
 * A result that is `unsupported` is not marked accepted as a whole (engine rule); its supported
 * items can still be taken one by one, and an unsupported one only after the user edited it.
 */
export async function acceptAiItem(input: AiAcceptInput): Promise<AiAcceptOutcome> {
  const given = [input.knowledgePoint, input.cards, input.note].filter((v) => v !== undefined);
  if (given.length !== 1) {
    throw new StudyVaultError('invalid_request', 'Accept exactly one kind of object per item.');
  }
  const kp = input.knowledgePoint
    ? parseInput(KnowledgePoint, input.knowledgePoint, 'knowledge point')
    : undefined;
  const cards = input.cards ? input.cards.map((c) => parseInput(Card, c, 'card')) : undefined;
  const deck = input.deck ? parseInput(Deck, input.deck, 'deck') : undefined;
  const note = input.note ? parseInput(Note, input.note, 'note') : undefined;
  if (cards && cards.length === 0) {
    throw new StudyVaultError('invalid_request', 'There are no cards to add.');
  }
  if (deck && cards?.some((c) => c.deckId !== deck.id)) {
    throw new StudyVaultError('invalid_request', 'The cards do not belong to the new deck.');
  }

  const outcome = await withWritableDb((db) =>
    db.transaction(
      'rw',
      [db.aiResults, db.knowledgePoints, db.decks, db.cards, db.notes, db.highlights, db.sources],
      async (): Promise<AiAcceptOutcome> => {
        const current = await readResult(db, input.resultId);
        if (!aiItemPaths(toResult(current)).includes(input.itemPath)) {
          throw new StudyVaultError('invalid_request', 'Unknown item of this AI result.');
        }
        if (current.items[input.itemPath]?.state === 'accepted') {
          return { result: current, alreadyAccepted: true };
        }
        const inputs = new Set(current.inputSourceIds);
        const linked = unique(
          [
            kp?.highlightId,
            kp?.primaryQuoteId,
            ...(kp?.claims ?? []).flatMap((c) => c.evidenceHighlightIds),
            note?.highlightId,
            ...(cards ?? []).map((c) => c.highlightId),
          ].filter((id): id is string => typeof id === 'string'),
        );
        const quotes = new Map<string, string>();
        for (const id of linked) {
          if (!inputs.has(id)) {
            throw new StudyVaultError(
              'invalid_request',
              'The new item points at a highlight that was not an input of this AI result.',
            );
          }
          quotes.set(id, (await liveHighlight(db, id)).exactQuote);
        }

        const targets: AiItemReview['targets'] = [];
        const ts = now();
        if (kp) {
          await db.knowledgePoints.put(kp);
          targets.push({ table: 'knowledgePoints', id: kp.id });
        }
        if (cards) {
          let deckId = cards[0]!.deckId;
          if (deck) {
            // A deck of that name already exists (a second accept racing the first, or another
            // window): use it instead of creating a twin.
            const same = (await db.decks.toArray())
              .map((r) => parseRow(Deck, r, 'deck'))
              .filter(notNull)
              .find(
                (d) =>
                  d.deletedAt === null &&
                  d.bankId === null &&
                  d.name.toLowerCase() === deck.name.toLowerCase(),
              );
            if (same) deckId = same.id;
            else await db.decks.put(deck);
          } else {
            const deckRow = await db.decks.get(deckId);
            const live = deckRow && parseRow(Deck, deckRow, 'deck');
            if (!live || live.deletedAt !== null) {
              throw new StudyVaultError('not_found', 'The deck for these cards no longer exists.');
            }
            if (cards.some((c) => c.deckId !== live.id)) {
              throw new StudyVaultError('invalid_request', 'All cards must go into one deck.');
            }
          }
          // Provenance is read from the highlight here, never taken from the caller.
          const stored = cards
            .map((c) =>
              c.highlightId === null
                ? c
                : parseInput(
                    Card,
                    { ...c, sourceQuote: quotes.get(c.highlightId) ?? null },
                    'card',
                  ),
            )
            .map((c) => (c.deckId === deckId ? c : { ...c, deckId }));
          await db.cards.bulkPut(stored);
          targets.push(...stored.map((c) => ({ table: 'cards' as const, id: c.id })));
        }
        if (note) {
          if (note.sourceId !== null && !(await db.sources.get(note.sourceId))) {
            throw new StudyVaultError('not_found', 'The note’s source was not found.');
          }
          await db.notes.put(note);
          if (note.highlightId !== null) await touchHighlights(db, [note.highlightId], ts);
          targets.push({ table: 'notes', id: note.id });
        }

        const items = {
          ...current.items,
          [input.itemPath]: { state: 'accepted' as const, at: ts, edited: input.edited, targets },
        };
        let next = { ...current, items } as StoredAiResult;
        if (current.verificationState !== 'unsupported') {
          const accepted = acceptResult(toResult(current), Date.now());
          next = {
            ...next,
            acceptedByUserAt: accepted.acceptedByUserAt,
            acceptedAt: accepted.acceptedByUserAt,
            verificationState: accepted.verificationState,
          } as StoredAiResult;
        }
        await db.aiResults.put(asRow(next));
        return { result: next, alreadyAccepted: false };
      },
    ),
  );
  if (!outcome.alreadyAccepted) await signalChange();
  return outcome;
}

// ---------------------------------------------------------------------------------------------
// AiCache port
// ---------------------------------------------------------------------------------------------

/** The durable cache of @ai over the aiResults table (index inputFingerprint). */
export function createAiCache(): AiCache {
  return {
    async get(fingerprint) {
      const rows = await withDb((db) =>
        db.aiResults.where('inputFingerprint').equals(fingerprint).toArray(),
      );
      const newest = rows
        .map((r) => parseRow(StoredAiResultSchema, r, 'aiResult'))
        .filter(notNull)
        .sort((a, b) => cmp(b.createdAt, a.createdAt))[0];
      return newest ? toResult(newest) : null;
    },
    async put(result) {
      await saveAiResult(result);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Reading the vault for the AI views
// ---------------------------------------------------------------------------------------------

export interface AiSourceRef {
  id: string;
  kind: 'highlight' | 'note';
  /** The immutable quote (highlight) or the note body. */
  text: string;
  /** The page/document the passage came from (null for a note without one). */
  sourceId: string | null;
  sourceTitle: string | null;
  host: string | null;
  deleted: boolean;
}

/** Resolves chunk ids (highlights, then notes) to what the vault holds. Unknown ids are absent. */
export async function resolveAiSources(ids: readonly string[]): Promise<Map<string, AiSourceRef>> {
  const wanted = unique(ids);
  return withDb((db) =>
    db.transaction('r', [db.highlights, db.notes, db.sources], async () => {
      const out = new Map<string, AiSourceRef>();
      if (wanted.length === 0) return out;
      const highlights = (await db.highlights.bulkGet(wanted))
        .map((r) => (r ? parseRow(Highlight, r, 'highlight') : null))
        .filter(notNull);
      const sources = await readSources(
        db,
        highlights.map((h) => h.sourceId),
      );
      for (const h of highlights) {
        const s = sources.get(h.sourceId);
        out.set(h.id, {
          id: h.id,
          kind: 'highlight',
          text: h.exactQuote,
          sourceId: h.sourceId,
          sourceTitle: s?.title ?? null,
          host: s?.host ?? null,
          deleted: h.deletedAt !== null,
        });
      }
      const rest = wanted.filter((id) => !out.has(id));
      for (const row of await db.notes.bulkGet(rest)) {
        const n = row ? parseRow(Note, row, 'note') : null;
        if (n) {
          out.set(n.id, {
            id: n.id,
            kind: 'note',
            text: n.body,
            sourceId: n.sourceId,
            sourceTitle: n.title || null,
            host: null,
            deleted: n.deletedAt !== null,
          });
        }
      }
      return out;
    }),
  );
}

/** Live decks, by name, for the "add flashcards to" choice. */
export async function listAiDeckChoices(): Promise<{ id: string; name: string }[]> {
  return withDb(async (db) => {
    const rows = await db.decks.toArray();
    return rows
      .map((r) => parseRow(Deck, r, 'deck'))
      .filter(notNull)
      .filter((d) => d.deletedAt === null)
      .map((d) => ({ id: d.id, name: d.name }))
      .sort((a, b) => cmp(a.name.toLowerCase(), b.name.toLowerCase()) || cmp(a.id, b.id));
  });
}

export async function countAiResults(): Promise<number> {
  return withDb((db) => db.aiResults.count());
}

/**
 * "Delete all AI data": results (the cache), the usage ledger, settings and the API key. Notes,
 * cards and knowledge points the user accepted are the user's own and stay (still marked as
 * AI-made); their `aiResultId` then points at a result that no longer exists.
 */
export async function clearAiData(): Promise<void> {
  await withWritableDb((db) =>
    db.transaction('rw', [db.aiResults, db.meta], async () => {
      await db.aiResults.clear();
      await db.meta.bulkDelete([KEY_SETTINGS, KEY_API_KEY, KEY_BUDGET]);
    }),
  );
  await signalChange();
}
