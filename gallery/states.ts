import { updateSettings } from '@runtime';
import { patchSettings } from './scenarios/kit';
import {
  listBanks,
  listDocuments,
  listPageHighlights,
  listPdfHighlights,
  listRecentHighlights,
} from '@storage';
import { TAB_PRESETS } from './scenarios/tabs';
import type { Surface } from './boot';
import { $, byText, click, clickTestId, clickText, frames, setValue, waitFor } from './dom';
import { browser } from './shim/chrome';

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
  },
  options: {
    'ai-on': {
      prepare: async () =>
        void (await updateSettings((s) => ({ ...s, features: { ...s.features, ai: true } }))),
    },
    'delete-dialog': { run: clickThen(() => clickText('Delete all StudyVault data…'), DIALOG) },
    'all-sites-dialog': { run: clickThen(() => clickText('Enable on all sites'), DIALOG) },
  },
  onboarding: {
    privacy: tourAt('privacy'),
    access: tourAt('access'),
    banks: tourAt('banks'),
    'banks-medicine': tourAt('banks', 'medicine'),
    look: tourAt('look'),
    keys: tourAt('keys'),
    done: tourAt('done'),
    skipped: {
      run: async () => {
        await clickText('Skip the tour');
        await waitFor(() => byText('Tour skipped', 'h1, h2'), '"Tour skipped"');
      },
    },
  },
  'pdf-reader': {
    default: pdfOpened,
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
