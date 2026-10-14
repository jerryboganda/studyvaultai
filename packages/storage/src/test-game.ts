import { uuidv7 } from 'uuidv7';
import { expect } from 'vitest';
import { createMockProvider, runTask, type AiSelection } from '@ai';
import { approve, goodReply, makeDeps } from '@ai/testkit';
import { SCHEMA_VERSION, type HighlightView } from '@shared';
import { createCard } from '@study/cards';
import { DEFAULT_DECK_SETTINGS, type Card, type Deck } from '@study/schema';
import type { DayBoundary } from '@study/time';
import { importMarkdownHighlights } from '@backup';
import { acceptAiItem, saveAiResult } from './ai';
import { importExternalHighlights, listLiveQuoteHashes } from './backupTarget';
import { getDb } from './db';
import { getGameState } from './game';

/** Shared helpers for the game-layer tests. Not imported by production code. */

export const UTC: DayBoundary = { timeZone: 'UTC', rolloverHour: 0 };

type Row = Record<string, unknown>;

/** Import one quote from a Markdown file, the way the import wizard does. Returns its id. */
export async function importQuote(quote: string): Promise<string> {
  const set = await importMarkdownHighlights(`> ${quote}\n`, {
    existingQuoteHashes: await listLiveQuoteHashes(),
  });
  const result = await importExternalHighlights(set, { bankId: null });
  expect(result.created).toBe(1);
  return result.highlightIds[0]!;
}

/**
 * The ledger is complete: every non-imported highlight, every card and every review log has its
 * event (in `gameEvents`, or as a purge copy in `gameFacts`), every undone log its `ru_` fact, and
 * no imported highlight earned anything. Every create path's test calls this, so a future create
 * path that forgets its hook fails here instead of silently earning nothing.
 */
export async function expectLedgerComplete(): Promise<void> {
  const db = getDb();
  if (!db.isOpen()) await db.open();
  const events = new Set((await db.gameEvents.toCollection().primaryKeys()).map(String));
  const facts = new Set((await db.gameFacts.toCollection().primaryKeys()).map(String));
  const has = (id: string) => events.has(id) || facts.has(id);
  const missing: string[] = [];
  const unearned: string[] = [];
  for (const h of (await db.highlights.toArray()) as Row[]) {
    const id = `hs_${String(h.id)}`;
    if (h.captureMethod === 'import') {
      if (has(id)) unearned.push(id);
    } else if (!has(id)) missing.push(id);
  }
  for (const c of (await db.cards.toArray()) as Row[]) {
    if (!has(`cd_${String(c.id)}`)) missing.push(`cd_${String(c.id)}`);
  }
  for (const l of (await db.reviewLogs.toArray()) as Row[]) {
    if (!has(`rv_${String(l.id)}`)) missing.push(`rv_${String(l.id)}`);
    if (l.userCorrection && !facts.has(`ru_${String(l.id)}`)) missing.push(`ru_${String(l.id)}`);
  }
  expect({ missing, unearned }).toEqual({ missing: [], unearned: [] });
}

/** The ready game state (throws when the backfill has not finished). */
export async function readyState(now?: string | number, boundary: DayBoundary = UTC) {
  const state = await getGameState({ boundary, ...(now === undefined ? {} : { now }) });
  if (!state.ready) throw new Error(`game state not ready: ${JSON.stringify(state.backfill)}`);
  return state;
}

/** Ids of both ledger tables, sorted. */
export async function ledgerIds(): Promise<{ events: string[]; facts: string[] }> {
  const db = getDb();
  if (!db.isOpen()) await db.open();
  return {
    events: (await db.gameEvents.toCollection().primaryKeys()).map(String).sort(),
    facts: (await db.gameFacts.toCollection().primaryKeys()).map(String).sort(),
  };
}

/** Two AI flashcards accepted one by one into a new deck, as the AI panel does. */
export async function acceptTwoAiCards(h: HighlightView): Promise<Card[]> {
  const selection: AiSelection = { chunks: [{ id: h.id, kind: 'highlight', text: h.exactQuote }] };
  const provider = createMockProvider([{ json: goodReply('flashcards', selection) }]);
  const deps = makeDeps(provider, { randomId: () => uuidv7() });
  const { result } = await runTask(
    'flashcards',
    selection,
    deps,
    await approve('flashcards', selection, deps),
  );
  await saveAiResult(result);
  const ts = new Date().toISOString();
  const deck: Deck = {
    id: uuidv7(),
    schemaVersion: SCHEMA_VERSION,
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
    bankId: null,
    name: 'AI drafts',
    settings: { ...DEFAULT_DECK_SETTINGS },
  };
  const card = (front: string): Card =>
    createCard(
      {
        cardType: 'basic',
        front,
        back: 'Cyclooxygenase',
        cloze: null,
        tags: [],
        knowledgePointId: null,
        highlightId: h.id,
        sourceQuote: h.exactQuote,
        createdBy: 'ai',
        aiResultId: result.id,
        needsHumanVerification: true,
      },
      { id: uuidv7(), deckId: deck.id },
      new Date(),
    );
  const first = card('What does aspirin inhibit irreversibly?');
  const second = card('Which enzyme does aspirin block?');
  await acceptAiItem({
    resultId: result.id,
    itemPath: '/cards/0',
    edited: false,
    deck,
    cards: [first],
  });
  await acceptAiItem({ resultId: result.id, itemPath: '/cards/1', edited: false, cards: [second] });
  return [first, second];
}
