import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaptureResult, FilingOutcome } from '@shared';
import {
  FakeBackground,
  clearSelection,
  flushPromises,
  select,
  setBody,
  startHarness,
  type Harness,
} from './testUtils';

/**
 * The keyboard and context-menu path (content.captureSelection) tells the person about a filing rule
 * the same way the toolbar overlay does (docs/adr/017-filing-rules.md).
 */

const RIBO = 'Ribosomes build proteins from amino acids';
const sender = {} as never;
const harnesses: Harness[] = [];

const suggested: FilingOutcome = {
  status: 'suggested',
  ruleName: 'Biology sites',
  bank: { id: 'bank-bio00001', name: 'Biology', color: 'green', isInbox: false },
  folderName: null,
  addedTags: 0,
};

async function boot(filing: FilingOutcome | null): Promise<Harness> {
  const background = new FakeBackground();
  background.filing = filing;
  const h = startHarness({ background });
  harnesses.push(h);
  await h.controller.ready;
  await flushPromises();
  return h;
}

beforeEach(() => {
  vi.useFakeTimers();
  setBody(
    '<article><p>Ribosomes build proteins from amino acids inside the cytoplasm.</p></article>',
  );
});

afterEach(() => {
  for (const h of harnesses.splice(0)) h.controller.destroy();
  clearSelection();
  vi.useRealTimers();
  setBody('');
});

const capture = async (h: Harness): Promise<CaptureResult> => {
  select(RIBO);
  return (await h.handlers['content.captureSelection']!(
    { method: 'shortcut', bankId: null },
    sender,
  )) as CaptureResult;
};

describe('captureSelection with a filing rule', () => {
  it('returns the filing outcome to the caller', async () => {
    const h = await boot(suggested);
    const result = await capture(h);
    expect(result.filing).toEqual(suggested);
  });

  it('a rule that filed it replaces the "Saved" toast and its Undo undoes the filing', async () => {
    const filed: FilingOutcome = { ...suggested, status: 'filed' };
    const h = await boot(filed);
    const result = await capture(h);

    expect(h.ui.toasts.map((t) => t.text)).toEqual(["Filed in Biology by rule 'Biology sites'"]);
    h.ui.toasts[0]!.action!.run();
    await flushPromises();
    expect(h.background.callsOf('filing.undo')).toEqual([
      { type: 'filing.undo', payload: { highlightId: result.highlight.id } },
    ]);
    expect(h.background.callsOf('highlight.delete')).toHaveLength(0);
    expect(h.ui.toasts.at(-1)!.text).toMatch(/Filing undone/);
  });

  it('a suggestion follows the "Saved" toast; File and Not now go to the worker', async () => {
    const h = await boot(suggested);
    const result = await capture(h);

    expect(h.ui.toasts.map((t) => t.text)).toEqual([
      'Saved to Inbox',
      "File in Biology? Rule 'Biology sites'",
    ]);
    const suggestion = h.ui.toasts[1]!;
    expect(suggestion.action!.label).toBe('File');
    expect(suggestion.secondary!.label).toBe('Not now');

    suggestion.secondary!.run();
    await flushPromises();
    expect(h.background.callsOf('filing.dismiss')).toEqual([
      { type: 'filing.dismiss', payload: { highlightId: result.highlight.id } },
    ]);

    suggestion.action!.run();
    await flushPromises();
    expect(h.background.callsOf('filing.accept')).toEqual([
      { type: 'filing.accept', payload: { highlightId: result.highlight.id } },
    ]);
    expect(h.ui.toasts.at(-1)!.text).toBe("Filed in Biology by rule 'Rule'");
  });

  it('reports a worker failure instead of staying silent', async () => {
    const h = await boot(suggested);
    await capture(h);
    h.background.failNext('filing.accept', new Error('storage busy'));
    h.ui.toasts[1]!.action!.run();
    await flushPromises();
    expect(h.ui.toasts.at(-1)).toMatchObject({ tone: 'error' });
  });

  it('without a rule there is a single toast, as before', async () => {
    const h = await boot(null);
    await capture(h);
    expect(h.ui.toasts.map((t) => t.text)).toEqual(['Saved to Inbox']);
  });
});
