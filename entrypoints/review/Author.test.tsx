import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  configure,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { listCards, listKnowledgePoints } from '@storage';
import { freshDatabase, save } from '@storage/test-vault';
import { ToastProvider } from '@ui';
import { TID } from '@ui/review';
import { Author } from './Author';

function renderAuthor(highlightId: string | null) {
  return render(
    <ToastProvider>
      <Author initialHighlightId={highlightId} />
    </ToastProvider>,
  );
}

vi.setConfig({ testTimeout: 30_000 });
// Several agents and CI shards share the CPU: waiting for the page is not a failure.
configure({ asyncUtilTimeout: 10_000 });

beforeEach(async () => {
  await freshDatabase();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(cleanup);

const tab = (name: string | RegExp) => screen.getByRole('tab', { name });
const createButton = () => screen.getByTestId(TID.saveCards);
/** Typing one character at a time re-renders the live preview each time: set the value at once. */
const fill = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

describe('card author', () => {
  it('asks for a highlight first and lists the saved ones', async () => {
    await save('Aspirin irreversibly inhibits cyclooxygenase.');
    renderAuthor(null);
    expect(await screen.findByText('Choose a highlight')).toBeTruthy();
    expect(await screen.findByText(/Aspirin irreversibly inhibits/)).toBeTruthy();
  });

  it('a basic card previews live and is stored with the highlight as its source', async () => {
    const user = userEvent.setup();
    const h = await save('Metformin reduces hepatic gluconeogenesis.');
    renderAuthor(h.id);
    await screen.findByTestId(TID.editor);

    // Incomplete: the button says why instead of failing after the click.
    expect(createButton().getAttribute('aria-disabled')).toBe('true');
    expect(createButton().getAttribute('title')).toMatch(/front of the card is empty|empty/i);

    fill(screen.getByLabelText('Question'), 'What does metformin reduce?');
    await user.click(screen.getByRole('button', { name: 'Use the quote as the answer' }));
    const preview = screen.getByTestId(TID.preview);
    expect(preview.textContent).toContain('What does metformin reduce?');
    expect(preview.textContent).toContain('Metformin reduces hepatic gluconeogenesis.');
    expect(preview.textContent).toMatch(/1 card will be created/);

    await user.click(createButton());
    await waitFor(async () => expect((await listCards()).total).toBe(1));
    const { cards } = await listCards();
    expect(cards[0]).toMatchObject({
      cardType: 'basic',
      front: 'What does metformin reduce?',
      highlightId: h.id,
      sourceQuote: 'Metformin reduces hepatic gluconeogenesis.',
    });
    // The form clears for the next card.
    await waitFor(() =>
      expect((screen.getByLabelText('Question') as HTMLInputElement).value).toBe(''),
    );
  });

  it('the cloze helper wraps the selected words and makes one card per deletion', async () => {
    const user = userEvent.setup();
    const text = 'Aspirin irreversibly inhibits cyclooxygenase.';
    const h = await save(text);
    renderAuthor(h.id);
    await screen.findByTestId(TID.editor);
    await user.click(tab('Fill in the blank'));

    const area = screen.getByTestId(TID.clozeText) as HTMLTextAreaElement;
    expect(area.value).toBe(text);

    // Nothing selected: the helper explains instead of doing nothing.
    area.setSelectionRange(3, 3);
    await user.click(screen.getByTestId(TID.clozeWrap));
    expect(await screen.findByText('Select the word or phrase to hide first.')).toBeTruthy();

    area.setSelectionRange(0, 7);
    await user.click(screen.getByTestId(TID.clozeWrap));
    expect(area.value).toBe('{{c1::Aspirin}} irreversibly inhibits cyclooxygenase.');

    const start = area.value.indexOf('cyclooxygenase');
    area.setSelectionRange(start, start + 'cyclooxygenase'.length);
    fireEvent.change(screen.getByTestId(TID.clozeHint), { target: { value: 'enzyme' } });
    await user.click(screen.getByTestId(TID.clozeWrap));
    expect(area.value).toBe(
      '{{c1::Aspirin}} irreversibly inhibits {{c2::cyclooxygenase::enzyme}}.',
    );

    const preview = screen.getByTestId(TID.preview);
    expect(preview.textContent).toMatch(/2 cards will be created/);
    expect(preview.textContent).toContain('[enzyme]');

    await user.click(createButton());
    await waitFor(async () => expect((await listCards()).total).toBe(2));
    const { cards } = await listCards();
    expect(cards.map((c) => c.cloze?.activeIndex).sort()).toEqual([1, 2]);
    expect(cards.every((c) => c.highlightId === h.id)).toBe(true);
  });

  it('keeps the wrapped words selected without waiting for an animation frame', async () => {
    // A late animation-frame callback used to re-select the previous words after a person (or a
    // script) had already selected new ones, so the next wrap nested a deletion inside the first.
    // No frame ever fires here: the selection must already be where the helper promises.
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0);
    const user = userEvent.setup();
    const h = await save('Aspirin irreversibly inhibits cyclooxygenase.');
    renderAuthor(h.id);
    await screen.findByTestId(TID.editor);
    await user.click(tab('Fill in the blank'));

    const area = screen.getByTestId(TID.clozeText) as HTMLTextAreaElement;
    area.setSelectionRange(0, 7);
    await user.click(screen.getByTestId(TID.clozeWrap));
    expect(area.value).toBe('{{c1::Aspirin}} irreversibly inhibits cyclooxygenase.');
    expect([area.selectionStart, area.selectionEnd]).toEqual([6, 13]);
    expect(area.value.slice(area.selectionStart, area.selectionEnd)).toBe('Aspirin');
  });

  it('a multiple-choice card needs two options and a marked answer', async () => {
    const user = userEvent.setup();
    const h = await save('Warfarin inhibits vitamin K epoxide reductase.');
    renderAuthor(h.id);
    await screen.findByTestId(TID.editor);
    await user.click(tab('Multiple choice'));
    fill(screen.getByLabelText('Question'), 'Which enzyme does warfarin inhibit?');
    fill(screen.getByLabelText('Option 1 text'), 'VKOR');
    expect(createButton().getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByTestId(TID.previewIssues).textContent).toMatch(/at least 2 choices/);

    fill(screen.getByLabelText('Option 2 text'), 'COX-1');
    await user.click(screen.getByLabelText('Option 2 is correct'));
    await user.click(createButton());
    await waitFor(async () => expect((await listCards()).total).toBe(1));
    const [card] = (await listCards()).cards;
    expect(card!.choices?.map((c) => c.text)).toEqual(['VKOR', 'COX-1']);
    expect(card!.back).toBe('COX-1');
  });

  it('bulk: one question per highlight, rows without a question are left out', async () => {
    const user = userEvent.setup();
    const a = await save('First fact about the heart.');
    await save('Second fact about the lungs.', { bankId: null });
    renderAuthor(null);
    const rowA = await screen.findByTestId(`rv-pick-${a.id}`);
    await user.click(within(rowA).getByRole('checkbox'));
    const all = screen.getAllByRole('checkbox');
    for (const box of all) if (!(box as HTMLInputElement).checked) await user.click(box);
    expect(tab(/From several/).textContent).toMatch(/\(2\)/);
    await user.click(tab(/From several/));

    const bulk = await screen.findByTestId(TID.bulk);
    // The heading context of the capture fixture seeds a question; the learner may change it.
    const inputs = within(bulk).getAllByLabelText('Question') as HTMLInputElement[];
    expect(inputs).toHaveLength(2);
    expect(inputs[0]!.value).toMatch(/What does the source say about "Antiplatelets"\?/);
    await user.clear(inputs[1]!);
    expect(within(bulk).getByText(/Add a question or untick this row/)).toBeTruthy();
    expect(screen.getByTestId(TID.bulkCreate).textContent).toBe('Create 1 card');

    await user.click(screen.getByTestId(TID.bulkCreate));
    await waitFor(async () => expect((await listCards()).total).toBe(1));
    const [card] = (await listCards()).cards;
    expect(card!.front).toMatch(/Antiplatelets/);
    expect(card!.back).toMatch(/fact about the/);
  });

  it('a typed card has no source and goes to a General deck', async () => {
    const user = userEvent.setup();
    renderAuthor(null);
    await user.click(await screen.findByRole('tab', { name: 'Typed card' }));
    const manual = screen.getByTestId(TID.manual);
    fill(within(manual).getByLabelText('Question'), 'What is the heart rate range?');
    fill(within(manual).getByLabelText('Answer'), '60 to 100 per minute');
    await user.click(createButton());
    await waitFor(async () => expect((await listCards()).total).toBe(1));
    const [card] = (await listCards()).cards;
    expect(card).toMatchObject({ highlightId: null, sourceQuote: null });
  });
});

describe('knowledge point editor', () => {
  it('starts not checked, will not claim source support without evidence, and saves', async () => {
    const user = userEvent.setup();
    const h = await save('Statins inhibit HMG-CoA reductase.');
    renderAuthor(h.id);
    const editor = await screen.findByTestId(TID.kpEditor);
    const status = (await within(editor).findByTestId(TID.kpStatus)) as HTMLSelectElement;
    expect(status.value).toBe('not_checked');
    const supported = within(status).getByRole('option', { name: /Supported by a source/ });
    expect((supported as HTMLOptionElement).disabled).toBe(true);

    // Saving needs a statement; the button says so.
    expect(within(editor).getByTestId(TID.kpSave).getAttribute('aria-disabled')).toBe('true');
    fill(within(editor).getByTestId(TID.kpOneLiner), 'Statins block cholesterol synthesis');
    fill(within(editor).getByTestId(TID.kpPearl), 'Take at night for short-acting ones.');

    // A claim linked to this highlight is evidence: now the label can be set, by the person.
    await user.click(within(editor).getByTestId(TID.kpAddClaim));
    fill(within(editor).getByLabelText('Claim 1'), 'Inhibits HMG-CoA reductase');
    await waitFor(() =>
      expect(
        (within(status).getByRole('option', { name: /Supported by a source/ }) as HTMLOptionElement)
          .disabled,
      ).toBe(false),
    );
    await user.selectOptions(status, 'source_supported');
    await user.click(within(editor).getByTestId(TID.kpSave));

    await waitFor(async () =>
      expect(await listKnowledgePoints({ highlightId: h.id })).toHaveLength(1),
    );
    const [kp] = await listKnowledgePoints({ highlightId: h.id });
    expect(kp).toMatchObject({
      createdBy: 'user',
      verificationStatus: 'source_supported',
      examPearl: 'Take at night for short-acting ones.',
    });
    expect(kp!.claims[0]!.evidenceHighlightIds).toEqual([h.id]);
  });
});
