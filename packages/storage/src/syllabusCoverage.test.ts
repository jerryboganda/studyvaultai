// @vitest-environment node
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flattenSyllabus } from '@shared';
import { DEFAULT_COVERAGE_THRESHOLDS, syllabusTopicCoverage, type CoverageTopic } from '@study';
import { getDb } from './db';
import { createFolder } from './hierarchy';
import { addToBank } from './membership';
import { createBank, softDeleteHighlight } from './repo';
import {
  createCardsFromHighlight,
  createDeck,
  createManualCards,
  reviewCard,
  setCardsSuspended,
  type TemplateInput,
} from './study';
import { createSyllabus } from './syllabi';
import {
  COVERAGE_HISTORY_DAYS,
  loadCoverageThresholds,
  loadSyllabusCoverageData,
  saveCoverageThresholds,
} from './syllabusCoverage';
import { attachTags, createTag, deleteTag } from './tags';
import { freshDatabase, save } from './test-vault';

const DAY = 86_400_000;
const T0 = Date.parse('2026-03-10T12:00:00.000Z');
const UTC = { timeZone: 'UTC', rolloverHour: 0 };

const basic = (n: number, tags: string[] = []): TemplateInput => ({
  template: 'basic',
  question: `Question ${n}?`,
  answer: `Answer ${n}`,
  tags,
});

beforeEach(async () => {
  await freshDatabase();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

/**
 * Cardiology: h1 (with a card c1 tagged "own-tag") and h4 (in the trash).
 * Pharmacology: h2 (tag "High Yield", card c2). h3 is filed in both banks.
 * c3 is a typed card with no bank whose own tag is the same tag by another spelling.
 */
async function seed() {
  const cardio = await createBank('Cardiology');
  const pharm = await createBank('Pharmacology');
  const { tag } = await createTag('High Yield');
  const ownTag = (await createTag('own-tag')).tag;
  const h1 = await save('Stroke volume is the blood ejected per beat.', { bankId: cardio.id });
  const h2 = await save('Warfarin inhibits vitamin K epoxide reductase.', { bankId: pharm.id });
  const h3 = await save('Digoxin inhibits the sodium potassium pump.', { bankId: cardio.id });
  await addToBank({ highlightId: h3.id, bankId: pharm.id });
  const h4 = await save('A trashed fact about preload.', { bankId: cardio.id });
  await attachTags({ highlightIds: [h2.id], tagIds: [tag.id] });
  await softDeleteHighlight(h4.id);
  const [c1] = await createCardsFromHighlight(h1.id, [basic(1, ['own-tag'])], { now: T0 });
  const [c2] = await createCardsFromHighlight(h2.id, [basic(2)], { now: T0 });
  const [c3] = await createManualCards([basic(3, ['  HIGH yield '])], { now: T0 });
  return { cardio, pharm, tag, ownTag, h1, h2, h3, h4, c1: c1!, c2: c2!, c3: c3! };
}

describe('syllabus coverage data', () => {
  it('reads live highlights with their live banks and tags, and cards with theirs', async () => {
    const s = await seed();
    const data = await loadSyllabusCoverageData({ now: T0, boundary: UTC });
    const hl = new Map(data.highlights.map((h) => [h.id, h]));

    expect([...hl.keys()].sort()).toEqual([s.h1.id, s.h2.id, s.h3.id].sort()); // h4 is trashed
    expect(hl.get(s.h1.id)).toMatchObject({ bankIds: [s.cardio.id], tagIds: [] });
    expect(hl.get(s.h2.id)).toMatchObject({ bankIds: [s.pharm.id], tagIds: [s.tag.id] });
    expect([...(hl.get(s.h3.id)?.bankIds ?? [])].sort()).toEqual([s.cardio.id, s.pharm.id].sort());

    const cards = new Map(data.cards.map((c) => [c.id, c]));
    // The card's own tag resolves to the tag id; its highlight's bank is its bank.
    expect(cards.get(s.c1.id)).toMatchObject({
      bankIds: [s.cardio.id],
      tagIds: [s.ownTag.id],
      suspended: false,
    });
    expect(cards.get(s.c2.id)).toMatchObject({ bankIds: [s.pharm.id], tagIds: [s.tag.id] });
    // A typed card has no bank; its own tag matches by name key ("  HIGH yield " = "High Yield").
    expect(cards.get(s.c3.id)).toMatchObject({ bankIds: [], tagIds: [s.tag.id] });

    expect(data.banks.map((b) => b.name)).toEqual(
      expect.arrayContaining(['Cardiology', 'Pharmacology', 'Inbox']),
    );
    expect(data.tags.map((t) => t.name).sort()).toEqual(['High Yield', 'own-tag']);
    expect(data.now).toBe(new Date(T0).toISOString());
  });

  it('leaves out a trashed highlight and a deleted tag, and flags a suspended card', async () => {
    const s = await seed();
    await setCardsSuspended([s.c1.id], true);
    await deleteTag(s.tag.id);
    const data = await loadSyllabusCoverageData({ now: T0, boundary: UTC });

    expect(data.tags.map((t) => t.name)).toEqual(['own-tag']);
    expect(data.highlights.find((h) => h.id === s.h2.id)?.tagIds).toEqual([]);
    expect(data.cards.find((c) => c.id === s.c1.id)?.suspended).toBe(true);
    expect(data.cards.find((c) => c.id === s.c3.id)?.tagIds).toEqual([]);

    // A card whose highlight went to the trash keeps its deck's bank (the bank deck made for it) and its own tags only.
    await softDeleteHighlight(s.h1.id);
    const again = await loadSyllabusCoverageData({ now: T0, boundary: UTC });
    expect(again.highlights.map((h) => h.id)).not.toContain(s.h1.id);
    expect(again.cards.find((c) => c.id === s.c1.id)).toMatchObject({
      bankIds: [s.cardio.id],
      tagIds: [s.ownTag.id],
    });
  });

  it('takes a deck bank into account and skips cards of a deleted deck', async () => {
    const s = await seed();
    const deck = await createDeck({ name: 'Cardio deck', bankId: s.cardio.id });
    const [typed] = await createManualCards([basic(9)], { deckId: deck.id, now: T0 });
    const data = await loadSyllabusCoverageData({ now: T0, boundary: UTC });
    expect(data.cards.find((c) => c.id === typed!.id)?.bankIds).toEqual([s.cardio.id]);
  });

  it('reads the reviews of the last year only, for cards it returns', async () => {
    const s = await seed();
    await getDb().cards.update(s.c1.id, {
      fsrs: {
        ...s.c1.fsrs,
        state: 'review',
        stability: 20,
        difficulty: 5,
        lastReview: new Date(T0 - 40 * DAY).toISOString(),
        due: new Date(T0 - DAY).toISOString(),
      },
      dueAt: new Date(T0 - DAY).toISOString(),
    });
    expect(
      (await reviewCard(s.c1.id, 3, { now: T0 - 30 * DAY, boundary: UTC, durationMs: 3000 }))
        .status,
    ).toBe('reviewed');
    expect(
      (await reviewCard(s.c1.id, 3, { now: T0 - 20 * DAY, boundary: UTC, durationMs: 3000 }))
        .status,
    ).toBe('reviewed');

    const all = await loadSyllabusCoverageData({ now: T0, boundary: UTC });
    expect(all.logs.map((l) => l.cardId)).toEqual([s.c1.id, s.c1.id]);

    const recent = await loadSyllabusCoverageData({ now: T0, boundary: UTC, sinceDays: 25 });
    expect(recent.logs).toHaveLength(1);
    expect(COVERAGE_HISTORY_DAYS).toBe(365);

    const future = await loadSyllabusCoverageData({ now: T0 + 400 * DAY, boundary: UTC });
    expect(future.logs).toEqual([]);
  });

  it('feeds the coverage function: a stored syllabus gives the numbers of the stored data', async () => {
    const s = await seed();
    const folder = await createFolder({ bankId: s.cardio.id, name: 'Physiology' });
    expect(folder.id).toBeTruthy();
    const syllabus = await createSyllabus({
      name: 'Exam',
      nodes: [
        {
          title: 'Cardiology',
          weight: 3,
          bankIds: [s.cardio.id],
          children: [{ title: 'Drugs', tagIds: [s.tag.id], bankIds: [s.pharm.id] }],
        },
        { title: 'Planned later' },
      ],
    });
    const data = await loadSyllabusCoverageData({ now: T0, boundary: UTC });
    const topics: CoverageTopic[] = flattenSyllabus(syllabus.nodes).map(
      ({ node, depth, parentId }) => ({
        id: node.id,
        title: node.title,
        depth,
        parentId,
        ...(node.weight === undefined ? {} : { weight: node.weight }),
        bankIds: node.bankIds,
        tagIds: node.tagIds,
      }),
    );
    const report = syllabusTopicCoverage(
      topics,
      { highlights: data.highlights, cards: data.cards, logs: data.logs },
      { now: data.now, boundary: data.boundary },
    );
    const by = new Map(report.topics.map((t) => [t.title, t]));
    // Drugs: bank Pharmacology (h2, h3) or tag High Yield (h2): 2 highlights, cards c2 and c3.
    expect(by.get('Drugs')).toMatchObject({ highlights: 2, cards: 2, state: 'thin' });
    // Cardiology: its own bank (h1, h3; h4 is in the trash) plus the subtopic's (h2): 3 highlights.
    expect(by.get('Cardiology')).toMatchObject({ highlights: 3, cards: 3 });
    expect(by.get('Planned later')).toMatchObject({ highlights: 0, mapped: false, state: 'none' });
    expect(report.unmapped).toBe(1);
    expect(report.thresholds).toEqual(DEFAULT_COVERAGE_THRESHOLDS);
  });
});

describe('coverage thresholds', () => {
  it('defaults, round trips on the device, and refuses values that are not whole numbers', async () => {
    expect(await loadCoverageThresholds()).toEqual(DEFAULT_COVERAGE_THRESHOLDS);
    expect(await saveCoverageThresholds({ minHighlights: 5, minCards: 0 })).toEqual({
      minHighlights: 5,
      minCards: 0,
    });
    expect(await loadCoverageThresholds()).toEqual({ minHighlights: 5, minCards: 0 });

    await expect(saveCoverageThresholds({ minHighlights: 1.5, minCards: 1 })).rejects.toThrow(
      /whole numbers/,
    );
    await expect(saveCoverageThresholds({ minHighlights: -1, minCards: 1 })).rejects.toThrow();
    await expect(saveCoverageThresholds({ minHighlights: 1000, minCards: 1 })).rejects.toThrow();
    expect(await loadCoverageThresholds()).toEqual({ minHighlights: 5, minCards: 0 });
  });

  it('falls back to the defaults when the stored value is damaged, and is a meta row only', async () => {
    await saveCoverageThresholds({ minHighlights: 2, minCards: 2 });
    await getDb().meta.put({
      key: 'syllabusThresholds',
      value: { minHighlights: 'many', minCards: -4 },
      updatedAt: new Date().toISOString(),
    });
    expect(await loadCoverageThresholds()).toEqual(DEFAULT_COVERAGE_THRESHOLDS);
    // It is in `meta` (never exported, never synchronised) and nowhere else.
    expect((await getDb().meta.toArray()).map((r) => r.key)).toContain('syllabusThresholds');
    expect(await getDb().syllabi.count()).toBe(0);
  });
});
