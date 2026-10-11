import { uuidv7 } from 'uuidv7';
import type { z } from 'zod';
import {
  Highlight,
  HighlightBank,
  SCHEMA_VERSION,
  StudyVaultError,
  type Highlight as HighlightRow,
  type Source as SourceRow,
} from '@shared';
import {
  DEFAULT_DECK_SETTINGS,
  DEFAULT_LEARN_AHEAD_MS,
  DEFAULT_ROLLOVER_HOUR,
  Card,
  Deck,
  DeckSettings,
  KnowledgePoint,
  Rating,
  ReviewLog,
  ReviewSession,
  applyBacklogPlan,
  backlog,
  buildBasic,
  buildCloze,
  buildCompare,
  buildDefinition,
  buildMcq,
  buildQueue,
  buryCard,
  countToday,
  countsByBank,
  countsByDeck,
  createCard,
  draftFromKnowledgePoint,
  isValidTimeZone,
  mcqIssues,
  parseCloze,
  parseSession,
  planBacklogRecovery,
  renderCloze,
  reschedule,
  resetCard,
  resumeSession,
  review,
  segmentsToText,
  setSuspended,
  startSession,
  studyDayNumber,
  studyDayStartMs,
  toIso,
  toMs,
  undoReview,
  unburyCard,
  type BacklogPlan,
  type BacklogStats,
  type BankCounts,
  type Built,
  type CardDraft,
  type CompareRow,
  type Creator,
  type DateInput,
  type DayBoundary,
  type DeckCounts,
  type KnowledgePointTemplate,
  type QueueResult,
  type Random,
  type ResumeResult,
  type SourceRef,
  type VerificationStatus,
} from '@study';
import { registerTableSchema } from './registry';
import {
  cmp,
  isDeleted,
  liveBank,
  liveHighlight,
  notNull,
  now as nowIso,
  parseRow,
  readBanks,
  readSources,
  requireId,
  signalChange,
  unique,
} from './core';
import { withDb, withWritableDb, type MetaRow, type StudyVaultDb } from './db';

/**
 * Retention repositories: decks, knowledge points, cards, review logs, the study queue and the
 * persisted review session, over the tables Dexie v2 already declares. The pure rules (scheduling,
 * queue, cloze, analytics) live in @study; this file only loads rows, validates them on the way in
 * and out, and commits them atomically.
 *
 * Rules every function here follows:
 *  - the clock and the study-day boundary are injectable (`StudyClockOptions`), so day rollover and
 *    DST are testable; without them the device clock and the device time zone are used;
 *  - a card and the ReviewLog of its answer are written in ONE transaction;
 *  - the source link of a card (highlightId + quote snapshot) is read from the highlight here, never
 *    taken from the caller, so provenance cannot be forged or edited through a card;
 *  - IndexedDB cannot index booleans or nested paths here, so suspended/state are filtered in code
 *    after the `[deckId+dueAt]`/`dueAt` index narrowed the rows;
 *  - every committed mutation signals dataEpoch, so every viewer (side panel, popup, review page)
 *    refreshes its counts.
 */

registerTableSchema('decks', Deck);
registerTableSchema('knowledgePoints', KnowledgePoint);
registerTableSchema('cards', Card);
registerTableSchema('reviewLogs', ReviewLog);

// ---------------------------------------------------------------------------------------------
// Clock, boundary and small helpers
// ---------------------------------------------------------------------------------------------

export interface StudyClockOptions {
  /** Defaults to the device clock. */
  now?: DateInput;
  /** Defaults to the device time zone with the default 04:00 rollover (`systemBoundary`). */
  boundary?: DayBoundary;
}

/** Queue preferences. Defaults are the engine's own (see @study queue.ts). */
export interface QueuePrefs {
  interleave?: 'deck' | 'bank' | 'none';
  order?: 'retrievability' | 'due';
  newOrder?: 'created' | 'random';
  learnAheadMs?: number;
  /** Needed for `newOrder: 'random'`; defaults to Math.random. */
  random?: Random;
}

/** Device time zone (IANA) with Anki's default rollover; UTC when the platform will not say. */
export function systemBoundary(): DayBoundary {
  let timeZone: string;
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    timeZone = 'UTC';
  }
  return {
    timeZone: isValidTimeZone(timeZone) ? timeZone : 'UTC',
    rolloverHour: DEFAULT_ROLLOVER_HOUR,
  };
}

interface Clock {
  nowMs: number;
  nowIso: string;
  boundary: DayBoundary;
}

function clockOf(opts: StudyClockOptions = {}): Clock {
  const nowMs = opts.now === undefined ? Date.now() : toMs(opts.now);
  return { nowMs, nowIso: toIso(nowMs), boundary: opts.boundary ?? systemBoundary() };
}

/** Readable validation failure (Zod's own message is a JSON dump). */
function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const detail = result.error.issues
    .map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ');
  throw new StudyVaultError('invalid_request', `Invalid ${what}: ${detail}`);
}

const STUDY_TABLES = (db: StudyVaultDb) => [
  db.banks,
  db.decks,
  db.cards,
  db.reviewLogs,
  db.knowledgePoints,
  db.highlights,
  db.highlightBanks,
];

// ---------------------------------------------------------------------------------------------
// Row readers (all validate; a row that does not parse is invisible, never overwritten)
// ---------------------------------------------------------------------------------------------

async function readDeck(db: StudyVaultDb, id: string): Promise<Deck | null> {
  const row = await db.decks.get(id);
  return row ? parseRow(Deck, row, 'deck') : null;
}

async function liveDeck(db: StudyVaultDb, id: string): Promise<Deck> {
  const deck = await readDeck(db, id);
  if (!deck || deck.deletedAt !== null) throw new StudyVaultError('not_found', 'Deck not found');
  return deck;
}

async function readCard(db: StudyVaultDb, id: string): Promise<Card | null> {
  const row = await db.cards.get(id);
  return row ? parseRow(Card, row, 'card') : null;
}

async function liveCard(db: StudyVaultDb, id: string): Promise<Card> {
  const card = await readCard(db, id);
  if (!card || card.deletedAt !== null) throw new StudyVaultError('not_found', 'Card not found');
  return card;
}

async function readKnowledgePoint(db: StudyVaultDb, id: string): Promise<KnowledgePoint | null> {
  const row = await db.knowledgePoints.get(id);
  return row ? parseRow(KnowledgePoint, row, 'knowledge point') : null;
}

async function liveKnowledgePoint(db: StudyVaultDb, id: string): Promise<KnowledgePoint> {
  const kp = await readKnowledgePoint(db, id);
  if (!kp || kp.deletedAt !== null) {
    throw new StudyVaultError('not_found', 'Knowledge point not found');
  }
  return kp;
}

async function allDecks(db: StudyVaultDb): Promise<Deck[]> {
  return (await db.decks.toArray())
    .map((r) => parseRow(Deck, r, 'deck'))
    .filter(notNull)
    .filter((d) => d.deletedAt === null)
    .sort((a, b) => cmp(a.name.toLowerCase(), b.name.toLowerCase()) || cmp(a.id, b.id));
}

const parseCards = (rows: unknown[]): Card[] =>
  rows.map((r) => parseRow(Card, r, 'card')).filter(notNull);

// ---------------------------------------------------------------------------------------------
// Decks
// ---------------------------------------------------------------------------------------------

export async function listDecks(): Promise<Deck[]> {
  return withDb((db) => allDecks(db));
}

export async function getDeck(id: string): Promise<Deck | null> {
  requireId(id);
  return withDb(async (db) => {
    const deck = await readDeck(db, id);
    return deck && deck.deletedAt === null ? deck : null;
  });
}

function newDeck(
  ts: string,
  input: { name: string; bankId: string | null; settings?: Partial<DeckSettings> },
): Deck {
  return parseOrThrow(
    Deck,
    {
      id: uuidv7(),
      schemaVersion: SCHEMA_VERSION,
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      bankId: input.bankId,
      name: input.name,
      settings: { ...DEFAULT_DECK_SETTINGS, ...input.settings },
    },
    'deck',
  );
}

export async function createDeck(input: {
  name: string;
  bankId?: string | null;
  settings?: Partial<DeckSettings>;
}): Promise<Deck> {
  const bankId = input.bankId ?? null;
  if (bankId !== null) requireId(bankId);
  const deck = await withWritableDb((db) =>
    db.transaction('rw', [db.banks, db.decks], async () => {
      if (bankId !== null) await liveBank(db, bankId);
      const created = newDeck(nowIso(), { name: input.name, bankId, settings: input.settings });
      await db.decks.add(created);
      return created;
    }),
  );
  await signalChange();
  return deck;
}

/**
 * The deck that studies a bank (the oldest live one), created on first use. `bankId: null` is the
 * free-standing "General" deck. The lookup and the insert share one readwrite transaction, so two
 * windows cannot both create it.
 */
async function ensureDeckInTx(db: StudyVaultDb, bankId: string | null, ts: string): Promise<Deck> {
  const decks = await allDecks(db);
  const existing = decks
    .filter((d) => d.bankId === bankId)
    .sort((a, b) => cmp(a.createdAt, b.createdAt) || cmp(a.id, b.id))[0];
  if (existing) return existing;
  let name = 'General';
  if (bankId !== null) name = (await liveBank(db, bankId)).name;
  const created = newDeck(ts, { name, bankId });
  await db.decks.add(created);
  return created;
}

export async function ensureDeckForBank(bankId: string | null): Promise<Deck> {
  if (bankId !== null) requireId(bankId);
  const deck = await withWritableDb((db) =>
    db.transaction('rw', [db.banks, db.decks], () => ensureDeckInTx(db, bankId, nowIso())),
  );
  await signalChange();
  return deck;
}

export async function renameDeck(id: string, name: string): Promise<Deck> {
  requireId(id);
  const deck = await withWritableDb((db) =>
    db.transaction('rw', db.decks, async () => {
      const current = await liveDeck(db, id);
      const next = parseOrThrow(Deck, { ...current, name, updatedAt: nowIso() }, 'deck');
      await db.decks.put(next);
      return next;
    }),
  );
  await signalChange();
  return deck;
}

/**
 * Change a deck's scheduling rules. Applies from the next answer on: stored cards, due dates and
 * history are not rewritten.
 */
export async function updateDeckSettings(id: string, patch: Partial<DeckSettings>): Promise<Deck> {
  requireId(id);
  const deck = await withWritableDb((db) =>
    db.transaction('rw', db.decks, async () => {
      const current = await liveDeck(db, id);
      const settings = parseOrThrow(
        DeckSettings,
        { ...current.settings, ...patch },
        'deck settings',
      );
      const next = { ...current, settings, updatedAt: nowIso() };
      await db.decks.put(next);
      return next;
    }),
  );
  await signalChange();
  return deck;
}

/**
 * Soft-delete a deck. Its cards are moved to `moveCardsTo` when given, otherwise soft-deleted with
 * it (nothing is hard-deleted here, so `restoreDeck` brings everything back).
 */
export async function deleteDeck(
  id: string,
  options: { moveCardsTo?: string } = {},
): Promise<{ moved: number; deleted: number }> {
  requireId(id);
  if (options.moveCardsTo !== undefined) {
    requireId(options.moveCardsTo);
    if (options.moveCardsTo === id) {
      throw new StudyVaultError('invalid_request', 'Choose a different deck to move the cards to.');
    }
  }
  const result = await withWritableDb((db) =>
    db.transaction('rw', [db.decks, db.cards], async () => {
      const deck = await liveDeck(db, id);
      if (options.moveCardsTo !== undefined) await liveDeck(db, options.moveCardsTo);
      const ts = nowIso();
      const cards = parseCards(await db.cards.where('deckId').equals(id).toArray()).filter(
        (c) => c.deletedAt === null,
      );
      const next = cards.map((c) =>
        options.moveCardsTo !== undefined
          ? { ...c, deckId: options.moveCardsTo, updatedAt: ts }
          : { ...c, deletedAt: ts, updatedAt: ts },
      );
      if (next.length > 0) await db.cards.bulkPut(next);
      await db.decks.put({ ...deck, deletedAt: ts, updatedAt: ts });
      return options.moveCardsTo !== undefined
        ? { moved: next.length, deleted: 0 }
        : { moved: 0, deleted: next.length };
    }),
  );
  await signalChange();
  return result;
}

/** Undo `deleteDeck` without `moveCardsTo`: the deck and the cards deleted with it come back. */
export async function restoreDeck(id: string): Promise<Deck> {
  requireId(id);
  const deck = await withWritableDb((db) =>
    db.transaction('rw', [db.decks, db.cards], async () => {
      const current = await readDeck(db, id);
      if (!current) throw new StudyVaultError('not_found', 'Deck not found');
      const ts = nowIso();
      const restored = { ...current, deletedAt: null, updatedAt: ts };
      const stamp = current.deletedAt;
      const cards = parseCards(await db.cards.where('deckId').equals(id).toArray()).filter(
        (c) => c.deletedAt !== null && stamp !== null && c.deletedAt === stamp,
      );
      if (cards.length > 0) {
        await db.cards.bulkPut(cards.map((c) => ({ ...c, deletedAt: null, updatedAt: ts })));
      }
      await db.decks.put(restored);
      return restored;
    }),
  );
  await signalChange();
  return deck;
}

// ---------------------------------------------------------------------------------------------
// Card templates (pure): what the authoring UI previews and what the repo stores
// ---------------------------------------------------------------------------------------------

export type TemplateInput =
  | { template: 'basic'; question: string; answer: string; explanation?: string; tags?: string[] }
  | { template: 'definition'; term: string; definition: string; example?: string; tags?: string[] }
  | { template: 'compare'; left: string; right: string; rows: CompareRow[]; tags?: string[] }
  | {
      template: 'cloze';
      markup: string;
      /** One card per deletion number (default) or a single card hiding everything. */
      perDeletion?: boolean;
      explanation?: string;
      tags?: string[];
    }
  | {
      template: 'mcq';
      stem: string;
      choices: string[];
      correctIndex: number;
      explanation?: string;
      /** Store the choices shuffled. Default false: review shuffles the display order itself. */
      shuffle?: boolean;
      tags?: string[];
    };

export type TemplateName = TemplateInput['template'];
export const TEMPLATE_NAMES: readonly TemplateName[] = [
  'basic',
  'cloze',
  'definition',
  'compare',
  'mcq',
];

export interface DraftMeta {
  createdBy?: Creator;
  aiResultId?: string | null;
  requireVerification?: boolean;
  random?: Random;
}

/**
 * Turn user-supplied template fields into validated card drafts. No text is generated: every
 * field comes from the person (or from an AI result they accepted). A cloze template can yield
 * several drafts (one per deletion number).
 */
export function buildTemplateDrafts(
  input: TemplateInput,
  source: SourceRef,
  meta: DraftMeta = {},
): Built<CardDraft[]> {
  const common = {
    source,
    tags: input.tags,
    createdBy: meta.createdBy,
    aiResultId: meta.aiResultId,
    requireVerification: meta.requireVerification,
  };
  const one = (built: Built<CardDraft>): Built<CardDraft[]> =>
    built.ok ? { ok: true, value: [built.value] } : built;
  switch (input.template) {
    case 'basic':
      return one(
        buildBasic({
          ...common,
          question: input.question,
          answer: input.answer,
          ...(input.explanation === undefined ? {} : { explanation: input.explanation }),
        }),
      );
    case 'definition':
      return one(
        buildDefinition({
          ...common,
          term: input.term,
          definition: input.definition,
          ...(input.example === undefined ? {} : { example: input.example }),
        }),
      );
    case 'compare':
      return one(
        buildCompare({ ...common, left: input.left, right: input.right, rows: input.rows }),
      );
    case 'cloze':
      return buildCloze({
        ...common,
        markup: input.markup,
        ...(input.perDeletion === undefined ? {} : { perDeletion: input.perDeletion }),
        ...(input.explanation === undefined ? {} : { explanation: input.explanation }),
      });
    case 'mcq':
      return one(
        buildMcq({
          ...common,
          stem: input.stem,
          choices: input.choices,
          correctIndex: input.correctIndex,
          shuffle: input.shuffle === true,
          random: meta.random ?? Math.random,
          ...(input.explanation === undefined ? {} : { explanation: input.explanation }),
        }),
      );
  }
}

const issuesToError = (issues: string[]) =>
  new StudyVaultError('invalid_request', issues.join(' '));

// ---------------------------------------------------------------------------------------------
// Knowledge points
// ---------------------------------------------------------------------------------------------

export interface KnowledgePointInput {
  highlightId: string;
  /** The highlight whose quote is the point's primary evidence. Defaults to `highlightId`. */
  primaryQuoteId?: string;
  shortOneLiner: string;
  examPearl?: string | null;
  misconception?: string | null;
  claims?: KnowledgePoint['claims'];
  /** 'ai' arrives with Phase 5; such a point is never accepted or verified on creation. */
  createdBy?: Creator;
}

export interface KnowledgePointPatch {
  shortOneLiner?: string;
  examPearl?: string | null;
  misconception?: string | null;
  claims?: KnowledgePoint['claims'];
  /** User-only: nothing in StudyVault sets this on its own. */
  verificationStatus?: VerificationStatus;
}

async function assertEvidenceExists(db: StudyVaultDb, claims: KnowledgePoint['claims']) {
  const ids = unique(claims.flatMap((c) => c.evidenceHighlightIds));
  for (const id of ids) {
    const row = await db.highlights.get(id);
    if (!row || isDeleted(row)) {
      throw new StudyVaultError(
        'invalid_request',
        'A claim links to a highlight that does not exist (or is in the trash).',
      );
    }
  }
}

export async function listKnowledgePoints(
  query: { highlightId?: string } = {},
): Promise<KnowledgePoint[]> {
  if (query.highlightId !== undefined) requireId(query.highlightId);
  return withDb(async (db) => {
    const rows =
      query.highlightId !== undefined
        ? await db.knowledgePoints.where('highlightId').equals(query.highlightId).toArray()
        : await db.knowledgePoints.toArray();
    return rows
      .map((r) => parseRow(KnowledgePoint, r, 'knowledge point'))
      .filter(notNull)
      .filter((k) => k.deletedAt === null)
      .sort((a, b) => cmp(a.createdAt, b.createdAt) || cmp(a.id, b.id));
  });
}

export async function getKnowledgePoint(id: string): Promise<KnowledgePoint | null> {
  requireId(id);
  return withDb(async (db) => {
    const kp = await readKnowledgePoint(db, id);
    return kp && kp.deletedAt === null ? kp : null;
  });
}

export async function createKnowledgePoint(input: KnowledgePointInput): Promise<KnowledgePoint> {
  requireId(input.highlightId);
  const createdBy = input.createdBy ?? 'user';
  const kp = await withWritableDb((db) =>
    db.transaction('rw', [db.highlights, db.knowledgePoints], async () => {
      await liveHighlight(db, input.highlightId);
      const primaryQuoteId = input.primaryQuoteId ?? input.highlightId;
      if (primaryQuoteId !== input.highlightId) await liveHighlight(db, requireId(primaryQuoteId));
      const claims = input.claims ?? [];
      await assertEvidenceExists(db, claims);
      const ts = nowIso();
      const row = parseOrThrow(
        KnowledgePoint,
        {
          id: uuidv7(),
          schemaVersion: SCHEMA_VERSION,
          createdAt: ts,
          updatedAt: ts,
          deletedAt: null,
          highlightId: input.highlightId,
          primaryQuoteId,
          shortOneLiner: input.shortOneLiner,
          examPearl: input.examPearl ?? null,
          misconception: input.misconception ?? null,
          // Always the starting label: only the person changes it, and only for points they wrote.
          verificationStatus: 'not_checked',
          claims,
          createdBy,
          acceptedAt: createdBy === 'user' ? ts : null,
        },
        'knowledge point',
      );
      await db.knowledgePoints.add(row);
      return row;
    }),
  );
  await signalChange();
  return kp;
}

export async function updateKnowledgePoint(
  id: string,
  patch: KnowledgePointPatch,
): Promise<KnowledgePoint> {
  requireId(id);
  const kp = await withWritableDb((db) =>
    db.transaction('rw', [db.highlights, db.knowledgePoints], async () => {
      const current = await liveKnowledgePoint(db, id);
      if (patch.claims) await assertEvidenceExists(db, patch.claims);
      const next = parseOrThrow(
        KnowledgePoint,
        { ...current, ...patch, updatedAt: nowIso() },
        'knowledge point',
      );
      await db.knowledgePoints.put(next);
      return next;
    }),
  );
  await signalChange();
  return kp;
}

/** The person accepts a point that was created for them (AI results later). Never verifies it. */
export async function acceptKnowledgePoint(id: string): Promise<KnowledgePoint> {
  requireId(id);
  const kp = await withWritableDb((db) =>
    db.transaction('rw', db.knowledgePoints, async () => {
      const current = await liveKnowledgePoint(db, id);
      if (current.acceptedAt !== null) return current;
      const ts = nowIso();
      const next = { ...current, acceptedAt: ts, updatedAt: ts };
      await db.knowledgePoints.put(next);
      return next;
    }),
  );
  await signalChange();
  return kp;
}

export async function deleteKnowledgePoint(id: string): Promise<void> {
  requireId(id);
  await withWritableDb((db) =>
    db.transaction('rw', db.knowledgePoints, async () => {
      const current = await liveKnowledgePoint(db, id);
      const ts = nowIso();
      await db.knowledgePoints.put({ ...current, deletedAt: ts, updatedAt: ts });
    }),
  );
  await signalChange();
}

// ---------------------------------------------------------------------------------------------
// Cards: create
// ---------------------------------------------------------------------------------------------

/** The deck a highlight's cards go to: the given bank's deck, else its first bank's, else General. */
async function deckForHighlight(
  db: StudyVaultDb,
  highlightId: string,
  bankId: string | undefined,
  ts: string,
): Promise<Deck> {
  const banks = new Set((await readBanks(db)).map((b) => b.id));
  const memberships = (await db.highlightBanks.where('highlightId').equals(highlightId).toArray())
    .map((r) => parseRow(HighlightBank, r, 'highlightBank'))
    .filter(notNull)
    .filter((m) => banks.has(m.bankId))
    .sort((a, b) => cmp(a.addedAt, b.addedAt) || cmp(a.bankId, b.bankId));
  const chosen =
    (bankId !== undefined ? memberships.find((m) => m.bankId === bankId) : undefined) ??
    memberships[0];
  return ensureDeckInTx(db, chosen?.bankId ?? null, ts);
}

export interface CreateCardsOptions {
  /** Target deck. Default: the deck of the highlight's bank (see `deckForHighlight`). */
  deckId?: string;
  /** Prefer the deck of this bank when the highlight is filed in several. */
  bankId?: string;
  knowledgePointId?: string | null;
  now?: DateInput;
  random?: Random;
}

async function resolveDeck(
  db: StudyVaultDb,
  options: CreateCardsOptions,
  highlightId: string | null,
  ts: string,
): Promise<Deck> {
  if (options.deckId !== undefined) return liveDeck(db, requireId(options.deckId));
  if (highlightId !== null) return deckForHighlight(db, highlightId, options.bankId, ts);
  return ensureDeckInTx(db, options.bankId ?? null, ts);
}

async function storeDrafts(
  db: StudyVaultDb,
  drafts: { draft: CardDraft; deckId: string }[],
  ts: string,
): Promise<Card[]> {
  const cards: Card[] = [];
  for (const { draft, deckId } of drafts) {
    const card = parseOrThrow(Card, createCard(draft, { id: uuidv7(), deckId }, ts), 'card');
    cards.push(card);
  }
  if (cards.length > 0) await db.cards.bulkAdd(cards);
  return cards;
}

/**
 * Cards from one highlight. The source link and the quote snapshot are taken from the highlight
 * itself, in the same transaction that stores the cards.
 */
export async function createCardsFromHighlight(
  highlightId: string,
  templates: TemplateInput[],
  options: CreateCardsOptions = {},
): Promise<Card[]> {
  requireId(highlightId);
  if (templates.length === 0) {
    throw new StudyVaultError('invalid_request', 'Choose at least one card to create.');
  }
  const cards = await withWritableDb((db) =>
    db.transaction('rw', STUDY_TABLES(db), async () => {
      const ts = options.now === undefined ? nowIso() : toIso(toMs(options.now));
      const highlight = await liveHighlight(db, highlightId);
      const source: SourceRef = {
        highlightId,
        quote: highlight.exactQuote,
        knowledgePointId: options.knowledgePointId ?? null,
      };
      if (source.knowledgePointId) await liveKnowledgePoint(db, source.knowledgePointId);
      const drafts: CardDraft[] = [];
      for (const template of templates) {
        const built = buildTemplateDrafts(template, source, { random: options.random });
        if (!built.ok) throw issuesToError(built.issues);
        drafts.push(...built.value);
      }
      const deck = await resolveDeck(db, options, highlightId, ts);
      return storeDrafts(
        db,
        drafts.map((draft) => ({ draft, deckId: deck.id })),
        ts,
      );
    }),
  );
  await signalChange();
  return cards;
}

/** Free-standing cards (no highlight): typed by the person into a deck. */
export async function createManualCards(
  templates: TemplateInput[],
  options: CreateCardsOptions = {},
): Promise<Card[]> {
  if (templates.length === 0) {
    throw new StudyVaultError('invalid_request', 'Choose at least one card to create.');
  }
  const cards = await withWritableDb((db) =>
    db.transaction('rw', STUDY_TABLES(db), async () => {
      const ts = options.now === undefined ? nowIso() : toIso(toMs(options.now));
      const drafts: CardDraft[] = [];
      for (const template of templates) {
        const built = buildTemplateDrafts(
          template,
          { highlightId: null, quote: null, knowledgePointId: null },
          { random: options.random },
        );
        if (!built.ok) throw issuesToError(built.issues);
        drafts.push(...built.value);
      }
      const deck = await resolveDeck(db, options, null, ts);
      return storeDrafts(
        db,
        drafts.map((draft) => ({ draft, deckId: deck.id })),
        ts,
      );
    }),
  );
  await signalChange();
  return cards;
}

/**
 * One template per highlight, all or nothing. Each card is filed in the deck of its own
 * highlight's bank unless `options.deckId` forces one.
 */
export async function createCardsFromHighlights(
  items: { highlightId: string; template: TemplateInput }[],
  options: Omit<CreateCardsOptions, 'knowledgePointId'> = {},
): Promise<Card[]> {
  if (items.length === 0) {
    throw new StudyVaultError('invalid_request', 'Choose at least one highlight.');
  }
  for (const item of items) requireId(item.highlightId);
  const cards = await withWritableDb((db) =>
    db.transaction('rw', STUDY_TABLES(db), async () => {
      const ts = options.now === undefined ? nowIso() : toIso(toMs(options.now));
      const pending: { draft: CardDraft; deckId: string }[] = [];
      const forced =
        options.deckId === undefined ? null : await liveDeck(db, requireId(options.deckId));
      for (const item of items) {
        const highlight = await liveHighlight(db, item.highlightId);
        const built = buildTemplateDrafts(
          item.template,
          { highlightId: item.highlightId, quote: highlight.exactQuote, knowledgePointId: null },
          { random: options.random },
        );
        if (!built.ok) throw issuesToError(built.issues);
        const deck = forced ?? (await deckForHighlight(db, item.highlightId, options.bankId, ts));
        for (const draft of built.value) pending.push({ draft, deckId: deck.id });
      }
      return storeDrafts(db, pending, ts);
    }),
  );
  await signalChange();
  return cards;
}

/** Recall cards from a knowledge point's exam pearl or misconception, using its own wording. */
export async function createCardsFromKnowledgePoint(
  knowledgePointId: string,
  template: KnowledgePointTemplate,
  options: Pick<CreateCardsOptions, 'deckId' | 'now'> = {},
): Promise<Card[]> {
  requireId(knowledgePointId);
  const cards = await withWritableDb((db) =>
    db.transaction('rw', STUDY_TABLES(db), async () => {
      const ts = options.now === undefined ? nowIso() : toIso(toMs(options.now));
      const kp = await liveKnowledgePoint(db, knowledgePointId);
      const highlight = await liveHighlight(db, kp.highlightId);
      // An AI-made point yields a card flagged for human verification (createdBy is inherited).
      const built = draftFromKnowledgePoint(kp, highlight.exactQuote, template);
      if (!built.ok) throw issuesToError(built.issues);
      const deck = await resolveDeck(db, options, kp.highlightId, ts);
      return storeDrafts(db, [{ draft: built.value, deckId: deck.id }], ts);
    }),
  );
  await signalChange();
  return cards;
}

// ---------------------------------------------------------------------------------------------
// Cards: read
// ---------------------------------------------------------------------------------------------

export async function getCard(id: string): Promise<Card | null> {
  requireId(id);
  return withDb(async (db) => {
    const card = await readCard(db, id);
    return card && card.deletedAt === null ? card : null;
  });
}

/** Live cards by id, in the order asked; unknown or deleted ids are left out. */
export async function getCards(ids: readonly string[]): Promise<Card[]> {
  if (ids.length === 0) return [];
  return withDb(async (db) => {
    const rows = await db.cards.bulkGet(unique(ids));
    const byId = new Map(
      parseCards(rows.filter((r) => r !== undefined))
        .filter((c) => c.deletedAt === null)
        .map((c) => [c.id, c]),
    );
    return ids.flatMap((id) => {
      const card = byId.get(id);
      return card ? [card] : [];
    });
  });
}

export type CardFilter =
  'all' | 'new' | 'learning' | 'review' | 'due' | 'suspended' | 'buried' | 'leech' | 'deleted';

export interface CardListQuery extends StudyClockOptions {
  deckId?: string;
  highlightId?: string;
  knowledgePointId?: string;
  filter?: CardFilter;
  /** Case-insensitive substring of the front, back or a tag. */
  search?: string;
  /** 1..2000, default 500. */
  limit?: number;
}

export interface CardList {
  cards: Card[];
  /** Matches before `limit`. */
  total: number;
}

export async function listCards(query: CardListQuery = {}): Promise<CardList> {
  const { nowMs, boundary } = clockOf(query);
  const filter = query.filter ?? 'all';
  const limit = Math.min(Math.max(Math.floor(query.limit ?? 500), 1), 2000);
  const needle = query.search?.trim().toLowerCase() ?? '';
  const dayEnd = studyDayStartMs(studyDayNumber(nowMs, boundary) + 1, boundary);
  return withDb(async (db) => {
    let rows: unknown[];
    if (query.deckId !== undefined) {
      rows = await db.cards.where('deckId').equals(requireId(query.deckId)).toArray();
    } else if (query.highlightId !== undefined) {
      rows = await db.cards.where('highlightId').equals(requireId(query.highlightId)).toArray();
    } else if (query.knowledgePointId !== undefined) {
      rows = await db.cards
        .where('knowledgePointId')
        .equals(requireId(query.knowledgePointId))
        .toArray();
    } else {
      rows = await db.cards.toArray();
    }
    const matches = parseCards(rows).filter((c) => {
      if (filter === 'deleted' ? c.deletedAt === null : c.deletedAt !== null) return false;
      if (query.highlightId !== undefined && c.highlightId !== query.highlightId) return false;
      if (query.knowledgePointId !== undefined && c.knowledgePointId !== query.knowledgePointId) {
        return false;
      }
      const s = c.fsrs;
      const dueMs = Date.parse(s.due);
      switch (filter) {
        case 'new':
          if (s.state !== 'new') return false;
          break;
        case 'learning':
          if (s.state !== 'learning' && s.state !== 'relearning') return false;
          break;
        case 'review':
          if (s.state !== 'review') return false;
          break;
        case 'due':
          if (c.suspended || (s.state === 'new' ? dueMs > nowMs : dueMs >= dayEnd)) return false;
          break;
        case 'suspended':
          if (!c.suspended) return false;
          break;
        case 'buried':
          if (!c.buriedUntil || Date.parse(c.buriedUntil) <= nowMs) return false;
          break;
        case 'leech':
          if (!c.tags.includes('leech')) return false;
          break;
        default:
          break;
      }
      if (needle === '') return true;
      return (
        c.front.toLowerCase().includes(needle) ||
        c.back.toLowerCase().includes(needle) ||
        c.tags.some((t) => t.toLowerCase().includes(needle))
      );
    });
    matches.sort((a, b) => cmp(b.createdAt, a.createdAt) || cmp(a.id, b.id));
    return { cards: matches.slice(0, limit), total: matches.length };
  });
}

/** Changes whenever the card's scheduling does; text edits do not alter it. */
export function cardVersion(card: Pick<Card, 'fsrs' | 'suspended'>): string {
  const s = card.fsrs;
  return [s.state, s.reps, s.lapses, s.lastReview ?? '', s.due, card.suspended ? 's' : ''].join(
    '|',
  );
}

// ---------------------------------------------------------------------------------------------
// Cards: edit and manage
// ---------------------------------------------------------------------------------------------

export interface CardPatch {
  front?: string;
  back?: string;
  /** null removes it. */
  explanation?: string | null;
  tags?: string[];
  /** Cloze cards only: replaces the markup; front and back are rebuilt from it. */
  clozeMarkup?: string;
  /** MCQ cards only. */
  choices?: { id: string; text: string }[];
  answerChoiceId?: string;
}

const normaliseTags = (tags: readonly string[]): string[] => {
  const out: string[] = [];
  for (const raw of tags) {
    const t = raw.trim();
    if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out;
};

/**
 * Edit the content of a card. Scheduling, provenance (highlightId, sourceQuote, createdBy) and the
 * card type never change here. Cards made together from one cloze text stay independent afterwards.
 */
export async function updateCard(id: string, patch: CardPatch, now?: DateInput): Promise<Card> {
  requireId(id);
  const card = await withWritableDb((db) =>
    db.transaction('rw', db.cards, async () => {
      const current = await liveCard(db, id);
      const next: Card = {
        ...current,
        updatedAt: toIso(now === undefined ? Date.now() : toMs(now)),
      };
      if (current.cardType === 'cloze' && patch.clozeMarkup !== undefined && current.cloze) {
        const parsed = parseCloze(patch.clozeMarkup);
        if (parsed.deletions.length === 0) {
          throw new StudyVaultError(
            'invalid_request',
            'Add at least one deletion, written as {{c1::answer}} or {{c1::answer::hint}}.',
          );
        }
        const active =
          current.cloze.activeIndex !== null && parsed.indexes.includes(current.cloze.activeIndex)
            ? current.cloze.activeIndex
            : current.cloze.activeIndex === null
              ? null
              : (parsed.indexes[0] ?? null);
        next.cloze = { text: patch.clozeMarkup, deletions: parsed.deletions, activeIndex: active };
        next.front = segmentsToText(renderCloze(parsed, { activeIndex: active, reveal: false }));
        next.back = segmentsToText(renderCloze(parsed, { activeIndex: active, reveal: true }));
      } else if (current.cardType !== 'cloze') {
        if (patch.front !== undefined) next.front = patch.front.trim();
        if (patch.back !== undefined) next.back = patch.back.trim();
      }
      if (patch.explanation !== undefined) {
        const e = patch.explanation?.trim() ?? '';
        if (e === '') delete next.explanation;
        else next.explanation = e;
      }
      if (patch.tags !== undefined) next.tags = normaliseTags(patch.tags);
      if (current.cardType === 'mcq' && (patch.choices || patch.answerChoiceId !== undefined)) {
        const choices = (patch.choices ?? current.choices ?? []).map((c) => ({
          id: c.id,
          text: c.text.trim(),
        }));
        const answerId = patch.answerChoiceId ?? current.answerChoiceId;
        const issues = mcqIssues(choices, answerId);
        if (issues.length > 0) throw issuesToError(issues);
        next.choices = choices;
        if (answerId !== undefined) {
          next.answerChoiceId = answerId;
          next.back = choices.find((c) => c.id === answerId)?.text ?? next.back;
        }
      }
      const valid = parseOrThrow(Card, next, 'card');
      await db.cards.put(valid);
      return valid;
    }),
  );
  await signalChange();
  return card;
}

/** The person checked the answer key and the wording: clears the "needs verification" flag. */
export async function markCardVerified(id: string): Promise<Card> {
  requireId(id);
  const card = await withWritableDb((db) =>
    db.transaction('rw', db.cards, async () => {
      const current = await liveCard(db, id);
      if (!current.needsHumanVerification) return current;
      const next = { ...current, needsHumanVerification: false, updatedAt: nowIso() };
      await db.cards.put(next);
      return next;
    }),
  );
  await signalChange();
  return card;
}

/** Apply a pure transformation to several live cards in one transaction. */
async function transformCards(
  ids: readonly string[],
  fn: (card: Card, ts: string) => Card,
  now?: DateInput,
): Promise<Card[]> {
  const wanted = unique(ids);
  wanted.forEach((id) => requireId(id));
  if (wanted.length === 0) return [];
  const changed = await withWritableDb((db) =>
    db.transaction('rw', db.cards, async () => {
      const ts = now === undefined ? nowIso() : toIso(toMs(now));
      const rows = await db.cards.bulkGet(wanted);
      const cards = parseCards(rows.filter((r) => r !== undefined)).filter(
        (c) => c.deletedAt === null,
      );
      const next = cards.map((c) => parseOrThrow(Card, fn(c, ts), 'card'));
      if (next.length > 0) await db.cards.bulkPut(next);
      return next;
    }),
  );
  if (changed.length > 0) await signalChange();
  return changed;
}

export const setCardsSuspended = (ids: readonly string[], suspended: boolean, now?: DateInput) =>
  transformCards(
    ids,
    (c, ts) => {
      const next = setSuspended(c, suspended, ts);
      // Unsuspending a leech is the person saying "I fixed it": the next lapse flags it again.
      return !suspended && c.tags.includes('leech')
        ? { ...next, tags: next.tags.filter((t) => t !== 'leech') }
        : next;
    },
    now,
  );

export const buryCards = (ids: readonly string[], opts: StudyClockOptions = {}) => {
  const { nowIso: ts, boundary } = clockOf(opts);
  return transformCards(ids, (c) => buryCard(c, ts, boundary), ts);
};

export const unburyCards = (ids: readonly string[], now?: DateInput) =>
  transformCards(ids, (c, ts) => unburyCard(c, ts), now);

/** Move the due date (stability and difficulty are kept). A date in the past means "due now". */
export const rescheduleCard = (id: string, dueAt: DateInput, now?: DateInput) =>
  transformCards([id], (c, ts) => reschedule(c, dueAt, ts), now).then((r) => {
    if (!r[0]) throw new StudyVaultError('not_found', 'Card not found');
    return r[0];
  });

/** Forget a card: a new card again. Review counts are kept unless `resetCounts`. */
export const resetCardProgress = (
  id: string,
  opts: { resetCounts?: boolean; now?: DateInput } = {},
) =>
  transformCards(
    [id],
    (c, ts) => resetCard(c, ts, { resetCounts: opts.resetCounts === true }),
    opts.now,
  ).then((r) => {
    if (!r[0]) throw new StudyVaultError('not_found', 'Card not found');
    return r[0];
  });

export async function moveCards(ids: readonly string[], deckId: string): Promise<Card[]> {
  requireId(deckId);
  await withDb((db) => liveDeck(db, deckId));
  return transformCards(ids, (c, ts) => ({ ...c, deckId, updatedAt: ts }));
}

/** Soft delete. The card, its history and its source link stay on this device until purged. */
export async function deleteCards(ids: readonly string[], now?: DateInput): Promise<number> {
  const changed = await transformCards(
    ids,
    (c, ts) => ({ ...c, deletedAt: ts, updatedAt: ts }),
    now,
  );
  return changed.length;
}

export async function restoreCards(ids: readonly string[]): Promise<number> {
  const wanted = unique(ids);
  wanted.forEach((id) => requireId(id));
  const restored = await withWritableDb((db) =>
    db.transaction('rw', [db.cards, db.decks], async () => {
      const ts = nowIso();
      const rows = await db.cards.bulkGet(wanted);
      const cards = parseCards(rows.filter((r) => r !== undefined)).filter(
        (c) => c.deletedAt !== null,
      );
      for (const c of cards) await liveDeck(db, c.deckId);
      const next = cards.map((c) => ({ ...c, deletedAt: null, updatedAt: ts }));
      if (next.length > 0) await db.cards.bulkPut(next);
      return next.length;
    }),
  );
  if (restored > 0) await signalChange();
  return restored;
}

// ---------------------------------------------------------------------------------------------
// Review and undo
// ---------------------------------------------------------------------------------------------

export interface ReviewCardOptions extends StudyClockOptions {
  /** Session this answer belongs to. Default: a fresh id (a one-off review). */
  sessionId?: string;
  /** Milliseconds the learner took. Default 0. */
  durationMs?: number;
  /**
   * Idempotency key (the ReviewLog id). A retry with the same key never writes a second log:
   * it returns the first outcome. Default: a fresh id.
   */
  logId?: string;
  /** `cardVersion(card)` of the card the learner saw. A mismatch writes nothing ("stale"). */
  expectedVersion?: string;
}

export type ReviewOutcome =
  | { status: 'reviewed'; card: Card; log: ReviewLog; leech: boolean; clockAdjusted: boolean }
  /** This logId was already applied: nothing was written; `card` is the current card. */
  | { status: 'duplicate'; card: Card | null; log: ReviewLog }
  /** The card changed since the learner saw it (another window answered it, edited its schedule). */
  | { status: 'stale'; card: Card }
  | { status: 'unavailable'; reason: 'missing' | 'deleted' | 'suspended' | 'deck_missing' };

/**
 * Answer a card. The scheduler, the card row and the ReviewLog are one atomic unit: either the card
 * moved and the log exists, or neither changed. Never reviews a deleted or suspended card.
 */
export async function reviewCard(
  cardId: string,
  rating: Rating,
  options: ReviewCardOptions = {},
): Promise<ReviewOutcome> {
  requireId(cardId);
  const grade = parseOrThrow(Rating, rating, 'rating');
  const logId = options.logId === undefined ? uuidv7() : requireId(options.logId);
  const sessionId = options.sessionId === undefined ? uuidv7() : requireId(options.sessionId);
  const { nowIso: ts, boundary } = clockOf(options);
  const outcome = await withWritableDb((db) =>
    db.transaction('rw', [db.cards, db.decks, db.reviewLogs], async (): Promise<ReviewOutcome> => {
      const existing = await db.reviewLogs.get(logId);
      if (existing) {
        const log = parseRow(ReviewLog, existing, 'review log');
        if (!log || log.cardId !== cardId) {
          throw new StudyVaultError('invalid_request', 'That review id belongs to another card.');
        }
        return { status: 'duplicate', card: await readCard(db, cardId), log };
      }
      const card = await readCard(db, cardId);
      if (!card) return { status: 'unavailable', reason: 'missing' };
      if (card.deletedAt !== null) return { status: 'unavailable', reason: 'deleted' };
      if (card.suspended) return { status: 'unavailable', reason: 'suspended' };
      if (options.expectedVersion !== undefined && cardVersion(card) !== options.expectedVersion) {
        return { status: 'stale', card };
      }
      const deck = await readDeck(db, card.deckId);
      if (!deck || deck.deletedAt !== null)
        return { status: 'unavailable', reason: 'deck_missing' };
      const result = review(card, grade, ts, deck.settings, {
        logId,
        sessionId,
        durationMs: options.durationMs ?? 0,
        boundary,
      });
      const validCard = parseOrThrow(Card, result.card, 'card');
      const validLog = parseOrThrow(ReviewLog, result.log, 'review log');
      await db.cards.put(validCard);
      await db.reviewLogs.add(validLog);
      return {
        status: 'reviewed',
        card: validCard,
        log: validLog,
        leech: result.leech,
        clockAdjusted: result.clockAdjusted,
      };
    }),
  );
  if (outcome.status === 'reviewed') await signalChange();
  return outcome;
}

export type UndoOutcome =
  | { status: 'undone'; card: Card; log: ReviewLog }
  | {
      status: 'refused';
      reason: 'missing' | 'no_review' | 'not_last_review' | 'already_undone' | 'card_mismatch';
    };

/**
 * Undo the most recent un-undone review of a card: the card gets the scheduling state recorded in
 * the log and the log is marked corrected (the only amendment a log ever gets). Refused when the
 * card has moved on, so an old log can never overwrite newer state.
 */
export async function undoLastReview(
  cardId: string,
  options: { now?: DateInput; expectLogId?: string } = {},
): Promise<UndoOutcome> {
  requireId(cardId);
  const ts = options.now === undefined ? nowIso() : toIso(toMs(options.now));
  const outcome = await withWritableDb((db) =>
    db.transaction('rw', [db.cards, db.reviewLogs], async (): Promise<UndoOutcome> => {
      const card = await readCard(db, cardId);
      if (!card || card.deletedAt !== null) return { status: 'refused', reason: 'missing' };
      const logs = (
        await db.reviewLogs
          .where('[cardId+reviewedAt]')
          .between([cardId, ''], [cardId, '￿'])
          .toArray()
      )
        .map((r) => parseRow(ReviewLog, r, 'review log'))
        .filter(notNull)
        .filter((l) => !l.userCorrection)
        .sort((a, b) => cmp(a.reviewedAt, b.reviewedAt) || cmp(a.id, b.id));
      const last = logs[logs.length - 1];
      if (!last) return { status: 'refused', reason: 'no_review' };
      if (options.expectLogId !== undefined && last.id !== options.expectLogId) {
        return { status: 'refused', reason: 'not_last_review' };
      }
      const result = undoReview(card, last, ts);
      if (!result.ok) return { status: 'refused', reason: result.reason };
      const validCard = parseOrThrow(Card, result.card, 'card');
      const validLog = parseOrThrow(ReviewLog, result.log, 'review log');
      await db.cards.put(validCard);
      await db.reviewLogs.put(validLog);
      return { status: 'undone', card: validCard, log: validLog };
    }),
  );
  if (outcome.status === 'undone') await signalChange();
  return outcome;
}

export interface ReviewLogQuery {
  /** Inclusive lower bound on `reviewedAt` (ISO). */
  since?: string;
  /** Exclusive upper bound. */
  until?: string;
  cardId?: string;
  /** Include logs that were undone (default false). */
  includeCorrected?: boolean;
  /** 1..100000, default 50000. */
  limit?: number;
}

export async function listReviewLogs(query: ReviewLogQuery = {}): Promise<ReviewLog[]> {
  const limit = Math.min(Math.max(Math.floor(query.limit ?? 50_000), 1), 100_000);
  if (query.cardId !== undefined) requireId(query.cardId);
  return withDb(async (db) => {
    let rows: unknown[];
    if (query.cardId !== undefined) {
      rows = await db.reviewLogs
        .where('[cardId+reviewedAt]')
        .between([query.cardId, query.since ?? ''], [query.cardId, '￿'])
        .toArray();
    } else if (query.since !== undefined) {
      rows = await db.reviewLogs.where('reviewedAt').aboveOrEqual(query.since).toArray();
    } else {
      rows = await db.reviewLogs.toArray();
    }
    return rows
      .map((r) => parseRow(ReviewLog, r, 'review log'))
      .filter(notNull)
      .filter((l) => (query.includeCorrected === true ? true : !l.userCorrection))
      .filter((l) => query.until === undefined || l.reviewedAt < query.until)
      .sort((a, b) => cmp(a.reviewedAt, b.reviewedAt) || cmp(a.id, b.id))
      .slice(0, limit);
  });
}

// ---------------------------------------------------------------------------------------------
// Queue, counts, overview
// ---------------------------------------------------------------------------------------------

type QueueInputs = {
  cards: Card[];
  decks: Deck[];
  done: ReturnType<typeof countToday>;
};

/** Cards that can be in today's queue (a `dueAt` index range) and today's work done per deck. */
async function loadQueueInputs(
  db: StudyVaultDb,
  clock: Clock,
  learnAheadMs: number,
): Promise<QueueInputs> {
  const decks = await allDecks(db);
  const today = studyDayNumber(clock.nowMs, clock.boundary);
  const dayStart = studyDayStartMs(today, clock.boundary);
  const dayEnd = studyDayStartMs(today + 1, clock.boundary);
  // +1s of slack: ISO strings are compared as text, so a stored value without milliseconds still
  // lands inside the range; the queue itself compares parsed instants.
  const upper = toIso(Math.max(dayEnd, clock.nowMs + learnAheadMs) + 1000);
  const cards = parseCards(await db.cards.where('dueAt').below(upper).toArray());
  const logs = (await db.reviewLogs.where('reviewedAt').aboveOrEqual(toIso(dayStart)).toArray())
    .map((r) => parseRow(ReviewLog, r, 'review log'))
    .filter(notNull);
  const deckOf = new Map<string, string>(cards.map((c) => [c.id, c.deckId]));
  const missing = unique(logs.map((l) => l.cardId).filter((id) => !deckOf.has(id)));
  if (missing.length > 0) {
    for (const row of await db.cards.bulkGet(missing)) {
      const c = row ? parseRow(Card, row, 'card') : null;
      if (c) deckOf.set(c.id, c.deckId);
    }
  }
  const done = countToday(logs, (id) => deckOf.get(id), clock.nowMs, clock.boundary);
  return { cards, decks, done };
}

function queueOf(
  inputs: QueueInputs,
  clock: Clock,
  deckIds: readonly string[] | null | undefined,
  prefs: QueuePrefs,
): QueueResult {
  return buildQueue(inputs.cards, {
    now: clock.nowMs,
    boundary: clock.boundary,
    decks: inputs.decks,
    done: inputs.done,
    deckIds: deckIds ?? null,
    ...(prefs.order ? { order: prefs.order } : {}),
    ...(prefs.newOrder ? { newOrder: prefs.newOrder } : {}),
    ...(prefs.interleave ? { interleave: prefs.interleave } : {}),
    ...(prefs.learnAheadMs !== undefined ? { learnAheadMs: prefs.learnAheadMs } : {}),
    random: prefs.random ?? Math.random,
  });
}

export interface DueListOptions extends StudyClockOptions, QueuePrefs {
  /** Restrict to these decks (e.g. one bank's decks). Default: every deck. */
  deckIds?: readonly string[] | null;
  /** Cards returned (the queue is ordered). Default: all of them. */
  limit?: number;
}

export interface DueList {
  queue: QueueResult;
  /** The queue's cards in study order, at most `limit`. */
  cards: Card[];
  decks: Deck[];
}

/** What the learner would study right now under today's caps, in order. */
export async function listDueCards(options: DueListOptions = {}): Promise<DueList> {
  const clock = clockOf(options);
  return withDb((db) =>
    db.transaction('r', [db.decks, db.cards, db.reviewLogs], async () => {
      const inputs = await loadQueueInputs(
        db,
        clock,
        options.learnAheadMs ?? DEFAULT_LEARN_AHEAD_MS,
      );
      const queue = queueOf(inputs, clock, options.deckIds, options);
      const byId = new Map(inputs.cards.map((c) => [c.id, c]));
      const ids = queue.ids.slice(0, options.limit ?? queue.ids.length);
      const cards = ids.flatMap((id) => {
        const c = byId.get(id);
        return c ? [c] : [];
      });
      return { queue, cards, decks: inputs.decks };
    }),
  );
}

export interface DueGroup {
  learning: number;
  review: number;
  new: number;
  /** learning + review + new: what a session would offer today. */
  total: number;
}

export interface DueSummary {
  now: string;
  dayKey: string;
  dayEndsAt: string;
  /** Everything the queue offers right now (all decks). */
  total: DueGroup;
  /** Due cards that did not fit today's daily caps; they stay due. */
  deferred: { review: number; new: number };
  nextLearningAt: string | null;
  byDeck: Record<string, DueGroup>;
  /** Keyed by bank id; free-standing decks are under "none". */
  byBank: Record<string, DueGroup>;
}

const emptyGroup = (): DueGroup => ({ learning: 0, review: 0, new: 0, total: 0 });

export const NO_BANK = 'none';

/** Cheap enough for a badge: reads only the cards that can be due today. */
export async function getDueSummary(
  options: StudyClockOptions & QueuePrefs = {},
): Promise<DueSummary> {
  const clock = clockOf(options);
  return withDb((db) =>
    db.transaction('r', [db.decks, db.cards, db.reviewLogs], async () => {
      const inputs = await loadQueueInputs(
        db,
        clock,
        options.learnAheadMs ?? DEFAULT_LEARN_AHEAD_MS,
      );
      const queue = queueOf(inputs, clock, null, options);
      const bankOf = new Map(inputs.decks.map((d) => [d.id, d.bankId ?? NO_BANK]));
      const total = emptyGroup();
      const byDeck: Record<string, DueGroup> = {};
      const byBank: Record<string, DueGroup> = {};
      for (const e of queue.entries) {
        const bankKey = bankOf.get(e.deckId) ?? NO_BANK;
        for (const g of [
          total,
          (byDeck[e.deckId] ??= emptyGroup()),
          (byBank[bankKey] ??= emptyGroup()),
        ]) {
          g[e.kind] += 1;
          g.total += 1;
        }
      }
      return {
        now: queue.now,
        dayKey: queue.dayKey,
        dayEndsAt: queue.dayEndsAt,
        total,
        deferred: { review: queue.deferred.review, new: queue.deferred.new },
        nextLearningAt: queue.nextLearningAt,
        byDeck,
        byBank,
      };
    }),
  );
}

export interface DeckOverview {
  deck: Deck;
  counts: DeckCounts;
  due: DueGroup;
  deferred: { review: number; new: number };
}

export interface BankOverview {
  bankId: string | null;
  name: string;
  counts: BankCounts;
  due: DueGroup;
}

export interface StudyOverview {
  now: string;
  dayKey: string;
  dayEndsAt: string;
  boundary: DayBoundary;
  decks: DeckOverview[];
  banks: BankOverview[];
  due: DueGroup;
  deferred: { review: number; new: number };
  nextLearningAt: string | null;
  backlog: BacklogStats;
  totalCards: number;
  /** Cards whose deck is gone (kept, not shown). */
  orphanCards: number;
}

/** Everything the deck picker shows. Reads every card: use `getDueSummary` for a badge. */
export async function getStudyOverview(
  options: StudyClockOptions & QueuePrefs = {},
): Promise<StudyOverview> {
  const clock = clockOf(options);
  return withDb((db) =>
    db.transaction('r', [db.banks, db.decks, db.cards, db.reviewLogs], async () => {
      const inputs = await loadQueueInputs(
        db,
        clock,
        options.learnAheadMs ?? DEFAULT_LEARN_AHEAD_MS,
      );
      const everyCard = parseCards(await db.cards.toArray()).filter((c) => c.deletedAt === null);
      const queue = queueOf(inputs, clock, null, options);
      const { decks: deckCounts, orphanCards } = countsByDeck(
        everyCard,
        inputs.decks,
        clock.nowMs,
        clock.boundary,
      );
      const countsOf = new Map(deckCounts.map((c) => [c.deckId, c]));
      const dueByDeck = new Map<string, DueGroup>();
      const bankOfDeck = new Map(inputs.decks.map((d) => [d.id, d.bankId]));
      const dueByBank = new Map<string | null, DueGroup>();
      const total = emptyGroup();
      const group = <K>(map: Map<K, DueGroup>, key: K): DueGroup => {
        let g = map.get(key);
        if (!g) map.set(key, (g = emptyGroup()));
        return g;
      };
      for (const e of queue.entries) {
        const bankId = bankOfDeck.get(e.deckId) ?? null;
        for (const g of [total, group(dueByDeck, e.deckId), group(dueByBank, bankId)]) {
          g[e.kind] += 1;
          g.total += 1;
        }
      }
      const banks = await readBanks(db);
      const bankName = (id: string | null) =>
        id === null ? 'No bank' : (banks.find((b) => b.id === id)?.name ?? 'Deleted bank');
      const decks: DeckOverview[] = inputs.decks.map((deck) => {
        const counts = countsOf.get(deck.id);
        return {
          deck,
          counts: counts as DeckCounts,
          due: dueByDeck.get(deck.id) ?? emptyGroup(),
          deferred: queue.deferred.byDeck[deck.id] ?? { review: 0, new: 0 },
        };
      });
      return {
        now: queue.now,
        dayKey: queue.dayKey,
        dayEndsAt: queue.dayEndsAt,
        boundary: clock.boundary,
        decks,
        banks: countsByBank(deckCounts).map((counts) => ({
          bankId: counts.bankId,
          name: bankName(counts.bankId),
          counts,
          due: dueByBank.get(counts.bankId) ?? emptyGroup(),
        })),
        due: total,
        deferred: { review: queue.deferred.review, new: queue.deferred.new },
        nextLearningAt: queue.nextLearningAt,
        backlog: backlog(everyCard, clock.nowMs, clock.boundary),
        totalCards: everyCard.length,
        orphanCards,
      };
    }),
  );
}

export type AnalyticsCard = Pick<Card, 'id' | 'deckId' | 'deletedAt' | 'suspended' | 'fsrs'>;
export type AnalyticsLog = Pick<
  ReviewLog,
  'cardId' | 'reviewedAt' | 'rating' | 'durationMs' | 'previousState' | 'userCorrection'
>;

export interface AnalyticsInput {
  now: string;
  boundary: DayBoundary;
  decks: Deck[];
  cards: AnalyticsCard[];
  logs: AnalyticsLog[];
  /** Earliest review ever recorded (for "how much history is there"), or null. */
  firstReviewAt: string | null;
  banks: { id: string; name: string }[];
}

/** The slim, real rows the analytics view computes from. Nothing is estimated here. */
export async function getAnalyticsInput(
  options: StudyClockOptions & { sinceDays?: number } = {},
): Promise<AnalyticsInput> {
  const clock = clockOf(options);
  const since =
    options.sinceDays === undefined
      ? undefined
      : toIso(clock.nowMs - Math.max(1, options.sinceDays) * 86_400_000);
  return withDb((db) =>
    db.transaction('r', [db.banks, db.decks, db.cards, db.reviewLogs], async () => {
      const decks = await allDecks(db);
      const cards = parseCards(await db.cards.toArray())
        .filter((c) => c.deletedAt === null)
        .map(({ id, deckId, deletedAt, suspended, fsrs }) => ({
          id,
          deckId,
          deletedAt,
          suspended,
          fsrs,
        }));
      const rows =
        since === undefined
          ? await db.reviewLogs.toArray()
          : await db.reviewLogs.where('reviewedAt').aboveOrEqual(since).toArray();
      const logs = rows
        .map((r) => parseRow(ReviewLog, r, 'review log'))
        .filter(notNull)
        .map(({ cardId, reviewedAt, rating, durationMs, previousState, userCorrection }) => ({
          cardId,
          reviewedAt,
          rating,
          durationMs,
          previousState,
          ...(userCorrection ? { userCorrection } : {}),
        }));
      const first = await db.reviewLogs.orderBy('reviewedAt').first();
      return {
        now: clock.nowIso,
        boundary: clock.boundary,
        decks,
        cards,
        logs,
        firstReviewAt: first
          ? (parseRow(ReviewLog, first, 'review log')?.reviewedAt ?? null)
          : null,
        banks: (await readBanks(db)).map((b) => ({ id: b.id, name: b.name })),
      };
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// Backlog recovery
// ---------------------------------------------------------------------------------------------

export interface BacklogPlanOptions extends StudyClockOptions {
  /** Window in study days, today included (1-366). */
  days: number;
  /** Per-deck review budget per day. Default: each deck's `reviewsPerDay`. */
  maxPerDay?: number;
}

export interface BacklogPreviewMove {
  cardId: string;
  deckId: string;
  front: string;
  fromDueAt: string;
  toDueAt: string;
  dayOffset: number;
}

export interface BacklogPreview {
  plan: BacklogPlan;
  /** The moves with the card text, so the learner can see what changes before applying. */
  moves: BacklogPreviewMove[];
  /** Cards that do not fit the window; they stay overdue. */
  unassigned: { cardId: string; deckId: string; front: string }[];
}

/** Proposal only: nothing is written. Today's work already done counts against today's budget. */
export async function planBacklog(options: BacklogPlanOptions): Promise<BacklogPreview> {
  const clock = clockOf(options);
  const days = Math.min(366, Math.max(1, Math.floor(options.days)));
  const windowEnd = studyDayStartMs(
    studyDayNumber(clock.nowMs, clock.boundary) + days,
    clock.boundary,
  );
  return withDb((db) =>
    db.transaction('r', [db.decks, db.cards, db.reviewLogs], async () => {
      const inputs = await loadQueueInputs(db, clock, DEFAULT_LEARN_AHEAD_MS);
      // Overdue cards and the ones already scheduled inside the window (they use up budget).
      const cards = parseCards(
        await db.cards
          .where('dueAt')
          .below(toIso(windowEnd + 1000))
          .toArray(),
      );
      const plan = planBacklogRecovery(cards, {
        now: clock.nowMs,
        boundary: clock.boundary,
        decks: inputs.decks,
        days,
        ...(options.maxPerDay === undefined ? {} : { maxPerDay: options.maxPerDay }),
        done: inputs.done,
      });
      const front = new Map(cards.map((c) => [c.id, c.front]));
      return {
        plan,
        moves: plan.moves.map((m) => ({ ...m, front: front.get(m.cardId) ?? '' })),
        unassigned: plan.unassigned.map((u) => ({ ...u, front: front.get(u.cardId) ?? '' })),
      };
    }),
  );
}

/**
 * Apply a plan produced by `planBacklog`. Only due dates move (never memory state), and a card
 * whose due date is no longer the one the plan saw is skipped, so a plan can be applied late
 * without overwriting newer work. One transaction.
 */
export async function applyBacklog(
  plan: BacklogPlan,
  options: StudyClockOptions = {},
): Promise<{ moved: number; skipped: number }> {
  const clock = clockOf(options);
  const result = await withWritableDb((db) =>
    db.transaction('rw', db.cards, async () => {
      const rows = await db.cards.bulkGet(plan.moves.map((m) => m.cardId));
      const cards = parseCards(rows.filter((r) => r !== undefined));
      const expected = new Map(plan.moves.map((m) => [m.cardId, m.fromDueAt]));
      const fresh = cards.filter(
        (c) =>
          c.deletedAt === null &&
          !c.suspended &&
          c.fsrs.state === 'review' &&
          Date.parse(c.fsrs.due) === Date.parse(expected.get(c.id) ?? ''),
      );
      const moved = applyBacklogPlan(fresh, plan, clock.nowMs).map((c) =>
        parseOrThrow(Card, c, 'card'),
      );
      if (moved.length > 0) await db.cards.bulkPut(moved);
      return { moved: moved.length, skipped: plan.moves.length - moved.length };
    }),
  );
  if (result.moved > 0) await signalChange();
  return result;
}

// ---------------------------------------------------------------------------------------------
// Persisted review session (device-local; the meta table is not part of backups)
// ---------------------------------------------------------------------------------------------

const SESSION_KEY = 'studySession';

export async function saveStudySession(session: ReviewSession): Promise<void> {
  const value = parseOrThrow(ReviewSession, session, 'review session');
  await withWritableDb(async (db) => {
    const row: MetaRow = { key: SESSION_KEY, value, updatedAt: nowIso() };
    await db.meta.put(row);
  });
}

export async function loadStudySession(): Promise<ReviewSession | null> {
  return withDb(async (db) => {
    const row = await db.meta.get(SESSION_KEY);
    return row ? parseSession(row.value) : null;
  });
}

/**
 * Every viewer's "continue session" state follows this one, so it signals (saving progress after an
 * answer does not: the answer itself already did).
 */
export async function clearStudySession(): Promise<void> {
  await withWritableDb(async (db) => {
    await db.meta.delete(SESSION_KEY);
  });
  await signalChange();
}

export interface StartedSession {
  session: ReviewSession;
  queue: QueueResult;
}

/** Build today's queue for the given decks, persist it as the current session and return it. */
export async function startStudySession(options: DueListOptions = {}): Promise<StartedSession> {
  const clock = clockOf(options);
  const due = await listDueCards({ ...options, now: clock.nowMs, boundary: clock.boundary });
  const session = startSession(due.queue, {
    id: uuidv7(),
    boundary: clock.boundary,
    deckIds: options.deckIds ?? null,
  });
  await saveStudySession(session);
  await signalChange();
  return { session, queue: due.queue };
}

export interface ResumedSession extends ResumeResult {
  /** The session as it was stored (before reconciliation). */
  stored: ReviewSession;
}

/**
 * Load the stored session and reconcile it with the cards as they are now: cards answered, edited,
 * suspended or deleted since are dropped or moved, never shown twice. Null when there is none.
 * The reconciled session is written back unless the study day moved on (then it is cleared).
 */
export async function resumeStudySession(
  options: StudyClockOptions = {},
): Promise<ResumedSession | null> {
  const clock = clockOf(options);
  const stored = await loadStudySession();
  if (!stored) return null;
  const ids = unique([...stored.pending, ...stored.learning.map((l) => l.cardId)]);
  const rows = await withDb(async (db) =>
    parseCards((await db.cards.bulkGet(ids)).filter((r) => r !== undefined)),
  );
  const result = resumeSession(stored, rows, clock.nowMs);
  if (result.stale) await clearStudySession();
  else await saveStudySession(result.session);
  return { ...result, stored };
}

// ---------------------------------------------------------------------------------------------
// Source context ("jump to source", "explain answer")
// ---------------------------------------------------------------------------------------------

export type SourceJump =
  | { kind: 'web'; url: string }
  | { kind: 'pdf'; documentId: string; pageNumber: number | null; highlightId: string };

export interface CardSourceContext {
  cardId: string;
  highlightId: string | null;
  /** The highlight's current quote, else the snapshot stored on the card. */
  quote: string | null;
  /** The highlight no longer exists (or is in the trash): `quote` is the card's snapshot. */
  quoteIsSnapshot: boolean;
  /** The user's own comment on the highlight, and notes linked to it. Never the quote. */
  userComment: string;
  notes: { id: string; title: string; body: string }[];
  headingContext: string | null;
  source: {
    id: string;
    title: string;
    host: string;
    type: SourceRow['type'];
    pageNumber: number | null;
  } | null;
  jump: SourceJump | null;
  knowledgePoint: KnowledgePoint | null;
}

export async function getCardSourceContext(cardId: string): Promise<CardSourceContext> {
  requireId(cardId);
  return withDb((db) =>
    db.transaction(
      'r',
      [db.cards, db.highlights, db.sources, db.notes, db.knowledgePoints],
      async () => {
        const card = await liveCard(db, cardId);
        const base: CardSourceContext = {
          cardId,
          highlightId: card.highlightId,
          quote: card.sourceQuote,
          quoteIsSnapshot: true,
          userComment: '',
          notes: [],
          headingContext: null,
          source: null,
          jump: null,
          knowledgePoint: null,
        };
        if (card.knowledgePointId) {
          const kp = await readKnowledgePoint(db, card.knowledgePointId);
          if (kp && kp.deletedAt === null) base.knowledgePoint = kp;
        }
        if (!card.highlightId) return base;
        const row = await db.highlights.get(card.highlightId);
        const highlight: HighlightRow | null =
          row && !isDeleted(row) ? parseRow(Highlight, row, 'highlight') : null;
        if (!highlight) return base;
        const source = (await readSources(db, [highlight.sourceId])).get(highlight.sourceId);
        const notes = (await db.notes.where('highlightId').equals(highlight.id).toArray())
          .filter((n) => !isDeleted(n))
          .sort(
            (a, b) =>
              Number(b.pinned) - Number(a.pinned) ||
              cmp(b.updatedAt, a.updatedAt) ||
              cmp(a.id, b.id),
          )
          .map(({ id, title, body }) => ({ id, title, body }));
        const anchor = highlight.anchorSet;
        const pageNumber = anchor.type === 'pdf' ? anchor.pageNumber : null;
        let jump: SourceJump | null = null;
        if (source?.type === 'pdf' && source.documentId) {
          jump = {
            kind: 'pdf',
            documentId: source.documentId,
            pageNumber,
            highlightId: highlight.id,
          };
        } else if (source) {
          jump = { kind: 'web', url: highlight.capturedUrl ?? source.originalUrl };
        }
        return {
          ...base,
          quote: highlight.exactQuote,
          quoteIsSnapshot: false,
          userComment: highlight.userComment,
          notes,
          headingContext: highlight.headingContext,
          source: source
            ? {
                id: source.id,
                title: highlight.capturedTitle ?? source.title,
                host: source.host,
                type: source.type,
                pageNumber,
              }
            : null,
          jump,
        };
      },
    ),
  );
}
