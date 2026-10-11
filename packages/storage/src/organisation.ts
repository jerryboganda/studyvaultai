import type { z } from 'zod';
import { stableStringify } from '@sync';
import { Id, StudyVaultError } from '@shared';

/**
 * Helpers shared by the three organisation repositories (rules.ts, syllabi.ts, relations.ts; schema
 * v4, ADR-011). Nothing here is part of the public API except the `SaveOutcome` type.
 */

/**
 * Result of an edit that was given `expectedVersion` (the `updatedAt` the editor read). `stale`
 * means the row changed since: nothing was written and `row` is what is stored now, for the editor
 * to show and let the person decide (the same shape as `reviewCard`'s "stale" outcome).
 */
export type SaveOutcome<T> = { status: 'saved'; row: T } | { status: 'stale'; row: T };

/**
 * An `updatedAt` strictly after `previous`, so that `updatedAt` is a usable version of the row even
 * when two writes land in the same millisecond.
 */
export function nextStamp(previous: string, now: string): string {
  const before = Date.parse(previous);
  return Date.parse(now) > before ? now : new Date(before + 1).toISOString();
}

/** A copy without `undefined` members (sync and backup carry plain JSON, which has none). */
export function withoutUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => withoutUndefined(item)) as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value)) {
      if (member !== undefined) out[key] = withoutUndefined(member);
    }
    return out as T;
  }
  return value;
}

/** `schema.parse` with a message a person can read (Zod's own is a JSON dump). */
export function parseStrict<S extends z.ZodType>(
  schema: S,
  value: unknown,
  what: string,
): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return withoutUndefined(result.data);
  const detail = result.error.issues
    .map((issue) =>
      issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
    )
    .join('; ');
  throw new StudyVaultError('invalid_request', `Invalid ${what}: ${detail}`);
}

export const invalid = (message: string): StudyVaultError =>
  new StudyVaultError('invalid_request', message);

/** Reject ids that are not ids, then drop repeats. */
export function cleanIds(ids: readonly string[] | undefined, what: string): string[] {
  if (ids !== undefined && !Array.isArray(ids)) throw invalid(`Invalid ${what}s: expected a list.`);
  const out: string[] = [];
  for (const id of ids ?? []) {
    if (!Id.safeParse(id).success) {
      throw invalid(`Invalid ${what}: "${String(id)}" is not an id.`);
    }
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** Whether two plain-JSON rows say the same thing (key order does not matter). */
export const sameRow = (a: unknown, b: unknown): boolean =>
  stableStringify(withoutUndefined(a) as never) === stableStringify(withoutUndefined(b) as never);
