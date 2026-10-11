# ADR-020: Exam simulation and syllabus coverage

**Status:** accepted (exam simulation); syllabus coverage reserved · **Date:** 2026-10-11 · Refines
ADR-010 (the `meta` table). Delivers the "exam simulation" line of PRD.md (P1 "Exam simulation and
adaptive targeted review using actual review data"; the adaptive half is not part of this slice).

## Part 1: exam simulation

### Context
Review (Phase 4) answers "what is due today". A learner preparing for a high-stakes exam also needs
the opposite: a timed run over a chosen part of the vault with no feedback until the end, a score they
can trust, and the missed questions with their sources. The run must not disturb the memory model
(an exam is not spaced practice), must survive a reload, and must be honest about what a machine can
and cannot grade.

### Decisions

**1. Where it lives.** A new tab "Exam" on the review page (`view=exam`), after "Study". Pure rules
in `packages/study/src/exam.ts` (no clock, no random, no React, no storage); persistence in
`packages/storage/src/exam.ts`; UI in `entrypoints/review/Exam*.tsx`. The tab's code is a lazy chunk
(`import('./Exam')`), and both modules are imported by path (`@study/exam`, `@storage/exam`), not from
the package barrels: the service worker, the content script, the popup and the side panel carry none of
it. Measured: see "Size" below.

**2. Scope.** Bank, folder (the folder and its whole subtree) or tag, or all cards. A card belongs to a
bank when its deck is that bank's or its highlight is filed in it; to a folder through its highlight's
filing (typed cards have none); to a tag through its own tags or its highlight's tags (compared with
`tagNameKey`). Suspended and deleted cards, and cards whose deck is gone, are never asked. A trashed
highlight files nothing (the card keeps its deck's bank). `examScopeOptions` lists only scopes with at
least one card, with the real count.

**3. Configuration.** Number of questions (1 to 200, capped by the cards available and said so on
screen), an optional time limit in whole minutes (1 to 480) and "shuffle". `validateExamConfig` is the
only place the rules live; the form and `createExam` both use it. Cards are drawn with a seed taken
from the injected `Random` and stored in the exam (`seed`), so the same exam can always be reproduced;
without shuffle the chosen cards are asked in creation order (the draw is still random when fewer
questions than cards are asked). The order of each multiple-choice list is a function of
`(seed, card id)`, so a render never reshuffles.

**4. Two question kinds, and when the machine may grade.**
- *Multiple choice* is scored by the card's key.
- *Everything else* (basic, cloze, definition, compare) is recall: the person may type an answer
  (kept, never graded by the machine) or just think, and **marks it themselves after answering has
  ended**. Showing the answer and asking "did you know it" during the run would give feedback that the
  exam is meant to withhold, so the exam has two phases: `answering` (timed) and `marking` (untimed;
  the recall questions are shown with their answer, the person picks "I knew it" or "I did not know
  it"). "Mark the rest as not known" is the only bulk action and is explicit. A recall question is
  never silently scored.
- A question whose card was removed or changed type since is `void`: left out of the score and the
  breakdown, listed as such. Removing a card never punishes the person.

**5. Time.** The limit covers answering only. There is no pause. `deadlineAt = startedAt + minutes`
and everything is derived from the instants: an exam reopened after the deadline lands in marking with
`endedAt = deadlineAt` (whenever it is noticed), and an answer that arrives after the deadline is
dropped, not squeezed in. Time per question is charged to the question on screen at each event; the
time spent with the page closed is charged to nobody (the clock itself did not stop).
Leaving is "Leave exam" behind a confirmation; the exam stays and can be continued until its time runs
out (or 24 hours pass). A page that opens on an unfinished exam continues it.

**6. Accessibility of the clock.** The visible time is `role="timer"` with `aria-live="off"`: it is
read when asked and never interrupts. The person is told at 50 %, 10 %, one minute and the end
(`examMilestones`; a moment that repeats another within a second, or falls at the start, is left out),
through ONE polite region that outlives each screen, so "time is up" is heard even though the question
screen is replaced at that moment. A resumed exam does not repeat what it had already passed. There are
no single-key shortcuts in the exam (WCAG 2.1.4); every action is a button or a native radio group.
Meaning is never colour alone (the picked option has a heavier border and a checked radio).

**7. Persistence, with a version and an expiry.** The running exam is the IndexedDB `meta` row
`examSession` (`version: 1`, `expiresAt = startedAt + 24 h`, or finish + 24 h for results), written
after every change; `parseExamSession` validates it (including cross-field consistency) and
`loadExamSession` removes an expired or unreadable row. It holds card ids, the person's answers and
marks, bank names as they were, tags and times, **not card text**: questions are read live, so a purge
leaves nothing derived behind (ADR-010 amendment 2, section 10) and an edit made meanwhile is what
the person sees. The one piece of the person's own words that stays is what they typed, for 24 hours.
`chrome.storage.local` was rejected: content scripts can read it, and the exam has no need to be
there. The exam does not depend on the service worker at all, so a suspended worker cannot affect it
(`exam.spec.ts` stops the worker and reloads mid-exam).

**8. Results.** Fixed when marking ends (`finishExam` stores one outcome per question), so they cannot
drift if a card is edited later: score (correct / graded; unanswered counts against), per bank and
per tag (a question with several tags counts under each; the screen says so), time per question
(table, with the average), and the missed questions (wrong or unanswered) with the person's answer,
the correct answer, the quote (the highlight's current quote, else the card's snapshot, labelled) and
"Jump to source" through the same `openSource` helper the study session uses. "Export results as
Markdown" is a client-side Blob download with all card text escaped (`examToMarkdown`; a quote with
markup stays inert).

**9. No scheduling side effects unless asked.** An exam writes no card and no review log. At the end
the person may tick "Count this exam as review": each answered card gets one rating (correct is Good,
wrong is Again; unanswered and void are left alone: running out of time is not forgetting) through the
existing `reviewCard`, keyed by `logId = <examId>-<position>`, so a retry or a double click can never
write a card twice (`duplicate` outcomes are folded in). Unticking undoes it through `undoLastReview`
with `expectLogId`: a card reviewed again since is refused and counted, never overwritten. An exam can
be counted once: after an undo the log ids exist, so the control stays off and says why.

**10. History.** The last 20 finished exams are kept as summaries in the `meta` row `examHistory`
(scope label, counts, limit, time used, "counted as review"; no question text), shown on the Exam tab
with "Clear this list". **They are not in backups and not synchronised**: `meta` is excluded from
backups by design (ADR-010, `BACKUP_EXCLUDED_TABLES`), and a summary of how a person did is not
something a restore should invent on another device. The screen says "stored on this device only, not
part of backups, not synced"; "Delete all data" removes it with the database. Making it portable
would be a backup-format decision (as `savedSearches`), not taken here.

### Consequences
- A question the person answered in their head but never typed shows as unanswered in the progress
  counter (the finish dialog says recall questions can still be marked); the score is unaffected
  because marking is the person's.
- Two windows editing one exam last-write-wins; the exam is single-user and single-page by design.
- A new exam replaces unread results of the previous one (the history keeps its summary).
- Not covered: adaptive "targeted review" from exam results (a later slice can build a deck from the
  missed list); images, math rendering inside questions follow the card renderer (ADR-015).

### Tests
`packages/study/src/exam.test.ts` (scope, configuration, seeded draw, shuffle, timer, milestones,
time-up at the deadline, resume, scoring, void, breakdown, review plan, history, Markdown escaping),
`packages/storage/src/exam.test.ts` (facts from the vault, persistence and expiry, history cap,
idempotent count-as-review and undo, no scheduling side effect), `entrypoints/review/Exam.test.tsx`
(whole run without feedback, marking, results, count and undo, export, leave/continue/discard, reload
and clock, the timer is not chatty), `tests/e2e/exam.spec.ts` (loaded extension: start, answer,
time-out on the pinned clock, reload mid-exam with the worker stopped, results, count-as-review and
undo, source jump, offline, axe WCAG 2.2 AA).

### Size
Measured with a private e2e build (minified, unzipped): the lazy `Exam-*.js` chunk is 45,315 B
(13,852 B gzip) and is fetched only when the Exam tab is opened. The eager part is the extra tab and
the `TID` entries (about 1.2 KB in the review chunks) and 0.5 KB of CSS; no worker, content-script,
popup or side-panel file changed. The retired duplicate `hashSeed` moved into `@study/random` (a
wash).

## Part 2: syllabus coverage (reserved)

Reserved for the agent that adds the syllabus coverage view (exam blueprint nodes, coverage per node
from cards and highlights, "weak areas" feeding an exam scope). It will extend `ExamScope` with a
`syllabus` kind and `examScopeOptions` with the nodes that have cards. The persisted exam row is
versioned (`version: 1`) and an older build refuses a row it cannot parse (it is dropped, which is
harmless for a 24-hour row), so adding a scope kind is additive. Nothing else is decided here.
