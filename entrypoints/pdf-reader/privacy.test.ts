// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { INCOGNITO_CAPTURE_REFUSAL } from '@shared';
import {
  UNKNOWN_WINDOW_REFUSAL,
  detectWindowPrivacy,
  onceWindowPrivacy,
  refusalFor,
  writePolicy,
  type PrivacyApi,
} from './privacy';

const answers = (incognito: boolean | undefined) => async () =>
  incognito === undefined ? undefined : { incognito };

describe('detectWindowPrivacy', () => {
  it('asks the tab, not the extension flag (which is false for a spanning extension)', async () => {
    const api: PrivacyApi = {
      extension: { inIncognitoContext: false },
      tabs: { getCurrent: answers(true) },
      windows: { getCurrent: answers(false) },
    };
    expect(await detectWindowPrivacy(false, api)).toBe('private');
    expect(await detectWindowPrivacy(false, { ...api, tabs: { getCurrent: answers(false) } })).toBe(
      'normal',
    );
  });

  it('falls back to the window when the page is not in a tab, and to "unknown" when nothing answers', async () => {
    expect(
      await detectWindowPrivacy(false, {
        tabs: { getCurrent: answers(undefined) },
        windows: { getCurrent: answers(true) },
      }),
    ).toBe('private');
    expect(
      await detectWindowPrivacy(false, {
        tabs: {
          getCurrent: async () => {
            throw new Error('no tab');
          },
        },
        windows: { getCurrent: answers(false) },
      }),
    ).toBe('normal');
    expect(await detectWindowPrivacy(false, {})).toBe('unknown');
    expect(
      await detectWindowPrivacy(false, {
        tabs: { getCurrent: answers(undefined) },
        windows: {
          getCurrent: async () => {
            throw new Error('unavailable');
          },
        },
      }),
    ).toBe('unknown');
  });

  it('any source that says "private" wins: a split-mode context, or the opener that built the address', async () => {
    const normal: PrivacyApi = {
      tabs: { getCurrent: answers(false) },
      windows: { getCurrent: answers(false) },
    };
    expect(await detectWindowPrivacy(true, normal)).toBe('private');
    expect(
      await detectWindowPrivacy(false, { ...normal, extension: { inIncognitoContext: true } }),
    ).toBe('private');
  });

  it('is asked once per page load', async () => {
    const getCurrent = vi.fn(answers(false));
    const ask = onceWindowPrivacy(false, { tabs: { getCurrent } });
    expect(await Promise.all([ask(), ask(), ask()])).toEqual(['normal', 'normal', 'normal']);
    expect(getCurrent).toHaveBeenCalledTimes(1);
  });
});

describe('what the reader may write', () => {
  it('a normal window writes; a private one does not and says why', () => {
    expect(writePolicy('normal', false)).toEqual({ persist: true, reason: null });
    expect(writePolicy('private', false)).toEqual({
      persist: false,
      reason: INCOGNITO_CAPTURE_REFUSAL,
    });
  });

  it('"Save from private windows" turns writing on in either case', () => {
    expect(writePolicy('private', true)).toEqual({ persist: true, reason: null });
    expect(writePolicy('unknown', true)).toEqual({ persist: true, reason: null });
  });

  it('a window that cannot be told is treated as private, with its own explanation', () => {
    expect(writePolicy('unknown', false)).toEqual({
      persist: false,
      reason: UNKNOWN_WINDOW_REFUSAL,
    });
    expect(UNKNOWN_WINDOW_REFUSAL).not.toBe(INCOGNITO_CAPTURE_REFUSAL);
    expect(UNKNOWN_WINDOW_REFUSAL).toMatch(/could not tell/);
  });

  it('while the window is still being checked nothing is written and nothing is announced', () => {
    expect(writePolicy(null, false)).toEqual({ persist: false, reason: null });
  });

  it('the storage restriction speaks with the same words', () => {
    expect(refusalFor('normal')).toBeNull();
    expect(refusalFor('private')).toBe(INCOGNITO_CAPTURE_REFUSAL);
    expect(refusalFor('unknown')).toBe(UNKNOWN_WINDOW_REFUSAL);
  });
});
