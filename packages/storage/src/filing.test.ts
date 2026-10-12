// @vitest-environment node
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FILING_SESSION_MAX_AGE_MS,
  INBOX_BANK_ID,
  filingSuggestionKey,
  filingUndoKey,
  type FilingCandidate,
} from '@shared';
import { getDb } from './db';
import {
  FILING_PLAN_BUDGET_MS,
  acceptFiling,
  dismissFiling,
  filingAfterCapture,
  listFilingSuggestions,
  undoFiling,
  type FilingSessionPort,
} from './filing';
import { createFolder, deleteBank } from './hierarchy';
import { addToBank } from './membership';
import { createBank, saveCapture } from './repo';
import { createFilingRule, deleteFilingRule, updateFilingRule } from './rules';
import { attachTags, createTag, deleteTag } from './tags';
import { anchor, cap } from './test-fixtures';
import { freshDatabase } from './test-vault';

/** An in-memory chrome.storage.session. */
function memoryPort() {
  const store = new Map<string, unknown>();
  const port: FilingSessionPort = {
    async get(keys) {
      if (keys === null) return Object.fromEntries(store);
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((k) => store.has(k)).map((k) => [k, store.get(k)]));
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) store.set(k, structuredClone(v));
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
    },
  };
  return { port, store };
}

beforeEach(async () => {
  await freshDatabase();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.useRealTimers());

let counter = 0;
/** A new highlight on example.com, saved the way a capture saves it (in the Inbox). */
async function capture(over: { url?: string; quote?: string; bankId?: string | null } = {}) {
  counter += 1;
  const quote = over.quote ?? `Heart failure is a clinical syndrome number ${counter}.`;
  const url = over.url ?? 'https://www.example.com/courses/cardio/week-1';
  const result = await saveCapture(
    cap(quote, 100 + counter * 50, {
      page: { url, canonicalUrl: null, title: 'Week 1: Cardiology' },
      anchorSet: anchor(quote, 100 + counter * 50),
      bankId: over.bankId ?? null,
    }),
  );
  const candidate: FilingCandidate = {
    url,
    title: 'Week 1: Cardiology',
    quote,
    kind: result.highlight.kind,
    tagIds: [],
    sourceType: 'web',
  };
  return {
    result,
    id: result.highlight.id,
    candidate,
    placed: { bankId: result.bank.id, folderId: null as string | null },
    requestedBankId: over.bankId ?? null,
    lastBankId: null as string | null,
  };
}

async function membershipsOf(id: string) {
  return (await getDb().highlightBanks.where('highlightId').equals(id).toArray()).map((m) => ({
    bankId: m.bankId,
    folderId: m.folderId,
  }));
}
const tagsOf = async (id: string) =>
  (await getDb().highlightTags.where('highlightId').equals(id).toArray()).map((l) => l.tagId);

describe('a rule that asks first (the default)', () => {
  it('stores a suggestion and changes nothing', async () => {
    const bank = await createBank('Cardiology');
    const { port, store } = memoryPort();
    await createFilingRule({
      name: 'Cardio sites',
      match: { hosts: ['example.com'] },
      action: { bankId: bank.id },
    });
    const c = await capture();
    const before = await membershipsOf(c.id);

    const outcome = await filingAfterCapture({ highlightId: c.id, ...c }, port);

    expect(outcome).toMatchObject({
      status: 'suggested',
      ruleName: 'Cardio sites',
      bank: { id: bank.id, name: 'Cardiology' },
      folderName: null,
      addedTags: 0,
    });
    expect(await membershipsOf(c.id)).toEqual(before);
    expect(before).toEqual([{ bankId: INBOX_BANK_ID, folderId: null }]);
    expect(await listFilingSuggestions(port)).toMatchObject([
      { highlightId: c.id, bankId: bank.id, ruleName: 'Cardio sites' },
    ]);
    expect([...store.keys()]).toEqual([filingSuggestionKey(c.id)]);
  });

  it('files on accept, in one move, and Undo puts it back', async () => {
    const bank = await createBank('Cardiology');
    const folder = await createFolder({ bankId: bank.id, name: 'Week 1' });
    const tag = (await createTag('Cardio')).tag;
    const { port } = memoryPort();
    await createFilingRule({
      name: 'Cardio',
      match: { hosts: ['example.com'] },
      action: { bankId: bank.id, folderId: folder.id, addTagIds: [tag.id] },
    });
    const c = await capture();
    await filingAfterCapture({ highlightId: c.id, ...c }, port);

    const filed = await acceptFiling(c.id, port);

    expect(filed).toMatchObject({
      status: 'filed',
      ruleName: 'Cardio',
      bank: { id: bank.id },
      folderName: 'Week 1',
      addedTags: 1,
    });
    expect(await membershipsOf(c.id)).toEqual([{ bankId: bank.id, folderId: folder.id }]);
    expect(await tagsOf(c.id)).toEqual([tag.id]);
    expect(await listFilingSuggestions(port)).toEqual([]);

    expect(await undoFiling(c.id, port)).toEqual({ restored: true, reason: null });
    expect(await membershipsOf(c.id)).toEqual([{ bankId: INBOX_BANK_ID, folderId: null }]);
    expect(await tagsOf(c.id)).toEqual([]);
    // Undo is single use.
    expect(await undoFiling(c.id, port)).toMatchObject({ restored: false });
  });

  it('"Not now" drops the suggestion; accepting it afterwards says it is gone', async () => {
    const bank = await createBank('Cardiology');
    const { port } = memoryPort();
    await createFilingRule({
      name: 'Cardio',
      match: { hosts: ['example.com'] },
      action: { bankId: bank.id },
    });
    const c = await capture();
    await filingAfterCapture({ highlightId: c.id, ...c }, port);
    await dismissFiling(c.id, port);
    expect(await listFilingSuggestions(port)).toEqual([]);
    expect(await acceptFiling(c.id, port)).toMatchObject({ status: 'unavailable' });
    expect(await membershipsOf(c.id)).toEqual([{ bankId: INBOX_BANK_ID, folderId: null }]);
  });

  it('a suggestion expires after a day', async () => {
    const bank = await createBank('Cardiology');
    const { port } = memoryPort();
    await createFilingRule({
      name: 'Cardio',
      match: { hosts: ['example.com'] },
      action: { bankId: bank.id },
    });
    const c = await capture();
    await filingAfterCapture({ highlightId: c.id, ...c }, port);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + FILING_SESSION_MAX_AGE_MS + 1000);
    expect(await listFilingSuggestions(port)).toEqual([]);
    expect(await acceptFiling(c.id, port)).toMatchObject({ status: 'unavailable' });
  });

  it('a tag deleted since the suggestion is skipped; the bank and folder still file', async () => {
    const bank = await createBank('Cardiology');
    const kept = (await createTag('Keep')).tag;
    const gone = (await createTag('Gone')).tag;
    const { port } = memoryPort();
    await createFilingRule({
      name: 'Cardio',
      match: { hosts: ['example.com'] },
      action: { bankId: bank.id, addTagIds: [kept.id, gone.id] },
    });
    const c = await capture();
    await filingAfterCapture({ highlightId: c.id, ...c }, port);
    await deleteTag(gone.id);
    const filed = await acceptFiling(c.id, port);
    expect(filed).toMatchObject({ status: 'filed', addedTags: 1 });
    expect(await tagsOf(c.id)).toEqual([kept.id]);
  });

  it('accepting after the bank was deleted files nothing and says why', async () => {
    const bank = await createBank('Cardiology');
    const { port } = memoryPort();
    await createFilingRule({
      name: 'Cardio',
      match: { hosts: ['example.com'] },
      action: { bankId: bank.id },
    });
    const c = await capture();
    await filingAfterCapture({ highlightId: c.id, ...c }, port);
    await deleteBank(bank.id);
    const out = await acceptFiling(c.id, port);
    expect(out).toMatchObject({ status: 'unavailable', ruleName: 'Cardio' });
    expect(await membershipsOf(c.id)).toEqual([{ bankId: INBOX_BANK_ID, folderId: null }]);
    expect(await listFilingSuggestions(port)).toEqual([]);
  });
});

describe('a rule that files without asking', () => {
  async function quietRule(over: { requireConfirm?: boolean } = {}) {
    const bank = await createBank('Cardiology');
    const tag = (await createTag('Cardio')).tag;
    const rule = await createFilingRule({
      name: 'Cardio',
      match: { hosts: ['example.com'] },
      action: { bankId: bank.id, addTagIds: [tag.id] },
      requireConfirm: over.requireConfirm ?? false,
    });
    return { bank, tag, rule };
  }

  it('files at once and records Undo; source and quote are untouched', async () => {
    const { bank, tag } = await quietRule();
    const { port } = memoryPort();
    const c = await capture();
    const db = getDb();
    const sourceBefore = await db.sources.get(c.result.highlight.sourceId);
    const rowBefore = await db.highlights.get(c.id);

    const outcome = await filingAfterCapture({ highlightId: c.id, ...c }, port);

    expect(outcome).toMatchObject({
      status: 'filed',
      bank: { id: bank.id, name: 'Cardiology' },
      addedTags: 1,
    });
    expect(await membershipsOf(c.id)).toEqual([{ bankId: bank.id, folderId: null }]);
    expect(await tagsOf(c.id)).toEqual([tag.id]);
    expect(await db.sources.get(c.result.highlight.sourceId)).toEqual(sourceBefore);
    const rowAfter = await db.highlights.get(c.id);
    expect({ ...rowAfter, updatedAt: '' }).toEqual({ ...rowBefore, updatedAt: '' });
    expect(rowAfter?.updatedAt).not.toBe(rowBefore?.updatedAt);
    expect(await port.get(filingUndoKey(c.id))).toHaveProperty([filingUndoKey(c.id)]);
  });

  it('Undo restores the previous placement and leaves tags the highlight already had', async () => {
    const { tag } = await quietRule();
    const own = (await createTag('Own')).tag;
    const { port } = memoryPort();
    const c = await capture();
    await attachTags({ highlightIds: [c.id], tagIds: [own.id, tag.id] });
    const candidate = { ...c.candidate, tagIds: [own.id, tag.id] };

    // Both tags are already there: only the move is new.
    const outcome = await filingAfterCapture({ highlightId: c.id, ...c, candidate }, port);
    expect(outcome).toMatchObject({ status: 'filed', addedTags: 0 });
    expect(await undoFiling(c.id, port)).toEqual({ restored: true, reason: null });
    expect(await membershipsOf(c.id)).toEqual([{ bankId: INBOX_BANK_ID, folderId: null }]);
    expect((await tagsOf(c.id)).sort()).toEqual([own.id, tag.id].sort());
  });

  it('Undo does not touch a highlight that was moved again', async () => {
    await quietRule();
    const other = await createBank('Elsewhere');
    const { port } = memoryPort();
    const c = await capture();
    await filingAfterCapture({ highlightId: c.id, ...c }, port);
    await addToBank({ highlightId: c.id, bankId: other.id });

    const out = await undoFiling(c.id, port);

    expect(out.restored).toBe(false);
    expect(out.reason).toMatch(/moved again/);
    expect((await membershipsOf(c.id)).map((m) => m.bankId).sort()).toHaveLength(2);
  });

  it('a mixed pair of rules asks: a quiet rule cannot carry an asking one through', async () => {
    const { bank } = await quietRule();
    const { port } = memoryPort();
    await createFilingRule({
      name: 'Asks',
      match: { titleContains: ['cardiology'] },
      action: { bankId: bank.id },
      requireConfirm: true,
    });
    const c = await capture();
    const outcome = await filingAfterCapture({ highlightId: c.id, ...c }, port);
    expect(outcome?.status).toBe('suggested');
    expect(await membershipsOf(c.id)).toEqual([{ bankId: INBOX_BANK_ID, folderId: null }]);
  });
});

describe('what applies', () => {
  it('nothing without a rule, with only disabled rules or when none matches', async () => {
    const bank = await createBank('Cardiology');
    const { port, store } = memoryPort();
    const c = await capture();
    expect(await filingAfterCapture({ highlightId: c.id, ...c }, port)).toBeNull();

    const rule = await createFilingRule({
      name: 'Cardio',
      match: { hosts: ['example.com'] },
      action: { bankId: bank.id },
      requireConfirm: false,
    });
    await updateFilingRule(rule.id, { enabled: false });
    expect(await filingAfterCapture({ highlightId: c.id, ...c }, port)).toBeNull();

    await updateFilingRule(rule.id, { enabled: true, match: { hosts: ['other.org'] } });
    expect(await filingAfterCapture({ highlightId: c.id, ...c }, port)).toBeNull();
    expect(await membershipsOf(c.id)).toEqual([{ bankId: INBOX_BANK_ID, folderId: null }]);
    expect(store.size).toBe(0);
  });

  it('a deleted rule is gone for good', async () => {
    const bank = await createBank('Cardiology');
    const { port } = memoryPort();
    const rule = await createFilingRule({
      name: 'Cardio',
      match: { hosts: ['example.com'] },
      action: { bankId: bank.id },
      requireConfirm: false,
    });
    await deleteFilingRule(rule.id);
    const c = await capture();
    expect(await filingAfterCapture({ highlightId: c.id, ...c }, port)).toBeNull();
  });

  it('the first rule in order decides the place; tags of every matching rule are added', async () => {
    const a = await createBank('First');
    const b = await createBank('Second');
    const t1 = (await createTag('One')).tag;
    const t2 = (await createTag('Two')).tag;
    const { port } = memoryPort();
    await createFilingRule({
      name: 'A',
      match: { hosts: ['example.com'] },
      action: { bankId: a.id, addTagIds: [t1.id] },
      requireConfirm: false,
    });
    await createFilingRule({
      name: 'B',
      match: { titleContains: ['week 1'] },
      action: { bankId: b.id, addTagIds: [t2.id] },
      requireConfirm: false,
    });
    const c = await capture();
    const out = await filingAfterCapture({ highlightId: c.id, ...c }, port);
    expect(out).toMatchObject({ status: 'filed', ruleName: 'A', bank: { id: a.id }, addedTags: 2 });
    expect(await membershipsOf(c.id)).toEqual([{ bankId: a.id, folderId: null }]);
    expect((await tagsOf(c.id)).sort()).toEqual([t1.id, t2.id].sort());
  });

  it('never overrides a bank the person picked, but acts on the default one', async () => {
    const target = await createBank('Cardiology');
    const picked = await createBank('Picked');
    const last = await createBank('Last used');
    const { port } = memoryPort();
    await createFilingRule({
      name: 'Cardio',
      match: { hosts: ['example.com'] },
      action: { bankId: target.id },
      requireConfirm: false,
    });
    const explicit = await capture({ bankId: picked.id });
    const quiet = await filingAfterCapture(
      { highlightId: explicit.id, ...explicit, lastBankId: last.id },
      port,
    );
    expect(quiet).toBeNull();
    expect(await membershipsOf(explicit.id)).toEqual([{ bankId: picked.id, folderId: null }]);

    // The default placement is the last-used bank: naming it is no choice.
    const defaulted = await capture({ bankId: last.id });
    const filed = await filingAfterCapture(
      { highlightId: defaulted.id, ...defaulted, lastBankId: last.id },
      port,
    );
    expect(filed).toMatchObject({ status: 'filed', bank: { id: target.id } });
  });

  it('a rule that would change nothing stays quiet', async () => {
    const bank = await createBank('Cardiology');
    const { port, store } = memoryPort();
    await createFilingRule({
      name: 'Cardio',
      match: { hosts: ['example.com'] },
      action: { bankId: bank.id },
      requireConfirm: false,
    });
    const c = await capture({ bankId: bank.id });
    expect(await filingAfterCapture({ highlightId: c.id, ...c }, port)).toBeNull();
    expect(store.size).toBe(0);
  });

  it('a PDF highlight is only filed by a rule that names pdf', async () => {
    const bank = await createBank('Cardiology');
    const { port } = memoryPort();
    await createFilingRule({
      name: 'Any source',
      match: { kinds: ['essential'] },
      action: { bankId: bank.id },
      requireConfirm: false,
    });
    const c = await capture();
    const pdf = { ...c.candidate, url: null, sourceType: 'pdf' as const };
    expect(await filingAfterCapture({ highlightId: c.id, ...c, candidate: pdf }, port)).toBeNull();

    await createFilingRule({
      name: 'PDFs',
      match: { sourceTypes: ['pdf'], kinds: ['essential'] },
      action: { bankId: bank.id },
      requireConfirm: false,
    });
    // The first (any-source) rule is not offered a PDF, so the named rule decides.
    const out = await filingAfterCapture({ highlightId: c.id, ...c, candidate: pdf }, port);
    expect(out).toMatchObject({ status: 'filed', ruleName: 'PDFs' });
  });
});

describe('a rule whose target is gone', () => {
  it('files nothing, keeps the highlight where the capture put it and says so', async () => {
    const bank = await createBank('Cardiology');
    const { port, store } = memoryPort();
    await createFilingRule({
      name: 'Cardio',
      match: { hosts: ['example.com'] },
      action: { bankId: bank.id },
      requireConfirm: false,
    });
    await deleteBank(bank.id);
    const c = await capture();

    const out = await filingAfterCapture({ highlightId: c.id, ...c }, port);

    expect(out).toMatchObject({ status: 'unavailable', ruleName: 'Cardio' });
    expect(out?.status === 'unavailable' && out.reason).toMatch(/bank no longer exists/);
    expect(await membershipsOf(c.id)).toEqual([{ bankId: INBOX_BANK_ID, folderId: null }]);
    expect(store.size).toBe(0);
  });

  it('is not handed to a lower rule', async () => {
    const gone = await createBank('Gone');
    const other = await createBank('Other');
    const { port } = memoryPort();
    await createFilingRule({
      name: 'Broken',
      match: { hosts: ['example.com'] },
      action: { bankId: gone.id },
      requireConfirm: false,
    });
    await createFilingRule({
      name: 'Lower',
      match: { hosts: ['example.com'] },
      action: { bankId: other.id },
      requireConfirm: false,
    });
    await deleteBank(gone.id);
    const c = await capture();
    const out = await filingAfterCapture({ highlightId: c.id, ...c }, port);
    expect(out).toMatchObject({ status: 'unavailable', ruleName: 'Broken' });
    expect(await membershipsOf(c.id)).toEqual([{ bankId: INBOX_BANK_ID, folderId: null }]);
  });
});

describe('failures never reach the save', () => {
  it('gives up planning after the budget instead of holding the save', async () => {
    const rules = await import('./rules');
    const c = await capture();
    const { port } = memoryPort();
    vi.spyOn(rules, 'listFilingRules').mockImplementation(() => new Promise(() => undefined));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = filingAfterCapture({ highlightId: c.id, ...c }, port);
    await vi.advanceTimersByTimeAsync(FILING_PLAN_BUDGET_MS + 1);
    await expect(pending).resolves.toBeNull();
    expect(await membershipsOf(c.id)).toEqual([{ bankId: INBOX_BANK_ID, folderId: null }]);
  });

  it('a session store that fails is logged and means "no filing"', async () => {
    const bank = await createBank('Cardiology');
    await createFilingRule({
      name: 'Cardio',
      match: { hosts: ['example.com'] },
      action: { bankId: bank.id },
    });
    const c = await capture();
    const port: FilingSessionPort = {
      get: async () => ({}),
      set: async () => {
        throw new Error('quota');
      },
      remove: async () => undefined,
    };
    await expect(filingAfterCapture({ highlightId: c.id, ...c }, port)).resolves.toBeNull();
    expect(console.warn).toHaveBeenCalled();
    expect(await membershipsOf(c.id)).toEqual([{ bankId: INBOX_BANK_ID, folderId: null }]);
  });
});
