import { beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { onboardingUrl, openOnboarding } from './open';
import {
  ONBOARDING_KEY,
  ONBOARDING_STEPS,
  defaultOnboardingState,
  getOnboardingState,
  hasOnboardingState,
  parseOnboardingState,
  updateOnboardingState,
  watchOnboardingState,
} from './onboardingState';
import { SETTINGS_SECTIONS, onboardingPath, optionsPath, settingsPath } from './paths';

beforeEach(() => fakeBrowser.reset());

describe('paths', () => {
  it('onboardingPath is the extension-relative page the worker opens', () => {
    expect(onboardingPath).toBe('onboarding.html');
    expect(optionsPath).toBe('options.html');
  });

  it('settingsPath deep-links known sections and nothing else', () => {
    expect(settingsPath()).toBe('options.html');
    expect(settingsPath('ai')).toBe('options.html#ai');
    expect(settingsPath('site-access')).toBe('options.html#site-access');
    expect(settingsPath('nope' as never)).toBe('options.html');
    expect(new Set(SETTINGS_SECTIONS.map((s) => s.id)).size).toBe(SETTINGS_SECTIONS.length);
  });
});

describe('onboarding state', () => {
  it('has a defined default: pending, at the welcome, blank preset', () => {
    expect(defaultOnboardingState()).toMatchObject({
      status: 'pending',
      step: 'welcome',
      preset: { id: 'blank', excluded: [] },
      applied: null,
    });
    expect(ONBOARDING_STEPS[0]).toBe('welcome');
    expect(ONBOARDING_STEPS.at(-1)).toBe('done');
  });

  it('parses field by field: one bad field falls back, the rest survive', () => {
    const parsed = parseOnboardingState({
      schemaVersion: 1,
      status: 'skipped',
      step: 'not-a-step',
      preset: { id: 'radiology', excluded: ['Diagnostic Radiology/MRI'] },
      applied: { nonsense: true },
      updatedAt: 42,
    });
    expect(parsed).toMatchObject({
      status: 'skipped',
      step: 'welcome',
      preset: { id: 'radiology', excluded: ['Diagnostic Radiology/MRI'] },
      applied: null,
      updatedAt: '',
    });
    expect(parseOnboardingState(null)).toEqual(defaultOnboardingState());
    expect(parseOnboardingState('x')).toEqual(defaultOnboardingState());
  });

  it('knows whether the tour was ever shown, round-trips and notifies other contexts', async () => {
    expect(await hasOnboardingState()).toBe(false);
    expect(await getOnboardingState()).toEqual(defaultOnboardingState());

    const seen: string[] = [];
    const stop = watchOnboardingState((s) => seen.push(s.status));
    const saved = await updateOnboardingState((s) => ({ ...s, status: 'completed', step: 'done' }));
    expect(saved).toMatchObject({ status: 'completed', step: 'done' });
    expect(saved.updatedAt).not.toBe('');
    expect(await hasOnboardingState()).toBe(true);
    expect(await getOnboardingState()).toEqual(saved);
    expect(seen).toContain('completed');
    stop();
    await updateOnboardingState((s) => ({ ...s, status: 'skipped' }));
    expect(seen.filter((s) => s === 'skipped')).toHaveLength(0); // unsubscribed
  });

  it('is stored under its own key, apart from the capture settings', async () => {
    await updateOnboardingState((s) => ({ ...s, step: 'banks' }));
    const all = await browser.storage.local.get(null);
    expect(Object.keys(all)).toEqual([ONBOARDING_KEY]);
  });
});

describe('openOnboarding', () => {
  it('brings an open tour tab to the front instead of making a second one', async () => {
    const create = vi.spyOn(browser.tabs, 'create').mockResolvedValue({} as never);
    const update = vi.spyOn(browser.tabs, 'update').mockResolvedValue({} as never);
    vi.spyOn(browser.windows, 'update').mockResolvedValue({} as never);
    vi.spyOn(browser.tabs, 'query').mockResolvedValue([{ id: 4, windowId: 2 }] as never);
    await openOnboarding();
    expect(update).toHaveBeenCalledWith(4, { active: true });
    expect(create).not.toHaveBeenCalled();
  });

  it('creates the tab when none is open', async () => {
    const create = vi.spyOn(browser.tabs, 'create').mockResolvedValue({} as never);
    vi.spyOn(browser.tabs, 'query').mockResolvedValue([] as never);
    await openOnboarding();
    expect(create).toHaveBeenCalledWith({ url: onboardingUrl() });
    expect(onboardingUrl()).toMatch(/\/onboarding\.html$/);
  });
});
