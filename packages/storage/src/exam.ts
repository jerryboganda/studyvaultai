import {
  Folder,
  HighlightBank,
  HighlightTag,
  MAX_FOLDER_DEPTH,
  StudyVaultError,
  Tag,
  tagNameKey,
} from '@shared';
import { Card, Deck, type DateInput, type DayBoundary } from '@study';
import {
  ExamHistoryEntry,
  ExamSession,
  parseExamHistory,
  parseExamSession,
  pushHistory,
  type ExamCardFacts,
  type ExamReviewApplied,
  type ExamReviewItem,
  type ExamUniverse,
} from '@study/exam';
import { cmp, notNull, now as nowIso, parseRow, readBanks, unique } from './core';
import { withDb, withWritableDb } from './db';
import { reviewCard, undoLastReview } from './study';

/**
 * Exam simulation, persistence side (ADR-020). The rules live in `@study/exam`; this file loads the
 * facts the scope filter needs, keeps the running exam and the history in the device-local `meta`
 * table, and applies "count this exam as review" through the existing idempotent review API.
 *
 * `meta` is never exported, restored or synchronised and goes with the database on "Delete all data"
 * (ADR-010), so neither the running exam nor the history ever leaves this device.
 *
 * Imported by path (`@storage/exam`), not from the barrel: only the review page's exam view uses it,
 * so no other bundle (worker, content script, side panel) carries it.
 */

const SESSION_KEY = 'examSession';
const HISTORY_KEY = 'examHistory';

// ---------------------------------------------------------------------------------------------
// Which cards can be asked
// ---------------------------------------------------------------------------------------------

export interface ExamData extends ExamUniverse {
  /** Every live bank's name by id (the exam keeps the ones its questions are reported under). */
  bankNames: Record<string, string>;
}

/**
 * The cards an exam may ask (live, not suspended, deck alive) with their bank, folder and tag
 * facts, and the banks and folders a scope can name. One read transaction, no writes.
 */
export async function loadExamData(): Promise<ExamData> {
  return withDb((db) =>
    db.transaction(
      'r',
      [
        db.banks,
        db.folders,
        db.decks,
        db.cards,
        db.highlights,
        db.highlightBanks,
        db.highlightTags,
        db.tags,
      ],
      async () => {
        const banks = await readBanks(db);
        const liveBanks = new Set(banks.map((b) => b.id));
        const decks = new Map(
          (await db.decks.toArray())
            .map((r) => parseRow(Deck, r, 'deck'))
            .filter(notNull)
            .filter((d) => d.deletedAt === null)
            .map((d) => [d.id, d] as const),
        );
        const cards = (await db.cards.toArray())
          .map((r) => parseRow(Card, r, 'card'))
          .filter(notNull)
          .filter((c) => c.deletedAt === null && !c.suspended && decks.has(c.deckId));

        // Filing and tags belong to the highlight; a highlight in the trash files nothing.
        const trashed = new Set(
          (await db.highlights.where('deletedAt').above('').primaryKeys()) as string[],
        );
        const wanted = new Set(
          cards.flatMap((c) =>
            c.highlightId && !trashed.has(c.highlightId) ? [c.highlightId] : [],
          ),
        );
        const filed = new Map<string, { bankId: string; folderId: string | null; at: string }[]>();
        for (const row of await db.highlightBanks.toArray()) {
          if (!wanted.has(row.highlightId)) continue;
          const m = parseRow(HighlightBank, row, 'highlightBank');
          if (!m || !liveBanks.has(m.bankId)) continue;
          const list = filed.get(m.highlightId) ?? [];
          list.push({ bankId: m.bankId, folderId: m.folderId, at: m.addedAt });
          filed.set(m.highlightId, list);
        }
        const tagName = new Map(
          (await db.tags.toArray())
            .map((r) => parseRow(Tag, r, 'tag'))
            .filter(notNull)
            .filter((t) => t.deletedAt === null)
            .map((t) => [t.id, t.name] as const),
        );
        const tagged = new Map<string, string[]>();
        for (const row of await db.highlightTags.toArray()) {
          if (!wanted.has(row.highlightId)) continue;
          const link = parseRow(HighlightTag, row, 'highlightTag');
          const name = link ? tagName.get(link.tagId) : undefined;
          if (!link || name === undefined) continue;
          tagged.set(link.highlightId, [...(tagged.get(link.highlightId) ?? []), name]);
        }
        const folders = new Map<string, Folder>(
          (await db.folders.toArray())
            .map((r) => parseRow(Folder, r, 'folder'))
            .filter(notNull)
            .filter((f) => f.deletedAt === null && liveBanks.has(f.bankId))
            .map((f) => [f.id, f] as const),
        );
        /** The folder and every ancestor, innermost first. A cycle or a missing parent ends it. */
        const chain = (id: string): Folder[] => {
          const out: Folder[] = [];
          const seen = new Set<string>();
          let at = folders.get(id);
          while (at && !seen.has(at.id) && out.length < MAX_FOLDER_DEPTH) {
            seen.add(at.id);
            out.push(at);
            at = at.parentFolderId === null ? undefined : folders.get(at.parentFolderId);
          }
          return out;
        };

        const facts: ExamCardFacts[] = cards.map((c) => {
          const memberships =
            c.highlightId && !trashed.has(c.highlightId)
              ? (filed.get(c.highlightId) ?? []).sort((a, b) => cmp(a.at, b.at))
              : [];
          const deckBank = decks.get(c.deckId)?.bankId ?? null;
          const own = deckBank !== null && liveBanks.has(deckBank) ? deckBank : null;
          const bankIds = unique([...(own ? [own] : []), ...memberships.map((m) => m.bankId)]);
          const tags = new Map<string, string>();
          for (const t of [
            ...c.tags,
            ...(c.highlightId ? (tagged.get(c.highlightId) ?? []) : []),
          ]) {
            const key = tagNameKey(t);
            if (key !== '' && !tags.has(key)) tags.set(key, t);
          }
          return {
            cardId: c.id,
            cardType: c.cardType,
            bankId: own ?? memberships[0]?.bankId ?? null,
            bankIds,
            folderIds: unique(
              memberships.flatMap((m) => (m.folderId ? chain(m.folderId).map((f) => f.id) : [])),
            ),
            tags: [...tags.values()],
          };
        });

        const names = new Map(banks.map((b) => [b.id, b.name] as const));
        return {
          cards: facts,
          banks: banks.map((b) => ({ id: b.id, name: b.name })),
          folders: [...folders.values()].map((f) => ({
            id: f.id,
            bankId: f.bankId,
            path: chain(f.id)
              .map((x) => x.name)
              .reverse(),
          })),
          bankNames: Object.fromEntries(names),
        };
      },
    ),
  );
}

// ---------------------------------------------------------------------------------------------
// The running exam and the history
// ---------------------------------------------------------------------------------------------

/**
 * The stored exam, if it is still valid and within its 24 hours. An expired or unreadable one is
 * removed (it can neither resume nor block a new exam); `expired` lets the caller say why it is gone.
 */
export async function loadExamSession(
  now: DateInput = Date.now(),
): Promise<{ session: ExamSession | null; expired: boolean }> {
  const row = await withDb((db) => db.meta.get(SESSION_KEY));
  if (!row) return { session: null, expired: false };
  const found = parseExamSession(row.value, now);
  if (found.session === null) await withWritableDb((db) => db.meta.delete(SESSION_KEY));
  return found;
}

export async function saveExamSession(session: ExamSession): Promise<void> {
  const checked = ExamSession.safeParse(session);
  if (!checked.success) {
    throw new StudyVaultError(
      'invalid_request',
      `Invalid exam: ${checked.error.issues[0]?.message}`,
    );
  }
  await withWritableDb((db) =>
    db.meta.put({ key: SESSION_KEY, value: checked.data, updatedAt: nowIso() }),
  );
}

export async function clearExamSession(): Promise<void> {
  await withWritableDb((db) => db.meta.delete(SESSION_KEY));
}

export async function loadExamHistory(): Promise<ExamHistoryEntry[]> {
  const row = await withDb((db) => db.meta.get(HISTORY_KEY));
  return parseExamHistory(row?.value);
}

/** Add (or replace, by exam id) one summary; the list keeps the newest 20. Returns the new list. */
export async function recordExamHistory(entry: ExamHistoryEntry): Promise<ExamHistoryEntry[]> {
  const checked = ExamHistoryEntry.safeParse(entry);
  if (!checked.success) {
    throw new StudyVaultError('invalid_request', 'Invalid exam summary.');
  }
  return withWritableDb((db) =>
    db.transaction('rw', db.meta, async () => {
      const row = await db.meta.get(HISTORY_KEY);
      const next = pushHistory(parseExamHistory(row?.value), checked.data);
      await db.meta.put({ key: HISTORY_KEY, value: next, updatedAt: nowIso() });
      return next;
    }),
  );
}

export async function clearExamHistory(): Promise<void> {
  await withWritableDb((db) => db.meta.delete(HISTORY_KEY));
}

// ---------------------------------------------------------------------------------------------
// Count as review
// ---------------------------------------------------------------------------------------------

export interface ExamReviewResult {
  /** The answers written (or already written by an earlier attempt with the same keys). */
  logs: ExamReviewApplied['logs'];
  /** Cards that could not be reviewed (deleted or suspended since the exam). */
  unavailable: number;
}

/**
 * One review per planned item through `reviewCard`, keyed by the item's `logId`, so a retry after a
 * failure (or a double click) can never write a card's answer twice. Each call is its own
 * transaction: a failure part-way leaves the earlier ones written, and the retry skips them.
 */
export async function applyExamReview(
  items: readonly ExamReviewItem[],
  opts: { sessionId: string; now?: DateInput; boundary?: DayBoundary },
): Promise<ExamReviewResult> {
  const logs: ExamReviewResult['logs'] = [];
  let unavailable = 0;
  for (const item of items) {
    const out = await reviewCard(item.cardId, item.rating, {
      sessionId: opts.sessionId,
      logId: item.logId,
      durationMs: item.durationMs,
      ...(opts.now === undefined ? {} : { now: opts.now }),
      ...(opts.boundary === undefined ? {} : { boundary: opts.boundary }),
    });
    if (out.status === 'reviewed' || out.status === 'duplicate') {
      logs.push({ cardId: item.cardId, logId: item.logId, rating: item.rating });
    } else {
      unavailable += 1;
    }
  }
  return { logs, unavailable };
}

/**
 * Take the exam's reviews back (each card returns to the state recorded in its log). A card that
 * was reviewed again since is refused, never overwritten, and counted.
 */
export async function undoExamReview(
  logs: ExamReviewApplied['logs'],
  opts: { now?: DateInput } = {},
): Promise<{ undone: number; refused: number }> {
  let undone = 0;
  let refused = 0;
  for (const l of logs) {
    const out = await undoLastReview(l.cardId, {
      expectLogId: l.logId,
      ...(opts.now === undefined ? {} : { now: opts.now }),
    });
    if (out.status === 'undone') undone += 1;
    else refused += 1;
  }
  return { undone, refused };
}
