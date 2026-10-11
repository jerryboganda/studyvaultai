// @vitest-environment node
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { ApplyRejectedError, STUDYVAULT_SYNC_POLICY, SyncOperation, checkPolicy } from '@sync';
import { INBOX_BANK_ID, defaultSettings } from '@shared';
import { closeDb, getDb, resetDbForTests, StudyVaultDb } from './db';
import { createFolder } from './hierarchy';
import { addToBank, removeFromBank } from './membership';
import { createBank } from './repo';
import { createNote, deleteNote, updateNote } from './notes';
import { bulkDelete, bulkMove, bulkRestore, bulkTag } from './bulk';
import { restoreHighlight, saveCapture, softDeleteHighlight, updateHighlight } from './repo';
import { reportResolutions } from './repo';
import { tableRegistry } from './registry';
import { attachTags, createTag, detachTags } from './tags';
import { purge } from './trash';
import { upsertDocument, saveOcrPage } from './pdf';
import {
  SyncPolicyDriftError,
  activeSyncPolicy,
  createDexieOpLog,
  createDexieStateStore,
  createSyncRuntime,
  ensureClientId,
  fieldHashes,
  listSyncConflicts,
  listSyncQuarantine,
  resetSyncIdentity,
  stopSyncCapture,
  suppressSyncCapture,
  type SyncOpRow,
  type SyncRuntime,
} from './sync';
import { cap } from './test-fixtures';
import { save } from './test-vault';

let rt: SyncRuntime;

async function boot(enabled = true): Promise<SyncRuntime> {
  await resetDbForTests();
  fakeBrowser.reset();
  const runtime = await createSyncRuntime({ isEnabled: () => enabled });
  runtime.startCapture();
  return runtime;
}

beforeEach(async () => {
  rt = await boot();
});

const pending = async () => (await rt.log.pending(10_000)).map((p) => p.op);
const summary = (ops: SyncOperation[]) =>
  ops.map((o) => `${o.entityType}:${o.opType}:${o.revision}`);
const payloadOf = (op: SyncOperation) =>
  op.payload as { set: Record<string, unknown>; full: boolean };

const HLC = (n: number, client = 'client-AAAAAAAA') =>
  `${n.toString(36).padStart(9, '0')}.0000.${client}`;
function makeOp(id: string, over: Partial<Record<string, unknown>> = {}): SyncOperation {
  return SyncOperation.parse({
    id,
    clientId: 'client-AAAAAAAA',
    entityType: 'notes',
    entityId: `note-${id}`,
    opType: 'upsert',
    revision: 1,
    hlc: HLC(1_700_000_000),
    baseRevision: 0,
    payload: { v: 1, full: true, set: { title: id }, prev: {}, base: {}, sets: {}, observed: null },
    payloadEncrypted: false,
    tombstone: false,
    idempotencyKey: `client-AAAAAAAA:${id}`,
    createdAt: '2026-10-11T00:00:00.000Z',
    ...over,
  });
}

// ---------------------------------------------------------------------------------------------

describe('policy against the real table registry', () => {
  it('has no drift: every named field exists in the schema of its table', () => {
    const active = activeSyncPolicy();
    const names = active.tables.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'banks',
        'folders',
        'tags',
        'sources',
        'highlights',
        'highlightBanks',
        'highlightTags',
        'notes',
        'documents',
        'ocrPages',
      ]),
    );
    // Tables whose schema is still a placeholder are left out and reported, not guessed.
    expect(active.notSynced).toEqual(expect.arrayContaining(['cards', 'decks']));
    const base = Object.fromEntries(
      Object.entries(STUDYVAULT_SYNC_POLICY).filter(([t]) => names.includes(t)),
    );
    expect(checkPolicy(tableRegistry, base)).toEqual([]);
  });

  it('derives device-local fields from the registry and uses the schema as the allow-list', () => {
    const { policy } = activeSyncPolicy();
    expect(policy.highlights!.local).toEqual(
      expect.arrayContaining(['resolveStatus', 'resolveConfidence', 'lastResolvedAt']),
    );
    expect(policy.highlights!.fields).toEqual(
      expect.arrayContaining(['exactQuote', 'userComment']),
    );
    expect(policy.highlights!.fields).not.toContain('somethingElse');
  });

  it('fails loudly when a policy field disappears from a schema (drift)', () => {
    const drifted = {
      ...STUDYVAULT_SYNC_POLICY,
      notes: { ...STUDYVAULT_SYNC_POLICY.notes!, text: ['title', 'content'] }, // "body" was renamed
    };
    expect(() => activeSyncPolicy(tableRegistry, drifted)).toThrow(SyncPolicyDriftError);
    try {
      activeSyncPolicy(tableRegistry, drifted);
    } catch (e) {
      expect((e as SyncPolicyDriftError).issues.join(' ')).toMatch(/notes\.content/);
    }
  });

  it('a runtime cannot start on a drifted policy', async () => {
    const drifted = {
      ...STUDYVAULT_SYNC_POLICY,
      highlights: { ...STUDYVAULT_SYNC_POLICY.highlights!, immutable: ['exactQuoteRenamed'] },
    };
    await expect(createSyncRuntime({ isEnabled: () => true, policy: drifted })).rejects.toThrow(
      SyncPolicyDriftError,
    );
  });
});

// ---------------------------------------------------------------------------------------------

describe('outbox (OpLog) on Dexie', () => {
  it('keeps insertion order, limits pages and counts what is pending', async () => {
    const log = createDexieOpLog(getDb());
    for (const id of ['op-aaaaaaa1', 'op-aaaaaaa2', 'op-aaaaaaa3']) await log.append(makeOp(id));
    expect((await log.pending(2)).map((p) => p.op.id)).toEqual(['op-aaaaaaa1', 'op-aaaaaaa2']);
    expect(await log.countPending()).toBe(3);
    expect((await log.pending(10)).map((p) => p.attempts)).toEqual([0, 0, 0]);
  });

  it('finds the unattempted operation of one entity, and stops after an attempt', async () => {
    const log = createDexieOpLog(getDb());
    await log.append(makeOp('op-bbbbbbb1', { entityId: 'note-x' }));
    await log.append(makeOp('op-bbbbbbb2', { entityId: 'note-y' }));
    expect((await log.unattemptedFor('notes', 'note-x'))?.op.id).toBe('op-bbbbbbb1');
    await log.markAttempted(['op-bbbbbbb1']);
    expect(await log.unattemptedFor('notes', 'note-x')).toBeNull();
    expect((await log.pending(5)).find((p) => p.op.id === 'op-bbbbbbb1')?.attempts).toBe(1);
    expect(await log.unattemptedFor('notes', 'note-none')).toBeNull();
  });

  it('replace keeps queue position, resets attempts for a new op and keeps them for a re-encrypt', async () => {
    const log = createDexieOpLog(getDb());
    for (const id of ['op-ccccccc1', 'op-ccccccc2', 'op-ccccccc3']) await log.append(makeOp(id));
    await log.markAttempted(['op-ccccccc2']);
    // coalesce 2 -> 4: the new operation takes the queue slot of the replaced one, attempts reset
    await log.replace(['op-ccccccc2'], makeOp('op-ccccccc4'));
    expect((await log.pending(10)).map((p) => [p.op.id, p.attempts])).toEqual([
      ['op-ccccccc1', 0],
      ['op-ccccccc4', 0],
      ['op-ccccccc3', 0],
    ]);
    // same id again (encryption persisted): attempts are kept
    await log.markAttempted(['op-ccccccc4']);
    await log.replace(['op-ccccccc4'], makeOp('op-ccccccc4', { revision: 1 }));
    expect((await log.pending(10)).find((p) => p.op.id === 'op-ccccccc4')?.attempts).toBe(1);
    // drop without replacement
    await log.replace(['op-ccccccc1'], null);
    expect((await log.pending(10)).map((p) => p.op.id)).toEqual(['op-ccccccc4', 'op-ccccccc3']);
  });

  it('marks sent, prunes by age and clears', async () => {
    const log = createDexieOpLog(getDb());
    for (const id of ['op-ddddddd1', 'op-ddddddd2']) await log.append(makeOp(id));
    await log.markSent(['op-ddddddd1'], 1_000);
    expect(await log.countPending()).toBe(1);
    expect(await log.pruneSent(500)).toBe(0);
    expect(await log.pruneSent(2_000)).toBe(1);
    await log.clear();
    expect(await log.countPending()).toBe(0);
  });
});

describe('state store on Dexie', () => {
  it('round-trips state, entity metadata, tombstones, conflicts and quarantine', async () => {
    const store = createDexieStateStore(getDb(), rt.active);
    expect(await store.loadState()).toBeNull();
    const state = {
      v: 1 as const,
      clientId: rt.clientId,
      accountId: null,
      cursor: '7',
      epoch: null,
      pending: 0,
      lastSyncAt: null,
      status: 'idle' as const,
      lastError: null,
      backoff: { attempt: 0, nextAttemptAt: null },
      hlc: { wall: 0, counter: 0 },
      needsResync: false,
    };
    await store.saveState(state);
    expect(await store.loadState()).toEqual(state);

    const meta = {
      entityType: 'notes',
      entityId: 'note-gone',
      revision: 3,
      vector: {},
      fields: {},
      sets: {},
      born: true,
      rm: HLC(10),
      ao: null,
      tombstoneAt: 1_000,
      frozen: {},
    };
    await store.putMeta(meta);
    expect(await store.getMeta('notes', 'note-gone')).toEqual(meta);
    expect((await store.listTombstones(2_000, 10)).map((m) => m.entityId)).toEqual(['note-gone']);
    expect(await store.listTombstones(500, 10)).toEqual([]);
    await store.deleteMeta('notes', 'note-gone');
    expect(await store.getMeta('notes', 'note-gone')).toBeNull();

    await store.putQuarantined({
      id: 'q-1',
      entityType: 'notes',
      entityId: 'n',
      reason: 'invalid_op',
      detail: 'bad',
      at: 5,
      op: null,
    });
    await store.putQuarantined({
      id: 'q-0',
      entityType: null,
      entityId: null,
      reason: 'locked',
      detail: 'older',
      at: 1,
      op: null,
    });
    expect((await store.listQuarantined()).map((q) => q.id)).toEqual(['q-0', 'q-1']);

    await store.clearAll();
    expect(await store.loadState()).toBeNull();
    expect(await store.listQuarantined()).toEqual([]);
    // the installation id is not sync bookkeeping and survives
    expect(await ensureClientId()).toBe(rt.clientId);
  });

  it('keeps newer local metadata when a stale write-back arrives, and asks for a re-pull', async () => {
    const store = createDexieStateStore(getDb(), rt.active);
    await store.saveState({
      v: 1,
      clientId: rt.clientId,
      accountId: null,
      cursor: null,
      epoch: null,
      pending: 0,
      lastSyncAt: null,
      status: 'idle',
      lastError: null,
      backoff: { attempt: 0, nextAttemptAt: null },
      hlc: { wall: 0, counter: 0 },
      needsResync: false,
    });
    const base = {
      entityType: 'notes',
      entityId: 'note-race',
      vector: {},
      fields: {},
      sets: {},
      born: true,
      rm: null,
      ao: null,
      tombstoneAt: null,
      frozen: {},
    };
    await store.putMeta({ ...base, revision: 5 });
    await store.putMeta({ ...base, revision: 4 }); // computed before the local edit committed
    expect((await store.getMeta('notes', 'note-race'))?.revision).toBe(5);
    expect((await store.loadState())?.needsResync).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------

describe('capture through the real repositories', () => {
  it('a capture, an edit, a soft delete and an undo are recorded as ordinary operations', async () => {
    const saved = await saveCapture(cap());
    const created = await pending();
    const types = [...new Set(created.map((o) => o.entityType))];
    expect(types).toEqual(
      expect.arrayContaining(['sources', 'highlights', 'highlightBanks', 'banks']),
    );
    const highlight = created.find((o) => o.entityType === 'highlights')!;
    expect(highlight.opType).toBe('upsert');
    expect(payloadOf(highlight).full).toBe(true);
    // immutable provenance travels with the creation; device-local state does not
    expect(payloadOf(highlight).set).toMatchObject({ exactQuote: expect.any(String) });
    expect(payloadOf(highlight).set).not.toHaveProperty('resolveStatus');
    expect(payloadOf(highlight).set).not.toHaveProperty('schemaVersion');

    await updateHighlight(saved.highlight.id, { userComment: 'my note' });
    await softDeleteHighlight(saved.highlight.id);
    await restoreHighlight(saved.highlight.id);

    // unsent edits of one entity are coalesced into the creation, losslessly
    const merged = (await pending()).find((o) => o.entityType === 'highlights')!;
    expect(payloadOf(merged).set).toMatchObject({ userComment: 'my note', deletedAt: null });
    // and no tombstone exists: a soft delete is an edit of `deletedAt`
    expect((await pending()).some((o) => o.opType === 'delete')).toBe(false);
  });

  it('after the first batch is sent, later edits are small field patches', async () => {
    const saved = await saveCapture(cap());
    const ids = (await pending()).map((o) => o.id);
    await rt.log.markAttempted(ids);
    await rt.log.markSent(ids, Date.now());
    await updateHighlight(saved.highlight.id, { userComment: 'later' });
    const ops = await pending();
    expect(ops).toHaveLength(1);
    expect(payloadOf(ops[0]!).full).toBe(false);
    expect(Object.keys(payloadOf(ops[0]!).set).sort()).toEqual(['updatedAt', 'userComment']);
    await softDeleteHighlight(saved.highlight.id);
    expect(Object.keys(payloadOf((await pending())[0]!).set).sort()).toEqual([
      'deletedAt',
      'updatedAt',
      'userComment',
    ]);
  });

  it('notes, tags, folders, memberships and bulk operations are captured', async () => {
    const a = await save('Quote A for the capture test');
    const b = await save('Quote B for the capture test');
    const note = await createNote({ highlightId: a.id, body: 'first' });
    await updateNote(note.id, { body: 'second' });
    const tag = (await createTag('Pharm')).tag;
    await attachTags({ highlightIds: [a.id, b.id], tagIds: [tag.id] });
    await detachTags({ highlightIds: [b.id], tagIds: [tag.id] });
    const folder = await createFolder({ bankId: INBOX_BANK_ID, name: 'Unit 1' });
    const other = await createBank('Second bank');
    await addToBank({ highlightId: b.id, bankId: other.id });
    await removeFromBank({ highlightId: b.id, bankId: other.id });
    await addToBank({ highlightId: a.id, bankId: INBOX_BANK_ID, folderId: folder.id });
    await bulkTag({ highlightIds: [a.id, b.id], addTagIds: [tag.id] });
    await bulkMove({ highlightIds: [a.id, b.id], toBankId: INBOX_BANK_ID, folderId: folder.id });
    await deleteNote(note.id);

    const ops = await pending();
    const by = (type: string) => ops.filter((o) => o.entityType === type);
    expect(by('notes').length).toBeGreaterThan(0);
    expect(payloadOf(by('notes')[0]!).set).toMatchObject({ body: 'second' });
    expect(by('tags')).toHaveLength(1);
    expect(by('folders')).toHaveLength(1);
    // membership rows have compound keys "highlightId|bankId" / "highlightId|tagId"
    expect(by('highlightTags').every((o) => o.entityId.includes('|'))).toBe(true);
    expect(by('highlightTags').some((o) => o.opType === 'delete')).toBe(true);
    expect(by('highlightBanks').some((o) => o.opType === 'delete')).toBe(true);
    // deleteNote is a soft delete: an edit, not a tombstone
    expect(by('notes').some((o) => o.opType === 'delete')).toBe(false);
  });

  it('bulk soft delete and restore write one edit per row; purge writes tombstones', async () => {
    const hs = [await save('Bulk one quote text'), await save('Bulk two quote text')];
    const ids = hs.map((h) => h.id);
    await rt.log.markSent(
      (await pending()).map((o) => o.id),
      1,
    );
    await bulkDelete(ids);
    const afterDelete = await pending();
    expect(summary(afterDelete).filter((s) => s.startsWith('highlights'))).toHaveLength(2);
    for (const op of afterDelete.filter((o) => o.entityType === 'highlights')) {
      expect(payloadOf(op).set).toHaveProperty('deletedAt', expect.any(String));
    }
    await bulkRestore(ids);
    expect(
      (await pending()).filter((o) => o.entityType === 'highlights' && o.opType === 'delete'),
    ).toEqual([]);
    await bulkDelete(ids);
    await purge(ids.map((id) => ({ kind: 'highlight' as const, id })));
    // purged: the rows are physically gone, so tombstones exist
    expect(
      (await pending()).filter((o) => o.entityType === 'highlights' && o.opType === 'delete'),
    ).toHaveLength(2);
  });

  describe('purge and the sync bookkeeping', () => {
    const outbox = async () => (await getDb().syncOps.toArray()) as unknown as SyncOpRow[];
    const rowsOf = async (entityType: string, entityId: string) =>
      (await outbox())
        .filter((r) => r.entityType === entityType && r.entityId === entityId)
        .sort((a, b) => a.seq - b.seq);

    it('an entity that was never sent ends as a content-free tombstone, with no copy of its text', async () => {
      const h = await save('Verbatim quote that must not stay in the outbox');
      const sourceId = (await getDb().highlights.get(h.id))!.sourceId;
      await updateHighlight(h.id, { userComment: 'a private comment' });
      expect(JSON.stringify(await pending())).toContain('Verbatim quote');

      await bulkDelete([h.id]);
      await purge([{ kind: 'highlight', id: h.id }]);

      const mine = await rowsOf('highlights', h.id);
      expect(mine.map((r) => r.op.opType)).toEqual(['delete']);
      expect(mine[0]!.op).toMatchObject({ tombstone: true, entityId: h.id });
      expect(payloadOf(mine[0]!.op).set).toEqual({});
      // the membership and the source (purged with its only highlight) are tombstones too
      for (const [type, id] of [
        ['highlightBanks', `${h.id}|${INBOX_BANK_ID}`],
        ['sources', sourceId],
      ] as const) {
        expect(
          (await rowsOf(type, id)).map((r) => r.op.opType),
          type,
        ).toEqual(['delete']);
      }
      const text = JSON.stringify(await outbox());
      expect(text).not.toContain('Verbatim quote');
      expect(text).not.toContain('a private comment');
      expect(text).not.toContain('example.com'); // the source address went with its create
    });

    it('keeps an unsent edit of an entity that was delivered, and drops the acknowledged copies', async () => {
      const h = await save('Delivered quote text for the outbox test');
      const first = (await pending()).map((o) => o.id);
      await rt.log.markAttempted(first);
      await rt.log.markSent(first, Date.now());
      await updateHighlight(h.id, { userComment: 'edited while offline' });
      await bulkDelete([h.id]);
      expect(JSON.stringify(await outbox())).toContain('Delivered quote text');

      await purge([{ kind: 'highlight', id: h.id }]);

      const mine = await rowsOf('highlights', h.id);
      // Acknowledged copies (they held the quote) are gone ...
      expect(mine.filter((r) => r.pending === 0)).toEqual([]);
      expect(JSON.stringify(await outbox())).not.toContain('Delivered quote text');
      // ... the unsent patch stays (the tombstone's causal context refers to its clock) and the
      // tombstone follows it.
      expect(mine.map((r) => r.op.opType)).toEqual(['upsert', 'delete']);
      expect(payloadOf(mine[0]!.op).full).toBe(false);
      expect(mine[0]!.op.baseRevision).toBeGreaterThan(0);
    });

    it('an operation that was attempted may have reached the server: it is not rewritten', async () => {
      const h = await save('Attempted but unacknowledged quote');
      await rt.log.markAttempted((await pending()).map((o) => o.id));
      await bulkDelete([h.id]);
      await purge([{ kind: 'highlight', id: h.id }]);
      const mine = await rowsOf('highlights', h.id);
      // the attempted creation (with the quote), the later soft delete, and the tombstone
      expect(mine.map((r) => [r.op.opType, r.attempts])).toEqual([
        ['upsert', 1],
        ['upsert', 0],
        ['delete', 0],
      ]);
      expect(payloadOf(mine[0]!.op).full).toBe(true);
    });

    it('removes the conflict records and quarantined operations of a purged entity only', async () => {
      const a = await save('Conflicted highlight to purge');
      const b = await save('Conflicted highlight to keep');
      const store = createDexieStateStore(getDb(), rt.active);
      const conflict = (id: string, entityId: string) => ({
        id,
        entityType: 'highlights',
        entityId,
        field: 'userComment',
        kind: 'text_edit' as const,
        local: { value: 'my version', hlc: null },
        remote: { value: 'their version', hlc: HLC(5) },
        base: null,
        detectedAt: 1,
        resolution: null,
      });
      await store.putConflict(conflict('conflict-a', a.id));
      await store.putConflict(conflict('conflict-b', b.id));
      const quarantined = (id: string, entityId: string | null) => ({
        id,
        entityType: 'highlights',
        entityId,
        reason: 'awaiting_create' as const,
        detail: 'their version',
        at: 1,
        op: { payload: { set: { userComment: 'their version' } } },
      });
      await store.putQuarantined(quarantined('quarantine-a', a.id));
      await store.putQuarantined(quarantined('quarantine-b', b.id));
      await store.putQuarantined(quarantined('quarantine-none', null));

      await bulkDelete([a.id]);
      await purge([{ kind: 'highlight', id: a.id }]);

      expect((await listSyncConflicts()).map((c) => c.id)).toEqual(['conflict-b']);
      expect((await listSyncQuarantine()).map((q) => q.id).sort()).toEqual([
        'quarantine-b',
        'quarantine-none',
      ]);
    });

    it('does the same with capture off: nothing of the text stays, reconcile sends the tombstone', async () => {
      const h = await save('Written while capture was running');
      stopSyncCapture();
      await bulkDelete([h.id]);
      await purge([{ kind: 'highlight', id: h.id }]);
      expect(JSON.stringify(await outbox())).not.toContain('Written while capture');

      rt.startCapture();
      const result = await rt.reconcile();
      expect(result.deleted).toBeGreaterThan(0);
      expect((await rowsOf('highlights', h.id)).map((r) => r.op.opType)).toEqual(['delete']);
    });
  });

  it('PDF documents and OCR pages (compound numeric key) are captured', async () => {
    const id = 'a'.repeat(64);
    await upsertDocument({
      id,
      title: 'Lecture',
      pageCount: 2,
      byteLength: 10,
      originalUrl: null,
      textStatus: 'text',
    });
    await saveOcrPage({
      documentId: id,
      pageNumber: 1,
      text: 'hello',
      language: 'eng',
      engine: 'e',
    });
    const ops = await pending();
    expect(ops.some((o) => o.entityType === 'documents')).toBe(true);
    const ocr = ops.find((o) => o.entityType === 'ocrPages')!;
    expect(ocr.entityId).toBe(`${id}|1`);
    // the applier can address it again (number coerced from the id)
    expect(await rt.applier.read('ocrPages', ocr.entityId)).toMatchObject({ pageNumber: 1 });
  });

  it('does not record device-local changes (resolution reports)', async () => {
    const saved = await saveCapture(cap());
    await rt.log.markSent(
      (await pending()).map((o) => o.id),
      1,
    );
    await reportResolutions([{ id: saved.highlight.id, status: 'resolved', confidence: 0.9 }]);
    expect(await pending()).toEqual([]);
  });

  it('is atomic: a transaction that fails afterwards leaves neither the row nor its operation', async () => {
    const db = getDb();
    await expect(
      db.transaction('rw', db.banks, async () => {
        await db.banks.put({
          id: 'bank-atomic-01',
          schemaVersion: 1,
          createdAt: '2026-10-11T00:00:00.000Z',
          updatedAt: '2026-10-11T00:00:00.000Z',
          deletedAt: null,
          name: 'Atomic',
          color: 'blue',
          position: 9,
          isInbox: false,
        });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await db.banks.get('bank-atomic-01')).toBeUndefined();
    expect(await pending()).toEqual([]);
  });

  it('a failure while recording aborts the write instead of leaving a row without its operation', async () => {
    const db = getDb();
    const original = db.syncInterceptor!;
    db.syncInterceptor = { ...original, record: () => Promise.reject(new Error('disk full')) };
    await expect(
      db.banks.put({
        id: 'bank-abort-001',
        schemaVersion: 1,
        createdAt: '2026-10-11T00:00:00.000Z',
        updatedAt: '2026-10-11T00:00:00.000Z',
        deletedAt: null,
        name: 'Abort',
        color: 'blue',
        position: 9,
        isInbox: false,
      }),
    ).rejects.toThrow('disk full');
    expect(await db.banks.get('bank-abort-001')).toBeUndefined();
    db.syncInterceptor = original;
  });
});

// ---------------------------------------------------------------------------------------------

describe('capture covers every Dexie mutation path', () => {
  const bank = (id: string, over: Record<string, unknown> = {}) =>
    ({
      id,
      schemaVersion: 1,
      createdAt: '2026-10-11T00:00:00.000Z',
      updatedAt: '2026-10-11T00:00:00.000Z',
      deletedAt: null,
      name: `Bank ${id}`,
      color: 'blue',
      position: 1,
      isInbox: false,
      ...over,
    }) as never;
  const bankOps = async () => (await pending()).filter((o) => o.entityType === 'banks');

  it.each([
    ['add', (db: StudyVaultDb) => db.banks.add(bank('bank-path-add-1'))],
    ['put (new)', (db: StudyVaultDb) => db.banks.put(bank('bank-path-put-1'))],
    [
      'bulkAdd',
      (db: StudyVaultDb) => db.banks.bulkAdd([bank('bank-bulk-a-1'), bank('bank-bulk-a-2')]),
    ],
    [
      'bulkPut',
      (db: StudyVaultDb) => db.banks.bulkPut([bank('bank-bulk-p-1'), bank('bank-bulk-p-2')]),
    ],
  ])('%s creates one operation per row', async (_name, write) => {
    const db = getDb();
    await write(db);
    const ops = await bankOps();
    expect(ops.length).toBeGreaterThan(0);
    expect(ops.every((o) => o.opType === 'upsert' && payloadOf(o).full)).toBe(true);
    expect(await db.syncEntityMeta.count()).toBe(ops.length);
  });

  it('update, modify (object and function), bulkUpdate and put over an existing row are edits', async () => {
    const db = getDb();
    await db.banks.bulkPut([
      bank('bank-edit-0001'),
      bank('bank-edit-0002'),
      bank('bank-edit-0003'),
    ]);
    await rt.log.markSent(
      (await pending()).map((o) => o.id),
      1,
    );

    await db.banks.update('bank-edit-0001', { name: 'via update' });
    await db.banks.where('id').equals('bank-edit-0002').modify({ name: 'via modify' });
    await db.banks
      .where('id')
      .equals('bank-edit-0003')
      .modify((b) => {
        b.position = 7;
      });
    await db.banks.put(bank('bank-edit-0001', { name: 'via put', position: 3 }));
    await db.banks.bulkUpdate([{ key: 'bank-edit-0002', changes: { color: 'amber' } }]);

    const ops = await bankOps();
    expect(ops.map((o) => o.entityId).sort()).toEqual([
      'bank-edit-0001',
      'bank-edit-0002',
      'bank-edit-0003',
    ]);
    const set = (id: string) => payloadOf(ops.find((o) => o.entityId === id)!).set;
    expect(set('bank-edit-0001')).toMatchObject({ name: 'via put', position: 3 });
    expect(set('bank-edit-0002')).toMatchObject({ name: 'via modify', color: 'amber' });
    expect(set('bank-edit-0003')).toMatchObject({ position: 7 });
    expect(ops.every((o) => payloadOf(o).full === false)).toBe(true);
  });

  it('delete, bulkDelete, where().delete() and clear() write tombstones', async () => {
    const db = getDb();
    await db.banks.bulkPut(['a', 'b', 'c', 'd', 'e'].map((s) => bank(`bank-del-0000${s}`)));
    await rt.log.markSent(
      (await pending()).map((o) => o.id),
      1,
    );
    await db.banks.delete('bank-del-0000a');
    await db.banks.bulkDelete(['bank-del-0000b']);
    await db.banks.where('id').equals('bank-del-0000c').delete();
    await db.banks.clear();
    const ops = await bankOps();
    expect(ops.every((o) => o.opType === 'delete' && o.tombstone)).toBe(true);
    expect(ops.map((o) => o.entityId).sort()).toEqual(
      ['a', 'b', 'c', 'd', 'e'].map((s) => `bank-del-0000${s}`),
    );
  });

  it('never records tables that are not synchronised, or its own bookkeeping', async () => {
    const db = getDb();
    await db.meta.put({ key: 'custom', value: 1, updatedAt: '2026-10-11T00:00:00.000Z' });
    await db.attachments.put({ id: 'att-0000001' } as never);
    await db.aiResults.put({ id: 'ai-0000001' });
    expect(await pending()).toEqual([]);
  });

  it('two connections (two extension contexts) write concurrently without clashing', async () => {
    const other = new StudyVaultDb(getDb().name);
    const second = await createSyncRuntime({ db: other, isEnabled: () => true });
    second.startCapture();
    try {
      const mine = getDb();
      await Promise.all([
        ...Array.from({ length: 12 }, (_, i) => mine.banks.put(bank(`bank-conn-a-${i}`))),
        ...Array.from({ length: 12 }, (_, i) => other.banks.put(bank(`bank-conn-b-${i}`))),
      ]);
      const ops = await bankOps();
      expect(ops).toHaveLength(24);
      expect(new Set(ops.map((o) => o.entityId)).size).toBe(24);
      const rows = await mine.syncOps.toArray();
      expect(new Set(rows.map((r) => r.seq)).size).toBe(rows.length); // unique, dense order
    } finally {
      other.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe('provenance guard', () => {
  it('a local change to an immutable field is kept out of the exchange and surfaced', async () => {
    const saved = await saveCapture(cap());
    await rt.log.markSent(
      (await pending()).map((o) => o.id),
      1,
    );
    const db = getDb();
    const row = (await db.highlights.get(saved.highlight.id))!;
    await db.highlights.put({ ...row, exactQuote: 'a rewritten quote', userComment: 'ok' });
    // the write itself is not blocked (sync is optional) ...
    expect((await db.highlights.get(saved.highlight.id))?.exactQuote).toBe('a rewritten quote');
    // ... but nothing was sent for it, and the user can see why
    expect(await pending()).toEqual([]);
    const issues = await listSyncQuarantine();
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      entityType: 'highlights',
      entityId: saved.highlight.id,
      reason: 'immutable_field',
    });
  });
});

// ---------------------------------------------------------------------------------------------

describe('remote changes are applied without being captured', () => {
  it('create, update and delete through the applier leave the outbox empty', async () => {
    const id = 'bank-remote-0001';
    await rt.applier.apply({
      entityType: 'banks',
      entityId: id,
      deleted: false,
      create: true,
      fields: {
        id,
        createdAt: '2026-10-11T00:00:00.000Z',
        updatedAt: '2026-10-11T00:00:00.000Z',
        deletedAt: null,
        name: 'From elsewhere',
        color: 'amber',
        position: 4,
        isInbox: false,
      },
      sets: {},
    });
    expect(await getDb().banks.get(id)).toMatchObject({ name: 'From elsewhere', schemaVersion: 1 });
    await rt.applier.apply({
      entityType: 'banks',
      entityId: id,
      deleted: false,
      create: false,
      fields: { name: 'Renamed remotely' },
      sets: {},
    });
    expect((await rt.applier.read('banks', id))?.name).toBe('Renamed remotely');
    await rt.applier.apply({
      entityType: 'banks',
      entityId: id,
      deleted: true,
      create: false,
      fields: {},
      sets: {},
    });
    expect(await getDb().banks.get(id)).toBeUndefined();
    expect(await pending()).toEqual([]);
    expect(await getDb().syncEntityMeta.count()).toBe(0);
  });

  it('a row that fails its table schema is refused with a reason, nothing is written', async () => {
    await expect(
      rt.applier.apply({
        entityType: 'banks',
        entityId: 'bank-bad-000001',
        deleted: false,
        create: true,
        fields: { id: 'bank-bad-000001', name: 42 },
        sets: {},
      }),
    ).rejects.toBeInstanceOf(ApplyRejectedError);
    expect(await getDb().banks.get('bank-bad-000001')).toBeUndefined();
    await expect(
      rt.applier.apply({
        entityType: 'cards',
        entityId: 'card-000000001',
        deleted: false,
        create: true,
        fields: {},
        sets: {},
      }),
    ).rejects.toMatchObject({ reason: 'unknown_entity_type' });
  });

  it('JSON null that stands for an absent optional field is dropped, a nullable one is kept', async () => {
    const saved = await saveCapture(cap());
    await rt.applier.apply({
      entityType: 'highlights',
      entityId: saved.highlight.id,
      deleted: false,
      create: false,
      fields: { capturedTitle: null, headingContext: null },
      sets: {},
    });
    const row = (await getDb().highlights.get(saved.highlight.id))!;
    expect(row.headingContext).toBeNull();
    expect('capturedTitle' in row).toBe(false);
  });

  it('refuses to write over a row saved by a newer build', async () => {
    const id = 'bank-newer-0001';
    await getDb().banks.put({
      id,
      schemaVersion: 2 as unknown as 1,
      createdAt: '2026-10-11T00:00:00.000Z',
      updatedAt: '2026-10-11T00:00:00.000Z',
      deletedAt: null,
      name: 'From the future',
      color: 'blue',
      position: 1,
      isInbox: false,
    });
    closeDb(); // a fresh connection has not verified that no newer rows exist
    const fresh = await createSyncRuntime({ isEnabled: () => true });
    await expect(
      fresh.applier.apply({
        entityType: 'banks',
        entityId: 'bank-other-0001',
        deleted: false,
        create: true,
        fields: {},
        sets: {},
      }),
    ).rejects.toMatchObject({ code: 'storage_unavailable' });
  });

  it('an explicit exclusion works for other wholesale writers too', async () => {
    const db = getDb();
    await db.transaction('rw', db.banks, async (tx) => {
      suppressSyncCapture(tx);
      await db.banks.put({
        id: 'bank-suppress-01',
        schemaVersion: 1,
        createdAt: '2026-10-11T00:00:00.000Z',
        updatedAt: '2026-10-11T00:00:00.000Z',
        deletedAt: null,
        name: 'Quiet',
        color: 'blue',
        position: 1,
        isInbox: false,
      });
    });
    expect(await pending()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------

describe('reconcile: what changed while capture was not running', () => {
  beforeEach(async () => {
    rt.stopCapture();
  });

  it('first enable: every existing row becomes a create, once', async () => {
    const h = await save('Existing quote before sync existed');
    await createNote({ highlightId: h.id, body: 'old note' });
    expect(await pending()).toEqual([]); // capture was off

    const first = await rt.reconcile();
    expect(first.created).toBeGreaterThan(0);
    expect(first.changed + first.deleted).toBe(0);
    const ops = await pending();
    expect(ops.some((o) => o.entityType === 'highlights')).toBe(true);
    expect(ops.every((o) => payloadOf(o).full)).toBe(true);

    const again = await rt.reconcile();
    expect(again).toMatchObject({ created: 0, changed: 0, deleted: 0, incomplete: false });
    expect(await pending()).toHaveLength(ops.length);
  });

  it('edits and deletes made while off are found and sent as patches and tombstones', async () => {
    const a = await save('Reconcile quote A is here');
    const b = await save('Reconcile quote B is here');
    await rt.reconcile();
    const first = await pending();
    await rt.log.markAttempted(first.map((o) => o.id));
    await rt.log.markSent(
      first.map((o) => o.id),
      1,
    );

    // while off: an edit, a soft delete, a physical delete, a new row
    const db = getDb();
    await db.highlights.update(a.id, {
      userComment: 'edited offline',
      updatedAt: '2026-11-01T00:00:00.000Z',
    });
    await db.highlightBanks.where('highlightId').equals(b.id).delete();
    const c = await save('Reconcile quote C is new');

    const result = await rt.reconcile();
    expect(result.created).toBeGreaterThan(0);
    // the edited highlight (and the shared source whose updatedAt moved when C was saved)
    expect(result.changed).toBeGreaterThanOrEqual(1);
    expect(result.deleted).toBe(1);
    const ops = await pending();
    const edit = ops.find((o) => o.entityType === 'highlights' && o.entityId === a.id)!;
    // only what changed is sent, not the whole row
    expect(payloadOf(edit).full).toBe(false);
    expect(Object.keys(payloadOf(edit).set).sort()).toEqual(['updatedAt', 'userComment']);
    expect(ops.filter((o) => o.opType === 'delete').map((o) => o.entityType)).toEqual([
      'highlightBanks',
    ]);
    expect(ops.some((o) => o.entityId === c.id)).toBe(true);
  });

  it('set-valued fields are diffed against the merge metadata', async () => {
    const { tag } = await createTag('Aliased');
    await rt.reconcile();
    const ids = (await pending()).map((o) => o.id);
    await rt.log.markAttempted(ids);
    await rt.log.markSent(ids, 1);
    await getDb().tags.update(tag.id, { aliases: ['alias one'] });
    const result = await rt.reconcile();
    expect(result.changed).toBe(1);
    const op = (await pending()).find((o) => o.entityType === 'tags')!;
    expect(op.payload).toMatchObject({ sets: { aliases: { add: ['alias one'], remove: [] } } });
  });

  it('a live edit made while the sweep runs is recorded as it is now, not as the sweep first read it', async () => {
    const db = getDb();
    const h = await save('Quote edited while the first sweep runs');
    const table = db.table('highlights'); // what the sweep reads through
    const read = table.toArray.bind(table);
    // The sweep has its copy of the table; the person edits the row before the sweep reaches it.
    vi.spyOn(table, 'toArray').mockImplementationOnce((async () => {
      const rows = await read();
      await db.highlights.update(h.id, { userComment: 'typed during the sweep' });
      return rows;
    }) as never);

    await rt.reconcile();

    const op = (await pending()).find((o) => o.entityType === 'highlights' && o.entityId === h.id)!;
    expect(payloadOf(op).set.userComment).toBe('typed during the sweep');
    // And what is on disk agrees with what was recorded: the next sweep finds nothing to do.
    expect(await rt.reconcile()).toMatchObject({ created: 0, changed: 0, deleted: 0 });
  });

  it('a row that is physically deleted while the sweep runs is not sent as a create', async () => {
    const db = getDb();
    const a = await save('Quote removed while the first sweep runs');
    const table = db.table('highlights');
    const read = table.toArray.bind(table);
    vi.spyOn(table, 'toArray').mockImplementationOnce((async () => {
      const rows = await read();
      await db.highlights.delete(a.id); // gone after the sweep read it
      return rows;
    }) as never);

    await rt.reconcile();

    const ops = await pending();
    expect(ops.some((o) => o.entityType === 'highlights' && o.entityId === a.id)).toBe(false);
  });

  it('a write from a transaction opened before capture started is noticed and reconciled', async () => {
    const db = getDb();
    const h = await save('Missed window quote');
    await rt.reconcile();
    const ids = (await pending()).map((o) => o.id);
    await rt.log.markAttempted(ids);
    await rt.log.markSent(ids, 1);

    await db.transaction('rw', db.highlights, async () => {
      await db.highlights.count(); // the transaction exists, capture is not installed yet
      rt.startCapture();
      await db.highlights.update(h.id, { userComment: 'written in the gap' });
    });
    expect(await rt.isDirty()).toBe(true);
    expect(await pending()).toEqual([]);
    expect((await rt.reconcile()).changed).toBe(1);
    expect(await rt.isDirty()).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------

describe('identity and the per-connection gate', () => {
  it('keeps one client id and replaces it (with a clean start) on request', async () => {
    const id = await ensureClientId();
    expect(id).toBe(rt.clientId);
    expect(await ensureClientId()).toBe(id);
    await saveCapture(cap());
    expect((await pending()).length).toBeGreaterThan(0);
    const next = await resetSyncIdentity();
    expect(next).not.toBe(id);
    expect(await pending()).toEqual([]);
    expect(await getDb().syncEntityMeta.count()).toBe(0);
    expect(await getDb().highlights.count()).toBe(1); // user data is never touched
  });

  it('with the flag off nothing is installed and nothing is recorded', async () => {
    await resetDbForTests();
    fakeBrowser.reset();
    await saveCapture(cap()); // goes through the gate
    expect(getDb().syncInterceptor).toBeNull();
    expect(await getDb().syncOps.count()).toBe(0);
    expect(await getDb().syncEntityMeta.count()).toBe(0);
    expect(await getDb().meta.get('sync.state')).toBeUndefined();
  });

  it('with the flag on, a context installs capture before its first write, and follows the flag live', async () => {
    await resetDbForTests();
    fakeBrowser.reset();
    await fakeBrowser.storage.local.set({
      settings: {
        ...defaultSettings(),
        features: { review: true, pdfReader: true, ai: false, sync: true },
      },
    });
    await saveCapture(cap('Quote written while sync is on'));
    expect(getDb().syncInterceptor).not.toBeNull();
    expect(await getDb().syncOps.count()).toBeGreaterThan(0);

    // switched off from another context (the options page): this context stops recording
    await fakeBrowser.storage.local.set({ settings: defaultSettings() });
    await vi.waitFor(() => expect(getDb().syncInterceptor).toBeNull());
    const before = await getDb().syncOps.count();
    await saveCapture(cap('Quote written after sync was switched off', 400));
    expect(await getDb().syncOps.count()).toBe(before);

    // and on again
    await fakeBrowser.storage.local.set({
      settings: {
        ...defaultSettings(),
        features: { review: true, pdfReader: true, ai: false, sync: true },
      },
    });
    await vi.waitFor(() => expect(getDb().syncInterceptor).not.toBeNull());
    stopSyncCapture();
  });
});

describe('fingerprints', () => {
  it('ignore device-local and set fields and are stable under key order', () => {
    const { policy } = activeSyncPolicy();
    const resolved = {
      immutable: new Set<string>(),
      text: new Set<string>(),
      sets: new Set(['aliases']),
      local: new Set(['resolveStatus']),
      fields: null,
      appendOnly: false,
    };
    const a = fieldHashes(
      { id: 'x', name: 'n', aliases: ['q'], resolveStatus: 'resolved' },
      resolved,
    );
    const b = fieldHashes({ resolveStatus: 'orphaned', name: 'n', id: 'x', aliases: [] }, resolved);
    expect(a).toEqual(b);
    expect(Object.keys(a).sort()).toEqual(['id', 'name']);
    expect(policy.highlights).toBeDefined();
  });
});

describe('listing', () => {
  it('lists conflicts and quarantine through the repository connection', async () => {
    expect(await listSyncConflicts()).toEqual([]);
    expect(await listSyncQuarantine()).toEqual([]);
  });
});

describe('a full outbox never loses a change silently', () => {
  it('commits the write, remembers the gap, and finds the rest by fingerprint once drained', async () => {
    rt.stopCapture();
    const small = await createSyncRuntime({
      isEnabled: () => true,
      options: { maxPendingOps: 2 },
    });
    small.startCapture();
    const db = getDb();
    const bank = (n: number) =>
      ({
        id: `bank-full-${String(n).padStart(4, '0')}`,
        schemaVersion: 1,
        createdAt: '2026-10-11T00:00:00.000Z',
        updatedAt: '2026-10-11T00:00:00.000Z',
        deletedAt: null,
        name: `Bank ${n}`,
        color: 'blue',
        position: n,
        isInbox: false,
      }) as never;

    await db.banks.bulkPut([1, 2, 3, 4, 5].map(bank));
    // every row was written, only two operations fit, and the gap is on record
    expect(await db.banks.count()).toBe(5);
    expect((await small.log.pending(100)).length).toBe(2);
    expect(await small.isDirty()).toBe(true);

    // the queue drains (sent), then the missing ones are recorded: nothing was lost
    const ids = (await small.log.pending(100)).map((p) => p.op.id);
    await small.log.markAttempted(ids);
    await small.log.markSent(ids, Date.now());
    const first = await small.reconcile();
    expect(first.created).toBeGreaterThan(0);
    // still not everything fits: it stays dirty and continues after the next drain
    let guard = 0;
    while (await small.isDirty()) {
      const queued = (await small.log.pending(100)).map((p) => p.op.id);
      await small.log.markAttempted(queued);
      await small.log.markSent(queued, Date.now());
      await small.reconcile();
      if (++guard > 10) throw new Error('did not converge');
    }
    const meta = await db.syncEntityMeta.where('entityType').equals('banks').toArray();
    expect(meta.length).toBe(5);
  });
});
