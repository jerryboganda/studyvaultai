import type { Locator, Page } from '@playwright/test';
import { SCHEMA_VERSION, Syllabus as SyllabusSchema } from '@shared';
import {
  Card as CardSchema,
  Deck as DeckSchema,
  ReviewLog as ReviewLogSchema,
} from '@study/schema';
import { makeCard, makeDeck } from '@study/testUtils';
import {
  buildDataset,
  ensureVault,
  expect,
  openControl,
  rawPut,
  readTable,
  writeDataset,
  type Dataset,
  type DatasetInput,
  type Env,
  type TableName,
} from './helpers.dashboard';
import { pickCard, showMoreView } from './helpers.graph';

/**
 * Helpers for syllabus.spec.ts (custom syllabus editor and coverage, ADR-020 part 2).
 *
 * The vault is seeded straight into IndexedDB before the first page load (see the SEEDING note in
 * helpers.dashboard.ts); rows are validated with the product's own schemas in Node first. Test ids are
 * copied from the product on purpose (nothing is imported from it, so a renamed id fails the spec).
 *
 * The seeded vault and what each topic of `OUTLINE` must show (default thresholds: 3 highlights and
 * 1 card; weights Cardiology 3, Renal 3, Misc 1, Not started 1; Heart failure and Rhythm 1 each):
 *
 *   highlights   c1 cardio | c2 cardio + tag hy | c3 cardio + renal | r1 renal + hy | r2 renal, TRASHED
 *                t1 inbox + hy
 *   cards        k1 (from c1, graduated, DUE, last reviewed 3 days ago, 6 mature reviews of which
 *                one was forgotten, plus one undone and one first review that do not count)
 *                k2 (from c2, new) | k3 (from r1, graduated, not due, last reviewed 5 days ago,
 *                3 mature reviews) | k4 (from c3, SUSPENDED)
 *
 *   Heart failure -> bank Cardiology      3 highlights (c1 c2 c3), 2 cards (k1 k2), 1 due, 83 % of 6
 *   Rhythm        -> nothing              0, 0, 0
 *   Cardiology    -> (its subtopics)      3, 2, 1 as above; covered 50 % of its subtopics
 *   Renal         -> bank Renal + tag hy  4 highlights (c3 r1 c2 t1; r1 once, r2 is trashed),
 *                                         2 cards (k2 through the tag, k3), 0 due, n/a of 3
 *   Misc notes    -> bank Inbox           1 highlight (t1), 0 cards
 *   Not started   -> nothing              0
 *
 * Whole syllabus: 56.25 % covered (Cardiology 3/8 x 50 % + Renal 3/8), 68.75 % with some material.
 */

export const DAY = 86_400_000;

export const TEXT = {
  c1: 'Preload is the ventricular stretch at the end of diastole.',
  c2: 'Afterload is the resistance the ventricle ejects against.',
  c3: 'Digoxin inhibits the sodium potassium pump.',
  r1: 'Creatinine rises late in acute kidney injury.',
  r2: 'A discarded fact about glomerular filtration.',
  t1: 'A loose note waiting in the inbox.',
} as const;

/** The outline the tests paste (the name comes from the leading heading). */
export const OUTLINE = [
  '# Cardiorenal exam',
  '- Cardiology (weight 3)',
  '  - Heart failure',
  '  - Rhythm',
  '- Renal (weight 3)',
  '- Misc notes',
  '- Not started',
].join('\n');

export const SID = {
  view: 'syllabus-view',
  select: 'syllabus-select',
  create: 'syllabus-new',
  rename: 'syllabus-rename',
  export: 'syllabus-export',
  remove: 'syllabus-delete',
  size: 'syllabus-size',
  importText: 'syllabus-import-text',
  importSummary: 'syllabus-import-summary',
  importErrors: 'syllabus-import-errors',
  importPreview: 'syllabus-import-preview',
  add: 'topic-add',
  addChild: 'topic-add-child',
  up: 'topic-up',
  down: 'topic-down',
  indent: 'topic-indent',
  outdent: 'topic-outdent',
  del: 'topic-delete',
  title: 'topic-title',
  weight: 'topic-weight',
  banks: 'topic-banks',
  tags: 'topic-tags',
  show: 'topic-show',
  // review page, Analytics tab
  rvSection: 'rv-syllabus',
  rvEmpty: 'rv-syllabus-empty',
  rvCreate: 'rv-syllabus-create',
  rvSelect: 'rv-syllabus-select',
  rvEdit: 'rv-syllabus-edit',
  rvOverall: 'rv-syllabus-overall',
  rvMinHighlights: 'rv-syllabus-min-highlights',
  rvMinCards: 'rv-syllabus-min-cards',
  rvReset: 'rv-syllabus-reset',
  rvStatus: 'rv-syllabus-threshold-status',
  rvChart: 'rv-syllabus-chart',
  rvTable: 'rv-syllabus-table',
} as const;

export const sortId = (key: string) => `rv-syllabus-sort-${key}`;

// -----------------------------------------------------------------------------------------------
// The vault
// -----------------------------------------------------------------------------------------------

export function vaultInput(env: Env): DatasetInput {
  const source = `${env.origin}/dash-source-a.html?syllabus=1`;
  return {
    banks: [
      { key: 'cardio', name: 'Cardiology' },
      { key: 'renal', name: 'Renal' },
    ],
    tags: [{ key: 'hy', name: 'High Yield' }],
    sources: [{ key: 's1', url: source, title: 'Cardiorenal notes' }],
    highlights: [
      { key: 'c1', quote: TEXT.c1, source: 's1', places: [{ bank: 'cardio' }] },
      { key: 'c2', quote: TEXT.c2, source: 's1', places: [{ bank: 'cardio' }], tags: ['hy'] },
      {
        key: 'c3',
        quote: TEXT.c3,
        source: 's1',
        places: [{ bank: 'cardio' }, { bank: 'renal' }],
      },
      { key: 'r1', quote: TEXT.r1, source: 's1', places: [{ bank: 'renal' }], tags: ['hy'] },
      { key: 'r2', quote: TEXT.r2, source: 's1', places: [{ bank: 'renal' }], trashed: true },
      { key: 't1', quote: TEXT.t1, source: 's1', places: [{ bank: 'inbox' }], tags: ['hy'] },
    ],
  };
}

export interface SeededVault {
  /** An extension page that can read and write the vault's database. */
  ctrl: Page;
  ds: Dataset;
  /** Wall-clock time the seed was made at (cards are dated relative to it). */
  now: number;
  /** ISO instant `days` from the seed time (negative: in the past). */
  at(days: number): string;
  id: { cardio: string; renal: string; hy: string; inbox: string };
}

/** Banks, tags, highlights, decks, cards and review logs, written before the first page load. */
export async function seedSyllabusVault(env: Env): Promise<SeededVault> {
  const ctrl = await openControl(env);
  await ensureVault(ctrl);
  const ds = buildDataset(vaultInput(env));
  await writeDataset(ctrl, ds);

  const now = Date.now();
  const at = (days: number) => new Date(now + days * DAY).toISOString();
  const deck = (key: 'cardio' | 'renal', name: string) =>
    DeckSchema.parse(makeDeck(`e2e-deck-${key}`, { bankId: ds.id.bank(key), name }));
  const card = (
    key: string,
    deckKey: 'cardio' | 'renal',
    highlight: string,
    spec: Parameters<typeof makeCard>[1],
  ) =>
    CardSchema.parse({
      ...makeCard(`e2e-card-${key}`, { deckId: `e2e-deck-${deckKey}`, ...spec }),
      highlightId: ds.id.hl(highlight),
    });

  const cards = [
    card('k1', 'cardio', 'c1', {
      state: 'review',
      due: at(-1),
      lastReview: at(-3),
      stability: 12,
    }),
    card('k2', 'cardio', 'c2', {}),
    card('k3', 'renal', 'r1', { state: 'review', due: at(10), lastReview: at(-5), stability: 20 }),
    card('k4', 'cardio', 'c3', {
      state: 'review',
      due: at(-1),
      lastReview: at(-2),
      stability: 8,
      suspended: true,
    }),
  ];

  let n = 0;
  const log = (
    cardId: string,
    daysAgo: number,
    rating: 1 | 2 | 3 | 4,
    over: { first?: boolean; undone?: boolean } = {},
  ) => {
    const when = at(-daysAgo);
    const prev = makeCard('log-card-0001', {
      state: over.first ? 'new' : 'review',
      due: when,
      lastReview: over.first ? null : at(-daysAgo - 4),
    }).fsrs;
    const next = makeCard('log-card-0001', {
      state: 'review',
      due: at(-daysAgo + 5),
      lastReview: when,
    }).fsrs;
    n += 1;
    return ReviewLogSchema.parse({
      id: `e2e-log-${String(n).padStart(3, '0')}`,
      schemaVersion: SCHEMA_VERSION,
      cardId,
      reviewedAt: when,
      rating,
      durationMs: 4_000,
      sessionId: 'e2e-session-0001',
      previousState: prev,
      nextState: next,
      algorithmVersion: 'e2e',
      scheduledDays: 5,
      elapsedDays: 4,
      leech: false,
      ...(over.undone ? { userCorrection: { kind: 'undone', at: when } } : {}),
    });
  };
  const logs = [
    // k1: six mature reviews, one of them forgotten (5 of 6 remembered = 83 %) ...
    log('e2e-card-k1', 3, 3),
    log('e2e-card-k1', 4, 3),
    log('e2e-card-k1', 5, 4),
    log('e2e-card-k1', 6, 2),
    log('e2e-card-k1', 7, 1),
    log('e2e-card-k1', 8, 3),
    // ... and two that do not count: one undone, and the very first review of the card.
    log('e2e-card-k1', 9, 1, { undone: true }),
    log('e2e-card-k1', 12, 3, { first: true }),
    // k3: three mature reviews: below the minimum of five, so no number is shown.
    log('e2e-card-k3', 5, 3),
    log('e2e-card-k3', 6, 3),
    log('e2e-card-k3', 7, 2),
  ];

  await rawPut(ctrl, {
    decks: [deck('cardio', 'Cardiology'), deck('renal', 'Renal')],
    cards,
    reviewLogs: logs,
  } as never);

  return {
    ctrl,
    ds,
    now,
    at,
    id: {
      cardio: ds.id.bank('cardio'),
      renal: ds.id.bank('renal'),
      hy: ds.id.tag('hy'),
      inbox: ds.id.bank('inbox'),
    },
  };
}

export const topicId = (key: string) => `e2e-topic-${key}`;

/** The syllabus of OUTLINE, written straight into the vault (for the tests that are not about making one). */
export async function putSyllabus(seed: SeededVault, name = 'Cardiorenal exam'): Promise<string> {
  const at = new Date(seed.now - DAY).toISOString();
  const node = (
    key: string,
    title: string,
    over: { weight?: number; bankIds?: string[]; tagIds?: string[]; children?: unknown[] } = {},
  ) => ({
    id: topicId(key),
    title,
    children: over.children ?? [],
    bankIds: over.bankIds ?? [],
    tagIds: over.tagIds ?? [],
    ...(over.weight === undefined ? {} : { weight: over.weight }),
  });
  const row = SyllabusSchema.parse({
    id: 'e2e-syllabus-0001',
    schemaVersion: SCHEMA_VERSION,
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
    name,
    nodes: [
      node('cardiology', 'Cardiology', {
        weight: 3,
        children: [
          node('hf', 'Heart failure', { bankIds: [seed.id.cardio] }),
          node('rhythm', 'Rhythm'),
        ],
      }),
      node('renal', 'Renal', { weight: 3, bankIds: [seed.id.renal], tagIds: [seed.id.hy] }),
      node('misc', 'Misc notes', { bankIds: [seed.id.inbox] }),
      node('todo', 'Not started'),
    ],
  });
  await rawPut(seed.ctrl, { syllabi: [row] } as never);
  return row.id;
}

// -----------------------------------------------------------------------------------------------
// Stored rows (raw reads)
// -----------------------------------------------------------------------------------------------

export interface StoredTopic {
  id: string;
  title: string;
  weight?: number;
  bankIds: string[];
  tagIds: string[];
  children: StoredTopic[];
}
export interface StoredSyllabus {
  id: string;
  name: string;
  deletedAt: string | null;
  updatedAt: string;
  nodes: StoredTopic[];
}

export const syllabusRows = (ctrl: Page) => readTable<StoredSyllabus>(ctrl, 'syllabi' as TableName);

/** Every topic of every live syllabus by title (titles are unique in these tests). */
export async function topicsByTitle(ctrl: Page): Promise<Map<string, StoredTopic>> {
  const out = new Map<string, StoredTopic>();
  const walk = (list: StoredTopic[]) => {
    for (const t of list) {
      out.set(t.title, t);
      walk(t.children);
    }
  };
  for (const row of await syllabusRows(ctrl)) if (row.deletedAt === null) walk(row.nodes);
  return out;
}

export async function storedThresholds(ctrl: Page): Promise<unknown> {
  const rows = await readTable<{ key: string; value: unknown }>(ctrl, 'meta');
  return rows.find((r) => r.key === 'syllabusThresholds')?.value;
}

// -----------------------------------------------------------------------------------------------
// The editor (dashboard)
// -----------------------------------------------------------------------------------------------

/** The topics of the open syllabus (the bank tree on the left is another tree). */
export const topicsTree = (page: Page): Locator => page.getByRole('tree', { name: /^Topics of / });

export const topicItem = (page: Page, title: string): Locator =>
  topicsTree(page)
    .getByRole('treeitem')
    .filter({ hasText: new RegExp(`^${title}(\\s|$)`) });

/** Rail › More › Syllabus. */
export async function openSyllabusView(page: Page): Promise<void> {
  await showMoreView(page, 'syllabus');
  await expect(page.getByTestId(SID.view)).toBeVisible();
}

/** The "New syllabus" wizard dialog. */
export const syllabusWizard = (page: Page): Locator =>
  page.getByRole('dialog', { name: 'New syllabus' });

/** The current step of a wizard is its heading. */
export const wizardStep = (wizard: Locator, title: string): Locator =>
  wizard.getByRole('heading', { name: title, exact: true });

/** Press Next and wait for the named step. */
export async function wizardNext(wizard: Locator, title: string): Promise<void> {
  await wizard.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(wizardStep(wizard, title)).toBeVisible();
}

/** Open the wizard and choose "Paste outline" (Start from › Paste outline). */
export async function startPaste(page: Page): Promise<Locator> {
  await page.getByTestId(SID.create).click();
  const wizard = syllabusWizard(page);
  await expect(wizardStep(wizard, 'Start from')).toBeVisible();
  await pickCard(wizard.getByRole('radio', { name: /^Paste outline/ }));
  await wizardNext(wizard, 'Paste outline');
  return wizard;
}

/** Paste `text` into the wizard's outline field (on its "Paste outline" step). */
export async function pasteOutline(page: Page, text: string): Promise<Locator> {
  const wizard = syllabusWizard(page);
  await expect(wizardStep(wizard, 'Paste outline')).toBeVisible();
  await wizard.getByTestId(SID.importText).fill(text);
  return wizard;
}

/** Select a topic and tick banks and tags in its pickers. */
export async function mapTopic(
  page: Page,
  title: string,
  to: { banks?: string[]; tags?: string[] },
): Promise<void> {
  await topicItem(page, title).click();
  await expect(page.getByTestId(SID.title)).toHaveValue(title);
  for (const bank of to.banks ?? []) {
    await pickCard(page.getByTestId(SID.banks).getByRole('checkbox', { name: bank, exact: true }));
  }
  for (const tag of to.tags ?? []) {
    await pickCard(page.getByTestId(SID.tags).getByRole('checkbox', { name: tag, exact: true }));
  }
}

// -----------------------------------------------------------------------------------------------
// Expected numbers (computed from the description above, never from the product)
// -----------------------------------------------------------------------------------------------

const pct = (n: number, digits = 0) => `${(n * 100).toFixed(digits)}%`;
/** Whole percent as the coverage rings round it (Math.round, as a person reads 56.25 % as 56). */
const whole = (n: number) => Math.round(n * 100);

export interface ExpectedRow {
  cells: string[];
}

/** Topic cell of a topic nothing points at: its title and a "Not mapped" badge. */
const unmapped = (title: string) => `${title} Not mapped`;

/** The first eight cells of each table row (topic, share, highlights, cards, due, retention, last, state). */
export function expectedRows(lastK1: string, lastK3: string, covered = 'default') {
  const hfState = covered === 'default' ? 'Covered' : 'Thin';
  const renalState = 'Covered';
  const cardiologyState =
    covered === 'default'
      ? 'Thin (50% of its subtopics by weight)'
      : 'Thin (0% of its subtopics by weight)';
  return {
    Cardiology: ['Cardiology', pct(0.375, 1), '3', '2', '1', '83% (6)', lastK1, cardiologyState],
    'Heart failure': ['Heart failure', pct(0.1875, 1), '3', '2', '1', '83% (6)', lastK1, hfState],
    Rhythm: [unmapped('Rhythm'), pct(0.1875, 1), '0', '0', '0', 'n/a (0)', 'Never', 'None'],
    Renal: ['Renal', pct(0.375, 1), '4', '2', '0', 'n/a (3)', lastK3, renalState],
    'Misc notes': ['Misc notes', pct(0.125, 1), '1', '0', '0', 'n/a (0)', 'Never', 'Thin'],
    'Not started': [
      unmapped('Not started'),
      pct(0.125, 1),
      '0',
      '0',
      '0',
      'n/a (0)',
      'Never',
      'None',
    ],
  } as Record<string, string[]>;
}

/** Row key of the table: the topic title without its "Not mapped" badge or "in <parent>". */
export const topicOfCell = (cell: string): string => cell.replace(/ in .*$| Not mapped$/, '');

/** Whole-syllabus coverage by weight, as whole percents (56.25 % covered, 68.75 % started). */
export const overallPct = {
  covered: whole(0.5625),
  started: whole(0.6875),
  /** With 4 highlights needed: only Renal (3 of 8) is covered. */
  strictCovered: whole(0.375),
};

/** Accessible name of a coverage ring (ProgressRing: "<label>: <n> of 100 %", ", done" when full). */
export const ringName = (label: string, value: number): string =>
  `${label}: ${value} of 100 %${value >= 100 ? ', done' : ''}`;

/** The top-level topics of the chart, in outline order: covered share by weight and state. */
export const expectedChart: ReadonlyArray<{ title: string; covered: number; state: string }> = [
  { title: 'Cardiology', covered: 50, state: 'Thin' },
  { title: 'Renal', covered: 100, state: 'Covered' },
  { title: 'Misc notes', covered: 0, state: 'Thin' },
  { title: 'Not started', covered: 0, state: 'None' },
];
