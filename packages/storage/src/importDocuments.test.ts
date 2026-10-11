import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import { strToU8, zipSync } from 'fflate';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { importMarkdownHighlights } from '@backup';
import { importDocument } from '@backup/importDocs';
import { importExternalHighlights, undoExternalImport } from './backupTarget';
import { getDb, resetDbForTests } from './db';
import { softDeleteHighlight } from './repo';

// jsdom has no crypto.subtle; Node's is what a browser would provide.
Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

vi.setConfig({ testTimeout: 60_000 });

beforeEach(async () => {
  await resetDbForTests();
  fakeBrowser.reset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const slide = (...lines: string[]) =>
  `<p:sld xmlns:a="${A}" xmlns:p="${P}"><p:cSld><p:spTree><p:sp><p:txBody>${lines
    .map((t) => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`)
    .join('')}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;

function pptx(): Uint8Array {
  return zipSync({
    'ppt/presentation.xml': strToU8('<p:presentation/>'),
    'ppt/slides/slide1.xml': strToU8(slide('Beta blockers', 'Reduce mortality after MI.')),
    'ppt/slides/slide2.xml': strToU8(slide('ACE inhibitors', 'Block angiotensin II formation.')),
  });
}

describe('importing documents', () => {
  it('writes one imported highlight per slide with the file and slide as its locator', async () => {
    const set = await importDocument({ name: 'cardio lecture.pptx', bytes: pptx() });
    const res = await importExternalHighlights(set, { bankId: null });
    expect(res).toMatchObject({ created: 2, duplicates: 0, sourcesCreated: 1 });
    expect(res.batchId).toMatch(/^[0-9a-f-]{36}$/);

    const db = getDb();
    const rows = await Promise.all(res.highlightIds.map((id) => db.highlights.get(id)));
    expect(rows.map((r) => r?.exactQuote)).toEqual([
      'Beta blockers\nReduce mortality after MI.',
      'ACE inhibitors\nBlock angiotensin II formation.',
    ]);
    expect(rows[0]).toMatchObject({
      captureMethod: 'import',
      userComment: '',
      customFields: {
        importedFrom: 'pptx',
        needsReview: true,
        importedFile: 'cardio lecture.pptx',
        importedLocator: 'Slide 1',
      },
    });
    expect(rows[1]?.customFields?.importedLocator).toBe('Slide 2');

    // one Source for the file, of the import's own, titled with the file name
    expect(rows[0]?.sourceId).toBe(rows[1]?.sourceId);
    const source = await db.sources.get(rows[0]!.sourceId);
    expect(source).toMatchObject({ type: 'web', title: 'cardio lecture.pptx', host: 'imported' });
    expect(source?.urlKey).toBe(`imported:${res.batchId}:1`);
    expect(source?.originalUrl).toMatch(/^https:\/\/studyvault\.invalid\/imported\//);

    // importing the same file again adds nothing
    const again = await importDocument(
      { name: 'cardio lecture.pptx', bytes: pptx() },
      { existingQuoteHashes: new Set(rows.map((r) => r!.quoteHash)) },
    );
    expect(again.highlights).toHaveLength(0);
    expect(again.duplicates).toHaveLength(2);
  });

  it('refuses a forged row with a format it does not know', async () => {
    const set = await importDocument({ name: 'a.pptx', bytes: pptx() });
    const forged = { ...set.highlights[0]!, format: 'exe' as never };
    await expect(
      importExternalHighlights({ highlights: [forged] }, { bankId: null }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });
});

describe('undoExternalImport', () => {
  it('moves exactly that import’s highlights to the Trash, once, and leaves every other one', async () => {
    const first = await importExternalHighlights(
      await importDocument({ name: 'a.pptx', bytes: pptx() }),
      { bankId: null },
    );
    const other = await importExternalHighlights(
      await importMarkdownHighlights('> A different fact from a Markdown note.\n'),
      { bankId: null },
    );
    expect(first.batchId).not.toBe(other.batchId);
    // one highlight of the first import was already trashed by hand: not counted, not restored
    await softDeleteHighlight(first.highlightIds[0]!);

    const done = await undoExternalImport(first.batchId);
    expect(done).toEqual({ removed: 1 });
    const db = getDb();
    const state = await Promise.all(
      [...first.highlightIds, ...other.highlightIds].map(async (id) => [
        id,
        (await db.highlights.get(id))?.deletedAt !== null,
      ]),
    );
    expect(state).toEqual([
      [first.highlightIds[0], true],
      [first.highlightIds[1], true],
      [other.highlightIds[0], false],
    ]);
    // still there to restore: nothing was purged, and the Source remains
    expect(await db.highlights.count()).toBe(3);
    expect(await db.sources.count()).toBe(2);

    expect(await undoExternalImport(first.batchId)).toEqual({ removed: 0 });
  });

  it('rejects something that is not an import name, and an unknown one is a no-op', async () => {
    await expect(undoExternalImport('imported:')).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(await undoExternalImport('00000000-0000-4000-8000-000000000000')).toEqual({
      removed: 0,
    });
  });
});
