import {
  KIND_LABELS,
  defaultSettings,
  type AnchorSet,
  type BankLite,
  type CaptureResult,
  type FilingOutcome,
  type HighlightKind,
  type HighlightView,
  type Settings,
} from '@shared';
import { HOST_ATTRIBUTE, HighlightPainter, type PaintEntry } from '@highlights';
import type { CaptureHost, CaptureUi } from '../entrypoints/highlighter.content/contract';
import { mountCaptureUi } from '../entrypoints/highlighter.content/ui/mount';
import overlayCss from '../entrypoints/highlighter.content/ui/styles.css?inline';
import { findState } from './catalog';
import { $, byText, frames, sleep, waitFor } from './dom';

/**
 * The real in-page overlay (entrypoints/highlighter.content/ui) on a sample study page, one state
 * per address (`?state=`, catalog.json). It is mounted the way ui/index.tsx does it, in an open
 * shadow root with styles.css (WXT's `:root` -> `:host` rewrite done here), and rendered with React
 * instead of the extension's Preact. The page logic (controller.ts) is replaced by a fake
 * CaptureHost whose answers each state picks; highlights are painted by the real HighlightPainter.
 */

const BANKS: BankLite[] = [
  { id: 'bank-inbox-001', name: 'Inbox', color: 'blue', isInbox: true },
  { id: 'bank-pharm-001', name: 'Pharmacology', color: 'purple', isInbox: false },
  { id: 'bank-cardio-01', name: 'Cardiology', color: 'red', isInbox: false },
  { id: 'bank-micro-001', name: 'Microbiology', color: 'green', isInbox: false },
];
const [INBOX, PHARM, CARDIO] = BANKS as [BankLite, BankLite, BankLite];

const LOST = 'StudyVault lost contact with the extension. Reload this page, then try again.';
const TOO_SLOW = 'StudyVault is taking too long to respond. Try again in a moment.';
const never = <T,>() => new Promise<T>(() => undefined);

const ANCHOR: AnchorSet = {
  type: 'html',
  textAlgorithm: 'sv-text-v1',
  textQuote: { exact: 'x', prefix: '', suffix: '' },
  textPosition: { start: 0, end: 1 },
  structuralPath: null,
  contentSignature: 'gallery',
  documentTextLength: 4000,
};

let seq = 0;
function makeView(quote: string, kind: HighlightKind, over: Partial<HighlightView> = {}) {
  return {
    id: `hl-gallery-${String(++seq).padStart(4, '0')}`,
    sourceId: 'src-gallery-0001',
    exactQuote: quote,
    anchorSet: { ...ANCHOR, textQuote: { exact: quote, prefix: '', suffix: '' } },
    kind,
    color: settings.palette[kind],
    priority: 3,
    userComment: '',
    headingContext: null,
    bankIds: [PHARM.id],
    capturedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    resolveStatus: 'resolved',
    resolveConfidence: 1,
    ...over,
  } satisfies HighlightView;
}

/** A range over `phrase` inside the paragraph `id` (paragraph text is collapsed to one node). */
function rangeOf(id: string, phrase: string, endId = id, endPhrase = phrase): Range {
  const node = (pid: string) => document.getElementById(pid)!.firstChild as Text;
  const start = node(id);
  const end = node(endId);
  const at = start.data.indexOf(phrase);
  const to = end.data.indexOf(endPhrase);
  if (at < 0 || to < 0) throw new Error(`"${phrase}" is not in #${id}`);
  const range = document.createRange();
  range.setStart(start, at);
  range.setEnd(end, to + endPhrase.length);
  return range;
}

/** Scrolls so the range sits at `fraction` of the viewport height. */
function scrollTo(range: Range, fraction: number): void {
  const top = range.getBoundingClientRect().top + window.scrollY;
  window.scrollTo(0, Math.max(0, top - window.innerHeight * fraction));
}

// ---------------------------------------------------------------------------------------------
// The page: settings, painter, fake host
// ---------------------------------------------------------------------------------------------

const params = new URLSearchParams(location.search);
const theme = params.get('theme');
let settings: Settings = {
  ...defaultSettings(),
  ...(theme === 'light' || theme === 'dark' ? { theme } : {}),
  lastBankId: PHARM.id,
};

const painter = new HighlightPainter(document);
const painted: PaintEntry[] = [];
const paint = (id: string, kind: HighlightKind, range: Range) => {
  painted.push({ id, kind, color: settings.palette[kind], range });
  painter.paint(painted);
};

/** What the current selection is; the fake host saves it (the real controller keeps a clone). */
let selected: Range | null = null;

function created(kind: HighlightKind, bank: BankLite, filing?: FilingOutcome): CaptureResult {
  const view = makeView(selected?.toString() ?? '', kind, { bankIds: [bank.id] });
  if (selected) paint(view.id, kind, selected);
  return { status: 'created', highlight: view, bank, addedToBank: false, filing };
}

let ui: CaptureUi;
const host: CaptureHost = {
  settings: () => settings,
  save: async (req) => created(req.kind, PHARM),
  listBanks: async () => ({ banks: BANKS, lastBankId: PHARM.id }),
  createBank: async (name) => ({ id: 'bank-new-0001', name, color: 'teal', isInbox: false }),
  undo: async () => undefined,
  acceptFiling: async () => ({
    status: 'filed',
    ruleName: 'Cardiology reading',
    bank: CARDIO,
    folderName: 'Arrhythmias',
    addedTags: 1,
  }),
  dismissFiling: async () => undefined,
  undoFiling: async () => ({ restored: true, reason: null }),
  update: async (id, patch) => ({ ...popoverView, ...patch, id }),
  remove: async () => undefined,
  restore: async () => popoverView,
  dismissSelection: () => {
    selected = null;
    document.getSelection()?.removeAllRanges();
  },
  openInSidePanel: async () => true,
};

// ---------------------------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------------------------

const shadowRoot = () => document.querySelector('studyvault-overlay')!.shadowRoot!;
const inOverlay = <E extends Element = HTMLElement>(selector: string) =>
  $<E>(selector, shadowRoot());
const button = (name: string) => inOverlay(`button[aria-label="${name}"]`);

/** Selects a phrase on the page and shows the toolbar for it, as the controller does. */
async function select(range: Range, fraction: number): Promise<void> {
  scrollTo(range, fraction);
  await frames();
  document.getSelection()!.removeAllRanges();
  document.getSelection()!.addRange(range);
  selected = range;
  ui.showToolbar({ text: range.toString().trim(), rect: range.getBoundingClientRect() });
  await waitFor(() => inOverlay('.sv-unit[data-placement]'), 'the toolbar to be placed');
}

const rateSentence = () =>
  rangeOf('p-rate', 'Rate control with a beta blocker is the first-line strategy');
const selectMiddle = () => select(rateSentence(), 0.5);

async function clickInOverlay(find: () => HTMLElement | null, what: string): Promise<void> {
  (await waitFor(find, what)).click();
}

async function openComposer(): Promise<HTMLElement> {
  await selectMiddle();
  await clickInOverlay(() => button('More options'), 'More options');
  return waitFor(() => inOverlay('.sv-panel'), 'the Save with details panel');
}

/** Saves with the toolbar's Save button and waits for `count` toasts. */
async function saveAndToast(count = 1, buttonName = 'Save selection'): Promise<void> {
  await selectMiddle();
  await clickInOverlay(() => button(buttonName), buttonName);
  await waitFor(
    () => shadowRoot().querySelectorAll('.sv-toast').length >= count,
    `${count} toast(s)`,
  );
}

let popoverView = makeView(
  'mask the adrenergic warning signs of hypoglycaemia, such as tremor and palpitations',
  'exception',
  { headingContext: 'Cautions' },
);

async function openPopover(over: Partial<HighlightView> = {}): Promise<HTMLElement> {
  popoverView = { ...popoverView, ...over };
  const range = rangeOf('p-hypo', popoverView.exactQuote);
  scrollTo(range, 0.35);
  await frames();
  ui.showHighlightPopover(popoverView, range.getBoundingClientRect());
  return waitFor(
    () => inOverlay('[role="dialog"]:not([style*="hidden"])'),
    'the highlight popover',
  );
}

/** Picks the Weak area kind in the popover's kind row (radio buttons). */
async function changeType(dialog: HTMLElement): Promise<void> {
  const name = KIND_LABELS.weak_area.label;
  const radio = `.sv-kinds [role="radio"][aria-label="${name}"]`;
  (await waitFor(() => $<HTMLElement>(radio, dialog), `the ${name} kind`)).click();
}

const STATES: Record<string, () => Promise<void>> = {
  default: selectMiddle,
  'toolbar-below': () =>
    select(rangeOf('p-mechanism', 'Beta blockers compete with adrenaline and noradrenaline'), 0.02),
  'toolbar-edge': () =>
    select(
      rangeOf(
        'p-mechanism',
        'Beta blockers compete',
        'p-summary',
        'decision about anticoagulation.',
      ),
      // Starts above the viewport and ends below it: no room on either side.
      -0.4,
    ),
  'toolbar-caption': async () => {
    await selectMiddle();
    const formula = await waitFor(() => button('Save as Formula'), 'the Formula button');
    // React's onMouseEnter listens for mouseover from outside (relatedTarget null).
    formula.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, composed: true }));
  },
  'toolbar-focused': async () => {
    await selectMiddle();
    if (!ui.focusToolbar()) throw new Error('The toolbar did not take focus.');
  },
  'toolbar-busy': async () => {
    host.save = never;
    await selectMiddle();
    await clickInOverlay(() => button('Save selection'), 'Save');
    await waitFor(() => inOverlay('[role="toolbar"][aria-busy="true"]'), 'the busy toolbar');
  },
  'toolbar-compact': selectMiddle,
  composer: async () => {
    const panel = await openComposer();
    await waitFor(() => $('select', panel), 'the bank list');
  },
  'composer-loading': async () => {
    host.listBanks = never;
    await openComposer();
  },
  'composer-no-banks': async () => {
    host.listBanks = async () => ({ banks: [], lastBankId: null });
    const panel = await openComposer();
    await waitFor(() => $('select[disabled]', panel), 'the empty bank list');
  },
  'composer-error': async () => {
    host.listBanks = async () => {
      throw new Error(TOO_SLOW);
    };
    const panel = await openComposer();
    await waitFor(() => $('[role="alert"]', panel), 'the bank error');
  },
  'composer-saving': async () => {
    host.save = never;
    const panel = await openComposer();
    await waitFor(() => $('select', panel), 'the bank list');
    await clickInOverlay(() => byText('Save', 'button.sv-btn-primary, button', panel), 'Save');
  },
  popover: async () => {
    await openPopover();
  },
  'popover-note': async () => {
    await openPopover({
      userComment:
        'Sweating is the one warning sign that stays: ask about it when you take the history.',
      priority: 4,
    });
  },
  'popover-saved': async () => {
    const dialog = await openPopover();
    await changeType(dialog);
    await waitFor(() => byText('Saved', 'p, span, div', dialog), '"Saved"');
  },
  'popover-error': async () => {
    host.update = async () => {
      throw new Error(LOST);
    };
    const dialog = await openPopover();
    await changeType(dialog);
    await waitFor(() => byText('Could not save', 'p, span, div', dialog), 'the save error');
  },
  'popover-deleting': async () => {
    host.remove = never;
    const dialog = await openPopover();
    await clickInOverlay(() => byText('Delete', 'button', dialog), 'Delete');
    await waitFor(() => byText('Deleting', 'p, span, div, button', dialog), '"Deleting"');
  },
  'toast-saved': () => saveAndToast(),
  'toast-xp': async () => {
    // Game mode on: the worker reports the quick save's XP and the toast shows "+2 XP".
    host.save = async (req) => ({ ...created(req.kind, PHARM), xp: 2 });
    await saveAndToast();
    await waitFor(() => inOverlay('.sv-toast .sv-xp'), 'the +2 XP chip');
  },
  'toast-note': () => saveAndToast(1, 'Save and add a note in the side panel'),
  'toast-error': async () => {
    host.save = async () => {
      throw new Error(LOST);
    };
    await saveAndToast();
  },
  'toast-retry': async () => {
    // The controller reports its own failures, with Retry for transient ones (controller.ts).
    host.save = async () => {
      ui.toast({ text: TOO_SLOW, tone: 'error', action: { label: 'Retry', run: () => undefined } });
      throw new Error(TOO_SLOW);
    };
    await saveAndToast();
  },
  'toast-filed': async () => {
    host.save = async (req) =>
      created(req.kind, INBOX, {
        status: 'filed',
        ruleName: 'Cardiology reading',
        bank: CARDIO,
        folderName: 'Arrhythmias',
        addedTags: 1,
      });
    await saveAndToast();
  },
  'toast-suggested': async () => {
    host.save = async (req) =>
      created(req.kind, INBOX, {
        status: 'suggested',
        ruleName: 'Cardiology reading',
        bank: CARDIO,
        folderName: 'Arrhythmias',
        addedTags: 0,
      });
    await saveAndToast(2);
  },
  'toast-unavailable': async () => {
    host.save = async (req) =>
      created(req.kind, INBOX, {
        status: 'unavailable',
        ruleName: 'Cardiology reading',
        reason: 'The highlight stays where it was saved: its bank no longer exists.',
      });
    await saveAndToast(1);
  },
  'toast-deleted': async () => {
    const dialog = await openPopover();
    await clickInOverlay(() => byText('Delete', 'button', dialog), 'Delete');
    await waitFor(() => byText('Highlight deleted', '.sv-toast', shadowRoot()), 'the toast');
  },
  'toast-stack': async () => {
    host.save = async (req) =>
      created(req.kind, INBOX, {
        status: 'suggested',
        ruleName: 'Cardiology reading',
        bank: CARDIO,
        folderName: 'Arrhythmias',
        addedTags: 0,
      });
    await saveAndToast(2);
    ui.toast({ text: TOO_SLOW, tone: 'error', action: { label: 'Retry', run: () => undefined } });
    await waitFor(() => shadowRoot().querySelectorAll('.sv-toast').length >= 3, '3 toasts');
  },
};

export async function start(): Promise<void> {
  const html = document.documentElement;
  html.dataset.gallery = 'seeding';
  if (theme === 'light' || theme === 'dark') html.dataset.theme = theme;
  try {
    const stateId = params.get('state') ?? 'default';
    findState('overlay', stateId);
    const run = STATES[stateId];
    if (!run) throw new Error(`overlay.tsx has no script for state "${stateId}".`);
    if (stateId === 'toolbar-compact') settings = { ...settings, density: 'compact' };

    // One text node per paragraph, so a phrase is one offset pair (rendering is unchanged).
    for (const p of document.querySelectorAll('article p')) {
      p.textContent = (p.textContent ?? '').replace(/\s+/g, ' ').trim();
    }
    paint(
      'hl-painted-0001',
      'essential',
      rangeOf('p-selectivity', 'Selectivity is relative rather than absolute'),
    );
    paint('hl-painted-0002', 'exception', rangeOf('p-hypo', popoverView.exactQuote));
    paint(
      'hl-painted-0003',
      'weak_area',
      rangeOf('p-withdrawal', 'Taper the dose over one to two weeks'),
    );
    paint('hl-painted-0004', 'differential', rangeOf('p-stroke', 'CHA2DS2-VASc score'));

    // As ui/index.tsx mounts it (WXT createShadowRootUi), with the shadow root open.
    const shadowHost = document.createElement('studyvault-overlay');
    shadowHost.setAttribute(HOST_ATTRIBUTE, '');
    document.documentElement.append(shadowHost);
    const shadow = shadowHost.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = overlayCss.replaceAll(':root', ':host');
    const container = document.createElement('div');
    shadow.append(style, container);
    ui = mountCaptureUi({ container, shadowHost, host });
    Object.assign(window, {
      __gallery: {
        setTheme: async (next: 'light' | 'dark') => {
          html.dataset.theme = next;
          settings = { ...settings, theme: next };
          ui.applySettings(settings);
          await frames();
        },
      },
    });

    await frames();
    await run();
    // A pointer resting on the toasts holds them (WCAG 2.2.1), so a slow capture still sees them.
    for (const toast of shadowRoot().querySelectorAll('.sv-toast')) {
      toast.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, composed: true }));
    }
    await sleep(100);
    html.dataset.gallery = 'mounted';
  } catch (err) {
    html.dataset.gallery = 'error';
    const box = document.createElement('pre');
    box.setAttribute('role', 'alert');
    box.style.cssText =
      'position:relative;margin:16px;padding:12px;border:2px solid #b91c1c;white-space:pre-wrap';
    box.textContent = `Gallery could not show the overlay:\n${err instanceof Error ? (err.stack ?? err.message) : String(err)}`;
    document.body.prepend(box);
    throw err;
  }
}
