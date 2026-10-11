/** One prefix for everything StudyVault writes to the console, so it can be filtered in DevTools. */
export const LOG_PREFIX = '[StudyVault]';

export function logError(scope: string, ...details: unknown[]): void {
  console.error(`${LOG_PREFIX} ${scope}`, ...details);
}
