// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { TIME_OF_DAY } from '@study';
import { Settings, defaultSettings, parseSettings } from './settings';

describe('Settings.reminders (docs/adr/019-reminders.md)', () => {
  it('is off by default: no count on the icon, no daily time', () => {
    expect(defaultSettings().reminders).toEqual({ on: false, dailyAt: null });
    expect(Settings.safeParse(defaultSettings()).success).toBe(true);
  });

  it('settings stored by a build without reminders keep every choice and get the default', () => {
    const before = defaultSettings() as Partial<Settings>;
    delete before.reminders;
    const stored = {
      ...before,
      theme: 'dark',
      denyList: ['example.org'],
      features: { review: false, pdfReader: true, ai: true, sync: false },
    };
    const parsed = parseSettings(JSON.parse(JSON.stringify(stored)));
    expect(parsed.reminders).toEqual({ on: false, dailyAt: null });
    expect(parsed.theme).toBe('dark');
    expect(parsed.denyList).toEqual(['example.org']);
    expect(parsed.features).toEqual({ review: false, pdfReader: true, ai: true, sync: false });
  });

  it('round-trips a choice', () => {
    const stored = { ...defaultSettings(), reminders: { on: true, dailyAt: '07:30' } };
    expect(parseSettings(JSON.parse(JSON.stringify(stored))).reminders).toEqual({
      on: true,
      dailyAt: '07:30',
    });
  });

  it('a damaged field falls back by itself: a bad time does not switch the count off, nor the reverse', () => {
    const base = defaultSettings();
    const parse = (reminders: unknown) => parseSettings({ ...base, reminders }).reminders;
    expect(parse({ on: true, dailyAt: '25:00' })).toEqual({ on: true, dailyAt: null });
    expect(parse({ on: true, dailyAt: '7:30' })).toEqual({ on: true, dailyAt: null });
    expect(parse({ on: 'yes', dailyAt: '18:00' })).toEqual({ on: false, dailyAt: '18:00' });
    expect(parse({ on: true })).toEqual({ on: true, dailyAt: null });
    expect(parse(null)).toEqual({ on: false, dailyAt: null });
    expect(parse('on')).toEqual({ on: false, dailyAt: null });
    expect(parse([])).toEqual({ on: false, dailyAt: null });
  });

  it('accepts exactly the times the study engine can schedule', () => {
    const times = ['00:00', '09:05', '12:30', '23:59', '24:00', '7:30', '07:60', '', 'ab:cd'];
    for (const t of times) {
      const ok = Settings.shape.reminders.shape.dailyAt.safeParse(t).success;
      expect(ok, t).toBe(TIME_OF_DAY.test(t));
    }
  });
});

describe('Settings.useFilingRules (docs/adr/017-filing-rules.md)', () => {
  it('is on by default (with no rule nothing is filed)', () => {
    expect(defaultSettings().useFilingRules).toBe(true);
    expect(Settings.safeParse(defaultSettings()).success).toBe(true);
  });

  it('settings stored before the field existed get the default and keep every choice', () => {
    const before = defaultSettings() as Partial<Settings>;
    delete before.useFilingRules;
    const parsed = parseSettings(JSON.parse(JSON.stringify({ ...before, theme: 'dark' })));
    expect(parsed.useFilingRules).toBe(true);
    expect(parsed.theme).toBe('dark');
  });

  it('keeps an explicit off, and a damaged value falls back to the default', () => {
    const base = defaultSettings();
    expect(parseSettings({ ...base, useFilingRules: false }).useFilingRules).toBe(false);
    expect(parseSettings({ ...base, useFilingRules: 'no' }).useFilingRules).toBe(true);
  });
});
