import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createBank, createTag, deleteBank, listSyllabi } from '@storage';
import { freshDatabase } from '@storage/test-vault';
import { realApi } from './api';
import { SyllabusView } from './SyllabusView';
import { Harness } from './testHarness';
import { loadTreeData } from './treeData';

vi.setConfig({ testTimeout: 30_000 });
// Several agents and CI shards share the CPU: waiting for the page is not a failure.
configure({ asyncUtilTimeout: 10_000 });

beforeEach(async () => {
  await freshDatabase();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function seedVault() {
  const cardio = await createBank('Cardiology');
  const renal = await createBank('Renal');
  const { tag } = await createTag('High Yield');
  return { cardio, renal, tag };
}

async function renderView(initialId: string | null = null) {
  const tree = await loadTreeData(realApi);
  const onShowTopic = vi.fn();
  render(
    <Harness api={realApi} tree={tree}>
      <SyllabusView initialId={initialId} onShowTopic={onShowTopic} />
    </Harness>,
  );
  return { onShowTopic };
}

type User = ReturnType<typeof userEvent.setup>;

async function newSyllabus(user: User, name: string) {
  await user.click(await screen.findByTestId('syllabus-new'));
  await user.type(await screen.findByTestId('name-input'), name);
  await user.click(screen.getByTestId('dialog-confirm'));
  await screen.findByTestId('topic-add');
}

/** Add a topic after the selected one (or at the end) and give it a title. */
async function addTopic(user: User, title: string, sub = false) {
  await user.click(screen.getByTestId(sub ? 'topic-add-child' : 'topic-add'));
  const input = (await screen.findByTestId('topic-title')) as HTMLInputElement;
  await waitFor(() => expect(document.activeElement).toBe(input));
  await user.clear(input);
  await user.type(input, `${title}{Enter}`);
  await waitFor(() =>
    expect(screen.getByRole('treeitem', { name: new RegExp(title) })).toBeTruthy(),
  );
}

const stored = async () => (await listSyllabi())[0]!;
const titles = (nodes: Array<{ title: string; children: unknown[] }>): string[] =>
  nodes.map((n) => n.title);

describe('syllabus editor', () => {
  it('starts honest and empty, then creates a syllabus and saves each topic as it is typed', async () => {
    const user = userEvent.setup();
    await seedVault();
    await renderView();
    expect(await screen.findByText('You have no syllabus yet')).toBeTruthy();
    expect(screen.queryByTestId('topic-add')).toBeNull();

    await newSyllabus(user, 'Cardiology exam');
    expect(screen.getByText('This syllabus has no topics yet')).toBeTruthy();
    expect(screen.getByTestId('syllabus-size').textContent).toMatch(
      /^0 of 500 topics · 0 of 6 levels/,
    );

    await addTopic(user, 'Heart failure');
    await addTopic(user, 'Arrhythmias');
    await addTopic(user, 'Drugs', true);

    await waitFor(async () => {
      const s = await stored();
      expect(titles(s.nodes)).toEqual(['Heart failure', 'Arrhythmias']);
      expect(titles(s.nodes[1]!.children as never)).toEqual(['Drugs']);
    });
    expect(screen.getByTestId('syllabus-size').textContent).toMatch(
      /^3 of 500 topics · 2 of 6 levels/,
    );
    expect((await stored()).name).toBe('Cardiology exam');
  });

  it('reorders, indents and outdents with the buttons and says why a move is not possible', async () => {
    const user = userEvent.setup();
    await seedVault();
    await renderView();
    await newSyllabus(user, 'Moves');
    await addTopic(user, 'One');
    await addTopic(user, 'Two');
    await addTopic(user, 'Three');

    // "Three" is selected and last: it cannot move down, and the button says why.
    const down = screen.getByTestId('topic-down');
    expect(down.getAttribute('aria-disabled')).toBe('true');
    expect(down.getAttribute('title')).toBe('Already the last topic at this level.');

    await user.click(screen.getByTestId('topic-up'));
    await waitFor(async () =>
      expect(titles((await stored()).nodes)).toEqual(['One', 'Three', 'Two']),
    );
    await user.click(screen.getByTestId('topic-indent'));
    await waitFor(async () => {
      const s = await stored();
      expect(titles(s.nodes)).toEqual(['One', 'Two']);
      expect(titles(s.nodes[0]!.children as never)).toEqual(['Three']);
    });
    await user.click(screen.getByTestId('topic-outdent'));
    await waitFor(async () =>
      expect(titles((await stored()).nodes)).toEqual(['One', 'Three', 'Two']),
    );

    // Select "One": nothing above it.
    await user.click(screen.getByRole('treeitem', { name: /One/ }));
    expect(screen.getByTestId('topic-up').getAttribute('title')).toBe(
      'Already the first topic at this level.',
    );
    expect(screen.getByTestId('topic-indent').getAttribute('title')).toBe(
      'There is no topic above to move this one into.',
    );
  });

  it('works from the keyboard: Alt+Arrow moves, F2 edits the title, Delete removes with Undo', async () => {
    const user = userEvent.setup();
    await seedVault();
    await renderView();
    await newSyllabus(user, 'Keys');
    await addTopic(user, 'Alpha');
    await addTopic(user, 'Beta');

    const beta = screen.getByRole('treeitem', { name: /Beta/ });
    act_focus(beta);
    fireEvent.keyDown(beta, { key: 'ArrowUp', altKey: true });
    await waitFor(async () => expect(titles((await stored()).nodes)).toEqual(['Beta', 'Alpha']));

    fireEvent.keyDown(screen.getByRole('treeitem', { name: /Beta/ }), { key: 'F2' });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('topic-title')));

    fireEvent.keyDown(screen.getByRole('treeitem', { name: /Beta/ }), { key: 'Delete' });
    await waitFor(async () => expect(titles((await stored()).nodes)).toEqual(['Alpha']));
    const undo = await screen.findByRole('button', { name: 'Undo' });
    await user.click(undo);
    await waitFor(async () => expect(titles((await stored()).nodes)).toEqual(['Beta', 'Alpha']));
  });

  it('refuses topics past the limits with the schema wording', async () => {
    const user = userEvent.setup();
    await seedVault();
    await renderView();
    await newSyllabus(user, 'Deep');
    await addTopic(user, 'L1');
    for (let level = 2; level <= 6; level += 1) await addTopic(user, `L${level}`, true);

    const child = screen.getByTestId('topic-add-child');
    expect(child.getAttribute('aria-disabled')).toBe('true');
    expect(child.getAttribute('title')).toBe('Topics can be nested at most 6 levels deep.');
    expect(screen.getByTestId('syllabus-size').textContent).toMatch(
      /6 of 500 topics · 6 of 6 levels/,
    );
    // A sibling at the deepest level is fine.
    expect(screen.getByTestId('topic-add').getAttribute('aria-disabled')).toBeNull();
  });

  it('validates the weight in the field and keeps only a valid one', async () => {
    const user = userEvent.setup();
    await seedVault();
    await renderView();
    await newSyllabus(user, 'Weights');
    await addTopic(user, 'Heavy');

    const weight = screen.getByTestId('topic-weight') as HTMLInputElement;
    await user.type(weight, '0');
    await user.tab();
    expect(weight.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText(/Use a number above 0 and at most 1000/)).toBeTruthy();
    expect((await stored()).nodes[0]).not.toHaveProperty('weight');

    await user.clear(weight);
    await user.type(weight, '2.5');
    await user.tab();
    await waitFor(async () => expect((await stored()).nodes[0]?.weight).toBe(2.5));
    expect(weight.getAttribute('aria-invalid')).toBeNull();

    await user.clear(weight);
    await user.tab();
    await waitFor(async () => expect((await stored()).nodes[0]).not.toHaveProperty('weight'));
  });

  it('maps a topic to banks and tags, and shows its highlights as a bank or a search', async () => {
    const user = userEvent.setup();
    const { cardio, tag } = await seedVault();
    const { onShowTopic } = await renderView();
    await newSyllabus(user, 'Mapping');
    await addTopic(user, 'Cardiac');

    const show = screen.getByTestId('topic-show');
    expect(show.getAttribute('aria-disabled')).toBe('true');
    expect(show.getAttribute('title')).toBe('Map a bank or a tag to this topic first.');
    expect(screen.getByRole('treeitem', { name: /Cardiac/ }).textContent).toContain('not mapped');

    const banks = within(screen.getByTestId('topic-banks'));
    await user.click(banks.getByRole('checkbox', { name: 'Cardiology' }));
    await waitFor(async () => expect((await stored()).nodes[0]?.bankIds).toEqual([cardio.id]));
    await user.click(screen.getByTestId('topic-show'));
    expect(onShowTopic).toHaveBeenLastCalledWith({ kind: 'bank', bankId: cardio.id });

    const tags = within(screen.getByTestId('topic-tags'));
    await user.click(tags.getByRole('checkbox', { name: 'High Yield' }));
    await waitFor(async () => expect((await stored()).nodes[0]?.tagIds).toEqual([tag.id]));
    await user.click(screen.getByTestId('topic-show'));
    expect(onShowTopic).toHaveBeenLastCalledWith({
      kind: 'search',
      q: '(bank:"Cardiology" OR tag:"High Yield")',
      used: 2,
      total: 2,
    });
    expect(screen.getByRole('treeitem', { name: /Cardiac/ }).textContent).toContain(
      '1 bank, 1 tag',
    );
  });

  it('reports what a topic points at that is gone, and lets the person untick it', async () => {
    const user = userEvent.setup();
    const { cardio } = await seedVault();
    await renderView();
    await newSyllabus(user, 'Gone');
    await addTopic(user, 'Cardiac');
    await user.click(
      within(screen.getByTestId('topic-banks')).getByRole('checkbox', { name: 'Cardiology' }),
    );
    await waitFor(async () => expect((await stored()).nodes[0]?.bankIds).toEqual([cardio.id]));
    cleanup();

    await deleteBank(cardio.id);
    await renderView((await stored()).id);
    await user.click(await screen.findByRole('treeitem', { name: /Cardiac/ }));
    expect(await screen.findByText('Some of what this topic points at is gone')).toBeTruthy();
    const gone = within(screen.getByTestId('topic-banks')).getByRole('checkbox', {
      name: /deleted or in the trash/,
    });
    expect((gone as HTMLInputElement).checked).toBe(true);
    await user.click(gone);
    await waitFor(async () => expect((await stored()).nodes[0]?.bankIds).toEqual([]));
  });
});

describe('syllabus list', () => {
  it('renames, and deletes with an Undo that brings the syllabus back', async () => {
    const user = userEvent.setup();
    await seedVault();
    await renderView();
    await newSyllabus(user, 'First draft');
    await addTopic(user, 'Topic');

    await user.click(screen.getByTestId('syllabus-rename'));
    const input = await screen.findByTestId('name-input');
    await user.clear(input);
    await user.type(input, 'Final');
    await user.click(screen.getByTestId('dialog-confirm'));
    await waitFor(async () => expect((await stored()).name).toBe('Final'));
    await waitFor(() =>
      expect(within(screen.getByTestId('syllabus-select')).getByText('Final')).toBeTruthy(),
    );

    await user.click(screen.getByTestId('syllabus-delete'));
    expect(await screen.findByText('You have no syllabus yet')).toBeTruthy();
    expect(await listSyllabi()).toHaveLength(0);
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect(await listSyllabi()).toHaveLength(1));
    expect(await screen.findByTestId('topic-add')).toBeTruthy();
    expect((await stored()).nodes).toHaveLength(1);
  });

  it('starts from the banks: one mapped topic per bank, never the Inbox', async () => {
    const user = userEvent.setup();
    const { cardio, renal } = await seedVault();
    await renderView();
    await user.click(await screen.findByTestId('syllabus-from-banks'));
    await waitFor(async () => {
      const s = await stored();
      expect(titles(s.nodes).sort()).toEqual(['Cardiology', 'Renal']);
      expect(s.nodes.flatMap((n) => n.bankIds).sort()).toEqual([cardio.id, renal.id].sort());
    });
  });

  it('disables "Start from my banks" with its reason when there is nothing to start from', async () => {
    await renderView();
    const button = await screen.findByTestId('syllabus-from-banks');
    await waitFor(() =>
      expect(button.getAttribute('title')).toBe('You have no banks besides the Inbox yet.'),
    );
    expect(button.getAttribute('aria-disabled')).toBe('true');
  });

  it('exports the outline as Markdown through a download, not the network', async () => {
    const user = userEvent.setup();
    await seedVault();
    const blobs: Blob[] = [];
    URL.createObjectURL = vi.fn((b: Blob) => {
      blobs.push(b);
      return 'blob:syllabus';
    });
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await renderView();
    await newSyllabus(user, 'Export me');
    await addTopic(user, 'Physiology');
    await user.click(screen.getByTestId('syllabus-export'));
    expect(click).toHaveBeenCalledTimes(1);
    expect(blobs).toHaveLength(1);
    const text = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsText(blobs[0]!);
    });
    expect(text).toBe('# Export me\n\n- Physiology\n');
  });
});

describe('importing an outline', () => {
  const paste = (text: string) =>
    fireEvent.change(screen.getByTestId('syllabus-import-text'), { target: { value: text } });

  it('previews before anything is saved, then creates the syllabus with its weights', async () => {
    const user = userEvent.setup();
    await seedVault();
    await renderView();
    await user.click(await screen.findByTestId('syllabus-import'));

    const confirm = await screen.findByTestId('dialog-confirm');
    expect(confirm.getAttribute('aria-disabled')).toBe('true');
    expect(confirm.getAttribute('title')).toBe('Paste an outline first.');

    paste(
      '# Pharmacology\n- Autonomics (weight 3)\n  - Cholinergics\n  - Adrenergics\n- Antibiotics',
    );
    await waitFor(() =>
      expect(screen.getByTestId('syllabus-import-summary').textContent).toMatch(
        /4 topics in 2 levels will be created as “Pharmacology”/,
      ),
    );
    expect(await listSyllabi()).toHaveLength(0); // a preview saves nothing
    const preview = within(screen.getByTestId('syllabus-import-preview'));
    expect(preview.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Autonomics (weight 3)',
      'Cholinergics',
      'Adrenergics',
      'Antibiotics',
    ]);

    await user.click(confirm);
    await waitFor(async () => {
      const s = await stored();
      expect(s.name).toBe('Pharmacology');
      expect(titles(s.nodes)).toEqual(['Autonomics', 'Antibiotics']);
      expect(s.nodes[0]?.weight).toBe(3);
      expect(titles(s.nodes[0]!.children as never)).toEqual(['Cholinergics', 'Adrenergics']);
    });
    expect(await screen.findByRole('treeitem', { name: /Autonomics/ })).toBeTruthy();
  });

  it('blocks an outline the schema would refuse, with the line and the limit', async () => {
    const user = userEvent.setup();
    await renderView();
    await user.click(await screen.findByTestId('syllabus-import'));
    await screen.findByTestId('syllabus-import-text');
    paste(Array.from({ length: 8 }, (_, i) => `${'  '.repeat(i)}- level ${i + 1}`).join('\n'));

    const errors = await screen.findByTestId('syllabus-import-errors');
    expect(errors.textContent).toContain('Line 7');
    expect(errors.textContent).toContain('at most 6 are allowed');
    const confirm = screen.getByTestId('dialog-confirm');
    expect(confirm.getAttribute('aria-disabled')).toBe('true');
    expect(confirm.getAttribute('title')).toBe('Fix the problems listed first.');
    await userEvent.setup().click(confirm);
    expect(await listSyllabi()).toHaveLength(0);
  });
});

/** `focus()` inside act, so the roving tabindex follows. */
function act_focus(el: HTMLElement) {
  el.focus();
}
