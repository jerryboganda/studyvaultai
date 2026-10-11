// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  DAY_MS,
  DayBoundary,
  formatInterval,
  isValidTimeZone,
  studyDayKey,
  studyDayNumber,
  studyDayStartMs,
  toMs,
  tzOffsetMs,
} from './time';

const LA = 'America/Los_Angeles';
const KOLKATA = 'Asia/Kolkata';
const AUCKLAND = 'Pacific/Auckland';
const HOUR = 3_600_000;
const z = (iso: string): number => Date.parse(iso);
const dayOf = (y: number, m: number, d: number): number => Date.UTC(y, m - 1, d) / DAY_MS;
const b = (timeZone: string, rolloverHour = 0): DayBoundary => ({ timeZone, rolloverHour });

describe('tzOffsetMs', () => {
  it('matches the known offsets of the three reference zones', () => {
    expect(tzOffsetMs(z('2026-01-15T12:00:00Z'), LA)).toBe(-8 * HOUR);
    expect(tzOffsetMs(z('2026-07-15T12:00:00Z'), LA)).toBe(-7 * HOUR);
    expect(tzOffsetMs(z('2026-01-15T12:00:00Z'), KOLKATA)).toBe(5.5 * HOUR);
    expect(tzOffsetMs(z('2026-07-15T12:00:00Z'), KOLKATA)).toBe(5.5 * HOUR);
    expect(tzOffsetMs(z('2026-01-15T12:00:00Z'), AUCKLAND)).toBe(13 * HOUR);
    expect(tzOffsetMs(z('2026-07-15T12:00:00Z'), AUCKLAND)).toBe(12 * HOUR);
  });

  it('switches exactly at the transition instant (to the millisecond)', () => {
    const t = z('2026-03-08T10:00:00Z'); // 02:00 PST -> 03:00 PDT
    expect(tzOffsetMs(t - 1, LA)).toBe(-8 * HOUR);
    expect(tzOffsetMs(t, LA)).toBe(-7 * HOUR);
    const fall = z('2026-11-01T09:00:00Z'); // 02:00 PDT -> 01:00 PST
    expect(tzOffsetMs(fall - 1, LA)).toBe(-7 * HOUR);
    expect(tzOffsetMs(fall, LA)).toBe(-8 * HOUR);
  });

  it('is stable when asked repeatedly and out of order (cache correctness)', () => {
    const probes = [
      z('2026-11-01T09:00:00Z'),
      z('2026-03-08T09:59:59.999Z'),
      z('2026-11-01T08:59:59.999Z'),
      z('2026-03-08T10:00:00Z'),
    ];
    const first = probes.map((p) => tzOffsetMs(p, LA));
    expect(probes.map((p) => tzOffsetMs(p, LA))).toEqual(first);
    expect(first).toEqual([-8 * HOUR, -8 * HOUR, -7 * HOUR, -7 * HOUR]);
  });

  it('validates time zones', () => {
    expect(isValidTimeZone(LA)).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(DayBoundary.safeParse({ timeZone: 'Mars/Olympus', rolloverHour: 4 }).success).toBe(
      false,
    );
    expect(DayBoundary.safeParse({ timeZone: LA, rolloverHour: 24 }).success).toBe(false);
    expect(DayBoundary.safeParse({ timeZone: LA, rolloverHour: 4 }).success).toBe(true);
  });
});

describe('study day boundaries', () => {
  it('Los Angeles: the spring-forward day is 23 hours, the fall-back day 25', () => {
    const start = studyDayStartMs(dayOf(2026, 3, 8), b(LA));
    const next = studyDayStartMs(dayOf(2026, 3, 9), b(LA));
    expect(new Date(start).toISOString()).toBe('2026-03-08T08:00:00.000Z');
    expect(new Date(next).toISOString()).toBe('2026-03-09T07:00:00.000Z');
    expect((next - start) / HOUR).toBe(23);

    const fStart = studyDayStartMs(dayOf(2026, 11, 1), b(LA));
    const fNext = studyDayStartMs(dayOf(2026, 11, 2), b(LA));
    expect(new Date(fStart).toISOString()).toBe('2026-11-01T07:00:00.000Z');
    expect(new Date(fNext).toISOString()).toBe('2026-11-02T08:00:00.000Z');
    expect((fNext - fStart) / HOUR).toBe(25);
  });

  it('Kolkata: a half-hour offset, no DST, always 24 hours', () => {
    const start = studyDayStartMs(dayOf(2026, 6, 1), b(KOLKATA));
    expect(new Date(start).toISOString()).toBe('2026-05-31T18:30:00.000Z');
    expect(studyDayStartMs(dayOf(2026, 6, 2), b(KOLKATA)) - start).toBe(DAY_MS);
    // 23:59 local on Jun 1 and 00:00 local on Jun 2
    expect(studyDayNumber(z('2026-06-01T18:29:59.999Z'), b(KOLKATA))).toBe(dayOf(2026, 6, 1));
    expect(studyDayNumber(z('2026-06-01T18:30:00.000Z'), b(KOLKATA))).toBe(dayOf(2026, 6, 2));
  });

  it('Auckland: 23-hour and 25-hour days at both transitions, and the date is ahead of UTC', () => {
    const s1 = studyDayStartMs(dayOf(2026, 9, 27), b(AUCKLAND));
    const s2 = studyDayStartMs(dayOf(2026, 9, 28), b(AUCKLAND));
    expect(new Date(s1).toISOString()).toBe('2026-09-26T12:00:00.000Z');
    expect((s2 - s1) / HOUR).toBe(23);

    const e1 = studyDayStartMs(dayOf(2027, 4, 4), b(AUCKLAND));
    const e2 = studyDayStartMs(dayOf(2027, 4, 5), b(AUCKLAND));
    expect(new Date(e1).toISOString()).toBe('2027-04-03T11:00:00.000Z');
    expect((e2 - e1) / HOUR).toBe(25);

    // 2026-06-30T20:00Z is already July 1 in Auckland
    expect(studyDayKey(studyDayNumber(z('2026-06-30T20:00:00Z'), b(AUCKLAND)))).toBe('2026-07-01');
  });

  it('start and number are inverse: the start belongs to its day, one ms earlier to the previous', () => {
    const zones = [LA, KOLKATA, AUCKLAND, 'UTC', 'Europe/London', 'Australia/Lord_Howe'];
    for (const tz of zones) {
      for (const rollover of [0, 1, 2, 3, 4, 12, 23]) {
        for (const probe of [
          '2026-03-07',
          '2026-03-08',
          '2026-03-29',
          '2026-09-27',
          '2026-10-04',
          '2026-11-01',
          '2027-04-04',
        ]) {
          const day = studyDayNumber(z(`${probe}T12:00:00Z`), b(tz, rollover));
          const start = studyDayStartMs(day, b(tz, rollover));
          expect(studyDayNumber(start, b(tz, rollover))).toBe(day);
          expect(studyDayNumber(start - 1, b(tz, rollover))).toBe(day - 1);
        }
      }
    }
  });

  it('rollover hour: 3am still belongs to the previous study day, 4am starts the new one', () => {
    const boundary = b(LA, 4);
    const before = studyDayNumber(z('2026-01-10T11:00:00Z'), boundary); // 03:00 PST Jan 10
    const after = studyDayNumber(z('2026-01-10T12:00:00Z'), boundary); // 04:00 PST Jan 10
    expect(before).toBe(dayOf(2026, 1, 9));
    expect(after).toBe(dayOf(2026, 1, 10));
    expect(new Date(studyDayStartMs(after, boundary)).toISOString()).toBe(
      '2026-01-10T12:00:00.000Z',
    );
  });

  it('a rollover hour inside the spring-forward gap starts the day when the gap ends', () => {
    // 02:30 does not exist on 2026-03-08 in LA; 02:00 is the gap itself.
    const start = studyDayStartMs(dayOf(2026, 3, 8), b(LA, 2));
    expect(new Date(start).toISOString()).toBe('2026-03-08T10:00:00.000Z');
    expect(studyDayNumber(start - 1, b(LA, 2))).toBe(dayOf(2026, 3, 7));
  });

  it('a rollover hour inside the fall-back hour resolves to its first occurrence', () => {
    const start = studyDayStartMs(dayOf(2026, 11, 1), b(LA, 1));
    expect(new Date(start).toISOString()).toBe('2026-11-01T08:00:00.000Z'); // 01:00 PDT, not 01:00 PST (09:00Z)
    // The repeated hour does not flip the day back.
    expect(studyDayNumber(z('2026-11-01T09:30:00Z'), b(LA, 1))).toBe(dayOf(2026, 11, 1));
  });
});

describe('toMs and labels', () => {
  it('accepts Date, ISO string and number, and rejects garbage', () => {
    const ms = z('2026-01-05T09:00:00Z');
    expect(toMs(new Date(ms))).toBe(ms);
    expect(toMs('2026-01-05T09:00:00Z')).toBe(ms);
    expect(toMs(ms)).toBe(ms);
    expect(() => toMs('not a date')).toThrow(RangeError);
    expect(() => toMs(Number.NaN)).toThrow(RangeError);
  });

  it('formats intervals compactly', () => {
    expect(formatInterval(10_000)).toBe('<1m');
    expect(formatInterval(10 * 60_000)).toBe('10m');
    expect(formatInterval(59.6 * 60_000)).toBe('1h');
    expect(formatInterval(5 * HOUR)).toBe('5h');
    expect(formatInterval(3 * DAY_MS)).toBe('3d');
    expect(formatInterval(45 * DAY_MS)).toBe('1.5mo');
    expect(formatInterval(400 * DAY_MS)).toBe('1.1y');
    expect(formatInterval(-5)).toBe('<1m');
  });
});
