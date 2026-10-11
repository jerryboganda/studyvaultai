import AxeBuilder from '@axe-core/playwright';
import {
  expect as baseExpect,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';
import {
  OVERLAY_HOST,
  activate as activateFixturePage,
  bg,
  bgData,
  highlightsOf,
  toolbarOf,
  tripleClickBlock,
  type Env,
} from './helpers.pages';

/**
 * Longer expect timeout than the suite default: these flows chain real IndexedDB transactions,
 * extension messaging and real input, and the local machine is shared with other build jobs.
 */
export const expect = baseExpect.configure({ timeout: 30_000 });

/**
 * Helpers for the retention-system E2E (review.spec.ts). Real Chromium, the real built extension,
 * real keyboard/mouse input. Nothing mocks a Chrome API.
 *
 * Time. The review page reads `Date.now()` for every scheduling decision, and a browser's clock
 * cannot be changed from a test, so the tests pin it with Playwright's clock (`context.clock`),
 * which replaces `Date` inside every page of the context, extension pages included. The clock is
 * set BEFORE the page that must see it is opened (a page keeps the `Date.now` it captured at load).
 * Everything else (IndexedDB, chrome.storage, the DOM) is real.
 *
 * Direct IndexedDB access is used for two things only, both documented where used: READING the
 * database to assert what was really persisted (`readStudyDb`), and seeding one AI-made card
 * (`seedAiCard`), because creating one through the UI needs a configured AI provider and network.
 */

// -----------------------------------------------------------------------------------------------
// Data-test ids (copied from packages/ui/src/review/testids.ts on purpose: nothing is imported)
// -----------------------------------------------------------------------------------------------

export const TID = {
  deckPicker: 'rv-deck-picker',
  deckEmpty: 'rv-deck-empty',
  startAll: 'rv-start-all',
  continue: 'rv-continue',
  discard: 'rv-discard-session',
  dueTotal: 'rv-due-total',
  dueNew: 'rv-due-new',
  dueLearning: 'rv-due-learning',
  dueReview: 'rv-due-review',
  deferredNote: 'rv-deferred-note',
  nextLearning: 'rv-next-learning',
  session: 'rv-session',
  progress: 'rv-progress',
  progressText: 'rv-progress-text',
  card: 'rv-card',
  question: 'rv-question',
  answer: 'rv-answer',
  reveal: 'rv-reveal',
  unverified: 'rv-unverified',
  verify: 'rv-verify',
  choices: 'rv-choices',
  mcqResult: 'rv-mcq-result',
  mcqExplanation: 'rv-mcq-explanation',
  ratings: 'rv-ratings',
  undo: 'rv-undo',
  edit: 'rv-edit',
  suspend: 'rv-suspend',
  bury: 'rv-bury',
  source: 'rv-source',
  explain: 'rv-explain',
  explainPanel: 'rv-explain-panel',
  explainQuote: 'rv-explain-quote',
  notice: 'rv-notice',
  waiting: 'rv-waiting',
  waitNow: 'rv-wait-now',
  leave: 'rv-leave',
  summary: 'rv-summary',
  summaryAnswered: 'rv-summary-answered',
  summaryNext: 'rv-summary-next',
  summaryAgain: 'rv-summary-again',
  backlog: 'rv-backlog',
  backlogDays: 'rv-backlog-days',
  backlogPlan: 'rv-backlog-plan',
  backlogApply: 'rv-backlog-apply',
  backlogResult: 'rv-backlog-result',
  author: 'rv-author',
  manual: 'rv-manual',
  editor: 'rv-editor',
  preview: 'rv-preview',
  previewIssues: 'rv-preview-issues',
  clozeText: 'rv-cloze-text',
  clozeWrap: 'rv-cloze-wrap',
  clozeIndex: 'rv-cloze-index',
  clozeHint: 'rv-cloze-hint',
  deckSelect: 'rv-deck-select',
  saveCards: 'rv-save-cards',
  bulk: 'rv-bulk',
  bulkCreate: 'rv-bulk-create',
  browser: 'rv-browser',
  browserFilter: 'rv-browser-filter',
  browserSearch: 'rv-browser-search',
  browserDeck: 'rv-browser-deck',
  newDeckName: 'rv-new-deck-name',
  newDeck: 'rv-new-deck',
  deckSettingsSave: 'rv-deck-settings-save',
  deckSettingsReset: 'rv-deck-settings-reset',
  studyDay: 'rv-study-day',
  timeZone: 'rv-time-zone',
  rollover: 'rv-rollover',
  studyDaySave: 'rv-study-day-save',
  analytics: 'rv-analytics',
  analyticsEmpty: 'rv-analytics-empty',
  forecast: 'rv-forecast',
  forecastTable: 'rv-forecast-table',
  retention: 'rv-retention',
  retentionInsufficient: 'rv-retention-insufficient',
  studyLog: 'rv-study-log',
  streak: 'rv-streak',
  counts: 'rv-counts',
  backlogStats: 'rv-backlog-stats',
} as const;

export const ratingId = (rating: Rating) => `rv-rate-${rating}`;
export const choiceId = (index: number) => `rv-choice-${index}`;
export const blankId = (index: number) => `rv-blank-${index}`;

export type Rating = 1 | 2 | 3 | 4;
export const RATING_NAMES: Record<Rating, string> = { 1: 'Again', 2: 'Hard', 3: 'Good', 4: 'Easy' };

// -----------------------------------------------------------------------------------------------
// Time
// -----------------------------------------------------------------------------------------------

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
/** Tuesday 2026-03-10 12:00 UTC: the pinned "now" of the time-dependent tests. */
export const T0 = Date.UTC(2026, 2, 10, 12, 0, 0);
/** The study-day settings the time tests run under (no DST in UTC, so every number is exact). */
export const UTC_DAY = { timeZone: 'UTC', rolloverHour: 4 } as const;

/** First instant of the UTC-based study day that contains `ms`. */
export function studyDayStart(ms: number, rolloverHour = 4): number {
  const shift = rolloverHour * HOUR;
  return Math.floor((ms - shift) / DAY) * DAY + shift;
}

export const iso = (ms: number): string => new Date(ms).toISOString();

export interface Ctx {
  context: BrowserContext;
  extensionId: string;
  /** http://127.0.0.1:PORT of the fixture server. */
  origin: string;
}

/** Pin `Date` in every page of the context (set it before opening the page that must see it). */
export async function setClock(ctx: Ctx, ms: number): Promise<void> {
  await ctx.context.clock.setFixedTime(ms);
}

// -----------------------------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------------------------

const ERRORS = new WeakMap<Page, string[]>();

export function trackErrors(page: Page): void {
  const errors: string[] = [];
  ERRORS.set(page, errors);
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
}

export const pageErrors = (page: Page): string[] => ERRORS.get(page) ?? [];

// -----------------------------------------------------------------------------------------------
// Opening the review page and the study-day settings
// -----------------------------------------------------------------------------------------------

export interface StudySettingsPatch {
  timeZone?: string;
  rolloverHour?: number;
  interleave?: 'deck' | 'bank' | 'none';
  order?: 'retrievability' | 'due';
  newOrder?: 'created' | 'random';
  learnAheadMinutes?: number;
}

/** Write the study settings the way the Settings view persists them (own storage key). */
export async function writeStudySettings(page: Page, patch: StudySettingsPatch): Promise<void> {
  await page.evaluate(async (p) => {
    const key = 'studySettings';
    const stored = (await chrome.storage.local.get(key))[key] as
      Record<string, unknown> | undefined;
    await chrome.storage.local.set({ [key]: { schemaVersion: 1, ...(stored ?? {}), ...p } });
  }, patch);
}

export async function openReview(
  ctx: Ctx,
  opts: { query?: string; settings?: StudySettingsPatch } = {},
): Promise<Page> {
  const page = await ctx.context.newPage();
  trackErrors(page);
  await page.goto(`chrome-extension://${ctx.extensionId}/review.html${opts.query ?? ''}`);
  if (opts.settings) {
    await writeStudySettings(page, opts.settings);
    await page.reload();
  }
  await expect(page.getByRole('heading', { name: 'Review', level: 1 })).toBeVisible();
  return page;
}

export type ReviewTab = 'Study' | 'Create cards' | 'Cards' | 'Analytics' | 'Settings';

export async function gotoTab(page: Page, tab: ReviewTab): Promise<void> {
  await page.getByRole('tab', { name: tab, exact: true }).click();
  await expect(page.getByRole('tab', { name: tab, exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
}

// -----------------------------------------------------------------------------------------------
// Highlights through the real toolbar
// -----------------------------------------------------------------------------------------------

export interface Captured {
  id: string;
  quote: string;
}

const PERSISTENT = new WeakMap<BrowserContext, boolean>();

/**
 * True when captureHighlights could register the content script for the fixture origin, so that a
 * tab the PRODUCT opens later (Jump to source) also runs it. When false the highlights were saved
 * through `tab.activate` and a product-opened tab has no content script.
 */
export const hasPersistentAccess = (ctx: Ctx): boolean => PERSISTENT.get(ctx.context) === true;

/**
 * Best effort: persistent site access for the fixture origin (a registered content script). It has
 * no 5 s activation deadline (which a busy machine misses) and it makes a tab opened later by "Jump
 * to source" run the content script. The origin is stored through the worker's `updateSettings`
 * (the e2e-build hook of entrypoints/background/e2e.ts: the worker ignores a raw
 * chrome.storage.local write) and the outcome is CHECKED through `site.sync`; false is returned
 * (never thrown) when the worker did not register the origin.
 */
async function ensurePersistentAccess(ctx: Ctx, ext: Page): Promise<boolean> {
  const pattern = `${ctx.origin}/*`;
  const stored = await ext.evaluate(async (origin) => {
    const current = ((await chrome.storage.local.get('settings')).settings ?? {}) as {
      persistentOrigins?: string[];
    };
    const have: string[] = current.persistentOrigins ?? [];
    if (have.includes(origin)) return true;
    const reply = (await chrome.runtime.sendMessage({
      v: 1,
      type: 'e2e.settings.patch',
      payload: { json: JSON.stringify({ persistentOrigins: [...have, origin] }) },
    })) as { ok?: boolean } | undefined;
    return reply?.ok === true;
  }, pattern);
  if (!stored) return false;
  // The worker answers within 15 s on an idle machine; on a busy one the first call can miss it,
  // which says nothing about the flows under test, so ask again (at most three times).
  let sync = await bg(ext, 'site.sync');
  for (let attempt = 1; attempt < 3 && !sync.ok; attempt++) sync = await bg(ext, 'site.sync');
  if (!sync.ok) return false;
  return (sync.data as { registeredMatches: string[] }).registeredMatches.includes(pattern);
}

/** `tab.activate` (activeTab path) with a reload between attempts: it has a 5 s deadline. */
async function activateWithRetry(ctx: Ctx, page: Page): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await activateFixturePage(ctx as unknown as Env, page);
      return;
    } catch (err) {
      last = err;
      await page.reload();
    }
  }
  throw last;
}

/** The content script runs in `page` and has finished its first rehydration. */
async function waitForContentScript(ext: Page, page: Page): Promise<void> {
  await expect(page.locator(OVERLAY_HOST)).toHaveCount(1, { timeout: 90_000 });
  await expect
    .poll(
      () =>
        ext.evaluate(async (pageUrl) => {
          const tab = (await chrome.tabs.query({})).find((t) => t.url === pageUrl);
          if (tab?.id === undefined) return 'no tab';
          try {
            const reply = await chrome.tabs.sendMessage(tab.id, {
              v: 1,
              type: 'content.pageStatus',
              payload: {},
            });
            return reply ? 'ready' : 'no reply';
          } catch (err) {
            return `not yet: ${String((err as Error)?.message ?? err)}`;
          }
        }, page.url()),
      { message: 'content script should finish its first rehydration', timeout: 90_000 },
    )
    .toBe('ready');
}

/** One toolbar save: real triple-click on `selector`, real click on the toolbar button. */
async function saveOne(ext: Page, page: Page, selector: string, bank?: string): Promise<void> {
  const before = (await highlightsOf(ext, page.url())).length;
  await page.bringToFront();
  await tripleClickBlock(page, selector);
  await expect(toolbarOf(page)).toBeVisible();
  if (bank) {
    await page.getByRole('button', { name: 'More options', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Save with details' });
    await dialog.getByRole('combobox', { name: 'Bank' }).selectOption({ label: bank });
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  } else {
    await page.getByRole('button', { name: 'Save selection', exact: true }).click();
  }
  await expect
    .poll(async () => (await highlightsOf(ext, page.url())).length, {
      message: `highlight ${selector} was stored`,
    })
    .toBe(before + 1);
}

/**
 * Open `path` of the fixture server (the content script runs through persistent site access when
 * the worker registers it, else through `tab.activate`) and save each `#id` block with a real triple-click and the real toolbar. With `bank`, the
 * highlight is filed through the toolbar's "More options" composer (the bank is created first).
 */
export async function captureHighlights(
  ctx: Ctx,
  path: string,
  selectors: readonly string[],
  opts: { bank?: string } = {},
): Promise<Captured[]> {
  const ext = await ctx.context.newPage();
  await ext.goto(`chrome-extension://${ctx.extensionId}/options.html`);
  const page = await ctx.context.newPage();
  try {
    const persistent = await ensurePersistentAccess(ctx, ext);
    PERSISTENT.set(ctx.context, persistent);
    await page.goto(`${ctx.origin}${path}`);
    if (!persistent) await activateWithRetry(ctx, page);
    await waitForContentScript(ext, page);
    if (opts.bank) {
      const { banks } = await bgData<{ banks: Array<{ name: string }> }>(ext, 'banks.list');
      if (!banks.some((b) => b.name === opts.bank)) {
        await bgData(ext, 'bank.create', { name: opts.bank });
      }
    }
    for (const selector of selectors) {
      await saveOne(ext, page, selector, opts.bank);
    }
    const rows = await highlightsOf(ext, page.url());
    return rows.map((r) => ({ id: r.id, quote: r.exactQuote }));
  } finally {
    await page.close();
    await ext.close();
  }
}

// -----------------------------------------------------------------------------------------------
// The database, read raw (what was really persisted)
// -----------------------------------------------------------------------------------------------

export interface FsrsRow {
  state: 'new' | 'learning' | 'review' | 'relearning';
  due: string;
  stability: number;
  difficulty: number;
  elapsedDays: number;
  scheduledDays: number;
  learningSteps: number;
  reps: number;
  lapses: number;
  lastReview: string | null;
}

export interface CardRow {
  id: string;
  deckId: string;
  highlightId: string | null;
  sourceQuote: string | null;
  cardType: 'basic' | 'cloze' | 'definition' | 'compare' | 'mcq';
  front: string;
  back: string;
  cloze: { text: string; activeIndex: number | null } | null;
  choices?: Array<{ id: string; text: string }>;
  answerChoiceId?: string;
  explanation?: string;
  tags: string[];
  suspended: boolean;
  buriedUntil: string | null;
  needsHumanVerification: boolean;
  dueAt: string;
  fsrs: FsrsRow;
  createdBy: 'user' | 'ai';
  aiResultId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface LogRow {
  id: string;
  cardId: string;
  reviewedAt: string;
  rating: Rating;
  durationMs: number;
  sessionId: string;
  previousState: FsrsRow;
  nextState: FsrsRow;
  scheduledDays: number;
  elapsedDays: number;
  leech: boolean;
  userCorrection?: { kind: 'undone'; at: string };
}

export interface DeckRow {
  id: string;
  name: string;
  bankId: string | null;
  deletedAt: string | null;
  updatedAt: string;
  settings: {
    newPerDay: number;
    reviewsPerDay: number;
    targetRetention: number;
    learningSteps: string[];
    relearnSteps: string[];
    maxIntervalDays: number;
    enableFuzz: boolean;
    leechThreshold: number;
  };
}

export interface StudyDb {
  decks: DeckRow[];
  cards: CardRow[];
  logs: LogRow[];
  /** The persisted review session (meta table), or null. */
  session: {
    id: string;
    pending: string[];
    learning: Array<{ cardId: string; dueAt: string }>;
    answered: number;
    dayNumber: number;
    lastAnswer: { cardId: string; logId: string; rating: Rating } | null;
  } | null;
}

/** Raw read of IndexedDB "studyvault" from any extension page. Never upgrades, never writes. */
export async function readStudyDb(page: Page): Promise<StudyDb> {
  return page.evaluate(async () => {
    const empty = { decks: [], cards: [], logs: [], session: null };
    const known = await indexedDB.databases();
    if (!known.some((d) => d.name === 'studyvault')) return empty as never;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('studyvault');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      const names = Array.from(db.objectStoreNames);
      const all = (store: string) =>
        new Promise<unknown[]>((resolve, reject) => {
          if (!names.includes(store)) return resolve([]);
          const req = db.transaction(store, 'readonly').objectStore(store).getAll();
          req.onsuccess = () => resolve(req.result as unknown[]);
          req.onerror = () => reject(req.error);
        });
      const meta = (await all('meta')) as Array<{ key: string; value: unknown }>;
      return {
        decks: (await all('decks')) as never,
        cards: (await all('cards')) as never,
        logs: (await all('reviewLogs')) as never,
        session: (meta.find((m) => m.key === 'studySession')?.value ?? null) as never,
      };
    } finally {
      db.close();
    }
  });
}

export const liveCards = (db: StudyDb): CardRow[] => db.cards.filter((c) => c.deletedAt === null);
export const countedLogs = (db: StudyDb): LogRow[] => db.logs.filter((l) => !l.userCorrection);
export const cardByFront = (db: StudyDb, front: string): CardRow => {
  const hit = db.cards.find((c) => c.front === front && c.deletedAt === null);
  if (!hit) throw new Error(`no card with front ${JSON.stringify(front)}`);
  return hit;
};

/**
 * Seed ONE AI-made card by a direct IndexedDB put. There is no UI path that does not need a
 * configured AI provider and a network round trip, which this suite does not have. The row is a
 * clone of an existing (UI-made, valid) card, so every field the schema requires is present;
 * only `id`, `createdBy`, `aiResultId`, `needsHumanVerification` and the wording differ, exactly
 * what `buildAccept` in packages/ui/src/ai/accept.ts produces. It is a real, schema-valid row:
 * the review page reads it back through the same validated readers as any other card.
 */
export async function seedAiCard(
  page: Page,
  template: CardRow,
  wording: { front: string; back: string },
): Promise<string> {
  return page.evaluate(
    async ({ template, wording }) => {
      const id = crypto.randomUUID();
      const row = {
        ...template,
        id,
        front: wording.front,
        back: wording.back,
        cloze: null,
        cardType: 'basic',
        createdBy: 'ai',
        aiResultId: crypto.randomUUID(),
        needsHumanVerification: true,
        tags: [],
      };
      delete (row as { choices?: unknown }).choices;
      delete (row as { answerChoiceId?: unknown }).answerChoiceId;
      delete (row as { explanation?: unknown }).explanation;
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('studyvault');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('cards', 'readwrite');
          tx.objectStore('cards').put(row);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } finally {
        db.close();
      }
      return id;
    },
    { template, wording },
  );
}

// -----------------------------------------------------------------------------------------------
// Card authoring (the author view)
// -----------------------------------------------------------------------------------------------

export type CardSpec =
  | { t: 'basic'; question: string; answer: string; explanation?: string; tags?: string }
  | { t: 'cloze'; markup: string; perDeletion?: boolean; explanation?: string }
  | { t: 'definition'; term: string; definition: string; example?: string }
  | {
      t: 'compare';
      left: string;
      right: string;
      rows: Array<{ aspect: string; left: string; right: string }>;
    }
  | {
      t: 'mcq';
      stem: string;
      choices: string[];
      correct: number;
      explanation?: string;
    };

const TEMPLATE_TAB: Record<CardSpec['t'], string> = {
  basic: 'Question and answer',
  cloze: 'Fill in the blank',
  definition: 'Term and definition',
  compare: 'Compare',
  mcq: 'Multiple choice',
};

/** Fill the (single, visible) card editor for `spec`; does not save. */
export async function fillEditor(page: Page, spec: CardSpec): Promise<Locator> {
  const editor = page.getByTestId(TID.editor);
  await expect(editor).toBeVisible();
  await editor.getByRole('tab', { name: TEMPLATE_TAB[spec.t], exact: true }).click();
  switch (spec.t) {
    case 'basic':
      await editor.getByRole('textbox', { name: 'Question', exact: true }).fill(spec.question);
      await editor.getByRole('textbox', { name: 'Answer', exact: true }).fill(spec.answer);
      if (spec.explanation) {
        await editor
          .getByRole('textbox', { name: 'Explanation (optional)', exact: true })
          .fill(spec.explanation);
      }
      if (spec.tags) {
        await editor
          .getByRole('textbox', { name: 'Tags (comma separated, optional)' })
          .fill(spec.tags);
      }
      break;
    case 'cloze': {
      await editor.getByTestId(TID.clozeText).fill(spec.markup);
      const box = editor.getByRole('checkbox', { name: /One card per deletion number/ });
      if (spec.perDeletion === false) await box.uncheck();
      else await box.check();
      if (spec.explanation) {
        await editor
          .getByRole('textbox', { name: 'Explanation (optional)', exact: true })
          .fill(spec.explanation);
      }
      break;
    }
    case 'definition':
      await editor.getByRole('textbox', { name: 'Term', exact: true }).fill(spec.term);
      await editor.getByRole('textbox', { name: 'Definition', exact: true }).fill(spec.definition);
      if (spec.example) {
        await editor
          .getByRole('textbox', { name: 'Example (optional)', exact: true })
          .fill(spec.example);
      }
      break;
    case 'compare': {
      await editor.getByRole('textbox', { name: 'First item', exact: true }).fill(spec.left);
      await editor.getByRole('textbox', { name: 'Second item', exact: true }).fill(spec.right);
      const aspects = editor.locator('fieldset', { hasText: 'Aspects' });
      for (let i = 0; i < spec.rows.length; i++) {
        if (i > 0) await aspects.getByRole('button', { name: 'Add aspect' }).click();
        const row = spec.rows[i]!;
        const inputs = aspects.locator('li').nth(i).locator('input');
        await inputs.nth(0).fill(row.aspect);
        await inputs.nth(1).fill(row.left);
        await inputs.nth(2).fill(row.right);
      }
      break;
    }
    case 'mcq':
      await editor.getByRole('textbox', { name: 'Question', exact: true }).fill(spec.stem);
      for (let i = 0; i < spec.choices.length; i++) {
        if (i >= 4) await editor.getByRole('button', { name: 'Add option' }).click();
        await editor
          .getByRole('textbox', { name: `Option ${i + 1} text`, exact: true })
          .fill(spec.choices[i]!);
      }
      await editor
        .getByRole('radio', { name: `Option ${spec.correct + 1} is correct`, exact: true })
        .check();
      if (spec.explanation) {
        await editor
          .getByRole('textbox', { name: 'Why the answer is right (optional)', exact: true })
          .fill(spec.explanation);
      }
      break;
  }
  await expectUniqueControlNames(editor, `card editor (${spec.t})`);
  return editor;
}

/**
 * Accessible names of the controls (fields and tabs) inside `scope`: aria-label or the text of the
 * associated <label>. (A tab panel is named by its own tab by design, so panels are not listed; a
 * panel can only collide with a field through its tab's name, which is listed.)
 */
export async function controlNames(scope: Locator): Promise<string[]> {
  return scope.evaluate((root) => {
    const names: string[] = [];
    const nameOf = (el: Element): string => {
      const aria = el.getAttribute('aria-label');
      if (aria) return aria;
      const by = el.getAttribute('aria-labelledby');
      if (by) {
        return by
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .join(' ');
      }
      const labels = (el as HTMLInputElement).labels;
      if (labels && labels.length > 0) {
        return Array.from(labels)
          .map((l) => l.textContent ?? '')
          .join(' ');
      }
      return el.getAttribute('role') === 'tab' ? (el.textContent ?? '') : '';
    };
    for (const el of root.querySelectorAll('input, textarea, select, [role="tab"]')) {
      const name = nameOf(el).replace(/\s+/g, ' ').trim();
      if (name !== '') names.push(name);
    }
    return names;
  });
}

/** No two controls of `scope` may share one accessible name (a screen reader user could not tell them apart). */
export async function expectUniqueControlNames(scope: Locator, what: string): Promise<void> {
  const names = await controlNames(scope);
  const seen = new Set<string>();
  const dupes = names.filter((n) => {
    const key = n.toLowerCase();
    const dup = seen.has(key);
    seen.add(key);
    return dup;
  });
  expect(dupes, `${what}: controls that share an accessible name`).toEqual([]);
}

export async function cardCount(page: Page): Promise<number> {
  return liveCards(await readStudyDb(page)).length;
}

/** Fill and save the visible card editor; waits until the new cards are in the database. */
export async function saveEditor(page: Page, spec: CardSpec, expectedNew: number): Promise<void> {
  const before = await cardCount(page);
  await fillEditor(page, spec);
  await expect(page.getByTestId(TID.saveCards)).not.toHaveAttribute('aria-disabled', 'true');
  await page.getByTestId(TID.saveCards).click();
  await expect
    .poll(() => cardCount(page), { message: 'cards were stored' })
    .toBe(before + expectedNew);
  // The editor clears itself a moment AFTER the cards are stored; typing into it before that would
  // be wiped. Its preview going back to the empty prompt is the signal that it is ready again.
  await expect(page.getByTestId(TID.preview)).toContainText(
    'Fill in the fields above to see the card.',
  );
}

/** Author tab, a highlight from the picker, then the editor. */
export async function openHighlightInAuthor(page: Page, highlightId: string): Promise<void> {
  await gotoTab(page, 'Create cards');
  await page.getByTestId(`rv-pick-${highlightId}`).getByRole('button').click();
  await expect(page.getByTestId(TID.editor)).toBeVisible();
}

/** Author tab, "Typed card": a free-standing card with no source. */
export async function openTypedCard(page: Page): Promise<void> {
  await gotoTab(page, 'Create cards');
  await page.getByRole('tab', { name: 'Typed card', exact: true }).click();
  await expect(page.getByTestId(TID.manual)).toBeVisible();
}

/**
 * `count` free-standing basic-looking cards in one save: one cloze text with `count` deletions,
 * one card per deletion. Fast way to a deck of N cards through the real author UI.
 */
export async function createTypedClozeCards(page: Page, count: number): Promise<void> {
  const markup = Array.from({ length: count }, (_, i) => `term {{c${i + 1}::answer${i + 1}}}`).join(
    '; ',
  );
  await openTypedCard(page);
  await saveEditor(page, { t: 'cloze', markup, perDeletion: true }, count);
}

// -----------------------------------------------------------------------------------------------
// Study view and session
// -----------------------------------------------------------------------------------------------

export interface DueNumbers {
  total: number;
  new: number;
  learning: number;
  review: number;
}

const firstInt = (text: string | null): number => Number(/\d+/.exec(text ?? '')?.[0] ?? NaN);

export async function dueNumbers(page: Page): Promise<DueNumbers> {
  await expect(page.getByTestId(TID.deckPicker)).toBeVisible();
  const text = (id: string) => page.getByTestId(id).textContent();
  return {
    total: firstInt(await text(TID.dueTotal)),
    new: firstInt(await text(TID.dueNew)),
    learning: firstInt(await text(TID.dueLearning)),
    review: firstInt(await text(TID.dueReview)),
  };
}

/** Wait for the deck picker to settle on `total` due cards. */
export async function expectDue(page: Page, total: number): Promise<void> {
  await expect(page.getByTestId(TID.dueTotal)).toHaveText(String(total));
}

export async function startAll(page: Page): Promise<void> {
  await page.getByTestId(TID.startAll).click();
  await expect(page.getByTestId(TID.session)).toBeVisible();
}

/** What the four rating buttons promise, read from the screen. */
export async function previewLabels(page: Page): Promise<Record<Rating, string>> {
  const out = {} as Record<Rating, string>;
  for (const r of [1, 2, 3, 4] as const) {
    out[r] =
      (await page.getByTestId(ratingId(r)).locator('.rv-rating__interval').textContent())?.trim() ??
      '';
  }
  return out;
}

/** Show the answer with the keyboard. */
export async function reveal(page: Page): Promise<void> {
  await expect(page.getByTestId(TID.reveal)).toBeVisible();
  await page.keyboard.press('Space');
  await expect(page.getByTestId(TID.ratings)).toBeVisible();
}

/** Press a rating key and wait until the answer is stored and the next state is on screen. */
export async function rateKey(page: Page, rating: Rating): Promise<void> {
  await page.keyboard.press(String(rating));
  await expect(page.getByTestId(TID.ratings)).toHaveCount(0);
}

/** Reveal with Space and rate with the number key. */
export async function answerWith(page: Page, rating: Rating): Promise<void> {
  await reveal(page);
  await rateKey(page, rating);
}

export type SessionKind = 'card' | 'done' | 'waiting' | 'none';

/** What the session surface shows right now (never throws; 'none' while it is changing). */
export async function sessionKind(page: Page): Promise<SessionKind> {
  if (await page.getByTestId(TID.reveal).isVisible()) return 'card';
  if (await page.getByTestId(TID.summary).isVisible()) return 'done';
  if (await page.getByTestId(TID.waiting).isVisible()) return 'waiting';
  return 'none';
}

export async function settledSession(page: Page): Promise<SessionKind> {
  let kind: SessionKind = 'none';
  await expect
    .poll(async () => (kind = await sessionKind(page)), { message: 'the session shows something' })
    .not.toBe('none');
  return kind;
}

export interface Answered {
  question: string;
  rating: Rating;
}

/**
 * Answer every card the session shows with the next rating of `ratings` (then Good), until the
 * summary or a "waiting for a learning step" screen. Returns what was answered, in order.
 */
export async function answerAll(
  page: Page,
  ratings: readonly Rating[],
  opts: { max?: number } = {},
): Promise<Answered[]> {
  const out: Answered[] = [];
  const max = opts.max ?? 500;
  while (out.length < max) {
    if ((await settledSession(page)) !== 'card') break;
    const rating = ratings[out.length] ?? 3;
    const question = await questionText(page);
    await answerWith(page, rating);
    out.push({ question, rating });
  }
  return out;
}

export const questionText = async (page: Page): Promise<string> =>
  ((await page.getByTestId(TID.question).textContent()) ?? '').trim();

// -----------------------------------------------------------------------------------------------
// Card browser, deck settings
// -----------------------------------------------------------------------------------------------

export const cardRow = (page: Page, text: string | RegExp): Locator =>
  page.locator('[data-testid^="rv-card-"]', { hasText: text });

export async function setBrowserFilter(page: Page, label: string): Promise<void> {
  await page.getByTestId(TID.browserFilter).selectOption({ label });
}

export interface DeckSettingsPatch {
  newPerDay?: string;
  reviewsPerDay?: string;
  learningSteps?: string;
  relearnSteps?: string;
  targetRetentionPct?: string;
  maxIntervalDays?: string;
  leechThreshold?: string;
  fuzz?: boolean;
}

/** Open the deck's rules in the Settings view and return its form. */
export async function openDeckForm(page: Page, deckName: string): Promise<Locator> {
  await gotoTab(page, 'Settings');
  const details = page.locator('details', {
    has: page.locator('.rv-details__name', { hasText: deckName }),
  });
  const form = details.getByRole('form', { name: `Settings of deck ${deckName}` });
  if (!(await form.isVisible())) await details.locator('summary').click();
  await expect(form).toBeVisible();
  return form;
}

export async function fillDeckForm(form: Locator, patch: DeckSettingsPatch): Promise<void> {
  const fields: Array<[keyof DeckSettingsPatch, string]> = [
    ['targetRetentionPct', 'Target retention (%)'],
    ['newPerDay', 'New cards per day'],
    ['reviewsPerDay', 'Reviews per day'],
    ['maxIntervalDays', 'Maximum interval (days)'],
    ['learningSteps', 'Learning steps'],
    ['relearnSteps', 'Relearning steps'],
    ['leechThreshold', 'Leech threshold'],
  ];
  for (const [key, label] of fields) {
    const value = patch[key];
    if (typeof value === 'string') await form.getByLabel(label, { exact: true }).fill(value);
  }
  if (patch.fuzz !== undefined) {
    const box = form.getByRole('checkbox', { name: /Spread due dates/ });
    if (patch.fuzz) await box.check();
    else await box.uncheck();
  }
}

/**
 * Fill the deck form and save it. Waits for the settings to be in the database (not for the on-screen
 * "Saved" notice: that notice is checked on its own in the settings test).
 */
export async function saveDeckSettings(
  page: Page,
  deckName: string,
  patch: DeckSettingsPatch,
): Promise<void> {
  const form = await openDeckForm(page, deckName);
  await fillDeckForm(form, patch);
  await form.getByTestId(TID.deckSettingsSave).click();
  const wanted: Record<string, unknown> = {};
  if (patch.newPerDay !== undefined) wanted.newPerDay = Number(patch.newPerDay);
  if (patch.reviewsPerDay !== undefined) wanted.reviewsPerDay = Number(patch.reviewsPerDay);
  if (patch.maxIntervalDays !== undefined) wanted.maxIntervalDays = Number(patch.maxIntervalDays);
  if (patch.leechThreshold !== undefined) wanted.leechThreshold = Number(patch.leechThreshold);
  if (patch.fuzz !== undefined) wanted.enableFuzz = patch.fuzz;
  if (patch.learningSteps !== undefined) wanted.learningSteps = patch.learningSteps.split(/\s+/);
  if (patch.relearnSteps !== undefined) wanted.relearnSteps = patch.relearnSteps.split(/\s+/);
  await expect
    .poll(
      async () =>
        (await readStudyDb(page)).decks.find((d) => d.name === deckName && d.deletedAt === null)
          ?.settings,
      { message: `settings of deck ${deckName} were stored` },
    )
    .toMatchObject(wanted);
}

// -----------------------------------------------------------------------------------------------
// Interval labels
// -----------------------------------------------------------------------------------------------

/** Milliseconds a button label such as "10m", "3h", "4d", "2.5mo", "1.2y" stands for, +- rounding. */
export function labelToMs(label: string): { ms: number; tolerance: number } {
  const m = /^(\d+(?:\.\d+)?)(m|h|d|mo|y)$/.exec(label.trim());
  if (!m) {
    if (label.trim() === '<1m') return { ms: 0, tolerance: MINUTE };
    throw new Error(`unrecognised interval label: ${label}`);
  }
  const n = Number(m[1]);
  switch (m[2]) {
    case 'm':
      return { ms: n * MINUTE, tolerance: MINUTE / 2 };
    case 'h':
      return { ms: n * HOUR, tolerance: HOUR / 2 };
    case 'd':
      return { ms: n * DAY, tolerance: DAY / 2 };
    case 'mo':
      return { ms: n * 30.4375 * DAY, tolerance: 0.05 * 30.4375 * DAY };
    default:
      return { ms: n * 365.25 * DAY, tolerance: 0.05 * 365.25 * DAY };
  }
}

// -----------------------------------------------------------------------------------------------
// Tables
// -----------------------------------------------------------------------------------------------

/** Body rows of a table as trimmed cell texts (works for tables inside a closed <details>). */
export async function tableRows(table: Locator): Promise<string[][]> {
  return table.evaluate((el) =>
    Array.from(el.querySelectorAll('tbody tr')).map((tr) =>
      Array.from(tr.children).map((c) => (c.textContent ?? '').replace(/\s+/g, ' ').trim()),
    ),
  );
}

// -----------------------------------------------------------------------------------------------
// Accessibility
// -----------------------------------------------------------------------------------------------

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];

export async function axeReport(page: Page): Promise<string> {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  return results.violations
    .map((v) => {
      const nodes = v.nodes
        .slice(0, 4)
        .map(
          (n) =>
            `    - ${JSON.stringify(n.target)}\n      ${n.html.slice(0, 160)}\n      ${(n.failureSummary ?? '').replace(/\n/g, ' | ')}`,
        )
        .join('\n');
      return `[${v.impact ?? 'n/a'}] ${v.id}: ${v.help} (${v.nodes.length} node(s))\n${nodes}`;
    })
    .join('\n');
}

/** axe WCAG 2.2 AA over the whole document; failure message lists every violation. */
export async function expectAccessible(page: Page, label: string): Promise<void> {
  const report = await axeReport(page);
  // Soft: one failing state must not hide the violations of the states after it.
  expect.soft(report, `axe WCAG 2.2 AA violations on ${label}`).toBe('');
}

// -----------------------------------------------------------------------------------------------
// Checks shared by several tests
// -----------------------------------------------------------------------------------------------

/**
 * A button label ("10m", "16d") must agree with the due date that was really stored for the card
 * after that answer. `answeredAt` is the (pinned) time of the answer.
 */
export function expectDueMatchesLabel(
  card: CardRow,
  label: string,
  answeredAt: number,
  what: string,
): void {
  const { ms, tolerance } = labelToMs(label);
  const delta = Date.parse(card.fsrs.due) - answeredAt;
  expect(
    Math.abs(delta - ms),
    `${what}: button said ${label} (${ms} ms), stored due is ${delta} ms away`,
  ).toBeLessThanOrEqual(tolerance);
  expect(card.dueAt, `${what}: dueAt mirrors fsrs.due`).toBe(card.fsrs.due);
}

/** The text the card browser prints for an instant, produced by the page's own Intl in `timeZone`. */
export async function whenText(page: Page, isoInstant: string, timeZone: string): Promise<string> {
  return page.evaluate(
    ({ at, tz }) =>
      new Intl.DateTimeFormat(undefined, {
        timeZone: tz,
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(at)),
    { at: isoInstant, tz: timeZone },
  );
}

/** Set the study day through the Settings view's own form and wait for its saved notice. */
export async function setStudyDayInUi(
  page: Page,
  next: { timeZone: string; rolloverHour: number },
): Promise<void> {
  await gotoTab(page, 'Settings');
  const form = page.getByTestId(TID.studyDay);
  await form.getByTestId(TID.timeZone).fill(next.timeZone);
  await form.getByTestId(TID.rollover).selectOption(String(next.rolloverHour));
  await form.getByTestId(TID.studyDaySave).click();
  await expect(
    form.getByText(/^Saved\. Open review windows pick the new settings up/),
  ).toBeVisible();
}

/** The study settings exactly as stored under chrome.storage.local. */
export async function storedStudySettings(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(async () => {
    const got = await chrome.storage.local.get('studySettings');
    return (got.studySettings ?? {}) as Record<string, unknown>;
  });
}

/** Create basic typed cards (no source) in one visit to the author view. */
export async function createBasicCards(
  page: Page,
  cards: ReadonlyArray<readonly [question: string, answer: string]>,
): Promise<void> {
  await openTypedCard(page);
  for (const [question, answer] of cards) {
    await saveEditor(page, { t: 'basic', question, answer }, 1);
  }
}

/** Position (0-based) of the option whose text contains `text` in the on-screen choice list. */
export async function optionIndex(page: Page, text: string): Promise<number> {
  const n = await page.getByTestId(TID.choices).locator('li').count();
  for (let i = 0; i < n; i++) {
    if (((await page.getByTestId(choiceId(i)).textContent()) ?? '').includes(text)) return i;
  }
  throw new Error(`no option contains ${text}`);
}

/** Reload the page and open `tab` again (the address keeps the view the page was on). */
export async function reloadTo(page: Page, tab: ReviewTab): Promise<void> {
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Review', level: 1 })).toBeVisible();
  await gotoTab(page, tab);
}

/** The id of the element that has focus (data-testid, else tag name). */
export async function focusedId(page: Page): Promise<string> {
  return page.evaluate(
    () =>
      document.activeElement?.getAttribute('data-testid') ??
      document.activeElement?.textContent?.trim() ??
      document.activeElement?.tagName ??
      '',
  );
}

/** Press Tab until the focused element satisfies `match`; fails after `max` presses. */
export async function tabUntil(
  page: Page,
  match: (id: string) => boolean,
  max = 60,
): Promise<string> {
  for (let i = 0; i < max; i++) {
    const id = await focusedId(page);
    if (match(id)) return id;
    await page.keyboard.press('Tab');
  }
  throw new Error(`Tab never reached the target; focus is on ${await focusedId(page)}`);
}
