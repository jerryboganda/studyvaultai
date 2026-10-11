import { readFileSync } from 'node:fs';
import Dexie from 'dexie';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { CaptureInput, HighlightView } from '@shared';
import { DB_NAME, SCHEMA_V1, getDb, resetDbForTests } from './db';
import { saveCapture } from './repo';
import { anchor, cap } from './test-fixtures';

/** Shared helpers for the vault tests. Not imported by production code. */

export type Row = Record<string, unknown>;
export interface V1Snapshot {
  banks: Row[];
  sources: Row[];
  highlights: Row[];
  highlightBanks: Row[];
}

export type FixtureName = 'schema-v1.json' | 'schema-v1-empty.json' | 'schema-v1-trash.json';

export function loadFixture(name: FixtureName): V1Snapshot {
  const raw = JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'),
  ) as V1Snapshot & { _note: string };
  return {
    banks: structuredClone(raw.banks),
    sources: structuredClone(raw.sources),
    highlights: structuredClone(raw.highlights),
    highlightBanks: structuredClone(raw.highlightBanks),
  };
}

/** Write rows the way the schema-version-1 build did: straight into IndexedDB, v1 stores only. */
export async function seedV1(data: V1Snapshot): Promise<void> {
  await resetDbForTests();
  const legacy = new Dexie(DB_NAME);
  legacy.version(1).stores(SCHEMA_V1);
  try {
    await legacy.open();
    await legacy.table('banks').bulkPut(data.banks);
    await legacy.table('sources').bulkPut(data.sources);
    await legacy.table('highlights').bulkPut(data.highlights);
    await legacy.table('highlightBanks').bulkPut(data.highlightBanks);
  } finally {
    legacy.close();
  }
}

/** Every row of every table of the shared database. */
export async function dump(): Promise<Record<string, Row[]>> {
  const db = getDb();
  if (!db.isOpen()) await db.open();
  const out: Record<string, Row[]> = {};
  for (const table of db.tables) out[table.name] = (await table.toArray()) as Row[];
  return out;
}

export const byId = (rows: Row[]) =>
  [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)));

export async function freshDatabase(): Promise<void> {
  await resetDbForTests();
  fakeBrowser.reset();
}

let counter = 0;

/** Save one highlight with a unique quote and position; returns the view. */
export async function save(
  quote?: string,
  over: Partial<CaptureInput> = {},
  start?: number,
): Promise<HighlightView> {
  counter++;
  const text = quote ?? `Unique study fact number ${counter} for the vault tests.`;
  return (await saveCapture(cap(text, start ?? counter * 100, over))).highlight;
}

/** A capture on another page, so two sources exist. */
export async function saveOn(
  url: string,
  quote: string,
  over: Partial<CaptureInput> = {},
  start = 50,
): Promise<HighlightView> {
  return (
    await saveCapture(
      cap(quote, start, {
        page: { url, canonicalUrl: null, title: `Page ${url}` },
        anchorSet: anchor(quote, start, 'p: ', ' :s'),
        ...over,
      }),
    )
  ).highlight;
}

/** Records every dataEpoch token written, so tests can count change notifications. */
export function trackEpochs(): unknown[] {
  const seen: unknown[] = [];
  fakeBrowser.storage.onChanged.addListener((changes) => {
    if (changes.dataEpoch) seen.push(changes.dataEpoch.newValue);
  });
  return seen;
}
