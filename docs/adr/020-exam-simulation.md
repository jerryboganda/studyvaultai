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
- An exam scope drawn from a syllabus topic ("weak areas feeding an exam", the half the reservation
  of this section mentioned) was not part of this slice. It needed `ExamScope` and the exam
  persistence (Part 1) to learn a `syllabus` kind; it is built, see "Part 2 addendum" below.

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

## Part 2 addendum: an exam over a syllabus topic

**Status:** accepted · **Date:** 2026-10-12. Closes the reservation above. Additive to Part 1: no
exam that was possible before changes, and no scheduling side effect is added (decision 9 of Part 1
holds as written).

### Decisions

**1. A fifth scope kind.** `{ kind: 'syllabus', syllabusId, topicId | null, weighted }`. A topic means
the topic and everything below it (a node points at banks and tags, so a subtree is the union of
their mappings); `null` is the whole syllabus. It is picked on the setup form, next to the library
scopes, as "My banks, folders and tags" or "A syllabus" (a radio group, shown when at least one
syllabus exists; without one the form says how to get one and offers the editor).

**2. Membership is the coverage's, not a second reading of it.** The tree, the mapping and the
"which topics does this item belong to" rule were lifted out of `syllabusTopicCoverage` into
`syllabusTopicIndex` (`packages/study/src/analytics.ts`); coverage and the exam both call it, and
`coverageTopics` is the one place a stored outline becomes that list. The facts are the ones the
coverage table reads (`loadSyllabusCoverageData`, through `loadExamTopicRefs`, read only when the
syllabus scope is in use). The candidates are those cards intersected with the exam's own universe
(live, not suspended, deck alive), each once. A storage test asserts that the card count of every
topic equals the coverage table's "Cards" column, before and after a card is suspended. The topic
picker shows those counts.

**3. Units and shared cards.** A *unit* is what coverage judges by its own cards: a topic without
subtopics, or whose subtopics point at nothing. A card that belongs to several units is counted
under exactly ONE of them, so each question has one topic and the per-topic results add up: scarcest
cards first, each to the unit with the fewest cards so far (ties by outline order), a function of
the card ids and the seed only. A card reached only through the own mapping of a topic that has
subtopics counts under the deepest topic it reaches.

**4. Weighted by topic weight.** Questions are shared between the units that have cards by *largest
remainder* with caps (`allocateByWeight`): a unit never gets more questions than cards, and what it
cannot take goes to the others in the same proportion; ties go to the earlier unit in the outline.
The weight of a unit is its **share of the syllabus** (the product of the normalised sibling weights
down the tree, the number the coverage table shows), not its raw `weight`, because weights are only
meaningful among siblings; absent means equal. The cards of a unit are drawn with a seeded shuffle.
A unit that got no question is reported, never silently dropped: `nocards` (nothing in it),
`shared` (every card it holds counts under another unit) or `noshare` (cards, but fewer questions
than its weight earns). Cards only a parent's own mapping reaches are not drawn in a weighted exam
(they have no unit) and are counted and said (`undrawn`). Unweighted exams draw from the whole pool
with the same seeded shuffle every scope uses.

**5. What you see is what is drawn.** The setup form keeps one seed for its lifetime and shows the
plan (a table: topic, share, cards, questions, and "Left out: ...") computed from it by the same
pure functions; `ExamConfig.seed` carries it into `createExam`, so the draw equals the plan unless
the cards changed in between. Library scopes still draw a fresh seed at start.

**6. Persistence, additively.** The exam row is `version: 2`: `scope` may be a syllabus scope,
`syllabus: { topics, skipped, undrawn } | null` (the titles as they were, in outline order, and what
was left out; never card text) and `topicId` on every question (null outside a syllabus exam). A
refinement ties them together (a syllabus exam keeps its outline, only it does, and a question names
a known topic). **Migration:** `upgradeExamSession` carries a stored version 1 row over (no
syllabus, `topicId: null`), so an exam in flight when the extension updates continues, answers and
clock intact. A row that is neither version (damaged, or a version this build does not know) is
removed as before, and now reported (`unreadable`): the page says it "could not be read ... and was
removed" instead of dropping it silently. History entries gain the optional `syllabusId` (an id,
never a title or card text); the scope label already names the syllabus and topic and is capped at
300 characters. Still device-local, not in backups, not synced (Part 1, decision 10).

**7. Results by topic.** A "By topic" table in outline order (a question counts under one topic; the
screen says so) with a "Study this topic" button per row (its aria-label names the topic). It reads
the syllabus as it is now and opens the same dashboard list the coverage table's "Show" opens
(`subtreeMappings` and `topicLibraryTarget`: the bank, or a search over the banks and tags). A topic
that was removed, a syllabus deleted since, or mappings that are gone leave the button disabled with
the reason. The Markdown export has a "By topic" table.

**8. Entry points.** The coverage table has an "Exam on this topic" button per topic (disabled with a
reason when the topic has no cards; the column is absent where the host has no exam) and the review
address accepts `?view=exam&syllabus=<id>&topic=<id>` (ids validated like the other parameters; a
topic is ignored without its syllabus). Both land on the setup with the syllabus radio on, the topic
chosen and focus on the form's heading; the address is rewritten so a reload keeps it, and the
preselection is forgotten when another tab is chosen. An exam in progress is not hidden: the setup
opens with its "Continue the exam / Discard" notice and Start explains why it is off. A syllabus or
topic that is gone says so and falls back to the first syllabus or the whole syllabus.

### Consequences
- A card in several topics counts under one of them, chosen by balance and not by the person; the
  setup and the results say so.
- The setup reads every card's filing a second time (the coverage facts) when the syllabus scope is
  used; the work is lazy and local, and the review log is not read.
- Not built: time limits per topic, an adaptive "weakest topics first" draw from retention (the
  coverage already shows retention; feeding it back into a draw is a separate decision), and
  per-topic marks from the results page.
- `.rv-tablewrap` became `position: relative`: a visually hidden reason inside a table cell (a
  disabled button's) was positioned against the page and widened it past the wrapper's clip at
  320 px; the coverage table's new column exposed it.

### Tests
`packages/study/src/examSyllabus.test.ts` (largest-remainder allocation with caps and invariants
over 300 random shapes, membership counted once like coverage, a topic's subtree, shared cards
balanced under one topic, empty and shared topics reported, deterministic with the seed and
independent of input order, parent-own-mapping cards, `createExam` over a syllabus),
`packages/study/src/exam.test.ts` (version 1 carried over, unreadable reported, outline consistency,
results by topic, Markdown, history), `packages/storage/src/exam.test.ts` (counts equal the coverage
table's, suspended cards, a syllabus exam kept and resumed, the summary has an id and no text, a
version 1 row in the database), `entrypoints/review/ExamSyllabus.test.tsx` (setup counts and plan,
topic exam, results by topic and the study link, the address, a gone topic or syllabus, the coverage
button, no syllabus, an empty topic, an exam of the previous version continues and an unknown one is
reported), `entrypoints/review/SyllabusCoverage.test.tsx` (the button, by keyboard, disabled with a
reason, absent without a host), `packages/ui/src/review/model.test.ts` (the address),
`tests/e2e/exam.spec.ts` (loaded extension: an outline imported in the editor and mapped, the exam
started from a topic, counts equal to the seeded vault, offline with no request, results by topic,
"Study this topic" opens exactly the counted highlights, "Exam on this topic" by keyboard, the
address after a reload, a weighted exam and what it left out, axe WCAG 2.2 AA on setup and results).

### Size
Measured against a build of the commit this work started from (private e2e builds, minified,
unzipped): the lazy `Exam-*.js` chunk 45,443 B -> 61,099 B (+15,656 B; gzip +4,607 B), fetched only
on the Exam tab; the storage coverage loader moved into a shared lazy chunk (`syllabusCoverage-*.js`,
2,866 B) that `SyllabusCoverage-*.js` (14,895 B -> 12,371 B) and `Exam` both use, so that pair grew
by 342 B; the eager part is about 1 KB in the review entry (test ids, the address parser, the tab
wiring), `links-*.js` +227 B and 18 B of CSS. The added code is in neither the service worker nor
the content script (its distinctive identifiers are absent from `background.js` and
`content-scripts/highlighter.js`).
