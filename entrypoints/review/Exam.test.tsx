import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { browser } from 'wxt/browser';
import { makeCard } from '@study/testUtils';
import { createExam, type ExamSession } from '@study/exam';
import {
  closeDb,
  createDeck,
  createManualCards,
  getCard,
  getDb,
  listReviewLogs,
  type TemplateInput,
} from '@storage';
import { freshDatabase } from '@storage/test-vault';
import { STUDY_SETTINGS_KEY, TID, defaultStudySettings, examChoiceId } from '@ui/review';
import { ExamRun } from './ExamRun';
import { Review } from './Review';

const MIN = 60_000;
const T0 = Date.parse('2026-03-10T12:00:00.000Z');
const settings = { ...defaultStudySettings(), timeZone: 'UTC', rolloverHour: 0 };

vi.setConfig({ testTimeout: 60_000 });
// Several agents and CI shards share the CPU: waiting for the page is not a failure.
configure({ asyncUtilTimeout: 15_000 });

const basic = (n: number): TemplateInput => ({
  template: 'basic',
  question: `Question ${n}?`,
  answer: `Answer ${n}`,
});
const mcq: TemplateInput = {
  template: 'mcq',
  stem: 'Which node paces the heart?',
  choices: ['SA node', 'AV node', 'Purkinje fibres'],
  correctIndex: 0,
  explanation: 'The SA node fires fastest.',
};

/** Basic 1, multiple choice, basic 3: the order of an unshuffled exam (creation order). */
async function seed() {
  const deck = await createDeck({ name: 'Cardiology' });
  const cards = await createManualCards([basic(1), mcq, basic(3)], { deckId: deck.id });
  return { deck, cards };
}

beforeEach(async () => {
  await freshDatabase();
  await browser.storage.local.set({ [STUDY_SETTINGS_KEY]: settings });
  window.history.replaceState(null, '', '/review.html?view=exam');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const readBlob = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsText(blob);
  });

type User = ReturnType<typeof userEvent.setup>;
const step = (title: string) => screen.findByRole('heading', { name: title });
const next = (user: User) => user.click(screen.getByRole('button', { name: 'Next' }));

/** The setup wizard: scope, how many, time limit, a last look, then start. */
async function startExam(
  user: User,
  opts: { minutes?: string; shuffle?: boolean; questions?: string } = {},
) {
  await screen.findByTestId(TID.examSetup);
  await step('What to ask');
  await next(user);
  await step('How many?');
  if (opts.questions !== undefined) {
    await user.click(screen.getByRole('radio', { name: /^Custom/ }));
    const n = screen.getByTestId(TID.examQuestions);
    await user.clear(n);
    await user.type(n, opts.questions);
  }
  if (opts.shuffle !== true) await user.click(screen.getByTestId(TID.examShuffle));
  await next(user);
  await step('Time limit');
  if (opts.minutes !== undefined) {
    await user.click(screen.getByRole('radio', { name: /^Custom/ }));
    const m = screen.getByTestId(TID.examMinutes);
    await user.clear(m);
    await user.type(m, opts.minutes);
  }
  await next(user);
  await step('Looks good?');
  await user.click(screen.getByRole('button', { name: 'Start exam' }));
  await screen.findByTestId(TID.examRun);
}

describe('exam: setup', () => {
  it('says what can be asked, caps the count by availability, and stops a bad step with a reason', async () => {
    const user = userEvent.setup();
    await seed();
    render(<Review />);
    await screen.findByTestId(TID.examSetup);
    await step('What to ask');

    // Only scopes that have cards are offered: no bank holds one of these typed cards.
    const scope = within(screen.getByTestId(TID.examScope));
    expect(scope.getAllByRole('radio')).toHaveLength(1);
    expect(scope.getByRole('radio', { name: /All cards/ })).toHaveProperty('checked', true);
    expect(screen.getByTestId(TID.examScope).textContent).toContain('3 cards');
    await next(user);

    // Three cards: no preset below that, so "All" is picked; a typed number is the other way.
    await step('How many?');
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.getByRole('radio', { name: /^All/ })).toHaveProperty('checked', true);
    await user.click(screen.getByRole('radio', { name: /^Custom/ }));
    const n = screen.getByTestId(TID.examQuestions);
    expect((n as HTMLInputElement).value).toBe('3');
    await user.clear(n);
    await user.type(n, '50');
    expect(
      await screen.findByText(
        'Only 3 cards can be asked in this scope, so the exam has 3 questions.',
      ),
    ).toBeTruthy();

    await user.clear(n);
    await user.type(n, '0');
    await next(user);
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /whole number of questions from 1 to 200/,
    );
    // Still on this step, with focus on the field to fix.
    expect(screen.getByRole('heading', { name: 'How many?' })).toBeTruthy();
    expect(document.activeElement).toBe(n);

    await user.clear(n);
    await user.type(n, '3');
    await next(user);
    await step('Time limit');
    expect(screen.getByRole('radio', { name: /^No limit/ })).toHaveProperty('checked', true);
    expect(
      screen.getByRole('radio', { name: /^1 min each/ }).closest('label')?.textContent,
    ).toMatch(/3 min/);
    await user.click(screen.getByRole('radio', { name: /^Custom/ }));
    const m = screen.getByTestId(TID.examMinutes);
    await user.clear(m);
    await user.type(m, '0');
    await next(user);
    expect((await screen.findByRole('alert')).textContent).toMatch(/minutes from 1 to 480/);

    // Back keeps every answer.
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await step('How many?');
    expect((screen.getByTestId(TID.examQuestions) as HTMLInputElement).value).toBe('3');
  });

  it('with no cards at all it says so instead of offering an exam, and points to Create', async () => {
    const user = userEvent.setup();
    render(<Review />);
    expect(await screen.findByText('No cards yet')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Create cards' }));
    expect(screen.getByRole('tab', { name: 'Create' }).getAttribute('aria-selected')).toBe('true');
  });
});

describe('exam: a whole run', () => {
  it('shows nothing about the answers until the end, then marks, scores and leaves the schedule alone', async () => {
    const user = userEvent.setup();
    const { cards } = await seed();
    const urls: Blob[] = [];
    URL.createObjectURL = vi.fn((b: Blob) => {
      urls.push(b);
      return 'blob:exam';
    });
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    render(<Review />);
    await startExam(user);

    // Question 1: recall. Type something; the answer is not shown.
    expect(screen.getByRole('heading', { name: 'Question 1 of 3' })).toBeTruthy();
    expect(screen.getByTestId(TID.examQuestion).textContent).toContain('Question 1?');
    expect(screen.queryByText('Answer 1')).toBeNull();
    await user.type(screen.getByTestId(TID.examText), 'my own attempt');
    // The pause control does not exist; leaving is a different, confirmed action.
    expect(screen.queryByRole('button', { name: /pause/i })).toBeNull();

    // Question 2: multiple choice. Picking gives no feedback of any kind.
    await user.click(screen.getByTestId(TID.examNext));
    const pick = screen.getByRole('radio', { name: 'SA node' });
    await user.click(pick);
    expect((pick as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByText(/correct/i)).toBeNull();
    expect(screen.queryByText('The SA node fires fastest.')).toBeNull();
    expect(
      screen.getByTestId(TID.examChoices).querySelectorAll('input[type="radio"]'),
    ).toHaveLength(3);
    expect(screen.getByTestId(examChoiceId(0))).toBeTruthy();

    // The state reached the database after each change (a reload would continue from it).
    await waitFor(async () => {
      const row = await getDb().meta.get('examSession');
      const value = row?.value as ExamSession | undefined;
      expect(value?.questions.map((q) => q.choiceId ?? q.text)).toEqual([
        'my own attempt',
        expect.stringMatching(/^ch/),
        '',
      ]);
    });

    // Question 3 left blank; finish.
    await user.click(screen.getByTestId(TID.examNext));
    await user.click(screen.getByTestId(TID.examFinish));
    const confirm = await screen.findByRole('dialog', { hidden: true });
    expect(confirm.textContent).toMatch(/1 recall question has nothing typed/);
    await user.click(within(confirm).getByRole('button', { name: 'Finish exam' }));

    // Marking: the answers appear now; recall is marked by the person.
    const marking = await screen.findByTestId(TID.examMarking);
    expect(within(marking).getByText('Answer 1')).toBeTruthy();
    expect(within(marking).getByText('Answer 3')).toBeTruthy();
    expect(within(marking).queryByText('The SA node fires fastest.')).toBeNull();
    const showResults = screen.getByTestId(TID.examShowResults);
    expect(showResults.getAttribute('aria-disabled')).toBe('true');
    // The reason is the tooltip the button points at.
    expect(
      document.getElementById(showResults.getAttribute('aria-describedby') ?? '')?.textContent,
    ).toMatch(/2 questions still need a mark/);
    await user.click(screen.getByRole('radio', { name: 'I knew it (question 1)' }));
    await user.click(screen.getByTestId(TID.examMarkRest));
    expect(screen.getByRole('radio', { name: "Didn't know it (question 3)" })).toHaveProperty(
      'checked',
      true,
    );
    await user.click(screen.getByTestId(TID.examShowResults));

    // Results: 2 of 3 (the multiple choice by the key, question 1 by the person).
    const results = await screen.findByTestId(TID.examResults);
    expect(within(results).getByTestId(TID.examScore).textContent).toMatch(/67%2 of 3 correct/);
    const missed = within(results).getByTestId(TID.examMissed);
    expect(missed.textContent).toContain('Question 3');
    expect(missed.textContent).toContain('Correct answer: Answer 3');
    expect(within(results).getByTestId(TID.examBanks).textContent).toContain('No bank');

    // Nothing about the schedule changed.
    expect(await listReviewLogs()).toEqual([]);
    for (const c of cards) expect((await getCard(c.id))!.fsrs).toEqual(c.fsrs);

    // Export is real Markdown of these results.
    await user.click(screen.getByTestId(TID.examExport));
    expect(urls).toHaveLength(1);
    const md = await readBlob(urls[0]!);
    expect(md).toMatch(/^# Exam results: All cards$/m);
    expect(md).toContain('- Score: 67% (2 of 3 correct, 1 wrong, 0 unanswered)');
    expect(md).toContain('### 3. Question 3?');

    // Count as review: one rating per answered card, undone by unticking.
    const tick = screen.getByRole('switch', { name: 'Count as review' });
    await user.click(tick);
    await waitFor(async () => expect(await listReviewLogs()).toHaveLength(3));
    await waitFor(() =>
      expect(screen.getByTestId(TID.examCountStatus).textContent).toBe(
        'Counted 3 cards as review.',
      ),
    );
    const ratings = (await listReviewLogs()).map((l) => l.rating).sort();
    expect(ratings).toEqual([1, 3, 3]);
    // The box is disabled while the work runs; once it is ticked and idle, unticking undoes it.
    await waitFor(() => expect((tick as HTMLInputElement).disabled).toBe(false));
    expect((tick as HTMLInputElement).checked).toBe(true);
    await user.click(tick);
    await waitFor(async () => expect(await listReviewLogs()).toEqual([]));
    await waitFor(() =>
      expect(screen.getByTestId(TID.examCountStatus).textContent).toMatch(/Undid 3 reviews/),
    );
    for (const c of cards) expect((await getCard(c.id))!.fsrs).toEqual(c.fsrs);
    // It was counted once and undone: it cannot be counted again, and the control says why.
    expect((tick as HTMLInputElement).disabled).toBe(true);

    // Close the results: the summary is in the history on the setup screen.
    await user.click(screen.getByTestId(TID.examClose));
    const history = await screen.findByTestId(TID.examHistory);
    await waitFor(() => expect(within(history).getAllByRole('row')).toHaveLength(2));
    expect(history.textContent).toContain('All cards');
    expect(history.textContent).toContain('67% (2 of 3)');
    expect(history.textContent).toMatch(/stored on this device only.*not part of\s+backups/);
    await waitFor(async () => expect(await getDb().meta.get('examSession')).toBeUndefined());
  });

  it('leaving asks first, keeps the exam, and it can be continued or discarded', async () => {
    const user = userEvent.setup();
    await seed();
    render(<Review />);
    await startExam(user, { minutes: '10' });

    await user.click(screen.getByTestId(TID.examLeave));
    let dialog = await screen.findByRole('dialog', { hidden: true });
    expect(dialog.textContent).toMatch(/timer does not stop/);
    await user.click(within(dialog).getByRole('button', { name: 'Stay in the exam' }));
    expect(screen.getByTestId(TID.examRun)).toBeTruthy();

    await user.click(screen.getByTestId(TID.examLeave));
    dialog = await screen.findByRole('dialog', { hidden: true });
    await user.click(within(dialog).getByRole('button', { name: 'Leave exam' }));
    const setup = await screen.findByTestId(TID.examSetup);
    expect(setup.textContent).toContain('Exam in progress');
    // One decision at a time: continue or discard; no second exam can be set up meanwhile.
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();

    await user.click(screen.getByTestId(TID.examContinue));
    await screen.findByTestId(TID.examRun);
    await user.click(screen.getByTestId(TID.examLeave));
    dialog = await screen.findByRole('dialog', { hidden: true });
    await user.click(within(dialog).getByRole('button', { name: 'Leave exam' }));
    await screen.findByTestId(TID.examSetup);
    await user.click(screen.getByTestId(TID.examDiscard));
    dialog = await screen.findByRole('dialog', { hidden: true });
    await user.click(within(dialog).getByRole('button', { name: 'Discard exam' }));
    await waitFor(async () => expect(await getDb().meta.get('examSession')).toBeUndefined());
    expect(await step('What to ask')).toBeTruthy();
    expect(screen.queryByTestId(TID.examContinue)).toBeNull();
  });
});

describe('exam: reload and the clock', () => {
  it('continues after a reload with the answers and the remaining time, and ends when time ran out while away', async () => {
    const user = userEvent.setup();
    await seed();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const first = render(<Review />);
    await startExam(user, { minutes: '10' });
    expect(screen.getByTestId(TID.examTimer).textContent).toBe('10:00');
    await user.type(screen.getByTestId(TID.examText), 'kept across the reload');
    await waitFor(async () => {
      const row = await getDb().meta.get('examSession');
      expect((row?.value as ExamSession).questions[0]?.text).toBe('kept across the reload');
    });

    // Reload four minutes later: straight back into the exam, clock not paused.
    first.unmount();
    closeDb();
    vi.setSystemTime(T0 + 4 * MIN);
    const second = render(<Review />);
    await screen.findByTestId(TID.examRun);
    expect(screen.getByTestId(TID.examTimer).textContent).toBe('06:00');
    expect((screen.getByTestId(TID.examText) as HTMLTextAreaElement).value).toBe(
      'kept across the reload',
    );

    // Reload after the deadline: the answers are kept and marking starts, with the reason.
    second.unmount();
    closeDb();
    vi.setSystemTime(T0 + 30 * MIN);
    render(<Review />);
    await screen.findByTestId(TID.examMarking);
    expect(screen.getByText(/The time limit ran out while this page was closed/)).toBeTruthy();
    expect(screen.getByText(/Time is up\. Your answers are saved\./)).toBeTruthy();
    // What opening the page did to the exam is written back (after the first render).
    await waitFor(async () => {
      const row = await getDb().meta.get('examSession');
      expect((row?.value as ExamSession).endReason).toBe('timeup');
    });
  });

  it('an exam kept for more than 24 hours is gone, and the page says so', async () => {
    const user = userEvent.setup();
    await seed();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const first = render(<Review />);
    await startExam(user);
    first.unmount();
    closeDb();
    vi.setSystemTime(T0 + 25 * 60 * MIN);
    render(<Review />);
    await screen.findByTestId(TID.examSetup);
    expect(screen.getByText(/expired after 24 hours and was removed/)).toBeTruthy();
    expect(screen.queryByTestId(TID.examContinue)).toBeNull();
  });
});

describe('exam: the timer is not chatty', () => {
  function facts(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      cardId: `card-${String(i + 1).padStart(6, '0')}`,
      cardType: 'basic' as const,
      bankId: null,
      bankIds: [],
      folderIds: [],
      tags: [],
    }));
  }
  const cardMap = (exam: ExamSession) =>
    new Map(exam.questions.map((q) => [q.cardId, makeCard(q.cardId)] as const));

  it('announces at half, ten percent, one minute and the end, once each, and never per second', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const exam = createExam({
      id: 'exam-0001',
      now: T0,
      random: () => 0.3,
      config: {
        scope: { kind: 'all' },
        scopeLabel: 'All cards',
        questions: 3,
        minutes: 30,
        shuffle: false,
      },
      cards: facts(3),
    });
    const announce = vi.fn();
    const onTimeUp = vi.fn();
    const noop = () => {};
    const { container } = render(
      <ExamRun
        exam={exam}
        cards={cardMap(exam)}
        announce={announce}
        onChoose={noop}
        onType={noop}
        onGo={noop}
        onFinish={noop}
        onLeave={noop}
        onTimeUp={onTimeUp}
      />,
    );
    const timer = screen.getByTestId(TID.examTimer);
    expect(timer.getAttribute('role')).toBe('timer');
    expect(timer.getAttribute('aria-live')).toBe('off');
    expect(timer.textContent).toBe('30:00');
    // Nothing inside the exam screen is a live region that a tick could speak through.
    expect(
      container.querySelectorAll(
        '[role="status"], [role="alert"], [aria-live]:not([aria-live="off"])',
      ),
    ).toHaveLength(0);

    const spoken = () => announce.mock.calls.map((c) => c[0] as string);
    act(() => void vi.advanceTimersByTime(14 * MIN + 59_000));
    expect(spoken()).toEqual([]);
    expect(timer.textContent).toBe('15:01');
    act(() => void vi.advanceTimersByTime(1000));
    expect(spoken()).toEqual(['Half of the time has passed. About 15 minutes left.']);
    act(() => void vi.advanceTimersByTime(12 * MIN));
    expect(spoken()).toHaveLength(2);
    expect(spoken()[1]).toBe('Ten percent of the time is left: about 3 minutes.');
    act(() => void vi.advanceTimersByTime(2 * MIN));
    expect(spoken()[2]).toBe('One minute left.');
    expect(onTimeUp).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(MIN));
    expect(spoken()).toHaveLength(4);
    expect(spoken()[3]).toBe('Time is up. Your answers are saved.');
    expect(onTimeUp).toHaveBeenCalled();
    expect(timer.textContent).toBe('00:00');
  });

  it('does not repeat what a resumed exam had already passed', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0 + 20 * MIN);
    const exam = createExam({
      id: 'exam-0001',
      now: T0,
      random: () => 0.3,
      config: {
        scope: { kind: 'all' },
        scopeLabel: 'All cards',
        questions: 2,
        minutes: 30,
        shuffle: false,
      },
      cards: facts(2),
    });
    const announce = vi.fn();
    const noop = () => {};
    render(
      <ExamRun
        exam={exam}
        cards={cardMap(exam)}
        announce={announce}
        onChoose={noop}
        onType={noop}
        onGo={noop}
        onFinish={noop}
        onLeave={noop}
        onTimeUp={noop}
      />,
    );
    act(() => void vi.advanceTimersByTime(5 * MIN));
    // 15:00 (half) was behind us at open; the next thing to say is the ten-percent mark at 27:00.
    expect(announce).toHaveBeenCalledTimes(0);
    act(() => void vi.advanceTimersByTime(2 * MIN));
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce.mock.calls[0]?.[0]).toMatch(/^Ten percent of the time is left/);
  });

  it('an exam with no limit shows no clock and announces nothing', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const exam = createExam({
      id: 'exam-0001',
      now: T0,
      random: () => 0.3,
      config: {
        scope: { kind: 'all' },
        scopeLabel: 'All cards',
        questions: 1,
        minutes: null,
        shuffle: false,
      },
      cards: facts(1),
    });
    const announce = vi.fn();
    const onTimeUp = vi.fn();
    const noop = () => {};
    render(
      <ExamRun
        exam={exam}
        cards={cardMap(exam)}
        announce={announce}
        onChoose={noop}
        onType={noop}
        onGo={noop}
        onFinish={noop}
        onLeave={noop}
        onTimeUp={onTimeUp}
      />,
    );
    expect(screen.queryByTestId(TID.examTimer)).toBeNull();
    expect(screen.getByText('No time limit')).toBeTruthy();
    act(() => void vi.advanceTimersByTime(600 * MIN));
    expect(announce).not.toHaveBeenCalled();
    expect(onTimeUp).not.toHaveBeenCalled();
  });
});
