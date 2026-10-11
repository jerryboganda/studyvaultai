import { SCHEMA_VERSION } from '@shared/constants';
import { DEFAULT_DECK_SETTINGS } from './schema';
import type { Card, CardState, Deck, DeckSettings, FsrsState } from './schema';
import { newFsrsState } from './scheduler';

/** Test fixtures: plain literals, no Zod parse, so thousands of cards cost nothing. */

export const T0 = '2026-01-05T09:00:00.000Z';
export const DAY = 86_400_000;

export const idOf = (prefix: string, n: number): string =>
  `${prefix}-${String(n).padStart(6, '0')}`;

export function makeDeck(
  id = 'deck-0001',
  over: { bankId?: string | null; name?: string; settings?: Partial<DeckSettings> } = {},
): Deck {
  return {
    id,
    schemaVersion: SCHEMA_VERSION,
    createdAt: T0,
    updatedAt: T0,
    deletedAt: null,
    bankId: over.bankId ?? null,
    name: over.name ?? id,
    settings: { ...DEFAULT_DECK_SETTINGS, enableFuzz: false, ...over.settings },
  };
}

export interface CardSpec {
  deckId?: string;
  state?: CardState;
  due?: string;
  lastReview?: string | null;
  stability?: number;
  difficulty?: number;
  lapses?: number;
  reps?: number;
  createdAt?: string;
  updatedAt?: string;
  suspended?: boolean;
  deleted?: boolean;
  buriedUntil?: string | null;
}

/** A stored card with an explicit scheduling state (defaults: new, due T0). */
export function makeCard(id: string, spec: CardSpec = {}): Card {
  const state = spec.state ?? 'new';
  const base = newFsrsState(spec.due ?? T0);
  const fsrs: FsrsState =
    state === 'new'
      ? { ...base, due: spec.due ?? T0 }
      : {
          ...base,
          state,
          due: spec.due ?? T0,
          stability: spec.stability ?? 5,
          difficulty: spec.difficulty ?? 5,
          reps: spec.reps ?? 3,
          lapses: spec.lapses ?? 0,
          lastReview: spec.lastReview === undefined ? T0 : spec.lastReview,
          scheduledDays: state === 'review' ? 5 : 0,
        };
  return {
    id,
    schemaVersion: SCHEMA_VERSION,
    createdAt: spec.createdAt ?? T0,
    updatedAt: spec.updatedAt ?? spec.createdAt ?? T0,
    deletedAt: spec.deleted ? T0 : null,
    deckId: spec.deckId ?? 'deck-0001',
    knowledgePointId: null,
    highlightId: null,
    sourceQuote: null,
    cardType: 'basic',
    front: `Question ${id}`,
    back: `Answer ${id}`,
    cloze: null,
    tags: [],
    suspended: spec.suspended ?? false,
    buriedUntil: spec.buriedUntil ?? null,
    needsHumanVerification: false,
    dueAt: fsrs.due,
    fsrs,
    createdBy: 'user',
    aiResultId: null,
  };
}
