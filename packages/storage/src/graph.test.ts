// @vitest-environment node
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HighlightView } from '@shared';
import { describeEnds, findKnowledgePoints, listLinks, loadGraph } from './graph';
import { createNote } from './notes';
import { createRelation, deleteRelation, listAllRelations, listRelationsFor } from './relations';
import { restoreHighlight, softDeleteHighlight } from './repo';
import { createKnowledgePoint } from './study';
import { freshDatabase, save, saveOn } from './test-vault';
import { purge } from './trash';

beforeEach(async () => {
  await freshDatabase();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

async function world() {
  const h1 = await save('Aspirin irreversibly inhibits cyclooxygenase in platelets.');
  const h2 = await saveOn(
    'https://example.org/clopidogrel',
    'Clopidogrel blocks the P2Y12   receptor\n on platelets.',
  );
  const note = await createNote({
    highlightId: h1.id,
    title: 'Compare',
    body: 'Both are antiplatelets.',
  });
  const kp = await createKnowledgePoint({ highlightId: h2.id, shortOneLiner: 'P2Y12 block' });
  return { h1, h2, note, kp };
}

const hl = (h: HighlightView) => ({ kind: 'highlight' as const, id: h.id });

describe('listLinks', () => {
  it('describes the other end of each link, for both directions and all three kinds', async () => {
    const w = await world();
    await createRelation({
      fromKind: 'highlight',
      fromId: w.h1.id,
      toKind: 'highlight',
      toId: w.h2.id,
      type: 'contradicts',
      note: 'check the dose',
    });
    await createRelation({
      fromKind: 'note',
      fromId: w.note.id,
      toKind: 'highlight',
      toId: w.h1.id,
      type: 'supports',
    });
    await createRelation({
      fromKind: 'highlight',
      fromId: w.h1.id,
      toKind: 'knowledgePoint',
      toId: w.kp.id,
      type: 'example',
    });

    const links = await listLinks(hl(w.h1));
    expect(links).toHaveLength(3);
    const byKind = Object.fromEntries(links.map((l) => [l.other.kind, l]));

    expect(byKind.highlight!.direction).toBe('out');
    expect(byKind.highlight!.relation.note).toBe('check the dose');
    expect(byKind.highlight!.other).toMatchObject({
      id: w.h2.id,
      // whitespace is collapsed to one line
      text: 'Clopidogrel blocks the P2Y12 receptor on platelets.',
      highlightId: w.h2.id,
      host: 'example.org',
    });
    expect(byKind.highlight!.other.sourceTitle).toContain('https://example.org/clopidogrel');

    expect(byKind.note!.direction).toBe('in');
    expect(byKind.note!.other).toMatchObject({
      text: 'Compare: Both are antiplatelets.',
      highlightId: w.h1.id,
    });

    expect(byKind.knowledgePoint!.other).toMatchObject({
      text: 'P2Y12 block',
      highlightId: w.h2.id, // opening a knowledge point shows its highlight
    });

    // The backlink appears on the other item without anything being created there.
    const back = await listLinks(hl(w.h2));
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ direction: 'in', other: { id: w.h1.id } });
  });

  it('hides a link while an end is in the trash and brings it back on restore', async () => {
    const w = await world();
    await createRelation({
      fromKind: 'highlight',
      fromId: w.h1.id,
      toKind: 'highlight',
      toId: w.h2.id,
      type: 'related',
    });
    expect(await listLinks(hl(w.h1))).toHaveLength(1);
    await softDeleteHighlight(w.h2.id);
    expect(await listLinks(hl(w.h1))).toHaveLength(0);
    expect(await listAllRelations()).toHaveLength(0);
    await restoreHighlight(w.h2.id);
    expect(await listLinks(hl(w.h1))).toHaveLength(1);
  });

  it('hides a link to a note or knowledge point whose highlight is in the trash', async () => {
    const w = await world();
    const h3 = await save('Heparin activates antithrombin and is monitored by the aPTT.');
    await createRelation({
      fromKind: 'highlight',
      fromId: h3.id,
      toKind: 'note',
      toId: w.note.id, // written on h1
      type: 'supports',
    });
    await createRelation({
      fromKind: 'highlight',
      fromId: h3.id,
      toKind: 'knowledgePoint',
      toId: w.kp.id, // derived from h2
      type: 'cause',
    });
    expect(await listLinks(hl(h3))).toHaveLength(2);

    await softDeleteHighlight(w.h1.id); // h3 itself is live: only the note's host is gone
    expect((await listLinks(hl(h3))).map((l) => l.other.kind)).toEqual(['knowledgePoint']);
    expect(await listRelationsFor({ kind: 'note', id: w.note.id })).toHaveLength(0);

    await softDeleteHighlight(w.h2.id);
    expect(await listAllRelations()).toHaveLength(0);

    await restoreHighlight(w.h1.id);
    expect((await listLinks(hl(h3))).map((l) => l.other.kind)).toEqual(['note']);
    await restoreHighlight(w.h2.id);
    expect(await listAllRelations()).toHaveLength(2);
  });

  it('does not list a deleted link, and purging an end removes its links for good', async () => {
    const w = await world();
    const made = await createRelation({
      fromKind: 'highlight',
      fromId: w.h1.id,
      toKind: 'highlight',
      toId: w.h2.id,
      type: 'prerequisite',
    });
    await deleteRelation(made.relation.id);
    expect(await listLinks(hl(w.h1))).toEqual([]);

    await createRelation({
      fromKind: 'highlight',
      fromId: w.h1.id,
      toKind: 'highlight',
      toId: w.h2.id,
      type: 'prerequisite',
    });
    await softDeleteHighlight(w.h2.id);
    await purge([{ kind: 'highlight', id: w.h2.id }]);
    await restoreHighlight(w.h1.id).catch(() => undefined);
    expect(await listLinks(hl(w.h1))).toEqual([]);
    expect((await loadGraph()).relations).toEqual([]);
  });
});

describe('describeEnds', () => {
  it('leaves out what does not exist and what cannot be opened', async () => {
    const w = await world();
    await softDeleteHighlight(w.h2.id);
    const ends = await describeEnds([
      hl(w.h1),
      hl(w.h2), // trashed
      { kind: 'highlight', id: '0190aaaa-0000-7000-8000-000000000000' }, // unknown
      { kind: 'note', id: w.note.id },
      { kind: 'knowledgePoint', id: w.kp.id }, // its highlight (h2) is trashed
    ]);
    expect([...ends.keys()].sort()).toEqual([`highlight:${w.h1.id}`, `note:${w.note.id}`].sort());
  });
});

describe('loadGraph and findKnowledgePoints', () => {
  it('loads every visible link', async () => {
    const w = await world();
    await createRelation({
      fromKind: 'highlight',
      fromId: w.h1.id,
      toKind: 'note',
      toId: w.note.id,
      type: 'example',
    });
    const graph = await loadGraph();
    expect(graph.truncated).toBe(false);
    expect(graph.relations.map((r) => r.type)).toEqual(['example']);
  });

  it('finds knowledge points by their text, newest first, and not those of a trashed highlight', async () => {
    const w = await world();
    const other = await createKnowledgePoint({
      highlightId: w.h1.id,
      shortOneLiner: 'COX-1 block',
      examPearl: 'Platelets cannot make new enzyme',
    });
    expect((await findKnowledgePoints('')).map((e) => e.id)).toEqual([other.id, w.kp.id]);
    expect((await findKnowledgePoints('p2y12')).map((e) => e.id)).toEqual([w.kp.id]);
    expect((await findKnowledgePoints('NEW ENZYME')).map((e) => e.id)).toEqual([other.id]);
    expect(await findKnowledgePoints('nothing like this')).toEqual([]);
    await softDeleteHighlight(w.h2.id);
    expect((await findKnowledgePoints('')).map((e) => e.id)).toEqual([other.id]);
  });
});
