import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { browser } from 'wxt/browser';
import { createExam, type ExamSession } from '@study/exam';
import {
  createBank,
  createCardsFromHighlight,
  createManualCards,
  createSyllabus,
  getDb,
  type TemplateInput,
} from '@storage';
import { loadExamData } from '@storage/exam';
import { freshDatabase, save } from '@storage/test-vault';
import {
  STUDY_SETTINGS_KEY,
  TID,
  defaultStudySettings,
  examStudyTopicId,
  syllabusExamId,
} from '@ui/review';
import { Review } from './Review';

/**
 * Exams drawn from a syllabus (ADR-020 part 2) through the whole review page: the setup, the draw,
 * the results by topic, the address and the coverage table's "Exam on this topic".
 */

vi.setConfig({ testTimeout: 60_000 });
// Several agents and CI shards share the CPU: waiting for the page is not a failure.
configure({ asyncUtilTimeout: 15_000 });

const settings = { ...defaultStudySettings(), timeZone: 'UTC', rolloverHour: 0 };

beforeEach(async () => {
  await freshDatabase();
  await browser.storage.local.set({ [STUDY_SETTINGS_KEY]: settings });
  window.history.replaceState(null, '', '/review.html?view=exam');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const basic = (label: string, n: number): TemplateInput => ({
  template: 'basic',
  question: `${label} question ${n}?`,
  answer: `${label} answer ${n}`,
});

/** Cardiology: two cards; Renal: one; "Planned" (weight 1) has nothing. Weights 3, 1 and 1. */
async function seedSyllabus() {
  const cardio = await createBank('Cardiology');
  const renal = await createBank('Renal');
  const h1 = await save('Stroke volume is the blood ejected per beat.', { bankId: cardio.id });
  const h2 = await save('Preload is end-diastolic ventricular stretch.', { bankId: cardio.id });
  const h3 = await save('Creatinine rises late in acute kidney injury.', { bankId: renal.id });
  await createCardsFromHighlight(h1.id, [basic('Syllabus', 1)]);
  await createCardsFromHighlight(h2.id, [basic('Syllabus', 2)]);
  await createCardsFromHighlight(h3.id, [basic('Syllabus', 3)]);
  const syllabus = await createSyllabus({
    name: 'Cardiorenal exam',
    nodes: [
      { title: 'Cardiology', weight: 3, bankIds: [cardio.id] },
      { title: 'Renal', weight: 1, bankIds: [renal.id] },
      { title: 'Planned', weight: 1 },
    ],
  });
  const topic = (title: string) => syllabus.nodes.find((n) => n.title === title)!;
  return { cardio, renal, syllabus, topic };
}

const storedExam = async () =>
  (await getDb().meta.get('examSession'))?.value as ExamSession | undefined;

/** Press start (order as created, no limit). */
async function start(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() =>
    expect(screen.getByTestId(TID.examStart).getAttribute('aria-disabled')).toBeNull(),
  );
  await user.click(screen.getByTestId(TID.examShuffle));
  await user.click(screen.getByTestId(TID.examStart));
  await screen.findByTestId(TID.examRun);
}

describe('exam: from a syllabus', () => {
  it('offers the syllabus, counts what the coverage counts, shares the questions by weight and draws only from it', async () => {
    const user = userEvent.setup();
    const s = await seedSyllabus();
    render(<Review />);
    await screen.findByTestId(TID.examSetup);
    // Banks, folders and tags first; a syllabus is one click away.
    expect(screen.getByTestId(TID.examScope)).toBeTruthy();
    await user.click(screen.getByTestId(TID.examSourceSyllabus));

    const topic = (await screen.findByTestId(TID.examTopic)) as HTMLSelectElement;
    await waitFor(() =>
      expect([...topic.options].map((o) => o.textContent?.trim())).toEqual([
        'The whole syllabus (3 cards)',
        'Cardiology (2 cards)',
        'Renal (1 card)',
        'Planned (0 cards)',
      ]),
    );
    expect(screen.queryByTestId(TID.examScope)).toBeNull();
    expect((screen.getByTestId(TID.examQuestions) as HTMLInputElement).value).toBe('3');

    // Weighted: 3 questions, Cardiology 75 % and Renal 25 % of the topics that have cards.
    await user.click(screen.getByTestId(TID.examWeighted));
    const plan = screen.getByTestId(TID.examPlan);
    await user.click(within(plan).getByText(/How the 3 questions are shared between topics/));
    const rows = within(plan)
      .getAllByRole('row')
      .slice(1)
      .map((r) => [...r.querySelectorAll('th, td')].map((c) => c.textContent));
    expect(rows).toEqual([
      ['Cardiology', '75.0%', '2', '2'],
      ['Renal', '25.0%', '1', '1'],
      ['Planned', '0.0%', '0', '0'],
    ]);
    expect(screen.getByTestId(TID.examLeftOut).textContent).toBe('Left out: Planned (no cards).');

    await start(user);
    const run = await storedExam();
    expect(run?.scope).toEqual({
      kind: 'syllabus',
      syllabusId: s.syllabus.id,
      topicId: null,
      weighted: true,
    });
    expect(run?.scopeLabel).toBe('Syllabus: Cardiorenal exam (weighted by topic)');
    expect(run?.questions).toHaveLength(3);
    expect(run?.syllabus?.skipped).toEqual([
      { id: s.topic('Planned').id, title: 'Planned', reason: 'nocards' },
    ]);
    const perTopic = new Map<string | null, number>();
    for (const q of run?.questions ?? []) {
      perTopic.set(q.topicId, (perTopic.get(q.topicId) ?? 0) + 1);
    }
    expect(Object.fromEntries(perTopic)).toEqual({
      [s.topic('Cardiology').id]: 2,
      [s.topic('Renal').id]: 1,
    });
  });

  it('asks a topic only, shows the results by topic and "Study this topic" opens the list "Show" opens', async () => {
    const user = userEvent.setup();
    const s = await seedSyllabus();
    const create = vi.spyOn(browser.tabs, 'create').mockResolvedValue({} as never);
    render(<Review />);
    await screen.findByTestId(TID.examSetup);
    await user.click(screen.getByTestId(TID.examSourceSyllabus));
    const topic = (await screen.findByTestId(TID.examTopic)) as HTMLSelectElement;
    await waitFor(() => expect(topic.options).toHaveLength(4));
    await user.selectOptions(topic, s.topic('Cardiology').id);
    await waitFor(() =>
      expect((screen.getByTestId(TID.examQuestions) as HTMLInputElement).value).toBe('2'),
    );
    await start(user);
    const run = await storedExam();
    expect(run?.scopeLabel).toBe('Syllabus: Cardiorenal exam / Cardiology');
    expect(run?.questions).toHaveLength(2);
    expect(run?.questions.every((q) => q.topicId === s.topic('Cardiology').id)).toBe(true);

    // Answer nothing; mark one known and one not.
    await user.click(screen.getByTestId(TID.examFinish));
    const confirm = await screen.findByRole('dialog', { hidden: true });
    await user.click(within(confirm).getByRole('button', { name: 'Finish exam' }));
    await screen.findByTestId(TID.examMarking);
    await user.click(screen.getByRole('radio', { name: 'I knew it (question 1)' }));
    await user.click(screen.getByRole('radio', { name: 'I did not know it (question 2)' }));
    await user.click(screen.getByTestId(TID.examShowResults));

    const results = await screen.findByTestId(TID.examResults);
    const topics = within(within(results).getByTestId(TID.examTopics));
    const row = topics.getAllByRole('row')[1]!;
    expect([...row.querySelectorAll('th, td')].slice(0, 6).map((c) => c.textContent)).toEqual([
      'Cardiology',
      '2',
      '1',
      '1',
      '0',
      '50%',
    ]);
    const study = await within(results).findByTestId(examStudyTopicId(s.topic('Cardiology').id));
    await waitFor(() => expect(study.getAttribute('aria-disabled')).toBeNull());
    expect(study.getAttribute('aria-label')).toBe('Study this topic: Cardiology');
    await user.click(study);
    await waitFor(() => expect(create).toHaveBeenCalled());
    // One bank and no tag: the dashboard list scoped to the bank, as the coverage table's "Show".
    expect(String(create.mock.calls[0]?.[0]?.url)).toMatch(
      new RegExp(`dashboard\\.html\\?bank=${s.cardio.id}$`),
    );

    // The summary names the syllabus by id and holds no question text.
    await user.click(screen.getByTestId(TID.examClose));
    const history = await screen.findByTestId(TID.examHistory);
    expect(history.textContent).toContain('Syllabus: Cardiorenal exam / Cardiology');
    const stored = (await getDb().meta.get('examHistory'))?.value as Array<Record<string, unknown>>;
    expect(stored[0]?.syllabusId).toBe(s.syllabus.id);
    expect(JSON.stringify(stored)).not.toMatch(/Syllabus question/);
  });

  it('opens on the topic named in the address, with focus on the form', async () => {
    const s = await seedSyllabus();
    window.history.replaceState(
      null,
      '',
      `/review.html?view=exam&syllabus=${s.syllabus.id}&topic=${s.topic('Renal').id}`,
    );
    render(<Review />);
    const topic = (await screen.findByTestId(TID.examTopic)) as HTMLSelectElement;
    expect((screen.getByTestId(TID.examSourceSyllabus) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId(TID.examSyllabus) as HTMLSelectElement).value).toBe(s.syllabus.id);
    expect(topic.value).toBe(s.topic('Renal').id);
    await waitFor(() =>
      expect((screen.getByTestId(TID.examQuestions) as HTMLInputElement).value).toBe('1'),
    );
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Exam simulation'));
  });

  it('says so when the topic or the syllabus in the address is gone, and falls back honestly', async () => {
    const s = await seedSyllabus();
    window.history.replaceState(
      null,
      '',
      `/review.html?view=exam&syllabus=${s.syllabus.id}&topic=topic-removed-0001`,
    );
    const first = render(<Review />);
    const topic = (await screen.findByTestId(TID.examTopic)) as HTMLSelectElement;
    expect(topic.value).toBe('');
    expect(screen.getByText(/The topic you chose is no longer in this syllabus/)).toBeTruthy();
    first.unmount();

    window.history.replaceState(
      null,
      '',
      '/review.html?view=exam&syllabus=syllabus-removed-0001&topic=topic-removed-0001',
    );
    render(<Review />);
    expect(await screen.findByText(/The syllabus you chose has been deleted/)).toBeTruthy();
    expect(screen.getByTestId(TID.examSyllabus)).toBeTruthy();
  });

  it('"Exam on this topic" in the coverage table opens the exam setup on that topic', async () => {
    const user = userEvent.setup();
    const s = await seedSyllabus();
    window.history.replaceState(null, '', '/review.html?view=analytics');
    render(<Review />);
    const button = await screen.findByTestId(syllabusExamId(s.topic('Cardiology').id));
    await user.click(button);

    const topic = (await screen.findByTestId(TID.examTopic)) as HTMLSelectElement;
    expect(topic.value).toBe(s.topic('Cardiology').id);
    expect(screen.getByRole('tab', { name: 'Exam' }).getAttribute('aria-selected')).toBe('true');
    expect(window.location.search).toBe(
      `?view=exam&syllabus=${s.syllabus.id}&topic=${s.topic('Cardiology').id}`,
    );
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Exam simulation'));
    // Moving to another tab forgets the preselection (the address too).
    await user.click(screen.getByRole('tab', { name: 'Study' }));
    expect(window.location.search).toBe('?view=study');
  });

  it('with no syllabus it says how to get one and offers the editor', async () => {
    const user = userEvent.setup();
    await createManualCards([basic('Typed', 1)]);
    const create = vi.spyOn(browser.tabs, 'create').mockResolvedValue({} as never);
    render(<Review />);
    await screen.findByTestId(TID.examSetup);
    expect(screen.queryByTestId(TID.examSource)).toBeNull();
    const hint = await screen.findByTestId(TID.examSyllabusNone);
    expect(hint.textContent).toMatch(/make a syllabus first/);
    await user.click(within(hint).getByRole('button', { name: 'Create a syllabus' }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(String(create.mock.calls[0]?.[0]?.url)).toMatch(/dashboard\.html\?view=syllabus$/);
  });

  it('a topic without cards is explained, with the editor one click away', async () => {
    const user = userEvent.setup();
    await createManualCards([basic('Typed', 1)]);
    const create = vi.spyOn(browser.tabs, 'create').mockResolvedValue({} as never);
    const bank = await createBank('Pharmacology');
    const syllabus = await createSyllabus({
      name: 'Pharm',
      nodes: [{ title: 'Unfiled', bankIds: [bank.id] }],
    });
    render(<Review />);
    await screen.findByTestId(TID.examSetup);
    await user.click(screen.getByTestId(TID.examSourceSyllabus));
    expect(await screen.findByText('No card belongs to this topic yet')).toBeTruthy();
    expect(screen.getByTestId(TID.examStart).getAttribute('aria-disabled')).toBe('true');
    await user.click(screen.getByRole('button', { name: 'Edit this syllabus' }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(String(create.mock.calls[0]?.[0]?.url)).toMatch(
      new RegExp(`dashboard\\.html\\?view=syllabus&syllabus=${syllabus.id}$`),
    );
  });
});

describe('exam: a stored exam of another version', () => {
  async function storedOldExam() {
    await createManualCards([basic('Typed', 1), basic('Typed', 2), basic('Typed', 3)]);
    const data = await loadExamData();
    const e = createExam({
      id: 'exam-0001',
      now: Date.now(),
      random: () => 0.5,
      config: {
        scope: { kind: 'all' },
        scopeLabel: 'All cards',
        questions: 3,
        minutes: null,
        shuffle: false,
      },
      cards: data.cards,
    });
    // Exactly what the build before the syllabus scope wrote.
    const old = JSON.parse(JSON.stringify(e)) as Record<string, unknown>;
    old.version = 1;
    delete old.syllabus;
    for (const q of old.questions as Array<Record<string, unknown>>) delete q.topicId;
    return old;
  }

  it('continues an exam made before this version, answers and all', async () => {
    const old = await storedOldExam();
    (old.questions as Array<Record<string, unknown>>)[0]!.text = 'typed before the update';
    await getDb().meta.put({ key: 'examSession', value: old, updatedAt: new Date().toISOString() });
    render(<Review />);
    await screen.findByTestId(TID.examRun);
    expect((screen.getByTestId(TID.examText) as HTMLTextAreaElement).value).toBe(
      'typed before the update',
    );
    expect(screen.queryByText(/could not be read/)).toBeNull();
  });

  it('drops one it does not know, says so, and lets a new exam be made', async () => {
    const old = await storedOldExam();
    old.version = 9;
    await getDb().meta.put({ key: 'examSession', value: old, updatedAt: new Date().toISOString() });
    render(<Review />);
    expect(await screen.findByText(/could not be read/)).toBeTruthy();
    expect(screen.queryByTestId(TID.examContinue)).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId(TID.examStart).getAttribute('aria-disabled')).toBeNull(),
    );
    await waitFor(async () => expect(await getDb().meta.get('examSession')).toBeUndefined());
  });
});
