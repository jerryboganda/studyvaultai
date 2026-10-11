import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { KeyProfile, SyncOperation } from '../../packages/sync/src/schema.ts';

/**
 * Storage port of the reference server. Every method takes the authenticated user id and can only
 * ever see that user's rows: there is no query that spans users, so tenant isolation does not depend
 * on a filter somebody must remember to add. Production: implement this over PostgreSQL with
 * `user_id` in every primary key (and, ideally, row-level security as a second fence).
 */

export interface StoredOp {
  cursor: number;
  op: SyncOperation;
}

export type AppendStatus = 'accepted' | 'duplicate' | 'idempotency_conflict' | 'quota_exceeded';

export interface AppendInput {
  op: SyncOperation;
  /** Digest of the canonical operation: a replay must carry identical content. */
  hash: string;
  bytes: number;
}

export interface AppendResult {
  status: AppendStatus;
  cursor: number | null;
}

export type ProfileResult = 'ok' | 'exists' | 'version_conflict';
export type RotateResult = 'ok' | 'version_conflict' | 'incomplete';

export interface OpStore {
  /** Atomic per call. Idempotent on (user, idempotencyKey). */
  append(userId: string, inputs: AppendInput[], quotaBytes: number): Promise<AppendResult[]>;
  /** Operations with cursor > since, ascending, at most `limit` and about `maxBytes`. */
  list(
    userId: string,
    since: number,
    limit: number,
    maxBytes: number,
  ): Promise<{ ops: StoredOp[]; head: number }>;
  head(userId: string): Promise<number>;
  /**
   * Identity of this user's current data generation (created on first use, replaced when the data is
   * erased). Clients that remember another one know the server was reset or restored.
   */
  epoch(userId: string): Promise<string>;
  getProfile(userId: string): Promise<KeyProfile | null>;
  /** Create the first profile (version 1). Replacement happens only through `rotate`. */
  createProfile(userId: string, profile: KeyProfile): Promise<ProfileResult>;
  /**
   * Replace the profile and re-encrypt every operation, atomically. `replacements` must cover the
   * user's whole log, and the profile must be exactly the current version + 1 (or version 1 when
   * there is none yet: migrating a plaintext history to E2EE).
   */
  rotate(
    userId: string,
    profile: KeyProfile,
    replacements: ReadonlyMap<string, SyncOperation['payload']>,
  ): Promise<RotateResult>;
  /** Durable deletion of everything held for the user. */
  deleteUser(userId: string): Promise<void>;
}

interface UserData {
  epoch: string | null;
  ops: StoredOp[];
  keys: Map<string, { cursor: number; hash: string }>;
  bytes: number;
  profile: KeyProfile | null;
}

function emptyUser(): UserData {
  return { epoch: null, ops: [], keys: new Map(), bytes: 0, profile: null };
}

/** Serialises work per user inside one process (the reference server is a single instance). */
class Gate {
  private tails = new Map<string, Promise<unknown>>();
  run<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(userId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.tails.set(userId, tail);
    void tail.then(() => {
      if (this.tails.get(userId) === tail) this.tails.delete(userId);
    });
    return next;
  }
}

/**
 * Shared logic over a per-user in-memory image. Subclasses supply `load` (read the user's durable
 * state, or nothing) and `persist*` hooks; the memory store has none.
 */
abstract class ImageStore implements OpStore {
  private readonly users = new Map<string, UserData>();
  private readonly gate = new Gate();

  protected abstract load(userId: string): Promise<UserData | null>;
  protected abstract persistAppend(
    userId: string,
    appended: StoredOp[],
    hashes: string[],
  ): Promise<void>;
  protected abstract persistProfile(userId: string, profile: KeyProfile): Promise<void>;
  protected abstract persistEpoch(userId: string, epoch: string): Promise<void>;
  protected abstract persistAll(
    userId: string,
    data: UserData,
    hashes: Map<number, string>,
  ): Promise<void>;
  protected abstract persistDelete(userId: string): Promise<void>;

  private async user(userId: string): Promise<UserData> {
    let data = this.users.get(userId);
    if (!data) {
      data = (await this.load(userId)) ?? emptyUser();
      this.users.set(userId, data);
    }
    return data;
  }

  append(userId: string, inputs: AppendInput[], quotaBytes: number): Promise<AppendResult[]> {
    return this.gate.run(userId, async () => {
      const data = await this.user(userId);
      const results: AppendResult[] = [];
      const appended: StoredOp[] = [];
      const hashes: string[] = [];
      let bytes = data.bytes;
      for (const { op, hash, bytes: size } of inputs) {
        const known = data.keys.get(op.idempotencyKey);
        if (known) {
          results.push({
            status: known.hash === hash ? 'duplicate' : 'idempotency_conflict',
            cursor: known.hash === hash ? known.cursor : null,
          });
          continue;
        }
        if (bytes + size > quotaBytes) {
          results.push({ status: 'quota_exceeded', cursor: null });
          continue;
        }
        const cursor = (data.ops.at(-1)?.cursor ?? 0) + appended.length + 1;
        // `appended` is not yet in data.ops; keep the in-batch numbering consistent.
        const stored: StoredOp = { cursor, op };
        appended.push(stored);
        hashes.push(hash);
        data.keys.set(op.idempotencyKey, { cursor, hash });
        bytes += size;
        results.push({ status: 'accepted', cursor });
      }
      if (appended.length > 0) {
        try {
          await this.persistAppend(userId, appended, hashes);
        } catch (e) {
          for (const s of appended) data.keys.delete(s.op.idempotencyKey);
          throw e;
        }
        data.ops.push(...appended);
        data.bytes = bytes;
      }
      return results;
    });
  }

  async list(userId: string, since: number, limit: number, maxBytes: number) {
    const data = await this.user(userId);
    const out: StoredOp[] = [];
    let bytes = 0;
    // Cursors are dense 1..n, so the first candidate is at index `since`.
    for (let i = since; i < data.ops.length && out.length < limit; i++) {
      const s = data.ops[i]!;
      bytes += JSON.stringify(s.op).length;
      if (out.length > 0 && bytes > maxBytes) break;
      out.push(s);
    }
    return { ops: out, head: data.ops.length };
  }

  async head(userId: string): Promise<number> {
    return (await this.user(userId)).ops.length;
  }

  epoch(userId: string): Promise<string> {
    return this.gate.run(userId, async () => {
      const data = await this.user(userId);
      if (!data.epoch) {
        const epoch = randomUUID();
        await this.persistEpoch(userId, epoch);
        data.epoch = epoch;
      }
      return data.epoch;
    });
  }

  async getProfile(userId: string): Promise<KeyProfile | null> {
    return (await this.user(userId)).profile;
  }

  createProfile(userId: string, profile: KeyProfile): Promise<ProfileResult> {
    return this.gate.run(userId, async () => {
      const data = await this.user(userId);
      if (data.profile) return 'exists';
      if (profile.version !== 1) return 'version_conflict';
      await this.persistProfile(userId, profile);
      data.profile = profile;
      return 'ok';
    });
  }

  rotate(
    userId: string,
    profile: KeyProfile,
    replacements: ReadonlyMap<string, SyncOperation['payload']>,
  ): Promise<RotateResult> {
    return this.gate.run(userId, async () => {
      const data = await this.user(userId);
      const expected = (data.profile?.version ?? 0) + 1;
      if (profile.version !== expected) return 'version_conflict';
      if (
        replacements.size !== data.ops.length ||
        data.ops.some((s) => !replacements.has(s.op.id))
      ) {
        return 'incomplete';
      }
      const next: UserData = {
        epoch: data.epoch,
        ops: data.ops.map((s) => ({
          cursor: s.cursor,
          op: { ...s.op, payload: replacements.get(s.op.id)!, payloadEncrypted: true },
        })),
        keys: new Map(),
        bytes: 0,
        profile,
      };
      const hashes = new Map<number, string>();
      for (const s of next.ops) {
        const hash = hashOperation(s.op);
        hashes.set(s.cursor, hash);
        next.keys.set(s.op.idempotencyKey, { cursor: s.cursor, hash });
        next.bytes += JSON.stringify(s.op).length;
      }
      await this.persistAll(userId, next, hashes);
      this.users.set(userId, next);
      return 'ok';
    });
  }

  deleteUser(userId: string): Promise<void> {
    return this.gate.run(userId, async () => {
      await this.persistDelete(userId);
      this.users.delete(userId);
    });
  }
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

export function hashOperation(op: SyncOperation): string {
  return createHash('sha256').update(canonical(op)).digest('hex');
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(record[k])}`)
    .join(',')}}`;
}

export class MemoryStore extends ImageStore {
  protected async load(): Promise<UserData | null> {
    return null;
  }
  protected async persistAppend(): Promise<void> {}
  protected async persistProfile(): Promise<void> {}
  protected async persistEpoch(): Promise<void> {}
  protected async persistAll(): Promise<void> {}
  protected async persistDelete(): Promise<void> {}
}

interface Line {
  cursor: number;
  hash: string;
  op: SyncOperation;
}

/**
 * Durable single-process store: one directory per user (named by a SHA-256 of the user id, so ids
 * can never escape the data directory), an append-only JSON-lines log fsynced per append, and an
 * atomically replaced profile. A torn final line from a crash is detected and discarded on load.
 * Not a scalable database: it is the smallest thing that is correct, and the contract for a real one.
 */
export class JsonFileStore extends ImageStore {
  private readonly dir: string;

  constructor(dir: string) {
    super();
    this.dir = dir;
  }

  private userDir(userId: string): string {
    return join(this.dir, createHash('sha256').update(userId).digest('hex'));
  }

  protected async load(userId: string): Promise<UserData | null> {
    const dir = this.userDir(userId);
    const data = emptyUser();
    const profile = await readIfPresent(join(dir, 'profile.json'));
    const log = await readIfPresent(join(dir, 'ops.jsonl'));
    const meta = await readIfPresent(join(dir, 'meta.json'));
    if (profile === null && log === null && meta === null) return null;
    if (meta !== null) data.epoch = (JSON.parse(meta) as { epoch: string }).epoch;
    // Corruption is never papered over: a damaged file makes this user's requests fail (500),
    // because serving a partial log would hand out duplicate cursors.
    if (profile !== null) data.profile = JSON.parse(profile) as KeyProfile;
    if (log !== null) {
      const pieces = log.split('\n');
      const torn = pieces.pop() ?? ''; // text after the last newline: empty, or a crash mid-append
      for (const raw of pieces) {
        const line = JSON.parse(raw) as Line;
        if (line.cursor !== data.ops.length + 1) throw new Error('operation log is not dense');
        data.ops.push({ cursor: line.cursor, op: line.op });
        data.keys.set(line.op.idempotencyKey, { cursor: line.cursor, hash: line.hash });
        data.bytes += JSON.stringify(line.op).length;
      }
      if (torn.length > 0) {
        await writeFile(join(dir, 'ops.jsonl'), pieces.map((l) => `${l}\n`).join(''));
      }
    }
    return data;
  }

  protected async persistAppend(
    userId: string,
    appended: StoredOp[],
    hashes: string[],
  ): Promise<void> {
    const dir = this.userDir(userId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const text = appended
      .map((s, i) => `${JSON.stringify({ cursor: s.cursor, hash: hashes[i], op: s.op })}\n`)
      .join('');
    const file = await open(join(dir, 'ops.jsonl'), 'a', 0o600);
    try {
      await file.write(text);
      await file.sync();
    } finally {
      await file.close();
    }
  }

  private async writeAtomic(userId: string, name: string, text: string): Promise<void> {
    const dir = this.userDir(userId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `${name}.${process.pid}.tmp`);
    await writeFile(tmp, text, { mode: 0o600 });
    await rename(tmp, join(dir, name));
  }

  protected async persistProfile(userId: string, profile: KeyProfile): Promise<void> {
    await this.writeAtomic(userId, 'profile.json', JSON.stringify(profile));
  }

  protected async persistEpoch(userId: string, epoch: string): Promise<void> {
    await this.writeAtomic(userId, 'meta.json', JSON.stringify({ epoch }));
  }

  protected async persistAll(
    userId: string,
    data: UserData,
    hashes: Map<number, string>,
  ): Promise<void> {
    const dir = this.userDir(userId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `ops.jsonl.${process.pid}.tmp`);
    const text = data.ops
      .map((s) => `${JSON.stringify({ cursor: s.cursor, hash: hashes.get(s.cursor), op: s.op })}\n`)
      .join('');
    await writeFile(tmp, text, { mode: 0o600 });
    // The log first, then the profile: a crash in between leaves new ciphertext with the old
    // profile, which `rotate` detects (version mismatch) and the client simply repeats.
    await rename(tmp, join(dir, 'ops.jsonl'));
    if (data.profile) await this.persistProfile(userId, data.profile);
  }

  protected async persistDelete(userId: string): Promise<void> {
    await rm(this.userDir(userId), { recursive: true, force: true });
  }
}
