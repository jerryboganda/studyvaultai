// Shared knowledge-workspace components. Import from '@ui/vault' (the stylesheet is '@ui/vault/vault.css').
export { CommandPalette, filterCommands, type Command } from './CommandPalette';
export {
  DASHBOARD_PAGE,
  dashboardPath,
  dashboardUrl,
  openDashboard,
  type DashboardTarget,
} from './dashboardLink';
export { Markdown } from './Markdown';
export { renderMarkdown, renderMarkdownToHtml } from './markdownRender';
export { PopupMenu, type MenuItem } from './Menu';
export type { MetaPort } from './meta';
export { Modal } from './Modal';
export {
  INDEX_KEY,
  INDEX_STALE_KEY,
  INDEX_STATE_KEY,
  PERSIST_DELAY_MS,
  RECONCILE_DELAY_MS,
  SKEW_MS,
  SearchHost,
  checksumOf,
  toIndexDocument,
  type RebuildReason,
  type SearchHostPorts,
  type SearchHostState,
} from './searchHost';
export {
  EMPTY_SELECTION,
  click as selectionClick,
  extendTo as selectionExtendTo,
  isEmpty as selectionIsEmpty,
  isSelected,
  prune as selectionPrune,
  rangeBetween,
  resolveIds,
  selectAllFiltered,
  selectAllLoaded,
  selectedCount,
  toggle as selectionToggle,
  type ClickModifiers,
  type Selection,
} from './selection';
export { Tree, type TreeHandle, type TreeProps } from './Tree';
export {
  flattenVisible,
  treeKey,
  typeahead,
  type KeyLike,
  type TreeItem,
  type TreeKeyResult,
  type TreeMoveDirection,
  type VisibleNode,
} from './treeModel';
export { VirtualList, type VirtualListProps } from './VirtualList';
export { computeWindow, scrollTopFor, type WindowInput, type WindowRange } from './virtual';
