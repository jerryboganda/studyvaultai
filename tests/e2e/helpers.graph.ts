import type { Locator, Page } from '@playwright/test';
import { Relation as RelationSchema, SCHEMA_VERSION, type RelationType } from '@shared';
import {
  BASE_TIME,
  buildDataset,
  ensureVault,
  expect,
  openControl,
  openDashboard,
  rawPut,
  readTable,
  settle,
  writeDataset,
  type DashTarget,
  type DatasetInput,
  type Env,
  type TableName,
} from './helpers.dashboard';

/**
 * Helpers for graph.spec.ts: a small pharmacology vault, the links between its highlights, and
 * locators for the Links section of the preview and for the graph view.
 *
 *   A aspirin     (with a note)       B clopidogrel      C heparin      V mitral valve (never linked)
 */
export const TEXT = {
  a: 'Aspirin irreversibly inhibits cyclooxygenase in platelets.',
  b: 'Clopidogrel blocks the P2Y12 receptor on platelets.',
  c: 'Heparin activates antithrombin and is monitored by the aPTT.',
  v: 'The mitral valve separates the left atrium from the left ventricle.',
} as const;

export const NOTE_BODY = 'Compare with clopidogrel before choosing a drug.';

export function graphInput(env: Env): DatasetInput {
  const url = (name: string) => `${env.origin}/dash-source-a.html?graph=${name}`;
  return {
    sources: [
      { key: 'aspirin', url: url('aspirin'), title: 'Antiplatelet drugs' },
      { key: 'p2y12', url: url('p2y12'), title: 'P2Y12 inhibitors' },
      { key: 'heparin', url: url('heparin'), title: 'Heparins' },
      { key: 'heart', url: url('heart'), title: 'Cardiac anatomy' },
    ],
    highlights: [
      {
        key: 'a',
        quote: TEXT.a,
        source: 'aspirin',
        notes: [{ title: 'Compare', body: NOTE_BODY }],
      },
      { key: 'b', quote: TEXT.b, source: 'p2y12' },
      { key: 'c', quote: TEXT.c, source: 'heparin' },
      { key: 'v', quote: TEXT.v, source: 'heart' },
    ],
  };
}

/** A vault written through the raw writer, ready for the first dashboard load. */
export async function seedGraph(env: Env) {
  const ctrl = await openControl(env);
  await ensureVault(ctrl);
  const ds = buildDataset(graphInput(env));
  await writeDataset(ctrl, ds);
  const id = {
    a: ds.id.hl('a'),
    b: ds.id.hl('b'),
    c: ds.id.hl('c'),
    v: ds.id.hl('v'),
  };
  return { ctrl, ds, id };
}

// -----------------------------------------------------------------------------------------------
// Dashboard navigation (shared with related, syllabus and rules specs)
// -----------------------------------------------------------------------------------------------

/**
 * The dashboard on the highlight list. A plain dashboard.html opens on Home, so this goes through the
 * rail's Banks button like a person would (harmless when a deep link already opened the list).
 */
export async function openLibrary(env: Env, target: DashTarget = {}): Promise<Page> {
  const page = await openDashboard(env, target, { settle: false });
  await showLibrary(page);
  return page;
}

/** Rail › Banks: the highlight list, scope unchanged, loaded. */
export async function showLibrary(page: Page): Promise<void> {
  await page.getByTestId('nav-banks').click();
  await expect(page.getByTestId('view-library')).toBeVisible();
  await settle(page);
}

export type MoreView = 'graph' | 'syllabus' | 'rules' | 'trash' | 'duplicates' | 'storage' | 'chat';

/** Rail › More, then the view's tile. Inside the view the rail marks More as the current page. */
export async function showMoreView(page: Page, view: MoreView): Promise<void> {
  await page.getByTestId('nav-more').click();
  await page.getByTestId('more-view').getByTestId(`view-${view}`).click();
  await expect(page.getByTestId('nav-more')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('more-view')).toHaveCount(0);
}

/**
 * Tick a picture-card or pill radio/checkbox the way a person does: by its label (the native input
 * is visually hidden inside it). Resolves once the input is checked.
 */
export async function pickCard(input: Locator): Promise<void> {
  await input.locator('xpath=ancestor::label[1]').click();
  await expect(input).toBeChecked();
}

// -----------------------------------------------------------------------------------------------
// The relations table, raw
// -----------------------------------------------------------------------------------------------

export interface StoredRelation {
  id: string;
  fromKind: string;
  fromId: string;
  toKind: string;
  toId: string;
  type: RelationType;
  note?: string;
  deletedAt: string | null;
}

export const relationRows = (ctrl: Page) =>
  readTable<StoredRelation>(ctrl, 'relations' as TableName);

/** Links written straight into the vault (before the first dashboard load, so the index sees them). */
export async function putRelations(
  ctrl: Page,
  links: Array<{ from: string; to: string; type: RelationType; note?: string }>,
): Promise<void> {
  const rows = links.map((link, i) => {
    const at = new Date(BASE_TIME + i * 1000).toISOString();
    return RelationSchema.parse({
      id: `rel-graph-${String(i).padStart(4, '0')}`,
      schemaVersion: SCHEMA_VERSION,
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
      fromKind: 'highlight',
      fromId: link.from,
      toKind: 'highlight',
      toId: link.to,
      type: link.type,
      ...(link.note ? { note: link.note } : {}),
    });
  });
  await rawPut(ctrl, { relations: rows } as never);
}

// -----------------------------------------------------------------------------------------------
// The Links section of the preview
// -----------------------------------------------------------------------------------------------

export const linksSection = (page: Page): Locator => page.getByTestId('preview-links');
export const linksToggle = (page: Page): Locator => linksSection(page).getByTestId('links-toggle');
export const linkItems = (page: Page): Locator => linksSection(page).getByTestId('link-item');

/** Open the section if it is closed. */
export async function openLinks(page: Page): Promise<void> {
  const toggle = linksToggle(page);
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(linksSection(page).getByTestId('links-summary')).toBeVisible();
}

/** The link whose other end shows this text. */
export const linkTo = (page: Page, text: string): Locator =>
  linkItems(page).filter({ has: page.getByTestId('link-text').filter({ hasText: text }) });

export interface NewLink {
  /** Words typed into the picker's search box. */
  query: string;
  /** Id of the candidate to choose. */
  pick: string;
  type?: RelationType;
  note?: string;
  direction?: 'out' | 'in';
}

/** Fill the picker (open it first with `link-add`) up to, not including, the submit. */
export async function fillLink(page: Page, link: NewLink): Promise<void> {
  const section = linksSection(page);
  await section.getByTestId('link-search').fill(link.query);
  const candidate = section.locator(`[data-testid="link-candidate"][data-id="${link.pick}"]`);
  await expect(candidate).toBeVisible({ timeout: 30_000 });
  await candidate.getByRole('radio').check();
  if (link.type) await section.getByTestId('link-new-type').selectOption(link.type);
  if (link.direction) await section.getByTestId('link-new-direction').selectOption(link.direction);
  if (link.note) await section.getByTestId('link-new-note').fill(link.note);
}

/** Open the picker, fill it and add the link. */
export async function addLink(page: Page, link: NewLink): Promise<void> {
  await openLinks(page);
  await linksSection(page).getByTestId('link-add').click();
  await fillLink(page, link);
  await linksSection(page).getByTestId('link-submit').click();
  await expect(linksSection(page).getByTestId('link-picker')).toHaveCount(0);
}

// -----------------------------------------------------------------------------------------------
// The graph view
// -----------------------------------------------------------------------------------------------

export const graphView = (page: Page): Locator => page.getByTestId('graph-view');
export const graphNodes = (page: Page): Locator => graphView(page).getByTestId('graph-node');
export const connectionRows = (page: Page): Locator =>
  graphView(page).getByTestId('connection-row');

/** The row of the Connections table for one item (`kind:id`). */
export const connectionRow = (page: Page, nodeKey: string): Locator =>
  graphView(page).locator(`[data-testid="connection-row"][data-node="${nodeKey}"]`);

export const nodeOf = (page: Page, highlightId: string): Locator =>
  graphView(page).locator(`[data-testid="graph-node"][data-node="highlight:${highlightId}"]`);

/** `data-node` of the element that has keyboard focus (empty when it is not a graph node). */
export async function focusedNode(page: Page): Promise<string> {
  return page.evaluate(
    () => document.activeElement?.closest('[data-node]')?.getAttribute('data-node') ?? '',
  );
}
