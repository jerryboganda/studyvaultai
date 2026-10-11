import 'fake-indexeddb/auto';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createNote, createRelation, restoreHighlight, softDeleteHighlight } from '@storage';
import type { RelationRef } from '@storage';
import { freshDatabase, save } from '@storage/test-vault';
import { ToastProvider } from '@ui';
import GraphView from './GraphView';

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 60_000 });

beforeEach(async () => {
  await freshDatabase();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(cleanup);

const TEXT = {
  a: 'Aspirin irreversibly inhibits cyclooxygenase in platelets.',
  b: 'Clopidogrel blocks the P2Y12 receptor on platelets.',
  c: 'Heparin activates antithrombin and is monitored by the aPTT.',
  d: 'Warfarin inhibits vitamin K epoxide reductase.',
  e: 'The mitral valve separates the left atrium from the left ventricle.',
} as const;

const hl = (id: string): RelationRef => ({ kind: 'highlight', id });

/** a -supports-> b -contradicts-> c -cause-> d, plus a note on a linked to b; e has no links. */
async function world() {
  const made: Array<Awaited<ReturnType<typeof save>>> = [];
  for (const [i, quote] of [TEXT.a, TEXT.b, TEXT.c, TEXT.d, TEXT.e].entries()) {
    made.push(await save(quote, {}, 100 + i * 500));
  }
  const [a, b, c, d, e] = made;
  const note = await createNote({
    highlightId: a!.id,
    title: 'Platelets',
    body: 'Two drug classes.',
  });
  const link = (
    fromId: string,
    toId: string,
    type: 'supports' | 'contradicts' | 'cause' | 'example',
    toKind: 'highlight' | 'note' = 'highlight',
  ) => createRelation({ fromKind: 'highlight', fromId, toKind, toId, type });
  await link(a!.id, b!.id, 'supports');
  await link(b!.id, c!.id, 'contradicts');
  await link(c!.id, d!.id, 'cause');
  await link(b!.id, note.id, 'example', 'note');
  return { a: a!, b: b!, c: c!, d: d!, e: e!, note };
}

function Harness({
  start,
  onShow = () => undefined,
  onBack = () => undefined,
  onCentreSpy,
}: {
  start: RelationRef | null;
  onShow?(id: string): void;
  onBack?(): void;
  onCentreSpy?(next: RelationRef | null): void;
}) {
  const [centre, setCentre] = useState<RelationRef | null>(start);
  return (
    <ToastProvider>
      <GraphView
        centre={centre}
        onCentre={(next) => {
          onCentreSpy?.(next);
          setCentre(next);
        }}
        onShow={onShow}
        onBack={onBack}
      />
    </ToastProvider>
  );
}

const nodes = () => screen.queryAllByTestId('graph-node');
/** The names of the items arrive in a second read; wait for one of them. */
const named = (key: string, text: string) =>
  waitFor(() =>
    expect(
      screen.queryAllByTestId('connection-row').find((r) => r.getAttribute('data-node') === key)
        ?.textContent,
    ).toContain(text),
  );
const rows = () => screen.queryAllByTestId('connection-row');
const rowText = (key: string) =>
  rows().find((r) => r.getAttribute('data-node') === key)?.textContent ?? '';

describe('GraphView overview', () => {
  it('says what to do when there are no links yet', async () => {
    render(<Harness start={null} />);
    expect(await screen.findByText('No links yet')).toBeTruthy();
  });

  it('lists the most connected items and the groups instead of drawing everything', async () => {
    const w = await world();
    // a second, separate group
    const x = await save('Statins inhibit HMG-CoA reductase.', {}, 5000);
    const y = await save('LDL cholesterol falls with statin therapy.', {}, 5600);
    await createRelation({
      fromKind: 'highlight',
      fromId: x.id,
      toKind: 'highlight',
      toId: y.id,
      type: 'related',
    });
    const spy = vi.fn();
    render(<Harness start={null} onCentreSpy={spy} />);

    const summary = await screen.findByTestId('graph-summary');
    // 5 links between 6 items (a, b, c, d, the note, ... plus x and y), in 2 groups
    await waitFor(() =>
      expect(summary.textContent).toMatch(/^5 links between 7 items, in 2 groups/),
    );
    expect(screen.queryByTestId('graph-svg')).toBeNull(); // not a picture of everything

    await waitFor(() =>
      expect(screen.getAllByTestId('graph-top-item')[0]!.textContent).toContain(TEXT.b),
    );
    const top = screen.getAllByTestId('graph-top-item');
    // b has three connections (a, c, the note): the most connected comes first
    expect(top[0]!.getAttribute('data-node')).toBe(`highlight:${w.b.id}`);
    expect(top[0]!.textContent).toContain('3 connections');
    expect(top[0]!.textContent).toContain(TEXT.b);

    const groups = screen.getAllByTestId('graph-group');
    expect(groups).toHaveLength(2);
    expect(groups[0]!.textContent).toContain('5 items');
    expect(groups[1]!.textContent).toContain('2 items');

    await userEvent.click(within(top[0]!).getByTestId('graph-centre'));
    expect(spy).toHaveBeenCalledWith({ kind: 'highlight', id: w.b.id });
    expect(await screen.findByTestId('graph-svg')).toBeTruthy();
  });
});

describe('GraphView around an item', () => {
  it('draws the neighbourhood and holds the same information in the Connections table', async () => {
    const w = await world();
    render(<Harness start={hl(w.b.id)} />);

    await waitFor(() => expect(nodes()).toHaveLength(4));
    await named(`highlight:${w.a.id}`, TEXT.a); // the read that names all four
    expect(screen.getByTestId('graph-summary').textContent).toBe('4 items and 3 links.');
    expect(rows()).toHaveLength(4);

    // the centre first, with what each link says
    const centreRow = rows()[0]!;
    expect(centreRow.getAttribute('data-node')).toBe(`highlight:${w.b.id}`);
    expect(centreRow.getAttribute('data-depth')).toBe('0');
    expect(
      within(centreRow)
        .getAllByTestId('connection-link')
        .map((l) => l.textContent),
    ).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Supported by Aspirin/),
        expect.stringMatching(/^Contradicts Heparin/),
        expect.stringMatching(/^Is an example of Platelets/),
      ]),
    );
    expect(rowText(`highlight:${w.a.id}`)).toContain(TEXT.a);
    expect(rowText(`note:${w.note.id}`)).toContain('Platelets: Two drug classes.');
    expect(rowText(`highlight:${w.c.id}`)).toContain(TEXT.c);
    // d is two links away: not shown at one link
    expect(rowText(`highlight:${w.d.id}`)).toBe('');

    // every node has a name that says what and where
    const centreNode = nodes().find((n) => n.getAttribute('data-centre') === 'true')!;
    expect(centreNode.getAttribute('aria-label')).toMatch(/^Highlight: Clopidogrel blocks/);
    expect(centreNode.getAttribute('aria-label')).toContain('3 links');
    expect(centreNode.getAttribute('aria-label')).toContain('The centre of the graph');
    expect(centreNode.getAttribute('role')).toBe('button');
    // only one node is a tab stop
    expect(nodes().filter((n) => n.getAttribute('tabindex') === '0')).toEqual([centreNode]);

    // the legend names every type in words, with its line style
    const legend = screen.getByTestId('graph-legend').textContent ?? '';
    for (const word of [
      'Related thin solid line, no arrow',
      'Supports thick solid line, arrow',
      'Contradicts dashed line, arrow',
      'Cause dotted line, arrow',
      'Example dash-dot line, arrow',
      'Prerequisite long-dash line, arrow',
    ]) {
      expect(legend).toContain(word);
    }
    // edges carry a dash pattern, not only a colour
    const dashed = screen
      .getAllByTestId('graph-edge')
      .find((e) => e.getAttribute('data-type') === 'contradicts')!;
    expect(dashed.querySelector('path')!.getAttribute('stroke-dasharray')).toBeTruthy();
    const solid = screen
      .getAllByTestId('graph-edge')
      .find((e) => e.getAttribute('data-type') === 'supports')!;
    expect(solid.querySelector('path')!.getAttribute('stroke-dasharray')).toBeNull();
  });

  it('reaches two links away when asked, and centres on an item from the table', async () => {
    const w = await world();
    const spy = vi.fn();
    render(<Harness start={hl(w.b.id)} onCentreSpy={spy} />);
    await waitFor(() => expect(nodes()).toHaveLength(4));

    await userEvent.click(screen.getByTestId('graph-depth-2'));
    await waitFor(() => expect(nodes()).toHaveLength(5));
    await named(`highlight:${w.d.id}`, TEXT.d);
    expect(rowText(`highlight:${w.d.id}`)).toContain(TEXT.d);
    expect(
      rows()
        .find((r) => r.getAttribute('data-node') === `highlight:${w.d.id}`)!
        .getAttribute('data-depth'),
    ).toBe('2');

    const row = rows().find((r) => r.getAttribute('data-node') === `highlight:${w.c.id}`)!;
    await userEvent.click(within(row).getByTestId('connection-centre'));
    expect(spy).toHaveBeenCalledWith({ kind: 'highlight', id: w.c.id });
    await waitFor(() => expect(rows()[0]!.getAttribute('data-node')).toBe(`highlight:${w.c.id}`));
  });

  it('caps the picture at 60 items and shows more on request', async () => {
    const hub = await save('A hub highlight that many others are linked to.', {}, 100);
    const made: string[] = [];
    for (let i = 0; i < 65; i++) {
      const leaf = await save(`Leaf highlight number ${i} of the hub.`, {}, 1000 + i * 100);
      made.push(leaf.id);
      await createRelation({
        fromKind: 'highlight',
        fromId: hub.id,
        toKind: 'highlight',
        toId: leaf.id,
        type: 'related',
      });
    }
    render(<Harness start={hl(hub.id)} />);
    await waitFor(() => expect(nodes()).toHaveLength(60), { timeout: 20_000 });
    expect(rows()).toHaveLength(60);
    expect(screen.getByTestId('graph-summary').textContent).toContain('6 more within reach');
    const more = screen.getByTestId('graph-more');
    expect(more.textContent).toBe('Show 6 more (66 within reach)');
    await userEvent.click(more);
    await waitFor(() => expect(nodes()).toHaveLength(66));
    expect(screen.queryByTestId('graph-more')).toBeNull();
  });

  it('is operated from the keyboard: arrows walk the links, Enter opens, C centres, Escape returns', async () => {
    const w = await world();
    const onShow = vi.fn();
    const onBack = vi.fn();
    const spy = vi.fn();
    render(<Harness start={hl(w.b.id)} onShow={onShow} onBack={onBack} onCentreSpy={spy} />);
    await waitFor(() => expect(nodes()).toHaveLength(4));
    await named(`highlight:${w.c.id}`, TEXT.c);
    const svg = screen.getByTestId('graph-svg');
    const centreKey = `highlight:${w.b.id}`;
    const node = (key: string) => nodes().find((n) => n.getAttribute('data-node') === key)!;
    const key = (k: string) => {
      const target = document.activeElement as Element;
      fireEvent.keyDown(target, { key: k });
    };

    act(() => node(centreKey).focus());
    expect(document.activeElement).toBe(node(centreKey));

    key('ArrowRight'); // into a linked item
    const first = document.activeElement!.getAttribute('data-node')!;
    expect(first).not.toBe(centreKey);
    expect([`highlight:${w.a.id}`, `highlight:${w.c.id}`, `note:${w.note.id}`]).toContain(first);
    expect(svg.contains(document.activeElement)).toBe(true);

    key('ArrowDown'); // the next item linked from the centre
    const second = document.activeElement!.getAttribute('data-node')!;
    expect(second).not.toBe(first);
    expect(second).not.toBe(centreKey);
    key('ArrowUp'); // and back to the first
    expect(document.activeElement!.getAttribute('data-node')).toBe(first);

    key('ArrowLeft'); // back out to where the walk started
    expect(document.activeElement!.getAttribute('data-node')).toBe(centreKey);

    // Enter opens the highlight of the item that has focus
    key('ArrowRight');
    const at = document.activeElement!.getAttribute('data-node')!;
    key('Enter');
    expect(onShow).toHaveBeenCalledWith(at.replace('highlight:', ''));

    key('c');
    expect(spy).toHaveBeenLastCalledWith({ kind: 'highlight', id: at.replace('highlight:', '') });

    fireEvent.keyDown(screen.getByTestId('graph-view'), { key: 'Escape' });
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('zooms and fits with buttons and keys', async () => {
    const w = await world();
    render(<Harness start={hl(w.b.id)} />);
    await waitFor(() => expect(nodes()).toHaveLength(4));
    const zoom = () => screen.getByTestId('graph-zoom').textContent;
    expect(zoom()).toBe('100%'); // jsdom has no layout: fit is the natural size
    await userEvent.click(screen.getByTestId('graph-zoom-in'));
    expect(zoom()).toBe('125%');
    await userEvent.click(screen.getByTestId('graph-zoom-out'));
    await userEvent.click(screen.getByTestId('graph-zoom-out'));
    expect(zoom()).toBe('80%');
    await userEvent.click(screen.getByTestId('graph-fit'));
    expect(zoom()).toBe('100%');
    act(() => nodes()[0]!.focus());
    fireEvent.keyDown(document.activeElement!, { key: '+' });
    expect(zoom()).toBe('125%');
    fireEvent.keyDown(document.activeElement!, { key: '0' });
    expect(zoom()).toBe('100%');
  });

  it('hides a link whose end is in the trash, live, and shows it again on restore', async () => {
    const w = await world();
    render(<Harness start={hl(w.b.id)} />);
    await waitFor(() => expect(nodes()).toHaveLength(4));

    await softDeleteHighlight(w.c.id);
    await waitFor(() => expect(nodes()).toHaveLength(3));
    expect(rowText(`highlight:${w.c.id}`)).toBe('');
    expect(screen.getByTestId('graph-summary').textContent).toBe('3 items and 2 links.');

    await restoreHighlight(w.c.id);
    await waitFor(() => expect(nodes()).toHaveLength(4));
  });

  it('says so when the centre is no longer available, and offers the overview', async () => {
    const w = await world();
    await softDeleteHighlight(w.b.id);
    render(<Harness start={hl(w.b.id)} />);
    expect(await screen.findByText('This item is no longer available')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Show the overview' }));
    expect(await screen.findByTestId('graph-summary')).toBeTruthy();
    expect(screen.queryByTestId('graph-svg')).toBeNull();
  });

  it('draws a lone item and says it has no links', async () => {
    const w = await world();
    render(<Harness start={hl(w.e.id)} />);
    expect(await screen.findByText('This item has no links yet')).toBeTruthy();
    await waitFor(() => expect(nodes()).toHaveLength(1));
  });

  it('shows a note that belongs to no highlight with Open unavailable and the reason', async () => {
    const w = await world();
    const loose = await createNote({ body: 'A loose thought about platelets.' });
    await createRelation({
      fromKind: 'highlight',
      fromId: w.a.id,
      toKind: 'note',
      toId: loose.id,
      type: 'related',
    });
    render(<Harness start={hl(w.a.id)} />);
    await waitFor(() => expect(nodes().length).toBeGreaterThanOrEqual(3));
    await named(`note:${loose.id}`, 'A loose thought about platelets.');
    const row = rows().find((r) => r.getAttribute('data-node') === `note:${loose.id}`)!;
    const open = within(row).getByTestId('connection-open');
    expect(open.getAttribute('aria-disabled')).toBe('true');
    expect(open.getAttribute('title')).toMatch(/not attached to a highlight/);
    expect(row.textContent).toContain('Note');
    expect(row.textContent).toContain('A loose thought about platelets.');
  });
});
