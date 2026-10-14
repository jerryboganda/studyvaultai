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

/** Restore wizard: chooses `file`, then shows the step with test id `step`. */
const restoreWith =
  (
    file: () => File | Promise<File>,
    step: string,
    then?: () => Promise<void>,
  ): StateScript['run'] =>
  async () => {
    chooseFile(await scrollTo<HTMLInputElement>(tid('backup-import-file')), await file());
    await scrollTo(tid(step), 30_000);
    if (then) await then();
  };

/** The scanned PDF opened in the reader (its copy is kept), first page drawn. */
const scannedOpen: StateScript['prepare'] = async (setParam) =>
  setParam('doc', await storeScannedPdf());
const scannedBanner = () =>
  waitFor(() => byText('Scanned pages', 'p, div, strong, h2, h3'), 'the scanned banner', 30_000);

/** Exam setup -> a short exam started. */
async function startExam(): Promise<void> {
  const count = await waitFor(() => $<HTMLInputElement>(tid('rv-exam-questions')), 'the count');
  setValue(count, '6');
  await clickTestId('rv-exam-start');
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
    const knew = [...document.querySelectorAll<HTMLElement>('label.rv-choice')].filter((l) =>
      l.textContent?.includes('I knew it'),
    );
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
    'deny-confirm': {
      run: async () => {
        await clickText('Allow StudyVault on mail.google.com');
        await waitFor(() => byText('Keep it off'), 'the confirmation');
      },
    },
    activated: {
      run: async () => {
        await clickText('Activate on this tab');
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
    'card-links': {
      run: async () => {
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
        await clickTestId('card-ai-toggle');
        await scrollTo(tid('ai-actions'));
      },
    },
    'ai-result': {
      prepare: aiConfigured,
      run: async () => {
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
    duplicates: {
      run: clickThen(() => clickTestId('view-duplicates'), '[data-testid="duplicates-view"]'),
    },
    trash: { run: clickThen(() => clickTestId('view-trash'), '[data-testid="trash-view"]') },
    storage: { run: clickThen(() => clickTestId('view-storage'), '[data-testid="storage-panel"]') },
    palette: { run: clickThen(() => clickTestId('open-palette'), DIALOG) },
    'new-bank': { run: clickThen(() => clickTestId('new-bank'), DIALOG) },
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
        await clickText('Study everything due');
        await waitFor(() => byText('Show answer') ?? byText('Show the answer'), 'a card');
      },
    },
    answer: {
      run: async () => {
        await clickText('Study everything due');
        await click(
          () => byText('Show answer') ?? byText('Show the answer'),
          'the Show answer button',
        );
        await waitFor(() => byText('Again'), 'the rating buttons');
      },
    },
    'create-highlight': {
      prepare: async (setParam) => setParam('highlight', await richHighlightId()),
    },
    'kp-editor': {
      prepare: async (setParam) => setParam('highlight', await richHighlightId()),
      run: async () => void (await scrollTo(tid('rv-kp-editor'))),
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
        await click(() => byText('Edit', `${tid('rv-browser')} button`), 'a card Edit button');
        await scrollTo(`${tid('rv-browser')} ${tid('rv-editor')}`);
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
    'delete-dialog': { run: clickThen(() => clickText('Delete all StudyVault data…'), DIALOG) },
    'all-sites-dialog': { run: clickThen(() => clickText('Enable on all sites'), DIALOG) },
    'ai-configured': { prepare: aiConfigured },
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
        chooseFile(await scrollTo<HTMLInputElement>(tid('backup-external-file')), FILES.anki());
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
        await clickText('Create the bank and folders');
        await waitFor(() => byText('Done', 'p, div, strong'), 'the created bank');
      },
    },
    skipped: {
      run: async () => {
        await clickText('Skip the tour');
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
        await waitFor(() => byText('This PDF is password protected', 'h2'), 'the password dialog');
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
