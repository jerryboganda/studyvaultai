// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { getSettings } from '@runtime';
import { registerE2eHooks } from './e2e';

const BASE = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/';

async function send(payload: unknown, sender: Record<string, unknown>) {
  const replies: Array<{ ok: boolean; error?: { code: string } }> = [];
  await fakeBrowser.runtime.onMessage.trigger(
    { v: 1, type: 'e2e.settings.patch', payload },
    { id: browser.runtime.id, ...sender },
    (r: unknown) => replies.push(r as never),
  );
  await new Promise((r) => setTimeout(r, 10));
  return replies[0];
}

beforeEach(() => {
  fakeBrowser.reset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the e2e settings hook', () => {
  it('is not registered unless the build is the e2e build', () => {
    registerE2eHooks(BASE);
    expect(browser.runtime.onMessage.hasListeners()).toBe(false);
    vi.stubGlobal('__SV_E2E__', false);
    registerE2eHooks(BASE);
    expect(browser.runtime.onMessage.hasListeners()).toBe(false);
  });

  it('changes settings through updateSettings for extension pages, nulls included', async () => {
    vi.stubGlobal('__SV_E2E__', true);
    registerE2eHooks(BASE);
    const reply = await send(
      { json: JSON.stringify({ denyList: ['bank.example'], lastBankId: null }) },
      { url: `${BASE}options.html` },
    );
    expect(reply).toMatchObject({ ok: true });
    const settings = await getSettings();
    expect(settings.denyList).toEqual(['bank.example']);
    expect(settings.lastBankId).toBeNull();
  });

  it('refuses a content script and a patch that is not an object', async () => {
    vi.stubGlobal('__SV_E2E__', true);
    registerE2eHooks(BASE);
    const before = await getSettings();
    const script = await send(
      { json: JSON.stringify({ denyList: [] }) },
      { url: 'https://evil.example/', tab: { id: 4 } },
    );
    expect(script).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    const bad = await send({ json: '[1]' }, { url: `${BASE}options.html` });
    expect(bad).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(await getSettings()).toEqual(before);
  });
});
