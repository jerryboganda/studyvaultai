import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FilingOutcome } from '@shared';
import type { CaptureHost } from '../contract';
import { BIOLOGY, act, cleanupUi, makeHighlight, makeResult, mountUi, rect } from './testHarness';

/** The overlay's toasts for a filing rule (docs/adr/017-filing-rules.md), on the Preact runtime. */

const SELECTION = { text: 'Mitochondria are the powerhouse', rect: rect(100, 200, 120, 20) };
const ID = 'hl-new00001';

const suggested: FilingOutcome = {
  status: 'suggested',
  ruleName: 'Biology sites',
  bank: BIOLOGY,
  folderName: 'Week 1',
  addedTags: 1,
};
const filed: FilingOutcome = { ...suggested, status: 'filed' };

afterEach(() => {
  cleanupUi();
  vi.useRealTimers();
});

function setup(filing: FilingOutcome | undefined, host: Partial<CaptureHost> = {}) {
  const mounted = mountUi({ host });
  mounted.host.save.mockResolvedValueOnce(
    makeResult({ highlight: makeHighlight({ id: ID }), ...(filing ? { filing } : {}) }),
  );
  act(() => mounted.ui.showToolbar(SELECTION));
  return mounted;
}

const save = (q: ReturnType<typeof mountUi>['q']) =>
  userEvent.setup().click(q.getByRole('button', { name: 'Save selection' }));

describe('a rule that filed the highlight', () => {
  it('says where and by which rule, with Undo that undoes the filing and not the save', async () => {
    const undoFiling = vi.fn(async () => ({ restored: true, reason: null as string | null }));
    const { host, q } = setup(filed, { undoFiling });
    await save(q);

    expect(await q.findByText("Filed in Biology / Week 1 by rule 'Biology sites'")).toBeTruthy();
    // The plain "Saved to Inbox" would name a bank the highlight is no longer in.
    expect(q.queryByText(/Saved to/)).toBeNull();

    await userEvent.setup().click(q.getByRole('button', { name: 'Undo' }));
    expect(undoFiling).toHaveBeenCalledWith(ID);
    expect(host.undo).not.toHaveBeenCalled();
    expect(await q.findByText(/Filing undone/)).toBeTruthy();
  });

  it('reports why an undo could not be done', async () => {
    const undoFiling = vi.fn(async () => ({ restored: false, reason: 'It was moved again.' }));
    const { q } = setup(filed, { undoFiling });
    await save(q);
    await userEvent.setup().click(await q.findByRole('button', { name: 'Undo' }));
    expect(await q.findByText('It was moved again.')).toBeTruthy();
  });

  it('shows a failed undo as an error', async () => {
    const undoFiling = vi.fn(async () => {
      throw new Error('The worker did not answer.');
    });
    const { q } = setup(filed, { undoFiling });
    await save(q);
    await userEvent.setup().click(await q.findByRole('button', { name: 'Undo' }));
    expect(await q.findByText('The worker did not answer.')).toBeTruthy();
  });
});

describe('a rule that asks first', () => {
  it('shows the save and then a suggestion with File and Not now', async () => {
    const { q } = setup(suggested);
    await save(q);
    expect(await q.findByText('Saved to Inbox')).toBeTruthy();
    expect(await q.findByText("File in Biology / Week 1? Rule 'Biology sites'")).toBeTruthy();
    expect(q.getByRole('button', { name: 'File' })).toBeTruthy();
    expect(q.getByRole('button', { name: 'Not now' })).toBeTruthy();
    // Both toasts keep their own Undo / File, and the keyboard reaches the newest action.
    expect(q.getAllByRole('button', { name: 'Undo' })).toHaveLength(1);
  });

  it('File asks the worker, then offers Undo for the filing', async () => {
    const acceptFiling = vi.fn(async () => filed);
    const undoFiling = vi.fn(async () => ({ restored: true, reason: null as string | null }));
    const { q } = setup(suggested, { acceptFiling, undoFiling });
    await save(q);
    const user = userEvent.setup();
    await user.click(await q.findByRole('button', { name: 'File' }));
    expect(acceptFiling).toHaveBeenCalledWith(ID);
    expect(await q.findByText("Filed in Biology / Week 1 by rule 'Biology sites'")).toBeTruthy();
    await user.click(q.getAllByRole('button', { name: 'Undo' }).at(-1)!);
    expect(undoFiling).toHaveBeenCalledWith(ID);
  });

  it('Not now drops the suggestion and files nothing', async () => {
    const acceptFiling = vi.fn(async () => filed);
    const dismissFiling = vi.fn(async () => undefined);
    const { q } = setup(suggested, { acceptFiling, dismissFiling });
    await save(q);
    await userEvent.setup().click(await q.findByRole('button', { name: 'Not now' }));
    expect(dismissFiling).toHaveBeenCalledWith(ID);
    expect(acceptFiling).not.toHaveBeenCalled();
    expect(q.queryByText(/File in Biology/)).toBeNull();
  });

  it('says so when the suggestion is no longer there', async () => {
    const acceptFiling = vi.fn(async (): Promise<FilingOutcome> => ({
      status: 'unavailable',
      ruleName: '',
      reason: 'This suggestion is no longer available.',
    }));
    const { q } = setup(suggested, { acceptFiling });
    await save(q);
    await userEvent.setup().click(await q.findByRole('button', { name: 'File' }));
    expect(await q.findByText('This suggestion is no longer available.')).toBeTruthy();
  });
});

describe('a rule that could not be applied', () => {
  it('tells the person, keeps the "Saved" toast and offers no action', async () => {
    const { q } = setup({
      status: 'unavailable',
      ruleName: 'Biology sites',
      reason: 'The highlight stays where it was saved: its bank no longer exists.',
    });
    await save(q);
    expect(await q.findByText('Saved to Inbox')).toBeTruthy();
    expect(
      await q.findByText(
        "Rule 'Biology sites' could not file this highlight. The highlight stays where it was saved: its bank no longer exists.",
      ),
    ).toBeTruthy();
    expect(q.queryByRole('button', { name: 'File' })).toBeNull();
  });
});

describe('without a rule', () => {
  it('behaves exactly as before', async () => {
    const { q } = setup(undefined);
    await save(q);
    expect(await q.findByText('Saved to Inbox')).toBeTruthy();
    expect(q.getAllByRole('button', { name: 'Undo' })).toHaveLength(1);
    expect(q.queryByRole('button', { name: 'File' })).toBeNull();
  });
});
