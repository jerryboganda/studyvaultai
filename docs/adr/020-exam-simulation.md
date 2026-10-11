# ADR-020: Exam simulation and syllabus coverage

**Status:** accepted (exam simulation, syllabus coverage) · **Date:** 2026-10-11 · Refines
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

## Part 2: custom syllabus and coverage

### Context
ADR-011 gave the vault a `syllabi` table (a named outline whose topics point at banks and tags) and
the persistence API, but nothing used it. PRD.md lists "coverage vs custom syllabus" under review
analytics. The person needs (a) a place to make and keep an outline of an exam or course without
re-typing it, and (b) an honest answer, per topic and for the whole outline, to "how much of this do I
have, and how well do I know it". Nothing may be guessed from text: coverage is only what the person
pointed at.

### Decisions

**1. Two surfaces, split by purpose.** The *editor* is the dashboard view `syllabus` (`?view=syllabus`,
optional `&syllabus=<id>`, nav button "Syllabus", palette command "Show the syllabus editor"; a lazy
chunk). The *coverage* is a section "Syllabus coverage" at the end of the review page's Analytics tab
(a lazy chunk of its own). Each links to the other ("See coverage" in the editor, "Edit this
syllabus" and "Map a bank or tag" in the table), and an empty Analytics section offers "Create a
syllabus". `openDashboard` is extended with `view: 'syllabus'` and `syllabus`; the dashboard reads
the id only if it looks like an id.

**2. The editor.** A syllabus is created empty, from a pasted outline, or "from my banks" (one topic
per bank, mapped to it, never the Inbox; folders are not topics because a topic points at banks and
tags only). It is renamed and deleted from the toolbar; delete is a soft delete with an Undo toast
(`deleteSyllabus` / `restoreSyllabus`). The tree is the shared ARIA `Tree`: arrows move, Alt+Up/Down
reorder, Alt+Right indents, Alt+Left outdents, F2 edits the title, Delete removes (with Undo), the
Menu key or a right click opens the same actions. Every action is also a button, and a button that
cannot act is `aria-disabled` with the reason (first/last at its level, no topic above to indent
into, level 6 reached, 500 topics reached), so nothing is drag-only. The selected topic has a title
(<= 200), a weight (> 0, <= 1000; empty means an equal share; the message says so) and two checkbox
pickers, banks and tags (<= 50 each). A mapping to something deleted or in the trash is kept, shown
as "a bank that is deleted or in the trash (untick to remove)" and reported in the topic's notice,
as ADR-011 decided.
- *Saving.* Each change is applied to the tree on screen at once and saved by `updateSyllabus` with
  `expectedVersion`, one write after another (a held-down key cannot race itself). A write that comes
  back `stale` shows the stored version and says so; a failed write shows the stored version and
  the error. Nothing is overwritten silently.
- *Outline text.* `parseOutline` (pure, `entrypoints/dashboard/syllabusModel.ts`) reads nested bullets
  (`-`, `*`, `+`, `1.`), plain indented lines and Markdown headings; a single leading `# Title` is the
  name; a trailing `(weight 2)` is the weight; a tab is four spaces. A level is the position of the
  indent in the chain of indents seen so far, so a jump of two levels is clamped and reported. The
  paste box has a live dry run: counts, the first lines of the tree, line-numbered errors that block
  the import (more than 500 topics, deeper than 6 levels, a title over 200 characters, a bad weight,
  more than 100,000 characters or 2,000 lines) and notes on what was interpreted. Nothing is saved
  until the button. Titles are text; the text is never rendered as markup.
- *Export.* "Export as Markdown" writes the outline (titles and weights) through a Blob download;
  `parseOutline` reads it back to the same tree (tested). Banks and tags are not exported: their ids
  mean nothing in another vault.

**3. What a topic holds.** A highlight or a card belongs to a topic when one of its banks or tags is
one the topic, or a subtopic, points at, and is counted once however many mappings match (union, not
intersection). Highlights: live ones, in live banks. Cards: not deleted, not suspended, deck alive;
their banks are the deck's bank and the banks of their highlight, their tags the card's own (resolved
by name key and aliases) and the highlight's (the same rules as the exam scope; a trashed highlight
files nothing). The pure rules are `syllabusTopicCoverage` in `packages/study/src/analytics.ts`
beside the unchanged `syllabusCoverage`; the facts are read in one transaction by
`loadSyllabusCoverageData` (`packages/storage/src/syllabusCoverage.ts`, imported by path, so no other
bundle carries it).

**4. Numbers per topic.** Highlights, cards, due (review cards due by the end of the study day plus
learning steps due now; new cards are never due), retention of mature reviews (answered Hard, Good or
Easy among reviews of graduated cards, over the last 365 days, undone reviews ignored; a number only
from 5 reviews, else "n/a" with the count), last studied (the newest `fsrs.lastReview` of its cards)
and the coverage state:
- *none*: no highlight and no card; *covered*: at least `minHighlights` highlights and at least
  `minCards` cards; *thin*: anything between. Defaults 3 and 1; both are whole numbers 0..999, shown
  and adjustable on the page, kept on this device only (see 8).

**5. Judging and the weighted figure.** A topic without subtopics, or whose subtopics point at
nothing, is judged by the thresholds. A topic whose subtopics point somewhere is judged from them:
its *covered* share is the weighted share of its subtopics that are covered, its *started* share the
weighted share that are at least thin. Weights are relative among siblings (absent = 1), so a topic's
share of the whole syllabus is the product of its normalised weights down the tree; the whole
syllabus's covered share is the weighted share of its top-level topics. The page shows two numbers,
"covered" and "has at least some material", and how many topics point at nothing; it never invents a
single blended score. A topic that has subtopics and its own mapping counts that mapping towards its
totals but is judged from its subtopics; the editor says so on the topic.

**6. The table is the primary view.** A sortable table (button in each column header, `aria-sort`;
ascending, descending, back to the outline order) with one row per topic: topic (indented in outline
order, "in <parent>" when sorted), share, highlights, cards, due, retention (n of reviews), last
studied, coverage (glyph and word, never colour alone; "from its subtopics" for judged-from-subtopics
topics) and an action. The chart is a picture of the table for the top-level topics (covered share,
stacked with the share that has some material) with a text summary and its own data table, as the
other analytics charts. The action is "Show" (a topic that points somewhere) or "Map a bank or tag"
(one that does not: no dead control), and a topic whose mapping is all gone says why it cannot show.
Honest empty states: no syllabus (with "Create a syllabus"), an empty syllabus, an unmapped topic.

**7. Showing a topic's highlights.** `topicLibraryTarget` (`packages/ui/src/vault/topicLink.ts`) turns
the banks and tags of a topic and its subtopics into either the dashboard list scoped to one bank
(`?bank=<id>`, exactly one bank and no tag) or a search in the grammar the search box already speaks,
`(bank:"A" OR bank:"B" OR tag:"c")` (`?q=...`), so the person sees and can edit what is shown and the
list is the same set the table counted. The search box holds 24 words and 512 characters; a topic
that points at more uses the first ones and the editor says "holds N of M". Names are quoted and
escaped.

**8. Persistence and privacy.** Syllabi are the ADR-011 rows (backup, sync policy, integrity check and
"Delete all data" are unchanged). The two thresholds are the device-local `meta` row
`syllabusThresholds` (`{ minHighlights, minCards }`, normalised on read, damaged values fall back to
the defaults): not in backups and not synchronised, like the exam history, and removed with the
database by "Delete all data". No new permission, no network path, no AI: everything works offline.

### Consequences
- A person with many topics can hit the search box limits; the editor says so instead of silently
  dropping mappings.
- The coverage reads every highlight id, link row and card of the vault once per refresh (keys only
  for highlights); it is refreshed on data changes, not on a timer.
- A 100,000-review vault is read through the 365-day window only; older reviews do not count towards
  topic retention (the page says "last 12 months").
- Not decided here and not built: an exam scope drawn from a syllabus topic ("weak areas feeding an
  exam", the half the reservation of this section mentioned). It needs `ExamScope` and the exam
  persistence (Part 1) to learn a `syllabus` kind; the persisted exam row is versioned, so that is
  additive and left to a follow-up that owns the exam code.

### Tests
`packages/study/src/analytics.test.ts` ("syllabusTopicCoverage": counted once, trashed and
suspended left out, weights, equal share, judging from subtopics and from its own mapping, empty
topics and syllabus, thresholds, due by study day, retention minimum, malformed trees, a
500-topic/20,000-highlight run), `packages/storage/src/syllabusCoverage.test.ts` (facts from the
vault, deleted tags and highlights, deck banks, the 365-day window, a stored syllabus end to end,
the thresholds on the device),
`entrypoints/dashboard/syllabusModel.test.ts` (edits and their limits, weights, the outline reader
and its errors, export round trip, from-banks), `entrypoints/dashboard/SyllabusView.test.tsx` (create,
type, reorder with buttons and keys, limits, weight validation, mapping and Show, gone mappings,
rename, delete with Undo, from-banks, export, import dry run and errors),
`entrypoints/review/SyllabusCoverage.test.tsx` (numbers, chart, sort, thresholds, Show targets,
subtopics), `packages/ui/src/vault/topicLink.test.ts`, and `tests/e2e/syllabus.spec.ts` (loaded
extension, offline: import an outline, map banks and tags, the coverage equals the seeded vault,
sorting, thresholds kept across a reload, "Show" opens exactly the counted highlights, delete and
Undo, "Delete all data", 320 px reflow, axe WCAG 2.2 AA on the editor, the dialog and the coverage).

### Size
Measured with a private e2e build (minified, unzipped): the lazy `SyllabusView-*.js` chunk is 24,683 B
(8,689 B gzip) and loads when the Syllabus view opens; the lazy `SyllabusCoverage-*.js` chunk is
14,895 B (5,246 B gzip) and loads on the Analytics tab; the shared `topicLink-*.js` chunk is
1,184 B (649 B gzip). The two search-box limits are copied rather than imported because importing them
pulled 12 KB of query parser into the review page. The eager part (a nav entry, the lazy wrappers,
test ids, the link and deep-link parsers) is estimated at about 2 KB of JavaScript across the
dashboard and review entry chunks and 2.2 KB of CSS (about 0.6 KB gzip); it was not measured against a
baseline build.
