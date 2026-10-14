import {
  Archive,
  BookOpen,
  ChartColumn,
  Copy,
  HardDrive,
  History,
  Layers,
  ListTree,
  MessagesSquare,
  Network,
  RefreshCw,
  Sparkles,
  Timer,
  Trash,
  Workflow,
} from 'lucide-react';
import { pdfReaderPath } from '@pdf/readerUrl';
import type { Settings } from '@shared';
import { InlineNotice, MoreGrid, useAction, type MoreItem } from '@ui';
import { reviewPageUrl, type ReviewView } from '@ui/review';
import { dashboardPath, openDashboard, type DashboardTarget } from '@ui/vault';
import { extensionPageUrl, openInTab, optionsUrl } from './links';

type Target =
  | { to: 'recent' }
  | { to: 'review'; view: ReviewView }
  | { to: 'dashboard'; target: DashboardTarget }
  | { to: 'options'; section: string }
  | { to: 'page'; path: string };

/**
 * The dashboard's own `?view=` addresses that `DashboardTarget` does not name (entrypoints/
 * dashboard/deepLink.ts LINKED_VIEWS). ponytail: opens a new tab instead of reusing an open
 * dashboard; move these into `DashboardTarget.view` when @ui/vault is next changed.
 */
const dashboardView = (view: 'duplicates' | 'trash'): Target => ({
  to: 'page',
  path: `${dashboardPath()}?view=${view}`,
});

/**
 * Everything outside the four core tabs (UX_DESIGN 9, More grid order), as tiles that open the
 * page that owns the feature. Only destinations with a real address are listed: Imports and Fields
 * live in the dashboard without a deep link yet.
 */
export function moreTargets(
  features: Settings['features'] | null,
): Array<Omit<MoreItem, 'onSelect'> & { target: Target }> {
  const off = (on: boolean | undefined) => (on === false ? 'Off' : undefined);
  const ai = features?.ai;
  return [
    { id: 'recent', label: 'Recent', icon: History, tone: 'primary', target: { to: 'recent' } },
    {
      id: 'exam',
      label: 'Exam',
      icon: Timer,
      tone: 'danger',
      target: { to: 'review', view: 'exam' },
    },
    {
      id: 'syllabus',
      label: 'Syllabus',
      icon: ListTree,
      tone: 'success',
      target: { to: 'dashboard', target: { view: 'syllabus' } },
    },
    {
      id: 'cards',
      label: 'Cards',
      icon: Layers,
      tone: 'violet',
      target: { to: 'review', view: 'cards' },
    },
    {
      id: 'stats',
      label: 'Stats',
      icon: ChartColumn,
      tone: 'sun',
      target: { to: 'review', view: 'analytics' },
    },
    {
      id: 'rules',
      label: 'Rules',
      icon: Workflow,
      tone: 'primary',
      target: { to: 'dashboard', target: { view: 'rules' } },
    },
    {
      id: 'backup',
      label: 'Backup',
      icon: Archive,
      tone: 'neutral',
      target: { to: 'options', section: 'backup' },
    },
    {
      id: 'duplicates',
      label: 'Duplicates',
      icon: Copy,
      tone: 'sun',
      target: dashboardView('duplicates'),
    },
    {
      id: 'trash',
      label: 'Trash',
      icon: Trash,
      tone: 'danger',
      target: dashboardView('trash'),
    },
    {
      id: 'graph',
      label: 'Graph',
      icon: Network,
      tone: 'violet',
      target: { to: 'dashboard', target: { view: 'graph' } },
    },
    {
      id: 'storage',
      label: 'Storage',
      icon: HardDrive,
      tone: 'sun',
      target: { to: 'options', section: 'storage' },
    },
    {
      id: 'pdf',
      label: 'PDF reader',
      icon: BookOpen,
      tone: 'danger',
      status: off(features?.pdfReader),
      // Switched off: the tile opens its setting instead of a reader that would refuse.
      target:
        features?.pdfReader === false
          ? { to: 'options', section: 'capture' }
          : { to: 'page', path: pdfReaderPath() },
    },
    {
      id: 'ai',
      label: 'AI',
      icon: Sparkles,
      tone: 'violet',
      status: off(ai),
      target: { to: 'options', section: 'ai' },
    },
    {
      id: 'chat',
      label: 'Chat',
      icon: MessagesSquare,
      tone: 'primary',
      status: off(ai),
      target: ai ? { to: 'dashboard', target: { view: 'chat' } } : { to: 'options', section: 'ai' },
    },
    {
      id: 'sync',
      label: 'Sync',
      icon: RefreshCw,
      tone: 'success',
      status: off(features?.sync),
      target: { to: 'options', section: 'sync' },
    },
  ];
}

export function MoreTab({
  features,
  onRecent,
}: {
  features: Settings['features'] | null;
  onRecent(): void;
}) {
  const go = useAction(async (target: Target) => {
    switch (target.to) {
      case 'recent':
        onRecent();
        return;
      case 'review':
        return openInTab(reviewPageUrl({ view: target.view }));
      case 'dashboard':
        return openDashboard(target.target);
      case 'options':
        return openInTab(optionsUrl(target.section));
      case 'page':
        return openInTab(extensionPageUrl(target.path));
    }
  });
  const items: MoreItem[] = moreTargets(features).map(({ target, ...item }) => ({
    ...item,
    onSelect: () => void go.run(target),
  }));
  return (
    <div className="sv-stack">
      <h2 className="sp-h">More</h2>
      {go.error ? (
        <InlineNotice tone="error" title="Could not open it">
          {go.error}
        </InlineNotice>
      ) : null}
      <MoreGrid items={items} label="More tools" columns={3} />
    </div>
  );
}
