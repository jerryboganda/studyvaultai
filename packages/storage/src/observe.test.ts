// @vitest-environment node
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { resetDbForTests } from './db';
import { observe } from './observe';
import { createBank, listBanksWithCounts, listRecentHighlights, saveCapture } from './repo';
import { cap } from './test-fixtures';

let unsubscribe: (() => void) | undefined;

beforeEach(async () => {
  await resetDbForTests();
  fakeBrowser.reset();
});

afterEach(() => {
  unsubscribe?.();
  unsubscribe = undefined;
});

describe('observe', () => {
  it('emits the current value and re-emits after repo mutations', async () => {
    const seen: number[] = [];
    unsubscribe = observe(() => listRecentHighlights(10)).subscribe((items) =>
      seen.push(items.length),
    );
    await vi.waitFor(() => expect(seen.at(-1)).toBe(0), { timeout: 5000 });

    await saveCapture(cap('First observed quote', 10));
    await vi.waitFor(() => expect(seen.at(-1)).toBe(1), { timeout: 5000 });

    await saveCapture(cap('Second observed quote', 400));
    await vi.waitFor(() => expect(seen.at(-1)).toBe(2), { timeout: 5000 });
  });

  it('runs bank listings (virtual Inbox, no writes) inside a live query', async () => {
    const seen: string[][] = [];
    const errors: unknown[] = [];
    unsubscribe = observe(() => listBanksWithCounts()).subscribe(
      (rows) => seen.push(rows.map((r) => `${r.bank.name}:${r.count}`)),
      (err) => errors.push(err),
    );
    await vi.waitFor(() => expect(seen.at(-1)).toEqual(['Inbox:0']), { timeout: 5000 });

    await createBank('Cardiology');
    await vi.waitFor(() => expect(seen.at(-1)).toEqual(['Inbox:0', 'Cardiology:0']), {
      timeout: 5000,
    });

    await saveCapture(cap('Counted quote text', 10));
    await vi.waitFor(() => expect(seen.at(-1)).toEqual(['Inbox:1', 'Cardiology:0']), {
      timeout: 5000,
    });
    expect(errors).toEqual([]);
  });

  it('stops emitting after unsubscribe', async () => {
    const seen: number[] = [];
    const stop = observe(() => listRecentHighlights(10)).subscribe((items) =>
      seen.push(items.length),
    );
    await vi.waitFor(() => expect(seen.at(-1)).toBe(0), { timeout: 5000 });
    stop();
    const emitted = seen.length;
    await saveCapture(cap('After unsubscribe quote', 10));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seen).toHaveLength(emitted);
  });
});
