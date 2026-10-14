// @vitest-environment node
//
// Regenerates src/fixtures/schema-v4-study.json, the FROZEN version-4 vault that migration.test.ts
// upgrades to version 5 and backfills. Run only when the fixture is deliberately (re)created:
//
//   SV_REGEN_FIXTURES=1 pnpm exec vitest run packages/storage/src/fixtures.generate.test.ts
//
// It drives the real repositories, then keeps only what a version-4 build stores: the v4 tables
// (the v5 game tables are dropped; no v4 row shape differs from v5) and a v4 schema marker. Without
// the variable this file defines no tests.
import 'fake-indexeddb/auto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { META_SCHEMA_KEY, SCHEMA_V4 } from './db';
import { createBank, saveCapture, softDeleteHighlight } from './repo';
import { createCardsFromHighlight, reviewCard, startStudySession, undoLastReview } from './study';
import { cap } from './test-fixtures';
import { acceptTwoAiCards, importQuote } from './test-game';
import { dump, freshDatabase } from './test-vault';

const enabled = process.env.SV_REGEN_FIXTURES === '1';
const NEW_YORK = { timeZone: 'America/New_York', rolloverHour: 4 };

afterEach(() => {
  vi.useRealTimers();
});

describe.runIf(enabled)('version-4 study fixture generator', () => {
  it('writes schema-v4-study.json', async () => {
    await freshDatabase();
    vi.useFakeTimers({ toFake: ['Date'] });
    const clock = (iso: string) => vi.setSystemTime(new Date(iso));

    clock('2026-03-07T15:00:00.000Z');
    const bank = await createBank('Cardiology');
    const save = async (quote: string, start: number) =>
      (await saveCapture(cap(quote, start, { bankId: bank.id }))).highlight;
    const h1 = await save('Aspirin irreversibly inhibits cyclooxygenase.', 100);
    clock('2026-03-07T15:05:00.000Z');
    const h2 = await save('Warfarin inhibits vitamin K epoxide reductase.', 300);
    clock('2026-03-07T15:10:00.000Z');
    const h3 = await save('Heparin potentiates antithrombin III.', 500);
    clock('2026-03-07T15:12:00.000Z');
    await importQuote('Digoxin inhibits the sodium-potassium ATPase.');

    const [card1] = await createCardsFromHighlight(
      h1.id,
      [{ template: 'basic', question: 'What does aspirin inhibit?', answer: 'COX' }],
      { now: '2026-03-07T15:20:00.000Z' },
    );
    const [card2, card3] = await createCardsFromHighlight(
      h2.id,
      [
        {
          template: 'cloze',
          markup: '{{c1::Warfarin}} inhibits {{c2::vitamin K}} epoxide reductase.',
        },
      ],
      { now: '2026-03-07T15:25:00.000Z' },
    );

    clock('2026-03-07T15:30:00.000Z');
    const aiCards = await acceptTwoAiCards(h1);

    clock('2026-03-07T16:00:00.000Z');
    await softDeleteHighlight(h3.id); // trashed 50 minutes after the save

    const { session } = await startStudySession({
      now: '2026-03-07T20:59:00.000Z',
      boundary: NEW_YORK,
    });
    const answer = (cardId: string, rating: 1 | 2 | 3 | 4, now: string, sessionId?: string) =>
      reviewCard(cardId, rating, { now, boundary: NEW_YORK, ...(sessionId ? { sessionId } : {}) });
    // 16:00 EST on Saturday
    expect((await answer(card1!.id, 3, '2026-03-07T21:00:00.000Z', session.id)).status).toBe(
      'reviewed',
    );
    // 03:30 EDT on Sunday, right after the clocks went forward: still Saturday's study day
    expect((await answer(card2!.id, 3, '2026-03-08T07:30:00.000Z', session.id)).status).toBe(
      'reviewed',
    );
    // 05:00 EDT: Sunday's study day
    expect((await answer(card3!.id, 2, '2026-03-08T09:00:00.000Z', session.id)).status).toBe(
      'reviewed',
    );
    // Monday: an answer that is undone a minute later ...
    expect((await answer(card1!.id, 4, '2026-03-09T14:00:00.000Z', session.id)).status).toBe(
      'reviewed',
    );
    expect((await undoLastReview(card1!.id, { now: '2026-03-09T14:01:00.000Z' })).status).toBe(
      'undone',
    );
    // ... and a one-off review of an AI card, outside the session
    expect((await answer(aiCards[0]!.id, 1, '2026-03-09T15:00:00.000Z')).status).toBe('reviewed');

    const all = await dump();
    const tables: Record<string, unknown[]> = {};
    for (const name of Object.keys(SCHEMA_V4)) {
      tables[name] = name === 'meta' ? [] : (all[name] ?? []);
    }
    const studySession = all.meta?.find((m) => m.key === 'studySession');
    tables.meta = [
      {
        key: META_SCHEMA_KEY,
        value: {
          recordSchemaVersion: 1,
          migratedFrom: 3,
          migratedAt: '2026-02-01T08:00:00.000Z',
          dbVersion: 4,
          v4MigratedAt: '2026-02-01T08:00:00.000Z',
        },
        updatedAt: '2026-02-01T08:00:00.000Z',
      },
      ...(studySession ? [studySession] : []),
    ];
    writeFileSync(
      resolve(__dirname, 'fixtures', 'schema-v4-study.json'),
      `${JSON.stringify(
        {
          _note:
            'Frozen: a version-4 vault (Dexie v4 tables only) with three web saves (one trashed 50 minutes later), one imported highlight, a basic card, a two-card cloze, two AI cards, a review session across the America/New_York DST change of 2026-03-08 (one answer undone) and a one-off review. Generated by fixtures.generate.test.ts; never regenerate.',
          boundary: NEW_YORK,
          tables,
        },
        null,
        2,
      )}\n`,
    );
  });
});
