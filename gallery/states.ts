import { updateSettings } from '@runtime';
import { patchSettings } from './scenarios/kit';
import {
  listBanks,
  listCards,
  listDocuments,
  listPageHighlights,
  listPdfHighlights,
  listRecentHighlights,
  rescheduleCard,
  setGameMode,
} from '@storage';
import { TAB_PRESETS } from './scenarios/tabs';
import type { Surface } from './boot';
import { $, byText, click, clickTestId, clickText, frames, setValue, sleep, waitFor } from './dom';
import { browser } from './shim/chrome';
import { seedAi } from './fakes/ai';
import { fakeSync, seedConflict } from './fakes/sync';
import { FILES, chooseFile, fakeDirectoryPicker, storeScannedPdf } from './fakes/files';
import { DAY, NOW } from './scenarios/kit';

/**
 * Scripts for gallery states that an address alone cannot reach (catalog.json lists every state and
 * its address parameters). `prepare` runs after the scenario is seeded and before the page mounts;
 * `run` drives the mounted page. Prefer an address: these exist only where the app has no route.
 */
export interface StateScript {
  prepare?: (setParam: (name: string, value: string) => void) => Promise<void>;
  run?: () => Promise<void>;
}

/** A pending welcome tour at `step` (the tour reads its place from chrome.storage.local). */
const tourAt = (step: string, preset = 'blank'): StateScript => ({
  prepare: () =>
    browser.storage.local.set({
      onboarding: {
        schemaVersion: 1,
        status: 'pending',
        step,
        preset: { id: preset, excluded: [] },
        applied: null,
        updatedAt: new Date().toISOString(),
      },
    }),
});

/** A highlight with notes, tags and links when the scenario has one (the beta blocker article). */
async function richHighlightId(): Promise<string> {
  const recent = await listRecentHighlights(200);
  const pick = recent.find((r) => r.highlight.exactQuote.includes('Cardioselective')) ?? recent[0];
  if (!pick) throw new Error('This scenario has no highlight to open.');
  return pick.highlight.id;
}

/** The PDF this scenario keeps a copy of, if any. */
async function storedPdf(): Promise<string | null> {
  return (await listDocuments()).find((d) => d.cachedBytes !== null)?.document.id ?? null;
}

const openStoredPdf: StateScript['prepare'] = async (setParam) => {
  const id = await storedPdf();
  if (id) setParam('doc', id);
};

/** The first page of the open PDF has its text layer complete (it can be searched and selected). */
const pdfPageReady = () =>
  waitFor(
    () => $('[data-testid="pdf-page-1"] .sv-textlayer:has(> .endOfContent):has(> span)'),
    'the first PDF page to be drawn',
    30_000,
  );

/** Clicks, then waits until `expect` (a selector) is on the page, so a missed click fails loudly. */
const clickThen =
  (act: () => Promise<void>, expect: string): (() => Promise<void>) =>
  async () => {
    await act();
    await waitFor(() => $(expect), expect);
  };
const DIALOG = 'dialog[open]';

/** The daily reminder flag the service worker raises (packages/ui/src/review/reminders.ts). */
const reminder: StateScript = {
  prepare: () =>
    browser.storage.session.set({
      reminderDue: { at: Date.now() - 3_600_000, expiresAt: Date.now() + 6 * 3_600_000 },
    }),
  run: async () =>
    void (await waitFor(() => byText('Time to review', 'p, div, span, strong'), 'the reminder')),
};

const pdfOpened: StateScript = {
  prepare: openStoredPdf,
  run: async () => {
    if (new URLSearchParams(location.search).has('doc')) await pdfPageReady();
  },
};

/** Scrolls `el` to the top once the page has placed its own focus (which scrolls too). */
async function scrollUp<E extends HTMLElement>(el: E): Promise<E> {
  await sleep(300);
  el.scrollIntoView({ block: 'start' });
  await frames();
  return el;
}

/** Waits for `selector`, then scrolls it to the top, so the shot shows that part of the page. */
async function scrollTo<E extends HTMLElement = HTMLElement>(
  selector: string,
  timeout?: number,
): Promise<E> {
  return scrollUp(await waitFor(() => $<E>(selector), selector, timeout));
}
const tid = (id: string) => `[data-testid="${id}"]`;

/** Waits for the innermost `selector` element containing `text`, then scrolls it to the top. */
async function scrollToText(text: string, selector = 'h2, h3, h4'): Promise<HTMLElement> {
  return scrollUp(await waitFor(() => byText(text, selector), `"${text}"`));
}

/** AI turned on with the fake provider (fakes/ai.ts). */
const aiConfigured: StateScript['prepare'] = () => seedAi();

/** Asks the dashboard chat a question: the consent dialog opens (nothing is sent before Send). */
async function askChat(): Promise<void> {
  const box = await waitFor(() => $<HTMLTextAreaElement>(tid('chat-question')), 'the question box');
  setValue(box, 'What do beta blockers do in heart failure?');
  await clickTestId('chat-ask');
  await waitFor(() => $(tid('ai-consent-dialog')), 'the consent dialog');
}

/** Sends from the open consent dialog and waits for the fake provider's answer. */
async function sendConsent(): Promise<void> {
  await clickTestId('ai-send');
  await waitFor(() => $(tid('ai-close')), 'the answer', 20_000);
}

/** The sync section signed in with a canned status (fakes/sync.ts). */
const syncAs = (view: Parameters<typeof fakeSync>[0], conflict = false): StateScript => ({
  prepare: async () => {
    if (conflict) await seedConflict();
    await fakeSync(view);
  },
  run: async () =>
    void (await scrollToText(conflict ? 'Conflicts (' : 'Sync between devices', 'h2, h3')),
});

/** Backup section: the task card `task` chosen (back up, restore, import or export). */
const backupTask = (task: 'backup' | 'restore' | 'import' | 'export') => async () => {
  await clickTestId(`backup-task-${task}`);
  await waitFor(() => $(`${tid(`backup-panel-${task}`)}:not([hidden])`), `the ${task} panel`);
};

/** Restore wizard: chooses `file`, then shows the step with test id `step`. */
const restoreWith =
  (
    file: () => File | Promise<File>,
    step: string,
    then?: () => Promise<void>,
  ): StateScript['run'] =>
  async () => {
    await backupTask('restore')();
    chooseFile(
      await waitFor(() => $<HTMLInputElement>(tid('backup-import-file')), 'the file input'),
      await file(),
    );
    await scrollTo(tid(step), 30_000);
    if (then) await then();
  };

/** AI configured, "Edit setup" pressed: the setup flow at the step titled `title`. */
const editAiAt = (title: string) => async () => {
  // The saved key is read after the settings: before it, the key step asks for one.
  await waitFor(() => $(tid('ai-key-mask')), 'the saved key');
  await clickTestId('ai-edit-setup');
  await wizardTo(title);
};

/** Sync setup flow (sync off) filled with sample addresses, at the step titled `title`. */
const syncSetupAt = (title: string) => async () => {
  await waitFor(() => $(tid('sync-setup-flow')), 'the sync setup');
  const fill = async (id: string, value: string) =>
    setValue(await waitFor(() => $<HTMLInputElement>(tid(id)), id), value);
  for (const step of ['Sync server', 'Sign-in provider', 'Looks good?']) {
    if (wizardTitle() === title) return;
    await wizardTo(step);
    if (step === 'Sync server') await fill('sync-server-url', 'https://sync.example.org');
    if (step === 'Sign-in provider') {
      await fill('sync-issuer', 'https://id.example.org');
      await fill('sync-client-id', 'studyvault-gallery');
    }
  }
};

/** The scanned PDF opened in the reader (its copy is kept), first page drawn. */
const scannedOpen: StateScript['prepare'] = async (setParam) =>
  setParam('doc', await storeScannedPdf());
const scannedBanner = () =>
  waitFor(() => byText('Scanned pages', 'p, div, strong, h2, h3'), 'the scanned banner', 30_000);

/** The open wizard's step heading (shared Wizard, StepFlow and the dashboard's JumpWizard). */
const wizardTitle = () => $('.sv-wiz__title')?.textContent?.trim() ?? null;

/**
 * Presses Next in the open wizard until its step heading reads `title`. Each step must already be
 * valid: a step that refuses (its error shows) times out with that step's name.
 */
async function wizardTo(title: string): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const now = await waitFor(wizardTitle, 'a wizard step');
    if (now === title) return;
    await clickText('Next', '.sv-wiz__nav button');
    await waitFor(() => wizardTitle() !== now, `the step after "${now}"`);
  }
  throw new Error(`Gallery state: the wizard never reached "${title}"`);
}

/** Presses Back in the open wizard until its step heading reads `title`. */
async function wizardBackTo(title: string): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const now = await waitFor(wizardTitle, 'a wizard step');
    if (now === title) return;
    await clickText('Back', '.sv-wiz__nav button');
    await waitFor(() => wizardTitle() !== now, `the step before "${now}"`);
  }
  throw new Error(`Gallery state: the wizard never went back to "${title}"`);
}

/** Picks the picture card labelled `label` (ChoiceCards: a visually hidden radio in a label). */
async function choose(label: string): Promise<void> {
  await click(
    () => byText(label, '.sv-choice__label')?.closest<HTMLElement>('label') ?? null,
    `the "${label}" choice`,
  );
  await waitFor(
    () => byText(label, '.sv-choice__label')?.closest('label')?.querySelector('input:checked'),
    `"${label}" chosen`,
  );
}

/** Dashboard Home with today's progress counted (the XP ledger is built in the page first). */
const homeReady = async () =>
  void (await waitFor(
    () => $('.home-today__game, .home-today__plain'),
    "today's progress",
    30_000,
  ));

/** Dashboard "New bank" wizard from Home, named "Dermatology", at the step titled `title`. */
const newBankAt = (title: string) => async () => {
  await homeReady(); // the cards behind the dialog settle first
  await clickTestId('home-new-bank');
  setValue(
    await waitFor(() => $<HTMLInputElement>(tid('name-input')), 'the name field'),
    'Dermatology',
  );
  await wizardTo(title);
};

/** Edits the first filing rule: the wizard opens on "Looks good?", then Back to `title`. */
const editRule = (title: string) => async () => {
  await clickTestId('rule-edit');
  await waitFor(() => $(DIALOG), 'the rule wizard');
  await wizardBackTo(title);
};

/** New syllabus wizard: "Paste outline" chosen and an outline pasted (the check shows). */
async function syllabusPasted(): Promise<void> {
  await clickTestId('syllabus-new');
  await choose('Paste outline');
  await wizardTo('Paste outline');
  setValue(
    await waitFor(() => $<HTMLTextAreaElement>(tid('syllabus-import-text')), 'the outline box'),
    '# Renal medicine\n- Acid-base (weight 2)\n  - Metabolic acidosis\n  - Respiratory alkalosis\n- Acute kidney injury\n  - Prerenal causes\n- Electrolytes',
  );
  await waitFor(() => byText('topic', `${tid('syllabus-import-summary')} *`), 'the outline check');
}

/** Side panel: the first card's "More actions" drawer open (kind, tags, notes, links, AI). */
async function openDrawer(): Promise<void> {
  await clickTestId('card-more');
  await waitFor(() => $(tid('card-drawer')), 'the card drawer');
}

/** Side panel Banks tab: "New bank" wizard named "Dermatology", at the step titled `title`. */
const panelNewBankAt = (title: string) => async () => {
  await clickText('New bank', '.sp-titlerow button');
  const name = await waitFor(
    () => $<HTMLInputElement>(`${DIALOG} .sv-textfield input`),
    'the name field',
  );
  setValue(name, 'Dermatology');
  await wizardTo(title);
};

/** Exam setup wizard: a custom count of 6 questions, at the "How many?" step. */
async function examCount(): Promise<void> {
  await waitFor(() => $(tid('rv-exam-setup')), 'the exam setup');
  await wizardTo('How many?');
  await choose('Custom');
  setValue(await waitFor(() => $<HTMLInputElement>(tid('rv-exam-questions')), 'the count'), '6');
}

/** Exam setup -> a short exam started. */
async function startExam(): Promise<void> {
  await examCount();
  await wizardTo('Looks good?');
  await clickText('Start exam', '.sv-wiz__nav button');
  await waitFor(() => $(tid('rv-exam-run')), 'the exam', 20_000);
}

/** Answers every question (first choice, or a typed answer), finishes, marks, shows results. */
async function finishExam(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const choice = $<HTMLInputElement>(`${tid('rv-exam-choices')} input[type="radio"]`);
    const text = $<HTMLTextAreaElement>(tid('rv-exam-text'));
    if (choice) choice.click();
    else if (text) setValue(text, 'My answer, typed in the gallery.');
    await frames();
    const next = $<HTMLButtonElement>(tid('rv-exam-next'));
    if (!next || next.matches('[aria-disabled="true"], :disabled')) break;
    next.click();
    await frames();
  }
  await clickTestId('rv-exam-finish');
  await frames();
  const confirm = byText('Finish exam', 'dialog[open] button');
  if (confirm) confirm.click();
  await waitFor(() => $(tid('rv-exam-marking')) ?? $(tid('rv-exam-results')), 'marking or results');
  if ($(tid('rv-exam-marking'))) {
    const knew = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-testid^="rv-exam-mark-"][data-testid$="-know"]',
      ),
    ];
    knew.filter((_, i) => i % 2 === 0).forEach((l) => l.querySelector('input')?.click());
    await frames();
    await clickTestId('rv-exam-mark-rest');
    await clickTestId('rv-exam-show-results');
  }
  await scrollTo(tid('rv-exam-results'));
}

export const SCRIPTS: Partial<Record<Surface, Record<string, StateScript>>> = {
  popup: {
    reminder,
    game: { run: async () => void (await waitFor(() => $('.pp-game .sv-ring'), 'the goal ring')) },
    'game-off': {
      prepare: async () => setGameMode(false),
      run: async () => void (await waitFor(() => $('.pp-game--plain'), "today's plain counts")),
    },
    'deny-confirm': {
      run: async () => {
        await clickText('Allow this site');
        await waitFor(() => byText('Keep it off'), 'the confirmation');
      },
    },
    activated: {
      run: async () => {
        await clickText('Turn on', '.pp-site__acts button');
        await waitFor(() => byText('on this page', 'p, li, span, div'), 'the page counts');
      },
    },
  },
  sidepanel: {
    reminder,
    'filing-suggestion': {
      // What the worker leaves in chrome.storage.session when a rule asks first (ADR-017).
      prepare: async () => {
        const [first] = await listPageHighlights(TAB_PRESETS.article!.url!, null);
        const bank = (await listBanks()).find((b) => b.name === 'Pharmacology');
        if (!first || !bank)
          throw new Error('This scenario has no article highlight to suggest for.');
        await browser.storage.session.set({
          [`sv.filing.suggest.${first.highlight.id}`]: {
            highlightId: first.highlight.id,
            at: Date.now(),
            ruleName: 'Pharmacology reading',
            bankId: bank.id,
            bankName: bank.name,
            folderId: null,
            folderName: null,
            addTagIds: [],
          },
        });
      },
      run: async () => {
        const chip = await waitFor(
          () => byText('Pharmacology reading', 'p, div, span'),
          'the suggestion',
        );
        chip.scrollIntoView({ block: 'center' });
      },
    },
    'card-drawer': { run: openDrawer },
    'new-bank': { run: panelNewBankAt('Name it') },
    'new-bank-review': { run: panelNewBankAt('Looks good?') },
    'card-links': {
      run: async () => {
        await openDrawer();
        await click(() => byText('Show links'), 'Show links');
        const toggle = await waitFor(() => byText('Hide links'), 'the open links section');
        toggle.scrollIntoView({ block: 'start' });
      },
    },
    'search-results': {
      run: async () => {
        const input = await waitFor(
          () => $<HTMLInputElement>('[role="tabpanel"] input[type="search"]'),
          'the search box',
        );
        // The index opens first; a query typed before that waits for it.
        await waitFor(() => !byText('Opening the search index', 'p, div, span'), 'the index');
        setValue(input, 'beta blocker');
        await waitFor(() => $('[role="tabpanel"] mark'), 'marked search results');
      },
    },
    'ai-drafts': {
      prepare: aiConfigured,
      run: async () => {
        await openDrawer();
        await clickTestId('card-ai-toggle');
        await scrollTo(tid('ai-actions'));
      },
    },
    'ai-result': {
      prepare: aiConfigured,
      run: async () => {
        await openDrawer();
        await clickTestId('card-ai-toggle');
        await clickTestId('ai-action-exam_pearl');
        await waitFor(() => $(tid('ai-consent-dialog')), 'the consent dialog');
        await sendConsent();
      },
    },
  },
  dashboard: {
    preview: { prepare: async (setParam) => setParam('highlight', await richHighlightId()) },
    'bank-menu': {
      run: async () => {
        const bank = await waitFor(
          () => byText('Pharmacology', '[role="treeitem"]'),
          'the Pharmacology bank',
        );
        const box = bank.getBoundingClientRect();
        bank.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            clientX: box.left + 40,
            clientY: box.top + box.height / 2,
          }),
        );
        await waitFor(() => $('[role="menu"]'), 'the bank menu');
      },
    },
    'compact-contrast': {
      prepare: async () => {
        await patchSettings({ density: 'compact' });
        localStorage.setItem('sv.dashboard.contrast', 'high');
      },
      // Read once at mount; removed again so other gallery pages in this browser are not affected.
      run: async () => {
        await waitFor(() => document.documentElement.dataset.contrast === 'high', 'high contrast');
        localStorage.removeItem('sv.dashboard.contrast');
      },
    },
    'rule-dialog': { run: clickThen(() => clickTestId('rule-new'), DIALOG) },
    'rule-edit': { run: editRule('Looks good?') },
    'rule-edit-try': { run: editRule('Try it') },
    'rule-edit-file': { run: editRule('File into') },
    'rule-edit-match': { run: editRule('What matches') },
    'syllabus-wizard': { run: clickThen(() => clickTestId('syllabus-new'), DIALOG) },
    'syllabus-wizard-paste': { run: syllabusPasted },
    'syllabus-wizard-review': {
      run: async () => {
        await syllabusPasted();
        await wizardTo('Looks good?');
      },
    },
    palette: { run: clickThen(() => clickTestId('open-palette'), DIALOG) },
    'new-bank': {
      run: async () => {
        await homeReady();
        await clickThen(() => clickTestId('home-new-bank'), DIALOG)();
      },
    },
    'new-bank-icon': { run: newBankAt('Pick an icon') },
    'new-bank-colour': { run: newBankAt('Pick a colour') },
    'new-bank-review': { run: newBankAt('Looks good?') },
    'new-bank-done': {
      run: async () => {
        await newBankAt('Looks good?')();
        await clickText('Create bank', '.sv-wiz__nav button');
        await waitFor(() => $(tid('new-bank-done')), 'the "Bank ready!" screen');
      },
    },
    default: { run: homeReady },
    'home-narrow': { run: homeReady },
    'home-game-off': {
      prepare: async () => setGameMode(false),
      run: async () => void (await waitFor(() => $('.home-today__plain'), "today's plain counts")),
    },
    badges: {
      run: async () => {
        await homeReady();
        await clickTestId('home-badges-all');
        await waitFor(() => $(`dialog[open]${tid('badges-sheet')}`), 'the badges sheet');
      },
    },
    'chat-consent': { prepare: aiConfigured, run: askChat },
    'chat-answer': {
      prepare: aiConfigured,
      run: async () => {
        await askChat();
        await sendConsent();
        await clickTestId('ai-close');
        await scrollTo(tid('chat-turn'), 20_000);
      },
    },
    'narrow-tree': {
      run: clickThen(
        () => clickTestId('toggle-tree'),
        '[data-testid="toggle-tree"][aria-expanded="true"]',
      ),
    },
  },
  review: {
    session: {
      run: async () => {
        await clickTestId('rv-start-all');
        await waitFor(() => $(tid('rv-reveal')), 'a card');
      },
    },
    answer: {
      run: async () => {
        await clickTestId('rv-start-all');
        await clickTestId('rv-reveal');
        await waitFor(() => $(tid('rv-ratings')), 'the rating buttons');
      },
    },
    'session-done': {
      // The deck with the fewest cards due, every card answered Easy: the end-of-session screen.
      run: async () => {
        await waitFor(() => $(tid('rv-deck-picker')), 'the decks');
        const due = (b: HTMLElement) => Number(/\((\d+)\)/.exec(b.textContent ?? '')?.[1] ?? 0);
        const starts = [
          ...document.querySelectorAll<HTMLButtonElement>('[data-testid^="rv-start-"]'),
        ].filter((b) => b.dataset.testid !== 'rv-start-all' && due(b) > 0);
        const smallest = starts.sort((a, b) => due(a) - due(b))[0];
        if (!smallest) throw new Error('This scenario has no deck with cards due.');
        smallest.click();
        for (let i = 0; i < 200 && !$(tid('rv-summary')); i++) {
          await waitFor(
            () =>
              $(tid('rv-summary')) ??
              $(tid('rv-wait-now')) ??
              $(`${tid('rv-ratings')} button`) ??
              $(tid('rv-reveal')) ??
              $(`${tid('rv-choices')} input`),
            'the next card',
          );
          const next =
            $(tid('rv-wait-now')) ??
            $(tid('rv-rate-4')) ??
            $(tid('rv-reveal')) ??
            $<HTMLElement>(`${tid('rv-choices')} input`);
          next?.click();
          await frames();
        }
        await scrollTo(tid('rv-summary'), 30_000);
      },
    },
    'create-highlight': {
      prepare: async (setParam) => setParam('highlight', await richHighlightId()),
    },
    'kp-editor': {
      prepare: async (setParam) => setParam('highlight', await richHighlightId()),
      run: async () => void (await scrollTo(tid('rv-kp-editor'))),
    },
    'exam-count': { run: examCount },
    'exam-time': {
      run: async () => {
        await examCount();
        await wizardTo('Time limit');
      },
    },
    'exam-plan': {
      run: async () => {
        await examCount();
        await wizardTo('Looks good?');
      },
    },
    'exam-run': { run: startExam },
    'exam-results': {
      run: async () => {
        await startExam();
        await finishExam();
      },
    },
    'card-edit': {
      run: async () => {
        await click(
          () => $(`${tid('rv-browser')} button[aria-label="Edit"]`),
          'a card Edit button',
        );
        await waitFor(() => $(`dialog[open] ${tid('rv-editor')}`), 'the Edit card sheet');
      },
    },
    backlog: {
      // 25 review cards whose due date passed while the student was away: the planner opens itself.
      prepare: async () => {
        const { cards } = await listCards({ filter: 'all', limit: 2000 });
        const due = cards.filter((c) => c.fsrs.state === 'review').slice(0, 25);
        for (const [i, card] of due.entries()) {
          const at = NOW - (2 + (i % 8)) * DAY;
          await rescheduleCard(card.id, at, at);
        }
      },
      run: async () => {
        // A budget of 2 reviews per deck and day, so the plan moves cards and shows what changes.
        const planner = await waitFor(() => $(tid('rv-backlog')), 'the planner');
        setValue(
          await waitFor(() => $<HTMLInputElement>('input[id$="-budget"]', planner), 'budget'),
          '2',
        );
        await waitFor(() => $('table', planner), 'the moves table');
      },
    },
  },
  options: {
    'ai-on': {
      prepare: async () =>
        void (await updateSettings((s) => ({ ...s, features: { ...s.features, ai: true } }))),
    },
    'save-failed': {
      // The settings write fails (catalog fault): the section reports its own error.
      run: async () => {
        await click(() => $('input[type="radio"][value="compact"]'), 'the Compact density radio');
        const notice = await waitFor(
          () => byText('Your change was not saved', 'p, div, strong'),
          'the error',
        );
        notice.scrollIntoView({ block: 'center' });
      },
    },
    'delete-dialog': { run: clickThen(() => clickText('Delete all data'), DIALOG) },
    'site-wizard': { run: clickThen(() => clickText('Choose sites'), DIALOG) },
    'site-wizard-sites': {
      run: async () => {
        await clickText('Choose sites');
        await choose('Some sites');
        await wizardTo('Which sites?');
        for (const site of ['nejm.org', 'bmj.com']) {
          const field = `${DIALOG} input[inputmode="url"]`;
          setValue(await waitFor(() => $<HTMLInputElement>(field), 'the site field'), site);
          await clickText('Add', `${DIALOG} button`);
          await waitFor(() => byText(site, `${DIALOG} li`), site);
        }
      },
    },
    'all-sites-dialog': {
      // Choose sites -> All sites -> what Chrome will be asked (the old confirmation dialog).
      run: async () => {
        await clickText('Choose sites');
        await choose('All sites');
        await wizardTo('Chrome asks');
      },
    },
    'backup-restore': { run: backupTask('restore') },
    'backup-import': { run: backupTask('import') },
    'backup-export': { run: backupTask('export') },
    'ai-configured': { prepare: aiConfigured },
    'ai-wizard-address': { prepare: aiConfigured, run: editAiAt('Address and model') },
    'ai-wizard-key': { prepare: aiConfigured, run: editAiAt('API key') },
    'ai-wizard-limit': { prepare: aiConfigured, run: editAiAt('Daily limit') },
    'ai-wizard-save': { prepare: aiConfigured, run: editAiAt('Save and test') },
    'sync-wizard-server': { run: syncSetupAt('Sync server') },
    'sync-wizard-signin': { run: syncSetupAt('Sign-in provider') },
    'sync-wizard-check': {
      run: async () => {
        await syncSetupAt('Looks good?')();
        await clickTestId('sync-ack');
      },
    },
    'ai-test-success': {
      prepare: aiConfigured,
      run: async () => {
        await clickTestId('ai-test');
        const result = await waitFor(() => $(tid('ai-test-result')), 'the test result', 20_000);
        result.scrollIntoView({ block: 'center' });
      },
    },
    'ai-routing': {
      prepare: aiConfigured,
      run: async () => void (await scrollTo(tid('ai-routing'))),
    },
    'ai-ledger': {
      prepare: aiConfigured,
      run: async () => void (await scrollTo(tid('ai-ledger'))),
    },
    'sync-signed-in': syncAs({}),
    'sync-encryption-choice': syncAs({
      status: 'awaiting_encryption_choice',
      encryptionChoice: 'undecided',
      lastSyncAt: null,
      pending: 139,
      e2ee: { mode: 'none', version: null, lockInSeconds: null },
    }),
    'sync-locked': syncAs({
      status: 'locked',
      pending: 4,
      e2ee: { mode: 'locked', lockInSeconds: null },
    }),
    'sync-conflicts': syncAs({ attention: { conflicts: 1, quarantined: 0 } }, true),
    'restore-review': { run: restoreWith(FILES.exported, 'backup-import-review') },
    'restore-invalid': { run: restoreWith(FILES.oldModelBackup, 'backup-import-blocked') },
    'restore-passphrase': {
      run: restoreWith(FILES.encryptedBackup, 'backup-import-passphrase'),
    },
    'restore-done': {
      run: restoreWith(FILES.exported, 'backup-import-review', async () => {
        // No safety download in the gallery: merging keeps everything anyway.
        const safety = $<HTMLInputElement>(tid('backup-import-safety'));
        if (safety?.checked) safety.click();
        await clickTestId('backup-import-restore');
        await scrollTo(tid('backup-import-done'), 30_000);
      }),
    },
    'import-anki': {
      run: async () => {
        await backupTask('import')();
        chooseFile(
          await waitFor(() => $<HTMLInputElement>(tid('backup-external-file')), 'the file input'),
          FILES.anki(),
        );
        await scrollTo(tid('backup-external-review'), 20_000);
      },
    },
    'backup-folder': {
      prepare: async () => fakeDirectoryPicker(),
      run: async () => {
        await scrollTo(tid('backup-folder'));
        await clickTestId('backup-folder-choose');
        await clickTestId('backup-folder-now');
        await scrollTo(tid('backup-folder-done'), 30_000);
      },
    },
  },
  onboarding: {
    default: { run: async () => void (await waitFor(() => $('.ob-chips'), 'the daily goal')) },
    'welcome-game-off': {
      prepare: async () => setGameMode(false),
      run: async () =>
        void (await waitFor(() => $('[aria-label="What StudyVault does"]'), 'the tiles')),
    },
    privacy: tourAt('privacy'),
    access: tourAt('access'),
    banks: tourAt('banks'),
    'banks-medicine': tourAt('banks', 'medicine'),
    look: tourAt('look'),
    keys: tourAt('keys'),
    done: tourAt('done'),
    'banks-created': {
      prepare: tourAt('banks', 'medicine').prepare,
      run: async () => {
        await clickTestId('ob-create');
        await waitFor(() => byText('Done', 'p, div, strong'), 'the created bank');
      },
    },
    skipped: {
      run: async () => {
        await clickTestId('ob-skip');
        await waitFor(() => byText('Tour skipped', 'h1, h2'), '"Tour skipped"');
      },
    },
  },
  'pdf-reader': {
    default: pdfOpened,
    loading: { prepare: openStoredPdf },
    'load-failed': { prepare: openStoredPdf },
    password: {
      run: async () => {
        const input = await waitFor(() => $<HTMLInputElement>(tid('pdf-file-input')), 'the input');
        chooseFile(input, await FILES.lockedPdf());
        await waitFor(() => byText('Password needed', 'h2'), 'the password dialog');
      },
    },
    scanned: {
      prepare: scannedOpen,
      run: async () => void (await scannedBanner()),
    },
    'ocr-done': {
      // Real OCR (tesseract from public/ocr, served by the gallery): one page takes a few seconds.
      prepare: scannedOpen,
      run: async () => {
        await scannedBanner();
        await clickTestId('pdf-ocr-this-page');
        await waitFor(
          () => byText('Recognised 1 page', 'p, div, strong'),
          'the OCR result',
          60_000,
        );
        await click(() => byText('Page text', '[role="tab"], button'), 'the Page text tab');
        await waitFor(() => byText('Edit line', 'button'), 'the recognised lines');
      },
    },
    'ocr-running': {
      prepare: scannedOpen,
      run: async () => {
        await scannedBanner();
        await clickTestId('pdf-ocr-this-page');
        await waitFor(() => byText('Recognising', 'p, div, strong, h2, h3'), 'OCR running');
      },
    },
    highlight: {
      prepare: async (setParam) => {
        const doc = await storedPdf();
        if (!doc) throw new Error('This scenario keeps no PDF copy.');
        setParam('doc', doc);
        const first = (await listPdfHighlights(doc))[0];
        if (first) setParam('highlight', first.id);
      },
      run: async () => void (await pdfPageReady()),
    },
    sidepane: {
      prepare: openStoredPdf,
      run: async () => {
        await pdfPageReady();
        await clickTestId('pdf-toggle-sidepane');
        await waitFor(() => $('[data-testid="pdf-sidepane"]'), 'the side pane');
      },
    },
    search: {
      prepare: openStoredPdf,
      run: async () => {
        await pdfPageReady();
        setValue(
          await waitFor(() => $<HTMLInputElement>('[data-testid="pdf-search"]'), 'the search box'),
          'vaccine',
        );
        await waitFor(
          () => /\d+ of \d+/.test($('[data-testid="pdf-find-count"]')?.textContent ?? ''),
          'search matches',
          30_000,
        );
      },
    },
    savebar: {
      prepare: openStoredPdf,
      run: async () => {
        const layer = await pdfPageReady();
        // As a drag would (tests/e2e/helpers.pdfReal.ts): first word to a few words later.
        const spans = [...layer.querySelectorAll('span')].filter(
          (s) => s.firstChild?.nodeType === Node.TEXT_NODE && (s.textContent ?? '').trim(),
        );
        const a = spans[2];
        const b = spans[Math.min(spans.length - 1, 6)];
        if (!a?.firstChild || !b?.firstChild) throw new Error('No text to select on page 1.');
        await frames();
        document
          .getSelection()!
          .setBaseAndExtent(a.firstChild, 0, b.firstChild, (b.textContent ?? '').length);
        await waitFor(() => $('[data-testid="pdf-savebar"]'), 'the save bar');
      },
    },
  },
};
