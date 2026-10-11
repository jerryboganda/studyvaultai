// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DAY_MS, HOUR_MS, TIME_OF_DAY, nextReminderAt, tzOffsetMs } from './time';

const LA = 'America/Los_Angeles';
const BERLIN = 'Europe/Berlin';
const KOLKATA = 'Asia/Kolkata';
const AUCKLAND = 'Pacific/Auckland';
const z = (iso: string): number => Date.parse(iso);
const iso = (ms: number): string => new Date(ms).toISOString();

describe('nextReminderAt', () => {
  it('is the next occurrence of the wall-clock time in the zone', () => {
    // 04:00 PST: 18:00 is later today (02:00Z tomorrow); 03:00 has passed, so it is tomorrow's.
    expect(iso(nextReminderAt(z('2026-01-15T12:00:00Z'), LA, '18:00'))).toBe(
      '2026-01-16T02:00:00.000Z',
    );
    expect(iso(nextReminderAt(z('2026-01-15T12:00:00Z'), LA, '03:00'))).toBe(
      '2026-01-16T11:00:00.000Z',
    );
    // A half-hour zone: 17:30 IST now, so 09:00 is tomorrow morning (03:30Z).
    expect(iso(nextReminderAt(z('2026-01-15T12:00:00Z'), KOLKATA, '09:00'))).toBe(
      '2026-01-16T03:30:00.000Z',
    );
    expect(iso(nextReminderAt(z('2026-01-15T12:00:00Z'), 'UTC', '12:01'))).toBe(
      '2026-01-15T12:01:00.000Z',
    );
  });

  it('is strictly after now: the very instant of the reminder asks for the next day', () => {
    const at = z('2026-01-16T02:00:00Z'); // 18:00 PST
    expect(iso(nextReminderAt(at - 1, LA, '18:00'))).toBe('2026-01-16T02:00:00.000Z');
    expect(iso(nextReminderAt(at, LA, '18:00'))).toBe('2026-01-17T02:00:00.000Z');
  });

  it('takes a Date, an ISO string or a number', () => {
    const expected = z('2026-06-01T08:00:00Z');
    expect(nextReminderAt(new Date('2026-06-01T07:00:00Z'), 'UTC', '08:00')).toBe(expected);
    expect(nextReminderAt('2026-06-01T07:00:00Z', 'UTC', '08:00')).toBe(expected);
    expect(nextReminderAt(z('2026-06-01T07:00:00Z'), 'UTC', '08:00')).toBe(expected);
  });

  describe('daylight saving time', () => {
    it('Los Angeles, clocks go forward: a time inside the gap is the instant the gap ends', () => {
      // 2026-03-08 02:00 PST -> 03:00 PDT at 10:00Z. 02:30 does not exist that day.
      expect(iso(nextReminderAt(z('2026-03-07T12:00:00Z'), LA, '02:30'))).toBe(
        '2026-03-08T10:00:00.000Z',
      );
      expect(iso(nextReminderAt(z('2026-03-08T08:00:00Z'), LA, '02:30'))).toBe(
        '2026-03-08T10:00:00.000Z',
      );
      // Once the gap has passed, the next one is the day after, at the wall-clock time again.
      expect(iso(nextReminderAt(z('2026-03-08T10:30:00Z'), LA, '02:30'))).toBe(
        '2026-03-09T09:30:00.000Z',
      );
    });

    it('Los Angeles, clocks go back: a repeated time fires at its first occurrence only', () => {
      // 2026-11-01 02:00 PDT -> 01:00 PST at 09:00Z. 01:30 is 08:30Z (PDT) and again 09:30Z (PST).
      expect(iso(nextReminderAt(z('2026-11-01T07:00:00Z'), LA, '01:30'))).toBe(
        '2026-11-01T08:30:00.000Z',
      );
      // Between the two: the second 01:30 is not a second reminder, tomorrow's is next.
      expect(iso(nextReminderAt(z('2026-11-01T08:45:00Z'), LA, '01:30'))).toBe(
        '2026-11-02T09:30:00.000Z',
      );
    });

    it('Berlin, both transitions', () => {
      // 2026-03-29 02:00 CET -> 03:00 CEST at 01:00Z.
      expect(iso(nextReminderAt(z('2026-03-28T20:00:00Z'), BERLIN, '02:30'))).toBe(
        '2026-03-29T01:00:00.000Z',
      );
      // 2026-10-25 03:00 CEST -> 02:00 CET at 01:00Z. 02:30 is 00:30Z (CEST) and 01:30Z (CET).
      expect(iso(nextReminderAt(z('2026-10-24T20:00:00Z'), BERLIN, '02:30'))).toBe(
        '2026-10-25T00:30:00.000Z',
      );
      expect(iso(nextReminderAt(z('2026-10-25T00:45:00Z'), BERLIN, '02:30'))).toBe(
        '2026-10-26T01:30:00.000Z',
      );
    });

    it('Auckland: ahead of UTC, the spring-forward gap resolves too', () => {
      // 2026-09-27 02:00 NZST -> 03:00 NZDT at 2026-09-26T14:00Z.
      expect(iso(nextReminderAt(z('2026-09-26T00:00:00Z'), AUCKLAND, '02:30'))).toBe(
        '2026-09-26T14:00:00.000Z',
      );
      // The same wall-clock time the day before is 02:30 NZST = 14:30Z the day before.
      expect(iso(nextReminderAt(z('2026-09-25T00:00:00Z'), AUCKLAND, '02:30'))).toBe(
        '2026-09-25T14:30:00.000Z',
      );
    });

    it.each([
      ['12:00', LA],
      ['02:30', LA],
      ['01:30', LA],
      ['02:30', BERLIN],
      ['03:00', AUCKLAND],
      ['09:15', KOLKATA],
    ])(
      '%s in %s: exactly one reminder per calendar day for 400 days, at the wall-clock time',
      (time, zone) => {
        const [h, m] = time.split(':').map(Number) as [number, number];
        const wallOf = (ms: number) => ms + tzOffsetMs(ms, zone);
        let t = z('2026-01-01T00:00:00Z');
        let lastDate: number | null = null;
        for (let i = 0; i < 400; i++) {
          const next = nextReminderAt(t, zone, time);
          expect(next).toBeGreaterThan(t);
          const wall = wallOf(next);
          const date = Math.floor(wall / DAY_MS);
          if (lastDate !== null) expect(date).toBe(lastDate + 1); // never twice, never skipped
          lastDate = date;
          // The wall-clock time is the asked one, except on a day it does not exist (the gap's end).
          const minutes = Math.round((wall - date * DAY_MS) / 60_000);
          const asked = h * 60 + m;
          if (minutes !== asked) expect(minutes).toBeGreaterThan(asked);
          expect(minutes - asked).toBeLessThanOrEqual(60);
          if (i > 0) expect(next - t).toBeLessThanOrEqual(25 * HOUR_MS);
          t = next;
        }
      },
    );
  });

  it('refuses a time of day or a zone it cannot read', () => {
    const now = z('2026-01-15T12:00:00Z');
    for (const bad of ['24:00', '7:30', '07:60', '', '0730', '07:30:00', 'ab:cd']) {
      expect(() => nextReminderAt(now, 'UTC', bad), bad).toThrow(RangeError);
    }
    expect(() => nextReminderAt(now, 'Mars/Olympus', '08:00')).toThrow(RangeError);
    expect(() => nextReminderAt('not a date', 'UTC', '08:00')).toThrow(RangeError);
  });

  it('exports the pattern the settings schema and the time input share', () => {
    expect(TIME_OF_DAY.test('00:00')).toBe(true);
    expect(TIME_OF_DAY.test('23:59')).toBe(true);
    expect(TIME_OF_DAY.test('24:00')).toBe(false);
    expect(TIME_OF_DAY.test('9:00')).toBe(false);
  });
});
