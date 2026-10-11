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
  keysToggle: 'rv-keys-toggle',
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

  // exam simulation
  examSetup: 'rv-exam-setup',
  examScope: 'rv-exam-scope',
  examQuestions: 'rv-exam-questions',
  examTimed: 'rv-exam-timed',
  examMinutes: 'rv-exam-minutes',
  examShuffle: 'rv-exam-shuffle',
  examStart: 'rv-exam-start',
  examContinue: 'rv-exam-continue',
  examDiscard: 'rv-exam-discard',
  examRun: 'rv-exam-run',
  examTimer: 'rv-exam-timer',
  examAnnounce: 'rv-exam-announce',
  examProgress: 'rv-exam-progress',
  examQuestion: 'rv-exam-question',
  examChoices: 'rv-exam-choices',
  examText: 'rv-exam-text',
  examPrev: 'rv-exam-prev',
  examNext: 'rv-exam-next',
  examFinish: 'rv-exam-finish',
  examLeave: 'rv-exam-leave',
  examMarking: 'rv-exam-marking',
  examMarkRest: 'rv-exam-mark-rest',
  examShowResults: 'rv-exam-show-results',
  examResults: 'rv-exam-results',
  examScore: 'rv-exam-score',
  examBanks: 'rv-exam-banks',
  examTags: 'rv-exam-tags',
  examTimes: 'rv-exam-times',
  examMissed: 'rv-exam-missed',
  examExport: 'rv-exam-export',
  examCount: 'rv-exam-count',
  examCountStatus: 'rv-exam-count-status',
  examClose: 'rv-exam-close',
  examHistory: 'rv-exam-history',
  examHistoryClear: 'rv-exam-history-clear',

  // syllabus coverage (Analytics)
  syllabus: 'rv-syllabus',
  syllabusEmpty: 'rv-syllabus-empty',
  syllabusCreate: 'rv-syllabus-create',
  syllabusSelect: 'rv-syllabus-select',
  syllabusEdit: 'rv-syllabus-edit',
  syllabusOverall: 'rv-syllabus-overall',
  syllabusMinHighlights: 'rv-syllabus-min-highlights',
  syllabusMinCards: 'rv-syllabus-min-cards',
  syllabusReset: 'rv-syllabus-reset',
  syllabusThresholdStatus: 'rv-syllabus-threshold-status',
  syllabusChart: 'rv-syllabus-chart',
  syllabusTable: 'rv-syllabus-table',
  syllabusError: 'rv-syllabus-error',

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
/** Syllabus coverage: one table row and its buttons, by topic id. */
export const syllabusRowId = (topicId: string) => `rv-syllabus-row-${topicId}`;
export const syllabusShowId = (topicId: string) => `rv-syllabus-show-${topicId}`;
export const syllabusSortId = (key: string) => `rv-syllabus-sort-${key}`;
/** Exam: 0-based question index in exam order. */
export const examChoiceId = (index: number) => `rv-exam-choice-${index}`;
export const examMarkId = (index: number, mark: 'know' | 'dont') => `rv-exam-mark-${index}-${mark}`;
export const examMissedId = (index: number) => `rv-exam-missed-${index}`;
export const examJumpId = (index: number) => `rv-exam-jump-${index}`;
