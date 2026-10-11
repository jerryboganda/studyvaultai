import { StudyVaultError } from '@shared';

/**
 * Whether doing the same thing again can help. `storage_unavailable` is not a passing glitch: it
 * also means "data saved by a newer version" or "the Inbox cannot be read", which a blind retry
 * only repeats. Such errors show their message and no Retry button.
 */
export function isRetryable(err: unknown): boolean {
  return !(err instanceof StudyVaultError && err.code === 'storage_unavailable');
}

export function errorMessage(err: unknown, fallback = 'Something went wrong.'): string {
  return err instanceof Error && err.message.trim() ? err.message : fallback;
}

/** Cut to `max` UTF-16 units without splitting a surrogate pair. Display only; never stored. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end).trimEnd()}…`;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
