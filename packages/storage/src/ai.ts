import { z } from 'zod';
import {
  AI_TASK_KINDS,
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
import { cardEvent } from '@study/game';
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
import { addMissing } from './game';
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

/** Wire protocols. `codex_responses` (ChatGPT Codex OAuth) is the primary provider only. */
export const AI_PROVIDERS = ['openai_compatible', 'anthropic', 'codex_responses'] as const;
export type AiProviderId = (typeof AI_PROVIDERS)[number];
/** What a fallback provider can be (the Codex login belongs to the primary provider). */
export const AI_PROFILE_PROVIDERS = ['openai_compatible', 'anthropic'] as const;

/** The preset a provider was set up from: drives model lists, reasoning mapping and usage. */
export const AI_VENDORS = [
  'openai',
  'anthropic',
  'ollama',
  'lmstudio',
  'custom',
  'ubag',
  'nvidia_nim',
  'opencode_go',
  'openrouter',
  'chatgpt_codex',
] as const;
export type AiVendorId = (typeof AI_VENDORS)[number];

export const AI_EFFORTS = ['', 'minimal', 'low', 'medium', 'high', 'max'] as const;
export type AiEffort = (typeof AI_EFFORTS)[number];
/** `basic`: the stored key is `user:password`, sent as HTTP Basic (UBAG's public gateway). */
export const AI_AUTH_SCHEMES = ['bearer', 'basic'] as const;
export type AiAuthScheme = (typeof AI_AUTH_SCHEMES)[number];

const KEY_SETTINGS = 'aiSettings';
const KEY_API_KEY = 'aiKey';
const KEY_PROFILE_KEYS = 'aiProfileKeys';
const KEY_BUDGET = 'aiBudget';
const KEY_CODEX_AUTH = 'aiCodexAuth';

/**
 * `meta` keys that hold secrets: every export, backup and snapshot must leave these rows out
 * (`meta` is not a backup table at all, and it is local-only for sync). `aiKey` is the primary
 * provider's key; `aiProfileKeys` holds one `{apiKey, origin}` per fallback provider.
 */
export const AI_SECRET_META_KEYS: readonly string[] = [
  KEY_API_KEY,
  KEY_PROFILE_KEYS,
  KEY_CODEX_AUTH,
];

// ---------------------------------------------------------------------------------------------
// Settings (meta 'aiSettings')
// ---------------------------------------------------------------------------------------------

/** The id the primary provider (the top-level fields of the settings) goes by in routes. */
export const PRIMARY_PROFILE_ID = 'primary';
/** Providers that can follow the primary one. */
export const AI_MAX_FALLBACKS = 3;

const AiPricingSchema = z.strictObject({
  inputUsdPerMTok: z.number().min(0).max(1_000_000),
  outputUsdPerMTok: z.number().min(0).max(1_000_000),
});

/** One provider after the primary one, with its own address, model, price list and key. */
export const AiProfileSchema = z.strictObject({
  id: z.string().regex(/^p-[a-z0-9]{6,20}$/),
  label: z.string().trim().min(1).max(40),
  provider: z.enum(AI_PROFILE_PROVIDERS),
  baseUrl: z.string().trim().max(300),
  model: z.string().trim().max(120),
  jsonMode: z.boolean(),
  maxTokensParam: z.enum(['max_tokens', 'max_completion_tokens']),
  pricing: AiPricingSchema.nullable(),
  vendor: z.enum(AI_VENDORS).default('custom'),
  /** '' = the model's own default. */
  reasoningEffort: z.enum(AI_EFFORTS).default(''),
  authScheme: z.enum(AI_AUTH_SCHEMES).default('bearer'),
  /** Used when an earlier provider is not answering (network error, 5xx, timeout), never otherwise. */
  fallback: z.boolean(),
});
export type AiProfile = z.infer<typeof AiProfileSchema>;

export const AiSettingsSchema = z
  .strictObject({
    provider: z.enum(AI_PROVIDERS),
    /** '' = the provider's default address (Anthropic only). */
    baseUrl: z.string().trim().max(300),
    model: z.string().trim().max(120),
    /** Ask OpenAI-compatible servers for `response_format: json_object` (some servers reject it). */
    jsonMode: z.boolean(),
    maxTokensParam: z.enum(['max_tokens', 'max_completion_tokens']),
    vendor: z.enum(AI_VENDORS).default('custom'),
    reasoningEffort: z.enum(AI_EFFORTS).default(''),
    authScheme: z.enum(AI_AUTH_SCHEMES).default('bearer'),
    limits: BudgetLimits,
    /** null = unknown: estimates show "unknown" and a cost cap cannot be enforced. */
    pricing: AiPricingSchema.nullable(),
    preferences: z.strictObject({
      flashcardCount: z.number().int().min(1).max(20),
      mcqChoices: z.number().int().min(3).max(6),
    }),
    /** After the primary provider, in the order they are tried. */
    fallbacks: z.array(AiProfileSchema).max(AI_MAX_FALLBACKS),
    /**
     * Task kind -> provider that is tried FIRST for it ('primary' or a profile id); the others follow
     * in list order. A kind that is absent starts with the primary provider.
     */
    routes: z.record(z.string().max(40), z.string().max(40)),
  })
  .superRefine((v, ctx) => {
    const ids = v.fallbacks.map((p) => p.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: 'custom', message: 'duplicate provider ids' });
    }
  });
export type AiSettings = z.infer<typeof AiSettingsSchema>;

/** The fields every provider has, whether it is the primary one or a fallback. */
export type AiProfileSettings = Pick<
  AiSettings,
  | 'provider'
  | 'baseUrl'
  | 'model'
  | 'jsonMode'
  | 'maxTokensParam'
  | 'pricing'
  | 'vendor'
  | 'reasoningEffort'
  | 'authScheme'
>;

export function defaultAiSettings(): AiSettings {
  return {
    provider: 'openai_compatible',
    baseUrl: '',
    model: '',
    jsonMode: true,
    maxTokensParam: 'max_tokens',
    vendor: 'custom',
    reasoningEffort: '',
    authScheme: 'bearer',
    limits: { maxRequestsPerDay: 30, maxCostUsdPerDay: null },
    pricing: null,
    preferences: { flashcardCount: 5, mcqChoices: 4 },
    fallbacks: [],
    routes: {},
  };
}

const KINDS: ReadonlySet<string> = new Set(AI_TASK_KINDS);

/**
 * A stored row as settings. A fallback that no longer validates is dropped (the primary provider
 * and everything else survive); a route to a provider that is gone, or for an unknown task, is dropped.
 */
function readSettings(stored: unknown): AiSettings {
  const defaults = defaultAiSettings();
  if (typeof stored !== 'object' || stored === null) return defaults;
  const raw = stored as Record<string, unknown>;
  const fallbacks = (Array.isArray(raw.fallbacks) ? raw.fallbacks : [])
    .flatMap((p) => {
      const r = AiProfileSchema.safeParse(p);
      return r.success ? [r.data] : [];
    })
    .slice(0, AI_MAX_FALLBACKS);
  const storedRoutes =
    typeof raw.routes === 'object' && raw.routes !== null && !Array.isArray(raw.routes)
      ? raw.routes
      : {};
  const parsed = AiSettingsSchema.safeParse({
    ...defaults,
    ...raw,
    fallbacks,
    routes: storedRoutes,
  });
  if (!parsed.success) return defaults;
  const ids = new Set<string>([PRIMARY_PROFILE_ID, ...parsed.data.fallbacks.map((p) => p.id)]);
  const routes = Object.fromEntries(
    Object.entries(parsed.data.routes).filter(([kind, id]) => KINDS.has(kind) && ids.has(id)),
  );
  return { ...parsed.data, routes };
}

export async function getAiSettings(): Promise<AiSettings> {
  const row = await withDb((db) => db.meta.get(KEY_SETTINGS));
  return readSettings(row?.value);
}

async function getSettingsIn(db: StudyVaultDb): Promise<AiSettings> {
  return readSettings((await db.meta.get(KEY_SETTINGS))?.value);
}

export async function setAiSettings(next: AiSettings): Promise<AiSettings> {
  const value = parseInput(AiSettingsSchema, next, 'AI settings');
  await withWritableDb((db) => db.meta.put({ key: KEY_SETTINGS, value, updatedAt: now() }));
  await signalChange();
  return value;
}

const ProfileKeysRow = z.record(
  z.string().max(40),
  z.strictObject({ apiKey: z.string().min(1), origin: z.string().min(1) }),
);

/**
 * Read-modify-write of the settings in one transaction, so the primary form and the provider list
 * (two editors of one row) never overwrite each other. The keys of a fallback that was removed go
 * in the same transaction; routes to it are dropped.
 */
export async function updateAiSettings(
  mutate: (current: AiSettings) => AiSettings,
): Promise<AiSettings> {
  const value = await withWritableDb((db) =>
    db.transaction('rw', db.meta, async () => {
      const row = await db.meta.get(KEY_SETTINGS);
      const next = parseInput(AiSettingsSchema, mutate(readSettings(row?.value)), 'AI settings');
      const ids = new Set(next.fallbacks.map((p) => p.id));
      const routes = Object.fromEntries(
        Object.entries(next.routes).filter(([, id]) => id === PRIMARY_PROFILE_ID || ids.has(id)),
      );
      const value = { ...next, routes };
      await db.meta.put({ key: KEY_SETTINGS, value, updatedAt: now() });
      const keys = ProfileKeysRow.safeParse((await db.meta.get(KEY_PROFILE_KEYS))?.value);
      if (keys.success) {
        const kept = Object.fromEntries(Object.entries(keys.data).filter(([id]) => ids.has(id)));
        if (Object.keys(kept).length !== Object.keys(keys.data).length) {
          if (Object.keys(kept).length === 0) await db.meta.delete(KEY_PROFILE_KEYS);
          else await db.meta.put({ key: KEY_PROFILE_KEYS, value: kept, updatedAt: now() });
        }
      }
      return value;
    }),
  );
  await signalChange();
  return value;
}

/** A new id for a fallback provider. */
export const newAiProfileId = (): string =>
  `p-${Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => (b % 36).toString(36)).join('')}`;

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
  codex_responses: 'https://chatgpt.com/backend-api/codex',
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

/** The patterns of every provider that can receive text: the primary one and the fallbacks. */
export async function getAiEndpointPatterns(): Promise<string[]> {
  const s = await getAiSettings();
  return unique(
    [s, ...s.fallbacks]
      .map((p) => checkAiEndpoint(p.provider, p.baseUrl))
      .flatMap((check) => (check.ok ? [check.pattern] : [])),
  );
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

// Keys of the fallback providers: one meta row `aiProfileKeys`, { [profileId]: { apiKey, origin } }.
// Same containment as the primary key (extension-origin IndexedDB only, bound to the origin it was
// saved for, never in a result, backup, export or sync row, removed by the same wipes).

const profileKeys = (value: unknown): z.infer<typeof ProfileKeysRow> => {
  const parsed = ProfileKeysRow.safeParse(value);
  return parsed.success ? parsed.data : {};
};

/** Present / origin / last four characters of each fallback provider's key; never the key. */
export async function getAiProfileKeyInfos(): Promise<Record<string, AiKeyInfo>> {
  const row = await withDb((db) => db.meta.get(KEY_PROFILE_KEYS));
  return Object.fromEntries(
    Object.entries(profileKeys(row?.value)).map(([id, k]) => [
      id,
      { present: true, origin: k.origin, last4: k.apiKey.slice(-4) },
    ]),
  );
}

/** The only reader of a fallback provider's secret (with `getAiApiKey` for the primary one). */
export async function getAiProfileApiKey(
  profileId: string,
  origin: string,
): Promise<string | null> {
  const row = await withDb((db) => db.meta.get(KEY_PROFILE_KEYS));
  const key = profileKeys(row?.value)[profileId];
  return key && key.origin === origin ? key.apiKey : null;
}

export async function setAiProfileApiKey(
  profileId: string,
  apiKey: string,
  origin: string,
): Promise<void> {
  const key = apiKey.trim();
  if (!API_KEY_SHAPE.test(key)) {
    throw new StudyVaultError(
      'invalid_request',
      'That does not look like an API key: it must be 8-512 visible characters without spaces.',
    );
  }
  await withWritableDb((db) =>
    db.transaction('rw', db.meta, async () => {
      // A key only ever belongs to a provider that exists.
      if (!(await getSettingsIn(db)).fallbacks.some((p) => p.id === profileId)) {
        throw new StudyVaultError('not_found', 'That provider no longer exists.');
      }
      const all = profileKeys((await db.meta.get(KEY_PROFILE_KEYS))?.value);
      all[profileId] = { apiKey: key, origin };
      await db.meta.put({ key: KEY_PROFILE_KEYS, value: all, updatedAt: now() });
    }),
  );
  await signalChange();
}

export async function clearAiProfileApiKey(profileId: string): Promise<void> {
  await withWritableDb((db) =>
    db.transaction('rw', db.meta, async () => {
      const all = profileKeys((await db.meta.get(KEY_PROFILE_KEYS))?.value);
      if (!(profileId in all)) return;
      delete all[profileId];
      if (Object.keys(all).length === 0) await db.meta.delete(KEY_PROFILE_KEYS);
      else await db.meta.put({ key: KEY_PROFILE_KEYS, value: all, updatedAt: now() });
    }),
  );
  await signalChange();
}

// ---------------------------------------------------------------------------------------------
// ChatGPT Codex login (meta 'aiCodexAuth'): OAuth tokens, same containment as the API key
// ---------------------------------------------------------------------------------------------

export const CodexAuthRow = z.strictObject({
  accessToken: z.string().min(1).max(8192),
  refreshToken: z.string().min(1).max(8192),
  /** Epoch ms after which the access token must be refreshed. */
  expiresAt: z.number().int().min(0),
  accountId: z.string().min(1).max(200),
});
export type CodexAuth = z.infer<typeof CodexAuthRow>;

export async function getCodexAuth(): Promise<CodexAuth | null> {
  const row = await withDb((db) => db.meta.get(KEY_CODEX_AUTH));
  const parsed = CodexAuthRow.safeParse(row?.value);
  return parsed.success ? parsed.data : null;
}

export async function setCodexAuth(auth: CodexAuth): Promise<void> {
  const value = parseInput(CodexAuthRow, auth, 'Codex login');
  await withWritableDb((db) => db.meta.put({ key: KEY_CODEX_AUTH, value, updatedAt: now() }));
  await signalChange();
}

export async function clearCodexAuth(): Promise<void> {
  await withWritableDb((db) => db.meta.delete(KEY_CODEX_AUTH));
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
  /** `explain` and `chat`: the question that was asked (the engine's result does not keep it). */
  question: z.string().max(4000).optional(),
  /** `chat` only: the conversation this turn belongs to (see chat.ts). */
  threadId: z.string().max(40).optional(),
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
  extra: { question?: string; threadId?: string } = {},
): Promise<StoredAiResult> {
  const parsed = parseInput(AiResult, result, 'AI result');
  const question = extra.question?.trim() || undefined;
  const threadId = extra.threadId;
  const row = await withWritableDb((db) =>
    db.transaction('rw', [db.aiResults, db.highlights], async () => {
      const existing = await db.aiResults.get(parsed.id);
      if (existing) {
        const current = await readResult(db, parsed.id);
        if (
          threadId !== undefined &&
          current.threadId !== undefined &&
          current.threadId !== threadId
        ) {
          // The same answer served from the cache to another conversation: a row of its own there.
          const copy = {
            ...current,
            id: `${parsed.id.slice(0, 40)}-${Math.random().toString(36).slice(2, 10)}`,
            threadId,
            ...(question === undefined ? {} : { question }),
          } as StoredAiResult;
          await db.aiResults.put(asRow(copy));
          return copy;
        }
        if (
          (question === undefined || current.question !== undefined) &&
          (threadId === undefined || current.threadId !== undefined)
        ) {
          return current;
        }
        const next = {
          ...current,
          ...(current.question === undefined && question !== undefined ? { question } : {}),
          ...(current.threadId === undefined && threadId !== undefined ? { threadId } : {}),
        } as StoredAiResult;
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
        ...(threadId === undefined ? {} : { threadId }),
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
      [
        db.aiResults,
        db.knowledgePoints,
        db.decks,
        db.cards,
        db.notes,
        db.highlights,
        db.sources,
        db.gameEvents,
      ],
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
          await addMissing(db.gameEvents, stored.map(cardEvent));
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
      await db.meta.bulkDelete([
        KEY_SETTINGS,
        KEY_API_KEY,
        KEY_PROFILE_KEYS,
        KEY_BUDGET,
        KEY_CODEX_AUTH,
        'aiChatThreads',
      ]);
    }),
  );
  await signalChange();
}
