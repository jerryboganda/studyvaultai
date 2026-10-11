import { HighlightBank, HighlightTag, StudyVaultError, Tag, tagNameKey } from '@shared';
import {
  Card,
  Deck,
  ReviewLog,
  normalizeThresholds,
  toMs,
  type CoverageCard,
  type CoverageHighlight,
  type CoverageThresholds,
  type DateInput,
  type DayBoundary,
} from '@study';
import { notNull, now as nowIso, parseRow, readBanks, unique } from './core';
import { withDb, withWritableDb } from './db';
import { systemBoundary, type AnalyticsLog } from './study';

/**
 * What syllabus coverage (ADR-020 part 2) is computed from: plain facts read in ONE transaction, and
 * the two thresholds the person may change. The rules are `syllabusTopicCoverage` in `@study`.
 *
 * Imported by path (`@storage/syllabusCoverage`), not from the barrel: only the review page's
 * analytics view uses it, so no other bundle carries it. The thresholds live in the device-local
 * `meta` table (never exported or synchronised; "Delete all data" removes them with the database).
 */

const THRESHOLDS_KEY = 'syllabusThresholds';
/** Reviews older than this are not read: the retention shown is "the last twelve months". */
export const COVERAGE_HISTORY_DAYS = 365;

export interface SyllabusCoverageData {
  now: string;
  boundary: DayBoundary;
  /** Live highlights with the live banks and the tags they carry. */
  highlights: CoverageHighlight[];
  /** Cards of live decks with their banks and tags (own and the highlight's), as ids. */
  cards: CoverageCard[];
  logs: AnalyticsLog[];
  /** Live banks and tags, to name the ones a topic points at. */
  banks: { id: string; name: string }[];
  tags: { id: string; name: string }[];
}

export async function loadSyllabusCoverageData(
  options: { now?: DateInput; boundary?: DayBoundary; sinceDays?: number } = {},
): Promise<SyllabusCoverageData> {
  const nowMs = options.now === undefined ? Date.now() : toMs(options.now);
  const since = new Date(
    nowMs - Math.max(1, options.sinceDays ?? COVERAGE_HISTORY_DAYS) * 86_400_000,
  ).toISOString();
  return withDb((db) =>
    db.transaction(
      'r',
      [
        db.banks,
        db.decks,
        db.cards,
        db.highlights,
        db.highlightBanks,
        db.highlightTags,
        db.tags,
        db.reviewLogs,
      ],
      async () => {
        const banks = await readBanks(db);
        const liveBanks = new Set(banks.map((b) => b.id));

        const tags = (await db.tags.toArray())
          .map((r) => parseRow(Tag, r, 'tag'))
          .filter(notNull)
          .filter((t) => t.deletedAt === null);
        const liveTags = new Set(tags.map((t) => t.id));
        // A card's own tags are names: resolve them through names and aliases.
        const tagByKey = new Map<string, string>();
        for (const t of tags) {
          tagByKey.set(t.nameKey, t.id);
          for (const alias of t.aliases) {
            const key = tagNameKey(alias);
            if (!tagByKey.has(key)) tagByKey.set(key, t.id);
          }
        }

        // Highlights: every key minus the trashed ones (no row bodies are read).
        const trashed = new Set(
          (await db.highlights.where('deletedAt').above('').primaryKeys()) as string[],
        );
        const liveIds = ((await db.highlights.toCollection().primaryKeys()) as string[]).filter(
          (id) => !trashed.has(id),
        );
        const live = new Set(liveIds);
        const filed = new Map<string, string[]>();
        for (const row of await db.highlightBanks.toArray()) {
          const m = parseRow(HighlightBank, row, 'highlightBank');
          if (!m || !live.has(m.highlightId) || !liveBanks.has(m.bankId)) continue;
          const list = filed.get(m.highlightId);
          if (list) list.push(m.bankId);
          else filed.set(m.highlightId, [m.bankId]);
        }
        const tagged = new Map<string, string[]>();
        for (const row of await db.highlightTags.toArray()) {
          const link = parseRow(HighlightTag, row, 'highlightTag');
          if (!link || !live.has(link.highlightId) || !liveTags.has(link.tagId)) continue;
          const list = tagged.get(link.highlightId);
          if (list) list.push(link.tagId);
          else tagged.set(link.highlightId, [link.tagId]);
        }
        const highlights: CoverageHighlight[] = liveIds.map((id) => ({
          id,
          deletedAt: null,
          bankIds: unique(filed.get(id) ?? []),
          tagIds: unique(tagged.get(id) ?? []),
        }));

        // Cards of live decks.
        const decks = new Map(
          (await db.decks.toArray())
            .map((r) => parseRow(Deck, r, 'deck'))
            .filter(notNull)
            .filter((d) => d.deletedAt === null)
            .map((d) => [d.id, d] as const),
        );
        const cards: CoverageCard[] = [];
        for (const row of await db.cards.toArray()) {
          const c = parseRow(Card, row, 'card');
          if (!c || c.deletedAt !== null || !decks.has(c.deckId)) continue;
          // Filing and tags belong to the highlight; a highlight in the trash files nothing.
          const hid = c.highlightId !== null && live.has(c.highlightId) ? c.highlightId : null;
          const deckBank = decks.get(c.deckId)?.bankId ?? null;
          const own = c.tags
            .map((name) => tagByKey.get(tagNameKey(name)))
            .filter((id): id is string => id !== undefined);
          cards.push({
            id: c.id,
            deletedAt: null,
            suspended: c.suspended,
            fsrs: { state: c.fsrs.state, due: c.fsrs.due, lastReview: c.fsrs.lastReview },
            bankIds: unique([
              ...(deckBank !== null && liveBanks.has(deckBank) ? [deckBank] : []),
              ...(hid ? (filed.get(hid) ?? []) : []),
            ]),
            tagIds: unique([...own, ...(hid ? (tagged.get(hid) ?? []) : [])]),
          });
        }

        const cardIds = new Set(cards.map((c) => c.id));
        const logs: AnalyticsLog[] = [];
        for (const row of await db.reviewLogs.where('reviewedAt').aboveOrEqual(since).toArray()) {
          const l = parseRow(ReviewLog, row, 'review log');
          if (!l || !cardIds.has(l.cardId)) continue;
          logs.push({
            cardId: l.cardId,
            reviewedAt: l.reviewedAt,
            rating: l.rating,
            durationMs: l.durationMs,
            previousState: l.previousState,
            ...(l.userCorrection ? { userCorrection: l.userCorrection } : {}),
          });
        }

        return {
          now: new Date(nowMs).toISOString(),
          boundary: options.boundary ?? systemBoundary(),
          highlights,
          cards,
          logs,
          banks: banks.map((b) => ({ id: b.id, name: b.name })),
          tags: tags.map((t) => ({ id: t.id, name: t.name })),
        };
      },
    ),
  );
}

/** The thresholds the person set on this device, or the defaults. */
export async function loadCoverageThresholds(): Promise<CoverageThresholds> {
  const row = await withDb((db) => db.meta.get(THRESHOLDS_KEY));
  return normalizeThresholds(row?.value);
}

/** Whole numbers 0..999 only; the caller validates and explains, this refuses anything else. */
export async function saveCoverageThresholds(
  next: CoverageThresholds,
): Promise<CoverageThresholds> {
  const value = normalizeThresholds(next);
  if (value.minHighlights !== next.minHighlights || value.minCards !== next.minCards) {
    throw new StudyVaultError('invalid_request', 'Thresholds are whole numbers from 0 to 999.');
  }
  await withWritableDb((db) => db.meta.put({ key: THRESHOLDS_KEY, value, updatedAt: nowIso() }));
  return value;
}
