# ADR-016: Backups into a folder the person chose

**Status:** accepted · **Date:** 2026-10-11 · Extends the backup format of `packages/backup` (format
version 1 is unchanged) and ADR-010 section 1 (what "Delete all data" reaches). Builds on ADR-003
(least privilege) and ADR-005 (free text only in the extension origin).

## Context
A backup used to be one download: the person pressed "Create backup file" and the browser put the
file wherever downloads go. That is easy to forget, lands in one place, and gives no history. People
asked for the usual desktop behaviour: "back up to this folder", dated files, the last N kept, and a
clear "last backup" status.

Constraints, from the engineering contract (`CLAUDE.md`):

- local first, no account, no network, no new install-time permission;
- the vault database is the only authority for study data, and the backup file is the only thing
  that leaves it; secrets (`meta`) are never in a backup;
- a Manifest V3 worker has no durable state and no user gesture.

## Decision

### 1. The File System Access API, from an extension page, from a click
`window.showDirectoryPicker({ id: 'studyvault-backups', mode: 'readwrite' })` is called by the
Options page ("Backup and restore", panel "Back up to a folder"). Everything that writes
(`FileSystemFileHandle.createWritable`) also runs there, inside the click handler of "Back up now":
`requestPermission` needs a user gesture, and the worker never has one.

No `permissions` entry is added to the manifest. The file-system permission is **Chrome's own
per-folder grant**:

| | |
| --- | --- |
| What it is | "let this extension edit files in this folder", asked by Chrome when the person picks the folder |
| Scope | that one folder and what is inside it; nothing else on the disk |
| Given by | the person, in Chrome's folder dialog |
| Revoked by | Chrome's site settings for the extension, or "Stop using this folder" (which only forgets StudyVault's reference; Chrome's grant stays listed until removed there, and the panel says so) |
| Lifetime | Chrome may ask again after a restart; the panel then asks again from the next click (`ensureFolderPermission`), and a "no" changes nothing |
| Manifest | nothing (`scripts/check-build.mjs` still pins `permissions`, `optional_permissions` and `host_permissions`) |

Where `showDirectoryPicker` does not exist (Firefox, Safari, an embedded browser) the panel says so
and the ordinary download flow, which is untouched, remains the way to back up. Feature detection is
`typeof window.showDirectoryPicker === 'function'`; there is no user-agent sniffing.

### 2. Where the handle lives
The handle is stored in the IndexedDB `meta` table of the vault database, under two keys:
`backupFolder.handle` (the `FileSystemDirectoryHandle`, a structured-cloneable reference) and
`backupFolder.state` (folder name, the two preferences, the last backup; validated with Zod on
every read, a damaged row reads as "no folder"). `packages/storage/src/backupFolder.ts`.

- `meta` is in `BACKUP_EXCLUDED_TABLES`, so the handle and the status are in no backup, are not
  restored (a replace restore does not touch them) and cannot reach another device through a file.
- It is not synced: `meta` has no sync policy, and the handle means nothing on another computer.
- "Delete all data" deletes the database, so both rows go with it (`wipeAllData`, ADR-010 section
  1); the open panel follows through the data epoch without a reload. Files already written to the
  folder are the person's and are never touched by any StudyVault delete.
- No new Dexie version: `meta` is an untyped key-value table, so no migration is needed; the
  backup registry and the sync policy are unchanged on purpose (that is what "not in backups, not
  synced" means). Tests pin it: `packages/storage/src/backupFolder.test.ts`.

### 3. Names and ownership
Files are named `studyvault-YYYYMMDD-HHMMSS.zip` (`.svbackup` when encrypted; the same UTC stamp as
the manual export's `studyvault-backup-...`, so the two never collide). A name that is taken gets a
`-2`, `-3` suffix: **an existing file is never replaced**.

A file is "ours" only when both hold:

1. the name matches `^studyvault-\d{8}-\d{6}(-\d+)?\.(zip|svbackup)$`, and
2. it carries the marker `origin: "backup-folder"`: a new optional member of the manifest (inside
   the checksum) and, for an encrypted file, of the plain-text, authenticated header of the
   container, so ownership can be read without the passphrase.

`Manifest.origin` is additive and optional. `formatVersion` stays 1: older builds ignore the member
(the schema strips unknown keys, the checksum is computed over the raw object) and still restore the
file. Reading the marker never loads a backup: `hasFolderMarker` does three small ranged reads (end
record, central directory, manifest entry).

### 4. Writing, checking, pruning (`packages/backup/src/folder.ts`)
1. Pick a free name; create the file; write; `close()` (Chrome replaces the file atomically).
2. **Check**: read the file back and compare it with the bytes that were written, chunk by chunk
   (size first, then every byte). That subsumes "size, ZIP signature and manifest checksum", and
   needs no extra memory. A file that fails is removed again and `folder_verify_failed` is shown.
3. **Prune** only after the check passed: list the folder, keep the newest `keepLast` of our own
   files (the new one is always kept), delete the rest. Anything else (other names, look-alikes
   without the marker, directories, unreadable files) is never opened for writing or deleted.
   A file that cannot be removed is reported by name; the new backup stands.

A failed write removes only the empty file this run created; older backups are never pruned by a
failed run.

### 5. Failures are typed and tell the person what to do
New `BackupError` codes (no data is ever changed by any of them): `folder_permission` (ask again:
"Allow and try again"), `folder_missing` (moved, renamed, drive gone: "Choose a folder"),
`disk_full` (`QuotaExceededError` or a "no space" message), `folder_write_failed`,
`folder_verify_failed`. `folderError` maps DOMExceptions across realms by name, not by `instanceof`.

### 6. The reminder is a notice, not a job
Chrome gives a page access to the folder only while a gesture is handled, so **StudyVault cannot
back up in the background**, and no alarm, worker path or "automatic backup" exists or is claimed.
Instead the person picks an interval (off, 1, 3, 7, 14 or 30 days; default 7) and
`BackupReminder` shows a notice on the dashboard and the settings page when the last backup to
this folder (or the day the folder was chosen, when there is none) is older. The text says that
nothing is written by itself. Only backups made to the folder count: a manual download is not
recorded, and the notice says "to this folder".

### 7. What the person sees
`packages/ui/src/backup/BackupFolder.tsx`: folder name (Chrome shares only the name, and the panel
says why no path is shown), "Last backup" with age, file name, size, SHA-256 and "read back and
checked", the two preferences, optional passphrase (same component and rules as the manual
export; it is not stored), optional cached PDFs, real progress, the permission explanation, and
"Choose another folder" / "Stop using this folder".

## Alternatives rejected
- **`chrome.downloads`**: needs the `downloads` permission, cannot choose a folder per call, cannot
  list, verify or prune.
- **A worker or alarm writing the backup**: no handle without a gesture; would need a hosted or
  native component; would promise something that cannot be kept.
- **OPFS as the destination**: not visible to the person, removed with the extension's data.
- **Cloud drives through their APIs**: accounts and network; out of scope (a folder that a
  cloud-drive app syncs works today, and the panel suggests encrypting in that case).
- **Replacing a file of the same name**: a collision would destroy a backup; a suffix costs nothing.

## Consequences
- One more panel in the settings page; code is split so the dashboard only loads
  `BackupReminder` (storage read plus one notice), and the Options chunk carries the rest.
- The e2e suite stubs the picker with an OPFS directory (`tests/e2e/backup-folder.spec.ts`); the
  real permission prompt on a real disk stays a manual check (MT list).
- If Chrome stops structured-cloning handles into IndexedDB, the panel degrades to "choose a
  folder again"; nothing else depends on the stored handle.

## Tests
`packages/backup/src/folder.test.ts` (marker, names, write, verify, prune, collisions, full drive,
corrupted write, permission), `packages/storage/src/backupFolder.test.ts` (state, validation, never
in a backup, survives a restore, removed by Delete all data), `packages/ui/src/backup/backupFolder.test.tsx`
(panel, failures, preferences, reminder, real wiring), `tests/e2e/backup-folder.spec.ts` (loaded
extension: write, check, prune, encrypted, failures, reminder, unsupported, Delete all data,
restore through the wizard).
