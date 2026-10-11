import '@shared/zodConfig';
import { z } from 'zod';
import { MAX_BANK_NAME_CHARS, MAX_QUOTE_CHARS, SCHEMA_VERSION } from '@shared/constants';
import { Id, IsoDate } from '@shared/schema';
import type { TableSpec } from '@shared/registry';
import { DayBoundary } from './time';

/**
 * Persisted shapes of the retention engine (PRD P1 "study intelligence", DATA_MODEL.md).
 * All timestamps are ISO-8601 UTC strings. The Dexie layout lives in @storage; these are the
 * validated shapes it stores and that backup/sync walk through `STUDY_TABLE_SPECS`.
 */

export const LIMITS = {
  cardText: MAX_QUOTE_CHARS,
  oneLiner: 500,
  longNote: 2_000,
  deckName: MAX_BANK_NAME_CHARS,
  tag: 64,
  tags: 32,
  claims: 32,
  evidence: 32,
  choices: 8,
  clozeDeletions: 200,
} as const;

const recordMeta = {
  schemaVersion: z.literal(SCHEMA_VERSION),
  createdAt: IsoDate,
  updatedAt: IsoDate,
  deletedAt: IsoDate.nullable(),
};

const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => s.trim().length > 0, 'must not be blank');

export const Creator = z.enum(['user', 'ai']);
export type Creator = z.infer<typeof Creator>;

// ---------------------------------------------------------------------------------------------
// Scheduling state
// ---------------------------------------------------------------------------------------------

export const CARD_STATES = ['new', 'learning', 'review', 'relearning'] as const;
export const CardState = z.enum(CARD_STATES);
export type CardState = z.infer<typeof CardState>;

/** 1 Again, 2 Hard, 3 Good, 4 Easy. */
export const Rating = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
export type Rating = z.infer<typeof Rating>;
export const RATINGS: readonly Rating[] = [1, 2, 3, 4];
export const RATING_LABELS: Record<Rating, string> = {
  1: 'Again',
  2: 'Hard',
  3: 'Good',
  4: 'Easy',
};

/**
 * Lossless serialisation of a ts-fsrs `Card`: `due`/`last_review` as ISO strings, `state` by name.
 * Numbers are IEEE doubles and survive JSON exactly, so restoring yields an identical next review.
 */
export const FsrsState = z
  .object({
    state: CardState,
    due: IsoDate,
    stability: z.number().min(0),
    difficulty: z.number().min(0),
    elapsedDays: z.number().int().min(0),
    scheduledDays: z.number().int().min(0),
    learningSteps: z.number().int().min(0),
    reps: z.number().int().min(0),
    lapses: z.number().int().min(0),
    lastReview: IsoDate.nullable(),
  })
  .refine((s) => s.state === 'new' || (s.stability > 0 && s.difficulty > 0), {
    message: 'a card that has been studied needs positive stability and difficulty',
  });
export type FsrsState = z.infer<typeof FsrsState>;

// ---------------------------------------------------------------------------------------------
// Deck
// ---------------------------------------------------------------------------------------------

/** `10m`, `1h`, `1d`: whole numbers only, exactly what ts-fsrs parses. */
export const LearningStep = z
  .string()
  .regex(/^[1-9]\d{0,4}[mhd]$/, 'use steps like 1m, 10m, 1h, 1d');

export const DeckSettings = z.object({
  newPerDay: z.number().int().min(0).max(9999),
  reviewsPerDay: z.number().int().min(0).max(9999),
  /** FSRS desired retention. 0.9 means "recall 90% of cards at the moment they come due". */
  targetRetention: z.number().min(0.7).max(0.99),
  learningSteps: z.array(LearningStep).max(8),
  relearnSteps: z.array(LearningStep).max(8),
  maxIntervalDays: z.number().int().min(1).max(36_500),
  /** Spread due dates deterministically (seeded by card id and rep count); off = exact intervals. */
  enableFuzz: z.boolean(),
  /** A card that lapses this many times is flagged (and suspended) so the user can rewrite it. */
  leechThreshold: z.number().int().min(1).max(99),
});
export type DeckSettings = z.infer<typeof DeckSettings>;

export const DEFAULT_DECK_SETTINGS: DeckSettings = {
  newPerDay: 20,
  reviewsPerDay: 200,
  targetRetention: 0.9,
  learningSteps: ['1m', '10m'],
  relearnSteps: ['10m'],
  maxIntervalDays: 36_500,
  enableFuzz: true,
  leechThreshold: 8,
};

export const Deck = z.object({
  id: Id,
  ...recordMeta,
  /** Bank this deck studies, or null for a free-standing deck. */
  bankId: Id.nullable(),
  name: z.string().trim().min(1).max(LIMITS.deckName),
  settings: DeckSettings,
});
export type Deck = z.infer<typeof Deck>;

// ---------------------------------------------------------------------------------------------
// KnowledgePoint
// ---------------------------------------------------------------------------------------------

export const VERIFICATION_STATUSES = [
  'not_checked',
  'source_supported',
  'conflicting',
  'externally_verified',
] as const;
export const VerificationStatus = z.enum(VERIFICATION_STATUSES);
export type VerificationStatus = z.infer<typeof VerificationStatus>;

export const ClaimReliability = z.enum(['unrated', 'low', 'moderate', 'high']);
export type ClaimReliability = z.infer<typeof ClaimReliability>;

export const Claim = z.object({
  text: text(LIMITS.longNote),
  evidenceHighlightIds: z.array(Id).max(LIMITS.evidence),
  reliability: ClaimReliability,
});
export type Claim = z.infer<typeof Claim>;

/**
 * A compact, user-approved concept derived from a highlight. The literal quote stays in the
 * highlight (`primaryQuoteId`); nothing here overwrites it. AI-created points stay `not_checked`
 * until evidence is linked, and `acceptedAt` is null until the user accepts them.
 */
export const KnowledgePoint = z
  .object({
    id: Id,
    ...recordMeta,
    highlightId: Id,
    primaryQuoteId: Id,
    shortOneLiner: text(LIMITS.oneLiner),
    examPearl: z.string().max(LIMITS.longNote).nullable(),
    misconception: z.string().max(LIMITS.longNote).nullable(),
    verificationStatus: VerificationStatus,
    claims: z.array(Claim).max(LIMITS.claims),
    createdBy: Creator,
    acceptedAt: IsoDate.nullable(),
  })
  .superRefine((kp, ctx) => {
    if (
      kp.verificationStatus === 'source_supported' &&
      !kp.claims.some((c) => c.evidenceHighlightIds.length > 0)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['verificationStatus'],
        message: 'source_supported needs at least one claim linked to evidence',
      });
    }
  });
export type KnowledgePoint = z.infer<typeof KnowledgePoint>;

// ---------------------------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------------------------

export const CARD_TYPES = ['basic', 'cloze', 'definition', 'compare', 'mcq'] as const;
export const CardType = z.enum(CARD_TYPES);
export type CardType = z.infer<typeof CardType>;

export const ClozeDeletionSchema = z.object({
  index: z.number().int().min(1).max(99),
  answer: text(LIMITS.cardText),
  hint: z.string().max(LIMITS.longNote).nullable(),
});

/**
 * `text` is the cloze markup (`{{c1::answer::hint}}`); `deletions` is its parsed index. `activeIndex`
 * is the deletion this card tests (others show as context); null hides every deletion at once.
 * Checked structurally, not re-parsed: a parser improvement must not invalidate stored cards.
 */
export const ClozeData = z
  .object({
    text: text(LIMITS.cardText),
    deletions: z.array(ClozeDeletionSchema).min(1).max(LIMITS.clozeDeletions),
    activeIndex: z.number().int().min(1).max(99).nullable().default(null),
  })
  .superRefine((c, ctx) => {
    const indexes = new Set(c.deletions.map((d) => d.index));
    for (const index of indexes) {
      if (!c.text.includes(`{{c${index}::`)) {
        ctx.addIssue({
          code: 'custom',
          path: ['deletions'],
          message: `deletion c${index} does not occur in the cloze text`,
        });
      }
    }
    if (c.activeIndex !== null && !indexes.has(c.activeIndex)) {
      ctx.addIssue({
        code: 'custom',
        path: ['activeIndex'],
        message: 'activeIndex is not a deletion',
      });
    }
  });
export type ClozeData = z.infer<typeof ClozeData>;

/** Local to one card, so shorter than a record id (`ch1`). */
export const ChoiceId = z.string().regex(/^[0-9A-Za-z_-]{1,32}$/, 'invalid choice id');

export const Choice = z.object({ id: ChoiceId, text: text(LIMITS.cardText) });
export type Choice = z.infer<typeof Choice>;

export const Card = z
  .object({
    id: Id,
    ...recordMeta,
    deckId: Id,
    knowledgePointId: Id.nullable(),
    /** Source link: review jumps to this highlight. Null only for free-standing cards. */
    highlightId: Id.nullable(),
    /** Immutable snapshot of the source wording, so a card can show its source even if the highlight is gone. */
    sourceQuote: z.string().max(LIMITS.cardText).nullable().default(null),
    cardType: CardType,
    front: text(LIMITS.cardText),
    back: text(LIMITS.cardText),
    cloze: ClozeData.nullable(),
    choices: z.array(Choice).max(LIMITS.choices).optional(),
    answerChoiceId: ChoiceId.optional(),
    explanation: z.string().max(LIMITS.cardText).optional(),
    tags: z.array(z.string().trim().min(1).max(LIMITS.tag)).max(LIMITS.tags),
    suspended: z.boolean(),
    /** Hidden from the queue until this instant (bury until the next study day). */
    buriedUntil: IsoDate.nullable().default(null),
    /** AI-made or flagged cards stay marked until a person has checked the key and the wording. */
    needsHumanVerification: z.boolean().default(false),
    /** Mirror of `fsrs.due` kept for indexing; must always agree with it. */
    dueAt: IsoDate,
    fsrs: FsrsState,
    createdBy: Creator,
    aiResultId: Id.nullable(),
  })
  .superRefine((c, ctx) => {
    if (Date.parse(c.dueAt) !== Date.parse(c.fsrs.due)) {
      ctx.addIssue({ code: 'custom', path: ['dueAt'], message: 'dueAt must equal fsrs.due' });
    }
    if ((c.cardType === 'cloze') !== (c.cloze !== null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['cloze'],
        message: 'cloze data is required for cloze cards and only for them',
      });
    }
    if (c.cardType === 'mcq') {
      const ids = new Set(c.choices?.map((x) => x.id));
      if (!c.choices || c.choices.length < 2 || ids.size !== c.choices.length) {
        ctx.addIssue({
          code: 'custom',
          path: ['choices'],
          message: 'mcq needs 2-8 distinct choices',
        });
      } else if (!c.answerChoiceId || !ids.has(c.answerChoiceId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['answerChoiceId'],
          message: 'answerChoiceId must be one of the choices',
        });
      }
    } else if (c.choices || c.answerChoiceId) {
      ctx.addIssue({
        code: 'custom',
        path: ['choices'],
        message: 'choices are only for mcq cards',
      });
    }
  });
export type Card = z.infer<typeof Card>;

// ---------------------------------------------------------------------------------------------
// ReviewLog (append-only; the single permitted amendment is `userCorrection` on undo)
// ---------------------------------------------------------------------------------------------

export const ReviewCorrection = z.object({ kind: z.literal('undone'), at: IsoDate });
export type ReviewCorrection = z.infer<typeof ReviewCorrection>;

export const ReviewLog = z.object({
  id: Id,
  schemaVersion: z.literal(SCHEMA_VERSION),
  cardId: Id,
  reviewedAt: IsoDate,
  rating: Rating,
  durationMs: z.number().int().min(0).max(86_400_000),
  sessionId: Id,
  /** Scheduling state before the answer: undo restores exactly this. */
  previousState: FsrsState,
  nextState: FsrsState,
  /** Scheduler implementation that produced `nextState` (see ALGORITHM_VERSION). */
  algorithmVersion: z.string().min(1).max(128),
  scheduledDays: z.number().int().min(0),
  /** Whole study days since the previous review, as the scheduler saw them. */
  elapsedDays: z.number().int().min(0),
  /** This answer pushed the card over the leech threshold. */
  leech: z.boolean().default(false),
  userCorrection: ReviewCorrection.optional(),
});
export type ReviewLog = z.infer<typeof ReviewLog>;

// ---------------------------------------------------------------------------------------------
// Review session: a plain value, persisted by the caller, resumable after a restart
// ---------------------------------------------------------------------------------------------

export const ReviewSession = z
  .object({
    version: z.literal(1),
    id: Id,
    startedAt: IsoDate,
    /** Study day the queue was built for. */
    dayNumber: z.number().int(),
    boundary: DayBoundary,
    deckIds: z.array(Id).nullable(),
    /** Cards not yet shown, in order. */
    pending: z.array(Id),
    /** Cards waiting for a learning step to elapse. */
    learning: z.array(z.object({ cardId: Id, dueAt: IsoDate })),
    answered: z.number().int().min(0),
    lastAnswer: z.object({ cardId: Id, logId: Id, rating: Rating }).nullable(),
  })
  .superRefine((s, ctx) => {
    const seen = new Set<string>();
    const dup = [...s.pending, ...s.learning.map((l) => l.cardId)].find((id) => {
      if (seen.has(id)) return true;
      seen.add(id);
      return false;
    });
    if (dup) {
      ctx.addIssue({ code: 'custom', path: ['pending'], message: `card ${dup} is queued twice` });
    }
  });
export type ReviewSession = z.infer<typeof ReviewSession>;

// ---------------------------------------------------------------------------------------------
// Registry contract for backup / sync / integrity checks
// ---------------------------------------------------------------------------------------------

export const STUDY_TABLE_SPECS: readonly TableSpec[] = [
  {
    name: 'decks',
    primaryKey: 'id',
    schema: Deck,
    softDelete: true,
    references: [{ field: 'bankId', table: 'banks', nullable: true }],
  },
  {
    name: 'knowledgePoints',
    primaryKey: 'id',
    schema: KnowledgePoint,
    softDelete: true,
    references: [
      { field: 'highlightId', table: 'highlights' },
      { field: 'primaryQuoteId', table: 'highlights' },
    ],
  },
  {
    name: 'cards',
    primaryKey: 'id',
    schema: Card,
    softDelete: true,
    references: [
      { field: 'deckId', table: 'decks' },
      { field: 'knowledgePointId', table: 'knowledgePoints', nullable: true },
      { field: 'highlightId', table: 'highlights', nullable: true },
    ],
  },
  {
    name: 'reviewLogs',
    primaryKey: 'id',
    schema: ReviewLog,
    softDelete: false,
    references: [{ field: 'cardId', table: 'cards' }],
  },
];
