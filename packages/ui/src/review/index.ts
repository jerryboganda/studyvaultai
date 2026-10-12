// Review (retention) UI building blocks. Import from '@ui/review'.
//
// For the side panel / popup / options page:
//   <ReviewTab />               compact due counts + start/continue + link to the full page
//   useDueCount()               live "cards due today" for badges (reads its own settings)
//   <ReviewSettingsSection />   study day, queue order and per-deck rules
// The full review page itself is entrypoints/review (review.html); `reviewPageUrl` links to it.

export { ReviewTab } from './ReviewTab';
export { ReminderNotice, useReminderRaised } from './ReminderNotice';
export { useNow } from './useNow';
export { ReviewSettingsSection, StudyDaySettings, DeckOptions } from './ReviewSettingsSection';
export { DeckSettingsForm } from './DeckSettingsForm';
export { CardFace, type CardFaceProps, type FaceCard } from './CardFace';
export {
  useDueCount,
  useReviewSession,
  useStudySettings,
  useTick,
  clockKey,
  type DueCount,
} from './hooks';
export {
  ReviewSessionController,
  defaultPort,
  type ControllerDeps,
  type CurrentCard,
  type LastAnswer,
  type SessionPhase,
  type SessionState,
  type StudyPort,
} from './session';
export {
  STUDY_SETTINGS_KEY,
  StudySettings,
  defaultStudySettings,
  deviceTimeZone,
  getStudySettings,
  parseStudySettings,
  toBoundary,
  toClock,
  toQueuePrefs,
  updateStudySettings,
  watchStudySettings,
} from './settings';
export {
  computeAnalytics,
  choiceRandom,
  formatDayKey,
  formatDuration,
  formatWhen,
  hashSeed,
  isFieldTarget,
  keyAction,
  parseDraft,
  percent,
  summarizeSession,
  toDraft,
  untilLabel,
  type AnalyticsReport,
  type DeckSettingsDraft,
  type KeyAction,
  type KeyContext,
  type SessionSummary,
} from './model';
export {
  parseReviewSearch,
  reviewPageUrl,
  reviewSearch,
  type ExamTarget,
  type ReviewLink,
  type ReviewView,
} from './links';
export * from './testids';
export {
  clozeWrap,
  initialEditorState,
  nextClozeIndex,
  toTemplateInput,
  type EditorState,
  type WrapResult,
} from './templates';
