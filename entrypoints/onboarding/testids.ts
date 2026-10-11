/** `data-testid` hooks of the welcome tour (one list for unit tests and E2E specs). */
export const TID = {
  root: 'ob-root',
  skip: 'ob-skip',
  back: 'ob-back',
  next: 'ob-next',
  progress: 'ob-progress',
  step: (id: string) => `ob-step-${id}`,
  // privacy
  privateWindows: 'ob-private-windows',
  paintHighlights: 'ob-paint-highlights',
  aiStatus: 'ob-ai-status',
  syncStatus: 'ob-sync-status',
  // banks
  preset: (id: string) => `ob-preset-${id}`,
  node: (key: string) => `ob-node-${key}`,
  create: 'ob-create',
  applied: 'ob-applied',
  plan: 'ob-plan',
  // look
  theme: (id: string) => `ob-theme-${id}`,
  density: (id: string) => `ob-density-${id}`,
  // keys
  shortcuts: 'ob-shortcuts',
  // done
  openPanel: 'ob-open-panel',
  finish: 'ob-finish',
  finished: 'ob-finished',
  skipped: 'ob-skipped',
  summary: 'ob-summary',
} as const;
