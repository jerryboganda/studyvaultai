// @vitest-environment node
import { mkdtemp, readdir, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SyncOperation } from '../../packages/sync/src/schema.ts';
import { JsonFileStore, MemoryStore, hashOperation } from './store.ts';
import type { OpStore } from './store.ts';
import { makeOp } from './testing.ts';

const NOW = Date.UTC(2026, 9, 11, 12);
const op = (id: string, over: Record<string, unknown> = {}) =>
  SyncOperation.parse({ ...makeOp({ id }, NOW), ...over });
const input = (o: ReturnType<typeof op>) => ({
  op: o,
  hash: hashOperation(o),
  bytes: JSON.stringify(o).length,
});
const BIG = 1 << 30;

const dirs: string[] = [];
async function tmp() {
  const d = await mkdtemp(join(tmpdir(), 'sv-store-'));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe.each([
  ['memory', async () => new MemoryStore() as OpStore],
  ['json file', async () => new JsonFileStore(await tmp()) as OpStore],
])('%s store contract', (_name, make) => {
  it('assigns dense cursors, de-duplicates on key, and isolates users', async () => {
    const s = await make();
    const a = await s.append('u1', [input(op('op-A-000001')), input(op('op-A-000002'))], BIG);
    expect(a.map((r) => [r.status, r.cursor])).toEqual([
      ['accepted', 1],
      ['accepted', 2],
    ]);
    const again = await s.append('u1', [input(op('op-A-000001'))], BIG);
    expect(again[0]).toEqual({ status: 'duplicate', cursor: 1 });
    const other = await s.append('u2', [input(op('op-A-000001'))], BIG);
    expect(other[0]).toEqual({ status: 'accepted', cursor: 1 });
    expect(await s.head('u1')).toBe(2);
    expect(await s.head('u2')).toBe(1);
    expect((await s.list('u2', 0, 10, BIG)).ops).toHaveLength(1);
    await s.deleteUser('u1');
    expect(await s.head('u1')).toBe(0);
    expect(await s.head('u2')).toBe(1);
  });

  it('serialises concurrent appends of one user without duplicate cursors', async () => {
    const s = await make();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        s.append('u1', [input(op(`op-A-${String(i).padStart(6, '0')}`))], BIG),
      ),
    );
    const cursors = results.map((r) => r[0]!.cursor).sort((x, y) => x! - y!);
    expect(cursors).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });
});

describe('json file store durability', () => {
  it('survives a restart: log, cursors, idempotency keys and profile', async () => {
    const dir = await tmp();
    const one = new JsonFileStore(dir);
    await one.append('u1', [input(op('op-A-000001')), input(op('op-A-000002'))], BIG);
    await one.createProfile('u1', {
      v: 1,
      kdf: 'PBKDF2-SHA256',
      iterations: 600_000,
      salt: 'A'.repeat(22),
      kid: 'k1-aaaaaaaa',
      version: 1,
      keyCheck: 'B'.repeat(43),
      createdAt: new Date(NOW).toISOString(),
    });

    const two = new JsonFileStore(dir); // a new process, same directory
    expect(await two.head('u1')).toBe(2);
    expect((await two.append('u1', [input(op('op-A-000002'))], BIG))[0]).toEqual({
      status: 'duplicate',
      cursor: 2,
    });
    expect((await two.append('u1', [input(op('op-A-000003'))], BIG))[0]).toEqual({
      status: 'accepted',
      cursor: 3,
    });
    expect((await two.getProfile('u1'))?.kid).toBe('k1-aaaaaaaa');
  });

  it('discards a torn final line left by a crash and keeps going', async () => {
    const dir = await tmp();
    const one = new JsonFileStore(dir);
    await one.append('u1', [input(op('op-A-000001'))], BIG);
    const [userDir] = await readdir(dir);
    await appendFile(join(dir, userDir!, 'ops.jsonl'), '{"cursor":2,"hash":"x","op":{"id":"op-A-0');

    const two = new JsonFileStore(dir);
    expect(await two.head('u1')).toBe(1);
    expect((await two.append('u1', [input(op('op-A-000002'))], BIG))[0]!.cursor).toBe(2);
    const text = await readFile(join(dir, userDir!, 'ops.jsonl'), 'utf8');
    expect(text.trim().split('\n')).toHaveLength(2);
  });

  it('fails closed on real corruption instead of serving a partial log', async () => {
    const dir = await tmp();
    const one = new JsonFileStore(dir);
    await one.append('u1', [input(op('op-A-000001')), input(op('op-A-000002'))], BIG);
    const [userDir] = await readdir(dir);
    const file = join(dir, userDir!, 'ops.jsonl');
    const lines = (await readFile(file, 'utf8')).split('\n');
    lines[0] = 'garbage';
    await writeFile(file, lines.join('\n'));
    await expect(new JsonFileStore(dir).head('u1')).rejects.toThrow();
  });

  it('names directories by digest: a hostile user id cannot reach outside the data dir', async () => {
    const dir = await tmp();
    const s = new JsonFileStore(dir);
    await s.append('../../escape', [input(op('op-A-000001'))], BIG);
    const entries = await readdir(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('deletion removes the files', async () => {
    const dir = await tmp();
    const s = new JsonFileStore(dir);
    await s.append('u1', [input(op('op-A-000001'))], BIG);
    await s.deleteUser('u1');
    expect(await readdir(dir)).toEqual([]);
  });
});
