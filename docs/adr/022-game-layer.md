# ADR-022: Game layer storage - a derived local ledger plus synced facts

**Status:** proposed · **Date:** 2026-10-14 · Implements the game rules of ADR-021 and
`UX_DESIGN.md` section 11. Extends ADR-011 (schema bump pattern) and ADR-010 (no RPC for storage).
The full engineering spec (algorithms, API, file plan, tests) is kept with this ADR's pull request.

## Context
ADR-021 fixed the game UX: daily goal 10/30/50/100 (30 until chosen), rating-neutral XP (review 1,
save 2, card 3, finished session +5), levels, a goal-based streak with automatic freezes (one per 7
streak days, at most 2), badges, celebrations, and a Game mode switch. ADR-021 left the storage
decision to this ADR. The owner requires the game state to be stored in the versioned database,
backfilled from existing history, in backups, and synced only when sync is on.

These facts of the codebase shape the decision:
- Purging a highlight hard-deletes its cards and their review logs (`packages/storage/src/trash.ts`
  `purgeInTx`). If XP were computed from those rows alone, it would go down after a purge.
- Awaiting a non-IndexedDB promise inside a transaction commits it early, so a Dexie upgrade cannot
  read `studySettings` from chrome.storage.
- The study session is device-local and has no durable "completed" record. An undo stamps
  `userCorrection` on an append-only review log. Sync quarantines that local change, so the undo
  never reaches other devices.
- Settings and `studySettings` are neither backed up nor synced (ADR-010).
- The sync outbox holds at most 20,000 pending operations. An older build quarantines unknown
  entity types and re-pulls everything after 1,000 quarantined operations.

## Decision
1. **Dexie v5 adds two append-only tables.** No existing table or index changes.
   - `gameEvents` (`id, at, schemaVersion`) holds one row per XP-earning source row:
     `rv_<logId>`, `hs_<highlightId>`, `cd_<cardId>`. Each row is a pure function of its source row,
     and its `at` is the source row's own timestamp. The table is backed up but not synced: every
     device derives the same rows from synced source rows.
   - `gameFacts` (`id, at, [kind+at], schemaVersion`) holds what cannot be re-derived:
     - review undo `ru_<logId>` and save undo `hu_<highlightId>`, and the card cancel `cu_<cardId>`
       (with `ru_`/`hu_`, written by a merge restore for the rows it adds, so a merge earns nothing);
     - the session bonus `sb_<sessionId>`;
     - goal `gs_<uuid>`, Game mode `gm_<uuid>` and game start `gx_<uuid>`;
     - a copy of any `gameEvents` row whose source a purge (or a remote delete) removes; the purge
       derives the rows first, so a purge that runs before the backfill keeps its XP.

     `gameFacts` is backed up, and it is synced (append-only) when sync is on.
2. **Rows are only ever added.** An undo is a cancelling fact, never an edit. A row's id and content
   are deterministic wherever two devices could write it, so a retry, the backfill, the sync
   applier and a restore are all idempotent, and the same row never conflicts.
3. **Nothing derived is stored.** XP, level, streak, freezes, badges and celebrations are computed
   by replaying the two tables with the device's study-day boundary. A per-day rollup of closed days
   is cached in device-local `meta['game.cache']` and checked against a row count. The cache is
   disposable.
4. **Writes are recorded in the same transaction as the action.** Hooks go in `reviewCard`,
   `undoLastReview`, the card creators, `acceptAiItem`, `saveCapture`, `savePdfHighlight`, the
   highlight soft-delete paths (undo within 10 minutes), the sync applier and purge. A new
   `completeStudySession` replaces `clearStudySession` at the end of a review session.
5. **The upgrade only moves the marker.** The backfill is a separate job that runs after the
   database opens. It is resumable (it checkpoints every 1,000 rows), idempotent, runs under a Web
   Lock, and reports real progress. Until it finishes, the UI shows progress and no game numbers.
6. **Rule choices** (UX_DESIGN.md section 11; owner-approved):
   - XP for a level: `25·L·(L−1)`.
   - A goal change applies from the current study day.
   - Before the game started on this vault, any day with XP counts toward the streak. From then
     on, a day counts only when it meets that day's goal.
   - Freezes are earned and used across the whole history.
   - No XP for imports, duplicates, Trash restores or merge restores.
   - A synced row brings the event its own device earned; it is never counted twice.
   - Game mode off hides the game. Recording continues.
7. **Celebrations happen once per device.** A milestone is celebrated only on the study day it
   happened and only after this device's baseline. Pages claim it in a read-write `meta`
   transaction.

## Consequences
- **Upgrade and backfill.** The v5 upgrade cannot fail on a large vault. The backfill of about 100k
  reviews runs once, in the background. Session bonuses, undos and goals from before the update
  cannot be derived and are not invented.
- **Undo across devices.** Undo reaches every device's XP through `ru_`. The underlying sync defect
  stays: other devices' queues and analytics still count an undone review. That fix belongs to
  sync.
- **Sync load.** Sync carries only a few game operations a day. Each device's ledger is as complete
  as the source rows it has seen, plus the purge copies in `gameFacts`.
- **Every new create path must add its event.** A test helper checks that the ledger is complete
  after each create path. Changing a derivation rule bumps `GAME_RULES_VERSION`, which re-runs the
  backfill. Rules that remove XP are applied in the replay instead.
- **Boundary changes.** Changing the study-day boundary re-buckets history, the same as Analytics.
- **Clock changes.** A clock set back can move goals or XP into past days. This only fools the user
  and is accepted.
- **Backup and restore.**
  - `BACKUP_MIGRATIONS` gains `{ from: 4 }`.
  - A replace restore clears the game tables (when the archive lacks them) and resets the backfill
    marker, so XP is re-derived from the archive.
  - A merge restore takes the union of the archive's game rows and derives nothing.
- **Older builds.** A device still on an older build quarantines `gameFacts` operations. After an
  update, the worker retries the quarantine.

## Alternatives rejected
- **One synced event table** (the judged winner as written). It doubles sync operations. An older
  build would loop on re-pulls past 1,000 quarantined operations, and every device would upload
  identical backfilled rows on reconcile.
- **Pure derivation from existing rows**, with fossils for purges. Its cache fingerprint is
  invalidated by every undo, ack and session, which forces cold rebuilds. A purge by an older build
  would lose XP for good.
- **A daily counter table maintained by an always-on write interceptor.** It is order-dependent and
  cannot be rebuilt. Merging backups overwrites counts. A game bug could abort every save and
  review.
- **Goal and Game mode in `Settings`.** Settings are not backed up or synced (ADR-010).
- **Synced celebration acks** (once per person): this needs extra synced rows for a rare
  double-show. Possible later.
- **A daily cap on session bonuses** and **next-day goal changes**: these are not in the
  owner-approved rules.
