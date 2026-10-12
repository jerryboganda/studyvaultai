// Opt-in AI surfaces (Phase 5). Pure engine: @ai. Persistence: @storage (ai.ts).
export { AiSettingsSection } from './AiSettingsSection';
export { HighlightAiActions, type HighlightAiActionsProps } from './HighlightAiActions';
export {
  ConsentPreviewDialog,
  type AiHighlightInput,
  type ConsentPreviewDialogProps,
} from './ConsentPreviewDialog';
export { AiResultCard, type AiResultCardProps } from './AiResultCard';
export { AiResultsList, type AiResultsListProps } from './AiResultsList';
export { UsageLedger } from './UsageLedger';
export { AiEnvProvider, useAiEnv } from './context';
export { useAiConfig, useAiFlag } from './hooks';
export {
  defaultAiEnv,
  loadAiConfig,
  previewAiTask,
  runAiTask,
  sendBlocker,
  testAiConnection,
  type AiConfig,
  type AiConnectionTest,
  type AiEnv,
  type AiRunArgs,
  type AiRunDone,
} from './runtime';
export { describeAiError, AI_ACTION_KINDS, AI_KIND_INFO, type AiErrorView } from './labels';
export { buildAccept, initialDraft, toMarkdown, type AiDraft } from './accept';
export {
  CHAT_MAX_CHARS,
  CHAT_TOP_K,
  retrieveForChat,
  type AiChatInput,
  type AiChatPassage,
  type AiChatTurn,
  type ChatRetrieval,
} from './chat';
export { routeFor, type AiProfileConfig, type AiRoute } from './runtime';
