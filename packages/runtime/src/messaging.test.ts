// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { BackgroundRpc, StudyVaultError } from '@shared';
import {
  CALL_TIMEOUT_MS,
  HANDLER_TIMEOUT_MS,
  callBackground,
  callTab,
  serveRpc,
  type Handlers,
} from './messaging';

type Reply = { ok: boolean; data?: unknown; error?: { code: string; message: string } };

/** Microtasks only, so it also works under fake timers. */
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** Delivers one message to the registered listener(s) and returns the replies sent so far. */
async function deliver(type: string, sender: object = { id: browser.runtime.id }) {
  const replies: Reply[] = [];
  await fakeBrowser.runtime.onMessage.trigger({ v: 1, type, payload: {} }, sender, (r: unknown) => {
    replies.push(r as Reply);
  });
  await flush();
  return replies;
}

const never = () => new Promise<never>(() => undefined);
const banks = { banks: [], lastBankId: null };

beforeEach(() => {
  fakeBrowser.reset();
});
afterEach(() => vi.useRealTimers());

describe('serveRpc settles every accepted request', () => {
  it('replies with the data of a handler that succeeds', async () => {
    serveRpc(BackgroundRpc, { 'banks.list': async () => banks });
    expect(await deliver('banks.list')).toEqual([{ ok: true, data: banks }]);
  });

  it('replies with the error of a handler that rejects', async () => {
    serveRpc(BackgroundRpc, {
      'banks.list': async () => {
        throw new StudyVaultError('forbidden', 'nope');
      },
    });
    expect(await deliver('banks.list')).toEqual([
      { ok: false, error: { code: 'forbidden', message: 'nope' } },
    ]);
  });

  it('turns a handler that throws synchronously into an error reply', async () => {
    const handlers: Handlers<typeof BackgroundRpc> = {
      'banks.list': (() => {
        throw new Error('sync boom');
      }) as never,
    };
    serveRpc(BackgroundRpc, handlers);
    expect(await deliver('banks.list')).toEqual([
      { ok: false, error: { code: 'internal', message: 'sync boom' } },
    ]);
  });

  it('answers a handler that never settles with an internal error, and leaves no timer', async () => {
    vi.useFakeTimers();
    serveRpc(BackgroundRpc, { 'banks.list': never });
    const replies: Reply[] = [];
    await fakeBrowser.runtime.onMessage.trigger(
      { v: 1, type: 'banks.list', payload: {} },
      { id: browser.runtime.id },
      (r: unknown) => replies.push(r as Reply),
    );
    await vi.advanceTimersByTimeAsync(HANDLER_TIMEOUT_MS - 1);
    expect(replies).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      ok: false,
      error: { code: 'internal', message: expect.stringContaining('banks.list') },
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('honours a per-registration timeout', async () => {
    vi.useFakeTimers();
    serveRpc(BackgroundRpc, { 'banks.list': never }, { timeoutMs: 1000 });
    const replies: Reply[] = [];
    await fakeBrowser.runtime.onMessage.trigger(
      { v: 1, type: 'banks.list', payload: {} },
      { id: browser.runtime.id },
      (r: unknown) => replies.push(r as Reply),
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(replies).toHaveLength(1);
  });

  it('a fast handler leaves no timer behind', async () => {
    vi.useFakeTimers();
    serveRpc(BackgroundRpc, { 'banks.list': async () => banks });
    await deliver('banks.list');
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects senders from other extensions and ignores foreign messages', async () => {
    const handler = vi.fn(async () => banks);
    serveRpc(BackgroundRpc, { 'banks.list': handler });
    const foreign = await deliver('banks.list', { id: 'someone-else' });
    expect(foreign).toMatchObject([{ ok: false, error: { code: 'forbidden' } }]);
    expect(await deliver('content.ping')).toEqual([]); // another map: not ours
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('callers do not wait forever', () => {
  it('gives up on a background that never answers with no_receiver', async () => {
    vi.useFakeTimers();
    vi.spyOn(browser.runtime, 'sendMessage').mockImplementation(never);
    const outcome = callBackground('banks.list', {}).then(
      () => null,
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(CALL_TIMEOUT_MS);
    const err = await outcome;
    expect(err).toBeInstanceOf(StudyVaultError);
    expect(err).toMatchObject({
      code: 'no_receiver',
      message: expect.stringContaining('banks.list'),
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives up on a tab that never answers, using the caller's own bound", async () => {
    vi.useFakeTimers();
    vi.spyOn(browser.tabs, 'sendMessage').mockImplementation(never);
    const outcome = callTab(7, 'content.pageStatus', {}, { timeoutMs: 2000 }).then(
      () => null,
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect(await outcome).toMatchObject({ code: 'no_receiver' });
  });

  it('is unaffected when the answer arrives in time, and leaves no timer behind', async () => {
    vi.useFakeTimers();
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({ ok: true, data: banks } as never);
    await expect(callBackground('banks.list', {})).resolves.toEqual(banks);
    expect(vi.getTimerCount()).toBe(0);
  });
});
