// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { BADGE_MAX, badgeView, isRaised, parseReminderFlag, reminderText } from './reminders';

const TITLE = 'StudyVault AI';

describe('reminder flag', () => {
  it('reads what the worker wrote and nothing else', () => {
    expect(parseReminderFlag({ at: 1, expiresAt: 2 })).toEqual({ at: 1, expiresAt: 2 });
    for (const bad of [null, undefined, 'x', 3, [], {}, { at: 1 }, { at: '1', expiresAt: 2 }]) {
      expect(parseReminderFlag(bad)).toBeNull();
    }
    expect(parseReminderFlag({ at: Number.NaN, expiresAt: 2 })).toBeNull();
  });

  it('counts until the study day it was raised in ends', () => {
    const flag = { at: 100, expiresAt: 200 };
    expect(isRaised(flag, 199)).toBe(true);
    expect(isRaised(flag, 200)).toBe(false);
    expect(isRaised(null, 0)).toBe(false);
  });
});

describe('badgeView', () => {
  it('speaks plainly, in the tooltip too', () => {
    expect(reminderText(1)).toBe('Time to review: 1 card due');
    expect(reminderText(14)).toBe('Time to review: 14 cards due');
    expect(badgeView({ count: 1, raised: false, defaultTitle: TITLE })).toEqual({
      text: '1',
      title: 'StudyVault AI: 1 card due',
      highlighted: false,
    });
    expect(badgeView({ count: 14, raised: true, defaultTitle: TITLE })).toEqual({
      text: '!',
      title: 'StudyVault AI: Time to review: 14 cards due',
      highlighted: true,
    });
  });

  it('is empty with nothing due, even when a notice is still stored', () => {
    for (const raised of [false, true]) {
      expect(badgeView({ count: 0, raised, defaultTitle: TITLE })).toEqual({
        text: '',
        title: TITLE,
        highlighted: false,
      });
    }
  });

  it('keeps the badge to four characters', () => {
    expect(badgeView({ count: BADGE_MAX, raised: false, defaultTitle: TITLE }).text).toBe('999');
    expect(badgeView({ count: BADGE_MAX + 1, raised: false, defaultTitle: TITLE }).text).toBe(
      '999+',
    );
  });
});
