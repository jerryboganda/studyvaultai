# ADR-017: Auto-filing rules

**Status:** accepted · **Date:** 2026-10-11 · Builds on ADR-011 (the `filingRules` table and its
repository), ADR-010 (module seams) and ADR-005 (free text only in extension origins). Product text:
PRD "smart auto-filing that requires confirmation".

## Context
ADR-011 gave rules persistence (`createFilingRule`, `listApplicableFilingRules`, `matchFilingRules`,
`planFiling`, ...) and said "storage never files anything". Nothing used them. A rule is useful only if
the person can make one, see what it would do, and have it act when a highlight is saved, without
the product ever moving a highlight somewhere they did not choose.

## Decisions

### 1. One decision function, shared (`decideFiling`, `@shared/filing.ts`)
The worker (at capture) and the "Test a rule" panel call the same pure function, so they cannot
disagree:

- the first matching enabled rule (rank order) decides bank and folder; tags are the union over every
  matching usable rule; the plan asks when **any** matching rule asks (`planFiling`);
- when the first matching rule points at a bank, folder or added tag that is gone the result is
  `blocked`: nothing is filed, the person is told, and a lower rule is **not** silently promoted. A
  broken rule that is not first is skipped;
- a PDF candidate is offered only to rules that list `pdf` in `sourceTypes`. A rule with no source
  condition is written with web pages in mind and never files a reader highlight. (`filingMatchApplies`
  is unchanged: an absent field is still "any".)

### 2. Where rules run: after a capture created a highlight, nowhere else
`capture.save` (worker) calls `FilingPort.afterCapture` after `saveCapture` committed and after
`lastBankId` was stored, only when `status === 'created'` and `Settings.useFilingRules` is on. A
duplicate, a restored highlight, an import, a restore from a backup and a sync apply never reach it:
those paths do not call it. The reader's `createStorageStore().savePdfHighlight` makes the same call
for a new reader highlight (`sourceType: 'pdf'`). The save result carries the answer as the optional
`CaptureResult.filing`; the step never throws (a failure is logged and means "no filing") and its
read-only planning part is abandoned after 2 s (`FILING_PLAN_BUDGET_MS`), so it can neither lose nor
noticeably delay a save.

A capture that **names a bank** other than the one a one-click save would have used (the last-used
bank while it exists, else the Inbox) is an explicit choice, and a rule never overrides it
(`isDefaultBankChoice`). Private windows follow the existing rule: `capture.save` is refused there
unless `allowIncognitoCapture` is on, so rules only run where capture is allowed; `filing.accept`
applies the same check.

### 3. What filing does (`packages/storage/src/filing.ts`)
`applyPlacement` runs in **one** transaction over banks, folders, memberships, highlights, tags and tag
links. It re-checks that the bank, folder (and that it belongs to the bank) and highlight are live,
leaves the highlight in the plan's bank/folder and in no other live bank (memberships to deleted banks
are left alone, as `deleteBank` does), links the tags that exist and are new, and bumps the
highlight's `updatedAt` so search and sync see the change. The source row, the quote, the anchor and
every provenance field are not written. A placement that changes nothing is "unchanged": no toast,
no record.

- A rule that **asks** (`requireConfirm`, the default) stores a *suggestion* and changes nothing.
- A rule that **does not ask** files at once and stores an *undo record*.
- A rule whose target is gone: the highlight stays in the bank the capture put it in (the Inbox when
  no last-used bank applies), the save result says why (`filing.status = 'unavailable'`), nothing is
  written. This is the "deleted target bank falls back to the Inbox, with a notice" requirement: a
  highlight is never moved *to* the Inbox by a rule, because it is already where a capture without a
  rule would have put it.

### 4. Suggestion and undo live in `chrome.storage.session`
Both are small records keyed by highlight id (`sv.filing.suggest.<id>`, `sv.filing.undo.<id>`, shapes
in `@shared/filingSession.ts`). Session storage survives the worker being suspended (nothing is held
in worker memory), is cleared when the browser closes, is never synced, backed up or written to the
database, and is already cleared by "Delete all data". Records older than 24 h are ignored and
removed; at most 100 of each kind are kept.

The page never names a bank. The content script holds only the highlight id: `filing.accept`,
`filing.dismiss` and `filing.undo` (BackgroundRpc) take `{ highlightId }`, the worker reads the
placement from its own record, and a page may act only on a highlight of its own site (the same
`authorize` as `highlight.*`). Extension pages (side panel, PDF reader) call the same `@storage`
functions directly.

**Undo** puts the highlight back on the memberships it had (those whose bank still exists; the Inbox
when none does) and removes only the tags that filing linked. It acts only while the highlight is
still exactly where filing put it: one that was moved again is left alone and the reason is shown.

### 5. The setting
`Settings.useFilingRules` (default `true`). With no rule nothing is filed, so "on" is harmless and
the first rule works at once; "off" keeps the rules and consults none. The switch is in the rules
manager and in Settings > Capture (with a button that opens the manager).

### 6. Screens
- **Manager** (dashboard view `rules`, `dashboard.html?view=rules`, palette command "Show the filing
  rules", button in Settings > Capture): rules in the order they are tried; Move up / Move down
  buttons and Alt+Up / Alt+Down on the row (focus stays on the control); an "On" switch per rule
  (written with `expectedVersion`; a rule changed elsewhere is not overwritten); Edit; Duplicate (the
  copy is created **off**, right after the original, and opens for editing); Delete without a prompt,
  with Undo (soft delete, then restored to its old position); problems of a rule written out in its
  row (`checkFilingRules`).
- **Dialog**: name; chip fields for sites, address prefixes, title words and quote words, each
  validated when added with the reason it was refused (`normalizeFilingHost`, `parseHttpUrl`, length,
  duplicates, the 20-value limit); an existing-tag picker; kinds and sources as checkboxes; bank
  (required), folder and extra tags; "Ask me before filing" **on** by default; "This rule is on". A
  rule that only looks at tags gets a warning: a new highlight has no tags yet, so it cannot match at
  capture time.
- **Test a rule**: address, title, quote, kind, source and tags -> which rules match, in order, each
  explained (decides / adds its tags / turned off / skipped because something it needs was deleted /
  not offered to PDFs / blocked), and the resulting plan in a sentence. Runs `decideFiling`.
- **Page overlay**: "Filed in X by rule 'R'" with Undo (replaces "Saved to ...", which would name a
  bank the highlight is no longer in); "File in X? Rule 'R'" with **File** and **Not now** (the toast
  gained an optional second button; a suggestion stays 12 s, paused while hovered or focused);
  "Rule 'R' could not file this highlight. ..." for a blocked rule. The wording is `filingMessage`
  (shared), also used by the side panel and the PDF reader.
- **Side panel**: a pending suggestion is a chip on its card (File in <bank> / Not now), in "This
  page" and "Recent", until filed, dismissed or 24 h old.

### 7. Limits that are decisions
- Rules look at a **new** highlight only. There is no "apply to existing highlights"; that would be a
  bulk move and needs its own confirmation design.
- A new highlight has no tags, so a `tagIds` condition cannot match at capture time. It is kept
  because the schema and the Test panel support it, and the form says so.
- A rule moves the new highlight out of the bank the capture chose (default placement); it never
  duplicates it into a second bank.
- Two windows: the worker is the only writer of both records; a second accept finds none and says so.

## Consequences
- Storage gained `filing.ts` (6 exports) and no table: nothing to migrate, back up or sync (the rules
  themselves are ADR-011 data; suggestions and undo records are session state by design).
- `BackgroundRpc` gained three entries and `CaptureResult` an optional field: older content scripts
  (an update in flight) ignore the field.
- `HandlerDeps` gained a required `filing` port.

## Tests
`packages/shared/src/filing.test.ts` (`decideFiling`, `isDefaultBankChoice`), `settings.test.ts`;
`packages/storage/src/filing.test.ts` (suggestion, accept, dismiss, expiry, auto-file, undo and its
guard, order, tag union, disabled and deleted rules, deleted target, explicit bank, PDF, failing
session store); `entrypoints/background/handlers.test.ts` (post-commit step, authorisation, private
windows); `entrypoints/highlighter.content/ui/filing.test.tsx` and `controller.filing.test.ts`
(toasts); `entrypoints/dashboard/RulesView.test.tsx` (list, dialog, validation, ordering and
keyboard, undo, duplicate, master switch, Test panel); `entrypoints/options/Options.test.tsx`;
`entrypoints/sidepanel/SidePanel.filing.test.tsx`; `entrypoints/pdf-reader/filing.test.ts` and
`store.filing.test.ts`; `tests/e2e/rules.spec.ts` (loaded extension).
