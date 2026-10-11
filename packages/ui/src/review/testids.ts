/**
 * `data-testid` hooks of the review surfaces. One list, so unit tests, E2E specs and the integrator
 * use the same names. Dynamic ids end in the entity id (`rv-deck-<deckId>`); use the helpers.
 */
export const TID = {
  // review page shell
  page: 'rv-page',
  nav: 'rv-nav',
  navStudy: 'rv-nav-study',
  navCreate: 'rv-nav-create',
  navCards: 'rv-nav-cards',
  navAnalytics: 'rv-nav-analytics',
  navSettings: 'rv-nav-settings',
  loadError: 'rv-load-error',

  // deck picker
  deckPicker: 'rv-deck-picker',
  deckEmpty: 'rv-deck-empty',
  deckStartAll: 'rv-start-all',
  deckContinue: 'rv-continue',
  deckDiscard: 'rv-discard-session',
  dueTotal: 'rv-due-total',
  dueNew: 'rv-due-new',
  dueLearning: 'rv-due-learning',
  dueReview: 'rv-due-review',
  deferredNote: 'rv-deferred-note',
  nextLearning: 'rv-next-learning',

  // session
  session: 'rv-session',
  progress: 'rv-progress',
  progressText: 'rv-progress-text',
  card: 'rv-card',
  question: 'rv-question',
  answer: 'rv-answer',
  reveal: 'rv-reveal',
  unverified: 'rv-unverified',
  verify: 'rv-verify',
  choices: 'rv-choices',
  mcqResult: 'rv-mcq-result',
  mcqExplanation: 'rv-mcq-explanation',
  ratings: 'rv-ratings',
  undo: 'rv-undo',
  edit: 'rv-edit',
  suspend: 'rv-suspend',
  bury: 'rv-bury',
  source: 'rv-source',
  explain: 'rv-explain',
  explainPanel: 'rv-explain-panel',
  explainQuote: 'rv-explain-quote',
  explainNote: 'rv-explain-note',
  notice: 'rv-notice',
  waiting: 'rv-waiting',
  waitNow: 'rv-wait-now',
  leave: 'rv-leave',
  summary: 'rv-summary',
  summaryAnswered: 'rv-summary-answered',
  summaryNext: 'rv-summary-next',
  summaryAgain: 'rv-summary-again',

  // backlog recovery
  backlog: 'rv-backlog',
  backlogDays: 'rv-backlog-days',
  backlogPlan: 'rv-backlog-plan',
  backlogApply: 'rv-backlog-apply',
  backlogResult: 'rv-backlog-result',

  // authoring
  author: 'rv-author',
  picker: 'rv-picker',
  pickerSearch: 'rv-picker-search',
  pickerBank: 'rv-picker-bank',
  bulk: 'rv-bulk',
  bulkCreate: 'rv-bulk-create',
  manual: 'rv-manual',
  editor: 'rv-editor',
  tplBasic: 'rv-tpl-basic',
  tplCloze: 'rv-tpl-cloze',
  tplDefinition: 'rv-tpl-definition',
  tplCompare: 'rv-tpl-compare',
  tplMcq: 'rv-tpl-mcq',
  preview: 'rv-preview',
  previewIssues: 'rv-preview-issues',
  clozeText: 'rv-cloze-text',
  clozeWrap: 'rv-cloze-wrap',
  clozeIndex: 'rv-cloze-index',
  clozeHint: 'rv-cloze-hint',
  deckSelect: 'rv-deck-select',
  saveCards: 'rv-save-cards',
  kpEditor: 'rv-kp-editor',
  kpOneLiner: 'rv-kp-oneliner',
  kpPearl: 'rv-kp-pearl',
  kpMisconception: 'rv-kp-misconception',
  kpStatus: 'rv-kp-status',
  kpSave: 'rv-kp-save',
  kpAddClaim: 'rv-kp-add-claim',

  // card browser
  browser: 'rv-browser',
  browserFilter: 'rv-browser-filter',
  browserSearch: 'rv-browser-search',
  browserDeck: 'rv-browser-deck',
  newDeckName: 'rv-new-deck-name',
  newDeck: 'rv-new-deck',

  // deck settings and study day
  deckSettings: 'rv-deck-settings',
  deckSettingsSave: 'rv-deck-settings-save',
  deckSettingsReset: 'rv-deck-settings-reset',
  studyDay: 'rv-study-day',
  timeZone: 'rv-time-zone',
  rollover: 'rv-rollover',
  studyDaySave: 'rv-study-day-save',

  // analytics
  analytics: 'rv-analytics',
  analyticsEmpty: 'rv-analytics-empty',
  forecast: 'rv-forecast',
  forecastTable: 'rv-forecast-table',
  retention: 'rv-retention',
  retentionInsufficient: 'rv-retention-insufficient',
  studyLog: 'rv-study-log',
  streak: 'rv-streak',
  counts: 'rv-counts',
  backlogStats: 'rv-backlog-stats',

  // reusable pieces for the integrator
  tab: 'rv-tab',
  tabCount: 'rv-tab-count',
  tabStart: 'rv-tab-start',
  tabContinue: 'rv-tab-continue',
  tabOpen: 'rv-tab-open',
  tabCreate: 'rv-tab-create',
  tabEmpty: 'rv-tab-empty',
  settingsSection: 'rv-settings-section',
} as const;

export const deckRowId = (deckId: string) => `rv-deck-${deckId}`;
export const deckStartId = (deckId: string) => `rv-start-${deckId}`;
export const deckSettingsId = (deckId: string) => `rv-deck-settings-${deckId}`;
export const ratingId = (rating: 1 | 2 | 3 | 4) => `rv-rate-${rating}`;
export const choiceId = (index: number) => `rv-choice-${index}`;
export const blankId = (index: number) => `rv-blank-${index}`;
export const pickerItemId = (highlightId: string) => `rv-pick-${highlightId}`;
export const cardRowId = (cardId: string) => `rv-card-${cardId}`;
export const bankRowId = (bankId: string | null) => `rv-bank-${bankId ?? 'none'}`;
