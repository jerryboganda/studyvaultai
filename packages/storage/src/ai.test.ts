// @vitest-environment node
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { uuidv7 } from 'uuidv7';
import { exportBackup, exportJson, restoreBackup } from '@backup';
import { AiResult, createMockProvider, runTask, type AiSelection, type AiTaskKind } from '@ai';
import { approve, goodReply, makeDeps } from '@ai/testkit';
import { SCHEMA_VERSION, type HighlightView, type Note } from '@shared';
import { DEFAULT_DECK_SETTINGS, type Card, type Deck, type KnowledgePoint } from '@study/schema';
import { createCard } from '@study/cards';
import {
  AI_SECRET_META_KEYS,
  StoredAiResultSchema,
  acceptAiItem,
  addAiSpend,
  aiItemPaths,
  checkAiEndpoint,
  clearAiApiKey,
  clearAiData,
  countAiResults,
  createAiCache,
  defaultAiSettings,
  deleteAiResult,
  discardAiItems,
  getAiApiKey,
  getAiBudget,
  getAiKeyInfo,
  getAiResult,
  getAiSettings,
  listAiDeckChoices,
  listAiResults,
  rejectAiResult,
  resolveAiSources,
  saveAiResult,
  setAiApiKey,
  setAiSettings,
  type StoredAiResult,
} from './ai';
import {
  BACKUP_EXCLUDED_TABLES,
  BACKUP_MIGRATIONS,
  backupTableRegistry,
  createBackupTarget,
  createSnapshotSource,
} from './backupTarget';
import { getDb } from './db';
import { createNote, deleteNote } from './notes';
import { checkIntegrity, getTableRegistry } from './registry';
import { softDeleteHighlight } from './repo';
import { purge } from './trash';
import { dump, freshDatabase, save } from './test-vault';

const KEY = 'sk-test-0123456789abcdefSECRETKEY';
let h1: HighlightView;
let h2: HighlightView;

beforeEach(async () => {
  await freshDatabase();
  h1 = await save(
    'Metformin is the first-line pharmacological treatment for type 2 diabetes mellitus.',
  );
  h2 = await save(
    'Insulin therapy is required in type 1 diabetes mellitus because beta cells are destroyed.',
  );
});

const chunk = (h: HighlightView) => ({
  id: h.id,
  kind: 'highlight' as const,
  text: h.exactQuote,
});

/** A real AiResult produced by the real pipeline against a scripted provider. */
async function produce(
  kind: AiTaskKind,
  selection: AiSelection,
  reply?: (good: unknown) => unknown,
): Promise<AiResult> {
  const good = goodReply(kind, selection);
  const provider = createMockProvider([{ json: reply ? reply(good) : good }]);
  const deps = makeDeps(provider, { randomId: () => uuidv7() });
  const opts = await approve(kind, selection, deps);
  const out = await runTask(kind, selection, deps, opts);
  return out.result;
}

const pearl = () => produce('exam_pearl', { chunks: [chunk(h1), chunk(h2)] });

function kpFor(result: AiResult, highlightId: string): KnowledgePoint {
  const ts = new Date().toISOString();
  return {
    id: uuidv7(),
    schemaVersion: SCHEMA_VERSION,
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
    highlightId,
    primaryQuoteId: highlightId,
    shortOneLiner: 'Metformin is first-line for type 2 diabetes.',
    examPearl: 'It is the standard initial drug.',
    misconception: null,
    verificationStatus: 'not_checked',
    claims: [
      {
        text: 'Metformin is first-line.',
        evidenceHighlightIds: [highlightId],
        reliability: 'unrated',
      },
    ],
    createdBy: 'ai',
    acceptedAt: ts,
  };
}

function deckOf(name = 'AI drafts'): Deck {
  const ts = new Date().toISOString();
  return {
    id: uuidv7(),
    schemaVersion: SCHEMA_VERSION,
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
    bankId: null,
    name,
    settings: { ...DEFAULT_DECK_SETTINGS },
  };
}

function cardOf(deckId: string, highlightId: string, resultId: string, quote: string | null): Card {
  return createCard(
    {
      cardType: 'basic',
      front: 'What is first-line for T2DM?',
      back: 'Metformin',
      cloze: null,
      tags: [],
      knowledgePointId: null,
      highlightId,
      sourceQuote: quote,
      createdBy: 'ai',
      aiResultId: resultId,
      needsHumanVerification: true,
    },
    { id: uuidv7(), deckId },
    new Date(),
  );
}

function noteOf(highlightId: string | null): Note {
  const ts = new Date().toISOString();
  return {
    id: uuidv7(),
    schemaVersion: SCHEMA_VERSION,
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
    highlightId,
    sourceId: null,
    title: 'AI summary',
    body: '> **AI-generated, unverified.**\n\nSummary text.',
    pinned: false,
  };
}

describe('aiResults rows', () => {
  it('registers its schema and stores a validated row with the index fields', async () => {
    const result = await pearl();
    const row = await saveAiResult(result);
    expect(row.highlightId).toBe(h1.id);
    expect(row.acceptedAt).toBeNull();
    expect(row.items).toEqual({});

    const db = getDb();
    expect(
      (await db.aiResults.where('highlightId').equals(h1.id).toArray()).map((r) => r.id),
    ).toEqual([result.id]);
    expect(
      (await db.aiResults.where('inputFingerprint').equals(result.inputFingerprint).toArray())
        .length,
    ).toBe(1);
    expect((await db.aiResults.where('kind').equals('exam_pearl').toArray()).length).toBe(1);

    const spec = getTableRegistry().tables.find((t) => t.name === 'aiResults')!;
    expect(spec.schema).toBe(StoredAiResultSchema);
    const raw = (await dump()).aiResults![0]!;
    expect(spec.schema.safeParse(raw).success).toBe(true);
    expect(spec.schema.safeParse({ ...raw, output: { oneLiner: 'x' } }).success).toBe(false);
    expect(spec.schema.safeParse({ ...raw, acceptedAt: new Date().toISOString() }).success).toBe(
      false,
    );
    expect((await checkIntegrity()).ok).toBe(true);
  });

  it('keeps review state when the same result is saved again', async () => {
    const result = await pearl();
    await saveAiResult(result);
    await acceptAiItem({
      resultId: result.id,
      itemPath: '',
      edited: false,
      knowledgePoint: kpFor(result, h1.id),
    });
    const again = await saveAiResult(result);
    expect(again.items['']?.state).toBe('accepted');
    expect(await countAiResults()).toBe(1);
  });

  it('lists newest first and filters by highlight and kind', async () => {
    const a = await pearl();
    await saveAiResult(a);
    const b = await produce('summary', { chunks: [chunk(h2)] });
    await saveAiResult(b);
    expect((await listAiResults()).length).toBe(2);
    expect((await listAiResults({ highlightIds: [h2.id] })).map((r) => r.id).sort()).toEqual(
      [a.id, b.id].sort(),
    ); // the pearl used both highlights
    expect((await listAiResults({ highlightIds: [h1.id] })).map((r) => r.id)).toEqual([a.id]);
    expect((await listAiResults({ kind: 'summary' })).map((r) => r.id)).toEqual([b.id]);
    expect(await getAiResult('nope-nope-nope')).toBeNull();
    await deleteAiResult(a.id);
    expect(await countAiResults()).toBe(1);
  });

  it('skips a row that cannot be read instead of failing the list', async () => {
    const good = await pearl();
    await saveAiResult(good);
    await getDb().aiResults.put({ id: 'corrupt-row-0001', kind: 'summary' });
    expect((await listAiResults()).map((r) => r.id)).toEqual([good.id]);
  });
});

describe('AiCache port', () => {
  it('serves a stored result by fingerprint as a strict AiResult', async () => {
    const result = await pearl();
    const cache = createAiCache();
    expect(await cache.get(result.inputFingerprint)).toBeNull();
    await cache.put(result);
    const hit = await cache.get(result.inputFingerprint);
    expect(AiResult.safeParse(hit).success).toBe(true);
    expect(hit?.id).toBe(result.id);
  });

  it('makes the second identical run a cache hit that calls no provider', async () => {
    const selection: AiSelection = { chunks: [chunk(h1)] };
    const provider = createMockProvider([{ json: goodReply('summary', selection) }]);
    const cache = createAiCache();
    const deps = makeDeps(provider, { cache, randomId: () => uuidv7() });
    const first = await runTask(
      'summary',
      selection,
      deps,
      await approve('summary', selection, deps),
    );
    const second = await runTask(
      'summary',
      selection,
      deps,
      await approve('summary', selection, deps),
    );
    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(second.result.id).toBe(first.result.id);
    expect(provider.calls).toHaveLength(1);
    expect(await countAiResults()).toBe(1);
  });

  it('does not serve a result whose every item was discarded', async () => {
    const result = await pearl();
    await saveAiResult(result);
    await discardAiItems(result.id, ['']);
    expect(await createAiCache().get(result.inputFingerprint)).toBeNull();
    expect(await countAiResults()).toBe(0);
  });
});

describe('acceptAiItem', () => {
  it('creates a knowledge point and marks the result accepted, once', async () => {
    const result = await pearl();
    await saveAiResult(result);
    const input = {
      resultId: result.id,
      itemPath: '',
      edited: false,
      knowledgePoint: kpFor(result, h1.id),
    };
    const first = await acceptAiItem(input);
    expect(first.alreadyAccepted).toBe(false);
    expect(first.result.verificationState).toBe('source_supported');
    expect(first.result.acceptedAt).not.toBeNull();
    expect(first.result.items['']?.targets).toEqual([
      { table: 'knowledgePoints', id: input.knowledgePoint.id },
    ]);
    const db = getDb();
    const kp = await db.knowledgePoints.get(input.knowledgePoint.id);
    expect(kp).toMatchObject({ createdBy: 'ai', verificationStatus: 'not_checked' });
    // The quote is untouched.
    expect((await db.highlights.get(h1.id))?.exactQuote).toBe(h1.exactQuote);

    // A second click (or a retry) creates nothing more.
    const second = await acceptAiItem({ ...input, knowledgePoint: kpFor(result, h1.id) });
    expect(second.alreadyAccepted).toBe(true);
    expect(await db.knowledgePoints.count()).toBe(1);
  });

  it('adds cards to a new deck, takes the quote from the highlight, and accepts items one by one', async () => {
    const selection: AiSelection = { chunks: [chunk(h1)] };
    const result = await produce('flashcards', selection);
    await saveAiResult(result);
    expect(aiItemPaths(result)).toEqual(['/cards/0', '/cards/1']);

    const deck = deckOf();
    const forged = cardOf(deck.id, h1.id, result.id, 'A quote the model made up');
    const out = await acceptAiItem({
      resultId: result.id,
      itemPath: '/cards/0',
      edited: false,
      deck,
      cards: [forged],
    });
    expect(out.result.items['/cards/0']?.state).toBe('accepted');
    expect(out.result.items['/cards/1']).toBeUndefined();
    const stored = await getDb().cards.get(forged.id);
    expect(stored).toMatchObject({ sourceQuote: h1.exactQuote, createdBy: 'ai' });
    expect(await listAiDeckChoices()).toEqual([{ id: deck.id, name: 'AI drafts' }]);

    // Second card into the existing deck.
    const second = cardOf(deck.id, h1.id, result.id, h1.exactQuote);
    await acceptAiItem({
      resultId: result.id,
      itemPath: '/cards/1',
      edited: true,
      cards: [second],
    });
    expect(await getDb().cards.count()).toBe(2);
    expect((await getAiResult(result.id))?.items['/cards/1']?.edited).toBe(true);
  });

  it('is atomic: a bad link creates nothing and leaves the result untouched', async () => {
    const result = await pearl();
    await saveAiResult(result);
    const stranger = await save('A highlight that was not an input of the result.');
    const db = getDb();
    await expect(
      acceptAiItem({
        resultId: result.id,
        itemPath: '',
        edited: false,
        knowledgePoint: kpFor(result, stranger.id),
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      acceptAiItem({
        resultId: result.id,
        itemPath: '',
        edited: false,
        note: { ...noteOf(h1.id), sourceId: 'src-doesnotexist' },
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(await db.knowledgePoints.count()).toBe(0);
    expect(await db.notes.count()).toBe(0);
    expect((await getAiResult(result.id))?.acceptedAt).toBeNull();
  });

  it('refuses an unknown item and a missing deck, and wants exactly one object kind', async () => {
    const result = await produce('flashcards', { chunks: [chunk(h1)] });
    await saveAiResult(result);
    const deck = deckOf();
    await expect(
      acceptAiItem({
        resultId: result.id,
        itemPath: '/cards/9',
        edited: false,
        deck,
        cards: [cardOf(deck.id, h1.id, result.id, null)],
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      acceptAiItem({
        resultId: result.id,
        itemPath: '/cards/0',
        edited: false,
        cards: [cardOf(uuidv7(), h1.id, result.id, null)],
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      acceptAiItem({ resultId: result.id, itemPath: '/cards/0', edited: false }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('never marks an unsupported result accepted as a whole, but lets an item be taken', async () => {
    const result = await produce('summary', { chunks: [chunk(h1)] }, (good) => ({
      ...(good as object),
      evidence: [{ quoteId: h1.id, text: 'text that appears nowhere in the source passage' }],
    }));
    expect(result.verificationState).toBe('unsupported');
    await saveAiResult(result);
    const out = await acceptAiItem({
      resultId: result.id,
      itemPath: '',
      edited: true,
      note: noteOf(h1.id),
    });
    expect(out.result.verificationState).toBe('unsupported');
    expect(out.result.acceptedAt).toBeNull();
    expect(out.result.items['']?.state).toBe('accepted');
    const note = (await getDb().notes.toArray())[0]!;
    expect(note.body).toContain('AI-generated, unverified');
  });
});

describe('question and reject', () => {
  it('stores the question of an explain result, also when the cache saved the row first', async () => {
    const selection: AiSelection = { chunks: [chunk(h1)], question: 'What is first-line?' };
    const result = await produce('explain', selection);
    await createAiCache().put(result); // what the pipeline does before the caller can
    const row = await saveAiResult(result, { question: '  What is first-line?  ' });
    expect(row.question).toBe('What is first-line?');
    // A later save does not replace it.
    expect((await saveAiResult(result, { question: 'Something else' })).question).toBe(
      'What is first-line?',
    );
    expect((await getDb().aiResults.get(result.id))?.question).toBe('What is first-line?');
    expect(StoredAiResultSchema.safeParse(await getDb().aiResults.get(result.id)).success).toBe(
      true,
    );
  });

  it('reject discards every undecided item and drops the result', async () => {
    const result = await produce('flashcards', { chunks: [chunk(h1)] });
    await saveAiResult(result);
    await rejectAiResult(result.id);
    expect(await getAiResult(result.id)).toBeNull();
    await expect(rejectAiResult(result.id)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('discardAiItems', () => {
  it('keeps a result that still has an undecided or accepted item, and drops one fully discarded', async () => {
    const result = await produce('flashcards', { chunks: [chunk(h1)] });
    await saveAiResult(result);
    const deck = deckOf();
    await acceptAiItem({
      resultId: result.id,
      itemPath: '/cards/0',
      edited: false,
      deck,
      cards: [cardOf(deck.id, h1.id, result.id, null)],
    });
    // Accepted items are never un-accepted by a discard.
    const after = await discardAiItems(result.id, ['/cards/0', '/cards/1']);
    expect(after.items['/cards/0']?.state).toBe('accepted');
    expect(after.items['/cards/1']?.state).toBe('discarded');
    expect(await countAiResults()).toBe(1);
  });
});

describe('sources', () => {
  it('resolves ids to the immutable vault text, flags deleted ones and omits unknown ones', async () => {
    const note = await getDb().notes.put({ ...noteOf(null) });
    const map = await resolveAiSources([h1.id, h2.id, 'unknown-id-0001', note]);
    expect(map.get(h1.id)).toMatchObject({
      kind: 'highlight',
      text: h1.exactQuote,
      deleted: false,
    });
    expect(map.get(note)).toMatchObject({ kind: 'note' });
    expect(map.has('unknown-id-0001')).toBe(false);
  });
});

describe('settings, key and ledger', () => {
  it('round-trips settings and falls back to defaults for junk', async () => {
    expect(await getAiSettings()).toEqual(defaultAiSettings());
    const next = {
      ...defaultAiSettings(),
      baseUrl: 'https://api.example.test/v1',
      model: 'm',
      pricing: { inputUsdPerMTok: 1, outputUsdPerMTok: 2 },
    };
    await setAiSettings(next);
    expect(await getAiSettings()).toEqual(next);
    await expect(
      setAiSettings({ ...next, limits: { maxRequestsPerDay: -1, maxCostUsdPerDay: null } }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await getDb().meta.put({ key: 'aiSettings', value: { provider: 'nope' }, updatedAt: 'x' });
    expect(await getAiSettings()).toEqual(defaultAiSettings());
  });

  it('keeps the key in the meta table only, bound to its origin, never in results', async () => {
    await setAiApiKey(KEY, 'https://api.example.test');
    expect(await getAiApiKey('https://api.example.test')).toBe(KEY);
    expect(await getAiApiKey('https://evil.example')).toBeNull();
    expect(await getAiKeyInfo()).toEqual({
      present: true,
      origin: 'https://api.example.test',
      last4: KEY.slice(-4),
    });
    expect(AI_SECRET_META_KEYS).toEqual(['aiKey']);

    await saveAiResult(await pearl());
    const all = await dump();
    const holders = Object.entries(all)
      .filter(([, rows]) => JSON.stringify(rows).includes(KEY))
      .map(([table]) => table);
    expect(holders).toEqual(['meta']);
    expect(all.meta!.filter((r) => JSON.stringify(r).includes(KEY)).map((r) => r.key)).toEqual([
      'aiKey',
    ]);

    await expect(setAiApiKey('short', 'https://api.example.test')).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(
      setAiApiKey('sk-with space inside it', 'https://api.example.test'),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await clearAiApiKey();
    expect(await getAiApiKey('https://api.example.test')).toBeNull();
    expect((await getAiKeyInfo()).present).toBe(false);
  });

  it('adds spend atomically and starts a new day at zero', async () => {
    const day1 = Date.parse('2026-10-11T10:00:00Z');
    const day2 = Date.parse('2026-10-12T00:00:01Z');
    await Promise.all([
      addAiSpend({ requests: 1, costUsd: 0.01, inputTokens: 100, outputTokens: 20 }, day1),
      addAiSpend({ requests: 2, costUsd: null, inputTokens: 50, outputTokens: 10 }, day1),
    ]);
    expect(await getAiBudget(day1)).toEqual({
      day: '2026-10-11',
      requests: 3,
      costUsd: 0.01,
      inputTokens: 150,
      outputTokens: 30,
    });
    expect(await getAiBudget(day2)).toMatchObject({ day: '2026-10-12', requests: 0 });
  });

  it('deletes all AI data but keeps what the user accepted', async () => {
    await setAiApiKey(KEY, 'https://api.example.test');
    await setAiSettings({ ...defaultAiSettings(), model: 'm' });
    await addAiSpend({ requests: 1, costUsd: 0, inputTokens: 1, outputTokens: 1 });
    const result = await pearl();
    await saveAiResult(result);
    await acceptAiItem({
      resultId: result.id,
      itemPath: '',
      edited: false,
      knowledgePoint: kpFor(result, h1.id),
    });
    await clearAiData();
    const db = getDb();
    expect(await db.aiResults.count()).toBe(0);
    expect(await db.meta.get('aiKey')).toBeUndefined();
    expect(await db.meta.get('aiSettings')).toBeUndefined();
    expect(await db.meta.get('aiBudget')).toBeUndefined();
    expect(await db.knowledgePoints.count()).toBe(1);
    expect(await db.highlights.get(h1.id)).toBeDefined();
  });
});

describe('backup and export', () => {
  it('never contains the key, keeps AI drafts and their review state, and restores cleanly', async () => {
    await setAiApiKey(KEY, 'https://api.example.test');
    await setAiSettings({ ...defaultAiSettings(), baseUrl: 'https://api.example.test/v1' });
    const result = await pearl();
    await saveAiResult(result);
    await acceptAiItem({
      resultId: result.id,
      itemPath: '',
      edited: false,
      knowledgePoint: kpFor(result, h1.id),
    });

    expect(BACKUP_EXCLUDED_TABLES).toContain('meta');
    expect(backupTableRegistry.tables.map((t) => t.name)).not.toContain('meta');

    // The table that holds the key cannot be exported, even when asked for by name.
    await expect(
      exportBackup(await createSnapshotSource(), { includeLocalOnlyTables: ['meta'] }),
    ).rejects.toThrow(/Unknown table/);
    const zip = await exportBackup(await createSnapshotSource(), { appVersion: 'test' });
    const files = unzipSync(zip.bytes);
    const text = Object.values(files)
      .map((f) => strFromU8(f))
      .join('\n');
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('aiKey');
    expect(zip.manifest.tables.map((t) => t.name)).toContain('aiResults');
    const json = await exportJson(await createSnapshotSource(), { appVersion: 'test' });
    expect(strFromU8(json.bytes)).not.toContain(KEY);

    const before = (await dump()).aiResults;
    await getDb().aiResults.clear();
    await getDb().knowledgePoints.clear();
    const { report } = await restoreBackup(zip.bytes, {
      target: createBackupTarget(),
      mode: 'replace',
      migrations: BACKUP_MIGRATIONS,
    });
    expect(report.totals.invalid).toBe(0);
    expect((await dump()).aiResults).toEqual(before);
    expect((await getAiResult(result.id))?.items['']?.state).toBe('accepted');
    expect((await checkIntegrity()).ok).toBe(true);
    // The restore does not touch the key on this device either.
    expect(await getAiApiKey('https://api.example.test')).toBe(KEY);
  });
});

describe('checkAiEndpoint', () => {
  it('accepts https and the two loopback http hosts the CSP allows', () => {
    expect(checkAiEndpoint('openai_compatible', 'https://api.openai.com/v1/')).toMatchObject({
      ok: true,
      origin: 'https://api.openai.com',
      url: 'https://api.openai.com/v1',
      pattern: 'https://api.openai.com/*',
      loopback: false,
    });
    expect(checkAiEndpoint('openai_compatible', 'http://localhost:11434/v1')).toMatchObject({
      ok: true,
      pattern: 'http://localhost/*',
      loopback: true,
    });
    expect(checkAiEndpoint('openai_compatible', 'http://127.0.0.1:1234/v1')).toMatchObject({
      ok: true,
      loopback: true,
    });
    expect(checkAiEndpoint('anthropic', '')).toMatchObject({
      ok: true,
      origin: 'https://api.anthropic.com',
    });
  });

  it('refuses everything else with a reason', () => {
    for (const bad of [
      '',
      'not a url',
      'http://example.com/v1',
      'http://192.168.1.5:11434/v1',
      'http://[::1]:11434/v1',
      'http://foo.localhost:1234/v1',
      'https://user:pw@api.example.test/v1',
      'https://api.example.test/v1?key=1',
      'ftp://api.example.test',
    ]) {
      const r = checkAiEndpoint('openai_compatible', bad);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.reason.length).toBeGreaterThan(10);
    }
  });
});

describe('purging the inputs of a result', () => {
  it('removes the result (output and evidence quotes) whichever highlight input is purged', async () => {
    const result = await pearl(); // inputs: h1 (what the highlightId index names) and h2
    const stored = await saveAiResult(result);
    expect(stored.highlightId).toBe(h1.id);
    expect(stored.inputSourceIds).toEqual(expect.arrayContaining([h1.id, h2.id]));

    await softDeleteHighlight(h2.id);
    const purged = await purge([{ kind: 'highlight', id: h2.id }]);
    expect(purged.related.aiResults).toBe(1);
    expect(await getAiResult(result.id)).toBeNull();
    expect(await countAiResults()).toBe(0);
    // the other input is untouched
    expect(await getDb().highlights.get(h1.id)).toBeDefined();
  });

  it('removes the result when a NOTE input is purged, and keeps unrelated results', async () => {
    const note = await createNote({ highlightId: h1.id, body: 'Study note used as AI input' });
    const withNote = await produce('exam_pearl', {
      chunks: [chunk(h1), { id: note.id, kind: 'note', text: note.body }],
    });
    const unrelated = await produce('exam_pearl', { chunks: [chunk(h2)] });
    await saveAiResult(withNote);
    await saveAiResult(unrelated);
    expect(await countAiResults()).toBe(2);

    await deleteNote(note.id);
    await purge([{ kind: 'note', id: note.id }]);
    expect(await getAiResult(withNote.id)).toBeNull();
    expect(await getAiResult(unrelated.id)).not.toBeNull();
    // the highlight the note was written on is still there, and so is the unrelated result
    expect(await getDb().highlights.get(h1.id)).toBeDefined();
  });

  it('removes the results of a highlight together with its notes in one purge, atomically', async () => {
    const note = await createNote({ highlightId: h2.id, body: 'A note on the second highlight' });
    const viaNote = await produce('exam_pearl', {
      chunks: [chunk(h1), { id: note.id, kind: 'note', text: note.body }],
    });
    await saveAiResult(viaNote);
    await softDeleteHighlight(h2.id);

    // A failure after the result was removed (the last step writes the purge marker) rolls the whole
    // purge back: nothing is half-deleted.
    const db = getDb();
    const boom = () => {
      throw new Error('injected');
    };
    db.meta.hook('creating', boom);
    try {
      await expect(purge([{ kind: 'highlight', id: h2.id }])).rejects.toBeDefined();
    } finally {
      db.meta.hook('creating').unsubscribe(boom);
    }
    expect(await db.highlights.get(h2.id)).toBeDefined();
    expect(await getAiResult(viaNote.id)).not.toBeNull();
    expect(await db.notes.get(note.id)).toBeDefined();

    await purge([{ kind: 'highlight', id: h2.id }]);
    // the note went with its highlight, and the result that used the note as an input with it
    expect(await db.notes.get(note.id)).toBeUndefined();
    expect(await getAiResult(viaNote.id)).toBeNull();
  });
});

describe('types', () => {
  it('StoredAiResult carries the AiResult unchanged', async () => {
    const result = await pearl();
    const row: StoredAiResult = await saveAiResult(result);
    const { schemaVersion, highlightId, acceptedAt, items, ...rest } = row;
    expect([schemaVersion, highlightId, acceptedAt, items]).toBeDefined();
    expect(rest).toEqual(result);
  });
});
