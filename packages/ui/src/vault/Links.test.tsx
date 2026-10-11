import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createSearchIndex, type RelatedHit } from '@search';
import {
  createKnowledgePoint,
  createNote,
  createRelation,
  listAllRelations,
  listSearchDocuments,
  restoreHighlight,
  softDeleteHighlight,
  type RelationRef,
} from '@storage';
import { freshDatabase, save, saveOn } from '@storage/test-vault';
import { ToastProvider } from '../Toast';
import { LinksSection, storageLinks, type LinkSearchPort, type LinksPort } from './Links';
import { RelatedSection, type RelatedPort } from './Related';

configure({ asyncUtilTimeout: 10_000 });

beforeEach(async () => {
  await freshDatabase();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(cleanup);

const ASPIRIN = 'Aspirin irreversibly inhibits cyclooxygenase in platelets.';
const CLOPIDOGREL = 'Clopidogrel blocks the P2Y12 receptor on platelets.';
const HEPARIN = 'Heparin activates antithrombin and is monitored by the aPTT.';

async function world() {
  const h1 = await save(ASPIRIN);
  const h2 = await saveOn('https://example.org/p2y12', CLOPIDOGREL);
  const h3 = await save(HEPARIN);
  return { h1, h2, h3 };
}

const hl = (id: string): RelationRef => ({ kind: 'highlight', id });

/** The picker's index, built from the real vault. */
async function index(): Promise<LinkSearchPort> {
  const docs = await listSearchDocuments({ limit: 500 });
  const idx = createSearchIndex();
  idx.applyChanges(docs);
  return {
    state: { phase: 'ready', documents: docs.length, rejected: 0 },
    revision: 1,
    search: (query, options) => idx.search(query, options),
  };
}

async function show(
  item: RelationRef,
  options: { port?: LinksPort; eager?: boolean; onOpen?: (id: string) => void } = {},
) {
  const search = await index();
  const onOpen = options.onOpen ?? vi.fn();
  render(
    <ToastProvider>
      <LinksSection
        item={item}
        port={options.port ?? storageLinks}
        search={search}
        onOpen={onOpen}
        eager={options.eager}
      />
    </ToastProvider>,
  );
  return { onOpen };
}

const toggle = () => screen.getByTestId('links-toggle');
const items = () => screen.queryAllByTestId('link-item');
const open = async () => {
  await userEvent.click(toggle());
  await screen.findByTestId('links-summary');
};

describe('LinksSection', () => {
  it('is collapsed and reads nothing until it is opened', async () => {
    const w = await world();
    const list = vi.fn(storageLinks.list);
    await show(hl(w.h1.id), { port: { ...storageLinks, list } });
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(toggle().textContent).toBe('Show links');
    expect(list).not.toHaveBeenCalled();
    expect(document.getElementById(toggle().getAttribute('aria-controls')!)!.hidden).toBe(true);

    await open();
    expect(list).toHaveBeenCalledWith(hl(w.h1.id));
    expect(screen.getByTestId('links-summary').textContent).toMatch(/^No links yet/);
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
  });

  it('lists links out and in with the other end and its source, and shows the backlink', async () => {
    const w = await world();
    await createRelation({
      fromKind: 'highlight',
      fromId: w.h1.id,
      toKind: 'highlight',
      toId: w.h2.id,
      type: 'supports',
      note: 'same pathway',
    });
    await createRelation({
      fromKind: 'highlight',
      fromId: w.h3.id,
      toKind: 'highlight',
      toId: w.h1.id,
      type: 'contradicts',
    });

    const { onOpen } = await show(hl(w.h1.id), { eager: true });
    await waitFor(() => expect(toggle().textContent).toBe('Show links (2)'));
    await open();
    const rows = items();
    expect(rows).toHaveLength(2);
    const byType = Object.fromEntries(rows.map((r) => [r.getAttribute('data-type'), r]));

    const out = byType.supports!;
    expect(out.getAttribute('data-direction')).toBe('out');
    expect(within(out).getByTestId('link-phrase').textContent).toBe('Supports');
    expect(within(out).getByTestId('link-text').textContent).toBe(CLOPIDOGREL);
    expect(out.textContent).toContain('https://example.org/p2y12');
    expect(within(out).getByTestId('link-note').textContent).toContain('same pathway');
    expect((within(out).getByTestId('link-type') as HTMLSelectElement).value).toBe('supports');

    const back = byType.contradicts!;
    expect(back.getAttribute('data-direction')).toBe('in');
    expect(within(back).getByTestId('link-phrase').textContent).toBe('Contradicted by');
    expect(within(back).getByTestId('link-text').textContent).toBe(HEPARIN);

    await userEvent.click(within(out).getByTestId('link-open'));
    expect(onOpen).toHaveBeenCalledWith(w.h2.id);
  });

  it('shows a link on the other item without creating anything there', async () => {
    const w = await world();
    await createRelation({
      fromKind: 'highlight',
      fromId: w.h1.id,
      toKind: 'highlight',
      toId: w.h2.id,
      type: 'cause',
    });
    await show(hl(w.h2.id), { eager: true });
    await open();
    expect(items()).toHaveLength(1);
    expect(within(items()[0]!).getByTestId('link-phrase').textContent).toBe('Caused by');
    expect(await listAllRelations()).toHaveLength(1);
  });

  it('adds a link: search, choose, type, note; and refuses itself and a repeat clearly', async () => {
    const w = await world();
    await show(hl(w.h1.id));
    await open();
    await userEvent.click(screen.getByTestId('link-add'));

    // Itself is listed, but cannot be chosen.
    await userEvent.type(screen.getByTestId('link-search'), 'aspirin');
    const self = await screen.findByTestId('link-candidate');
    expect(self.textContent).toContain('this is the item you are linking from');
    expect(within(self).getByRole('radio').hasAttribute('disabled')).toBe(true);

    await userEvent.clear(screen.getByTestId('link-search'));
    await userEvent.type(screen.getByTestId('link-search'), 'clopidogrel');
    const candidate = await screen.findByTestId('link-candidate');
    expect(candidate.getAttribute('data-id')).toBe(w.h2.id);
    expect(screen.getByTestId('link-submit').getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByTestId('link-submit').getAttribute('title')).toBe(
      'Choose the item to link to first.',
    );
    await userEvent.click(within(candidate).getByRole('radio'));
    await userEvent.selectOptions(screen.getByTestId('link-new-type'), 'cause');
    await userEvent.type(screen.getByTestId('link-new-note'), 'both stop clotting');
    await userEvent.click(screen.getByTestId('link-submit'));

    await waitFor(() => expect(items()).toHaveLength(1));
    expect(screen.queryByTestId('link-picker')).toBeNull();
    const stored = await listAllRelations();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      fromId: w.h1.id,
      toId: w.h2.id,
      type: 'cause',
      note: 'both stop clotting',
    });

    // The same link again is refused before anything is written; another type is allowed.
    await userEvent.click(screen.getByTestId('link-add'));
    await userEvent.type(screen.getByTestId('link-search'), 'clopidogrel');
    const again = await screen.findByTestId('link-candidate');
    expect(again.textContent).toContain('already linked: Cause');
    await userEvent.click(within(again).getByRole('radio'));
    await userEvent.selectOptions(screen.getByTestId('link-new-type'), 'cause');
    expect(screen.getByTestId('link-reason').textContent).toMatch(/^Already linked as Cause/);
    expect(screen.getByTestId('link-submit').getAttribute('aria-disabled')).toBe('true');
    await userEvent.selectOptions(screen.getByTestId('link-new-type'), 'supports');
    expect(screen.queryByTestId('link-reason')).toBeNull();
    expect(screen.getByTestId('link-submit').getAttribute('aria-disabled')).toBeNull();
  });

  it('adds a link in the other direction and to a knowledge point', async () => {
    const w = await world();
    const kp = await createKnowledgePoint({ highlightId: w.h2.id, shortOneLiner: 'P2Y12 block' });
    await show(hl(w.h1.id));
    await open();
    await userEvent.click(screen.getByTestId('link-add'));
    await userEvent.selectOptions(screen.getByTestId('link-where'), 'points');
    await userEvent.type(screen.getByTestId('link-search'), 'p2y12');
    const candidate = await screen.findByTestId('link-candidate');
    expect(candidate.getAttribute('data-kind')).toBe('knowledgePoint');
    await userEvent.click(within(candidate).getByRole('radio'));
    await userEvent.selectOptions(screen.getByTestId('link-new-type'), 'prerequisite');
    await userEvent.selectOptions(screen.getByTestId('link-new-direction'), 'in');
    await userEvent.click(screen.getByTestId('link-submit'));

    await waitFor(() => expect(items()).toHaveLength(1));
    expect(await listAllRelations()).toMatchObject([
      {
        fromKind: 'knowledgePoint',
        fromId: kp.id,
        toKind: 'highlight',
        toId: w.h1.id,
        type: 'prerequisite',
      },
    ]);
    expect(within(items()[0]!).getByTestId('link-phrase').textContent).toBe('Has the prerequisite');
  });

  it('changes the type, edits the note and removes, each with an undo', async () => {
    const w = await world();
    await createRelation({
      fromKind: 'highlight',
      fromId: w.h1.id,
      toKind: 'highlight',
      toId: w.h2.id,
      type: 'related',
    });
    await show(hl(w.h1.id));
    await open();
    await waitFor(() => expect(items()).toHaveLength(1));

    // type
    await userEvent.selectOptions(screen.getByTestId('link-type'), 'contradicts');
    await waitFor(() => expect(items()[0]!.getAttribute('data-type')).toBe('contradicts'));
    expect((await listAllRelations()).map((r) => r.type)).toEqual(['contradicts']);
    await userEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(items()[0]!.getAttribute('data-type')).toBe('related'));
    expect((await listAllRelations()).map((r) => r.type)).toEqual(['related']);

    // note
    await userEvent.click(screen.getByTestId('link-note-edit'));
    await userEvent.type(screen.getByTestId('link-note-input'), 'see chapter 4');
    await userEvent.click(screen.getByTestId('link-note-save'));
    await waitFor(() =>
      expect(screen.getByTestId('link-note').textContent).toContain('see chapter 4'),
    );
    expect((await listAllRelations())[0]!.note).toBe('see chapter 4');

    // remove
    await userEvent.click(screen.getByTestId('link-remove'));
    await waitFor(() => expect(items()).toHaveLength(0));
    expect(await listAllRelations()).toEqual([]);
    const undo = await screen.findByRole('button', { name: 'Undo' });
    expect(document.activeElement).toBe(undo); // the removed row took its focused button with it
    await userEvent.click(undo);
    await waitFor(() => expect(items()).toHaveLength(1));
    expect(await listAllRelations()).toHaveLength(1);
  });

  it('says so when a type change would repeat an existing link', async () => {
    const w = await world();
    await createRelation({
      fromKind: 'highlight',
      fromId: w.h1.id,
      toKind: 'highlight',
      toId: w.h2.id,
      type: 'related',
    });
    await createRelation({
      fromKind: 'highlight',
      fromId: w.h1.id,
      toKind: 'highlight',
      toId: w.h2.id,
      type: 'supports',
    });
    await show(hl(w.h1.id));
    await open();
    await waitFor(() => expect(items()).toHaveLength(2));
    const related = items().find((r) => r.getAttribute('data-type') === 'related')!;
    await userEvent.selectOptions(within(related).getByTestId('link-type'), 'supports');
    expect(await screen.findByText('These two items are already linked as Supports.')).toBeTruthy();
    expect(await listAllRelations()).toHaveLength(2);
  });

  it('follows the trash live: a trashed end hides the link, restoring brings it back', async () => {
    const w = await world();
    const note = await createNote({ highlightId: w.h2.id, body: 'Loading dose is 300 mg.' });
    await createRelation({
      fromKind: 'highlight',
      fromId: w.h1.id,
      toKind: 'highlight',
      toId: w.h2.id,
      type: 'related',
    });
    await createRelation({
      fromKind: 'highlight',
      fromId: w.h1.id,
      toKind: 'note',
      toId: note.id,
      type: 'example',
    });
    await show(hl(w.h1.id));
    await open();
    await waitFor(() => expect(items()).toHaveLength(2));

    await softDeleteHighlight(w.h2.id); // the highlight, and so its note, are out of reach
    await waitFor(() => expect(items()).toHaveLength(0));
    expect(screen.getByTestId('links-summary').textContent).toMatch(/^No links yet/);

    await restoreHighlight(w.h2.id);
    await waitFor(() => expect(items()).toHaveLength(2));
  });

  it('explains a note that belongs to nothing instead of offering Open', async () => {
    const w = await world();
    const loose = await createNote({ body: 'A thought with no highlight.' });
    await createRelation({
      fromKind: 'highlight',
      fromId: w.h1.id,
      toKind: 'note',
      toId: loose.id,
      type: 'related',
    });
    await show(hl(w.h1.id));
    await open();
    await waitFor(() => expect(items()).toHaveLength(1));
    const button = within(items()[0]!).getByTestId('link-open');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('title')).toMatch(/not attached to a highlight/);
  });
});

describe('a Related suggestion becomes a link in one click', () => {
  it('creates a "related" link and says it is linked; a second click would be "existing"', async () => {
    const w = await world();
    const hit = {
      highlightId: w.h2.id,
      doc: {
        id: w.h2.id,
        docType: 'highlight',
        highlightId: w.h2.id,
        title: 'Page',
        url: null,
        host: 'example.org',
        quote: CLOPIDOGREL,
        comment: '',
        headingContext: null,
        tags: [],
        banks: [],
        folderPath: [],
        kind: 'essential',
        priority: 3,
        resolveStatus: 'resolved',
        updatedAt: '2026-01-01T00:00:00.000Z',
        deletedAt: null,
      },
      score: 1,
      sharedTerms: ['platelets'],
      explanation: 'shares: platelets',
    } satisfies RelatedHit;
    const port: RelatedPort = {
      state: { phase: 'ready', documents: 3, rejected: 0 },
      revision: 1,
      find: () => ({ found: true, hits: [hit], total: 1, terms: ['platelets'], took: 1 }),
    };
    render(
      <RelatedSection
        id={w.h1.id}
        port={port}
        onOpen={() => undefined}
        onLink={async (other) => {
          await storageLinks.create({
            fromKind: 'highlight',
            fromId: w.h1.id,
            toKind: 'highlight',
            toId: other,
            type: 'related',
          });
        }}
      />,
    );
    await userEvent.click(screen.getByTestId('related-toggle'));
    await userEvent.click(await screen.findByTestId('related-link'));
    expect((await screen.findByTestId('related-linked')).textContent).toBe('Linked as Related');
    expect(screen.queryByTestId('related-link')).toBeNull();
    expect(await listAllRelations()).toMatchObject([
      { fromId: w.h1.id, toId: w.h2.id, type: 'related' },
    ]);
  });

  it('has no link button when the surface gives no way to link', async () => {
    const port: RelatedPort = {
      state: { phase: 'ready', documents: 0, rejected: 0 },
      revision: 1,
      find: () => ({ found: true, hits: [], total: 0, terms: [], took: 1 }),
    };
    render(<RelatedSection id="h1" port={port} onOpen={() => undefined} />);
    await userEvent.click(screen.getByTestId('related-toggle'));
    expect(screen.queryByTestId('related-link')).toBeNull();
  });
});
