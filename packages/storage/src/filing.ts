import { browser } from 'wxt/browser';
import {
  FILING_SESSION_MAX_AGE_MS,
  FILING_SESSION_MAX_RECORDS,
  FILING_SUGGESTION_PREFIX,
  FILING_UNDO_PREFIX,
  FilingSuggestion,
  FilingUndoRecord,
  INBOX_BANK_ID,
  decideFiling,
  filingSuggestionKey,
  filingUndoKey,
  isDefaultBankChoice,
  type BankLite,
  type FilingCandidate,
  type FilingOutcome,
  type FilingRuleIssue,
} from '@shared';
import {
  ensureInbox,
  isDeleted,
  liveBank,
  liveHighlight,
  notNull,
  now,
  readBanks,
  requireId,
  signalChange,
  touchHighlights,
  toLite,
} from './core';
import { withDb, withWritableDb } from './db';
import { assertFolderInBank, fileInBank, MEMBERSHIP_TABLES } from './membership';
import { checkFilingRules, listFilingRules } from './rules';
import { linkTags, unlinkTags } from './tags';

/**
 * Applying auto-filing rules to a highlight that was just saved (docs/adr/017-filing-rules.md).
 *
 * Storage never decides anything itself: `decideFiling` (shared, pure) says what a candidate gets.
 * This module reads the rules, files with the existing membership primitives in ONE transaction, and
 * keeps the two small records the person's next click needs (a pending suggestion, an undo record)
 * in chrome.storage.session, which survives a suspended worker and is never synced or backed up.
 *
 * Nothing here is called for imports, restores or sync: only a capture path calls
 * `filingAfterCapture`, and only for a highlight it has just created.
 */

/** The part of chrome.storage.session this module uses (injected in tests). */
export interface FilingSessionPort {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

const sessionPort = (): FilingSessionPort => browser.storage.session as FilingSessionPort;

/** Planning (reads only) is abandoned after this long: the save has already succeeded. */
export const FILING_PLAN_BUDGET_MS = 2_000;

export interface FilingCapture {
  highlightId: string;
  candidate: FilingCandidate;
  /** Where the capture put it: a rule that would change nothing is not worth a toast. */
  placed: { bankId: string; folderId: string | null };
  /**
   * The bank the capture asked for (null: "wherever a quick save goes") and the last-used bank at
   * that time. A request for any other bank is the person's choice and rules leave it alone.
   */
  requestedBankId: string | null;
  lastBankId: string | null;
}

/** The rule's own words for why it could not be applied. */
function whyBlocked(issues: readonly FilingRuleIssue[]): string {
  const has = (field: FilingRuleIssue['field']) => issues.some((i) => i.field === field);
  if (has('action.bankId')) return 'its bank no longer exists';
  if (has('action.folderId')) {
    return issues.some((i) => i.field === 'action.folderId' && i.problem === 'wrong_bank')
      ? 'its folder is not in its bank any more'
      : 'its folder no longer exists';
  }
  return 'a tag it adds no longer exists';
}

type Applied =
  | {
      status: 'filed';
      bank: BankLite;
      folderName: string | null;
      addedTagIds: string[];
      undo: FilingUndoRecord;
    }
  | { status: 'unchanged' }
  | { status: 'unavailable'; reason: string };

interface Placement {
  bankId: string;
  folderId: string | null;
  addTagIds: readonly string[];
}

/**
 * File `highlightId` at `placement` and nowhere else it lives now, in one transaction. The source and
 * the quote are not touched; only memberships, tag links and the highlight's `updatedAt` (so search
 * and sync see the change). Memberships to banks that are gone are left alone.
 */
async function applyPlacement(
  highlightId: string,
  placement: Placement,
  at: number,
): Promise<Applied> {
  const result = await withWritableDb((db) =>
    db.transaction('rw', [...MEMBERSHIP_TABLES(db), db.tags, db.highlightTags], async () => {
      try {
        await liveHighlight(db, highlightId);
      } catch {
        return { status: 'unavailable', reason: 'the highlight no longer exists' } as const;
      }
      let bank;
      try {
        bank = await liveBank(db, placement.bankId);
      } catch {
        return { status: 'unavailable', reason: 'its bank no longer exists' } as const;
      }
      let folderName: string | null = null;
      if (placement.folderId !== null) {
        try {
          await assertFolderInBank(db, placement.folderId, bank.id);
        } catch {
          return { status: 'unavailable', reason: 'its folder no longer exists' } as const;
        }
        folderName = (await db.folders.get(placement.folderId))?.name ?? null;
      }
      // Only tags that still exist are added: a tag deleted since the suggestion does not stop it.
      const tagRows = await db.tags.bulkGet([...placement.addTagIds]);
      const liveTagIds = placement.addTagIds.filter((_, i) => {
        const row = tagRows[i];
        return row !== undefined && !isDeleted(row);
      });
      const liveBankIds = new Set((await readBanks(db)).map((b) => b.id));
      const memberships = (
        await db.highlightBanks.where('highlightId').equals(highlightId).toArray()
      ).filter((m) => liveBankIds.has(m.bankId));
      const had = new Set(
        (await db.highlightTags.where('highlightId').equals(highlightId).toArray()).map(
          (l) => l.tagId,
        ),
      );
      const newTagIds = liveTagIds.filter((id) => !had.has(id));

      const ts = now();
      let changed = false;
      for (const m of memberships) {
        if (m.bankId === bank.id) continue;
        await db.highlightBanks.delete([highlightId, m.bankId]);
        changed = true;
      }
      const filed = await fileInBank(db, highlightId, bank.id, placement.folderId, ts);
      changed = changed || filed.changed;
      if (newTagIds.length > 0) {
        await linkTags(db, [highlightId], newTagIds, ts);
        changed = true;
      }
      if (!changed) return { status: 'unchanged' } as const;
      await touchHighlights(db, [highlightId], ts);
      const undo: FilingUndoRecord = {
        highlightId,
        at,
        bankId: bank.id,
        folderId: placement.folderId,
        previous: memberships.map((m) => ({
          bankId: m.bankId,
          folderId: m.folderId,
          addedAt: m.addedAt,
        })),
        addedTagIds: newTagIds,
      };
      return {
        status: 'filed',
        bank: toLite(bank),
        folderName,
        addedTagIds: newTagIds,
        undo,
      } as const;
    }),
  );
  if (result.status === 'filed') await signalChange();
  return result;
}

// ---------------------------------------------------------------------------------------------
// session records
// ---------------------------------------------------------------------------------------------

/** Drop what is too old and, per kind, all but the newest records. Best effort. */
async function prune(port: FilingSessionPort, at: number): Promise<void> {
  try {
    const all = await port.get(null);
    const doomed: string[] = [];
    for (const prefix of [FILING_SUGGESTION_PREFIX, FILING_UNDO_PREFIX]) {
      const entries = Object.entries(all)
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({
          key,
          at:
            typeof (value as { at?: unknown })?.at === 'number' ? (value as { at: number }).at : 0,
        }))
        .sort((a, b) => b.at - a.at);
      entries.forEach((entry, index) => {
        if (index >= FILING_SESSION_MAX_RECORDS || at - entry.at > FILING_SESSION_MAX_AGE_MS) {
          doomed.push(entry.key);
        }
      });
    }
    if (doomed.length > 0) await port.remove(doomed);
  } catch (err) {
    console.warn('[StudyVault] could not prune filing records', err);
  }
}

async function readRecord<T>(
  port: FilingSessionPort,
  key: string,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
): Promise<T | null> {
  const stored = (await port.get(key))[key];
  const parsed = schema.safeParse(stored);
  if (!parsed.success) return null;
  const at = (parsed.data as { at: number }).at;
  if (Date.now() - at > FILING_SESSION_MAX_AGE_MS) {
    await port.remove(key).catch(() => undefined);
    return null;
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------------------------

const within = async <T>(work: Promise<T>, ms: number): Promise<T | undefined> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Run the rules for a highlight a capture has just created. Returns what the person should be told,
 * or null when no rule applies. It never throws: whatever goes wrong here must not turn a saved
 * highlight into an error, so a failure is logged and means "no filing".
 *
 * A rule that asks first (the default) stores a suggestion and changes nothing. A rule that does not
 * ask files the highlight at once, in one transaction, and stores the undo record.
 */
export async function filingAfterCapture(
  input: FilingCapture,
  port: FilingSessionPort = sessionPort(),
): Promise<FilingOutcome | null> {
  try {
    const highlightId = requireId(input.highlightId);
    const decision = await within(
      (async () => {
        const rules = await listFilingRules({ enabledOnly: true });
        if (rules.length === 0) return null;
        return decideFiling(rules, await checkFilingRules(), input.candidate);
      })(),
      FILING_PLAN_BUDGET_MS,
    );
    if (!decision || decision.kind === 'none') return null;
    // Only after a rule matched: a capture that no rule matches does no extra read. A bank the
    // person picked is theirs; rules act only on the default placement.
    const liveBankIds = await withDb(async (db) => (await readBanks(db)).map((b) => b.id));
    if (!isDefaultBankChoice(input.requestedBankId, input.lastBankId, liveBankIds, INBOX_BANK_ID)) {
      return null;
    }
    const ruleName = decision.rule.name;
    if (decision.kind === 'blocked') {
      return {
        status: 'unavailable',
        ruleName,
        reason: `The highlight stays where it was saved: ${whyBlocked(decision.issues)}.`,
      };
    }
    const { plan } = decision;
    const here = input.placed;
    if (
      plan.bankId === here.bankId &&
      plan.folderId === here.folderId &&
      plan.addTagIds.length === 0
    ) {
      return null; // already where the rule would put it
    }
    const at = Date.now();

    if (plan.requireConfirm) {
      const target = await describeTarget(plan.bankId, plan.folderId);
      if (!target) return null;
      const suggestion: FilingSuggestion = {
        highlightId,
        at,
        ruleName,
        bankId: plan.bankId,
        bankName: target.bank.name,
        folderId: plan.folderId,
        folderName: target.folderName,
        addTagIds: plan.addTagIds,
      };
      await port.set({ [filingSuggestionKey(highlightId)]: suggestion });
      void prune(port, at);
      return {
        status: 'suggested',
        ruleName,
        bank: target.bank,
        folderName: target.folderName,
        addedTags: plan.addTagIds.length,
      };
    }

    const applied = await applyPlacement(highlightId, plan, at);
    if (applied.status === 'unchanged') return null;
    if (applied.status === 'unavailable') {
      return {
        status: 'unavailable',
        ruleName,
        reason: `The highlight stays where it was saved: ${applied.reason}.`,
      };
    }
    await port.set({ [filingUndoKey(highlightId)]: applied.undo });
    void prune(port, at);
    return {
      status: 'filed',
      ruleName,
      bank: applied.bank,
      folderName: applied.folderName,
      addedTags: applied.addedTagIds.length,
    };
  } catch (err) {
    console.warn('[StudyVault] filing rules were not applied', err);
    return null;
  }
}

/** The bank and folder name a toast or chip shows; null when the bank is not there. */
async function describeTarget(
  bankId: string,
  folderId: string | null,
): Promise<{ bank: BankLite; folderName: string | null } | null> {
  return withDb(async (db) => {
    const bank = (await readBanks(db)).find((b) => b.id === bankId);
    if (!bank) return null;
    const folder = folderId === null ? null : await db.folders.get(folderId);
    return { bank: toLite(bank), folderName: folder?.name ?? null };
  });
}

/** File a pending suggestion. 'unavailable' says why nothing was filed (the suggestion is dropped). */
export async function acceptFiling(
  highlightId: string,
  port: FilingSessionPort = sessionPort(),
): Promise<FilingOutcome> {
  requireId(highlightId);
  const key = filingSuggestionKey(highlightId);
  const suggestion = await readRecord(port, key, FilingSuggestion);
  if (!suggestion) {
    return {
      status: 'unavailable',
      ruleName: '',
      reason: 'This suggestion is no longer available.',
    };
  }
  const applied = await applyPlacement(
    highlightId,
    { bankId: suggestion.bankId, folderId: suggestion.folderId, addTagIds: suggestion.addTagIds },
    Date.now(),
  );
  await port.remove(key);
  if (applied.status === 'unavailable') {
    return {
      status: 'unavailable',
      ruleName: suggestion.ruleName,
      reason: `Nothing was filed: ${applied.reason}.`,
    };
  }
  if (applied.status === 'unchanged') {
    // Moved there by hand since: nothing to do, and nothing to undo.
    const target = await describeTarget(suggestion.bankId, suggestion.folderId);
    if (!target) {
      return {
        status: 'unavailable',
        ruleName: suggestion.ruleName,
        reason: 'Its bank no longer exists.',
      };
    }
    return {
      status: 'filed',
      ruleName: suggestion.ruleName,
      bank: target.bank,
      folderName: target.folderName,
      addedTags: 0,
    };
  }
  await port.set({ [filingUndoKey(highlightId)]: applied.undo });
  return {
    status: 'filed',
    ruleName: suggestion.ruleName,
    bank: applied.bank,
    folderName: applied.folderName,
    addedTags: applied.addedTagIds.length,
  };
}

/** "Not now": forget a pending suggestion. Idempotent. */
export async function dismissFiling(
  highlightId: string,
  port: FilingSessionPort = sessionPort(),
): Promise<void> {
  await port.remove(filingSuggestionKey(requireId(highlightId)));
}

/**
 * Put a filed highlight back where it was: its earlier memberships (those whose bank still exists;
 * the Inbox when none does) and without the tags filing added. Only while it is still exactly where
 * filing put it: a highlight the person moved since is left alone and the reason is returned.
 */
export async function undoFiling(
  highlightId: string,
  port: FilingSessionPort = sessionPort(),
): Promise<{ restored: boolean; reason: string | null }> {
  requireId(highlightId);
  const key = filingUndoKey(highlightId);
  const record = await readRecord(port, key, FilingUndoRecord);
  if (!record) return { restored: false, reason: 'There is nothing to undo any more.' };

  const outcome = await withWritableDb((db) =>
    db.transaction('rw', [...MEMBERSHIP_TABLES(db), db.tags, db.highlightTags], async () => {
      try {
        await liveHighlight(db, highlightId);
      } catch {
        return 'The highlight no longer exists.';
      }
      const liveBanks = new Set((await readBanks(db)).map((b) => b.id));
      const current = (
        await db.highlightBanks.where('highlightId').equals(highlightId).toArray()
      ).filter((m) => liveBanks.has(m.bankId));
      const [only] = current;
      if (
        current.length !== 1 ||
        only?.bankId !== record.bankId ||
        (only.folderId ?? null) !== record.folderId
      ) {
        return 'It was moved again after it was filed, so nothing was changed.';
      }
      const ts = now();
      const back = record.previous.filter((m) => liveBanks.has(m.bankId));
      if (back.length === 0) {
        const inbox = await ensureInbox(db, ts);
        back.push({ bankId: inbox.id, folderId: null, addedAt: ts });
      }
      if (!back.some((m) => m.bankId === record.bankId)) {
        await db.highlightBanks.delete([highlightId, record.bankId]);
      }
      for (const m of back) {
        await db.highlightBanks.put({
          highlightId,
          bankId: m.bankId,
          folderId: m.folderId,
          addedAt: m.addedAt,
        });
      }
      await unlinkTags(db, [highlightId], record.addedTagIds, ts);
      await touchHighlights(db, [highlightId], ts);
      return null;
    }),
  );
  await port.remove(key).catch(() => undefined);
  if (outcome !== null) return { restored: false, reason: outcome };
  await signalChange();
  return { restored: true, reason: null };
}

/** Pending suggestions, oldest first. Expired and unreadable records are ignored. */
export async function listFilingSuggestions(
  port: FilingSessionPort = sessionPort(),
): Promise<FilingSuggestion[]> {
  const all = await port.get(null);
  const at = Date.now();
  return Object.entries(all)
    .filter(([key]) => key.startsWith(FILING_SUGGESTION_PREFIX))
    .map(([, value]) => {
      const parsed = FilingSuggestion.safeParse(value);
      return parsed.success && at - parsed.data.at <= FILING_SESSION_MAX_AGE_MS
        ? parsed.data
        : null;
    })
    .filter(notNull)
    .sort((a, b) => a.at - b.at);
}
