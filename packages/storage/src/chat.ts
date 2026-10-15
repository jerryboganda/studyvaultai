import { z } from 'zod';
import { IsoDate } from '@shared';
import { cmp, now, parseInput, signalChange } from './core';
import { withDb, withWritableDb } from './db';
import { listAiResults, type StoredAiResult } from './ai';

/**
 * Saved conversations for "Chat". The turns are ordinary `aiResults` rows (kind `chat`, with a
 * `threadId`), so they are backed up, restored and purged like every other AI result. What a
 * conversation adds is small and lives in the `meta` row `aiChatThreads`: its title, whether the
 * person agreed to the chat's sending rules, and the rolling summary the next messages carry as
 * memory. A thread that has turns but no meta row (a restored backup) is listed with defaults.
 */

const KEY = 'aiChatThreads';
const ID_SHAPE = /^t-[a-z0-9]{6,20}$/;

export const ChatThreadMeta = z.strictObject({
  id: z.string().regex(ID_SHAPE),
  title: z.string().trim().max(80),
  /** Rolling summary of the turns up to `summarizedUpTo`. '' = none yet. */
  summary: z.string().max(4000),
  /** `createdAt` of the newest turn the summary covers. */
  summarizedUpTo: IsoDate.nullable(),
  /** When the person accepted this conversation's sending rules (null = not yet). */
  consentedAt: IsoDate.nullable(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type ChatThreadMeta = z.infer<typeof ChatThreadMeta>;

const Row = z.record(z.string(), z.unknown());

export interface ChatThread extends ChatThreadMeta {
  /** Number of saved turns. */
  turns: number;
}

export type ChatTurn = StoredAiResult & { kind: 'chat' };

export const newChatThreadId = (): string =>
  `t-${Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => (b % 36).toString(36)).join('')}`;

async function readMeta(): Promise<Record<string, ChatThreadMeta>> {
  const row = await withDb((db) => db.meta.get(KEY));
  const parsed = Row.safeParse(row?.value);
  if (!parsed.success) return {};
  const out: Record<string, ChatThreadMeta> = {};
  for (const [id, v] of Object.entries(parsed.data)) {
    const m = ChatThreadMeta.safeParse(v);
    if (m.success && m.data.id === id) out[id] = m.data;
  }
  return out;
}

async function writeMeta(
  mutate: (all: Record<string, ChatThreadMeta>) => Record<string, ChatThreadMeta>,
): Promise<void> {
  await withWritableDb((db) =>
    db.transaction('rw', db.meta, async () => {
      const row = await db.meta.get(KEY);
      const parsed = Row.safeParse(row?.value);
      const current: Record<string, ChatThreadMeta> = {};
      if (parsed.success) {
        for (const [id, v] of Object.entries(parsed.data)) {
          const m = ChatThreadMeta.safeParse(v);
          if (m.success && m.data.id === id) current[id] = m.data;
        }
      }
      const next = mutate(current);
      if (Object.keys(next).length === 0) await db.meta.delete(KEY);
      else await db.meta.put({ key: KEY, value: next, updatedAt: now() });
    }),
  );
  await signalChange();
}

const isTurn = (r: StoredAiResult): r is ChatTurn => r.kind === 'chat';

/** The saved turns of one conversation, oldest first. */
export async function getChatTurns(threadId: string): Promise<ChatTurn[]> {
  const all = await listAiResults({ kind: 'chat', limit: 1000 });
  return all
    .filter((r): r is ChatTurn => isTurn(r) && r.threadId === threadId)
    .sort((a, b) => cmp(a.createdAt, b.createdAt) || cmp(a.id, b.id));
}

/** Every conversation, most recently active first. */
export async function listChatThreads(): Promise<ChatThread[]> {
  const [meta, results] = await Promise.all([
    readMeta(),
    listAiResults({ kind: 'chat', limit: 1000 }),
  ]);
  const byThread = new Map<string, ChatTurn[]>();
  for (const r of results) {
    if (!isTurn(r) || !r.threadId || !ID_SHAPE.test(r.threadId)) continue;
    const list = byThread.get(r.threadId) ?? [];
    list.push(r);
    byThread.set(r.threadId, list);
  }
  const ids = new Set([...Object.keys(meta), ...byThread.keys()]);
  const threads: ChatThread[] = [];
  for (const id of ids) {
    const turns = (byThread.get(id) ?? []).sort((a, b) => cmp(a.createdAt, b.createdAt));
    const m = meta[id];
    const first = turns[0];
    const stamp = turns.at(-1)?.createdAt ?? now();
    threads.push({
      id,
      title: m?.title || (first?.question ?? 'New chat').slice(0, 60),
      summary: m?.summary ?? '',
      summarizedUpTo: m?.summarizedUpTo ?? null,
      // A restored conversation has no recorded agreement: ask again.
      consentedAt: m?.consentedAt ?? null,
      createdAt: m?.createdAt ?? first?.createdAt ?? stamp,
      updatedAt: turns.at(-1)?.createdAt ?? m?.updatedAt ?? stamp,
      turns: turns.length,
    });
  }
  return threads.sort((a, b) => cmp(b.updatedAt, a.updatedAt) || cmp(a.id, b.id));
}

export async function createChatThread(title = ''): Promise<ChatThreadMeta> {
  const stamp = now();
  const meta = parseInput(
    ChatThreadMeta,
    {
      id: newChatThreadId(),
      title: title.trim().slice(0, 80),
      summary: '',
      summarizedUpTo: null,
      consentedAt: null,
      createdAt: stamp,
      updatedAt: stamp,
    },
    'chat thread',
  );
  await writeMeta((all) => ({ ...all, [meta.id]: meta }));
  return meta;
}

export type ChatThreadPatch = Partial<
  Pick<ChatThreadMeta, 'title' | 'summary' | 'summarizedUpTo' | 'consentedAt'>
>;

/** Creates the row on first use, so a restored conversation can be renamed or agreed to. */
export async function updateChatThread(id: string, patch: ChatThreadPatch): Promise<void> {
  if (!ID_SHAPE.test(id)) return;
  const stamp = now();
  await writeMeta((all) => {
    const base: ChatThreadMeta = all[id] ?? {
      id,
      title: '',
      summary: '',
      summarizedUpTo: null,
      consentedAt: null,
      createdAt: stamp,
      updatedAt: stamp,
    };
    const next = parseInput(
      ChatThreadMeta,
      {
        ...base,
        ...patch,
        title: (patch.title ?? base.title).trim().slice(0, 80),
        updatedAt: stamp,
      },
      'chat thread',
    );
    return { ...all, [id]: next };
  });
}

/** Removes a conversation: its turns and its row. Nothing else is touched. */
export async function deleteChatThread(id: string): Promise<void> {
  await withWritableDb((db) =>
    db.transaction('rw', [db.aiResults, db.meta], async () => {
      const keys: string[] = [];
      await db.aiResults.each((row) => {
        const r = row as unknown as { id: string; kind?: string; threadId?: string };
        if (r.kind === 'chat' && r.threadId === id) keys.push(r.id);
      });
      if (keys.length > 0) await db.aiResults.bulkDelete(keys);
      const row = await db.meta.get(KEY);
      const parsed = Row.safeParse(row?.value);
      if (parsed.success && id in parsed.data) {
        const { [id]: _removed, ...rest } = parsed.data;
        if (Object.keys(rest).length === 0) await db.meta.delete(KEY);
        else await db.meta.put({ key: KEY, value: rest, updatedAt: now() });
      }
    }),
  );
  await signalChange();
}
