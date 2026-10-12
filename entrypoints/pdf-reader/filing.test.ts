// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { FilingOutcome } from '@shared';
import { filingToasts, type FilingToast } from './filing';

const bank = { id: 'bank-bio00001', name: 'Biology', color: 'green', isInbox: false } as const;
const suggested: FilingOutcome = {
  status: 'suggested',
  ruleName: 'Textbooks',
  bank,
  folderName: null,
  addedTags: 0,
};
const filed: FilingOutcome = { ...suggested, status: 'filed' };

function setup() {
  const port = {
    accept: vi.fn(async (_id: string): Promise<FilingOutcome> => filed),
    dismiss: vi.fn(async (_id: string) => undefined),
    undo: vi.fn(async (_id: string) => ({ restored: true, reason: null as string | null })),
  };
  const pushed: FilingToast[] = [];
  const refresh = vi.fn(async () => undefined);
  return { port, pushed, refresh, push: (t: FilingToast) => pushed.push(t) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('PDF reader notices for filing rules', () => {
  it('one toast for a result shared by several highlights', () => {
    const t = setup();
    const toasts = filingToasts(
      [
        { id: 'hl-0000001a', filing: suggested },
        { id: 'hl-0000001b', filing: suggested },
      ],
      t.port,
      t.push,
      t.refresh,
    );
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.message).toBe("File in Biology? Rule 'Textbooks' (2 highlights)");
    expect(toasts[0]!.action!.label).toBe('File');
  });

  it('File files each highlight, then offers Undo for the filing', async () => {
    const t = setup();
    const [toast] = filingToasts(
      [
        { id: 'hl-0000001a', filing: suggested },
        { id: 'hl-0000001b', filing: suggested },
      ],
      t.port,
      t.push,
      t.refresh,
    );
    toast!.action!.onClick();
    await settle();
    expect(t.port.accept.mock.calls.map((c) => c[0])).toEqual(['hl-0000001a', 'hl-0000001b']);
    expect(t.refresh).toHaveBeenCalled();
    expect(t.pushed).toHaveLength(1);
    expect(t.pushed[0]!.message).toBe("Filed in Biology by rule 'Textbooks' (2 highlights)");
    expect(t.pushed[0]!.action!.label).toBe('Undo');

    t.pushed[0]!.action!.onClick();
    await settle();
    expect(t.port.undo.mock.calls.map((c) => c[0])).toEqual(['hl-0000001a', 'hl-0000001b']);
    expect(t.pushed.at(-1)!.message).toMatch(/Filing undone/);
  });

  it('a filed result offers Undo straight away', async () => {
    const t = setup();
    const [toast] = filingToasts([{ id: 'hl-0000001a', filing: filed }], t.port, t.push, t.refresh);
    expect(toast!.message).toBe("Filed in Biology by rule 'Textbooks'");
    t.port.undo.mockResolvedValueOnce({ restored: false, reason: 'It was moved again.' });
    toast!.action!.onClick();
    await settle();
    expect(t.pushed.at(-1)!.message).toBe('It was moved again.');
  });

  it('says so when a rule could not be applied, without an action', () => {
    const t = setup();
    const [toast] = filingToasts(
      [
        {
          id: 'hl-0000001a',
          filing: {
            status: 'unavailable',
            ruleName: 'Textbooks',
            reason: 'The highlight stays where it was saved: its bank no longer exists.',
          },
        },
      ],
      t.port,
      t.push,
      t.refresh,
    );
    expect(toast!.message).toContain("Rule 'Textbooks' could not file this highlight.");
    expect(toast!.action).toBeUndefined();
  });

  it('reports a failure instead of staying silent', async () => {
    const t = setup();
    t.port.accept.mockRejectedValueOnce(new Error('storage busy'));
    const [toast] = filingToasts(
      [{ id: 'hl-0000001a', filing: suggested }],
      t.port,
      t.push,
      t.refresh,
    );
    toast!.action!.onClick();
    await settle();
    expect(t.pushed).toEqual([{ tone: 'error', message: 'storage busy' }]);
  });
});
