// @vitest-environment node
// Fallback providers of the AI feature: settings, keys, and where those keys can and cannot be.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { uuidv7 } from 'uuidv7';
import { exportBackup, exportJson, restoreBackup } from '@backup';
import { createMockProvider, runTask } from '@ai';
import { approve, goodReply, makeDeps } from '@ai/testkit';
import type { HighlightView } from '@shared';
import {
  AI_SECRET_META_KEYS,
  PRIMARY_PROFILE_ID,
  clearAiData,
  clearAiProfileApiKey,
  defaultAiSettings,
  getAiApiKey,
  getAiEndpointPatterns,
  getAiProfileApiKey,
  getAiProfileKeyInfos,
  getAiSettings,
  newAiProfileId,
  saveAiResult,
  setAiApiKey,
  setAiProfileApiKey,
  updateAiSettings,
  type AiProfile,
} from './ai';
import { BACKUP_MIGRATIONS, createBackupTarget, createSnapshotSource } from './backupTarget';
import { getDb } from './db';
import { dump, freshDatabase, save } from './test-vault';

const KEY = 'sk-test-0123456789abcdefSECRETKEY';
const KEY2 = 'sk-test-FALLBACK-9876543210zyxwvu';
let h1: HighlightView;

beforeEach(async () => {
  await freshDatabase();
  h1 = await save(
    'Metformin is the first-line pharmacological treatment for type 2 diabetes mellitus.',
  );
});

const profile = (over: Partial<AiProfile> = {}): AiProfile => ({
  id: newAiProfileId(),
  label: 'Local model',
  provider: 'openai_compatible',
  baseUrl: 'http://localhost:11434/v1',
  model: 'llama',
  jsonMode: true,
  maxTokensParam: 'max_tokens',
  vendor: 'custom',
  reasoningEffort: '',
  authScheme: 'bearer',
  pricing: null,
  fallback: true,
  ...over,
});

/** A real result of the real pipeline, so the "no key in results" checks look at real rows. */
async function aResult() {
  const selection = { chunks: [{ id: h1.id, kind: 'highlight' as const, text: h1.exactQuote }] };
  const provider = createMockProvider([{ json: goodReply('exam_pearl', selection) }]);
  const deps = makeDeps(provider, { randomId: () => uuidv7() });
  return (
    await runTask('exam_pearl', selection, deps, await approve('exam_pearl', selection, deps))
  ).result;
}

describe('fallback providers in the settings', () => {
  it('are stored in order, and an old settings row without them still reads', async () => {
    expect((await getAiSettings()).fallbacks).toEqual([]);
    await getDb().meta.put({
      key: 'aiSettings',
      value: { ...defaultAiSettings(), model: 'm', fallbacks: undefined, routes: undefined },
      updatedAt: 'x',
    });
    expect(await getAiSettings()).toMatchObject({ model: 'm', fallbacks: [], routes: {} });

    const a = profile({ label: 'A' });
    const b = profile({ label: 'B', baseUrl: 'https://api.example.test/v1' });
    await updateAiSettings((cur) => ({ ...cur, fallbacks: [a, b], routes: { summary: b.id } }));
    const read = await getAiSettings();
    expect(read.fallbacks.map((p) => p.label)).toEqual(['A', 'B']);
    expect(read.routes).toEqual({ summary: b.id });
    expect(await getAiEndpointPatterns()).toEqual([
      'http://localhost/*',
      'https://api.example.test/*',
    ]);
  });

  it('are validated: at most three, unique ids, and a route must name a provider that exists', async () => {
    const four = Array.from({ length: 4 }, () => profile());
    await expect(updateAiSettings((cur) => ({ ...cur, fallbacks: four }))).rejects.toMatchObject({
      code: 'invalid_request',
    });
    const a = profile();
    await expect(
      updateAiSettings((cur) => ({ ...cur, fallbacks: [a, { ...a }] })),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      updateAiSettings((cur) => ({ ...cur, fallbacks: [{ ...a, id: PRIMARY_PROFILE_ID }] })),
    ).rejects.toMatchObject({ code: 'invalid_request' });

    // A route to a provider that is not there, or for a task that does not exist, is dropped.
    await updateAiSettings((cur) => ({
      ...cur,
      fallbacks: [a],
      routes: {
        summary: a.id,
        mcq: 'p-gone0000',
        hack: PRIMARY_PROFILE_ID,
        explain: PRIMARY_PROFILE_ID,
      },
    }));
    expect((await getAiSettings()).routes).toEqual({ summary: a.id, explain: PRIMARY_PROFILE_ID });
  });

  it('one bad fallback in a stored row is dropped and the primary provider survives', async () => {
    const good = profile({ label: 'Good' });
    await getDb().meta.put({
      key: 'aiSettings',
      value: {
        ...defaultAiSettings(),
        baseUrl: 'https://api.example.test/v1',
        model: 'm',
        fallbacks: [good, { id: 'nope', label: '' }],
      },
      updatedAt: 'x',
    });
    const read = await getAiSettings();
    expect(read.baseUrl).toBe('https://api.example.test/v1');
    expect(read.fallbacks.map((p) => p.label)).toEqual(['Good']);
  });

  it('two editors of the settings do not overwrite each other', async () => {
    const a = profile();
    await Promise.all([
      updateAiSettings((cur) => ({ ...cur, model: 'primary-model' })),
      updateAiSettings((cur) => ({ ...cur, fallbacks: [...cur.fallbacks, a] })),
    ]);
    const read = await getAiSettings();
    expect(read.model).toBe('primary-model');
    expect(read.fallbacks.map((p) => p.id)).toEqual([a.id]);
  });
});

describe('the keys of fallback providers', () => {
  it('are one meta row, bound to the origin, and never in a result, a backup or an export', async () => {
    const a = profile();
    await updateAiSettings((cur) => ({ ...cur, fallbacks: [a] }));
    await setAiApiKey(KEY, 'https://api.example.test');
    await setAiProfileApiKey(a.id, KEY2, 'http://localhost');
    expect(AI_SECRET_META_KEYS).toEqual(['aiKey', 'aiProfileKeys', 'aiCodexAuth']);

    expect(await getAiProfileApiKey(a.id, 'http://localhost')).toBe(KEY2);
    expect(await getAiProfileApiKey(a.id, 'https://evil.example')).toBeNull();
    expect(await getAiProfileApiKey('p-other0000', 'http://localhost')).toBeNull();
    const infos = await getAiProfileKeyInfos();
    expect(infos).toEqual({
      [a.id]: { present: true, origin: 'http://localhost', last4: KEY2.slice(-4) },
    });
    expect(JSON.stringify(infos)).not.toContain(KEY2);

    await saveAiResult(await aResult());
    const all = await dump();
    const holders = Object.entries(all)
      .filter(([, rows]) => JSON.stringify(rows).includes(KEY2))
      .map(([table]) => table);
    expect(holders).toEqual(['meta']);
    expect(all.meta!.filter((r) => JSON.stringify(r).includes(KEY2)).map((r) => r.key)).toEqual([
      'aiProfileKeys',
    ]);

    // Not in a backup or a JSON export, and the table that holds it cannot be asked for.
    const zip = await exportBackup(await createSnapshotSource(), { appVersion: 'test' });
    const text = Object.values(unzipSync(zip.bytes))
      .map((f) => strFromU8(f))
      .join('\n');
    for (const secret of [KEY, KEY2, 'aiProfileKeys', 'aiKey', 'aiSettings', a.baseUrl]) {
      expect(text, secret).not.toContain(secret);
    }
    const json = await exportJson(await createSnapshotSource(), { appVersion: 'test' });
    expect(strFromU8(json.bytes)).not.toContain(KEY2);
    await expect(
      exportBackup(await createSnapshotSource(), { includeLocalOnlyTables: ['meta'] }),
    ).rejects.toThrow(/Unknown table/);

    // A restore does not touch the keys of this device either.
    await getDb().aiResults.clear();
    await restoreBackup(zip.bytes, {
      target: createBackupTarget(),
      mode: 'replace',
      migrations: BACKUP_MIGRATIONS,
    });
    expect(await getAiProfileApiKey(a.id, 'http://localhost')).toBe(KEY2);
    expect(await getAiApiKey('https://api.example.test')).toBe(KEY);
  });

  it('belong to a provider that exists, and go with it', async () => {
    await expect(setAiProfileApiKey('p-stranger0', KEY2, 'http://localhost')).rejects.toMatchObject(
      { code: 'not_found' },
    );
    const a = profile();
    const b = profile({ label: 'B' });
    await updateAiSettings((cur) => ({ ...cur, fallbacks: [a, b], routes: { mcq: a.id } }));
    await expect(setAiProfileApiKey(a.id, 'short', 'http://localhost')).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(
      setAiProfileApiKey(a.id, 'sk-with space inside it', 'http://localhost'),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await setAiProfileApiKey(a.id, KEY2, 'http://localhost');
    await setAiProfileApiKey(b.id, KEY, 'http://localhost');

    // Removing a provider removes its key and its routes in the same step; the other is untouched.
    await updateAiSettings((cur) => ({
      ...cur,
      fallbacks: cur.fallbacks.filter((p) => p.id !== a.id),
    }));
    expect(await getAiProfileApiKey(a.id, 'http://localhost')).toBeNull();
    expect(await getAiProfileApiKey(b.id, 'http://localhost')).toBe(KEY);
    expect((await getAiSettings()).routes).toEqual({});
    expect(JSON.stringify(await getDb().meta.get('aiProfileKeys'))).not.toContain(KEY2);

    await clearAiProfileApiKey(b.id);
    expect(await getDb().meta.get('aiProfileKeys')).toBeUndefined();
  });

  it('are removed by "Delete all AI data", with the providers', async () => {
    const a = profile();
    await updateAiSettings((cur) => ({ ...cur, fallbacks: [a] }));
    await setAiProfileApiKey(a.id, KEY2, 'http://localhost');
    await clearAiData();
    expect(await getDb().meta.get('aiProfileKeys')).toBeUndefined();
    expect(await getDb().meta.get('aiSettings')).toBeUndefined();
    expect(await getAiProfileApiKey(a.id, 'http://localhost')).toBeNull();
    expect((await getAiSettings()).fallbacks).toEqual([]);
  });
});
