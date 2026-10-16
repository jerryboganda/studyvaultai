import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { browser } from 'wxt/browser';
import {
  attachTags,
  createBank,
  createCardsFromHighlight,
  createSyllabus,
  createTag,
  getDb,
  softDeleteHighlight,
} from '@storage';
import { loadCoverageThresholds } from '@storage/syllabusCoverage';
import { freshDatabase, save } from '@storage/test-vault';
import { TID, defaultStudySettings, syllabusExamId, syllabusShowId } from '@ui/review';
import SyllabusCoverage from './SyllabusCoverage';

vi.setConfig({ testTimeout: 30_000 });
// Several agents and CI shards share the CPU: waiting for the page is not a failure.
configure({ asyncUtilTimeout: 10_000 });

const DAY = 86_400_000;
const settings = { ...defaultStudySettings(), timeZone: 'UTC', rolloverHour: 0 };

beforeEach(async () => {
  await freshDatabase();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * Cardiology: h1, h2, h3 (h1 and h2 have a card, h1's is a graduated card that is due) and h5 in the
 * trash. Renal: h4. A tag on h4. The syllabus weights Cardiology 3, Renal 1 and leaves "Planned"
 * (1) unmapped, so the shares are 60 %, 20 % and 20 %.
 */
async function seed() {
  const cardio = await createBank('Cardiology');
  const renal = await createBank('Renal');
  const { tag } = await createTag('High Yield');
  const h1 = await save('Stroke volume is the blood ejected per beat.', { bankId: cardio.id });
  const h2 = await save('Preload is end-diastolic ventricular stretch.', { bankId: cardio.id });
  await save('Afterload is the resistance the ventricle ejects against.', { bankId: cardio.id });
  const h4 = await save('Creatinine rises late in acute kidney injury.', { bankId: renal.id });
  const h5 = await save('A fact that was thrown away.', { bankId: cardio.id });
  await attachTags({ highlightIds: [h4.id], tagIds: [tag.id] });
  await softDeleteHighlight(h5.id);
  const basic = (n: number) => ({
    template: 'basic' as const,
    question: `Question ${n}?`,
    answer: `Answer ${n}`,
  });
  const [c1] = await createCardsFromHighlight(h1.id, [basic(1)]);
  await createCardsFromHighlight(h2.id, [basic(2)]);
  const now = Date.now();
  await getDb().cards.update(c1!.id, {
    dueAt: new Date(now - DAY).toISOString(),
    fsrs: {
      ...c1!.fsrs,
      state: 'review',
      stability: 9,
      difficulty: 5,
      reps: 4,
      due: new Date(now - DAY).toISOString(),
      lastReview: new Date(now - 6 * DAY).toISOString(),
    },
  });
  const syllabus = await createSyllabus({
    name: 'Cardiorenal exam',
    nodes: [
      { title: 'Cardiology', weight: 3, bankIds: [cardio.id] },
      { title: 'Renal', weight: 1, bankIds: [renal.id] },
      { title: 'Planned', weight: 1 },
    ],
  });
  return { cardio, renal, tag, syllabus };
}

const rowOf = (title: string) => {
  const row = screen.getAllByRole('row').find((r) => r.textContent?.startsWith(title));
  if (!row) throw new Error(`no row for ${title}`);
  return row;
};
const cells = (row: HTMLElement) =>
  within(row)
    .getAllByRole('cell')
    .map((c) => c.textContent?.replace(/\s+/g, ' ').trim());

describe('syllabus coverage', () => {
  it('invites the person to create a syllabus when there is none', async () => {
    const user = userEvent.setup();
    const create = vi.spyOn(browser.tabs, 'create').mockResolvedValue({} as never);
    render(<SyllabusCoverage settings={settings} />);
    expect(await screen.findByTestId(TID.syllabusEmpty)).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();

    await user.click(screen.getByTestId(TID.syllabusCreate));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(String(create.mock.calls[0]?.[0]?.url)).toMatch(/dashboard\.html\?view=syllabus$/);
  });

  it('shows the real numbers per topic and for the syllabus, weighted', async () => {
    await seed();
    render(<SyllabusCoverage settings={settings} />);
    const overall = await screen.findByTestId(TID.syllabusOverall);
    // Cardiology (60 %) is covered; Renal (20 %) has a highlight and no card: thin; Planned: none.
    await waitFor(() => expect(overall.textContent).toMatch(/60%\s*Covered/));
    expect(overall.textContent).toMatch(/80%\s*Started/);
    expect(overall.textContent).toMatch(/1\s*of 3 topics unmapped/);

    const table = within(screen.getByTestId(TID.syllabusTable));
    // Share, highlights (the trashed one is not counted), cards, due, retention, last studied, state.
    const cardiology = cells(
      table.getAllByRole('row').find((r) => r.textContent?.startsWith('Cardiology'))!,
    );
    expect(cardiology[0]).toBe('60.0%');
    expect(cardiology.slice(1, 5)).toEqual(['3', '2', '1', 'n/a (0)']);
    expect(cardiology[5]).not.toBe('Never');
    expect(cardiology[6]).toMatch(/Covered/);

    const renal = cells(table.getAllByRole('row').find((r) => r.textContent?.startsWith('Renal'))!);
    expect(renal.slice(0, 5)).toEqual(['20.0%', '1', '0', '0', 'n/a (0)']);
    expect(renal[5]).toBe('Never');
    expect(renal[6]).toMatch(/Thin/);

    const planned = table.getAllByRole('row').find((r) => r.textContent?.startsWith('Planned'))!;
    expect(planned.textContent).toMatch(/Not mapped/);
    expect(cells(planned)[6]).toMatch(/None/);
    // An unmapped topic offers to map it, never a dead "show".
    expect(
      within(planned).getByRole('button', { name: 'Map a bank or tag to Planned' }),
    ).toBeTruthy();
  });

  it('draws one named ring per top-level topic, summed up in words; the table has the numbers', async () => {
    await seed();
    render(<SyllabusCoverage settings={settings} />);
    const chart = await screen.findByTestId(TID.syllabusChart);
    await waitFor(() =>
      expect(chart.getAttribute('aria-label')).toMatch(
        /3 top-level topics: 1 covered, 1 thin, 1 with no material/,
      ),
    );
    const rings = within(chart).getAllByRole('img');
    expect(rings.map((r) => r.getAttribute('aria-label'))).toEqual([
      'Cardiology covered: 100 of 100 %, done',
      'Renal covered: 0 of 100 %',
      'Planned covered: 0 of 100 %',
    ]);
    // Every ring also says its state in words, not by colour alone.
    expect(within(chart).getAllByRole('listitem')[1]!.textContent).toMatch(/Renal\s*Thin/);
    expect(screen.getByTestId(TID.syllabusTable)).toBeTruthy();
  });

  it('sorts by a column and says which way', async () => {
    const user = userEvent.setup();
    await seed();
    render(<SyllabusCoverage settings={settings} />);
    await screen.findByTestId(TID.syllabusTable);

    const names = () =>
      within(screen.getByTestId(TID.syllabusTable))
        .getAllByRole('rowheader')
        .map((h) => h.textContent?.replace(/\s*Not mapped$/, '').trim());
    expect(names()).toEqual(['Cardiology', 'Renal', 'Planned']);

    const header = screen.getByRole('columnheader', { name: 'Highlights' });
    await user.click(screen.getByTestId('rv-syllabus-sort-highlights'));
    expect(header.getAttribute('aria-sort')).toBe('ascending');
    expect(names()).toEqual(['Planned', 'Renal', 'Cardiology']);
    await user.click(screen.getByTestId('rv-syllabus-sort-highlights'));
    expect(header.getAttribute('aria-sort')).toBe('descending');
    expect(names()).toEqual(['Cardiology', 'Renal', 'Planned']);
    await user.click(screen.getByTestId('rv-syllabus-sort-highlights'));
    expect(header.getAttribute('aria-sort')).toBeNull();
  });

  it('lets the person change the thresholds, keeps them on the device, and refuses nonsense', async () => {
    const user = userEvent.setup();
    await seed();
    render(<SyllabusCoverage settings={settings} />);
    const overall = await screen.findByTestId(TID.syllabusOverall);
    await waitFor(() => expect(overall.textContent).toMatch(/60%\s*Covered/));

    const highlights = screen.getByTestId(TID.syllabusMinHighlights) as HTMLInputElement;
    const cards = screen.getByTestId(TID.syllabusMinCards) as HTMLInputElement;
    expect(highlights.value).toBe('3');
    expect(cards.value).toBe('1');
    expect(screen.getByTestId(TID.syllabusReset).getAttribute('aria-disabled')).toBe('true');

    // Nothing is saved for a value that is not a whole number.
    await user.clear(highlights);
    await user.type(highlights, '1.5');
    await user.tab();
    expect(highlights.getAttribute('aria-invalid')).toBe('true');
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /Highlights needed: Use a whole number from 0 to 999/,
    );
    expect(await loadCoverageThresholds()).toEqual({ minHighlights: 3, minCards: 1 });

    // One highlight and no card is enough: Renal is covered now, and so is the whole 80 %.
    await user.clear(highlights);
    await user.type(highlights, '1');
    await user.clear(cards);
    await user.type(cards, '0');
    await user.tab();
    await waitFor(() => expect(overall.textContent).toMatch(/80%\s*Covered/));
    await waitFor(async () =>
      expect(await loadCoverageThresholds()).toEqual({ minHighlights: 1, minCards: 0 }),
    );
    expect(screen.getByTestId(TID.syllabusThresholdStatus).textContent).toMatch(
      /Saved on this device: covered from 1 highlight and 0 cards/,
    );
    expect(within(rowOf('Renal')).getByText(/Covered/)).toBeTruthy();

    await user.click(screen.getByTestId(TID.syllabusReset));
    await waitFor(() => expect(overall.textContent).toMatch(/60%\s*Covered/));
    expect(highlights.value).toBe('3');
    expect(await loadCoverageThresholds()).toEqual({ minHighlights: 3, minCards: 1 });
  });

  it('opens the dashboard list of a topic: its bank, or a search of its banks and tags', async () => {
    const user = userEvent.setup();
    const { cardio, renal, tag, syllabus } = await seed();
    const create = vi.spyOn(browser.tabs, 'create').mockResolvedValue({} as never);
    render(<SyllabusCoverage settings={settings} />);
    await screen.findByTestId(TID.syllabusTable);
    const ids = syllabus.nodes.map((n) => n.id);

    await user.click(await screen.findByTestId(syllabusShowId(ids[0]!)));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(String(create.mock.calls[0]?.[0]?.url)).toMatch(
      new RegExp(`dashboard\\.html\\?bank=${cardio.id}$`),
    );

    // A topic that points at a bank and a tag: the list is the search of both, shown in the box.
    await createSyllabus({
      name: 'Both',
      nodes: [{ title: 'Kidney', bankIds: [renal.id], tagIds: [tag.id] }],
    });
    await user.selectOptions(await screen.findByTestId(TID.syllabusSelect), 'Both');
    const kidney = await screen.findByRole('button', { name: 'Show highlights of Kidney' });
    await user.click(kidney);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    const url = new URL(String(create.mock.calls[1]?.[0]?.url));
    expect(url.searchParams.get('q')).toBe('(bank:"Renal" OR tag:"High Yield")');
    expect(url.searchParams.get('bank')).toBeNull();
  });

  it('judges a topic with mapped subtopics from them and says so', async () => {
    const { cardio, renal } = await seed();
    await createSyllabus({
      name: 'Nested',
      nodes: [
        {
          title: 'Systems',
          children: [
            { title: 'Heart', bankIds: [cardio.id] },
            { title: 'Kidney', bankIds: [renal.id] },
          ],
        },
      ],
    });
    render(<SyllabusCoverage settings={settings} />);
    const select = await screen.findByTestId(TID.syllabusSelect);
    await userEvent.setup().selectOptions(select, 'Nested');
    await screen.findAllByText('Systems');
    const systems = rowOf('Systems');
    // Heart is covered (half the weight), Kidney is thin: "Systems" is thin, 50 % covered.
    expect(systems.textContent).toMatch(/Thin/);
    expect(systems.textContent).toMatch(/50% of its subtopics by weight/);
    expect(rowOf('Heart').textContent).toMatch(/Covered/);
  });
});

describe('an exam on a topic', () => {
  it('is offered for a topic that has cards, by keyboard too, and explained where it has none', async () => {
    const user = userEvent.setup();
    const s = await seed();
    const open = vi.fn();
    render(<SyllabusCoverage settings={settings} onExamOnTopic={open} />);
    await screen.findByTestId(TID.syllabusTable);
    await waitFor(() => expect(screen.getByTestId(TID.syllabusOverall).textContent).toMatch(/60%/));
    const [cardiology, renal] = s.syllabus.nodes;

    // The column is there, and the button names the topic it is for.
    expect(screen.getByRole('columnheader', { name: 'Exam' })).toBeTruthy();
    const ask = screen.getByTestId(syllabusExamId(cardiology!.id));
    expect(ask.textContent?.trim()).toBe('Exam');
    expect(ask.getAttribute('aria-label')).toBe('Exam on this topic: Cardiology');
    expect(ask.getAttribute('aria-disabled')).toBeNull();
    ask.focus();
    await user.keyboard('{Enter}');
    expect(open).toHaveBeenCalledWith({ syllabusId: s.syllabus.id, topicId: cardiology!.id });

    // Renal has a highlight and no card: nothing to ask, and the button says why.
    const none = screen.getByTestId(syllabusExamId(renal!.id));
    expect(none.getAttribute('aria-disabled')).toBe('true');
    expect(none.getAttribute('title')).toMatch(/no cards to ask/);
    await user.click(none);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('is not drawn where the host has no exam (no dead control)', async () => {
    await seed();
    render(<SyllabusCoverage settings={settings} />);
    await screen.findByTestId(TID.syllabusTable);
    expect(screen.queryByRole('columnheader', { name: 'Exam' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Exam on this topic/ })).toBeNull();
  });
});
