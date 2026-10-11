import '@shared/zodConfig';
import { z } from 'zod';

/**
 * Time helpers for the retention engine. Everything is a pure function of its arguments: the caller
 * injects `now` and the user's IANA time zone, nothing reads the system clock or locale.
 *
 * A "study day" is the user's local calendar day shifted by a rollover hour (Anki's "next day starts
 * at"). Day boundaries are resolved with Intl so DST transitions (23h / 25h days) are exact.
 */

export type DateInput = Date | string | number;

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

export function toMs(input: DateInput): number {
  const ms =
    input instanceof Date ? input.getTime() : typeof input === 'number' ? input : Date.parse(input);
  if (!Number.isFinite(ms)) throw new RangeError(`Invalid date: ${String(input)}`);
  return ms;
}

export const toIso = (ms: number): string => new Date(ms).toISOString();

// ---------------------------------------------------------------------------------------------
// Time zones
// ---------------------------------------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** Offset (local wall clock minus UTC) at an instant, straight from Intl. Slow: use tzOffsetMs. */
function rawOffsetMs(ms: number, timeZone: string): number {
  let y = 0;
  let mo = 1;
  let d = 1;
  let h = 0;
  let mi = 0;
  let s = 0;
  for (const p of formatter(timeZone).formatToParts(ms)) {
    if (p.type === 'year') y = Number(p.value);
    else if (p.type === 'month') mo = Number(p.value);
    else if (p.type === 'day') d = Number(p.value);
    else if (p.type === 'hour') h = Number(p.value) % 24;
    else if (p.type === 'minute') mi = Number(p.value);
    else if (p.type === 'second') s = Number(p.value);
  }
  return Date.UTC(y, mo - 1, d, h, mi, s) - Math.floor(ms / 1000) * 1000;
}

interface DayOffsets {
  /** First instant of the UTC day at which the offset changes, or null when it does not. */
  transitionMs: number | null;
  before: number;
  after: number;
}

const offsetCaches = new Map<string, Map<number, DayOffsets>>();
const MAX_CACHED_DAYS = 20_000;

/**
 * Local-minus-UTC offset in ms at an instant. Memoised per UTC day: a day costs two Intl calls, and
 * one binary search when a DST transition falls inside it (a zone changes offset at most once a day).
 */
export function tzOffsetMs(ms: number, timeZone: string): number {
  if (timeZone === 'UTC') return 0;
  let cache = offsetCaches.get(timeZone);
  if (!cache || cache.size > MAX_CACHED_DAYS) {
    cache = new Map();
    offsetCaches.set(timeZone, cache);
  }
  const day = Math.floor(ms / DAY_MS);
  let entry = cache.get(day);
  if (!entry) {
    const start = day * DAY_MS;
    const end = start + DAY_MS - 1;
    const before = rawOffsetMs(start, timeZone);
    const after = rawOffsetMs(end, timeZone);
    if (before === after) {
      entry = { transitionMs: null, before, after };
    } else {
      let lo = start; // offset(lo) === before
      let hi = end; // offset(hi) === after
      while (hi - lo > 1) {
        const mid = lo + Math.floor((hi - lo) / 2);
        if (rawOffsetMs(mid, timeZone) === before) lo = mid;
        else hi = mid;
      }
      entry = { transitionMs: hi, before, after };
    }
    cache.set(day, entry);
  }
  return entry.transitionMs === null || ms < entry.transitionMs ? entry.before : entry.after;
}

// ---------------------------------------------------------------------------------------------
// Study days
// ---------------------------------------------------------------------------------------------

/** Where the user's study day starts: IANA zone plus the hour (0-23, local) at which it rolls over. */
export const DayBoundary = z.object({
  timeZone: z.string().min(1).max(64).refine(isValidTimeZone, 'unknown IANA time zone'),
  rolloverHour: z.number().int().min(0).max(23),
});
export type DayBoundary = z.infer<typeof DayBoundary>;

/** Anki's default: late-night study counts towards the previous day. */
export const DEFAULT_ROLLOVER_HOUR = 4;

/** UTC calendar days: what ts-fsrs itself assumes. */
export const UTC_BOUNDARY: DayBoundary = { timeZone: 'UTC', rolloverHour: 0 };

/** Integer index of the study day containing an instant (days since 1970-01-01, in the user's frame). */
export function studyDayNumber(ms: number, boundary: DayBoundary): number {
  return Math.floor(
    (ms + tzOffsetMs(ms, boundary.timeZone) - boundary.rolloverHour * HOUR_MS) / DAY_MS,
  );
}

/**
 * First instant of a study day. DST-safe: an ambiguous local time (clocks go back) resolves to its
 * first occurrence; a non-existent one (clocks go forward) resolves to the instant the gap ends.
 */
export function studyDayStartMs(dayNumber: number, boundary: DayBoundary): number {
  return wallClockToMs(dayNumber * DAY_MS + boundary.rolloverHour * HOUR_MS, boundary.timeZone);
}

/**
 * The instant at which the wall clock of `tz` reads `wall` (a local date and time written as if it
 * were UTC milliseconds). DST-safe the way `studyDayStartMs` is: the first of two occurrences, and
 * the instant the gap ends when the local time does not exist.
 */
export function wallClockToMs(wall: number, tz: string): number {
  const t1 = wall - tzOffsetMs(wall - DAY_MS, tz);
  const t2 = wall - tzOffsetMs(wall + DAY_MS, tz);
  const valid = [t1, t2].filter((t) => t + tzOffsetMs(t, tz) === wall);
  if (valid.length > 0) return Math.min(...valid);
  // The local time does not exist: first instant whose local time is at or after it.
  let lo = Math.min(t1, t2);
  let hi = Math.max(t1, t2);
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (mid + tzOffsetMs(mid, tz) >= wall) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** Local calendar date (YYYY-MM-DD) that labels a study day. */
export const studyDayKey = (dayNumber: number): string =>
  new Date(dayNumber * DAY_MS).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------------------------
// Daily reminder time
// ---------------------------------------------------------------------------------------------

/** "HH:MM", 24-hour and zero-padded: what an `<input type="time">` produces. */
export const TIME_OF_DAY = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * The first instant strictly after `now` at which the wall clock of `timeZone` reads `timeOfDay`.
 * DST follows `wallClockToMs`: a time that does not exist that day (clocks go forward) is the
 * instant the gap ends, and a time that happens twice (clocks go back) is its first occurrence, so
 * a daily reminder fires exactly once per calendar day.
 */
export function nextReminderAt(now: DateInput, timeZone: string, timeOfDay: string): number {
  const parts = TIME_OF_DAY.exec(timeOfDay);
  if (!parts) throw new RangeError(`Invalid time of day: ${timeOfDay}`);
  if (!isValidTimeZone(timeZone)) throw new RangeError(`Invalid time zone: ${timeZone}`);
  const ms = toMs(now);
  const sinceMidnight = Number(parts[1]) * HOUR_MS + Number(parts[2]) * MINUTE_MS;
  const today = Math.floor((ms + tzOffsetMs(ms, timeZone)) / DAY_MS);
  // Today's occurrence may have passed; a calendar day is at most 25 hours, so tomorrow's cannot.
  for (let day = today; day <= today + 2; day++) {
    const at = wallClockToMs(day * DAY_MS + sinceMidnight, timeZone);
    if (at > ms) return at;
  }
  throw new RangeError(`No occurrence of ${timeOfDay} found in ${timeZone}`);
}

// ---------------------------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------------------------

/** Compact interval label for review buttons: "<1m", "10m", "3h", "4d", "2.5mo", "1.2y". */
export function formatInterval(ms: number): string {
  const minutes = Math.round(Math.max(0, ms) / MINUTE_MS);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d`;
  const one = (n: number) => String(Math.round(n * 10) / 10);
  const months = ms / DAY_MS / 30.4375;
  return months < 12 ? `${one(months)}mo` : `${one(ms / DAY_MS / 365.25)}y`;
}
