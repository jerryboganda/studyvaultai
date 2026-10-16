import { uuidv7 } from 'uuidv7';
import { revokeAllSiteAccess } from '@runtime';
import { browser } from 'wxt/browser';
import {
  Bank,
  CaptureInput,
  COLOR_IDS,
  Highlight,
  HighlightPatch,
  MAX_QUOTE_CHARS,
  MAX_URL_CHARS,
  ResolutionReport,
  SCHEMA_VERSION,
  Source,
  StudyVaultError,
  redactUrl,
  sourceKeys,
  trustedCanonical,
  type BankLite,
  type BankRecord,
  type CaptureResult,
  type HighlightView,
} from '@shared';
import { saveEvent } from '@study/game';
import {
  addMembership,
  allTables,
  cmp,
  ensureInbox,
  isDeleted,
  isPrimary,
  liveHighlight,
  liveHighlightsOf,
  matchSources,
  now,
  parseInput,
  parseRow,
  readBanks,
  requireId,
  keysWhereIn,
  resolveTargetBank,
  samePlace,
  signalChange,
  signalResolution,
  toItems,
  toLite,
  toViews,
} from './core';
import { clearRestoreStaging, deletePreMigrationSnapshot } from './backupTarget';
import { WipePendingError, deleteDatabase, withDb, withWritableDb } from './db';
import { addMissing, revokeQuickSave } from './game';
import { normalizeQuote, quoteHash } from './normalize';
import type { BankWithCount, HighlightListItem, RepoApi } from './types';

// ---------------------------------------------------------------------------------------------
// RepoApi (Phase 1 contract). Shared helpers live in ./core.
// ---------------------------------------------------------------------------------------------

export async function saveCapture(input: CaptureInput): Promise<CaptureResult> {
  const capture = parseInput(CaptureInput, input, 'capture');
  const keys = sourceKeys(capture.page.url, capture.page.canonicalUrl);
  // The stored address has no credentials: presigned-URL signatures, OAuth tokens and fragments are
  // not provenance, and a rotating token must not fork one page into many sources.
  const originalUrl = redactUrl(capture.page.url);
  // Normalisation can lengthen a URL (percent-encoding); a record we could not read back is worse
  // than a refused capture.
  if (
    !keys ||
    originalUrl === null ||
    keys.urlKey.length > MAX_URL_CHARS ||
    keys.visitedKey.length > MAX_URL_CHARS ||
    originalUrl.length > MAX_URL_CHARS
  ) {
    throw new StudyVaultError('invalid_request', 'Page URL cannot be stored as a source');
  }
  const canonicalUrl = trustedCanonical(capture.page.url, capture.page.canonicalUrl);
  const normalized = normalizeQuote(capture.exactQuote);
  if (normalized === '') throw new StudyVaultError('invalid_request', 'Quote is empty');
  // Hash before the transaction: awaiting crypto.subtle inside would let IndexedDB auto-commit it.
  const hash = await quoteHash(normalized);

  const { result, changed } = await withWritableDb((db) =>
    // `allTables` itself stays as it is: update and delete use it too.
    db.transaction('rw', [...allTables(db), db.gameEvents], async () => {
      // Stamp once this transaction holds its lock (a request resolves only then): a capture that
      // waited behind a restore must not carry a time from before the wait, or the search catch-up,
      // which looks for rows changed since a moment it has already passed, would never see it.
      await db.banks.count();
      const ts = now();
      const bank = await resolveTargetBank(db, capture.bankId, ts);
      const sources = await matchSources(db, keys);

      const same: Highlight[] = [];
      for (const source of sources) {
        const rows = await db.highlights
          .where('[sourceId+quoteHash]')
          .equals([source.id, hash])
          .toArray();
        for (const row of rows) {
          const parsed = parseRow(Highlight, row, 'highlight');
          if (parsed && samePlace(parsed.anchorSet, capture.anchorSet)) same.push(parsed);
        }
      }
      same.sort((a, b) => cmp(a.capturedAt, b.capturedAt) || cmp(a.id, b.id));
      const live = same.find((h) => h.deletedAt === null);
      const deleted = live
        ? undefined
        : same.sort((a, b) => cmp(b.deletedAt ?? '', a.deletedAt ?? ''))[0];

      let highlight: Highlight;
      let status: CaptureResult['status'];
      let addedToBank: boolean;

      if (live) {
        highlight = live;
        status = 'duplicate';
        addedToBank = await addMembership(db, live.id, bank.id, ts);
      } else if (deleted) {
        highlight = { ...deleted, deletedAt: null, updatedAt: ts };
        status = 'restored';
        await db.highlights.update(deleted.id, { deletedAt: null, updatedAt: ts });
        await db.sources.update(deleted.sourceId, { updatedAt: ts });
        addedToBank = await addMembership(db, deleted.id, bank.id, ts);
      } else {
        let source = sources.find((s) => isPrimary(s, keys));
        if (source) {
          // Provenance stays as first seen; only an empty title may be filled in.
          const title = source.title === '' ? capture.page.title : source.title;
          await db.sources.update(source.id, { updatedAt: ts, title });
        } else {
          source = {
            id: uuidv7(),
            schemaVersion: SCHEMA_VERSION,
            createdAt: ts,
            updatedAt: ts,
            deletedAt: null,
            type: 'web',
            urlKey: keys.urlKey,
            visitedKey: keys.visitedKey,
            originalUrl,
            canonicalUrl,
            host: new URL(capture.page.url).hostname,
            title: capture.page.title,
          };
          await db.sources.put(source);
        }
        highlight = {
          id: uuidv7(),
          schemaVersion: SCHEMA_VERSION,
          createdAt: ts,
          updatedAt: ts,
          deletedAt: null,
          sourceId: source.id,
          exactQuote: capture.exactQuote,
          // The hash covers the full normalised text; the stored copy only has to fit the schema.
          normalizedQuote: normalized.slice(0, MAX_QUOTE_CHARS),
          quoteHash: hash,
          anchorSet: capture.anchorSet,
          kind: capture.kind,
          color: capture.color,
          priority: capture.priority,
          userComment: capture.userComment,
          headingContext: capture.headingContext,
          captureMethod: capture.captureMethod,
          capturedAt: ts,
          resolveStatus: 'unchecked',
          resolveConfidence: null,
          lastResolvedAt: null,
          capturedUrl: originalUrl,
          capturedTitle: capture.page.title,
        };
        await db.highlights.put(highlight);
        const event = saveEvent(highlight);
        if (event) await addMissing(db.gameEvents, [event]);
        await db.highlightBanks.put({
          highlightId: highlight.id,
          bankId: bank.id,
          folderId: null,
          addedAt: ts,
        });
        status = 'created';
        addedToBank = true;
      }

      const [view] = await toViews(db, [highlight]);
      return {
        result: { status, highlight: view!, bank: toLite(bank), addedToBank },
        changed: status !== 'duplicate' || addedToBank,
      };
    }),
  );
  if (changed) await signalChange();
  return result;
}

export async function getPageHighlights(
  url: string,
  canonicalUrl: string | null,
): Promise<{ sourceId: string | null; highlights: HighlightView[] }> {
  const keys = sourceKeys(url, canonicalUrl);
  if (!keys) return { sourceId: null, highlights: [] };
  return withDb((db) =>
    db.transaction('r', allTables(db), async () => {
      const sources = await matchSources(db, keys);
      const rows = await liveHighlightsOf(
        db,
        sources.map((s) => s.id),
      );
      return { sourceId: sources[0]?.id ?? null, highlights: await toViews(db, rows) };
    }),
  );
}

export async function updateHighlight(id: string, patch: HighlightPatch): Promise<HighlightView> {
  requireId(id);
  const parsed = parseInput(HighlightPatch, patch, 'highlight patch');
  const changes = Object.fromEntries(
    Object.entries(parsed).filter(([, value]) => value !== undefined),
  ) as HighlightPatch;
  const { view, changed } = await withWritableDb((db) =>
    db.transaction('rw', allTables(db), async () => {
      const row = await liveHighlight(db, id);
      const differs = (Object.keys(changes) as Array<keyof HighlightPatch>).some(
        (key) => row[key] !== changes[key],
      );
      if (!differs) return { view: (await toViews(db, [row]))[0]!, changed: false };
      const next = { ...row, ...changes, updatedAt: now() };
      await db.highlights.update(id, { ...changes, updatedAt: next.updatedAt });
      return { view: (await toViews(db, [next]))[0]!, changed: true };
    }),
  );
  if (changed) await signalChange();
  return view;
}

export async function softDeleteHighlight(id: string): Promise<void> {
  requireId(id);
  const changed = await withWritableDb((db) =>
    db.transaction('rw', [db.highlights, db.gameFacts], async () => {
      const row = await db.highlights.get(id);
      if (!row) throw new StudyVaultError('not_found', 'Highlight not found');
      if (isDeleted(row)) return false;
      const ts = now();
      await db.highlights.update(id, { deletedAt: ts, updatedAt: ts });
      await revokeQuickSave(db, row, ts); // the save toast's undo takes its XP back
      return true;
    }),
  );
  if (changed) await signalChange();
}

export async function restoreHighlight(id: string): Promise<HighlightView> {
  requireId(id);
  const { view, changed } = await withWritableDb((db) =>
    db.transaction('rw', allTables(db), async () => {
      const stored = await db.highlights.get(id);
      const row = stored ? parseRow(Highlight, stored, 'highlight') : null;
      if (!row) throw new StudyVaultError('not_found', 'Highlight not found');
      if (row.deletedAt === null) return { view: (await toViews(db, [row]))[0]!, changed: false };
      const restored = { ...row, deletedAt: null, updatedAt: now() };
      await db.highlights.update(id, { deletedAt: null, updatedAt: restored.updatedAt });
      return { view: (await toViews(db, [restored]))[0]!, changed: true };
    }),
  );
  if (changed) await signalChange();
  return view;
}

export async function reportResolutions(
  items: Array<{ id: string; status: Highlight['resolveStatus']; confidence: number | null }>,
): Promise<number> {
  const reports = new Map<string, (typeof items)[number]>();
  for (const item of items) {
    reports.set(item.id, parseInput(ResolutionReport, item, 'resolution report'));
  }
  if (reports.size === 0) return 0;
  const { updated, changed } = await withWritableDb((db) =>
    db.transaction('rw', db.highlights, async () => {
      const ts = now();
      let updated = 0;
      let changed = false;
      for (const [id, report] of reports) {
        const row = await db.highlights.get(id);
        if (!row || isDeleted(row)) continue;
        await db.highlights.update(id, {
          resolveStatus: report.status,
          resolveConfidence: report.confidence,
          lastResolvedAt: ts,
        });
        updated++;
        if (row.resolveStatus !== report.status || row.resolveConfidence !== report.confidence) {
          changed = true;
        }
      }
      return { updated, changed };
    }),
  );
  // Only a real outcome change notifies, and only on the resolution channel: the page that
  // produced these outcomes already knows them, so content scripts are not woken to refetch and
  // repaint (and re-report). Panels watch this channel to refresh their badges.
  if (changed) await signalResolution();
  return updated;
}

export async function getHighlightSource(
  id: string,
  options: { includeDeleted?: boolean } = {},
): Promise<{ sourceId: string; urlKey: string; visitedKey: string } | null> {
  requireId(id);
  return withDb(async (db) => {
    const row = await db.highlights.get(id);
    if (!row || (isDeleted(row) && options.includeDeleted !== true)) return null;
    const stored = await db.sources.get(row.sourceId);
    const source = stored ? parseRow(Source, stored, 'source') : null;
    return source
      ? { sourceId: source.id, urlKey: source.urlKey, visitedKey: source.visitedKey }
      : null;
  });
}

export async function listBanks(): Promise<BankLite[]> {
  return withDb(async (db) => (await readBanks(db)).map(toLite));
}

export async function createBank(name: string): Promise<BankLite> {
  const bankName = parseInput(Bank.shape.name, name, 'bank name');
  const bank = await withWritableDb((db) =>
    db.transaction('rw', db.banks, async () => {
      const ts = now();
      await ensureInbox(db, ts);
      // Highest position among rows that can be read, so a corrupt row (a position that is not a
      // number sorts last in IndexedDB) cannot make us write a bank that fails validation.
      const top = Math.max(0, ...(await readBanks(db)).map((b) => b.position));
      const position = Math.floor(top) + 1;
      const row: BankRecord = {
        id: uuidv7(),
        schemaVersion: SCHEMA_VERSION,
        createdAt: ts,
        updatedAt: ts,
        deletedAt: null,
        name: bankName,
        color: COLOR_IDS[(position - 1) % COLOR_IDS.length]!,
        position,
        isInbox: false,
      };
      await db.banks.put(row);
      return row;
    }),
  );
  await signalChange();
  return toLite(bank);
}

export async function listRecentHighlights(limit: number): Promise<HighlightListItem[]> {
  if (!Number.isFinite(limit) || limit < 0) {
    throw new StudyVaultError('invalid_request', 'limit must be a non-negative number');
  }
  const max = Math.floor(limit);
  if (max === 0) return [];
  return withDb((db) =>
    db.transaction('r', allTables(db), async () => {
      const rows: Highlight[] = [];
      await db.highlights
        .orderBy('capturedAt')
        .reverse()
        .until(() => rows.length >= max)
        .each((row) => {
          if (isDeleted(row)) return;
          const parsed = parseRow(Highlight, row, 'highlight');
          if (parsed) rows.push(parsed);
        });
      return toItems(db, rows);
    }),
  );
}

export async function listPageHighlights(
  url: string,
  canonicalUrl: string | null,
): Promise<HighlightListItem[]> {
  const keys = sourceKeys(url, canonicalUrl);
  if (!keys) return [];
  return withDb((db) =>
    db.transaction('r', allTables(db), async () => {
      const sources = await matchSources(db, keys);
      return toItems(
        db,
        await liveHighlightsOf(
          db,
          sources.map((s) => s.id),
        ),
      );
    }),
  );
}

export async function listBanksWithCounts(): Promise<BankWithCount[]> {
  return withDb((db) =>
    db.transaction('r', [db.banks, db.highlights, db.highlightBanks], async () => {
      const banks = await readBanks(db);
      // Index counts (no row is deserialised: a corrupt row that a list would skip still counts),
      // minus the memberships of the few highlights that are in the trash.
      const trashed = (await db.highlights.where('deletedAt').above('').primaryKeys()) as string[];
      // Keys only: a membership's primary key is [highlightId, bankId].
      const gone = (await keysWhereIn(db.highlightBanks, 'highlightId', trashed)) as Array<
        [string, string]
      >;
      // Counted once per bank, not by filtering every trashed membership for every bank.
      const trashedIn = new Map<string, number>();
      for (const [, bankId] of gone) trashedIn.set(bankId, (trashedIn.get(bankId) ?? 0) + 1);
      const out: BankWithCount[] = [];
      for (const bank of banks) {
        const all = await db.highlightBanks.where('bankId').equals(bank.id).count();
        out.push({ bank: toLite(bank), count: Math.max(0, all - (trashedIn.get(bank.id) ?? 0)) });
      }
      return out;
    }),
  );
}

/**
 * Where "Delete all data" is:
 *  - `deleting`: the database delete was requested (normally over within a moment);
 *  - `blocked`: another StudyVault window still holds the database. The request stays queued and the
 *    wipe continues by itself the moment that window is closed;
 *  - `cleaning`: the database is gone; the pre-update copy, restore staging, settings and site
 *    access are being removed.
 */
export type WipeState = 'deleting' | 'blocked' | 'cleaning';

export interface WipeOptions {
  /** Called at once with the current state and again at every change. */
  onState?: (state: WipeState) => void;
  /**
   * Stop waiting. The wipe itself cannot be taken back: the delete is already queued in IndexedDB.
   * This call rejects with `WipePendingError`; the wipe goes on and finishes by itself.
   */
  signal?: AbortSignal;
}

interface WipeRun {
  state: WipeState;
  done: Promise<void>;
  watchers: Set<(state: WipeState) => void>;
}
let wipeRun: WipeRun | null = null;

/** The wipe that is running in this context, if any (for a view that mounts while it runs). */
export const getWipeState = (): WipeState | null => wipeRun?.state ?? null;

async function runWipe(set: (state: WipeState) => void): Promise<void> {
  // The database first, and without a deadline. An IndexedDB delete cannot be withdrawn once it is
  // requested: giving up on it would leave it queued, and it would still run later, after the
  // pre-update copy, the settings and the site access had been left in place. So the other stores
  // come last, after the delete has really completed. Deleting the database drops every table of
  // every schema version (vault, study, ai, sync, PDF bytes and OCR text included); the next use
  // recreates it empty.
  await deleteDatabase(() => set('blocked'));
  set('cleaning');
  // Two more full copies of the vault live in databases of their own: the automatic pre-update
  // archive and the staging area of a restore that crashed. "Delete all" must reach both.
  await Promise.all([deletePreMigrationSnapshot(), clearRestoreStaging()]);
  await browser.storage.local.clear();
  await browser.storage.session?.clear();
  // Optional host permissions are part of what StudyVault holds: left granted, the worker would
  // register the persistent script again from Chrome's grants. Best effort (no permissions API in
  // some test and embedded contexts).
  await revokeAllSiteAccess().catch((err: unknown) =>
    console.warn('[StudyVault] could not revoke site access', err),
  );
  // Search indexes that are open still hold the deleted text in memory and would write it into the
  // new database on their next flush: a fresh generation in the marker they watch (SearchHost,
  // `searchIndexStale`) makes each drop it. After the storage clear, so the connection gate of the
  // recreated database sees no settings.
  await withWritableDb(async (db) => {
    await db.meta.put({ key: 'searchIndexStale', value: uuidv7(), updatedAt: now() });
  }).catch((err: unknown) =>
    console.warn('[StudyVault] could not mark the search index stale', err),
  );
  // Settings are gone and the database is empty: viewers must drop what they are showing.
  await signalChange();
}

const STOPPED_WAITING =
  'Deleting is not finished. It cannot be cancelled once started: it finishes by itself as soon as every other StudyVault window is closed, and StudyVault cannot read or save in this window until then.';

/**
 * Delete everything StudyVault holds on this device. One wipe runs at a time per context: a second
 * call joins it. See `WipeState` and `WipeOptions`; `WipePendingError` is what a caller that stopped
 * waiting gets, and what every other database call gets while the delete is still queued.
 */
export function wipeAllData(options: WipeOptions = {}): Promise<void> {
  const { onState, signal } = options;
  if (signal?.aborted) return Promise.reject(signal.reason);
  if (!wipeRun) {
    const run: WipeRun = { state: 'deleting', done: Promise.resolve(), watchers: new Set() };
    const set = (state: WipeState) => {
      run.state = state;
      for (const watcher of [...run.watchers]) watcher(state);
    };
    run.done = runWipe(set).finally(() => {
      if (wipeRun === run) wipeRun = null;
    });
    // Someone may have stopped waiting: the run still ends, and must not be an unhandled rejection.
    run.done.catch(() => undefined);
    wipeRun = run;
  }
  const run = wipeRun;
  if (onState) {
    run.watchers.add(onState);
    onState(run.state);
  }
  const detach = () => {
    if (onState) run.watchers.delete(onState);
  };
  if (!signal) return run.done.finally(detach);
  return new Promise<void>((resolve, reject) => {
    const stop = () => {
      detach();
      reject(new WipePendingError(STOPPED_WAITING));
    };
    signal.addEventListener('abort', stop, { once: true });
    run.done.then(resolve, reject).finally(() => {
      detach();
      signal.removeEventListener('abort', stop);
    });
  });
}

/** Compile-time proof that every RepoApi member is implemented with the exact signature. */
export const repo = {
  saveCapture,
  getPageHighlights,
  updateHighlight,
  softDeleteHighlight,
  restoreHighlight,
  reportResolutions,
  getHighlightSource,
  listBanks,
  createBank,
  listRecentHighlights,
  listPageHighlights,
  listBanksWithCounts,
  wipeAllData,
} satisfies RepoApi;
